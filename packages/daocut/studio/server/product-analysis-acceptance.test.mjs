// Synthetic acceptance fixture: generated color videos and invented product text, never business analysis.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startStudio } from './server.mjs';

test('synthetic products survive the real API, transfer, range edits and recovery without editing the film', async () => {
  const tempBase = resolve('.test-temp');
  await mkdir(tempBase, { recursive: true });
  const scratch = await mkdtemp(join(tempBase, 'product-acceptance-'));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'library');
  process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash');
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const res = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const json = await res.json();
      assert.equal(res.status, 200, JSON.stringify(json));
      return json;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-project') });
    for (const name of ['synthetic-a.mp4', 'synthetic-b.mp4']) {
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=5:d=12', '-c:v', 'mpeg4', '-y', join(project.path, name)], { windowsHide: true });
    }
    const path = `/api/projects/${project.id}/product-analysis`;
    const filmPath = join(project.path, 'film.html');
    const filmBefore = await readFile(filmPath, 'utf8');
    const tags = ['钩子', '痛点', '卖点', '产品演示', '价格锚点', '行动指令'];
    const fixture = {
      version: 1,
      sources: [{ id: 'video-a', assetPath: 'synthetic-a.mp4', durationMs: null }, { id: 'video-b', assetPath: 'synthetic-b.mp4', durationMs: null }],
      products: [{ id: 'p1', name: '示例商品甲（虚构）', sourceIds: ['video-a'] }, { id: 'p2', name: '示例商品乙（虚构）', sourceIds: ['video-b'] }],
      intervals: [{ id: 'i1', productId: 'p1', sourceId: 'video-a', startMs: 0, endMs: 4000 }, { id: 'i2', productId: 'p1', sourceId: 'video-a', startMs: 6000, endMs: 10000 }, { id: 'i3', productId: 'p2', sourceId: 'video-b', startMs: 0, endMs: 5000 }],
      candidates: tags.map((tag, n) => ({ id: `c${n}`, productId: 'p1', intervalId: 'i1', sourceId: 'video-a', startMs: 500 + n * 200, endMs: 2500 + n * 200, text: `虚构示例：${tag}`, tags: [tag], origin: 'synthetic-test', version: 1 })),
    };
    const saved = await api(path, 'PUT', { analysis: fixture });
    assert.equal(saved.analysis.sources[0].durationMs, 12000);
    assert.equal(saved.analysis.sources[1].durationMs, 12000);
    await studio.close();
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    assert.deepEqual((await api(path)).analysis, saved.analysis, 'server restart reopens saved analysis');
    assert.ok(saved.analysis.candidates[0].endMs > saved.analysis.candidates[1].startMs, 'overlapping candidates remain independent');
    const moved = structuredClone(saved.analysis);
    moved.products[1].sourceIds.push('video-a');
    moved.intervals[0].productId = 'p2';
    moved.candidates.forEach(c => { c.productId = 'p2'; });
    await api(path, 'PUT', { analysis: moved });
    const shortened = structuredClone(moved);
    shortened.intervals[0].endMs = 1000;
    const edited = await api(path, 'PUT', { analysis: shortened });
    assert.equal(edited.analysis.candidates.length, 6, 'shortening does not delete or trim candidates');
    assert.deepEqual(edited.history, moved);
    const restored = await api(path, 'PUT', { analysis: edited.history });
    assert.deepEqual(restored.analysis, moved);
    assert.deepEqual((await api(path)).analysis, moved);
    assert.equal(await readFile(filmPath, 'utf8'), filmBefore, 'analysis operations never insert clips into film');
  } finally {
    if (studio) await studio.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
