import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat, access, realpath, copyFile, lstat, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createProjectBackup, inspectProjectBackup, restoreProjectBackup } from './project-backup.mjs';
import { readProductTranscript, transcriptionLocation, transcribeProductSource } from './product-transcription.mjs';
import { readTranscriptReview, saveTranscriptReview } from './transcript-review.mjs';
import { AUDIO_SEGMENT_POLICY, planAudioSegments } from './transcription-segments.mjs';
import { createExports } from './exports.mjs';
import { associateSharedLibrary, resolveSharedMedia } from './shared-media.mjs';
import { createProductDiscovery } from './product-discovery-route.mjs';

const base = resolve('.tmp/shared-v2-20261105/backup');
process.env.DAOCUT_STUDIO_HOME = join(base, 'isolated-studio-home');
test.beforeEach(t => { t.mock.method(globalThis, 'fetch', () => { throw new Error('real network forbidden'); }); });
const hash = value => createHash('sha256').update(value).digest('hex');
async function put(root, path, value) { await mkdir(resolve(root, path, '..'), { recursive: true }); await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); }
async function fixture() {
  await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'original');
  await put(root, 'film.html', '<html><body>personal film</body></html>');
  await put(root, 'assets/local.mp4', 'isolated mock media');
  const mediaInfo = await stat(join(root, 'assets/local.mp4'));
  await put(root, '.film/product-analysis.json', { version: 1, sources: [{ id: 'source-a', assetPath: 'assets/local.mp4', durationMs: 10000 }], products: [{ id: 'A', name: '人工改名', sourceIds: ['source-a'] }], intervals: [], candidates: [] });
  await put(root, '.film/source-takes.json', { version: 1, sources: [{ sourceIdentity: hash(JSON.stringify({ sourceId: 'source-a', assetPath: 'assets/local.mp4', size: mediaInfo.size, mtimeMs: mediaInfo.mtimeMs })), document: { sourceId: 'source-a', assetPath: 'assets/local.mp4', film: { tracks: [] } } }] });
  await put(root, '.film/shared-analysis/task.json', { descriptor: { root, taskKey: 'task' }, snapshot: { selected: 'first-version' }, outbox: { payload: 'receipt' } });
  await put(root, '.film/product-transcripts/raw-responses/receipt.json', { text: '原始回包' });
  await put(root, '.film/chat/private.json', 'private chat'); await put(root, '.film/logs/private.json', 'private log'); await put(root, '.env', 'SECRET=do-not-copy');
  return { dir, root, backup: join(dir, 'backup'), target: join(dir, 'restored') };
}
test('complete backup preserves personal state and receipts but excludes application secrets and chat logs', async () => {
  const f = await fixture(); await createProjectBackup(f.root, f.backup);
  const info = await inspectProjectBackup(f.backup); assert.equal(info.sources[0].sha256, hash('isolated mock media')); assert.equal(info.hasPendingResults, true);
  assert.match(await readFile(join(f.backup, '.film/product-analysis.json'), 'utf8'), /人工改名/);
  assert.equal(JSON.parse(await readFile(join(f.backup, '.film/shared-analysis/task.json'))).outbox.payload, 'receipt');
  for (const path of ['.env', '.film/chat/private.json', '.film/logs/private.json']) await assert.rejects(access(join(f.backup, path)));
});
test('tampered or incomplete backups are refused before creating a project', async () => {
  const f = await fixture(); await createProjectBackup(f.root, f.backup); await put(f.backup, 'film.html', 'changed');
  await assert.rejects(inspectProjectBackup(f.backup), /校验/);
  await assert.rejects(restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true }), /校验/); await assert.rejects(access(f.target));
  await assert.rejects(inspectProjectBackup(f.root), /完整备份/);
});
test('disk-full during backup never publishes a usable partial version or changes original', async () => {
  const f = await fixture(); await assert.rejects(createProjectBackup(f.root, f.backup, { copyFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  await assert.rejects(access(f.backup)); assert.match(await readFile(join(f.root, 'film.html'), 'utf8'), /personal film/);
});
test('restore uses a new folder, preserves manual edits and outbox, and never submits requests', async () => {
  const f = await fixture(); await createProjectBackup(f.root, f.backup); const info = await inspectProjectBackup(f.backup);
  const result = await restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId, mappings: [] });
  assert.equal(result.path, f.target); assert.match(await readFile(join(f.target, '.film/product-analysis.json'), 'utf8'), /人工改名/);
  assert.equal(JSON.parse(await readFile(join(f.target, '.film/shared-analysis/task.json'))).outbox.payload, 'receipt');
  assert.ok(result.warnings.some(text => text.includes('待确认')));
  await assert.rejects(restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId }), /已存在/);
});
test('registered NAS source is referenced and hashed, never packed; different same-name bytes cannot restore', async () => {
  const f = await fixture(), nas = join(f.dir, 'fake-nas'); await put(nas, 'same.mp4', 'mock NAS original');
  await put(f.root, 'assets/.daocut-source-media.json', { version: 1, items: { 'assets/local.mp4': { libraryId: 'library-test', libraryName: '测试库', relativePath: 'same.mp4', size: 17, mtimeMs: 0 } } });
  await createProjectBackup(f.root, f.backup, { resolveSource: async () => join(nas, 'same.mp4') }); await assert.rejects(access(join(f.backup, 'assets/local.mp4')));
  const info = await inspectProjectBackup(f.backup); await put(nas, 'same.mp4', 'different content');
  await assert.rejects(restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId, mappings: [{ libraryId: 'library-test', root: nas }] }), /内容/);
  await assert.rejects(access(f.target));
});

