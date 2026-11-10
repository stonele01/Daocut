import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureError, FilmPage, serve, vulkanFirst } from './host.mjs';
import { locate } from './shared.mjs';

test('cancelled media requests close their files so the project can be renamed', { timeout: 10000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-host-cancel-'));
  const root = join(scratch, 'film');
  mkdirSync(root);
  const data = Buffer.alloc(16 * 1024 * 1024);
  data.write('0123456789');
  writeFileSync(join(root, 'video.mp4'), data);
  const streams = [];
  const create = fs.createReadStream;
  const mocked = t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = create(...args);
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  const site = await serve(root);
  try {
    const head = await fetch(`${site.url}/video.mp4`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(streams.length, 0, 'HEAD opens no file stream');
    const part = await fetch(`${site.url}/video.mp4`, { headers: { range: 'bytes=0-7' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '01234567');
    for (const range of [undefined, 'bytes=0-']) {
      await new Promise((done, fail) => {
        const req = get(`${site.url}/video.mp4`, { headers: range ? { range } : {} }, (res) => {
          res.on('error', () => {});
          res.once('data', () => { res.destroy(); done(); });
        });
        req.on('error', fail);
      });
      const stream = streams.at(-1);
      if (!stream.closed) await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('cancelled request left its file open')), 1500);
        stream.once('close', () => { clearTimeout(timer); done(); });
      });
      assert.equal(stream.closed, true, `${range ?? 'full'} request releases its file`);
    }
    await fs.promises.rename(root, join(scratch, 'renamed'));
    assert.equal(fs.existsSync(join(scratch, 'renamed', 'video.mp4')), true);
  } finally {
    for (const stream of streams) {
      stream.destroy();
      if (!stream.closed) await once(stream, 'close');
    }
    await site.close();
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('the served folder is all a page reads: no way out through .., a link or a malformed address', { skip: process.platform === 'win32' && 'links need Developer Mode on Windows' }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-host-'));
  const root = join(scratch, 'film');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'a.txt'), 'mine');
  writeFileSync(join(scratch, 'secret.txt'), 'secret');
  /* a film from elsewhere can bring links to anywhere: to a file, and to a folder above it */
  symlinkSync(join(scratch, 'secret.txt'), join(root, 'assets', 'notes.txt'));
  symlinkSync(scratch, join(root, 'assets', 'up'));
  /* a link that stays inside is followed */
  symlinkSync(join(root, 'assets', 'a.txt'), join(root, 'same.txt'));
  const site = await serve(root);
  try {
    const get = async (path) => { const r = await fetch(site.url + path); return [r.status, await r.text()]; };
    assert.deepEqual(await get('/assets/a.txt'), [200, 'mine']);
    assert.deepEqual(await get('/same.txt'), [200, 'mine']);
    assert.equal((await get('/assets/notes.txt'))[0], 403);
    assert.equal((await get('/assets/up/secret.txt'))[0], 403);
    assert.notEqual((await get('/%2e%2e/secret.txt'))[1], 'secret');
    assert.notEqual((await get('/assets/..%2f..%2fsecret.txt'))[1], 'secret');
    assert.equal((await get('/%E0%A4%A'))[0], 400);
    assert.deepEqual(await get('/assets/a.txt'), [200, 'mine'], 'and it still serves');
  } finally {
    await site.close();
  }
});

test('look and render serve the film\'s project, never the folders around it', () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'of-work-')));
  const film = join(work, 'forked');
  mkdirSync(join(film, 'scenes'), { recursive: true });
  writeFileSync(join(film, 'film.html'), '{"stage":{"w":16,"h":9},"tracks":[]}');
  writeFileSync(join(film, 'scenes', 'title.html'), '<!doctype html>');
  mkdirSync(join(work, 'page'));
  writeFileSync(join(work, 'page', 'index.html'), '<!doctype html>');
  writeFileSync(join(work, '.env'), 'SECRET=1');
  const was = process.cwd();
  process.chdir(work);
  try {
    /* run from a folder that holds other things (a workspace, a home folder) */
    assert.equal(locate('forked').root, film);
    assert.equal(locate('forked/scenes/title.html').root, film, 'a scene page still reaches ../ inside its project');
    assert.equal(locate('page').root, join(work, 'page'), 'a page on its own is served from its own folder');
    /* a host that names the project serves it */
    assert.equal(locate(join(film, 'scenes', 'title.html'), film).root, film);
  } finally {
    process.chdir(was);
  }
});

