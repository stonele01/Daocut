import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const bridgeSource = readFileSync(new URL('../shell/bridge.ts', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../../../packages/daocut/studio/ui/src/api.ts', import.meta.url), 'utf8');
const draftBarrierSource = readFileSync(new URL('../../../packages/daocut/studio/ui/src/lib/draft-save-barrier.ts', import.meta.url), 'utf8');

// Run the real bridge and API together; only their native, DOM and network boundaries are replaced.
function loadSource(context, source) {
  const js = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  vm.runInContext(js.replace(/^export /gm, '').replace(/^\{\s*\};?$/gm, ''), context);
}
function harness(initialPath = '/projects/a') {
  const requests = [], sockets = [], timers = [];
  const events = new Map();
  const element = () => ({ style: {}, dataset: {}, toggleAttribute() {} });
  const column = element();
  const location = { pathname: '', search: '', protocol: 'http:', host: 'localhost:4787' };
  const navigate = (path) => {
    const url = new URL(path, `http://${location.host}`);
    location.pathname = url.pathname;
    location.search = url.search;
  };
  navigate(initialPath);
  const native = {
    platform: 'linux',
    hello: async () => ({ chatOpen: true, chatWidth: 420, chatMin: 340, studioMin: 640, fullScreen: false }),
    agents: {}, localAgents: {}, chat: {}, skills: {},
    setTheme() {}, setLanguage() {}, onFullScreen() {}, onToggleChat() {},
  };
  const context = vm.createContext({
    URLSearchParams,
    window: { daocutNative: native },
    location,
    history: Object.fromEntries(['pushState', 'replaceState'].map((method) => [method, (_state, _title, url) => navigate(url)])),
    document: { documentElement: element(), getElementById: () => column, createElement: element, head: { append() {} } },
    MutationObserver: class { observe() {} },
    WebSocket: class {
      constructor(url) { this.url = url; sockets.push(this); }
      close() { this.closed = true; }
      emit(event) { this.onmessage({ data: JSON.stringify(event) }); }
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { timers[id - 1] = null; },
    innerWidth: 1280,
    addEventListener: (name, listener) => events.set(name, listener),
    flushSync: (fn) => fn(),
    fetch: (url, init) => new Promise((resolve) => {
      requests.push({ url, init, respond: (body, status = 200) => resolve({ ok: status < 400, status, json: async () => body }) });
    }),
  });
  loadSource(context, bridgeSource);
  context.studioHost = context.window.daocutHost;
  loadSource(context, draftBarrierSource);
  loadSource(context, apiSource);
  const api = vm.runInContext('api', context);
  const projectEvents = vm.runInContext('projectEvents', context);
  const bridge = context.window.daocutDesktop;
  const changed = [];
  bridge.onProject((project) => changed.push({ ...project }));
  return {
    api, bridge, native, requests, changed, sockets, column,
    subscribe: (id = 'a', listener = () => {}) => projectEvents(id, listener),
    reconnect: () => { sockets.at(-1).onclose(); timers.at(-1)(); sockets.at(-1).onopen(); },
    failReconnect: () => { sockets.at(-1).onclose(); timers.at(-1)(); },
    navigate: (path) => context.history.pushState(null, '', path),
  };
}
const project = (name = 'Untitled', id = 'a') => ({ id, name, path: `/projects/${name}`, openedAt: 1, missing: false });
const shown = (p) => ({ id: p.id, name: p.name, path: p.path });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function opened(h) {
  h.requests[0].respond({ project: project() });
  await h.bridge.hello();
}

test('a confirmed rename updates the existing chat immediately, ahead of its pending project lookup', async () => {
  const h = harness();
  const chat = h.bridge.chat;
  const renamed = project('My film');
  const rename = h.api.rename('a', renamed.name);
  assert.equal(h.requests[1].url, '/api/projects/a');
  assert.equal(h.requests[1].init.method, 'PATCH');
  h.requests[1].respond({ project: renamed });
  assert.equal((await rename).path, renamed.path);
  assert.deepEqual(h.changed, [shown(renamed)]);
  h.requests[0].respond({ project: project() });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(renamed));
  assert.equal(h.bridge.chat, chat, 'the same chat bridge stays attached');
});

test('film reads cannot restore an old folder after a confirmed rename', async () => {
  const h = harness();
  await opened(h);
  const oldFilm = h.api.film('a');
  const rename = h.api.rename('a', 'My film');
  h.requests[2].respond({ project: project('My film') });
  await rename;
  h.requests[1].respond({ project: project(), text: '' });
  await oldFilm;
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project('My film')));
  assert.deepEqual(h.changed.map((p) => p.name), ['Untitled', 'My film']);
});