test('stale personal trims cannot become valid again merely because the source id is unchanged', async () => {
  const f = await fixture(), path = '.film/source-takes.json', takes = JSON.parse(await readFile(join(f.root, path)));
  takes.sources[0].sourceIdentity = 'old-source-version'; await put(f.root, path, takes); await createProjectBackup(f.root, f.backup); const info = await inspectProjectBackup(f.backup);
  await assert.rejects(restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId }), /取用.*身份不一致/); await assert.rejects(access(f.target));
});
test('a source changed between identity hashing and snapshot copy cannot publish a complete backup', async () => {
  const f = await fixture(); let changed = false;
  await assert.rejects(createProjectBackup(f.root, f.backup, { copyFile: async (from, to) => { if (!changed) { changed = true; await put(f.root, 'assets/local.mp4', 'changed video content'); } await copyFile(from, to); } }), /变化|修改/);
  await assert.rejects(access(f.backup));
});
test('restore ENOSPC preserves backup and never exposes a half-restored project', async () => {
  const f = await fixture(); await createProjectBackup(f.root, f.backup); const info = await inspectProjectBackup(f.backup);
  await assert.rejects(restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId }, { copyFile: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  await assert.rejects(access(f.target)); assert.equal((await inspectProjectBackup(f.backup)).backupId, info.backupId);
});
test('raw provider receipts containing credentials cause backup to stop instead of leaking them', async () => {
  const f = await fixture(); await put(f.root, '.film/product-transcripts/raw-responses/receipt.json', { apiKey: 'test-secret-only' });
  await assert.rejects(createProjectBackup(f.root, f.backup), /凭据/); await assert.rejects(access(f.backup));
});
test('completed transcript and local seam decisions survive cross-folder restore without provider requests', async () => {
  const f = await fixture(), source = { id: 'source-a', assetPath: 'assets/local.mp4', durationMs: 10000 }, loc = await transcriptionLocation(f.root, source);
  const plan = planAudioSegments(10000, { targetMs: 5000, overlapMs: 1000 });
  const segments = [
    { ...plan[0], status: 'complete', cues: [{ text: '前文', startMs: 100, endMs: 500 }, { text: '截断句子', startMs: 4800, endMs: 5300 }], words: [] },
    { ...plan[1], status: 'complete', cues: [{ text: '另一边完整句子', startMs: 300, endMs: 900 }, { text: '后文', startMs: 1500, endMs: 2000 }], words: [] },
  ];
  await put(f.root, `.film/product-transcripts/${hash(source.id)}.json`, { version: 1, sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, status: 'pending', segmented: true, fingerprint: loc.fingerprint });
  await put(f.root, `.film/product-transcripts/${hash(source.id)}.json.segments.json`, { version: 1, sourceId: source.id, durationMs: source.durationMs, identity: 'custom-complete-fixture', segments });
  const review = await readTranscriptReview(f.root, source.id);
  await saveTranscriptReview(f.root, { sourceId: source.id, identity: review.identity, expectedRevision: 0, seamId: review.seams[0].id, cues: [{ text: '人工核对的完整句子', startMs: 4800, endMs: 5400 }], confirmed: true, acknowledgeImpact: true });
  const before = await readProductTranscript(f.root, source), raw = await readFile(`${loc.path}.segments.json`, 'utf8');
  await createProjectBackup(f.root, f.backup); const info = await inspectProjectBackup(f.backup);
  await restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId });
  const after = await readProductTranscript(f.target, source); assert.deepEqual(after.cues, before.cues); assert.equal(after.reviewRevision, 1);
  assert.equal((await readTranscriptReview(f.target, source.id)).pendingCount, 0);
  assert.equal(await readFile(join(f.target, `.film/product-transcripts/${hash(source.id)}.json.segments.json`), 'utf8'), raw);
  assert.deepEqual((await readProductTranscript(f.target, source)).cues, before.cues);
});
test('pending outbox relocation checks the original company and attempt using status only', async () => {
  const f = await fixture(), path = '.film/shared-analysis/task.json';
  const saved = { sourceId: 'source-a', descriptor: { root: f.root, libraryId: 'library-test', taskKey: 'task', resultRoot: 'old-location' }, coordinationId: 'company-original', attemptId: 'attempt-original', status: 'publish-pending', snapshot: { pinned: 'old' }, outbox: { payload: 'immutable' } };
  await put(f.root, path, saved); await createProjectBackup(f.root, f.backup); const info = await inspectProjectBackup(f.backup), calls = [], resultRoot = join(f.dir, 'fake-results');
  await restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId, resultRoots: [{ libraryId: 'library-test', root: resultRoot }] }, { coordinate: async (action, body) => { calls.push([action, body]); return { coordinationId: 'company-original', task: { attemptId: 'attempt-original', status: 'submitted' } }; } });
  assert.deepEqual(calls, [['status', { taskKey: 'task', expectedCoordinatorId: 'company-original' }]]);
  const restored = JSON.parse(await readFile(join(f.target, path))); assert.equal(restored.descriptor.resultRoot, resultRoot); assert.deepEqual(restored.outbox, saved.outbox); assert.deepEqual(restored.snapshot, saved.snapshot); await assert.rejects(access(resultRoot));
});
test('different coordinator cannot rebind a pending result destination', async () => {
  const f = await fixture(), path = '.film/shared-analysis/task.json'; await put(f.root, path, { descriptor: { root: f.root, libraryId: 'library-test', taskKey: 'task', resultRoot: 'old-location' }, coordinationId: 'original', attemptId: 'attempt', outbox: { original: true } });
  await createProjectBackup(f.root, f.backup); const info = await inspectProjectBackup(f.backup);
  const result = await restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: info.backupId, resultRoots: [{ libraryId: 'library-test', root: f.dir }] }, { coordinate: async () => ({ coordinationId: 'different', task: { attemptId: 'attempt' } }) });
  assert.equal(JSON.parse(await readFile(join(f.target, path))).descriptor.resultRoot, 'old-location'); assert.ok(result.warnings.some(text => text.includes('待确认')));
});

