import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { filmHtml } from './film-doc.mjs';
import { render } from './render.mjs';

for (const stage of ['frames', 'mix', 'mux']) test(`cancelling during ${stage} closes the actual encoder and fails the render`, { timeout: 60000 }, async t => {
  const base = resolve(tmpdir()), root = mkdtempSync(join(base, `daocut-cancel-${stage}-`));
  mkdirSync(join(root, 'assets'));
  const tone = join(root, 'assets/tone.wav');
  childProcess.execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', tone], { windowsHide: true });
  writeFileSync(join(root, 'page.html'), '<!doctype html><body style="background:red"><script>window.film={width:160,height:90,duration:1,frame(){}}</script>');
  writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 160, h: 90, fps: 10 }, tracks: [{ clips: [{ id: 'v', src: 'page.html', at: 0, time: [0, 1] }] }, { clips: [{ id: 'a', src: 'assets/tone.wav', at: 0, time: [0, 1] }] }] }));
  const control = new AbortController(), spawn = childProcess.spawn;
  let target, timer, abortedAt, closedAt;
  const instrument = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const matches = command === 'ffmpeg' && (stage === 'frames' ? args.includes('image2pipe') : stage === 'mix' ? args.includes('-filter_complex') : args.some((arg, i) => arg === '-c' && args[i + 1] === 'copy'));
    if (!matches) return spawn(command, args, options);
    assert.equal(target, undefined, 'the cancelled stage is not retried');
    // A real finite encoder, slowed so cancellation is tied to its spawn rather than a guessed render delay.
    const at = args.indexOf('-i');
    target = spawn(command, [...args.slice(0, at), '-readrate', '0.1', ...args.slice(at)], options);
    target.once('close', () => { closedAt = Date.now(); });
    timer = setTimeout(() => { abortedAt = Date.now(); control.abort(); }, 100);
    return target;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(render([root], { out: join(root, 'out.mp4'), workers: 1, hardware: false, seekable: false, fps: 10, signal: control.signal, onProgress() {} }), /cancelled/);
    assert.ok(target?.pid, 'the target stage actually started');
    assert.ok(closedAt >= abortedAt, 'the child closed before render returned');
    assert.ok(closedAt - abortedAt < 3000, `cancel took ${closedAt - abortedAt} ms`);
    assert.ok(target.exitCode !== null || target.signalCode !== null, 'the child really exited');
    assert.equal(existsSync(join(root, '.film/cache/render', `.parts-${process.pid}`)), false, 'no partial render parts');
  } finally {
    t.diagnostic(JSON.stringify({ stage, pid: target?.pid, aborted: control.signal.aborted, abortedAt, closedAt, exitCode: target?.exitCode, signalCode: target?.signalCode }));
    clearTimeout(timer);
    if (target && target.exitCode === null && target.signalCode === null) {
      const closed = new Promise(resolve => target.once('close', resolve));
      target.kill('SIGKILL'); await closed;
    }
    instrument.mock.restore(); syncBuiltinESMExports();
    assert.ok(resolve(root).startsWith(base + sep));
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
