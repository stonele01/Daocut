import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openNewSharedProject, readSharedProjectOpen } from './shared-project-open.mjs';
import { readProductAnalysis, updateProductAnalysis } from './product-analysis.mjs';

async function fixture(t, options = {}) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-open-20261106');
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.film')); await writeFile(join(root, 'film.html'), 'empty film');
  const seed = { version: 1, sources: [{ id: 's', assetPath: 'assets/live.mp4', durationMs: null }], products: [{ id: 'placeholder', name: 'folder', sourceIds: ['s'] }], intervals: [], candidates: [] };
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify(seed));
  const calls = [], items = options.items ?? [];
  const deps = {
    registerSource: async () => { calls.push('prepare'); return updateProductAnalysis(root, data => { data.sources[0].durationMs = 20000; return data; }, async () => ({ duration: 20 })); },
    publication: {
      catalog: async () => { calls.push('catalog'); assert.equal((await readProductAnalysis(root)).analysis.sources[0].durationMs, 20000); if (options.catalog) await options.catalog(root); return { results: items }; },
      preview: async (_, item) => { calls.push(`preview:${item.taskKey}`); return { action: item.action, scope: item.scope, proposal: { products: [], intervals: [], unassigned: [] } }; },
      importResult: async (_, item) => { calls.push(`import:${item.taskKey}`); return { imported: true, runId: 'run', needsReview: item.action === 'transcription' }; },
    },
    discovery: { apply: async () => { calls.push('apply'); } },
  };
  return { root, seed, calls, deps, run: () => openNewSharedProject(root, { sourceId: 's', assetPath: 'assets/live.mp4', expectedAnalysis: seed }, deps) };
}
test('new shared opening registers duration before catalog, saves empty state and never invokes analysis', async t => {
  const f = await fixture(t); const result = await f.run();
  assert.deepEqual(f.calls, ['prepare', 'catalog']); assert.equal(result.status, 'empty'); assert.equal(result.requestCount, 0);
  assert.deepEqual(await readSharedProjectOpen(f.root), result); assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'empty film');
});
test('existing or edited project is preserved before probing or importing', async t => {
  const f = await fixture(t); const value = structuredClone(f.seed); value.products[0].name = 'personal rename';
  await writeFile(join(f.root, '.film/product-analysis.json'), JSON.stringify(value));
  assert.equal((await f.run()).status, 'review-required'); assert.deepEqual(f.calls, []);
  assert.equal((await readProductAnalysis(f.root)).analysis.products[0].name, 'personal rename');
});
test('personal edit arriving during catalog prevents automatic adoption', async t => {
  const f = await fixture(t, { items: [{ taskKey: 'd', resultSha: 'sha', action: 'discovery' }], catalog: async root => {
    await updateProductAnalysis(root, data => { data.products[0].name = 'changed while opening'; return data; });
  } });
  assert.equal((await f.run()).status, 'review-required'); assert.ok(!f.calls.includes('import:d'));
});
test('personal edit arriving during video preparation is not adopted as an automatic-import baseline', async t => {
  const f = await fixture(t, { items: [{ taskKey: 'd', resultSha: 'sha', action: 'discovery' }] });
  f.deps.registerSource = async () => updateProductAnalysis(f.root, data => { data.sources[0].durationMs = 20000; data.products[0].name = 'renamed during probe'; return data; });
  assert.equal((await f.run()).status, 'review-required'); assert.deepEqual(f.calls, []);
  assert.equal((await readProductAnalysis(f.root)).analysis.products[0].name, 'renamed during probe');
});
test('ambiguous versions are left for review and unavailable sharing opens with a saved explanation', async t => {
  const f = await fixture(t, { items: [{ taskKey: 'd1', action: 'discovery' }, { taskKey: 'd2', action: 'discovery' }] });
  assert.equal((await f.run()).status, 'review-required'); assert.ok(!f.calls.some(c => c.startsWith('import:')));
  const g = await fixture(t, { catalog: async () => { throw Error('coordinator unavailable'); } });
  const state = await g.run(); assert.equal(state.status, 'unavailable'); assert.match(state.warnings.join(' '), /coordinator unavailable/);
});
test('duplicate/reopened initialization returns persisted state without reimporting or querying models', async t => {
  const f = await fixture(t); const [a, b] = await Promise.all([f.run(), f.run()]); assert.deepEqual(a, b);
  const before = [...f.calls]; assert.deepEqual(await f.run(), a); assert.deepEqual(f.calls, before);
});
