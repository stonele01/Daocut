import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeTextStructure, combineTextStructureWindows, createDeepSeekTextClient, recoverDeepSeekTextResponse, textStructureRequest, textStructureWindows, TEXT_CUE_ENCODING, LEGACY_TEXT_CUE_ENCODING, TEXT_STRUCTURE_PROMPT } from './text-structure.mjs';

const input = () => ({ sourceId: 's', productId: 'p', intervalId: 'i', rangeStartMs: 0, rangeEndMs: 3000, cues: [{ text: '你看这个', startMs: 0, endMs: 1000 }, { text: '价格十元', startMs: 1000, endMs: 2000 }] });
const item = { firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['价格锚点'], details: { subtypes: ['普通报价'], reason: '提及价格', evidence: ['ASR'], context: '', repetition: '', review: [] } };

const compact = candidates => ({ schema: 'complete-speech-v1', candidates, issues: [] });

test('new requests carry explicit window-local indices and inclusive boundaries without mutating source cues', async () => {
  const args = input();
  args.cues[0].index = 91;
  const before = structuredClone(args);
  const result = await analyzeTextStructure({ ...args, cueIndexOffset: 90, client: async request => {
    assert.deepEqual(request, textStructureRequest(args));
    const body = JSON.parse(request.input);
    assert.deepEqual(body.cues, args.cues.map((cue, index) => ({ ...cue, index })));
    assert.deepEqual(body.cueIndexing, { base: 0, first: 0, last: 1, reference: 'cues.index', endInclusive: true });
    return compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'] }]);
  } });
  assert.deepEqual(result.candidates[0].cueRange, [90, 91]);
  assert.equal(result.candidates[0].text, '你看这个价格十元');
  assert.deepEqual(args, before);
});

test('legacy encoding rebuilds original request bytes and recovers a saved reply offline', async () => {
  const args = input(), prompt = 'frozen exact prompt';
  const oldInput = JSON.stringify({ sourceId: args.sourceId, productId: args.productId, intervalId: args.intervalId, rangeStartMs: args.rangeStartMs, rangeEndMs: args.rangeEndMs, cues: args.cues });
  const request = textStructureRequest({ ...args, prompt, cueEncoding: LEGACY_TEXT_CUE_ENCODING });
  assert.deepEqual(request, { system: prompt, input: oldInput });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const rawText = JSON.stringify(compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['福利机制'] }]));
  const receipt = { responseVersion: 'deepseek-text-receipt-v1', provider: 'deepseek', status: 'completed', httpStatus: 200, rawText, rawTextSha256: hash(rawText), inputSha256: hash(JSON.stringify([prompt, oldInput])) };
  const recovered = await analyzeTextStructure({ ...args, prompt, cueEncoding: LEGACY_TEXT_CUE_ENCODING, client: async rebuilt => recoverDeepSeekTextResponse(receipt, rebuilt) });
  assert.equal(recovered.candidates[0].text, '你看这个价格十元');
  assert.throws(() => recoverDeepSeekTextResponse(receipt, textStructureRequest({ ...args, prompt })), { code: 'MODEL_INPUT_CHANGED' });
});

