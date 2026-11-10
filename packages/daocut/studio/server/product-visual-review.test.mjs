import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createProductVisualReview, visualReviewCandidatesHash, validateProductVisualReview } from './product-visual-review.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/visual-review-20261110');
const sha = value => createHash('sha256').update(value).digest('hex');
const model = { id: 'saved-chat-model', name: '模拟对话看图模型', api: 'openai-responses', model: 'fixture', baseUrl: 'https://invalid.example' };
const scope = { sourceId: 's', productId: 'p', intervalId: 'first', productName: '模拟蓝杯', startMs: 1000, endMs: 9000 };
const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 20000 };
const candidates = [
  { ...scope, startMs: 1000, endMs: 4000, cueRange: [0, 1], text: '这只模拟蓝杯按这里就能开盖', tags: ['卖点', '产品展示'] },
  { ...scope, startMs: 6000, endMs: 9000, cueRange: [2, 2], text: '需要的现在拍', tags: ['行动指令'] },
];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=', 'base64');
const media = { version: 'product-media-review-v1', key: 'a'.repeat(64), sourceSha: 'b'.repeat(64), scope: { startMs: 1000, endMs: 9000 }, status: 'complete', issues: [], speechVerified: false, continuousActionVerified: false,
  segments: candidates.map((c, i) => ({ startMs: c.startMs, endMs: c.endMs, cueRange: c.cueRange, visual: { status: 'sampled', sampleTimesMs: [i ? 7000 : 2000], artifactSha256: sha(png) }, audio: { status: 'unavailable' }, issues: [] })) };
const response = () => ({ schema: 'product-visual-judgment-v1', findings: [
  { candidate: 0, productMatch: 'match', display: 'shown', evidenceTimesMs: [2000], observation: '抽帧中可见蓝色杯身和杯盖，无法由静态图确认完整开盖动作', issues: ['连续动作需播放确认'] },
  { candidate: 1, productMatch: 'uncertain', display: 'not-shown', evidenceTimesMs: [7000], observation: '该采样帧未见明确产品展示', issues: [] },
], issues: [] });
async function fixture(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'unit-'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('no real model/network'));
  const cache = join(root, '.film/cache/product-media-review', media.key); await mkdir(cache, { recursive: true });
  await writeFile(join(cache, 'sheet.png'), png); await writeFile(join(root, 'film.html'), 'protected parent');
  return root;
}
function client(fn) { return Object.assign(fn, { getCacheIdentity: async () => model }); }
const options = { expectedIdentity: model };

test('existing contact sheet and exact single lecture context reach image client once; saved judgement reopens without calls', async t => {
  const root = await fixture(t); let calls = 0;
  const service = createProductVisualReview({ client: client(async request => {
    calls++; assert.equal(request.images.length, 1); assert.equal(request.images[0].data, png.toString('base64'));
    const input = JSON.parse(request.input); assert.equal(input.productName, scope.productName);
    assert.deepEqual(input.candidates.map(c => c.text), candidates.map(c => c.text));
    assert.deepEqual(input.frameTimesMs, [2000, 7000]);
    assert.ok(request.system.includes('不能'));
    await request.onReceipt?.({ requestId: 'mock-receipt', inputTokens: 10, outputTokens: 20 });
    return JSON.stringify(response());
  }) });
  const result = await service.review(root, source, scope, candidates, media, options);
  assert.equal(result.status, 'complete'); assert.equal(result.entries[0].display, 'shown');
  assert.equal(result.candidatesHash, visualReviewCandidatesHash(candidates));
  assert.equal(result.continuousActionVerified, false); assert.equal(result.speechVerified, false);
  assert.equal(calls, 1);
  const reopen = createProductVisualReview({ client: client(async () => assert.fail('must reuse saved result')) });
  assert.deepEqual(await reopen.review(root, source, scope, candidates, media, options), result);
  const saved = JSON.parse(await readFile(join(root, '.film/visual-review', `${result.key}.json`), 'utf8'));
  assert.ok(saved.attempts[0].raw); assert.equal(saved.attempts[0].receipt.requestId, 'mock-receipt');
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'protected parent');
});

test('missing pictures and unconfirmed or changed model never send a request', async t => {
  const root = await fixture(t); let calls = 0;
  const service = createProductVisualReview({ client: client(async () => { calls++; return response(); }) });
  assert.equal((await service.review(root, source, scope, candidates, media)).status, 'unavailable');
  assert.equal((await service.review(root, source, scope, candidates, media, { expectedIdentity: { ...model, id: 'changed' } })).status, 'unavailable');
  assert.equal((await service.review(root, source, scope, candidates, { ...media, status: 'failed', segments: [] }, options)).status, 'unavailable');
  assert.equal(calls, 0);
});

