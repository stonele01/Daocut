import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { compactionEvidenceExtension, installCompactionRecovery } from './pi-compaction.mjs';
import { modelsJson } from './pi-config.mjs';

const testRoot = fileURLToPath(new URL('../../../.release/tests/compaction-prompts/', import.meta.url));
mkdirSync(testRoot, { recursive: true });

const usage = (input = 300, output = 10) => ({ input, output, cacheRead: 50, cacheWrite: 25, totalTokens: input + output + 75, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (text = 'Completed checkpoint', stopReason = 'stop', over = {}) => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'byok-fixture-thinking', model: 'fixture',
  usage: usage(), stopReason, timestamp: Date.now(), ...over,
});

async function fixture(produce, { maxOutputTokens = 32000, context = 128000, keepRecentTokens = 90, api = 'openai-completions', baseUrl = 'http://127.0.0.1:1/v1', useNative = false, archiveEvidence = false, installRecovery = installCompactionRecovery } = {}) {
  const home = mkdtempSync(join(testRoot, 'daocut-compaction-'));
  const own = { id: 'fixture', name: 'fixture', api, model: 'fixture', baseUrl, keyEnv: 'DAOCUT_SYNTHETIC_UNUSED',
    levels: ['low', 'max'], effort: 'max', context, maxOutputTokens };
  const modelsPath = join(home, 'models.json');
  writeFileSync(modelsPath, JSON.stringify(modelsJson([own])));
  const runtime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath, refreshOnCreate: false });
  if (useNative) await runtime.setRuntimeApiKey('byok-fixture-thinking', 'synthetic-loopback-only');
  const model = runtime.getModel('byok-fixture-thinking', 'fixture');
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
  const manager = SessionManager.inMemory(home);
  manager.appendMessage({ role: 'user', content: 'Edit product A from 00:05.120 to 00:21.450; keep subtitles, no music. ' + 'Older checked context. '.repeat(100), timestamp: 1 });
  manager.appendMessage(assistant('Approved plan and exact asset path D:/assets/product-a.mp4', 'stop', { timestamp: 2 }));
  manager.appendMessage({ role: 'user', content: 'Continue the recent approved edit. ' + 'Recent task. '.repeat(25), timestamp: 3 });
  manager.appendMessage(assistant('', 'toolUse', { timestamp: 4, content: [{ type: 'toolCall', id: 'recent-read', name: 'read', arguments: { path: 'film.html' } }] }));
  manager.appendMessage({ role: 'toolResult', toolCallId: 'recent-read', toolName: 'read', content: [{ type: 'text', text: 'Recent timeline source. '.repeat(8) }], isError: false, timestamp: 5 });
  manager.appendMessage(assistant('Waiting for the next approved step.', 'stop', { timestamp: 6 }));
  const loader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: 'test-compaction-evidence', factory: compactionEvidenceExtension }],
    systemPromptOverride: () => 'Synthetic test only', agentsFilesOverride: () => ({ agentsFiles: [] }) });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: home, agentDir: home, modelRuntime: runtime, model, thinkingLevel: 'max', resourceLoader: loader, sessionManager: manager, settingsManager, tools: [] });
  const calls = [], logged = [], events = [];
  const nativeStream = session.agent.streamFunction;
  session.agent.streamFunction = (sentModel, sentContext, options) => {
    const call = { model: sentModel, context: sentContext, options };
    calls.push(call);
    return useNative ? nativeStream(sentModel, sentContext, options) : { result: async () => produce(call, calls.length, session) };
  };
  installRecovery(session, { cwd: archiveEvidence ? home : undefined, onCall: (call) => logged.push(call) });
  session.subscribe((event) => events.push(event));
  return { session, manager, model, calls, logged, events };
}

function rawHistory(manager) { return structuredClone(manager.getEntries().filter((e) => e.type === 'message')); }
function toolPairs(messages) {
  const calls = messages.flatMap((m) => m.role === 'assistant' ? m.content.filter((b) => b.type === 'toolCall').map((b) => b.id) : []);
  const results = messages.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId);
  assert.deepEqual(calls, results, 'retained tool calls and results stay together');
}

