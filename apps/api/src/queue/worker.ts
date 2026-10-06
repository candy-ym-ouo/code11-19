import type { Job, RepairType } from '@prisma/client';
import type { Dirent } from 'node:fs';
import { config } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { processImage } from '../media/image';
import { processAudio, probeDurationMs } from '../media/audio';
import { inspectDocument } from '../media/document';
import { putBuffer, remove, absOf, statObject } from '../storage/local';
import { makeTmpPath } from '../services/mediaService';
import { buildExportZip } from '../services/exportService';
import type { StoredFailure } from '../services/repairService';

type Handler = (job: Job) => Promise<Record<string, unknown>>;

/** 重处理任务载荷：按物理文件分组，组内 mediaIds 共享一次处理结果。 */
interface RepairPayload {
  mediaId?: string;
  storageKey?: string;
  sha256?: string;
  mediaIds?: string[];
}

type JobOutcome = {
  ok: boolean;
  mediaId: string;
  repair: RepairType;
  error?: string;
  sourceMissing?: boolean;
};

function absPathOf(key: string): string {
  return absOf(key);
}

/** 取任务要处理的物理文件；原始文件不在磁盘上时返回 null（由调用方计入 sourceMissing）。 */
async function sourcePath(storageKey: string | undefined, fallbackMediaId: string): Promise<string | null> {
  if (storageKey) {
    const exists = await statObject(storageKey);
    return exists ? absPathOf(storageKey) : null;
  }
  // 兼容上传链路的旧载荷 { mediaId }
  const media = await prisma.itemMedia.findUnique({ where: { id: fallbackMediaId } });
  if (!media) return null;
  const exists = await statObject(media.storageKey);
  return exists ? absPathOf(media.storageKey) : null;
}

function repairOf(job: Job): RepairType {
  if (job.type === 'media_waveform') return 'waveform';
  if (job.type === 'media_duration') return 'duration';
  return 'thumbnail';
}

async function handleThumbnail(job: Job): Promise<Record<string, unknown>> {
  const payload = job.payload as RepairPayload;
  if (payload.storageKey && payload.mediaIds) {
    const src = await sourcePath(payload.storageKey, payload.mediaIds[0]!);
    const outcomes: JobOutcome[] = payload.mediaIds.map((mediaId) => ({
      ok: Boolean(src),
      mediaId,
      repair: 'thumbnail',
      ...(src ? {} : { sourceMissing: true, error: '原始文件已不在磁盘上' }),
    }));
    if (!src) return { mediaIds: payload.mediaIds, outcomes, sourceMissing: payload.mediaIds.length };

    const media = await prisma.itemMedia.findFirst({
      where: { id: { in: payload.mediaIds }, kind: 'image' },
      include: { item: true },
    });
    if (!media) return { mediaIds: payload.mediaIds, outcomes, skipped: '组内无图片' };

    let variants;
    try {
      variants = await processImage(src, media.item.familyId, payload.sha256 ?? media.sha256, putBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : '缩略图生成失败';
      await prisma.itemMedia.updateMany({
        where: { id: { in: payload.mediaIds }, kind: 'image', deletedAt: null },
        data: { status: 'failed', lastError: message },
      });
      for (const o of outcomes) {
        o.ok = false;
        o.error = message;
      }
      return { mediaIds: payload.mediaIds, outcomes };
    }

    let bytes = 0;
    for (const key of [variants.thumbKey, variants.largeKey]) {
      const st = await statObject(key);
      bytes += st?.size ?? 0;
    }

    await prisma.itemMedia.updateMany({
      where: { id: { in: payload.mediaIds }, kind: 'image', deletedAt: null },
      data: {
        status: 'ready',
        thumbKey: variants.thumbKey,
        largeKey: variants.largeKey,
        width: variants.width,
        height: variants.height,
        lastError: null,
      },
    });
    return { mediaIds: payload.mediaIds, outcomes, thumbKey: variants.thumbKey, bytes };
  }

  // 上传链路：单个 mediaId，图片/文档各自处理
  const { mediaId } = payload;
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  try {
    if (media.kind === 'image') {
      const item = await prisma.item.findUniqueOrThrow({ where: { id: media.itemId } });
      const variants = await processImage(absPathOf(media.storageKey), item.familyId, media.sha256, putBuffer);
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: {
          status: 'ready',
          thumbKey: variants.thumbKey,
          largeKey: variants.largeKey,
          width: variants.width,
          height: variants.height,
          lastError: null,
        },
      });
      return { thumbKey: variants.thumbKey, width: variants.width, height: variants.height };
    }
    if (media.kind === 'document') {
      const info = await inspectDocument(absPathOf(media.storageKey));
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: { status: 'ready', lastError: null },
      });
      return { pageCount: info.pageCount };
    }
    await prisma.itemMedia.update({ where: { id: mediaId }, data: { status: 'ready' } });
    return { skipped: '非图片/文档' };
  } catch (err) {
    await prisma.itemMedia.update({
      where: { id: mediaId },
      data: { status: 'failed', lastError: err instanceof Error ? err.message.slice(0, 500) : '处理失败' },
    });
    throw err;
  }
}

