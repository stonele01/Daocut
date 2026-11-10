import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prefsOf, readPrefs, writePrefs } from './prefs.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/shared-live-20261104/ui');
mkdirSync(base, { recursive: true });

test('shared analysis is opt-in and accepts only portable library ids with absolute result roots', () => {
  assert.deepEqual(prefsOf(null).sharedAnalysis, { enabled: false, resultRoots: [] });
  const root = resolve(base, 'not-created-result-root');
  const sharedAnalysis = prefsOf({ sharedAnalysis: { enabled: true, resultRoots: [
    { libraryId: 'library-one', root }, { libraryId: 'library-one', root: resolve(base, 'other') },
    { libraryId: '../bad', root }, { libraryId: 'library-two', root: 'relative/path' },
  ] } }).sharedAnalysis;
  assert.deepEqual(sharedAnalysis, { enabled: true, resultRoots: [{ libraryId: 'library-one', root }] });
  assert.equal(existsSync(root), false, 'reading settings never creates a shared directory');
});

test('shared analysis settings survive reopen without changing media mappings or creating the result folder', () => {
  const home = mkdtempSync(join(base, 'prefs-'));
  const old = process.env.DAOCUT_STUDIO_HOME;
  process.env.DAOCUT_STUDIO_HOME = home;
  try {
    const library = { id: 'library-one', name: '模拟素材库', root: resolve(base, 'media') };
    const sharedAnalysis = { enabled: true, resultRoots: [{ libraryId: library.id, root: resolve(home, 'shared-results') }] };
    writePrefs({ sharedMediaLibraries: [library] });
    writePrefs({ sharedAnalysis });
    assert.deepEqual(readPrefs().sharedAnalysis, sharedAnalysis);
    assert.deepEqual(readPrefs().sharedMediaLibraries, [library]);
    writePrefs({ proxies: { on: false } });
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'prefs.json'), 'utf8')).sharedAnalysis, sharedAnalysis);
    assert.equal(existsSync(sharedAnalysis.resultRoots[0].root), false);
  } finally {
    if (old === undefined) delete process.env.DAOCUT_STUDIO_HOME; else process.env.DAOCUT_STUDIO_HOME = old;
  }
});
