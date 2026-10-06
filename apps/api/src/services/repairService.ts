import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { AppError } from '../http/errors';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';
import { buildFingerprint, planRepairs, type RepairTarget, type RepairType } from './repairPlan';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const BATCH_LIST_LIMIT = 30;

export interface StoredFailure {
  mediaId: string;
  repair: RepairType;
  error: string;
}

export interface StoredTarget {
  mediaId: string;
  sha256: string;
  storageKey: string;
  repair: RepairType;
  size: number;
}

const REPAIR_TO_JOB: Record<RepairType, 'media_thumbnail' | 'media_waveform' | 'media_duration'> = {
  thumbnail: 'media_thumbnail',
  waveform: 'media_waveform',
  duration: 'media_duration',
};

/** 扫描家庭下未删除媒体（条目也未删除），找出缺失产物。文档不产生派生文件，无需纳入。 */
export async function scanFamily(familyId: string, repairs: RepairType[]) {
  void repairs; // 需要哪些修复项由纯函数 planRepairs 判定，这里只取 image/audio 两类原始数据
  const rows = await prisma.itemMedia.findMany({
    where: {
      deletedAt: null,
      kind: { in: ['image', 'audio'] },
      item: { familyId, deletedAt: null },
    },
    select: {
      id: true,
      kind: true,
      sha256: true,
      storageKey: true,
      byteSize: true,
      thumbKey: true,
      waveformKey: true,
      durationMs: true,
    },
  });
  return planRepairs(rows, repairs);
}

/**
 * 创建（或幂等返回）一个重处理批次。
 * 按内容摘要指纹去重：同一份「sha+修复项」清单永远只对应一个批次，
 * 因此重复点击 / 重复调用不会产生第二批任务。
 */
