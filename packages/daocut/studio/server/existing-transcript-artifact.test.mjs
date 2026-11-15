import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readExistingTranscriptArtifact, readHistoricalTranscriptInput, extractOriginalTranscriptScope, importExistingTranscriptArtifact } from './existing-transcript-artifact.mjs';
import { transcriptionLocation, readProductTranscript, transcribeProductSource, confirmProductTranscript } from './product-transcription.mjs';
import { readTranscriptReview, saveTranscriptReview } from './transcript-review.mjs';
import { updateProductAnalysis } from './product-analysis.mjs';
import { writeAtomic } from './atomic.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/shared-existing-20261105/transcript/cases');
const cue = (text, startMs, endMs) => ({ text, startMs, endMs });
const rawSegments = () => [
  { id: 'audio-1', startMs: 0, endMs: 3500, coreStartMs: 0, coreEndMs: 3000, status: 'complete', requestId: 'synthetic-1', completedAt: '2026-01-01T00:00:01Z', cues: [cue('开头原话', 100, 800), cue('第一商品完整一句', 1000, 1800), cue('交界截断因为', 2800, 3490)] },
  { id: 'audio-2', startMs: 2500, endMs: 6000, coreStartMs: 3000, coreEndMs: 6000, status: 'complete', requestId: 'synthetic-2', completedAt: '2026-01-01T00:00:02Z', cues: [cue('交界截断', 300, 700), cue('因为后半句完整', 700, 1400), cue('后文', 2000, 2800)] },
].map(s => ({ ...s, words: s.cues.map(c => ({ token: c.text, start: c.startMs / 1000, end: c.endMs / 1000 })), providerSecret: 'must-not-share-secret' }));

async function fixture(t, { name = 'source-a', raw = true, reviewed = true, segments = rawSegments() } = {}) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => { throw Error('real requests forbidden'); });
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/live.mp4'), 'synthetic-video'); await writeFile(join(root, 'film.html'), 'personal-film');
  const source = { id: name, assetPath: 'assets/live.mp4', durationMs: 6000 };
  await updateProductAnalysis(root, data => ({ ...data, sources: [source] }), async () => ({ duration: 6 }));
  const loc = await transcriptionLocation(root, source); await mkdir(loc.dir, { recursive: true });
  const cues = [cue('开头原话', 100, 800), cue('第一商品完整一句', 1000, 1800), cue('私人修订不能共享', 2800, 3900), cue('后文', 4500, 5300)];
  const cache = { version: 1, status: 'complete', sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, fingerprint: loc.fingerprint, cues, words: [], text: cues.map(c => c.text).join(' '), segmented: true, ...(reviewed ? { boundaryReview: { kind: 'agent-local-boundary-review', excluded: { text: 'PRIVATE-REVIEW' } } } : {}) };
  await writeFile(loc.path, JSON.stringify(cache));
  if (raw) await writeFile(loc.path + '.segments.json', JSON.stringify({ version: 1, sourceId: source.id, durationMs: 6000, identity: 'old-local-identity', segments }));
  return { root, source, loc, cache };
}
async function blank(t, name = 'source-b') {
  const f = await fixture(t, { name, raw: false, reviewed: false }); await rm(f.loc.path); return f;
}
const ref = { sha256: 'a'.repeat(64), version: 'test-baseline' };

test('legacy export shares only original segment snapshots, source-absolute times and safe provenance', async t => {
  const f = await fixture(t), before = await readFile(f.loc.path, 'utf8'), artifact = await readExistingTranscriptArtifact(f.root, f.source);
  assert.equal(artifact.payload.kind, 'original-asr-segments'); assert.equal(artifact.payload.version, 1);
  assert.equal(artifact.payload.collectionStatus, 'complete'); assert.equal(artifact.summary.segmentCount, 2);
  assert.equal(artifact.summary.rawCueCount, 6); assert.equal(artifact.summary.pendingSeams, 0);
  assert.deepEqual(artifact.payload.segments[1].cues[0], cue('交界截断', 2800, 3200));
  assert.equal(artifact.provenance.legacyReview, 'agent-local-boundary-review');
  assert.equal(artifact.provenance.effectiveInput.origin, 'agent-local-boundary-review');
  assert.equal(artifact.provenance.effectiveInput.cueCount, 4);
  assert.match(artifact.provenance.effectiveInput.hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(artifact), /私人修订不能共享|PRIVATE-REVIEW|must-not-share-secret|old-local-identity|case-/);
  assert.equal(await readFile(f.loc.path, 'utf8'), before);
});

