import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { readSourceTakes, SOURCE_TAKES_FILE, sourceTakesRoute, writeSourceTakes } from './source-takes.mjs';

async function fixture(t) {
  const base = resolve('../../.tmp/source-takes-20261104');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets')); await mkdir(join(root, '.film'));
  for (const id of ['a', 'b']) await writeFile(join(root, `assets/${id}.mp4`), `synthetic source ${id}`);
  const analysis = { version: 1, sources: ['a', 'b'].map(id => ({ id, assetPath: `assets/${id}.mp4`, durationMs: 10000 })), products: [], intervals: [], candidates: [] };
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify(analysis));
  await writeFile(join(root, 'film.html'), '<!-- independent finished film -->');
  const document = (id = 'a') => ({ version: 1, sourceId: id, assetPath: `assets/${id}.mp4`, durationMs: 10000, signature: JSON.stringify([`assets/${id}.mp4`, 10000, []]), film: { tracks: [{ attrs: { 'data-personal-provenance': 'retained' }, clips: [{ id: 'personal-1', src: `assets/${id}.mp4`, at: 2, time: [2, 4], attrs: { 'data-source-kind': 'context', 'data-source-range': '' } }] }] } });
  const input = async (id = 'a', doc = document(id)) => ({ expectedRevision: 0, sourceIdentity: (await readSourceTakes(root, id)).sourceIdentity, document: doc });
  return { root, document, input, analysis };
}
const status = expected => error => error.status === expected;

test('personal takes persist independently and reopen in a new process without browser state', async t => {
  const { root, input, document } = await fixture(t);
  const paths = ['film.html', '.film/product-analysis.json', 'assets/a.mp4', 'assets/b.mp4'];
  const before = await Promise.all(paths.map(path => readFile(join(root, path))));
  const saved = await writeSourceTakes(root, 'a', await input());
  assert.equal(saved.revision, 1); assert.deepEqual(saved.document, document());
  const code = `import { readSourceTakes } from './studio/server/source-takes.mjs'; console.log(JSON.stringify(await readSourceTakes(process.argv[1], 'a')));`;
  const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code, root], { cwd: resolve('.'), encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(restarted, saved);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(root, path)))), before);
});

test('different sources save concurrently while stale edits to the same source are refused', async t => {
  const { root, input } = await fixture(t);
  const a = await input('a'), b = await input('b');
  const values = await Promise.all([writeSourceTakes(root, 'a', a), writeSourceTakes(root, 'b', b)]);
  assert.deepEqual(values.map(value => value.revision), [1, 1]);
  const edits = [3, 3.5].map(at => ({ ...a, expectedRevision: 1, document: structuredClone(a.document) }));
  for (let i = 0; i < edits.length; i++) { edits[i].document.film.tracks[0].clips[0].at = 3 + i * 0.5; edits[i].document.film.tracks[0].clips[0].time[0] = 3 + i * 0.5; }
  const settled = await Promise.allSettled(edits.map(edit => writeSourceTakes(root, 'a', edit)));
  assert.equal(settled.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(value => value.status === 'rejected' && value.reason.status === 409).length, 1);
  assert.equal((await readSourceTakes(root, 'a')).revision, 2);
  assert.deepEqual((await readSourceTakes(root, 'b')).document, b.document);
});

test('a lost successful response can be explicitly retried without creating another revision', async t => {
  const { root, input } = await fixture(t); const request = await input();
  const first = await writeSourceTakes(root, 'a', request);
  assert.deepEqual(await writeSourceTakes(root, 'a', request), first);
  const next = structuredClone(request); next.expectedRevision = 1; next.document.film.tracks[0].clips = [];
  const removed = await writeSourceTakes(root, 'a', next);
  await assert.rejects(writeSourceTakes(root, 'a', request), status(409));
  assert.deepEqual(await readSourceTakes(root, 'a'), removed);
});

test('new analysis and candidate IDs do not rewrite saved private source edits', async t => {
  const { root, input, analysis } = await fixture(t);
  const saved = await writeSourceTakes(root, 'a', await input());
  analysis.products = [{ id: 'p', name: 'synthetic', sourceIds: ['a'] }];
  analysis.intervals = [{ id: 'i-new', productId: 'p', sourceId: 'a', startMs: 0, endMs: 10000 }];
  analysis.candidates = [{ id: 'c-new', productId: 'p', intervalId: 'i-new', sourceId: 'a', startMs: 1000, endMs: 7000, tags: ['卖点'], text: 'synthetic new text', origin: 'mock', version: 2 }];
  await writeFile(join(root, '.film/product-analysis.json'), JSON.stringify(analysis));
  assert.deepEqual(await readSourceTakes(root, 'a'), saved);
});

