import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { readLogImage } from 'daocut/log-images';
import { compactionEvidenceExtension, installCompactionRecovery } from './pi-compaction.mjs';
import { modelsJson } from './pi-config.mjs';

// Real SDK and disk-backed synthetic sessions; no transport, user project, model API or real credential.
const tempRoot = resolve(import.meta.dirname, '../../../.tmp/pi-compaction-retention');
mkdirSync(tempRoot, { recursive: true });
const oldRequirement = '最初要求：只剪原声，不加花字。每条 30–50 秒，分别成片，不要串在一个视频。';
const correction = '最新纠正：现在加高级 MG；只限绿区 A=(0,0,1160,240)、B=(24,1087,651,1748)，阴影和全部进退场也不得越界，不裁切原画腾位置。';
const finalCorrection = '再次纠正：取消顶部区域 A 的标题，只保留区域 B；其余价格条件、原画和分片要求不变。';
const condition = '唯一尾部成交条件：付款 189；确认收货之后返 10，到手 179；仅限打“谢谢主播”的人，280 双，1 号链接。';
const longToolText = 'SYNTHETIC ASR background cue. '.repeat(3600) + '\n' + condition;
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhGQAAAAASUVORK5CYII=', 'base64');
const usage = { input: 2000, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 2040, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text, stopReason = 'stop', over = {}) => ({ role: 'assistant', content: [{ type: 'text', text }],
  api: 'openai-completions', provider: 'byok-retention-thinking', model: 'retention', usage, stopReason, timestamp: Date.now(), ...over });
const user = (text, timestamp) => ({ role: 'user', content: text, timestamp });
const tools = (manager, id, body, timestamp, extra = {}) => {
  manager.appendMessage(assistant('', 'toolUse', { timestamp, content: [{ type: 'toolCall', id, name: 'read', arguments: { path: id + '.txt' } }] }));
  return manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: body }],
    details: { source: 'synthetic', ...extra }, isError: false, timestamp: timestamp + 1 });
};
const history = manager => structuredClone(manager.getEntries().filter(e => e.type === 'message'));
const checkpoints = manager => manager.getEntries().filter(e => e.type === 'compaction');
const occurrences = (value, part) => value.split(part).length - 1;

function verifyToolPairs(messages) {
  const calls = messages.flatMap(m => m.role === 'assistant' && Array.isArray(m.content)
    ? m.content.filter(b => b.type === 'toolCall').map(b => b.id) : []);
  const results = messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId);
  assert.ok(calls.length > 0, 'recent tool history must really survive');
  assert.deepEqual(calls, results, 'recent tools have neither orphan results nor missing results');
}

async function fixture(produce = () => assistant('Current-state narrative deliberately omits the source facts.'), { onPreparation } = {}) {
  const home = mkdtempSync(join(tempRoot, 'retention-'));
  const project = join(home, 'project'), agentHome = join(home, 'agent'), sessions = join(home, 'sessions');
  for (const folder of [project, agentHome, sessions]) mkdirSync(folder);
  const own = { id: 'retention', name: 'retention', api: 'openai-completions', model: 'retention', baseUrl: 'http://127.0.0.1:1/v1',
    keyEnv: 'DAOCUT_RETENTION_SYNTHETIC_UNUSED', levels: ['low', 'max'], effort: 'max', context: 128000, maxOutputTokens: 32000 };
  const modelsPath = join(agentHome, 'models.json');
  writeFileSync(modelsPath, JSON.stringify(modelsJson([own])));
  const runtime = await ModelRuntime.create({ authPath: join(agentHome, 'auth.json'), modelsPath, refreshOnCreate: false });
  const model = runtime.getModel('byok-retention-thinking', 'retention');
  const settings = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: false } });
  assert.equal(settings.getCompactionKeepRecentTokens(model), 20000, 'use the SDK default recent-history budget');
  const manager = SessionManager.create(project, sessions);
  manager.appendMessage(user(oldRequirement, 1));
  const oldToolId = tools(manager, 'older-asr', longToolText, 2, { exactAsset: 'assets/live.mp4', sourceRange: [363.85, 373.19], filmRange: [28.14, 37.48] });
  manager.appendMessage(assistant('Old route built, not proof it matches the delivery request.', 'stop', { timestamp: 4 }));
  const correctedUserId = manager.appendMessage({ role: 'user', content: [{ type: 'text', text: correction },
    { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }], timestamp: 5 });
  tools(manager, 'recent-a', 'Recent timing data A; '.repeat(2000), 6);
  manager.appendMessage(assistant('Timing A parsed.', 'stop', { timestamp: 8 }));
  manager.appendMessage(user('继续现有任务；素材 assets/live.mp4，复用 assets/live.vtt，源时间与成片时间不能混淆。', 9));
  tools(manager, 'recent-b', 'Recent timing data B; '.repeat(2000), 10);
  manager.appendMessage(assistant('Recent raw result remains available.', 'stop', { timestamp: 12 }));
  const loader = new DefaultResourceLoader({ cwd: project, agentDir: agentHome, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      ...(onPreparation ? [{ name: 'observe-native-cut', factory: pi => pi.on('session_before_compact', ({ preparation }) => { onPreparation(structuredClone(preparation)); }) }] : []),
      { name: 'test-evidence', factory: compactionEvidenceExtension },
    ],
    systemPromptOverride: () => 'Synthetic retention test only.', agentsFilesOverride: () => ({ agentsFiles: [] }) });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: project, agentDir: agentHome, modelRuntime: runtime, model, thinkingLevel: 'max',
    resourceLoader: loader, sessionManager: manager, settingsManager: settings, tools: [] });
  const calls = [], events = [];
  session.agent.streamFunction = (sentModel, context, options) => {
    const request = { model: sentModel, context, options };
    calls.push(request);
    return { result: async () => produce(request, calls.length, session) };
  };
  installCompactionRecovery(session, { cwd: project });
  session.subscribe(event => events.push(event));
  return { home, project, manager, session, calls, events, oldToolId, correctedUserId };
}