async function handleWaveform(job: Job): Promise<Record<string, unknown>> {
  const payload = job.payload as RepairPayload;
  if (payload.storageKey && payload.mediaIds) {
    const src = await sourcePath(payload.storageKey, payload.mediaIds[0]!);
    const outcomes: JobOutcome[] = payload.mediaIds.map((mediaId) => ({
      ok: Boolean(src),
      mediaId,
      repair: 'waveform',
      ...(src ? {} : { sourceMissing: true, error: '原始文件已不在磁盘上' }),
    }));
    if (!src) return { mediaIds: payload.mediaIds, outcomes, sourceMissing: payload.mediaIds.length };

    const media = await prisma.itemMedia.findFirstOrThrow({
      where: { id: { in: payload.mediaIds } },
      include: { item: true },
    });
    let variants;
    try {
      variants = await processAudio(src, media.item.familyId, payload.sha256 ?? media.sha256, putBuffer, makeTmpPath);
      // 宿主机缺 ffmpeg / 转码失败时 processAudio 返回全空：对波形修复来说这就是失败，
      // 不能标记成功，否则前端会以为产物已补齐。
      if (!variants.waveformKey) {
        throw new Error('未能生成波形（通常是宿主机缺少 ffmpeg 或音频文件无法解码）');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 300) : '音频处理失败';
      await prisma.itemMedia.updateMany({
        where: { id: { in: payload.mediaIds }, deletedAt: null },
        data: { status: 'failed', lastError: message },
      });
      for (const o of outcomes) {
        o.ok = false;
        o.error = message;
      }
      return { mediaIds: payload.mediaIds, outcomes };
    }

    let bytes = 0;
    for (const key of [variants.transcodeKey, variants.waveformKey]) {
      if (key) bytes += (await statObject(key))?.size ?? 0;
    }
    // 同内容媒体全部共享派生产物；durationMs 也在这一步顺带补齐
    await prisma.itemMedia.updateMany({
      where: { id: { in: payload.mediaIds }, deletedAt: null },
      data: {
        status: 'ready',
        transcodeKey: variants.transcodeKey,
        waveformKey: variants.waveformKey,
        durationMs: variants.durationMs,
        lastError: null,
      },
    });
    return { mediaIds: payload.mediaIds, outcomes, transcodeKey: variants.transcodeKey, durationMs: variants.durationMs, bytes };
  }

  // 上传链路
  const { mediaId } = payload;
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  const item = await prisma.item.findUniqueOrThrow({ where: { id: media.itemId } });
  const variants = await processAudio(
    absPathOf(media.storageKey),
    item.familyId,
    media.sha256,
    putBuffer,
    makeTmpPath,
  );
  await prisma.itemMedia.update({
    where: { id: mediaId },
    data: {
      status: 'ready',
      transcodeKey: variants.transcodeKey,
      waveformKey: variants.waveformKey,
      durationMs: variants.durationMs,
      lastError: null,
    },
  });
  return { transcodeKey: variants.transcodeKey, peaks: variants.peakCount, durationMs: variants.durationMs };
}

