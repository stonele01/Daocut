import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as context from '../chat/src/lib/agent-context.ts';

const require = createRequire(import.meta.url);
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function compiled(relative, mocks, browser = {}) {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'sessionStorage', 'window', output)((id) => {
    if (!(id in mocks)) throw Error('Unmocked import ' + id);
    return mocks[id];
  }, module, module.exports, browser.sessionStorage, browser.window);
  return module.exports;
}
const copy = (value) => structuredClone(value);
const nativeInfo = (mode = 'default', model = 'a', choices = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'agent', 'agent-full-access']) => ({
  sessionId: 'native', agentInfo: null, authMethods: [], mcp: false, models: null,
  modes: { currentModeId: mode, availableModes: choices.map((id) => ({ id, name: id })) },
  configOptions: [
    { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: model, options: ['a', 'b', 'c'].map((value) => ({ value, name: value })) },
    { id: 'mode', category: 'mode', name: 'Mode', type: 'select', currentValue: mode, options: choices.map((value) => ({ value, name: value })) },
  ],
});
const modeOf = (info) => info.configOptions.find((o) => o.id === 'mode').currentValue;
function harness({ initial = nativeInfo(), sharedStorage = storage(), fixedKey, onSet, onPrompt } = {}) {
  let listener;
  let serial = 0;
  let turnSerial = 0;
  const state = new Map();
  const calls = [];
  const prompts = [];
  const reports = [];
  const bridge = {
    onEvent: (fn) => { listener = fn; return () => {}; },
    start: async () => {
      const key = fixedKey ?? 'session-' + ++serial;
      const info = copy(initial);
      state.set(key, info);
      return { ok: true, key, info: copy(info) };
    },
    setOption: async (key, id, value) => {
      calls.push({ key, id, value });
      const info = state.get(key);
      if (onSet) return onSet({ key, id, value, info, emit: (update) => listener({ kind: 'update', key, update }) });
      info.configOptions.find((o) => o.id === id).currentValue = value;
      return { ok: true, result: { configOptions: copy(info.configOptions) } };
    },
    prompt: async (key, text) => {
      prompts.push({ key, text });
      return onPrompt ? onPrompt({ key, emit: (event) => listener({ key, ...event }), bridge }) : { ok: true, stopReason: 'end_turn' };
    },
    running: async () => [],
  };
  const api = compiled('../chat/src/lib/local-agent-run.ts', {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() }, './agent-context': context,
    '@/lib/desktop-bridge': { desktopBridge: () => ({ localAgents: bridge }) },
    '@/lib/unprompted': { opensUnprompted: () => false },
    '@/lib/agent-transcript': { reduceTranscript: (items) => items },
    '../app-bridge': { app: {} }, '@daocut/shared': {}, '@/lib/chat-store': {},
    'daocut/studio-ui/lib/storage-migration.ts': {},
  }, { sessionStorage: sharedStorage });
  const run = async ({ agent = 'claude', conversation = 'one', options = {} } = {}) => {
    const turn = new api.LocalAgentTurn('local:' + ++turnSerial, agent, turnSerial);
    // No artificial quiet-period wait is needed when the fixture sends no transcript content.
    turn.lastEventAt = 0;
    await api.runLocalAgentTurn({ projectId: 'p', conversation, agent, cwd: 'D:/synthetic', text: 'Continue the requested edit', turn, options, onSessionInfo: (info) => reports.push(copy(info)) });
    return turn;
  };
  return { api, run, calls, prompts, reports, state, bridge, emit: (event) => listener(event) };
}

test('old persisted native modes are ignored while model picks and other providers keep their behavior', () => {
  const localStorage = storage();
  localStorage.setItem('daocut.local-agents.v2', JSON.stringify({ picked: 'claude', prefs: {
    claude: { mode: 'bypassPermissions', permissionMode: 'bypassPermissions', model: 'a' },
    codex: { mode: 'agent-full-access', model: 'b' },
    byok: { model: 'own' }, kimi: { model: 'k' }, minimax: { model: 'm' }, deepseek: { mode: 'custom', model: 'd' },
  }, options: {} }));
  const api = compiled('../chat/src/state/local-agent-store.ts', {
    zustand: require('zustand'), '../../../src/agent-definitions.mjs': { isAgentId: (id) => ['claude', 'codex', 'byok', 'kimi', 'minimax', 'deepseek'].includes(id) },
    '@/lib/desktop-bridge': { desktopBridge: () => null }, '@/lib/local-agent-run': {}, 'daocut/studio-ui/lib/storage-migration.ts': {},
  }, { window: { localStorage } });
  api.useLocalAgents.getState().hydrate();
  const { prefs } = api.useLocalAgents.getState();
  assert.deepEqual(api.effectivePrefs(prefs, 'claude'), { model: 'a' });
  assert.deepEqual(api.effectivePrefs(prefs, 'codex'), { model: 'b' });
  assert.deepEqual(api.effectivePrefs(prefs, 'byok', [{ id: 'byok', byok: { models: [{ id: 'own', model: 'service' }] } }]), { model: 'own', mode: 'agent-full-access' });
  assert.deepEqual(api.effectivePrefs(prefs, 'kimi'), { model: 'k', mode: 'yolo' });
  assert.deepEqual(api.effectivePrefs(prefs, 'minimax'), { model: 'm', permissionMode: 'bypassPermissions' });
  assert.deepEqual(api.effectivePrefs(prefs, 'deepseek'), { model: 'd', mode: 'custom' });
  assert.equal(JSON.parse(localStorage.getItem('daocut.local-agents.v2')).prefs.claude.mode, 'bypassPermissions', 'reading preferences does not rewrite unrelated user state');
});

