import test from 'node:test';
import assert from 'node:assert/strict';
import { combineDiscoveryWindows, discoverProducts, discoveryWindows, validateDiscoveryCues } from './product-discovery.mjs';

const cues = ['甲商品完整介绍', '甲商品卖点', '乙商品介绍', '乙商品福利', '甲商品回来了', '顺便提及丙'].map((text, index) => ({ text, startMs: index * 1000, endMs: index * 1000 + 900 }));
const product = (key, name, cue, more = {}) => ({ key, name, variant: '', aliases: [], evidence: [cue], ...more });
const lecture = (key, firstCue, lastCue = firstCue) => ({ key, firstCue, lastCue, kind: 'lecture', reason: '原话明确讲解', evidence: [firstCue] });
const window = (firstCue, lastCue) => ({ firstCue, lastCue, coreFirst: firstCue, coreLast: lastCue });
const combine = (windows, results) => combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues, windows, results });

for (const switchText of ['', '来，下一个商品']) test(`transport boundary keeps a cleaner lecture unless an actual switch is spoken: ${switchText || 'no switch'}`, () => {
  const input = ['来，追觅洗地机', '吸力很大', '我以前买的要3899', switchText || '月月以前买的4180', '今天补贴1699', '水箱800毫升'].map((text, index) => ({ text, startMs: index * 1000, endMs: index * 1000 + 900 }));
  const output = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: input, windows: [window(0, 2), window(3, 5)], results: [
    { products: [product('p51', '追觅洗地机', 0, { variant: '28000帕/60分钟', identityUncertain: true })], ranges: [{ ...lecture('p51', 0, 2), scopeStatus: 'confirmed', reason: '窗口末仍在讲价，未完' }], issues: [] },
    { products: [product('p50', '洗地机', 3, { variant: '800毫升/两年质保', identityUncertain: true })], ranges: [{ ...lecture('p50', 3, 5), scopeStatus: 'confirmed', reason: '继续讲价格、补贴、质保和水箱' }], issues: [] },
  ] });
  assert.equal(output.intervals.length, switchText ? 2 : 1);
  if (!switchText) assert.deepEqual([output.intervals[0].firstCue, output.intervals[0].lastCue], [0, 5]);
});

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

test('same product continues within one window unless there is evidence of a switch; long silence remains separate', () => {
  const output = combine([window(0, 5)], [{ products: [product('a', '甲', 0)], ranges: [lecture('a', 0), lecture('a', 1)], issues: [] }]);
  assert.equal(output.intervals.length, 1);
  const explicitSwitch = cues.map(cue => ({ ...cue })); explicitSwitch[1].text = '接下来换一个商品';
  const switched = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: explicitSwitch, windows: [window(0, 5)], results: [{ products: [product('a', '甲', 0)], ranges: [lecture('a', 0), lecture('a', 1)], issues: [] }] });
  assert.equal(switched.intervals.length, 2);
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
  assert.equal(combine([window(0, 2), window(3, 5)], results).products.length, 1, 'a model specification label is not spoken switching evidence');
});

