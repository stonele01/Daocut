import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { startStudio } from './server.mjs';

test('ordinary server exposes stage plans and blocks legacy paid endpoints even with confirmed:true', async t => {
  const base = resolve('../../.tmp/desktop-live-services-20261104/backend'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'http-'));
  const old = Object.fromEntries(['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY'].map(key => [key, process.env[key]]));
  process.env.DAOCUT_STUDIO_HOME = join(root, 'home'); process.env.DAOCUT_LIBRARY = join(root, 'library');
  t.mock.method(globalThis, 'fetch', () => { throw Error('external network prohibited'); });
  let calls = 0, transcript = null;
  const probeSource = async () => ({ duration: 10 });
  const studio = await startStudio({ port: 0, key: 'isolated-workflow-key', openBrowser() {}, requireAnalysisPlan: true,
    analysisServices: async () => ({ transcription: { enabled: true, provider: 'doubao', name: '模拟豆包', endpoint: 'https://mock.invalid/asr', model: 'mock-asr' }, text: { enabled: true, provider: 'deepseek', name: '模拟 DeepSeek', endpoint: 'https://mock.invalid/text', model: 'mock-model' } }),
    liveAnalysis: { probeSource, readTranscript: async () => transcript, transcribe: async () => { calls++; transcript = { cues: [{ text: '模拟字幕', startMs: 0, endMs: 1000 }] }; return transcript; } },
    productDiscovery: { probeSource, readTranscript: async () => transcript, modelIdentity: 'mock', modelClient: async () => { throw Error('text was not separately confirmed'); } },
  });
  t.after(async () => { await studio.close(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(root, { recursive: true, force: true }); });
  const api = (path, body) => new Promise((resolve, reject) => {
    const req = request(`${studio.origin}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let content = ''; res.setEncoding('utf8'); res.on('data', chunk => { content += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(content) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const opened = await api('/api/open', { path: join(root, 'project'), fallback: 0, now: true });
  assert.equal(opened.status, 200); const prefix = `/api/projects/${opened.data.project.id}`;
  await mkdir(join(root, 'project', 'assets'), { recursive: true }); await writeFile(join(root, 'project', 'assets', 'live.mp4'), 'synthetic');
  const registered = await api(`${prefix}/product-workflow/source`, { assetPath: 'assets/live.mp4' }); assert.equal(registered.status, 200);
  const sourceId = registered.data.source.id;
  for (const path of ['live-analysis/transcribe', 'live-analysis/analyze', 'product-discovery/discover', 'product-preparation']) {
    assert.equal((await api(`${prefix}/${path}`, { sourceId, confirmed: true })).status, 409);
  }
  const planned = await api(`${prefix}/product-workflow/plan?sourceId=${sourceId}&action=transcription`);
  assert.equal(planned.status, 200); assert.equal(planned.data.requestCount, 1); assert.equal(calls, 0);
  assert.equal((await api(`${prefix}/product-workflow/execute`, { plan: planned.data })).status, 400);
  assert.equal((await api(`${prefix}/product-workflow/execute`, { confirmed: true, plan: planned.data })).status, 200);
  let status;
  for (let n = 0; n < 100; n++) { status = (await api(`${prefix}/product-workflow/status?sourceId=${sourceId}`)).data; if (!status.busy) break; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(status.transcription.status, 'complete'); assert.equal(status.phase, 'discovery'); assert.equal(calls, 1);
  assert.equal((await api(`${prefix}/live-analysis?sourceId=${sourceId}`)).status, 200);
});
