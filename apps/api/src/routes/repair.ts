import { Router } from 'express';
import { createRepairBatchSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as repairService from '../services/repairService';

export const repairRouter = Router({ mergeParams: true });

/** 预扫描：返回待修数量与占用估算，不创建任何任务。供前端先给用户看影响面。 */
repairRouter.get(
  '/plan',
  requireFamily('family:update'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const requested = (req.query.repairs as string | undefined)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const repairs = (requested?.length ? requested : ['thumbnail', 'waveform', 'duration']).filter(
      (r): r is 'thumbnail' | 'waveform' | 'duration' => r === 'thumbnail' || r === 'waveform' || r === 'duration',
    );
    const { targets, estimatedBytes } = await repairService.scanFamily(ctx.familyId, repairs);
    const byRepair = { thumbnail: 0, waveform: 0, duration: 0 };
    for (const t of targets) byRepair[t.repair] += 1;
    res.json({
      repairs,
      totalTargets: targets.length,
      byRepair,
      estimatedBytes,
      // 内容寻址存储里同一物理文件只处理一次，这是预计实际要跑的任务数
      uniqueFiles: new Set(targets.map((t) => `${t.storageKey}|${t.repair}`)).size,
    });
  }),
);

repairRouter.post(
  '/batches',
  requireFamily('family:update'),
  writeLimiter,
  validateBody(createRepairBatchSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const result = await repairService.createRepairBatch(user.id, ctx, req.body.repairs, clientMeta(req));
    if (result.nothingToRepair) {
      res.status(200).json({ nothingToRepair: true, message: '没有发现需要修复的媒体产物' });
      return;
    }
    const batch = await repairService.getBatch(ctx.familyId, result.batchId);
    res.status(result.created ? 202 : 200).json({ batch, reused: !result.created });
  }),
);

repairRouter.get(
  '/batches',
  requireFamily('family:update'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ batches: await repairService.listBatches(ctx.familyId) });
  }),
);

repairRouter.get(
  '/batches/:batchId',
  requireFamily('family:update'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ batch: await repairService.getBatch(ctx.familyId, req.params.batchId!) });
  }),
);

repairRouter.post(
  '/batches/:batchId/retry',
  requireFamily('family:update'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const result = await repairService.retryFailed(user.id, ctx, req.params.batchId!, clientMeta(req));
    const batch = await repairService.getBatch(ctx.familyId, result.batchId);
    res.status(202).json({ batch, retried: result.retried });
  }),
);
