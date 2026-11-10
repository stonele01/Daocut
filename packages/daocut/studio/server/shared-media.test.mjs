import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { addSharedMedia, associateSharedLibrary, browseSharedFolder, createSharedMediaProject, listSharedProjectMedia, refreshSharedMedia, resolveSharedMedia, sharedMediaManifest } from './shared-media.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { readFilmFile } from '../../src/film-doc.mjs';

let scratch;
let oldHome;
let oldLibrary;

beforeEach(() => {
  const temporaryRoot = process.env.DAOCUT_TEST_TMP || join(process.cwd(), '.test-temp');
  mkdirSync(temporaryRoot, { recursive: true });
  scratch = mkdtempSync(join(temporaryRoot, 'of-shared-media-'));
  oldHome = process.env.DAOCUT_STUDIO_HOME;
  oldLibrary = process.env.DAOCUT_LIBRARY;
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'projects');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.DAOCUT_STUDIO_HOME; else process.env.DAOCUT_STUDIO_HOME = oldHome;
  if (oldLibrary === undefined) delete process.env.DAOCUT_LIBRARY; else process.env.DAOCUT_LIBRARY = oldLibrary;
});

test('a shared product listing reads only its direct videos and transcript files, never a path outside its configured root', async () => {
  const root = join(scratch, 'source');
  const product = join(root, '氨基酸洗面奶');
  const outside = join(scratch, 'outside');
  mkdirSync(join(product, 'nested'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(product, 'take.mp4'), 'video');
  writeFileSync(join(product, 'take.vtt'), 'captions');
  writeFileSync(join(product, 'nested', 'not-scanned.mp4'), 'video');
  writeFileSync(join(outside, 'other.mp4'), 'video');
  const library = await associateSharedLibrary({ id: 'shared-self-operated-01', name: '往期自营素材', root });
  const listed = await browseSharedFolder({ libraryId: library.id, folder: product });
  assert.deepEqual(listed.videos.map((file) => file.path), ['氨基酸洗面奶/take.mp4']);
  assert.deepEqual(listed.transcripts.map((file) => file.path), ['氨基酸洗面奶/take.vtt']);
  await assert.rejects(browseSharedFolder({ libraryId: library.id, folder: outside }), /inside the material library/);
});

test('adds multiple selected videos as logical references without duplicate assets or nested files', async () => {
  const root = join(scratch, 'source');
  const folder = join(root, 'product');
  const projectRoot = join(scratch, 'project');
  mkdirSync(join(folder, 'nested'), { recursive: true });
  mkdirSync(projectRoot);
  for (const name of ['one.mp4', 'two.mov', 'nested/hidden.mp4']) writeFileSync(join(folder, name), name);
  await associateSharedLibrary({ id: 'shared-existing-01', name: 'Library', root });
  const request = { projectRoot, libraryId: 'shared-existing-01', folder, videoPaths: ['product/one.mp4', 'product/two.mov'] };
  const [first] = await Promise.all([addSharedMedia(request), addSharedMedia(request)]);
  assert.equal(first.assets.length, 2);
  assert.deepEqual((await addSharedMedia(request)).assets, first.assets);
  assert.equal(Object.keys((await sharedMediaManifest(projectRoot)).items).length, 2);
  assert.ok(first.assets.every((asset) => !existsSync(join(projectRoot, asset))), 'no filesystem link or copied video');
  for (const asset of first.assets) assert.ok((await resolveSharedMedia(projectRoot, asset)).path.startsWith(folder));
  await assert.rejects(addSharedMedia({ ...request, videoPaths: ['product/nested/hidden.mp4'] }), /directly inside/);
  await assert.rejects(addSharedMedia({ ...request, videoPaths: ['../outside.mp4'] }));
});

test('a personal project records a portable source reference, stays timeline-empty, and follows the same library id on another local root', async () => {
  const firstRoot = join(scratch, 'first-root');
  const secondRoot = join(scratch, 'second-root');
  const changedRoot = join(scratch, 'changed-root');
  const relative = '氨基酸洗面奶/take.mp4';
  const stamp = new Date('2026-01-02T03:04:05.000Z');
  for (const root of [firstRoot, secondRoot, changedRoot]) mkdirSync(join(root, '氨基酸洗面奶'), { recursive: true });
  const first = join(firstRoot, ...relative.split('/'));
  const second = join(secondRoot, ...relative.split('/'));
  const changed = join(changedRoot, ...relative.split('/'));
  writeFileSync(first, 'same source bytes');
  writeFileSync(second, 'same source bytes');
  writeFileSync(changed, 'different bytes!');
  for (const file of [first, second]) utimesSync(file, stamp, stamp);
  utimesSync(changed, new Date(stamp.getTime() + 5000), new Date(stamp.getTime() + 5000));

  const library = await associateSharedLibrary({ id: 'shared-self-operated-02', name: '往期自营素材', root: firstRoot });
  const [one, duplicate] = await Promise.all([
      createSharedMediaProject({ libraryId: library.id, videoPath: relative, requestId: 'request-0001' }),
      createSharedMediaProject({ libraryId: library.id, videoPath: relative, requestId: 'request-0001' }),
    ]);
  assert.equal(one.project.id, duplicate.project.id, 'the same double-click request makes one project');
  assert.equal(one.asset, duplicate.asset, 'the same request links one asset');
  const repeated = await createSharedMediaProject({ libraryId: library.id, videoPath: relative, requestId: 'request-0001' });
  assert.equal(repeated.project.id, one.project.id, 'a delayed retry with the same request id does not make a second project');
  assert.equal(existsSync(join(one.project.path, ...one.asset.split('/'))), false, 'the video is neither linked nor copied');
  assert.deepEqual(readFilmFile(readFileSync(join(one.project.path, 'film.html'), 'utf8')).doc.tracks, [], 'creating a project does not put the original on the final timeline');
  const manifestText = readFileSync(join(one.project.path, 'assets', '.daocut-source-media.json'), 'utf8');
  assert.ok(!manifestText.includes(firstRoot), 'the project manifest does not store this computer’s physical root');
  const manifest = await sharedMediaManifest(one.project.path);
  assert.deepEqual(manifest.items[one.asset], { libraryId: library.id, libraryName: '往期自营素材', relativePath: relative, size: Buffer.byteLength('same source bytes'), mtimeMs: stamp.getTime(), mode: 'reference', sha256: createHash('sha256').update('same source bytes').digest('hex') });
  const { analysis } = await readProductAnalysis(one.project.path);
  assert.equal(analysis.products[0].name, '氨基酸洗面奶');
  assert.equal(analysis.sources[0].assetPath, one.asset);
  assert.equal(analysis.sources[0].durationMs, null);
  assert.deepEqual(analysis.products[0].sourceIds, [analysis.sources[0].id]);
  assert.deepEqual(analysis.intervals, []);
  assert.deepEqual(analysis.candidates, []);

  await associateSharedLibrary({ id: library.id, name: library.name, root: secondRoot });
  const moved = await listSharedProjectMedia(one.project.path);
  assert.equal(moved.links[one.asset]?.source?.status, 'available');
  assert.equal((await resolveSharedMedia(one.project.path, one.asset)).path, realpathSync(second), 'the same library id resolves the source on this computer');

  await associateSharedLibrary({ id: library.id, name: library.name, root: changedRoot });
  const states = await refreshSharedMedia(one.project.path);
  assert.equal(states[one.asset]?.status, 'needs-confirmation', 'size/time disagreement is a warning, not an automatic replacement');
  await assert.rejects(resolveSharedMedia(one.project.path, one.asset), /changed/, 'a differing candidate cannot be used');
  assert.equal(readFileSync(second, 'utf8'), 'same source bytes', 'the original source is untouched');
});

test('a size or modified-time disagreement asks for confirmation and leaves the project asset alone', async () => {
  const root = join(scratch, 'source');
  const relative = '氨基酸洗面奶/take.mp4';
  const source = join(root, ...relative.split('/'));
  const project = join(scratch, 'project');
  mkdirSync(join(project, 'assets'), { recursive: true });
  mkdirSync(join(root, '氨基酸洗面奶'), { recursive: true });
  writeFileSync(source, 'different source');
  writeFileSync(join(project, 'assets', 'take.mp4'), 'the existing project link is untouched');
  writeFileSync(join(project, 'assets', '.daocut-source-media.json'), JSON.stringify({
    version: 1,
    items: {
      'assets/take.mp4': {
        libraryId: 'shared-self-operated-04', libraryName: '往期自营素材', relativePath: relative,
        size: 1, mtimeMs: 1,
      },
    },
  }));
  await associateSharedLibrary({ id: 'shared-self-operated-04', name: '往期自营素材', root });
  const states = await refreshSharedMedia(project);
  assert.equal(states['assets/take.mp4']?.status, 'needs-confirmation');
  assert.equal(readFileSync(join(project, 'assets', 'take.mp4'), 'utf8'), 'the existing project link is untouched');
});

test('read-only resolution accepts only the registered matching library link', async t => {
  const root = join(scratch, 'source'), project = join(scratch, 'project');
  mkdirSync(root); mkdirSync(join(project, 'assets'), { recursive: true });
  const file = join(root, 'video.mp4'), other = join(root, 'other.mp4');
  writeFileSync(file, 'video'); writeFileSync(other, 'other');
  const stamp = new Date('2026-01-02T03:04:05Z'); utimesSync(file, stamp, stamp);
  const link = join(project, 'assets', 'video.mp4');
  try { symlinkSync(file, link, 'file'); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows symbolic-link permission unavailable'); return; }
    throw error;
  }
  await associateSharedLibrary({ id: 'shared-resolver-01', name: 'Library', root });
  const manifest = join(project, 'assets', '.daocut-source-media.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, items: { 'assets/video.mp4': { libraryId: 'shared-resolver-01', libraryName: 'Library', relativePath: 'video.mp4', size: 5, mtimeMs: stamp.getTime() } } }));
  assert.equal((await resolveSharedMedia(project, 'assets/video.mp4')).path, realpathSync(file));
  await assert.rejects(resolveSharedMedia(project, 'assets/other.mp4'), /not registered/);
  await assert.rejects(resolveSharedMedia(project, 'assets/../video.mp4'));
  writeFileSync(file, 'changed');
  await assert.rejects(resolveSharedMedia(project, 'assets/video.mp4'), /changed/);
  writeFileSync(file, 'video'); utimesSync(file, stamp, stamp);
  rmSync(link); symlinkSync(other, link, 'file');
  await assert.rejects(resolveSharedMedia(project, 'assets/video.mp4'), /does not match/);
  assert.equal(realpathSync(link), realpathSync(other));
});
