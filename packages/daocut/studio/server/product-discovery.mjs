import { createHash } from 'node:crypto';
import { DISCOVER_PRODUCTS_PROMPT } from './approved-prompts.mjs';

export const DISCOVERY_VERSION = 'product-discovery-v1';
export const PREVIOUS_DISCOVERY_PROMPT = `你只检查直播转写，没有检查原音或画面。识别完整商品讲解，不将简短提及、闲聊、过渡、混讲当作完整讲解。相同商品返场保留独立范围，不包住中间其他商品。不同规格或套装、证据不足的别名不能强行合并。时间由程序按原片 cue 恢复，只输出输入中的全局 cue 索引。跨窗口可以引用上下文，不能臆造窗口外索引。已知商品只供核对：复用 key 必须同名同规格；不同叫法合并必须给 matchKey、matchEvidence 和 matchReason，规格不明则 identityUncertain:true。所有 evidence 是输入中的 cue 索引。输出 JSON {products:[{key,name,variant:"",aliases:[{name,evidence:[0]}],evidence:[0],identityUncertain:false,matchKey?,matchEvidence?:[0],matchReason?:""}],ranges:[{key:"商品key或null",firstCue:0,lastCue:1,kind:"lecture|mixed|mention|uncertain|transition",reason:"依据",evidence:[0]}],issues:["问题"]}。lecture 才可关联商品，其他内容 key 必须 null。每个范围至少有一句证据。名称不明确或身份存疑可保留待确认商品，但必须说明。不得声称看到了画面或确认了画面内容。`;
export const DISCOVERY_PROMPT = DISCOVER_PRODUCTS_PROMPT;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (kind, value) => `${kind}-${hash(value).slice(0, 24)}`;
const text = value => typeof value === 'string' && value.trim().length > 0;
const norm = value => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
const invalid = message => { throw Object.assign(new Error(message), { code: 'DISCOVERY_INVALID_RESULT' }); };

export function validateDiscoveryCues(cues, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Array.isArray(cues) || !cues.length) invalid('缺少可核验的原片时长或转写');
  return cues.map((cue, index) => {
    if (!text(cue?.text) || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.endMs > durationMs || (index && cue.startMs < cues[index - 1].startMs)) invalid('转写时间无效或超出原片，未发送模型');
    return { index, startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
  });
}

// UTF-8 bytes are a deterministic payload budget, not a claim about tokenizer counts.
export function discoveryWindows(cues, { maxBytes = 24000, contextCues = 3 } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 256 || !Number.isInteger(contextCues) || contextCues < 0 || contextCues > 20) throw new Error('无效分窗设置');
  const size = cue => Buffer.byteLength(JSON.stringify(cue), 'utf8') + 1;
  if (cues.some(cue => size(cue) > maxBytes)) invalid('单条字幕超过文字窗口预算，需要先人工检查字幕边界');
  const windows = [];
  for (let first = 0; first < cues.length;) {
    let end = first, used = 2;
    while (end < cues.length && used + size(cues[end]) <= maxBytes) used += size(cues[end++]);
    if (end === first) invalid('文字窗口预算不足');
    let from = first, to = end;
    for (let n = 0; n < contextCues; n++) {
      if (from > 0 && used + size(cues[from - 1]) <= maxBytes) { from--; used += size(cues[from]); }
      if (to < cues.length && used + size(cues[to]) <= maxBytes) { used += size(cues[to]); to++; }
    }
    // Reserve modest context without using time-based fixed cuts.
    if (first > 0 && from === first && end - first > 1) {
      end--; to = end; used = 2 + cues.slice(first, end).reduce((sum, cue) => sum + size(cue), 0);
      while (from > Math.max(0, first - contextCues) && used + size(cues[from - 1]) <= maxBytes) { from--; used += size(cues[from]); }
    }
    windows.push({ index: windows.length, coreFirst: first, coreLast: end - 1, firstCue: from, lastCue: to - 1, cues: cues.slice(from, to), bytes: used });
    first = end;
  }
  return windows;
}

