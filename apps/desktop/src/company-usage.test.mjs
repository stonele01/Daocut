import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanyUsageReporter, companyUsageEvent } from './company-usage.mjs';

// All fixtures stay under the checkout on D:, never the user's C: TEMP or real projects.
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../.release/test-company-usage');
const root = (t) => {
  mkdirSync(testRoot, { recursive: true });
  const dir = mkdtempSync(join(testRoot, 'case-'));
  t.after(() => {
    const child = relative(testRoot, resolve(dir));
    assert.ok(child && child !== '..' && !child.startsWith('..' + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};
const usage = (input = 100) => ({ input, output: 20, cacheRead: 300, cacheWrite: 0, reasoning: 10 });
const call = (input = 100) => ({ kind: 'call', startedAt: Date.parse('2026-10-24T02:00:00Z'),
  answer: { model: 'deepseek-flash', usage: usage(input) }, pricing: { currency: 'CNY', input: 1, output: 2, cacheRead: 0.1 } });
const identity = (id = 'employee-a', serverUrl = 'https://company.example') => ({ status: 'signed-in', serverUrl, user: { id } });
const fixture = (t, options = {}) => {
  let current = identity();
  let offline = false;
  const sent = [];
  const server = new Map();
  const logs = new Map();
  const client = {
    state: () => current,
    async submitUsage(body, expected) {
      if (offline) throw new Error('offline');
      assert.equal(expected.userId, current.user?.id);
      assert.equal(expected.serverUrl, current.serverUrl);
      sent.push({ body: structuredClone(body), expected: { ...expected } });
      for (const event of body.events) {
        const key = `${expected.userId}:${event.id}`, previous = server.get(key);
        // The company API accepts idempotent upgrades, but not a stale incomplete
        // receipt replacing an already complete one (company-data.mjs contract).
        if (!previous || Number(event.reported) >= Number(previous.reported) && Number(event.incomplete) <= Number(previous.incomplete)) server.set(key, event);
      }
      return { ok: true };
    },
  };
  const dataDir = root(t);
  const args = { dataDir, client, appVersion: '0.2.13', readTurn: (_project, turnId) => logs.get(turnId), retryMs: 0, lateMs: 0, ...options };
  const reporters = [];
  const make = () => { const r = createCompanyUsageReporter(args); reporters.push(r); return r; };
  t.after(() => reporters.forEach((r) => r.stop()));
  return { dataDir, args, reporter: make(), make, logs, server, sent, setUser: (value) => { current = value; }, setOffline: (value) => { offline = value; } };
};

test('receipt includes token categories once and only reliably priced costs; no private fields leave it', () => {
  const event = companyUsageEvent({ ...call(), messages: [{ text: 'private' }], systemPrompt: 'private', path: 'D:/secret', apiKey: 'secret' },
    { id: 'id', at: '2026-10-24T00:00:00Z', appVersion: '0.2.13' });
  assert.equal(event.total, 420);
  assert.equal(event.reasoning, 10);
  assert.equal(event.reported, true);
  assert.equal(event.incomplete, false);
  assert.ok(Math.abs(event.costs.CNY - 0.00017) < 1e-12);
  assert.deepEqual(Object.keys(event).sort(), ['appVersion', 'at', 'cacheRead', 'cacheWrite', 'costs', 'id', 'incomplete', 'input', 'model', 'output', 'reasoning', 'reported', 'total'].sort());
  const missing = companyUsageEvent({ answer: null }, { id: 'id', at: 'now' });
  assert.equal(missing.total, 0);
  assert.equal(missing.reported, false);
  assert.equal(missing.incomplete, true);
  assert.equal(missing.costs, undefined);
  const partial = companyUsageEvent({ answer: { usage: { input: 10, output: 2 } }, pricing: call().pricing }, { id: 'id', at: 'now' });
  assert.equal(partial.total, 12);
  assert.equal(partial.reported, true);
  assert.equal(partial.incomplete, true);
  assert.equal(partial.costs, undefined);
});

test('offline receipts survive a process restart and are sent once under their captured employee', async (t) => {
  const f = fixture(t, { recoverNativeTurn: async () => { assert.fail('BYOK must not invoke native recovery'); } });
  f.setOffline(true);
  const token = f.reporter.startTurn({ project: join(f.dataDir, 'project'), turnId: 'turn-a', agent: 'byok' });
  f.logs.set('turn-a', { calls: [call()] });
  await f.reporter.finishTurn(token);
  assert.equal(f.reporter.state().pending, 1);
  f.reporter.stop();
  const second = f.make();
  f.setOffline(false);
  await second.flush();
  await second.flush();
  assert.equal(second.state().pending, 0);
  assert.equal(f.server.size, 1);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].expected, { serverUrl: 'https://company.example', userId: 'employee-a' });
  assert.equal(JSON.stringify(f.sent).includes(f.dataDir), false);
});

test('native work interrupted before turn completion keeps its quit boundary for restart recovery', async (t) => {
  let clock = 1000;
  const recovered = [];
  const f = fixture(t, { now: () => clock, recoverNativeTurn: async (record) => { recovered.push(record); } });
  const project = join(f.dataDir, 'project');
  f.reporter.startTurn({ project, turnId: 'interrupted-native', agent: 'claude',
    nativeRecord: { sessionId: 'synthetic-session', agentLog: null, from: clock } });
  f.logs.set('interrupted-native', { calls: [{ ...call(), requestId: 'claude:main:interrupted' }] });
  clock = 1500;
  f.reporter.stop();
  clock = 50000;
  const restarted = f.make();
  await restarted.flush();
  assert.equal(recovered.length, 1);
  assert.deepEqual(recovered[0], { agent: 'claude', cwd: project, turnId: 'interrupted-native',
    sessionId: 'synthetic-session', agentLog: null, from: 1000, to: 1500 });
  assert.equal([...f.server.values()][0].total, 420);
  assert.equal(restarted.state().monitoring, 0, 'overdue recovery runs before the completed registration is retired');
});

test('same request is idempotent and a late receipt updates its original event instead of adding another', async (t) => {
  const f = fixture(t);
  const input = { project: join(f.dataDir, 'p'), turnId: 'turn-late', agent: 'byok' };
  const token = f.reporter.startTurn(input);
  assert.equal(f.reporter.startTurn(input).id, token.id);
  f.logs.set(input.turnId, { calls: [{ ...call(), answer: null }] });
  await f.reporter.finishTurn(token);
  const id = f.sent[0].body.events[0].id;
  assert.equal(f.sent[0].body.events[0].reported, false);
  f.logs.set(input.turnId, { calls: [call()] });
  await f.reporter.flush();
  await f.reporter.finishTurn(token);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].body.events[0].id, id);
  assert.equal(f.server.size, 1);
  assert.equal([...f.server.values()][0].total, 420);
});

