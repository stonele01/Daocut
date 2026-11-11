import { productId, type ProductAnalysis, type ProductInterval, type UnassignedProductRange } from './product-analysis.ts';

type RangeEdit = { type: 'range'; id: string; sourceId: string; productId: string; startMs: number; endMs: number; newProductName?: string };
export type ProductEdit = RangeEdit
  | { type: 'rename'; productId: string; name: string }
  | { type: 'unassign'; intervalId: string }
  | { type: 'delete-product'; productId: string }
  | { type: 'merge'; productId: string; targetId: string }
  | { type: 'split'; productId: string; newProductId: string; name: string; intervalIds: string[] };

function withManualBounds<T extends ProductInterval | UnassignedProductRange>(value: T, startMs: number, endMs: number): T {
  const next = { ...value, startMs, endMs } as T & { firstCue?: number; lastCue?: number };
  if (startMs !== value.startMs || endMs !== value.endMs) {
    // Human boundaries need not coincide with ASR cues. Keep only complete,
    // time-supported quotes; the original evidence stays in the AI proposal/history.
    delete next.firstCue; delete next.lastCue;
    if (next.evidence) next.evidence = next.evidence.filter(e => typeof e !== 'string' && e.startMs >= startMs && e.endMs <= endMs);
    next.origin = 'manual';
  }
  return next;
}

/** Edits the effective product document only. The server keeps the original AI proposals separately. */
export function applyProductEdit(data: ProductAnalysis, action: ProductEdit): ProductAnalysis {
  const next = structuredClone(data);
  next.unassigned ??= [];
  const needProduct = (id: string) => { const found = next.products.find(p => p.id === id); if (!found) throw new Error('商品已变化，请重新读取'); return found; };
  const name = (value: string) => { const clean = value.trim(); if (!clean) throw new Error('商品名称不能为空'); return clean; };
  const archive = (ids: Set<string>) => {
    const removed = next.candidates.filter(c => ids.has(c.intervalId));
    if (removed.length) next.archivedCandidates = [...(next.archivedCandidates ?? []), ...removed];
    next.candidates = next.candidates.filter(c => !ids.has(c.intervalId));
  };
  const unassign = (range: ProductInterval) => {
    next.unassigned = [...(next.unassigned ?? []), { id: range.id, sourceId: range.sourceId, startMs: range.startMs, endMs: range.endMs, kind: 'uncertain', reason: '人工移除商品归属', evidence: range.evidence ?? [], review: ['待确认商品归属', '画面待核实'], origin: 'manual' }];
  };
  const move = (ids: Set<string>, targetId: string) => {
    const target = needProduct(targetId);
    for (const range of [...next.intervals, ...(next.scopes ?? [])]) if (ids.has(range.id)) {
      range.productId = targetId;
      if (!target.sourceIds.includes(range.sourceId)) target.sourceIds.push(range.sourceId);
    }
    for (const candidate of next.candidates) if (ids.has(candidate.intervalId)) candidate.productId = targetId;
  };
  if (action.type === 'rename') {
    const product = needProduct(action.productId); product.name = name(action.name);
  } else if (action.type === 'range') {
    const source = next.sources.find(s => s.id === action.sourceId);
    if (!source || !Number.isFinite(action.startMs) || !Number.isFinite(action.endMs) || action.startMs < 0 || action.endMs <= action.startMs || (source.durationMs !== null && action.endMs > source.durationMs)) throw new Error('讲解范围无效，请检查原片起止时间');
    if (action.newProductName) {
      if (next.products.some(p => p.id === action.productId)) throw new Error('新商品身份重复');
      next.products.push({ id: action.productId, name: name(action.newProductName), sourceIds: [action.sourceId], origin: 'manual' });
    }
    const product = needProduct(action.productId);
    const existing = next.intervals.find(i => i.id === action.id);
    const pending = next.unassigned?.find(i => i.id === action.id);
    const previous = existing ?? pending;
    if (next.scopes?.some(i => i.id === action.id)) throw new Error('检查范围不能直接改为讲解范围');
    if (previous && previous.sourceId !== action.sourceId) throw new Error('已有范围不能替换来源视频');
    const startMs = Math.round(action.startMs), endMs = Math.round(action.endMs);
    if (startMs >= endMs) throw new Error('讲解范围无效，请检查原片起止时间');
    const range = withManualBounds<ProductInterval>({ ...(existing ?? { origin: 'manual' }), id: action.id, sourceId: action.sourceId, productId: action.productId, startMs: existing?.startMs ?? pending?.startMs ?? startMs, endMs: existing?.endMs ?? pending?.endMs ?? endMs, ...(pending ? { evidence: pending.evidence, review: pending.review } : {}) }, startMs, endMs);
    next.intervals = existing ? next.intervals.map(i => i.id === action.id ? range : i) : [...next.intervals, range];
    next.unassigned = next.unassigned!.flatMap(item => {
      if (item.sourceId !== range.sourceId || item.endMs <= startMs || item.startMs >= endMs) return [item.id === range.id ? { ...item, id: productId() } : item];
      const remainder = (from: number, to: number): UnassignedProductRange => ({
        ...withManualBounds(item, from, to), id: productId(), kind: 'uncertain',
        reason: '人工调整讲解范围后剩余内容，归属待确认',
      });
      return [
        ...(item.startMs < startMs ? [remainder(item.startMs, startMs)] : []),
        ...(item.endMs > endMs ? [remainder(endMs, item.endMs)] : []),
      ];
    });
    if (!product.sourceIds.includes(action.sourceId)) product.sourceIds.push(action.sourceId);
    for (const candidate of next.candidates) if (candidate.intervalId === action.id) candidate.productId = action.productId;
  } else if (action.type === 'unassign') {
    const range = next.intervals.find(i => i.id === action.intervalId);
    if (!range) throw new Error('讲解范围已变化，请重新读取');
    unassign(range); archive(new Set([range.id]));
    next.intervals = next.intervals.filter(i => i.id !== range.id);
  } else if (action.type === 'delete-product') {
    const product = needProduct(action.productId);
    const ranges = next.intervals.filter(i => i.productId === product.id);
    ranges.forEach(unassign);
    const ids = new Set([...ranges, ...(next.scopes ?? []).filter(i => i.productId === product.id)].map(i => i.id));
    archive(ids);
    next.intervals = next.intervals.filter(i => i.productId !== product.id);
    if (next.scopes) next.scopes = next.scopes.filter(i => i.productId !== product.id);
    next.products = next.products.filter(p => p.id !== product.id);
  } else if (action.type === 'merge') {
    const product = needProduct(action.productId), target = needProduct(action.targetId);
    if (product.id === target.id) throw new Error('请选择另一个商品');
    const ids = new Set([...next.intervals, ...(next.scopes ?? [])].filter(i => i.productId === product.id).map(i => i.id));
    move(ids, target.id);
    target.sourceIds = [...new Set([...target.sourceIds, ...product.sourceIds])];
    target.aliases = [...(target.aliases ?? []), ...(product.aliases ?? []), { name: product.name, evidence: ['人工确认合并'] }];
    next.products = next.products.filter(p => p.id !== product.id);
  } else {
    needProduct(action.productId);
    if (!action.intervalIds.length || new Set(action.intervalIds).size !== action.intervalIds.length || action.intervalIds.some(id => !next.intervals.some(i => i.id === id && i.productId === action.productId))) throw new Error('请选择当前商品的讲解范围');
    if (next.products.some(p => p.id === action.newProductId)) throw new Error('新商品身份重复');
    next.products.push({ id: action.newProductId, name: name(action.name), sourceIds: [], origin: 'manual' });
    move(new Set(action.intervalIds), action.newProductId);
  }
  return next;
}