export function combineDiscoveryWindows({ sourceId, runId, durationMs, cues, windows, results }) {
  validateDiscoveryCues(cues, durationMs);
  if (!text(sourceId) || !text(runId) || !Array.isArray(results) || results.length !== windows.length) invalid('拆品批次不完整');
  const products = [], ranges = [], unassigned = [], issues = [];
  const known = new Map();
  const evidenceFor = (indices, window) => {
    if (!Array.isArray(indices) || !indices.length || indices.some(n => !Number.isInteger(n) || n < window.firstCue || n > window.lastCue)) invalid('拆品证据不属于当前转写窗口');
    return [...new Set(indices)].map(n => ({ cue: n, text: cues[n].text, startMs: cues[n].startMs, endMs: cues[n].endMs }));
  };
  for (let w = 0; w < windows.length; w++) {
    const window = windows[w], result = results[w];
    if (!result || !Array.isArray(result.products) || !Array.isArray(result.ranges) || !Array.isArray(result.issues) || result.issues.some(x => typeof x !== 'string')) invalid('拆品结果格式无效');
    const local = new Map();
    for (const item of result.products) {
      if (!text(item?.key) || !text(item.name) || typeof item.variant !== 'string' || local.has(item.key) || !Array.isArray(item.aliases) || (item.identityUncertain !== undefined && typeof item.identityUncertain !== 'boolean')) invalid('商品身份或别名格式无效');
      const evidence = evidenceFor(item.evidence, window);
      const aliases = item.aliases.map(alias => {
        if (!text(alias?.name)) invalid('商品别名无效');
        return { name: alias.name, evidence: evidenceFor(alias.evidence, window) };
      });
      let previous = known.get(item.matchKey ?? item.key);
      const sameName = previous && norm(previous.name) === norm(item.name) && norm(previous.variant) === norm(item.variant);
      const explicit = previous && item.matchKey && text(item.matchReason) && Array.isArray(item.matchEvidence) && item.matchEvidence.length;
      if (explicit) evidenceFor(item.matchEvidence, window);
      const merge = previous && !item.identityUncertain && !previous.identityUncertain && norm(previous.variant) === norm(item.variant) && (sameName || explicit);
      if (merge) {
        if (norm(previous.name) !== norm(item.name)) aliases.push({ name: item.name, evidence, reason: item.matchReason });
        previous.aliases.push(...aliases.filter(alias => !previous.aliases.some(old => norm(old.name) === norm(alias.name))));
        previous.evidence.push(...evidence);
        if (explicit) previous.mergeEvidence.push({ reason: item.matchReason, evidence: evidenceFor(item.matchEvidence, window) });
        known.set(item.key, previous);
      } else {
        const collision = Boolean(previous);
        previous = { id: id('product', [sourceId, item.key, collision ? w : '', item.name, item.variant]), key: collision ? `${item.key}@${w}` : item.key, name: item.name, variant: item.variant, sourceIds: [sourceId], aliases, evidence, mergeEvidence: [], identityUncertain: Boolean(item.identityUncertain || collision), review: ['仅依据转写，画面待核实', ...(item.identityUncertain || collision ? ['商品身份或规格待确认，未自动归并'] : [])], origin: 'ai-discovery', discoveryRunId: runId };
        products.push(previous);
        known.set(previous.key, previous);
      }
      local.set(item.key, previous);
    }
    for (const range of result.ranges) {
      if (!range || !Number.isInteger(range.firstCue) || !Number.isInteger(range.lastCue) || range.firstCue < window.firstCue || range.lastCue > window.lastCue || range.lastCue < range.firstCue || !['lecture', 'mixed', 'mention', 'uncertain', 'transition'].includes(range.kind) || !text(range.reason)) invalid('讲解范围或时间索引无效');
      const evidence = evidenceFor(range.evidence, window);
      if (range.lastCue < window.coreFirst || range.firstCue > window.coreLast) continue;
      const base = { sourceId, startMs: cues[range.firstCue].startMs, endMs: Math.max(...cues.slice(range.firstCue, range.lastCue + 1).map(c => c.endMs)), firstCue: range.firstCue, lastCue: range.lastCue, windowIndices: [w], evidence, reason: range.reason, review: ['仅依据转写，画面待核实'], origin: 'ai-discovery', discoveryRunId: runId };
      if (range.kind === 'lecture') {
        const product = local.get(range.key);
        if (!product) invalid('讲解引用无效商品');
        ranges.push({ ...base, productId: product.id });
      } else {
        if (range.key !== null) invalid('未确认内容不得强行归属商品');
        unassigned.push({ ...base, kind: range.kind });
      }
    }
    issues.push(...result.issues);
  }
  // Conflicting window evidence becomes reviewable, rather than choosing a product silently.
  const conflicts = new Set();
  for (let a = 0; a < ranges.length; a++) for (let b = a + 1; b < ranges.length; b++) if (ranges[a].productId !== ranges[b].productId && ranges[a].firstCue <= ranges[b].lastCue && ranges[b].firstCue <= ranges[a].lastCue) { conflicts.add(a); conflicts.add(b); }
  ranges.forEach((range, index) => { if (unassigned.some(item => item.firstCue <= range.lastCue && range.firstCue <= item.lastCue)) conflicts.add(index); });
  const accepted = ranges.filter((range, index) => {
    if (!conflicts.has(index)) return true;
    const { productId: ignored, ...base } = range;
    unassigned.push({ ...base, kind: 'mixed', reason: '跨窗口商品归属冲突，需人工核对' });
    return false;
  }).sort((a, b) => a.firstCue - b.firstCue || a.lastCue - b.lastCue);
  const merged = [];
  for (const range of accepted) {
    const prev = merged.findLast(old => old.productId === range.productId && range.firstCue <= old.lastCue && !unassigned.some(u => u.firstCue <= range.firstCue && u.lastCue >= old.lastCue));
    if (prev) { prev.lastCue = Math.max(prev.lastCue, range.lastCue); prev.endMs = Math.max(prev.endMs, range.endMs); prev.windowIndices = [...new Set([...prev.windowIndices, ...range.windowIndices])]; prev.evidence.push(...range.evidence); }
    else merged.push({ ...range });
  }
  const intervalIds = new Set();
  const intervals = merged.map(range => ({ ...range, id: id('interval', [sourceId, range.productId, range.firstCue, range.lastCue]) })).filter(range => { if (intervalIds.has(range.id)) return false; intervalIds.add(range.id); return true; });
  const seen = new Set();
  const pending = unassigned.filter(range => { const key = JSON.stringify([range.firstCue, range.lastCue, range.kind]); if (seen.has(key)) return false; seen.add(key); return true; }).map(range => ({ ...range, id: id('unassigned', [sourceId, range.firstCue, range.lastCue, range.kind]) }));
  // Uncovered cues stay explicitly unassigned; a successful job does not imply complete recognition.
  let start = null;
  for (let n = 0; n <= cues.length; n++) {
    const covered = n === cues.length || [...intervals, ...pending].some(r => r.firstCue <= n && r.lastCue >= n);
    if (!covered && start === null) start = n;
    if (covered && start !== null) {
      pending.push({ id: id('unassigned', [sourceId, start, n - 1, 'uncovered']), sourceId, startMs: cues[start].startMs, endMs: Math.max(...cues.slice(start, n).map(c => c.endMs)), firstCue: start, lastCue: n - 1, kind: 'uncertain', reason: '模型未归属的转写，待人工确认', evidence: [], review: ['画面待核实'], origin: 'ai-discovery', discoveryRunId: runId }); start = null;
    }
  }
  return { runId, sourceId, version: DISCOVERY_VERSION, products, intervals, unassigned: pending.sort((a, b) => a.startMs - b.startMs), issues: [...new Set([...issues, '仅检查转写，未检查原音及画面'])], windows: windows.length };
}