test('switching employee or company never relabels an existing pending receipt', async (t) => {
  const f = fixture(t);
  f.setOffline(true);
  const token = f.reporter.startTurn({ project: join(f.dataDir, 'p'), turnId: 'a' });
  f.logs.set('a', { calls: [call()] });
  await f.reporter.finishTurn(token);
  f.setOffline(false);
  f.setUser(identity('employee-b'));
  await f.reporter.flush();
  assert.equal(f.sent.length, 0);
  f.setUser(identity('employee-a', 'https://another.example'));
  await f.reporter.flush();
  assert.equal(f.sent.length, 0);
  f.setUser(identity());
  await f.reporter.flush();
  assert.equal(f.sent.length, 1);
});

test('empty compact and local BYOK response do not invent API requests; unavailable native receipts remain unknown', async (t) => {
  const f = fixture(t);
  const project = join(f.dataDir, 'p');
  for (const turn of [{ turnId: 'compact', agent: 'byok', skipEmpty: true }, { turnId: 'greeting', agent: 'byok' }, { turnId: 'native-compact', agent: 'codex', skipEmpty: true }]) {
    const token = f.reporter.startTurn({ project, ...turn });
    await f.reporter.finishTurn(token);
  }
  assert.equal(f.sent.length, 0);
  const token = f.reporter.startTurn({ project, turnId: 'native', agent: 'claude' });
  await f.reporter.finishTurn(token);
  assert.equal(f.sent[0].body.events[0].incomplete, true);
  assert.equal(f.sent[0].body.events[0].reported, false);
  f.logs.set('native', { calls: [call()] });
  await f.reporter.flush();
  assert.equal(f.server.size, 1, 'late native receipt replaces unknown marker');
});

