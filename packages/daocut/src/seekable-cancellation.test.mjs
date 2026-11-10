import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seekableCopies } from './seekable.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setImmediate(r));

// Controlled local subprocesses exercise the real copy/cache code at precise await boundaries. They are not
// evidence about codecs or Windows process termination; seekable.test.mjs retains the real 240-frame checks.
function fixture(t, { holdEncoder = false, holdColor = false, autoFinish = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'daocut-seek-cancel-'));
  const file = join(root, 'source.mov'); fs.writeFileSync(file, 'isolated source');
  const encoder = deferred(), color = deferred(), started = deferred(), runs = [];
  let releaseEncoder = () => {}, releaseColor = () => {};
  t.mock.method(childProcess, 'execFile', (name, args, _options, callback) => {
    let answer = '';
    if (name === 'ffprobe') answer = JSON.stringify({ streams: [{ codec_name: 'prores', width: 320, height: 180, pix_fmt: 'yuv422p10le', avg_frame_rate: '30/1' }] });
    if (args.includes('-encoders')) answer = ' V..... h264_nvenc\n V..... h264_videotoolbox\n';
    const finish = () => queueMicrotask(() => callback(null, answer));
    if (args.includes('-encoders') && holdEncoder) { releaseEncoder = finish; encoder.resolve(); }
    else if (name === 'ffprobe' && args.some((a) => a.startsWith('stream=color_'))) { releaseColor = finish; color.resolve(); if (!holdColor) finish(); }
    else finish();
    return new EventEmitter();
  });
  t.mock.method(childProcess, 'spawn', (name, args) => {
    assert.equal(name, 'ffmpeg', 'only the mocked converter may be started');
    const out = args.at(-1); assert.match(out, /\.part-/);
    const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.exitCode = null; proc.signalCode = null;
    proc.kills = 0;
    proc.finish = (code = 0) => { if (proc.exitCode !== null) return; proc.exitCode = code; proc.emit('close', code); };
    proc.kill = () => { proc.kills++; queueMicrotask(() => proc.finish(1)); return true; };
    fs.writeFileSync(out, 'whole simulated picture'); runs.push(proc); started.resolve(proc);
    if (autoFinish) queueMicrotask(() => proc.finish());
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { releaseEncoder(); releaseColor(); for (const run of runs) run.finish(1); t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, runs, encoder, color, started, releaseEncoder: () => releaseEncoder(), releaseColor: () => releaseColor(),
    list: () => fs.readdirSync(join(root, '.film', 'cache', 'seek')), ask: { plays: async () => false, slow: false } };
}

test('cancel during encoder discovery never starts a conversion after the discovery returns', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { holdEncoder: true }), quit = new AbortController();
  const pending = seekableCopies([f.file], f.root, { ...f.ask, signal: quit.signal });
  await f.encoder.promise; quit.abort(); f.releaseEncoder();
  assert.equal((await pending).size, 0);
  assert.equal(f.runs.length, 0, 'no encoder starts after cancellation');
  assert.deepEqual(f.list(), []);
});

test('cancel during color probing never starts a conversion after the probe returns', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { holdColor: true }), quit = new AbortController();
  const pending = seekableCopies([f.file], f.root, { ...f.ask, signal: quit.signal });
  await f.color.promise; quit.abort(); f.releaseColor();
  assert.equal((await pending).size, 0);
  assert.equal(f.runs.length, 0, 'no encoder starts after cancellation');
  assert.deepEqual(f.list(), []);
});

test('cancel during the browser probe makes no copy', { timeout: 5000 }, async (t) => {
  const f = fixture(t), quit = new AbortController(), entered = deferred(), release = deferred();
  const pending = seekableCopies([f.file], f.root, { slow: false, signal: quit.signal, plays: async () => { entered.resolve(); await release.promise; return false; } });
  await entered.promise; quit.abort(); release.resolve();
  assert.equal((await pending).size, 0); assert.equal(f.runs.length, 0); assert.deepEqual(f.list(), []);
});

test('a cancelled waiter cannot use or stop another caller\'s completed copy', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { autoFinish: false }), quit = new AbortController(), entered = deferred();
  const owner = seekableCopies([f.file], f.root, f.ask);
  const proc = await f.started.promise;
  const waiter = seekableCopies([f.file], f.root, { signal: quit.signal, slow: false, plays: async () => { entered.resolve(); return false; } });
  await entered.promise; await turn(); quit.abort(); proc.finish();
  const [a, b] = await Promise.all([owner, waiter]);
  assert.equal(a.size, 1); assert.equal(b.size, 0, 'cancelled consumer gets no completed copy');
  assert.equal(proc.kills, 0, 'the other caller still owns the conversion');
  assert.equal(f.runs.length, 1, 'concurrent requests share one conversion');
  assert.equal(f.list().length, 1); assert.ok(f.list().every((name) => !name.includes('.part-')));
});

test('cancel during conversion waits for its child to close and removes the partial file', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { autoFinish: false }), quit = new AbortController();
  const pending = seekableCopies([f.file], f.root, { ...f.ask, signal: quit.signal });
  const proc = await f.started.promise; quit.abort();
  assert.equal((await pending).size, 0); assert.equal(proc.kills, 1); assert.notEqual(proc.exitCode, null); assert.deepEqual(f.list(), []);
});

test('cancel after encoder close but before publication does not publish the partial file', { timeout: 5000 }, async (t) => {
  const f = fixture(t, { autoFinish: false }), quit = new AbortController();
  const pending = seekableCopies([f.file], f.root, { ...f.ask, signal: quit.signal });
  const proc = await f.started.promise; proc.finish(); quit.abort();
  assert.equal((await pending).size, 0); assert.deepEqual(f.list(), [], 'cancelled output is not a reusable cache entry');
});

test('cancel while a cache rename is busy stops publication retries and removes the partial file', { timeout: 5000 }, async (t) => {
  const f = fixture(t), quit = new AbortController();
  const rename = fs.renameSync; let attempts = 0;
  t.mock.method(fs, 'renameSync', (...args) => { if (++attempts === 1) { quit.abort(); throw Object.assign(new Error('isolated busy file'), { code: 'EBUSY' }); } return rename(...args); });
  syncBuiltinESMExports();
  const result = await seekableCopies([f.file], f.root, { ...f.ask, signal: quit.signal });
  assert.equal(result.size, 0); assert.equal(attempts, 1); assert.deepEqual(f.list(), []);
});