export async function discoverProducts({ sourceId, runId, durationMs, cues: input, client, maxBytes, contextCues, completed = [], onWindow = async () => {} }) {
  const cues = validateDiscoveryCues(input, durationMs);
  const windows = discoveryWindows(cues, { maxBytes, contextCues });
  if (typeof client !== 'function') throw new Error('商品识别服务未启用');
  const results = [...completed];
  if (results.length > windows.length) invalid('保存的分窗状态不匹配');
  for (let n = results.length; n < windows.length; n++) {
    const window = windows[n];
    const knownProducts = [];
    const validatedProducts = results.length ? combineDiscoveryWindows({ sourceId, runId, durationMs, cues, windows: windows.slice(0, n), results }).products : [];
    for (const { key, name, variant } of validatedProducts) {
      const entry = { key, name, variant };
      // Keep prior identity context bounded separately from the cue payload budget.
      if (Buffer.byteLength(JSON.stringify([...knownProducts, entry]), 'utf8') > 8000) break;
      knownProducts.push(entry);
    }
    const result = await client({ system: DISCOVERY_PROMPT, input: JSON.stringify({ sourceId, durationMs, coreFirst: window.coreFirst, coreLast: window.coreLast, cues: window.cues, knownProducts }) });
    // Validate each reply before persisting it as a completed paid window.
    combineDiscoveryWindows({ sourceId, runId, durationMs, cues, windows: [window], results: [result] });
    results.push(result);
    await onWindow({ index: n, windows: windows.length, results: structuredClone(results) });
  }
  return combineDiscoveryWindows({ sourceId, runId, durationMs, cues, windows, results });
}