test('the shared project stream updates chat for a rename in another page', async () => {
  const h = harness();
  await opened(h);
  const received = [];
  h.subscribe('a', (event) => received.push(event.type));
  h.subscribe('a');
  assert.equal(h.sockets.length, 1);
  const renamed = project('Renamed elsewhere');
  h.sockets[0].emit({ type: 'project', project: renamed });
  h.sockets[0].emit({ type: 'film', rev: '' });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(renamed));
  assert.deepEqual(h.changed.map((p) => p.name), ['Untitled', 'Renamed elsewhere']);
  assert.deepEqual(received, ['project', 'film']);
  assert.equal(h.requests.length, 1, 'current project metadata needs no extra HTTP lookup');
});

test('the project snapshot on reconnect repairs a rename missed while disconnected', async () => {
  const h = harness();
  await opened(h);
  const received = [];
  h.subscribe('a', (event) => received.push(event.type));
  h.reconnect();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].emit({ type: 'project', project: project('Renamed while offline') });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project('Renamed while offline')));
  assert.deepEqual(received, ['film', 'files', 'history', 'project']);
});

test('an initial project snapshot prevents an older lookup from restoring the old folder', async () => {
  const h = harness();
  h.subscribe();
  h.sockets[0].emit({ type: 'project', project: project('Current folder') });
  h.requests[0].respond({ project: project() });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project('Current folder')));
});

test('an earlier project lookup cannot replace the project reached by navigation', async () => {
  const h = harness();
  h.navigate('/projects/b');
  h.requests[1].respond({ project: project('Project B', 'b') });
  await h.bridge.hello();
  h.requests[0].respond({ project: project() });
  await tick();
  assert.deepEqual(h.changed, [shown(project('Project B', 'b'))]);
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project('Project B', 'b')));
});

test('a previous project rename does not cancel the newly opened project lookup', async () => {
  const h = harness();
  await opened(h);
  const rename = h.api.rename('a', 'Renamed A');
  h.subscribe('a');
  h.navigate('/projects/b');
  h.requests[1].respond({ project: project('Renamed A') });
  await rename;
  h.sockets[0].emit({ type: 'project', project: project('Renamed A again') });
  h.requests[2].respond({ project: project('Project B', 'b') });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project('Project B', 'b')));
});

test('leaving keeps the chat mounted and returning invalidates reads from the earlier visit', async () => {
  const h = harness();
  await opened(h);
  const chat = h.bridge.chat;
  h.navigate('/projects/a');
  h.navigate('/');
  assert.equal(h.column.hidden, true);
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project()));
  assert.equal(h.bridge.chat, chat);
  assert.deepEqual(h.changed, [shown(project())], 'no null/reset project notification on leaving');
  h.navigate('/projects/a');
  assert.equal(h.column.hidden, false);
  h.requests[1].respond({ project: project('Earlier visit') });
  await tick();
  assert.deepEqual(h.changed.map((p) => p.name), ['Untitled']);
  h.requests[2].respond({ project: project('Current visit') });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project('Current visit')));
});

test('late events from an unsubscribed project stream cannot overwrite its next visit', async () => {
  const h = harness();
  await opened(h);
  const stop = h.subscribe();
  stop();
  assert.equal(h.sockets[0].closed, true);
  h.navigate('/');
  h.navigate('/projects/a');
  h.subscribe();
  h.sockets[1].emit({ type: 'project', project: project('Current visit') });
  h.sockets[0].emit({ type: 'project', project: project('Previous visit') });
  h.requests[1].respond({ project: project() });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project('Current visit')));
});

test('opening a structure draft keeps the owner URL and follows the child project directly', async () => {
  const h = harness('/projects/a?structureDraft=sd-one');
  const child = project('Plan one', 'sd-one');
  assert.equal(h.requests[0].url, '/api/projects/sd-one');
  h.requests[0].respond({ project: child });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(child));
  assert.deepEqual(h.changed, [shown(child)]);
  assert.equal(h.requests.length, 1, 'a hidden child does not need the project list');
});

test('a same-owner draft query change invalidates the pending parent lookup and parent events', async () => {
  const h = harness();
  const chat = h.bridge.chat;
  h.subscribe('a');
  const oldFilm = h.api.film('a');
  h.navigate('/projects/a?structureDraft=sd-one');
  assert.equal(h.requests[2].url, '/api/projects/sd-one');
  h.requests[0].respond({ project: project('Stale owner lookup') });
  h.requests[1].respond({ project: project('Stale owner film'), text: '' });
  await oldFilm;
  h.sockets[0].emit({ type: 'project', project: project('Stale owner stream') });
  assert.deepEqual(h.changed, []);
  const child = project('Plan one', 'sd-one');
  h.requests[2].respond({ project: child });
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(child));
  h.sockets[0].emit({ type: 'project', project: project('Late owner stream') });
  assert.deepEqual(h.changed, [shown(child)]);
  assert.equal(h.bridge.chat, chat);
});

