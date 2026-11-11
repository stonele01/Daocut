import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { AI_STRUCTURE_VERSION, PREVIOUS_AI_STRUCTURE_VERSION, PREVIOUS_AI_STRUCTURE_PROMPT,
  createAiStructureRequest, validateAiStructureResponse } from './ai-structure.mjs';
import { inspectAiCompositionInput } from './structure-composition.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { createStructureWorkspace } from './structure-workspace.mjs';
import { createStructureBatchExports } from './structure-batch-exports.mjs';
import { readProjectFilm } from './film.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/structure-version-workspace-exports');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const register = async path => ({ path, id: (await readFile(join(path, '.film/id'), 'utf8')).trim() });
const filmClips = html => readFilmFile(html).value.tracks.flatMap(track => track.clips);

async function fixture(t) {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'project'), output = join(dir, 'exports');
  await mkdir(join(root, '.film'), { recursive: true }); await mkdir(join(root, 'assets'));
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real models or external network'); });
  const scope = { sourceId: 's', productId: 'p', intervalId: 'once', startMs: 0, endMs: 45000 };
  const texts = ['完整的痛点开头', '完整的卖点和必要上下文', '需要的点击链接购买'];
  const roles = ['pain', 'core', 'purchase'], tags = ['痛点', '卖点', '行动指令'];
  const cues = texts.map((text, i) => ({ text, startMs: i * 15000, endMs: i * 15000 + 13000 }));
  const candidates = cues.map((cue, i) => ({ ...scope, ...cue, id: `candidate-${i}`, cueRange: [i, i], tags: [tags[i]],
    details: { composition: { contract: 'complete-speech-v1', status: 'confirmed', roles: [roles[i]], requires: [], excludes: [], conditions: {} } } }));
  const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: scope.endMs };
  const material = { source, context: scope, scope, visibility: 'local', analysisVersion: 'saved-analysis', semanticVersion: 'saved-complete-speech',
    engineInput: { scope, sourceIdentity: 'synthetic-source', candidates, cues }, issues: [] };
  const project = { id: 'version-parent', name: '双版本隔离工程', path: root };
  await writeFile(join(root, '.film/id'), project.id);
  await writeFile(join(root, 'assets/synthetic.mp4'), 'isolated synthetic media bytes; this test does not decode or render');
  await writeFile(join(root, 'assets/synthetic.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:13.000\n完整的痛点开头\n\n00:00:15.000 --> 00:00:28.000\n完整的卖点和必要上下文\n\n00:00:30.000 --> 00:00:43.000\n需要的点击链接购买\n');
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 720, h: 1280 }, tracks: [{ clips: [{ id: 'existing-finished-film', src: source.assetPath, time: [0, 5], speed: 1 }] }] }));
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [source],
    products: [{ id: 'p', name: '模拟商品', sourceIds: ['s'] }], intervals: [{ ...scope, id: scope.intervalId }], candidates }));
  const oldKey = sharedHash({ kind: PREVIOUS_AI_STRUCTURE_VERSION, prompt: PREVIOUS_AI_STRUCTURE_PROMPT,
    analysis: material.analysisVersion, semantic: material.semanticVersion, input: inspectAiCompositionInput(material.engineInput).inputHash, visibility: material.visibility });
  const response = { schema: PREVIOUS_AI_STRUCTURE_VERSION, plans: [[0, 1, 2]], complete: true, issues: [] };
  const result = validateAiStructureResponse(material, response, { expectedVersion: PREVIOUS_AI_STRUCTURE_VERSION });
  assert.equal(result.plans.length, 1);
  const oldPath = join(root, '.film/ai-structure-plans', `${oldKey}.json`);
  await mkdir(join(root, '.film/ai-structure-plans'));
  await writeFile(oldPath, JSON.stringify({ version: PREVIOUS_AI_STRUCTURE_VERSION, key: oldKey, sourceId: 's',
    rounds: [{ status: 'complete', submitted: true, request: createAiStructureRequest(material, { version: PREVIOUS_AI_STRUCTURE_VERSION }), response, result }] }));
  const services = [], managers = [], calls = [];
  const service = () => {
    const value = createAiStructurePlans({ readInput: async () => structuredClone(material),
      modelIdentity: async () => ({ provider: 'mock', model: 'synthetic', endpoint: 'https://mock.invalid' }),
      modelClient: async request => { calls.push(request); return { schema: AI_STRUCTURE_VERSION,
        plans: [[0, 1, 2].map(unit => ({ unit, firstCue: unit, lastCue: unit, tags: [tags[unit]] }))], complete: true, issues: [] }; } });
    services.push(value); return value;
  };
  const jobs = [], sent = []; let released = false;
  const exports = {
    startSnapshot(project, request) {
      const snapshot = JSON.parse(readFileSync(join(project.path, '.film/structure-export-snapshot.json'), 'utf8'));
      sent.push({ snapshot, request, film: readFileSync(join(project.path, 'film.html'), 'utf8'), captions: readFileSync(join(project.path, 'assets/synthetic.vtt'), 'utf8') });
      const job = { id: randomUUID(), project: project.id, status: released ? 'done' : 'running', progress: released ? 1 : 0.1, outputs: [] };
      jobs.push(job); return { ...job };
    },
    list: id => jobs.filter(job => job.project === id).map(job => ({ ...job })),
    cancel: id => { const job = jobs.find(job => job.id === id); if (job) job.status = 'cancelled'; },
  };
  const batchManager = plans => { const value = createStructureBatchExports({ plans, exports, outputRoot: () => output, pollMs: 1 }); managers.push(value); return value; };
  t.after(async () => {
    released = true; jobs.forEach(job => { job.status = 'done'; job.progress = 1; });
    await Promise.all(managers.map(manager => manager.stop())); await Promise.all(services.map(value => value.wait()));
    assert.ok(resolve(dir).startsWith(base + sep)); await rm(dir, { recursive: true, force: true });
  });
  const protectedPaths = ['film.html', 'assets/synthetic.mp4', 'assets/synthetic.vtt', '.film/product-analysis.json'];
  const protectedState = () => Promise.all(protectedPaths.map(async name => [name, await readFile(join(root, name), 'utf8')]));
  return { root, project, scope, output, oldKey, oldPath, oldPlan: result.plans[0], calls, service, batchManager, sent, protectedState,
    release: () => { released = true; jobs.forEach(job => { job.status = 'done'; job.progress = 1; }); } };
}

