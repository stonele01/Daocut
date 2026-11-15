// Real workflow, persistence and Jianying export; deterministic ASR/model fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { createProductWorkflow } from './product-workflow.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { transcriptionLocation } from './product-transcription.mjs';
import { createStructurePlanInputReader } from './structure-plans.mjs';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { AI_STRUCTURE_REQUIRED_PROMPT as AI_STRUCTURE_CURATED_PROMPT } from './ai-structure-required.mjs';
import { createStructureBatchExports } from './structure-batch-exports.mjs';
import { ensureStructureDraft } from './structure-drafts.mjs';
import { createExports } from './exports.mjs';

const run = promisify(execFile);
const base = resolve(import.meta.dirname, '../../../../.tmp/curated-workflow-integration');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('new video prepares, analyzes, composes different-length structures, reopens and batch-exports exact original clips', { timeout: 180000 }, async t => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'project'), output = join(dir, 'exports');
  const names = ['TMP', 'TEMP', 'TMPDIR', 'DAOCUT_HOME', 'DAOCUT_STUDIO_HOME', 'DAOCUT_SHARED_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_EXPORTS', 'DAOCUT_NO_UPDATE_CHECK'];
  const saved = Object.fromEntries(names.map(key => [key, process.env[key]]));
  for (const key of names.filter(key => key !== 'DAOCUT_NO_UPDATE_CHECK')) {
    process.env[key] = join(dir, key); await mkdir(process.env[key], { recursive: true });
  }
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  let batches, exporter;
  t.after(async () => {
    await batches?.stop(); await exporter?.stopAll();
    for (const key of names) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true });
  });
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only local rendering may use the network');
    return fetch(input, options);
  });
  await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(join(root, '.film')); await mkdir(output);
  const assetPath = 'assets/live.mp4', video = join(root, assetPath);
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '65', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', video], { windowsHide: true, timeout: 30000 });
  const project = { id: 'curated-flow', name: '全流程隔离测试', path: root };
  const originalFilm = filmHtml({ stage: { w: 160, h: 90 }, tracks: [] });
  await writeFile(join(root, '.film/id'), project.id); await writeFile(join(root, 'film.html'), originalFilm);
  const beforeVideo = sha(await readFile(video));
  const cues = [
    [0, 13000, '带饭时担心饭盒装不下吗？'],
    [13000, 26000, '这款是饭盒，饭菜可以分开放，一套三十九元。'],
    [26000, 32500, '今天卖的是双层饭盒。'],
    [32500, 39000, '这次饭盒一套三十九元。'],
    [39000, 52000, '这款饭盒双层保温，带饭到公司也方便。'],
    [52000, 65000, '想要这款饭盒的朋友，现在点击下方链接购买。'],
  ].map(([startMs, endMs, text]) => ({ startMs, endMs, text }));
  const counts = { asr: 0, discovery: 0, analysis: 0, composition: 0 };
  const services = { transcription: { enabled: true, provider: 'doubao', model: 'fixture-asr' }, text: { enabled: true, provider: 'deepseek', model: 'fixture-text' } };
  let requestedSequences, requestedTexts;
  const modelClient = async ({ system, input }) => {
    const body = JSON.parse(input);
    if (body.units) {
      counts.composition++;
      assert.equal(system, AI_STRUCTURE_CURATED_PROMPT, 'The production request must carry the current reference examples');
      assert.equal(body.previous, undefined);
      const id = index => body.units.find(unit => unit.text === cues[index].text)?.id;
      assert.deepEqual(new Set(body.openingIds), new Set([id(0), id(4)]));
      assert.ok(body.units.every(unit => unit.subject === 'self'));
      requestedSequences = [[id(0), id(1), id(5)], [id(4), id(2), id(3), id(5)]];
      requestedTexts = requestedSequences.map(sequence => sequence.map(id => body.units.find(unit => unit.id === id).text));
      return { schema: 'ai-structure-plans-v7', plans: requestedSequences };
    }
    if (body.intervalId) {
      counts.analysis++;
      return { schema: 'complete-speech-v1', candidates: cues.map((cue, index) => ({
        firstCue: index, lastCue: index, tags: [['痛点'], ['产品介绍', '卖点', '价格机制'], ['产品介绍'], ['价格机制'], ['卖点'], ['行动指令']][index],
        ...([1, 3].includes(index) ? { price: { kind: 'current', evidence: [index] } } : {}),
        subject: { kind: 'self', evidence: [index] },
        ...([0, 4].includes(index) ? { opening: { group: `饭盒诉求${index}`, followup: index ? '解释怎么使用以及活动条件' : '接饭盒容量卖点' } } : {}),
      })), issues: [] };
    }
    counts.discovery++;
    // Match saved pre-0.2.40 discovery: uncertain formal name, positively
    // assigned lecture, no newer scopeStatus field. It must still compose.
    return { products: [{ key: 'box', name: '模拟饭盒', variant: '', aliases: [], evidence: [1], identityUncertain: true }],
      ranges: [{ key: 'box', firstCue: 0, lastCue: 5, kind: 'lecture', reason: '连续讲解同一饭盒', evidence: [1, 4, 5] }], issues: ['品牌名称待核对'] };
  };
  const transcribe = async (projectRoot, source) => {
    counts.asr++;
    const location = await transcriptionLocation(projectRoot, source); await mkdir(location.dir, { recursive: true });
    const value = { cues, words: [] };
    await writeFile(location.path, JSON.stringify({ version: 1, status: 'complete', sourceId: source.id, assetPath, fingerprint: location.fingerprint, durationMs: source.durationMs, ...value }));
    return value;
  };
  const make = () => {
    const live = createLiveAnalysis({ transcribe, modelClient, modelIdentity: services.text });
    const discovery = createProductDiscovery({ modelClient, modelIdentity: services.text });
    const workflow = createProductWorkflow({ liveAnalysis: live, discovery, analysisServices: async () => services });
    const plans = createAiStructurePlans({ readInput: createStructurePlanInputReader({ liveAnalysis: live }), modelClient, modelIdentity: services.text });
    return { live, workflow, plans };
  };
  const current = make();
  const { source } = await current.workflow.registerSource(root, { assetPath });
  assert.equal((await readProductAnalysis(root)).analysis.products.length, 0);
  const execute = async (action, extra) => {
    const plan = await current.workflow.plan(root, { action, sourceId: source.id, ...extra });
    await current.workflow.execute(root, { confirmed: true, plan }); await current.workflow.wait(root, source.id);
  };
  await execute('transcription', { prepare: true });
  let analysis = (await readProductAnalysis(root)).analysis;
  assert.equal(analysis.products.length, 1, JSON.stringify(await current.workflow.status(root, source.id))); assert.equal(analysis.products[0].name, '模拟饭盒'); assert.equal(analysis.intervals.length, 1);
  assert.equal((await current.workflow.status(root, source.id)).discoveryReady, true);
  const interval = analysis.intervals[0], scope = { sourceId: source.id, productId: interval.productId, intervalId: interval.id, startMs: interval.startMs, endMs: interval.endMs };
  await execute('analysis', scope);
  analysis = (await readProductAnalysis(root)).analysis;
  assert.equal(analysis.candidates.length, 6); assert.ok(analysis.candidates.some(candidate => candidate.tags.includes('产品介绍')));
  const ready = await current.plans.status(root, scope);
  assert.equal(ready.confirmation?.enabled, true, JSON.stringify(ready));
  await current.plans.generate(root, { ...scope, confirmed: true, confirmationId: ready.confirmation.id }); await current.plans.wait();
  const state = await current.plans.status(root, scope);
  assert.equal(state.status, 'complete', JSON.stringify(state)); assert.equal(state.plans.length, 2);
  assert.deepEqual(state.plans.map(plan => plan.clips.length), [3, 4], 'Neither a fixed five-stage shape nor a fixed middle order is required');
  for (const [index, plan] of state.plans.entries()) {
    assert.equal(plan.speed, 1.3); assert.equal(plan.durationMs, 30000);
    assert.deepEqual(plan.clips.map(clip => clip.candidateId), requestedTexts[index].map(text => analysis.candidates.find(candidate => candidate.text === text).id));
    for (const clip of plan.clips) {
      const cue = cues.find(cue => cue.text === clip.text); assert.ok(cue);
      assert.deepEqual([clip.startMs, clip.endMs], [cue.startMs, cue.endMs]);
    }
  }
  assert.deepEqual(counts, { asr: 1, discovery: 1, analysis: 1, composition: 1 });
  const reopened = make(); await reopened.workflow.status(root, source.id);
  assert.deepEqual((await reopened.plans.status(root, scope)).plans, state.plans);
  const beforeAnalysis = await readFile(join(root, '.film/product-analysis.json'), 'utf8');
  const personal = await ensureStructureDraft(root, { parentProjectId: project.id, plan: state.plans[1] });
  assert.match(await readFile(join(personal.root, 'assets/live.vtt'), 'utf8'), /饭盒/);
  await assert.rejects(readFile(join(root, 'assets/live.vtt')), { code: 'ENOENT' }, 'Source ASR stays in its original cache');
  exporter = createExports({ drafts: () => { throw Error('Do not use the installed Jianying directory'); } });
  batches = createStructureBatchExports({ plans: reopened.plans, exports: exporter, outputRoot: () => output, pollMs: 20 });
  const request = { ...scope, taskKey: state.taskKey, planIds: state.plans.map(plan => plan.id), requestId: randomUUID(), folder: output, name: '参考例子全流程' };
  const batch = await batches.create(project, request);
  assert.equal((await batches.create(project, request)).id, batch.id);
  const finished = await batches.wait(project, batch.id);
  assert.equal(finished.status, 'complete', JSON.stringify(finished.items)); assert.equal(finished.completed, 2);
  assert.deepEqual(finished.items.map(item => item.origin), ['public', 'private']);
  for (const item of finished.items) {
    const draft = JSON.parse(await readFile(item.outputs[0], 'utf8'));
    assert.equal(draft.duration, 30000000);
    const videoTrack = draft.tracks.find(track => track.type === 'video');
    const audioTrack = draft.tracks.find(track => track.type === 'audio');
    const textTrack = draft.tracks.find(track => track.type === 'text');
    assert.ok(videoTrack?.segments.length && textTrack?.segments.length);
    assert.equal(audioTrack, undefined, 'native cuts use their original audio without a duplicate WAV track');
    for (const segment of videoTrack.segments) {
      assert.equal(segment.volume, 1);
      assert.equal(segment.speed, 1.3);
      assert.equal(draft.materials.speeds.find(speed => segment.extra_material_refs.includes(speed.id)).speed, 1.3);
      assert.ok(Math.abs(segment.source_timerange.duration / 1.3 - segment.target_timerange.duration) <= 1000000 / draft.fps);
    }
    const words = draft.materials.texts.map(material => JSON.parse(material.content).text).join(' ');
    assert.match(words, /饭盒/); assert.match(words, /购买/);
    for (const material of draft.materials.videos) {
      const info = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', material.path], { windowsHide: true, timeout: 10000 });
      assert.ok(Number(info.stdout.trim()) > 0, 'Exported picture is a playable file');
    }
  }
  assert.deepEqual(counts, { asr: 1, discovery: 1, analysis: 1, composition: 1 }, 'Reopen and export do not request the model again');
  assert.equal(await readFile(join(root, '.film/product-analysis.json'), 'utf8'), beforeAnalysis);
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), originalFilm); assert.equal(sha(await readFile(video)), beforeVideo);
});
