import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
const probe = async () => ({ duration: 10 });
const transcript = { cues: [{ text: '测试', startMs: 100, endMs: 2000 }] };
async function request(route, root, rest, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.url = '/'; let result;
  const res = { writeHead() {}, end(text) { result = JSON.parse(text); } };
  await route(req, res, root, rest); return result;
}
async function setup() {
  await mkdir(resolve('.tmp/review-fixes-20261031/temp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/review-fixes-20261031/temp/scope-'));
  await mkdir(resolve(root, 'assets')); await writeFile(resolve(root, 'assets/a.mp4'), 'synthetic');
  await writeProductAnalysis(root, { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 10000 }], products: [{ id: 'p', name: '商品', sourceIds: ['s'] }, { id: 'p2', name: '商品2', sourceIds: ['s'] }], intervals: [{ id: 'i', sourceId: 's', productId: 'p', startMs: 0, endMs: 10000 }, { id: 'i2', sourceId: 's', productId: 'p2', startMs: 0, endMs: 10000 }], candidates: [] }, probe);
  return root;
}
test('conflicting requests are rejected during startup and while active', async () => {
  const root = await setup(); let release;
  try {
    let calls = 0; const gate = new Promise(resolve => { release = resolve; });
    const route = createLiveAnalysis({ modelIdentity: 'isolated-mock-v1', readTranscript: async () => transcript, probeSource: probe, modelClient: async () => { calls++; await gate; return { candidates: [], issues: [] }; }, transcribe: async () => { throw Error('unexpected'); } });
    const base = { sourceId: 's', intervalId: 'i', productId: 'p', confirmed: true };
    const variants = [['live-analysis/analyze', { ...base, intervalId: 'i2', productId: 'p2' }], ['live-analysis/analyze', { ...base, intervalId: 'missing' }], ['live-analysis/analyze', { ...base, productId: 'p2' }], ['live-analysis/analyze', { ...base, rerun: true }], ['live-analysis/transcribe', base]];
    const start = () => request(route, root, 'live-analysis/analyze', base);
    const conflict = ([rest, body]) => request(route, root, rest, body);
    const first = Array.from({ length: 5 }, start);
    const rejected = variants.map(v => assert.rejects(conflict(v), e => e.status === 409));
    assert.ok((await Promise.all(first)).every(result => result.analysis.status === 'running'));
    await Promise.all(rejected);
    for (let i = 0; i < 100 && calls === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(calls, 1);
    for (const v of variants) await assert.rejects(conflict(v), e => e.status === 409);
    assert.equal((await start()).analysis.status, 'running'); assert.equal(calls, 1);
    release();
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 10)); const result = await start(); if (result.analysis.status === 'complete') return; }
    assert.fail('analysis did not finish');
  } finally { release?.(); await new Promise(r => setTimeout(r, 200)); await rm(root, { recursive: true, force: true }); }
});

test('product-only request does not reuse another product cached analysis', async () => {
  const root = await setup();
  try {
    let calls = 0;
    const route = createLiveAnalysis({ modelIdentity: 'isolated-mock-v1', readTranscript: async () => transcript, probeSource: probe, modelClient: async () => { calls++; return { candidates: [], issues: [] }; } });
    const first = { sourceId: 's', productId: 'p', confirmed: true };
    await request(route, root, 'live-analysis/analyze', first);
    let done;
    for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 10)); done = await request(route, root, 'live-analysis/analyze', first); if (done.analysis.status === 'complete') break; }
    assert.equal(done.analysis.productId, 'p');
    const second = await request(route, root, 'live-analysis/analyze', { ...first, productId: 'p2' });
    assert.equal(second.analysis.status, 'running');
    assert.equal(second.analysis.productId, 'p2');
    for (let i = 0; i < 100 && calls < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(calls, 2);
    await new Promise(r => setTimeout(r, 100));
  } finally { await new Promise(r => setTimeout(r, 100)); await rm(root, { recursive: true, force: true }); }
});

test('startup view failure releases reservation for an explicit retry', async () => {
  const root = await setup();
  try {
    const fixture = (await readProductAnalysis(root)).analysis;
    let removeSource = true, calls = 0;
    const route = createLiveAnalysis({ modelIdentity: 'isolated-mock-v1', probeSource: probe, readTranscript: async () => {
      if (removeSource) {
        removeSource = false;
        await writeProductAnalysis(root, { ...fixture, sources: [], products: [], intervals: [] }, probe);
      }
      return transcript;
    }, modelClient: async () => { calls++; return { candidates: [], issues: [] }; } });
    const body = { sourceId: 's', intervalId: 'i', productId: 'p', confirmed: true };
    await assert.rejects(request(route, root, 'live-analysis/analyze', body), /来源不存在/);
    assert.equal(calls, 0);
    await writeProductAnalysis(root, fixture, probe);
    assert.equal(calls, 0);
    const retry = await request(route, root, 'live-analysis/analyze', body);
    assert.equal(retry.analysis.status, 'running');
    for (let i = 0; i < 100 && calls === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(calls, 1);
    await new Promise(r => setTimeout(r, 100));
  } finally { await new Promise(r => setTimeout(r, 100)); await rm(root, { recursive: true, force: true }); }
});