test('source replacement and changing a source between read and save never overwrite old takes', async t => {
  const { root, input } = await fixture(t);
  const request = await input(); const saved = await writeSourceTakes(root, 'a', request);
  const path = join(root, SOURCE_TAKES_FILE); const before = await readFile(path);
  await writeFile(join(root, 'assets/a.mp4'), 'a replacement source of different length');
  await assert.rejects(readSourceTakes(root, 'a'), status(409));
  await assert.rejects(writeSourceTakes(root, 'a', { ...request, expectedRevision: saved.revision }), status(409));
  assert.deepEqual(await readFile(path), before);
  const b = await input('b'); const info = await stat(join(root, 'assets/b.mp4'));
  await utimes(join(root, 'assets/b.mp4'), info.atime, new Date(info.mtimeMs + 2000));
  await assert.rejects(writeSourceTakes(root, 'b', b), status(409));
  assert.deepEqual(await readFile(path), before);
});

test('invalid bounds, references, duplicate IDs, duration and missing revisions are rejected', async t => {
  const { root, input } = await fixture(t); const request = await input();
  const mutations = [
    value => { value.document.film.tracks[0].clips[0].time = [-1, 2]; },
    value => { value.document.film.tracks[0].clips[0].time = [2, 2]; },
    value => { value.document.film.tracks[0].clips[0].time = [2, 11]; },
    value => { value.document.film.tracks[0].clips[0].time = [2, NaN]; },
    value => { value.document.film.tracks[0].clips[0].at = 1; },
    value => { value.document.film.tracks[0].clips[0].src = 'assets/b.mp4'; },
    value => { value.document.film.tracks[0].clips.push(structuredClone(value.document.film.tracks[0].clips[0])); },
    value => { value.document.durationMs = 11000; },
    value => { value.document.sourceId = 'b'; },
    value => { delete value.expectedRevision; },
    value => { value.document.signature = '{truncated'; },
    value => { value.document.signature = '{}'; },
    value => { value.document.signature = JSON.stringify(['assets/b.mp4', 10000, []]); },
    value => { value.document.signature = JSON.stringify(['assets/a.mp4', 9000, []]); },
    value => { value.document.signature = JSON.stringify(['assets/a.mp4', 10000, [['c', 0, 500], ['c', 500, 1000]]]); },
    value => { value.document.signature = JSON.stringify(['assets/a.mp4', 10000, [['c', -1, 500]]]); },
    value => { value.document.signature = JSON.stringify(['assets/a.mp4', 10000, [['c', 1000, 11000]]]); },
    value => { value.document.signature = JSON.stringify(['assets/a.mp4', 10000, [['c', 500, 500]]]); },
  ];
  for (const mutate of mutations) { const next = structuredClone(request); mutate(next); await assert.rejects(writeSourceTakes(root, 'a', next), status(400)); }
  assert.equal((await readSourceTakes(root, 'a')).revision, 0);
  await writeSourceTakes(root, 'a', request);
  assert.equal((await readSourceTakes(root, 'a')).revision, 1, 'invalid writes never poison the project queue');
});

test('corrupt or unsupported saved data is reported without reset or overwrite', async t => {
  const { root, input } = await fixture(t); const request = await input(); const path = join(root, SOURCE_TAKES_FILE);
  for (const broken of ['{truncated', JSON.stringify({ version: 999, sources: [] }), JSON.stringify({ version: 1, sources: [{ revision: 1, sourceIdentity: request.sourceIdentity, document: { ...request.document, film: { tracks: 'bad' } } }] })]) {
    await writeFile(path, broken);
    await assert.rejects(readSourceTakes(root, 'a'), status(409));
    await assert.rejects(writeSourceTakes(root, 'a', request), status(409));
    assert.equal(await readFile(path, 'utf8'), broken);
  }
});

test('route supports unanalysed project media and uses saved source metadata where available', async t => {
  const { root, input } = await fixture(t);
  const run = async (method, query, body) => {
    const request = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); request.method = method; request.url = `/source-takes${query}`;
    let code, value; const response = { writeHead(statusCode) { code = statusCode; }, end(data) { value = JSON.parse(data); } };
    assert.equal(await sourceTakesRoute(request, response, root, 'source-takes'), true); assert.equal(code, 200); return value;
  };
  assert.equal((await run('GET', '?sourceId=assets%2Fa.mp4&assetPath=assets%2Fa.mp4')).document, null);
  const saved = await run('PUT', '?sourceId=a', await input());
  assert.deepEqual(await run('GET', '?sourceId=a'), saved);
  await assert.rejects(run('GET', '?sourceId=a&sourceId=b'), status(400));
  await assert.rejects(run('GET', '?sourceId=a&assetPath=assets%2Fb.mp4'), status(409));
  await assert.rejects(run('GET', '?sourceId=unknown&assetPath=..%2Foutside.mp4'), status(409));
});
