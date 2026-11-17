import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';
import { filmCaptions } from './captions.mjs';
import { probeSource } from './nle.mjs';
import { captureStructureExport, materializeStructureExport } from './structure-export-snapshot.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/selected-export-tests');
async function fixture(t) {
  await fs.mkdir(base, { recursive: true }); const dir = await fs.mkdtemp(join(base, 'case-')), root = join(dir, 'parent');
  t.after(async () => { assert.ok(dir.startsWith(base + sep)); await fs.rm(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => { throw Error('No paid calls or external network'); });
  await fs.mkdir(join(root, '.film'), { recursive: true }); await fs.mkdir(join(root, 'assets'));
  const file = join(root, 'assets/live.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=30:d=12', '-f', 'lavfi', '-i', 'aevalsrc=0.25*sin(2*PI*(400*t+50*t*t)):s=48000:d=12', '-c:v', 'libx264', '-crf', '12', '-g', '120', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', file], { windowsHide: true });
  const plan = { id: 'a', version: 'saved', speed: 1.3, durationMs: 2000, scope: { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 12000 }, clips: [
    { sourceId: 's', startMs: 1370, endMs: 2670, text: '保留第一段', roles: ['hook'], coreIds: [] },
    { sourceId: 's', startMs: 7370, endMs: 8670, text: '保留第二段', roles: ['core'], coreIds: ['core'] },
  ] };
  await fs.writeFile(join(root, '.film/id'), 'isolated-source');
  await fs.writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 's', assetPath: 'assets/live.mp4', durationMs: 12000 }], products: [{ id: 'p', name: 'Fixture', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 12000 }], candidates: [] }));
  await fs.writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 160, h: 96 }, tracks: [] }));
  await fs.writeFile(join(root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n这一段<00:00:01.500>保留原话，<00:00:02.200>字幕不丢。\n\n00:00:07.000 --> 00:00:09.000\n第二段保留原话。\n');
  await fs.writeFile(join(root, 'assets/live.en.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nKeep the first caption.\n\n00:00:07.000 --> 00:00:09.000\nKeep the second caption.\n');
  const project = { id: 'isolated-source', path: root };
  return { dir, root, file, plan, project, mediaRoot: join(dir, 'batch/media'), capture: (id = 'a') => captureStructureExport(project, { plan: { ...plan, id }, itemRoot: join(dir, 'batch', id) }) };
}

test('selected export only stores used ranges, shares repeated footage, and keeps exact source-time selection', { timeout: 60000 }, async t => {
  const f = await fixture(t), mediaCache = new Map(), original = await fs.readFile(f.file);
  const copy = fs.copyFile; let fullCopies = 0;
  t.mock.method(fs, 'copyFile', async (from, ...args) => { if (resolve(from) === resolve(f.file)) fullCopies++; return copy(from, ...args); });
  const a = await f.capture('a'), b = await f.capture('b'); assert.equal(a.version, 2);
  const first = await materializeStructureExport(a, { mediaRoot: f.mediaRoot, mediaCache });
  const second = await materializeStructureExport(b, { mediaRoot: f.mediaRoot, mediaCache });
  const clips = readFilmFile(await fs.readFile(join(first.exportRoot, 'film.html'), 'utf8')).value.tracks[0].clips;
  const secondClips = readFilmFile(await fs.readFile(join(second.exportRoot, 'film.html'), 'utf8')).value.tracks[0].clips;
  const media = (await fs.readdir(f.mediaRoot)).filter(name => name.endsWith('.mp4'));
  assert.equal(media.length, 2); assert.equal(fullCopies, 0);
  let bytes = 0;
  for (let i = 0; i < clips.length; i++) {
    const output = join(first.exportRoot, clips[i].src), facts = await probeSource(output);
    bytes += (await fs.stat(output)).size;
    assert.ok(Math.abs(facts.duration - 1.3) < 0.08); assert.equal(facts.hasAudio, true);
    assert.deepEqual([facts.w, facts.h], [160, 96]);
    assert.deepEqual(clips[i].time, [0, 1.3]);
    assert.equal(clips[i].speed, 1.3);
    assert.equal((await fs.stat(output)).ino, (await fs.stat(join(second.exportRoot, secondClips[i].src))).ino);
    const frame = (file, at) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=32:24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
    // Compare the frame displayed at this source time, not the next frame returned by an independent seek.
    const sourceFrame = Math.floor((f.plan.clips[i].startMs / 1000 + 0.4) * 30);
    const expected = execFileSync('ffmpeg', ['-v', 'error', '-i', f.file, '-vf', `select=eq(n\\,${sourceFrame}),scale=32:24`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true }), actual = frame(output, 0.4);
    assert.equal(actual.length, expected.length);
    const mse = actual.reduce((sum, value, index) => sum + (value - expected[index]) ** 2, 0) / actual.length;
    assert.ok(Math.sqrt(mse) < 10, `selected frame mismatch: ${mse}`);
    const sound = (file, at) => {
      const pcm = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-t', '1', '-vn', '-ar', '16000', '-ac', '1', '-f', 'f32le', '-'], { windowsHide: true });
      return Array.from({ length: pcm.length / 4 }, (_, k) => pcm.readFloatLE(k * 4));
    };
    const expectedAudio = sound(f.file, f.plan.clips[i].startMs / 1000), actualAudio = sound(output, 0);
    let best = -Infinity, lag = Infinity;
    for (let shift = -320; shift <= 320; shift += 4) {
      let dot = 0, aa = 0, bb = 0;
      for (let k = 500; k < Math.min(expectedAudio.length, actualAudio.length) - 500; k++) { const a = expectedAudio[k], b = actualAudio[k + shift]; dot += a * b; aa += a * a; bb += b * b; }
      const correlation = dot / Math.sqrt(aa * bb);
      if (correlation > best) { best = correlation; lag = shift; }
    }
    assert.ok(best > 0.97 && Math.abs(lag) <= 32, `audio source-time mismatch: correlation=${best}, lag=${lag}`);
  }
  assert.ok(bytes < original.length * 0.7, 'media volume follows the selected ranges');
  assert.deepEqual(await fs.readFile(f.file), original);
  await fs.rename(f.file, f.file + '.offline');
  assert.equal((await materializeStructureExport(a, { mediaRoot: f.mediaRoot, mediaCache: new Map() })).exportRoot, first.exportRoot, 'completed selected export remains independent of the original');
});

test('private captions, translations, order and mixed speeds survive selected media rebasing', { timeout: 60000 }, async t => {
  const f = await fixture(t), draft = await ensureStructureDraft(f.root, { parentProjectId: f.project.id, plan: f.plan });
  const edited = filmHtml({ stage: { w: 160, h: 96 }, tracks: [{ clips: [
    { id: 'second', src: 'assets/live.mp4', time: [7.37, 8.67], speed: 1.3, at: 0 },
    { id: 'first', src: 'assets/live.mp4', time: [1.37, 2.67], speed: 2, at: 1 },
  ] }] });
  await fs.writeFile(join(draft.root, 'film.html'), edited);
  const before = await filmCaptions(draft.root);
  const snapshot = await f.capture(), prepared = await materializeStructureExport(snapshot, { mediaRoot: f.mediaRoot, mediaCache: new Map() });
  const after = await filmCaptions(prepared.exportRoot);
  const comparable = value => value.cues.map(({ startMs, durMs, text, alt, words }) => ({ startMs, durMs, text, alt, words }));
  assert.deepEqual(comparable(after), comparable(before));
  assert.equal(await fs.readFile(join(draft.root, 'film.html'), 'utf8'), edited);
});

test('space checks use selected duration and interrupted or changed selections are not accepted', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = await f.capture(), mediaCache = new Map();
  t.mock.method(fs, 'statfs', async () => ({ bavail: 0, bsize: 1 }));
  await assert.rejects(materializeStructureExport(a, { mediaRoot: f.mediaRoot, mediaCache }), e => e.code === 'ENOSPC' && /所用片段/.test(e.message));
  assert.deepEqual(await fs.readdir(f.mediaRoot), []);
  await fs.appendFile(f.file, 'changed');
  await assert.rejects(materializeStructureExport(a, { mediaRoot: f.mediaRoot, mediaCache: new Map() }), /原片.*变化/);
});

test('changed selected media is rejected on resume and when another plan reuses the persisted cache', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = await f.capture('a'), b = await f.capture('b');
  const first = await materializeStructureExport(a, { mediaRoot: f.mediaRoot });
  const clip = readFilmFile(await fs.readFile(join(first.exportRoot, 'film.html'), 'utf8')).value.tracks[0].clips[0];
  await fs.appendFile(join(first.exportRoot, clip.src), 'changed');
  await assert.rejects(materializeStructureExport(a, { mediaRoot: f.mediaRoot }), /选段导出内容已变化/);
  await assert.rejects(materializeStructureExport(b, { mediaRoot: f.mediaRoot }), /已保存选段发生变化/);
});