/** 仅补齐缺失时长：只跑 ffprobe，不写派生文件（缺失波形时不顺带生成）。 */
async function handleDuration(job: Job): Promise<Record<string, unknown>> {
  const payload = job.payload as RepairPayload;
  if (!payload.storageKey || !payload.mediaIds) throw new Error('时长探测任务载荷不合法');
  const src = await sourcePath(payload.storageKey, payload.mediaIds[0]!);
  const outcomes: JobOutcome[] = payload.mediaIds.map((mediaId) => ({
    ok: Boolean(src),
    mediaId,
    repair: 'duration',
    ...(src ? {} : { sourceMissing: true, error: '原始文件已不在磁盘上' }),
  }));
  if (!src) return { mediaIds: payload.mediaIds, outcomes, sourceMissing: payload.mediaIds.length };

  let durationMs: number;
  try {
    durationMs = await probeDurationMs(src);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : '时长探测失败';
    for (const o of outcomes) {
      o.ok = false;
      o.error = message;
    }
    return { mediaIds: payload.mediaIds, outcomes };
  }
  await prisma.itemMedia.updateMany({
    where: { id: { in: payload.mediaIds }, deletedAt: null },
    data: { durationMs, lastError: null },
  });
  return { mediaIds: payload.mediaIds, outcomes, durationMs, bytes: 0 };
}

/** 把重处理任务的结果汇总回批次：推进计数、登记失败、全部完成时收尾。 */
async function advanceBatch(job: Job, result: Record<string, unknown> | null, fatalError?: string): Promise<void> {
  if (!job.batchId) return;
  const repair = repairOf(job);

  let outcomes: JobOutcome[] | null = (result?.outcomes as JobOutcome[] | undefined) ?? null;
  if (!outcomes && fatalError) {
    const payload = job.payload as RepairPayload;
    const ids = payload.mediaIds ?? (payload.mediaId ? [payload.mediaId] : []);
    outcomes = ids.map((mediaId) => ({ ok: false, mediaId, repair, error: fatalError }));
  }
  if (!outcomes || outcomes.length === 0) return;

  const succeeded = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - succeeded;
  const sourceMissing = outcomes.filter((o) => o.sourceMissing).length;
  const bytes = typeof result?.bytes === 'number' ? result.bytes : 0;
  const newFailures: StoredFailure[] = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ mediaId: o.mediaId, repair: o.repair, error: (o.error ?? '处理失败').slice(0, 300) }));

  await prisma.$transaction(async (tx) => {
    const batch = await tx.repairBatch.findUnique({ where: { id: job.batchId! } });
    if (!batch) return;

    const failures = [...(batch.failures as unknown as StoredFailure[]), ...newFailures];
    const pending = await tx.job.count({
      where: { batchId: batch.id, status: { in: ['queued', 'running'] } },
    });

    const failedTotal = batch.failedTargets + failed;
    const succeededTotal = batch.succeededTargets + succeeded;
    const isLast = pending === 0;
    const status = !isLast
      ? 'running'
      : failedTotal === 0
        ? 'done'
        : succeededTotal === 0
          ? 'failed'
          : 'partial';

    await tx.repairBatch.update({
      where: { id: batch.id },
      data: {
        succeededTargets: succeededTotal,
        failedTargets: failedTotal,
        sourceMissing: batch.sourceMissing + sourceMissing,
        actualBytes: batch.actualBytes + BigInt(bytes),
        failures: failures.slice(-500) as unknown as object,
        status,
        finishedAt: isLast ? new Date() : null,
      },
    });
  });
}

async function handleExport(job: Job): Promise<Record<string, unknown>> {
  const result = await buildExportZip(job);
  return { items: result.items, media: result.media, bytes: result.bytes, file: result.file };
}

/** 回收站保留期到期后彻底删除（含磁盘文件）。 */
async function handleTrashPurge(): Promise<Record<string, unknown>> {
  const cutoff = new Date(Date.now() - config.TRASH_RETENTION_DAYS * 86_400_000);
  const expired = await prisma.item.findMany({
    where: { status: 'trashed', deletedAt: { lt: cutoff } },
    include: { media: true },
    take: 500,
  });
  let removed = 0;
  for (const item of expired) {
    const keys = item.media.flatMap((m) => [m.storageKey, m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey]);
    await prisma.item.delete({ where: { id: item.id } });
    await Promise.all(keys.filter(Boolean).map((k) => remove(k!).catch(() => undefined)));
    removed += 1;
  }
  return { removed, cutoff: cutoff.toISOString() };
}

