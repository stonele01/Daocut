import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm } from './film.mjs';
import { filmCaptions } from './captions.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';
import { createStructureBatchExports } from './structure-batch-exports.mjs';
import { createExports } from './exports.mjs';

const run = promisify(execFile);
const base = resolve(import.meta.dirname, '../../../../.tmp/structure-speed-export-integration');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const protectedState = async (root, paths) => Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))]));

test('v2 public and edited private clips export their frozen 1.3x picture audio and caption timing through the existing Jianying exporter', { timeout: 180000 }, async t => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'project'), output = join(dir, 'exports');
  const envKeys = ['TMP', 'TEMP', 'TMPDIR', 'DAOCUT_STUDIO_HOME', 'DAOCUT_HOME', 'DAOCUT_SHARED_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_EXPORTS', 'DAOCUT_NO_UPDATE_CHECK'];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const name of ['tmp', 'studio', 'shared', 'library', 'exports']) await mkdir(join(dir, name));
  process.env.TMP = process.env.TEMP = process.env.TMPDIR = join(dir, 'tmp');
  process.env.DAOCUT_HOME = process.env.DAOCUT_STUDIO_HOME = join(dir, 'studio');
  process.env.DAOCUT_SHARED_HOME = join(dir, 'shared'); process.env.DAOCUT_LIBRARY = join(dir, 'library');
  process.env.DAOCUT_EXPORTS = output; process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  let manager, exporter;
  t.after(async () => {
    await manager?.stop(); await exporter?.stopAll();
    for (const key of envKeys) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
    assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true });
  });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'external network and model calls are forbidden');
    return fetch(input, options);
  });
  await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(join(root, '.film'));
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=90x160:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '5.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(root, 'assets/live.mp4')], { windowsHide: true, timeout: 15000 });
  const project = { id: 'speed-parent', name: '倍速隔离验收', path: root };
  const scope = { sourceId: 'source', productId: 'product', intervalId: 'lecture', startMs: 0, endMs: 5200 };
  await writeFile(join(root, '.film/id'), `${project.id}\n`);
  await writeFile(join(root, '.film/settings.json'), JSON.stringify({ fps: 25 }));
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [{ clips: [{ id: 'existing', src: 'assets/live.mp4', time: [0, 1] }] }] }));
  const subtitles = 'WEBVTT\n\n00:00:00.520 --> 00:00:01.560\n公共钩子\n\n00:00:02.080 --> 00:00:03.120\n公共卖点\n\n00:00:03.640 --> 00:00:04.680\n公共逼单\n';
  await writeFile(join(root, 'assets/live.vtt'), subtitles);
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 'source', assetPath: 'assets/live.mp4', durationMs: 5200 }], products: [{ id: 'product', sourceIds: ['source'] }], intervals: [{ ...scope, id: 'lecture' }], candidates: [] }));
  const plan = id => ({ id, version: 'ai-structure-plans-v2', scope, speed: 1.3, durationMs: 2400, clips: [
    { sourceId: 'source', candidateId: 'slice-hook', parentCandidateId: 'mother-hook', cueRange: [1, 1], startMs: 520, endMs: 1560, text: '公共钩子', roles: ['hook'], coreIds: [] },
    { sourceId: 'source', candidateId: 'slice-core', parentCandidateId: 'mother-core', cueRange: [3, 3], startMs: 2080, endMs: 3120, text: '公共卖点', roles: ['core'], coreIds: ['core'] },
    { sourceId: 'source', candidateId: 'slice-purchase', parentCandidateId: 'mother-purchase', cueRange: [5, 5], startMs: 3640, endMs: 4680, text: '公共逼单', roles: ['purchase'], coreIds: [] },
  ] });
  const plans = [plan('plan-a'), plan('plan-b')];
  const legacy = await ensureStructureDraft(root, { parentProjectId: project.id, plan: { ...plans[0], version: 'ai-structure-plans-v1', speed: 1, durationMs: 3120 } });
  const personal = await ensureStructureDraft(root, { parentProjectId: project.id, plan: plans[1] });
  assert.deepEqual((await readProjectFilm(personal.root)).value.stage, { w: 90, h: 160 });
  const privateFilm = filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [{ clips: [
    { id: 'private-core', src: 'assets/live.mp4', at: 0, time: [2.6, 3.12], speed: 1.3 },
    { id: 'private-hook', src: 'assets/live.mp4', at: 0.4, time: [1.04, 1.56], speed: 1.3 },
    { id: 'private-purchase', src: 'assets/live.mp4', at: 0.8, time: [4.16, 4.68], speed: 1.3 },
  ] }] });
  await writeFile(join(personal.root, 'film.html'), privateFilm);
  await writeFile(join(personal.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:01.040 --> 00:00:01.560\n私人钩子\n\n00:00:02.600 --> 00:00:03.120\n私人卖点\n\n00:00:04.160 --> 00:00:04.680\n私人逼单\n');
  const protectedFiles = ['film.html', 'assets/live.mp4', 'assets/live.vtt', '.film/product-analysis.json', '.film/settings.json'];
  const before = await protectedState(root, protectedFiles), oldFilm = await readFile(join(legacy.root, 'film.html'), 'utf8');
  let installationLookups = 0;
  exporter = createExports({ drafts: () => { installationLookups++; throw Error('Installed Jianying folders must not be inspected'); } });
  const taskKey = digest(JSON.stringify(plans));
  manager = createStructureBatchExports({ plans: { status: async () => ({ status: 'complete', taskKey, context: { ...scope, visibility: 'local' }, plans }) }, exports: exporter, outputRoot: () => output, pollMs: 20 });
  const batch = await manager.create(project, { ...scope, taskKey, planIds: plans.map(plan => plan.id), requestId: randomUUID(), folder: output, name: '倍速模拟导出' });
  assert.deepEqual(batch.items.map(item => item.origin), ['public', 'private']);
  const laterFilm = filmHtml({ stage: { w: 160, h: 90 }, tracks: [{ clips: [{ id: 'later', src: 'assets/live.mp4', time: [0, 2], speed: 2 }] }] });
  await writeFile(join(personal.root, 'film.html'), laterFilm);
  await writeFile(join(personal.root, 'assets/live.vtt'), subtitles.replaceAll('公共', '稍后修改'));
  const finished = await manager.wait(project, batch.id);
  assert.equal(finished.status, 'complete', JSON.stringify(finished.items)); assert.equal(finished.completed, 2);
  assert.equal(installationLookups, 0);
  for (const [index, item] of finished.items.entries()) {
    const info = await json(item.outputs[0]), segmentUs = index ? 400000 : 800000;
    const segments = kind => info.tracks.filter(track => track.type === kind).flatMap(track => track.segments).sort((a, b) => a.target_timerange.start - b.target_timerange.start);
    const expected = [0, 1, 2].map(position => ({ start: position * segmentUs, duration: segmentUs }));
    assert.equal(info.duration, segmentUs * 3);
    assert.deepEqual(segments('video').map(clip => clip.target_timerange), expected);
    assert.deepEqual(segments('audio'), [], 'original audio stays on the video, with no duplicate audio track');
    assert.deepEqual(info.canvas_config, { width: 90, height: 160, ratio: 'original' });
    const sourceStarts = index ? [2600000, 1040000, 4160000] : [520000, 2080000, 3640000];
    for (const [i, clip] of segments('video').entries()) {
      assert.equal(clip.speed, 1.3);
      assert.equal(clip.volume, 1);
      assert.equal(clip.is_tone_modify, false);
      assert.deepEqual(clip.source_timerange, { start: sourceStarts[i], duration: Math.round(segmentUs * 1.3) });
      assert.deepEqual(clip.clip.scale, { x: 1, y: 1 });
      assert.equal(info.materials.speeds.find(speed => clip.extra_material_refs.includes(speed.id)).speed, 1.3);
    }
    assert.deepEqual(segments('text').map(clip => clip.target_timerange), expected, JSON.stringify(await filmCaptions(join(finished.storageFolder, '_snapshots', item.id))));
    const words = info.materials.texts.map(material => JSON.parse(material.content).text).join(' ');
    assert.match(words, index ? /私人卖点.*私人钩子.*私人逼单/ : /公共钩子.*公共卖点.*公共逼单/);
    assert.doesNotMatch(words, /稍后修改/);
    assert.equal(info.materials.videos.length, 1, 'all cuts share the frozen original');
    assert.equal(info.materials.audios.length, 0);
    for (const material of [...info.materials.videos, ...info.materials.audios]) {
      assert.ok(resolve(material.path).startsWith(resolve(finished.storageFolder) + sep));
      assert.equal(digest(await readFile(material.path)), digest(await readFile(join(root, 'assets/live.mp4'))), 'no rendered intermediary replaces the original');
    }
    const snapshotRoot = join(finished.storageFolder, '_snapshots', item.id);
    const frozen = (await readProjectFilm(snapshotRoot)).value.tracks[0].clips;
    assert.ok(frozen.every(clip => clip.speed === 1.3));
    assert.deepEqual(frozen.map(clip => clip.time), index ? [[2.6, 3.12], [1.04, 1.56], [4.16, 4.68]] : [[0.52, 1.56], [2.08, 3.12], [3.64, 4.68]]);
  }
  assert.deepEqual(await protectedState(root, protectedFiles), before);
  assert.equal(await readFile(join(legacy.root, 'film.html'), 'utf8'), oldFilm);
  assert.equal(await readFile(join(personal.root, 'film.html'), 'utf8'), laterFilm);
});
