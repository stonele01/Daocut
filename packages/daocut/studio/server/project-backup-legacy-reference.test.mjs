import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat, access, readdir, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectBackup, inspectProjectBackup, restoreProjectBackup, PROJECT_BACKUP_MANIFEST } from './project-backup.mjs';
import { resolveSharedMedia } from './shared-media.mjs';

const base = fileURLToPath(new URL('../../../../.tmp/cancellation-fixes-20261105/backup/legacy', import.meta.url));
await mkdir(base, { recursive: true });
process.env.DAOCUT_STUDIO_HOME = join(base, 'studio-home');
test.beforeEach(t => t.mock.method(globalThis, 'fetch', () => { throw Error('network forbidden in isolated backup tests'); }));
const hash = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function put(root, path, value) { await mkdir(resolve(root, path, '..'), { recursive: true }); await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); }
const missing = path => assert.rejects(access(path), { code: 'ENOENT' });
async function fixture() {
  const dir = await mkdtemp(join(base, 'case-')), root = join(dir, 'original'), library = join(dir, 'isolated-library');
  const asset = 'assets/source.mp4', sourcePath = join(library, 'session.mp4'), content = 'isolated source bytes';
  await put(library, 'session.mp4', content); const info = await stat(sourcePath);
  await put(root, asset, content);
  await put(root, 'film.html', '<html>personal edit: unchanged</html>');
  await put(root, 'assets/.daocut-source-media.json', { version: 1, items: { [asset]: { libraryId: 'legacy-library', libraryName: 'Isolated library', relativePath: 'session.mp4', size: info.size, mtimeMs: info.mtimeMs } } });
  await put(root, '.film/product-analysis.json', { version: 1, sources: [{ id: 'source-a', assetPath: asset, durationMs: 10000 }], products: [{ id: 'A', name: '人工商品名', sourceIds: ['source-a'] }], intervals: [{ id: 'range-a', sourceId: 'source-a', productId: 'A', startMs: 250, endMs: 5000 }], candidates: [] });
  const takes = { version: 1, sources: [{ sourceIdentity: hash(JSON.stringify({ sourceId: 'source-a', assetPath: asset, size: info.size, mtimeMs: info.mtimeMs })), document: { sourceId: 'source-a', assetPath: asset, privateSelection: { startMs: 1000, endMs: 2000 }, film: { tracks: [] } } }] };
  await put(root, '.film/source-takes.json', takes);
  await put(root, '.film/product-transcripts/raw-responses/receipt.json', { text: '原始记录' });
  await put(root, '.film/shared-analysis/attempt.json', { descriptor: { root, taskKey: 'saved-task' }, snapshot: { pinned: 'version-one' }, outbox: { alreadyGenerated: true } });
  const backup = join(dir, 'backup'), target = join(dir, 'restored');
  await createProjectBackup(root, backup, { resolveSource: async () => sourcePath });
  const inspected = await inspectProjectBackup(backup);
  const input = { confirmed: true, backupPath: backup, targetPath: target, expectedBackupId: inspected.backupId, mappings: [{ libraryId: 'legacy-library', root: library }] };
  return { dir, root, library, asset, sourcePath, content, backup, target, input, takes, inspected };
}

