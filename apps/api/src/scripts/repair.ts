/**
 * 媒体重处理中心 CLI：不启动 HTTP 服务也能批量修复。
 *
 * 用法：
 *   pnpm --filter @heirloom/api repair --family <fid> [--types thumbnail,waveform,duration] [--wait] [--poll 2000]
 *
 * 只负责「扫描 + 建批 + 轮询进度」，实际处理仍由 worker 执行；
 * 加 --wait 时本进程会顺带承担 worker 角色（适合一次性维护任务，无需另起 API）。
 */
import { prisma, disconnectDb } from '../db';
import { logger } from '../logger';
import { createRepairBatch, getBatch } from '../services/repairService';
import { loadFamilyContext } from '../services/permissionService';
import { __test__ as workerHooks } from '../queue/worker';

interface Args {
  family?: string;
  types: Array<'thumbnail' | 'waveform' | 'duration'>;
  wait: boolean;
  poll: number;
}

const ALL_TYPES = ['thumbnail', 'waveform', 'duration'] as const;

function parseArgs(argv: string[]): Args {
  const out: Args = { types: [...ALL_TYPES], wait: false, poll: 2000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--family' && argv[i + 1]) out.family = argv[++i];
    else if (arg === '--types' && argv[i + 1]) {
      const requested = argv[++i]!.split(',').map((s) => s.trim());
      out.types = requested.filter((t): t is (typeof ALL_TYPES)[number] =>
        (ALL_TYPES as readonly string[]).includes(t),
      );
    } else if (arg === '--wait') out.wait = true;
    else if (arg === '--poll' && argv[i + 1]) out.poll = Math.max(500, Number.parseInt(argv[++i]!, 10) || 2000);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.family) {
    console.error('缺少 --family <家庭ID>');
    process.exitCode = 1;
    return;
  }
  if (args.types.length === 0) {
    console.error('--types 至少要包含 thumbnail / waveform / duration 中的一个');
    process.exitCode = 1;
    return;
  }

  const family = await prisma.family.findFirst({ where: { id: args.family, deletedAt: null } });
  if (!family) {
    console.error(`家庭不存在：${args.family}`);
    process.exitCode = 1;
    return;
  }

  const sysUser = await prisma.user.findFirst({ where: { systemRole: 'sysadmin' }, orderBy: { createdAt: 'asc' } });
  if (!sysUser) {
    console.error('找不到系统管理员账号，无法以其名义建批');
    process.exitCode = 1;
    return;
  }

  const ctx = await loadFamilyContext(sysUser.id, family.id);
  if (!ctx) {
    console.error(`系统管理员不是家庭 ${args.family} 的成员，无法代其建批`);
    process.exitCode = 1;
    return;
  }

  const result = await createRepairBatch(
    sysUser.id,
    ctx,
    args.types,
    { ip: null, userAgent: 'repair-cli' },
  );
  if (result.nothingToRepair) {
    console.log('没有发现需要修复的媒体产物。');
    return;
  }
  console.log(`批次 ${result.batchId}（${result.created ? '新建' : '复用已有批次'}），修复项：${args.types.join(', ')}`);

  if (!args.wait) {
    const batch = await getBatch(family.id, result.batchId);
    console.log(
      `目标 ${batch.totalTargets} 个 / 任务 ${batch.totalJobs} 个，预估新增占用 ${batch.estimatedBytes} 字节。worker 会在后台执行，可用 --wait 等待完成。`,
    );
    return;
  }

  // 本进程直接跑 worker 循环并轮询批次进度
  let lastProgress = -1;
  for (;;) {
    await workerHooks.runOnce().catch((err) => logger.error({ err }, 'CLI worker 执行失败'));
    const batch = await getBatch(family.id, result.batchId);
    if (batch.progress !== lastProgress) {
      console.log(
        `进度 ${batch.progress}%  成功 ${batch.succeededTargets}/${batch.totalTargets}  失败 ${batch.failedTargets}  实际新增 ${batch.actualBytes} 字节`,
      );
      lastProgress = batch.progress;
    }
    if (batch.status !== 'running') {
      console.log(`批次结束：${batch.status}（原始文件缺失 ${batch.sourceMissing} 个）`);
      if (batch.failures.length) {
        console.log('失败明细（最多展示 10 条）：');
        for (const f of batch.failures.slice(-10)) console.log(`  - [${f.repair}] ${f.mediaId}: ${f.error}`);
      }
      process.exitCode = batch.failedTargets > 0 ? 2 : 0;
      break;
    }
    await sleep(args.poll);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