test('real SDK keeps native prompts, source and recent messages and tool pairs; summary alone uses lowest supported effort', async () => {
  const f = await fixture(() => assistant());
  try {
    const before = rawHistory(f.manager);
    const result = await f.session.compact();
    assert.ok(result.summary.includes('Completed checkpoint'));
    assert.deepEqual(rawHistory(f.manager), before, 'original history is append-only');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.maxTokens, 13107, 'Pi native history budget');
    assert.equal(f.calls[0].options.reasoning, 'low');
    assert.equal(f.session.thinkingLevel, 'max');
    assert.match(JSON.stringify(f.calls[0].context), /00:05.120.*00:21.450/);
    assert.match(JSON.stringify(f.calls[0].context), /## Goal/);
    assert.equal(f.logged.length, 1);
    const retained = f.manager.buildSessionProjection().messages;
    assert.ok(retained.some((m) => m.role === 'toolResult' && m.toolCallId === 'recent-read'));
    toolPairs(retained);
    assert.deepEqual(f.events.filter((e) => e.type.startsWith('compaction_')).map((e) => e.type), ['compaction_start', 'compaction_end']);
    await f.session.agent.streamFunction(f.model, { messages: [] }, { reasoning: 'max' }).result();
    assert.equal(f.calls.at(-1).options.reasoning, 'max', 'ordinary requests pass through after compaction');
  } finally { f.session.dispose(); }
});

test('length summary is never committed; retry raises only summary cap and logs each actual usage', async () => {
  const f = await fixture((_, n) => assistant(n === 1 ? 'INCOMPLETE CHECKPOINT' : 'Full summary with all editing constraints', n === 1 ? 'length' : 'stop'));
  try {
    const before = rawHistory(f.manager);
    const result = await f.session.compact();
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.map((c) => c.options.maxTokens), [13107, 26214]);
    assert.deepEqual(f.calls.map((c) => c.options.reasoning), ['low', 'low']);
    assert.equal(f.calls[0].context, f.calls[1].context, 'retry preserves the entire native summarization input by identity');
    assert.equal(result.summary.includes('INCOMPLETE'), false);
    assert.equal(f.manager.getEntries().filter((e) => e.type === 'compaction').length, 1);
    assert.deepEqual(rawHistory(f.manager), before);
    assert.equal(f.logged.length, 2);
    assert.deepEqual(f.logged.map((c) => c.response.stopReason), ['length', 'stop']);
    assert.equal(result.usage.output, 20, 'checkpoint usage includes both billed attempts');
    assert.equal(f.model.maxTokens, 32000);
    assert.equal(f.model.contextWindow, 128000);
    toolPairs(f.manager.buildSessionProjection().messages);
  } finally { f.session.dispose(); }
});

for (const [label, response, over, expectedCalls] of [
  ['second length', () => assistant('Partial', 'length'), {}, 2],
  ['hard output cap', () => assistant('Partial', 'length'), { maxOutputTokens: 8000 }, 2],
  ['missing usage', () => assistant('Partial', 'length', { usage: undefined }), {}, 1],
  ['no context headroom', () => assistant('Partial', 'length', { usage: usage(120000) }), {}, 1],
  ['empty checkpoint', () => assistant(''), {}, 1],
  ['provider error', () => assistant('', 'error', { errorMessage: '400 invalid fixture request' }), {}, 1],
]) {
  test(`${label} leaves original history and no incomplete checkpoint`, async () => {
    const f = await fixture(response, over);
    try {
      const before = rawHistory(f.manager);
      await assert.rejects(f.session.compact(), /Summarization failed/);
      assert.equal(f.calls.length, expectedCalls);
      assert.deepEqual(rawHistory(f.manager), before);
      assert.equal(f.manager.getEntries().some((e) => e.type === 'compaction'), false);
      toolPairs(f.manager.buildSessionProjection().messages);
      assert.equal(f.events.at(-1).type, 'compaction_end');
      assert.ok(f.events.at(-1).errorMessage);
    } finally { f.session.dispose(); }
  });
}

test('cancellation between attempts preserves history and never starts a recovery request', async () => {
  const f = await fixture((_, __, session) => { session.abortCompaction(); return assistant('Partial', 'length'); });
  try {
    const before = rawHistory(f.manager);
    await assert.rejects(f.session.compact());
    assert.equal(f.calls.length, 1);
    assert.deepEqual(rawHistory(f.manager), before);
    assert.equal(f.manager.getEntries().some((e) => e.type === 'compaction'), false);
    assert.equal(f.events.at(-1).aborted, true);
  } finally { f.session.dispose(); }
});

test('native transient retry and output-cap recovery share one extra request', async () => {
  const f = await fixture((_, n) => n === 1 ? assistant('', 'error', { errorMessage: 'terminated' }) : assistant('Partial', 'length'));
  try {
    await assert.rejects(f.session.compact(), /token cap/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.logged.length, 2);
    assert.equal(f.manager.getEntries().some((e) => e.type === 'compaction'), false);
  } finally { f.session.dispose(); }
});

