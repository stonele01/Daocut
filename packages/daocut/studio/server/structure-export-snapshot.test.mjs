import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm } from './film.mjs';
import { ensureStructureDraft, listStructureDrafts } from './structure-drafts.mjs';
import { captureStructureExport, materializeStructureExport } from './structure-export-snapshot.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/structure-export-snapshots');
const read = (root, path) => fs.readFile(join(root, path), 'utf8');
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(join(base, 'case-')), root = join(dir, 'parent');
  t.after(async () => { assert.ok(resolve(dir).startsWith(base + sep)); await fs.rm(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real model or network'); });
  await fs.mkdir(join(root, 'assets'), { recursive: true }); await fs.mkdir(join(root, '.film'));
  await fs.writeFile(join(root, '.film/id'), 'parent-id\n');
  await fs.writeFile(join(root, 'assets/live.mp4'), 'synthetic immutable source');
  await fs.writeFile(join(root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n原始字幕\n');
  await fs.writeFile(join(root, '.film/settings.json'), JSON.stringify({ fps: 25 }));
  await fs.writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 720, h: 1280 }, tracks: [{ clips: [{ id: 'existing', src: 'assets/live.mp4', time: [15, 17] }] }] }));
  await fs.writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 'source', assetPath: 'assets/live.mp4', durationMs: 20000 }], intervals: [{ id: 'lecture', sourceId: 'source', productId: 'product', startMs: 0, endMs: 20000 }], products: [], candidates: [] }));
  const plan = { id: 'plan-a', version: 'v1', speed: 1, durationMs: 6000, scope: { sourceId: 'source', productId: 'product', intervalId: 'lecture', startMs: 0, endMs: 20000 }, clips: [
    { sourceId: 'source', startMs: 1000, endMs: 3000, text: '完整钩子', roles: ['hook'], coreIds: [] },
    { sourceId: 'source', startMs: 7000, endMs: 9000, text: '完整卖点', roles: ['core'], coreIds: ['core-a'] },
    { sourceId: 'source', startMs: 12000, endMs: 14000, text: '完整逼单', roles: ['purchase'], coreIds: [] },
  ] };
  const project = { id: 'parent-id', name: 'Synthetic', path: root };
  return { dir, root, project, plan, item: name => join(dir, 'batch', name), mediaRoot: join(dir, 'batch/media') };
}

test('capture public plan freezes only small files without making a personal draft or changing parent film', async t => {
  const f = await fixture(t), before = await read(f.root, 'film.html');
  const result = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') });
  assert.equal(result.origin, 'public'); assert.match(result.revision, /^[a-f0-9]{64}$/); assert.equal(result.fps, 25);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.media.length, 1); assert.equal(result.media[0].assetPath, 'assets/live.mp4');
  await assert.rejects(fs.stat(join(result.root, 'assets/live.mp4')), { code: 'ENOENT' });
  assert.deepEqual((await readProjectFilm(result.root)).value.tracks[0].clips.map(c => c.time), [[1, 3], [7, 9], [12, 14]]);
  assert.equal((await listStructureDrafts(f.root)).length, 0);
  assert.equal(await read(f.root, 'film.html'), before);
  await assert.rejects(captureStructureExport(f.project, { plan: f.plan, itemRoot: result.root }), /存在|existing/i);
});

test('private plan version wins and captured order trim subtitles style and settings survive later edits', async t => {
  const f = await fixture(t), draft = await ensureStructureDraft(f.root, { parentProjectId: f.project.id, plan: f.plan });
  const privateFilm = filmHtml({ stage: { w: 1080, h: 1080 }, tracks: [{ clips: [{ id: 'edited-2', src: 'assets/live.mp4', time: [7.5, 8.5], at: 0, volume: 0.4 }, { id: 'edited-1', src: 'assets/live.mp4', time: [1, 2], at: 1 }] }] });
  await fs.writeFile(join(draft.root, 'film.html'), privateFilm);
  await fs.writeFile(join(draft.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n个人字幕\n');
  await fs.writeFile(join(draft.root, '.film/subtitles.json'), JSON.stringify({ on: false, color: '#ff0000' }));
  await fs.writeFile(join(draft.root, '.film/settings.json'), JSON.stringify({ fps: 50 }));
  const captured = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('private') });
  assert.equal(captured.origin, 'private'); assert.equal(captured.fps, 50); assert.equal(captured.sourceProjectId, (await read(draft.root, '.film/id')).trim());
  await fs.writeFile(join(draft.root, 'film.html'), 'later user edit');
  await fs.writeFile(join(draft.root, 'assets/live.vtt'), 'later subtitle');
  await fs.writeFile(join(draft.root, '.film/subtitles.json'), '{}');
  assert.equal(await read(captured.root, 'film.html'), privateFilm);
  assert.match(await read(captured.root, 'assets/live.vtt'), /个人字幕/);
  assert.equal(JSON.parse(await read(captured.root, '.film/subtitles.json')).color, '#ff0000');
  assert.equal(JSON.parse(await read(captured.root, '.film/settings.json')).fps, 50);
  await materializeStructureExport(JSON.parse(JSON.stringify(captured)), { mediaRoot: f.mediaRoot, mediaCache: new Map() });
  assert.equal(await read(captured.root, 'assets/live.mp4'), 'synthetic immutable source');
  assert.equal(await read(draft.root, 'film.html'), 'later user edit');
});

