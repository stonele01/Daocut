/** Whole-speech ordering and opening coverage. No model, project writes or media operations. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectAiCompositionInput } from './structure-composition.mjs';

export const AI_STRUCTURE_ORDER_VERSION = 'ai-structure-plans-v4';
export const AI_STRUCTURE_ORDER_PROMPT = (await readFile(new URL('./prompts/03-compose-structure-v4.txt', import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
const SPEED = 1.3;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const unique = values => [...new Set(values)];
const within = (inner, outer) => inner.startMs >= outer.startMs && inner.endMs <= outer.endMs;
const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;
const invalid = message => { throw Object.assign(Error(message), { code: 'AI_STRUCTURE_INVALID_RESPONSE' }); };
const tagFor = { hook: '钩子', story: '故事', pain: '痛点', core: '卖点', intro: '产品介绍', display: '产品演示', price: '价格机制', offer: '福利机制', trust: '信任背书', purchase: '行动指令' };
const genericNotes = new Set(['仅依据 ASR；画面、声音和句级边界待核实', '未检查原音及画面']);
const notesFor = item => (item.details?.review ?? []).filter(note => nonempty(note) && !genericNotes.has(note));

export function inspectAiOrderInput(engineInput) {
  const inspected = inspectAiCompositionInput(engineInput);
  const issues = inspected.issues.filter(issue => !issue.code.startsWith('MISSING_'));
  const reviewItems = structuredClone(inspected.reviewItems);
  const candidates = engineInput.candidates ?? [], cues = engineInput.cues ?? [];
  const indices = engineInput.cueIndices ?? cues.map((_, index) => index);
  const counts = new Map();
  for (const candidate of candidates) counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  for (const item of reviewItems) {
    const candidate = candidates.find(candidate => candidate.id === item.candidateId);
    const add = (code, message) => {
      const issue = { code, message, candidateId: item.candidateId, startMs: item.startMs, endMs: item.endMs };
      item.issues.push(issue); issues.push(issue);
    };
    if (counts.get(item.candidateId) !== 1) add('AI_ORDER_DUPLICATE_ID', '话术编号重复，不能确认取用的是哪一段。');
    const range = candidate?.cueRange;
    const first = Array.isArray(range) ? indices.indexOf(range[0]) : -1;
    const last = Array.isArray(range) ? indices.indexOf(range[1]) : -1;
    if (!Array.isArray(range) || range.length !== 2 || first < 0 || last < first
      || indices.slice(first, last + 1).some((value, index, slice) => index > 0 && value !== slice[index - 1] + 1)) {
      add('AI_ORDER_CUE_RANGE', '完整话术缺少连续、可回查的原字幕编号，不能猜测或重新切范围。');
    }
  }
  const eligible = reviewItems.filter(item => !item.issues.length);
  const openingIds = eligible.filter(item => item.review.roles.length && !item.review.roles.includes('purchase') && !item.review.requires.length).map(item => item.candidateId);
  if (!openingIds.length) issues.push({ code: 'AI_ORDER_OPENING_REQUIRED', message: '没有已确认且无需前置话术的非逼单开头。' });
  if (!eligible.some(item => item.review.roles.includes('core'))) issues.push({ code: 'AI_ORDER_CORE_REQUIRED', message: '没有已确认的完整卖点话术。' });
  if (!eligible.some(item => item.review.roles.includes('purchase'))) issues.push({ code: 'AI_ORDER_PURCHASE_REQUIRED', message: '没有已确认的购买逼单结尾。' });
  return { ...inspected, version: AI_STRUCTURE_ORDER_VERSION, inputHash: hash([AI_STRUCTURE_ORDER_VERSION, SPEED, inspected.inputHash, reviewItems.map(item => [item.candidateId, item.issues])]),
    ready: openingIds.length > 0 && !issues.some(issue => ['SCOPE_INVALID', 'AI_ORDER_CORE_REQUIRED', 'AI_ORDER_PURCHASE_REQUIRED'].includes(issue.code)),
    materialComplete: inspected.materialComplete && !issues.length, eligibleCount: eligible.length, openingIds, issues, reviewItems };
}

function visualFor(input) {
  if (input.visibility !== 'shared' && input.visualReviewStale) return { status: 'stale', issues: ['已有看图记录不适用于当前话术。'] };
  return input.visibility === 'shared' ? input.compositionEvidence?.visualReview : input.visualReview;
}

export function createAiOrderRequest(input, { previous = [], openingIds = [], feedback = [] } = {}) {
  const inspected = inspectAiOrderInput(input.engineInput);
  if (!Array.isArray(openingIds) || openingIds.some(id => !inspected.openingIds.includes(id))) invalid('请求的开头不属于本次已确认完整话术。');
  if (!Array.isArray(previous) || !Array.isArray(feedback)) invalid('已有方案或补充反馈格式无效。');
  const targets = unique(openingIds.length ? openingIds : inspected.openingIds);
  const visual = visualFor(input);
  const units = inspected.reviewItems.filter(item => !item.issues.length).map(item => {
    const review = item.review;
    const evidence = visual?.status === 'complete' ? visual.entries?.filter(entry => within(item, entry)) : [];
    return { id: item.candidateId, text: item.text, roles: review.roles, durationMs: item.endMs - item.startMs,
      ...(review.subject ? { subject: review.subject.kind } : {}),
      requires: review.requires, excludes: review.excludes ?? [], conditions: review.conditions,
      ...(notesFor(item).length ? { notes: notesFor(item) } : {}),
      ...(evidence?.length ? { visual: evidence.map(entry => ({ productMatch: entry.productMatch, display: entry.display, observation: entry.observation, issues: entry.issues })) } : {}) };
  });
  const body = { rules: { speed: SPEED, minDurationMs: 30000, maxDurationMs: 40000, minCoreUnits: 1, maxCoreUnits: 2, purchaseLast: true },
    openingIds: targets, units, previous, feedback,
    ...(visual ? { visualReview: { status: visual.status, issues: visual.issues ?? [] } } : {}) };
  const request = { system: AI_STRUCTURE_ORDER_PROMPT, input: JSON.stringify(body) };
  if (Buffer.byteLength(request.system + request.input, 'utf8') > 128000) throw Object.assign(Error('本轮完整话术与覆盖记录超过输入预算，请缩小本轮开头范围；未截断话术或发送请求'), { code: 'AI_STRUCTURE_INPUT_TOO_LARGE' });
  return request;
}

function checkFormat(value) {
  if (!record(value) || value.schema !== AI_STRUCTURE_ORDER_VERSION || !Array.isArray(value.plans)
    || Object.keys(value).some(key => !['schema', 'plans'].includes(key))
    || value.plans.some(sequence => !Array.isArray(sequence) || !sequence.length || sequence.some(id => !nonempty(id)))) {
    invalid('AI 排序仅可返回 schema 和 plans；每条 plans 是完整话术编号字符串的有序数组，不得返回时间、标签、新台词或完成声明。');
  }
}

function checkedSequences(input, sequences, inspected) {
  const engine = input.engineInput, scope = engine.scope;
  const byId = new Map((engine.candidates ?? []).map(candidate => [candidate.id, candidate]));
  const reviews = new Map(inspected.reviewItems.map(item => [item.candidateId, item]));
  const plans = [], accepted = [], issues = [], seen = new Set();
  const visual = visualFor(input);
  sequences.forEach((sequence, row) => {
    const reject = (code, message, part, candidateId) => issues.push({ code, message: `AI 方案 ${row + 1}${part === undefined ? '' : ` 第 ${part + 1} 段`}：${message}`, row,
      ...(part === undefined ? {} : { part }), ...(candidateId ? { candidateId } : {}), openingId: sequence[0] });
    if (new Set(sequence).size !== sequence.length) { reject('AI_ORDER_REPEAT', '同一条方案重复使用了话术编号。'); return; }
    const clips = [], chosen = [];
    for (const [part, id] of sequence.entries()) {
      const candidate = byId.get(id), item = reviews.get(id), review = item?.review;
      if (!candidate || !item || item.issues.length || !review) {
        reject('AI_ORDER_UNIT', !candidate ? `话术编号 ${id} 不属于本次素材。` : notesFor(item ?? {}).join('；') || item?.issues.map(issue => issue.message).join('；') || '这条话术尚未核对完整。', part, id); return;
      }
      if (!part && !inspected.openingIds.includes(id)) { reject('AI_ORDER_OPENING', '开头必须是已确认、非购买逼单且无需前置话术的完整单元。', part, id); return; }
      if (review.roles.includes('purchase') && part !== sequence.length - 1) { reject('AI_ORDER_STRUCTURE', '购买逼单只能放在最后。', part, id); return; }
      if (clips.some(clip => overlaps(clip, candidate))) { reject('AI_ORDER_OVERLAP', '同条方案选用了重叠原片范围。', part, id); return; }
      if (review.requires.some(required => !chosen.some(previous => previous.candidateId === required))) { reject('AI_ORDER_CONTEXT', '所需前文必须以完整话术放在本段之前。', part, id); return; }
      if (review.roles.includes('display') && !(visual?.status === 'complete' && visual.entries?.some(entry => within(candidate, entry)
        && entry.productMatch === 'match' && entry.display === 'shown' && entry.evidenceTimesMs?.some(ms => ms >= candidate.startMs && ms < candidate.endMs)))) {
        reject('AI_ORDER_DISPLAY', '缺少覆盖此完整话术的有效商品展示证据。', part, id); return;
      }
      for (const previous of chosen) {
        if ((review.excludes ?? []).includes(previous.candidateId) || (previous.review.excludes ?? []).includes(id)) { reject('AI_ORDER_EXCLUDED', '已有记录明确这两段不能合用。', part, id); return; }
        const conflict = Object.entries(review.conditions).find(([key, value]) => Object.hasOwn(previous.review.conditions, key) && previous.review.conditions[key] !== value);
        if (conflict) {
          const [key, value] = conflict, old = previous.review.conditions[key];
          reject(key === 'price' ? 'AI_ORDER_PRICE_METADATA' : 'AI_ORDER_CONDITIONS', key === 'price'
            ? `话术 ${previous.candidateId} 与 ${id} 的旧 price 元数据为 ${JSON.stringify(old)} / ${JSON.stringify(value)}，尚未区分现价、参考价或拟改价；请核对具体价格角色，不能据此断言原话报价矛盾。`
            : `话术 ${previous.candidateId} 与 ${id} 的已记录条件 ${key} 不同（${JSON.stringify(old)} / ${JSON.stringify(value)}）。`, part, id); return;
        }
      }
      const coreIds = review.roles.includes('core') ? [`speech-${hash([engine.sourceIdentity ?? scope.sourceId, candidate.startMs, candidate.endMs, candidate.text]).slice(0, 24)}`] : [];
      clips.push({ candidateId: id, parentCandidateId: id, candidateIds: [id], sourceId: scope.sourceId,
        ...(nonempty(input.source?.assetPath ?? candidate.assetPath) ? { assetPath: input.source?.assetPath ?? candidate.assetPath } : {}),
        startMs: candidate.startMs, endMs: candidate.endMs, text: candidate.text, tags: unique(review.roles.map(role => tagFor[role])),
        roles: [...review.roles], coreIds, cueRange: [...candidate.cueRange], parentCueRange: [...candidate.cueRange], conditions: { ...review.conditions },
        speed: SPEED, semanticReview: 'ai-selected-unit', continuousActionVerified: false, speechVerified: false });
      chosen.push(item);
    }
    const coreIds = unique(clips.flatMap(clip => clip.coreIds));
    if (!clips.at(-1)?.roles.includes('purchase') || coreIds.length < 1 || coreIds.length > 2
      || chosen.some(item => !item.review.roles.length && !chosen.some(other => other.review.requires.includes(item.candidateId)))) {
      reject('AI_ORDER_STRUCTURE', '需要1～2个完整卖点及最后的购买逼单；无作用的上下文只能供有明确依赖的后文使用。'); return;
    }
    const sourceDurationMs = clips.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0), durationMs = sourceDurationMs / SPEED;
    if (sourceDurationMs < 39000 || sourceDurationMs > 52000) { reject('AI_ORDER_DURATION', `完整原话按1.3倍速为${(durationMs / 1000).toFixed(2)}秒，需要30～40秒；未截话、改时间或补空白。`); return; }
    const playback = [];
    for (const clip of clips) {
      if (playback.at(-1)?.[1] === clip.startMs) playback.at(-1)[1] = clip.endMs;
      else playback.push([clip.startMs, clip.endMs]);
    }
    const id = `ai-${hash([AI_STRUCTURE_ORDER_VERSION, engine.sourceIdentity ?? scope.sourceId, scope.startMs, scope.endMs, SPEED, playback])}`;
    if (seen.has(id)) return;
    seen.add(id); clips[0].roles = unique(['hook', ...clips[0].roles]);
    const coreLabels = Object.fromEntries(clips.flatMap(clip => clip.coreIds.map(coreId => [coreId, clip.text.length > 24 ? `${clip.text.slice(0, 24)}…` : clip.text])));
    plans.push({ id, version: AI_STRUCTURE_ORDER_VERSION, generationMethod: 'ai', inputHash: inspected.inputHash, scope: { ...scope }, clips, coreIds, coreLabels,
      durationMs, sourceDurationMs, speed: SPEED, referenceDuration: 'reference', continuousActionVerified: false, speechVerified: false,
      structure: clips.map(clip => ({ candidateId: clip.candidateId, roles: [...clip.roles], coreIds: [...clip.coreIds] })) });
    accepted.push([...sequence]);
  });
  return { plans, sequences: accepted, issues };
}

function coverageFor(inspected, sequences) {
  const coveredIds = new Set(sequences.map(sequence => sequence[0]).filter(id => inspected.openingIds.includes(id)));
  return { total: inspected.openingIds.length, covered: coveredIds.size, remainingIds: inspected.openingIds.filter(id => !coveredIds.has(id)), openingIds: [...inspected.openingIds],
    excluded: inspected.reviewItems.filter(item => !inspected.openingIds.includes(item.candidateId)).map(item => ({ id: item.candidateId,
      reason: item.issues.length ? notesFor(item).join('；') || item.issues.map(issue => issue.message).join('；')
        : item.review.roles.includes('purchase') ? '完整话术包含购买逼单，只能用作结尾。'
          : item.review.requires.length ? `需要前置话术：${item.review.requires.join('、')}` : '没有可作为开头的已确认结构作用。' })) };
}

export function validateAiStructureOrder(input, value) {
  checkFormat(value);
  const inspected = inspectAiOrderInput(input.engineInput), result = checkedSequences(input, value.plans, inspected);
  const coverage = coverageFor(inspected, result.sequences);
  return { ...result, modelComplete: coverage.total > 0 && coverage.remainingIds.length === 0, allValidCombinationsEnumerated: false };
}

/** Revalidate persisted sequences; arbitrary first IDs never count as covered. */
export function getAiOrderCoverage(input, sequences) {
  checkFormat({ schema: AI_STRUCTURE_ORDER_VERSION, plans: sequences });
  const inspected = inspectAiOrderInput(input.engineInput);
  return coverageFor(inspected, checkedSequences(input, sequences, inspected).sequences);
}
