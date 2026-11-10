import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthorizedProductTranscriber } from './authorized-product-transcriber.mjs';

test('selected-source adapter is disabled by default and refuses changed files before credentials or network', async t => {
  assert.equal(createAuthorizedProductTranscriber(), null);
  const root = await mkdtemp(join(tmpdir(), 'authorized-asr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/a.mp4'), 'synthetic');
  const info = await stat(join(root, 'assets/a.mp4'));
  const source = { id: 'a', assetPath: 'assets/a.mp4', durationMs: 1000 };
  let keys = 0, calls = 0;
  const transcribe = createAuthorizedProductTranscriber({ enabled: true, projectRoot: root, source: { ...source, size: info.size, mtimeMs: info.mtimeMs }, getKey: () => { keys++; return 'fake'; }, readAudio: async () => Buffer.from('audio'), runProvider: async () => { calls++; return { index: [{ text: '合成', words: [{ token: '合成', start: 0, end: 0.9 }], cues: [{ text: '合成', startMs: 0, endMs: 900 }] }] }; } });
  await assert.rejects(transcribe(root, { ...source, id: 'other' }), error => error.code === 'ASR_NOT_SUBMITTED');
  assert.equal(keys, 0); assert.equal(calls, 0);
  assert.equal((await transcribe(root, source)).text, '合成');
  assert.equal(calls, 1);
  await writeFile(join(root, 'assets/a.mp4'), 'changed file');
  await assert.rejects(transcribe(root, source), error => error.code === 'ASR_NOT_SUBMITTED');
  assert.equal(keys, 1); assert.equal(calls, 1);
});
