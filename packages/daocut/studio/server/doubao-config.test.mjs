import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDoubaoKey } from './doubao-config.mjs';

test('reads only the specified synthetic key on demand without altering the file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'doubao-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'synthetic.json');
  const data = JSON.stringify({ keys: { doubao: 'invented-key-one', other: 'other-key' }, custom: [{ key: 'unrelated' }] });
  await writeFile(file, data);
  const before = await stat(file);
  assert.equal(await readDoubaoKey(file), 'invented-key-one');
  assert.equal(await readFile(file, 'utf8'), data);
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
  await writeFile(file, JSON.stringify({ keys: { doubao: 'invented-key-two' } }));
  assert.equal(await readDoubaoKey(file), 'invented-key-two');
  await writeFile(file, JSON.stringify({ keys: { other: 'key' } }));
  assert.equal(await readDoubaoKey(file), null);
  assert.equal(await readDoubaoKey(join(dir, 'missing')), null);
  await writeFile(file, '{invented-secret');
  await assert.rejects(readDoubaoKey(file), error => error.message === 'Existing transcription configuration is invalid.');
});
