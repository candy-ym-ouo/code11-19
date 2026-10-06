import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Button, Field, Select, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatBytes, formatDateTime } from '../../lib/format';

type Scope = 'missing' | 'failed' | 'all';
type RunStatus = 'scanning' | 'queued' | 'running' | 'done' | 'done_with_errors' | 'failed';
type ItemStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
type Artifact = 'thumb' | 'large' | 'waveform' | 'transcode' | 'duration';

interface Preview {
  mediaScanned: number;
  mediaToRepair: number;
  bytesEstimate: number;
  deduplicatedByContent: number;
  items: { mediaId: string; kind: 'image' | 'audio'; originalName: string; artifacts: Artifact[]; bytesEstimate: number }[];
}

interface Run {
  id: string;
  scope: Scope;
  status: RunStatus;
  verifyOnDisk: boolean;
  total: number;
  doneCount: number;
  failedCount: number;
  skippedCount: number;
  progress: number;
  bytesEstimate: number;
  bytesActual: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface RunItem {
  id: string;
  mediaId: string;
  artifacts: Artifact[];
  status: ItemStatus;
  attempts: number;
  bytesEstimate: number;
  bytesActual: number;
  lastError: string | null;
  media: { id: string; originalName: string; kind: string; mimeType: string } | null;
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  scanning: '扫描中',
  queued: '排队中',
  running: '执行中',
  done: '已完成',
  done_with_errors: '完成（有失败）',
  failed: '失败',
};

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  pending: '等待中',
  running: '处理中',
  done: '已修复',
  skipped: '跳过',
  failed: '失败',
};

const ARTIFACT_LABEL: Record<Artifact, string> = {
  thumb: '缩略图',
  large: '大图',
  waveform: '波形',
  transcode: 'mp3 转码',
  duration: '时长',
};

