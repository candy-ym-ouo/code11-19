import { spawn } from 'node:child_process';
import { derivedKey } from '../storage/local';
import { config } from '../config';

let ffmpegAvailable: boolean | null = null;

function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    child.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout: Buffer.concat(out), stderr: err });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  const probe = await run(config.FFMPEG_PATH, ['-version'], { timeoutMs: 5000 });
  ffmpegAvailable = probe.code === 0;
  return ffmpegAvailable;
}

/** 仅探测时长（毫秒），不生成任何产物。重处理中心补齐缺失时长时使用。 */
export async function probeDurationMs(srcPath: string): Promise<number> {
  if (!(await hasFfmpeg())) {
    throw new Error('宿主机未安装 ffmpeg，无法探测时长');
  }
  const probe = await run(
    config.FFPROBE_PATH,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      srcPath,
    ],
    { timeoutMs: 60_000 },
  );
  if (probe.code !== 0) {
    throw new Error(`ffprobe 探测失败：${probe.stderr.slice(-300) || '退出码 ' + probe.code}`);
  }
  const seconds = Number.parseFloat(probe.stdout.toString().trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('ffprobe 未返回有效时长');
  }
  return Math.round(seconds * 1000);
}

export interface AudioVariants {
  transcodeKey: string | null;
  waveformKey: string | null;
  durationMs: number | null;
  peakCount: number;
}

/**
 * 音频处理：
 *  - 原始文件永久保留（调用方不入库覆盖）
 *  - 用 ffmpeg 转一份单声道 mp3 供在线播放，规避 Safari 对 webm/opus 的支持差异
 *  - 解码成 8kHz 单声道 PCM 后自行降采样出峰值数组，前端用它画波形（无需额外二进制依赖）
 * 容器里没装 ffmpeg 时退化为「只保留原始文件」，条目仍可播放，但 audiodata/waveform 为空。
 */
export async function processAudio(
  srcPath: string,
  familyId: string,
  sha256: string,
  put: (key: string, data: Buffer) => Promise<void>,
  tmpPathFor: (suffix: string) => string,
): Promise<AudioVariants> {
  if (!(await hasFfmpeg())) {
    return { transcodeKey: null, waveformKey: null, durationMs: null, peakCount: 0 };
  }

  const mp3Path = tmpPathFor('.mp3');
  const transcode = await run(
    config.FFMPEG_PATH,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '96k', mp3Path],
    { timeoutMs: 10 * 60 * 1000 },
  );
  if (transcode.code !== 0) {
    return { transcodeKey: null, waveformKey: null, durationMs: null, peakCount: 0 };
  }

  const transcodeKey = derivedKey(familyId, sha256, '.mp3');
  const fsp = await import('node:fs/promises');
  try {
    const mp3 = await fsp.readFile(mp3Path);
    await put(transcodeKey, mp3);
  } finally {
    // 转码产物已经写进内容寻址存储，临时文件不再需要
    await fsp.rm(mp3Path, { force: true });
  }

  const durationProbe = await run(
    config.FFPROBE_PATH,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', srcPath],
    { timeoutMs: 60_000 },
  );
  const durationSec = Number.parseFloat(durationProbe.stdout.toString().trim());
  const durationMs = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null;

  const pcm = await run(
    config.FFMPEG_PATH,
    ['-hide_banner', '-loglevel', 'error', '-i', srcPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { timeoutMs: 10 * 60 * 1000 },
  );
  const peaks = computePeaks(pcm.stdout, 900);
  const waveformKey = derivedKey(familyId, sha256, '.waveform.json');
  if (peaks.length) {
    await put(waveformKey, Buffer.from(JSON.stringify({ peaks, sampleRate: 8000, durationMs }), 'utf8'));
  }

  return { transcodeKey, waveformKey: peaks.length ? waveformKey : null, durationMs, peakCount: peaks.length };
}

/** 把 16bit PCM 按桶取绝对值最大值，归一化到 0..1。 */
export function computePeaks(pcm: Buffer, buckets: number): number[] {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0 || buckets <= 0) return [];
  const bucketSize = Math.max(1, Math.floor(sampleCount / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b += 1) {
    const start = b * bucketSize;
    if (start >= sampleCount) break;
    const end = Math.min(sampleCount, start + bucketSize);
    let max = 0;
    for (let i = start; i < end; i += 1) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > max) max = v;
    }
    peaks.push(Number((max / 32768).toFixed(3)));
  }
  return peaks;
}
