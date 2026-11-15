import test from 'node:test';
import assert from 'node:assert/strict';
import { combineDiscoveryWindows, discoverProducts, discoveryWindows, validateDiscoveryCues } from './product-discovery.mjs';

const cues = ['甲商品完整介绍', '甲商品卖点', '乙商品介绍', '乙商品福利', '甲商品回来了', '顺便提及丙'].map((text, index) => ({ text, startMs: index * 1000, endMs: index * 1000 + 900 }));
const product = (key, name, cue, more = {}) => ({ key, name, variant: '', aliases: [], evidence: [cue], ...more });
const lecture = (key, firstCue, lastCue = firstCue) => ({ key, firstCue, lastCue, kind: 'lecture', reason: '原话明确讲解', evidence: [firstCue] });
const window = (firstCue, lastCue) => ({ firstCue, lastCue, coreFirst: firstCue, coreLast: lastCue });
const combine = (windows, results) => combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues, windows, results });

test('A B A retains two disjoint A ranges and an explicit unassigned mention', async () => {
  const output = await discoverProducts({ sourceId: 's', runId: 'r', durationMs: 6000, cues, client: async () => ({ products: [product('a', '甲', 0), product('b', '乙', 2)], ranges: [lecture('a', 0, 1), lecture('b', 2, 3), lecture('a', 4), { key: null, firstCue: 5, lastCue: 5, kind: 'mention', reason: '只是提及', evidence: [5] }], issues: [] }) });
  assert.equal(output.products.length, 2);
  const a = output.products.find(p => p.name === '甲');
  assert.deepEqual(output.intervals.filter(i => i.productId === a.id).map(i => [i.startMs, i.endMs]), [[0, 1900], [4000, 4900]]);
  assert.equal(output.unassigned[0].kind, 'mention');
  assert.ok(output.intervals.every(i => i.review.includes('仅依据转写，画面待核实')));
});

test('overlapping windows join one lecture without duplicating ranges or changing absolute times', () => {
  const output = combine([window(0, 2), window(1, 4)], [
    { products: [product('a', '甲', 0)], ranges: [lecture('a', 0, 2)], issues: [] },
    { products: [product('a', '甲', 1)], ranges: [lecture('a', 1, 4)], issues: [] },
  ]);
  assert.equal(output.products.length, 1);
  assert.deepEqual(output.intervals.map(i => [i.startMs, i.endMs]), [[0, 4900]]);
  assert.equal(output.unassigned[0].startMs, 5000);
});

test('independent same-product ranges remain separate even when cues are adjacent or silence is long', () => {
  const output = combine([window(0, 5)], [{ products: [product('a', '甲', 0)], ranges: [lecture('a', 0), lecture('a', 1)], issues: [] }]);
  assert.equal(output.intervals.length, 2);
  const silentCues = [{ text: '甲第一段', startMs: 0, endMs: 900 }, { text: '甲回场', startMs: 20000, endMs: 21000 }];
  const separated = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 30000, cues: silentCues, windows: [window(0, 0), window(1, 1)], results: [
    { products: [product('a', '甲', 0)], ranges: [lecture('a', 0)], issues: [] },
    { products: [product('a', '甲', 1)], ranges: [lecture('a', 1)], issues: [] },
  ] });
  assert.deepEqual(separated.intervals.map(i => [i.startMs, i.endMs]), [[0, 900], [20000, 21000]]);
});

