import type { ItemMedia, Job, MediaRepairItem, MediaRepairRun, MediaKind, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';
import { AppError } from '../http/errors';
import { processImage } from '../media/image';
import { processAudio, hasFfmpeg } from '../media/audio';
import { putBuffer, absOf, statObject } from '../storage/local';
import { makeTmpPath } from './mediaService';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export type Artifact = 'thumb' | 'large' | 'waveform' | 'transcode' | 'duration';
export type RepairScope = 'missing' | 'failed' | 'all';

export interface CreateRunInput {
  scope?: RepairScope;
  verifyOnDisk?: boolean;
  kinds?: MediaKind[];
  mediaIds?: string[];
  dryRun?: boolean;
  maxAttempts?: number;
}

/**
 * 判断一份媒体缺哪些产物。判定同时看数据库标记和（可选的）磁盘实际存在性：
 * 数据库里有 thumbKey 但文件已被误删时，verifyOnDisk=true 也会把它重新列为待修。
 */
export async function planArtifacts(
  media: Pick<ItemMedia, 'kind' | 'thumbKey' | 'largeKey' | 'waveformKey' | 'transcodeKey' | 'durationMs'>,
  opts: { verifyOnDisk?: boolean } = {},
): Promise<Artifact[]> {
  const missing = async (artifact: Artifact, key: string | null | undefined): Promise<Artifact | null> => {
    if (!key) return artifact;
    if (opts.verifyOnDisk) {
      const stat = await statObject(key);
      if (!stat) return artifact;
    }
    return null;
  };

  if (media.kind === 'image') {
    const [thumb, large] = await Promise.all([
      missing('thumb', media.thumbKey),
      missing('large', media.largeKey),
    ]);
    return [thumb, large].filter((a): a is Artifact => a !== null);
  }
  if (media.kind === 'audio') {
    const [waveform, transcode] = await Promise.all([
      missing('waveform', media.waveformKey),
      missing('transcode', media.transcodeKey),
    ]);
    // 时长是数据库字段，没有独立文件，磁盘校验对它无意义
    const duration: Artifact | null = media.durationMs == null ? 'duration' : null;
    return [waveform, transcode, duration].filter((a): a is Artifact => a !== null);
  }
  return [];
}

/**
 * 产物占用估算（启发式，不实际转码）：
 *  - 缩略图（480px webp）：约 30–60KB，取 45KB
 *  - 大图（≤2400px webp q82）：原图的 ~75%，封顶 2MB
 *  - mp3 转码（96kbps 单声道）：通常小于原始录音，取原始大小 60%，封顶 80MB
 *  - 波形 JSON（900 个峰值）：约 10KB
 *  - 时长字段不占盘
 * 同一 sha256 的派生文件在家庭内共享（内容寻址），估算时按 sha 去重。
 */
export const ESTIMATE = {
  thumbBytes: 45 * 1024,
  largeCapBytes: 2 * 1024 * 1024,
  largeRatio: 0.75,
  transcodeRatio: 0.6,
  transcodeCapBytes: 80 * 1024 * 1024,
  waveformBytes: 10 * 1024,
} as const;

export function estimateArtifacts(
  media: Pick<ItemMedia, 'kind' | 'sha256' | 'byteSize'>,
  artifacts: Artifact[],
): number {
  const raw = Number(media.byteSize);
  let bytes = 0;
  for (const a of artifacts) {
    if (a === 'thumb') bytes += ESTIMATE.thumbBytes;
    else if (a === 'large') bytes += Math.min(Math.round(raw * ESTIMATE.largeRatio), ESTIMATE.largeCapBytes);
    else if (a === 'transcode')
      bytes += Math.min(Math.round(raw * ESTIMATE.transcodeRatio), ESTIMATE.transcodeCapBytes);
    else if (a === 'waveform') bytes += ESTIMATE.waveformBytes;
  }
  return bytes;
}

interface PlannedMedia {
  media: ItemMedia;
  artifacts: Artifact[];
  bytes: number;
}

/** 扫描候选媒体并给出修复计划（不落库）。 */
async function collectPlan(familyId: string, input: CreateRunInput): Promise<PlannedMedia[]> {
  const where: Prisma.ItemMediaWhereInput = {
    deletedAt: null,
    item: { familyId, deletedAt: null },
    kind: { in: (input.kinds ?? ['image', 'audio']) as MediaKind[] },
  };
  if (input.mediaIds?.length) where.id = { in: input.mediaIds };
  if (input.scope === 'failed') where.status = 'failed';

  const rows = await prisma.itemMedia.findMany({ where });
  const planned: PlannedMedia[] = [];
  for (const media of rows) {
    if (media.kind === 'document') continue;
    const artifacts = input.scope === 'all' ? allArtifacts(media.kind) : await planArtifacts(media, { verifyOnDisk: input.verifyOnDisk });
    if (artifacts.length === 0) continue;
    planned.push({ media, artifacts, bytes: estimateArtifacts(media, artifacts) });
  }
  return planned;
}

function allArtifacts(kind: MediaKind): Artifact[] {
  return kind === 'image' ? ['thumb', 'large'] : ['waveform', 'transcode', 'duration'];
}

/** 只做占用估算（dry-run）：按 sha 去重，返回将新增的磁盘占用。 */
export async function previewRun(familyId: string, input: CreateRunInput) {
  const planned = await collectPlan(familyId, input);
  const scanned = await prisma.itemMedia.count({
    where: {
      deletedAt: null,
      item: { familyId, deletedAt: null },
      kind: { in: (input.kinds ?? ['image', 'audio']) as MediaKind[] },
      ...(input.mediaIds?.length ? { id: { in: input.mediaIds } } : {}),
      ...(input.scope === 'failed' ? { status: 'failed' } : {}),
    },
  });
  const billed = new Set<string>(); // `${sha}:${artifact}`，同内容只算一次
  let bytes = 0;
  for (const p of planned) {
    for (const a of p.artifacts) {
      const key = `${p.media.sha256}:${a}`;
      if (billed.has(key)) continue;
      billed.add(key);
      bytes += estimateArtifacts(p.media, [a]);
    }
  }
  return {
    mediaScanned: scanned,
    mediaToRepair: planned.length,
    items: planned.slice(0, 200).map((p) => ({
      mediaId: p.media.id,
      kind: p.media.kind,
      originalName: p.media.originalName,
      artifacts: p.artifacts,
      bytesEstimate: p.bytes,
    })),
    bytesEstimate: bytes,
    deduplicatedByContent: billed.size,
  };
}

/** 创建一次重处理批次，扫描由后台 job 执行（大库不阻塞 HTTP）。 */
export async function createRun(userId: string, ctx: FamilyContext, input: CreateRunInput, meta: ActorMeta) {
  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.mediaRepairRun.create({
      data: {
        familyId: ctx.familyId,
        scope: input.scope ?? 'missing',
        verifyOnDisk: input.verifyOnDisk ?? false,
        options: {
          kinds: input.kinds ?? ['image', 'audio'],
          maxAttempts: input.maxAttempts ?? 3,
        } as Prisma.InputJsonValue,
        createdBy: userId,
        status: 'scanning',
      },
    });
    await tx.job.create({
      data: {
        familyId: ctx.familyId,
        type: 'media_repair_dispatch',
        payload: { runId: created.id } as Prisma.InputJsonValue,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.repair.start',
        targetType: 'media_repair_run',
        targetId: created.id,
        diff: { scope: created.scope, verifyOnDisk: created.verifyOnDisk } as Prisma.InputJsonValue,
        ...meta,
      },
      tx,
    );
    return created;
  });
  return toRunDto(await prisma.mediaRepairRun.findUniqueOrThrow({ where: { id: run.id } }));
}

