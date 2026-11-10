import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './product-chat-test-fixture.mjs';

test('range A and B each start fresh while the ordinary conversation retains its own session', async () => {
  const f = runner();
  await f.run('normal-1', '普通聊天历史');
  await f.run('range-a', '仅商品 A 段', true);
  await f.run('range-b', '仅商品 B 段', true);
  await f.run('normal-2', '继续普通聊天');
  assert.deepEqual(f.starts.map(s => s.resume), ['previous-normal-session', null, null]);
  assert.deepEqual(f.sent.map(s => s.words), [['普通聊天历史'], ['仅商品 A 段'], ['仅商品 B 段'], ['普通聊天历史', '继续普通聊天']]);
  assert.equal(f.sent[0].key, f.sent[3].key);
  assert.notEqual(f.sent[1].key, f.sent[2].key);
  assert.deepEqual(f.closed, [f.sent[1].key, f.sent[2].key]);
});

test('a running product task cannot receive steering, including after page recovery', async () => {
  const f = runner();
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.run('range-a', 'A', true);
  while (!f.sent.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.api.canSteer('range-a'), false);
  assert.equal(await f.api.steerLocalAgentTurn('range-a', new f.api.LocalAgentTurn('range-b', 'byok'), 'B'), false);
  release();
  await pending;

  const g = runner();
  g.restore([{ key: 'restored-product', agent: 'byok', cwd: '/synthetic',
    info: { sessionId: 'isolated', steering: true, configOptions: [] },
    meta: { turnId: 'restored-a', projectId: 'project', sessionId: 'visible-chat', productStructure: true }, done: null, events: [] }]);
  await g.api.recoverLocalAgentTurns('project');
  assert.equal(g.api.canSteer('restored-a'), false);
  await g.run('ordinary-after-reload', '普通对话');
  assert.equal(g.sent[0].key, 'native-1', 'restored product session was not reused by the ordinary conversation');
});

test('cancellation during native session setup closes it before any model prompt', async () => {
  const f = runner();
  let release, cancelled = false;
  f.holdStart(new Promise(resolve => { release = resolve; }));
  const pending = f.api.runLocalAgentTurn({ projectId: 'project', conversation: 'visible-chat', agent: 'byok', cwd: '/synthetic', text: 'A',
    turn: new f.api.LocalAgentTurn('cancel-before-prompt', 'byok'),
    meta: { turnId: 'cancel-before-prompt', productStructure: true }, isCancelled: () => cancelled });
  assert.equal(f.starts.length, 1);
  cancelled = true;
  release();
  assert.equal((await pending).stopReason, 'cancelled');
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.closed, ['native-1']);
});

test('failed scoped model-option setup closes its session without a prompt', async () => {
  const f = runner();
  f.failOption();
  await assert.rejects(f.api.runLocalAgentTurn({ projectId: 'project', conversation: 'visible-chat', agent: 'byok', cwd: '/synthetic', text: 'A',
    turn: new f.api.LocalAgentTurn('option-failure', 'byok'), options: { model: 'new' },
    meta: { turnId: 'option-failure', productStructure: true } }), /option failed/);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.closed, ['native-1']);
  assert.equal(f.api.canSteer('option-failure'), false);
});