test('Codex uses agent once, ignores old full-access options, and repeats only for a new physical session', async () => {
  const h = harness({ initial: nativeInfo('agent-full-access') });
  await h.run({ agent: 'codex', options: { mode: 'agent-full-access' } });
  await h.run({ agent: 'codex', options: { mode: 'agent-full-access' } });
  await h.run({ agent: 'codex', conversation: 'two' });
  assert.deepEqual(h.calls.map(({ id, value }) => [id, value]), [['mode', 'agent'], ['mode', 'agent']]);
  assert.equal(h.prompts.length, 3);
  assert.equal(modeOf(h.reports[0]), 'agent');
});

test('Claude auto succeeds once and native permission requests still reach the existing UI', async () => {
  let permissionSeen;
  let finish;
  const waiting = new Promise((resolve) => { permissionSeen = resolve; });
  const h = harness({ onPrompt: async ({ key, emit, bridge }) => {
    if (finish) return { ok: true, stopReason: 'end_turn' };
    const answer = new Promise((resolve) => { finish = resolve; });
    bridge.answerPermission = async (answerKey, requestId, optionId) => { assert.equal(answerKey, key); assert.equal(requestId, 'approval'); assert.equal(optionId, 'allow-once'); finish(); };
    emit({ kind: 'permission', requestId: 'approval', params: { toolCall: { title: 'Requested export' }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }] } });
    permissionSeen();
    await answer;
    return { ok: true, stopReason: 'end_turn' };
  } });
  const running = h.run();
  await waiting;
  const turn = h.api.localAgentTurn('local:1');
  assert.equal(turn.state.permission.title, 'Requested export');
  await h.api.answerLocalAgentPermission('local:1', 'allow-once');
  await running;
  await h.run();
  assert.deepEqual(h.calls.map((c) => c.value), ['auto']);
  assert.equal(modeOf(h.reports[0]), 'auto');
});

test('the installed Claude adapter fallback is retained across turns and renderer reconnects', async () => {
  const { SessionModeManager } = await import('@agentclientprotocol/claude-agent-acp/dist/session-mode.js');
  const sharedStorage = storage();
  const h = harness({ sharedStorage, fixedKey: 'physical-claude', onSet: async ({ id, value, info, emit }) => {
    assert.equal(id, 'mode');
    const adapterSession = { modes: copy(info.modes), models: { currentModelId: 'a' }, modelInfos: [{ value: 'a', supportsAutoMode: false }], configOptions: info.configOptions, query: { setPermissionMode: async () => {} } };
    let manager;
    manager = new SessionModeManager({ getSession: () => adapterSession, logError: () => {}, supportsNotices: () => true,
      sessionUpdate: async ({ update }) => emit(update),
      updateConfigOption: async (_sessionId, _id, effective) => { manager.syncConfig(adapterSession, effective); info.configOptions = adapterSession.configOptions; emit({ sessionUpdate: 'config_option_update', configOptions: copy(info.configOptions) }); },
    });
    await manager.setSessionMode({ sessionId: 'native', modeId: value });
    return { ok: true, result: { configOptions: copy(info.configOptions) } };
  } });
  await h.run();
  await h.run();
  assert.deepEqual(h.calls.map((c) => c.value), ['auto']);
  assert.equal(modeOf(h.reports[0]), 'acceptEdits', 'actual adapter fallback, not a fabricated auto success');
  const reloaded = harness({ sharedStorage, fixedKey: 'physical-claude', initial: nativeInfo('acceptEdits') });
  await reloaded.run();
  assert.deepEqual(reloaded.calls, [], 'a renderer reload is not a fresh physical agent session');
  const fresh = harness({ sharedStorage, fixedKey: 'new-physical-claude', initial: nativeInfo('acceptEdits') });
  await fresh.run();
  assert.equal(fresh.calls[0].value, 'auto');
});

