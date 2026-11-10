import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createOneShotSample } from './one-shot-sample.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';

test('trusted startup runs one synthetic sample through the existing queue', async () => {
  const root = await mkdtemp(resolve('.test-temp/sample-'));
  try {
    await mkdir(join(root, 'assets'));
    const sourcePath = join(root, 'assets', '氨基酸2023.6.1.mp4');
    await writeFile(sourcePath, 'synthetic');
    const probeSource = async () => ({ duration: 132.47 });
    const initial = { version: 1, sources: [{ id: 's', assetPath: 'assets/氨基酸2023.6.1.mp4', durationMs: 132470 }], products: [{ id: 'p', name: '人工修改', sourceIds: ['s'] }], intervals: [], candidates: [] };
    await writeProductAnalysis(root, initial, probeSource);
    const cues = Array.from({ length: 49 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 500, text: `合成字幕${i}` }));
    const key = randomBytes(32), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const sealed = Buffer.concat([Buffer.from('enc:v10'), nonce, cipher.update(JSON.stringify({ id: 'fake-key' })), cipher.final(), cipher.getAuthTag()]);
    const files = { local: JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPItest').toString('base64') } }), agents: JSON.stringify({ byok: { models: [{ id: 'id', model: 'deepseek-flash', format: 'responses', baseUrl: 'https://api.deepseek.com' }] } }), keys: sealed };
    let calls = 0;
    const options = { enabled: true, root, sourcePath, sourceId: 's', productId: 'p', intervalId: 'scope', cueDigest: createHash('sha256').update(JSON.stringify(cues)).digest('hex'), probeSource, readTranscript: async () => ({ cues }), paths: { localState: 'local', agents: 'agents', sealedKeys: 'keys' }, unprotect: async () => key, readFile: async path => files[path], fetch: async () => { calls++; return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ candidates: [{ firstCue: 0, lastCue: 0, tags: ['钩子'], details: { subtypes: [], reason: '合成', evidence: ['ASR'], context: '', repetition: '', review: [] } }], issues: [] }) }] }] }) }; } };
    assert.equal(createOneShotSample({}), null);
    const wrong = createOneShotSample({ ...options, cueDigest: '0'.repeat(64) });
    await assert.rejects(wrong.prepareScope());
    assert.equal((await readProductAnalysis(root)).analysis.scopes, undefined);
    const sample = createOneShotSample(options);
    await sample.prepareScope();
    const route = createLiveAnalysis({ modelClient: sample.modelClient, modelIdentity: { provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/responses', maxOutputTokens: 16384, reasoningEffort: 'low' }, readTranscript: options.readTranscript, probeSource });
    async function request(method, rest, body) {
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.url = `/${rest}?sourceId=s`;
      let result; const res = { writeHead() {}, end(data) { result = JSON.parse(data); } };
      await route(req, res, root, rest); return result;
    }
    await request('POST', 'live-analysis/analyze', { sourceId: 's', intervalId: 'scope', confirmed: true });
    let state;
    for (let i = 0; i < 100; i++) { state = await request('GET', 'live-analysis'); if (state.analysis.status !== 'running') break; await new Promise(done => setTimeout(done, 10)); }
    assert.equal(state.analysis.status, 'complete');
    const saved = (await readProductAnalysis(root)).analysis;
    assert.deepEqual(saved.intervals, []);
    assert.equal(saved.products[0].name, '人工修改');
    assert.equal(saved.candidates[0].text, cues[0].text);
    assert.equal(calls, 1);
    await request('POST', 'live-analysis/analyze', { sourceId: 's', intervalId: 'scope', confirmed: true });
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
