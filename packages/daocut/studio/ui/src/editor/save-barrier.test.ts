import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForFilmSave } from './save-barrier.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('export waits for writes added while the first save is pending', async () => {
  const first = deferred(), second = deferred();
  let queue = first.promise;
  let exported = false;
  const exporting = waitForFilmSave(() => queue, () => null, () => false).then(() => { exported = true; });
  queue = second.promise;
  first.resolve();
  await Promise.resolve();
  assert.equal(exported, false);
  second.resolve();
  await exporting;
  assert.equal(exported, true);
});

test('a save failure or broken film blocks export, including a failed earlier queued write', async () => {
  const saved = deferred();
  let failure: string | null = null;
  let exported = false;
  const exporting = waitForFilmSave(() => saved.promise, () => failure, () => false).then(() => { exported = true; });
  failure = '磁盘写入失败';
  saved.resolve();
  await assert.rejects(exporting, /成片保存失败.*磁盘写入失败/);
  assert.equal(exported, false);
  const idle = Promise.resolve();
  await assert.rejects(waitForFilmSave(() => idle, () => null, () => true), /成片文件无法读取/);
});
