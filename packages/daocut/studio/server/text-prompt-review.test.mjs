import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as structure from './text-structure.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';

const legacy = structure.LEGACY_TEXT_STRUCTURE_PROMPT ?? structure.TEXT_STRUCTURE_PROMPT;
const previous = structure.PREVIOUS_TEXT_STRUCTURE_PROMPT;
const digest = text => createHash('sha256').update(text).digest('hex');

test('the text-only prompt has one machine output contract while preserving the stored legacy rules', () => {
  assert.equal(digest(legacy), 'd20a32f2ea906f2f8a5d986e1d2c53db71ba68b44dbde127465823814cd95973');
  assert.ok(previous.length < 2000, 'freeze the prior short prompt for exact recovery');
  assert.equal(previous.split('"schema":"complete-speech-v1"').length, 2);
  assert.equal(digest(previous), '7b71c20a1d41de0d08a1c411a8fd16538d45b7348dc48def0f598add58b3cc5f');
});

test('shorter wording retains paid window boundaries but reports the actual smaller request bytes', () => {
  const cues = Array.from({ length: 210 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: '模拟一次完整商品讲解内容。'.repeat(9) }));
  const args = { sourceId: 's', productId: 'p', intervalId: 'i', cues, rangeStartMs: 0, rangeEndMs: 210000 };
  const oldWindows = structure.textStructureWindows({ ...args, prompt: legacy });
  const windows = structure.textStructureWindows({ ...args, prompt: previous });
  assert.ok(windows.length > 1);
  assert.deepEqual(windows.map(w => [w.firstCue, w.lastCue]), oldWindows.map(w => [w.firstCue, w.lastCue]));
  for (const window of windows) {
    const actual = Buffer.byteLength(previous) + Buffer.byteLength(JSON.stringify({ ...args, cues: window.cues }));
    assert.equal(window.bytes, actual);
    assert.ok(window.bytes < oldWindows[window.index].bytes);
  }
});

test('saved legacy complete response recovers after wording cleanup, but a different cue or custom prompt cannot use it', async () => {
  let receipt;
  const client = structure.createDeepSeekTextClient({ getConfig: async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic' }), fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"schema":"complete-speech-v1","candidates":[],"issues":[]}' }] }] }) }) });
  await client({ system: legacy, input: 'synthetic exact cues', onReceipt: value => { receipt = value; } });
  assert.equal(structure.recoverDeepSeekTextResponse(receipt, { system: previous, input: 'synthetic exact cues' }).schema, 'complete-speech-v1');
  assert.throws(() => structure.recoverDeepSeekTextResponse(receipt, { system: previous, input: 'changed cue' }), { code: 'MODEL_INPUT_CHANGED' });
  assert.throws(() => structure.recoverDeepSeekTextResponse(receipt, { system: structure.TEXT_STRUCTURE_PROMPT, input: 'synthetic exact cues' }), { code: 'MODEL_INPUT_CHANGED' });
});

test('wording cleanup keeps the existing shared task identity, while custom rule changes do not', async () => {
  const options = { modelIdentity: { provider: 'mock', model: 'synthetic' } };
  const oldContract = await createLiveAnalysis({ ...options, structurePrompt: legacy }).sharedContract();
  assert.deepEqual(await createLiveAnalysis({ ...options, structurePrompt: previous }).sharedContract(), oldContract);
  assert.notDeepEqual(await createLiveAnalysis(options).sharedContract(), oldContract);
  assert.notDeepEqual(await createLiveAnalysis({ ...options, structurePrompt: structure.TEXT_STRUCTURE_PROMPT + '\nDifferent rule' }).sharedContract(), oldContract);
});