function indexFrom(summary) {
  const matches = [...summary.matchAll(/原文索引: <([^>]+)>/g)];
  assert.equal(matches.length, 1, 'one authoritative retrieval index per checkpoint');
  return matches[0][1];
}
function evidenceFrom(summary) {
  const index = readFileSync(indexFrom(summary), 'utf8');
  const paths = [...index.matchAll(/原文: <([^>]+)>/g)].map(m => m[1]);
  assert.ok(paths.length > 0, 'index must link readable entry files');
  return { index, entries: paths.map(path => {
    const document = readFileSync(path, 'utf8');
    const json = /```json\n([\s\S]*?)\n```/.exec(document);
    assert.ok(json, 'entry contains machine-readable untruncated source');
    return { path, record: JSON.parse(json[1]) };
  }) };
}

// The generated summary deliberately drops facts; this test proves the mechanical layer, not model judgment.
test('native compaction keeps recent messages and tool pairs; original corrections, long tool tails and image bytes remain recoverable', async () => {
  const f = await fixture();
  try {
    const before = history(f.manager);
    const result = await f.session.compact();
    assert.deepEqual(history(f.manager), before, 'original messages remain byte-for-byte equivalent');
    assert.equal(checkpoints(f.manager).length, 1);
    for (const requirement of [oldRequirement, correction]) assert.equal(occurrences(result.summary, requirement), 1, 'each actual user statement appears verbatim once');
    assert.ok(result.summary.indexOf(oldRequirement) < result.summary.indexOf(correction), 'corrections retain chronological order');
    assert.match(result.summary, /纠正或取消会替代此前对应要求/);
    const retained = f.manager.buildSessionProjection().messages;
    verifyToolPairs(retained);
    assert.ok(retained.some(m => m.role === 'toolResult' && m.toolCallId === 'recent-b'), 'latest tool result stays raw in the active context');
    const originalRecent = before.find(e => e.message.role === 'toolResult' && e.message.toolCallId === 'recent-b').message;
    assert.deepEqual(retained.find(m => m.role === 'toolResult' && m.toolCallId === 'recent-b'), originalRecent);
    const evidence = evidenceFrom(result.summary);
    const archivedTool = evidence.entries.find(e => e.record.entryId === f.oldToolId).record.message;
    assert.equal(archivedTool.content[0].text, longToolText, 'retrieve the condition beyond the SDK 2000-character tool excerpt');
    assert.ok(archivedTool.content[0].text.indexOf(condition) > 2000);
    assert.deepEqual(archivedTool.details, { source: 'synthetic', exactAsset: 'assets/live.mp4', sourceRange: [363.85, 373.19], filmRange: [28.14, 37.48] });
    const archivedUser = evidence.entries.find(e => e.record.entryId === f.correctedUserId).record.message;
    const picture = archivedUser.content.find(b => b.type === 'image');
    assert.equal(picture.data, undefined, 'archive uses a local image reference');
    const recovered = readLogImage(f.project, picture.file);
    assert.ok(recovered);
    assert.deepEqual(recovered.data, image, 'referenced image preserves exact original bytes');
    assert.equal(recovered.mimeType, 'image/png');
    assert.ok(f.calls.every(c => !JSON.stringify(c.context).includes(image.toString('base64'))), 'summary evidence does not re-upload image bytes');
    const reopened = SessionManager.open(f.manager.getSessionFile());
    assert.deepEqual(history(reopened), before, 'persistent raw history also survives reopen');
    assert.equal(checkpoints(reopened).at(-1).summary, result.summary);
  } finally { f.session.dispose(); }
});

