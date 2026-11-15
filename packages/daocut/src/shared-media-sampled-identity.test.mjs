import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const moduleUrl = new URL('./shared-media-reference.mjs', import.meta.url).href;
const script = `import fs from 'node:fs'; import fsp from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
let bytes=0,streams=0;const originalOpen=fsp.open,originalStream=fs.createReadStream;
fsp.open=async(...args)=>{const file=await originalOpen(...args);if(args[0]===process.argv[1]){const read=file.read.bind(file);file.read=async(...a)=>{const r=await read(...a);bytes+=r.bytesRead;return r;};}return file;};
fs.createReadStream=(...args)=>{streams++;return originalStream(...args)};syncBuiltinESMExports();
const {mediaEditingIdentity,mediaContentHash}=await import(${JSON.stringify(moduleUrl)});const progress=[];
const values=await Promise.all([mediaEditingIdentity(process.argv[1],{onProgress:p=>progress.push(p)}),mediaEditingIdentity(process.argv[1])]);
const full=process.argv[2]==='full'?await mediaContentHash(process.argv[1]):null;
console.log(JSON.stringify({values,bytes,streams,progress,full}));`;

test('large source cold open reads at most eight MiB, shares concurrent reads, and persists an explicitly sampled identity', async t => {
  const base = resolve('.tmp/sampled-identity-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'large.mp4'); await writeFile(file, Buffer.alloc(16 * 1024 * 1024, 3));
  const run = full => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, file, full ? 'full' : 'sample'], { env: { ...process.env, DAOCUT_STUDIO_HOME: join(root, 'home') }, windowsHide: true, encoding: 'utf8' }));
  const cold = run(false), warm = run(true);
  assert.equal(cold.bytes, 8 * 1024 * 1024); assert.equal(cold.streams, 0);
  assert.deepEqual(cold.values[0], cold.values[1]); assert.equal(cold.values[0].identityKind, 'sampled-sha256-v1');
  assert.equal(cold.progress.at(-1).bytesRead, cold.bytes); assert.equal(cold.progress.at(-1).totalBytes, cold.bytes);
  assert.equal(warm.bytes, 0); assert.equal(warm.streams, 1, 'full verification must never reuse a sampled digest');
  assert.deepEqual(warm.values, cold.values); assert.notEqual(warm.full, warm.values[0].sha256);
  // A replacement at an interior sampled position must not reopen old analysis.
  const handle = await open(file, 'r+'); await handle.write(Buffer.from([4]), 0, 1, Math.floor((16 * 1024 * 1024 - 1024 * 1024) * 3 / 7)); await handle.close();
  const changed = run(false); assert.equal(changed.bytes, cold.bytes); assert.notEqual(changed.values[0].sha256, cold.values[0].sha256);
});
