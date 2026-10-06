import { describe, expect, it, vi } from 'vitest';

// planArtifacts 依赖 storage 的 statObject → config → 环境变量，mock 掉磁盘层
const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }));
vi.mock('../storage/local', async () => {
  const actual = await vi.importActual<typeof import('../storage/local')>('../storage/local');
  return { ...actual, statObject: statMock };
});

import { planArtifacts, estimateArtifacts, ESTIMATE } from '../services/mediaRepairService';

describe('planArtifacts（缺失产物判定）', () => {
  it('图片：数据库标记齐全且不校验磁盘时无需修复', async () => {
    const missing = await planArtifacts(
      { kind: 'image', thumbKey: 't', largeKey: 'l', waveformKey: null, transcodeKey: null, durationMs: null },
      { verifyOnDisk: false },
    );
    expect(missing).toEqual([]);
  });

  it('图片：缺缩略图与大图时两者都列出', async () => {
    const missing = await planArtifacts(
      { kind: 'image', thumbKey: null, largeKey: null, waveformKey: null, transcodeKey: null, durationMs: null },
      { verifyOnDisk: false },
    );
    expect(missing).toEqual(['thumb', 'large']);
  });

  it('verifyOnDisk：数据库有 key 但磁盘文件丢失时重新列为缺失', async () => {
    statMock.mockResolvedValue(null); // 全部不存在
    const missing = await planArtifacts(
      { kind: 'image', thumbKey: 'ghost-thumb', largeKey: 'ghost-large', waveformKey: null, transcodeKey: null, durationMs: null },
      { verifyOnDisk: true },
    );
    expect(missing).toEqual(['thumb', 'large']);
  });

  it('verifyOnDisk：磁盘文件健在时不重复处理（幂等）', async () => {
    statMock.mockResolvedValue({ size: 123 });
    const missing = await planArtifacts(
      { kind: 'image', thumbKey: 'thumb', largeKey: 'large', waveformKey: null, transcodeKey: null, durationMs: null },
      { verifyOnDisk: true },
    );
    expect(missing).toEqual([]);
  });

  it('音频：波形/转码/时长三项独立判定', async () => {
    const missing = await planArtifacts(
      {
        kind: 'audio',
        thumbKey: null,
        largeKey: null,
        waveformKey: 'w', // 已有波形
        transcodeKey: null,
        durationMs: null,
      },
      { verifyOnDisk: false },
    );
    expect(missing).toEqual(['transcode', 'duration']);
  });

  it('文档不需要重处理', async () => {
    const missing = await planArtifacts(
      { kind: 'document', thumbKey: null, largeKey: null, waveformKey: null, transcodeKey: null, durationMs: null },
      { verifyOnDisk: false },
    );
    expect(missing).toEqual([]);
  });
});

describe('estimateArtifacts（占用估算）', () => {
  it('缩略图固定约 45KB，大图按原图比例并封顶 2MB', () => {
    const small = estimateArtifacts({ kind: 'image', sha256: 'a', byteSize: BigInt(500 * 1024) }, ['thumb', 'large']);
    expect(small).toBe(ESTIMATE.thumbBytes + Math.round(500 * 1024 * ESTIMATE.largeRatio));

    const huge = estimateArtifacts({ kind: 'image', sha256: 'b', byteSize: BigInt(20 * 1024 * 1024) }, ['large']);
    expect(huge).toBe(ESTIMATE.largeCapBytes);
  });

  it('音频转码按比例估算并封顶，波形约 10KB，时长不占盘', () => {
    const bytes = estimateArtifacts(
      { kind: 'audio', sha256: 'c', byteSize: BigInt(10 * 1024 * 1024) },
      ['transcode', 'waveform', 'duration'],
    );
    expect(bytes).toBe(Math.round(10 * 1024 * 1024 * ESTIMATE.transcodeRatio) + ESTIMATE.waveformBytes);

    const capped = estimateArtifacts(
      { kind: 'audio', sha256: 'd', byteSize: BigInt(500 * 1024 * 1024) },
      ['transcode'],
    );
    expect(capped).toBe(ESTIMATE.transcodeCapBytes);
  });
});
