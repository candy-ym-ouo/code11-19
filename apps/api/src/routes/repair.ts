import { Router } from 'express';
import { createRepairRunSchema, listRepairItemsQuerySchema, type CreateRepairRunInput } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody, validateQuery, queryOf } from '../middleware/validation';
import * as repairService from '../services/mediaRepairService';

export const repairRouter = Router({ mergeParams: true });

/** 只扫描 + 估算占用，不落任何任务（占用估算按钮）。 */
repairRouter.post(
  '/preview',
  requireFamily('family:export'),
  writeLimiter,
  validateBody(createRepairRunSchema),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const body = req.body as CreateRepairRunInput;
    const preview = await repairService.previewRun(ctx.familyId, body);
    res.json({ preview });
  }),
);

repairRouter.post(
  '/runs',
  requireFamily('family:export'),
  writeLimiter,
  validateBody(createRepairRunSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const body = req.body as CreateRepairRunInput;
    const run = await repairService.createRun(user.id, ctx, body, clientMeta(req));
    res.status(202).json({ run });
  }),
);

repairRouter.get(
  '/runs',
  requireFamily('family:export'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json(await repairService.listRuns(ctx));
  }),
);

repairRouter.get(
  '/runs/:runId',
  requireFamily('family:export'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ run: await repairService.getRun(ctx, req.params.runId!) });
  }),
);

repairRouter.get(
  '/runs/:runId/items',
  requireFamily('family:export'),
  validateQuery(listRepairItemsQuerySchema),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    const query = queryOf<{ status?: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; limit?: number; offset?: number }>(req);
    res.json(await repairService.listRunItems(ctx, req.params.runId!, query));
  }),
);

repairRouter.post(
  '/runs/:runId/items/:itemId/retry',
  requireFamily('family:export'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const item = await repairService.retryItem(user.id, ctx, req.params.runId!, req.params.itemId!, clientMeta(req));
    res.json({ item });
  }),
);
