// End-to-end synthetic fixture: only localhost Studio routes and injected fake services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStudio } from './server.mjs';
import { transcribeProductSource } from './product-transcription.mjs';

test('synthetic transcription and candidate analysis survive restart without altering human work', async () => {
  const base = resolve('.test-temp'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'live-e2e-'));
  const envNames = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR'];
  const old = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'library');
  process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash');
  await mkdir(process.env.DAOCUT_TRASH_DIR);
  let studio, transcriptions = 0, analyses = 0;
  const liveAnalysis = { modelIdentity: 'isolated-mock-v1',
    transcribe: (root, source) => transcribeProductSource(root, source, {
      getKey: async () => 'synthetic-key', readAudio: async () => Buffer.from('synthetic audio'),
      runProvider: async () => { transcriptions++; return { index: [{ text: '这款20元，值得试试。', words: [{ token: '二十元', start: 0.1, end: 1.1 }], cues: [{ text: '这款20元，', startMs: 100, endMs: 1100 }, { text: '值得试试。', startMs: 1200, endMs: 2000 }] }] }; },
    }),
    modelClient: async ({ input }) => {
      analyses++;
      const data = JSON.parse(input);
      assert.equal(data.productId, 'product-a');
      assert.equal(data.intervalId, 'human-range');
      assert.equal(data.cues[0].text, '这款20元，');
      return { candidates: [{ firstCue: 0, lastCue: 0, tags: ['价格锚点'], details: { subtypes: [], reason: '出现价格', evidence: ['ASR'], context: '', repetition: '', review: ['画面待核实'] } }], issues: [] };
    },
  };
  try {
    studio = await startStudio({ port: 0, openBrowser: () => {}, liveAnalysis });
    const api = async (path, method = 'GET', body) => {
      const res = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=5:d=5', '-c:v', 'mpeg4', '-y', join(project.path, 'assets', 'synthetic.mp4')], { windowsHide: true });
    const analysisPath = `/api/projects/${project.id}/product-analysis`;
    const livePath = `/api/projects/${project.id}/live-analysis`;
    const film = join(project.path, 'film.html'), originalFilm = await readFile(film, 'utf8');
    const fixture = { version: 1, sources: [{ id: 'source-a', assetPath: 'assets/synthetic.mp4', durationMs: null }], products: [{ id: 'product-a', name: '人工商品', sourceIds: ['source-a'] }], intervals: [{ id: 'human-range', productId: 'product-a', sourceId: 'source-a', startMs: 0, endMs: 4000 }], candidates: [] };
    const saved = (await api(analysisPath, 'PUT', { analysis: fixture })).analysis;
    const poll = async type => {
      for (let i = 0; i < 100; i++) {
        const state = await api(`${livePath}?sourceId=source-a`);
        if (state[type].status !== 'running') { assert.equal(state[type].status, 'complete', JSON.stringify(state)); return state; }
        await new Promise(done => setTimeout(done, 10));
      }
      throw Error('synthetic task did not finish');
    };
    await api(`${livePath}/transcribe`, 'POST', { sourceId: 'source-a', confirmed: true });
    const transcript = await poll('transcription');
    assert.deepEqual(transcript.transcription.segments, [{ text: '这款20元，', startMs: 100, endMs: 1100 }, { text: '值得试试。', startMs: 1200, endMs: 2000 }]);
    await api(`${livePath}/analyze`, 'POST', { sourceId: 'source-a', intervalId: 'human-range', confirmed: true });
    await poll('analysis');
    const after = (await api(analysisPath)).analysis;
    assert.deepEqual(after.products, saved.products); assert.deepEqual(after.intervals, saved.intervals);
    assert.equal(after.candidates.length, 1);
    assert.equal(after.candidates[0].productId, 'product-a'); assert.equal(after.candidates[0].intervalId, 'human-range');
    assert.equal(after.candidates[0].text, '这款20元，');
    assert.deepEqual([after.candidates[0].startMs, after.candidates[0].endMs], [100, 1100]);
    assert.equal(await readFile(film, 'utf8'), originalFilm);
    await studio.close(); studio = await startStudio({ port: 0, openBrowser: () => {}, liveAnalysis });
    assert.deepEqual((await api(analysisPath)).analysis, after);
    assert.deepEqual((await api(`${livePath}?sourceId=source-a`)).transcription.segments, transcript.transcription.segments);
    assert.equal(await readFile(film, 'utf8'), originalFilm);
    assert.equal(transcriptions, 1); assert.equal(analyses, 1);
  } finally {
    if (studio) await studio.close();
    for (const name of envNames) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    await rm(scratch, { recursive: true, force: true });
  }
});

