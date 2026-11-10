import test from 'node:test';
import assert from 'node:assert/strict';
import { trimLoadedThumbs } from './thumb-cache.ts';

test('long-source navigation bounds thumbnail history and retains the current viewport', () => {
  const loaded = new Map<string, string>();
  for (let page = 0; page < 200; page++) {
    const wanted = new Map(Array.from({ length: 30 }, (_, index) => [`shot-${page * 30 + index}`, `frame-${page * 30 + index}`]));
    for (const [key, url] of wanted) loaded.set(key, url);
    trimLoadedThumbs(loaded, wanted);
    assert.ok(loaded.size <= 1024);
    for (const [key, url] of wanted) assert.equal(loaded.get(key), url);
  }
  assert.equal(loaded.has('shot-0'), false);
});

test('a dense current viewport is kept without retaining its old history', () => {
  const loaded = new Map([['old', 'old-url']]);
  const wanted = new Map(Array.from({ length: 1500 }, (_, i) => [`shot-${i}`, `url-${i}`]));
  for (const [key, url] of wanted) loaded.set(key, url);
  trimLoadedThumbs(loaded, wanted);
  assert.equal(loaded.size, 1500);
  assert.equal(loaded.has('old'), false);
});
