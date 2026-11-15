import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { createProjectBackup, inspectProjectBackup, restoreProjectBackup } from './project-backup.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';
import { transcriptionLocation } from './product-transcription.mjs';
import { createStructurePlanInputReader, createStructurePlans } from './structure-plans.mjs';
import { createAiStructurePlans } from './ai-structure-plans.mjs';
import { aiStructurePrompt, createAiStructureRequest, validateAiStructureResponse } from './ai-structure.mjs';
import { inspectAiRequiredInput } from './ai-structure-required.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { ensureStructureDraft, listStructureDrafts } from './structure-drafts.mjs';
import { readProjectFilm, editProjectFilm } from './film.mjs';
import { sourceSubtitles, writeSourceSubtitles } from './subtitle-edits.mjs';
import { readSubtitleStyle, writeSubtitleStyle } from './captions.mjs';

test('backup restores both AI rule versions, legacy plans and edited drafts without regenerating after two relocations', async t => {
  const base = resolve('.tmp/backup-plans-tests'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'original');
  if (!process.env.DAOCUT_BACKUP_ACCEPTANCE) t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('Backup and restore must not contact a model'); });
  await mkdir(join(root, 'assets'), { recursive: true }); await mkdir(join(root, '.film'));
  await writeFile(join(root, '.film/id'), 'backup-plan-parent');
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 320, h: 180 }, tracks: [] }));
  const source = { id: 's', assetPath: 'assets/live.mp4', durationMs: 65000 };
  if (process.env.DAOCUT_BACKUP_TEST_MEDIA) await copyFile(process.env.DAOCUT_BACKUP_TEST_MEDIA, join(root, source.assetPath));
  else await writeFile(join(root, source.assetPath), 'synthetic source bytes');
  const scope = { sourceId: 's', productId: 'p', intervalId: 'i', startMs: 0, endMs: 65000 };
  const rows = [
    ['这款是双层饭盒，今天一套三十九元。', ['产品介绍', '价格机制']],
    ['双层保温，带饭到公司也方便。', ['卖点']],
    ['想要饭盒的朋友现在点击下方链接购买。', ['行动指令']],
  ];
  const cues = rows.map(([text], n) => ({ text, startMs: n * 15000, endMs: n * 15000 + 13000 }));
  const probeSource = async () => ({ duration: 65 });
  await writeProductAnalysis(root, { version: 1, sources: [source], products: [{ id: 'p', name: '人工命名饭盒', sourceIds: ['s'] }], intervals: [{ ...scope, id: 'i' }], candidates: [] }, probeSource);
  const loc = await transcriptionLocation(root, source); await mkdir(loc.dir, { recursive: true });
  await writeFile(loc.path, JSON.stringify({ version: 1, status: 'complete', sourceId: 's', assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs: source.durationMs, cues, words: [] }));
  let calls = 0;
  const modelIdentity = { provider: 'mock', model: 'backup-fixture', endpoint: 'https://example.invalid' };
  const client = async ({ input }) => {
    calls++;
    const body = JSON.parse(input);
    if (body.units) return { schema: 'ai-structure-plans-v8', plans: [body.units.map(u => u.id)], prices: [{ id: body.units[0].id, kind: 'current', evidence: [0] }] };
    return { schema: 'complete-speech-v1', candidates: rows.map(([, tags], n) => ({ firstCue: n, lastCue: n, tags,
      subject: { kind: 'self', evidence: [n] }, ...(n === 0 ? { price: { kind: 'current', evidence: [0] }, opening: { group: '饭盒介绍', followup: '说明保温卖点' } } : {}) })), issues: [] };
  };
  const live = createLiveAnalysis({ modelIdentity, modelClient: client, probeSource });
  await live.startAnalysis(root, { ...scope, lectureOnly: true }); await live.wait(root, 's');
  assert.equal((await live.view(root, 's', 'i', 'p', scope)).analysis.status, 'complete');
  const readInput = createStructurePlanInputReader({ liveAnalysis: live });
  const material = await readInput(root, scope), version = 'ai-structure-plans-v7';
  const key = sharedHash({ kind: version, prompt: aiStructurePrompt(version), analysis: material.analysisVersion, semantic: material.semanticVersion, input: inspectAiRequiredInput(material.engineInput).inputHash, visibility: material.visibility });
  const oldRequest = createAiStructureRequest(material, { version });
  const response = { schema: version, plans: [material.engineInput.candidates.map(c => c.id)] };
  const result = validateAiStructureResponse(material, response, { expectedVersion: version });
  assert.equal(result.plans.length, 1);
  await mkdir(join(root, '.film/ai-structure-plans'));
  await writeFile(join(root, '.film/ai-structure-plans', `${key}.json`), JSON.stringify({ version, key, sourceId: 's', rounds: [{ status: 'complete', request: oldRequest, response, result }] }));
  const plans = createAiStructurePlans({ readInput, modelIdentity, modelClient: client });
  const versions = ['ai-structure-plans-v7', 'ai-structure-plans-v8'], saved = [];
  for (const rulesVersion of versions) {
    const req = { ...scope, rulesVersion }, ready = await plans.status(root, req);
    if (rulesVersion !== version) { await plans.generate(root, { ...req, confirmed: true, confirmationId: ready.confirmation?.id }); await plans.wait(); }
    const state = await plans.status(root, req); assert.equal(state.plans.length, 1, JSON.stringify(state)); saved.push(state);
  }
  const legacy = createStructurePlans({ readInput });
  const old = await legacy.generate(root, scope); assert.equal(old.status, 'complete'); assert.ok(old.plans.length > 0);
  const draft = await ensureStructureDraft(root, { parentProjectId: 'backup-plan-parent', plan: saved[1].plans[0] });
  const film = await readProjectFilm(draft.root), clip = film.value.tracks[0].clips[0];
  await editProjectFilm(draft.root, film.rev, [{ op: 'set', clip: clip.id, field: 'time', value: [1, 12] }, { op: 'set', clip: clip.id, field: 'volume', value: 0.4 }]);
  const subtitles = await sourceSubtitles(draft.root, source.assetPath); subtitles.cues[0].text = '人工字幕：饭盒三十九元';
  await writeSourceSubtitles(draft.root, source.assetPath, subtitles.cues);
  await writeSubtitleStyle(draft.root, { ...(await readSubtitleStyle(draft.root)), on: true, pos: { x: 0.5, y: 0.8 } });
  await writeFile(join(root, '.film/structure-workspace.json'), JSON.stringify({ version: 1, activeProjectId: (await readFile(join(draft.root, '.film/id'), 'utf8')).trim() }));
  const originalFilm = (await readProjectFilm(draft.root)).value, originalStyle = await readSubtitleStyle(draft.root), originalCalls = calls;
  let current = root;
  for (let n = 0; n < 2; n++) {
    const backup = join(dir, `backup-${n}`), target = join(dir, `restored-${n}`);
    await createProjectBackup(current, backup); const inspection = await inspectProjectBackup(backup);
    await restoreProjectBackup({ backupPath: backup, targetPath: target, expectedBackupId: inspection.backupId, confirmed: true });
    const reopenedLive = createLiveAnalysis({ modelIdentity, modelClient: () => assert.fail('must not regenerate'), probeSource });
    const reopenedInput = createStructurePlanInputReader({ liveAnalysis: reopenedLive });
    const reopened = createAiStructurePlans({ readInput: reopenedInput, modelIdentity, modelClient: () => assert.fail('must not regenerate') });
    for (const [i, rulesVersion] of versions.entries()) {
      const result = await reopened.status(target, { ...scope, rulesVersion });
      assert.deepEqual(result.plans, saved[i].plans); assert.equal(result.taskKey, saved[i].taskKey);
      assert.equal(await readFile(join(target, '.film/ai-structure-plans', `${result.taskKey}.json`), 'utf8'), await readFile(join(root, '.film/ai-structure-plans', `${result.taskKey}.json`), 'utf8'));
    }
    assert.deepEqual((await createStructurePlans({ readInput: reopenedInput }).status(target, scope)).plans, old.plans);
    const [copy] = await listStructureDrafts(target);
    assert.deepEqual((await readProjectFilm(copy.root)).value, originalFilm);
    assert.deepEqual(await readSubtitleStyle(copy.root), originalStyle);
    assert.equal((await sourceSubtitles(copy.root, source.assetPath)).cues[0].text, '人工字幕：饭盒三十九元');
    const id = (await readFile(join(target, '.film/id'), 'utf8')).trim();
    assert.equal((await ensureStructureDraft(target, { parentProjectId: id, plan: saved[1].plans[0] })).root, copy.root);
    current = target;
  }
  assert.equal(calls, originalCalls);
  const blocked = createAiStructurePlans({ readInput: createStructurePlanInputReader({ liveAnalysis: createLiveAnalysis({ modelIdentity: 'different-model', probeSource }) }) });
  assert.equal((await blocked.status(current, scope)).status, 'unavailable', 'restoration does not bypass model identity checks');
  if (process.env.DAOCUT_BACKUP_ACCEPTANCE) await writeFile(process.env.DAOCUT_BACKUP_ACCEPTANCE, JSON.stringify({ dir, root, target: current, scope, modelIdentity, planIds: saved.map(s => s.plans[0].id) }));
});
