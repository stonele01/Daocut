import test from 'node:test';
import assert from 'node:assert/strict';
import { productStructureBlocker, productStructureIntent, runProductStructureTask } from '../chat/src/lib/product-structure-task.ts';

const scope = { sourceId: 's', productId: 'a', intervalId: 'a1', productName: 'A', startMs: 3600000, endMs: 3660000 };
const intent = { retry: false, rerun: false };
const state = (status, extra = {}) => ({ scope, analysis: { status, stale: status !== 'complete', ...extra } });

test('explicit structure tasks are distinguished from explanations, questions and negation', () => {
  for (const text of ['分析结构', '帮我出这段的结构', '识别一下这个商品的结构', '帮我提取本段结构', '把这段结构分析一下']) assert.deepEqual(productStructureIntent(text), intent, text);
  assert.deepEqual(productStructureIntent('重试本段结构'), { retry: true, rerun: false });
  assert.deepEqual(productStructureIntent('重新分析这段结构'), { retry: false, rerun: true });
  for (const text of ['结构是什么', '解释结构分析的结果', '怎么分析结构', '分析结构要多少钱', '不要分析结构', '先不识别结构', '介绍一下这个商品', '普通讨论', '请检查分析结构的代码', '讨论分析结构的方案', '暂时不分析结构', '我不想分析结构', '不分析结构', '分析一下结构，别发真实模型请求']) assert.equal(productStructureIntent(text), null, text);
  for (const text of ['暂时不分析结构', '我不想分析结构', '不分析结构', '分析一下结构，别发真实模型请求']) assert.ok(productStructureBlocker(text), text);
});

test('selected product analysis wording shares the confirmed structure task without requiring the word structure', () => {
  for (const text of ['分析这个商品的卖点和痛点', '提取钩子和卖点', '帮我分析这段', '分析当前商品段', '把本段的钩子、痛点、卖点拆解一下', '梳理这个商品的话术']) assert.deepEqual(productStructureIntent(text), intent, text);
  for (const text of ['卖点是什么', '为什么这样标注痛点', '讨论提取钩子的功能', '梳理话术要多少钱', '请检查提取卖点的代码', '不要提取钩子和卖点', '暂时不要梳理这个商品的话术', '仅本地模拟提取钩子和卖点']) assert.equal(productStructureIntent(text), null, text);
  for (const text of ['不要提取钩子和卖点', '暂时不要梳理这个商品的话术', '仅本地模拟提取钩子和卖点']) assert.ok(productStructureBlocker(text), text);
});

test('valid card result is opened with zero POST, and completed shared tasks refresh the page', async () => {
  let writes = 0, refreshed = 0;
  const result = await runProductStructureTask({ read: async () => state('complete'), start: async () => { writes++; throw Error(); }, refresh: () => refreshed++ }, scope, intent);
  assert.equal(result.reused, true); assert.equal(writes, 0); assert.equal(refreshed, 1);
});

test('a running task is joined with read-only polling, never submitted again', async () => {
  let reads = 0, writes = 0;
  const result = await runProductStructureTask({ read: async () => state(++reads < 3 ? 'running' : 'complete'), start: async () => { writes++; throw Error(); }, refresh() {} }, scope, intent, { wait: async () => {} });
  assert.equal(result.reused, false); assert.equal(reads, 3); assert.equal(writes, 0);
});

test('missing result posts once and polls the shared windows; a read failure never restarts it', async () => {
  let writes = 0, reads = 0;
  const io = { read: async () => { if (++reads === 1) return state('idle'); throw Error('读取连接中断'); }, confirm: async () => true, start: async () => { writes++; return state('running'); }, refresh() { throw Error('unfinished'); } };
  await assert.rejects(runProductStructureTask(io, scope, intent, { wait: async () => {} }), /读取连接中断/);
  assert.equal(writes, 1); assert.equal(reads, 2);
});

test('uncertain POST failure does not automatically retry or poll as if submission had failed safely', async () => {
  let writes = 0;
  await assert.rejects(runProductStructureTask({ read: async () => state('idle'), confirm: async () => true, start: async () => { writes++; throw Error('提交响应中断'); }, refresh() {} }, scope, intent), /提交响应中断/);
  assert.equal(writes, 1);
});

test('stale frozen boundary and absent scope are rejected before POST', async () => {
  let writes = 0;
  for (const scope of [undefined, { sourceId: 's', productId: 'a', intervalId: 'a1', startMs: 1, endMs: 2 }]) {
    await assert.rejects(runProductStructureTask({ read: async () => ({ ...state('idle'), scope }), start: async () => { writes++; throw Error(); }, refresh() {} }, { sourceId: 's', productId: 'a', intervalId: 'a1', startMs: 0, endMs: 2 }, intent), /商品段已经改变/);
  }
  assert.equal(writes, 0);
});

test('Stop during a pending read prevents a late model submission', async () => {
  let done, writes = 0;
  const controller = new AbortController();
  const result = runProductStructureTask({ read: () => new Promise(resolve => { done = resolve; }), start: async () => { writes++; return state('complete'); }, refresh() {} }, scope, intent, { signal: controller.signal });
  controller.abort(); done(state('idle'));
  await assert.rejects(result, /停止等待/);
  assert.equal(writes, 0);
});

test('unknown cost or request plan still requires explicit confirmation before a POST', async () => {
  let confirmations = 0, writes = 0;
  await assert.rejects(runProductStructureTask({ read: async () => state('idle'), confirm: async () => { confirmations++; return false; }, start: async () => { writes++; return state('complete'); }, refresh() {} }, scope, intent), /已取消/);
  assert.equal(confirmations, 1); assert.equal(writes, 0);
});

test('desktop structure confirmation submits the same frozen workflow plan, including retry and service scope', async () => {
  const plan = { identity: 'approved-input', action: 'analysis', sourceId: 's', productId: 'a', intervalId: 'a1', retry: false, rerun: false, service: { provider: 'deepseek', model: 'mock', endpoint: 'https://example.invalid/responses' }, requestCount: 1 };
  const initial = { ...state('idle'), workflowPlan: structuredClone(plan) };
  let submitted;
  await runProductStructureTask({ read: async () => initial, confirm: async () => { initial.workflowPlan.identity = 'changed-after-dialog'; return true; }, start: async options => { submitted = options.plan; return state('complete'); }, refresh() {} }, scope, intent);
  assert.deepEqual(submitted, plan, 'execution must retain the exact plan shown before confirmation');
});

test('cached desktop structure uses no confirmation or new workflow execution', async () => {
  let confirmed = 0, posted = 0;
  const result = await runProductStructureTask({ read: async () => ({ ...state('complete'), workflowPlan: { identity: 'cached', cached: true } }), confirm: async () => { confirmed++; return true; }, start: async () => { posted++; throw Error(); }, refresh() {} }, scope, intent);
  assert.equal(result.reused, true); assert.equal(confirmed, 0); assert.equal(posted, 0);
});
