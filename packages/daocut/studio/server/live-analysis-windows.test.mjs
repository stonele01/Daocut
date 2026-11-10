import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createLiveAnalysis } from './live-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
import { TEXT_STRUCTURE_PROMPT, textStructureWindows } from './text-structure.mjs';

const details = { subtypes: [], reason: '模拟原话证据', evidence: ['ASR'], context: '', repetition: '', review: [] };
const probe = async () => ({ duration: 100 });
const policy = { maxInputBytes: Buffer.byteLength(TEXT_STRUCTURE_PROMPT) + 1700, contextCues: 1 };
const cues = Array.from({ length: 7 }, (_, i) => ({ startMs: 10000 + i * 1000, endMs: 10500 + i * 1000, text: `${i}${'测试讲解内容'.repeat(35)}` }));
const args = { sourceId: 's', productId: 'a', intervalId: 'a1', rangeStartMs: 10000, rangeEndMs: 18000, cues, prompt: TEXT_STRUCTURE_PROMPT, ...policy };
async function request(route, root, method = 'GET', body = {}) {
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify({ sourceId: 's', intervalId: 'a1', productId: 'a', confirmed: true, ...body }))] : []);
  req.method = method; req.url = '/?sourceId=s&intervalId=a1&productId=a';
  let result;
  await route(req, { writeHead() {}, end(text) { result = JSON.parse(text); } }, root, method === 'GET' ? 'live-analysis' : 'live-analysis/analyze');
  return result;
}
async function finish(route, root) {
  for (let i = 0; i < 300; i++) {
    const result = await request(route, root);
    if (result.analysis.status !== 'running') return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('mock windows did not finish');
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'daocut-structure-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'assets/a.mp4'), 'synthetic');
  await writeFile(join(root, 'film.html'), 'untouched film fixture');
  await writeProductAnalysis(root, { version: 1, sources: [{ id: 's', assetPath: 'assets/a.mp4', durationMs: 100000 }], products: [{ id: 'a', name: '商品甲', sourceIds: ['s'] }], intervals: [{ id: 'a1', sourceId: 's', productId: 'a', startMs: 10000, endMs: 18000 }], candidates: [] }, probe);
  const allCues = [{ startMs: 500, endMs: 1000, text: '选中范围之外' }, ...cues];
  return { root, options: { modelIdentity: 'isolated-window-mock-v1', readTranscript: async () => ({ cues: allCues }), probeSource: probe, structureWindowPolicy: policy } };
}
const modelOutput = input => ({ candidates: JSON.parse(input).cues.flatMap((cue, i) => [
  { firstCue: i, lastCue: i, tags: ['卖点'], details },
  ...(cue.text.startsWith('1') ? [{ firstCue: i, lastCue: i, tags: ['痛点'], details }] : []),
]), issues: [] });

test('structure windows use complete cue boundaries, bounded bytes and overlapping context', () => {
  const windows = textStructureWindows(args);
  assert.ok(windows.length > 1);
  assert.equal(windows[0].firstCue, 0);
  assert.equal(windows.at(-1).lastCue, cues.length - 1);
  for (const [i, window] of windows.entries()) {
    assert.ok(window.bytes <= policy.maxInputBytes);
    assert.deepEqual(window.cues, cues.slice(window.firstCue, window.lastCue + 1));
    if (i) assert.equal(window.firstCue, windows[i - 1].lastCue);
  }
  assert.throws(() => textStructureWindows({ ...args, cues: [{ ...cues[0], text: '超长'.repeat(20000) }] }), /预算/);
});

test('failed second window survives reopen and explicit retry reuses completed output', async t => {
  const c = await setup(t), windows = textStructureWindows(args), calls = [];
  let fail = true;
  const modelClient = async ({ input }) => {
    const first = Number(JSON.parse(input).cues[0].text.slice(0, 1)); calls.push(first);
    if (fail && first === windows[1].firstCue) throw Object.assign(Error('mock interruption'), { code: 'MODEL_TIMEOUT' });
    return modelOutput(input);
  };
  let route = createLiveAnalysis({ ...c.options, modelClient });
  await request(route, c.root, 'POST');
  const failed = await finish(route, c.root);
  assert.equal(failed.analysis.status, 'failed');
  assert.equal(failed.analysis.progress.completedWindows, 1);
  assert.equal(failed.analysis.progress.totalWindows, windows.length);
  assert.equal((await readProductAnalysis(c.root)).analysis.candidates.length, 0, 'partial windows are not valid candidates');
  fail = false;
  route = createLiveAnalysis({ ...c.options, modelClient });
  await request(route, c.root); await request(route, c.root);
  assert.equal(calls.length, 2, 'GET/reopen never retry');
  await request(route, c.root, 'POST');
  const done = await finish(route, c.root);
  assert.equal(done.analysis.status, 'complete');
  assert.equal(done.analysis.progress.completedWindows, windows.length);
  assert.equal(done.analysis.progress.resumedWindows, 1);
  assert.equal(calls.filter(first => first === 0).length, 1, 'completed first window is not billed again');
  assert.equal(calls.length, windows.length + 1);
  const candidates = (await readProductAnalysis(c.root)).analysis.candidates;
  assert.equal(candidates.length, cues.length + 1, 'same cue/tag duplicates removed; different tags retained');
  assert.deepEqual(candidates.filter(x => x.tags[0] === '卖点').map(x => x.cueRange), cues.map((_, i) => [i + 1, i + 1]), 'indices refer to the full source transcript');
  assert.deepEqual(candidates.filter(x => x.tags[0] === '卖点').map(x => [x.startMs, x.endMs]), cues.map(x => [x.startMs, x.endMs]));
  assert.equal(await readFile(join(c.root, 'film.html'), 'utf8'), 'untouched film fixture');
  await request(route, c.root, 'POST'); assert.equal(calls.length, windows.length + 1);
});

test('changed window policy invalidates completion without resending', async t => {
  const c = await setup(t); let calls = 0;
  const modelClient = async ({ input }) => { calls++; return modelOutput(input); };
  const first = createLiveAnalysis({ ...c.options, modelClient });
  await request(first, c.root, 'POST'); assert.equal((await finish(first, c.root)).analysis.status, 'complete');
  const before = calls;
  const changed = createLiveAnalysis({ ...c.options, modelClient, structureWindowPolicy: { ...policy, contextCues: 0 } });
  const state = await request(changed, c.root);
  assert.equal(state.analysis.stale, true); assert.equal(calls, before);
});

test('a candidate spanning a window boundary keeps full-source cue indices and absolute times', async t => {
  const c = await setup(t);
  const route = createLiveAnalysis({ ...c.options, modelClient: async ({ input }) => ({ candidates: JSON.parse(input).cues.length > 1 ? [{ firstCue: 0, lastCue: 1, tags: ['卖点'], details }] : [], issues: [] }) });
  await request(route, c.root, 'POST'); assert.equal((await finish(route, c.root)).analysis.status, 'complete');
  const candidates = (await readProductAnalysis(c.root)).analysis.candidates;
  const boundary = candidates.find(candidate => candidate.cueRange[0] === 2 && candidate.cueRange[1] === 3);
  assert.ok(boundary);
  assert.deepEqual([boundary.startMs, boundary.endMs], [11000, 12500]);
  assert.equal(boundary.text, cues[1].text + cues[2].text);
});

test('a terminated process leaves completed windows reusable and pending windows require explicit retry', async t => {
  const c = await setup(t), windows = textStructureWindows(args);
  const moduleUrl = new URL('./live-analysis.mjs', import.meta.url).href;
  const worker = `import {createLiveAnalysis} from ${JSON.stringify(moduleUrl)};
    import {Readable} from 'node:stream';
    process.on('message', async data => {
      let calls = 0;
      const route = createLiveAnalysis({modelIdentity:'isolated-window-mock-v1', structureWindowPolicy:data.policy, probeSource:async()=>({duration:100}), readTranscript:async()=>({cues:data.cues}), modelClient:async({input})=>{
        calls++; process.send({window:calls});
        if(calls===2) await new Promise(()=>{});
        return {candidates:JSON.parse(input).cues.map((cue,i)=>({firstCue:i,lastCue:i,tags:['卖点'],details:data.details})),issues:[]};
      }});
      const req=Readable.from([Buffer.from(JSON.stringify({sourceId:'s',productId:'a',intervalId:'a1',confirmed:true}))]); req.method='POST';req.url='/';
      await route(req,{writeHead(){},end(){}},data.root,'live-analysis/analyze');
    });`;
  let child = spawn(process.execPath, ['--input-type=module', '-e', worker], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true });
  t.after(async () => { if (child) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit; } });
  const secondWindow = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('worker did not reach the second window')), 5000);
    child.on('message', message => { if (message.window === 2) { clearTimeout(timeout); resolve(); } });
    child.once('error', reject);
  });
  child.send({ root: c.root, cues: (await c.options.readTranscript()).cues, policy, details });
  await secondWindow;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; child = null;
  const calls = [];
  const route = createLiveAnalysis({ ...c.options, modelClient: async ({ input }) => { calls.push(Number(JSON.parse(input).cues[0].text.slice(0, 1))); return modelOutput(input); } });
  const stopped = await request(route, c.root);
  assert.equal(stopped.analysis.status, 'failed'); assert.match(stopped.analysis.error, /中断/);
  assert.equal(stopped.analysis.progress.completedWindows, 1); assert.equal(calls.length, 0);
  await request(route, c.root, 'POST');
  const done = await finish(route, c.root);
  assert.equal(done.analysis.status, 'complete'); assert.equal(done.analysis.progress.resumedWindows, 1);
  assert.equal(calls.length, windows.length - 1); assert.ok(!calls.includes(0));
});

