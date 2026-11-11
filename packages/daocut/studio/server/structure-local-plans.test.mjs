import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createStructurePlans, createStructurePlanInputReader } from './structure-plans.mjs';
import { createStructureWorkspace } from './structure-workspace.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { filmHtml } from '../../src/film-doc.mjs';
import { readProjectFilm, editProjectFilm } from './film.mjs';
import { patchProjectSettings, readProjectSettings } from './project-settings.mjs';
import { writeSourceSubtitles } from './subtitle-edits.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/structure-local-plans-tests');
async function fixture(t, { analyze = true, missingPurchase = false } = {}) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'local-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real models or network'); });
  await mkdir(join(root, 'assets')); await mkdir(join(root, '.film'));
  const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 24000 };
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 24000 };
  const data = { version: 1, sources: [source], products: [{ id: 'p', name: '合成商品', sourceIds: ['s'] }],
    intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 24000 }], candidates: [] };
  await writeFile(join(root, source.assetPath), 'synthetic local source');
  await writeFile(join(root, '.film/id'), 'local-parent');
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify(data));
  await writeFile(join(root, 'film.html'), filmHtml({ tracks: [{ clips: [{ id: 'existing-film', src: source.assetPath, time: [20, 22] }] }] }));
  let transcript = { cues: [
    { startMs: 0, endMs: 4000, text: '这是第一个完整开场' },
    { startMs: 4000, endMs: 8000, text: '这是第二个完整痛点' },
    { startMs: 8000, endMs: 16000, text: '这是完整卖点及其必要上下文' },
    { startMs: 16000, endMs: 20000, text: '需要的现在点击购买' },
  ], words: [] };
  let calls = 0;
  const options = { modelIdentity: 'isolated-local-text', probeSource: async () => ({ duration: 24 }), readTranscript: async () => transcript,
    modelClient: async () => { calls++; return { schema: 'complete-speech-v1', candidates: [['故事'], ['痛点'], ['卖点'], ...(missingPurchase ? [] : [['行动指令']])].map((tags, i) => ({ firstCue: i, lastCue: i, tags })), issues: [] }; } };
  const live = createLiveAnalysis(options);
  if (analyze) { await live.startAnalysis(root, { ...scope, lectureOnly: true }); await live.wait(root, 's'); assert.equal((await live.view(root, 's', 'i', 'p', scope)).analysis.status, 'complete'); }
  const forbiddenShared = new Proxy({}, { get: (_, name) => () => { throw Error(`Local composition must not call shared ${String(name)}`); } });
  const make = (extra = {}) => createStructurePlans({ sharedAnalysis: forbiddenShared, readInput: createStructurePlanInputReader({ readTranscript: options.readTranscript, liveAnalysis: createLiveAnalysis(options) }), ...extra });
  return { root, source, scope, live, options, make, calls: () => calls, changeTranscript: () => { transcript = { ...transcript, cues: transcript.cues.map((c, i) => i === 0 ? { ...c, text: '个人修改过的字幕' } : c) }; } };
}
async function complete(service, f) {
  let result;
  for (let i = 0; i < 100; i++) { result = await service.generate(f.root, f.scope); if (result.status !== 'running') return result; }
  throw Error('synthetic enumeration did not finish');
}

test('a saved local lecture composes without publishing, requesting a model or changing original work', async t => {
  const f = await fixture(t), service = f.make({ pageSize: 1 });
  const protectedPaths = ['film.html', f.source.assetPath, '.film/product-analysis.json', `.film/live-analysis/${sharedHash('s')}.json`];
  const before = await Promise.all(protectedPaths.map(path => readFile(join(f.root, path), 'utf8')));
  const idle = await service.status(f.root, f.scope);
  assert.equal(idle.status, 'idle'); assert.equal(idle.context.visibility, 'local');
  const partial = await service.generate(f.root, f.scope);
  assert.equal(partial.status, 'running'); assert.equal(partial.complete, false);
  const result = await complete(f.make({ pageSize: 1 }), f);
  assert.equal(result.status, 'complete'); assert.equal(result.context.visibility, 'local');
  assert.equal(result.allValidCombinationsEnumerated, true); assert.ok(result.plans.length >= 2);
  assert.ok(result.plans.every(p => p.speed === 1 && p.clips[0].roles.includes('hook') && p.clips.at(-1).roles.includes('purchase') && p.coreIds.length >= 1 && p.coreIds.length <= 2));
  assert.ok(result.plans.every(p => p.clips.some(c => c.text === '这是完整卖点及其必要上下文' && c.startMs === 8000 && c.endMs === 16000)));
  assert.ok(result.plans.every(p => p.clips.every(c => c.assetPath === f.source.assetPath && c.sourceId === 's')));
  assert.deepEqual((await f.make({ compose: () => { throw Error('Must reuse saved plans'); } }).status(f.root, f.scope)).plans, result.plans);
  await assert.rejects(service.publish(f.root, { confirmed: true, taskKey: result.taskKey, sourceId: 's' }), /没有可补保存/);
  assert.equal(f.calls(), 1); assert.equal(result.requestCount, 0);
  assert.deepEqual(await Promise.all(protectedPaths.map(path => readFile(join(f.root, path), 'utf8'))), before);
  assert.equal((await readdir(join(f.root, '.film'))).includes('shared-analysis'), false);
});

