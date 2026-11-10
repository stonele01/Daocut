import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordProblem, problemsFile } from '../../src/problems.mjs';
import { diagnosticsName, exportDiagnostics, feedbackDiagnostics, turnLogForFile } from './diagnostics.mjs';

const TURN = [
  { t: 1, kind: 'prompt', agent: 'codex', text: 'make my secret film', meta: { model: '6.1 Sol' }, session: { agentInfo: { name: 'codex-acp', version: '1.13.1' } }, opened: { program: '/x/codex', adapter: '@agentclientprotocol/codex-acp' } },
  { t: 2, kind: 'sent', prompt: [{ type: 'text', text: 'make my secret film' }] },
  { t: 3, kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a reply about the secret' } } },
  { t: 4, kind: 'update', update: { sessionUpdate: 'notice', severity: 'warning', title: 'Reconnecting... 2/5' } },
  { t: 4.1, kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: "List files in 'secret'", name: 'exec_command', kind: 'read', status: 'in_progress', rawInput: { command: 'ls secret' } } },
  { t: 4.2, kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed', name: 'exec_command', rawOutput: { formatted_output: 'secret.txt', exit_code: 2 } } },
  { t: 4.3, kind: 'permission', params: { toolCall: { title: 'Delete secret' } } },
  { t: 4.4, kind: 'question', message: 'Which secret?' },
  { t: 5, kind: 'done', ok: false, error: 'Codex stopped while answering without saying why.' },
].map((e) => JSON.stringify(e)).join('\n');

test("a turn's log goes in as how it went, without what was said unless asked", () => {
  const kept = turnLogForFile(TURN, false);
  assert.doesNotMatch(kept, /secret/);
  assert.match(kept, /Reconnecting\.\.\. 2\/5/);
  assert.match(kept, /without saying why/);
  const prompt = JSON.parse(kept.split('\n')[0]);
  assert.deepEqual([prompt.kind, prompt.model, prompt.program, prompt.words], ['prompt', '6.1 Sol', '/x/codex', '(left out)']);
  const steps = kept.split('\n').map((l) => JSON.parse(l)).filter((e) => e.update?.toolCallId);
  assert.deepEqual(steps.map((e) => e.update), [
    { sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'exec_command', kind: 'read', status: 'in_progress' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', name: 'exec_command', status: 'failed', exitCode: 2 },
  ]);
  assert.match(kept, /"kind":"permission","words":"\(left out\)"/);
  assert.equal(turnLogForFile(TURN, true), TURN);
});

test('feedback diagnostics excludes conversation by default and bounds opted-in details', () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-feedback-'));
  const home = join(root, 'home');
  const dir = join(root, 'project', '.film', 'logs');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'turn.jsonl');
  writeFileSync(log, TURN + '\n' + JSON.stringify({ kind: 'sent', prompt: 'api_key=sk-syntheticSecret0123456789012345' }));
  const now = new Date();
  recordProblem({ area: 'agent', what: 'Connection error', project: 'private project', log }, { file: problemsFile(home), now });
  const basic = feedbackDiagnostics({ home, now }).details;
  assert.match(basic, /Connection error/);
  assert.doesNotMatch(basic, /secret film|private project|syntheticSecret/);
  const detailed = feedbackDiagnostics({ home, now, conversations: true }).details;
  assert.match(detailed, /make my secret film/);
  assert.doesNotMatch(detailed, /syntheticSecret/);
  writeFileSync(log, JSON.stringify({ kind: 'sent', prompt: '长'.repeat(150000) }));
  const bounded = feedbackDiagnostics({ home, now, conversations: true }).details;
  assert.ok(Buffer.byteLength(bounded) <= 256 * 1024);
  assert.match(bounded, /已截短/);
});