/** 清理孤儿文件与过期导出包，防止磁盘只涨不降。 */
async function handleStorageGc(): Promise<Record<string, unknown>> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const referenced = new Set<string>();
  const media = await prisma.itemMedia.findMany({ select: { storageKey: true, thumbKey: true, largeKey: true, transcodeKey: true, waveformKey: true } });
  for (const m of media) {
    for (const k of [m.storageKey, m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey]) if (k) referenced.add(k);
  }

  const root = config.STORAGE_ROOT;
  let scanned = 0;
  let deleted = 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tmp') continue; // 临时目录单独处理
        await walk(full);
        continue;
      }
      scanned += 1;
      const key = path.relative(root, full).split(path.sep).join('/');
      if (referenced.has(key)) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) continue;
      await fsp.rm(full, { force: true });
      deleted += 1;
    }
  }
  await walk(root);

  // 临时目录里超过 24 小时的残留（中断的上传）直接清掉
  const tmp = path.join(root, 'tmp');
  for (const name of await fsp.readdir(tmp).catch(() => [])) {
    const full = path.join(tmp, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(full, { force: true, recursive: true });
      deleted += 1;
    }
  }

  // 过期导出包
  const exportCutoff = Date.now() - config.EXPORT_RETENTION_DAYS * 86_400_000;
  for (const familyDir of await fsp.readdir(config.EXPORT_ROOT).catch(() => [])) {
    const dir = path.join(config.EXPORT_ROOT, familyDir);
    for (const file of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, file);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < exportCutoff) {
        await fsp.rm(full, { force: true });
        deleted += 1;
      }
    }
  }

  return { scanned, deleted };
}

const HANDLERS: Record<string, Handler> = {
  media_thumbnail: handleThumbnail,
  media_waveform: handleWaveform,
  media_duration: handleDuration,
  export_build: handleExport,
  trash_purge: handleTrashPurge,
  storage_gc: handleStorageGc,
};

/** 原子领取一个任务：UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)。 */
async function claimJob(): Promise<Job | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE jobs SET status = 'running', started_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  const first = rows[0];
  if (!first) return null;
  return prisma.job.findUnique({ where: { id: first.id } });
}

async function runOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const handler = HANDLERS[job.type];
  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'failed', finishedAt: new Date(), lastError: `未知任务类型 ${job.type}` },
    });
    return true;
  }
  try {
    const result = await handler(job);
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'done', progress: 100, finishedAt: new Date(), result: result as never, lastError: null },
    });
    await advanceBatch(job, result).catch((err) => logger.error({ err, jobId: job.id }, '批次推进失败'));
    logger.info({ jobId: job.id, type: job.type, result }, '任务完成');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts;
    const backoffMs = Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, job.attempts - 1));
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: exhausted ? 'failed' : 'queued',
        lastError: message.slice(0, 1000),
        finishedAt: exhausted ? new Date() : null,
        runAfter: new Date(Date.now() + backoffMs),
      },
    });
    if (exhausted) {
      await advanceBatch(job, null, message).catch((batchErr) =>
        logger.error({ err: batchErr, jobId: job.id }, '批次失败登记失败'),
      );
    }
    logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, '任务失败');
  }
  return true;
}

const DAILY = 24 * 3600 * 1000;

export function startWorker(): () => void {
  if (!config.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED=false，后台任务不会执行（缩略图/波形/导出将一直处于排队状态）');
    return () => undefined;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      let processed = 0;
      while (processed < 5 && (await runOnce())) processed += 1;
    } catch (err) {
      logger.error({ err }, 'worker 轮询失败');
    }
    if (!stopped) timer = setTimeout(tick, config.WORKER_POLL_MS);
  };
  timer = setTimeout(tick, 1000);

  // 每日维护任务：回收站清理 + 孤儿文件回收；重复入队是幂等的，这里只保证每天至少跑一次
  const daily = setInterval(() => {
    void prisma.job
      .create({ data: { type: 'trash_purge', payload: {} as never } })
      .then(() => prisma.job.create({ data: { type: 'storage_gc', payload: {} as never } }))
      .catch((err) => logger.error({ err }, '每日维护任务入队失败'));
  }, DAILY);

  logger.info({ pollMs: config.WORKER_POLL_MS }, '后台任务 worker 已启动');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(daily);
  };
}

export const __test__ = {
  runOnce,
  computeBackoffForTest: (attempts: number) => Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, attempts - 1)),
  advanceBatch,
};
