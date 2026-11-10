import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { ensureStructureDraft, listStructureDrafts } from './structure-drafts.mjs';
import { createStructureBatchExports } from './structure-batch-exports.mjs';
import { createExports } from './exports.mjs';

const run = promisify(execFile);
const base = resolve(import.meta.dirname, '../../../../.tmp/structure-batch-integration');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const protectedBytes = async (root, files) => Promise.all(files.map(async file => [file, digest(await readFile(join(root, file)))]));

for (const destination of ['folder', 'jianying']) test(`selected public and private plans export separate real Jianying drafts from frozen edits and one media copy (${destination})`, { timeout: 60000 }, async t => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'project'), output = join(dir, 'exports');
  const envKeys = ['TMP', 'TEMP', 'TMPDIR', 'DAOCUT_STUDIO_HOME', 'DAOCUT_EXPORTS'];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  await mkdir(join(dir, 'tmp')); await mkdir(join(dir, 'studio')); await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(join(root, '.film'));
  process.env.TMP = process.env.TEMP = process.env.TMPDIR = join(dir, 'tmp');
  process.env.DAOCUT_STUDIO_HOME = join(dir, 'studio'); process.env.DAOCUT_EXPORTS = output;
  let manager, exporter;
  t.after(async () => {
    await manager?.stop(); await exporter?.stopAll();
    for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
    assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true });
  });
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Real model or external network forbidden');
    return realFetch(input, options);
  });
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(root, 'assets/live.mp4')], { windowsHide: true, timeout: 15000 });
  const project = { id: 'integration-parent', name: '合成结构视频', path: root };
  const scope = { sourceId: 'source', productId: 'product', intervalId: 'lecture', startMs: 0, endMs: 2000 };
  await writeFile(join(root, '.film/id'), `${project.id}\n`);
  await writeFile(join(root, '.film/settings.json'), JSON.stringify({ fps: 25 }));
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'existing-parent', src: 'assets/live.mp4', time: [0, 0.8] }] }] }));
  await writeFile(join(root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:00.400\n公共钩子\n\n00:00:00.600 --> 00:00:01.000\n公共卖点\n\n00:00:01.400 --> 00:00:01.800\n公共逼单\n');
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [{ id: 'source', assetPath: 'assets/live.mp4', durationMs: 2000 }], products: [{ id: 'product', name: '模拟商品' }], intervals: [{ ...scope, id: 'lecture' }], candidates: [] }));
  const plan = id => ({ id, version: 'fixture-v1', scope, speed: 1, durationMs: 1200, clips: [
    { sourceId: 'source', startMs: 0, endMs: 400, text: '公共钩子', roles: ['hook'], coreIds: [] },
    { sourceId: 'source', startMs: 600, endMs: 1000, text: '公共卖点', roles: ['core'], coreIds: ['core'] },
    { sourceId: 'source', startMs: 1400, endMs: 1800, text: '公共逼单', roles: ['purchase'], coreIds: [] },
  ] });
  const plans = [plan('plan-a'), plan('plan-b'), plan('plan-c')];
  const taskKey = digest(JSON.stringify(plans)), publicFile = '.film/mock-public-plans.json';
  const publicState = { status: 'complete', taskKey, context: { ...scope, visibility: 'shared' }, plans };
  await writeFile(join(root, publicFile), JSON.stringify(publicState));
  const draftB = await ensureStructureDraft(root, { parentProjectId: project.id, plan: plans[1] });
  const draftC = await ensureStructureDraft(root, { parentProjectId: project.id, plan: plans[2] });
  const editedB = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [
    { id: 'private-core', src: 'assets/live.mp4', at: 0, time: [0.64, 1.0] },
    { id: 'private-hook', src: 'assets/live.mp4', at: 0.36, time: [0.04, 0.4] },
    { id: 'private-close', src: 'assets/live.mp4', at: 0.72, time: [1.4, 1.76] },
  ] }] });
  const privateVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:00.400\n私人钩子B\n\n00:00:00.600 --> 00:00:01.000\n私人卖点B\n\n00:00:01.400 --> 00:00:01.800\n私人逼单B\n';
  await writeFile(join(draftB.root, 'film.html'), editedB); await writeFile(join(draftB.root, 'assets/live.vtt'), privateVtt);
  const protectedFiles = ['film.html', 'assets/live.mp4', 'assets/live.vtt', '.film/settings.json', '.film/product-analysis.json', publicFile];
  const before = await protectedBytes(root, protectedFiles);
  const cFiles = ['film.html', 'assets/live.vtt', '.film/settings.json', '.film/subtitles.json', '.film/structure-draft.json'];
  const cBefore = await protectedBytes(draftC.root, cFiles);
  let installationLookups = 0;
  exporter = createExports({ drafts: () => { installationLookups++; throw Error('Must never inspect or write installed Jianying drafts'); } });
  const chosenFolder = join(output, '用户指定输出');
  await mkdir(chosenFolder, { recursive: true });
  await mkdir(join(chosenFolder, '其他人已有草稿')); await writeFile(join(chosenFolder, '其他人已有草稿', 'draft_info.json'), 'unchanged colleague draft');
  manager = createStructureBatchExports({ plans: { status: async () => json(join(root, publicFile)) }, exports: exporter, outputRoot: () => output, draftsRoot: () => chosenFolder, pollMs: 20 });
  const created = await manager.create(project, { ...scope, taskKey, planIds: ['plan-b', 'plan-a'], requestId: randomUUID(), name: '验收随行杯', folder: chosenFolder, destination });
  assert.equal(destination === 'jianying' ? created.folder : dirname(created.folder), chosenFolder);
  assert.equal(created.storageFolder, destination === 'jianying' ? join(chosenFolder, '.daocut-structure-batches', created.id) : created.folder);
  assert.equal(created.total, 2); assert.deepEqual(created.items.map(item => item.planId), ['plan-a', 'plan-b']);
  assert.deepEqual(created.items.map(item => item.origin), ['public', 'private']);
  const laterFilm = filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'later', src: 'assets/live.mp4', time: [0, 1.8] }] }] });
  await writeFile(join(draftB.root, 'film.html'), laterFilm); await writeFile(join(draftB.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.800\n导出后继续编辑\n');
  const finished = await manager.wait(project, created.id);
  assert.equal(finished.status, 'complete', JSON.stringify(finished.items)); assert.equal(finished.completed, 2);
  assert.equal(installationLookups, 0);
  assert.equal(exporter.list(project.id).length, 2);
  const drafts = await Promise.all(finished.items.map(async item => {
    assert.ok(item.outputs[0].endsWith('draft_info.json'), 'real export output is a file, not the draft directory');
    const folder = dirname(item.outputs[0]), info = await json(item.outputs[0]);
    assert.deepEqual(await json(join(folder, 'draft_content.json')), info);
    return { folder, info };
  }));
  assert.notEqual(drafts[0].folder, drafts[1].folder); assert.notEqual(drafts[0].info.id, drafts[1].info.id);
  assert.deepEqual(drafts.map(draft => basename(draft.folder)), ['验收随行杯_方案001', '验收随行杯_方案002']);
  assert.deepEqual(drafts.map(draft => draft.info.name), ['验收随行杯_方案001', '验收随行杯_方案002']);
  if (destination === 'jianying') assert.ok(drafts.every(draft => dirname(draft.folder) === chosenFolder), 'draft folders are direct children listed by Jianying');
  assert.equal(await readFile(join(chosenFolder, '其他人已有草稿', 'draft_info.json'), 'utf8'), 'unchanged colleague draft');
  const videos = info => info.tracks.filter(track => track.type === 'video').flatMap(track => track.segments).sort((a, b) => a.target_timerange.start - b.target_timerange.start);
  assert.deepEqual(videos(drafts[0].info).map(segment => segment.source_timerange), [{ start: 0, duration: 400000 }, { start: 600000, duration: 400000 }, { start: 1400000, duration: 400000 }]);
  assert.deepEqual(videos(drafts[1].info).map(segment => segment.source_timerange), [{ start: 640000, duration: 360000 }, { start: 40000, duration: 360000 }, { start: 1400000, duration: 360000 }]);
  const text = info => info.materials.texts.map(item => JSON.parse(item.content).text).join(' ');
  assert.match(text(drafts[0].info), /公共钩子/); assert.doesNotMatch(text(drafts[0].info), /私人|导出后/);
  assert.match(text(drafts[1].info), /私人卖点B/); assert.match(text(drafts[1].info), /私人钩子B/); assert.doesNotMatch(text(drafts[1].info), /公共|导出后/);
  const snapshotA = join(finished.storageFolder, '_snapshots/001/assets/live.mp4'), snapshotB = join(finished.storageFolder, '_snapshots/002/assets/live.mp4');
  assert.deepEqual((await readdir(join(finished.storageFolder, '_snapshots'))).sort(), ['001', '002']);
  const mediaNames = await readdir(join(finished.storageFolder, '_media')); assert.equal(mediaNames.length, 1);
  const media = join(finished.storageFolder, '_media', mediaNames[0]);
  const [aInfo, bInfo, mediaInfo, originalInfo] = await Promise.all([snapshotA, snapshotB, media, join(root, 'assets/live.mp4')].map(path => stat(path)));
  assert.equal(aInfo.ino, bInfo.ino); assert.equal(aInfo.ino, mediaInfo.ino); assert.notEqual(aInfo.ino, originalInfo.ino);
  for (const [index, draft] of drafts.entries()) assert.ok(draft.info.materials.videos.every(material => resolve(material.path) === resolve(index ? snapshotB : snapshotA)));
  assert.deepEqual(await protectedBytes(root, protectedFiles), before); assert.deepEqual(await protectedBytes(draftC.root, cFiles), cBefore);
  assert.equal(await readFile(join(draftB.root, 'film.html'), 'utf8'), laterFilm);
  assert.equal((await listStructureDrafts(root)).length, 2, 'public A export does not create a visible personal draft');
});
