import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filmHtml } from './film-doc.mjs';
import { FilmPage } from './host.mjs';
import { render } from './render.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setImmediate(r));

for (const kind of ['cancel', 'capture error']) test(`frame ${kind} waits for encoder streams before cleaning parts, preserving the error`, { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'daocut-encoder-close-'));
  fs.writeFileSync(join(root, 'page.html'), '<!doctype html><body><script>window.film={width:160,height:90,duration:1,frame(){}}</script>');
  fs.writeFileSync(join(root, 'film.html'), filmHtml({ stage: { w: 160, h: 90, fps: 10 }, tracks: [{ clips: [{ id: 'v', src: 'page.html', at: 0, time: [0, 1] }] }] }));
  const controller = new AbortController(), spawn = childProcess.spawn, remove = fs.rmSync;
  const failure = new Error(kind === 'cancel' ? 'cancelled' : 'isolated capture failure');
  const children = [], capture = deferred();
  let earlyCleanup = 0, capturedAt, settled = false, pending;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command !== 'ffmpeg' || !args.includes('image2pipe')) return spawn(command, args, options);
    // A real finite child, acting only as the encoder's process lifecycle. The separate stage tests use FFmpeg.
    // EOF alone does not stop it, so a capture failure must actively stop both encoder and alpha watcher.
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();setTimeout(()=>{},5000)'], options);
    const actualClose = deferred(), emit = child.emit;
    const item = { child, actualClose, closeArgs: null, forwarded: false, release() { if (this.closeArgs && !this.forwarded) { this.forwarded = true; emit.call(child, 'close', ...this.closeArgs); } } };
    child.emit = function (name, ...args) { if (name === 'close') { item.closeArgs = args; actualClose.resolve(); return true; } return emit.call(this, name, ...args); };
    children.push(item);
    return child;
  });
  t.mock.method(FilmPage.prototype, 'capture', async () => {
    capturedAt = Date.now(); capture.resolve();
    if (kind === 'cancel') controller.abort();
    throw failure;
  });
  t.mock.method(fs, 'rmSync', (path, options) => {
    if (String(path).includes(`.parts-${process.pid}`) && children.some((p) => !p.forwarded)) earlyCleanup++;
    return remove(path, options);
  });
  syncBuiltinESMExports();
  try {
    pending = render([root], { out: join(root, 'out.mov'), workers: 1, hardware: false, seekable: false, silent: true, fps: 10, signal: controller.signal, onProgress() {},
      ...(kind === 'capture error' ? { alpha: true, clear: { video: ['-c:v', 'png'], pix: 'format=rgba' } } : {}) });
    const outcome = pending.then(() => { settled = true; return { error: null }; }, (error) => { settled = true; return { error }; });
    await capture.promise;
    assert.equal(children.length, kind === 'capture error' ? 2 : 1, 'capture failure also exercises the alpha watcher');
    await Promise.all(children.map((p) => p.actualClose.promise));
    await turn();
    assert.equal(earlyCleanup, 0, 'parts cannot be removed until every encoder stream has closed');
    assert.equal(settled, false, 'render cannot finish while child close notifications are still held');
    assert.ok(Date.now() - capturedAt < 3000, 'failure actively terminates the five-second children');
    for (const child of children) child.release();
    const result = await outcome;
    if (kind === 'capture error') assert.equal(result.error, failure, 'cleanup cannot replace the original capture error');
    else assert.match(result.error?.message ?? '', /cancelled/);
    assert.ok(children.every((p) => p.child.exitCode !== null || p.child.signalCode !== null));
    assert.equal(fs.existsSync(join(root, '.film/cache/render', `.parts-${process.pid}`)), false);
  } finally {
    for (const item of children) { if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL'); await item.actualClose.promise; item.release(); }
    await pending?.catch(() => {});
    t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
