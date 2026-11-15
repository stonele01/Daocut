import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { HttpError } from './http.mjs';
import { createStructurePlanInputReader, localize } from './structure-plans.mjs';
import { inspectAiCompositionInput } from './structure-composition.mjs';
import { inspectAiRangeInput } from './ai-structure-ranges.mjs';
import { AI_STRUCTURE_ORDER_VERSION, inspectAiOrderInput, getAiOrderCoverage, validateAiStructureOrder } from './ai-structure-order.mjs';
import { AI_STRUCTURE_VARIANTS_VERSION, inspectAiVariantsInput, getAiVariantsCoverage, planAiVariantBatches } from './ai-structure-variants.mjs';
import { AI_STRUCTURE_CURATED_VERSION, inspectAiCuratedInput, getAiCuratedCoverage } from './ai-structure-curated.mjs';
import { AI_STRUCTURE_REQUIRED_VERSION, inspectAiRequiredInput, getAiRequiredCoverage } from './ai-structure-required.mjs';
import { AI_STRUCTURE_PRICED_VERSION, inspectAiPricedInput, getAiPricedCoverage, MAX_OPENING_VARIANTS } from './ai-structure-priced.mjs';
import { recoverDeepSeekTextResponse } from './text-structure.mjs';
import { AI_STRUCTURE_VERSION, AI_STRUCTURE_VERSIONS, PREVIOUS_AI_STRUCTURE_VERSION, aiStructurePrompt, createAiStructureRequest, validateAiStructureResponse } from './ai-structure.mjs';

const directory = root => join(root, '.film', 'ai-structure-plans');
const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new HttpError(409, 'AI 方案记录无法读取，原记录保留'); } };
const save = async (root, key, data) => { await mkdir(directory(root), { recursive: true }); await writeAtomic(join(directory(root), `${key}.json`), JSON.stringify(data)); };
const publicModel = m => m ? { model: typeof m === 'string' ? m : m.model, provider: m.provider, endpoint: m.endpoint } : null;
const errorIssue = message => ({ code: 'AI_STRUCTURE_FAILED', message });
const OPENING_BATCH_SIZE = 8;
const OPENING_BATCH_ATTEMPTS = 2;
const isCurated = m => [AI_STRUCTURE_CURATED_VERSION, AI_STRUCTURE_REQUIRED_VERSION, AI_STRUCTURE_PRICED_VERSION].includes(m.version);
const isVariants = m => m.version === AI_STRUCTURE_VARIANTS_VERSION || isCurated(m);
const isOrdered = m => m.version === AI_STRUCTURE_ORDER_VERSION || isVariants(m);