/**
 * 后台任务：扫描全库、生成 RepairItem、为每条媒体派发幂等的处理 job。
 * 中途失败由 jobs 表的退避重试兜底，重跑会跳过已存在的 (runId, mediaId)。
 */
export async function dispatchRun(job: Job): Promise<Record<string, unknown>> {
  const { runId } = job.payload as { runId: string };
  const run = await prisma.mediaRepairRun.findUnique({ where: { id: runId } });
  if (!run) return { skipped: '批次已删除' };

  const options = (run.options ?? {}) as { kinds?: MediaKind[]; maxAttempts?: number };
  const input: CreateRunInput = {
    scope: run.scope,
    verifyOnDisk: run.verifyOnDisk,
    kinds: options.kinds,
    maxAttempts: options.maxAttempts,
  };

  const planned = await collectPlan(run.familyId, input);
  let enqueued = 0;

  for (const p of planned) {
    // 唯一约束 (runId, mediaId) 保证派发本身幂等：重复扫描不会产生重复条目
    const item = await prisma.mediaRepairItem.upsert({
      where: { runId_mediaId: { runId, mediaId: p.media.id } },
      create: {
        runId,
        mediaId: p.media.id,
        artifacts: p.artifacts as Prisma.MediaRepairItemUncheckedCreateInput['artifacts'],
        bytesEstimate: BigInt(p.bytes),
        status: 'pending',
      },
      update: {}, // 已在本批次中：保留既有状态（可能已经修好了）
    });

    const existingJob = item.jobId
      ? await prisma.job.findUnique({ where: { id: item.jobId } })
      : null;
    if (existingJob && ['queued', 'running'].includes(existingJob.status)) continue;

    const work = await prisma.job.create({
      data: {
        familyId: run.familyId,
        type: p.media.kind === 'image' ? 'media_repair_image' : 'media_repair_audio',
        // scope=all 表示强制重建：处理时跳过「产物已存在」的短路检查
        payload: { runItemId: item.id, mediaId: p.media.id, force: run.scope === 'all' } as Prisma.InputJsonValue,
        maxAttempts: options.maxAttempts ?? 3,
      },
    });
    await prisma.mediaRepairItem.update({ where: { id: item.id }, data: { jobId: work.id } });
    enqueued += 1;
  }

  // 估算值以表内条目为准：派发 job 中途失败重试时，这里天然包含上一轮已落库的条目
  const [total, estimateSum] = await Promise.all([
    prisma.mediaRepairItem.count({ where: { runId } }),
    prisma.mediaRepairItem.aggregate({ where: { runId }, _sum: { bytesEstimate: true } }),
  ]);
  await prisma.mediaRepairRun.update({
    where: { id: runId },
    data: {
      total,
      bytesEstimate: estimateSum._sum.bytesEstimate ?? 0n,
      startedAt: run.startedAt ?? new Date(),
      // 扫描结束：没有待修条目直接收尾，否则进入 running 由 recalcRun 聚合
      status: total === 0 ? 'done' : 'running',
      finishedAt: total === 0 ? new Date() : null,
    },
  });
  await recalcRun(runId);
  logger.info({ runId, planned: planned.length, enqueued, total }, '媒体重处理派发完成');
  return { planned: planned.length, enqueued, total };
}