test('switching draft queries under the same owner rejects the previous child lookup and stream', async () => {
  const h = harness('/projects/a?structureDraft=sd-one');
  h.subscribe('sd-one');
  h.navigate('/projects/a?structureDraft=sd-two');
  const second = project('Plan two', 'sd-two');
  assert.equal(h.requests[1].url, '/api/projects/sd-two');
  h.requests[1].respond({ project: second });
  await h.bridge.hello();
  h.requests[0].respond({ project: project('Plan one', 'sd-one') });
  h.sockets[0].emit({ type: 'project', project: project('Changed plan one', 'sd-one') });
  await tick();
  assert.deepEqual(h.changed, [shown(second)]);
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(second));
});

test('removing the draft query restores the owner and ignores the child stream', async () => {
  const h = harness('/projects/a?structureDraft=sd-one');
  const child = project('Plan one', 'sd-one');
  h.requests[0].respond({ project: child });
  await h.bridge.hello();
  h.subscribe('sd-one');
  h.navigate('/projects/a');
  assert.equal(h.requests[1].url, '/api/projects/a');
  h.requests[1].respond({ project: project() });
  await h.bridge.hello();
  h.sockets[0].emit({ type: 'project', project: project('Late child', 'sd-one') });
  assert.deepEqual(h.changed, [shown(child), shown(project())]);
  assert.deepEqual({ ...(await h.bridge.hello()).project }, shown(project()));
});

test('repeated draft reconnect failures check the hidden child directly without reporting it gone', async () => {
  const h = harness('/projects/a?structureDraft=sd-one');
  const child = project('Plan one', 'sd-one');
  h.requests[0].respond({ project: child });
  await h.bridge.hello();
  const received = [];
  h.subscribe('sd-one', (event) => received.push(event.type));
  for (let attempt = 0; attempt < 3; attempt += 1) h.failReconnect();
  assert.equal(h.requests[1].url, '/api/projects/sd-one', 'the launcher intentionally hides draft children');
  h.requests[1].respond({ project: child });
  await tick();
  assert.deepEqual(received, []);
  h.sockets.at(-1).onopen();
  h.sockets.at(-1).emit({ type: 'project', project: child });
  assert.deepEqual(received, ['film', 'files', 'history', 'project']);
});

test('a missing child still reports gone after repeated reconnect failures', async () => {
  const h = harness('/projects/a?structureDraft=sd-one');
  h.requests[0].respond({ project: project('Plan one', 'sd-one') });
  await h.bridge.hello();
  const received = [];
  h.subscribe('sd-one', (event) => received.push(event.type));
  for (let attempt = 0; attempt < 3; attempt += 1) h.failReconnect();
  assert.equal(h.requests[1].url, '/api/projects/sd-one');
  h.requests[1].respond({ error: 'Project not found' }, 404);
  await tick();
  assert.deepEqual(received, ['gone']);
});

test('a refused rename leaves the chat path unchanged and preserves the reason for Studio', async () => {
  const h = harness();
  await opened(h);
  const rename = h.api.rename('a', 'My film');
  h.requests[1].respond({ error: 'Stop the agent first.', code: 'agent-running' }, 409);
  await assert.rejects(rename, (error) => error.status === 409 && error.body.code === 'agent-running');
  assert.deepEqual(h.changed, [shown(project())]);
});

test('product chat context reads the selected saved range with source milliseconds and no mutation', async () => {
  const h = harness();
  await opened(h);
  const scope = { sourceId: 'source /一', productId: 'product-a', intervalId: 'a-return', productName: 'A', startMs: 1250, endMs: 2900 };
  const reading = h.bridge.productChatContext('a', scope);
  const request = h.requests.at(-1);
  assert.ok(request.url.startsWith('/api/projects/a/product-chat-context?'));
  assert.equal(request.init, undefined, 'same-origin read uses GET without an upload body');
  assert.deepEqual(Object.fromEntries(new URL(request.url, 'http://local').searchParams), {
    sourceId: scope.sourceId, productId: scope.productId, intervalId: scope.intervalId, startMs: '1250', endMs: '2900',
  });
  const result = { scope, transcriptVersion: 'v1', segments: [{ startMs: 1400, endMs: 2500, text: 'A 原话' }] };
  request.respond(result);
  assert.equal(await reading, result);
  assert.equal(h.requests.length, 2);
});

