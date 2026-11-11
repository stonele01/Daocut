import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ai from './ai-structure.mjs';
import * as text from './text-structure.mjs';
import { DISCOVERY_PROMPT } from './product-discovery.mjs';
import { localize } from './structure-plans.mjs';

const approved = async name => (await readFile(new URL(`../../../../docs/prompts-review-20261111/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
test('all three runtime prompts preserve the complete reviewed judgment requirements verbatim', async () => {
  assert.equal(DISCOVERY_PROMPT, await approved('01-discover-products.txt'));
  assert.equal(text.TEXT_STRUCTURE_PROMPT, await approved('02-analyze-speech.txt'));
  assert.equal(ai.AI_STRUCTURE_PROMPT, await approved('03-compose-structure.txt'));
  assert.notEqual(text.textStructureCachePrompt(text.TEXT_STRUCTURE_PROMPT), text.textStructureCachePrompt(text.PREVIOUS_TEXT_STRUCTURE_PROMPT));
});

const input = { visibility: 'local', scope: { startMs: 0, endMs: 60000 }, engineInput: {
  candidates: [{ id: 'mother', cueRange: [120, 122], startMs: 0, endMs: 26000, text: '模拟完整原话', tags: ['卖点', '行动指令'] }],
  cues: [{ startMs: 0, endMs: 13000, text: '完整卖点。', cue: 0 }, { startMs: 13000, endMs: 26000, text: '购买指令。' }], cueIndices: [120, 122]
} };
test('new requests use the approved child range schema and authoritative original cue indices', () => {
  const previous = [[{ unit: 0, firstCue: 120, lastCue: 120, tags: ['卖点'] }]];
  const request = ai.createAiStructureRequest(input, { previous });
  assert.equal(ai.AI_STRUCTURE_VERSION, 'ai-structure-plans-v2');
  assert.equal(request.system, ai.AI_STRUCTURE_PROMPT);
  assert.deepEqual(JSON.parse(request.input).transcript.map(c => c.cue), [120, 122]);
  assert.deepEqual(JSON.parse(request.input).previous, previous);
  assert.throws(() => ai.validateAiStructureResponse(input, { schema: 'ai-structure-plans-v1', plans: [], complete: true, issues: [] }, { expectedVersion: ai.AI_STRUCTURE_VERSION }), /格式|版本/);
});
test('old saved requests can still be rebuilt explicitly without changing their prompt', () => {
  const request = ai.createAiStructureRequest(input, { version: 'ai-structure-plans-v1', previous: [[0]] });
  assert.equal(request.system, ai.PREVIOUS_AI_STRUCTURE_PROMPT);
  assert.match(request.system, /ai-structure-plans-v1/);
  assert.notEqual(request.system, ai.AI_STRUCTURE_PROMPT);
});
test('shared child ranges retain their locally mapped parent provenance', () => {
  const output = localize([{ candidateId: 'public', parentCandidateId: 'public', sourceId: 'remote', startMs: 10, endMs: 20 }], {
    context: { sourceId: 'local', productId: 'p', intervalId: 'i' }, localCandidateIds: { public: 'private' }, source: { assetPath: 'assets/synthetic.mp4' }
  });
  assert.equal(output[0].parentCandidateId, 'private');
  assert.equal(output[0].candidateId, 'private');
  assert.equal(output[0].assetPath, 'assets/synthetic.mp4');
});