export function RepairCenterPage() {
  const { fid = '' } = useParams<{ fid: string }>();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>('missing');
  const [verifyOnDisk, setVerifyOnDisk] = useState(true);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const runs = useQuery({
    queryKey: ['repair-runs', fid],
    queryFn: () => api.get<{ runs: Run[] }>(`/families/${fid}/repair/runs`),
    refetchInterval: (q) => {
      const list = (q.state.data as { runs: Run[] } | undefined)?.runs ?? [];
      // 还有未终结批次时继续轮询；全部终结则停止，省掉无谓请求
      return list.some((r) => ['scanning', 'queued', 'running'].includes(r.status)) ? 2000 : false;
    },
  });

  const preview = useMutation({
    mutationFn: () =>
      api.post<{ preview: Preview }>(`/families/${fid}/repair/preview`, { scope, verifyOnDisk }),
    onError: (err) => push(err instanceof ApiError ? err.message : '扫描失败', 'error'),
  });

  const start = useMutation({
    mutationFn: () => api.post<{ run: Run }>(`/families/${fid}/repair/runs`, { scope, verifyOnDisk }),
    onSuccess: async (data) => {
      push('重处理批次已开始', 'success');
      setSelectedRun(data.run.id);
      await queryClient.invalidateQueries({ queryKey: ['repair-runs', fid] });
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '发起失败', 'error'),
  });

  const latestActive = (runs.data?.runs ?? []).find((r) => ['scanning', 'queued', 'running'].includes(r.status));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>媒体重处理中心</h1>
          <p className="page-head__sub">
            批量补齐缺失的缩略图、波形与时长。按文件内容（sha256）幂等执行：同一批媒体重复发起不会重复生成；已经齐全的媒体会自动跳过。
          </p>
        </div>
      </div>

      <section className="card">
        <h2 style={{ marginBottom: 'var(--space-4)' }}>发起修复</h2>
        <div className="row" style={{ gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="扫描范围">
            <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)} style={{ minWidth: 180 }}>
              <option value="missing">仅缺失产物（默认）</option>
              <option value="failed">仅历史处理失败</option>
              <option value="all">全部图片/音频（强制重建）</option>
            </Select>
          </Field>
          <label className="row" style={{ gap: 8, paddingBottom: 10 }}>
            <input type="checkbox" checked={verifyOnDisk} onChange={(e) => setVerifyOnDisk(e.target.checked)} />
            <span>同时核对磁盘文件（迁移或误删后建议开启）</span>
          </label>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <Button variant="secondary" loading={preview.isPending} onClick={() => preview.mutate()}>
            只扫描并估算占用
          </Button>
          <Button variant="primary" loading={start.isPending} disabled={Boolean(latestActive)} onClick={() => start.mutate()}>
            {latestActive ? '已有批次在执行' : '开始批量修复'}
          </Button>
        </div>
        {latestActive ? (
          <p className="muted" style={{ marginTop: 'var(--space-3)' }}>
            有批次正在执行，完成后才能发起新批次；你也可以
            <Link to={`/f/${fid}/settings`}>回到设置页</Link>继续做别的事，任务在后台运行。
          </p>
        ) : null}
        {preview.data ? <PreviewPanel data={preview.data.preview} onStart={() => start.mutate()} starting={start.isPending} /> : null}
      </section>

      {runs.isLoading ? (
        <Spinner />
      ) : (
        <section className="card">
          <h2 style={{ marginBottom: 'var(--space-3)' }}>修复批次</h2>
          {(runs.data?.runs ?? []).length === 0 ? (
            <p className="muted">还没有发起过重处理。先「只扫描并估算占用」看看有多少媒体需要修。</p>
          ) : (
            <div className="log-list">
              {(runs.data?.runs ?? []).map((run) => (
                <RunRow key={run.id} run={run} expanded={selectedRun === run.id} onToggle={() => setSelectedRun(selectedRun === run.id ? null : run.id)} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function PreviewPanel({ data, onStart, starting }: { data: Preview; onStart: () => void; starting: boolean }) {
  return (
    <div className="card" style={{ background: 'var(--surface-2)', marginTop: 'var(--space-4)' }}>
      <div className="row row--between">
        <strong>扫描结果</strong>
        <Tag tone="success">预计新增占用 {formatBytes(data.bytesEstimate)}</Tag>
      </div>
      <p className="muted" style={{ margin: 'var(--space-2) 0' }}>
        共扫描 {data.mediaScanned} 个图片/音频，{data.mediaToRepair} 个需要修复；按内容去重后将生成 {data.deduplicatedByContent}{' '}
        个派生文件。估算依据：缩略图≈45KB、大图≤原图 75%（封顶 2MB）、mp3≤原始 60%（封顶 80MB）、波形≈10KB。
      </p>
      {data.items.length > 0 ? (
        <details>
          <summary className="muted" style={{ cursor: 'pointer' }}>
            查看前 {data.items.length} 条明细
          </summary>
          <div className="log-list" style={{ marginTop: 'var(--space-2)' }}>
            {data.items.map((it) => (
              <div key={it.mediaId} className="log-item">
                <div className="log-item__body">
                  <div>{it.originalName}</div>
                  <div className="log-item__meta">
                    {it.kind === 'image' ? '图片' : '音频'} · 缺：{it.artifacts.map((a) => ARTIFACT_LABEL[a]).join('、')} · ≈
                    {formatBytes(it.bytesEstimate)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {data.mediaToRepair > 0 ? (
        <Button size="sm" variant="primary" loading={starting} style={{ marginTop: 'var(--space-3)' }} onClick={onStart}>
          按此计划开始修复
        </Button>
      ) : (
        <p style={{ marginTop: 'var(--space-3)', color: 'var(--success, #2f7d32)' }}>所有媒体产物齐全，无需修复。</p>
      )}
    </div>
  );
}

function RunRow({ run, expanded, onToggle }: { run: Run; expanded: boolean; onToggle: () => void }) {
  const active = ['scanning', 'queued', 'running'].includes(run.status);
  return (
    <div className="log-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="row row--between">
        <div className="log-item__body">
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <strong>{RUN_STATUS_LABEL[run.status]}</strong>
            <Tag tone={run.status === 'done' ? 'success' : run.failedCount > 0 ? 'warn' : 'muted'}>
              {scopeLabel(run.scope)}
            </Tag>
            {run.verifyOnDisk ? <Tag>核对磁盘</Tag> : null}
          </div>
          <div className="log-item__meta">
            {formatDateTime(run.createdAt)} · 共 {run.total} · 成功 {run.doneCount} · 跳过 {run.skippedCount} · 失败 {run.failedCount}
            {run.finishedAt ? ` · 实际新增 ${formatBytes(run.bytesActual)}` : run.bytesEstimate ? ` · 预计新增 ${formatBytes(run.bytesEstimate)}` : ''}
          </div>
        </div>
        <Button size="sm" onClick={onToggle}>
          {expanded ? '收起明细' : '查看明细'}
        </Button>
      </div>
      <div style={{ marginTop: 8 }}>
        <div className="progress" aria-label={`进度 ${run.progress}%`}>
          <div className="progress__bar" style={{ width: `${run.progress}%` }} />
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {run.status === 'scanning' ? '正在扫描媒体库…' : `${run.progress}%`}
        </div>
      </div>
      {expanded ? <RunItems run={run} active={active} /> : null}
    </div>
  );
}

function scopeLabel(scope: Scope): string {
  return scope === 'missing' ? '仅缺失' : scope === 'failed' ? '仅失败' : '全部重建';
}

function RunItems({ run, active }: { run: Run; active: boolean }) {
  const { fid = '' } = useParams<{ fid: string }>();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [filter, setFilter] = useState<'' | ItemStatus>('');

  const items = useQuery({
    queryKey: ['repair-items', fid, run.id, filter],
    queryFn: () =>
      api.get<{ total: number; items: RunItem[] }>(
        `/families/${fid}/repair/runs/${run.id}/items?limit=200${filter ? `&status=${filter}` : ''}`,
      ),
    refetchInterval: active ? 3000 : false,
  });

  const retry = useMutation({
    mutationFn: (itemId: string) => api.post(`/families/${fid}/repair/runs/${run.id}/items/${itemId}/retry`),
    onSuccess: async () => {
      push('已重新入队', 'success');
      await queryClient.invalidateQueries({ queryKey: ['repair-items', fid, run.id] });
      await queryClient.invalidateQueries({ queryKey: ['repair-runs', fid] });
    },
    onError: (err) => push(err instanceof ApiError ? err.message : '重试失败', 'error'),
  });

  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <div className="row" style={{ gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}>
        <span className="muted">筛选：</span>
        {(['', 'failed', 'done', 'skipped', 'pending'] as const).map((s) => (
          <Button key={s || 'all'} size="sm" variant={filter === s ? 'primary' : 'ghost'} onClick={() => setFilter(s)}>
            {s === '' ? '全部' : ITEM_STATUS_LABEL[s]}
          </Button>
        ))}
      </div>
      {run.lastError ? <p className="field__error">{run.lastError}</p> : null}
      {items.isLoading ? (
        <Spinner />
      ) : (items.data?.items ?? []).length === 0 ? (
        <p className="muted">暂无明细（扫描完成后出现）。</p>
      ) : (
        <div className="log-list">
          {(items.data?.items ?? []).map((it) => (
            <div key={it.id} className="log-item">
              <div className="log-item__body">
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <span>{it.media?.originalName ?? '媒体已删除'}</span>
                  <Tag tone={it.status === 'done' ? 'success' : it.status === 'failed' ? 'warn' : 'muted'}>
                    {ITEM_STATUS_LABEL[it.status]}
                  </Tag>
                  {it.attempts > 1 ? <span className="muted">第 {it.attempts} 次尝试</span> : null}
                </div>
                <div className="log-item__meta">
                  {it.artifacts.map((a) => ARTIFACT_LABEL[a]).join('、')}
                  {it.bytesActual > 0 ? ` · 新增 ${formatBytes(it.bytesActual)}` : ''}
                  {it.lastError ? ` · ${it.lastError}` : ''}
                </div>
              </div>
              {it.status === 'failed' ? (
                <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(it.id)}>
                  重试
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
