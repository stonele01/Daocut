import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTextStructure, combineTextStructureWindows, createDeepSeekTextClient, TEXT_STRUCTURE_PROMPT } from './text-structure.mjs';

const input = () => ({ sourceId: 's', productId: 'p', intervalId: 'i', rangeStartMs: 0, rangeEndMs: 3000, cues: [{ text: '你看这个', startMs: 0, endMs: 1000 }, { text: '价格十元', startMs: 1000, endMs: 2000 }] });
const item = { firstCue: 0, lastCue: 1, tags: ['价格锚点'], details: { subtypes: ['普通报价'], reason: '提及价格', evidence: ['ASR'], context: '', repetition: '', review: [] } };

const compact = candidates => ({ schema: 'complete-speech-v1', candidates, issues: [] });

test('compact whole-speech result keeps necessary context in one exact range without model explanations', async () => {
  const cues = [{ text: '以前放包里容易漏水。', startMs: 0, endMs: 1000 }, { text: '这个密封圈解决了刚才的问题。', startMs: 1000, endMs: 2000 }];
  const before = structuredClone(cues);
  const result = await analyzeTextStructure({ ...input(), cues, client: async () => compact([{ firstCue: 0, lastCue: 1, tags: ['痛点', '卖点'] }]) });
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.text, cues.map(cue => cue.text).join(''));
  assert.deepEqual(candidate.cueRange, [0, 1]);
  assert.deepEqual([candidate.startMs, candidate.endMs], [0, 2000]);
  assert.deepEqual(candidate.details.composition.roles, ['pain', 'core']);
  assert.deepEqual(candidate.details.composition.requires, []);
  assert.equal(candidate.details.composition.status, 'confirmed');
  assert.equal(candidate.details.composition.coreIds.length, 1);
  assert.deepEqual(cues, before);
});

test('empty compact output keeps its schema and coverage issues through window combination', async () => {
  const issues = ['窗口后半部分未读完'];
  const result = await analyzeTextStructure({ ...input(), client: async () => ({ ...compact([]), issues }) });
  assert.equal(result.schema, 'complete-speech-v1');
  const combined = combineTextStructureWindows({ ...input(), outputs: [result] });
  assert.equal(combined.schema, 'complete-speech-v1');
  assert.ok(combined.issues.includes(issues[0]));
  const legacy = await analyzeTextStructure({ ...input(), client: async () => ({ candidates: [], issues: [] }) });
  assert.equal(Object.hasOwn(legacy, 'schema'), false);
  assert.equal(Object.hasOwn(combineTextStructureWindows({ ...input(), outputs: [legacy] }), 'schema'), false);
});

test('compact labels normalize welfare and preserve complete selling expressions without requiring hook labels', async () => {
  const tags = ['故事', '痛点', '卖点', '福利机制', '信任背书', '行动指令', '逼单', '价格锚点'];
  const expected = ['story', 'pain', 'core', 'offer', 'trust', 'purchase', 'purchase', 'offer'];
  for (const [index, tag] of tags.entries()) {
    const result = await analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, tags: [tag] }]) });
    assert.deepEqual(result.candidates[0].details.composition.roles, [expected[index]]);
    assert.equal(result.candidates[0].tags.includes('钩子'), false);
    if (tag === '价格锚点') assert.deepEqual(result.candidates[0].tags, ['福利机制']);
  }
  const cues = [{ text: '倒过来也不漏。', startMs: 0, endMs: 1000 }, { text: '放在包里不怕弄湿东西。', startMs: 1000, endMs: 2000 }];
  const response = compact(cues.map((_, i) => ({ firstCue: i, lastCue: i, tags: ['卖点'] })));
  const first = await analyzeTextStructure({ ...input(), cues, client: async () => response });
  const second = await analyzeTextStructure({ ...input(), cues, cueIndexOffset: 20, client: async () => response });
  assert.notEqual(first.candidates[0].details.composition.coreIds[0], first.candidates[1].details.composition.coreIds[0]);
  assert.deepEqual(first.candidates.map(c => c.details.composition.coreIds), second.candidates.map(c => c.details.composition.coreIds), 'whole-source range identity survives window offsets');
});

