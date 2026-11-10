import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRoster } from './agent-roster.mjs';
import { createDesktopTextService } from './desktop-analysis-service.mjs';

function fixture(t) {
  const base = resolve('.tmp/desktop-live-services-20261104/desktop'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'models-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let probes = 0, unseals = 0;
  const roster = createRoster({ dataDir: dir, localAgents: async () => [], closeSessions: () => {}, onChange: () => {},
    seal: text => Buffer.from(`sealed:${text}`), unseal: data => { unseals++; return data.toString().replace(/^sealed:/, ''); },
    fetch: async () => { probes++; return new Response('{}'); } });
  return { roster, dir, counts: () => ({ probes, unseals }) };
}
const config = { format: 'responses', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', key: 'synthetic-secret', liveAnalysis: true };

test('live text model saves offline, is selected explicitly, and public inspection never unseals the key', async t => {
  const f = fixture(t);
  const first = await f.roster.saveOwnModel(config); assert.equal(first.ok, true); assert.equal(f.counts().probes, 0);
  const before = f.counts().unseals;
  const publicConfig = f.roster.analysisModel(); assert.equal(publicConfig.model, config.model);
  assert.equal(f.counts().unseals, before); assert.ok(!JSON.stringify(publicConfig).includes('synthetic-secret'));
  assert.ok(!readFileSync(join(f.dir, 'agents.json'), 'utf8').includes('synthetic-secret'));
  const second = await f.roster.saveOwnModel({ ...config, model: 'deepseek-other' });
  assert.equal(f.roster.analysisModel().id, second.id);
  f.roster.disconnect('byok'); assert.equal(f.roster.analysisModel(), null);
});

test('normal visual model settings retain their image check, and invalid text endpoints are refused offline', async t => {
  const f = fixture(t);
  assert.equal((await f.roster.saveOwnModel({ ...config, liveAnalysis: false })).ok, true);
  assert.equal(f.counts().probes, 1);
  assert.equal((await f.roster.saveOwnModel({ ...config, baseUrl: 'https://other.test' })).ok, false);
  assert.equal(f.counts().probes, 1);
});

test('text execution bridge returns only parsed output and a safe receipt; stale approval cannot execute', async t => {
  const f = fixture(t); await f.roster.saveOwnModel(config);
  let calls = 0;
  const service = createDesktopTextService({ roster: () => f.roster, fetch: async (_url, options) => {
    calls++; assert.ok(options.signal); assert.equal(JSON.parse(options.body).input[1].content, 'synthetic transcript');
    return new Response(JSON.stringify({ id: 'mock-response', status: 'completed', model: config.model, usage: { input_tokens: 25, output_tokens: 10 }, output: [{ content: [{ type: 'output_text', text: '{"candidates":[],"issues":[]}' }] }] }));
  } });
  const publicConfig = await service({ operation: 'public-config' }); assert.equal(calls, 0);
  const result = await service({ operation: 'execute', expectedConfig: publicConfig, system: 'synthetic prompt', input: 'synthetic transcript' });
  assert.deepEqual(result.value, { candidates: [], issues: [] }); assert.equal(result.receipt.requestId, 'mock-response');
  assert.equal(result.receipt.usage.input_tokens, 25); assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  await f.roster.saveOwnModel({ ...config, model: 'changed-model' });
  await assert.rejects(service({ operation: 'execute', expectedConfig: publicConfig, system: 's', input: 't' }), { code: 'MODEL_INPUT_CHANGED' });
  assert.equal(calls, 1);
});

test('incomplete paid responses retain their safe usage receipt for the persisted task ledger', async t => {
  const f = fixture(t); await f.roster.saveOwnModel(config);
  const service = createDesktopTextService({ roster: () => f.roster, fetch: async () => new Response(JSON.stringify({ id: 'synthetic-incomplete', status: 'incomplete', usage: { input_tokens: 14, output_tokens: 3, private: 'do-not-copy' } })) });
  const expectedConfig = await service({ operation: 'public-config' });
  await assert.rejects(service({ operation: 'execute', expectedConfig, system: 's', input: 't' }), error => {
    assert.equal(error.code, 'MODEL_INCOMPLETE');
    assert.equal(error.receipt.requestId, 'synthetic-incomplete');
    assert.deepEqual(error.receipt.usage, { input_tokens: 14, output_tokens: 3 });
    return true;
  });
});

test('visual configuration uses existing first image-capable conversation model and never unseals on inspection', async t => {
  const f = fixture(t); await f.roster.saveOwnModel(config);
  const visual = await f.roster.saveOwnModel({ format: 'chat', baseUrl: 'https://mock.invalid/v1', model: 'mock-vision', name: 'Existing visual', key: 'synthetic-visual-secret', levels: ['auto', 'low'], effort: 'low', context: 65536, maxOutputTokens: 2048 });
  const before = f.counts();
  const service = createDesktopTextService({ roster: () => f.roster, fetch: () => assert.fail('public inspection cannot request') });
  const result = await service({ operation: 'public-visual-config' });
  assert.equal(result.id, visual.id); assert.equal(result.api, 'openai-completions'); assert.equal(result.model, 'mock-vision');
  assert.equal(result.effort, 'low'); assert.equal(result.context, 65536); assert.equal(result.maxOutputTokens, 2048);
  assert.deepEqual(f.counts(), before); assert.ok(!JSON.stringify(result).includes('synthetic-visual-secret'));
  f.roster.disconnect('byok'); assert.equal(await service({ operation: 'public-visual-config' }), null);
});

test('visual bridge executes only matching confirmed configuration and returns raw output with receipt', async t => {
  const f = fixture(t); await f.roster.saveOwnModel({ format: 'chat', baseUrl: 'https://mock.invalid/v1', model: 'mock-vision', key: 'synthetic-visual-secret' });
  let calls = 0;
  const service = createDesktopTextService({ roster: () => f.roster, visualStream: (_model, context, options) => {
    calls++; assert.equal(context.messages[0].content[1].type, 'image'); assert.equal(options.maxRetries, 0);
    return { result: async () => ({ role: 'assistant', content: [{ type: 'text', text: '{"observations":[]}' }], stopReason: 'stop', responseId: 'visual-receipt', usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } }) };
  } });
  const expectedConfig = await service({ operation: 'public-visual-config' });
  const message = { operation: 'execute-visual', system: 'mock system', input: 'mock input', images: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], expectedConfig };
  const value = await service(message); assert.equal(value.value, '{"observations":[]}'); assert.equal(value.receipt.requestId, 'visual-receipt'); assert.equal(calls, 1);
  await assert.rejects(service({ ...message, expectedConfig: { ...expectedConfig, model: 'changed' } }), { code: 'MODEL_INPUT_CHANGED' }); assert.equal(calls, 1);
});
