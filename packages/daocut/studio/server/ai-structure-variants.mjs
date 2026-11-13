/** Additional whole-speech variants. Pure validation/planning; no model or project writes. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AI_STRUCTURE_ORDER_VERSION, inspectAiOrderInput, createAiOrderRequest, validateAiStructureOrder, getAiOrderCoverage } from './ai-structure-order.mjs';

export const AI_STRUCTURE_VARIANTS_VERSION = 'ai-structure-plans-v5';
export const AI_STRUCTURE_VARIANTS_PROMPT = (await readFile(new URL('./prompts/03-compose-structure-v5.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = values => [...new Set(values)];
const invalid = message => { throw Object.assign(Error(message), { code: 'AI_STRUCTURE_INVALID_RESPONSE' }); };

function targetCount(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid('每个开头的有区别版本目标必须显式设置为正整数。');
  return value;
}

function countsFor(inspected, targets, targetVariants, targetCounts) {
  if (targetVariants !== undefined) targetCount(targetVariants);
  if (targetCounts !== undefined && (!record(targetCounts) || Object.keys(targetCounts).some(id => !inspected.openingIds.includes(id)))) invalid('逐个开头的最低覆盖目标格式无效。');
  if (targetCounts !== undefined) for (const count of Object.values(targetCounts)) targetCount(count);
  if (targetVariants === undefined && targetCounts === undefined) invalid('必须显式设置本轮逐个开头的最低覆盖目标。');
  return Object.fromEntries(targets.map(id => [id, targetCount(targetCounts?.[id] ?? targetVariants)]));
}

function targetsFor(inspected, openingIds) {
  if (openingIds === undefined) return [...inspected.openingIds];
  if (!Array.isArray(openingIds) || openingIds.some(id => !inspected.openingIds.includes(id))) invalid('请求的开头不属于本次已确认完整话术。');
  return unique(openingIds);
}

function checkedHistory(input, previous) {
  return validateAiStructureOrder(input, { schema: AI_STRUCTURE_ORDER_VERSION, plans: previous });
}

/** An observable material/role-order distinction, not a claim of semantic novelty. */
function routeFor(sequence, reviews) {
  const core = [], support = [], roleOrder = [];
  for (const [index, id] of sequence.entries()) {
    const roles = reviews.get(id).review.roles;
    if (roles.includes('purchase')) continue;
    if (roles.includes('core')) core.push(id);
    else if (index > 0) support.push(id);
    const role = unique(roles.filter(role => !['hook', 'purchase'].includes(role))).sort().join('+');
    if (role && role !== roleOrder.at(-1)) roleOrder.push(role);
  }
  return JSON.stringify([sequence[0], core.sort(), support.sort(), roleOrder]);
}

export function inspectAiVariantsInput(engineInput) {
  const inspected = inspectAiOrderInput(engineInput);
  return { ...inspected, version: AI_STRUCTURE_VARIANTS_VERSION, inputHash: hash([AI_STRUCTURE_VARIANTS_VERSION, inspected.inputHash]) };
}

