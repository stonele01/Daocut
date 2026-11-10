import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readProductChatContext, productChatContextRoute } from './product-chat-context.mjs';
import { PRODUCT_ANALYSIS_FILE } from './product-analysis.mjs';

async function fixture(t) {
  const base = resolve(import.meta.dirname, '../../../../.tmp/product-chat-scope-20261103/server-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'product-chat-context-'));
  t.after(() => {
    const child = relative(base, root);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    return rm(root, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'fetch', () => { throw Error('This read-only test must never make a network request'); });
  await mkdir(join(root, 'assets'));
  const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 15000 };
  const media = join(root, source.assetPath);
  await writeFile(media, 'synthetic, not a real video');
  const data = { version: 1, sources: [source], products: [{ id: 'a', name: '商品 A', sourceIds: ['s'] }, { id: 'b', name: '商品 B', sourceIds: ['s'] }], intervals: [
    { id: 'a1', productId: 'a', sourceId: 's', startMs: 0, endMs: 5000 },
    { id: 'b1', productId: 'b', sourceId: 's', startMs: 5000, endMs: 10000 },
    { id: 'a2', productId: 'a', sourceId: 's', startMs: 10000, endMs: 15000 },
  ], candidates: [] };
  const cues = [{ startMs: 100, endMs: 4000, text: 'A 首段的内容。' }, { startMs: 5100, endMs: 9000, text: 'B 的内容。' }, { startMs: 10100, endMs: 14000, text: 'A 返场的内容。' }];
  const cachePath = join(root, '.film', 'product-transcripts', `${createHash('sha256').update(source.id).digest('hex')}.json`);
  await mkdir(join(root, '.film', 'product-transcripts'), { recursive: true });
  const saveAnalysis = async () => writeFile(join(root, PRODUCT_ANALYSIS_FILE), JSON.stringify(data));
  const saveTranscript = async (patch = {}) => {
    const info = await stat(media);
    const value = { version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint: { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, path: await realpath(media) }, text: cues.map(cue => cue.text).join(''), cues, words: [], ...patch };
    await writeFile(cachePath, JSON.stringify(value));
  };
  const selection = (id = 'a1') => { const { id: intervalId, ...range } = data.intervals.find(range => range.id === id); return { ...range, intervalId }; };
  await saveAnalysis(); await saveTranscript();
  return { root, source, media, data, cues, cachePath, saveAnalysis, saveTranscript, selection };
}

test('A → B → A reads only the selected lecture, keeps absolute time and is read-only on reopen', async t => {
  const f = await fixture(t);
  const before = await Promise.all([readFile(f.cachePath), readFile(join(f.root, PRODUCT_ANALYSIS_FILE)), readFile(f.media)]);
  const first = await readProductChatContext(f.root, f.selection());
  const second = await readProductChatContext(f.root, f.selection('b1'));
  const returning = await readProductChatContext(f.root, f.selection('a2'));
  assert.deepEqual(first.segments, [f.cues[0]]);
  assert.deepEqual(second.segments, [f.cues[1]]);
  assert.deepEqual(returning.segments, [f.cues[2]]);
  assert.deepEqual(first, await readProductChatContext(f.root, f.selection()));
  assert.deepEqual(Object.keys(first).sort(), ['scope', 'segments', 'transcriptVersion']);
  assert.deepEqual(first.scope, { ...f.selection(), productName: '商品 A' });
  assert.match(first.transcriptVersion, /^[a-f0-9]{64}$/);
  assert.notEqual(first.transcriptVersion, returning.transcriptVersion);
  assert.deepEqual(await Promise.all([readFile(f.cachePath), readFile(join(f.root, PRODUCT_ANALYSIS_FILE)), readFile(f.media)]), before);
});

test('rejects missing or mismatched IDs, stale boundaries, and inspection/private ranges', async t => {
  const f = await fixture(t);
  f.data.scopes = [{ id: 'inspection', productId: 'a', sourceId: 's', startMs: 0, endMs: 1000, kind: 'confirmed-inspection', confirmed: true }];
  await f.saveAnalysis();
  for (const patch of [{ sourceId: 'other' }, { productId: 'b' }, { intervalId: 'missing' }, { intervalId: 'inspection' }, { intervalId: 'private-take' }, { startMs: 1 }, { endMs: 4999 }]) {
    await assert.rejects(readProductChatContext(f.root, { ...f.selection(), ...patch }), { status: 409 });
  }
  for (const patch of [{ intervalId: '' }, { startMs: -1 }, { startMs: NaN }, { endMs: Infinity }, { endMs: 0 }]) {
    await assert.rejects(readProductChatContext(f.root, { ...f.selection(), ...patch }), { status: 400 });
  }
});

test('crossing sentence uses only fully contained word timestamps and reports omitted boundary words', async t => {
  const f = await fixture(t);
  f.data.intervals[0].startMs = 1500;
  f.data.intervals[0].endMs = 3500;
  await f.saveAnalysis();
  await f.saveTranscript({ cues: [{ startMs: 0, endMs: 5000, text: '前品、切中左词、本品、切中右词、后品' }], words: [
    { startMs: 0, endMs: 1000, text: '前品' }, { startMs: 1000, endMs: 2000, text: '切中左词' },
    { startMs: 2000, endMs: 3000, text: '本品' }, { startMs: 3000, endMs: 4000, text: '切中右词' }, { startMs: 4000, endMs: 5000, text: '后品' },
  ] });
  const result = await readProductChatContext(f.root, f.selection());
  assert.deepEqual(result.segments, [{ startMs: 2000, endMs: 3000, text: '本品' }]);
  assert.equal(result.omittedBoundaryWords, 2);
  assert.ok(!JSON.stringify(result).includes('前品'));
  assert.ok(!JSON.stringify(result).includes('后品'));
});

test('never clips a whole sentence when word alignment is absent, invalid, or straddles the cue', async t => {
  const f = await fixture(t);
  f.data.intervals[0].startMs = 1000;
  await f.saveAnalysis();
  for (const words of [undefined, [], [{ startMs: -1, endMs: 3000, text: '无效' }], [{ startMs: 0, endMs: 16000, text: '越界' }], [{ startMs: 0, endMs: 2000, text: '跨字幕' }]]) {
    await f.saveTranscript({ words });
    await assert.rejects(readProductChatContext(f.root, f.selection()), /没有可靠的逐词时间/);
  }
  await f.saveTranscript({ words: [{ startMs: 100, endMs: 4000, text: '整词跨选择起点' }] });
  await assert.rejects(readProductChatContext(f.root, f.selection()), /没有完整、有效/);
});

test('missing, pending, unbound, changed-source and invalid transcripts fail without requests or writes', async t => {
  const f = await fixture(t);
  await rm(f.cachePath);
  await assert.rejects(readProductChatContext(f.root, f.selection()), /没有可用的已保存转写/);
  await f.saveTranscript({ status: 'pending' });
  const pending = await readFile(f.cachePath, 'utf8');
  await assert.rejects(readProductChatContext(f.root, f.selection()), /来源绑定或未完成任务/);
  assert.equal(await readFile(f.cachePath, 'utf8'), pending);
  await f.saveTranscript({ cues: [{ startMs: 0, endMs: 16000, text: '无效时间' }] });
  await assert.rejects(readProductChatContext(f.root, f.selection()), { status: 409 });
  await f.saveTranscript();
  await writeFile(f.media, 'different synthetic source');
  await assert.rejects(readProductChatContext(f.root, f.selection()), /没有可用的已保存转写/);
  await f.saveTranscript();
  await writeFile(join(f.root, 'assets', 'synthetic.vtt'), 'WEBVTT\n\n00:00:00.100 --> 00:00:04.000\n未绑定字幕\n');
  await assert.rejects(readProductChatContext(f.root, f.selection()), /来源绑定或未完成任务/);
});

test('fingerprint changes with saved scope, transcript content, product name and source identity', async t => {
  const f = await fixture(t);
  const versions = [];
  const remember = async () => versions.push((await readProductChatContext(f.root, f.selection())).transcriptVersion);
  await remember();
  f.data.intervals[0].endMs = 4500; await f.saveAnalysis(); await remember();
  f.data.products[0].name = '人工改名'; await f.saveAnalysis(); await remember();
  f.cues[0].text = '已修正原话'; await f.saveTranscript(); await remember();
  await writeFile(f.media, 'new synthetic media with a new fingerprint'); await f.saveTranscript(); await remember();
  assert.equal(new Set(versions).size, versions.length);
});

test('GET route requires all unique scope parameters and returns only the selected transcript', async t => {
  const f = await fixture(t);
  const params = new URLSearchParams(Object.entries(f.selection()).map(([key, value]) => [key, String(value)]));
  let status, headers, body;
  const res = { writeHead: (value, sentHeaders) => { status = value; headers = sentHeaders; }, end: value => { body = JSON.parse(value); } };
  assert.equal(await productChatContextRoute({ method: 'POST', url: '/product-chat-context' }, res, f.root, 'product-chat-context'), false);
  assert.equal(await productChatContextRoute({ method: 'GET', url: `/?${params}` }, res, f.root, 'other'), false);
  assert.equal(await productChatContextRoute({ method: 'GET', url: `/?${params}` }, res, f.root, 'product-chat-context'), true);
  assert.equal(status, 200); assert.equal(headers['cache-control'], 'no-store');
  assert.deepEqual(body.segments, [f.cues[0]]);
  for (const query of ['', `${params}&startMs=0`, `${params.toString().replace('startMs=0', 'startMs=')}`, `${params.toString().replace('startMs=0', 'startMs=no')}`]) {
    await assert.rejects(productChatContextRoute({ method: 'GET', url: `/?${query}` }, res, f.root, 'product-chat-context'), { status: 400 });
  }
});
