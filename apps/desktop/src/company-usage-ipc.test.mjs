import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSession } from './agents.mjs';
import { registerLocalAgentIpc } from './local-agents-ipc.mjs';

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../.release/test-company-usage-ipc');
const setup = async (t, { fail = false, reporterFails = false } = {}) => {
  mkdirSync(fixtureRoot, { recursive: true });
  const project = mkdtempSync(join(fixtureRoot, 'case-'));
  const handlers = new Map(), starts = [], finishes = [];
  let session, activeOwner = { serverUrl: 'https://company.example', userId: 'employee-a' };
  t.mock.method(AgentSession.prototype, 'start', async function () { session = this; return { sessionId: 'synthetic-session' }; });
  t.mock.method(AgentSession.prototype, 'prompt', async () => { if (fail) throw new Error('synthetic cancellation'); return 'end_turn'; });
  t.mock.method(AgentSession.prototype, 'close', () => {});
  const api = registerLocalAgentIpc({ handle: (key, fn) => handlers.set(key, fn) }, {
    trusted: () => true, harness: async () => ({}), env: { DAOCUT_STUDIO_HOME: join(project, 'studio') },
    usageReporter: {
      startTurn(input) { if (reporterFails) throw new Error('synthetic queue failure'); starts.push(input); return { id: input.turnId, owner: input.identity ?? activeOwner }; },
      async finishTurn(token) { if (reporterFails) throw new Error('synthetic queue failure'); if (token) finishes.push(token); },
    },
  });
  t.after(async () => {
    api.closeAll();
    await new Promise((done) => setTimeout(done, 50));
    const child = relative(fixtureRoot, resolve(project));
    assert.ok(child && child !== '..' && !child.startsWith('..' + sep));
    rmSync(project, { recursive: true, force: true });
  });
  const event = { sender: { once() {}, isDestroyed: () => false, send() {} } };
  const started = await handlers.get('desktop:local-agents:start')(event, { agent: 'byok', cwd: project });
  assert.equal(started.ok, true);
  const run = (channel, options = {}) => handlers.get(`desktop:local-agents:${channel}`)(event, { key: started.key, ...options });
  return { starts, finishes, run, getSession: () => session, changeOwner: (id) => { activeOwner = { ...activeOwner, userId: id }; } };
};

test('IPC captures attribution before running and queues success and failure receipts without blocking result', async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? 'failed' : 'successful', async (child) => {
      const f = await setup(child, { fail });
      const result = await f.run('prompt', { text: 'synthetic task', meta: { turnId: 'local:usage' } });
      await new Promise((done) => setImmediate(done));
      assert.equal(result.ok, !fail);
      assert.equal(f.starts.length, 1);
      assert.equal(f.finishes.length, 1);
      assert.equal(f.finishes[0].owner.userId, 'employee-a');
    });
  }
});

test('unprompted background work keeps the preceding task owner and is finalized on process exit', async (t) => {
  const f = await setup(t);
  await f.run('prompt', { text: 'synthetic task', meta: { turnId: 'local:prompt' } });
  f.changeOwner('employee-b');
  await f.run('adopt', { turnId: 'local:background' });
  assert.equal(f.starts[1].identity.userId, 'employee-a');
  f.getSession().opts.onExit({ code: 0, stderr: '' });
  await new Promise((done) => setImmediate(done));
  assert.equal(f.finishes.at(-1).id, 'local:background');
  assert.equal(f.finishes.at(-1).owner.userId, 'employee-a');
});

test('compact marker is passed without the user prompt', async (t) => {
  const f = await setup(t);
  const result = await f.run('prompt', { text: '/compact', meta: { turnId: 'local:compact' } });
  assert.equal(result.ok, true);
  assert.equal(f.starts[0].skipEmpty, true);
  assert.equal('text' in f.starts[0], false);
});

test('optional reporter failure does not stop normal chat', async (t) => {
  const f = await setup(t, { reporterFails: true });
  const result = await f.run('prompt', { text: 'synthetic task', meta: { turnId: 'local:failure' } });
  await new Promise((done) => setImmediate(done));
  assert.equal(result.ok, true);
});


test('prompt authorization takes the existing session agent, never a renderer override', async t => {
  const project = join(fixtureRoot, 'native-agent-identity'); mkdirSync(project, { recursive: true });
  t.mock.method(AgentSession.prototype, 'start', async () => ({ sessionId: 'native-test' }));
  t.mock.method(AgentSession.prototype, 'prompt', async () => 'end_turn');
  t.mock.method(AgentSession.prototype, 'close', () => {});
  const handlers = new Map(), seen = [];
  const api = registerLocalAgentIpc({ handle: (key, fn) => handlers.set(key, fn) }, { trusted: () => true,
    authorizeTask: async ({ agent }) => { seen.push(agent); if (seen.length > 1 && agent !== 'byok') throw new Error('native quota blocked'); } });
  t.after(() => api.closeAll());
  const event = { sender: { once() {}, isDestroyed: () => false, send() {} } };
  const started = await handlers.get('desktop:local-agents:start')(event, { agent: 'claude', cwd: project });
  assert.equal(started.ok, true);
  const result = await handlers.get('desktop:local-agents:prompt')(event, { key: started.key, agent: 'byok', text: 'bypass' });
  assert.equal(result.ok, false); assert.deepEqual(seen, ['claude', 'claude']);
});