async function loadRepairItem(runItemId: string): Promise<MediaRepairItem> {
  const item = await prisma.mediaRepairItem.findUnique({ where: { id: runItemId } });
  if (!item) throw new Error(`修复条目不存在: ${runItemId}`);
  return item;
}

/**
 * 领取条目：
 *  - pending（首次/退避重试）：直接进入 running
 *  - running 但已经卡在 running 超过 10 分钟（worker 崩溃，job 被退避重新投递）：抢占回收
 *  - 正在被别人处理（running 且未超时）/ 已终结：返回 null，杜绝并发重复处理
 * 同步累加 attempts，使「第 N 次尝试」与 jobs.attempts 保持一致。
 */
async function claimItem(runItemId: string): Promise<MediaRepairItem | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE media_repair_items
    SET status = 'running',
        attempts = attempts + 1,
        updated_at = now(),
        started_at = COALESCE(started_at, now())
    WHERE id = ${runItemId}
      AND (
        status = 'pending'
        OR (status = 'running' AND updated_at < now() - interval '10 minutes')
      )
    RETURNING id
  `;
  if (rows.length === 0) return null;
  return loadRepairItem(runItemId);
}

export async function processImageRepair(job: Job): Promise<Record<string, unknown>> {
  const { runItemId, force = false } = job.payload as { runItemId: string; force?: boolean };
  const item = await claimItem(runItemId);
  if (!item) return { skipped: '条目已在处理或已终结' };
  const media = await prisma.itemMedia.findUnique({ where: { id: item.mediaId } });
  if (!media || media.deletedAt) {
    await finishItem(item.id, 'skipped', { error: '媒体已删除' });
    return { skipped: '媒体已删除' };
  }
  if (!(await rawExists(media.storageKey))) {
    // 原始文件丢失是永久性失败：耗尽而非抛错，避免无意义的退避重试
    await finishItem(item.id, 'failed', { error: `原始文件已丢失：${media.storageKey}`, mediaStatus: 'failed' });
    return { failed: '原始文件已丢失' };
  }

  // 二次幂等检查：可能已被另一条 job（上传后的常规处理 / 另一个批次）修好。
  // scope=all（强制重建）时跳过该短路。
  if (!force) {
    const stillMissing = await planArtifacts(media, { verifyOnDisk: true });
    if (stillMissing.length === 0) {
      await prisma.itemMedia.update({ where: { id: media.id }, data: { status: 'ready', lastError: null } });
      await finishItem(item.id, 'skipped');
      return { skipped: '产物已存在' };
    }
  }

  const familyId = (await prisma.item.findUniqueOrThrow({
    where: { id: media.itemId },
    select: { familyId: true },
  })).familyId;

  const variants = await processImage(absOf(media.storageKey), familyId, media.sha256, putBuffer);
  const bytesActual = await sumKeySizes([variants.thumbKey, variants.largeKey]);
  await prisma.itemMedia.update({
    where: { id: media.id },
    data: {
      status: 'ready',
      thumbKey: variants.thumbKey,
      largeKey: variants.largeKey,
      width: variants.width,
      height: variants.height,
      lastError: null,
    },
  });
  await finishItem(item.id, 'done', { bytesActual });
  return { thumbKey: variants.thumbKey, largeKey: variants.largeKey, bytesActual };
}

export async function processAudioRepair(job: Job): Promise<Record<string, unknown>> {
  const { runItemId, force = false } = job.payload as { runItemId: string; force?: boolean };
  const item = await claimItem(runItemId);
  if (!item) return { skipped: '条目已在处理或已终结' };
  const media = await prisma.itemMedia.findUnique({ where: { id: item.mediaId } });
  if (!media || media.deletedAt) {
    await finishItem(item.id, 'skipped', { error: '媒体已删除' });
    return { skipped: '媒体已删除' };
  }
  if (!(await rawExists(media.storageKey))) {
    // 原始文件丢失是永久性失败：耗尽而非抛错，避免无意义的退避重试
    await finishItem(item.id, 'failed', { error: `原始文件已丢失：${media.storageKey}`, mediaStatus: 'failed' });
    return { failed: '原始文件已丢失' };
  }

  if (!force) {
    const stillMissing = await planArtifacts(media, { verifyOnDisk: true });
    if (stillMissing.length === 0) {
      await prisma.itemMedia.update({ where: { id: media.id }, data: { lastError: null } });
      await finishItem(item.id, 'skipped');
      return { skipped: '产物已存在' };
    }
  }

  if (!(await hasFfmpeg())) {
    // 环境限制，重试也不会成功：标记 skipped 而不是 failed
    await finishItem(item.id, 'skipped', { error: '宿主机未安装 ffmpeg，无法转码/取时长' });
    return { skipped: 'ffmpeg 不可用' };
  }

  const familyId = (await prisma.item.findUniqueOrThrow({
    where: { id: media.itemId },
    select: { familyId: true },
  })).familyId;

  const variants = await processAudio(absOf(media.storageKey), familyId, media.sha256, putBuffer, makeTmpPath);
  const keys = [variants.transcodeKey, variants.waveformKey].filter((k): k is string => Boolean(k));
  const bytesActual = await sumKeySizes(keys);

  const repaired = await planArtifacts(
    {
      kind: 'audio',
      thumbKey: null,
      largeKey: null,
      waveformKey: variants.waveformKey ?? media.waveformKey,
      transcodeKey: variants.transcodeKey ?? media.transcodeKey,
      durationMs: variants.durationMs ?? media.durationMs,
    },
    {},
  );
  if (repaired.length > 0) {
    // ffmpeg 跑了但仍拿不到某些产物（坏文件/不支持的编码）：不 throw，避免无限退避
    await prisma.itemMedia.update({
      where: { id: media.id },
      data: {
        transcodeKey: variants.transcodeKey ?? media.transcodeKey,
        waveformKey: variants.waveformKey ?? media.waveformKey,
        durationMs: variants.durationMs ?? media.durationMs,
        lastError: `仍缺失产物：${repaired.join('、')}（文件可能损坏或编码不支持）`.slice(0, 500),
      },
    });
    await finishItem(item.id, 'failed', { bytesActual, error: `仍缺失产物：${repaired.join('、')}` });
    return { partial: repaired, bytesActual };
  }

  await prisma.itemMedia.update({
    where: { id: media.id },
    data: {
      status: 'ready',
      transcodeKey: variants.transcodeKey,
      waveformKey: variants.waveformKey,
      durationMs: variants.durationMs,
      lastError: null,
    },
  });
  await finishItem(item.id, 'done', { bytesActual });
  return { transcodeKey: variants.transcodeKey, durationMs: variants.durationMs, bytesActual };
}

async function rawExists(storageKey: string): Promise<boolean> {
  return (await statObject(storageKey)) !== null;
}

async function sumKeySizes(keys: string[]): Promise<number> {
  let total = 0;
  for (const key of keys) {
    const stat = await statObject(key);
    if (stat) total += stat.size;
  }
  return total;
}

interface FinishOpts {
  bytesActual?: number;
  error?: string;
  mediaStatus?: 'failed';
}

async function finishItem(itemId: string, status: MediaRepairItem['status'], opts: FinishOpts = {}): Promise<void> {
  const item = await prisma.mediaRepairItem.findUniqueOrThrow({ where: { id: itemId } });
  await prisma.mediaRepairItem.update({
    where: { id: itemId },
    data: {
      status,
      finishedAt: new Date(),
      ...(opts.bytesActual !== undefined ? { bytesActual: BigInt(opts.bytesActual) } : {}),
      lastError: opts.error ?? (status === 'done' || status === 'skipped' ? null : item.lastError),
    },
  });
  if (opts.mediaStatus === 'failed') {
    await prisma.itemMedia.update({
      where: { id: item.mediaId },
      data: { status: 'failed', lastError: opts.error?.slice(0, 500) ?? '处理失败' },
    });
  }
  await recalcRun(item.runId);
}

/**
 * job 退避/耗尽回调（由 worker 在 catch 中调用）：
 *  - 还要重试：条目回到 pending，等下一次 job 尝试
 *  - 已耗尽：条目永久 failed，媒体状态同步 failed
 */
export async function settleItemAfterJobError(job: Job, exhausted: boolean, message: string): Promise<void> {
  const payload = job.payload as { runItemId?: string };
  if (!payload.runItemId) return;
  const item = await prisma.mediaRepairItem.findUnique({ where: { id: payload.runItemId } });
  if (!item || item.status === 'done' || item.status === 'skipped') return;

  if (exhausted) {
    await prisma.mediaRepairItem.update({
      where: { id: item.id },
      data: { status: 'failed', finishedAt: new Date(), lastError: message.slice(0, 500) },
    });
    await prisma.itemMedia.update({
      where: { id: item.mediaId },
      data: { status: 'failed', lastError: message.slice(0, 500) },
    });
  } else {
    await prisma.mediaRepairItem.update({
      where: { id: item.id },
      data: { status: 'pending', lastError: message.slice(0, 500) },
    });
  }
  await recalcRun(item.runId);
}

/** 重新汇总批次计数；所有条目终结时把批次收尾。 */
export async function recalcRun(runId: string): Promise<void> {
  const run = await prisma.mediaRepairRun.findUnique({ where: { id: runId } });
  if (!run || run.status === 'scanning') return;

  const [grouped, bytesRows] = await Promise.all([
    prisma.mediaRepairItem.groupBy({ by: ['status'], where: { runId }, _count: true }),
    prisma.mediaRepairItem.aggregate({
      where: { runId, status: { in: ['done', 'failed'] } },
      _sum: { bytesActual: true },
    }),
  ]);
  const counts: Record<MediaRepairItem['status'], number> = { pending: 0, running: 0, done: 0, skipped: 0, failed: 0 };
  for (const g of grouped) counts[g.status as MediaRepairItem['status']] = g._count;
  const total = counts.pending + counts.running + counts.done + counts.skipped + counts.failed;
  const finished = counts.pending === 0 && counts.running === 0;

  const next: Prisma.MediaRepairRunUpdateInput = {
    total,
    doneCount: counts.done,
    failedCount: counts.failed,
    skippedCount: counts.skipped,
    bytesActual: bytesRows._sum.bytesActual ?? 0n,
  };
  if (finished) {
    next.status = counts.failed > 0 ? 'done_with_errors' : 'done';
    next.finishedAt = new Date();
  } else {
    next.status = 'running';
    next.finishedAt = null;
  }
  await prisma.mediaRepairRun.update({ where: { id: runId }, data: next });
}

/** 手动重试一条失败的媒体：重置条目并重新派发 job（手工重试不占自动退避次数）。 */
export async function retryItem(userId: string, ctx: FamilyContext, runId: string, itemId: string, meta: ActorMeta) {
  const run = await getOwnedRun(ctx.familyId, runId);
  const item = await prisma.mediaRepairItem.findFirst({ where: { id: itemId, runId } });
  if (!item) throw new AppError('NOT_FOUND', '修复条目不存在');
  if (item.status === 'pending' || item.status === 'running') {
    throw new AppError('CONFLICT', '该条目仍在队列中，无需重复重试');
  }
  const media = await prisma.itemMedia.findFirst({
    where: { id: item.mediaId, item: { familyId: ctx.familyId } },
  });
  if (!media) throw new AppError('NOT_FOUND', '媒体已不存在');

  const work = await prisma.job.create({
    data: {
      familyId: ctx.familyId,
      type: media.kind === 'image' ? 'media_repair_image' : 'media_repair_audio',
      payload: { runItemId: item.id, mediaId: media.id, manual: true } as Prisma.InputJsonValue,
      maxAttempts: 3,
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.mediaRepairItem.update({
      where: { id: item.id },
      data: { status: 'pending', attempts: { increment: 1 }, lastError: null, finishedAt: null, jobId: work.id },
    });
    await tx.mediaRepairRun.update({ where: { id: run.id }, data: { status: 'running', finishedAt: null } });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.repair.retry',
        targetType: 'media_repair_item',
        targetId: item.id,
        ...meta,
      },
      tx,
    );
  });
  return toItemDto(await prisma.mediaRepairItem.findUniqueOrThrow({ where: { id: item.id } }));
}

async function getOwnedRun(familyId: string, runId: string): Promise<MediaRepairRun> {
  const run = await prisma.mediaRepairRun.findFirst({ where: { id: runId, familyId } });
  if (!run) throw new AppError('NOT_FOUND', '重处理批次不存在');
  return run;
}

export async function listRuns(ctx: FamilyContext, limit = 30) {
  const runs = await prisma.mediaRepairRun.findMany({
    where: { familyId: ctx.familyId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
  });
  return { runs: runs.map((r) => toRunDto(r)) };
}

export async function getRun(ctx: FamilyContext, runId: string) {
  return toRunDto(await getOwnedRun(ctx.familyId, runId));
}

export async function listRunItems(
  ctx: FamilyContext,
  runId: string,
  query: { status?: MediaRepairItem['status']; limit?: number; offset?: number },
) {
  await getOwnedRun(ctx.familyId, runId);
  const take = query.limit ?? 100;
  const skip = query.offset ?? 0;
  const [items, total] = await Promise.all([
    prisma.mediaRepairItem.findMany({
      where: { runId, ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take,
      skip,
    }),
    prisma.mediaRepairItem.count({ where: { runId, ...(query.status ? { status: query.status } : {}) } }),
  ]);
  const mediaRows = await prisma.itemMedia.findMany({
    where: { id: { in: items.map((i) => i.mediaId) } },
    select: { id: true, originalName: true, kind: true, mimeType: true },
  });
  const mediaById = new Map(mediaRows.map((m) => [m.id, m]));
  return {
    total,
    items: items.map((i) => ({ ...toItemDto(i), media: mediaById.get(i.mediaId) ?? null })),
  };
}

export function toRunDto(r: MediaRepairRun) {
  const total = r.total || 0;
  const settled = r.doneCount + r.failedCount + r.skippedCount;
  return {
    id: r.id,
    scope: r.scope,
    status: r.status,
    verifyOnDisk: r.verifyOnDisk,
    options: r.options,
    total,
    doneCount: r.doneCount,
    failedCount: r.failedCount,
    skippedCount: r.skippedCount,
    progress: r.status === 'scanning' ? 0 : total === 0 ? 100 : Math.round((settled / total) * 100),
    bytesEstimate: Number(r.bytesEstimate),
    bytesActual: Number(r.bytesActual),
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

function toItemDto(i: MediaRepairItem) {
  return {
    id: i.id,
    mediaId: i.mediaId,
    artifacts: i.artifacts,
    status: i.status,
    attempts: i.attempts,
    bytesEstimate: Number(i.bytesEstimate),
    bytesActual: Number(i.bytesActual),
    lastError: i.lastError,
    jobId: i.jobId,
    startedAt: i.startedAt?.toISOString() ?? null,
    finishedAt: i.finishedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}
