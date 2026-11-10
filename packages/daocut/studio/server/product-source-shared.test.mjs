import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { associateSharedLibrary } from './shared-media.mjs';
import { readProductTranscript, confirmProductTranscript } from './product-transcription.mjs';
import { createLiveAnalysis } from './live-analysis.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';

test('shared source transcripts and live status use the validated mapping even without linked places', async t => {
  await mkdir(resolve('.test-temp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-temp/asr-shared-'));
  const oldHome = process.env.DAOCUT_STUDIO_HOME;
  process.env.DAOCUT_STUDIO_HOME = join(root, 'home');
  t.after(async () => { if (oldHome === undefined) delete process.env.DAOCUT_STUDIO_HOME; else process.env.DAOCUT_STUDIO_HOME = oldHome; await rm(root, { recursive: true, force: true }); });
  const project = join(root, 'project'), library = join(root, 'library');
  await mkdir(join(project, 'assets'), { recursive: true });
  await mkdir(library);
  const media = join(library, 'a.mp4');
  await writeFile(media, 'synthetic');
  try { await symlink(media, join(project, 'assets', 'a.mp4'), 'file'); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('symbolic links unavailable'); return; } throw error; }
  const info = await stat(media);
  await associateSharedLibrary({ id: 'shared-asr-test-01', name: 'Synthetic', root: library });
  await writeFile(join(project, 'assets', '.daocut-source-media.json'), JSON.stringify({ version: 1, items: { 'assets/a.mp4': { libraryId: 'shared-asr-test-01', libraryName: 'Synthetic', relativePath: 'a.mp4', size: info.size, mtimeMs: Math.round(info.mtimeMs) } } }));
  await writeFile(join(project, 'assets', 'a.vtt'), 'WEBVTT\n\n00:00:00.100 --> 00:00:00.900\n合成字幕\n');
  const source = { id: 's', assetPath: 'assets/a.mp4', durationMs: null };
  await writeProductAnalysis(project, { version: 1, sources: [source], products: [], intervals: [], candidates: [] });
  await confirmProductTranscript(project, source, { sourceConfirmed: true, durationMs: 1000 });
  assert.equal((await readProductTranscript(project, source)).cues[0].text, '合成字幕');
  const route = createLiveAnalysis();
  const req = Readable.from([]); req.method = 'GET'; req.url = '/?sourceId=s';
  let response;
  await route(req, { writeHead() {}, end(text) { response = JSON.parse(text); } }, project, 'live-analysis');
  assert.equal(response.transcription.status, 'complete');
  assert.equal(response.transcription.segments[0].text, '合成字幕');
  await writeFile(media, 'changed synthetic source');
  await assert.rejects(readProductTranscript(project, source));
  const req2 = Readable.from([]); req2.method = 'GET'; req2.url = '/?sourceId=s';
  await route(req2, { writeHead() {}, end(text) { response = JSON.parse(text); } }, project, 'live-analysis');
  assert.equal(response.transcription.status, 'failed');
  assert.equal(await readFile(media, 'utf8'), 'changed synthetic source');
});