export async function createRepairBatch(
  userId: string,
  ctx: FamilyContext,
  repairs: RepairType[],
  meta: ActorMeta,
): Promise<{ batchId: string; created: boolean; nothingToRepair?: boolean }> {
  const { targets, estimatedBytes } = await scanFamily(ctx.familyId, repairs);
  if (targets.length === 0) return { batchId: '', created: false, nothingToRepair: true };

  const fingerprint = await buildFingerprint(ctx.familyId, targets);

  const existing = await prisma.repairBatch.findUnique({
    where: { familyId_fingerprint: { familyId: ctx.familyId, fingerprint } },
  });
  if (existing) return { batchId: existing.id, created: false };

  // 按物理文件分组：内容寻址存储里同一 storageKey 只需处理一次，组内所有媒体共享结果。
  const groups = new Map<string, RepairTarget[]>();
  for (const t of targets) {
    const key = `${t.storageKey}|${t.repair}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  try {
    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.repairBatch.create({
        data: {
          familyId: ctx.familyId,
          createdBy: userId,
          fingerprint,
          repairs,
          status: 'running',
          totalTargets: targets.length,
          estimatedBytes: BigInt(estimatedBytes),
          targets: targets as unknown as object,
          failures: [] as unknown as object,
        },
      });

      let totalJobs = 0;
      for (const [, list] of groups) {
        const first = list[0]!;
        await tx.job.create({
          data: {
            familyId: ctx.familyId,
            batchId: created.id,
            type: REPAIR_TO_JOB[first.repair],
            payload: {
              storageKey: first.storageKey,
              sha256: first.sha256,
              mediaIds: list.map((t) => t.mediaId),
            } as never,
          },
        });
        totalJobs += 1;
      }

      await tx.repairBatch.update({ where: { id: created.id }, data: { totalJobs } });

      await audit.record(
        {
          familyId: ctx.familyId,
          actorId: userId,
          action: 'repair.batch_create',
          targetType: 'repair_batch',
          targetId: created.id,
          diff: {
            repairs,
            targets: targets.length,
            jobs: totalJobs,
            estimatedBytes,
          } as never,
          ...meta,
        },
        tx,
      );
      return created;
    });
    return { batchId: batch.id, created: true };
  } catch (err) {
    // 并发下另一请求已创建同指纹批次：直接返回已有批次，仍然幂等。
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const dup = await prisma.repairBatch.findUniqueOrThrow({
        where: { familyId_fingerprint: { familyId: ctx.familyId, fingerprint } },
      });
      return { batchId: dup.id, created: false };
    }
    throw err;
  }
}

export function toBatchDto(b: {
  id: string;
  familyId: string;
  status: string;
  repairs: RepairType[];
  totalTargets: number;
  totalJobs: number;
  succeededTargets: number;
  failedTargets: number;
  estimatedBytes: bigint;
  actualBytes: bigint;
  sourceMissing: number;
  failures: unknown;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: b.id,
    familyId: b.familyId,
    status: b.status,
    repairs: b.repairs,
    progress: b.totalTargets === 0 ? 0 : Math.round(((b.succeededTargets + b.failedTargets) / b.totalTargets) * 100),
    totalTargets: b.totalTargets,
    totalJobs: b.totalJobs,
    succeededTargets: b.succeededTargets,
    failedTargets: b.failedTargets,
    estimatedBytes: Number(b.estimatedBytes),
    actualBytes: Number(b.actualBytes),
    sourceMissing: b.sourceMissing,
    failures: b.failures as StoredFailure[],
    createdAt: b.createdAt.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
  };
}

export async function getBatch(familyId: string, batchId: string) {
  const batch = await prisma.repairBatch.findFirst({ where: { id: batchId, familyId } });
  if (!batch) throw new AppError('NOT_FOUND', '重处理批次不存在');
  return toBatchDto(batch);
}

export async function listBatches(familyId: string) {
  const rows = await prisma.repairBatch.findMany({
    where: { familyId },
    orderBy: { createdAt: 'desc' },
    take: BATCH_LIST_LIMIT,
  });
  return rows.map(toBatchDto);
}

/** 对批次内失败（含原始文件丢失）的目标重新入队。成功的不重复处理。 */
export async function retryFailed(userId: string, ctx: FamilyContext, batchId: string, meta: ActorMeta) {
  const batch = await prisma.repairBatch.findFirst({ where: { id: batchId, familyId: ctx.familyId } });
  if (!batch) throw new AppError('NOT_FOUND', '重处理批次不存在');

  const targets = batch.targets as unknown as StoredTarget[];
  const failures = batch.failures as unknown as StoredFailure[];
  if (failures.length === 0) {
    return { batchId, retried: 0 };
  }

  const failedKeys = new Set(failures.map((f) => `${f.mediaId}|${f.repair}`));
  const retryTargets = targets.filter((t) => failedKeys.has(`${t.mediaId}|${t.repair}`));

  const groups = new Map<string, StoredTarget[]>();
  for (const t of retryTargets) {
    const key = `${t.storageKey}|${t.repair}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  await prisma.$transaction(async (tx) => {
    // 把上一轮失败的目标作为「新一轮目标」追加：
    // totalTargets += 失败数，failedTargets 归零。这样进度口径始终是
    // (成功 + 失败) / 总目标，多次重试也不会超过 100%。
    const retryCount = retryTargets.length;
    await tx.repairBatch.update({
      where: { id: batchId },
      data: {
        status: 'running',
        totalTargets: { increment: retryCount },
        totalJobs: { increment: groups.size },
        failedTargets: 0,
        sourceMissing: 0,
        failures: [] as unknown as object,
        finishedAt: null,
      },
    });
    for (const [, list] of groups) {
      const first = list[0]!;
      await tx.job.create({
        data: {
          familyId: ctx.familyId,
          batchId,
          type: REPAIR_TO_JOB[first.repair],
          payload: {
            storageKey: first.storageKey,
            sha256: first.sha256,
            mediaIds: list.map((t) => t.mediaId),
          } as never,
        },
      });
    }
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'repair.retry',
        targetType: 'repair_batch',
        targetId: batchId,
        diff: { retried: retryTargets.length, jobs: groups.size } as never,
        ...meta,
      },
      tx,
    );
  });

  return { batchId, retried: retryTargets.length };
}