test('Windows: Vulkan when its renderer is a GPU, read once; otherwise the default, for every later browser too', async () => {
  /** A launcher that records what each browser was opened with; `fails` makes a Vulkan launch throw. */
  const launcher = (fails = false) => {
    const opened = /** @type {string[][]} */ ([]), closed = /** @type {string[][]} */ ([]);
    const open = async (/** @type {string[]} */ angle) => {
      opened.push(angle);
      if (fails && angle.length) throw new Error('no Vulkan driver');
      return /** @type {any} */ ({ angle, close: async () => { closed.push(angle); } });
    };
    return { open, opened, closed };
  };
  const reads = (/** @type {() => Promise<string>} */ said) => {
    let count = 0;
    return { renderer: async () => { count++; return said(); }, get count() { return count; } };
  };
  const vulkan = ['--use-angle=vulkan'];

  const gpu = reads(async () => 'ANGLE (NVIDIA, Vulkan 1.4.329 (NVIDIA GeForce RTX 5070 Laptop GPU (0x00002D58)), NVIDIA)');
  let l = launcher(), pick = vulkanFirst(gpu.renderer);
  const browsers = await Promise.all([pick(l.open), pick(l.open), pick(l.open)]);
  assert.deepEqual(browsers.map((b) => b.angle), [vulkan, vulkan, vulkan]);
  assert.equal(gpu.count, 1);
  assert.deepEqual(l.closed, []);

  /* WARP is Microsoft's own software rasteriser: a machine with no GPU driver, or a remote session, reads it. */
  for (const said of [
    async () => 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    async () => 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    async () => 'none',
    async () => { throw new Error('page crashed'); },
  ]) {
    const software = reads(said);
    l = launcher(); pick = vulkanFirst(software.renderer);
    const [first, second] = await Promise.all([pick(l.open), pick(l.open)]);
    assert.deepEqual([first.angle, second.angle], [[], []]);
    assert.deepEqual(l.opened, [vulkan, [], []]);
    assert.deepEqual(l.closed, [vulkan]);
    assert.equal(software.count, 1);
  }

  const never = reads(async () => 'unused');
  l = launcher(true); pick = vulkanFirst(never.renderer);
  assert.deepEqual((await pick(l.open)).angle, []);
  assert.deepEqual((await pick(l.open)).angle, []);
  assert.deepEqual(l.opened, [vulkan, [], []]);
  assert.equal(never.count, 0);
});

/** A capture target whose CDP responses can fail without starting a browser. */
function captureTarget(send) {
  const film = new FilmPage();
  film.entry = 'scenes/title.html';
  film.frameTime = 1.234567;
  film.meta = { width: 320, height: 180 };
  film.scale = 2;
  film.problems = [];
  let paints = 0;
  film.page = { isClosed: () => false, evaluate: async () => { paints++; } };
  film.browser = { isConnected: () => true };
  film.cdp = { send };
  return { film, paints: () => paints };
}
const emptyScreenshot = () => new Error('cdpSession.send: Protocol error (Page.captureScreenshot): Unable to capture screenshot');

test('an empty screenshot gets one compositor wait and the identical capture again, without redrawing the film', async () => {
  const calls = [];
  const { film, paints } = captureTarget(async (...args) => {
    calls.push(args);
    if (calls.length === 1) throw emptyScreenshot();
    return { data: Buffer.from('picture').toString('base64') };
  });
  film.seek = () => { throw new Error('capture must not call frame again'); };
  assert.equal((await film.capture({ format: 'jpeg', quality: 95 })).toString(), 'picture');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0][1].clip, { x: 0, y: 0, width: 320, height: 180, scale: 2 });
  assert.equal(paints(), 1);
  assert.equal(film.frameTime, 1.234567);
  assert.match(film.problems[0].message, /recovered on capture attempt 2/);
});

test('a persistent empty screenshot stops after two captures with the exact page, time, dimensions and cause', async () => {
  let calls = 0;
  const error = emptyScreenshot();
  const { film } = captureTarget(async () => { calls++; throw error; });
  await assert.rejects(film.capture(), (e) => {
    assert.ok(e instanceof CaptureError);
    assert.equal(e.cause, error);
    assert.ok(e.message.includes('scenes/title.html: picture at 1.234567 s (640×360, png)'));
    assert.match(e.message, /capture attempt 2\/2.*Unable to capture screenshot/);
    return true;
  });
  assert.equal(calls, 2);
});

test('unrelated capture errors and closed browsers are never retried', async () => {
  for (const reason of ['Protocol error (Page.captureScreenshot): Invalid parameters', 'Target page, context or browser has been closed', 'ERR_MEMORY_ALLOCATION_FAILED']) {
    let calls = 0;
    const { film, paints } = captureTarget(async () => { calls++; throw new Error(reason); });
    await assert.rejects(film.capture(), (e) => e.cause.message === reason);
    assert.equal(calls, 1);
    assert.equal(paints(), 0);
  }
  for (const closed of ['page', 'browser']) {
    let calls = 0;
    const { film, paints } = captureTarget(async () => { calls++; throw emptyScreenshot(); });
    if (closed === 'page') film.page.isClosed = () => true;
    else film.browser.isConnected = () => false;
    await assert.rejects(film.capture(), CaptureError);
    assert.equal(calls, 1);
    assert.equal(paints(), 0);
  }
});

test('cancelled captures never retry, including cancellation during the compositor wait', async () => {
  for (const when of ['before', 'capture', 'wait']) {
    const abort = new AbortController();
    let calls = 0;
    const { film } = captureTarget(async () => {
      calls++;
      if (when === 'capture') abort.abort();
      throw emptyScreenshot();
    });
    film.page.evaluate = async () => { if (when === 'wait') abort.abort(); };
    if (when === 'before') abort.abort();
    await assert.rejects(film.capture({ signal: abort.signal }), /^Error: cancelled$/);
    assert.equal(calls, when === 'before' ? 0 : 1);
  }
});

test('the retry shares the first capture deadline and cannot start after that deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let calls = 0;
  const { film } = captureTarget(async () => { calls++; throw emptyScreenshot(); });
  film.page.evaluate = async () => { t.mock.timers.tick(30_001); };
  await assert.rejects(film.capture(), /did not come within 30 s/);
  assert.equal(calls, 1, 'a slow compositor does not buy a second 30 seconds');
});

test('a capture timeout is not retried', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
  let calls = 0;
  const { film } = captureTarget(() => { calls++; return new Promise(() => {}); });
  const result = assert.rejects(film.capture(), /did not come within 30 s/);
  t.mock.timers.tick(30_000);
  await result;
  assert.equal(calls, 1);
});
