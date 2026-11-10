import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerChatIpc } from './chat-ipc.mjs';
import { fileURLToPath } from 'node:url';
import { combineUsage, emptyUsage, summarizeUsage } from './model-usage.mjs';

test('chat usage IPC returns scalar receipts, refreshes growing logs and enforces the existing project boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'daocut-usage-'));
  const logs = join(dir, '.film', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'local-one.jsonl'), JSON.stringify({ kind: 'prompt', t: 1, agent: 'byok', prompt: 'private prompt' }) + '\n');
  const path = join(logs, 'local-one.model.jsonl');
  const first = { kind: 'call', messages: [{ content: 'private prompt' }], answer: { usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 } }, pricing: { currency: 'CNY', input: 1, output: 2 } };
  writeFileSync(path, JSON.stringify(first) + '\n');
  const handlers = new Map();
  registerChatIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    trusted: () => true, projects: async () => [dir], dataDir: dir, reveal() {}, tell() {}, log() {},
  });
  const read = (project = dir) => handlers.get('desktop:chat:usage')({}, { project, turnIds: ['local:one', 'local:missing'] });
  const one = await read();
  assert.equal(one['local:one'].total, 10);
  assert.equal(one['local:one'].unpriced, 0);
  assert.equal(one['local:missing'].missing, 1);
  assert.equal(JSON.stringify(one).includes('private prompt'), false);
  assert.deepEqual(await read(), one, 'unchanged logs retain their scalar summary');
  writeFileSync(path, JSON.stringify(first) + '\n' + JSON.stringify({ ...first, answer: { usage: { input: 80, output: 20 } } }) + '\n');
  assert.equal((await read())['local:one'].total, 110);
  await assert.rejects(read(join(dir, 'not-open')), /not a project/);
});


function commandUsageFixture() {
  const root = fileURLToPath(new URL('../.release/compact-usage-tests/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  const logs = join(dir, '.film', 'logs');
  mkdirSync(logs, { recursive: true });
  const handlers = new Map();
  registerChatIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    trusted: () => true, projects: async () => [dir], dataDir: dir, reveal() {}, tell() {}, log() {},
  });
  return {
    write: (id, events, calls = []) => {
      const name = id.replace(':', '-');
      writeFileSync(join(logs, name + '.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
      writeFileSync(join(logs, name + '.model.jsonl'), calls.map(e => JSON.stringify(e) + '\n').join(''));
    },
    read: (...turnIds) => handlers.get('desktop:chat:usage')({}, { project: dir, turnIds }),
  };
}
const commandPrompt = { kind: 'prompt', agent: 'byok', text: '/compact', t: 1 };
const skippedReply = { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '当前对话已经压缩，无需重复压缩。' },
  _meta: { 'daocut/localReply': true, 'daocut/compaction': { reason: 'manual', status: 'skipped' } } } };
const paidSummary = { kind: 'call', answer: { usage: { input: 45000, output: 60, cacheRead: 0, cacheWrite: 0 } }, pricing: { currency: 'CNY', input: 2, output: 8 } };

test('actual usage IPC recognizes explicit local compact no-ops without hiding existing costs', async () => {
  const f = commandUsageFixture();
  f.write('local:paid', [commandPrompt], [paidSummary]);
  f.write('local:skipped', [commandPrompt, skippedReply, { kind: 'done', ok: true, stopReason: 'end_turn' }]);
  const result = await f.read('local:paid', 'local:skipped');
  assert.deepEqual(result['local:skipped'], emptyUsage());
  assert.deepEqual(combineUsage(Object.values(result)), result['local:paid']);
  assert.ok(Math.abs(result['local:paid'].costs.CNY - 0.09048) < 1e-10);
  assert.deepEqual(await f.read('local:paid', 'local:skipped'), result, 'known no-request state survives repeated reads');
});

test('usage IPC keeps missing, failed, cancelled and unmarked compact logs unknown', async () => {
  const f = commandUsageFixture();
  const changedStatus = status => ({ ...skippedReply, update: { ...skippedReply.update,
    _meta: { ...skippedReply.update._meta, 'daocut/compaction': { reason: 'manual', status } } } });
  const variants = [[], [commandPrompt], [commandPrompt, changedStatus('failed')], [commandPrompt, changedStatus('cancelled')],
    [{ ...commandPrompt, agent: 'codex' }, skippedReply], [{ ...commandPrompt, text: 'ordinary request' }, skippedReply],
    [commandPrompt, { ...skippedReply, update: { ...skippedReply.update, _meta: { 'daocut/compaction': { reason: 'manual', status: 'skipped' } } } }]];
  for (const [i, events] of variants.entries()) f.write('local:unknown' + i, events);
  const result = await f.read(...variants.map((_, i) => 'local:unknown' + i), 'local:absent');
  for (const summary of Object.values(result)) assert.deepEqual(summary, summarizeUsage([]));
});

test('actual model calls override skipped metadata and growing logs invalidate a zero-request summary', async () => {
  const f = commandUsageFixture();
  f.write('local:skipped', [commandPrompt, skippedReply]);
  assert.deepEqual((await f.read('local:skipped'))['local:skipped'], emptyUsage());
  f.write('local:skipped', [commandPrompt, skippedReply], [paidSummary]);
  assert.deepEqual((await f.read('local:skipped'))['local:skipped'], summarizeUsage([paidSummary]));
  const missingReceipt = { kind: 'call', answer: { stopReason: 'error' } };
  f.write('local:skipped', [commandPrompt, skippedReply], [missingReceipt]);
  assert.deepEqual((await f.read('local:skipped'))['local:skipped'], summarizeUsage([missingReceipt]));
});