test('ordinary export queue produces an inspectable full backup without a dedicated script', async () => {
  const f = await fixture(); process.env.DAOCUT_EXPORTS = join(f.dir, 'exports');
  const exporter = createExports(), job = exporter.start({ id: 'isolated', name: 'Backup test', path: f.root }, { kind: 'project', as: 'folder', parts: [], backup: true });
  const done = await new Promise((resolve, reject) => { const start = Date.now(); const poll = () => { const current = exporter.list('isolated').find(item => item.id === job.id); if (['done', 'failed', 'cancelled'].includes(current.status)) resolve(current); else if (Date.now() - start > 5000) reject(new Error('export timeout')); else setTimeout(poll, 10); }; poll(); });
  assert.equal(done.status, 'done', done.error); assert.equal((await inspectProjectBackup(done.outputs[0])).sources.length, 1);
});
test('legacy native file link remains a link and is readable through the real library resolver on its new mapping', async t => {
  const f = await fixture(), nas = join(f.dir, 'fake-nas'); await put(nas, 'same.mp4', 'isolated mock media'); const mediaInfo = await stat(join(nas, 'same.mp4'));
  // Same bytes are re-associated explicitly; old takes must describe this NAS version.
  const takes = JSON.parse(await readFile(join(f.root, '.film/source-takes.json'))); takes.sources[0].sourceIdentity = hash(JSON.stringify({ sourceId: 'source-a', assetPath: 'assets/local.mp4', size: mediaInfo.size, mtimeMs: mediaInfo.mtimeMs })); await put(f.root, '.film/source-takes.json', takes);
  await put(f.root, 'assets/.daocut-source-media.json', { version: 1, items: { 'assets/local.mp4': { libraryId: 'library-test', libraryName: '测试库', relativePath: 'same.mp4', size: mediaInfo.size, mtimeMs: mediaInfo.mtimeMs } } });
  // Native-link compatibility remains a separate check; restored backups now migrate to logical
  // references (project-backup-legacy-reference.test.mjs), so they no longer need this OS privilege.
  await mkdir(join(f.target, 'assets'), { recursive: true });
  await copyFile(join(f.root, 'assets/.daocut-source-media.json'), join(f.target, 'assets/.daocut-source-media.json'));
  try { await symlink(join(nas, 'same.mp4'), join(f.target, 'assets/local.mp4'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Windows file symlink privilege unavailable; native-link compatibility not executed'); return; } throw error; }
  await associateSharedLibrary({ id: 'library-test', name: '测试库', root: nas });
  const result = { path: f.target };
  assert.equal((await lstat(join(result.path, 'assets/local.mp4'))).isSymbolicLink(), true);
  const source = await resolveSharedMedia(result.path, 'assets/local.mp4'); assert.equal(await realpath(source.path), await realpath(join(nas, 'same.mp4')));
  assert.equal(await readFile(source.path, 'utf8'), 'isolated mock media');
});
test('restored shared discovery reuses its verified transcript input instead of requiring another model request', async () => {
  const f = await fixture(), source = { id: 'source-a', assetPath: 'assets/local.mp4', durationMs: 10000 }, loc = await transcriptionLocation(f.root, source), info = await stat(loc.input);
  const cues = [{ startMs: 100, endMs: 500, text: '商品完整讲解' }];
  await put(f.root, `.film/product-transcripts/${hash(source.id)}.json`, { version: 1, sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint: loc.fingerprint, status: 'complete', cues, words: [], text: cues[0].text });
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const discoveryHash = value => hash(JSON.stringify(canonical(value)));
  const fingerprint = discoveryHash({ sourceId: source.id, assetPath: source.assetPath, resolvedPath: await realpath(loc.input), size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, durationMs: source.durationMs });
  await put(f.root, `.film/product-discovery/${discoveryHash(source.id)}.json`, { version: 1, sourceId: source.id, runs: [{ id: 'shared-complete', status: 'complete', inputHash: discoveryHash({ fingerprint, durationMs: source.durationMs, cues }), sharedRef: { sha256: 'verified' }, completed: [{}] }] });
  await createProjectBackup(f.root, f.backup); const inspection = await inspectProjectBackup(f.backup);
  await restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: inspection.backupId });
  const discovery = createProductDiscovery({ modelIdentity: 'mock', probeSource: async () => ({ duration: 10 }), modelClient: async () => { throw Error('must reuse'); } });
  assert.equal((await discovery.plan(f.target, source.id)).cached, true);
});
test('restoring an uncertain segmented transcription keeps completed segments and blocks implicit resubmission', async () => {
  const f = await fixture(), source = { id: 'source-a', assetPath: 'assets/local.mp4', durationMs: 1300000 }, loc = await transcriptionLocation(f.root, source);
  const analysis = JSON.parse(await readFile(join(f.root, '.film/product-analysis.json'))); analysis.sources = [source]; await put(f.root, '.film/product-analysis.json', analysis);
  const plan = planAudioSegments(source.durationMs), segments = plan.map((segment, index) => ({ ...segment, status: index ? 'pending' : 'complete', requestId: `original-${index}`, ...(index ? {} : { cues: [{ text: '已完成', startMs: 0, endMs: 1000 }], words: [] }) }));
  const identity = hash(JSON.stringify({ sourceId: source.id, assetPath: source.assetPath, fingerprint: loc.fingerprint, durationMs: source.durationMs, plan, policyVersion: AUDIO_SEGMENT_POLICY.version, model: 'volc.bigasr.auc_turbo', audio: 'mp3-16k-mono-32k' }));
  await put(f.root, `.film/product-transcripts/${hash(source.id)}.json`, { version: 1, sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint: loc.fingerprint, status: 'pending', segmented: true });
  await put(f.root, `.film/product-transcripts/${hash(source.id)}.json.segments.json`, { version: 1, sourceId: source.id, durationMs: source.durationMs, identity, segments });
  await createProjectBackup(f.root, f.backup); const inspection = await inspectProjectBackup(f.backup);
  await restoreProjectBackup({ backupPath: f.backup, targetPath: f.target, confirmed: true, expectedBackupId: inspection.backupId });
  let calls = 0;
  await assert.rejects(transcribeProductSource(f.target, source, { getKey: async () => 'fake', runProvider: async () => { calls++; throw Error('must not submit'); }, readAudio: async () => Buffer.from('mock') }), /previous transcription may have been submitted/);
  assert.equal(calls, 0); assert.deepEqual(JSON.parse(await readFile(join(f.target, `.film/product-transcripts/${hash(source.id)}.json.segments.json`))).segments, segments);
});
