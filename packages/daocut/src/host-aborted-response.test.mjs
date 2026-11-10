import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderFiles } from './host.mjs';

test('media cancelled during asynchronous preparation opens no stream and does not stop later range requests', { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'of-host-before-pipe-'));
  writeFileSync(join(root, 'video.mp4'), '0123456789');
  const streams = [];
  const create = fs.createReadStream;
  const mocked = t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = create(...args);
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  const files = folderFiles(root);
  let reached, completed;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://test');
    if (url.searchParams.has('cancel')) {
      // The media host may await a source identity check before folderFiles runs.
      const closed = new Promise(done => res.once('close', done));
      reached();
      await closed;
      try { completed({ handled: files(req, res, url.pathname, url.searchParams) }); }
      catch (error) { completed({ error }); }
    } else if (!files(req, res, url.pathname, url.searchParams)) res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const range of [undefined, 'bytes=0-7']) {
      const arrived = new Promise(done => { reached = done; });
      const finished = new Promise(done => { completed = done; });
      const req = get(`${origin}/video.mp4?cancel=1`, { headers: range ? { range } : {} });
      req.on('error', () => {});
      await arrived;
      req.destroy();
      const result = await finished;
      assert.equal(result.error, undefined, `${range ?? 'full'} cancellation must not throw`);
      assert.equal(result.handled, true);
      assert.equal(streams.length, 0, 'an abandoned response must not open the media file');
    }
    const part = await fetch(`${origin}/video.mp4`, { headers: { range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await part.text(), '2345');
    const full = await fetch(`${origin}/video.mp4`);
    assert.equal(full.status, 200);
    assert.equal(await full.text(), '0123456789');
  } finally {
    for (const stream of streams) {
      stream.on('error', () => {});
      stream.destroy();
      if (!stream.closed) await new Promise(done => stream.once('close', done));
    }
    server.closeAllConnections?.();
    await new Promise(done => server.close(done));
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
