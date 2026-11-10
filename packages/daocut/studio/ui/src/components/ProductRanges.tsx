import React from 'react';
import { applyProductEdit, type ProductEdit } from '@/lib/product-manual';
import { parseSourceTime, productId, productEvidenceText, sourceTime, type ProductAnalysis, type ProductInterval, type UnassignedProductRange } from '@/lib/product-analysis';

const button = 'rounded border border-[var(--border)] px-2 py-1 text-[11px] transition duration-150 hover:bg-[var(--bg-hover)] active:scale-95 disabled:opacity-40';
const input = 'mt-1 w-full min-w-0 rounded border border-[var(--border)] bg-[var(--dock-pane)] px-2 py-1 outline-none transition focus:border-[var(--accent)]';
type Props = { analysis: ProductAnalysis; productId: string | null; selectedIntervalId: string; onSelectRange: (range: ProductInterval) => void; onSave: (next: ProductAnalysis) => Promise<void>; onLocate: (sourceId: string, ms: number) => void };

function RangeEditor({ analysis, initial, selectedProductId, onSave, onCancel }: { analysis: ProductAnalysis; initial?: ProductInterval | UnassignedProductRange; selectedProductId: string | null; onSave: (action: ProductEdit) => Promise<boolean>; onCancel: () => void }) {
  const [sourceId, setSourceId] = React.useState(initial?.sourceId ?? analysis.products.find(p => p.id === selectedProductId)?.sourceIds[0] ?? analysis.sources[0]?.id ?? '');
  const [targetId, setTargetId] = React.useState(initial && 'productId' in initial ? initial.productId : selectedProductId ?? '__new');
  const [name, setName] = React.useState('');
  const [start, setStart] = React.useState(sourceTime(initial?.startMs ?? 0));
  const [end, setEnd] = React.useState(initial ? sourceTime(initial.endMs) : '');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setError('');
    const startMs = parseSourceTime(start), endMs = parseSourceTime(end);
    if (startMs === null || endMs === null) { setError('请填写原片起止时间，例如 01:23.500'); return; }
    if (targetId === '__new' && !name.trim()) { setError('请填写新商品名称'); return; }
    setBusy(true);
    try {
      const saved = await onSave({ type: 'range', id: initial?.id ?? productId(), sourceId, productId: targetId === '__new' ? productId() : targetId, startMs, endMs, ...(targetId === '__new' ? { newProductName: name.trim() } : {}) });
      if (saved) onCancel();
    } finally { setBusy(false); }
  };
  return <form aria-label="修改讲解范围" onSubmit={event => void submit(event)} className="my-2 space-y-2 rounded border border-[var(--accent)]/40 bg-[var(--dock-pane)] p-2">
    <label className="block">来源视频<select className={input} aria-label="范围来源视频" value={sourceId} disabled={!!initial || busy} onChange={e => setSourceId(e.target.value)}>{analysis.sources.map(s => <option key={s.id} value={s.id}>{s.assetPath}</option>)}</select></label>
    <div className="grid grid-cols-2 gap-2"><label>原片起点<input aria-label="讲解起点" className={input} value={start} disabled={busy} onChange={e => setStart(e.target.value)} /></label><label>原片终点<input aria-label="讲解终点" className={input} value={end} disabled={busy} onChange={e => setEnd(e.target.value)} /></label></div>
    <label className="block">商品归属<select aria-label="范围商品归属" className={input} value={targetId} disabled={busy} onChange={e => setTargetId(e.target.value)}>{analysis.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="__new">归入新商品</option></select></label>
    {targetId === '__new' && <input className={input} aria-label="新商品名称" placeholder="新商品名称" value={name} disabled={busy} onChange={e => setName(e.target.value)} />}
    <p className="text-[10.5px] text-[var(--text-muted)]">保存到个人工程的讲解范围。原片取用和成片保持不变。</p>
    {error && <p role="alert" className="text-red-400">{error}</p>}
    <div className="flex gap-1"><button className={button} disabled={busy || !sourceId} type="submit">保存范围</button><button className={button} disabled={busy} type="button" onClick={onCancel}>取消</button></div>
  </form>;
}

