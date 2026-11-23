import { createHash } from 'node:crypto';
import { DISCOVER_PRODUCTS_PROMPT, PREVIOUS_DISCOVER_PRODUCTS_PROMPT, PREVIOUS_CHAT_DISCOVER_PRODUCTS_PROMPT, PREVIOUS_BOUNDARY_DISCOVER_PRODUCTS_PROMPT } from './approved-prompts.mjs';

export const DISCOVERY_VERSION = 'product-discovery-v1';
export const PREVIOUS_DISCOVERY_PROMPT = `你只检查直播转写，没有检查原音或画面。识别完整商品讲解，不将简短提及、闲聊、过渡、混讲当作完整讲解。相同商品返场保留独立范围，不包住中间其他商品。不同规格或套装、证据不足的别名不能强行合并。时间由程序按原片 cue 恢复，只输出输入中的全局 cue 索引。跨窗口可以引用上下文，不能臆造窗口外索引。已知商品只供核对：复用 key 必须同名同规格；不同叫法合并必须给 matchKey、matchEvidence 和 matchReason，规格不明则 identityUncertain:true。所有 evidence 是输入中的 cue 索引。输出 JSON {products:[{key,name,variant:"",aliases:[{name,evidence:[0]}],evidence:[0],identityUncertain:false,matchKey?,matchEvidence?:[0],matchReason?:""}],ranges:[{key:"商品key或null",firstCue:0,lastCue:1,kind:"lecture|mixed|mention|uncertain|transition",reason:"依据",evidence:[0]}],issues:["问题"]}。lecture 才可关联商品，其他内容 key 必须 null。每个范围至少有一句证据。名称不明确或身份存疑可保留待确认商品，但必须说明。不得声称看到了画面或确认了画面内容。`;
export const PREVIOUS_CONTEXT_DISCOVERY_PROMPT = PREVIOUS_DISCOVER_PRODUCTS_PROMPT;
export const PREVIOUS_CHAT_DISCOVERY_PROMPT = PREVIOUS_CHAT_DISCOVER_PRODUCTS_PROMPT;
export const PREVIOUS_BOUNDARY_DISCOVERY_PROMPT = PREVIOUS_BOUNDARY_DISCOVER_PRODUCTS_PROMPT;
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
  // A short acknowledgement omitted at a transport boundary is not a product
  // change. Never bridge substantive text, a long silence or an assigned range.
  const continuous = (last, first) => {
    if (first <= last) return true;
    const gap = cues.slice(last + 1, first);
    return first - last <= 4 && cues[first].startMs - cues[last].endMs <= 2000
      && gap.every(cue => /^(?:嗯+|啊+|哦+|呃+|对|对的|是|是的|好的|好|没错)[。！!，,？?\s]*$/u.test(cue.text.trim()));
  };
  const switchProduct = { test(value) {
    const pattern = /过品|过款|换品|(?:切换|换)(?:到)?(?:下(?:一个|一款|一件)|另(?:一个|一款|一件)|一(?:个|款|件)|款|商品|产品)|下(?:一个|一款|一件)|接下来(?:看|讲|介绍)|开始介绍另一/gu;
    for (const match of value.matchAll(pattern)) {
      const before = value.slice(0, match.index).split(/[。！!？?；;]/u).at(-1);
      const after = value.slice(match.index + match[0].length);
      // Preview, negation and a different colour/size are not an actual switch.
      const qualifier = [...before.matchAll(/等会儿?|一会儿?|待会儿?|稍后|等下|后面|先不|不要|别|还没|不(?:要)?急着|想不想|要不要/gu)].at(-1);
      if (qualifier && !/(?:现在|马上|这就)(?:开始|我们|咱们|来)?[，,、\s]*$/u.test(before.slice(qualifier.index + qualifier[0].length))) continue;
      if (/^\s*(?:颜色|色号|尺码|码数|规格|问题|话题|福利)/u.test(after)) continue;
      return true;
    }
    return false;
  } };
  // A transition may mean a product switch, not just chat. Only bridge an
  // explicitly described conversational interruption; other transitions stay separate.
  const chatTransition = range => range.kind === 'transition'
    && /闲聊|聊天|感谢|互动|寒暄/u.test(range.reason)
    && !/换品|换款|切换|转入|返场|结束.*讲解|讲解.*结束/u.test(range.reason);
  const chatGap = (last, first) => {
    const gap = cues.slice(last + 1, first);
    const acknowledgement = /^(?:嗯+|啊+|哦+|呃+|对|对的|是|是的|好的|好|没错)[。！!，,？?\s]*$/u;
    return gap.some(cue => text(cue.text) && !acknowledgement.test(cue.text.trim())) && !gap.some(cue => switchProduct.test(cue.text));
  };
  // An uncertain garment description can still span a colour demonstration at the exact cut.
  const continuesColourDemo = (old, next) => old.scopeStatus === 'uncertain' && next.scopeStatus === 'confirmed'
    && old.lastCue + 1 === next.firstCue
    && cues[next.firstCue].startMs - cues[old.lastCue].endMs <= 2000
    && cues.slice(Math.max(old.firstCue, old.lastCue - 2), old.lastCue + 1).some(cue => /(?:颜色|色号).*(?:看|展示)|(?:看|展示).*颜色/u.test(cue.text))
    && /颜色|色号/u.test(cues[next.firstCue].text)
    && !cues.slice(Math.max(old.firstCue, old.lastCue - 2), next.firstCue + 1).some(cue => switchProduct.test(cue.text));
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
      if (item.nameUncertain !== undefined && typeof item.nameUncertain !== 'boolean') invalid('名称状态无效');
      const evidence = evidenceFor(item.evidence, window);
      const aliases = item.aliases.map(alias => {
        if (!text(alias?.name)) invalid('商品别名无效');
        return { name: alias.name, evidence: evidenceFor(alias.evidence, window) };
      });
      const baseKey = item.key.replace(/@\d+$/u, '');
      let previous = known.get(item.matchKey ?? item.key) ?? (baseKey !== item.key ? known.get(baseKey) : undefined);
      // Window boundaries are transport details, not evidence of a new sale.
      // A continuous confirmed lecture keeps its identity even if the model
      // changes a key/name/specification in the next batch. Keep observations.
      const boundary = w > 0 && ranges.findLast(old => old.windowIndices.at(-1) === w - 1
        && continuous(old.lastCue, windows[w - 1].coreLast + 1)
        && result.ranges.some(next => next.key === item.key && next.kind === 'lecture' && next.scopeStatus === 'confirmed'
          && (old.scopeStatus === 'confirmed' || (previous?.id === old.productId && previous.key === item.key && norm(previous.name) === norm(item.name)
            && text(item.variant) && norm(previous.variant) === norm(item.variant) && old.lastCue === windows[w - 1].coreLast
            && next.firstCue === window.coreFirst && continuesColourDemo(old, next)))
          && next.firstCue <= window.coreFirst && next.lastCue >= window.coreFirst && continuous(old.lastCue, next.firstCue)
          && !cues.slice(Math.min(old.lastCue, next.firstCue), Math.max(old.lastCue, next.firstCue) + 1).some(cue => switchProduct.test(cue.text))
          && ![...unassigned, ...result.ranges.filter(other => other !== next)].some(other => other.kind !== 'lecture' && !chatTransition(other) && other.firstCue <= Math.max(old.lastCue, next.firstCue) && other.lastCue >= Math.min(old.lastCue, next.firstCue))
          && !result.ranges.some(other => other !== next && other.kind === 'lecture' && other.key !== next.key && other.firstCue <= window.coreFirst && other.lastCue >= window.coreFirst)));
      const boundaryPrevious = boundary && products.find(product => product.id === boundary.productId);
      if (boundaryPrevious) previous = boundaryPrevious;
      const productNames = product => [product.name, ...(product.aliases ?? []).map(alias => alias.name)].map(norm);
      const sameName = previous && norm(previous.name) === norm(item.name) && norm(previous.variant) === norm(item.variant);
      const explicit = previous && item.matchKey && text(item.matchReason) && Array.isArray(item.matchEvidence) && item.matchEvidence.length;
      if (explicit) evidenceFor(item.matchEvidence, window);
      // The model can keep the same sale across a transport window even when its
      // formal product name is unknown. This is not evidence for merging a later return.
      const adjacentLecture = previous && item.key === previous.key
        && ranges.some(old => old.productId === previous.id && old.scopeStatus === 'confirmed' && old.windowIndices.at(-1) === w - 1
          && continuous(old.lastCue, windows[w - 1].coreLast + 1)
          && result.ranges.some(next => next.key === item.key && next.kind === 'lecture' && next.scopeStatus === 'confirmed'
            && continuous(old.lastCue, next.firstCue) && next.lastCue >= window.coreFirst
            && !switchProduct.test(`${cues[old.lastCue].text} ${cues[next.firstCue].text}`)
            && ![...unassigned, ...result.ranges.filter(other => other !== next)].some(other => other.firstCue > old.lastCue && other.firstCue < next.firstCue)));
      // Compare the same measurement, not an unlabelled bag of numbers: an
      // outfit's length does not contradict its fill weight. Approximate spoken
      // quantities retain their stated precision (150多克 includes 153克).
      const measurements = value => {
        const found = new Map();
        for (const [key, pattern] of [
          ['fill', /充绒(?:量)?\s*(\d+(?:\.\d+)?)(多)?\s*(?:克|g)/giu],
          ['loft', /蓬松度\s*(\d+(?:\.\d+)?)(多)?/gu],
          ['length', /衣长\s*(\d+(?:\.\d+)?)(多)?\s*(?:公分|厘米|cm)/giu],
          ['down', /绒子含量\s*(\d+(?:\.\d+)?)(多)?\s*%/gu],
          ['down', /(\d+(?:\.\d+)?)(多)?\s*%\s*绒子/gu],
        ]) for (const match of value.matchAll(pattern)) {
          const amount = Number(match[1]);
          found.set(key, [amount, amount + (match[2] ? (amount % 100 === 0 ? 99 : 9) : 0)]);
        }
        return found;
      };
      const oldMeasures = measurements(previous?.variant ?? ''), newMeasures = measurements(item.variant);
      const compatibleVariant = previous && !/另一(?:款|个|套)|不同规格|另一个规格/u.test(`${previous.variant} ${item.variant}`)
        && ![...oldMeasures].some(([key, [min, max]]) => newMeasures.has(key)
          && (newMeasures.get(key)[0] > max || newMeasures.get(key)[1] < min));
      const continuation = adjacentLecture && (norm(previous.variant) === norm(item.variant) || norm(previous.name) === norm(item.name) && compatibleVariant);
      const chatContinuation = previous && compatibleVariant && item.key === previous.key && (norm(previous.name) === norm(item.name) || aliases.some(alias => norm(alias.name) === norm(previous.name)))
        && ranges.some(old => old.productId === previous.id && old.scopeStatus === 'confirmed' && old.windowIndices.at(-1) === w - 1
          && result.ranges.some(next => next.key === item.key && next.kind === 'lecture' && next.scopeStatus === 'confirmed' && next.lastCue >= window.coreFirst && chatGap(old.lastCue, next.firstCue)
            && !ranges.some(other => other.productId !== old.productId && other.firstCue < next.firstCue && other.lastCue > old.lastCue)
            && !result.ranges.some(other => other !== next && other.kind === 'lecture' && other.key !== item.key && other.firstCue < next.firstCue && other.lastCue > old.lastCue)
            && !switchProduct.test(`${cues[old.lastCue].text} ${cues[next.firstCue].text}`)
            && ![...unassigned, ...result.ranges].some(other => other.kind !== 'lecture' && !chatTransition(other) && other.firstCue < next.firstCue && other.lastCue > old.lastCue)));
      const ambiguousBoundary = adjacentLecture && !continuation && norm(previous.name) === norm(item.name) && norm(previous.variant) !== norm(item.variant);
      if (ambiguousBoundary) {
        const warning = '相邻窗口可能是同一次商品讲解，但规格描述不同；请核对后连接，已有分析将按原范围保留';
        if (!previous.review.includes(warning)) previous.review.push(warning);
        issues.push(warning);
      }
      const overlapContinuation = previous && compatibleVariant && (productNames(previous).includes(norm(item.name)) || baseKey !== item.key && baseKey === previous.key)
        && ranges.some(old => old.productId === previous.id && old.scopeStatus === 'confirmed' && old.windowIndices.at(-1) === w - 1
          && result.ranges.some(next => next.key === item.key && next.kind === 'lecture' && next.scopeStatus === 'confirmed'
            && next.firstCue <= old.lastCue && next.lastCue >= old.lastCue
            && !cues.slice(next.firstCue, old.lastCue + 1).some(cue => switchProduct.test(cue.text))
            && !ranges.some(other => other.productId !== old.productId && other.firstCue <= old.lastCue && other.lastCue >= next.firstCue)
            && !result.ranges.some(other => other !== next && other.kind === 'lecture' && other.key !== item.key && other.firstCue <= old.lastCue && other.lastCue >= next.firstCue)
            && !result.ranges.some(other => other.kind === 'mixed' && other.firstCue <= old.lastCue && other.lastCue >= next.firstCue)
            && !unassigned.some(other => other.kind === 'mixed' && other.firstCue <= old.lastCue && other.lastCue >= next.firstCue)));
      const merge = boundaryPrevious || continuation || chatContinuation || overlapContinuation || (previous && !item.nameUncertain && !previous.nameUncertain && !item.identityUncertain && !previous.identityUncertain && norm(previous.variant) === norm(item.variant) && (sameName || explicit));
      if (merge) {
        if (boundaryPrevious && (norm(previous.name) !== norm(item.name) || norm(previous.variant) !== norm(item.variant))) {
          previous.identityUncertain = true;
          const warning = '跨批次连续讲解未发现实际换品信号，保留同一讲解；名称或规格差异待核对';
          if (!previous.review.includes(warning)) previous.review.push(warning);
        }
        if ((boundaryPrevious || chatContinuation || continuation || overlapContinuation) && norm(previous.variant) !== norm(item.variant)) {
          previous.variantObservations ??= [];
          previous.variantObservations.push({ variant: item.variant, evidence });
          const warning = '同一讲解中的规格描述有差异，原话已保留，请核对具体规格';
          if (!previous.review.includes(warning)) previous.review.push(warning);
        }
        if (norm(previous.name) !== norm(item.name)) aliases.push({ name: item.name, evidence, reason: item.matchReason });
        previous.aliases.push(...aliases.filter(alias => !previous.aliases.some(old => norm(old.name) === norm(alias.name))));
        previous.evidence.push(...evidence);
        if (explicit) previous.mergeEvidence.push({ reason: item.matchReason, evidence: evidenceFor(item.matchEvidence, window) });
        known.set(item.key, previous);
      } else {
        const collision = Boolean(previous);
        previous = { id: id('product', [sourceId, item.key, collision ? w : '', item.name, item.variant]), key: collision ? `${item.key}@${w}` : item.key, name: item.name, variant: item.variant, sourceIds: [sourceId], aliases, evidence, mergeEvidence: [], identityUncertain: Boolean(item.identityUncertain || collision), ...(item.nameUncertain !== undefined ? { nameUncertain: item.nameUncertain } : {}), review: ['仅依据转写，画面待核实', ...(item.identityUncertain || collision ? ['商品身份或规格待确认，未自动归并'] : []), ...(ambiguousBoundary ? ['相邻窗口可能是同一次商品讲解，但规格描述不同；请核对后连接，已有分析将按原范围保留'] : [])], origin: 'ai-discovery', discoveryRunId: runId };
        products.push(previous);
        known.set(previous.key, previous);
      }
      local.set(item.key, previous);
    }
    for (const range of result.ranges) {
      if (!range || !Number.isInteger(range.firstCue) || !Number.isInteger(range.lastCue) || range.firstCue < window.firstCue || range.lastCue > window.lastCue || range.lastCue < range.firstCue || !['lecture', 'mixed', 'mention', 'uncertain', 'transition'].includes(range.kind) || !text(range.reason)) invalid('讲解范围或时间索引无效');
      const evidence = evidenceFor(range.evidence, window);
      if (range.lastCue < window.coreFirst || range.firstCue > window.coreLast) continue;
      if (range.scopeStatus !== undefined && !['confirmed', 'uncertain'].includes(range.scopeStatus)) invalid('商品讲解归属状态无效');
      const base = { ...(range.scopeStatus ? { scopeStatus: range.scopeStatus } : {}), sourceId, startMs: cues[range.firstCue].startMs, endMs: Math.max(...cues.slice(range.firstCue, range.lastCue + 1).map(c => c.endMs)), firstCue: range.firstCue, lastCue: range.lastCue, windowIndices: [w], evidence, reason: range.reason, review: ['仅依据转写，画面待核实'], origin: 'ai-discovery', discoveryRunId: runId };
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
  // A disputed context cue must not discard minutes of otherwise confirmed speech.
  // Keep only the disputed overlap unassigned; old, unconfirmed ranges still need review in full.
  const conflicts = new Map();
  const conflict = (index, other) => {
    const range = ranges[index];
    if (range.firstCue > other.lastCue || other.firstCue > range.lastCue) return;
    const spans = conflicts.get(index) ?? [];
    spans.push([Math.max(range.firstCue, other.firstCue), Math.min(range.lastCue, other.lastCue)]);
    conflicts.set(index, spans);
  };
  for (let a = 0; a < ranges.length; a++) for (let b = a + 1; b < ranges.length; b++) if (ranges[a].productId !== ranges[b].productId) { conflict(a, ranges[b]); conflict(b, ranges[a]); }
  ranges.forEach((range, index) => unassigned.forEach(item => conflict(index, item)));
  const fragment = (range, firstCue, lastCue) => ({ ...range, firstCue, lastCue, startMs: cues[firstCue].startMs,
    endMs: Math.max(...cues.slice(firstCue, lastCue + 1).map(cue => cue.endMs)),
    evidence: range.evidence.filter(item => item.cue >= firstCue && item.cue <= lastCue) });
  const accepted = ranges.flatMap((range, index) => {
    if (!conflicts.has(index)) return [range];
    const spans = range.scopeStatus === 'confirmed' ? conflicts.get(index).sort((a, b) => a[0] - b[0]) : [[range.firstCue, range.lastCue]];
    const cuts = [];
    for (const span of spans) {
      const previous = cuts.at(-1);
      if (previous && span[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], span[1]);
      else cuts.push([...span]);
    }
    const kept = [];
    const keep = (first, last) => {
      const part = fragment(range, first, last);
      part.review = [...part.review, '相邻边界有归属冲突，本段保留原模型已确认的非冲突内容'];
      if (!part.evidence.length) {
        part.scopeStatus = 'uncertain';
        part.evidence = [{ cue: first, text: cues[first].text, startMs: cues[first].startMs, endMs: cues[first].endMs }];
      }
      kept.push(part);
    };
    let first = range.firstCue;
    for (const [start, end] of cuts) {
      if (start > first) keep(first, start - 1);
      const { productId: ignored, ...base } = fragment(range, start, end);
      unassigned.push({ ...base, kind: 'mixed', scopeStatus: 'uncertain', reason: '跨窗口商品归属冲突，需人工核对' });
      first = end + 1;
    }
    if (first <= range.lastCue) keep(first, range.lastCue);
    return kept;
  }).sort((a, b) => a.firstCue - b.firstCue || a.lastCue - b.lastCue);
  // A model may switch product keys or use a shorter name at a window edge.
  // Flag likely continuity for review; names alone cannot prove matching SKUs.
  const sharedName = (left, right) => {
    const a = norm(left).replace(/\s+/g, ''), b = norm(right).replace(/\s+/g, '');
    for (let n = 0; n <= a.length - 3; n++) if (b.includes(a.slice(n, n + 3))) return true;
    return false;
  };
  for (let index = 1; index < accepted.length; index++) {
    const old = accepted[index - 1], next = accepted[index];
    if (old.productId === next.productId || old.scopeStatus !== 'confirmed' || next.scopeStatus !== 'confirmed' || old.windowIndices.at(-1) + 1 !== next.windowIndices[0] || !continuous(old.lastCue, next.firstCue)) continue;
    const first = products.find(product => product.id === old.productId), second = products.find(product => product.id === next.productId);
    if (!first || !second || !sharedName(first.name, second.name)) continue;
    const warning = '相邻窗口可能是同一次商品讲解，但名称或规格不同；请核对后连接，已有分析将按原范围保留';
    for (const product of [first, second]) if (!product.review.includes(warning)) product.review.push(warning);
    issues.push(warning);
  }
  const merged = [];
  for (const range of accepted) {
    const prev = merged.findLast(old => {
      if (old.productId !== range.productId) return false;
      if (cues.slice(Math.min(old.lastCue, range.firstCue), Math.max(old.lastCue, range.firstCue) + 1).some(cue => switchProduct.test(cue.text))) return false;
      const adjacent = old.windowIndices.at(-1) + 1 === range.windowIndices[0] && (old.scopeStatus === 'confirmed' && range.scopeStatus === 'confirmed' || continuesColourDemo(old, range))
        && !switchProduct.test(`${cues[old.lastCue].text} ${cues[range.firstCue].text}`);
      const sameWindow = old.windowIndices.at(-1) === range.windowIndices[0]
        && old.scopeStatus !== 'uncertain' && range.scopeStatus !== 'uncertain'
        && continuous(old.lastCue, range.firstCue)
        && !switchProduct.test(`${cues[old.lastCue].text} ${cues[range.firstCue].text}`)
        && !accepted.some(other => other.productId !== old.productId && other.firstCue < range.firstCue && other.lastCue > old.lastCue);
      const throughChat = (adjacent || old.windowIndices.at(-1) === range.windowIndices[0] && old.scopeStatus === 'confirmed' && range.scopeStatus === 'confirmed') && chatGap(old.lastCue, range.firstCue)
        && !accepted.some(other => other.productId !== old.productId && other.firstCue < range.firstCue && other.lastCue > old.lastCue)
        && !unassigned.some(other => !chatTransition(other) && other.firstCue < range.firstCue && other.lastCue > old.lastCue);
      return throughChat || (range.firstCue <= old.lastCue || sameWindow || adjacent && continuous(old.lastCue, range.firstCue)) && !unassigned.some(u => u.firstCue <= range.firstCue && u.lastCue >= old.lastCue);
    });
    if (prev) { prev.lastCue = Math.max(prev.lastCue, range.lastCue); prev.endMs = Math.max(prev.endMs, range.endMs); prev.windowIndices = [...new Set([...prev.windowIndices, ...range.windowIndices])]; prev.evidence.push(...range.evidence); if (prev.scopeStatus === 'uncertain' || range.scopeStatus === 'uncertain') prev.scopeStatus = 'uncertain'; else if (prev.scopeStatus !== range.scopeStatus) delete prev.scopeStatus; }
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
    for (const { key, name, variant, nameUncertain, identityUncertain } of validatedProducts) {
      const entry = { key, name, variant, ...(nameUncertain !== undefined ? { nameUncertain } : {}), identityUncertain };
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