test('destinations without hard links copy only the selected short media', { timeout: 60000 }, async t => {
  const f = await fixture(t), a = await f.capture(), original = await fs.readFile(f.file);
  const copy = fs.copyFile, copiedVideos = [];
  t.mock.method(fs, 'link', async () => { throw Object.assign(Error('No hard links'), { code: 'ENOTSUP' }); });
  t.mock.method(fs, 'copyFile', async (from, ...args) => {
    if (from.endsWith('.mp4')) { assert.notEqual(resolve(from), resolve(f.file)); copiedVideos.push((await fs.stat(from)).size); }
    return copy(from, ...args);
  });
  await materializeStructureExport(a, { mediaRoot: f.mediaRoot });
  assert.equal(copiedVideos.length, 2);
  assert.ok(copiedVideos.reduce((a, b) => a + b, 0) < original.length * 0.7);
  assert.deepEqual(await fs.readFile(f.file), original);
});

test('legacy full-file source identities must still match before selected ranges are saved', { timeout: 60000 }, async t => {
  const f = await fixture(t), bytes = await fs.readFile(f.file);
  const manifest = sha256 => JSON.stringify({ version: 1, items: { 'assets/live.mp4': { mode: 'copy', size: bytes.length, sha256 } } });
  await fs.writeFile(join(f.root, 'assets/.daocut-source-media.json'), manifest('a'.repeat(64)));
  await assert.rejects(materializeStructureExport(await f.capture('bad'), { mediaRoot: f.mediaRoot }), /原片内容与保存的身份不一致/);
  assert.deepEqual(await fs.readdir(f.mediaRoot), []);
  await fs.writeFile(join(f.root, 'assets/.daocut-source-media.json'), manifest(createHash('sha256').update(bytes).digest('hex')));
  await materializeStructureExport(await f.capture('good'), { mediaRoot: f.mediaRoot });
  assert.equal((await fs.readdir(f.mediaRoot)).filter(n => n.endsWith('.mp4')).length, 2);
});
