import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { startStudio } from './server.mjs';

test('moving a source excludes concurrent product saves and does not expose half-moved associations', { timeout: 30000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/source-safety-20261105/server');
  await fs.mkdir(base, { recursive: true }); const scratch = await fs.mkdtemp(join(base, 'move-'));
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = key === 'DAOCUT_NO_UPDATE_CHECK' ? '1' : join(scratch, key);
  let studio, release, moving;
  try {
    studio = await startStudio({ port: 0, openBrowser() {}, authorizeTask: async () => { throw Error('model forbidden'); } });
    const api = (path, method = 'GET', body) => fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const response = await api('/api/projects', 'POST', { path: join(scratch, 'project') }); assert.equal(response.status, 200);
    const { project } = await response.json(), prefix = `/api/projects/${project.id}`;
    await fs.mkdir(join(project.path, 'assets'), { recursive: true });
    const original = join(project.path, 'assets/source.mp4'), target = join(project.path, 'assets/moved.mp4');
    await fs.writeFile(original, 'synthetic bytes, not a NAS video');
    const analysis = { version: 1, sources: [{ id: 's', assetPath: 'assets/source.mp4', durationMs: 2000 }], products: [{ id: 'p', name: '原人工名称', sourceIds: ['s'] }], intervals: [], candidates: [] };
    await fs.writeFile(join(project.path, '.film/product-analysis.json'), JSON.stringify(analysis));
    let started; const reached = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => { if (resolve(String(from)) === resolve(original) && resolve(String(to)) === resolve(target)) { started(); await held; } return rename(from, to); });
    syncBuiltinESMExports();
    moving = api(`${prefix}/files`, 'PATCH', { from: 'assets/source.mp4', to: 'assets/moved.mp4' });
    let timer; await Promise.race([reached, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('move did not reach filesystem')), 5000); })]).finally(() => clearTimeout(timer));
    const write = await api(`${prefix}/product-analysis`, 'PUT', { analysis: { ...analysis, products: [{ ...analysis.products[0], name: '旧窗口保存' }] }, expected: analysis });
    assert.equal(write.status, 409, 'save must not race a source move');
    const read = await api(`${prefix}/product-analysis`); assert.equal(read.status, 409, 'half-moved associations must not be returned');
    release(); const moved = await moving; assert.equal(moved.status, 200, await moved.text());
    const current = await (await api(`${prefix}/product-analysis`)).json();
    assert.equal(current.analysis.sources[0].assetPath, 'assets/moved.mp4'); assert.equal(current.analysis.products[0].name, '原人工名称');
    const stale = await api(`${prefix}/product-analysis`, 'PUT', { analysis, expected: analysis }); assert.equal(stale.status, 409);
    assert.equal(await fs.readFile(target, 'utf8'), 'synthetic bytes, not a NAS video');
  } finally {
    release?.(); await moving?.catch(() => {}); t.mock.restoreAll(); syncBuiltinESMExports(); await studio?.close();
    for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key];
  }
});