test('compact special conditions are retained and unresolved context is not silently confirmed', async () => {
  const conditions = { offerRound: '这一轮', quantity: 2, couponRequired: true };
  const result = await analyzeTextStructure({ ...input(), client: async () => compact([
    { firstCue: 0, lastCue: 1, tags: ['福利机制'], conditions },
    { firstCue: 1, lastCue: 1, tags: ['卖点'], review: ['必要前文不在当前窗口，无法独立使用'] },
  ]) });
  assert.deepEqual(result.candidates[0].details.composition.conditions, conditions);
  assert.equal(result.candidates[1].details.composition.status, 'pending');
  assert.match(result.candidates[1].details.review.join(''), /必要前文/);
});

test('compact contract rejects unsupported output, bad ranges and unverified visual labels', async () => {
  for (const response of [
    { ...compact([]), schema: 'complete-speech-future' },
    compact([{ firstCue: 0, lastCue: 3, tags: ['卖点'] }]),
    compact([{ firstCue: 0, lastCue: 1, tags: ['产品演示'] }]),
    compact([{ firstCue: 0, lastCue: 1, tags: ['福利机制'], conditions: { price: {} } }]),
    compact([{ firstCue: 0, lastCue: 1, tags: ['卖点'], review: '缺前文' }]),
  ]) await assert.rejects(analyzeTextStructure({ ...input(), client: async () => response }), { code: 'MODEL_CONSTRAINT' });
});

test('legacy empty context remains legacy and normalized complete results survive saved replay', async () => {
  const legacy = await analyzeTextStructure({ ...input(), client: async () => ({ candidates: [item], issues: [] }) });
  assert.equal(legacy.candidates[0].details.composition, undefined);
  const fresh = await analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, tags: ['卖点'] }]) });
  const candidate = fresh.candidates[0];
  const reopened = await analyzeTextStructure({ ...input(), client: async () => ({ candidates: [{ firstCue: 0, lastCue: 1, tags: candidate.tags, details: candidate.details }], issues: fresh.issues }) });
  assert.deepEqual(reopened.candidates[0].details, candidate.details);
  assert.equal(reopened.candidates[0].text, candidate.text);
  assert.equal(reopened.schema, 'complete-speech-v1');
});

test('overlapping compact windows retain unresolved context and conflicting offer conditions', async () => {
  const make = candidate => analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, tags: ['福利机制'], ...candidate }]) });
  const confirmed = await make({ conditions: { quantity: 2 } });
  const unresolved = await make({ conditions: { quantity: 2 }, review: ['必要的领券资格尚未核实'] });
  const conflict = await make({ conditions: { quantity: 1 } });
  for (const outputs of [[confirmed, unresolved], [unresolved, confirmed], [confirmed, conflict]]) {
    const result = combineTextStructureWindows({ outputs, ...input() });
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    assert.equal(candidate.details.composition.status, 'pending');
    assert.match(candidate.details.review.join(''), /领券资格|条件.*冲突/);
    assert.deepEqual(candidate.windowIndices, [0, 1]);
    assert.equal(candidate.text, '你看这个价格十元');
  }
  const compatible = combineTextStructureWindows({ outputs: [await make({ conditions: { quantity: 2 } }), await make({ conditions: { couponRequired: true } })], ...input() });
  assert.equal(compatible.candidates[0].details.composition.status, 'confirmed');
  assert.deepEqual(compatible.candidates[0].details.composition.conditions, { quantity: 2, couponRequired: true });
  assert.equal(confirmed.candidates[0].details.composition.status, 'confirmed', 'merge must not mutate saved window output');
  assert.deepEqual(confirmed.candidates[0].details.composition.conditions, { quantity: 2 });
});