test('adjacent same-name continuation preserves differing variant descriptions for review', () => {
  const output = combine([window(0, 2), window(3, 5)], [
    { products: [product('a', '美白系列', 0, { variant: '第四代/升级版' })], ranges: [{ ...lecture('a', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('a', '美白系列', 3, { variant: '第四代/套装' })], ranges: [{ ...lecture('a', 3, 5), scopeStatus: 'confirmed' }], issues: [] },
  ]);
  assert.equal(output.products.length, 1);
  assert.equal(output.intervals.length, 1);
  assert.ok(output.products[0].review.some(text => text.includes('规格描述有差异')));
  assert.equal(output.products[0].variantObservations[0].variant, '第四代/套装');
});

test('continuous same-name down jacket keeps one lecture when matching measurements are worded differently', () => {
  const results = [
    { products: [product('a', '皇家至尊羽绒服', 0, { variant: '口述充绒300克/蓬松度800+/绒子含量95%', identityUncertain: true })], ranges: [{ ...lecture('a', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('a', '皇家至尊羽绒服', 3, { variant: '雁鸭绒/95%绒子/充绒300多克/蓬松度800+', identityUncertain: true })], ranges: [{ ...lecture('a', 3, 5), scopeStatus: 'confirmed' }], issues: [] },
  ];
  const joined = combine([window(0, 2), window(3, 5)], results);
  assert.equal(joined.products.length, 1);
  assert.equal(joined.intervals.length, 1);
  assert.equal(joined.products[0].variantObservations.length, 1);
  const switchedCues = cues.map(cue => ({ ...cue })); switchedCues[2].text = '这件讲完了，换下一个商品';
  const switched = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: switchedCues, windows: [window(0, 2), window(3, 5)], results });
  assert.equal(switched.products.length, 2, 'an explicit product switch blocks merging even when measurements match');
  results[1].products[0].variant = '雁鸭绒/95%绒子/充绒350克/蓬松度800+';
  const disputed = combine([window(0, 2), window(3, 5)], results);
  assert.equal(disputed.intervals.length, 1);
  assert.ok(disputed.products[0].review.some(note => note.includes('规格差异待核对')));
});

test('same product across idle chat remains one lecture without deleting the chat', () => {
  const input = cues.map(cue => ({ ...cue })); input[2].text = '感谢大家的支持'; input[3].text = '我们聊一下近况';
  const windows = [window(0, 3), window(2, 5)];
  const results = [
    { products: [product('a', '羽绒服', 0, { variant: '蓬松度700' })], ranges: [{ ...lecture('a', 0, 1), scopeStatus: 'confirmed' }, { key: null, firstCue: 2, lastCue: 3, kind: 'transition', reason: '闲聊', evidence: [2] }], issues: [] },
    { products: [product('a', '羽绒服', 4, { variant: '衣长75公分' })], ranges: [{ ...lecture('a', 4, 5), scopeStatus: 'confirmed' }], issues: [] },
  ];
  const output = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: input, windows, results });
  assert.equal(output.products.length, 1);
  assert.deepEqual(output.intervals.map(item => [item.firstCue, item.lastCue]), [[0, 5]]);
  assert.ok(output.unassigned.some(item => item.firstCue === 2 && item.lastCue === 3), 'the original chat remains separately identifiable');
  assert.equal(output.products[0].variantObservations[0].variant, '衣长75公分');
  results[0].ranges[1] = { key: null, firstCue: 2, lastCue: 3, kind: 'mixed', reason: '商品归属不明', evidence: [2] };
  const unclear = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: input, windows, results });
  assert.equal(unclear.products.length, 2, 'uncertain mixed goods are not silently merged');
});

test('an evidenced alias and an overlapping continuation survive window key changes', () => {
  const input = cues.map(cue => ({ ...cue })); input[2].text = '我要买四件，一家人都穿';
  const windows = [window(0, 2), window(2, 4), window(4, 5)];
  const results = [
    { products: [product('p', '排骨羽绒服', 0, { variant: '153克/62公分', identityUncertain: true, nameUncertain: true })], ranges: [{ ...lecture('p', 0, 1), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('p', '品牌排骨羽绒服', 3, { variant: '153克/62公分', identityUncertain: true, nameUncertain: true, aliases: [{ name: '排骨羽绒服', evidence: [3] }] })], ranges: [{ ...lecture('p', 3, 4), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('p@20', '排骨款', 4, { variant: '150多克/男女同款', identityUncertain: true, nameUncertain: true })], ranges: [{ ...lecture('p@20', 4, 5), scopeStatus: 'confirmed' }], issues: [] },
  ];
  const output = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: input, windows, results });
  assert.equal(output.products.length, 1);
  assert.deepEqual(output.intervals.map(item => [item.firstCue, item.lastCue]), [[0, 5]]);
  assert.ok(output.intervals[0].startMs <= input[2].startMs && output.intervals[0].endMs >= input[2].endMs, 'the intervening speech remains in the original range');
  const conflicting = structuredClone(results);
  conflicting[2].products.push(product('other', '另一件商品', 4));
  conflicting[2].ranges.push({ ...lecture('other', 4, 5), scopeStatus: 'confirmed' });
  const blocked = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: input, windows, results: conflicting });
  assert.ok(blocked.unassigned.some(item => item.kind === 'mixed'), 'conflicting product evidence remains reviewable');
});