test('two consecutive native compactions keep one evidence block, add the new correction, and reuse immutable old entries', async () => {
  const f = await fixture();
  try {
    const first = await f.session.compact();
    const evidence = evidenceFrom(first.summary);
    const originalEntryPaths = new Set(evidence.entries.map(e => e.path));
    const firstCheckpoint = structuredClone(checkpoints(f.manager)[0]);
    f.manager.appendMessage(user(finalCorrection, 20));
    tools(f.manager, 'later-local-change', 'New affected-span result; '.repeat(2500), 21);
    f.manager.appendMessage(assistant('One new local change is pending validation.', 'stop', { timestamp: 23 }));
    // SessionManager is the SDK persistence boundary; mirror its appended turn into the live agent before continuing.
    await f.session.navigateTree(f.manager.getLeafId(), { summarize: false });
    const beforeSecond = history(f.manager);
    const second = await f.session.compact();
    assert.deepEqual(history(f.manager), beforeSecond);
    assert.deepEqual(checkpoints(f.manager)[0], firstCheckpoint, 'old checkpoint is immutable');
    assert.equal(checkpoints(f.manager).length, 2);
    const next = evidenceFrom(second.summary);
    for (const requirement of [oldRequirement, correction, finalCorrection]) assert.equal(occurrences(second.summary, requirement), 1, 'no recursive evidence duplication');
    assert.ok(second.summary.indexOf(correction) < second.summary.indexOf(finalCorrection));
    for (const oldPath of originalEntryPaths) assert.ok(next.entries.some(e => e.path === oldPath), 'unchanged archived entries reuse the same path');
    assert.equal(next.entries.length, beforeSecond.length, 'index retains raw messages, not recursive checkpoint copies');
    const documents = readdirSync(join(f.project, '.film', 'chat', 'context', f.manager.getSessionId())).filter(n => n.startsWith('entry-'));
    assert.equal(documents.length, beforeSecond.length, 'repeat compaction creates only new entries, not copies of old evidence');
    verifyToolPairs(f.manager.buildSessionProjection().messages);
    for (const call of f.calls) {
      const request = JSON.stringify(call.context);
      assert.equal(occurrences(request, 'DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN'), 0, 'native summary requests do not receive the mechanical evidence footer');
    }
  } finally { f.session.dispose(); }
});

