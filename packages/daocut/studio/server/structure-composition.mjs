/** Pure composition of verified source ranges. No provider, filesystem or media operations. */
import { createHash } from 'node:crypto';

export const STRUCTURE_COMPOSITION_VERSION = 'structure-composition-v1';
export const STRUCTURE_COMPOSITION_ROLES = Object.freeze(['hook', 'core', 'purchase', 'pain', 'offer', 'trust', 'story', 'display']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;
const strings = value => Array.isArray(value) && value.every(string);
const unique = values => [...new Set(values)];
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const encoded = value => JSON.stringify(canonical(value));
const hash = value => createHash('sha256').update(encoded(value)).digest('hex');
const ms = value => Number.isSafeInteger(value) && value >= 0;
const contains = (outer, inner) => inner.startMs >= outer.startMs && inner.endMs <= outer.endMs;
const overlaps = (left, right) => left.startMs < right.endMs && right.startMs < left.endMs;
const joinQuotes = lines => lines.reduce((text, line) => text + (/[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(line.text) ? ' ' : '') + line.text, '');
const failure = (code, message) => Object.assign(new Error(message), { code });
// The new analysis contract already encloses all necessary context in one source
// range. Older saved analyses/cursors keep their original interpretation and IDs.
const completeSpeech = review => review?.contract === 'complete-speech-v1';
const canOpen = atom => atom.completeSpeech || atom.aiComposition
  ? atom.roles.length > 0 && !atom.roles.includes('purchase')
  : atom.roles.includes('hook');

function prepare(input = {}, { aiComposition = false } = {}) {
  const scope = input.scope ?? {}, issues = [], reviewItems = [];
  const issue = (code, message, candidate, extra = {}) => {
    const value = { code, message, ...(candidate ? { candidateId: candidate.id, text: candidate.text, startMs: candidate.startMs, endMs: candidate.endMs } : {}), ...extra };
    if (!issues.some(old => old.code === code && old.candidateId === value.candidateId && old.message === message)) issues.push(value);
    return value;
  };
  const validScope = [scope.sourceId, scope.productId, scope.intervalId].every(string) && ms(scope.startMs) && ms(scope.endMs) && scope.endMs > scope.startMs;
  if (!validScope) issue('SCOPE_INVALID', '请选择并保存一个有效的商品讲解段，生成范围不能跨返场。');
  const sourceIdentity = string(input.sourceIdentity) ? input.sourceIdentity : scope.sourceId ?? 'unidentified-source';
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const analysisIssues = Array.isArray(input.analysisIssues) ? input.analysisIssues.filter(string) : [];
  for (const message of analysisIssues) issue('ANALYSIS_INCOMPLETE', message);
  const allById = new Map(candidates.filter(candidate => record(candidate) && string(candidate.id)).map(candidate => [candidate.id, candidate]));
  const inScope = candidate => record(candidate) && candidate.sourceId === scope.sourceId && candidate.productId === scope.productId && candidate.intervalId === scope.intervalId;
  const selected = candidates.filter(inScope);
  const cues = Array.isArray(input.cues) ? input.cues : [];
  const cueIndices = Array.isArray(input.cueIndices) ? input.cueIndices : cues.map((_, index) => index);
  const cueMapValid = cueIndices.length === cues.length && cueIndices.every(index => Number.isSafeInteger(index) && index >= 0) && new Set(cueIndices).size === cueIndices.length;
  const reviewed = new Map((Array.isArray(input.semanticReview?.entries) ? input.semanticReview.entries : []).filter(record).map(value => [value.candidateId, value]));
  const lookupReview = candidate => reviewed.get(candidate.id) ?? candidate.composition ?? candidate.details?.composition;
  const groups = new Map(), candidateToGroup = new Map();
  const stableCandidate = candidate => candidate ? [sourceIdentity, candidate.startMs, candidate.endMs, candidate.text] : null;
  const stableRef = id => stableCandidate(allById.get(id)) ?? ['unavailable-reference', id];
  const stableReview = value => record(value) ? {
    ...(value.contract !== undefined ? { contract: value.contract } : {}),
    status: value.status, confirmed: value.confirmed, roles: value.roles, coreIds: value.coreIds,
    requires: Array.isArray(value.requires) ? value.requires.map(stableRef).sort((a, b) => encoded(a).localeCompare(encoded(b))) : value.requires,
    conditions: value.conditions,
    excludes: Array.isArray(value.excludes) ? value.excludes.map(stableRef).sort((a, b) => encoded(a).localeCompare(encoded(b))) : value.excludes,
  } : null;
  const inputHash = hash({ version: STRUCTURE_COMPOSITION_VERSION, sourceIdentity, scope: { startMs: scope.startMs, endMs: scope.endMs }, validScope,
    ...(analysisIssues.length ? { analysisIssues } : {}),
    semanticVersion: input.semanticReview?.version, coreLabels: input.semanticReview?.coreLabels ?? {},
    analysisVersion: input.analysisVersion, baselineVersion: input.baselineVersion,
    candidates: selected.map(candidate => ({ anchor: stableCandidate(candidate), cueRange: candidate.cueRange, version: candidate.version, review: stableReview(lookupReview(candidate)) })).sort((a, b) => encoded(a).localeCompare(encoded(b))),
    cues, cueIndices });

  for (const candidate of selected) {
    const before = issues.length;
    const review = lookupReview(candidate);
    const clue = { candidateId: candidate.id, sourceId: candidate.sourceId, productId: candidate.productId, intervalId: candidate.intervalId,
      startMs: candidate.startMs, endMs: candidate.endMs, text: candidate.text, tags: candidate.tags ?? [], details: candidate.details ?? null,
      ...(record(review) ? { review: structuredClone(review) } : {}), issues: [] };
    reviewItems.push(clue);
    if (!string(candidate.id)) issue('CANDIDATE_ID_INVALID', '话术缺少可靠的片段编号。', candidate);
    if (!validScope || !ms(candidate.startMs) || !ms(candidate.endMs) || candidate.endMs <= candidate.startMs || !contains(scope, candidate)) {
      issue('CANDIDATE_OUTSIDE_SCOPE', '话术超出当前商品讲解段，不能扩大范围或借用返场素材。', candidate);
    }
    let first = -1, last = -1;
    if (cueMapValid && Array.isArray(candidate.cueRange) && candidate.cueRange.length === 2) {
      first = cueIndices.indexOf(candidate.cueRange[0]); last = cueIndices.indexOf(candidate.cueRange[1]);
    } else if (cueMapValid && candidate.cueRange === undefined) {
      // Old results can reuse an exact, continuous known span. No timing estimate or sentence rewrite.
      first = cues.findIndex(cue => cue?.startMs === candidate.startMs);
      if (first >= 0) last = cues.findIndex((cue, index) => index >= first && cue?.endMs === candidate.endMs);
    }
    const lines = first >= 0 && last >= first ? cues.slice(first, last + 1) : [];
    if (!lines.length || lines.some((cue, index) => !record(cue) || !string(cue.text) || !ms(cue.startMs) || !ms(cue.endMs) || cue.endMs <= cue.startMs || !contains(scope, cue) || (index > 0 && cue.startMs < lines[index - 1].startMs)) || Math.min(...lines.map(cue => cue.startMs)) !== candidate.startMs || Math.max(...lines.map(cue => cue.endMs)) !== candidate.endMs) {
      issue('BOUNDARY_UNVERIFIED', '原话边界无法对应本段完整字幕或已确认逐词边界，请先核对。', candidate);
    } else if (candidate.text !== joinQuotes(lines)) {
      issue('QUOTE_MISMATCH', '片段文字与所引用原话不一致，不能补写、改写或截断原话。', candidate);
    }
    if (input.semanticReview?.version !== undefined && input.semanticReview.version !== 1) issue('SEMANTIC_VERSION_UNSUPPORTED', '语义核对记录版本无法识别，已有原话保留。', candidate);
    if (!record(review) || !(review.status === 'confirmed' || review.confirmed === true)) {
      issue('SEMANTICS_UNREVIEWED', '缺少已确认的结构作用、核心卖点、上下文依赖及条件信息；不会自动请求模型。', candidate);
    } else {
      if (!strings(review.roles) || review.roles.some(role => !STRUCTURE_COMPOSITION_ROLES.includes(role))) issue('ROLES_UNREVIEWED', '请核对这段承担的结构作用；购买逼单需明确针对观众购买。', candidate);
      if (!strings(review.requires)) issue('DEPENDENCIES_UNREVIEWED', '请明确这段是否需要前文及具体前文；旧 context 为空不代表已确认独立。', candidate);
      if (!record(review.conditions) || Object.values(review.conditions).some(value => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) issue('CONDITIONS_UNREVIEWED', '请核对规格、优惠轮次等适用条件；确认无条件时需明确记录。', candidate);
      if (!completeSpeech(review) && Array.isArray(review.roles) && review.roles.includes('core') && (!strings(review.coreIds) || !review.coreIds.length)) issue('CORE_UNREVIEWED', '卖点尚未关联到已确认的核心购买理由，不能只凭“卖点”标签计数。', candidate);
      if (review.coreIds !== undefined && !strings(review.coreIds)) issue('CORE_UNREVIEWED', '核心卖点编号格式无效。', candidate);
      if (Array.isArray(review.coreIds) && review.coreIds.length && !review.roles?.includes('core')) issue('CORE_ROLE_MISMATCH', '核心卖点编号与结构作用不一致，请核对。', candidate);
      if (review.excludes !== undefined && !strings(review.excludes)) issue('EXCLUSIONS_UNREVIEWED', '互斥话术记录格式无效，请核对。', candidate);
    }
    clue.issues = issues.slice(before);
    if (issues.length !== before) continue;
    const key = encoded(stableCandidate(candidate));
    let group = groups.get(key);
    const conditions = canonical(review.conditions);
    if (!group) {
      group = { key, candidate, candidateIds: [], roles: [], coreIds: [], requireIds: [], excludeIds: [], conditions: {}, cueRange: [cueIndices[first], cueIndices[last]], completeSpeech: completeSpeech(review), aiComposition, invalid: false };
      groups.set(key, group);
    }
    group.candidateIds.push(candidate.id);
    group.roles = unique([...group.roles, ...review.roles]).sort();
    const coreIds = completeSpeech(review) || aiComposition ? (review.roles.includes('core') ? [`speech-${hash(stableCandidate(candidate)).slice(0, 24)}`] : []) : (review.coreIds ?? []);
    group.coreIds = unique([...group.coreIds, ...coreIds]).sort();
    group.requireIds = unique([...group.requireIds, ...review.requires]);
    group.excludeIds = unique([...group.excludeIds, ...(review.excludes ?? [])]);
    for (const [name, value] of Object.entries(conditions)) {
      if (Object.hasOwn(group.conditions, name) && group.conditions[name] !== value) {
        group.invalid = true;
        issue('CONTRADICTORY_REVIEW', '同一原片范围存在冲突的条件核对记录。', candidate);
      }
      group.conditions[name] = value;
    }
    candidateToGroup.set(candidate.id, group);
  }
  for (const group of groups.values()) {
    group.requires = [];
    group.excludes = [];
    for (const id of group.requireIds) {
      const target = candidateToGroup.get(id), original = allById.get(id);
      if (!target) {
        group.invalid = true;
        issue(original && (!inScope(original) || !contains(scope, original)) ? 'DEPENDENCY_OUTSIDE_SCOPE' : 'DEPENDENCY_UNAVAILABLE', original && (!inScope(original) || !contains(scope, original)) ? '必要前文位于当前商品讲解段外，不能跨返场或越界补齐。' : '必要前文缺失或尚未核对完整，当前话术不能独立拼入。', group.candidate, { dependencyId: id });
      } else group.requires.push(target);
    }
    for (const id of group.excludeIds) {
      const target = candidateToGroup.get(id);
      if (target) group.excludes.push(target);
    }
    if (group.excludes.includes(group)) {
      group.invalid = true;
      issue('CONTRADICTORY_REVIEW', '同一实际原片范围不能同时被确认为自身的互斥片段。', group.candidate);
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(group, chain) {
    if (visiting.has(group)) {
      for (const member of chain.slice(chain.indexOf(group))) {
        member.invalid = true;
        issue('DEPENDENCY_CYCLE', '上下文依赖形成循环，无法确定完整的原话顺序，请核对。', member.candidate);
      }
      return;
    }
    if (visited.has(group)) return;
    visiting.add(group);
    for (const target of group.requires) visit(target, [...chain, group]);
    visiting.delete(group); visited.add(group);
  }
  for (const group of groups.values()) visit(group, []);
  let changed;
  do {
    changed = false;
    for (const group of groups.values()) if (!group.invalid && group.requires.some(target => target.invalid)) {
      group.invalid = true; changed = true;
      issue('DEPENDENCY_UNAVAILABLE', '这段需要的前文尚未通过核对，不能单独加入有效方案。', group.candidate);
    }
  } while (changed);
  const atoms = [...groups.values()].filter(group => !group.invalid).sort((a, b) => a.candidate.startMs - b.candidate.startMs || a.candidate.endMs - b.candidate.endMs || a.key.localeCompare(b.key));
  atoms.forEach((atom, index) => { atom.index = index; });
  atoms.forEach(atom => {
    atom.requires = unique(atom.requires.map(target => target.index));
    atom.excludes = unique(atom.excludes.filter(target => !target.invalid).map(target => target.index));
  });
  // Resolve after all references have been converted, independent of source order.
  atoms.forEach(atom => { atom.neededAsContext = atoms.some(other => other.requires.includes(atom.index)); });
  const materialComplete = validScope && !issues.length;
  const missing = [
    ['hook', '缺少可独立成立或已补齐段内前文的钩子。'],
    ['core', '缺少已确认核心购买理由的完整卖点话术。'],
    ['purchase', '缺少面向观众的明确购买逼单话术。'],
  ].filter(([role]) => !atoms.some(atom => (role === 'hook' ? canOpen(atom) : atom.roles.includes(role)) && (role !== 'core' || atom.coreIds.length)));
  for (const [role, message] of missing) issue(`MISSING_${role.toUpperCase()}`, message);
  for (const item of reviewItems) item.issues = issues.filter(value => value.candidateId === item.candidateId);
  const speechLabels = Object.fromEntries(atoms.filter(atom => atom.completeSpeech || atom.aiComposition).flatMap(atom => atom.coreIds.map(id => [id, atom.candidate.text.length > 24 ? `${atom.candidate.text.slice(0, 24)}…` : atom.candidate.text])));
  const coreLabels = Object.fromEntries(unique(atoms.flatMap(atom => atom.coreIds)).map(id => [id, speechLabels[id] ?? (string(input.semanticReview?.coreLabels?.[id]) ? input.semanticReview.coreLabels[id] : id)]));
  const inspection = { version: STRUCTURE_COMPOSITION_VERSION, inputHash, scope: { ...scope }, ready: validScope && missing.length === 0, materialComplete,
    candidateCount: selected.length, eligibleCount: atoms.length, ignoredCount: candidates.length - selected.length, issues, reviewItems, coreLabels };
  return { input, scope, sourceIdentity, atoms, inspection };
}

export function inspectCompositionInput(input) { return prepare(input).inspection; }
export function inspectAiCompositionInput(input) { return prepare(input, { aiComposition: true }).inspection; }

/** Validate an explicitly chosen sequence. This never searches or rearranges it. */
export function validateStructureSequences(input, sequences) {
  const prepared = prepare(input, { aiComposition: true }), plans = [], issues = [], accepted = [], seen = new Set();
  const indices = new Map(prepared.atoms.flatMap(atom => atom.candidateIds.map(id => [id, atom.index])));
  sequences.forEach((sequence, row) => {
    const path = [];
    const valid = sequence.every(id => {
      const index = indices.get(id);
      if (index === undefined || path.some(item => prepared.atoms[item].roles.includes('purchase')) || !canAppend(prepared.atoms, path, index)) return false;
      path.push(index); return true;
    }) && validPath(prepared.atoms, path);
    if (!valid) { issues.push({ code: 'AI_SEQUENCE_INVALID', message: `AI 方案 ${row + 1} 的结构、完整范围、上下文或活动条件不成立，未自动改排`, row }); return; }
    const plan = planFor(prepared, path);
    if (seen.has(plan.id)) return;
    seen.add(plan.id); plans.push(plan); accepted.push(row);
  });
  return { plans, issues, accepted, inspection: prepared.inspection };
}

function canAppend(atoms, path, index) {
  if (path.includes(index)) return false;
  const candidate = atoms[index];
  if (path.some(item => atoms[item].completeSpeech && atoms[item].roles.includes('purchase'))) return false;
  if (!candidate.requires.every(required => path.includes(required))) return false;
  if (!candidate.roles.length && !candidate.neededAsContext) return false;
  if (!path.some(item => atoms[item].roles.length) && candidate.roles.length && !canOpen(candidate)) return false;
  const coreIds = new Set(candidate.coreIds);
  const conditions = { ...candidate.conditions };
  for (const previousIndex of path) {
    const previous = atoms[previousIndex];
    if (overlaps(previous.candidate, candidate.candidate) || previous.excludes.includes(index) || candidate.excludes.includes(previousIndex)) return false;
    for (const id of previous.coreIds) coreIds.add(id);
    for (const [name, value] of Object.entries(previous.conditions)) {
      if (Object.hasOwn(conditions, name) && conditions[name] !== value) return false;
      conditions[name] = value;
    }
  }
  return coreIds.size <= 2;
}

function validPath(atoms, path) {
  if (!path.length) return false;
  const selected = path.map(index => atoms[index]);
  const first = selected.find(atom => atom.roles.length);
  if (!first || !canOpen(first) || !selected.at(-1).roles.includes('purchase')) return false;
  const openingDependencies = new Set();
  function includeDependencies(atom) {
    for (const index of atom.requires) if (!openingDependencies.has(index)) {
      openingDependencies.add(index); includeDependencies(atoms[index]);
    }
  }
  includeDependencies(first);
  if (selected.slice(0, selected.indexOf(first)).some(atom => !openingDependencies.has(atom.index))) return false;
  const cores = new Set(selected.flatMap(atom => atom.coreIds));
  if (!cores.size || cores.size > 2) return false;
  // A context-only clip must actually be required by something in this plan.
  return selected.every(atom => atom.roles.length || selected.some(other => other.requires.includes(atom.index)));
}

function planFor(prepared, path) {
  const { input, scope, sourceIdentity, atoms, inspection } = prepared;
  const selected = path.map(index => atoms[index]);
  const opening = selected.find(atom => atom.roles.length);
  const clips = selected.map(atom => ({ candidateId: atom.candidate.id, candidateIds: [...atom.candidateIds], sourceId: scope.sourceId,
    ...(string(atom.candidate.assetPath ?? scope.assetPath ?? input.assetPath) ? { assetPath: atom.candidate.assetPath ?? scope.assetPath ?? input.assetPath } : {}),
    startMs: atom.candidate.startMs, endMs: atom.candidate.endMs, text: atom.candidate.text,
    roles: atom === opening && atom.completeSpeech ? unique(['hook', ...atom.roles]) : [...atom.roles], coreIds: [...atom.coreIds], cueRange: [...atom.cueRange], speed: 1 }));
  const playback = [];
  for (const clip of clips) {
    const previous = playback.at(-1);
    if (previous && previous[1] === clip.startMs) previous[1] = clip.endMs;
    else playback.push([clip.startMs, clip.endMs]);
  }
  const durationMs = clips.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0);
  const coreIds = unique(clips.flatMap(clip => clip.coreIds)).sort();
  return { id: `structure-${hash([STRUCTURE_COMPOSITION_VERSION, sourceIdentity, scope.startMs, scope.endMs, playback])}`,
    version: STRUCTURE_COMPOSITION_VERSION, inputHash: inspection.inputHash, scope: { ...scope }, clips, coreIds,
    coreLabels: Object.fromEntries(coreIds.map(id => [id, inspection.coreLabels[id]])),
    durationMs, speed: 1, referenceDuration: durationMs < 30000 ? 'short' : durationMs > 50000 ? 'long' : 'reference',
    structure: clips.map(clip => ({ candidateId: clip.candidateId, roles: [...clip.roles], coreIds: [...clip.coreIds] })) };
}

function restoreCursor(cursor, prepared) {
  if (!cursor) return { version: STRUCTURE_COMPOSITION_VERSION, inputHash: prepared.inspection.inputHash, path: [], next: [0], evaluated: false, seen: [], stats: { visited: 0, emitted: 0 } };
  if (cursor.inputHash !== prepared.inspection.inputHash) throw failure('COMPOSITION_INPUT_CHANGED', '商品段、原话或语义核对已变化，不能继续旧批次；请重新生成，已有草稿保留。');
  const { atoms } = prepared;
  const valid = cursor.version === STRUCTURE_COMPOSITION_VERSION && Array.isArray(cursor.path) && cursor.path.every(index => Number.isSafeInteger(index) && index >= 0 && index < atoms.length) && new Set(cursor.path).size === cursor.path.length && Array.isArray(cursor.next) && cursor.next.length === cursor.path.length + 1 && cursor.next.every(index => Number.isSafeInteger(index) && index >= 0 && index <= atoms.length) && typeof cursor.evaluated === 'boolean' && strings(cursor.seen) && new Set(cursor.seen).size === cursor.seen.length && record(cursor.stats) && Number.isSafeInteger(cursor.stats.visited) && cursor.stats.visited >= 0 && cursor.stats.emitted === cursor.seen.length;
  if (!valid || cursor.path.some((index, depth) => !canAppend(atoms, cursor.path.slice(0, depth), index))) throw failure('COMPOSITION_CURSOR_INVALID', '组合进度记录无效，未把部分结果冒充全部完成。');
  return structuredClone(cursor);
}

/**
 * A page is a work budget, never a top-K selection. The JSON cursor exhausts all
 * non-repeating source-range paths; no duration or fixed fragment-count cutoff.
 * `complete` covers the reviewed subset. `allValidCombinationsEnumerated` also
 * requires that every candidate in this exact lecture had usable semantic data.
 */
export function enumerateStructureCompositions(input, { cursor = null, limit = 50, stepBudget = 10000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(stepBudget) || stepBudget < 1) throw failure('COMPOSITION_BUDGET_INVALID', '每批返回数量与计算步数必须为正整数。');
  const prepared = prepare(input), { atoms, inspection } = prepared;
  const state = restoreCursor(cursor, prepared), seen = new Set(state.seen), plans = [];
  let complete = !inspection.ready;
  for (let step = 0; !complete && step < stepBudget && plans.length < limit; step++) {
    state.stats.visited++;
    if (!state.evaluated) {
      state.evaluated = true;
      if (validPath(atoms, state.path)) {
        const plan = planFor(prepared, state.path);
        if (!seen.has(plan.id)) { seen.add(plan.id); plans.push(plan); state.stats.emitted++; }
      }
      continue;
    }
    const depth = state.path.length;
    if (state.next[depth] >= atoms.length) {
      if (!depth) { complete = true; break; }
      state.path.pop(); state.next.pop(); state.evaluated = true;
      continue;
    }
    const index = state.next[depth]++;
    if (canAppend(atoms, state.path, index)) {
      state.path.push(index); state.next.push(0); state.evaluated = false;
    }
  }
  state.seen = [...seen];
  const issues = [...inspection.issues];
  if (complete && inspection.ready && state.stats.emitted === 0) issues.push({ code: 'NO_COMPATIBLE_COMBINATION', message: '已核对材料的上下文、条件或不重复要求无法同时成立；没有硬凑方案。' });
  return { version: STRUCTURE_COMPOSITION_VERSION, inputHash: inspection.inputHash, plans, cursor: complete ? null : state, complete,
    materialComplete: inspection.materialComplete, allValidCombinationsEnumerated: complete && inspection.materialComplete,
    ready: inspection.ready, issues, stats: { ...state.stats }, coreLabels: inspection.coreLabels };
}