test('indexed window byte budgets include index digit growth and reset indices for each overlapping window', () => {
  const cues = Array.from({ length: 105 }, (_, index) => ({ text: '完整句子。', startMs: index * 100, endMs: (index + 1) * 100, index: 900 + index }));
  const args = { ...input(), cues, rangeEndMs: 10500, prompt: 'synthetic prompt', contextCues: 2 };
  const bytes = request => Buffer.byteLength(request.system, 'utf8') + Buffer.byteLength(request.input, 'utf8');
  const maxInputBytes = bytes(textStructureRequest({ ...args, cues: cues.slice(0, 100) }));
  const windows = textStructureWindows({ ...args, maxInputBytes });
  assert.deepEqual(windows.map(window => [window.firstCue, window.lastCue]), [[0, 99], [98, 104]]);
  assert.equal(windows[0].bytes, maxInputBytes);
  assert.equal(textStructureWindows({ ...args, maxInputBytes: maxInputBytes - 1 })[0].lastCue, 98);
  for (const window of windows) {
    const request = textStructureRequest({ ...args, cues: window.cues });
    const body = JSON.parse(request.input);
    assert.equal(window.bytes, bytes(request));
    assert.ok(window.bytes <= maxInputBytes);
    assert.deepEqual(body.cues.map(cue => cue.index), window.cues.map((_, index) => index));
    assert.equal(body.cueIndexing.last, window.cues.length - 1);
    assert.deepEqual(window.cues, cues.slice(window.firstCue, window.lastCue + 1));
  }
  assert.throws(() => textStructureWindows({ ...args, cues: [{ ...cues[0], text: '超长'.repeat(maxInputBytes) }], maxInputBytes }), { code: 'MODEL_INPUT_TOO_LARGE' });
});

test('legacy window boundaries retain the original byte budget without indexed overhead', () => {
  const cues = Array.from({ length: 12 }, (_, index) => ({ text: '旧字幕。', startMs: index * 100, endMs: (index + 1) * 100 }));
  const args = { ...input(), cues, rangeEndMs: 1200, prompt: 'frozen', contextCues: 2, cueEncoding: LEGACY_TEXT_CUE_ENCODING };
  const originalInput = JSON.stringify({ sourceId: args.sourceId, productId: args.productId, intervalId: args.intervalId, rangeStartMs: args.rangeStartMs, rangeEndMs: args.rangeEndMs, cues: cues.slice(0, 10) });
  const maxInputBytes = Buffer.byteLength(args.prompt, 'utf8') + Buffer.byteLength(originalInput, 'utf8');
  const windows = textStructureWindows({ ...args, maxInputBytes });
  assert.deepEqual(windows.map(window => [window.firstCue, window.lastCue]), [[0, 9], [8, 11]]);
  assert.equal(windows[0].bytes, maxInputBytes);
  for (const window of windows) {
    const request = textStructureRequest({ ...args, cues: window.cues });
    assert.equal(window.bytes, Buffer.byteLength(request.system, 'utf8') + Buffer.byteLength(request.input, 'utf8'));
    assert.equal(Object.hasOwn(JSON.parse(request.input), 'cueIndexing'), false);
  }
});

