import type { MediaKind } from '@prisma/client';

export type RepairType = 'thumbnail' | 'waveform' | 'duration';

/** 规划阶段只需要这些字段，全部来自数据库行，不碰磁盘，便于单测。 */
export interface PlanMediaRow {
  id: string;
  kind: MediaKind;
  sha256: string;
  storageKey: string;
  byteSize: bigint | number;
  thumbKey: string | null;
  waveformKey: string | null;
  durationMs: number | null;
}

export interface RepairTarget {
  mediaId: string;
  sha256: string;
  storageKey: string;
  repair: RepairType;
  /** 原始文件字节数，估算占用用。 */
  size: number;
}

/**
 * 产物写入前的经验系数（相对原始文件大小），偏保守：
 *  - 缩略图 480px webp + 2400px 大图，合计通常不超过原图的 35%
 *  - 波形 JSON（900 桶、3 位小数）通常 4KB 上下，封顶 16KB
 *  - 时长只是数据库里一个整数，按 0 计，仅提示不产生文件
 */
export const ESTIMATE = {
  imageDerivedFactor: 0.35,
  waveformMin: 4 * 1024,
  waveformPerByte: 0.001,
  waveformMax: 16 * 1024,
} as const;

export function estimateThumbnailBytes(srcSize: number): number {
  return Math.ceil(srcSize * ESTIMATE.imageDerivedFactor);
}

export function estimateWaveformBytes(srcSize: number): number {
  return Math.min(
    ESTIMATE.waveformMax,
    Math.max(ESTIMATE.waveformMin, Math.ceil(srcSize * ESTIMATE.waveformPerByte)),
  );
}

/** 判断一条媒体在给定修复项下是否需要重处理。 */
export function needsRepair(m: PlanMediaRow, repair: RepairType): boolean {
  switch (repair) {
    case 'thumbnail':
      return m.kind === 'image' && !m.thumbKey;
    case 'waveform':
      return m.kind === 'audio' && !m.waveformKey;
    case 'duration':
      // 0 或负数不是有效时长，视作缺失（ffprobe 成功时不可能返回 0）
      return m.kind === 'audio' && (m.durationMs == null || m.durationMs <= 0);
  }
}

/**
 * 纯函数：扫出待修目标并估算占用。
 * 同一媒体的「波形 + 时长」都缺失时会产生两条目标（一个任务会顺带把两者都修好，
 * 另一个任务执行时通常直接幂等跳过）。
 */
export function planRepairs(rows: PlanMediaRow[], repairs: RepairType[]): { targets: RepairTarget[]; estimatedBytes: number } {
  const targets: RepairTarget[] = [];
  let estimatedBytes = 0;
  for (const m of rows) {
    const size = Number(m.byteSize);
    for (const repair of repairs) {
      if (!needsRepair(m, repair)) continue;
      targets.push({ mediaId: m.id, sha256: m.sha256, storageKey: m.storageKey, repair, size });
      if (repair === 'thumbnail') estimatedBytes += estimateThumbnailBytes(size);
      else if (repair === 'waveform') estimatedBytes += estimateWaveformBytes(size);
    }
  }
  return { targets, estimatedBytes };
}

/**
 * 内容摘要指纹：同一份内容（sha256 + 修复项集合）的待修清单相同。
 * 对 sha 排序后哈希，保证扫描顺序不影响指纹 —— 重复执行得到同一个批次键。
 */
export async function buildFingerprint(familyId: string, targets: RepairTarget[]): Promise<string> {
  const { createHash } = await import('node:crypto');
  const lines = targets
    .map((t) => `${t.sha256}:${t.repair}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(`${familyId}\n${lines}`).digest('hex').slice(0, 32);
}
