import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const repo = resolve(import.meta.dirname, '../../../..');

// The actual source monitor runs in a real browser; only media timing is controlled.
// It cannot reach any model, running Studio, existing project or NAS.
test('source playback handles delayed media and superseded user commands', { timeout: 90000 }, async t => {
  const base = join(repo, '.tmp/playback-fix-20261106/browser');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'playback-'));
  const synthetic = join(scratch, 'synthetic.mp4');
  execFileSync(process.env.DAOCUT_TEST_FFMPEG || 'ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', '-y', synthetic], { windowsHide: true });
  const syntheticBytes = await readFile(synthetic);
  await writeFile(join(scratch, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(scratch, 'entry.tsx'), `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {SourcePreview} from ${JSON.stringify(join(repo, 'packages/daocut/studio/ui/src/components/SourcePreview.tsx').replaceAll('\\', '/'))};
    const file={path:'assets/synthetic.mp4',name:'synthetic.mp4',dir:'assets',size:128,kind:'video',mtimeMs:1,durationMs:30000};
    function Fixture(){
      const [request,setRequest]=useState({sourceId:'source-a',requestId:1,timeMs:1000,play:true});
      window.fixture ??= {};
      window.fixture.seek=setRequest;
      return <SourcePreview file={file} sourceId="source-a" sources={{file:()=>'/synthetic.mp4?key=PRIVATE_TEST_TOKEN'+(location.search.includes('real=1')?'&real=1':'')}}
        seekRequest={request} onClose={()=>{}} hideSourceTimeline />;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `);
  await build({ configFile: false, root: scratch, cacheDir: join(scratch, 'vite-cache'), logLevel: 'silent',
    plugins: [react(), { name: 'fixture-dependencies', resolveId(source) { if (/^(react|react-dom)(\/|$)/.test(source)) return require.resolve(source); } }],
    resolve: { alias: { '@': join(repo, 'packages/daocut/studio/ui/src') } },
    build: { outDir: join(scratch, 'dist'), emptyOutDir: true },
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost'), path = url.pathname;
      if (path === '/synthetic.mp4') {
        if (!url.searchParams.has('real')) { response.writeHead(204).end(); return; }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), syntheticBytes.length - 1) : syntheticBytes.length - 1;
        response.writeHead(range ? 206 : 200, { 'content-type': 'video/mp4', 'content-length': end - start + 1, 'accept-ranges': 'bytes',
          ...(range ? { 'content-range': `bytes ${start}-${end}/${syntheticBytes.length}` } : {}) });
        response.end(syntheticBytes.subarray(start, end + 1)); return;
      }
      const file = path.startsWith('/assets/') ? join(scratch, 'dist', path) : join(scratch, 'dist/index.html');
      response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const context = await browser.newContext({ locale: 'zh-CN' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.addInitScript(() => {
      const values = new WeakMap();
      const state = media => { if (!values.has(media)) values.set(media, { paused: true, ready: Number(new URL(location.href).searchParams.get('ready') ?? 1), time: 0, error: null }); return values.get(media); };
      const pending = [];
      const fixture = window.fixture = { calls: 0, pauses: 0, pending, state };
      for (const [name, getter] of Object.entries({ paused: s => s.paused, readyState: s => s.ready, currentTime: s => s.time,
        duration: () => 30, networkState: () => 2, error: s => s.error,
        buffered: () => ({ length: 1, start: () => 0, end: () => 2 }) })) {
        Object.defineProperty(HTMLMediaElement.prototype, name, { configurable: true, get() { const s = state(this); return getter(s); },
          ...(name === 'currentTime' ? { set(v) { state(this).time = v; } } : {}) });
      }
      HTMLMediaElement.prototype.play = function () {
        fixture.calls++; state(this).paused = false; this.dispatchEvent(new Event('play'));
        return new Promise((resolve, reject) => pending.push({ media: this, resolve, reject }));
      };
      HTMLMediaElement.prototype.pause = function () {
        fixture.pauses++; state(this).paused = true; this.dispatchEvent(new Event('pause'));
      };
      fixture.event = type => document.querySelector('video').dispatchEvent(new Event(type));
      fixture.resolve = index => { const p = pending[index]; state(p.media).paused = false; p.media.dispatchEvent(new Event('playing')); p.resolve(); };
      fixture.reject = (index, name, message) => pending[index].reject(new DOMException(message || name, name));
      fixture.mediaError = (code, message) => { const media = document.querySelector('video'); state(media).error = { code, message }; media.dispatchEvent(new Event('error')); };
      // Browser decoding is not under test in these controlled event races.
      document.addEventListener('error', e => { if (e.target instanceof HTMLMediaElement && !state(e.target).error) e.stopImmediatePropagation(); }, true);
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const open = async () => { await page.goto(origin); await page.waitForFunction(() => window.fixture.calls === 1); };
    const flush = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    await t.test('metadata arriving after an applied request does not restart that request', async () => {
      await open();
      const before = await page.evaluate(() => window.fixture.pauses);
      await page.evaluate(() => window.fixture.event('loadedmetadata')); await flush();
      assert.equal(await page.evaluate(() => window.fixture.calls), 1, 'one user request must start only once');
      assert.equal(await page.evaluate(() => window.fixture.pauses), before, 'metadata must not cancel a pending play');
    });
    await t.test('only the latest seek is applied when metadata was initially unavailable', async () => {
      await page.goto(`${origin}/?ready=0`); await page.waitForFunction(() => window.fixture.seek);
      await page.evaluate(() => window.fixture.seek({ sourceId: 'source-a', requestId: 2, timeMs: 8000 })); await flush();
      await page.evaluate(() => { window.fixture.state(document.querySelector('video')).ready = 1; window.fixture.event('loadedmetadata'); }); await flush();
      assert.equal(await page.evaluate(() => window.fixture.calls), 0, 'the superseded autoplay request is never sent');
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), 8);
      assert.equal(await page.locator('video').evaluate(v => v.paused), true);
    });
    await t.test('same request range refresh updates its stop point without replaying or jumping within range', async () => {
      await open();
      await page.evaluate(() => window.fixture.seek({ sourceId: 'source-a', requestId: 2, timeMs: 2000, play: true, range: { startMs: 2000, endMs: 9000, label: 'original' } }));
      await page.waitForFunction(() => window.fixture.calls === 2);
      await page.locator('video').evaluate(v => { v.currentTime = 4; });
      const pauses = await page.evaluate(() => window.fixture.pauses);
      await page.evaluate(() => window.fixture.seek({ sourceId: 'source-a', requestId: 2, timeMs: 3000, play: true, range: { startMs: 3000, endMs: 5000, label: 'corrected' } })); await flush();
      assert.equal(await page.evaluate(() => window.fixture.calls), 2);
      assert.equal(await page.evaluate(() => window.fixture.pauses), pauses);
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), 4, 'a correction does not rewind an in-range playhead');
      await page.locator('video').evaluate(v => { v.currentTime = 5.2; v.dispatchEvent(new Event('timeupdate')); }); await flush();
      assert.equal(await page.locator('video').evaluate(v => v.paused), true, 'the corrected end point stops playback');
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), 5);
    });
    await t.test('same request range correction clamps an excluded playhead and preserves a manual pause', async () => {
      await open();
      await page.evaluate(() => window.fixture.seek({ sourceId: 'source-a', requestId: 2, timeMs: 2000, play: true, range: { startMs: 2000, endMs: 9000 } }));
      await page.waitForFunction(() => window.fixture.calls === 2);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.evaluate(() => window.fixture.seek({ sourceId: 'source-a', requestId: 2, timeMs: 6000, play: true, range: { startMs: 6000, endMs: 8000 } })); await flush();
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), 6, 'the old position is excluded by the new start');
      assert.equal(await page.locator('video').evaluate(v => v.paused), true);
      assert.equal(await page.evaluate(() => window.fixture.calls), 2);
      await page.evaluate(() => window.fixture.event('loadedmetadata')); await flush();
      assert.equal(await page.evaluate(() => window.fixture.calls), 2, 'metadata still cannot replay this command');
    });
    await t.test('a manual pause before metadata stays paused when metadata arrives', async () => {
      await page.goto(`${origin}/?ready=0`); await page.waitForFunction(() => window.fixture.seek);
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.evaluate(() => { window.fixture.state(document.querySelector('video')).ready = 1; window.fixture.event('loadedmetadata'); }); await flush();
      assert.equal(await page.evaluate(() => window.fixture.calls), 0);
      assert.equal(await page.locator('video').evaluate(v => v.paused), true);
    });
    await t.test('manual scrubbing before metadata overrides the pending autoplay seek', async () => {
      await page.goto(`${origin}/?ready=0`); await page.waitForFunction(() => window.fixture.seek);
      const scrubber = page.getByRole('slider');
      await scrubber.evaluate(el => { el.style.height = '20px'; });
      const box = await scrubber.boundingBox(); assert.ok(box);
      await scrubber.click({ position: { x: box.width * 8 / 30, y: 5 } });
      const scrubbed = await page.locator('video').evaluate(v => v.currentTime);
      assert.ok(Math.abs(scrubbed - 8) < 0.05);
      await page.evaluate(() => { window.fixture.state(document.querySelector('video')).ready = 1; window.fixture.event('loadedmetadata'); }); await flush();
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), scrubbed, 'late metadata must not restore the superseded 1s position');
      assert.equal(await page.evaluate(() => window.fixture.calls), 0);
      assert.equal(await page.locator('video').evaluate(v => v.paused), true);
    });
    await t.test('old rejected play cannot replace the state of a newer successful request', async () => {
      await open();
      await page.evaluate(() => window.fixture.seek({ sourceId: 'source-a', requestId: 2, timeMs: 8000, play: true }));
      await page.waitForFunction(() => window.fixture.calls === 2);
      await page.evaluate(() => { window.fixture.resolve(1); window.fixture.reject(0, 'AbortError', 'interrupted by pause'); }); await flush();
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.locator('video').evaluate(v => v.currentTime), 8);
    });
    await t.test('explicit pause cancels pending playback without showing a failure', async () => {
      await open();
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.evaluate(() => window.fixture.reject(0, 'AbortError', 'interrupted by pause')); await flush();
      assert.equal(await page.locator('video').evaluate(v => v.paused), true);
      assert.equal(await page.getByRole('alert').count(), 0);
    });
    await t.test('current playback failure exposes useful diagnostics without a source token', async () => {
      await open();
      await page.evaluate(() => window.fixture.reject(0, 'NotSupportedError', 'Decoder failed for http://127.0.0.1/synthetic.mp4?key=PRIVATE_TEST_TOKEN')); await flush();
      const text = await page.getByRole('alert').innerText();
      assert.match(text, /格式|解码|支持/);
      await page.getByText('播放诊断', { exact: true }).click();
      const diagnostic = await page.locator('[data-source-playback-diagnostic]').innerText();
      assert.match(diagnostic, /NotSupportedError/);
      assert.doesNotMatch(diagnostic, /PRIVATE_TEST_TOKEN|\?key=/);
    });
    await t.test('network media errors and buffering are distinguished', async () => {
      await open();
      await page.evaluate(() => window.fixture.event('waiting')); await flush();
      assert.match(await page.locator('[data-source-playback-state]').innerText(), /缓冲|加载/);
      await page.evaluate(() => window.fixture.mediaError(2, 'Network read failed')); await flush();
      assert.match(await page.getByRole('alert').innerText(), /读取|网络/);
      await page.getByText('播放诊断', { exact: true }).click();
      assert.match(await page.locator('[data-source-playback-diagnostic]').innerText(), /MEDIA_ERR_NETWORK/);
      await open();
      await page.evaluate(() => window.fixture.mediaError(4, 'Media response was not usable')); await flush();
      assert.match(await page.getByRole('alert').innerText(), /无法读取或格式不受支持/, 'a bad HTTP response must not be diagnosed as a codec failure');
    });
    await t.test('a play request remains loading until the playing event and unexpected abort remains visible', async () => {
      await open();
      assert.match(await page.locator('[data-source-playback-state]').innerText(), /加载/);
      await page.evaluate(() => window.fixture.resolve(0)); await flush();
      assert.equal(await page.locator('[data-source-playback-state]').count(), 0);
      await open();
      await page.evaluate(() => window.fixture.reject(0, 'AbortError', 'unexpected source reset')); await flush();
      assert.match(await page.getByRole('alert').innerText(), /中断/);
    });
    await t.test('real synthetic H264/AAC advances frames, seeks and stops at a selected range', async () => {
      const real = await browser.newContext({ locale: 'zh-CN' });
      await real.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      try {
        const viewer = await real.newPage();
        await viewer.goto(`${origin}/?real=1`);
        await viewer.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 1.3 && v.videoWidth === 160; });
        await viewer.evaluate(() => window.fixture.seek({ sourceId: 'source-a', requestId: 2, timeMs: 3000, play: true, range: { startMs: 3000, endMs: 4000 } }));
        await viewer.waitForFunction(() => { const v = document.querySelector('video'); return v && v.paused && Math.abs(v.currentTime - 4) < 0.05; });
        assert.equal(await viewer.getByRole('alert').count(), 0);
        assert.ok(await viewer.locator('video').evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames) > 0);
        assert.ok(await viewer.locator('video').evaluate(v => v.webkitAudioDecodedByteCount) > 0, 'Chromium decoded the synthetic AAC track');
        const diagnostic = await viewer.locator('[data-source-playback-diagnostic]').textContent();
        assert.doesNotMatch(diagnostic, /PRIVATE_TEST_TOKEN/);
      } finally { await real.close(); }
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
