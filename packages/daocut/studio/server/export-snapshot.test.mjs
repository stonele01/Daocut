import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { createExports } from './exports.mjs';
import { filmHtml } from '../../src/film-doc.mjs';

const base = fileURLToPath(new URL('../../../../.tmp/batch-export-tests/', import.meta.url));
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'snapshot-'));
  const root = join(dir, 'snapshot'), folder = join(dir, 'batch');
  await mkdir(join(root, 'assets'), { recursive: true });
  const queue = createExports({ drafts: () => { throw Error('Must not consult the installed Jianying folder'); }, captions: async () => ({ cues: [], style: {} }) });
  t.after(async () => { await queue.stopAll(); assert.ok(resolve(dir).startsWith(resolve(base) + sep)); await rm(dir, { recursive: true, force: true }); });
  return { root, folder, queue, project: { id: 'isolated-batch', name: '方案 001', path: root } };
}

test('frozen export entry only accepts an explicit Jianying link export destination', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.queue.startSnapshot, 'function');
  for (const ask of [{ kind: 'video' }, { kind: 'nle', format: 'jianying', media: 'copy', folder: f.folder }, { kind: 'nle', format: 'jianying', media: 'link' }]) {
    assert.throws(() => f.queue.startSnapshot(f.project, ask));
  }
  assert.equal(f.queue.list(f.project.id).length, 0);
});

test('frozen Jianying export uses its batch folder and references one snapshot source', { timeout: 60000 }, async t => {
  const f = await fixture(t), source = join(f.root, 'assets/live.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x96:r=10', '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
  const text = filmHtml({ stage: { w: 96, h: 96 }, tracks: [{ clips: [{ id: 'frozen-clip', src: 'assets/live.mp4', at: 0, time: [0, 0.4] }] }] });
  await writeFile(join(f.root, 'film.html'), text);
  const receipt = { batchId: 'a'.repeat(24), itemId: '001', revision: 'b'.repeat(64) };
  const job = f.queue.startSnapshot(f.project, { kind: 'nle', format: 'jianying', media: 'link', subtitles: false, folder: f.folder, receipt });
  let current;
  do { await new Promise(r => setTimeout(r, 50)); current = f.queue.list(f.project.id).find(item => item.id === job.id); } while (['running', 'waiting'].includes(current.status));
  assert.equal(current.status, 'done', current.error);
  assert.ok(resolve(current.outputs[0]).startsWith(resolve(f.folder) + sep));
  const draftRoot = dirname(current.outputs[0]);
  const savedReceipt = JSON.parse(await readFile(join(draftRoot, '.daocut-structure-export.json'), 'utf8'));
  assert.deepEqual({ batchId: savedReceipt.batchId, itemId: savedReceipt.itemId, revision: savedReceipt.revision }, receipt);
  for (const name of ['draft_info.json', 'draft_content.json', 'draft_meta_info.json']) assert.equal(savedReceipt.files[name], createHash('sha256').update(await readFile(join(draftRoot, name))).digest('hex'));
  assert.ok(current.outputs.every(path => !path.endsWith('.daocut-structure-export.json')), 'internal receipt must not appear as an exported user file');
  const draft = JSON.parse(await readFile(join(draftRoot, 'draft_content.json'), 'utf8'));
  assert.equal(draft.materials.videos.length, 1);
  assert.equal(resolve(draft.materials.videos[0].path), resolve(source));
  const media = await readdir(join(draftRoot, 'media')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(media.filter(name => name.endsWith('.mp4')).length, 0);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), text);
});
