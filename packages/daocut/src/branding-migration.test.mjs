import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brandEnv, brandEnvironment } from './brand-env.mjs';
import { defaultStudioHome, defaultLibraryDir, libraryRoot, studioHomeDir } from './locations.mjs';
import { readSkill, setSkillCover } from './skills.mjs';
import { checkout, commitChanges, discardChanges, restoreCommit, status } from '../studio/server/history.mjs';
import { formatOf } from '../studio/server/history-migrate.mjs';
import { openRepo, readVersion } from '../studio/server/history-store.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'daocut-migration-'));
test('legacy environment and credential values remain available, and new names win', () => {
  const old = { OPENFILM_HOME: '/existing/StudioData', OPENFILM_PI: '{"agentDir":"/existing/agent"}', OPENFILM_BYOK_KEY_1: 'fixture-private-key', DAOCUT_HOME: '/product-root' };
  const current = brandEnvironment(old);
  assert.equal(current.DAOCUT_STUDIO_HOME, old.OPENFILM_HOME);
  assert.equal(current.DAOCUT_HOME, '/product-root', 'the product root must not be confused with StudioData');
  assert.equal(current.DAOCUT_PI, old.OPENFILM_PI);
  assert.equal(current.DAOCUT_BYOK_KEY_1, old.OPENFILM_BYOK_KEY_1);
  assert.equal(brandEnv('STUDIO_HOME', old), old.OPENFILM_HOME);
  assert.equal(brandEnv('STUDIO_HOME', { ...old, DAOCUT_STUDIO_HOME: '/chosen' }), '/chosen');
  assert.equal(old.DAOCUT_STUDIO_HOME, undefined, 'reading does not rewrite inherited settings');
});

test('legacy home and project paths remain in place with their saved preferences', () => {
  const root = scratch();
  const oldLibrary = join(root, process.platform === 'darwin' ? 'Movies' : 'Videos', 'OpenFilm', 'Projects');
  mkdirSync(oldLibrary, { recursive: true });
  assert.equal(defaultLibraryDir(root), oldLibrary);
  const oldHome = join(root, '.openfilm');
  mkdirSync(oldHome);
  assert.equal(defaultStudioHome(root), oldHome);
  mkdirSync(join(root, '.daocut'));
  assert.equal(defaultStudioHome(root), join(root, '.daocut'));
  const keys = ['DAOCUT_STUDIO_HOME', 'DAOCUT_SHARED_HOME', 'DAOCUT_LIBRARY', 'OPENFILM_HOME', 'OPENFILM_SHARED_HOME', 'OPENFILM_LIBRARY'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.OPENFILM_HOME = oldHome;
    const oldProject = join(root, 'OpenFilm', 'Projects');
    writeFileSync(join(oldHome, 'prefs.json'), JSON.stringify({ projectsFolder: oldProject, installedSkills: ['replicate'] }));
    assert.equal(studioHomeDir(), oldHome);
    assert.equal(libraryRoot(), oldProject);
    assert.equal(existsSync(oldProject), false, 'a configuration read never moves or creates projects');
    assert.equal(JSON.parse(readFileSync(join(oldHome, 'prefs.json'), 'utf8')).installedSkills[0], 'replicate');
  } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('legacy skill metadata reads unchanged; new edits retain unknown fields in daocut.json', () => {
  const mine = scratch();
  const folder = join(mine, 'legacy');
  mkdirSync(folder);
  writeFileSync(join(folder, 'SKILL.md'), '---\nname: legacy\ndescription: A saved skill.\n---\nSteps\n');
  const metadata = { title: { en: 'Existing title' }, custom: { user: 'kept' }, repository: 'https://github.com/openfilm/skills' };
  const original = JSON.stringify(metadata);
  writeFileSync(join(folder, 'openfilm.json'), original);
  assert.equal(readSkill(folder, 'mine').shown.title.en, 'Existing title');
  setSkillCover('legacy', null, { mine });
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'daocut.json'), 'utf8')), metadata);
  assert.equal(readFileSync(join(folder, 'openfilm.json'), 'utf8'), original);
  writeFileSync(join(folder, 'daocut.json'), JSON.stringify({ title: 'New title' }));
  assert.equal(readSkill(folder, 'mine').shown.title.en, 'New title');
});

test('old .film markers, media pointers and parked refs restore without rewriting prior commits', async () => {
  const root = scratch();
  writeFileSync(join(root, 'film.html'), '<html><body><section><iframe src="title.html#t=0,1"></iframe><video src="clip.mp4#t=0,1"></video></section></body></html>');
  writeFileSync(join(root, 'title.html'), 'Original page');
  writeFileSync(join(root, 'clip.mp4'), Buffer.from('original media bytes'));
  const first = await commitChanges(root, 'First cut');
  const gitDir = join(root, '.film', 'history');
  const git = (args, input) => execFileSync('git', ['--git-dir=' + gitDir, '--work-tree=' + root, ...args], { cwd: root, encoding: 'utf8', input, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Legacy fixture', GIT_COMMITTER_NAME: 'Legacy fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim();
  const repo = openRepo(root, gitDir);
  const entry = (await readVersion(repo, first)).get('clip.mp4');
  const pointer = `openfilm-media 1\nsha256 ${entry.media.sha256}\nsize ${entry.media.size}\n`;
  const blob = git(['hash-object', '-w', '--stdin'], pointer);
  git(['read-tree', 'HEAD']);
  git(['update-index', '--add', '--cacheinfo', `100644,${blob},clip.mp4`]);
  const tree = git(['write-tree']);
  const legacy = git(['commit-tree', tree, '-p', first, '-m', 'Legacy media version']);
  git(['update-ref', 'refs/heads/main', legacy]);
  renameSync(join(gitDir, 'daocut.json'), join(gitDir, 'openfilm.json'));
  assert.equal(formatOf(gitDir), 2, 'old current-format history must not be migrated again');
  assert.equal((await status(root)).changes, null, 'old pointers do not appear as media changes');
  assert.equal(git(['rev-parse', 'HEAD']), legacy);
  await checkout(root, { target: 'alternate', create: true });
  await checkout(root, { target: 'main' });
  writeFileSync(join(root, 'title.html'), 'Uncommitted original work');
  await checkout(root, { target: 'alternate' });
  const parked = git(['rev-parse', 'refs/daocut/parked/main']);
  git(['update-ref', 'refs/openfilm/parked/main', parked]);
  git(['update-ref', '-d', 'refs/daocut/parked/main']);
  assert.equal((await status(root)).branches.find(branch => branch.name === 'main').parked, true);
  await checkout(root, { target: 'main' });
  assert.equal(readFileSync(join(root, 'title.html'), 'utf8'), 'Uncommitted original work');
  await discardChanges(root);
  writeFileSync(join(root, 'clip.mp4'), 'Changed media');
  const changed = await commitChanges(root, 'Changed media fixture');
  const legacyCommit = git(['cat-file', '-p', legacy]);
  await restoreCommit(root, legacy);
  assert.equal(readFileSync(join(root, 'clip.mp4'), 'utf8'), 'original media bytes');
  assert.equal(git(['rev-parse', 'HEAD']), changed, 'restore leaves the current commit in place');
  assert.equal(git(['cat-file', '-p', legacy]), legacyCommit, 'the legacy commit remains byte-for-byte unchanged');
  assert.equal(existsSync(join(gitDir, 'openfilm.json')), true);
  assert.equal(existsSync(join(gitDir, 'daocut.json')), false, 'reading a current old marker does not rewrite it');
});