test('saved v1 and explicitly generated v2 keep separate edited drafts after reopen and batch-export their selected frozen version', async t => {
  const f = await fixture(t), protectedBefore = await f.protectedState(), oldRecord = await readFile(f.oldPath, 'utf8');
  const plans = f.service(), workspace = createStructureWorkspace({ plans, register });
  const oldRequest = { ...f.scope, taskKey: f.oldKey, planId: f.oldPlan.id };
  const oldDraft = await workspace.edit(f.project, oldRequest);
  const oldFilm = filmHtml({ stage: { w: 800, h: 800 }, tracks: [{ clips: [
    { id: 'old-edited-core', src: 'assets/synthetic.mp4', time: [16, 27], speed: 1, volume: 0.4 },
    { id: 'old-edited-hook', src: 'assets/synthetic.mp4', at: 11, time: [1, 12], speed: 1 },
  ] }] });
  await writeFile(join(oldDraft.project.path, 'film.html'), oldFilm);
  await writeFile(join(oldDraft.project.path, '.film/settings.json'), JSON.stringify({ fps: 25 }));
  await writeFile(join(oldDraft.project.path, 'assets/synthetic.vtt'), 'WEBVTT\n\n00:00:16.000 --> 00:00:27.000\n旧方案私人字幕\n');
  const selection = { ...f.scope, rulesVersion: AI_STRUCTURE_VERSION };
  const preview = await plans.status(f.root, selection);
  assert.equal(preview.status, 'idle'); assert.equal(f.calls.length, 0);
  await plans.generate(f.root, { ...selection, confirmed: true, confirmationId: preview.confirmation.id }); await plans.wait();
  const current = await plans.status(f.root, selection), newPlan = current.plans[0];
  assert.equal(current.status, 'complete'); assert.notEqual(current.taskKey, f.oldKey); assert.equal(f.calls.length, 1);
  assert.equal(newPlan.speed, 1.3); assert.equal(newPlan.durationMs, 30000);
  assert.equal((await plans.status(f.root, f.scope)).taskKey, current.taskKey, 'ordinary opening now defaults to the new saved version');
  const newRequest = { ...f.scope, taskKey: current.taskKey, planId: newPlan.id };
  const newDraft = await workspace.edit(f.project, newRequest);
  assert.notEqual(newDraft.project.id, oldDraft.project.id);
  assert.ok((await readProjectFilm(newDraft.project.path)).value.tracks.flatMap(track => track.clips).every(clip => clip.speed === 1.3));
  const newFilm = filmHtml({ stage: { w: 1080, h: 1920 }, tracks: [{ clips: [
    { id: 'new-edited-core', src: 'assets/synthetic.mp4', time: [17, 26], speed: 1.3, volume: 0.7 },
    { id: 'new-edited-purchase', src: 'assets/synthetic.mp4', at: 9 / 1.3, time: [31, 42], speed: 1.3 },
  ] }] });
  await writeFile(join(newDraft.project.path, 'film.html'), newFilm);
  await writeFile(join(newDraft.project.path, '.film/settings.json'), JSON.stringify({ fps: 60 }));
  await writeFile(join(newDraft.project.path, 'assets/synthetic.vtt'), 'WEBVTT\n\n00:00:17.000 --> 00:00:26.000\n新版私人字幕\n');
  await workspace.select(f.project, oldDraft.project.id); await workspace.select(f.project, newDraft.project.id);
  const reopenedPlans = f.service(), reopened = createStructureWorkspace({ plans: reopenedPlans, register });
  assert.equal((await reopened.read(f.project)).activeProjectId, newDraft.project.id);
  assert.equal((await reopened.read(f.project)).drafts.length, 2);
  assert.equal((await reopened.edit(f.project, oldRequest)).project.id, oldDraft.project.id);
  assert.equal((await reopened.edit(f.project, newRequest)).project.id, newDraft.project.id);
  assert.equal(await readFile(join(oldDraft.project.path, 'film.html'), 'utf8'), oldFilm);
  assert.equal(await readFile(join(newDraft.project.path, 'film.html'), 'utf8'), newFilm);
  assert.equal((await readJson(join(oldDraft.project.path, '.film/settings.json'))).fps, 25);
  assert.equal((await readJson(join(newDraft.project.path, '.film/settings.json'))).fps, 60);
  const recordFiles = await readdir(join(f.root, '.film/ai-structure-plans'));
  const recordsBefore = await Promise.all(recordFiles.map(async name => [name, await readFile(join(f.root, '.film/ai-structure-plans', name), 'utf8')]));
  assert.equal(recordFiles.length, 2);
  const batches = f.batchManager(reopenedPlans);
  const oldBatch = await batches.create(f.project, { ...oldRequest, planIds: [f.oldPlan.id], requestId: randomUUID() });
  const newBatch = await batches.create(f.project, { ...newRequest, planIds: [newPlan.id], requestId: randomUUID() });
  assert.equal(oldBatch.items[0].sourceProjectId, oldDraft.project.id); assert.equal(newBatch.items[0].sourceProjectId, newDraft.project.id);
  await reopened.select(f.project, oldDraft.project.id); await reopenedPlans.status(f.root, { ...f.scope, taskKey: f.oldKey });
  const laterOldFilm = oldFilm.replace('old-edited-core', 'later-old-edit'), laterNewFilm = newFilm.replace('new-edited-core', 'later-new-edit');
  await writeFile(join(oldDraft.project.path, 'film.html'), laterOldFilm);
  await writeFile(join(newDraft.project.path, 'film.html'), laterNewFilm);
  f.release();
  assert.equal((await batches.wait(f.project, oldBatch.id)).status, 'complete');
  assert.equal((await batches.wait(f.project, newBatch.id)).status, 'complete');
  assert.equal(f.sent.length, 2);
  for (const [index, expected] of [[oldDraft, oldFilm, '旧方案私人字幕', 1, 25], [newDraft, newFilm, '新版私人字幕', 1.3, 60]].entries()) {
    const sent = f.sent[index]; assert.equal(sent.snapshot.sourceProjectId, expected[0].project.id);
    assert.equal(sent.snapshot.planVersion, index ? AI_STRUCTURE_VERSION : PREVIOUS_AI_STRUCTURE_VERSION);
    assert.equal(sent.film, expected[1]); assert.match(sent.captions, new RegExp(expected[2]));
    assert.ok(filmClips(sent.film).every(clip => (clip.speed ?? 1) === expected[3])); assert.equal(sent.request.fps, expected[4]);
    assert.equal(sent.request.kind, 'nle'); assert.equal(sent.request.format, 'jianying');
  }
  await batches.stop();
  const reopenedBatches = f.batchManager(f.service());
  const persisted = await reopenedBatches.list(f.project); assert.equal(persisted.batches.length, 2);
  assert.ok(persisted.batches.every(batch => batch.status === 'complete'));
  assert.equal(await readFile(join(oldDraft.project.path, 'film.html'), 'utf8'), laterOldFilm);
  assert.equal(await readFile(join(newDraft.project.path, 'film.html'), 'utf8'), laterNewFilm);
  assert.deepEqual(await f.protectedState(), protectedBefore);
  assert.equal(await readFile(f.oldPath, 'utf8'), oldRecord);
  assert.deepEqual(await Promise.all(recordFiles.map(async name => [name, await readFile(join(f.root, '.film/ai-structure-plans', name), 'utf8')])), recordsBefore);
  assert.equal(f.calls.length, 1, 'switching, reopening, and exporting never call the model');
});
