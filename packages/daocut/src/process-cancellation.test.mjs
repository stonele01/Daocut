import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, kill, mix } from './shared.mjs';

// Finite fixtures even before the fix: a failing cancellation test cannot leave an infinite encoder behind.
test('ffmpeg deadline closes the actual finite encoder well before its natural end', { timeout: 15_000 }, async (t) => {
  const start = performance.now();
  const { proc, done } = ffmpeg(['-re', '-f', 'lavfi', '-i', 'anullsrc', '-t', '5', '-f', 'null', '-'], { timeoutMs: 400, what: 'bounded audio fixture' });
  const pid = proc.pid;
  await assert.rejects(done, /bounded audio fixture did not finish within 0 s/);
  const elapsed = performance.now() - start;
  t.diagnostic(JSON.stringify({ pid, elapsedMs: Math.round(elapsed), exitCode: proc.exitCode, signalCode: proc.signalCode }));
  assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'the encoder has exited, not merely a rejected promise');
  assert.ok(elapsed < 2500, `deadline must stop the five-second fixture, took ${Math.round(elapsed)} ms`);
});

test('Windows taskkill nonzero exit falls back to the owned ChildProcess handle', async () => {
  if (process.platform !== 'win32') return;
  const original = childProcess.spawn;
  const terminator = new EventEmitter();
  let calls = 0;
  const proc = { pid: 12345, exitCode: null, signalCode: null, kill(signal) { assert.equal(signal, 'SIGKILL'); calls++; return true; } };
  try {
    childProcess.spawn = (command, args, options) => {
      assert.equal(command, 'taskkill');
      assert.deepEqual(args, ['/pid', '12345', '/T', '/F']);
      assert.equal(options.windowsHide, true);
      return terminator;
    };
    syncBuiltinESMExports();
    kill(proc);
    terminator.emit('exit', 1);
    assert.equal(calls, 1, 'exit 1 is a failed termination too, even without spawn error');
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('Windows taskkill launch failure falls back once and never kills an already exited child', async () => {
  if (process.platform !== 'win32') return;
  const original = childProcess.spawn;
  const terminators = [];
  let calls = 0;
  const proc = { pid: 12345, exitCode: null, signalCode: null, kill(signal) { assert.equal(signal, 'SIGKILL'); calls++; return true; } };
  try {
    childProcess.spawn = () => { const p = new EventEmitter(); terminators.push(p); return p; };
    syncBuiltinESMExports();
    kill(proc);
    terminators[0].emit('error', new Error('test spawn denied'));
    terminators[0].emit('exit', 1);
    assert.equal(calls, 1);
    kill(proc);
    proc.exitCode = 0;
    terminators[1].emit('exit', 1);
    assert.equal(calls, 1, 'do not send another kill after the child exited');
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('kill closes only the finite child explicitly passed to it', { timeout: 12_000 }, async (t) => {
  const child = childProcess.spawn(process.execPath, ['-e', "process.stdout.write('ready');setTimeout(()=>{},5000)"], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  const start = performance.now();
  kill(child);
  await closed;
  const elapsed = performance.now() - start;
  t.diagnostic(JSON.stringify({ pid: child.pid, elapsedMs: Math.round(elapsed), exitCode: child.exitCode, signalCode: child.signalCode }));
  assert.ok(elapsed < 2500, `owned child did not stop promptly: ${Math.round(elapsed)} ms`);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('already cancelled ffmpeg never starts a process', () => {
  const controller = new AbortController(); controller.abort();
  const original = childProcess.spawn;
  let calls = 0;
  try {
    childProcess.spawn = () => { calls++; throw new Error('unexpected process'); };
    syncBuiltinESMExports();
    assert.throws(() => ffmpeg([], { signal: controller.signal }), /cancelled/i);
    assert.equal(calls, 0);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('aborting running ffmpeg rejects only after its encoder closes', { timeout: 12_000 }, async (t) => {
  const controller = new AbortController();
  const { proc, done } = ffmpeg(['-re', '-f', 'lavfi', '-i', 'anullsrc', '-t', '5', '-f', 'null', '-'], { signal: controller.signal });
  await once(proc, 'spawn');
  const start = performance.now();
  controller.abort();
  await assert.rejects(done, /cancelled/i);
  const elapsed = performance.now() - start;
  t.diagnostic(JSON.stringify({ pid: proc.pid, elapsedMs: Math.round(elapsed), exitCode: proc.exitCode, signalCode: proc.signalCode }));
  assert.ok(elapsed < 2500, 'cancel stops the encoder before natural completion');
  assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'reject waits for actual close');
});

test('mix passes cancellation to its encoder and removes its long filter script', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-mix-cancel-'));
  const tone = join(root, 'tone.wav');
  const controller = new AbortController();
  const original = childProcess.spawn;
  let encoder;
  try {
    const generated = childProcess.spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', tone], { windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr?.toString());
    childProcess.spawn = (command, args, options) => {
      const proc = original(command, args, options);
      if (command === 'ffmpeg' && args.includes('[out]')) {
        encoder = proc;
        proc.once('spawn', () => controller.abort());
      }
      return proc;
    };
    syncBuiltinESMExports();
    const clips = Array.from({ length: 400 }, (_, i) => ({ file: tone, at: (i % 20) * .1, from: 0, to: 1, channels: 1, volume: .01, speed: 1 }));
    await assert.rejects(mix(clips, 3, join(root, 'mix.wav'), ['-c:a', 'pcm_s16le'], { signal: controller.signal }), /cancelled/i);
    assert.ok(encoder, 'a real mixing encoder was started');
    assert.ok(encoder.exitCode !== null || encoder.signalCode !== null);
    assert.equal(readdirSync(root).some((name) => name.endsWith('.filter')), false, 'long filter is cleaned after cancellation');
  } finally {
    childProcess.spawn = original; syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
