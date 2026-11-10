import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAgentContext, contextForModel, contextPercent } from '../chat/src/lib/agent-context.ts';
import { sessionContextUpdate } from './pi-config.mjs';

const update = (used, size = 128000) => ({ sessionUpdate: 'usage_update', used, size });
test('context accepts native occupancy, not cumulative billing totals or cost', () => {
  assert.deepEqual(readAgentContext({ ...update(24000), totalTokens: 900000, cost: { amount: 99 } }), { used: 24000, size: 128000 });
  assert.equal(readAgentContext({ totalTokens: 900000 }), undefined);
  assert.equal(contextPercent(readAgentContext(update(24000))), 19);
});
test('unknown and invalid usage stay distinct from reported zero and overflow', () => {
  for (const value of [null, undefined, -1, NaN, Infinity, '100']) assert.equal(readAgentContext(update(value)), null);
  for (const size of [0, -1, NaN, Infinity, undefined]) assert.equal(readAgentContext({ ...update(1), size }), null);
  assert.equal(contextPercent(readAgentContext(update(0))), 0);
  assert.equal(contextPercent(readAgentContext(update(150000))), 117);
  assert.equal(contextPercent(null), null);
});
test('native unknown after compaction clears the old percentage, then lower usage replaces it', () => {
  const before = readAgentContext(update(110000));
  assert.equal(contextPercent(before), 86);
  const unknown = sessionContextUpdate({ getContextUsage: () => ({ tokens: null, contextWindow: 128000, percent: null }) });
  assert.equal(unknown.sessionUpdate, 'session_info_update');
  assert.equal(readAgentContext(unknown), null);
  const after = sessionContextUpdate({ getContextUsage: () => ({ tokens: 12000, contextWindow: 128000, percent: 9.375 }) });
  assert.equal(contextPercent(readAgentContext(after)), 9);
});
test('a selected but not applied model never shows the previous model percentage', () => {
  const context = readAgentContext(update(64000));
  assert.equal(contextForModel(context, 'a', 'b'), null);
  assert.equal(contextForModel(context, undefined, 'b'), null);
  assert.equal(contextForModel(context, 'a', 'a'), context);
  const resized = readAgentContext(update(64000, 256000));
  assert.equal(contextPercent(contextForModel(resized, 'b', 'b')), 25);
});
test('missing native model context is unknown and unrelated metadata is ignored', () => {
  for (const usage of [undefined, { tokens: NaN, contextWindow: 128000 }, { tokens: 20, contextWindow: 0 }]) {
    assert.equal(readAgentContext(sessionContextUpdate({ getContextUsage: () => usage })), null);
  }
  assert.equal(readAgentContext({ sessionUpdate: 'session_info_update', title: 'Example' }), undefined);
});