test('two captured plans share one batch copy with hard links while original media remains independent', async t => {
  const f = await fixture(t), cache = new Map(), originalCopy = fs.copyFile;
  let copied = 0; t.mock.method(fs, 'copyFile', async (...args) => { if (String(args[0]).endsWith('live.mp4')) copied++; return originalCopy(...args); });
  const a = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') });
  const b = await captureStructureExport(f.project, { plan: { ...f.plan, id: 'plan-b' }, itemRoot: f.item('b') });
  assert.equal(copied, 0);
  await Promise.all([materializeStructureExport(a, { mediaRoot: f.mediaRoot, mediaCache: cache }), materializeStructureExport(b, { mediaRoot: f.mediaRoot, mediaCache: cache })]);
  assert.equal(copied, 1);
  const sa = await fs.stat(join(a.root, 'assets/live.mp4')), sb = await fs.stat(join(b.root, 'assets/live.mp4')), original = await fs.stat(join(f.root, 'assets/live.mp4'));
  assert.equal(sa.ino, sb.ino); assert.notEqual(sa.ino, original.ino);
  assert.equal((await fs.readdir(f.mediaRoot)).length, 1);
  await fs.writeFile(join(f.root, 'assets/live.mp4'), 'original later changed');
  assert.equal(await read(a.root, 'assets/live.mp4'), 'synthetic immutable source');
});

test('media changed after capture is rejected instead of exporting newer bytes', async t => {
  const f = await fixture(t), captured = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') });
  await fs.writeFile(join(f.root, 'assets/live.mp4'), 'replacement source');
  await assert.rejects(materializeStructureExport(captured, { mediaRoot: f.mediaRoot, mediaCache: new Map() }), /变化|changed/i);
  await assert.rejects(fs.stat(join(captured.root, 'assets/live.mp4')), { code: 'ENOENT' });
});

test('a concurrent private-document change prevents snapshot publication', async t => {
  const f = await fixture(t), originalRead = fs.readFile; let changed = false;
  t.mock.method(fs, 'readFile', async (...args) => {
    const value = await originalRead(...args);
    if (!changed && String(args[0]) === join(f.root, '.film/settings.json')) { changed = true; await fs.writeFile(join(f.root, 'film.html'), 'concurrent film edit'); }
    return value;
  });
  await assert.rejects(captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') }), /变化|changed/i);
  await assert.rejects(fs.stat(f.item('a')), { code: 'ENOENT' });
});

test('unsupported webpage dependency is explicit and does not create an incomplete export', async t => {
  const f = await fixture(t), draft = await ensureStructureDraft(f.root, { parentProjectId: f.project.id, plan: f.plan });
  await fs.writeFile(join(draft.root, 'film.html'), filmHtml({ stage: { w: 720, h: 1280 }, tracks: [{ clips: [{ id: 'page', src: 'page.html', duration: 3 }] }] }));
  await assert.rejects(captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') }), /网页|不支持|unsupported/i);
});

test('missing hard-link capability fails without making per-plan copies', async t => {
  const f = await fixture(t), captured = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') });
  t.mock.method(fs, 'link', async () => { throw Object.assign(Error('cross-device'), { code: 'EXDEV' }); });
  await assert.rejects(materializeStructureExport(captured, { mediaRoot: f.mediaRoot, mediaCache: new Map() }), /硬链接|hard.link/i);
  await assert.rejects(fs.stat(join(captured.root, 'assets/live.mp4')), { code: 'ENOENT' });
});

test('another version private draft cannot replace the selected public plan', async t => {
  const f = await fixture(t); await ensureStructureDraft(f.root, { parentProjectId: f.project.id, plan: { ...f.plan, version: 'older' } });
  const captured = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') });
  assert.equal(captured.origin, 'public'); assert.equal((await listStructureDrafts(f.root)).length, 1);
});

test('media changed during copy never publishes its inconsistent bytes', async t => {
  const f = await fixture(t), captured = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') }), copy = fs.copyFile;
  t.mock.method(fs, 'copyFile', async (...args) => { await copy(...args); await fs.writeFile(join(f.root, 'assets/live.mp4'), 'changed while copying'); });
  await assert.rejects(materializeStructureExport(captured, { mediaRoot: f.mediaRoot, mediaCache: new Map() }), /变化|changed/i);
  assert.deepEqual(await fs.readdir(f.mediaRoot), []);
});

test('a corrupted batch copy is rejected after the in-memory cache is gone', async t => {
  const f = await fixture(t), a = await captureStructureExport(f.project, { plan: f.plan, itemRoot: f.item('a') });
  const b = await captureStructureExport(f.project, { plan: { ...f.plan, id: 'b' }, itemRoot: f.item('b') });
  await materializeStructureExport(a, { mediaRoot: f.mediaRoot, mediaCache: new Map() });
  const original = await fs.readFile(join(a.root, 'assets/live.mp4'));
  const corrupt = Buffer.from(original); corrupt[0] ^= 1;
  await fs.writeFile(join(a.root, 'assets/live.mp4'), corrupt);
  await assert.rejects(materializeStructureExport(b, { mediaRoot: f.mediaRoot, mediaCache: new Map() }), /身份|变化|不一致|changed/i);
});
