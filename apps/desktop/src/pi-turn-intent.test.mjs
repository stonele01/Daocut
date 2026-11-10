import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnToolPolicy } from './pi-turn-intent.mjs';

const text = value => ({ type: 'text', text: value });
const scoped = (patch = {}) => ({
  scope: { sourceId: 'source', productId: 'product-b', intervalId: 'range-b', productName: '商品 B', startMs: 600000, endMs: 620000 },
  transcriptVersion: 'fixture-version', segments: [{ startMs: 601000, endMs: 609000, text: '只给当前商品段的内容' }], ...patch,
});
const envelope = value => `<product_structure_context>${JSON.stringify(value)}</product_structure_context>`;

test('a validated selected-product transcript is text-only for this turn', () => {
  assert.deepEqual(turnToolPolicy([text('分析本段结构\n' + envelope(scoped()))]), { allowTools: false, reason: 'product-structure' });
  assert.deepEqual(turnToolPolicy([text('现在将已选素材加入成片')]), { allowTools: true });
});

test('prose, malformed envelopes, and out-of-scope transcript cannot impersonate the selected-product context', () => {
  for (const value of [
    '请说明 <product_structure_context> 是什么',
    '<product_structure_context>{bad json}</product_structure_context>',
    envelope(scoped({ transcriptVersion: '' })),
    envelope(scoped({ segments: [] })),
    envelope(scoped({ segments: [{ startMs: 599999, endMs: 609000, text: '越界' }] })),
    envelope(scoped({ segments: [{ startMs: 601000, endMs: 620001, text: '越界' }] })),
    envelope(scoped({ segments: [{ startMs: 609000, endMs: 601000, text: '反向' }] })),
    envelope(scoped({ scope: { ...scoped().scope, intervalId: '' } })),
    envelope(scoped()) + envelope(scoped()),
  ]) assert.deepEqual(turnToolPolicy([text(value)]), { allowTools: true });
});

test('complete greetings are conversational regardless of capitalization, spacing, or ordinary punctuation', () => {
  for (const greeting of ['你好', '您好！', '哈喽。', ' hello ', 'HI!', 'Hey?', '\n  你好，\t', '…你好～', 'Hello!!!']) {
    assert.deepEqual(turnToolPolicy([text(greeting)]), { allowTools: false, reason: 'greeting-only' }, greeting);
  }
});

test('the complete current prompt is checked, including text from later blocks', () => {
  assert.deepEqual(turnToolPolicy([text('\n'), text('您好'), text('！')]), { allowTools: false, reason: 'greeting-only' });
  assert.deepEqual(turnToolPolicy([text('你好'), text('帮我把这两段素材剪好放到时间轴')]), { allowTools: true });
  assert.deepEqual(turnToolPolicy([text('帮我剪视频'), text('你好')]), { allowTools: true });
});

test('greetings inside an actual editing request or quoted title never disable tools', () => {
  for (const request of [
    '你好，帮我剪好放到时间轴',
    'Hello, edit these clips.',
    '做一个5秒的你好动画',
    '你好动画',
    '"你好"',
    '“你好”',
    "'hello'",
    '`hi`',
    '片名：你好',
    '你好这个字怎么改',
  ]) assert.deepEqual(turnToolPolicy([text(request)]), { allowTools: true }, request);
});

test('continuations, option replies, and questions keep the ordinary model path', () => {
  for (const reply of ['继续', '1', '可以', '好的', '按之前的剪辑', '你好能做什么？', '你好啊', 'hello-world']) {
    assert.deepEqual(turnToolPolicy([text(reply)]), { allowTools: true }, reply);
  }
});

test('attached images, links, or resources are not discarded when deciding a turn is only a greeting', () => {
  for (const attachment of [
    { type: 'image', mimeType: 'image/png', data: 'fixture' },
    { type: 'resource_link', uri: 'file:///D:/Projects/film.html', name: 'film.html' },
    { type: 'resource', resource: { uri: 'file:///D:/Projects/note.txt', text: '剪成30秒' } },
    { type: 'audio', mimeType: 'audio/wav', data: 'fixture' },
  ]) assert.deepEqual(turnToolPolicy([text('你好'), attachment]), { allowTools: true }, attachment.type);
});

test('empty or malformed prompts are left to existing validation, not treated as greetings', () => {
  for (const blocks of [undefined, null, '你好', [], [text('')], [text(' ! ')], [null], [{}], [{ type: 'text' }]]) {
    assert.deepEqual(turnToolPolicy(blocks), { allowTools: true });
  }
});

test('policy is per-turn, deterministic, and does not mutate prompt blocks or leave a restrictive mode behind', () => {
  const greeting = Object.freeze([Object.freeze(text('你好'))]);
  const continuation = Object.freeze([Object.freeze(text('继续剪辑'))]);
  assert.deepEqual(turnToolPolicy(greeting), { allowTools: false, reason: 'greeting-only' });
  assert.deepEqual(turnToolPolicy(continuation), { allowTools: true });
  assert.deepEqual(turnToolPolicy(greeting), { allowTools: false, reason: 'greeting-only' });
  assert.equal(greeting[0].text, '你好');
});