/** Stable source/catalog prefix precedes every changing round field. */
export function createAiVariantsRequest(input, { openingIds, targetVariants, targetCounts, previous = [], feedback = [] } = {}) {
  const inspected = inspectAiVariantsInput(input.engineInput), targets = targetsFor(inspected, openingIds);
  const counts = targetVariants === undefined && targetCounts === undefined ? undefined : countsFor(inspected, targets, targetVariants, targetCounts);
  if (!Array.isArray(feedback)) invalid('补充反馈格式无效。');
  const history = checkedHistory(input, previous).sequences.filter(sequence => targets.includes(sequence[0]));
  // Reuse the v4 catalog projection, including applicable visual evidence and specific notes.
  const catalog = JSON.parse(createAiOrderRequest(input).input);
  const body = {
    rules: { ...catalog.rules, variantIdentity: 'opening-core-support-role-order-v1' },
    units: catalog.units,
    ...(catalog.visualReview ? { visualReview: catalog.visualReview } : {}),
    openingIds: targets,
    ...(targetVariants === undefined ? {} : { targetVariants }),
    ...(targetCounts === undefined ? {} : { targetCounts: counts }),
    previous: history,
    feedback: feedback.filter(item => !record(item) || !item.openingId || targets.includes(item.openingId)),
  };
  const request = { system: AI_STRUCTURE_VARIANTS_PROMPT, input: JSON.stringify(body) };
  if (Buffer.byteLength(request.system + request.input, 'utf8') > 128000) throw Object.assign(Error('本轮完整话术与相关版本记录超过输入预算，请缩小本轮开头范围；未截断话术或发送请求'), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
  return request;
}

function checkFormat(value) {
  if (!record(value) || value.schema !== AI_STRUCTURE_VARIANTS_VERSION || !Array.isArray(value.plans)
    || Object.keys(value).some(key => !['schema', 'plans'].includes(key))) {
    invalid('AI 变体仅可返回 v5 schema 和完整话术编号数组 plans，不得返回完成声明、时间、标签或新台词。');
  }
  // Keep the exact existing ID-array contract, including empty-row/type rejection.
  if (value.plans.some(sequence => !Array.isArray(sequence) || !sequence.length || sequence.some(id => typeof id !== 'string' || !id.length))) {
    invalid('每条变体必须是非空的完整话术编号字符串数组，不得返回片段对象、时间、标签或新台词。');
  }
}

export function validateAiStructureVariants(input, value, { openingIds, previous = [], targetVariants, targetCounts } = {}) {
  checkFormat(value);
  const inspected = inspectAiVariantsInput(input.engineInput), targets = targetsFor(inspected, openingIds);
  const hasTargets = targetVariants !== undefined || targetCounts !== undefined;
  if (hasTargets) countsFor(inspected, targets, targetVariants, targetCounts);
  const reviews = new Map(inspected.reviewItems.map(item => [item.candidateId, item]));
  const previousChecked = checkedHistory(input, previous), history = previousChecked.sequences;
  const seenRoutes = new Set(history.map(sequence => routeFor(sequence, reviews)));
  const seenPlayback = new Set(previousChecked.plans.map(plan => plan.id));
  const plans = [], sequences = [], issues = [];
  value.plans.forEach((sequence, row) => {
    const reject = (code, message) => issues.push({ code, message: `AI 方案 ${row + 1}：${message}`, row, openingId: sequence[0] });
    if (!targets.includes(sequence[0])) {
      reject('AI_VARIANT_OPENING_TARGET', '首条话术不属于本轮指定开头；不能用其他开头代替本轮目标。'); return;
    }
    const checked = validateAiStructureOrder(input, { schema: AI_STRUCTURE_ORDER_VERSION, plans: [sequence] });
    if (!checked.plans.length) {
      issues.push(...checked.issues.map(issue => ({ ...issue, row, message: issue.message.replace(/^AI 方案 1/, `AI 方案 ${row + 1}`) })));
      return;
    }
    const route = routeFor(sequence, reviews);
    const plan = checked.plans[0];
    if (seenRoutes.has(route) || seenPlayback.has(plan.id)) {
      reject('AI_VARIANT_NOT_DISTINCT', '与已有方案或本批已接受方案使用相同卖点、支撑材料和角色顺序；仅同角色话术互换或更换逼单不计新增版本。'); return;
    }
    seenRoutes.add(route);
    seenPlayback.add(plan.id);
    plans.push({ ...plan, id: `ai-${hash([AI_STRUCTURE_VARIANTS_VERSION, plan.id])}`, version: AI_STRUCTURE_VARIANTS_VERSION, inputHash: inspected.inputHash });
    sequences.push([...sequence]);
  });
  const coverage = hasTargets ? getAiVariantsCoverage(input, [...history, ...sequences], { targetVariants, targetCounts, openingIds: targets }) : undefined;
  return { plans, sequences, issues, ...(coverage ? { coverage } : {}), modelComplete: Boolean(coverage?.total && !coverage.remainingIds.length), allValidCombinationsEnumerated: false };
}

/** Seed v4/v5 sequences count only after the unchanged whole-speech validator passes. */
export function getAiVariantsCoverage(input, sequences, { targetVariants, targetCounts, openingIds } = {}) {
  const inspected = inspectAiVariantsInput(input.engineInput), targets = targetsFor(inspected, openingIds);
  const counts = countsFor(inspected, targets, targetVariants, targetCounts);
  const checked = checkedHistory(input, sequences);
  const reviews = new Map(inspected.reviewItems.map(item => [item.candidateId, item]));
  const perOpening = targets.map(openingId => {
    const saved = checked.sequences.filter(sequence => sequence[0] === openingId);
    const distinctCount = new Set(saved.map(sequence => routeFor(sequence, reviews))).size;
    return { openingId, targetVariants: counts[openingId], savedCount: saved.length, distinctCount, remaining: Math.max(0, counts[openingId] - distinctCount) };
  });
  return {
    targetVariants: targetVariants ?? null, targetCounts: counts, total: perOpening.length,
    covered: perOpening.filter(item => !item.remaining).length,
    openingCovered: perOpening.filter(item => item.savedCount > 0).length,
    openingIds: targets, remainingIds: perOpening.filter(item => item.remaining > 0).map(item => item.openingId), perOpening,
    totalVariants: perOpening.reduce((sum, item) => sum + item.savedCount, 0),
    totalDistinctVariants: perOpening.reduce((sum, item) => sum + item.distinctCount, 0),
    remainingVariants: perOpening.reduce((sum, item) => sum + item.remaining, 0),
    excluded: getAiOrderCoverage(input, []).excluded,
    allValidCombinationsEnumerated: false,
  };
}

/** Caller supplies a measured/approved workload budget; this helper invents no batch size. */
export function planAiVariantBatches(coverage, { maxTargetVariantsPerRequest } = {}) {
  if (!Number.isSafeInteger(maxTargetVariantsPerRequest) || maxTargetVariantsPerRequest < 1) {
    return { ready: false, batches: [], reason: '需要按实测或确认的单次目标输出预算分组，尚未设置预算。' };
  }
  const pending = coverage.perOpening.filter(item => item.remaining > 0);
  const overBudgetOpeningIds = pending.filter(item => item.remaining > maxTargetVariantsPerRequest).map(item => item.openingId);
  if (overBudgetOpeningIds.length) return { ready: false, batches: [], overBudgetOpeningIds, reason: '单个开头的待补版本数超过本轮目标输出预算，需要先明确分轮目标。' };
  const batches = [];
  for (const item of pending) {
    if (!batches.length || batches.at(-1).targetOutputCount + item.remaining > maxTargetVariantsPerRequest) batches.push({ openingIds: [], targetOutputCount: 0 });
    batches.at(-1).openingIds.push(item.openingId);
    batches.at(-1).targetOutputCount += item.remaining;
  }
  return { ready: true, maxTargetVariantsPerRequest, batches };
}