test('the diagnostic file: the report, the problems, the logs, the failed turns, and Codex\'s own log around its problem', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-diagnostics-'));
  const home = join(root, 'home');
  const appLogs = join(root, 'app-logs');
  const project = join(root, 'Film');
  const codexHome = join(root, 'codex');
  for (const dir of [join(home, 'logs'), appLogs, join(project, '.film', 'logs'), codexHome]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, 'logs', 'studio.log'), 'listening\nexport failed: no codec\n');
  writeFileSync(join(appLogs, 'updates.log'), '{"status":"current"}\n');
  const log = join(project, '.film', 'logs', 'local-abc.jsonl');
  writeFileSync(log, TURN);
  const at = new Date('2026-10-18T13:13:15Z');
  recordProblem({ area: 'agent', agent: 'Codex', agentId: 'codex', step: 'session/prompt', what: 'Codex stopped while answering without saying why.', project, log, ownLogs: codexHome }, { file: problemsFile(home), now: at });

  /* Codex's log database, as Codex keeps it */
  let sqlite = null;
  try { sqlite = await import('node:sqlite'); } catch { /* a Node without it: that part is left out */ }
  if (sqlite) {
    const db = new sqlite.DatabaseSync(join(codexHome, 'logs_2.sqlite'));
    db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT)');
    const add = db.prepare('INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body) VALUES (?, 0, ?, ?, ?)');
    const s = Math.floor(at.getTime() / 1000);
    add.run(s - 10, 'ERROR', 'codex_models_manager', 'failed to refresh available models: request timed out');
    add.run(s - 5, 'INFO', 'codex_http_client', 'using system root certificates');
    add.run(s - 3600, 'ERROR', 'codex_core', 'an hour before');
    db.close();
  }

  const made = await exportDiagnostics({ report: 'Daocut doctor\n✓ Node', folder: join(root, 'out'), home, appLogs, now: new Date('2026-10-18T14:00:00Z') });
  assert.equal(made.path, join(root, 'out', diagnosticsName(new Date('2026-10-18T14:00:00Z'))));
  assert.deepEqual(made.files.filter((f) => f !== 'agents/codex.txt'), ['report.txt', 'problems.jsonl', 'logs/studio/studio.log', 'logs/app/updates.log', 'turns/local-abc.jsonl']);
  const zip = readFileSync(made.path).toString('utf8');
  assert.match(zip, /Daocut doctor/);
  assert.match(zip, /export failed: no codec/);
  assert.match(zip, /Reconnecting\.\.\. 2\/5/);
  assert.doesNotMatch(zip, /secret/, 'no words of the turn');
  if (sqlite) {
    assert.ok(made.files.includes('agents/codex.txt'));
    assert.match(zip, /request timed out/);
    assert.doesNotMatch(zip, /system root certificates|an hour before/, 'only warnings and errors, around the problem');
  }
});


test('feedback strips old inline image bytes before budgeting and keeps the final failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-feedback-image-'));
  const home = join(root, 'home'); const log = join(root, 'turn.jsonl'); const now = new Date();
  const events = [
    { t: 1, kind: 'prompt', agent: 'own', text: 'Keep the agreed offer conditions', meta: { model: 'deepseek' } },
    { t: 2, kind: 'sent', prompt: [{ type: 'text', text: 'Cut to the requested duration' }] },
    ...Array.from({ length: 85 }, (_, i) => ({ t: i + 3, kind: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking ' } } })),
    { t: 90, kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'read-1', name: 'read', status: 'in_progress', rawInput: { path: 'frame.png' } } },
    { t: 91, kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(250723) }] } },
    { t: 92, kind: 'done', ok: false, error: 'ACP connection closed' },
    { t: 93, kind: 'exit', code: 1, signal: null },
  ];
  writeFileSync(log, events.map((event) => JSON.stringify(event)).join('\n'));
  recordProblem({ area: 'agent', what: 'ACP connection closed', log }, { file: problemsFile(home), now });
  const details = feedbackDiagnostics({ home, now, conversations: true }).details;
  assert.ok(Buffer.byteLength(details) <= 256 * 1024);
  assert.doesNotMatch(details, /A{100}/, 'inline media must not consume the feedback budget');
  assert.match(details, /Keep the agreed offer conditions/);
  assert.match(details, /Cut to the requested duration/);
  const rows = details.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  assert.ok(rows.some((row) => row.kind === 'done' && row.error === 'ACP connection closed'));
  assert.ok(rows.some((row) => row.kind === 'exit' && row.code === 1));
  assert.ok(rows.some((row) => row.update?.toolCallId === 'read-1' && row.update?.status === 'completed'));
  assert.equal(rows.filter((row) => row.update?.sessionUpdate === 'agent_thought_chunk').length, 1, 'adjacent stream chunks should be one timed event');
  const basic = feedbackDiagnostics({ home, now }).details;
  assert.doesNotMatch(basic, /offer conditions|requested duration|thinking|frame.png/);
  assert.match(basic, /ACP connection closed/);
});