test('changed window keys and names do not manufacture a switch without spoken evidence', () => {
  const output = combine([window(0, 2), window(3, 5)], [
    { products: [product('a', '香水洗发水', 0)], ranges: [{ ...lecture('a', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('b', '江南印象洗发水', 3)], ranges: [{ ...lecture('b', 3, 5), scopeStatus: 'confirmed' }], issues: [] },
  ]);
  assert.equal(output.products.length, 1);
  assert.ok(output.products[0].review.some(note => note.includes('实际换品信号')));
  const unrelated = combine([window(0, 2), window(3, 5)], [
    { products: [product('a', '香水洗发水', 0)], ranges: [{ ...lecture('a', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('b', '羽绒服', 3)], ranges: [{ ...lecture('b', 3, 5), scopeStatus: 'confirmed' }], issues: [] },
  ]);
  assert.ok(!unrelated.issues.some(note => note.includes('名称或规格不同')));
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
  assert.equal(run().products.length, 1);
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

test('a product-key disagreement at a transport seam retains one lecture absent a switch', () => {
  const output = combine([window(0, 2), window(2, 5)], [
    { products: [product('a', '面霜甲', 0)], ranges: [{ ...lecture('a', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('b', '面霜乙', 3)], ranges: [{ ...lecture('b', 2, 5), evidence: [3], scopeStatus: 'confirmed' }], issues: [] },
  ]);
  assert.deepEqual(output.intervals.map(i => [i.firstCue, i.lastCue]), [[0, 5]]);
  assert.equal(output.unassigned.filter(i => i.kind === 'mixed').length, 0);
  assert.ok(output.intervals.every(i => i.evidence.every(e => e.cue >= i.firstCue && e.cue <= i.lastCue)));
});

test('a context transition at a confirmed lecture start does not hide the whole lecture', () => {
  const output = combine([window(0, 2), window(2, 5)], [
    { products: [], ranges: [{ key: null, firstCue: 0, lastCue: 2, kind: 'transition', reason: '等待上架', evidence: [2] }], issues: [] },
    { products: [product('a', '洗发水', 3)], ranges: [{ ...lecture('a', 2, 5), scopeStatus: 'confirmed', evidence: [3, 5] }], issues: [] },
  ]);
  assert.deepEqual(output.intervals.map(i => [i.firstCue, i.lastCue, i.scopeStatus]), [[3, 5, 'confirmed']]);
  assert.ok(!output.unassigned.some(i => i.firstCue <= 5 && i.lastCue >= 3));
});

test('conflicting measurements at a continuous transport seam remain observations for review', () => {
  const output = combine([window(0, 2), window(2, 5)], [
    { products: [product('a', '羽绒服', 0, { variant: '充绒150克', identityUncertain: true })], ranges: [{ ...lecture('a', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('a', '羽绒服', 3, { variant: '充绒350克', identityUncertain: true })], ranges: [{ ...lecture('a', 2, 5), scopeStatus: 'confirmed' }], issues: [] },
  ]);
  assert.equal(output.products.length, 1);
  assert.equal(output.products[0].variantObservations[0].variant, '充绒350克');
  assert.ok(output.products[0].review.some(note => note.includes('规格差异待核对')));
});

for (const signal of ['这款讲完了，换下一个商品', '切换到另一款商品', '换到下一款', '下一件我们看这个']) test(`actual switch preserves distinct lectures: ${signal}`, () => {
  const input = cues.map(cue => ({ ...cue })); input[2].text = signal;
  const output = combineDiscoveryWindows({sourceId:'s',runId:'r',durationMs:6000,cues:input,windows:[window(0,2),window(2,5)],results:[
    {products:[product('a','羽绒服',0)],ranges:[{...lecture('a',0,2),scopeStatus:'confirmed'}],issues:[]},
    {products:[product('a','羽绒服',3)],ranges:[{...lecture('a',2,5),scopeStatus:'confirmed'}],issues:[]},
  ]});
  assert.equal(output.intervals.length, 2);
});

for (const speech of ['等会儿下一个商品是面霜，这个洗地机继续看', '不要换下一个，这款还没讲完', '下一个颜色是白色', '要不要看下一个，先把这个讲完']) test(`preview or option does not split a continuous lecture: ${speech}`, () => {
  const input = cues.map(cue => ({ ...cue })); input[2].text = speech;
  const output = combineDiscoveryWindows({ sourceId: 's', runId: 'r', durationMs: 6000, cues: input, windows: [window(0, 2), window(2, 5)], results: [
    { products: [product('first', '追觅洗地机', 0)], ranges: [{ ...lecture('first', 0, 2), scopeStatus: 'confirmed' }], issues: [] },
    { products: [product('second', '洗地机', 3)], ranges: [{ ...lecture('second', 2, 5), scopeStatus: 'confirmed' }], issues: [] },
  ] });
  assert.equal(output.intervals.length, 1);
});

test('mixed evidence in the incoming window blocks chat continuation', () => {
  const input = cues.map(cue=>({...cue})); input[2].text='聊一下'; input[3].text='现在继续';
  const output = combineDiscoveryWindows({sourceId:'s',runId:'r',durationMs:6000,cues:input,windows:[window(0,3),window(2,5)],results:[
    {products:[product('a','羽绒服',0,{identityUncertain:true})],ranges:[{...lecture('a',0,1),scopeStatus:'confirmed'}],issues:[]},
    {products:[product('a','羽绒服',4,{identityUncertain:true})],ranges:[{key:null,firstCue:2,lastCue:3,kind:'mixed',reason:'商品归属不明',evidence:[2]},{...lecture('a',4,5),scopeStatus:'confirmed'}],issues:[]},
  ]});
  assert.equal(output.products.length,2);
  assert.equal(output.intervals.length,2);
});

for (const kind of ['mention', 'uncertain']) test(`${kind} speech between confirmed lectures stays unassigned`, () => {
  const input=cues.map(cue=>({...cue}));input[2].text='顺便说下另一款';input[3].text='现在继续';
  const output=combineDiscoveryWindows({sourceId:'s',runId:'r',durationMs:6000,cues:input,windows:[window(0,5)],results:[
    {products:[product('a','羽绒服',0)],ranges:[{...lecture('a',0,1),scopeStatus:'confirmed'},{key:null,firstCue:2,lastCue:3,kind,reason:'未确认归属',evidence:[2]},{...lecture('a',4,5),scopeStatus:'confirmed'}],issues:[]},
  ]});
  assert.deepEqual(output.intervals.map(i=>[i.firstCue,i.lastCue]),[[0,1],[4,5]]);
  assert.ok(output.unassigned.some(i=>i.kind===kind&&i.firstCue===2&&i.lastCue===3));
});

test('same-window idle chat can retain one confirmed lecture', () => {
  const input=cues.map(cue=>({...cue}));input[2].text='感谢大家支持';input[3].text='聊聊近况';
  const output=combineDiscoveryWindows({sourceId:'s',runId:'r',durationMs:6000,cues:input,windows:[window(0,5)],results:[
    {products:[product('a','羽绒服',0)],ranges:[{...lecture('a',0,1),scopeStatus:'confirmed'},{key:null,firstCue:2,lastCue:3,kind:'transition',reason:'闲聊',evidence:[2]},{...lecture('a',4,5),scopeStatus:'confirmed'}],issues:[]},
  ]});
  assert.deepEqual(output.intervals.map(i=>[i.firstCue,i.lastCue]),[[0,5]]);
  assert.ok(output.unassigned.some(i=>i.firstCue===2&&i.lastCue===3));
});

test('an explicit product transition is not treated as idle chat without a switch keyword in ASR', () => {
  const input=cues.map(cue=>({...cue})); input[2].text='这件介绍完了'; input[3].text='大家稍等一会儿';
  const output=combineDiscoveryWindows({sourceId:'s',runId:'r',durationMs:6000,cues:input,windows:[window(0,5)],results:[
    {products:[product('a','羽绒服',0)],ranges:[{...lecture('a',0,1),scopeStatus:'confirmed'},
      {key:null,firstCue:2,lastCue:3,kind:'transition',reason:'转入其他商品，随后返场',evidence:[2]},
      {...lecture('a',4,5),scopeStatus:'confirmed'}],issues:[]},
  ]});
  assert.deepEqual(output.intervals.map(i=>[i.firstCue,i.lastCue]),[[0,1],[4,5]]);
  assert.ok(output.unassigned.some(i=>i.kind==='transition'&&i.firstCue===2&&i.lastCue===3));
});

test('different keys at a continuous generic-name window seam are not new switching evidence', () => {
  const output=combine([window(0,2),window(2,5)],[
    {products:[product('first','面霜',0,{identityUncertain:true})],ranges:[{...lecture('first',0,2),scopeStatus:'confirmed'}],issues:[]},
    {products:[product('second','面霜',3,{identityUncertain:true})],ranges:[{...lecture('second',2,5),scopeStatus:'confirmed',evidence:[3]}],issues:[]},
  ]);
  assert.equal(output.products.length,1);
  assert.equal(output.unassigned.filter(i=>i.kind==='mixed').length,0);
  assert.deepEqual(output.intervals.map(i=>[i.firstCue,i.lastCue]),[[0,5]]);
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