test('legacy review provenance survives the VTT-priority reader without rewriting old data', async t => {
  const f = await fixture(t), before = await readFile(f.loc.path, 'utf8');
  await writeFile(join(f.root, 'assets/live.vtt'), 'WEBVTT\n\n00:00:00.100 --> 00:00:00.800\n开头原话\n');
  await confirmProductTranscript(f.root, f.source, { sourceConfirmed: true });
  const value = await readProductTranscript(f.root, f.source);
  assert.equal(value.localReconciled, true); assert.equal(value.provenance.kind, 'agent-local-boundary-review');
  assert.equal(value.cues.length, 1); assert.equal(await readFile(f.loc.path, 'utf8'), before);
});

test('a clean first-product input is reconstructed from raw AI cues without the later private seam decision', async t => {
  const f = await fixture(t), artifact = await readExistingTranscriptArtifact(f.root, f.source), scope = { startMs: 100, endMs: 1800 };
  const original = extractOriginalTranscriptScope(artifact.payload, scope), historical = await readHistoricalTranscriptInput(f.root, f.source, scope);
  assert.equal(original.origin, 'original-provider-segments'); assert.equal(historical.origin, 'agent-local-boundary-review');
  assert.equal(original.hash, historical.hash); assert.equal(original.cues.length, 2);
  assert.deepEqual(extractOriginalTranscriptScope(artifact.payload, { startMs: 2800, endMs: 3900 }).cues.map(cue => cue.text), ['交界截断', '因为后半句完整']);
  assert.throws(() => extractOriginalTranscriptScope(artifact.payload, { startMs: -1, endMs: 1000 }));
});

test('raw segments import into a different local source with automatic joining and no ASR resubmission', async t => {
  const a = await fixture(t), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source);
  const film = await readFile(join(b.root, 'film.html'), 'utf8');
  const result = await importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref);
  assert.equal(result.collectionStatus, 'complete'); assert.equal(result.reviewRequired, false);
  const review = await readTranscriptReview(b.root, b.source.id); assert.equal(review.pendingCount, 0);
  assert.deepEqual(review.seams[0].right[0], cue('交界截断', 2800, 3200));
  assert.ok((await readProductTranscript(b.root, b.source)).cues.length);
  let calls = 0; const forbidden = () => { calls++; throw Error('must never submit or read credentials'); };
  for (const retryUncertain of [false, true]) assert.ok((await transcribeProductSource(b.root, b.source, { retryUncertain, getKey: forbidden, runProvider: forbidden, readAudio: forbidden })).cues.length);
  assert.equal(calls, 0); assert.equal(await readFile(join(b.root, 'film.html'), 'utf8'), film);
});

test('local review and reopen preserve imported raw data, and a repeated import preserves personal corrections', async t => {
  const a = await fixture(t), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source);
  await importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref);
  const raw = await readFile(b.loc.path + '.segments.json', 'utf8'), review = await readTranscriptReview(b.root, b.source.id);
  await saveTranscriptReview(b.root, { sourceId: b.source.id, identity: review.identity, expectedRevision: 0, seamId: review.seams[0].id, cues: review.seams[0].right, confirmed: true, acknowledgeImpact: true });
  const saved = await readFile(b.loc.path + '.review.json', 'utf8');
  assert.equal((await readProductTranscript(b.root, b.source)).localReconciled, true);
  const repeated = await importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref);
  assert.equal(repeated.reviewRequired, false);
  assert.equal(await readFile(b.loc.path + '.review.json', 'utf8'), saved); assert.equal(await readFile(b.loc.path + '.segments.json', 'utf8'), raw);
});

test('invalid, incomplete or mismatched raw artifact is refused before any destination cache write', async t => {
  const a = await fixture(t), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source);
  const invalids = [ { ...artifact.payload, durationMs: 6001 }, { ...artifact.payload, collectionStatus: 'pending' }, { ...artifact.payload, segments: artifact.payload.segments.slice(0, 1) } ];
  const negative = structuredClone(artifact.payload); negative.segments[1].cues[0].startMs = -1; invalids.push(negative);
  for (const payload of invalids) await assert.rejects(importExistingTranscriptArtifact(b.root, b.source, payload, ref));
  assert.deepEqual(await readdir(b.loc.dir), []);
});

