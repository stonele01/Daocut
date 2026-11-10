import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSampleTranscriber } from './sample-transcriber.mjs';

test('disabled by default; authorized sample only and configuration is read at call time', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sample-asr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), other = join(root, 'other'), config = join(root, 'synthetic-providers.json');
  await mkdir(join(project, 'assets'), { recursive: true }); await mkdir(other);
  await writeFile(join(project, 'assets', '氨基酸2023.6.1.mp4'), 'synthetic');
  assert.equal(createSampleTranscriber(), null);
  assert.equal(createSampleTranscriber({ enabled: false, providersFile: config }), null);
  let calls = 0;
  const transcribe = createSampleTranscriber({ enabled: true, projectRoot: project, providersFile: config,
    readAudio: async () => Buffer.from('synthetic audio'),
    runProvider: async (_verb, _args, ctx) => { calls++; assert.equal(ctx.key, 'fake-key'); return { index: [{ text: '20元。', words: [{ token: '二十元', start: 0, end: 1 }], cues: [{ text: '20元。', startMs: 0, endMs: 1000 }] }] }; },
  });
  const source = { id: 'sample', assetPath: 'assets/氨基酸2023.6.1.mp4', durationMs: 132470 };
  await assert.rejects(transcribe(other, source), /authorized sample/);
  await assert.rejects(transcribe(project, { ...source, assetPath: 'assets/other.mp4' }), /authorized sample/);
  assert.equal(calls, 0);
  await assert.rejects(transcribe(project, source), error => error.code === 'ASR_NOT_SUBMITTED' && error.reason === 'configuration');
  await writeFile(config, JSON.stringify({ keys: { doubao: 'fake-key', other: 'unrelated' } }));
  const before = await readFile(config, 'utf8');
  const result = await transcribe(project, source);
  assert.equal(result.text, '20元。'); assert.equal(calls, 1);
  assert.equal(await readFile(config, 'utf8'), before);
  assert.equal((await transcribe(project, source)).cached, true); assert.equal(calls, 1);
});

test('enabled assembly rejects absent or relative trusted paths', () => {
  assert.throws(() => createSampleTranscriber({ enabled: true }), /absolute/);
  assert.throws(() => createSampleTranscriber({ enabled: true, projectRoot: '.', providersFile: 'providers.json' }), /absolute/);
});


test('real provider rejects non-official endpoint before configuration or audio access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sample-endpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  const old = process.env.DAOCUT_DOUBAO_URL;
  t.after(() => { if (old === undefined) delete process.env.DAOCUT_DOUBAO_URL; else process.env.DAOCUT_DOUBAO_URL = old; });
  const callback = createSampleTranscriber({ enabled: true, projectRoot: project, providersFile: join(root, 'missing-config'), readAudio: () => { throw Error('must not read audio'); } });
  for (const url of ['https://example.com/api/v3/auc/bigmodel/recognize/flash', 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash?other=1', 'http://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash']) {
    process.env.DAOCUT_DOUBAO_URL = url;
    await assert.rejects(callback(project, { id: 'sample', assetPath: 'assets/氨基酸2023.6.1.mp4' }), error => error.code === 'ASR_NOT_SUBMITTED' && error.reason === 'endpoint');
  }
});