test('bounded feedback keeps the starts and ends of all five recent failed turns', () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-feedback-many-'));
  const home = join(root, 'home'); const now = new Date();
  for (let turn = 0; turn < 5; turn++) {
    const log = join(root, 'turn-' + turn + '.jsonl');
    const entries = [{ t: 1, kind: 'prompt', text: 'Requirement-' + turn },
      ...Array.from({ length: 1000 }, (_, i) => ({ t: i + 2, kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-' + i, status: 'completed', rawOutput: '长'.repeat(2000) } })),
      { t: 1005, kind: 'done', ok: false, error: 'Final failure-' + turn }];
    writeFileSync(log, entries.map((entry) => JSON.stringify(entry)).join('\n'));
    recordProblem({ area: 'agent', what: 'Failure-' + turn, log }, { file: problemsFile(home), now });
  }
  const details = feedbackDiagnostics({ home, now, conversations: true }).details;
  assert.ok(Buffer.byteLength(details) <= 256 * 1024);
  assert.doesNotMatch(details, /\uFFFD/);
  assert.match(details, /已截短/);
  for (let turn = 0; turn < 5; turn++) {
    assert.match(details, new RegExp('Requirement-' + turn));
    assert.match(details, new RegExp('Final failure-' + turn));
  }
  for (const line of details.split('\n').filter((line) => line.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(line));
});


test('feedback media variants and partial final lines keep valid redacted JSON and Unicode', () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-feedback-unicode-'));
  const home = join(root, 'home'); const log = join(root, 'turn.jsonl'); const now = new Date();
  const binary = 'Q'.repeat(200000);
  const entries = [
    { t: 1, kind: 'prompt', text: '起点😀' + '中😀'.repeat(10000) + '保留尾部条件😀' },
    { t: 2, kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'media', status: 'completed', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: binary } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + binary } },
      { type: 'resource', resource: { mimeType: 'image/png', blob: binary } },
      { type: 'image', file: '.film/logs/images/local-reference.png', mimeType: 'image/png' },
    ] } },
    { t: 3, kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' + '😀'.repeat(3000) } } },
    { t: 4, kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '末尾😀' } } },
    { t: 5, kind: 'done', ok: false, error: 'Final error api_key=sk-syntheticFeedbackSecret0123456789' },
  ];
  writeFileSync(log, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n{"t":6,"kind":"update"');
  recordProblem({ area: 'agent', what: 'Unicode failure', log }, { file: problemsFile(home), now });
  const details = feedbackDiagnostics({ home, now, conversations: true }).details;
  assert.ok(Buffer.byteLength(details) <= 256 * 1024);
  assert.doesNotMatch(details, /Q{100}|syntheticFeedbackSecret|\uFFFD/);
  assert.match(details, /起点😀/); assert.match(details, /保留尾部条件😀/); assert.match(details, /Final error/);
  assert.match(details, /已截短/);
  const rows = details.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const messages = rows.filter((row) => row.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(messages.length, 1); assert.equal(messages[0].chunks, 2); assert.equal(messages[0].through, 4);
  assert.equal(messages[0].update.content.text.isWellFormed(), true);
  assert.match(details, /local-reference\.png/);
  const basic = feedbackDiagnostics({ home, now }).details;
  assert.doesNotMatch(basic, /起点|尾部条件|local-reference|media_type|末尾/);
});


test('many older problems cannot crowd the newest failed turn out of feedback', () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-feedback-problems-'));
  const home = join(root, 'home'); const log = join(root, 'turn.jsonl'); const now = new Date();
  const problems = Array.from({ length: 500 }, (_, index) => ({ t: new Date(now.getTime() - 500 + index).toISOString(), area: 'agent', what: 'Earlier ' + '诊断'.repeat(900), log }));
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(problemsFile(home), problems.map((entry) => JSON.stringify(entry)).join('\n'));
  writeFileSync(log, JSON.stringify({ t: 1, kind: 'prompt', text: 'Newest requirement' }) + '\n' + JSON.stringify({ t: 2, kind: 'done', error: 'Newest failure', ok: false }));
  const details = feedbackDiagnostics({ home, now, conversations: true }).details;
  assert.ok(Buffer.byteLength(details) <= 256 * 1024);
  assert.match(details, /Newest requirement/); assert.match(details, /Newest failure/);
  assert.match(details, /较早问题已截短/);
  for (const line of details.split('\n').filter((line) => line.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(line));
});
