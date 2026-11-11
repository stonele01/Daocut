/** Validate AI-selected subranges against saved material. Pure, local and never a model call. */
import { createHash } from 'node:crypto';
import { inspectAiCompositionInput } from './structure-composition.mjs';

export const AI_STRUCTURE_RANGE_VERSION = 'ai-structure-plans-v2';
export const AI_STRUCTURE_RANGE_SPEED = 1.3;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const unique = values => [...new Set(values)];
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const within = (inner, outer) => inner.startMs >= outer.startMs && inner.endMs <= outer.endMs;
const overlaps = (a, b) => a.startMs < b.endMs && b.startMs < a.endMs;
const joinQuotes = cues => cues.reduce((text, cue) => text + (/[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(cue.text) ? ' ' : '') + cue.text, '');
const conditionMap = value => record(value) && Object.values(value).every(item => ['string', 'number', 'boolean'].includes(typeof item) && (typeof item !== 'number' || Number.isFinite(item)));
const roleFor = Object.freeze({ 故事: 'story', 钩子: 'hook', 痛点: 'pain', 卖点: 'core', 产品演示: 'display', 福利机制: 'offer', 信任背书: 'trust', 行动指令: 'purchase' });
const invalid = message => { throw Object.assign(Error(message), { code: 'AI_STRUCTURE_INVALID_RESPONSE' }); };

/** Parent roles do not describe every possible child; don't require a parent hook/core/close trio. */
export function inspectAiRangeInput(engineInput) {
  const old = inspectAiCompositionInput(engineInput);
  const issues = old.issues.filter(item => !item.code.startsWith('MISSING_'));
  const eligibleCount = old.reviewItems.filter(item => !item.issues.length).length;
  if (!eligibleCount && !issues.length) issues.push({ code: 'RANGE_MATERIAL_REQUIRED', message: '缺少可追溯的已确认话术范围，请先核对已有分析；不会自动重发模型。' });
  return { ...old, version: AI_STRUCTURE_RANGE_VERSION,
    inputHash: hash([AI_STRUCTURE_RANGE_VERSION, AI_STRUCTURE_RANGE_SPEED, old.inputHash]),
    eligibleCount, ready: eligibleCount > 0 && !issues.some(item => item.code === 'SCOPE_INVALID'),
    materialComplete: eligibleCount > 0 && !issues.length, issues };
}

function validateFormat(value) {
  if (!record(value) || value.schema !== AI_STRUCTURE_RANGE_VERSION || !Array.isArray(value.plans) || typeof value.complete !== 'boolean'
    || !Array.isArray(value.issues) || value.issues.some(issue => typeof issue !== 'string')
    || Object.keys(value).some(key => !['schema', 'plans', 'complete', 'issues'].includes(key))) invalid('AI 子段返回格式无效：需要 v2 方案及真实字幕首尾编号');
  for (const row of value.plans) {
    if (!Array.isArray(row) || !row.length) invalid('AI 子段方案格式无效：不能返回半条或空的方案');
    for (const part of row) {
      if (!record(part) || Object.keys(part).some(key => !['unit', 'firstCue', 'lastCue', 'tags', 'conditions'].includes(key))
        || ![part.unit, part.firstCue, part.lastCue].every(n => Number.isSafeInteger(n) && n >= 0)
        || !Array.isArray(part.tags) || !part.tags.length || part.tags.some(tag => typeof tag !== 'string' || !Object.hasOwn(roleFor, tag))
        || part.conditions !== undefined && !conditionMap(part.conditions)) invalid('AI 子段字段、标签或条件格式无效；不得返回改写原话或估计时间');
    }
  }
}

function visualEvidence(input, selected) {
  const review = input.visibility === 'shared' ? input.compositionEvidence?.visualReview : input.visualReview;
  if (review?.status !== 'complete' || input.visibility !== 'shared' && input.visualReviewStale) return false;
  return review.entries?.some(entry => within(selected, entry) && entry.productMatch === 'match' && entry.display === 'shown'
    && Array.isArray(entry.evidenceTimesMs) && entry.evidenceTimesMs.some(ms => ms >= selected.startMs && ms < selected.endMs)) === true;
}

/** Return only the valid explicitly returned rows. No repair, enumeration or semantic keyword guesses. */
export function validateAiStructureRanges(input, value) {
  validateFormat(value);
  const engine = input.engineInput, inspected = inspectAiRangeInput(engine), candidates = engine.candidates ?? [];
  const cues = engine.cues ?? [], cueIndices = engine.cueIndices ?? cues.map((_, n) => n), positions = new Map(cueIndices.map((n, i) => [n, i]));
  const reviews = new Map(inspected.reviewItems.map(item => [item.candidateId, item]));
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const scope = engine.scope, sourceIdentity = engine.sourceIdentity ?? scope.sourceId;
  const plans = [], sequences = [], seen = new Set();
  const issues = value.issues.filter(issue => issue.trim()).map(message => ({ code: 'AI_STRUCTURE_REVIEW', message }));
  const reject = (code, message, row, part, candidate) => {
    issues.push({ code, message: `AI 方案 ${row + 1}${part === undefined ? '' : ` 第 ${part + 1} 段`}：${message}`, row,
      ...(part === undefined ? {} : { part }), ...(candidate ? { candidateId: candidate.id, startMs: candidate.startMs, endMs: candidate.endMs } : {}) });
  };

  value.plans.forEach((sequence, row) => {
    const clips = [], selectedReviews = [];
    for (const [partIndex, part] of sequence.entries()) {
      const parent = candidates[part.unit], item = parent && reviews.get(parent.id), review = item?.review;
      if (!parent || !item || item.issues.length || !review) { reject('AI_RANGE_PARENT', '母话术不属于本次已确认范围，或其原话、边界、上下文仍待核对', row, partIndex, parent); return; }
      const first = positions.get(part.firstCue), last = positions.get(part.lastCue);
      if (first === undefined || last === undefined || last < first) { reject('AI_RANGE_BOUNDARY', '字幕编号不存在、次序错误或混用了窗口局部编号，未估计切点', row, partIndex, parent); return; }
      const lines = cues.slice(first, last + 1), ids = cueIndices.slice(first, last + 1);
      if (ids.some((n, index) => index > 0 && n !== ids[index - 1] + 1)) { reject('AI_RANGE_CUE_GAP', '所选字幕中间有未提供的范围，不能伪装成连续原话', row, partIndex, parent); return; }
      const selected = { startMs: Math.min(...lines.map(cue => cue.startMs)), endMs: Math.max(...lines.map(cue => cue.endMs)) };
      if (!within(selected, parent) || !within(selected, scope)
        || parent.cueRange && (part.firstCue < parent.cueRange[0] || part.lastCue > parent.cueRange[1])) {
        reject('AI_RANGE_BOUNDARY', '细选范围越出母话术或当前一次商品讲解，不能借返场或未确认素材', row, partIndex, parent); return;
      }
      const conditions = { ...review.conditions };
      for (const [name, condition] of Object.entries(part.conditions ?? {})) {
        if (Object.hasOwn(conditions, name) && conditions[name] !== condition) {
          reject('AI_RANGE_CONDITIONS', '裁短后的条件与已确认条件冲突，不能通过裁剪改造报价或资格', row, partIndex, parent); return;
        }
        conditions[name] = condition;
      }
      const tags = unique(part.tags), roles = tags.map(tag => roleFor[tag]);
      if (roles.includes('display') && !visualEvidence(input, selected)) { reject('AI_RANGE_DISPLAY', '没有适用于所选子范围的已保存画面证据，不能继承母段其他位置的展示', row, partIndex, parent); return; }
      if (clips.some(previous => overlaps(previous, selected))) { reject('AI_RANGE_OVERLAP', '同条方案重复播放了重叠原片范围', row, partIndex, parent); return; }
      for (const required of review.requires) {
        const dependency = byId.get(required);
        // A complete continuous child may already include this context in source
        // order. It must still retain content after it; a later/suffix reference
        // cannot stand in for prior context, nor can a crop erase the reference.
        if (dependency && within(dependency, selected) && dependency.endMs < selected.endMs) continue;
        // The stored dependency refers to a whole confirmed range. A new model's crop cannot erase it.
        // Adjacent earlier slices may together cover it, but no interval may be omitted or reordered.
        let coveredThrough = dependency?.startMs;
        for (const previous of clips) if (dependency && previous.startMs <= coveredThrough && previous.endMs > coveredThrough) coveredThrough = previous.endMs;
        if (!dependency || coveredThrough < dependency.endMs) {
          reject('AI_RANGE_CONTEXT', '所选话术有已记录的必要前文，必须在前面完整保留，不能裁短后丢掉', row, partIndex, parent); return;
        }
      }
      for (const [previousIndex, previousReview] of selectedReviews.entries()) {
        const previous = clips[previousIndex];
        if ((review.excludes ?? []).includes(previous.parentCandidateId) || (previousReview.excludes ?? []).includes(parent.id)) {
          reject('AI_RANGE_EXCLUDED', '已有核查明确这些话术不能混用', row, partIndex, parent); return;
        }
        if (Object.entries(conditions).some(([name, condition]) => Object.hasOwn(previous.conditions, name) && previous.conditions[name] !== condition)) {
          reject('AI_RANGE_CONDITIONS', '本条所选范围的规格、活动轮次或优惠条件互相冲突', row, partIndex, parent); return;
        }
      }
      const text = joinQuotes(lines), coreId = `speech-${hash([sourceIdentity, selected.startMs, selected.endMs, text]).slice(0, 24)}`;
      clips.push({ candidateId: parent.id, parentCandidateId: parent.id, candidateIds: [parent.id], sourceId: scope.sourceId,
        ...(nonempty(input.source?.assetPath ?? parent.assetPath) ? { assetPath: input.source?.assetPath ?? parent.assetPath } : {}),
        ...selected, text, tags, roles, coreIds: roles.includes('core') ? [coreId] : [], cueRange: [part.firstCue, part.lastCue],
        parentCueRange: parent.cueRange ? [...parent.cueRange] : undefined, conditions, speed: AI_STRUCTURE_RANGE_SPEED,
        semanticReview: 'ai-selected-range', continuousActionVerified: false, speechVerified: false });
      selectedReviews.push(review);
    }
    const cores = unique(clips.flatMap(clip => clip.coreIds));
    if (!clips.length || clips[0].roles.includes('purchase') || !clips.at(-1).roles.includes('purchase')
      || clips.slice(0, -1).some(clip => clip.roles.includes('purchase')) || cores.length < 1 || cores.length > 2) {
      reject('AI_RANGE_STRUCTURE', '需要非逼单开头、1～2段完整卖点及最后的购买逼单；不能用被裁去的母段标签补结构', row); return;
    }
    const sourceDurationMs = clips.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0);
    const durationMs = sourceDurationMs / AI_STRUCTURE_RANGE_SPEED;
    if (durationMs < 30000 || durationMs > 40000) { reject('AI_RANGE_DURATION', `按所选真实范围和1.3倍速计算为${(durationMs / 1000).toFixed(2)}秒，不满足成片30～40秒；未自动截话或加速`, row); return; }
    const playback = [];
    for (const clip of clips) {
      const previous = playback.at(-1);
      if (previous && previous[1] === clip.startMs) previous[1] = clip.endMs;
      else playback.push([clip.startMs, clip.endMs]);
    }
    const id = `ai-${hash([AI_STRUCTURE_RANGE_VERSION, sourceIdentity, scope.startMs, scope.endMs, AI_STRUCTURE_RANGE_SPEED, playback])}`;
    if (seen.has(id)) return;
    seen.add(id);
    clips[0].roles = unique(['hook', ...clips[0].roles]);
    const coreLabels = Object.fromEntries(clips.flatMap(clip => clip.coreIds.map(coreId => [coreId, clip.text.length > 24 ? `${clip.text.slice(0, 24)}…` : clip.text])));
    plans.push({ id, version: AI_STRUCTURE_RANGE_VERSION, generationMethod: 'ai', inputHash: inspected.inputHash,
      scope: { ...scope }, clips, coreIds: cores, coreLabels, durationMs, sourceDurationMs, speed: AI_STRUCTURE_RANGE_SPEED,
      referenceDuration: 'reference', structure: clips.map(clip => ({ candidateId: clip.candidateId, roles: [...clip.roles], coreIds: [...clip.coreIds] })),
      continuousActionVerified: false, speechVerified: false });
    sequences.push(structuredClone(sequence));
  });
  return { plans, sequences, modelComplete: value.complete, allValidCombinationsEnumerated: false, issues };
}