test('bad references identify the candidate and allowed range without guessing an offset or retrying', async () => {
  for (const cueEncoding of [TEXT_CUE_ENCODING, LEGACY_TEXT_CUE_ENCODING]) for (const [firstCue, lastCue] of [[0, 2], [1, 2], [-1, 0], [1, 0], [0.5, 1], [0, '1']]) {
    let calls = 0;
    await assert.rejects(analyzeTextStructure({ ...input(), cueEncoding, client: async () => {
      calls++;
      return compact([{ firstCue: 0, lastCue: 0, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'] }, { firstCue, lastCue, tags: ['卖点'] }]);
    } }), error => {
      assert.equal(error.code, 'MODEL_CONSTRAINT');
      assert.match(error.message, /第 2 个候选/);
      assert.match(error.message, /firstCue=.*lastCue=.*允许 0–1/);
      assert.equal(error.cueIssue.row, 2);
      assert.deepEqual([error.cueIssue.min, error.cueIssue.max], [0, 1]);
      if (typeof firstCue === 'number') assert.equal(error.cueIssue.first, firstCue);
      if (typeof lastCue === 'number') assert.equal(error.cueIssue.last, lastCue);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('an unknown cue encoding fails before invoking the client', async () => {
  let calls = 0;
  const args = { ...input(), cueEncoding: 'unknown' };
  assert.throws(() => textStructureRequest(args), { code: 'MODEL_INPUT_CHANGED' });
  assert.throws(() => textStructureWindows(args), { code: 'MODEL_INPUT_CHANGED' });
  await assert.rejects(analyzeTextStructure({ ...args, client: async () => { calls++; return compact([]); } }), { code: 'MODEL_INPUT_CHANGED' });
  assert.equal(calls, 0);
});

test('compact whole-speech result keeps necessary context in one exact range without model explanations', async () => {
  const cues = [{ text: '以前放包里容易漏水。', startMs: 0, endMs: 1000 }, { text: '这个密封圈解决了刚才的问题。', startMs: 1000, endMs: 2000 }];
  const before = structuredClone(cues);
  const result = await analyzeTextStructure({ ...input(), cues, client: async () => compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['痛点', '卖点'] }]) });
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

test('sentence-sized material stays separate while a dependent phrase retains only its necessary context', async () => {
  const cues = [
    { startMs: 0, endMs: 2000, text: '泵头可以单手按。' },
    { startMs: 2000, endMs: 4000, text: '瓶身透明，余量看得见。' },
    { startMs: 4000, endMs: 6000, text: '以前放包里怕漏。' },
    { startMs: 6000, endMs: 8000, text: '这个锁扣解决了刚才的问题。' },
    { startMs: 8000, endMs: 10000, text: '平时一瓶的价，今天同款两瓶这个价。' },
  ];
  const before = structuredClone(cues);
  const result = await analyzeTextStructure({ ...input(), cues, rangeEndMs: 10000, client: async request => {
    assert.match(request.system, /一句能独立理解就单独保留/);
    assert.match(request.system, /重点找价格对比/);
    assert.deepEqual(JSON.parse(request.input).cues, cues.map((cue, index) => ({ ...cue, index })));
    return compact([
      { firstCue: 0, lastCue: 0, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'] },
      { firstCue: 1, lastCue: 1, subject: { kind: 'self', evidence: [1] }, tags: ['卖点'] },
      { firstCue: 2, lastCue: 3, subject: { kind: 'self', evidence: [2] }, tags: ['痛点', '卖点'] },
      { firstCue: 4, lastCue: 4, subject: { kind: 'self', evidence: [4] }, tags: ['福利机制', '钩子'] },
    ]);
  } });
  assert.deepEqual(result.candidates.map(c => c.cueRange), [[0, 0], [1, 1], [2, 3], [4, 4]]);
  assert.equal(result.candidates[2].text, cues[2].text + cues[3].text);
  assert.deepEqual(result.candidates[3].details.composition.coreIds, [], 'a price-comparison hook is not counted as a product selling point');
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
    const result = await analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: [tag] }]) });
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
    { firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['福利机制'], conditions },
    { firstCue: 1, lastCue: 1, subject: { kind: 'self', evidence: [1] }, tags: ['卖点'], review: ['必要前文不在当前窗口，无法独立使用'] },
  ]) });
  assert.deepEqual(result.candidates[0].details.composition.conditions, conditions);
  assert.equal(result.candidates[1].details.composition.status, 'pending');
  assert.match(result.candidates[1].details.review.join(''), /必要前文/);
});

test('compact contract rejects unsupported output, bad ranges and unverified visual labels', async () => {
  for (const response of [
    { ...compact([]), schema: 'complete-speech-future' },
    compact([{ firstCue: 0, lastCue: 3, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'] }]),
    compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['产品演示'] }]),
    compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['福利机制'], conditions: { price: {} } }]),
    compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'], review: '缺前文' }]),
  ]) await assert.rejects(analyzeTextStructure({ ...input(), client: async () => response }), { code: 'MODEL_CONSTRAINT' });
});

test('legacy empty context remains legacy and normalized complete results survive saved replay', async () => {
  const legacy = await analyzeTextStructure({ ...input(), client: async () => ({ candidates: [item], issues: [] }) });
  assert.equal(legacy.candidates[0].details.composition, undefined);
  const fresh = await analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'] }]) });
  const candidate = fresh.candidates[0];
  const reopened = await analyzeTextStructure({ ...input(), client: async () => ({ candidates: [{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: candidate.tags, details: candidate.details }], issues: fresh.issues }) });
  assert.deepEqual(reopened.candidates[0].details, candidate.details);
  assert.equal(reopened.candidates[0].text, candidate.text);
  assert.equal(reopened.schema, 'complete-speech-v1');
});

