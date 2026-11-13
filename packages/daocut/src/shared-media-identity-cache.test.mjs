import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const moduleUrl = new URL('./shared-media-reference.mjs', import.meta.url).href;
const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
let reads=0;const original=fs.createReadStream;fs.createReadStream=(...args)=>{reads++;return original(...args)};syncBuiltinESMExports();
const {mediaContentHash}=await import(${JSON.stringify(moduleUrl)}); const started=performance.now();
const hashes=await Promise.all([mediaContentHash(process.argv[1]),mediaContentHash(process.argv[1])]);
console.log(JSON.stringify({hashes,reads,ms:performance.now()-started}));`;
async function fixture() {
  const base = resolve(import.meta.dirname, '../../../.tmp/p38/media-cache');
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  const home = join(root, 'home'), file = join(root, 'video.mp4'); await writeFile(file, 'original-content');
  const read = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, file], { env: { ...process.env, DAOCUT_STUDIO_HOME: home }, encoding: 'utf8', windowsHide: true }));
  return { root, file, home, read };
}
test('an unchanged source reuses its verified hash after a process restart without reading video bytes', async () => {
  const f = await fixture(), first = f.read(), second = f.read();
  assert.equal(first.reads, 1); assert.equal(second.reads, 0); assert.deepEqual(second.hashes, first.hashes);
});
test('same-size replacement with restored modification time invalidates the persistent hash', async () => {
  const f = await fixture(), first = f.read(), before = await stat(f.file);
  await writeFile(f.file, 'modified-content'); await utimes(f.file, before.atime, before.mtime);
  const second = f.read(); assert.equal(second.reads, 1); assert.notEqual(second.hashes[0], first.hashes[0]);
});
test('an incomplete local cache is rebuilt from the original', async () => {
  const f = await fixture(), first = f.read(), directory = join(f.home, 'cache/media-identities-v1');
  const [name] = await readdir(directory); await writeFile(join(directory, name), '{');
  const next = f.read(); assert.equal(next.reads, 1); assert.deepEqual(next.hashes, first.hashes);
});
test('unwritable cache layout does not block a correctly verified source', async () => {
  const f = await fixture(); await mkdir(f.home); await writeFile(join(f.home, 'cache'), 'not-a-directory');
  const result = f.read(); assert.equal(result.reads, 1); assert.match(result.hashes[0], /^[a-f0-9]{64}$/);
});
