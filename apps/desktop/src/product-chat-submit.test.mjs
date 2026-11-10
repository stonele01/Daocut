import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { runner } from './product-chat-test-fixture.mjs';
import { productRangeLabel, productStructurePrompt } from '../chat/src/lib/product-structure-context.ts';
import { productStructureBlocker, productStructureIntent, runProductStructureTask } from '../chat/src/lib/product-structure-task.ts';

const source = readFileSync(new URL('../chat/src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = [];
const find = node => {
  if (ts.isFunctionDeclaration(node) && ['submitFollowUp', 'runTurn', 'runStructureTurn'].includes(node.name?.text)) handlers.push(node.getText(ast));
  ts.forEachChild(node, find);
};
find(ast);
assert.equal(handlers.length, 3, 'exercise the actual composer submission and both asynchronous run handlers');
const code = ts.transpileModule(handlers.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const a = { sourceId: 'source', productId: 'a', intervalId: 'a-1', productName: '商品 A', startMs: 1000, endMs: 5000 };
const b = { sourceId: 'source', productId: 'b', intervalId: 'b-1', productName: '商品 B', startMs: 5000, endMs: 9000 };
const context = scope => ({ scope, transcriptVersion: 'v1', segments: [{ startMs: scope.startMs, endMs: scope.endMs, text: scope.productName + ' 段内原话' }] });

function composer(read = async (_project, scope) => context(scope)) {
  const f = runner();
  const reads = [], taskReads = [], taskStarts = [], refreshes = [], patches = [], errors = [], sessionWrites = [];
  let turnNo = 0;
  const state = {
    followUpFilled: true, followUp: '解释这段的话术', agent: 'byok', active: false,
    queued: false, queuedProductRange: { current: null }, productRange: a,
    followUpRefs: [], studioRefs: new Map(), sessionId: 'visible-chat', projectKey: 'project',
    sessions: [{ id: 'visible-chat', agentSessions: { byok: 'prior-native-with-other-product' } }],
    project: { id: 'project-id', path: '/synthetic', name: 'Test' },
    asset: { id: 'previous-running' }, selection: { refs: [{ kind: 'file', path: 'WHOLE-SOURCE.mp4' }], stage: { w: 100, h: 100 } },
    setQueued: value => { state.queued = value; }, setFollowUpError: value => errors.push(value),
    composerFiles: { files: [], take: () => [] }, compactPromptBlocker: () => null,
    canSteer: () => { throw Error('Product tasks must not inspect steering'); },
    resolvePromptReferences: text => text, skillReferencePackage: () => null,
    pagesToSend: () => [], activatedSkillIds: () => [], attachmentBlocker: () => null,
    buildPromptDisplay: () => null, thread: { scrollToBottom() {} },
    composerRef: { current: { clear() {} } }, setFollowUp: value => { state.followUp = value; }, setFollowUpRefs() {}, setStudioRefs() {}, setFileRefs() {}, setSkillRefs() {},
    makeLocalAgentTurnId: () => 'send-' + ++turnNo,
    productRangeLabel, productStructurePrompt, productStructureBlocker, productStructureIntent, runProductStructureTask,
    setStructureApproval: value => { if (typeof value === 'object' && value) value.respond(true); },
    app: {
      productChatContext: (projectId, scope) => { reads.push(structuredClone(scope)); return read(projectId, scope); },
      productStructureState: async (projectId, scope) => { taskReads.push({ projectId, scope: structuredClone(scope) }); return { scope, analysis: { status: 'complete', stale: false } }; },
      startProductStructure: async (projectId, scope, options) => { taskStarts.push({ projectId, scope, options }); return { scope, analysis: { status: 'complete', stale: false } }; },
      refreshProductAnalysis: projectId => refreshes.push(projectId),
    },
    settlers: { current: new Map() }, runs: { current: new Map() },
    registerPreparingLocalTurn: f.api.registerPreparingLocalTurn,
    runLocalAgentTurn: f.api.runLocalAgentTurn,
    localAgentTurn: f.api.localAgentTurn, readBalance: () => null,
    useLocalAgents: { getState: () => ({ noteOptions() {} }) },
    touchSession: (...args) => sessionWrites.push(args),
    openTurn(id, instruction, _display, _attachments, opts) {
      const turn = new f.api.LocalAgentTurn(id, 'byok');
      const meta = { turnId: id, projectId: 'project', sessionId: 'visible-chat', productStructure: opts?.productStructure, agent: 'byok' };
      state.settlers.current.set(id, patch => { patches.push({ id, patch }); state.settlers.current.delete(id); });
      return { turn, meta, prefs: {}, ready: Promise.resolve(true) };
    },
    steerTurn: () => { throw Error('Product tasks must not steer'); },
    referencePictures: () => { throw Error('No screenshot or whole source reference may be prepared'); },
    attachedPictures: () => { throw Error('No images may be prepared'); },
    t: key => key,
  };
  const submit = new Function('fixture', `with (fixture) { ${code}\nreturn submitFollowUp; }`)(state);
  return { f, state, reads, taskReads, taskStarts, refreshes, patches, errors, sessionWrites, submit, finish: () => Promise.all([...state.runs.current.values()]) };
}

test('actual Send captures A while its read is pending; switching to B cannot change the submitted scope or attach the full source', async () => {
  let resolve;
  const c = composer();
  c.state.followUp = '分析本段话术';
  c.state.app.productStructureState = (_projectId, scope) => { c.taskReads.push({ projectId: _projectId, scope: structuredClone(scope) }); return new Promise(done => { resolve = done; }); };
  c.submit();
  await new Promise(done => setImmediate(done));
  c.state.productRange = b;
  resolve({ scope: a, analysis: { status: 'complete', stale: false } });
  await c.finish();
  assert.deepEqual(c.taskReads, [{ projectId: 'project-id', scope: a }]);
  assert.equal(c.reads.length + c.f.starts.length + c.f.sent.length, 0);
  assert.equal(c.sessionWrites.length, 0);
});

test('actual queued Send keeps the range captured before the user changes selection', async () => {
  const c = composer();
  c.state.followUp = '分析这段';
  c.state.active = true;
  c.submit();
  assert.equal(c.state.queued, true);
  assert.deepEqual(c.state.queuedProductRange.current, a);
  assert.equal(c.reads.length, 0);
  c.state.productRange = b;
  c.state.active = false;
  c.submit();
  await c.finish();
  assert.deepEqual(c.taskReads, [{ projectId: 'project-id', scope: a }]);
  assert.equal(c.reads.length + c.f.starts.length + c.f.sent.length, 0);
});

test('failed shared task reads fail visibly without starting a model or retrying', async () => {
  for (const read of [async () => ({ scope: a, analysis: { status: 'failed', error: '转写未就绪' } }), async () => { throw Error('读取失败'); }]) {
    const c = composer(); c.state.followUp = '提取钩子和卖点';
    c.state.app.productStructureState = async (...args) => { c.taskReads.push(args); return read(...args); };
    c.submit();
    await c.finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.taskReads.length, 1); assert.equal(c.reads.length, 0);
    assert.equal(c.f.starts.length, 0);
    assert.equal(c.f.sent.length, 0);
    assert.equal(c.patches.at(-1).patch.status, 'error');
  }
});

test('Stop while shared task state is loading settles cancelled and never starts the paid prompt later', async () => {
  let resolve;
  const c = composer(); c.state.followUp = '分析这段';
  c.state.app.productStructureState = () => new Promise(done => { resolve = done; });
  c.submit();
  await new Promise(done => setImmediate(done));
  await c.f.api.cancelLocalAgentTurn('send-1');
  assert.equal(c.patches.at(-1).patch.status, 'cancelled');
  resolve({ scope: a, analysis: { status: 'complete', stale: false } });
  await c.finish();
  assert.equal(c.f.starts.length, 0);
  assert.equal(c.f.sent.length, 0);
});

test('unrecognized scoped messages stay local and preserve the draft instead of falling through to paid chat', async () => {
  for (const text of ['解释这段的话术', '介绍一下这个商品', '这里的划分为什么这样', '帮我看看这里']) {
    const c = composer(); c.state.followUp = text;
    c.submit(); await c.finish();
    assert.equal(c.taskReads.length + c.taskStarts.length + c.reads.length + c.f.starts.length + c.f.sent.length, 0, text);
    assert.equal(c.state.followUp, text);
    assert.match(c.errors.at(-1), /普通对话.*清除商品段选择/);
  }
});

test('ordinary chat without a product range retains its existing native model path', async () => {
  const c = composer(); c.state.productRange = null; c.state.followUp = '普通聊天';
  Object.assign(c.state, { attachedText: () => '', studioReferencesText: () => '', turnAttachments: () => [], PROMPT_PICTURES_MAX: 8, referencePictures: async () => ({ pictures: [], images: [] }), attachedPictures: async () => [] });
  c.submit(); await c.finish();
  assert.equal(c.f.starts.length, 1); assert.equal(c.f.sent.length, 1);
  assert.equal(c.taskReads.length + c.taskStarts.length + c.reads.length, 0);
});

test('scoped requests block external adapters and attachments without consuming the draft', () => {
  for (const change of [state => { state.agent = 'codex'; }, state => { state.composerFiles.files = [{ path: 'whole.mp4' }]; }, state => { state.followUpRefs = [{ id: 'file:whole.mp4' }]; }]) {
    const c = composer();
    change(c.state);
    c.submit();
    assert.equal(c.f.starts.length, 0);
    assert.equal(c.reads.length, 0);
    assert.ok(c.errors.at(-1));
    assert.equal(c.state.followUp, '解释这段的话术');
  }
});

test('actual structure Send opens the shared cached result, without a native model session or transcript request', async () => {
  const c = composer();
  c.state.followUp = '帮我出这段的结构';
  c.submit();
  c.state.productRange = b;
  await c.finish();
  assert.deepEqual(c.taskReads, [{ projectId: 'project-id', scope: a }]);
  assert.equal(c.taskStarts.length, 0);
  assert.deepEqual(c.refreshes, ['project-id']);
  assert.equal(c.f.starts.length, 0);
  assert.equal(c.f.sent.length, 0);
  assert.equal(c.reads.length, 0);
  assert.equal(c.patches.at(-1).patch.status, 'ready');
});

test('actual structure Send with no selected lecture stays local and preserves its draft', async () => {
  const c = composer();
  c.state.followUp = '分析结构';
  c.state.productRange = null;
  c.submit();
  await c.finish();
  assert.match(c.errors.at(-1), /选中一个商品讲解段/);
  assert.equal(c.taskReads.length + c.taskStarts.length + c.reads.length + c.f.sent.length, 0);
  assert.equal(c.state.followUp, '分析结构');
});

test('actual structure Send failure requires an explicit retry and never falls back to ordinary chat', async () => {
  const c = composer();
  c.state.followUp = '分析结构';
  c.state.app.productStructureState = async (_projectId, scope) => ({ scope, analysis: { status: 'failed', error: '模型请求超时' } });
  c.submit(); await c.finish();
  assert.equal(c.taskStarts.length + c.f.sent.length, 0);
  assert.match(c.patches.at(-1).patch.error, /不会自动重试/);
  c.state.followUp = '重试本段结构';
  c.submit(); await c.finish();
  assert.equal(c.taskStarts.length, 1);
  assert.deepEqual(c.taskStarts[0].options, { retryFailed: true, rerun: false });
  assert.equal(c.f.starts.length, 0);
});

test('negative and no-real-request commands never start a task or fall through to an ordinary paid chat', async () => {
  for (const text of ['暂时不分析结构', '我不想分析结构', '不分析结构', '分析一下结构，别发真实模型请求', '先不要发真实模型请求', '只用模拟数据分析结构']) {
    const c = composer(); c.state.followUp = text;
    c.submit(); await c.finish();
    assert.equal(c.taskReads.length + c.taskStarts.length + c.reads.length + c.f.starts.length + c.f.sent.length, 0, text);
    assert.match(c.errors.at(-1), /未发送模型/);
  }
});

test('actual structure Send waits for request review and Cancel sends no POST', async () => {
  const c = composer(); let pending;
  c.state.followUp = '分析结构';
  c.state.app.productStructureState = async (_projectId, scope) => ({ scope, analysis: { status: 'idle' }, analysisPlan: { enabled: true, model: 'mock', requestCount: 2, transcriptSegments: 12 } });
  c.state.setStructureApproval = value => { if (typeof value === 'object') pending = value; };
  c.submit(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.taskStarts.length, 0);
  assert.equal(pending.plan.requestCount, 2);
  assert.deepEqual(pending.scope, a);
  pending.respond(false); await c.finish();
  assert.equal(c.taskStarts.length + c.f.sent.length, 0);
  assert.equal(c.patches.at(-1).patch.status, 'cancelled');
});
