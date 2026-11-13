import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {filmCaptions} from './captions.mjs';
import {filmHtml} from '../../src/film-doc.mjs';
import {resolveMediaReference} from '../../src/shared-media-reference.mjs';

test('the first caption read after restart resolves a logical source without an earlier preview request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'caption-reference-'));
  const library = join(root, 'library'), project = join(root, 'project'), home = join(root, 'home');
  for (const dir of [library, join(project, 'assets'), home]) await mkdir(dir, {recursive: true});
  const previous = process.env.DAOCUT_STUDIO_HOME;
  process.env.DAOCUT_STUDIO_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DAOCUT_STUDIO_HOME; else process.env.DAOCUT_STUDIO_HOME = previous; });
  const bytes = 'fixture original media', media = join(library, 'source.mp4');
  await writeFile(media, bytes); const info = await stat(media);
  await writeFile(join(home, 'prefs.json'), JSON.stringify({sharedMediaLibraries: [{id: 'test-library', root: library}]}));
  await writeFile(join(project, 'assets/.daocut-source-media.json'), JSON.stringify({version: 1, items: {'assets/source.mp4': {
    mode: 'reference', libraryId: 'test-library', relativePath: 'source.mp4', size: info.size, mtimeMs: info.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }}}));
  await writeFile(join(project, 'film.html'), filmHtml({stage: {w: 912, h: 1920}, tracks: [{clips: [{id: 'clip', src: 'assets/source.mp4', time: [1, 3]}]}]}));
  await writeFile(join(project, 'assets/source.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n一瓶三十九，两瓶五十九。\n');
  assert.throws(() => resolveMediaReference(project, 'assets/source.mp4'), {code: 'SHARED_MEDIA_UNVERIFIED'});
  const captions = await filmCaptions(project, {duration: async () => 4});
  assert.ok(captions.cues.length > 0, 'cold loading must not silently discard the existing transcript');
  assert.match(captions.cues.map(c => c.text).join(''), /三十九/);
  assert.deepEqual(captions.untranscribed, []);
});
