import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createExports } from './exports.mjs';

test('ordinary project folder and zip exports still work beside complete backups for local media', async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-v2-20261105/export-regression');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'compat-')), root = join(scratch, 'original');
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_EXPORTS'], old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home'); process.env.DAOCUT_EXPORTS = join(scratch, 'exports');
  t.after(() => { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; });
  await mkdir(join(root, '.film'), { recursive: true }); await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'film.html'), 'personal film'); await writeFile(join(root, 'assets/mock.mp4'), 'synthetic local video');
  await writeFile(join(root, '.film/id'), 'original-id'); await writeFile(join(root, '.film/product-analysis.json'), '{"version":1,"sources":[]}');
  const exports = createExports(), project = { id: 'isolated', name: 'Local project', path: root };
  for (const as of ['folder', 'zip']) {
    const job = exports.start(project, { kind: 'project', as, parts: [] });
    const done = await new Promise((resolve, reject) => {
      const until = Date.now() + 5000; const poll = () => { const current = exports.list(project.id).find(item => item.id === job.id); if (['done', 'failed', 'cancelled'].includes(current.status)) resolve(current); else if (Date.now() > until) reject(Error('export timeout')); else setTimeout(poll, 10); }; poll();
    });
    assert.equal(done.status, 'done', done.error);
    if (as === 'folder') { assert.equal(await readFile(join(done.out, 'assets/mock.mp4'), 'utf8'), 'synthetic local video'); await assert.rejects(access(join(done.out, '.film/id'))); }
    else { const zipped = await readFile(done.out); assert.equal(zipped.readUInt32LE(0), 0x04034b50); assert.ok(zipped.includes(Buffer.from('Local project/film.html'))); assert.ok(zipped.includes(Buffer.from('Local project/assets/mock.mp4'))); }
  }
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'personal film');
});