test('uncertain transport is durable and reopening never retries without explicit acknowledgement', async t => {
  const root = await fixture(t); let calls = 0;
  const service = createProductVisualReview({ client: client(async () => { calls++; if (calls === 1) throw Object.assign(Error('private remote details'), { code: 'MODEL_TIMEOUT' }); return response(); }) });
  const uncertain = await service.review(root, source, scope, candidates, media, options);
  assert.equal(uncertain.status, 'uncertain'); assert.equal(calls, 1);
  assert.equal((await service.review(root, source, scope, candidates, media, options)).status, 'uncertain');
  assert.equal(calls, 1); assert.ok(!JSON.stringify(uncertain).includes('private remote'));
  const retried = await service.review(root, source, scope, candidates, media, { ...options, retryAcknowledged: true });
  assert.equal(retried.status, 'complete'); assert.equal(calls, 2);
  const saved = JSON.parse(await readFile(join(root, '.film/visual-review', `${retried.key}.json`), 'utf8'));
  assert.equal(saved.attempts.length, 2);
});

test('raw successful response recovers a failed final save without another model call', async t => {
  const root = await fixture(t); let calls = 0, once = true;
  const service = createProductVisualReview({ client: client(async () => { calls++; return response(); }), save: async (file, text) => {
    if (JSON.parse(text).record?.status === 'complete' && once) { once = false; throw Error('synthetic final disk failure'); }
    await writeFile(file, text);
  } });
  await assert.rejects(service.review(root, source, scope, candidates, media, options));
  assert.deepEqual(await service.recovery(root, source, scope, candidates, media, options), { recoverable: true });
  const result = await service.review(root, source, scope, candidates, media, options);
  assert.equal(result.status, 'complete'); assert.equal(calls, 1);
});

test('a saved successful receipt with raw text recovers even when the reply delivery failed', async t => {
  const root = await fixture(t); let calls = 0;
  const service = createProductVisualReview({ client: client(async request => {
    calls++; await request.onReceipt({ stopReason: 'stop', rawText: JSON.stringify(response()), usageKnown: true });
    throw Error('synthetic IPC reply failed after persisted receipt');
  }) });
  assert.equal((await service.review(root, source, scope, candidates, media, options)).status, 'uncertain');
  assert.equal((await service.recovery(root, source, scope, candidates, media, options)).recoverable, true);
  assert.equal((await service.review(root, source, scope, candidates, media, options)).status, 'complete');
  assert.equal(calls, 1);
});

test('invented evidence and missing findings cannot become verified image judgements', async t => {
  const root = await fixture(t);
  const wrong = response(); wrong.findings[0].evidenceTimesMs = [3000];
  const service = createProductVisualReview({ client: client(async () => wrong) });
  const result = await service.review(root, source, scope, candidates, media, options);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.entries, []);
  assert.equal((await service.review(root, source, scope, candidates, media, options)).status, 'failed');
  assert.throws(() => validateProductVisualReview({ ...result, continuousActionVerified: true }, scope));
});

test('source/lecture/candidate edits separate cache keys while portable IDs do not; cross-lecture input is refused', async t => {
  const root = await fixture(t); let calls = 0;
  const service = createProductVisualReview({ client: client(async () => { calls++; return response(); }) });
  const a = await service.review(root, source, scope, candidates, media, options);
  const changed = candidates.map(c => ({ ...c, text: c.text + '修正' }));
  const b = await service.review(root, source, scope, changed, media, options);
  assert.notEqual(a.key, b.key); assert.equal(calls, 2);
  const renamed = await service.review(root, source, { ...scope, productName: '另一款商品' }, candidates, media, options);
  assert.notEqual(a.key, renamed.key); assert.equal(calls, 3);
  assert.equal(visualReviewCandidatesHash(candidates), visualReviewCandidatesHash(candidates.map(c => ({ ...c, id: 'other', sourceId: 'other-source' }))));
  const invalid = await service.review(root, source, scope, [{ ...candidates[0], intervalId: 'return' }], media, options);
  assert.equal(invalid.status, 'unavailable'); assert.equal(calls, 3);
  assert.equal((await readdir(join(root, '.film/visual-review'))).length, 3);
});
