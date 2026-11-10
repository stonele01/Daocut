import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { AGENT_IDS } from '../src/agent-definitions.mjs';
import { readChoices } from '../src/agent-roster.mjs';
import { writeNasTestLauncher } from './nas-test-launcher.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scratch = join(repo, '.tmp/nas-test-launcher-20261105');
mkdirSync(scratch, { recursive: true });

function fixture() {
  const root = mkdtempSync(join(scratch, '中文 空格 '));
  mkdirSync(join(root, 'App'));
  const probe = `import { writeFileSync } from 'node:fs';
import { IDENTITY } from ${JSON.stringify(pathToFileURL(join(repo, 'apps/desktop/src/flavor.mjs')).href)};
const names = ['DAOCUT_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_SHARED_HOME', 'DAOCUT_COMPANY_PROFILE', 'OPENFILM_HOME', 'OPENFILM_COMPANY_PROFILE', 'DOUBAO_ASR_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'TEMP', 'TMP', 'KEEP_TEST_VALUE'];
writeFileSync(new URL('../observed.json', import.meta.url), JSON.stringify({ env: Object.fromEntries(names.map(n => [n, process.env[n] ?? null])), identity: IDENTITY, cwd: process.cwd(), args: process.argv.slice(2) }));
process.exitCode = 17;
`;
  writeFileSync(join(root, 'App/probe.mjs'), probe);
  writeFileSync(join(root, 'App/probe.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0probe.mjs" %*\r\nexit /b %errorlevel%\r\n`, 'ascii');
  return root;
}

function run(root, extraEnv = {}, args = []) {
  // Only fake values enter this fixture; the probe writes no real credentials.
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', join(root, '启动测试版.cmd'), ...args], {
    encoding: 'utf8', windowsHide: true, cwd: scratch,
    env: { ...process.env, ...extraEnv }, timeout: 15000,
  });
}

test('Windows launcher runs the app with independent paths, clears old configuration and keeps exit status', () => {
  const root = fixture();
  const old = join(root, 'old-install');
  mkdirSync(old);
  writeFileSync(join(old, 'prefs.json'), 'unchanged old settings');
  writeNasTestLauncher(root, { appRelativePath: 'App\\probe.cmd' });
  const result = run(root, {
    DAOCUT_HOME: old, DAOCUT_LIBRARY: old, DAOCUT_SHARED_HOME: old, DAOCUT_COMPANY_PROFILE: old,
    OPENFILM_HOME: old, OPENFILM_COMPANY_PROFILE: old,
    DOUBAO_ASR_API_KEY: 'fixture-doubao', DEEPSEEK_API_KEY: 'fixture-deepseek', OPENAI_API_KEY: 'fixture-openai',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--trace-warnings', KEEP_TEST_VALUE: 'keep-this',
  }, ['--remote-debugging-port=12345']);
  assert.equal(result.status, 17, result.stderr || result.stdout);
  const observed = JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8'));
  assert.equal(observed.env.DAOCUT_HOME, join(root, 'Data'));
  assert.equal(observed.env.TEMP, join(root, 'Temp'));
  assert.equal(observed.env.TMP, join(root, 'Temp'));
  assert.equal(observed.env.KEEP_TEST_VALUE, 'keep-this');
  for (const name of ['DAOCUT_LIBRARY', 'DAOCUT_SHARED_HOME', 'DAOCUT_COMPANY_PROFILE', 'OPENFILM_HOME', 'OPENFILM_COMPANY_PROFILE', 'DOUBAO_ASR_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) assert.equal(observed.env[name], null, name);
  assert.equal(observed.identity.library, join(root, 'Data/Projects'));
  assert.equal(observed.identity.studioHome, join(root, 'Data/StudioData'));
  assert.equal(observed.identity.userData, join(root, 'Data/AppData'));
  assert.equal(observed.identity.sharedHome, join(root, 'Data/StudioData'));
  assert.equal(observed.cwd, root);
  assert.deepEqual(observed.args, ['--remote-debugging-port=12345']);
  assert.equal(readFileSync(join(old, 'prefs.json'), 'utf8'), 'unchanged old settings');
});

test('caller environment and current directory survive a launcher call', () => {
  const root = fixture();
  writeNasTestLauncher(root, { appRelativePath: 'App\\probe.cmd' });
  const caller = join(root, 'caller.cmd');
  writeFileSync(caller, '@echo off\r\nchcp 65001 >nul\r\nset "DAOCUT_HOME=caller-original"\r\nset "OPENFILM_HOME=caller-legacy"\r\ncall "%~dp0启动测试版.cmd"\r\necho caller:%DAOCUT_HOME%:%OPENFILM_HOME%\r\ncd\r\n', 'utf8');
  // The caller uses UTF-8 for the test's Chinese filename; the distributed launcher itself is ASCII.
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', caller], { encoding: 'utf8', windowsHide: true, cwd: scratch, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /caller:caller-original:caller-legacy/);
  assert.ok(result.stdout.includes(scratch), result.stdout);
});

test('fresh seed disconnects every agent and preparing again cannot overwrite saved test choices', () => {
  const root = fixture();
  const launcher = writeNasTestLauncher(root, { appRelativePath: 'App\\probe.cmd' });
  assert.equal(launcher, join(root, '启动测试版.cmd'));
  const choices = readChoices(join(root, 'Data/AppData'));
  assert.deepEqual(choices.disconnected, [...AGENT_IDS]);
  for (const id of AGENT_IDS) assert.equal(choices.shown[id], false);
  assert.equal(choices.byok, null);
  const saved = '{"personal":"keep"}';
  writeFileSync(join(root, 'Data/AppData/agents.json'), saved);
  assert.throws(() => writeNasTestLauncher(root, { appRelativePath: 'App\\probe.cmd' }), /existing|exists/i);
  assert.equal(readFileSync(join(root, 'Data/AppData/agents.json'), 'utf8'), saved);
  assert.equal(run(root).status, 17);
  assert.equal(readFileSync(join(root, 'Data/AppData/agents.json'), 'utf8'), saved, 'launching never resets saved choices');
});

test('missing app or app outside the package is rejected without creating configuration', () => {
  const root = mkdtempSync(join(scratch, 'missing-'));
  assert.throws(() => writeNasTestLauncher(root), /missing|exist/i);
  assert.equal(existsSync(join(root, 'Data')), false);
  assert.throws(() => writeNasTestLauncher(root, { appRelativePath: '..\\old\\Daocut.exe' }), /relative|inside/i);
  assert.equal(existsSync(join(root, 'Data')), false);
});