test('only explicitly registered turns are read, including active-turn recovery after an interrupted process', async (t) => {
  const inspected = [];
  const f = fixture(t, { readTurn: (_project, turnId) => { inspected.push(turnId); return { calls: [call()] }; } });
  assert.equal(f.reporter.startTurn({ project: 'D:/example', turnId: '' }), null);
  f.setUser({ status: 'signed-out', serverUrl: 'https://company.example' });
  assert.equal(f.reporter.startTurn({ project: 'D:/example', turnId: 'signed-out' }), null);
  f.setUser(identity());
  f.reporter.startTurn({ project: 'D:/example', turnId: 'interrupted' });
  f.reporter.stop();
  const next = f.make();
  await next.flush();
  assert.deepEqual(new Set(inspected), new Set(['interrupted']));
  assert.equal(f.server.size, 1);
});

test('real model log counts failed/cancelled calls, not transport notices or historic conversation totals', async (t) => {
  const dir = root(t), project = join(dir, 'project');
  const logs = join(project, '.film/logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'local-real.jsonl'), JSON.stringify({ kind: 'done', ok: false }) + '\n');
  const failed = { ...call(), answer: { ...call().answer, stopReason: 'error' }, messages: [{ role: 'assistant', usage: usage(1000000) }] };
  const cancelled = { ...call(50), answer: { ...call(50).answer, stopReason: 'aborted' } };
  writeFileSync(join(logs, 'local-real.model.jsonl'), [failed, { kind: 'network_error', message: 'not an API receipt' }, cancelled].map((v) => JSON.stringify(v)).join('\n') + '\n');
  const sent = [];
  const reporter = createCompanyUsageReporter({ dataDir: join(dir, 'data'), appVersion: '0.2.13', retryMs: 0, lateMs: 0,
    client: { state: () => identity(), submitUsage: async (body) => { sent.push(body); } } });
  t.after(() => reporter.stop());
  const token = reporter.startTurn({ project, turnId: 'local:real', agent: 'byok' });
  await reporter.finishTurn(token);
  assert.equal(sent[0].events.length, 2);
  assert.equal(sent[0].events.reduce((sum, event) => sum + event.total, 0), 790);
  assert.equal(JSON.stringify(sent).includes('1000000'), false);
  const persisted = JSON.parse(readFileSync(join(dir, 'data/company-usage-queue.json'), 'utf8'));
  assert.deepEqual(persisted.pending, {});
});

test('an update arriving while a request is in flight remains pending until its own acknowledgement', async (t) => {
  const f = fixture(t);
  let release;
  f.args.client.submitUsage = () => new Promise((resolve) => { release = resolve; });
  const token = f.reporter.startTurn({ project: join(f.dataDir, 'p'), turnId: 'race' });
  f.logs.set('race', { calls: [{ ...call(), answer: null }] });
  const first = f.reporter.finishTurn(token);
  await new Promise((resolve) => setImmediate(resolve));
  f.logs.set('race', { calls: [call()] });
  const changed = f.reporter.finishTurn(token);
  release({ ok: true });
  await Promise.all([first, changed]);
  assert.equal(f.reporter.state().pending, 1);
});

test('native late insertion before an existing request preserves B420 instead of charging B twice', async (t) => {
  const f = fixture(t);
  const token = f.reporter.startTurn({ project: join(f.dataDir, 'p'), turnId: 'native-late', agent: 'claude' });
  const b = { ...call(), requestId: 'claude:main:request-b' };
  const a = { ...call(), requestId: 'claude:child:request-a', startedAt: b.startedAt - 1000, answer: null };
  f.logs.set('native-late', { calls: [b] });
  await f.reporter.finishTurn(token);
  const bId = f.sent[0].body.events[0].id;
  f.logs.set('native-late', { calls: [a, b] });
  await f.reporter.flush();
  assert.equal(f.server.size, 2);
  assert.equal([...f.server.values()].reduce((sum, event) => sum + event.total, 0), 420);
  assert.equal([...f.server.values()].filter((event) => event.incomplete).length, 1);
  assert.equal(f.server.get(`employee-a:${bId}`).total, 420);
  assert.equal(f.sent[1].body.events.length, 1, 'unchanged B is not re-submitted under another ID');
});

test('legacy native logs reconstruct compressed context for stable identity after late insertion', async (t) => {
  const f = fixture(t);
  const token = f.reporter.startTurn({ project: join(f.dataDir, 'p'), turnId: 'legacy-late', agent: 'claude' });
  const context = [{ role: 'user', content: [{ type: 'text', text: 'private task' }] }];
  const b = { ...call(), prefix: 0, messages: context };
  f.logs.set('legacy-late', { calls: [b] });
  await f.reporter.finishTurn(token);
  const a = { ...call(), startedAt: b.startedAt - 1000, prefix: 0, messages: context, answer: null };
  f.logs.set('legacy-late', { calls: [a, { ...b, prefix: 1, messages: [] }] });
  await f.reporter.flush();
  assert.equal(f.server.size, 2);
  assert.equal([...f.server.values()].reduce((sum, event) => sum + event.total, 0), 420);
  assert.equal([...f.server.values()].filter((event) => event.incomplete).length, 1);
  assert.equal(JSON.stringify(f.sent).includes('private task'), false);
});

test('legacy native identity collisions stay partial rather than inventing duplicate known usage', async (t) => {
  const f = fixture(t);
  const token = f.reporter.startTurn({ project: join(f.dataDir, 'p'), turnId: 'legacy-collision', agent: 'claude' });
  f.logs.set('legacy-collision', { calls: [call()] });
  await f.reporter.finishTurn(token);
  f.logs.set('legacy-collision', { calls: [call(), call()] });
  await f.reporter.flush();
  assert.equal([...f.server.values()].reduce((sum, event) => sum + event.total, 0), 420);
  assert.equal([...f.server.values()].filter((event) => event.incomplete).length, 1);
});


test('quota direct settlement and original model log replay keep the same server request ID', async (t) => {
  const f = fixture(t), quotaRequestId = '00000000-0000-4000-8000-000000000003';
  const receipt = companyUsageEvent(call(), { id: quotaRequestId, at: '2026-10-24T02:00:00.000Z', appVersion: '0.2.13' });
  const owner = { serverUrl: 'https://company.example', userId: 'employee-a' };
  f.reporter.recordRequest(receipt, owner);
  assert.equal(f.reporter.state().pending, 1);
  const persisted = JSON.parse(readFileSync(join(f.dataDir, 'company-usage-queue.json'), 'utf8'));
  assert.equal(persisted.pending[quotaRequestId].event.id, quotaRequestId);
  await f.reporter.flush();
  const token = f.reporter.startTurn({ project: join(f.dataDir, 'p'), turnId: 'quota', agent: 'byok' });
  f.logs.set('quota', { calls: [{ ...call(), quotaRequestId }] });
  await f.reporter.finishTurn(token);
  assert.equal(f.server.size, 1); assert.equal([...f.server.values()][0].id, quotaRequestId);
});
