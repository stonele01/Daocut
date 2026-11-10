import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createWaveformPeaks, MediaError, waveform } from './derived.mjs';

const base = resolve('../../.tmp/long-live-implementation-20261103/wave/unit');
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/input.wav'), 'isolated fake file for a mocked decoder');
  return root;
}

test('streamed peaks preserve sample and peak boundaries across arbitrary byte chunks', () => {
  const pcm = Buffer.alloc(601 * 2);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(16384, 200 * 2);
  pcm.writeInt16LE(8192, 599 * 2);
  pcm.writeInt16LE(-1000, 600 * 2);
  const expected = { duration: 601 / 8000, peaks: [1, 0.5, 0.25, 0.031] };
  for (const size of [1, 2, 3, 199, 200, 399, 400, 401, 65536]) {
    const result = createWaveformPeaks();
    for (let at = 0; at < pcm.length; at += size) {
      result.push(Buffer.alloc(0));
      result.push(pcm.subarray(at, at + size));
    }
    assert.deepEqual(result.finish(), expected, `chunk size ${size}`);
  }
  const empty = createWaveformPeaks();
  empty.push(Buffer.from([0xff]));
  assert.deepEqual(empty.finish(), { duration: 0, peaks: [] }, 'incomplete final sample is ignored as before');
});

async function withDecoder(t, run, decode) {
  t.mock.method(childProcess, 'spawn', (_name, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => decode(child, args));
    return child;
  });
  syncBuiltinESMExports();
  try { await run(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

test('concurrent waveform requests share one decoder and reuse the persisted source cache', async t => {
  const root = await fixture();
  let calls = 0;
  await withDecoder(t, async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => waveform(root, 'assets/input.wav')));
    assert.equal(calls, 1);
    for (const result of results) assert.deepEqual(result, { duration: 0.025, peaks: [0.5] });
    const cacheDir = join(root, '.film/cache/waves');
    const names = await readdir(cacheDir); assert.equal(names.length, 1);
    const cacheFile = join(cacheDir, names[0]), saved = await readFile(cacheFile), before = await stat(cacheFile);
    assert.deepEqual(await waveform(root, 'assets/input.wav'), results[0]);
    assert.equal(calls, 1);
    assert.equal((await stat(cacheFile)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await readFile(cacheFile), saved);
    await utimes(join(root, 'assets/input.wav'), new Date(), new Date(Date.now() + 5000));
    await waveform(root, 'assets/input.wav');
    assert.equal(calls, 2, 'changed source gets a new cache entry');
  }, child => {
    calls++;
    const pcm = Buffer.alloc(400); pcm.writeInt16LE(16384, 398);
    child.stdout.write(pcm.subarray(0, 1)); child.stdout.end(pcm.subarray(1));
    child.stderr.end(); child.emit('close', 0);
  });
});

test('failed or missing decoder leaves no successful waveform cache and releases the job', async t => {
  const root = await fixture();
  let calls = 0;
  await withDecoder(t, async () => {
    await assert.rejects(waveform(root, 'assets/input.wav'), e => e instanceof MediaError && e.status === 422 && /no audio stream/.test(e.message));
    assert.deepEqual(await readdir(join(root, '.film/cache/waves')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e)), []);
    await assert.rejects(waveform(root, 'assets/input.wav'), e => e instanceof MediaError && e.status === 501);
    assert.deepEqual(await readdir(join(root, '.film/cache/waves')).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e)), []);
    assert.deepEqual(await waveform(root, 'assets/input.wav'), { duration: 0.025, peaks: [0] });
    assert.equal(calls, 3);
  }, child => {
    calls++;
    if (calls === 1) {
      child.stdout.end(Buffer.alloc(400));
      child.stderr.end('no audio stream'); child.emit('close', 1);
    } else if (calls === 2) {
      child.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
      child.stdout.end(); child.stderr.end(); child.emit('close', -2);
    } else {
      child.stdout.end(Buffer.alloc(400)); child.stderr.end(); child.emit('close', 0);
    }
  });
});

test('different waveform jobs respect the shared three-decoder limit', async t => {
  const root = await fixture();
  const files = Array.from({ length: 8 }, (_, i) => `assets/tone-${i}.wav`);
  await Promise.all(files.map(file => writeFile(join(root, file), 'isolated synthetic placeholder')));
  let busy = 0, highest = 0, calls = 0;
  await withDecoder(t, async () => {
    const results = await Promise.all(files.map(file => waveform(root, file)));
    assert.equal(calls, files.length);
    assert.equal(highest, 3);
    assert.equal(busy, 0);
    assert.ok(results.every(result => result.duration === 0.025));
  }, child => {
    calls++; busy++; highest = Math.max(highest, busy);
    setTimeout(() => {
      child.stdout.end(Buffer.alloc(400)); child.stderr.end(); busy--; child.emit('close', 0);
    }, 5);
  });
});
