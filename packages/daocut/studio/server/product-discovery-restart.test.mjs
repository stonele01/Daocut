import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';

const transcript = { cues: [{ text: '模拟甲商品完整讲解', startMs: 100, endMs: 900 }] };
const probe = async () => ({ duration: 2 });
const options = { modelIdentity: 'restart-mock', readTranscript: async () => transcript, probeSource: probe };
async function request(route, root, method, body) {
  const rest = method === 'GET' ? 'product-discovery' : 'product-discovery/discover';
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.url = `/${rest}?sourceId=s`;
  let value; const res = { writeHead() {}, end(text) { value = JSON.parse(text); } }; await route(req, res, root, rest); return value;
}

if (process.argv.includes('--discovery-worker')) {
  const root = process.argv.at(-1);
  const route = createProductDiscovery({ ...options, modelClient: () => new Promise(() => {}) });
  await request(route, root, 'POST', { sourceId: 's', confirmed: true });
  process.stdout.write('discovery-ready\n');
  setInterval(() => {}, 1000);
} else {
  test('a killed discovery process reopens interrupted without a model call and needs explicit retry', { timeout: 30000 }, async t => {
    const base = resolve(import.meta.dirname, '../../../../.tmp/product-discovery-restart'); await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'restart-')); t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/a.mp4'), 'synthetic');
    await writeProductAnalysis(root, { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 2000 }], products: [], intervals: [], candidates: [] }, probe);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--discovery-worker', root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await new Promise((resolve, reject) => {
      let output = ''; child.stdout.on('data', chunk => { output += chunk; if (output.includes('discovery-ready')) resolve(); });
      child.on('error', reject); child.on('exit', code => reject(Error(`worker exited ${code} before ready`)));
    });
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    let calls = 0;
    const route = createProductDiscovery({ ...options, modelClient: async () => { calls++; return { products: [{ key: 'a', name: '甲', variant: '', aliases: [], evidence: [0] }], ranges: [{ key: 'a', firstCue: 0, lastCue: 0, kind: 'lecture', reason: '模拟原话', evidence: [0] }], issues: [] }; } });
    const interrupted = await request(route, root, 'GET'); assert.equal(interrupted.status, 'failed'); assert.match(interrupted.error, /中断/); assert.equal(calls, 0);
    await assert.rejects(request(route, root, 'POST', { sourceId: 's', confirmed: true }), { status: 409 }); assert.equal(calls, 0);
    await request(route, root, 'POST', { sourceId: 's', confirmed: true, retry: true });
    let completed;
    for (let n = 0; n < 100; n++) { completed = await request(route, root, 'GET'); if (completed.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(completed.status, 'complete'); assert.equal(calls, 1);
  });
}
