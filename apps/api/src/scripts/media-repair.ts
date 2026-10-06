/**
 * 媒体重处理中心 · 命令行入口（不依赖 HTTP，直接在本机库上跑）。
 *
 *   pnpm --filter @heirloom/api repair -- --help
 *   pnpm --filter @heirloom/api repair -- scan --family <fid|all> [--scope missing|failed|all] [--verify-on-disk] [--dry-run]
 *   pnpm --filter @heirloom/api repair -- run  --family <fid|all> [--scope ...]   # 派发后等待批次跑完
 *   pnpm --filter @heirloom/api repair -- status --run <runId>                    # 查看进度
 *
 * 与 HTTP 接口共用同一套服务逻辑，幂等语义完全一致。
 */
import { config } from '../config';
import { prisma, disconnectDb } from '../db';
import { startWorker } from '../queue/worker';
import type { CreateRepairRunInput } from '@heirloom/shared';
import {
  previewRun,
  createRun,
  toRunDto,
  type RepairScope,
} from '../services/mediaRepairService';
import type { FamilyContext } from '../services/permissionService';

function usage(): never {
  console.error(`用法: repair -- <command> [options]

命令:
  scan     扫描并输出修复计划与占用估算，不落任务
  run      发起批次并阻塞等待执行结束（本进程同时充当 worker）
  status   查看批次进度

选项:
  --family <fid|all>     指定家庭；all = 全部未删除家庭（scan/run 必填）
  --run <runId>          批次 ID（status 必填）
  --scope <scope>        missing（默认）| failed | all
  --kinds <list>         image,audio（默认两者）
  --verify-on-disk       同时检查磁盘派生文件是否真的存在
  --dry-run              scan 的别名语义（仅 scan 默认也不落库）
  --json                 只输出 JSON，便于脚本消费
  --help                 本帮助
`);
  process.exit(1);
}

interface CliArgs {
  command?: 'scan' | 'run' | 'status';
  family?: string;
  run?: string;
  scope: RepairScope;
  kinds?: string[];
  verifyOnDisk: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { scope: 'missing', verifyOnDisk: false, json: false };
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') usage();
  if (command !== 'scan' && command !== 'run' && command !== 'status') usage();
  args.command = command;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const next = () => rest[++i];
    if (flag === '--family') args.family = next();
    else if (flag === '--run') args.run = next();
    else if (flag === '--scope') {
      const v = next();
      if (v !== 'missing' && v !== 'failed' && v !== 'all') throw new Error(`非法 --scope: ${v}`);
      args.scope = v;
    } else if (flag === '--kinds') args.kinds = next()!.split(',').map((s) => s.trim()) as CliArgs['kinds'];
    else if (flag === '--verify-on-disk') args.verifyOnDisk = true;
    else if (flag === '--json') args.json = true;
    else throw new Error(`未知参数: ${flag}`);
  }
  return args;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function resolveFamilies(family?: string): Promise<{ id: string; name: string }[]> {
  if (!family) throw new Error('--family 必填（或用 all）');
  if (family === 'all') {
    return prisma.family.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
  }
  const row = await prisma.family.findFirst({ where: { id: family, deletedAt: null }, select: { id: true, name: true } });
  if (!row) throw new Error(`家庭不存在：${family}`);
  return [row];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'status') {
    if (!args.run) throw new Error('--run 必填');
    // CLI 直查，不走家庭权限校验
    const run = await prisma.mediaRepairRun.findUniqueOrThrow({ where: { id: args.run } });
    console.log(JSON.stringify(toRunDto(run), null, 2));
    await disconnectDb();
    return;
  }

  const families = await resolveFamilies(args.family);
  const input: CreateRepairRunInput = {
    scope: args.scope,
    verifyOnDisk: args.verifyOnDisk,
    kinds: args.kinds as CreateRepairRunInput['kinds'],
  };

  if (args.command === 'scan') {
    const reports = [];
    for (const f of families) {
      reports.push({ family: f, ...(await previewRun(f.id, input)) });
    }
    if (args.json) {
      console.log(JSON.stringify(reports, null, 2));
    } else {
      let totalBytes = 0;
      for (const r of reports) {
        totalBytes += r.bytesEstimate;
        console.log(
          `家庭 ${r.family.name}（${r.family.id}）：扫描 ${r.mediaScanned} 个媒体，` +
            `${r.mediaToRepair} 个需要修复，预计新增占用 ${fmtBytes(r.bytesEstimate)}（按内容去重 ${r.deduplicatedByContent} 个产物）`,
        );
      }
      console.log(`合计预计新增占用：${fmtBytes(totalBytes)}`);
    }
    await disconnectDb();
    return;
  }

  // run：本进程直接启动 worker，等待批次全部终结
  const sysadmin = await prisma.user.findFirstOrThrow({ where: { systemRole: 'sysadmin' } });
  const stop = startWorker();
  const runIds: string[] = [];
  for (const f of families) {
    const ctx: FamilyContext = { familyId: f.id, role: 'owner', memberId: 'cli' };
    const run = await createRun(sysadmin.id, ctx, input, { ip: null, userAgent: 'repair-cli' });
    runIds.push(run.id);
    if (!args.json) console.log(`已派发批次 ${run.id}（家庭 ${f.name}）`);
  }

  await waitForRuns(runIds, args.json);
  stop();
  await disconnectDb();
}

async function waitForRuns(runIds: string[], json: boolean): Promise<void> {
  const terminal = new Set(['done', 'done_with_errors', 'failed']);
  let lastProgress = -1;
  while (true) {
    const runs = await prisma.mediaRepairRun.findMany({ where: { id: { in: runIds } } });
    const allDone = runs.every((r) => terminal.has(r.status));
    if (!json) {
      const progress = runs.reduce((acc, r) => acc + toRunDto(r).progress, 0) / Math.max(1, runs.length);
      const rounded = Math.round(progress);
      if (rounded !== lastProgress || allDone) {
        process.stdout.write(`\r进度 ${rounded}%  `);
        lastProgress = rounded;
      }
    }
    if (allDone) {
      if (!json) process.stdout.write('\n');
      for (const r of runs) {
        const dto = toRunDto(r);
        if (json) console.log(JSON.stringify(dto));
        else
          console.log(
            `批次 ${r.id}：${dto.status}，成功 ${dto.doneCount}，跳过 ${dto.skippedCount}，失败 ${dto.failedCount}，实际新增 ${fmtBytes(dto.bytesActual)}`,
          );
        if (r.status === 'done_with_errors') process.exitCode = 2;
        if (r.status === 'failed') process.exitCode = 1;
      }
      return;
    }
    await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
  }
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
