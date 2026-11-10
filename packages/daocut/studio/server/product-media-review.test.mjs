import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat, utimes, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createProductMediaReview, validateProductMediaReview } from './product-media-review.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/product-media-review-20261110');
const digest = value => createHash('sha256').update(value).digest('hex');
const scope = { sourceId: 's', productId: 'p', intervalId: 'first', startMs: 1000, endMs: 9000 };
const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 12000 };
const candidates = [
  { id: 'a', sourceId: 's', productId: 'p', intervalId: 'first', startMs: 1000, endMs: 4000, cueRange: [0,1] },
  { id: 'b', sourceId: 's', productId: 'p', intervalId: 'first', startMs: 4000, endMs: 9000, cueRange: [2,3] },
];
async function fixture() {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'case-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, source.assetPath), 'synthetic-media-content-A');
  await writeFile(join(root, 'film.html'), 'existing film must not be changed');
  return root;
}
function inspector(calls, failure = false) {
  return async request => {
    calls.push(request);
    if (failure) throw Error('private path or credential must not leak');
    await mkdir(request.outputDir, { recursive: true });
    const file = join(request.outputDir, 'sample.png');
    await writeFile(file, 'fake frame image');
    return { ok: true, files: [file], media: { hasVideo: true, hasAudio: true, startMs: request.scope.startMs, endMs: request.scope.endMs, sampleTimesMs: [request.scope.startMs, request.scope.startMs + 2000, request.scope.endMs - 1000], peakDb: -12.3, integratedLufs: -20.1 } };
  };
}

test('reviews only the selected lecture once, persists portable technical evidence, and never claims semantic hearing', async () => {
  const root = await fixture(), calls = [];
  const before = await readFile(join(root, source.assetPath));
  const review = createProductMediaReview({ inspectMedia: inspector(calls) });
  const result = await review(root, source, scope, candidates);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].scope, scope);
  assert.ok(relative(root, calls[0].outputDir).startsWith('.film'));
  assert.equal(result.version, 'product-media-review-v1');
  assert.equal(result.status, 'complete');
  assert.equal(result.sourceSha, digest(before));
  assert.equal(result.speechVerified, false);
  assert.equal(result.continuousActionVerified, false);
  assert.equal(result.segments.length, 2);
  assert.deepEqual(result.segments[0].cueRange, [0,1]);
  assert.deepEqual(result.segments[0].visual.sampleTimesMs, [1000,3000]);
  assert.equal(result.segments[0].audio.status, 'technical-checked');
  assert.deepEqual(result.segments[0].audio.measurementRange, { startMs: 1000, endMs: 9000 });
  assert.equal(result.segments[0].audio.integratedLufs, -20.1);
  assert.ok(!JSON.stringify(result).includes(root));
  assert.ok(!JSON.stringify(result).includes('private path'));
  assert.deepEqual(await readFile(join(root, source.assetPath)), before);
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), 'existing film must not be changed');
  const reopened = await createProductMediaReview({ inspectMedia: async () => assert.fail('cached review must be reused') })(root, source, scope, candidates);
  assert.deepEqual(reopened, result);
});

test('rejects cross-lecture or out-of-scope candidates before inspecting', async () => {
  const root = await fixture(); let calls = 0;
  const review = createProductMediaReview({ inspectMedia: async () => { calls++; } });
  await assert.rejects(review(root, source, scope, [{ ...candidates[0], intervalId: 'return' }]), /讲解|范围/);
  await assert.rejects(review(root, source, scope, [{ ...candidates[0], endMs: 10000 }]), /讲解|范围/);
  await assert.rejects(review(root, source, { ...scope, sourceId: 'another' }, candidates), /来源|范围/);
  assert.equal(calls, 0);
});

test('same-size same-time source replacement and another lecture never reuse old evidence', async () => {
  const root = await fixture(), calls = [], review = createProductMediaReview({ inspectMedia: inspector(calls) });
  const first = await review(root, source, scope, candidates), info = await stat(join(root, source.assetPath));
  await writeFile(join(root, source.assetPath), 'synthetic-media-content-B');
  await utimes(join(root, source.assetPath), info.atime, info.mtime);
  const second = await review(root, source, scope, candidates);
  assert.notEqual(first.key, second.key);
  const returning = { ...scope, intervalId: 'return', startMs: 9000, endMs: 12000 };
  const third = await review(root, source, returning, [{ ...candidates[0], intervalId: 'return', startMs: 9000, endMs: 12000 }]);
  assert.notEqual(second.key, third.key);
  assert.equal(calls.length, 3);
});