/** Confirmed requests are persisted per round. Reuse/recovery never sends them again. */
export function createAiStructurePlans({ readInput = createStructurePlanInputReader(), modelClient, modelIdentity, sharedAnalysis, saveRecord = save } = {}) {
  const starts = new Map(), jobs = new Map(), storageErrors = new Map();
  const persist = saveRecord;
  const purposeFor = m => isCurated(m) ? { purpose: 'curated-composition' } : {};
  const identity = async m => typeof modelIdentity === 'function' ? modelIdentity(purposeFor(m)) : modelIdentity ?? await modelClient?.getCacheIdentity?.(purposeFor(m));
  const lockKey = (root, request) => JSON.stringify([root, request.sourceId, request.productId, request.intervalId]);
  async function versionedMaterial(root, input, version) {
    const legacy = version === PREVIOUS_AI_STRUCTURE_VERSION;
    const inspected = input.engineInput && (version === AI_STRUCTURE_PRICED_VERSION ? inspectAiPricedInput(input.engineInput)
      : version === AI_STRUCTURE_REQUIRED_VERSION ? inspectAiRequiredInput(input.engineInput)
      : version === AI_STRUCTURE_CURATED_VERSION ? inspectAiCuratedInput(input.engineInput)
      : version === AI_STRUCTURE_VARIANTS_VERSION ? inspectAiVariantsInput(input.engineInput)
      : version === AI_STRUCTURE_ORDER_VERSION ? inspectAiOrderInput(input.engineInput)
      : legacy ? inspectAiCompositionInput(input.engineInput) : inspectAiRangeInput(input.engineInput, { version }));
    const issues = [...(input.issues ?? []), ...(inspected?.issues ?? [])];
    const blocked = !['local', 'shared'].includes(input.visibility) || !inspected?.ready;
    const key = sharedHash({ kind: version, prompt: aiStructurePrompt(version), analysis: input.analysisVersion,
      semantic: input.semanticVersion, input: inspected?.inputHash, visibility: input.visibility });
    let saved = null, readError;
    try {
      saved = blocked ? null : await read(join(directory(root), `${key}.json`));
      if (saved && (saved.version !== version || saved.key !== key || saved.sourceId !== input.source.id)) throw new HttpError(409, 'AI 方案身份不匹配，未覆盖旧记录');
    } catch (error) { saved = null; readError = error.message; }
    return { root, input, inspected, issues, blocked, key, version, saved, readError };
  }
  async function material(root, request) {
    if (request.rulesVersion !== undefined && !AI_STRUCTURE_VERSIONS.includes(request.rulesVersion)) throw new HttpError(409, '拼结构规则版本无效，未生成或替换已有结果');
    const input = await readInput(root, request);
    const versions = await Promise.all(AI_STRUCTURE_VERSIONS.map(version => versionedMaterial(root, input, version)));
    const [current, ...historical] = versions;
    // The new workspace reuses exact, already-saved whole-speech plans. Reading
    // never rewrites their task, receipt, plan IDs or personal draft references.
    const priorOrder = historical.find(item => item.version === AI_STRUCTURE_ORDER_VERSION);
    const variants = versions.find(item => item.version === AI_STRUCTURE_VARIANTS_VERSION);
    if (!variants.blocked && !variants.saved && priorOrder?.saved?.rounds?.at(-1)?.status === 'complete') {
      const sequences = priorOrder.saved.rounds.filter(round => round.status === 'complete').flatMap(round => round.result?.sequences ?? []);
      const valid = validateAiStructureOrder(input, { schema: AI_STRUCTURE_ORDER_VERSION, plans: sequences });
      const ids = new Set(valid.plans.map(plan => plan.id));
      const plans = allPlans(priorOrder.saved).filter(plan => ids.has(plan.id));
      if (plans.length) variants.seed = { version: AI_STRUCTURE_ORDER_VERSION, taskKey: priorOrder.key,
        sourceHash: sharedHash(priorOrder.saved), plans, sequences: valid.sequences,
        usageSamples: priorOrder.saved.rounds.filter(round => round.receipt?.usage?.output_tokens > 0 && round.result?.plans?.length)
          .map(round => ({ model: round.model, outputTokens: round.receipt.usage.output_tokens,
            openings: round.openingIds?.length || new Set(round.result.sequences.map(sequence => sequence[0])).size })) };
    }
    for (const item of versions) if (item.saved?.seed) item.seed = item.saved.seed;
    const keyed = request.taskKey === undefined ? null : versions.find(item => item.key === request.taskKey);
    if (request.taskKey !== undefined && (!keyed || request.rulesVersion !== undefined && request.rulesVersion !== keyed.version)) throw new HttpError(409, '方案标识不属于当前讲解和规则版本，请重新读取；未使用其他输入的结果');
    const explicit = keyed ?? versions.find(item => item.version === request.rulesVersion);
    // A colleague may have only a published v5 result, including its v4 seed.
    // Its first request cannot be reconstructed until the saved seed is read.
    // Discover those exact published rounds before an old analysis is rejected
    // for not containing the new opening-selection metadata. No model is called.
    if (!explicit && current.blocked && input.visibility === 'shared' && !variants.blocked && !variants.saved && !variants.readError) {
      const oldWorkspace = { ...variants, versions };
      try {
        await importPublishedVariants(oldWorkspace);
        if (oldWorkspace.saved) return oldWorkspace;
      } catch (error) {
        return { ...oldWorkspace, blocked: true, issues: [...oldWorkspace.issues, errorIssue(`已有公共方案读取未完成：${error.message}`)] };
      }
    }
    const selected = explicit ?? (current.seed ? current : versions.find(item => item.saved || item.readError)) ?? current;
    const attach = m => ({ ...m, versions });
    const blockedUpgrade = (legacy, message, status = legacy.saved?.rounds?.at(-1)?.status ?? 'unknown') => ({ ...attach(current), blocked: true,
      blockedBy: { version: legacy.version, taskKey: legacy.key, status },
      issues: [...current.issues, { code: 'AI_STRUCTURE_LEGACY_UNAVAILABLE', message: `${message}；请先恢复或补存已有结果，未发起新版模型请求` }] });
    const absentLegacy = legacy => ({ ...attach(legacy), blocked: true, issues: [...legacy.issues, { code: 'AI_STRUCTURE_LEGACY_READ_ONLY', message: '没有已保存的旧版方案；旧版仅供查看、恢复及已有轮次续跑，新建请使用当前规则' }] });
    // Listing another version never changes its bytes, and an unreadable unrelated
    // historical record must not hide a saved current result or its recovery.
    if (selected.readError) return { ...attach(selected), blocked: true, issues: [...selected.issues, errorIssue(selected.readError)] };
    if (selected.saved || selected.seed || selected.blocked && selected !== current) return attach(selected);
    if (explicit === current && !current.blocked && input.visibility === 'shared') {
      // Reusing a colleague's current result is not a new paid upgrade.
      try {
        current.prepared = await nextRound(current);
        if (current.prepared.descriptor?.mode !== 'publish') { current.publicExists = true; return attach(current); }
      } catch (error) { return { ...attach(current), blocked: true, issues: [...current.issues, errorIssue(error.message)] }; }
    }
    if (selected === current) for (const legacy of historical) {
      if (legacy.readError) return blockedUpgrade(legacy, `旧方案结果无法读取：${legacy.readError}`);
      const last = legacy.saved?.rounds?.at(-1);
      if (legacy.saved && (last?.status !== 'complete' || !last.result)) return blockedUpgrade(legacy, '旧拼结构任务未完成，结果或费用状态仍不明确');
    }
    // A colleague may have no local record. Read the exact old public identity
    // before offering a paid upgrade; preparing does not claim or send a request.
    const prior = explicit && explicit !== current ? [explicit] : historical;
    if (input.visibility === 'shared') for (const legacy of prior) {
      if (legacy.saved || legacy.blocked) continue;
      try {
        legacy.prepared = await nextRound(legacy);
        if (legacy.prepared.descriptor?.mode !== 'publish') {
          legacy.publicExists = true;
          if (explicit !== current) return attach(legacy);
          if (legacy.prepared.descriptor?.mode !== 'reuse') return blockedUpgrade(legacy, '旧公共任务已有提交但尚未完整保存', legacy.prepared.descriptor.status ?? legacy.prepared.descriptor.mode);
          // Verify the completed prior result, without creating or rewriting its AI record.
          await publicResult(legacy, legacy.prepared);
        }
      } catch (error) {
        return explicit === legacy
          ? { ...attach(legacy), blocked: true, issues: [...legacy.issues, errorIssue(`旧公共方案状态无法核查：${error.message}`)] }
          : blockedUpgrade(legacy, `旧公共方案状态无法核查：${error.message}`);
      }
    }
    // Analyses saved before opening selection can still use their explicit v5
    // workspace. New curated analyses use v6 and never inherit its plan history.
    if (explicit?.version === AI_STRUCTURE_VARIANTS_VERSION && current.blocked) return attach(explicit);
    return explicit && explicit !== current ? absentLegacy(explicit) : attach(current);
  }
  const allPlans = saved => (saved?.rounds ?? []).flatMap(r => r.result?.plans ?? []);
  const previous = saved => (saved?.rounds ?? []).flatMap(r => r.result?.sequences ?? []);
  const plansFor = m => [...(isVariants(m) ? m.seed?.plans ?? [] : []), ...allPlans(m.saved)];
  const previousFor = m => [...(isVariants(m) ? m.seed?.sequences ?? [] : []), ...previous(m.saved)];
  function variantCoverage(m, nextPass = false) {
    const coverage = m.version === AI_STRUCTURE_PRICED_VERSION ? getAiPricedCoverage(m.input, previousFor(m))
      : m.version === AI_STRUCTURE_REQUIRED_VERSION ? getAiRequiredCoverage(m.input, previousFor(m))
      : isCurated(m) ? getAiCuratedCoverage(m.input, previousFor(m)) : getAiVariantsCoverage(m.input, previousFor(m), { targetVariants: 1 });
    const processed = new Set(nextPass ? [] : m.saved?.pass?.processedOpeningIds ?? []);
    const atLimit = new Set(m.version === AI_STRUCTURE_PRICED_VERSION ? coverage.perOpening.filter(item => item.distinctCount >= MAX_OPENING_VARIANTS).map(item => item.openingId) : []);
    const remainingIds = coverage.openingIds.filter(id => !processed.has(id) && !atLimit.has(id));
    // Completion measures which openings were requested, not a forced number of
    // new videos. An opening can legitimately have no further suitable variant.
    return { ...coverage, targetVariants: m.version === AI_STRUCTURE_PRICED_VERSION ? MAX_OPENING_VARIANTS : null, covered: coverage.total - remainingIds.length, remainingIds,
      remainingVariants: remainingIds.length, processedOpeningIds: coverage.openingIds.filter(id => processed.has(id)),
      perOpening: coverage.perOpening.map(item => ({ ...item, remaining: remainingIds.includes(item.openingId) ? 1 : 0 })) };
  }
  const orderCoverage = m => isVariants(m) ? variantCoverage(m)
    : m.version === AI_STRUCTURE_ORDER_VERSION ? getAiOrderCoverage(m.input, previous(m.saved)) : undefined;
  const finished = m => isOrdered(m) ? orderCoverage(m).remainingIds.length === 0 : m.saved?.rounds.at(-1)?.result?.modelComplete === true;
  const requestCoverage = m => isVariants(m) && finished(m) ? variantCoverage(m, true) : orderCoverage(m);
  const initializeSaved = m => m.saved ??= { version: m.version, key: m.key, sourceId: m.input.source.id,
    ...(isVariants(m) && m.seed ? { seed: m.seed } : {}), rounds: [] };
  function markProcessed(m, openingIds) {
    initializeSaved(m);
    m.saved.pass ??= { number: 1, openingIds: m.inspected.openingIds, processedOpeningIds: [] };
    m.saved.pass.processedOpeningIds = [...new Set([...m.saved.pass.processedOpeningIds, ...openingIds])];
  }
  function variantBudget(m, coverage, model) {
    if (m.version === AI_STRUCTURE_PRICED_VERSION) {
      // Three routes plus a complete price audit increase output per opening.
      // Bound the first batch; all groups remain inside the approved call budget.
      const batches = [];
      for (let index = 0; index < coverage.remainingIds.length; index += OPENING_BATCH_SIZE) batches.push({ openingIds: coverage.remainingIds.slice(index, index + OPENING_BATCH_SIZE) });
      return { batches, maxTargetVariantsPerRequest: OPENING_BATCH_SIZE * MAX_OPENING_VARIANTS, basis: 'up-to-three-per-opening', observedTokensPerOpening: null };
    }
    if (isCurated(m)) return { batches: coverage.remainingIds.length ? [{ openingIds: coverage.remainingIds }] : [],
      maxTargetVariantsPerRequest: coverage.remainingIds.length, basis: 'selected-openings', observedTokensPerOpening: null };
    const samples = [...(m.seed?.usageSamples ?? []), ...(m.saved?.rounds ?? [])
      .filter(round => round.receipt?.usage?.output_tokens > 0 && round.openingIds?.length)
      .map(round => ({ model: round.model, outputTokens: round.receipt.usage.output_tokens, openings: round.openingIds.length }))]
      .filter(sample => sample.model?.model === model?.model && sample.model?.provider === model?.provider
        && sample.model?.reasoningEffort === model?.reasoningEffort);
    const maxOutputTokens = Number.isSafeInteger(model?.maxOutputTokens) ? model.maxOutputTokens : 32768;
    // This is an observable output-budget estimate, not a quality guarantee.
    // Keep one observed opening's allowance in reserve; variants per opening
    // are unrestricted and observed cost includes the provider's reasoning.
    const perPlan = samples.length ? Math.ceil(Math.max(...samples.map(sample => sample.outputTokens / sample.openings))) : null;
    const minimumGroup = Math.max(1, ...coverage.perOpening.map(item => item.remaining));
    const maxTargetVariantsPerRequest = perPlan ? Math.max(minimumGroup, Math.floor(maxOutputTokens / perPlan) - 1) : minimumGroup;
    const planned = planAiVariantBatches(coverage, { maxTargetVariantsPerRequest });
    return { ...planned, maxTargetVariantsPerRequest, basis: perPlan ? 'observed-output' : 'first-opening', observedTokensPerOpening: perPlan };
  }
  function validateRound(m, response, request) {
    const options = isVariants(m) ? JSON.parse(request.input) : {};
    return validateAiStructureResponse(m.input, response, { expectedVersion: m.version,
      openingIds: options.openingIds, previous: options.previous, targetVariants: options.targetVariants, targetCounts: options.targetCounts });
  }
  const roundIdentity = (m, request, passNumber, correction = false) => ({ kind: m.version, key: m.key, requestHash: sharedHash(request),
    ...(isVariants(m) ? { passNumber, correction } : {}) });
  const publicRound = (version, round, seed, key) => ({ schema: version, requestHash: sharedHash(round.request), response: round.response,
    ...(version === AI_STRUCTURE_VARIANTS_VERSION && seed ? { compositionKey: key, seed } : {}),
    ...(round.receipt?.usage?.output_tokens > 0 ? { budgetSample: {
      model: { ...publicModel(round.model), reasoningEffort: round.model?.reasoningEffort },
      outputTokens: round.receipt.usage.output_tokens,
    } } : {}) });
  async function nextRound(m, options) {
    if (m.prepared && !options) return m.prepared;
    const coverage = isVariants(m) ? requestCoverage(m) : orderCoverage(m);
    const budget = isVariants(m) ? variantBudget(m, coverage, await identity(m)) : undefined;
    const openingIds = options?.openingIds ?? (isVariants(m) ? budget.batches[0]?.openingIds : coverage?.remainingIds.slice(0, OPENING_BATCH_SIZE));
    const feedback = options?.feedback ?? (m.version === AI_STRUCTURE_ORDER_VERSION ? m.saved?.rounds.at(-1)?.result?.issues ?? [] : []);
    const request = createAiStructureRequest(m.input, { previous: previousFor(m), version: m.version, openingIds, feedback });
    const passNumber = isVariants(m) ? options?.passNumber ?? (m.saved?.pass ? (m.saved.pass.number ?? 1) + (finished(m) ? 1 : 0) : 1) : undefined;
    const correction = isVariants(m) && options?.correction === true;
    let descriptor;
    if (m.input.visibility === 'shared') {
      if (!sharedAnalysis) throw new HttpError(409, '共享协调服务未接通，未发起本机付费请求');
      await sharedAnalysis.validateSource(m.root, m.input.source, m.input.baselineDescriptor);
      descriptor = await sharedAnalysis.prepareExisting(m.root, m.input.source, { action: 'structure-plans', scope: { startMs: m.input.scope.startMs, endMs: m.input.scope.endMs }, count: 0,
        provenance: { kind: 'structure-plans-v1', inputRevision: m.input.analysisVersion }, payload: roundIdentity(m, request, passNumber, correction) });
    }
    return { request, descriptor, ...(isVariants(m) ? { passNumber, correction } : {}) };
  }
  function view(m, status, extra = {}) {
    const rounds = m.saved?.rounds ?? [], last = rounds.at(-1);
    const plans = [...new Map(plansFor(m).map(p => [p.id, p])).values()];
    const savedVersions = [...new Map([...(m.versions ?? []).filter(item => item.saved || item.readError || item.publicExists), ...(m.saved ? [m] : [])].map(item => [item.version, { version: item.version, taskKey: item.key }])).values()];
    const coverage = m.inspected?.ready ? orderCoverage(m) : undefined;
    const localOpeningId = id => m.input.localCandidateIds?.[id] ?? id;
    const displayCoverage = isVariants(m) && coverage ? { ...coverage,
      openingIds: coverage.openingIds.map(localOpeningId), remainingIds: coverage.remainingIds.map(localOpeningId),
      processedOpeningIds: coverage.processedOpeningIds.map(localOpeningId),
      targetCounts: Object.fromEntries(Object.entries(coverage.targetCounts).map(([id, count]) => [localOpeningId(id), count])),
      perOpening: coverage.perOpening.map(item => ({ ...item, openingId: localOpeningId(item.openingId) })),
      excluded: localize(coverage.excluded.map(item => {
        const candidate = m.input.engineInput.candidates.find(candidate => candidate.id === item.id);
        return { ...item, ...(candidate ? { startMs: candidate.startMs, endMs: candidate.endMs, text: candidate.text } : {}) };
      }), m.input) } : coverage;
    return { status, taskKey: m.key, version: m.version, currentRulesVersion: AI_STRUCTURE_VERSION, savedVersions, ...(m.blockedBy ? { blockedBy: m.blockedBy } : {}), generationMethod: 'ai', plans: localize(plans, m.input), complete: status === 'complete' && (!coverage || coverage.remainingIds.length === 0), allValidCombinationsEnumerated: false,
      ...(coverage ? { coverage: displayCoverage, usablePlanIds: [...new Set([...(m.seed?.plans ?? []).map(plan => plan.id), ...rounds.filter(round => round.status === 'complete').flatMap(round => (round.result?.plans ?? []).map(plan => plan.id))])] } : {}),
      materialComplete: m.inspected?.materialComplete === true, context: { ...m.input.context, visibility: m.input.visibility },
      issues: [...m.issues, ...rounds.flatMap(r => r.result?.issues ?? []), ...(last?.error ? [errorIssue(last.error)] : []), ...(m.saved?.operationError ? [errorIssue(m.saved.operationError)] : [])],
      canContinue: status === 'complete' && (m.version === AI_STRUCTURE_PRICED_VERSION ? coverage?.perOpening.some(item => item.distinctCount < MAX_OPENING_VARIANTS) : isVariants(m) ? (coverage?.total ?? 0) > 0 : coverage ? coverage.remainingIds.length > 0 : last?.result?.modelComplete === false),
      recoverable: status === 'failed' && !!(last?.response || last?.receipt?.status === 'completed'),
      requestCount: rounds.filter(r => r.submitted).length, mediaReview: m.input.mediaReview, mediaReviewOrigin: m.input.mediaReviewOrigin,
      visualReview: m.input.visualReview, visualReviewOrigin: m.input.visualReviewOrigin, visualReviewStale: m.input.visualReviewStale, ...extra };
  }
  async function publicResult(m, prepared) {
    const snapshot = prepared.snapshot ?? await sharedAnalysis.read(m.root, prepared.descriptor), value = snapshot.payload;
    if (value?.schema !== m.version || value.requestHash !== sharedHash(prepared.request)) throw new HttpError(409, '公共 AI 方案输入不匹配，未重新生成');
    const result = validateRound(m, value.response, prepared.request);
    return { response: value.response, result, budgetSample: value.budgetSample };
  }
  async function imported(m, prepared) {
    if (isVariants(m) && m.saved?.rounds.some(round => round.status === 'complete'
      && round.descriptor?.taskKey === prepared.descriptor.taskKey && sharedHash(round.request) === sharedHash(prepared.request))) return;
    const { response, result, budgetSample } = await publicResult(m, prepared);
    initializeSaved(m);
    if (isVariants(m)) {
      if (!m.saved.pass || m.saved.pass.number < prepared.passNumber) m.saved.pass = { number: prepared.passNumber, openingIds: m.inspected.openingIds, processedOpeningIds: [] };
      if (m.saved.pass.number === prepared.passNumber) markProcessed(m, JSON.parse(prepared.request.input).openingIds);
    }
    const round = { status: 'complete', request: prepared.request, descriptor: prepared.descriptor, response, result,
      ...(budgetSample?.outputTokens > 0 ? { model: budgetSample.model, receipt: { usage: { output_tokens: budgetSample.outputTokens } } } : {}),
      ...(isVariants(m) ? { passNumber: prepared.passNumber, correction: prepared.correction === true, openingIds: JSON.parse(prepared.request.input).openingIds } : {}) };
    m.saved.rounds.splice(prepared.insertAfter === undefined ? m.saved.rounds.length : prepared.insertAfter + 1, 0, round);
    await persist(m.root, m.key, m.saved);
    delete m.prepared;
  }
  async function importPublishedVariants(m) {
    if (!isVariants(m) || m.input.visibility !== 'shared' || !sharedAnalysis?.history || !sharedAnalysis?.historicalArtifact) return false;
    await sharedAnalysis.validateSource(m.root, m.input.source, m.input.baselineDescriptor);
    const known = new Set((m.saved?.rounds ?? []).map(round => round.descriptor?.taskKey));
    const catalog = await sharedAnalysis.history(m.root, m.input.source);
    const available = [];
    for (const item of catalog.results) {
      if (known.has(item.taskKey) || item.catalog?.action !== 'structure-plans'
        || item.catalog.scope?.startMs !== m.input.scope.startMs || item.catalog.scope?.endMs !== m.input.scope.endMs
        || item.catalog.provenance?.inputRevision && item.catalog.provenance.inputRevision !== m.input.analysisVersion) continue;
      try {
        const selected = await sharedAnalysis.historicalArtifact(m.root, m.input.source, item.taskKey, item.result.sha256);
        if (selected.snapshot.payload?.schema === m.version) available.push(selected);
      } catch (error) {
        // A missing older artifact must not hide readable current results.
        // Until its identity can be checked, do not authorize a new paid pass.
        m.publicReadError = `部分公共方案无法读取：${error.message}；已保留可读取的方案，请恢复连接后刷新`;
      }
    }
    if (!m.seed) {
      const sharedSeed = available.find(item => item.snapshot.payload.compositionKey === m.key && item.snapshot.payload.seed)?.snapshot.payload.seed;
      if (sharedSeed?.version === AI_STRUCTURE_ORDER_VERSION && sharedSeed.taskKey === m.versions?.find(item => item.version === AI_STRUCTURE_ORDER_VERSION)?.key) {
        const valid = validateAiStructureOrder(m.input, { schema: AI_STRUCTURE_ORDER_VERSION, plans: sharedSeed.sequences });
        if (valid.plans.length !== sharedSeed.sequences?.length) throw new HttpError(409, '公共方案的旧版基础结果校验未通过');
        // Rebuild clips from the current verified analysis; shared seed data
        // cannot replace their times, source paths or private draft references.
        m.seed = { ...sharedSeed, plans: valid.plans, sequences: valid.sequences };
        if (m.saved) { m.saved.seed = m.seed; await persist(m.root, m.key, m.saved); }
      }
    }
    let changed = false;
    while (available.length) {
      // Replay the published request identities, not this computer's estimated
      // batch size. Older results contain no usage metadata, so match each
      // possible contiguous next group against its saved input hash.
      const choices = [];
      const add = (openingIds, passNumber, correction = false, feedback = [], prior = previousFor(m), insertAfter) => {
        let request;
        try { request = createAiStructureRequest(m.input, { previous: prior, version: m.version, openingIds, feedback }); }
        catch (error) { if (error.code === 'AI_STRUCTURE_INPUT_TOO_LARGE') return false; throw error; }
        choices.push({ request, passNumber, correction, insertAfter, dataHash: sharedHash(roundIdentity(m, request, passNumber, correction)) });
        return true;
      };
      // An older client may already have skipped corrections and imported later
      // groups. Rebuild each correction at its original position, including its
      // then-current history, without resetting a later pass's progress.
      for (const [index, round] of (m.saved?.rounds ?? []).entries()) {
        if (round.status !== 'complete' || round.correction === true) continue;
        const prior = [...(m.seed?.sequences ?? []), ...previous({ rounds: m.saved.rounds.slice(0, index + 1) })];
        const missing = new Set(getAiVariantsCoverage(m.input, prior, { targetVariants: 1 }).remainingIds);
        const targets = (round.openingIds ?? []).filter(id => missing.has(id));
        if (targets.length) add(targets, round.passNumber, true, round.result?.issues ?? [], prior, index);
      }
      const remaining = requestCoverage(m).remainingIds;
      const passNumber = m.saved?.pass ? m.saved.pass.number + (finished(m) ? 1 : 0) : 1;
      for (let size = 1; size <= remaining.length; size++) if (!add(remaining.slice(0, size), passNumber)) break;
      let match;
      for (const choice of choices) {
        const index = available.findIndex(item => item.snapshot.dataHash === choice.dataHash
          && item.snapshot.payload.requestHash === sharedHash(choice.request));
        if (index >= 0) { match = { choice, selected: available.splice(index, 1)[0] }; break; }
      }
      if (!match) break;
      const { choice, selected } = match;
      await imported(m, { ...choice, snapshot: selected.snapshot,
        descriptor: { ...selected.descriptor, result: selected.result, mode: 'reuse' } });
      changed = true;
    }
    return changed;
  }
  async function reuse(m, prepared) {
    const fallback = m.saved?.rounds.length || m.seed?.plans?.length ? 'complete' : 'unavailable';
    try { await imported(m, prepared); return view(m, 'complete'); }
    catch (error) { return view(m, fallback, { issues: [...m.issues, errorIssue(`已有公共方案无法读取或补存：${error.message}；原记录保留，未重新请求模型`)] }); }
  }
  async function confirmation(m, prepared, model = undefined) {
    model ??= await identity(m);
    if (!model || typeof modelClient !== 'function') return { enabled: false, rulesVersion: m.version, message: '请先配置拼结构使用的文字模型；已有分析和草稿保留' };
    const coverage = isVariants(m) ? requestCoverage(m) : orderCoverage(m);
    const variantPlan = isVariants(m) ? variantBudget(m, coverage, model) : null;
    const batchCount = variantPlan ? variantPlan.batches.length : coverage ? Math.ceil(coverage.remainingIds.length / OPENING_BATCH_SIZE) : 1;
    const budget = coverage ? { openingCount: coverage.remainingIds.length, batchCount, requestCount: batchCount * OPENING_BATCH_ATTEMPTS,
      ...(variantPlan ? { existingPlanCount: plansFor(m).length, batchBasis: variantPlan.basis } : {}) } : { requestCount: 1 };
    return { enabled: true, id: sharedHash({ key: m.key, request: prepared.request, model, ...(isVariants(m) ? { passNumber: prepared.passNumber } : {}), ...(coverage ? { budget, openingIds: coverage.remainingIds } : {}) }), rulesVersion: m.version, service: publicModel(model), ...budget,
      candidateCount: m.input.engineInput.candidates.length, transcriptSegments: m.input.engineInput.cues.length,
      continuation: !!(m.saved?.rounds.length || m.seed?.plans?.length), visibility: m.input.visibility };
  }
  async function status(root, request) {
    const m = await material(root, request);
    if (m.blocked) return view(m, 'unavailable');
    if (isOrdered(m) && jobs.has(lockKey(root, request))) return view(m, 'running');
    const last = m.saved?.rounds.at(-1);
    if (m.saved && (!last || last.status === 'complete' && !last.result)) return view(m, 'failed', { issues: [...m.issues, errorIssue('已有方案记录缺少完整请求或结果，状态不明；请恢复或核对原记录，不会重新发送')] });
    if (last && last.status !== 'complete') return view(m, last.status === 'running' && !jobs.has(lockKey(root, request)) || !['running', 'failed', 'publish-pending'].includes(last.status) ? 'failed' : last.status,
      last.status === 'running' && !jobs.has(lockKey(root, request)) ? { issues: [...m.issues, errorIssue(storageErrors.get(lockKey(root, request)) ?? '上次拼结构中断，结果或费用尚不明确；请恢复保存的返回，不会自动重发')] } : {});
    try { await importPublishedVariants(m); }
    catch (error) { return view(m, plansFor(m).length ? 'complete' : 'unavailable', { issues: [...m.issues, errorIssue(`公共方案读取未完成：${error.message}；已有结果保留，未请求模型`)] }); }
    if (last && finished(m) && !isVariants(m)) return view(m, 'complete');
    if (jobs.has(lockKey(root, request))) return view(m, 'busy', { issues: [...m.issues, errorIssue('当前这次讲解已有拼结构请求执行中，请等待已有任务完成，未启动另一个版本')] });
    let prepared;
    try { prepared = await nextRound(m); } catch (e) { return view(m, last || m.seed?.plans?.length ? 'complete' : 'unavailable', { issues: [...m.issues, errorIssue(e.message)] }); }
    if (prepared.descriptor?.mode === 'reuse') return reuse(m, prepared);
    if (m.publicReadError) return view(m, m.saved?.rounds.length || m.seed?.plans?.length ? 'complete' : 'unavailable', { issues: [...m.issues, errorIssue(m.publicReadError)] });
    if (prepared.descriptor && prepared.descriptor.mode !== 'publish') return view(m, last || m.seed?.plans?.length ? 'complete' : 'busy', { issues: [...m.issues, errorIssue('此公共任务已有提交，请等待或恢复已有结果；未重复请求')] });
    return view(m, m.saved?.rounds.length || m.seed?.plans?.length ? 'complete' : 'idle', { confirmation: await confirmation(m, prepared) });
  }
  async function finish(m, round, response) {
    round.response = response; await persist(m.root, m.key, m.saved);
    round.result = validateRound(m, response, round.request);
    if (isVariants(m)) markProcessed(m, JSON.parse(round.request.input).openingIds);
    round.status = m.input.visibility === 'shared' ? 'publish-pending' : 'complete'; delete round.error;
    await persist(m.root, m.key, m.saved);
    if (round.status === 'publish-pending') {
      await sharedAnalysis.complete(m.root, round.descriptor, round.attemptId, publicRound(m.version, round, m.seed, m.key));
      round.status = 'complete'; await persist(m.root, m.key, m.saved);
    }
  }
  async function generateOne(root, request) {
    const m = await material(root, request);
    if (m.blocked) return view(m, 'unavailable');
    if (jobs.has(lockKey(root, request))) return view(m, 'busy', { issues: [...m.issues, errorIssue('当前这次讲解已有拼结构请求执行中，请等待已有任务完成，未启动另一个版本')] });
    const last = m.saved?.rounds.at(-1);
    if (m.saved && (!last || !last.result || last.status !== 'complete' || !isVariants(m) && finished(m) || request.continue !== true)) return status(root, request);
    if (await importPublishedVariants(m)) return status(root, request);
    if (m.publicReadError) throw new HttpError(409, m.publicReadError);
    const prepared = await nextRound(m);
    if (prepared.descriptor?.mode === 'reuse') return reuse(m, prepared);
    if (prepared.descriptor && prepared.descriptor.mode !== 'publish') return view(m, 'busy');
    const model = await identity(m), plan = await confirmation(m, prepared, model);
    if (!plan.enabled || request.confirmed !== true || request.confirmationId !== plan.id) throw new HttpError(409, '请确认本次 AI 拼结构请求；素材、范围或模型可能已变化，未发送');
    if (isVariants(m)) return generateVariants(m, request, model, prepared);
    if (m.version === AI_STRUCTURE_ORDER_VERSION) return generateOpenings(m, request, model, prepared);
    let claim;
    if (prepared.descriptor) claim = await sharedAnalysis.acquire(prepared.descriptor);
    m.saved ??= { version: m.version, key: m.key, sourceId: m.input.source.id, rounds: [] };
    const round = { status: 'running', request: prepared.request, descriptor: prepared.descriptor, attemptId: claim?.attemptId, model, submitted: true };
    m.saved.rounds.push(round); await persist(root, m.key, m.saved);
    const key = lockKey(root, request);
    const job = Promise.resolve().then(async () => {
      try {
        const response = await modelClient({ ...round.request, ...purposeFor(m), expectedIdentity: model,
          onReceipt: async receipt => { round.receipt = receipt; await persist(root, m.key, m.saved); } });
        await finish(m, round, response);
      } catch (e) {
        if (round.status !== 'publish-pending') {
          round.status = 'failed'; round.error = `AI 拼结构未完成：${e.message}；已有分析和原返回保留，不会自动重发`;
          if (round.descriptor) await sharedAnalysis?.fail?.(round.descriptor, round.attemptId).catch(() => {});
        } else round.error = `公共保存未完成：${e.message}；本机 AI 返回已保留，请补存`;
        await persist(root, m.key, m.saved);
      }
    }).catch(error => { storageErrors.set(key, `AI 请求后的记录保存失败：${error.message}；请恢复已保存返回，不会重发模型`); }).finally(() => jobs.delete(key));
    jobs.set(key, job);
    return view(m, 'running');
  }
  // One confirmed operation owns a bounded pass across every uncovered opening.
  // There is no permutation search and no model-provided completion flag.
  async function generateOpenings(m, request, model, initialPrepared) {
    const root = m.root, key = lockKey(root, request);
    const pendingIds = orderCoverage(m).remainingIds;
    const groups = [];
    for (let n = 0; n < pendingIds.length; n += OPENING_BATCH_SIZE) groups.push(pendingIds.slice(n, n + OPENING_BATCH_SIZE));
    m.saved ??= { version: m.version, key: m.key, sourceId: m.input.source.id, rounds: [] };
    // Pin the material and evidence for the entire confirmed pass, not just its first request.
    const baseIdentity = sharedHash(createAiStructureRequest(m.input, { version: m.version, openingIds: pendingIds }));
    // Claim and persist the first round before reporting running. Another user
    // must observe a failed claim rather than a job that never owned the request.
    const firstClaim = initialPrepared.descriptor ? await sharedAnalysis.acquire(initialPrepared.descriptor) : undefined;
    let firstRound = { status: 'running', request: initialPrepared.request, descriptor: initialPrepared.descriptor,
      attemptId: firstClaim?.attemptId, model, submitted: true, openingIds: groups[0] };
    delete m.saved.operationError; storageErrors.delete(key);
    m.saved.rounds.push(firstRound); await persist(root, m.key, m.saved);
    const job = Promise.resolve().then(async () => {
      for (const group of groups) for (let attempt = 0; attempt < OPENING_BATCH_ATTEMPTS; attempt++) {
        const missing = new Set(orderCoverage(m).remainingIds), targets = group.filter(id => missing.has(id));
        if (!targets.length) break;
        let round = firstRound; firstRound = undefined;
        if (!round) {
          const freshInput = await readInput(root, request);
          const fresh = await versionedMaterial(root, freshInput, m.version);
          if (fresh.key !== m.key || sharedHash(createAiStructureRequest(freshInput, { version: m.version, openingIds: pendingIds })) !== baseIdentity) throw new Error('话术或核查记录已变化，已暂停后续批次；已有方案保留');
          if (sharedHash(await identity(m)) !== sharedHash(model)) throw new Error('模型配置已变化，已暂停后续批次；已有方案保留');
          const prepared = await nextRound(m, { openingIds: targets, feedback: m.saved.rounds.at(-1)?.result?.issues ?? [] });
          if (prepared.descriptor?.mode === 'reuse') { await imported(m, prepared); continue; }
          if (prepared.descriptor && prepared.descriptor.mode !== 'publish') throw new Error('本批公共任务已有提交，已暂停；请读取或恢复已有结果');
          const claim = prepared.descriptor ? await sharedAnalysis.acquire(prepared.descriptor) : undefined;
          round = { status: 'running', request: prepared.request, descriptor: prepared.descriptor, attemptId: claim?.attemptId, model, submitted: true, openingIds: targets };
          m.saved.rounds.push(round); await persist(root, m.key, m.saved);
        }
        try {
          const response = await modelClient({ ...round.request, ...purposeFor(m), expectedIdentity: model, onReceipt: async receipt => { round.receipt = receipt; await persist(root, m.key, m.saved); } });
          await finish(m, round, response);
        } catch (error) {
          if (round.status !== 'publish-pending') {
            round.status = 'failed';
            if (round.descriptor) await sharedAnalysis?.fail?.(round.descriptor, round.attemptId).catch(() => {});
          }
          round.error = `本批未完成：${error.message}；已有方案和返回保留，不自动重发`;
          await persist(root, m.key, m.saved);
          return;
        }
      }
    }).catch(async error => {
      m.saved.operationError = error.message; storageErrors.set(key, error.message);
      try { await persist(root, m.key, m.saved); } catch (saveError) { storageErrors.set(key, `${error.message}；停止原因保存失败：${saveError.message}`); }
    }).finally(() => jobs.delete(key));
    jobs.set(key, job);
    return view(m, 'running');
  }
  async function generateVariants(m, request, model, initialPrepared) {
    const root = m.root, key = lockKey(root, request), coverage = requestCoverage(m);
    const groups = variantBudget(m, coverage, model).batches.map(batch => batch.openingIds);
    const requestLimit = groups.length * OPENING_BATCH_ATTEMPTS;
    const pendingIds = coverage.remainingIds;
    const initiallyUncovered = new Set(getAiVariantsCoverage(m.input, previousFor(m), { targetVariants: 1 }).remainingIds);
    const baseIdentity = sharedHash(createAiStructureRequest(m.input, { version: m.version, openingIds: pendingIds }));
    // Claim before returning a running task, and persist the exact first request
    // before contacting the model. The original v4 record is never modified.
    const firstClaim = initialPrepared.descriptor ? await sharedAnalysis.acquire(initialPrepared.descriptor) : undefined;
    const restartPass = !m.saved?.pass || finished(m);
    initializeSaved(m);
    if (restartPass) m.saved.pass = { number: initialPrepared.passNumber, openingIds: coverage.openingIds, processedOpeningIds: [] };
    let firstRound = { status: 'running', request: initialPrepared.request, descriptor: initialPrepared.descriptor,
      attemptId: firstClaim?.attemptId, model, submitted: true, openingIds: groups[0], passNumber: initialPrepared.passNumber };
    delete m.saved.operationError; storageErrors.delete(key);
    m.saved.rounds.push(firstRound); await persist(root, m.key, m.saved);
    const job = Promise.resolve().then(async () => {
      let requestCount = 0;
      while (orderCoverage(m).remainingIds.length) {
        // Re-estimate from the latest actual usage after each completed group.
        // Never exceed the maximum request count the user already confirmed.
        const group = firstRound?.openingIds ?? variantBudget(m, orderCoverage(m), model).batches[0]?.openingIds;
        if (!group?.length) break;
        for (let attempt = 0; attempt < OPENING_BATCH_ATTEMPTS; attempt++) {
          // A successful pass may add zero, one or many variants for a seeded
          // opening. Only a never-covered opening receives one coverage retry.
          const uncovered = new Set(getAiVariantsCoverage(m.input, previousFor(m), { targetVariants: 1 }).remainingIds);
          const targets = attempt === 0 ? group : group.filter(id => initiallyUncovered.has(id) && uncovered.has(id));
          if (!targets.length) break;
          if (requestCount >= requestLimit) throw new Error('本次确认的请求次数已用完，已保存返回；剩余开头可继续补充');
          let round = firstRound; firstRound = undefined;
          if (!round) {
            const freshInput = await readInput(root, request), fresh = await versionedMaterial(root, freshInput, m.version);
            if (fresh.key !== m.key || sharedHash(createAiStructureRequest(freshInput, { version: m.version, openingIds: pendingIds })) !== baseIdentity) throw new Error('话术或核查记录已变化，已暂停后续批次；已有方案保留');
            if (sharedHash(await identity(m)) !== sharedHash(model)) throw new Error('模型配置已变化，已暂停后续批次；已有方案保留');
            const prepared = await nextRound(m, { openingIds: targets, passNumber: initialPrepared.passNumber, correction: attempt > 0,
              feedback: attempt ? m.saved.rounds.at(-1)?.result?.issues ?? [] : [] });
            if (prepared.descriptor?.mode === 'reuse') { await imported(m, prepared); continue; }
            if (prepared.descriptor && prepared.descriptor.mode !== 'publish') throw new Error('本批公共任务已有提交，已暂停；请读取或恢复已有结果');
            const claim = prepared.descriptor ? await sharedAnalysis.acquire(prepared.descriptor) : undefined;
            round = { status: 'running', request: prepared.request, descriptor: prepared.descriptor,
              attemptId: claim?.attemptId, model, submitted: true, openingIds: targets, passNumber: initialPrepared.passNumber, correction: attempt > 0 };
            m.saved.rounds.push(round); await persist(root, m.key, m.saved);
          }
          try {
            requestCount++;
            const response = await modelClient({ ...round.request, ...purposeFor(m), expectedIdentity: model,
              onReceipt: async receipt => { round.receipt = receipt; await persist(root, m.key, m.saved); } });
            await finish(m, round, response);
          } catch (error) {
            if (round.status !== 'publish-pending') {
              round.status = 'failed';
              if (round.descriptor) await sharedAnalysis?.fail?.(round.descriptor, round.attemptId).catch(() => {});
            }
            round.error = `本批未完成：${error.message}；已有方案和返回保留，不自动重发`;
            await persist(root, m.key, m.saved); return;
          }
        }
      }
    }).catch(async error => {
      m.saved.operationError = error.message; storageErrors.set(key, error.message);
      try { await persist(root, m.key, m.saved); } catch (saveError) { storageErrors.set(key, `${error.message}；停止原因保存失败：${saveError.message}`); }
    }).finally(() => jobs.delete(key));
    jobs.set(key, job);
    return view(m, 'running');
  }
  function generate(root, request) {
    const key = lockKey(root, request);
    const selector = JSON.stringify([request.rulesVersion ?? null, request.taskKey ?? null, request.continue === true]);
    const starting = starts.get(key);
    if (starting) return starting.selector === selector ? starting.pending : starting.pending.then(() => generate(root, request), () => generate(root, request));
    const pending = generateOne(root, request).finally(() => starts.delete(key)); starts.set(key, { selector, pending }); return pending;
  }
  async function recover(root, request) {
    const m = await material(root, request), round = m.saved?.rounds.at(-1);
    if (!round || m.blocked || jobs.has(lockKey(root, request)) || round.status === 'complete') return status(root, request);
    try {
      const response = round.response ?? recoverDeepSeekTextResponse(round.receipt, round.request);
      if (response === undefined) return view(m, 'failed', { issues: [...m.issues, errorIssue('没有完整且匹配输入的已保存返回，请核查请求记录；不会重发模型')] });
      await finish(m, round, response);
      storageErrors.delete(lockKey(root, request));
    } catch (e) { round.error = e.message; await persist(root, m.key, m.saved); }
    return view(m, round.status === 'running' ? 'failed' : round.status);
  }
  async function publish(root, request) {
    if (request.confirmed !== true || !/^[a-f0-9]{64}$/.test(request.taskKey ?? '')) throw new HttpError(400, '请确认补存已有 AI 方案');
    const saved = await read(join(directory(root), `${request.taskKey}.json`)), round = saved?.rounds.at(-1);
    if (saved?.sourceId !== request.sourceId || !AI_STRUCTURE_VERSIONS.includes(saved?.version) || round?.status !== 'publish-pending' || !round.descriptor) throw new HttpError(409, '没有可补保存的公共 AI 方案');
    await sharedAnalysis.complete(root, round.descriptor, round.attemptId, publicRound(saved.version, round, saved.seed, saved.key));
    round.status = 'complete'; delete round.error; await persist(root, saved.key, saved);
    return { status: 'complete', taskKey: saved.key, requestCount: 0 };
  }
  return { status, generate, recover, publish, wait: async () => { await Promise.all([...starts.values()].map(item => item.pending)); await Promise.all([...jobs.values()]); } };
}
