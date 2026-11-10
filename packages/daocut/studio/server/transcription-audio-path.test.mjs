import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { transcribeProductSource, readProductTranscript } from './product-transcription.mjs';

function fixture(t) {
  const base = resolve(tmpdir()), root = mkdtempSync(join(base, 'daocut-asr-audio-'));
  mkdirSync(join(root, 'assets'));
  const file = join(root, 'assets/synthetic.mp4');
  childProcess.execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=10:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true });
  const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex'), original = hash();
  const noNetwork = t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden in this test'); });
  t.after(() => {
    noNetwork.mock.restore();
    assert.equal(hash(), original);
    assert.ok(resolve(root).startsWith(base + sep));
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { root, source: { id: 'synthetic-audio', assetPath: 'assets/synthetic.mp4', durationMs: 2000 } };
}

test('real local audio extraction feeds a mock ASR and reopens without extracting or submitting again', { timeout: 20000 }, async t => {
  const { root, source } = fixture(t);
  let calls = 0;
  const options = {
    getKey: async () => 'isolated-placeholder',
    runProvider: async (verb, _args, ctx) => {
      calls++; assert.equal(verb, 'asr');
      const mp3 = await ctx.read();
      const probe = JSON.parse(childProcess.execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', 'pipe:0'], { input: mp3, encoding: 'utf8', windowsHide: true }));
      assert.equal(probe.streams[0].codec_name, 'mp3');
      assert.equal(probe.streams[0].channels, 1);
      assert.equal(Number(probe.streams[0].sample_rate), 16000);
      const pcm = childProcess.execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], { input: mp3, windowsHide: true });
      assert.ok(pcm.length >= 60000 && pcm.some(byte => byte !== 0), 'actual extracted audio is non-silent');
      return { index: [{ text: '模拟字幕', words: [{ token: '模拟字幕', start: 0.1, end: 1.5 }], cues: [{ text: '模拟字幕', startMs: 100, endMs: 1500 }] }] };
    },
  };
  const first = await transcribeProductSource(root, source, options);
  assert.equal(first.cues[0].text, '模拟字幕');
  assert.equal((await readProductTranscript(root, source)).cached, true);
  const cached = await transcribeProductSource(root, source, { ...options, readAudio: async () => { throw Error('cached audio must not be extracted'); } });
  assert.deepEqual(cached.cues, first.cues); assert.equal(calls, 1);
});

test('cancelling the real extraction closes its child and never submits to the mock provider', { timeout: 20000 }, async t => {
  const { root, source } = fixture(t), control = new AbortController(), execFile = childProcess.execFile;
  let child, timer, closed, calls = 0;
  const mocked = t.mock.method(childProcess, 'execFile', (command, args, ...rest) => {
    if (command !== 'ffmpeg' || !args.includes('libmp3lame')) return execFile(command, args, ...rest);
    const at = args.indexOf('-i');
    child = execFile(command, [...args.slice(0, at), '-readrate', '0.05', ...args.slice(at)], ...rest);
    closed = new Promise(resolve => child.once('close', resolve));
    timer = setTimeout(() => control.abort(), 100);
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(transcribeProductSource(root, source, { signal: control.signal, getKey: async () => 'isolated', runProvider: async () => { calls++; throw Error('must not submit'); } }), { code: 'ASR_NOT_SUBMITTED', reason: 'audio' });
    await closed;
    assert.equal(control.signal.aborted, true); assert.equal(calls, 0);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(await readProductTranscript(root, source), null);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
    mocked.mock.restore(); syncBuiltinESMExports();
  }
});
