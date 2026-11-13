import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ai from './ai-structure.mjs';
import * as text from './text-structure.mjs';
import { DISCOVERY_PROMPT } from './product-discovery.mjs';
import { localize } from './structure-plans.mjs';
import { COMPOSE_STRUCTURE_PROMPT } from './approved-prompts.mjs';

const approved = async name => (await readFile(new URL(`../../../../docs/prompts-review-20261111/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
const curated = async name => (await readFile(new URL(`../../../../docs/prompts-review-20261112/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
const required = async name => (await readFile(new URL(`../../../../docs/prompts-review-20261113/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
test('all three runtime prompts preserve the complete reviewed judgment requirements verbatim', async () => {
  assert.equal(DISCOVERY_PROMPT, await approved('01-discover-products.txt'));
  assert.equal(text.PREVIOUS_SENTENCE_TEXT_STRUCTURE_PROMPT, await approved('02-analyze-speech.txt'));
  assert.equal(text.PREVIOUS_ATTRIBUTED_TEXT_STRUCTURE_PROMPT, await curated('02-analyze-speech-curated.txt'));
  assert.equal(text.TEXT_STRUCTURE_PROMPT, await required('02-analyze-speech-curated.txt'));
  assert.equal(COMPOSE_STRUCTURE_PROMPT, await approved('03-compose-structure.txt'));
  assert.equal(ai.aiStructurePrompt('ai-structure-plans-v3'), COMPOSE_STRUCTURE_PROMPT);
  assert.equal(ai.aiStructurePrompt('ai-structure-plans-v4'), await approved('03-compose-structure-v4.txt'));
  assert.equal(ai.aiStructurePrompt('ai-structure-plans-v5'), await approved('03-compose-structure-v5.txt'));
  assert.equal(ai.aiStructurePrompt('ai-structure-plans-v6'), await curated('03-compose-structure-v6.txt'));
  assert.equal(ai.aiStructurePrompt('ai-structure-plans-v7'), await required('03-compose-structure-v7.txt'));
  assert.equal(ai.AI_STRUCTURE_PROMPT, await required('03-compose-structure-v8.txt'));
  assert.equal(text.PREVIOUS_CONTEXT_TEXT_STRUCTURE_PROMPT, await required('02-analyze-speech-curated-v3.txt'));
  assert.notEqual(text.textStructureCachePrompt(text.TEXT_STRUCTURE_PROMPT), text.textStructureCachePrompt(text.PREVIOUS_TEXT_STRUCTURE_PROMPT));
});

const input = { visibility: 'local', scope: { startMs: 0, endMs: 60000 }, engineInput: {
  candidates: [{ id: 'mother', cueRange: [120, 122], startMs: 0, endMs: 26000, text: '模拟完整原话', tags: ['卖点', '行动指令'] }],
  cues: [{ startMs: 0, endMs: 13000, text: '完整卖点。', cue: 0 }, { startMs: 13000, endMs: 26000, text: '购买指令。' }], cueIndices: [120, 122]
} };
test('historical v3 requests retain child ranges and authoritative original cue indices', () => {
  const previous = [[{ unit: 0, firstCue: 120, lastCue: 120, tags: ['卖点'] }]];
  const request = ai.createAiStructureRequest(input, { previous, version: 'ai-structure-plans-v3' });
  assert.equal(request.system, COMPOSE_STRUCTURE_PROMPT);
  assert.deepEqual(JSON.parse(request.input).transcript.map(c => c.cue), [120, 122]);
  assert.deepEqual(JSON.parse(request.input).previous, previous);
  assert.throws(() => ai.validateAiStructureResponse(input, { schema: 'ai-structure-plans-v1', plans: [], complete: true, issues: [] }, { expectedVersion: ai.AI_STRUCTURE_VERSION }), /格式|版本/);
});
test('historical v4 requests retain whole-speech IDs and their exact previous field', () => {
  const previous = [['mother']], request = ai.createAiStructureRequest(input, { previous, version: 'ai-structure-plans-v4' });
  const body = JSON.parse(request.input);
  assert.equal(request.system, ai.aiStructurePrompt('ai-structure-plans-v4'));
  assert.equal(Object.hasOwn(body, 'transcript'), false);
  assert.deepEqual(body.previous, previous);
  assert.throws(() => ai.validateAiStructureResponse(input, { schema: ai.AI_STRUCTURE_VERSION, plans: previous, complete: true }), /schema|plans|完成/);
});
test('default v6 puts the stable catalog first and first generation contains no old plans', () => {
  const request = ai.createAiStructureRequest(input), body = JSON.parse(request.input);
  assert.equal(ai.AI_STRUCTURE_VERSION, 'ai-structure-plans-v8'); assert.equal(request.system, ai.AI_STRUCTURE_PROMPT);
  assert.ok(Object.keys(body).indexOf('units') < Object.keys(body).indexOf('openingIds'));
  assert.deepEqual(body.transcript.map(cue => cue[0]), [120, 122]); assert.equal(body.targetVariants, undefined); assert.equal(body.targetCounts, undefined);
  assert.equal(body.previous, undefined);
});
test('old saved requests can still be rebuilt explicitly without changing their prompt', () => {
  const request = ai.createAiStructureRequest(input, { version: 'ai-structure-plans-v1', previous: [[0]] });
  assert.equal(request.system, ai.PREVIOUS_AI_STRUCTURE_PROMPT);
  assert.match(request.system, /ai-structure-plans-v1/);
  assert.notEqual(request.system, ai.AI_STRUCTURE_PROMPT);
});

test('current rules prioritize sentence-sized complete material and price-comparison openings without fixing body order', () => {
  assert.match(text.TEXT_STRUCTURE_PROMPT, /一句能独立理解就单独保留/);
  assert.match(text.TEXT_STRUCTURE_PROMPT, /意思完整即停止合并/);
  assert.match(text.TEXT_STRUCTURE_PROMPT, /重点找价格对比/);
  const request = ai.createAiStructureRequest(input, { version: 'ai-structure-plans-v3' });
  assert.match(request.system, /每个完整话术及有效完整子段，都要逐个尝试作开头/);
  assert.match(request.system, /只有购买逼单固定在最后；其余完整片段允许换位置/);
  assert.match(request.system, /重点寻找并优先尝试价格对比钩子/);
  assert.match(request.system, /价格对比属于福利机制，不因作开头就算成产品卖点/);
  assert.doesNotMatch(request.system, /本次不新增任意调换正文阶段|不能违反已确认正文结构/);
  const historical = ai.createAiStructureRequest(input, { version: 'ai-structure-plans-v4' });
  assert.match(historical.system, /openingIds/);
  assert.match(historical.system, /只能整条取用 units/);
  assert.match(historical.system, /只有购买逼单固定最后/);
  assert.match(historical.system, /价格对比属于 offer，不是商品 core 卖点/);
  assert.match(historical.system, /顶层只允许 schema 和 plans/);
  const current = ai.createAiStructureRequest(input);
  assert.match(current.system, /每个指定开头累计最多3条/);
  assert.match(current.system, /previous是已有方案/);
  assert.match(current.system, /只用units已有编号，整条取用/);
});
test('shared child ranges retain their locally mapped parent provenance', () => {
  const output = localize([{ candidateId: 'public', parentCandidateId: 'public', sourceId: 'remote', startMs: 10, endMs: 20 }], {
    context: { sourceId: 'local', productId: 'p', intervalId: 'i' }, localCandidateIds: { public: 'private' }, source: { assetPath: 'assets/synthetic.mp4' }
  });
  assert.equal(output[0].parentCandidateId, 'private');
  assert.equal(output[0].candidateId, 'private');
  assert.equal(output[0].assetPath, 'assets/synthetic.mp4');
});