test('local plan draft edits survive switching and reopening without covering another draft or the existing film', async t => {
  const f = await fixture(t), result = await complete(f.make(), f);
  assert.equal(result.status, 'complete');
  const project = { id: 'local-parent', path: f.root };
  const register = async path => ({ id: (await readFile(join(path, '.film/id'), 'utf8')).trim(), path });
  const workspace = () => createStructureWorkspace({ plans: f.make(), register });
  const edit = (w, plan) => w.edit(project, { ...f.scope, taskKey: result.taskKey, planId: plan.id });
  const original = await readFile(join(f.root, 'film.html'), 'utf8'), w = workspace();
  const a = await edit(w, result.plans[0]), b = await edit(w, result.plans[1]);
  assert.notEqual(a.project.id, b.project.id);
  const bBefore = await readFile(join(b.project.path, 'film.html'), 'utf8');
  const film = await readProjectFilm(a.project.path), first = film.value.tracks[0].clips[0];
  await editProjectFilm(a.project.path, film.rev, [{ op: 'set', clip: first.id, field: 'time', value: [first.time[0] + 0.5, first.time[1]] }]);
  await writeSourceSubtitles(a.project.path, f.source.assetPath, [{ startMs: 1000, endMs: 2000, text: '只属于草稿甲' }]);
  await patchProjectSettings(a.project.path, { fps: 24 });
  const edited = await readFile(join(a.project.path, 'film.html'), 'utf8');
  await w.select(project, b.project.id); await w.select(project, a.project.id);
  const reopened = workspace();
  assert.equal((await reopened.read(project)).activeProjectId, a.project.id);
  assert.equal((await edit(reopened, result.plans[0])).project.id, a.project.id);
  assert.equal(await readFile(join(a.project.path, 'film.html'), 'utf8'), edited);
  assert.match(await readFile(join(a.project.path, 'assets/synthetic.vtt'), 'utf8'), /只属于草稿甲/);
  assert.equal((await readProjectSettings(a.project.path)).fps, 24);
  assert.equal(await readFile(join(b.project.path, 'film.html'), 'utf8'), bBefore);
  assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), original);
  assert.equal(f.calls(), 1);
});

test('missing or changed local analysis reports its reason and does not retry or pretend a public baseline exists', async t => {
  for (const kind of ['not-analyzed', 'transcript-changed', 'candidate-changed', 'missing-purchase', 'missing-pinned-public']) {
    await t.test(kind, async t => {
      const f = await fixture(t, { analyze: kind !== 'not-analyzed', missingPurchase: kind === 'missing-purchase' });
      const calls = f.calls();
      if (kind === 'transcript-changed') f.changeTranscript();
      if (kind === 'candidate-changed') {
        const file = join(f.root, '.film/product-analysis.json'), data = JSON.parse(await readFile(file, 'utf8'));
        data.candidates[2].tags = ['痛点']; await writeFile(file, JSON.stringify(data));
      }
      if (kind === 'missing-pinned-public') {
        const file = join(f.root, '.film/live-analysis', `${sharedHash('s')}.json`), state = JSON.parse(await readFile(file, 'utf8'));
        state.analyses.i.sharedRef = { sha256: 'a'.repeat(64) }; await writeFile(file, JSON.stringify(state));
      }
      const result = await f.make().generate(f.root, f.scope);
      assert.equal(result.status, 'unavailable'); assert.equal(result.plans.length, 0);
      const codes = { 'not-analyzed': 'LOCAL_ANALYSIS_REQUIRED', 'transcript-changed': 'LOCAL_ANALYSIS_REQUIRED', 'candidate-changed': 'PRIVATE_CANDIDATES', 'missing-purchase': 'MISSING_PURCHASE', 'missing-pinned-public': 'PUBLIC_BASELINE_REQUIRED' };
      assert.ok(result.issues.some(i => i.code === codes[kind]), JSON.stringify(result.issues));
      assert.equal(f.calls(), calls);
    });
  }
});