test('confirmed continuous speech keeps one product across windows despite an uncertain formal name', () => {
  const results = [
    { products: [product('a', '防晒', 0, { identityUncertain: true, nameUncertain: true })], ranges: [{ ...lecture('a', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('a', '防晒乳', 3, { identityUncertain: true, nameUncertain: true })], ranges: [{ ...lecture('a', 3, 5), scopeStatus: 'confirmed' }], issues: [] },
  ];
  const joined = combine([window(0, 2), window(3, 5)], results);
  assert.equal(joined.products.length, 1);
  assert.equal(joined.products[0].identityUncertain, true);
  assert.deepEqual(joined.intervals.map(x => [x.firstCue, x.lastCue]), [[0, 5]]);
  results[1].ranges[0].scopeStatus = 'uncertain';
  assert.equal(combine([window(0, 2), window(3, 5)], results).products.length, 2);
  results[1].ranges[0].scopeStatus = 'confirmed';
  results[1].products[0].variant = '另一个规格';
  assert.equal(combine([window(0, 2), window(3, 5)], results).products.length, 2);
});

test('duplicate model ranges receive one stable interval and conflicting mention stays unassigned', () => {
  const duplicated = combine([window(0, 5)], [{ products: [product('a', '甲', 0)], ranges: [lecture('a', 0), lecture('a', 0)], issues: [] }]);
  assert.equal(duplicated.intervals.length, 1);
  const overlapping = combine([window(0, 5)], [{ products: [product('a', '甲', 0)], ranges: [lecture('a', 0, 2), lecture('a', 1, 3)], issues: [] }]);
  assert.deepEqual(overlapping.intervals.map(i => [i.startMs, i.endMs]), [[0, 3900]], 'same-window overlap is one lecture, adjacent non-overlap is covered separately');
  const conflict = combine([window(0, 2), window(1, 3)], [
    { products: [product('a', '甲', 0)], ranges: [lecture('a', 0, 2)], issues: [] },
    { products: [], ranges: [{ key: null, firstCue: 1, lastCue: 2, kind: 'mention', reason: '只是提及', evidence: [1] }], issues: [] },
  ]);
  assert.equal(conflict.intervals.length, 0);
});

test('a brief acknowledgement at the window boundary does not split a continuous unnamed product', () => {
  const input = cues.map(cue => ({ ...cue })); input[2].text = '是的。'; input[2].startMs = 1950; input[2].endMs = 2100;
  const results = [
    { products: [product('a', '防晒', 0, { nameUncertain: true })], ranges: [{ ...lecture('a', 0, 1), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('a', '防晒', 3, { nameUncertain: true })], ranges: [{ ...lecture('a', 3, 5), scopeStatus: 'confirmed' }], issues: [] },
  ];
  const run = () => combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: input, windows: [window(0, 2), window(3, 5)], results });
  const output = run();
  assert.equal(output.products.length, 1);
  assert.deepEqual(output.intervals.map(range => [range.firstCue, range.lastCue]), [[0, 5]]);
  assert.equal(output.unassigned.length, 0);
  input[2].text = '接下来换另一个产品';
  assert.equal(run().products.length, 2);
  input[2].text = '是的。';
  results[1].products[0].variant = '不同规格';
  assert.equal(run().products.length, 2);
});

test('alias evidence permits a match; missing evidence and different variants do not force a merge', () => {
  const output = combine([window(0, 1), window(2, 3), window(4, 5)], [
    { products: [product('a', '甲洗面奶', 0)], ranges: [lecture('a', 0)], issues: [] },
    { products: [product('alias', '小白管', 2, { matchKey: 'a', matchEvidence: [2], matchReason: '原话说小白管就是甲洗面奶' })], ranges: [lecture('alias', 2)], issues: [] },
    { products: [product('a', '甲洗面奶', 4, { variant: '两件套' })], ranges: [lecture('a', 4)], issues: [] },
  ]);
  assert.equal(output.products.length, 2);
  assert.equal(output.products[0].aliases[0].name, '小白管');
  assert.equal(output.products[0].mergeEvidence[0].evidence[0].startMs, 2000);
  assert.equal(output.products[1].identityUncertain, true);
  const uncertain = combine([window(0, 1), window(2, 3)], [
    { products: [product('a', '甲', 0)], ranges: [lecture('a', 0)], issues: [] },
    { products: [product('a', '小白管', 2)], ranges: [lecture('a', 2)], issues: [] },
  ]);
  assert.equal(uncertain.products.length, 2);
});

test('cross-window conflicting product evidence is unassigned rather than silently chosen', () => {
  const output = combine([window(0, 2), window(1, 3)], [
    { products: [product('a', '甲', 0)], ranges: [lecture('a', 0, 2)], issues: [] },
    { products: [product('b', '乙', 1)], ranges: [lecture('b', 1, 3)], issues: [] },
  ]);
  assert.equal(output.intervals.length, 0);
  assert.equal(output.unassigned.filter(i => i.kind === 'mixed').length, 2);
});

test('invalid cue times fail before the client; invalid references never become candidates', async () => {
  let calls = 0;
  for (const bad of [{ startMs: -1, endMs: 3 }, { startMs: 2, endMs: 1 }, { startMs: 0, endMs: 7000 }]) await assert.rejects(discoverProducts({ sourceId: 's', runId: 'r', durationMs: 6000, cues: [{ text: 'bad', ...bad }], client: async () => { calls++; } }), /时间/);
  assert.equal(calls, 0);
  for (const range of [lecture('unknown', 0), lecture('a', 0, 99), { ...lecture('a', 0), evidence: [99] }]) assert.throws(() => combine([window(0, 5)], [{ products: [product('a', '甲', 0)], ranges: [range], issues: [] }]));
});

test('UTF-8 budget uses cue boundaries with context and covers every core cue once', () => {
  const numbered = validateDiscoveryCues(Array.from({ length: 15 }, (_, n) => ({ text: '较长的直播转写'.repeat(5), startMs: n * 1000, endMs: n * 1000 + 900 })), 15000);
  const windows = discoveryWindows(numbered, { maxBytes: 800, contextCues: 2 });
  assert.ok(windows.length > 1);
  assert.deepEqual(windows.flatMap(w => Array.from({ length: w.coreLast - w.coreFirst + 1 }, (_, n) => w.coreFirst + n)), numbered.map(c => c.index));
  assert.ok(windows.every(w => Buffer.byteLength(JSON.stringify(w.cues), 'utf8') <= 800));
  assert.ok(windows.slice(1).some(w => w.firstCue < w.coreFirst));
});
