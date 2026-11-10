import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUBTITLE_DEFAULT } from './subtitles.ts';
import { readSubtitleStyleRecovery, rememberSubtitleStyle, acknowledgeSubtitleStyle, saveRememberedSubtitleStyle } from './subtitle-style-recovery.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const style = (italic: boolean) => ({ ...structuredClone(SUBTITLE_DEFAULT), font: { ...SUBTITLE_DEFAULT.font, italic } });

test('an edit is recoverable immediately, before the 500ms server debounce, and only in its own draft', () => {
  const storage = memoryStorage(), a = style(true), b = style(false);
  rememberSubtitleStyle('draft-A', a, storage);
  rememberSubtitleStyle('draft-B', b, storage);
  // A fresh reader represents closing the page before any server write ran.
  assert.deepEqual(readSubtitleStyleRecovery('draft-A', storage), a);
  assert.deepEqual(readSubtitleStyleRecovery('draft-B', storage), b);
  assert.equal(readSubtitleStyleRecovery('parent-project', storage), null);
});

test('a failed save keeps recovery; acknowledging another draft cannot clear it', async () => {
  const storage = memoryStorage(), a = style(true);
  rememberSubtitleStyle('draft-A', a, storage);
  await assert.rejects(saveRememberedSubtitleStyle('draft-A', a, async () => { throw new Error('synthetic save failure'); }, storage));
  acknowledgeSubtitleStyle('draft-B', a, storage);
  assert.deepEqual(readSubtitleStyleRecovery('draft-A', storage), a);
  const writes: string[] = [];
  await saveRememberedSubtitleStyle('draft-A', a, async id => { writes.push(id); }, storage);
  assert.deepEqual(writes, ['draft-A']);
  assert.equal(readSubtitleStyleRecovery('draft-A', storage), null);
});

test('an older successful request cannot delete a newer pending style', () => {
  const storage = memoryStorage(), first = style(true), latest = style(false);
  rememberSubtitleStyle('draft-A', first, storage);
  rememberSubtitleStyle('draft-A', latest, storage);
  acknowledgeSubtitleStyle('draft-A', first, storage);
  assert.deepEqual(readSubtitleStyleRecovery('draft-A', storage), latest);
  acknowledgeSubtitleStyle('draft-A', latest, storage);
  assert.equal(readSubtitleStyleRecovery('draft-A', storage), null);
});