test('split-turn history and prefix summaries share one retry, without committing either partial checkpoint', async () => {
  const f = await fixture((_, n) => assistant(n === 2 ? 'Full history' : 'Partial', n === 2 ? 'stop' : 'length'), { keepRecentTokens: 50 });
  try {
    const before = rawHistory(f.manager);
    await assert.rejects(f.session.compact(), /token cap/);
    assert.equal(f.calls.length, 3, 'history, one recovery, prefix; no second recovery');
    assert.deepEqual(f.calls.map((c) => c.options.maxTokens), [13107, 26214, 8192]);
    assert.deepEqual(rawHistory(f.manager), before);
    assert.equal(f.manager.getEntries().some((e) => e.type === 'compaction'), false);
  } finally { f.session.dispose(); }
});

test('enlarged summary remains under both user output cap and provider-reported context headroom', async () => {
  const f = await fixture((_, n) => assistant(n === 1 ? 'Partial' : 'Full checkpoint', n === 1 ? 'length' : 'stop', { usage: usage(110000) }), { maxOutputTokens: 20000 });
  try {
    await f.session.compact();
    assert.deepEqual(f.calls.map((c) => c.options.maxTokens), [13107, 16901]);
    assert.equal(f.model.maxTokens, 20000);
    assert.equal(f.model.contextWindow, 128000);
  } finally { f.session.dispose(); }
});

test('a transient error after length recovery cannot spend a third summary request', async () => {
  const f = await fixture((_, n) => n === 1 ? assistant('Partial', 'length') : assistant('', 'error', { errorMessage: 'terminated' }));
  try {
    await assert.rejects(f.session.compact(), /terminated/);
    assert.equal(f.calls.length, 2);
    assert.equal(f.logged.length, 2, 'native retry does not duplicate a usage record for the cached failure');
    assert.equal(f.manager.getEntries().some((e) => e.type === 'compaction'), false);
  } finally { f.session.dispose(); }
});

test('cancelling the recovery request preserves history even if the service returns complete text', async () => {
  const f = await fixture((_, n, session) => {
    if (n === 1) return assistant('Partial', 'length');
    session.abortCompaction();
    return assistant('Response that arrived after cancellation');
  });
  try {
    const before = rawHistory(f.manager);
    await assert.rejects(f.session.compact());
    assert.equal(f.calls.length, 2);
    assert.deepEqual(rawHistory(f.manager), before);
    assert.equal(f.manager.getEntries().some((e) => e.type === 'compaction'), false);
    assert.equal(f.events.at(-1).aborted, true);
  } finally { f.session.dispose(); }
});