test('old no-mode backup restores as a verified logical reference with personal edits and no source copy or link', async () => {
  const f = await fixture(), original = await readFile(join(f.root, '.film/product-analysis.json')), backupManifest = await readFile(join(f.backup, PROJECT_BACKUP_MANIFEST));
  assert.equal(f.inspected.sources[0].mode, undefined, 'fixture really is the old backup format');
  await missing(join(f.backup, f.asset));
  let linkCalls = 0;
  await restoreProjectBackup(f.input, { linkSource: async () => { linkCalls++; throw Object.assign(Error('test forbids OS links'), { code: 'EPERM' }); } });
  assert.equal(linkCalls, 0); await missing(join(f.target, f.asset));
  const shared = (await json(join(f.target, 'assets/.daocut-source-media.json'))).items[f.asset];
  assert.equal(shared.mode, 'reference'); assert.equal(shared.sha256, hash(f.content));
  assert.equal(shared.libraryId, 'legacy-library'); assert.equal(shared.relativePath, 'session.mp4');
  assert.equal((await resolveSharedMedia(f.target, f.asset)).path, f.sourcePath);
  assert.deepEqual(await readFile(join(f.target, '.film/product-analysis.json')), original);
  assert.deepEqual((await json(join(f.target, '.film/source-takes.json'))).sources[0].document, f.takes.sources[0].document);
  assert.deepEqual((await json(join(f.target, '.film/shared-analysis/attempt.json'))).outbox, { alreadyGenerated: true });
  assert.equal(await readFile(join(f.target, 'film.html'), 'utf8'), '<html>personal edit: unchanged</html>');
  assert.deepEqual(await readFile(join(f.root, '.film/product-analysis.json')), original);
  assert.deepEqual(await readFile(join(f.backup, PROJECT_BACKUP_MANIFEST)), backupManifest);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.content);
  // A new process has no previously verified hash cache and must resolve through the saved mapping.
  const script = `import {resolveSharedMedia} from './studio/server/shared-media.mjs';import {readFile} from 'node:fs/promises';const item=await resolveSharedMedia(${JSON.stringify(f.target)},${JSON.stringify(f.asset)});process.stdout.write(await readFile(item.path,'utf8'));`;
  const reopened = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, timeout: 10000, env: process.env, cwd: fileURLToPath(new URL('../../', import.meta.url)) });
  assert.equal(reopened.stdout, f.content);
  await assert.rejects(restoreProjectBackup(f.input), /已存在/);
});

test('legacy restore refuses same-name replacement before publishing or touching personal edits', async () => {
  const f = await fixture(), before = await readFile(join(f.root, '.film/product-analysis.json'));
  await writeFile(f.sourcePath, 'x'.repeat(Buffer.byteLength(f.content)));
  await assert.rejects(restoreProjectBackup(f.input), /内容不一致/); await missing(f.target);
  assert.deepEqual(await readFile(join(f.root, '.film/product-analysis.json')), before);
  assert.equal((await inspectProjectBackup(f.backup)).backupId, f.inspected.backupId);
  assert.ok(!(await readdir(f.dir)).some(name => name.includes('.restore-')));
});

test('legacy restore disk-full cleans staging and can retry the same saved bytes without a provider', async () => {
  const f = await fixture(), raw = await readFile(join(f.backup, PROJECT_BACKUP_MANIFEST));
  await assert.rejects(restoreProjectBackup(f.input, { copyFile: async () => { throw Object.assign(Error('disk full fixture'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  await missing(f.target); assert.ok(!(await readdir(f.dir)).some(name => name.includes('.restore-')));
  assert.deepEqual(await readFile(join(f.backup, PROJECT_BACKUP_MANIFEST)), raw);
  await restoreProjectBackup(f.input); assert.equal(await readFile((await resolveSharedMedia(f.target, f.asset)).path, 'utf8'), f.content);
});

test('a source replaced during restore cannot publish a seemingly valid migrated project', async () => {
  const f = await fixture(); let replaced = false;
  await assert.rejects(restoreProjectBackup(f.input, { copyFile: async (from, to) => { await copyFile(from, to); if (!replaced) { replaced = true; await writeFile(f.sourcePath, 'x'.repeat(Buffer.byteLength(f.content))); } } }), /来源.*变化|内容不一致/);
  await missing(f.target); assert.ok(!(await readdir(f.dir)).some(name => name.includes('.restore-')));
  assert.equal((await inspectProjectBackup(f.backup)).backupId, f.inspected.backupId);
});

test('migration refuses inconsistent saved library identity instead of silently rebinding a different source', async () => {
  const f = await fixture(), at = join(f.backup, PROJECT_BACKUP_MANIFEST), manifest = await json(at);
  const sharedPath = 'assets/.daocut-source-media.json', shared = await json(join(f.backup, sharedPath)); shared.items[f.asset].relativePath = 'another.mp4';
  await put(f.backup, sharedPath, shared);
  const bytes = await readFile(join(f.backup, sharedPath)), entry = manifest.files.find(file => file.path === sharedPath); entry.sha256 = hash(bytes); entry.size = bytes.length;
  const { manifestHash: ignored, ...body } = manifest; await writeFile(at, JSON.stringify({ ...body, manifestHash: hash(JSON.stringify(body)) }));
  await assert.rejects(restoreProjectBackup(f.input), /共享素材.*身份不一致/); await missing(f.target);
  assert.ok(!(await readdir(f.dir)).some(name => name.includes('.restore-')));
});
