import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readFilmFile } from '../../src/film-doc.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
import { startStudio } from './server.mjs';

const exec = promisify(execFile);

test('the product-analysis demo is isolated, persisted, and explicitly synthetic', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'product-analysis-demo-'));
  const before = { home: process.env.DAOCUT_STUDIO_HOME, library: process.env.DAOCUT_LIBRARY, trash: process.env.DAOCUT_TRASH_DIR };
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'library');
  process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash');
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio;
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {} });
    const response = await fetch(`${studio.origin}/api/projects/product-analysis-demo`, { method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, body: '{}' });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    const { project } = body;
    assert.match(project.name, /演示数据/);
    for (const name of ['demo-source-a.mp4', 'demo-source-b.mp4', 'demo-source-c.mp4']) {
      const file = join(project.path, 'assets', name);
      assert.ok(existsSync(file));
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,duration', '-of', 'json', file], { windowsHide: true });
      const [stream] = JSON.parse(stdout).streams;
      assert.equal(stream.codec_name, 'h264');
      assert.equal(stream.pix_fmt, 'yuv420p');
      assert.ok(Math.abs(Number(stream.duration) - 12) < 0.1, `${name} has the expected duration`);
    }
    const analysis = (await readProductAnalysis(project.path)).analysis;
    assert.equal(analysis.products.length, 4);
    for (const productId of ['demo-cleanser', 'demo-serum', 'demo-cream']) {
      const intervals = analysis.intervals.filter((interval) => interval.productId === productId);
      const candidates = analysis.candidates.filter((candidate) => candidate.productId === productId);
      assert.ok(intervals.length >= 3, `${productId} has multiple ranges`);
      assert.ok(new Set(intervals.map((interval) => interval.sourceId)).size >= 2, `${productId} spans videos`);
      assert.ok(candidates.length >= 3, `${productId} has multiple candidates`);
      assert.ok(new Set(candidates.map((candidate) => candidate.sourceId)).size >= 2, `${productId} has candidates across videos`);
      assert.ok(new Set(candidates.map((candidate) => candidate.intervalId)).size >= 3, `${productId} has candidates across ranges`);
      assert.ok(candidates.some((candidate) => candidate.tags.length > 1), `${productId} has a multi-tag candidate`);
    }
    assert.ok(analysis.candidates.every((candidate) => candidate.origin === 'demo-data'));
    assert.ok(analysis.candidates.some((candidate) => candidate.tags.length > 1), 'multi-tag candidates remain intact');
    assert.match(analysis.products.find((product) => product.id === 'demo-unanalysed').name, /尚未分析/);
    assert.equal(analysis.candidates.filter((candidate) => candidate.productId === 'demo-unanalysed').length, 0, 'the unanalysed state has no invented candidates');
    assert.ok(analysis.sources.every((source) => source.durationMs && source.durationMs >= 12000));
    assert.deepEqual(readFilmFile(await readFile(join(project.path, 'film.html'), 'utf8')).value?.tracks, [], 'the demo does not add anything to the film');
    const edited = structuredClone(analysis);
    edited.products[0].name = '演示洁面（已人工修改）';
    await writeProductAnalysis(project.path, edited);
    assert.equal((await readProductAnalysis(project.path)).analysis.products[0].name, '演示洁面（已人工修改）', 'reading again restores a user edit in the demo project');
  } finally {
    await studio?.close();
    for (const [key, value] of Object.entries(before)) {
      const env = key === 'home' ? 'DAOCUT_STUDIO_HOME' : key === 'library' ? 'DAOCUT_LIBRARY' : 'DAOCUT_TRASH_DIR';
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
