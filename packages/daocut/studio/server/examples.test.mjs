import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleFile, exampleFolder, listExamples } from './examples.mjs';

test('the retired examples catalog never fetches or exposes bundled posters', async () => {
  const before = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => { requested = true; throw new Error('Unexpected network request'); };
  try {
    assert.deepEqual(await listExamples(), []);
    assert.equal(exampleFile(), null);
    assert.equal(requested, false);
  } finally { globalThis.fetch = before; }
});

test('old conversation references retain an existing cached folder without rewriting media', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daocut-example-compat-'));
  const dir = join(home, 'cache', 'examples', 'intro');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'film.html'), 'old imported example');
  writeFileSync(join(dir, 'video.mp4'), 'retained user media');
  assert.equal(await exampleFolder('intro', { home }), dir);
  assert.equal(readFileSync(join(dir, 'video.mp4'), 'utf8'), 'retained user media');
  await assert.rejects(exampleFolder('missing', { home }), /no such example/);
  assert.equal(existsSync(join(home, 'cache', 'examples', 'missing')), false);
  await assert.rejects(exampleFolder('../intro', { home }), /no such example/);
});
