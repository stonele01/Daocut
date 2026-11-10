import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStudio } from './server.mjs';

test('offline local project reopens, edits and saves without company authorization; new analysis stays blocked', { timeout: 30000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-v2-20261105/offline');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'studio-'));
  const env = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(env.map(key => [key, process.env[key]]));
  for (const key of env.slice(0, 3)) process.env[key] = join(scratch, key);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  let studio, authChecks = 0, modelCalls = 0;
  const options = { port: 0, key: 'isolated-offline', openBrowser() {}, requireAnalysisPlan: true,
    authorizeTask: async () => { authChecks++; throw Error('公司服务离线'); },
    analysisServices: async () => ({ transcription: { enabled: true, provider: 'doubao', model: 'mock-asr', endpoint: 'local://mock' } }),
    liveAnalysis: { transcribe: async () => { modelCalls++; throw Error('must not send'); } },
  };
  t.after(async () => { await studio?.close(); for (const key of env) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; });
  const api = async (path, method = 'GET', input) => {
    const response = await fetch(`${studio.origin}/api/${path}`, { method, headers: { 'content-type': 'application/json', 'x-studio-key': studio.key }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  studio = await startStudio(options);
  const opened = await api('projects', 'POST', { path: join(scratch, 'existing') }); assert.equal(opened.status, 200);
  const project = opened.data.project, prefix = `projects/${project.id}`;
  await mkdir(join(project.path, 'assets'), { recursive: true });
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=5:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', join(project.path, 'assets/mock.mp4')], { windowsHide: true });
  const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/mock.mp4', durationMs: 4000 }], products: [{ id: 'p', name: '已保存商品', sourceIds: ['s'] }], intervals: [{ id: 'i', productId: 'p', sourceId: 's', startMs: 0, endMs: 4000 }], candidates: [] };
  assert.equal((await api(`${prefix}/product-analysis`, 'PUT', { analysis })).status, 200);
  const film = await readFile(join(project.path, 'film.html'));
  await studio.close(); studio = await startStudio(options);
  assert.equal((await api('projects', 'POST', { path: project.path, create: false })).status, 200);
  assert.equal((await api(prefix)).status, 200);
  const existing = (await api(`${prefix}/product-analysis`)).data.analysis; existing.products[0].name = '离线改名';
  const expected = (await api(`${prefix}/product-analysis`)).data.analysis;
  assert.equal((await api(`${prefix}/product-analysis`, 'PUT', { analysis: existing, expected })).status, 200);
  const takes = (await api(`${prefix}/source-takes?sourceId=s`)).data;
  const document = { version: 1, sourceId: 's', assetPath: 'assets/mock.mp4', durationMs: 4000, signature: JSON.stringify(['assets/mock.mp4', 4000, []]), film: { tracks: [{ clips: [{ id: 'take', src: 'assets/mock.mp4', time: [1, 3], at: 1 }] }] } };
  const stored = await api(`${prefix}/source-takes?sourceId=s`, 'PUT', { sourceIdentity: takes.sourceIdentity, expectedRevision: takes.revision, document }); assert.equal(stored.status, 200, JSON.stringify(stored.data));
  assert.equal(authChecks, 0);
  await studio.close(); studio = await startStudio(options);
  assert.equal((await api(`${prefix}/product-analysis`)).data.analysis.products[0].name, '离线改名');
  assert.deepEqual((await api(`${prefix}/source-takes?sourceId=s`)).data.document.film.tracks[0].clips[0].time, [1, 3]);
  const planned = await api(`${prefix}/product-workflow/plan?sourceId=s&action=transcription`); assert.equal(planned.status, 200);
  assert.equal((await api(`${prefix}/product-workflow/execute`, 'POST', { confirmed: true, plan: planned.data })).status, 403);
  assert.equal(authChecks, 1); assert.equal(modelCalls, 0);
  assert.deepEqual(await readFile(join(project.path, 'film.html')), film);
});