export function ProductRanges({ analysis, productId: selectedId, selectedIntervalId, onSelectRange, onSave, onLocate }: Props) {
  const product = analysis.products.find(p => p.id === selectedId);
  const ranges = analysis.intervals.filter(i => i.productId === selectedId).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.startMs - b.startMs);
  const [editing, setEditing] = React.useState<ProductInterval | UnassignedProductRange | 'new' | null>(null);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [operation, setOperation] = React.useState<'merge' | 'split' | 'delete' | null>(null);
  const [target, setTarget] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  const sourceName = (id: string) => analysis.sources.find(s => s.id === id)?.assetPath ?? '来源不可用';
  const save = async (action: ProductEdit) => {
    if (busy) return false;
    setError(''); setNotice(''); setBusy(true);
    try { await onSave(applyProductEdit(analysis, action)); setNotice('讲解范围已保存'); setOperation(null); setSelected([]); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  };
  const row = (range: ProductInterval | UnassignedProductRange, pending = false) => <div key={range.id} data-product-interval={range.id} className="rounded border border-[var(--border)] p-2 transition duration-150 hover:border-[var(--accent)]/50">
    <div className="flex items-start gap-1">
      {operation === 'split' && !pending && <input type="checkbox" className="mt-1" aria-label={`拆分范围 ${sourceTime(range.startMs)} – ${sourceTime(range.endMs)}`} checked={selected.includes(range.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, range.id] : ids.filter(id => id !== range.id))} />}
      <button type="button" className={`min-w-0 flex-1 text-left transition hover:text-[var(--accent)] active:scale-[.99] ${!pending && range.id === selectedIntervalId ? 'text-[var(--accent)]' : ''}`} aria-pressed={pending ? undefined : range.id === selectedIntervalId} aria-label={`定位讲解 ${sourceTime(range.startMs)} – ${sourceTime(range.endMs)}`} onClick={() => { if (!pending && 'productId' in range) onSelectRange(range); else onLocate(range.sourceId, range.startMs); }}><span className="block">{sourceTime(range.startMs)} – {sourceTime(range.endMs)}</span><span className="block truncate text-[10px] text-[var(--text-muted)]" title={sourceName(range.sourceId)}>{sourceName(range.sourceId)}</span></button>
      <button type="button" className={button} disabled={busy} aria-label={`${pending ? '分配' : '调整'}范围 ${range.id}`} onClick={() => setEditing(range)}>{pending ? '分配' : '调整'}</button>
    </div>
    {pending && 'reason' in range && <p className="mt-1 text-[10.5px] text-[var(--warn)]">{range.reason}</p>}
    {!!range.review?.length && <p className="mt-1 text-[10px] text-[var(--text-muted)]">{range.review.join(' · ')}</p>}
    {!!range.evidence?.length && <details className="mt-1 text-[10.5px] text-[var(--text-muted)]"><summary className="cursor-pointer">识别依据</summary>{range.evidence.map((e, i) => <p key={i} className="mt-1 whitespace-pre-wrap">{productEvidenceText(e)}</p>)}</details>}
    {!pending && <button type="button" className="mt-1 text-[10px] text-[var(--text-muted)] transition hover:text-[var(--warn)]" disabled={busy} onClick={() => void save({ type: 'unassign', intervalId: range.id })}>移除归属，转待确认</button>}
    {editing !== 'new' && editing?.id === range.id && <RangeEditor analysis={analysis} initial={range} selectedProductId={selectedId} onSave={save} onCancel={() => setEditing(null)} />}
  </div>;
  return <section aria-label="商品讲解范围" className="shrink-0 space-y-2 border-b border-[var(--border)] px-3 py-2.5 text-[11.5px]">
    {product && <>
      <div className="flex items-center gap-1"><strong className="flex-1">讲解范围 · {ranges.length} 段</strong><button className={button} disabled={busy || !analysis.sources.length} onClick={() => setEditing('new')}>添加范围</button></div>
      <p className="text-[10.5px] text-[var(--text-muted)]">原片绝对时间 · 点击定位 · 每段独立保存</p>
      {!!product.aliases?.length && <details className="text-[10.5px] text-[var(--text-muted)]"><summary className="cursor-pointer">别名与归并依据</summary>{product.aliases.map((alias, i) => <p key={i}>{alias.name}：{alias.evidence.map(productEvidenceText).join('；') || '依据待补充'}</p>)}</details>}
      {!!product.review?.length && <p className="text-[10.5px] text-[var(--warn)]">{product.review.join(' · ')}</p>}
      {editing === 'new' && <RangeEditor analysis={analysis} selectedProductId={selectedId} onSave={save} onCancel={() => setEditing(null)} />}
      <div className="max-h-64 space-y-1.5 overflow-y-auto">{ranges.map(r => row(r))}</div>
      {!ranges.length && <p className="text-[var(--text-muted)]">尚无已归属讲解范围</p>}
      <details><summary className="cursor-pointer text-[10.5px] text-[var(--text-muted)]">修正商品归并</summary>
        <div className="mt-2 flex flex-wrap gap-1"><button className={button} disabled={busy || analysis.products.length < 2} onClick={() => { setOperation('merge'); setTarget(''); }}>合并到其他商品</button><button className={button} disabled={busy || !ranges.length} onClick={() => { setOperation('split'); setSelected([]); }}>拆出新商品</button><button className={button} disabled={busy} onClick={() => setOperation('delete')}>移除商品</button></div>
        {operation === 'merge' && <div className="mt-2 space-y-2"><label>保留的商品<select className={input} aria-label="合并目标商品" value={target} onChange={e => setTarget(e.target.value)}><option value="">请选择</option>{analysis.products.filter(p => p.id !== selectedId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><p className="text-[10.5px] text-[var(--text-muted)]">只合并商品归属，各次讲解保持独立。请先核对规格和套装。</p><button className={button} disabled={busy || !target} onClick={() => void save({ type: 'merge', productId: product.id, targetId: target })}>确认合并</button></div>}
        {operation === 'split' && <div className="mt-2 space-y-2"><p className="text-[10.5px]">勾选上方要拆出的讲解范围</p><input className={input} aria-label="拆出商品名称" value={newName} onChange={e => setNewName(e.target.value)} placeholder="新商品名称" /><button className={button} disabled={busy || !selected.length || !newName.trim()} onClick={() => void save({ type: 'split', productId: product.id, newProductId: productId(), name: newName, intervalIds: selected })}>确认拆分</button></div>}
        {operation === 'delete' && <div className="mt-2 space-y-2"><p className="text-[10.5px]">全部讲解范围移到待确认，结构候选保留在个人工程归档，原片和已入成片保持不变。</p><button className={button} disabled={busy} onClick={() => void save({ type: 'delete-product', productId: product.id })}>确认移除商品</button></div>}
        {operation && <button className={`${button} mt-2`} disabled={busy} onClick={() => setOperation(null)}>取消修正</button>}
      </details>
    </>}
    {!!analysis.unassigned?.length && <details open={!product}><summary className="cursor-pointer font-medium">待确认归属 · {analysis.unassigned.length} 段</summary><div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">{analysis.unassigned.map(r => row(r, true))}</div></details>}
    {notice && <p role="status" className="text-[var(--text-muted)]">{notice}</p>}
    {error && <p role="alert" className="text-red-400">{error}</p>}
  </section>;
}
