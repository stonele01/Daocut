/** Current composition rules; v6 remains frozen for saved plans and requests. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AI_STRUCTURE_CURATED_VERSION, inspectAiCuratedInput, createAiCuratedRequest, validateAiCuratedResponse, getAiCuratedCoverage } from './ai-structure-curated.mjs';

export const AI_STRUCTURE_REQUIRED_VERSION = 'ai-structure-plans-v7';
export const AI_STRUCTURE_REQUIRED_PROMPT = (await readFile(new URL('./prompts/03-compose-structure-v7.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const currentPrice = review => review?.roles?.includes('price') && review.price?.kind === 'current' && review.price.evidence?.length > 0;

export function inspectAiRequiredInput(engineInput) {
  const base = inspectAiCuratedInput(engineInput);
  const eligible = base.reviewItems.filter(item => !item.issues.length);
  const issues = [...base.issues];
  if (!eligible.some(item => item.review.roles.includes('intro'))) issues.push({ code: 'AI_REQUIRED_INTRO', message: '缺少说明正在卖什么产品的完整产品介绍，请按新规则分析；已有方案保留。' });
  if (!eligible.some(item => currentPrice(item.review))) issues.push({ code: 'AI_REQUIRED_PRICE', message: '缺少已区分现价与参考价的实际报价，请按新规则分析；福利、参考价不能替代报价格，已有方案保留。' });
  return { ...base, version: AI_STRUCTURE_REQUIRED_VERSION, issues,
    ready: base.ready && !issues.some(issue => issue.code.startsWith('AI_REQUIRED_')),
    inputHash: hash([AI_STRUCTURE_REQUIRED_VERSION, base.inputHash, base.reviewItems.map(item => [item.candidateId, item.review?.price])]) };
}

export function createAiRequiredRequest(input, options = {}) {
  const request = createAiCuratedRequest(input, options);
  const body = JSON.parse(request.input);
  const reviews = new Map(inspectAiRequiredInput(input.engineInput).reviewItems.map(item => [item.candidateId, item.review]));
  body.rules = { ...body.rules, requiredRoles: ['intro', 'core', 'price', 'purchase'], currentPriceRequired: true };
  body.units = body.units.map(unit => ({ ...unit, ...(reviews.get(unit.id)?.price ? { price: reviews.get(unit.id).price } : {}) }));
  const next = { system: AI_STRUCTURE_REQUIRED_PROMPT, input: JSON.stringify(body) };
  if (Buffer.byteLength(next.system + next.input, 'utf8') > 128000) throw Object.assign(Error('完整话术库超过本轮输入预算，未截断素材或发送请求'), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
  return next;
}

export function validateAiRequiredResponse(input, value, options = {}) {
  if (value?.schema !== AI_STRUCTURE_REQUIRED_VERSION) throw Object.assign(Error('四项必带规则的返回版本不匹配'), { code: 'AI_STRUCTURE_INVALID_RESPONSE' });
  const checked = validateAiCuratedResponse(input, { ...value, schema: AI_STRUCTURE_CURATED_VERSION }, options);
  const inspected = inspectAiRequiredInput(input.engineInput);
  const reviews = new Map(inspected.reviewItems.map(item => [item.candidateId, item.review]));
  const plans = [], sequences = [], issues = [...checked.issues];
  checked.plans.forEach((plan, index) => {
    const selected = checked.sequences[index].map(id => reviews.get(id));
    const missing = [];
    if (!selected.some(review => review?.roles.includes('intro'))) missing.push('产品介绍');
    if (!selected.some(currentPrice)) missing.push('实际成交价格');
    if (missing.length) { issues.push({ code: 'AI_REQUIRED_CONTENT', openingId: checked.sequences[index][0], message: `方案缺少${missing.join('、')}；参考价和福利不能代替实际报价。` }); return; }
    plans.push({ ...plan, id: `ai-${hash([AI_STRUCTURE_REQUIRED_VERSION, plan.id])}`, version: AI_STRUCTURE_REQUIRED_VERSION, inputHash: inspected.inputHash });
    sequences.push(checked.sequences[index]);
  });
  const targets = options.openingIds ?? inspected.openingIds;
  return { plans, sequences, issues, modelComplete: targets.length > 0 && targets.every(id => sequences.some(sequence => sequence[0] === id)), allValidCombinationsEnumerated: false };
}

export function getAiRequiredCoverage(input, sequences, options = {}) {
  const checked = validateAiRequiredResponse(input, { schema: AI_STRUCTURE_REQUIRED_VERSION, plans: sequences }, options);
  return getAiCuratedCoverage(input, checked.sequences, options);
}
