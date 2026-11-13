/** Compose only openings explicitly selected during speech analysis. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectAiOrderInput, createAiOrderRequest } from './ai-structure-order.mjs';
import { AI_STRUCTURE_VARIANTS_VERSION, validateAiStructureVariants, getAiVariantsCoverage } from './ai-structure-variants.mjs';

export const AI_STRUCTURE_CURATED_VERSION = 'ai-structure-plans-v6';
export const AI_STRUCTURE_CURATED_PROMPT = (await readFile(new URL('./prompts/03-compose-structure-v6.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
export const OPENING_SELECTION_VERSION = 'curated-openings-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const invalid = message => { throw Object.assign(Error(message), { code: 'AI_STRUCTURE_INVALID_RESPONSE' }); };

export function inspectAiCuratedInput(engineInput) {
  const base = inspectAiOrderInput(engineInput);
  const selected = base.reviewItems.filter(item => base.openingIds.includes(item.candidateId)
    && item.review.openingPolicy === OPENING_SELECTION_VERSION && record(item.review.opening)
    && nonempty(item.review.opening.group) && nonempty(item.review.opening.followup));
  // Analysis compares similar expressions. Equal group keys across windows keep
  // the shorter complete expression; all other units remain available as body.
  const groups = new Map();
  for (const item of selected) {
    const group = item.review.opening.group.trim(), old = groups.get(group);
    if (!old || item.endMs - item.startMs < old.endMs - old.startMs) groups.set(group, item);
  }
  const openingIds = [...groups.values()].sort((a, b) => a.startMs - b.startMs).map(item => item.candidateId);
  const issues = [...base.issues];
  if (!openingIds.length) issues.push({ code: 'AI_CURATED_OPENING_REQUIRED', message: '当前分析尚无优选开头，请先运行AI分析；已有方案保留。' });
  return { ...base, version: AI_STRUCTURE_CURATED_VERSION, openingIds,
    ready: base.ready && openingIds.length > 0, issues,
    inputHash: hash([AI_STRUCTURE_CURATED_VERSION, base.inputHash,
      base.reviewItems.map(item => [item.candidateId, item.review?.openingPolicy, item.review?.opening])]) };
}

function targetsFor(input, openingIds) {
  const inspected = inspectAiCuratedInput(input.engineInput), targets = openingIds ?? inspected.openingIds;
  if (!Array.isArray(targets) || targets.some(id => !inspected.openingIds.includes(id))) invalid('请求的开头不属于AI分析优选结果。');
  return { inspected, targets: [...new Set(targets)] };
}

export function createAiCuratedRequest(input, { openingIds, previous = [], feedback = [] } = {}) {
  const { inspected, targets } = targetsFor(input, openingIds);
  if (!Array.isArray(previous) || !Array.isArray(feedback)) invalid('已有方案或反馈格式无效。');
  const catalog = JSON.parse(createAiOrderRequest(input, { openingIds: targets }).input);
  const reviews = new Map(inspected.reviewItems.map(item => [item.candidateId, item.review]));
  const units = catalog.units.map(unit => ({ id: unit.id, text: unit.text, roles: unit.roles, durationMs: unit.durationMs,
    ...(unit.subject ? { subject: unit.subject } : {}),
    ...(unit.requires?.length ? { requires: unit.requires } : {}),
    ...(unit.excludes?.length ? { excludes: unit.excludes } : {}),
    ...(Object.keys(unit.conditions ?? {}).length ? { conditions: unit.conditions } : {}),
    ...(unit.notes?.length ? { notes: unit.notes } : {}),
    ...(unit.visual?.length ? { visual: unit.visual } : {}),
    ...(inspected.openingIds.includes(unit.id) ? { opening: { followup: reviews.get(unit.id).opening.followup } } : {}) }));
  const history = previous.filter(sequence => Array.isArray(sequence) && targets.includes(sequence[0]));
  const relevantFeedback = feedback.filter(item => !record(item) || !item.openingId || targets.includes(item.openingId));
  // The complete catalog precedes variable targets/history for prefix caching.
  const body = { rules: catalog.rules, units, openingIds: targets,
    ...(history.length ? { previous: history } : {}), ...(relevantFeedback.length ? { feedback: relevantFeedback } : {}) };
  const request = { system: AI_STRUCTURE_CURATED_PROMPT, input: JSON.stringify(body) };
  if (Buffer.byteLength(request.system + request.input, 'utf8') > 128000) throw Object.assign(Error('完整话术库超过本轮输入预算，未截断素材或发送请求'), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
  return request;
}

export function validateAiCuratedResponse(input, value, { openingIds, previous = [] } = {}) {
  if (!record(value) || value.schema !== AI_STRUCTURE_CURATED_VERSION || !Array.isArray(value.plans)
    || Object.keys(value).some(key => !['schema', 'plans'].includes(key))) invalid('优选开头拼结构只可返回schema和话术编号数组plans。');
  const { inspected, targets } = targetsFor(input, openingIds);
  const validated = validateAiStructureVariants(input, { ...value, schema: AI_STRUCTURE_VARIANTS_VERSION }, { openingIds: targets, previous });
  const seen = new Set(), plans = [], sequences = [], issues = [...validated.issues];
  validated.sequences.forEach((sequence, index) => {
    if (seen.has(sequence[0])) { issues.push({ code: 'AI_CURATED_OPENING_LIMIT', openingId: sequence[0], message: '每个优选开头本轮只取一条方案。' }); return; }
    seen.add(sequence[0]); sequences.push(sequence);
    plans.push({ ...validated.plans[index], id: `ai-${hash([AI_STRUCTURE_CURATED_VERSION, validated.plans[index].id])}`,
      version: AI_STRUCTURE_CURATED_VERSION, inputHash: inspected.inputHash });
  });
  return { plans, sequences, issues, modelComplete: targets.length > 0 && targets.every(id => seen.has(id)), allValidCombinationsEnumerated: false };
}

export function getAiCuratedCoverage(input, sequences, { openingIds } = {}) {
  const { targets } = targetsFor(input, openingIds);
  return getAiVariantsCoverage(input, sequences, { openingIds: targets, targetVariants: 1 });
}