async function loopback() {
  const bodies = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      bodies.push(request);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url.endsWith('/responses')) {
        let sequence = 0;
        const event = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: sequence++, ...data }) + '\n\n';
        const response = { id: 'resp_' + bodies.length, object: 'response', created_at: 0, status: 'in_progress', model: request.model, output: [] };
        const item = { type: 'message', id: 'msg_' + bodies.length, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic current-state checkpoint.', annotations: [] }] };
        res.end(event('response.created', { response })
          + event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
          + event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text })
          + event('response.output_item.done', { output_index: 0, item })
          + event('response.completed', { response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112 } } }));
      } else {
        const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'chat_' + bodies.length, object: 'chat.completion.chunk', created: 0, model: request.model,
          choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } } : {}) }) + '\n\n';
        res.end(chunk({ role: 'assistant', content: 'Synthetic current-state checkpoint.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { bodies, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    close: () => { server.closeAllConnections(); server.close(); } };
}


test('a hard cap permits one same-cap recovery with the original native request, then records both usages', async () => {
  const f = await fixture((_, n) => assistant(n === 1 ? 'Partial' : 'Complete native checkpoint', n === 1 ? 'length' : 'stop'), { maxOutputTokens: 2000 });
  try {
    const before = rawHistory(f.manager);
    const result = await f.session.compact();
    assert.deepEqual(f.calls.map(call => call.options.maxTokens), [2000, 2000]);
    assert.equal(f.calls[0].context, f.calls[1].context, 'recovery sends the same native context object');
    assert.deepEqual(rawHistory(f.manager), before);
    assert.equal(result.usage.output, 20);
    assert.equal(f.manager.getEntries().filter(entry => entry.type === 'compaction').length, 1);
  } finally { f.session.dispose(); }
});

function nativeTemplates() {
  const source = readFileSync(new URL('./core/compaction/compaction.js', import.meta.resolve('@earendil-works/pi-coding-agent')), 'utf8').replace(/\r\n/g, '\n');
  const quote = String.fromCharCode(96);
  const get = name => source.match(new RegExp('const ' + name + ' = ' + quote + '([\\s\\S]*?)' + quote + ';'))[1];
  return {
    history: get('SUMMARIZATION_PROMPT'),
    update: get('UPDATE_SUMMARIZATION_PROMPT').replace('$' + '{UPDATE_SUMMARIZATION_INSTRUCTIONS}', get('UPDATE_SUMMARIZATION_INSTRUCTIONS')),
    prefix: get('TURN_PREFIX_SUMMARIZATION_PROMPT'),
  };
}
const templates = nativeTemplates();
const previousText = 'Native prior checkpoint with exact path D:/working copy/film.html and source times 00:05.120–00:21.450.';

function comparablePayload(body) {
  const copy = structuredClone(body);
  // Pi gives standalone summaries independent routing IDs; they are not prompt, model or budget differences.
  delete copy.prompt_cache_key;
  return copy;
}

for (const api of ['openai-responses', 'openai-completions']) {
  for (const mode of ['history', 'update', 'prefix']) {
    test('safe protection preserves the native ' + api + ' ' + mode + ' payload and ordinary editing', { timeout: 20000 }, async () => {
      const wire = await loopback(), baselineWire = await loopback();
      let f, baseline;
      const seedUpdate = instance => {
        if (mode === 'update') {
          instance.manager.appendCompaction(previousText, instance.manager.getEntries().find(entry => entry.type === 'message').id, 5000);
          instance.manager.appendMessage(assistant('New observation after the previous checkpoint.'));
        }
      };
      try {
        const options = { api, useNative: true, keepRecentTokens: mode === 'prefix' ? 50 : 90 };
        f = await fixture(null, { ...options, baseUrl: wire.baseUrl, archiveEvidence: true });
        // Native Pi at the same low summary effort used by the verified 0.2.16 wrapper.
        baseline = await fixture(null, { ...options, baseUrl: baselineWire.baseUrl, installRecovery: session => session.setThinkingLevel('low') });
        seedUpdate(f); seedUpdate(baseline);
        const before = rawHistory(f.manager);
        const result = await f.session.compact('FOCUS_SENTINEL: retain pending user work.');
        await baseline.session.compact('FOCUS_SENTINEL: retain pending user work.');
        assert.equal(wire.bodies.length, mode === 'prefix' ? 2 : 1);
        assert.deepEqual(wire.bodies.map(comparablePayload), baselineWire.bodies.map(comparablePayload),
          'final provider JSON matches native Pi, including prompt, focus, model, output cap and reasoning');
        const firstText = JSON.stringify(wire.bodies[0]);
        assert.ok(firstText.includes(JSON.stringify(templates[mode === 'prefix' ? 'history' : mode]).slice(1, -1)));
        assert.ok(firstText.includes('FOCUS_SENTINEL'));
        if (mode === 'prefix') assert.ok(JSON.stringify(wire.bodies[1]).includes(JSON.stringify(templates.prefix).slice(1, -1)));
        for (const body of wire.bodies) {
          const serialized = JSON.stringify(body);
          assert.equal(serialized.includes('DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN'), false, 'no evidence footer sent to the summary model');
          assert.equal(serialized.includes('CURRENT-STATE'), false);
          assert.equal(serialized.includes('Outstanding Acceptance Criteria'), false);
          assert.equal(serialized.includes('不可变原文索引'), false, 'no added instruction sent to the summary model');
        }
        assert.equal(result.summary.split('DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN').length - 1, 1, 'one footer appended only after success');
        assert.ok(result.summary.includes('Edit product A from 00:05.120 to 00:21.450; keep subtitles, no music.'));
        assert.deepEqual(rawHistory(f.manager), before);
        toolPairs(f.manager.buildSessionProjection().messages);
        const normalContext = { messages: [{ role: 'system', content: 'Ordinary editing rules.', timestamp: 0 }, { role: 'user', content: [{ type: 'text', text: 'NORMAL_EDIT_SENTINEL' }], timestamp: 1 }] };
        await (await f.session.agent.streamFunction(f.model, normalContext, { reasoning: 'max', maxTokens: 256 })).result();
        const normal = wire.bodies.at(-1);
        assert.match(JSON.stringify(normal), /NORMAL_EDIT_SENTINEL/);
        assert.equal(JSON.stringify(normal).includes('DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN'), false);
        assert.equal(normal.reasoning?.effort ?? normal.reasoning_effort, 'max');
        assert.equal(normal.max_output_tokens ?? normal.max_completion_tokens ?? normal.max_tokens, 256);
        assert.equal(f.calls.at(-1).context, normalContext, 'ordinary request context passes through unchanged');
      } finally { f?.session.dispose(); baseline?.session.dispose(); wire.close(); baselineWire.close(); }
    });
  }
}