test('chat event pipeline scopes snapshots by session, clears on exit and model change, and restores running context', async () => {
  const { readFileSync } = await import('node:fs');
  const ts = await import('typescript');
  const actualContext = await import('../chat/src/lib/agent-context.ts');
  let emit;
  let restored = [];
  let serial = 0;
  const info = (model = 'a') => ({ sessionId: 'native', configOptions: [{ id: 'model', category: 'model', currentValue: model }] });
  const bridge = {
    onEvent: (listener) => { emit = listener; return () => {}; },
    start: async () => ({ ok: true, key: 's' + ++serial, info: info() }),
    prompt: async () => ({ ok: true, stopReason: 'end_turn' }),
    setOption: async () => ({ ok: true, result: { configOptions: info('b').configOptions } }),
    running: async () => restored,
  };
  let notifications = 0;
  const react = { useSyncExternalStore: (subscribe, snapshot) => { subscribe(() => { notifications++; }); return snapshot(); } };
  const mocks = {
    react, './agent-context': actualContext,
    '@/lib/desktop-bridge': { desktopBridge: () => ({ localAgents: bridge }) },
    '@/lib/unprompted': { opensUnprompted: () => false },
    '@/lib/agent-transcript': { reduceTranscript: (items) => items },
    '../app-bridge': { app: {} },
    '@daocut/shared': {}, '@/lib/chat-store': {},
    'daocut/studio-ui/lib/storage-migration.ts': {},
  };
  const source = readFileSync(new URL('../chat/src/lib/local-agent-run.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((id) => {
    if (!(id in mocks)) throw Error('Unmocked import ' + id);
    return mocks[id];
  }, module, module.exports);
  const api = module.exports;
  const start = async (conversation) => {
    const turn = new api.LocalAgentTurn('local:' + conversation, 'byok');
    await api.runLocalAgentTurn({ projectId: 'p', conversation, agent: 'byok', cwd: '/synthetic', text: 'test', turn });
  };
  const current = (conversation, model = 'a') => api.useAgentContext('p', conversation, 'byok', model);
  await start('one');
  emit({ kind: 'update', key: 's1', update: detailedUpdate(96000) });
  assert.equal(contextPercent(current('one')), 75);
  assert.deepEqual(current('one').breakdown, localBreakdown());
  await start('two');
  assert.equal(current('two'), null);
  emit({ kind: 'update', key: 's2', update: update(12800) });
  assert.equal(contextPercent(current('two')), 10);
  assert.equal(current('two').breakdown, undefined, 'another session does not borrow categories');
  assert.equal(contextPercent(current('one')), 75);
  assert.equal(current('one', 'b'), null, 'menu switch immediately hides the old model');
  emit({ kind: 'update', key: 's1', update: { sessionUpdate: 'session_info_update', _meta: { 'daocut/contextUsage': null } } });
  assert.equal(current('one'), null);
  emit({ kind: 'update', key: 's1', update: update(6400) });
  assert.equal(contextPercent(current('one')), 5, 'compaction may reduce usage');
  assert.equal(current('one').breakdown, undefined, 'new snapshot without categories clears old details');
  emit({ kind: 'update', key: 's1', update: { sessionUpdate: 'config_option_update', configOptions: info('b').configOptions } });
  assert.equal(current('one', 'b'), null);
  emit({ kind: 'update', key: 's1', update: detailedUpdate(6400, localBreakdown({ system: 11, tools: 22, messages: 33 }), 256000) });
  assert.equal(contextPercent(current('one', 'b')), 3);
  assert.deepEqual(current('one', 'b').breakdown, localBreakdown({ system: 11, tools: 22, messages: 33 }));
  emit({ kind: 'exit', key: 's1' });
  assert.equal(current('one', 'b'), null);
  assert.equal(contextPercent(current('two')), 10);
  restored = [{ key: 's3', agent: 'byok', cwd: '/synthetic', info: info('b'), meta: { projectId: 'p', sessionId: 'three', turnId: 'local:three' }, done: { ok: true, stopReason: 'end_turn' }, events: [{ kind: 'update', update: detailedUpdate(25600, localBreakdown({ system: 44 }), 256000) }] }];
  await api.recoverLocalAgentTurns('p');
  assert.equal(contextPercent(current('three', 'b')), 10, 'reload restores model and last context event');
  assert.deepEqual(current('three', 'b').breakdown, localBreakdown({ system: 44 }), 'reload restores only this session metadata');
  api.forgetLocalAgentSessions('byok');
  assert.equal(current('two'), null);
  assert.equal(current('three', 'b'), null);
  assert.ok(notifications > 0, 'subscriptions learn about resets as well as usage');
});

const localBreakdown = (over = {}) => ({ source: 'local-estimate', system: 100, tools: 200, messages: 300, ...over });
const detailedUpdate = (used, detail = localBreakdown(), size = 128000) => ({
  ...update(used, size), _meta: { 'daocut/contextBreakdown': detail },
});

test('optional local categories are independent estimates and invalid metadata never replaces a valid native total', () => {
  const expected = { used: 9000, size: 128000, breakdown: localBreakdown() };
  assert.deepEqual(readAgentContext(detailedUpdate(9000)), expected);
  assert.equal(contextPercent(expected), 7, 'native total, not the sum of categories');
  for (const invalid of [null, {}, { ...localBreakdown(), source: 'provider' },
    localBreakdown({ system: -1 }), localBreakdown({ tools: NaN }), localBreakdown({ messages: Infinity }),
    localBreakdown({ system: 0.5 }), localBreakdown({ system: '1' }), localBreakdown({ tools: undefined }),
    localBreakdown({ messages: Number.MAX_SAFE_INTEGER + 1 })]) {
    assert.deepEqual(readAgentContext(detailedUpdate(9000, invalid)), { used: 9000, size: 128000 });
  }
  assert.deepEqual(readAgentContext(detailedUpdate(0, localBreakdown({ system: 0, tools: 0, messages: 0 }))).breakdown,
    { source: 'local-estimate', system: 0, tools: 0, messages: 0 }, 'known zero is retained');
  assert.equal(readAgentContext(detailedUpdate(-1)), null, 'metadata cannot rescue an invalid native total');
});

