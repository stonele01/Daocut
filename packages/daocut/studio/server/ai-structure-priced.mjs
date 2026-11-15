/** Recheck the chronological price context, then select up to three distinct routes. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectAiRequiredInput, createAiRequiredRequest } from './ai-structure-required.mjs';
import { AI_STRUCTURE_VARIANTS_VERSION, validateAiStructureVariants, getAiVariantsCoverage } from './ai-structure-variants.mjs';

export const AI_STRUCTURE_PRICED_VERSION = 'ai-structure-plans-v8';
export const AI_STRUCTURE_PRICED_PROMPT = (await readFile(new URL('./prompts/03-compose-structure-v8.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
export const MAX_OPENING_VARIANTS = 3;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = message => { throw Object.assign(Error(message), { code: 'AI_STRUCTURE_INVALID_RESPONSE' }); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCurrent = item => item?.review?.price?.kind === 'current' && item.review.price.evidence?.length > 0;

export function inspectAiPricedInput(engineInput) {
  const base = inspectAiRequiredInput(engineInput);
  return { ...base, version: AI_STRUCTURE_PRICED_VERSION,
    inputHash: hash([AI_STRUCTURE_PRICED_VERSION, base.inputHash, engineInput.cues, engineInput.cueIndices]) };
}

export function createAiPricedRequest(input, options = {}) {
  const body = JSON.parse(createAiRequiredRequest(input, options).input);
  const candidates = new Map(input.engineInput.candidates.map(item => [item.id, item]));
  body.rules = { ...body.rules, maxVariantsPerOpening: MAX_OPENING_VARIANTS, priceContextRequired: true };
  body.units = body.units.map(unit => ({ ...unit, cueRange: candidates.get(unit.id).cueRange }));
  // Price changes and their conditions may be outside an isolated candidate.
  // Supply the whole selected lecture, with original cue IDs, before variable targets.
  const { units, rules, ...variable } = body;
  const transcript = input.engineInput.cues.map((cue, index) => [input.engineInput.cueIndices?.[index] ?? index, cue.text]);
  const request = { system: AI_STRUCTURE_PRICED_PROMPT, input: JSON.stringify({ rules, units, transcript, ...variable }) };
  if (Buffer.byteLength(request.system + request.input, 'utf8') > 128000) throw Object.assign(Error('完整话术及报价上下文超过本轮输入预算，未截断素材或发送请求'), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
  return request;
}

function checkedPrices(input, prices, inspected) {
  const priceItems = inspected.reviewItems.filter(item => !item.issues.length && item.review.roles.includes('price'));
  const byId = new Map(priceItems.map(item => [item.candidateId, item]));
  const indices = input.engineInput.cueIndices ?? input.engineInput.cues.map((_, index) => index);
  const decisions = new Map();
  if (!Array.isArray(prices)) invalid('缺少整段讲解的报价核对，未接受仅凭旧现价标签生成的方案');
  for (const decision of prices) {
    if (!record(decision) || Object.keys(decision).some(key => !['id', 'kind', 'evidence', 'replacedBy'].includes(key))
      || !byId.has(decision.id) || decisions.has(decision.id)
      || !['current', 'reference', 'future', 'superseded', 'uncertain'].includes(decision.kind)
      || !Array.isArray(decision.evidence) || !decision.evidence.length
      || decision.evidence.some(index => !Number.isSafeInteger(index) || !indices.includes(index))) invalid('报价核对必须逐项引用本次讲解的真实话术和字幕编号，不得遗漏或重复');
    if (decision.kind === 'current' && !isCurrent(byId.get(decision.id))) invalid('参考价或拟改价不能未经重新分析直接充当当前成交价');
    const range = input.engineInput.candidates.find(item => item.id === decision.id).cueRange;
    if (!decision.evidence.some(cue => cue >= range[0] && cue <= range[1])) invalid('报价核对必须包含该话术自身的原字幕依据');
    if (decision.kind === 'superseded') {
      if (!Array.isArray(decision.replacedBy) || !decision.replacedBy.length || decision.replacedBy.some(id => id === decision.id || !byId.has(id))) invalid('已改价话术必须指向库中实际的替代报价');
    } else if (decision.replacedBy?.length) invalid('仅已改价话术可以声明替代报价');
    decisions.set(decision.id, decision);
  }
  if (decisions.size !== byId.size) invalid('报价核对未覆盖全部价格话术，未接受不完整的价格判断');
  for (const decision of decisions.values()) if (decision.kind === 'superseded') {
    if (decision.replacedBy.some(id => decisions.get(id)?.kind !== 'current')) invalid('替代报价必须是已核对的当前成交价，不能循环引用旧价');
    const ranges = decision.replacedBy.map(id => input.engineInput.candidates.find(item => item.id === id).cueRange);
    if (!ranges.some(([start, end]) => decision.evidence.some(cue => cue >= start && cue <= end))) invalid('改价判断缺少替代报价原话的字幕依据');
  }
  return decisions;
}

function checkedContent(input, sequences, inspected, options = {}) {
  const targets = options.openingIds ?? inspected.openingIds;
  if (!Array.isArray(targets) || targets.some(id => !inspected.openingIds.includes(id))) invalid('请求开头不属于本次优选结果');
  const checked = validateAiStructureVariants(input, { schema: AI_STRUCTURE_VARIANTS_VERSION, plans: sequences }, { openingIds: targets, previous: options.previous ?? [] });
  const reviews = new Map(inspected.reviewItems.map(item => [item.candidateId, item]));
  const plans = [], accepted = [], issues = [...checked.issues];
  checked.sequences.forEach((sequence, index) => {
    if (!sequence.some(id => reviews.get(id)?.review.roles.includes('intro')) || !sequence.some(id => isCurrent(reviews.get(id)))) {
      issues.push({ code: 'AI_REQUIRED_CONTENT', openingId: sequence[0], message: '方案缺少产品介绍或实际成交报价；福利、参考价不能替代报价。' }); return;
    }
    plans.push(checked.plans[index]); accepted.push(sequence);
  });
  return { plans, sequences: accepted, issues, reviews };
}

export function validateAiPricedResponse(input, value, options = {}) {
  if (!record(value) || value.schema !== AI_STRUCTURE_PRICED_VERSION || !Array.isArray(value.plans)
    || Object.keys(value).some(key => !['schema', 'prices', 'plans'].includes(key))) invalid('新版拼结构只返回schema、prices报价核对和plans编号数组');
  const inspected = inspectAiPricedInput(input.engineInput);
  const prices = checkedPrices(input, value.prices, inspected);
  const checked = checkedContent(input, value.plans, inspected, options);
  const history = getAiVariantsCoverage(input, options.previous ?? [], { openingIds: options.openingIds ?? inspected.openingIds, targetVariants: MAX_OPENING_VARIANTS });
  const plans = [], sequences = [], issues = [...checked.issues], counts = new Map(history.perOpening.map(item => [item.openingId, item.distinctCount]));
  for (const [index, sequence] of checked.sequences.entries()) {
    const reject = (code, message) => issues.push({ code, openingId: sequence[0], message });
    const selected = sequence.filter(id => prices.has(id));
    if (!selected.some(id => prices.get(id).kind === 'current')) { reject('AI_PRICE_NOT_CURRENT', '方案没有经整段上下文核对的当前成交报价，已改价、参考价及拟改价不能代替。'); continue; }
    if (selected.some(id => ['future', 'uncertain'].includes(prices.get(id).kind))) { reject('AI_PRICE_UNRESOLVED', '方案包含尚未确定或尚未生效的报价。'); continue; }
    if (selected.some(id => prices.get(id).kind === 'superseded' && !prices.get(id).replacedBy.some(next => sequence.indexOf(next) > sequence.indexOf(id)))) {
      reject('AI_PRICE_SUPERSEDED', '选用了降价前的报价，却没有在后面完整交代同条件的最终成交价。'); continue;
    }
    const count = counts.get(sequence[0]) ?? 0;
    if (count >= MAX_OPENING_VARIANTS) { reject('AI_OPENING_VARIANT_LIMIT', '同一个开头累计最多保留3条有实质区别的方案。'); continue; }
    counts.set(sequence[0], count + 1);
    plans.push({ ...checked.plans[index], id: `ai-${hash([AI_STRUCTURE_PRICED_VERSION, checked.plans[index].id, selected.map(id => prices.get(id))])}`,
      version: AI_STRUCTURE_PRICED_VERSION, inputHash: inspected.inputHash, priceReview: selected.map(id => prices.get(id)) });
    sequences.push(sequence);
  }
  const targets = options.openingIds ?? inspected.openingIds;
  return { plans, sequences, issues, prices: [...prices.values()], modelComplete: targets.every(id => sequences.some(sequence => sequence[0] === id)), allValidCombinationsEnumerated: false };
}

// Only persisted, already price-validated sequences enter progress counts. A new
// response must always pass validateAiPricedResponse above before it is saved.
export function getAiPricedCoverage(input, sequences, options = {}) {
  const inspected = inspectAiPricedInput(input.engineInput);
  const checked = checkedContent(input, sequences, inspected, options);
  return getAiVariantsCoverage(input, checked.sequences, { openingIds: options.openingIds ?? inspected.openingIds, targetVariants: MAX_OPENING_VARIANTS });
}