test('compact window merging does not silently confirm a legacy duplicate', async () => {
  const fresh = await analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, tags: ['卖点'] }]) });
  const legacy = await analyzeTextStructure({ ...input(), client: async () => ({ candidates: [{ ...item, tags: ['卖点'] }], issues: [] }) });
  for (const outputs of [[fresh, legacy], [legacy, fresh]]) {
    const combined = combineTextStructureWindows({ outputs, ...input() });
    assert.equal(combined.candidates[0].details.composition.status, 'pending');
    assert.match(combined.candidates[0].details.review.join(''), /完整性.*不一致/);
  }
  assert.equal(legacy.candidates[0].details.composition, undefined);
});
test('mock client returns source-derived text and times with verification warning', async () => {
  const result = await analyzeTextStructure({ ...input(), client: async ({ system, input: body }) => {
    assert.match(system, /本次只提供原片时间基准的 ASR/);
    assert.match(TEXT_STRUCTURE_PROMPT, /价格锚点福利机制/);
    assert.equal(JSON.parse(body).cues.length, 2);
    return { candidates: [item], issues: [] };
  } });
  assert.equal(result.candidates[0].text, '你看这个价格十元');
  assert.equal(result.candidates[0].startMs, 0);
  assert.equal(result.candidates[0].endMs, 2000);
  assert.match(result.candidates[0].details.review.join(''), /画面、声音和句级边界待核实/);
});
test('joins Chinese punctuation and numbers without invented spaces, keeping English word boundaries', async () => {
  const cues = [{ text: '这个，', startMs: 0, endMs: 400 }, { text: '69.9', startMs: 400, endMs: 800 }, { text: '元！', startMs: 800, endMs: 1200 }, { text: 'Hello', startMs: 1200, endMs: 1600 }, { text: 'world', startMs: 1600, endMs: 2000 }];
  const before = structuredClone(cues);
  const result = await analyzeTextStructure({ ...input(), cues, client: async () => ({ candidates: [{ ...item, lastCue: 4 }], issues: [] }) });
  assert.equal(result.candidates[0].text, '这个，69.9元！Hello world');
  assert.deepEqual(cues, before);
  assert.deepEqual([result.candidates[0].startMs, result.candidates[0].endMs], [0, 2000]);
});
test('keeps distinct cue-bounded functions and evidenced overlap as separate candidates', async () => {
  const cues = [{ text: '之前容易漏水', startMs: 20000, endMs: 23000 }, { text: '这款密封更严', startMs: 23000, endMs: 27000 }];
  const details = { ...item.details, reason: '模拟表达' };
  const result = await analyzeTextStructure({ ...input(), rangeStartMs: 20000, rangeEndMs: 27000, cues, client: async () => ({ candidates: [
    { firstCue: 0, lastCue: 0, tags: ['痛点'], details },
    { firstCue: 1, lastCue: 1, tags: ['卖点'], details },
    { firstCue: 0, lastCue: 1, tags: ['钩子'], details },
  ], issues: [] }) });
  assert.deepEqual(result.candidates.map(c => [c.startMs, c.endMs, c.tags]), [
    [20000, 23000, ['痛点']], [20000, 27000, ['钩子']], [23000, 27000, ['卖点']],
  ]);
  assert.ok(result.candidates.every(c => c.version === result.version));
});
test('rejects missing client, truncated output, invented cue and unknown tag', async () => {
  await assert.rejects(analyzeTextStructure(input()), { code: 'MODEL_CLIENT_UNAVAILABLE' });
  await assert.rejects(analyzeTextStructure({ ...input(), client: async () => ({ truncated: true, candidates: [] }) }));
  await assert.rejects(analyzeTextStructure({ ...input(), client: async () => ({ candidates: [{ ...item, lastCue: 4 }], issues: [] }) }));
  await assert.rejects(analyzeTextStructure({ ...input(), client: async () => ({ candidates: [{ ...item, tags: ['产品演示'] }], issues: [] }) }));
});
test('does not silently clip ASR outside the selected interval', async () => {
  await assert.rejects(analyzeTextStructure({ ...input(), rangeEndMs: 1500, client: async () => ({ candidates: [] }) }));
});
test('injected DeepSeek client uses only fake fetch and returns parsed output', async () => {
  let reads = 0;
  const client = createDeepSeekTextClient({ getConfig: async () => { reads++; return { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'fake' }; }, fetch: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/responses');
    const body = JSON.parse(options.body);
    assert.equal(body.input[0].role, 'system');
    assert.equal(body.max_output_tokens, 16384);
    assert.deepEqual(body.reasoning, { effort: 'low' });
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ candidates: [item], issues: [] }) }] }] }) };
  } });
  assert.equal(reads, 0);
  assert.equal((await analyzeTextStructure({ ...input(), client })).candidates.length, 1);
  assert.equal(reads, 1);
});
test('output limit rejects an incomplete response without retrying', async () => {
  let calls = 0;
  const client = createDeepSeekTextClient({ getConfig: async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'fake' }), fetch: async () => {
    calls++;
    return { ok: true, json: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ content: [{ type: 'output_text', text: '{"candidates":[]' }] }] }) };
  } });
  await assert.rejects(client({ system: 'synthetic', input: 'synthetic' }), { code: 'MODEL_INCOMPLETE' });
  assert.equal(calls, 1);
});
test('text timeout covers the body and emits only safe response usage without retrying', async () => {
  const receipts = []; let calls = 0;
  const config = async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'fake-secret' });
  const client = createDeepSeekTextClient({ getConfig: config, timeoutMs: 10, fetch: async (_url, options) => {
    calls++; assert.ok(options.signal);
    return { ok: true, status: 200, json: async () => ({ id: 'mock-id', status: 'completed', usage: { input_tokens: 2, output_tokens: 3, private: 'fake-secret' }, output: [{ content: [{ type: 'output_text', text: '{}' }] }] }) };
  } });
  await client({ system: 'mock', input: 'mock', onReceipt: receipt => receipts.push(receipt) });
  assert.equal(receipts[0].requestId, 'mock-id'); assert.deepEqual(receipts[0].usage, { input_tokens: 2, output_tokens: 3 }); assert.ok(!JSON.stringify(receipts).includes('fake-secret'));
  const hanging = createDeepSeekTextClient({ getConfig: config, timeoutMs: 10, fetch: async () => {
    calls++; return { ok: true, status: 200, json: async () => new Promise(() => {}) };
  } });
  await assert.rejects(hanging({ system: 'mock', input: 'mock' }), { code: 'MODEL_TIMEOUT' });
  assert.equal(calls, 2);
});
test('configuration and transport errors do not expose secrets', async () => {
  const broken = createDeepSeekTextClient({ getConfig: async () => { throw Error('secret'); }, fetch: async () => {} });
  await assert.rejects(broken({}), { code: 'MODEL_CLIENT_UNAVAILABLE', message: 'DeepSeek 模型配置不可用' });
  const client = createDeepSeekTextClient({ getConfig: async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'secret' }), fetch: async () => { throw Error('secret'); } });
  await assert.rejects(client({}), { code: 'MODEL_NETWORK', message: '模型网络请求失败' });
});
test('fake responses yield only safe error categories', async () => {
  const config = async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'fake-secret' });
  for (const [fetch, code] of [
    [async () => { throw Object.assign(Error('fake-secret'), { name: 'TimeoutError' }); }, 'MODEL_TIMEOUT'],
    [async () => ({ ok: false, status: 429, json: async () => { throw Error('must not read body'); } }), 'MODEL_HTTP'],
    [async () => ({ ok: true, json: async () => ({ status: 'incomplete', output: 'synthetic-private' }) }), 'MODEL_INCOMPLETE'],
    [async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'synthetic-private' }] }] }) }), 'MODEL_INVALID_JSON'],
  ]) {
    const client = createDeepSeekTextClient({ getConfig: config, fetch });
    await assert.rejects(client({}), error => error.code === code && !JSON.stringify(error).includes('fake-secret') && !error.message.includes('synthetic-private'));
  }
});
