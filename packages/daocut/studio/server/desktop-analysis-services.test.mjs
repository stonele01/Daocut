import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createDesktopAnalysisServices } from './desktop-analysis-services.mjs';

test('normal desktop wires existing local media tools without inspecting files or sending model requests on construction', async () => {
  let requests = 0, checks = 0;
  const bridge = async () => { requests++; throw Error('no model configuration should be read'); };
  const normal = createDesktopAnalysisServices({ textBridge: bridge });
  assert.equal(typeof normal.liveAnalysis.mediaReview, 'function');
  assert.equal(typeof normal.liveAnalysis.visualReview?.identity, 'function');
  assert.equal(typeof normal.liveAnalysis.visualReview?.review, 'function');
  const fake = async (...args) => { checks++; return { args }; };
  const injected = createDesktopAnalysisServices({ textBridge: bridge, mediaReview: fake });
  assert.equal(injected.liveAnalysis.mediaReview, fake);
  assert.equal(requests, 0); assert.equal(checks, 0);
});

test('desktop image adapter reads existing chat image model without executing a model request', async () => {
  const requests = [];
  const model = { id: 'chat', name: '模拟看图模型', api: 'openai-responses', baseUrl: 'https://example.invalid', model: 'mock', levels: ['auto'], effort: 'auto' };
  const service = createDesktopAnalysisServices({ textBridge: async request => {
    requests.push(request.operation); assert.equal(request.operation, 'public-visual-config'); return model;
  } });
  assert.deepEqual(await service.liveAnalysis.visualReview.identity(), model);
  assert.deepEqual(requests, ['public-visual-config']);
});

test('desktop adapters inspect settings without network or chmod and honor the provider choice and disconnect state', async t => {
  const base = resolve('../../.tmp/desktop-live-services-20261104/desktop'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'providers-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'providers.json'); let executions = 0;
  await writeFile(file, JSON.stringify({ keys: { doubao: 'synthetic-key' }, use: { asr: 'doubao' }, off: [] }));
  const before = await stat(file);
  const options = createDesktopAnalysisServices({ providersFile: () => file, env: {}, textBridge: async message => {
    if (message.operation === 'public-config') return { id: 'm', name: 'Synthetic DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
    executions++; return { value: { candidates: [], issues: [] }, receipt: { requestId: 'mock' } };
  } });
  assert.equal(options.requireAnalysisPlan, true);
  const publicInfo = await options.analysisServices(); assert.equal(publicInfo.transcription.enabled, true); assert.equal(publicInfo.text.enabled, true);
  assert.ok(!JSON.stringify(publicInfo).includes('synthetic-key')); assert.equal(executions, 0);
  assert.equal((await stat(file)).mode, before.mode); assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  await writeFile(file, JSON.stringify({ keys: {}, use: { asr: 'doubao' }, off: ['doubao'] }));
  assert.equal((await options.analysisServices()).transcription.enabled, false);
  await writeFile(file, JSON.stringify({ keys: { doubao: 'synthetic-key' }, use: { asr: 'groq' } }));
  assert.equal((await options.analysisServices()).transcription.enabled, false);
  let receipt; const output = await options.liveAnalysis.modelClient({ system: 's', input: 't', onReceipt: value => { receipt = value; } });
  assert.deepEqual(output.candidates, []); assert.equal(receipt.requestId, 'mock'); assert.equal(executions, 1);
  assert.deepEqual(await options.liveAnalysis.modelClient.getCacheIdentity(), await options.productDiscovery.modelClient.getCacheIdentity());
});

test('normal desktop transcription uses confirmed provider identity and reuses the local result', async t => {
  const base = resolve('../../.tmp/desktop-live-services-20261104/desktop'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'transcription-')); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = join(root, 'providers.json');
  await writeFile(settings, JSON.stringify({ keys: { doubao: 'synthetic-key' }, use: { asr: 'doubao' } }));
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/a.mp4'), 'synthetic');
  await writeFile(join(root, 'assets/b.mp4'), 'synthetic');
  let calls = 0, disableDuringExtract = false;
  const service = createDesktopAnalysisServices({ providersFile: settings, env: {}, textBridge: async () => null,
    readAudio: async () => { if (disableDuringExtract) await writeFile(settings, JSON.stringify({ use: { asr: 'groq' } })); return Buffer.from('synthetic'); },
    runProvider: async () => { calls++; return { index: [{ text: '合成字幕', cues: [{ text: '合成字幕', startMs: 0, endMs: 1000 }], words: [{ token: '合成字幕', start: 0, end: 1 }] }] }; },
  });
  const info = (await service.analysisServices()).transcription;
  const expectedService = { provider: info.provider, model: info.model, endpoint: info.endpoint };
  const source = { id: 'a', assetPath: 'assets/a.mp4', durationMs: 2000 };
  const first = await service.liveAnalysis.transcribe(root, source, { expectedService });
  assert.equal(first.cues.length, 1); assert.equal(calls, 1);
  assert.equal((await service.liveAnalysis.transcribe(root, source, { expectedService })).cached, true); assert.equal(calls, 1);
  disableDuringExtract = true;
  await assert.rejects(service.liveAnalysis.transcribe(root, { ...source, id: 'b', assetPath: 'assets/b.mp4' }, { expectedService }));
  assert.equal(calls, 1);
});

test('the frozen model identity is checked again inside the desktop adapter before execution', async t => {
  const base = resolve('../../.tmp/desktop-live-services-20261104/desktop'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'identity-')); t.after(() => rm(root, { recursive: true, force: true }));
  let publicConfig = { id: 'a', name: 'Synthetic', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, calls = 0;
  const options = createDesktopAnalysisServices({ providersFile: join(root, 'not-configured.json'), env: {}, textBridge: async message => {
    if (message.operation === 'public-config') return publicConfig;
    calls++; return { value: {} };
  } });
  const client = options.liveAnalysis.modelClient;
  const expectedIdentity = await client.getCacheIdentity();
  publicConfig = { ...publicConfig, id: 'b' };
  await assert.rejects(client({ system: 's', input: 't', expectedIdentity }), { code: 'MODEL_INPUT_CHANGED' });
  assert.equal(calls, 0);
});
