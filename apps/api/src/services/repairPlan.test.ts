import { describe, expect, it } from 'vitest';
import type { PlanMediaRow } from './repairPlan';
import {
  buildFingerprint,
  estimateThumbnailBytes,
  estimateWaveformBytes,
  needsRepair,
  planRepairs,
} from './repairPlan';

function image(overrides: Partial<PlanMediaRow> = {}): PlanMediaRow {
  return {
    id: 'img1',
    kind: 'image',
    sha256: 'a'.repeat(64),
    storageKey: 'families/f1/objects/aa/a.jpg',
    byteSize: 1_000_000n,
    thumbKey: null,
    waveformKey: null,
    durationMs: null,
    ...overrides,
  };
}

function audio(overrides: Partial<PlanMediaRow> = {}): PlanMediaRow {
  return {
    id: 'aud1',
    kind: 'audio',
    sha256: 'b'.repeat(64),
    storageKey: 'families/f1/objects/bb/b.webm',
    byteSize: 5_000_000n,
    thumbKey: null,
    waveformKey: null,
    durationMs: null,
    ...overrides,
  };
}

describe('needsRepair', () => {
  it('图片缺缩略图才需要修', () => {
    expect(needsRepair(image(), 'thumbnail')).toBe(true);
    expect(needsRepair(image({ thumbKey: 'k' }), 'thumbnail')).toBe(false);
  });

  it('音频的波形与时长分别判定', () => {
    expect(needsRepair(audio(), 'waveform')).toBe(true);
    expect(needsRepair(audio(), 'duration')).toBe(true);
    expect(needsRepair(audio({ waveformKey: 'w', durationMs: 123 }), 'waveform')).toBe(false);
    expect(needsRepair(audio({ durationMs: 0 }), 'duration')).toBe(true);
  });

  it('文档与类型不匹配的修复项直接跳过', () => {
    expect(needsRepair({ ...image(), kind: 'document' }, 'thumbnail')).toBe(false);
    expect(needsRepair(image(), 'waveform')).toBe(false);
    expect(needsRepair(audio(), 'thumbnail')).toBe(false);
  });
});

describe('planRepairs', () => {
  it('同时缺波形和时长的音频产生两条目标', () => {
    const { targets, estimatedBytes } = planRepairs([audio()], ['thumbnail', 'waveform', 'duration']);
    expect(targets.map((t) => t.repair).sort()).toEqual(['duration', 'waveform']);
    expect(estimatedBytes).toBeGreaterThan(0);
  });

  it('全部齐备时返回空计划', () => {
    const rows = [
      image({ thumbKey: 't' }),
      audio({ waveformKey: 'w', durationMs: 99 }),
    ];
    const { targets, estimatedBytes } = planRepairs(rows, ['thumbnail', 'waveform', 'duration']);
    expect(targets).toHaveLength(0);
    expect(estimatedBytes).toBe(0);
  });

  it('估算系数有上下界', () => {
    expect(estimateThumbnailBytes(10_000_000)).toBe(3_500_000);
    expect(estimateWaveformBytes(100)).toBe(4096);
    expect(estimateWaveformBytes(100_000_000)).toBe(16 * 1024);
  });
});

describe('buildFingerprint', () => {
  it('与顺序无关，与内容有关', async () => {
    const { targets: a } = planRepairs([image({ id: '1' }), audio({ id: '2' })], ['thumbnail', 'waveform']);
    const fp1 = await buildFingerprint('f1', a);
    const fp2 = await buildFingerprint('f1', [...a].reverse());
    expect(fp1).toBe(fp2);

    const { targets: b } = planRepairs([image({ id: '1', sha256: 'c'.repeat(64) }), audio({ id: '2' })], [
      'thumbnail',
      'waveform',
    ]);
    const fp3 = await buildFingerprint('f1', b);
    expect(fp3).not.toBe(fp1);

    const fp4 = await buildFingerprint('other-family', a);
    expect(fp4).not.toBe(fp1);
  });
});
