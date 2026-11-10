import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileOf } from './shared.mjs';
import { serve } from './host.mjs';
import { prepareMediaReferences } from './shared-media-reference.mjs';
import { FileError, importFile, makeFolder, moveFile, trashFile } from '../studio/server/files.mjs';

function fixture(t) {
  const base = resolve(tmpdir()), scratch = mkdtempSync(join(base, 'daocut-path-boundary-'));
  const root = join(scratch, 'project'), library = join(scratch, 'library'), home = join(scratch, 'home');
  for (const path of [join(root, 'assets'), library, home]) mkdirSync(path, { recursive: true });
  const was = process.env.DAOCUT_STUDIO_HOME;
  process.env.DAOCUT_STUDIO_HOME = home;
  t.after(() => {
    if (was === undefined) delete process.env.DAOCUT_STUDIO_HOME; else process.env.DAOCUT_STUDIO_HOME = was;
    assert.ok(resolve(scratch).startsWith(base + sep));
    rmSync(scratch, { recursive: true, force: true });
  });
  return { root, library, home, scratch };
}

function reference({ root, library, home }) {
  const path = join(library, 'source.wav'), text = 'isolated source bytes';
  writeFileSync(path, text);
  const info = statSync(path), asset = 'assets/source.wav';
  const record = { mode: 'reference', libraryId: 'path-test-library', relativePath: 'source.wav', sha256: createHash('sha256').update(text).digest('hex'), size: info.size, mtimeMs: info.mtimeMs };
  writeFileSync(join(home, 'prefs.json'), JSON.stringify({ sharedMediaLibraries: [{ id: record.libraryId, root: library }] }));
  const save = () => writeFileSync(join(root, 'assets/.daocut-source-media.json'), JSON.stringify({ version: 1, items: { [asset]: record } }));
  save();
  return { path, text, asset, record, save };
}

// Independent of the original native-link tests: a denied symlink must not hide these assertions.
test('fileOf ordinary paths and encoded traversal are checked without creating a symlink', t => {
  const { root, scratch } = fixture(t);
  writeFileSync(join(root, 'assets/a.mp3'), 'inside');
  writeFileSync(join(scratch, 'outside.mp3'), 'outside');
  assert.equal(fileOf(root, 'film.html', 'assets/a.mp3'), join(root, 'assets/a.mp3'));
  assert.equal(fileOf(root, 'scenes/one.html', '../assets/a.mp3'), join(root, 'assets/a.mp3'));
  assert.equal(fileOf(root, 'film.html', '../../outside.mp3'), join(root, 'outside.mp3'));
  for (const src of ['x%2F..%2F..%2Foutside.mp3', '%2E%2E%2Foutside.mp3']) {
    assert.throws(() => fileOf(root, 'film.html', src), /outside the film's folder/);
  }
  assert.throws(() => fileOf(root, 'film.html', '%E0%A4%A'), URIError);
});

test('HTTP ordinary paths, encoded traversal and malformed URLs are checked without links', async t => {
  const { root, scratch } = fixture(t);
  writeFileSync(join(root, 'assets/a.txt'), 'mine');
  writeFileSync(join(scratch, 'secret.txt'), 'secret');
  const site = await serve(root);
  try {
    const read = async path => { const response = await fetch(site.url + path); return [response.status, await response.text()]; };
    assert.deepEqual(await read('/assets/a.txt'), [200, 'mine']);
    assert.notEqual((await read('/%2e%2e/secret.txt'))[1], 'secret');
    assert.notEqual((await read('/assets/..%2f..%2fsecret.txt'))[1], 'secret');
    assert.equal((await read('/%E0%A4%A'))[0], 400);
    assert.deepEqual(await read('/assets/a.txt'), [200, 'mine']);
  } finally { await site.close(); }
});

test('file mutations reject parent paths and leave the external source unchanged', async t => {
  const { root, library } = fixture(t);
  writeFileSync(join(library, 'secret.wav'), 'outside');
  writeFileSync(join(root, 'assets/mine.wav'), 'inside');
  const escape = '../library/secret.wav';
  await assert.rejects(importFile(root, escape, Readable.from(['changed'])), FileError);
  await assert.rejects(makeFolder(root, '../library/new'), FileError);
  await assert.rejects(moveFile(root, 'assets/mine.wav', escape), FileError);
  await assert.rejects(moveFile(root, escape, 'assets/stolen.wav'), FileError);
  await assert.rejects(trashFile(root, escape), FileError);
  assert.deepEqual(readdirSync(library), ['secret.wav']);
  assert.equal(readFileSync(join(library, 'secret.wav'), 'utf8'), 'outside');
  assert.equal(readFileSync(join(root, 'assets/mine.wav'), 'utf8'), 'inside');
});

test('fileOf reads a verified logical source, never an unknown or unprepared source', async t => {
  const f = fixture(t), ref = reference(f);
  assert.throws(() => fileOf(f.root, 'film.html', ref.asset), { code: 'SHARED_MEDIA_UNVERIFIED' });
  await prepareMediaReferences(f.root, ref.asset);
  assert.equal(fileOf(f.root, 'film.html', ref.asset), ref.path);
  assert.equal(readFileSync(fileOf(f.root, 'scenes/one.html', '../' + ref.asset), 'utf8'), ref.text);
  assert.equal(fileOf(f.root, 'film.html', 'assets/unknown.wav'), join(f.root, 'assets/unknown.wav'));
  ref.record.libraryId = 'unconfigured-library'; ref.save();
  assert.throws(() => fileOf(f.root, 'film.html', ref.asset), /Configure this material library/);
});

test('logical source refuses escaped identities and changed content without rewriting the source', async t => {
  const f = fixture(t), ref = reference(f);
  for (const path of ['../secret.wav', 'source.wav:stream', '.private/source.wav']) {
    ref.record.relativePath = path; ref.save();
    await assert.rejects(prepareMediaReferences(f.root), /Invalid logical media path/);
  }
  ref.record.relativePath = 'source.wav'; ref.record.sha256 = '0'.repeat(64); ref.save();
  await assert.rejects(prepareMediaReferences(f.root), /content changed/);
  assert.equal(readFileSync(ref.path, 'utf8'), ref.text);
});