test('Pi breakdown reuses the SDK on the current projection, effective prompt and active schemas without history double counting', async () => {
  const { estimateTokens } = await import('@earendil-works/pi-coding-agent');
  const currentTool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execute: () => { throw Error('must never execute'); } };
  const oldTool = { name: 'removed', description: 'Old declaration', parameters: { type: 'object' } };
  let projection = [
    { role: 'system', content: 'old prompt '.repeat(500), sections: { old: 'stale'.repeat(200) }, toolsAdded: [oldTool, oldTool] },
    { role: 'system', content: '', sections: { custom: 'current prompt' }, toolsRemoved: [oldTool], toolsAdded: [currentTool] },
    { role: 'user', content: [{ type: 'text', text: 'private fixture question' }, { type: 'image', data: 'synthetic', mimeType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'fixture thinking' }, { type: 'toolCall', id: 't', name: 'read', arguments: { path: 'film.html' } }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'fixture tool result' }] },
  ];
  const session = {
    getContextUsage: () => ({ tokens: 9000, contextWindow: 128000 }),
    sessionManager: { buildSessionProjection: () => ({ messages: projection }) },
    systemPrompt: 'current effective rendered prompt',
    agent: { state: { tools: [currentTool] } },
  };
  const result = sessionContextUpdate(session, estimateTokens);
  const detail = result._meta['daocut/contextBreakdown'];
  const { name, description, parameters } = currentTool;
  assert.deepEqual(detail, {
    source: 'local-estimate',
    system: estimateTokens({ role: 'system', content: session.systemPrompt }),
    tools: estimateTokens({ role: 'system', content: '', toolsAdded: [{ name, description, parameters }] }),
    messages: projection.filter(m => m.role !== 'system').reduce((sum, message) => sum + estimateTokens(message), 0),
  });
  assert.equal(result.used, 9000, 'provider-anchored native total is untouched');
  assert.ok(detail.messages >= 1200, 'image and tool content are included by the native estimator');
  assert.equal(JSON.stringify(result).includes('private fixture'), false, 'only counts cross ACP');
  assert.equal(JSON.stringify(result).includes('fixture thinking'), false);
  session.agent.state.tools = [];
  projection = [{ role: 'system', content: '' }, { role: 'user', content: 'compacted checkpoint' }];
  const after = sessionContextUpdate(session, estimateTokens)._meta['daocut/contextBreakdown'];
  assert.equal(after.tools, 0, 'no active tool is zero, not historical declarations');
  assert.ok(after.messages < detail.messages, 'current projection replaces pre-compaction content');
  session.getContextUsage = () => ({ tokens: null, contextWindow: 128000 });
  assert.deepEqual(sessionContextUpdate(session, estimateTokens), { sessionUpdate: 'session_info_update', _meta: { 'daocut/contextUsage': null } });
});

test('missing or failed optional estimates leave native occupancy usable and do not invent first-request details', () => {
  const base = { getContextUsage: () => ({ tokens: 0, contextWindow: 128000 }) };
  assert.deepEqual(sessionContextUpdate(base), update(0));
  assert.deepEqual(sessionContextUpdate(base, () => 1), update(0));
  const fixture = { ...base, systemPrompt: 'not sent', agent: { state: { tools: [] } }, sessionManager: { buildSessionProjection: () => ({ messages: [] }) } };
  assert.deepEqual(sessionContextUpdate(fixture, () => 10), update(0));
  fixture.sessionManager.buildSessionProjection = () => ({ messages: [{ role: 'system', content: 'sent' }] });
  assert.deepEqual(sessionContextUpdate(fixture, () => { throw Error('display estimator failed'); }), update(0));
  assert.deepEqual(sessionContextUpdate(fixture, () => NaN), update(0));
});