test('a changed transcript cannot reuse the successful windows of a failed attempt', async t => {
  const c = await setup(t); let transcript = await c.options.readTranscript(), requests = 0;
  const options = { ...c.options, readTranscript: async () => transcript };
  const first = createLiveAnalysis({ ...options, modelClient: async ({ input }) => { requests++; if (requests === 2) throw Object.assign(Error(), { code: 'MODEL_TIMEOUT' }); return modelOutput(input); } });
  await request(first, c.root, 'POST'); assert.equal((await finish(first, c.root)).analysis.status, 'failed');
  transcript = structuredClone(transcript); transcript.cues[1].text += '已修正';
  const calls = [];
  const next = createLiveAnalysis({ ...options, modelClient: async ({ input }) => { calls.push(Number(JSON.parse(input).cues[0].text.slice(0, 1))); return modelOutput(input); } });
  await request(next, c.root, 'POST'); const done = await finish(next, c.root);
  assert.equal(done.analysis.status, 'complete'); assert.equal(done.analysis.progress.resumedWindows, 0);
  assert.equal(calls[0], 0);
});

test('small sample preserves the exact single request input contract', () => {
  const sample = Array.from({ length: 49 }, (_, i) => ({ text: `合成${i}`, startMs: i * 1000, endMs: i * 1000 + 500 }));
  const windows = textStructureWindows({ ...args, cues: sample, rangeStartMs: 0, rangeEndMs: 50000, maxInputBytes: undefined, contextCues: undefined });
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].cues, sample);
});
