// Real local FFmpeg + existing look, deterministic text response, no provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductMediaReview } from './product-media-review.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';
import { importSharedProductTranscript } from './product-transcription.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/media-review-real-tools-20261110');
const source = { id: 's', assetPath: 'assets/synthetic.mp4', durationMs: 6000 };
const scope = { sourceId: 's', productId: 'p', intervalId: 'first', startMs: 500, endMs: 4500, lectureOnly: true };
const cues = [
  { startMs: 500, endMs: 1500, text: '赶车时腾不出手拧杯盖。' },
  { startMs: 1500, endMs: 3000, text: '这款模拟杯可以单手按压打开。' },
  { startMs: 3000, endMs: 4500, text: '需要的确认规格后现在下单。' },
  { startMs: 5000, endMs: 6000, text: '这是另一次讲解，不能混入首讲。' },
];
const compact = { schema: 'complete-speech-v1', candidates: [
  { firstCue: 0, lastCue: 0, tags: ['痛点'] },
  { firstCue: 1, lastCue: 1, tags: ['卖点'] },
  { firstCue: 2, lastCue: 2, tags: ['逼单'] },
], issues: [] };
const sha = value => createHash('sha256').update(value).digest('hex');

async function createProject(parent, name, originalMedia) {
  const root = join(parent, name);
  await mkdir(join(root,'assets'), { recursive: true });
  if (originalMedia) await copyFile(originalMedia, join(root,source.assetPath));
  else execFileSync('ffmpeg', ['-nostdin','-v','error','-y','-f','lavfi','-i','testsrc2=s=96x160:r=10:d=6','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=6','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',join(root,source.assetPath)], { windowsHide: true });
  await writeFile(join(root,'film.html'), 'existing parent film; media review must not change it');
  await writeProductAnalysis(root, { version: 1, sources: [source], products: [{ id: 'p', name: '模拟随行杯', sourceIds: ['s'] }], intervals: [
    { id: 'first', sourceId: 's', productId: 'p', startMs: 500, endMs: 4500 },
    { id: 'return', sourceId: 's', productId: 'p', startMs: 5000, endMs: 6000 },
  ], candidates: [] });
  await importSharedProductTranscript(root, source, { cues, words: [] }, { schema: 'isolated-synthetic-transcript', sha256: sha(JSON.stringify(cues)) });
  return root;
}

async function beforeFiles(root) {
  return Object.fromEntries(await Promise.all(['film.html',source.assetPath].map(async path => {
    const bytes = await readFile(join(root,path)), info = await stat(join(root,path));
    return [path, { sha256: sha(bytes), size: info.size, mtimeMs: info.mtimeMs }];
  })));
}
async function analyze(route, root) {
  await route.startAnalysis(root,scope); await route.wait(root,'s');
  return route.view(root,'s','first','p',scope);
}

test('selected lecture uses real existing media tools once and shares saved evidence without repeating text or tools', { timeout: 90000 }, async t => {
  await mkdir(base,{ recursive: true });
  const scratch = await mkdtemp(join(base,'case-'));
  t.mock.method(globalThis,'fetch', () => { throw Error('No model, ASR or external network request in this test'); });
  const root = await createProject(scratch,'origin');
  const receiver = await createProject(scratch,'receiver',join(root,source.assetPath));
  const initial = await beforeFiles(root), receiverInitial = await beforeFiles(receiver);
  let modelCalls = 0, localToolCalls = 0;
  const localReview = createProductMediaReview();
  const common = { modelIdentity: 'isolated-real-tools-mock-text-v1', transcribe: async () => assert.fail('existing saved transcript must be reused') };
  const route = createLiveAnalysis({ ...common,
    modelClient: async ({ input }) => {
      modelCalls++;
      const request = JSON.parse(input);
      assert.deepEqual(request.cues, cues.slice(0,3));
      assert.deepEqual([request.rangeStartMs,request.rangeEndMs],[500,4500]);
      return structuredClone(compact);
    },
    mediaReview: async (...args) => { localToolCalls++; return localReview(...args); },
  });
  const done = await analyze(route,root);
  assert.equal(done.analysis.status,'complete');
  const review = done.analysis.mediaReview;
  assert.equal(review?.status,'complete',JSON.stringify(done.analysis));
  assert.equal(modelCalls,1); assert.equal(localToolCalls,1);
  assert.equal(review.sourceSha,initial[source.assetPath].sha256);
  assert.deepEqual(review.scope,{ startMs:500,endMs:4500 });
  assert.equal(review.speechVerified,false); assert.equal(review.continuousActionVerified,false);
  assert.equal(review.segments.length,3);
  assert.ok(review.segments.every(item => item.startMs>=500 && item.endMs<=4500));
  assert.ok(review.segments.every(item => item.visual.status==='sampled'));
  assert.ok(review.segments.every(item => item.audio.status==='technical-checked' && item.audio.hasAudio===true && Number.isFinite(item.audio.peakDb) && Number.isFinite(item.audio.integratedLufs)));
  assert.ok(review.segments.every(item => item.visual.sampleTimesMs.every(time => time>=item.startMs && time<item.endMs)));
  assert.ok(done.analysis.coverage.every(item => item.audioRanges.length===0 && item.videoRanges.length===0));
  assert.ok((await readdir(join(root,'.film','cache','product-media-review',review.key))).some(name=>name.endsWith('.png')));
  const analysisBeforeReopen = await readFile(join(root,'.film','product-analysis.json'),'utf8');
  const payload = await route.exportShared(root,'s','first');
  assert.deepEqual(payload.mediaReview,review);
  assert.ok(!JSON.stringify(payload.mediaReview).includes(scratch));
  const never = async () => assert.fail('reopening/import must not repeat either the model or local media tools');
  const reopened = createLiveAnalysis({ ...common, modelClient:never, mediaReview:never });
  assert.deepEqual((await analyze(reopened,root)).analysis.mediaReview,review);
  assert.equal(await readFile(join(root,'.film','product-analysis.json'),'utf8'),analysisBeforeReopen);
  const reused = createLiveAnalysis({ ...common, modelClient:never, mediaReview:never });
  await reused.importShared(receiver,'s',scope,payload,{ sha256:sha(JSON.stringify(payload)) });
  assert.deepEqual((await analyze(reused,receiver)).analysis.mediaReview,review);
  const received = (await readProductAnalysis(receiver)).analysis;
  assert.deepEqual(received.candidates.map(item=>item.text),cues.slice(0,3).map(cue=>cue.text));
  assert.ok(received.candidates.every(item=>item.intervalId==='first'));
  assert.deepEqual(await beforeFiles(root),initial);
  assert.deepEqual(await beforeFiles(receiver),receiverInitial);
  await writeFile(join(scratch,'result.json'),JSON.stringify({ passed:true, mockTextCalls:modelCalls, localReviewCalls:localToolCalls, realModelRequests:0, realAsrRequests:0, scope:review.scope, sourceSha:review.sourceSha, reviewKey:review.key, returnedSamples:review.segments.map(item=>item.visual.sampleTimesMs), sourceAndParentUnchanged:true, reopenedAndSharedWithoutTools:true },null,2));
});
