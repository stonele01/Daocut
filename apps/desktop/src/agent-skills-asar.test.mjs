import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sessionSkills } from './agent-skills.mjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Read an already installed binary path without importing electron's downloader.
const electronPackage = dirname(require.resolve('electron/package.json'));
const electronPathFile = join(electronPackage, 'path.txt');
const electron = process.env.DAOCUT_TEST_ELECTRON || (existsSync(electronPathFile) ? join(electronPackage, 'dist', readFileSync(electronPathFile, 'utf8').trim()) : null);
const body = '---\nname: packed-check\ndescription: A packaged skill used to verify real filesystem links.\n---\n\nPackaged body and relative resources must reach the Agent.\n';
const putSkill = (folder, text = body) => {
  mkdirSync(join(folder, 'references'), { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), text);
  writeFileSync(join(folder, 'references', 'note.txt'), 'Relative packaged resource.');
};

// This uses a real ASAR, real Electron fs and real Windows junctions, not mocked path strings.
test('Windows: every Agent link reaches unpacked ASAR skills, and Pi loads their body', {
  skip: process.platform !== 'win32' ? 'Windows junction regression' : !electron || !existsSync(electron) ? 'Set DAOCUT_TEST_ELECTRON to an existing Electron executable' : false,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-agent-asar-'));
  const source = join(root, 'source');
  putSkill(join(source, 'skills', 'packed-check'));
  const archive = join(root, 'app.asar');
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const { createPackageWithOptions } = appBuilderRequire('@electron/asar');
  await createPackageWithOptions(source, archive, { unpackDir: 'skills' });
  const realSkill = join(archive + '.unpacked', 'skills', 'packed-check');
  assert.equal(readFileSync(join(realSkill, 'SKILL.md'), 'utf8'), body);
  const paths = Object.fromEntries(['home', 'studio', 'library', 'mine', 'data', 'project', 'appdata', 'localappdata'].map(name => [name, join(root, name)]));
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(paths.studio, 'prefs.json'), JSON.stringify({ skillsInstalled: ['packed-check'] }));
  const script = join(root, 'verify.mjs');
  writeFileSync(script, `
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const [sourceModule, piModule, coreModule, config] = process.argv.slice(2);
const { paths, archive } = JSON.parse(config);
const { sessionSkills } = await import(sourceModule);
const { listSkills } = await import(coreModule);
const virtual = listSkills({ mine: paths.mine })[0].folder;
assert.equal(virtual, join(archive, 'skills', 'packed-check'));
const { DefaultResourceLoader, SettingsManager } = await import(piModule);
const outputs = [];
for (const agent of ['byok', 'claude', 'codex', 'opencode', 'qwen', 'copilot']) {
  const session = await sessionSkills(agent, { cwd: paths.project, home: paths.home, dataDir: paths.data, mine: paths.mine, prefsHome: paths.studio });
  assert.deepEqual(session.log.daocut, ['packed-check']);
  const file = join(session.log.folder, 'skills', 'packed-check', 'SKILL.md');
  assert.equal(realpathSync(file), realpathSync(join(archive + '.unpacked', 'skills', 'packed-check', 'SKILL.md')));
  assert.equal(readFileSync(join(session.log.folder, '.agents', 'skills', 'packed-check', 'references', 'note.txt'), 'utf8'), 'Relative packaged resource.');
  if (agent === 'byok') {
    const loader = new DefaultResourceLoader({ cwd: paths.project, agentDir: join(paths.data, 'pi'), settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noPromptTemplates: true, noThemes: true, noSkills: false, additionalSkillPaths: session.piSkills.paths,
      skillsOverride: base => ({ ...base, skills: base.skills.filter(skill => session.piSkills.names.includes(skill.name)) }),
      systemPromptOverride: () => '', appendSystemPromptOverride: () => [], agentsFilesOverride: () => ({ agentsFiles: [] }) });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ['packed-check']);
    assert.equal(readFileSync(loader.getSkills().skills[0].filePath, 'utf8'), readFileSync(file, 'utf8'));
  }
  outputs.push({ agent, file });
}
console.log(JSON.stringify(outputs));
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DAOCUT_') && !key.startsWith('OPENFILM_')));
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata, XDG_CONFIG_HOME: join(paths.home, '.config'),
    DAOCUT_STUDIO_HOME: paths.studio, DAOCUT_SHARED_HOME: paths.studio, DAOCUT_LIBRARY: paths.library, DAOCUT_SKILLS: paths.mine,
    DAOCUT_OFFICIAL_SKILLS: join(archive, 'skills') });
  const stdout = execFileSync(electron, [script, pathToFileURL(join(desktop, 'src/agent-skills.mjs')).href,
    pathToFileURL(join(desktop, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href,
    pathToFileURL(require.resolve('daocut/skills')).href, JSON.stringify({ paths, archive })], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const outputs = JSON.parse(stdout.trim());
  assert.equal(outputs.length, 6);
  for (const { file } of outputs) {
    assert.equal(readFileSync(file, 'utf8'), body, 'ordinary Node can read the link without Electron ASAR support');
    assert.equal(realpathSync(file), realpathSync(join(realSkill, 'SKILL.md')));
  }
});

test('an ordinary directory named .asar keeps its original target even with an unpacked sibling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'daocut-agent-asar-directory-'));
  const official = join(root, 'app.asar', 'skills');
  putSkill(join(official, 'packed-check'));
  putSkill(join(root, 'app.asar.unpacked', 'skills', 'packed-check'), 'Wrong sibling body.');
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(home); mkdirSync(cwd);
  writeFileSync(join(home, 'prefs.json'), JSON.stringify({ skillsInstalled: ['packed-check'] }));
  const previous = process.env.DAOCUT_OFFICIAL_SKILLS;
  process.env.DAOCUT_OFFICIAL_SKILLS = official;
  try {
    const session = await sessionSkills('byok', { cwd, home, prefsHome: home, dataDir: join(root, 'data'), mine: join(root, 'mine') });
    const file = join(session.piSkills.paths[0], 'packed-check', 'SKILL.md');
    assert.equal(readFileSync(file, 'utf8'), body);
    assert.equal(realpathSync(file), realpathSync(join(official, 'packed-check', 'SKILL.md')));
  } finally {
    if (previous === undefined) delete process.env.DAOCUT_OFFICIAL_SKILLS; else process.env.DAOCUT_OFFICIAL_SKILLS = previous;
  }
});
