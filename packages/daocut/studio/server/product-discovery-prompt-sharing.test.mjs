import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createProductDiscovery } from './product-discovery-route.mjs';
import { DISCOVERY_PROMPT, PREVIOUS_DISCOVERY_PROMPT, DISCOVERY_VERSION } from './product-discovery.mjs';
import { createProductWorkflow } from './product-workflow.mjs';
import { createSharedAnalysis } from './shared-analysis.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const identity = 'isolated-discovery-model';
const originalContract = { model: identity, prompt: hash(PREVIOUS_DISCOVERY_PROMPT), version: DISCOVERY_VERSION, maxBytes: 24000, contextCues: 3 };
const originalLocalHash = hash({ publicModelHash: hash(identity), promptHash: originalContract.prompt, algorithmVersion: DISCOVERY_VERSION, windowPolicy: { maxBytes: 24000, contextCues: 3, knownProductBytes: 8000 } });

async function fixture(t) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/discovery-prompt-sharing'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'fixture-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('No real network permitted'); });
  const root = join(scratch, 'personal'), resultRoot = join(scratch, 'mock-shared');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets/synthetic.mp4'), 'synthetic source'); await writeFile(join(root, 'film.html'), 'personal film must stay unchanged');
  const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 4000 };
  const cues = [{ startMs: 0, endMs: 1000, text: '这是模拟商品。' }, { startMs: 1000, endMs: 3000, text: '它的完整讲解。' }];
  const probeSource = async () => ({ duration: 4 }), readTranscript = async () => ({ cues });
  await writeProductAnalysis(root, { version: 1, sources: [source], products: [], intervals: [], candidates: [] }, probeSource);
  let modelCalls = 0;
  const discovery = createProductDiscovery({ modelIdentity: identity, readTranscript, probeSource, modelClient: async () => {
    modelCalls++;
    return { products: [{ key: 'p', name: '模拟商品', variant: '', aliases: [], evidence: [0] }], ranges: [{ key: 'p', firstCue: 0, lastCue: 1, kind: 'lecture', reason: '模拟原文', evidence: [0, 1] }], issues: [] };
  } });
  await discovery.start(root, { sourceId: 's' }); await discovery.wait(root, 's');
  assert.equal((await discovery.view(root, 's')).status, 'complete');
  const records = join(root, '.film/product-discovery'), recordFile = join(records, (await readdir(records))[0]);
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  // Existing completed outputs in the prior on-disk schema. This fixture never
  // calls the old model; it reproduces the original request identity explicitly.
  record.runs[0].contractHash = originalLocalHash; delete record.runs[0].promptHash;
  await writeFile(recordFile, JSON.stringify(record));
  const tasks = new Map(), operations = [];
  const coordinate = async (op, body) => {
    operations.push(op); let task = tasks.get(body.taskKey);
    if (op === 'status') return { task: structuredClone(task ?? null) };
    if (op === 'claim') {
      assert.equal(task, undefined, 'no duplicate public claim');
      task = { taskKey: body.taskKey, inputHash: body.inputHash, attemptId: 'synthetic-attempt', status: 'claimed' }; tasks.set(body.taskKey, task);
      return { acquired: true, task: structuredClone(task) };
    }
    assert.equal(body.attemptId, task.attemptId);
    if (op === 'submitted') { task.status = 'submitted'; return { task: structuredClone(task), sendAllowed: true }; }
    if (op === 'complete') { task.status = 'complete'; task.result = body.result; return { task: structuredClone(task) }; }
    throw Error(`Unexpected coordinator operation ${op}`);
  };
  const makeShared = () => createSharedAnalysis({ coordinate, settings: () => ({ enabled: true, resultRoots: [{ libraryId: 'synthetic-library', root: resultRoot }] }), readManifest: async () => ({ items: { 'assets/synthetic.mp4': { libraryId: 'synthetic-library', relativePath: 'show/synthetic.mp4' } } }) });
  const makeWorkflow = () => createProductWorkflow({ discovery, sharedAnalysis: makeShared(), readTranscript, probeSource,
    liveAnalysis: { view: async () => ({ transcription: { status: 'complete' }, analysis: { status: 'idle' } }) },
    analysisServices: async () => ({ text: { enabled: true, provider: 'mock', model: identity } }) });
  return { root, resultRoot, source, cues, discovery, recordFile, record, tasks, operations, makeShared, makeWorkflow, modelCalls: () => modelCalls };
}

test('old completed discovery publication preserves its original prompt with or without a pending claim', async t => {
  for (const pending of [false, true]) await t.test(pending ? 'recover original submitted claim' : 'publish existing local result', async t => {
    const f = await fixture(t), before = await readFile(f.recordFile, 'utf8');
    let submitted;
    if (pending) {
      const shared = f.makeShared();
      submitted = await shared.prepare(f.root, f.source, { action: 'discovery', data: f.cues, contract: originalContract });
      await shared.acquire(submitted);
    }
    const workflow = f.makeWorkflow();
    const plan = await workflow.plan(f.root, { sourceId: 's', action: 'discovery' });
    assert.equal(plan.cached, true); assert.equal(plan.requestCount, 0);
    if (pending) { assert.equal(plan.shared.mode, 'publish-pending'); assert.equal(plan.shared.recoverCached, true); }
    else assert.equal(plan.shared.mode, 'publish');
    await workflow.execute(f.root, { confirmed: true, plan });
    const task = [...f.tasks.values()][0]; assert.equal(task.status, 'complete');
    const snapshot = JSON.parse(await readFile(join(f.resultRoot, task.result.path), 'utf8'));
    assert.deepEqual(snapshot.contract, originalContract, 'saved old judgment must never be relabeled as the approved new prompt');
    assert.notEqual(snapshot.contract.prompt, hash(DISCOVERY_PROMPT));
    if (submitted) assert.equal(snapshot.inputHash, submitted.inputHash, 'recovery must retain the submitted public input identity');
    assert.equal(f.modelCalls(), 1, 'publication and recovery only save the existing synthetic result');
    assert.equal(await readFile(f.recordFile, 'utf8'), before, 'original local request record remains unchanged');
    assert.equal(await readFile(join(f.root, 'film.html'), 'utf8'), 'personal film must stay unchanged');
    assert.equal(f.operations.filter(op => op === 'claim').length, 1);
  });
});

test('an unrecognized saved discovery prompt blocks publication instead of inventing a contract or resending', async t => {
  const f = await fixture(t), record = structuredClone(f.record);
  record.runs[0].contractHash = 'unknown-previous-contract';
  await writeFile(f.recordFile, JSON.stringify(record)); const before = await readFile(f.recordFile, 'utf8');
  await assert.rejects(f.makeWorkflow().plan(f.root, { sourceId: 's', action: 'discovery' }), error => error.status === 409 && /契约|提示词/.test(error.message));
  assert.equal(f.modelCalls(), 1); assert.equal(f.tasks.size, 0);
  assert.equal(await readFile(f.recordFile, 'utf8'), before);
});
