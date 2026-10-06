import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Button, EmptyState, Spinner, Tag } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { formatBytes, formatDateTime } from '../../lib/format';
import type { RepairBatch, RepairPlan, RepairType } from '../../api/types';

const REPAIR_META: Record<RepairType, { label: string; desc: string; icon: string }> = {
  thumbnail: { label: '缩略图', desc: '为缺失缩略图的图片重新生成 480px 缩略图与 2400px 大图', icon: '🖼' },
  waveform: { label: '波形', desc: '为缺失波形的音频重新生成峰值波形（同时补齐时长与播放转码）', icon: '🎵' },
  duration: { label: '时长', desc: '仅探测缺失的音频时长并写回，不额外生成文件', icon: '⏱' },
};

const STATUS_META: Record<RepairBatch['status'], { label: string; tone: 'default' | 'success' | 'warn' | 'muted' }> = {
  running: { label: '进行中', tone: 'default' },
  done: { label: '全部成功', tone: 'success' },
  partial: { label: '部分失败', tone: 'warn' },
  failed: { label: '全部失败', tone: 'warn' },
};

export function RepairCenterPage() {
  const { fid } = useParams<{ fid: string }>();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [selected, setSelected] = useState<RepairType[]>(['thumbnail', 'waveform', 'duration']);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);

  const typesParam = selected.join(',');

  const plan = useQuery({
    queryKey: ['repair-plan', fid, typesParam],
    queryFn: () => api.get<RepairPlan>(`/families/${fid}/repairs/plan?repairs=${encodeURIComponent(typesParam)}`),
    enabled: Boolean(fid) && selected.length > 0,
    refetchInterval: activeBatchId ? 5000 : false,
  });

  const history = useQuery({
    queryKey: ['repair-batches', fid],
    queryFn: () => api.get<{ batches: RepairBatch[] }>(`/families/${fid}/repairs/batches`),
    enabled: Boolean(fid),
  });

  const activeBatch = useQuery({
    queryKey: ['repair-batch', fid, activeBatchId],
    queryFn: () => api.get<{ batch: RepairBatch }>(`/families/${fid}/repairs/batches/${activeBatchId}`),
    enabled: Boolean(fid && activeBatchId),
    refetchInterval: (q) => {
      const status = (q.state.data as { batch: RepairBatch } | undefined)?.batch.status;
      return status === 'running' ? 1500 : false;
    },
  });

  const createBatch = useMutation({
    mutationFn: () => api.post<{ batch: RepairBatch; reused?: boolean; nothingToRepair?: boolean }>(`/families/${fid}/repairs/batches`, { repairs: selected }),
    onSuccess: (data) => {
      if (data.nothingToRepair) {
        push('没有发现需要修复的媒体产物', 'info');
        return;
      }
      setActiveBatchId(data.batch.id);
      push(data.reused ? '已有相同内容的批次，已为你打开' : '重处理批次已创建', data.reused ? 'info' : 'success');
      void queryClient.invalidateQueries({ queryKey: ['repair-batches', fid] });
      void queryClient.invalidateQueries({ queryKey: ['repair-plan', fid] });
    },
    onError: (err: Error) => push(err.message, 'error'),
  });

  const retryFailed = useMutation({
    mutationFn: (batchId: string) => api.post<{ batch: RepairBatch }>(`/families/${fid}/repairs/batches/${batchId}/retry`),
    onSuccess: (data) => {
      setActiveBatchId(data.batch.id);
      push('失败目标已重新投递', 'success');
      void queryClient.invalidateQueries({ queryKey: ['repair-batches', fid] });
    },
    onError: (err: Error) => push(err.message, 'error'),
  });

  function toggle(type: RepairType) {
    setSelected((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));
  }

  const batch = activeBatch.data?.batch;
  const shownBatch = batch ?? history.data?.batches.find((b) => b.id === activeBatchId) ?? null;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>媒体重处理中心</h1>
          <p className="page-head__sub">批量修复缺失的缩略图、波形与时长。按文件内容摘要执行，重复提交不会产生重复任务。</p>
        </div>
      </header>

      <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="repair-options">
          {(Object.keys(REPAIR_META) as RepairType[]).map((type) => (
            <label key={type} className={`repair-option${selected.includes(type) ? ' repair-option--active' : ''}`}>
              <input type="checkbox" checked={selected.includes(type)} onChange={() => toggle(type)} />
              <span className="repair-option__icon" aria-hidden="true">{REPAIR_META[type].icon}</span>
              <span className="repair-option__text">
                <strong>{REPAIR_META[type].label}</strong>
                <small>{REPAIR_META[type].desc}</small>
              </span>
              {plan.data ? <Tag tone={plan.data.byRepair[type] ? 'warn' : 'muted'}>{plan.data.byRepair[type]} 项</Tag> : null}
            </label>
          ))}
        </div>

        <div className="repair-summary">
          {plan.isLoading ? (
            <Spinner label="正在扫描媒体库" />
          ) : plan.error ? (
            <p className="text-danger">扫描失败，请稍后重试</p>
          ) : plan.data ? (
            <dl className="repair-stats">
              <div>
                <dt>待修目标</dt>
                <dd>{plan.data.totalTargets} 个（{plan.data.uniqueFiles} 个物理文件）</dd>
              </div>
              <div>
                <dt>预计新增占用</dt>
                <dd>{formatBytes(plan.data.estimatedBytes)}</dd>
              </div>
            </dl>
          ) : null}
          <Button variant="primary" loading={createBatch.isPending} disabled={selected.length === 0 || (plan.data?.totalTargets ?? 0) === 0} onClick={() => createBatch.mutate()}>
            开始修复
          </Button>
        </div>
      </section>

      {shownBatch ? (
        <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="repair-batch__head">
            <div>
              <h2 style={{ margin: 0 }}>批次 {shownBatch.id.slice(-8)}</h2>
              <p className="muted" style={{ margin: '4px 0 0' }}>{formatDateTime(shownBatch.createdAt)} · {shownBatch.repairs.map((r) => REPAIR_META[r].label).join('、')}</p>
            </div>
            <Tag tone={STATUS_META[shownBatch.status].tone}>{STATUS_META[shownBatch.status].label}</Tag>
          </div>

          <div className="progress" role="progressbar" aria-valuenow={shownBatch.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress__bar" style={{ width: `${shownBatch.progress}%` }} />
          </div>
          <div className="repair-batch__counts">
            <span>进度 {shownBatch.progress}%</span>
            <span>成功 {shownBatch.succeededTargets}/{shownBatch.totalTargets}</span>
            <span>失败 {shownBatch.failedTargets}</span>
            {shownBatch.sourceMissing > 0 ? <span className="text-danger">原始文件缺失 {shownBatch.sourceMissing}</span> : null}
            <span>实际新增占用 {formatBytes(shownBatch.actualBytes)}（预估 {formatBytes(shownBatch.estimatedBytes)}）</span>
          </div>

          {shownBatch.failures.length > 0 ? (
            <details className="repair-failures">
              <summary>查看失败明细（{shownBatch.failures.length}）</summary>
              <ul>
                {shownBatch.failures.slice(-20).map((f, i) => (
                  <li key={`${f.mediaId}-${f.repair}-${i}`}>
                    <Tag tone="warn">{REPAIR_META[f.repair].label}</Tag> <code>{f.mediaId}</code> — {f.error}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {shownBatch.status !== 'running' && shownBatch.failedTargets > 0 ? (
            <Button size="sm" loading={retryFailed.isPending} onClick={() => retryFailed.mutate(shownBatch.id)}>
              重试失败项（{shownBatch.failedTargets}）
            </Button>
          ) : null}
        </section>
      ) : null}

      <section className="card card--flush">
        <h2 style={{ padding: 'var(--space-4) var(--space-4) 0', margin: 0 }}>历史批次</h2>
        {history.isLoading ? (
          <Spinner label="加载历史" />
        ) : !history.data || history.data.batches.length === 0 ? (
          <EmptyState title="还没有重处理批次" description="勾选上方修复项并点击「开始修复」，这里会保留每次批次的进度与结果。" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>批次</th>
                  <th>修复项</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>实际占用</th>
                  <th>时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.data.batches.map((b) => (
                  <tr key={b.id}>
                    <td><code>{b.id.slice(-8)}</code></td>
                    <td>{b.repairs.map((r) => REPAIR_META[r].label).join('、')}</td>
                    <td><Tag tone={STATUS_META[b.status].tone}>{STATUS_META[b.status].label}</Tag></td>
                    <td>{b.succeededTargets + b.failedTargets}/{b.totalTargets}</td>
                    <td>{formatBytes(b.actualBytes)}</td>
                    <td>{formatDateTime(b.createdAt)}</td>
                    <td>
                      <Button size="sm" variant="ghost" onClick={() => setActiveBatchId(b.id)}>
                        查看
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
