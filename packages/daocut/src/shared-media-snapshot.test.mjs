import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, stat, utimes, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { withMediaReferenceSnapshot, prepareMediaReferences, resolveMediaReference } from './shared-media-reference.mjs';

test('one read-only request avoids repeated synchronous NAS checks, next request revalidates changed bytes', async t => {
  const base = resolve(import.meta.dirname, '../../../.tmp/p40-media-snapshot');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')), oldHome = process.env.DAOCUT_STUDIO_HOME;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.DAOCUT_STUDIO_HOME; else process.env.DAOCUT_STUDIO_HOME = oldHome;
    assert.ok(root.startsWith(base + sep)); await rm(root, { recursive: true, force: true });
  });
  const library = join(root, 'library'), project = join(root, 'project'), home = join(root, 'home');
  for (const dir of [library, join(project, 'assets'), home]) await mkdir(dir, { recursive: true });
  process.env.DAOCUT_STUDIO_HOME = home;
  const file = join(library, 'a.mp4'), bytes = 'original media';
  await writeFile(file, bytes); const before = await stat(file);
  await writeFile(join(home, 'prefs.json'), JSON.stringify({ sharedMediaLibraries: [{ id: 'test-library', root: library }] }));
  await writeFile(join(project, 'assets/.daocut-source-media.json'), JSON.stringify({ version: 1, items: { 'assets/a.mp4': {
    mode: 'reference', libraryId: 'test-library', relativePath: 'a.mp4', size: before.size, mtimeMs: before.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  } } }));
  const original = realpathSync.native;
  let syncNetworkReads = 0;
  t.mock.method(realpathSync, 'native', function(path, ...args) {
    if (String(path).startsWith(library)) syncNetworkReads++;
    return original(path, ...args);
  });
  await withMediaReferenceSnapshot(async () => {
    for (let n = 0; n < 10; n++) {
      await prepareMediaReferences(project, 'assets/a.mp4');
      assert.equal(resolveMediaReference(project, 'assets/a.mp4').info.size, before.size);
    }
  });
  assert.equal(syncNetworkReads, 0);
  await writeFile(file, 'modified media'); await utimes(file, before.atime, before.mtime);
  await assert.rejects(withMediaReferenceSnapshot(() => prepareMediaReferences(project, 'assets/a.mp4')), /changed/);
});
