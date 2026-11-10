import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { startStudio } from './server.mjs';
import { transcriptionLocation } from './product-transcription.mjs';

test('ordinary HTTP entry exposes a shared plan and imports the first transcript in another isolated project', async t => {
  const base = resolve('../../.tmp/shared-live-20261104/backend'); await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'http-'));
  const old = { DAOCUT_STUDIO_HOME: process.env.DAOCUT_STUDIO_HOME, DAOCUT_LIBRARY: process.env.DAOCUT_LIBRARY };
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home'); process.env.DAOCUT_LIBRARY = join(scratch, 'projects');
  t.mock.method(globalThis, 'fetch', () => { throw Error('real network forbidden'); });
  let calls = 0, task;
  const coordinate = async (op, body) => {
    if (op === 'status') return { task: task ?? null };
    if (op === 'claim') { task = { taskKey: body.taskKey, inputHash: body.inputHash, attemptId: 'http-test-attempt', status: 'claimed' }; return { task, acquired: true }; }
    if (op === 'submitted') { const sendAllowed = task.status === 'claimed'; task.status = 'submitted'; return { task, sendAllowed }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; }
    return { task };
  };
  const probeSource = async () => ({ duration: 20 });
  const studio = await startStudio({ port: 0, key: 'shared-http-test', openBrowser() {}, requireAnalysisPlan: true,
    analysisServices: async () => ({ transcription: { enabled: true, provider: 'doubao', model: 'mock-asr' } }),
    sharedAnalysis: { coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'http-library', root: join(scratch, 'shared') }] }), readManifest: async () => ({ items: { 'assets/live.mp4': { libraryId: 'http-library', relativePath: 'same-live.mp4' } } }) },
    liveAnalysis: { probeSource, transcribe: async (root, source) => { calls++; const loc = await transcriptionLocation(root, source), cues = [{ text: '模拟字幕', startMs: 0, endMs: 1500 }]; await mkdir(loc.dir, { recursive: true }); await writeFile(loc.path, JSON.stringify({ version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, cues, words: [] })); return { cues, words: [] }; } },
    productDiscovery: { probeSource },
  });
  t.after(async () => { await studio.close(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(scratch, { recursive: true, force: true }); });
  const api = (path, body) => new Promise((resolve, reject) => {
    const req = request(`${studio.origin}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let bytes = ''; res.setEncoding('utf8'); res.on('data', part => { bytes += part; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(bytes) }));
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  for (let person = 0; person < 2; person++) {
    const root = join(scratch, `person-${person}`), opened = await api('/api/open', { path: root, fallback: 0, now: true }); assert.equal(opened.status, 200);
    await mkdir(join(root, 'assets'), { recursive: true }); await writeFile(join(root, 'assets/live.mp4'), 'same synthetic live');
    const prefix = `/api/projects/${opened.data.project.id}`, registered = await api(`${prefix}/product-workflow/source`, { assetPath: 'assets/live.mp4' }); assert.equal(registered.status, 200);
    const query = `sourceId=${encodeURIComponent(registered.data.source.id)}`, plan = await api(`${prefix}/product-workflow/plan?${query}&action=transcription`);
    assert.equal(plan.status, 200); assert.equal(plan.data.shared.mode, person ? 'reuse' : 'publish'); assert.equal(plan.data.requestCount, person ? 0 : 1);
    assert.equal((await api(`${prefix}/product-workflow/execute`, { confirmed: true, plan: plan.data })).status, 200);
    let status;
    for (let n = 0; n < 100; n++) { status = (await api(`${prefix}/product-workflow/status?${query}`)).data; if (!status.busy) break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(status.transcription.status, 'complete'); assert.equal(calls, 1);
  }
});