test('overlapping compact windows retain unresolved context and conflicting offer conditions', async () => {
  const make = candidate => analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['福利机制'], ...candidate }]) });
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
  const fresh = await analyzeTextStructure({ ...input(), client: async () => compact([{ firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['卖点'] }]) });
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
    assert.equal(system, TEXT_STRUCTURE_PROMPT);
    assert.match(system, /当前没有图片或音频/);
    assert.match(system, /价格机制：.*成交价/);
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
    { firstCue: 0, lastCue: 0, subject: { kind: 'self', evidence: [0] }, tags: ['痛点'], details },
    { firstCue: 1, lastCue: 1, subject: { kind: 'self', evidence: [1] }, tags: ['卖点'], details },
    { firstCue: 0, lastCue: 1, subject: { kind: 'self', evidence: [0] }, tags: ['钩子'], details },
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
    assert.equal(body.max_output_tokens, 65536);
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.deepEqual(body.text, { format: { type: 'json_object' } });
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
test('cached input usage preserves valid counts and keeps missing or invalid values unknown', async () => {
  const request = { system: 'synthetic cache rules', input: 'synthetic cache input' };
  const value = { candidates: [], issues: [] };
  for (const cached of [7, 0, undefined, null, -1, 1.5, '7', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    let receipt, calls = 0;
    const client = createDeepSeekTextClient({
      getConfig: async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-secret' }),
      fetch: async (_url, options) => {
        calls++;
        assert.deepEqual(JSON.parse(options.body).input, [{ role: 'system', content: request.system }, { role: 'user', content: request.input }]);
        return { ok: true, status: 200, json: async () => ({ status: 'completed',
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, private: 'synthetic-secret',
            ...(cached === undefined ? {} : { input_tokens_details: { cached_tokens: cached, private: 'synthetic-secret' } }),
            output_tokens_details: { reasoning_tokens: 2, private: 'synthetic-secret' } },
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }) };
      },
    });
    assert.deepEqual(await client({ ...request, onReceipt: saved => { receipt = saved; } }), value);
    const expected = { input_tokens: 10, output_tokens: 3, total_tokens: 13, output_tokens_details: { reasoning_tokens: 2 } };
    if (cached === 7 || cached === 0) expected.input_tokens_details = { cached_tokens: cached };
    assert.deepEqual(receipt.usage, expected);
    assert.equal(Object.hasOwn(receipt.usage, 'input_tokens_details'), cached === 7 || cached === 0);
    assert.ok(!JSON.stringify(receipt).includes('synthetic-secret'));
    assert.deepEqual(recoverDeepSeekTextResponse(receipt, request), value);
    const oldReceipt = { ...receipt, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
    assert.deepEqual(recoverDeepSeekTextResponse(oldReceipt, request), value, 'old receipts without cache details remain recoverable');
    assert.equal(calls, 1);
  }
});

test('cached input usage reaches saved receipts before incomplete or invalid JSON responses are rejected', async () => {
  for (const [status, text, code] of [['incomplete', '{"candidates":', 'MODEL_INCOMPLETE'], ['completed', 'not JSON', 'MODEL_INVALID_JSON']]) {
    let receipt, calls = 0;
    const client = createDeepSeekTextClient({
      getConfig: async () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'fake' }),
      fetch: async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ status,
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 7 } },
          output: [{ content: [{ type: 'output_text', text }] }] }) };
      },
    });
    await assert.rejects(client({ system: 'synthetic', input: 'synthetic', onReceipt: saved => { receipt = saved; } }), { code });
    assert.deepEqual(receipt.usage, { input_tokens: 10, input_tokens_details: { cached_tokens: 7 } });
    assert.equal(receipt.rawText, text); assert.equal(calls, 1);
  }
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