test('portable keys ignore local source and lecture ids, and a source change during review is not accepted', async () => {
  const root = await fixture(), other = await fixture();
  const first = await createProductMediaReview({ inspectMedia: inspector([]) })(root, source, scope, candidates);
  const ids = { sourceId: 'other-source', productId: 'other-product', intervalId: 'other-lecture' };
  const second = await createProductMediaReview({ inspectMedia: inspector([]) })(other, { ...source, id: ids.sourceId }, { ...scope, ...ids }, candidates.map(candidate => ({ ...candidate, ...ids })));
  assert.equal(second.key, first.key);
  const changed = await fixture(), inspect = inspector([]);
  const result = await createProductMediaReview({ inspectMedia: async request => {
    const value = await inspect(request);
    await writeFile(request.sourcePath, 'synthetic-media-content-B');
    return value;
  } })(changed, source, scope, candidates);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.segments, []);
});

test('concurrent requests share work, failed inspection is saved as failed and can recover without a model', async () => {
  const root = await fixture(), failedCalls = [];
  const failed = await createProductMediaReview({ inspectMedia: inspector(failedCalls, true) })(root, source, scope, candidates);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.issues.length);
  assert.equal(failed.speechVerified, false);
  assert.ok(!JSON.stringify(failed).includes('private path'));
  const calls = [], review = createProductMediaReview({ inspectMedia: inspector(calls) });
  const results = await Promise.all([review(root, source, scope, candidates), review(root, source, scope, candidates)]);
  assert.equal(calls.length, 1);
  assert.equal(results[0].status, 'complete');
  assert.deepEqual(results[0], results[1]);
});

test('missing modalities remain explicit and a sparse sample is not an inspected continuous action', async () => {
  const root = await fixture();
  const result = await createProductMediaReview({ inspectMedia: async ({ scope }) => ({ ok: true, files: [], media: { hasVideo: false, hasAudio: false, startMs: scope.startMs, endMs: scope.endMs, sampleTimesMs: [] } }) })(root, source, scope, candidates);
  assert.equal(result.status, 'complete');
  assert.ok(result.segments.every(segment => segment.visual.status === 'unavailable' && segment.audio.status === 'technical-checked' && segment.audio.hasAudio === false));
  assert.ok(result.issues.some(issue => /音轨/.test(issue)));
  assert.ok(result.issues.some(issue => /画面/.test(issue)));
  assert.equal(result.continuousActionVerified, false);
});

test('shared validation refuses invented semantic checks and out-of-range samples, while accepting a no-source failure', async () => {
  const root = await fixture(), result = await createProductMediaReview({ inspectMedia: inspector([]) })(root, source, scope, candidates);
  assert.throws(() => validateProductMediaReview({ ...result, speechVerified: true }, scope));
  assert.throws(() => validateProductMediaReview({ ...result, continuousActionVerified: true }, scope));
  const out = structuredClone(result); out.segments[0].visual.sampleTimesMs.push(11000);
  assert.throws(() => validateProductMediaReview(out, scope));
  assert.throws(() => validateProductMediaReview(result, { ...scope, endMs: 10000 }));
  const failed = { version: 'product-media-review-v1', status: 'failed', scope: { startMs: 1000, endMs: 9000 }, segments: [], issues: ['本地音画工具失败'], speechVerified: false, continuousActionVerified: false };
  assert.deepEqual(validateProductMediaReview(failed, scope), failed);
});

test('real synthetic AV uses existing look and keeps artifacts in the project cache', { timeout: 90000 }, async () => {
  const root = await fixture();
  execFileSync('ffmpeg', ['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=s=96x160:r=10:d=3','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',join(root,source.assetPath)], { windowsHide: true });
  // Non-binary-exact seconds (1.001) must round back to the selected millisecond.
  const before = await readFile(join(root,source.assetPath)), short = { ...scope, startMs: 1001, endMs: 2500 };
  const result = await createProductMediaReview()(root, { ...source, durationMs: 3000 }, short, [{ ...candidates[0], startMs: 1001, endMs: 2500 }]);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.equal(result.segments[0].visual.status, 'sampled');
  assert.ok(result.segments[0].visual.sampleTimesMs.every(time => time >= 1001 && time < 2500));
  assert.ok(Number.isFinite(result.segments[0].audio.integratedLufs));
  assert.ok(Number.isFinite(result.segments[0].audio.peakDb));
  assert.equal(result.speechVerified, false);
  assert.deepEqual(await readFile(join(root,source.assetPath)), before);
  assert.ok((await readdir(join(root,'.film','cache','product-media-review',result.key))).some(name=>name.endsWith('.png')));
  assert.equal((await readdir(join(root,'assets'))).some(name=>name.startsWith('.film')), false);
});