test('structure bridge uses shared task endpoints with the frozen lecture scope and never retries a rejected POST', async () => {
  const h = harness(); await opened(h);
  const scope = { sourceId: 'source /一', productId: 'a', intervalId: 'a-return', productName: 'A', startMs: 3600000, endMs: 3660000 };
  const reading = h.bridge.productStructureState('a', scope, { retry: true, rerun: false });
  const get = h.requests.at(-1);
  const params = new URL(get.url, 'http://localhost').searchParams;
  assert.equal(params.get('lectureOnly'), 'true');
  assert.equal(params.get('startMs'), String(scope.startMs));
  assert.equal(params.get('sourceId'), scope.sourceId);
  get.respond({ scope, analysis: { status: 'failed' } }); await tick();
  const planning = h.requests.at(-1);
  assert.ok(planning.url.includes('/product-workflow/plan?'));
  assert.equal(new URL(planning.url, 'http://localhost').searchParams.get('retry'), 'true');
  const plan = { identity: 'exact-approved-plan', action: 'analysis', sourceId: scope.sourceId, productId: scope.productId, intervalId: scope.intervalId, scope, enabled: true, service: { model: 'mock', endpoint: 'mock://text' }, cost: { basis: '模拟不计费' }, retryRequired: true };
  planning.respond(plan);
  assert.equal((await reading).workflowPlan, plan);
  const submitting = h.bridge.startProductStructure('a', scope, { retryFailed: true, rerun: false, plan });
  const post = h.requests.at(-1);
  assert.equal(post.url, '/api/projects/a/product-workflow/execute');
  assert.deepEqual(JSON.parse(post.init.body), { confirmed: true, plan, retryAcknowledged: true });
  post.respond({ error: '提交状态不确定' }, 409);
  await assert.rejects(submitting, /提交状态不确定/);
  await tick();
  assert.equal(h.requests.length, 4);
  await assert.rejects(h.bridge.startProductStructure('b', scope, { retryFailed: false, rerun: false }), /工程已切换/);
  assert.equal(h.requests.length, 4);
});

test('structure bridge reuses saved results and refuses missing or wrong-range plans before POST', async () => {
  const h = harness(); await opened(h);
  const scope = { sourceId: 's', productId: 'a', intervalId: 'a1', startMs: 1, endMs: 2 };
  const reading = h.bridge.productStructureState('a', scope);
  h.requests.at(-1).respond({ scope, analysis: { status: 'complete', stale: false } });
  assert.equal((await reading).analysis.status, 'complete');
  assert.equal(h.requests.length, 2);
  await assert.rejects(h.bridge.startProductStructure('a', scope, { retryFailed: false, rerun: false }), /确认计划/);
  await assert.rejects(h.bridge.startProductStructure('a', scope, { retryFailed: false, rerun: false, plan: { action: 'analysis', scope: { ...scope, endMs: 3 } } }), /商品段/);
  assert.equal(h.requests.length, 2);
});

test('explicit rerun after failure obtains a retry-aware plan and successful submit only reads status', async () => {
  const h = harness(); await opened(h);
  const scope = { sourceId: 's', productId: 'a', intervalId: 'a1', startMs: 1, endMs: 2 };
  const reading = h.bridge.productStructureState('a', scope, { retry: false, rerun: true });
  h.requests.at(-1).respond({ scope, analysis: { status: 'failed' } }); await tick();
  const planning = h.requests.at(-1);
  assert.equal(new URL(planning.url, 'http://localhost').searchParams.get('retry'), 'true');
  const plan = { identity: 'rerun-plan', action: 'analysis', scope, rerun: true, retry: true, enabled: true, service: { model: 'mock' }, cost: { basis: '模拟' } };
  planning.respond(plan); await reading;
  const submitting = h.bridge.startProductStructure('a', scope, { retryFailed: false, rerun: true, plan });
  const post = h.requests.at(-1);
  assert.equal(JSON.parse(post.init.body).retryAcknowledged, true);
  post.respond({ state: { busy: true } }); await tick();
  assert.equal(h.requests.at(-1).init, undefined);
  h.requests.at(-1).respond({ scope, analysis: { status: 'running' } });
  assert.equal((await submitting).analysis.status, 'running');
  assert.equal(h.requests.filter(request => request.init?.method === 'POST').length, 1);
});

test('product chat context rejects a changed project or failed read without retry or full-source fallback', async () => {
  const h = harness();
  await opened(h);
  const scope = { sourceId: 'source', productId: 'a', intervalId: 'a-1', productName: 'A', startMs: 1, endMs: 2 };
  await assert.rejects(h.bridge.productChatContext('b', scope), /工程已切换/);
  assert.equal(h.requests.length, 1);
  const failed = h.bridge.productChatContext('a', scope);
  h.requests.at(-1).respond({ error: '没有已保存转写' }, 409);
  await assert.rejects(failed, /没有已保存转写/);
  await tick();
  assert.equal(h.requests.length, 2, 'no automatic retry, transcription or full-video fetch');
});
