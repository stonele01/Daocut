import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStudio } from './server.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';
import { runOneShotSample } from './one-shot-sample-runner.mjs';

test('disabled runner does nothing; synthetic run persists and reopens', async () => {
  assert.equal(await runOneShotSample(), null);
  const base = resolve('.test-temp'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'runner-'));
  const names = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = join(scratch, name);
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const request = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200); return response.json();
    };
    const { project } = await request('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'));
    const sourcePath = join(project.path, 'assets', '氨基酸2023.6.1.mp4'); await writeFile(sourcePath, 'synthetic');
    const filmPath = join(project.path, 'film.html'), film = await readFile(filmPath, 'utf8');
    const probeSource = async () => ({ duration: 132.47 });
    await writeProductAnalysis(project.path, { version: 1, sources: [{ id: 's', assetPath: 'assets/氨基酸2023.6.1.mp4', durationMs: 132470 }], products: [{ id: 'p', name: '人工内容', sourceIds: ['s'] }], intervals: [], candidates: [] }, probeSource);
    await studio.close(); studio = null;
    const cues = Array.from({ length: 49 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 500, text: `合成${i}` }));
    const key = randomBytes(32), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const files = { local: JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPItest').toString('base64') } }), agents: JSON.stringify({ byok: { models: [{ id: 'id', model: 'deepseek-flash', format: 'responses', baseUrl: 'https://api.deepseek.com' }] } }), keys: Buffer.concat([Buffer.from('enc:v10'), nonce, cipher.update(JSON.stringify({ id: 'fake-key' })), cipher.final(), cipher.getAuthTag()]) };
    let calls = 0;
    const options = { enabled: true, projectId: project.id, root: project.path, sourcePath, sourceId: 's', productId: 'p', intervalId: 'scope', cueDigest: createHash('sha256').update(JSON.stringify(cues)).digest('hex'), probeSource, readTranscript: async () => ({ cues }), paths: { localState: 'local', agents: 'agents', sealedKeys: 'keys' }, unprotect: async () => key, readFile: async path => files[path], fetch: async () => { calls++; return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"candidates":[],"issues":[]}' }] }] }) }; } };
    options.modelIdentity = { provider: 'deepseek', model: 'deepseek-flash', endpoint: 'https://api.deepseek.com/responses', maxOutputTokens: 16384, reasoningEffort: 'low' };
    assert.equal((await runOneShotSample(options)).analysis.status, 'complete');
    assert.equal(calls, 1);
    assert.equal(await readFile(filmPath, 'utf8'), film);
    studio = await startStudio({ port: 0, openBrowser: () => {}, liveAnalysis: { readTranscript: options.readTranscript, modelIdentity: options.modelIdentity } });
    const analysis = (await request(`/api/projects/${project.id}/product-analysis`)).analysis;
    assert.equal(analysis.products[0].name, '人工内容'); assert.deepEqual(analysis.intervals, []);
    assert.equal((await request(`/api/projects/${project.id}/live-analysis?sourceId=s`)).analysis.status, 'complete');
  } finally {
    if (studio) await studio.close();
    for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    await rm(scratch, { recursive: true, force: true });
  }
});
