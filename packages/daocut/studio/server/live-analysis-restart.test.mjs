import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createLiveAnalysis } from './live-analysis.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';

const probe = async () => ({ duration: 10 });
const transcript = { cues: [{ text: '测试价格', startMs: 100, endMs: 2000 }] };
async function request(route, root, method, rest, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method; req.url = '/?sourceId=s';
  let result;
  const res = { writeHead() {}, end(text) { result = JSON.parse(text); } };
  await route(req, res, root, rest);
  return result;
}
if (process.argv[2] === '--worker') {
  const root = process.argv[3];
  const route = createLiveAnalysis({ modelIdentity: 'isolated-mock-v1', readTranscript: async () => transcript, probeSource: probe, modelClient: async () => {
    process.send('mock-call');
    await new Promise(() => {});
  } });
  process.on('message', async message => {
    if (message === 'start') {
      const result = await request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true });
      process.send({ started: result.analysis.status });
    }
    if (message === 'view') process.send({ state: (await request(route, root, 'GET', 'live-analysis')).analysis.status });
  });
} else {
  test('interrupted analysis can be explicitly retried once after process restart', async () => {
    await mkdir(resolve('.tmp/review-fixes-20261031/temp'), { recursive: true });
    const root = await mkdtemp(resolve('.tmp/review-fixes-20261031/temp/restart-'));
    let child;
    try {
      await mkdir(resolve(root, 'assets'));
      await writeFile(resolve(root, 'assets/a.mp4'), 'synthetic');
      await writeProductAnalysis(root, { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 10000 }], products: [{ id: 'p', name: '商品', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 10000 }], candidates: [] }, probe);
      child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const messages = [];
      child.on('message', value => messages.push(value));
      const wait = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('worker timed out'); };
      child.send('start');
      await wait(() => messages.includes('mock-call') && messages.some(m => m.started === 'running'));
      child.send('view');
      await wait(() => messages.some(m => m.state === 'running'));
      for (let i = 0; i < 5; i++) child.send('start');
      await wait(() => messages.filter(m => m.started === 'running').length === 6);
      assert.equal(messages.filter(m => m === 'mock-call').length, 1);
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exit; child = null;
      let calls = 0, release;
      const gate = new Promise(resolve => { release = resolve; });
      const route = createLiveAnalysis({ modelIdentity: 'isolated-mock-v1', readTranscript: async () => transcript, probeSource: probe, modelClient: async () => { calls++; await gate; return { candidates: [], issues: [] }; } });
      const interrupted = await request(route, root, 'GET', 'live-analysis');
      assert.equal(interrupted.analysis.status, 'failed');
      assert.match(interrupted.analysis.error, /中断/);
      assert.equal(calls, 0, 'restart and state inspection must not resend');
      const results = await Promise.all(Array.from({ length: 5 }, () => request(route, root, 'POST', 'live-analysis/analyze', { sourceId: 's', confirmed: true })));
      assert.ok(results.every(result => result.analysis.status === 'running'));
      await wait(() => calls === 1);
      assert.equal((await request(route, root, 'GET', 'live-analysis')).analysis.status, 'running');
      assert.equal(calls, 1);
      release();
      let completed = false;
      for (let i = 0; i < 300; i++) {
        if ((await request(route, root, 'GET', 'live-analysis')).analysis.status === 'complete') { completed = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(completed, true);
      assert.equal(calls, 1);
    } finally { if (child) child.kill(); await rm(root, { recursive: true, force: true }); }
  });
}