export function productRangeSummary(data: ProductAnalysis, productId: string) {
  const ranges = data.intervals.filter(i => i.productId === productId);
  return { ranges, count: ranges.length, totalMs: ranges.reduce((sum, range) => sum + range.endMs - range.startMs, 0) };
}

/** Explicit single-product shortcut; never merges existing lectures/returns. */
export function applyWholeProductLecture(data: ProductAnalysis, selectedProductId: string, sourceId: string): ProductAnalysis {
  const source = data.sources.find(s => s.id === sourceId), product = data.products.find(p => p.id === selectedProductId);
  if (!source || !product?.sourceIds.includes(sourceId)) throw new Error('请选择当前商品的来源视频');
  if (data.intervals.some(i => i.sourceId === sourceId) || data.scopes?.some(i => i.sourceId === sourceId) || data.unassigned?.some(i => i.sourceId === sourceId)) throw new Error('此视频已有讲解范围，请选择或调整已有范围');
  if (data.products.filter(p => p.sourceIds.includes(sourceId)).length !== 1) throw new Error('此视频关联多个商品，请先核对讲解范围');
  if (source.durationMs === null || !Number.isFinite(source.durationMs) || source.durationMs <= 0) throw new Error('视频时长不可用，请先核对来源');
  return applyProductEdit(data, { type: 'range', id: productId(), sourceId, productId: selectedProductId, startMs: 0, endMs: source.durationMs });
}