test('a current_mode_update before an empty successful response cannot be overwritten with auto', async () => {
  const h = harness({ onSet: async ({ emit }) => { emit({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' }); return { ok: true, result: {} }; } });
  await h.run();
  await h.run();
  assert.equal(modeOf(h.reports[0]), 'acceptEdits');
  assert.equal(h.reports[0].modes.currentModeId, 'acceptEdits');
  assert.equal(h.calls.length, 1);
});

test('model changes keep the adapter fallback and try auto once for another model', async () => {
  const h = harness({ onSet: async ({ id, value, info, emit }) => {
    info.configOptions.find((o) => o.id === id).currentValue = value;
    if (id === 'model' && value === 'b') {
      info.configOptions.find((o) => o.id === 'mode').currentValue = 'acceptEdits';
      emit({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
    }
    return { ok: true, result: { configOptions: copy(info.configOptions) } };
  } });
  await h.run();
  await h.run({ options: { model: 'b' } });
  await h.run({ options: { model: 'b' } });
  assert.deepEqual(h.calls.map(({ id, value }) => [id, value]), [['mode', 'auto'], ['model', 'b']]);
  await h.run({ options: { model: 'c' } });
  await h.run({ options: { model: 'c' } });
  assert.deepEqual(h.calls.slice(2).map(({ id, value }) => [id, value]), [['model', 'c'], ['mode', 'auto']]);
});

test('unavailable auto leaves existing mode intact; an adapter rejection is visible once without blocking edits', async () => {
  const unsupported = harness({ initial: nativeInfo('acceptEdits', 'a', ['default', 'acceptEdits', 'bypassPermissions']) });
  await unsupported.run();
  assert.deepEqual(unsupported.calls, []);
  assert.equal(modeOf(unsupported.reports[0]), 'acceptEdits');
  const failed = harness({ initial: nativeInfo('bypassPermissions'), onSet: async () => ({ ok: false, error: 'Auto mode is unavailable for this account' }) });
  const first = await failed.run();
  const next = await failed.run();
  assert.equal(modeOf(failed.reports[0]), 'bypassPermissions');
  assert.match(first.items.find((i) => i.kind === 'notice').text, /unavailable for this account.*Current mode: bypassPermissions/);
  assert.equal(next.items.some((i) => i.kind === 'notice'), false);
  assert.equal(failed.calls.length, 1);
  assert.equal(failed.prompts.length, 2);
});

test('BYOK and other providers receive their existing options without native mode defaults', async () => {
  const h = harness();
  await h.run({ agent: 'byok', options: { mode: 'agent-full-access' } });
  await h.run({ agent: 'deepseek', options: { mode: 'custom' } });
  assert.deepEqual(h.calls.map((c) => c.value), ['agent-full-access', 'custom']);
});

test('adapter-initiated model fallback is respected without another frontend mode request', async () => {
  const h = harness();
  await h.run();
  h.emit({ kind: 'update', key: 'session-1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' } });
  h.emit({ kind: 'update', key: 'session-1', update: { sessionUpdate: 'config_option_update', configOptions: nativeInfo('acceptEdits', 'b').configOptions } });
  await h.run();
  assert.deepEqual(h.calls.map((c) => c.value), ['auto']);
});

test('a running session recovered after reload retains its reported mode', async () => {
  const h = harness();
  h.bridge.running = async () => [{ key: 'recovered-session', agent: 'claude', cwd: 'D:/synthetic', info: nativeInfo('acceptEdits'), meta: { projectId: 'p', sessionId: 'one', turnId: 'local:recovered' }, events: [], done: { ok: true, stopReason: 'end_turn' } }];
  await h.api.recoverLocalAgentTurns('p');
  await h.run();
  assert.deepEqual(h.calls, []);
  assert.equal(h.prompts[0].key, 'recovered-session');
});

test('a legacy mode-only fallback does not suppress auto after the user selects a different model', async () => {
  const h = harness({ onSet: async ({ id, value, info, emit }) => {
    if (id === 'mode') {
      info.configOptions.find((o) => o.id === 'mode').currentValue = 'acceptEdits';
      emit({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
      return { ok: true, result: {} };
    }
    info.configOptions.find((o) => o.id === id).currentValue = value;
    return { ok: true, result: { configOptions: copy(info.configOptions) } };
  } });
  await h.run();
  await h.run({ options: { model: 'c' } });
  assert.deepEqual(h.calls.map(({ id, value }) => [id, value]), [['mode', 'auto'], ['model', 'c'], ['mode', 'auto']]);
});

test('legacy set_model success plus a mode fallback does not resend the same model on the next turn', async () => {
  const h = harness({ onSet: async ({ id, value, info, emit }) => {
    info.configOptions.find((o) => o.id === id).currentValue = value;
    if (id === 'model') {
      info.configOptions.find((o) => o.id === 'mode').currentValue = 'acceptEdits';
      emit({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
      return { ok: true, result: {} };
    }
    return { ok: true, result: { configOptions: copy(info.configOptions) } };
  } });
  await h.run();
  await h.run({ options: { model: 'b' } });
  await h.run({ options: { model: 'b' } });
  assert.deepEqual(h.calls.map(({ id, value }) => [id, value]), [['mode', 'auto'], ['model', 'b']]);
  assert.equal(h.prompts.length, 3, 'the next editing turn continues without reconfiguration');
});