test('automatic duplicate resolution imports a complete AI baseline without user-review provenance or new requests', async t => {
  const segments = rawSegments(); segments[0].cues[2] = cue('相同句', 2800, 3200); segments[1].cues = [cue('相同句', 300, 700), cue('后文', 2000, 2800)];
  for (const s of segments) s.words = s.cues.map(c => ({ token: c.text, start: c.startMs / 1000, end: c.endMs / 1000 }));
  const a = await fixture(t, { segments, reviewed: false }), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source);
  const result = await importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref);
  assert.equal(result.reviewRequired, false); const transcript = await readProductTranscript(b.root, b.source);
  assert.notEqual(transcript.localReconciled, true); assert.equal(transcript.cues.filter(c => c.text === '相同句').length, 1);
  assert.equal((await transcribeProductSource(b.root, b.source, { getKey: () => { throw Error('must not fetch credentials'); } })).cues.length, 4);
});

test('unknown legacy input never becomes an invented pure-AI artifact', async t => {
  const f = await fixture(t, { raw: false, reviewed: false });
  await assert.rejects(readExistingTranscriptArtifact(f.root, f.source), error => error.code === 'EXISTING_ASR_RAW_MISSING');
  const input = await readHistoricalTranscriptInput(f.root, f.source); assert.equal(input.origin, 'unknown');
});

test('publication import refuses an existing local transcript or conflicting artifact without overwriting it', async t => {
  const a = await fixture(t), b = await fixture(t, { name: 'source-b' }), artifact = await readExistingTranscriptArtifact(a.root, a.source), before = await readFile(b.loc.path, 'utf8');
  await assert.rejects(importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref), /已有|existing/i);
  assert.equal(await readFile(b.loc.path, 'utf8'), before);
});

test('partial local import retries only the cache commit and concurrent imports produce one intact raw snapshot', async t => {
  const a = await fixture(t), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source); let attempts = 0;
  const failingWrite = async (path, text) => { attempts++; if (path === b.loc.path) throw Object.assign(Error('synthetic disk full'), { code: 'ENOSPC' }); await writeAtomic(path, text); };
  await assert.rejects(importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref, { write: failingWrite }), /disk full/);
  const raw = await readFile(b.loc.path + '.segments.json', 'utf8');
  let paidCalls = 0; const forbidden = () => { paidCalls++; throw Error('unexpected ASR'); };
  await assert.rejects(readProductTranscript(b.root, b.source), error => error.code === 'EXISTING_ASR_IMPORT_INCOMPLETE');
  await assert.rejects(transcribeProductSource(b.root, b.source, { retryUncertain: true, getKey: forbidden, runProvider: forbidden }), error => error.code === 'EXISTING_ASR_IMPORT_INCOMPLETE');
  assert.equal(paidCalls, 0);
  await Promise.all([importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref), importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref)]);
  assert.equal(await readFile(b.loc.path + '.segments.json', 'utf8'), raw); assert.equal((await readTranscriptReview(b.root, b.source.id)).pendingCount, 0); assert.equal(attempts, 2);
});

test('changed imported segment bytes cannot be accepted merely because the stored artifact hash field is unchanged', async t => {
  const a = await fixture(t), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source);
  await importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref);
  const path = b.loc.path + '.segments.json', edited = JSON.parse(await readFile(path, 'utf8'));
  edited.segments[0].cues[0].text = 'local raw edit'; await writeFile(path, JSON.stringify(edited));
  const before = await readFile(path, 'utf8');
  await assert.rejects(importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref), /不一致|changed/);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('source replacement during local import prevents a cache from being committed for the old video', async t => {
  const a = await fixture(t), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source);
  const replacingWrite = async (path, text) => { await writeAtomic(path, text); if (path.endsWith('.segments.json')) await writeFile(join(b.root, 'assets/live.mp4'), 'replaced-synthetic-video'); };
  await assert.rejects(importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref, { write: replacingWrite }), /来源.*变化|source.*changed/i);
  await assert.rejects(readFile(b.loc.path), error => error.code === 'ENOENT');
});

test('source selected by content identity must still match before raw transcript import begins', async t => {
  const a = await fixture(t), b = await blank(t), artifact = await readExistingTranscriptArtifact(a.root, a.source);
  const info = await stat(join(b.root, b.source.assetPath));
  const expectedSourceFingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  await writeFile(join(b.root, b.source.assetPath), 'different-video-before-import');
  await assert.rejects(importExistingTranscriptArtifact(b.root, b.source, artifact.payload, ref, { expectedSourceFingerprint }), /来源.*变化|source.*changed/i);
  assert.deepEqual(await readdir(b.loc.dir), []);
  const c = await blank(t, 'source-c'), current = await stat(join(c.root, c.source.assetPath));
  const result = await importExistingTranscriptArtifact(c.root, c.source, artifact.payload, ref, { expectedSourceFingerprint: `${current.size}:${current.mtimeMs}:${current.ctimeMs}:${current.ino}` });
  assert.equal(result.imported, true);
});