for (const mode of ['empty', 'length', 'abort']) {
  test(`${mode} summary never commits a checkpoint or changes the raw message history`, async () => {
    const f = await fixture((_, __, session) => {
      if (mode === 'abort') { session.abortCompaction(); return assistant('Late answer after cancel.'); }
      return assistant(mode === 'empty' ? '' : 'INCOMPLETE', mode === 'length' ? 'length' : 'stop');
    });
    try {
      const before = history(f.manager);
      await assert.rejects(f.session.compact());
      assert.deepEqual(history(f.manager), before);
      assert.equal(checkpoints(f.manager).length, 0);
      const reopened = SessionManager.open(f.manager.getSessionFile());
      assert.deepEqual(history(reopened), before);
      assert.equal(checkpoints(reopened).length, 0);
      assert.ok(f.calls.length <= 2, 'failed compaction has bounded actual summary attempts');
      assert.equal(f.events.at(-1).type, 'compaction_end');
      if (mode === 'abort') assert.equal(f.events.at(-1).aborted, true);
      verifyToolPairs(f.manager.buildSessionProjection().messages);
    } finally { f.session.dispose(); }
  });
}
// Context edits are an SDK-supported persisted state (the user's failed session also has one).
// Omitting the previous visible tail makes the next cut prefix-only without changing any raw message.
test('prefix-only native compactions make zero history requests, keep one footer repeatedly, and preserve the prior checkpoint on failure', async () => {
  const preparations = [];
  let fail = false;
  const f = await fixture(() => assistant(fail ? '' : 'Complete concise native checkpoint.'), {
    onPreparation: preparation => preparations.push(preparation),
  });
  try {
    await f.session.compact();
    assert.equal(checkpoints(f.manager).length, 1, 'start from a real persisted native checkpoint with a footer');
    const firstCheckpoint = structuredClone(checkpoints(f.manager)[0]);
    assert.equal(occurrences(firstCheckpoint.summary, 'DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN'), 1);
    const preparePrefixOnlyTurn = async n => {
      const visible = f.manager.buildSessionProjection().entries.filter(e => e.sourceEntry.type === 'message' && e.messages.length);
      for (const e of visible) f.manager.appendContextEdit(e.sourceEntry.id, null);
      f.manager.appendMessage(user(`第 ${n} 次局部任务：继续保留成交条件，只修改已批准的区域。`, 100 + n * 4));
      tools(f.manager, 'prefix-only-' + n, 'Earlier prefix tool evidence. '.repeat(1200), 101 + n * 4);
      // A large recent assistant message places the native default-20K cut inside this turn.
      f.manager.appendMessage(assistant('Keep this later ongoing-turn content raw. '.repeat(2100), 'stop', { timestamp: 103 + n * 4 }));
      await f.session.navigateTree(f.manager.getLeafId(), { summarize: false });
    };
    const assertNativePrefixRequest = (fromCall, fromPreparation) => {
      const p = preparations[fromPreparation];
      assert.ok(p, 'SDK emitted its real preparation event');
      assert.equal(p.isSplitTurn, true);
      assert.equal(p.messagesToSummarize.length, 0, 'zero history messages, so no history-summary request can run');
      assert.ok(p.turnPrefixMessages.length > 0, 'there is a real turn prefix to summarize');
      assert.equal(occurrences(p.previousSummary, 'DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN'), 1, 'the native preparation really started with an old footer');
      const actual = f.calls.slice(fromCall);
      const prefixCalls = actual.filter(c => JSON.stringify(c.context).includes('# Conversation\\n'));
      assert.equal(actual.length, 1, 'exactly one actual model invocation');
      assert.equal(prefixCalls.length, 1, 'that invocation is the SDK turn-prefix request');
      assert.equal(actual.length - prefixCalls.length, 0, 'history-summary model invocations = 0');
    };
    for (const n of [1, 2]) {
      await preparePrefixOnlyTurn(n);
      const rawBefore = history(f.manager), callStart = f.calls.length, prepStart = preparations.length;
      const previousCheckpoint = structuredClone(checkpoints(f.manager).at(-1));
      const result = await f.session.compact();
      assertNativePrefixRequest(callStart, prepStart);
      assert.deepEqual(history(f.manager), rawBefore);
      assert.deepEqual(checkpoints(f.manager).at(-2), previousCheckpoint, 'old stored summary is not rewritten by the stripping hook');
      assert.equal(occurrences(result.summary, 'DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN'), 1, 'carried history plus new prefix has one mechanical block');
      assert.equal(occurrences(result.summary, oldRequirement), 1);
      assert.equal(occurrences(result.summary, correction), 1);
      evidenceFrom(result.summary);
    }
    assert.deepEqual(checkpoints(f.manager)[0], firstCheckpoint);
    await preparePrefixOnlyTurn(3);
    fail = true;
    const entriesBeforeFailure = structuredClone(f.manager.getEntries());
    const checkpointBeforeFailure = structuredClone(checkpoints(f.manager).at(-1));
    const callStart = f.calls.length, prepStart = preparations.length;
    await assert.rejects(f.session.compact(), /empty checkpoint/);
    assertNativePrefixRequest(callStart, prepStart);
    assert.deepEqual(f.manager.getEntries(), entriesBeforeFailure, 'failed prefix compaction commits no metadata or message edits');
    assert.deepEqual(checkpoints(f.manager).at(-1), checkpointBeforeFailure);
    const reopened = SessionManager.open(f.manager.getSessionFile());
    assert.deepEqual(reopened.getEntries(), entriesBeforeFailure, 'failure and old footer are safe after disk reopen');
  } finally { f.session.dispose(); }
});