import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTextStructure, combineTextStructureWindows, PREVIOUS_CURATED_TEXT_STRUCTURE_PROMPT } from './text-structure.mjs';
import { createAiStructureRequest, validateAiStructureResponse } from './ai-structure.mjs';
const AI_STRUCTURE_VERSION = 'ai-structure-plans-v6';
import { needsProductScopeConfirmation } from './structure-plans.mjs';
import { combineDiscoveryWindows } from './product-discovery.mjs';

const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 78000 };
const cues = [
  [0, 13000, '我们这款是软糖，一瓶三十颗。'],
  [13000, 19500, '我以前买的那个咬不动。'],
  [19500, 26000, '我们这个软，不粘牙。'],
  [26000, 39000, '我们这款开盖就能吃，方便携带。'],
  [39000, 52000, '别人这个销量第一，卖了二百万单。'],
  [52000, 65000, '还有这个，你看这个。'],
  [65000, 78000, '想要我们这款的现在去一号链接拍。'],
].map(([startMs, endMs, text]) => ({ startMs, endMs, text }));
const candidate = (firstCue, lastCue, tags, kind, opening) => ({ firstCue, lastCue, tags,
  subject: { kind, evidence: kind === 'unknown' ? [] : [firstCue, lastCue] },
  ...(opening ? { opening: { group: opening, followup: '接本品购买理由' } } : {}) });
const rows = () => [
  candidate(0, 0, ['产品介绍'], 'self', '规格介绍'),
  candidate(1, 2, ['痛点', '卖点'], 'comparison', '口感对比'),
  candidate(3, 3, ['卖点'], 'self'),
  candidate(4, 4, ['信任背书', '钩子'], 'other', '竞品销量'),
  candidate(5, 5, ['钩子'], 'unknown', '未明确指代'),
  candidate(6, 6, ['行动指令'], 'self'),
];
const analyze = (candidates = rows(), extra = {}) => analyzeTextStructure({ ...scope, rangeStartMs: 0, rangeEndMs: 78000, cues,
  client: async () => ({ schema: 'complete-speech-v1', candidates, issues: [] }), ...extra });
const material = output => ({ visibility: 'local', scope, context: scope, source: { id: 's', assetPath: 'assets/test.mp4' },
  engineInput: { scope, sourceIdentity: 'test', cues, candidates: output.candidates }, issues: [] });

test('intro needs no visual evidence; full comparison is retained and competitor-only/unknown speech cannot compose', async () => {
  const output = await analyze(), input = material(output), ids = output.candidates.map(c => c.id);
  assert.deepEqual(output.candidates[0].details.composition.roles, ['intro']);
  assert.equal(output.candidates[1].text, cues[1].text + cues[2].text);
  const body = JSON.parse(createAiStructureRequest(input).input);
  assert.equal(body.units.find(c => c.id === ids[1]).subject, 'comparison');
  assert.ok(!body.units.some(c => [ids[3], ids[4]].includes(c.id)));
  assert.ok(!body.openingIds.some(id => [ids[3], ids[4]].includes(id)));
  const good = validateAiStructureResponse(input, { schema: AI_STRUCTURE_VERSION, plans: [[ids[0], ids[2], ids[5]], [ids[1], ids[2], ids[5]]] });
  assert.equal(good.plans.length, 2);
  const bad = validateAiStructureResponse(input, { schema: AI_STRUCTURE_VERSION, plans: [[ids[3], ids[2], ids[5]], [ids[4], ids[2], ids[5]]] });
  assert.equal(bad.plans.length, 0);
});

test('missing current attribution stays pending; saved old prompt remains readable without invented attribution', async () => {
  const data = rows(); delete data[0].subject;
  assert.equal((await analyze(data)).candidates[0].details.composition.status, 'pending');
  const previous = await analyze(data, { prompt: PREVIOUS_CURATED_TEXT_STRUCTURE_PROMPT });
  assert.equal(previous.candidates[0].details.composition.subject, undefined);
  assert.equal(previous.candidates[0].details.composition.status, 'confirmed');
});

test('subject evidence must lie within the complete quote; contradictory window attribution is not silently accepted', async () => {
  const data = rows(); data[0].subject.evidence = [cues.length];
  await assert.rejects(analyze(data), /归属/);
  const a = await analyze(), changed = rows(); changed[2].subject.kind = 'other';
  const b = await analyze(changed);
  const merged = combineTextStructureWindows({ ...scope, cues, outputs: [a, b] });
  assert.equal(merged.candidates[2].details.composition.status, 'pending');
});

test('uncertain product identity does not block an assigned legacy lecture; explicitly uncertain scopes remain blocked', () => {
  assert.equal(needsProductScopeConfirmation({ identityUncertain: true, nameUncertain: true }, { scopeStatus: 'confirmed' }), false);
  assert.equal(needsProductScopeConfirmation({ identityUncertain: false }, { scopeStatus: 'uncertain' }), true);
  assert.equal(needsProductScopeConfirmation({ identityUncertain: true }, { id: 'legacy-lecture', startMs: 27360, endMs: 370590, origin: 'ai-discovery' }), false);
  assert.equal(needsProductScopeConfirmation({ identityUncertain: true }, { scopeStatus: 'uncertain' }), true);
  assert.equal(needsProductScopeConfirmation({ identityUncertain: true }, null), true);
  assert.equal(needsProductScopeConfirmation(null, { scopeStatus: 'confirmed' }), true);
});

test('discovery preserves contextual scope evidence while separating name uncertainty; conflicting scopes remain blocked', () => {
  const product = { key: 'p', name: '软糖', variant: '', aliases: [], evidence: [0, 3, 6], nameUncertain: true, identityUncertain: true };
  const range = { key: 'p', firstCue: 0, lastCue: 6, kind: 'lecture', scopeStatus: 'confirmed', reason: '介绍、比较后的我们、成交指令均指向同一主售商品', evidence: [0, 3, 6] };
  const output = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 78000, cues,
    windows: [{ firstCue: 0, lastCue: 6, coreFirst: 0, coreLast: 6 }], results: [{ products: [product], ranges: [range], issues: [] }] });
  assert.equal(output.products.length, 1);
  assert.equal(output.products[0].nameUncertain, true);
  assert.equal(output.intervals[0].scopeStatus, 'confirmed');
  assert.deepEqual(output.intervals[0].evidence.map(e => e.cue), [0, 3, 6]);
});
