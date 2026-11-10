import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateBrandStorage } from './storage-migration.ts';

test('existing preferences and per-project UI state migrate without replacing newer choices or deleting old values', () => {
  const values = new Map([
    ['openfilm.language', 'zh-CN'], ['openfilm.theme', 'light'], ['daocut.theme', 'dark'],
    ['openfilm.local-agents.v2', '{"picked":"byok"}'], ['openfilm.timeline.snap', '0'],
    ['openfilm-studio:reloaded-for', '0.2.8'], ['unrelated', 'preserved'],
  ]);
  const storage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  migrateBrandStorage(storage);
  assert.equal(values.get('daocut.language'), 'zh-CN');
  assert.equal(values.get('daocut.theme'), 'dark');
  assert.equal(values.get('daocut.local-agents.v2'), '{"picked":"byok"}');
  assert.equal(values.get('daocut.timeline.snap'), '0');
  assert.equal(values.get('daocut-studio:reloaded-for'), '0.2.8');
  assert.equal(values.get('openfilm.theme'), 'light');
  assert.equal(values.get('unrelated'), 'preserved');
  values.set('daocut.language', 'ja');
  migrateBrandStorage(storage);
  assert.equal(values.get('daocut.language'), 'ja');
  values.delete('daocut.language'); // Choosing System deliberately removes the explicit language.
  migrateBrandStorage(storage); // A reload must not resurrect the pre-migration choice.
  assert.equal(values.has('daocut.language'), false);
  assert.equal(values.get('openfilm.language'), 'zh-CN', 'legacy data remains untouched');
});
