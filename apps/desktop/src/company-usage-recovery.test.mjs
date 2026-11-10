import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSession } from './agents.mjs';
import { keepAgentRecord, registerLocalAgentIpc } from './local-agents-ipc.mjs';
import { createCompanyUsageReporter } from './company-usage.mjs';
import { agentRecordCalls, claudeProjectName } from './agent-records.mjs';
import { summarizeUsage } from './model-usage.mjs';
import { quitAfterStudio } from './window-lifecycle.mjs';

const owner = (id = 'employee-a') => ({ status: 'signed-in', serverUrl: 'https://synthetic.invalid', user: { id } });
const turnId = 'local:native-recovery';
const sessionId = 'synthetic-native-session';
const receipt = (at, id, input = 100) => ({ type: 'assistant', uuid: id, timestamp: new Date(at).toISOString(), message: {
  id, model: 'claude-synthetic', role: 'assistant', content: [{ type: 'text', text: 'synthetic complete' }], stop_reason: 'end_turn',
  usage: { input_tokens: input, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
} });

if (process.argv[2] === '--synthetic-native-exit') {
  const dir = process.argv[3], project = join(dir, 'project'), dataDir = join(dir, 'data'), nativeHome = join(dir, 'native');
  const nativeDir = join(nativeHome, 'projects', claudeProjectName(project));
  mkdirSync(project, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  const nativeFile = join(nativeDir, sessionId + '.jsonl');
  writeFileSync(nativeFile, JSON.stringify(receipt(Date.now() - 60_000, 'historic', 50000)) + '\n');
  const reporter = createCompanyUsageReporter({ dataDir, retryMs: 0, lateMs: 0,
    client: { state: () => owner(), submitUsage: async () => { throw new Error('child must exit before import'); } } });
  AgentSession.prototype.start = async function () { return { sessionId }; };
  AgentSession.prototype.prompt = async function () {
    appendFileSync(nativeFile, JSON.stringify(receipt(Date.now(), 'current')) + '\n');
    return 'end_turn';
  };
  AgentSession.prototype.close = function () {};
  const handlers = new Map();
  const local = registerLocalAgentIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    trusted: () => true, usageReporter: reporter, env: { DAOCUT_STUDIO_HOME: join(dir, 'studio') },
  });
  const event = { sender: { once() {}, isDestroyed: () => false, send() {} } };
  const started = await handlers.get('desktop:local-agents:start')(event, { agent: 'claude', cwd: project });
  assert.equal(started.ok, true);
  const result = await handlers.get('desktop:local-agents:prompt')(event, { key: started.key, text: 'synthetic only', meta: { turnId } });
  assert.equal(result.ok, true);
  await new Promise((done) => setTimeout(done, 30));
  assert.ok(existsSync(join(project, '.film/logs/local-native-recovery.jsonl')));
  assert.equal(existsSync(join(project, '.film/logs/local-native-recovery.model.jsonl')), false);
  quitAfterStudio({ preventDefault() {} }, {
    quitting: false, markQuitting() {}, closeAgents: () => local.closeAll(), studio: { async quit() {} },
    quit() {
      reporter.stop();
      writeFileSync(join(dir, 'exited.json'), JSON.stringify({ nativeFile, nativeHome, project, dataDir, at: Date.now() }));
      process.exit(0);
    },
  });
} else {
  test('native receipt survives exit before import, stays with its employee, and is recovered once inside its registered interval', async (t) => {
    const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../.release/test-company-usage-recovery');
    mkdirSync(fixtureRoot, { recursive: true });
    const dir = mkdtempSync(join(fixtureRoot, 'case-'));
    const reporters = [];
    t.after(() => {
      for (const reporter of reporters) reporter.stop();
      const child = relative(fixtureRoot, resolve(dir));
      assert.ok(child && child !== '..' && !child.startsWith('..' + sep));
      rmSync(dir, { recursive: true, force: true });
    });
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--synthetic-native-exit', dir], { windowsHide: true, encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    const saved = JSON.parse(readFileSync(join(dir, 'exited.json'), 'utf8'));
    // Another native use after Daocut exits must not be charged to this completed turn.
    appendFileSync(saved.nativeFile, JSON.stringify(receipt(saved.at + 1000, 'later-unrelated', 10000)) + '\n');
    const native = agentRecordCalls({ agent: 'claude', sessionId, cwd: saved.project, from: saved.at - 1000, to: saved.at,
      env: { CLAUDE_CONFIG_DIR: saved.nativeHome } });
    assert.equal(summarizeUsage(native.calls).total, 420, 'the original supported receipt is already complete');
    let current = owner('employee-b');
    const sent = [], recovered = [];
    const make = () => {
      const reporter = createCompanyUsageReporter({ dataDir: saved.dataDir, retryMs: 0, lateMs: 0,
        recoverNativeTurn: async (record) => {
          recovered.push(record);
          await keepAgentRecord({ ...record, env: { CLAUDE_CONFIG_DIR: saved.nativeHome }, settleMs: 0 });
        },
        client: { state: () => current, submitUsage: async (body, identity) => { sent.push({ body, identity }); } },
      });
      reporters.push(reporter); return reporter;
    };
    const restarted = make();
    await restarted.flush();
    assert.equal(sent.length, 0, 'another employee cannot receive the recovered receipt');
    current = owner();
    await restarted.flush();
    assert.equal(sent[0].body.events[0].total, 420, 'exit-window recovery must import the known native receipt');
    assert.equal(sent[0].body.events[0].reported, true);
    assert.equal(sent[0].body.events[0].incomplete, false);
    assert.equal(sent[0].body.events.length, 1, 'neither historical nor later native work belongs to this turn');
    assert.equal(sent[0].identity.userId, 'employee-a');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].sessionId, sessionId);
    assert.equal(recovered[0].cwd, saved.project);
    assert.ok(Number.isFinite(recovered[0].from) && Number.isFinite(recovered[0].to));
    assert.ok(recovered[0].to <= saved.at);
    await restarted.flush();
    restarted.stop();
    const again = make();
    await again.flush();
    assert.equal(sent.length, 1, 'reimporting after another restart is idempotent');
    assert.equal(JSON.stringify(sent).includes(saved.nativeHome), false, 'recovery paths stay local');
  });
}
