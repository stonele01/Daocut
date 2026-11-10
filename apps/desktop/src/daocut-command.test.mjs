import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandScript, commandScriptWindows, installDaocutCommand } from './daocut-command.mjs';

test("the daocut command alone has the app's ffmpeg first and its browser; the agent's PATH is left as it is", () => {
  const sh = commandScript('/app/node', '/app/daocut.mjs', { platform: 'darwin', ffmpeg: '/app/ffmpeg', env: { PLAYWRIGHT_BROWSERS_PATH: '/app/pw' } });
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /PLAYWRIGHT_BROWSERS_PATH='\/app\/pw' PATH='\/app\/ffmpeg':"\$PATH" ELECTRON_RUN_AS_NODE=1 DAOCUT_NO_UPDATE_CHECK=1 DAOCUT_RUN=daocut exec '\/app\/node' '\/app\/daocut.mjs' "\$@"\n$/);
  assert.doesNotMatch(commandScript('/n', '/c'), /PATH=/);
  const cmd = commandScriptWindows('C:\\app\\node.exe', 'C:\\app\\daocut.mjs', { ffmpeg: 'C:\\app\\ffmpeg', env: { PLAYWRIGHT_BROWSERS_PATH: 'C:\\pw' } });
  assert.match(cmd, /setlocal\r\nset "PLAYWRIGHT_BROWSERS_PATH=C:\\pw"\r\nset "PATH=C:\\app\\ffmpeg;%PATH%"\r\n/);
});

test('a script run through as-node.mjs sees itself as the script, with its arguments, and no ELECTRON_RUN_AS_NODE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daocut-as-node-'));
  try {
    const script = join(dir, 'show.mjs');
    writeFileSync(script, "console.log(JSON.stringify({ argv: process.argv.slice(1), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n");
    const asNode = fileURLToPath(new URL('./as-node.mjs', import.meta.url));
    const out = JSON.parse(execFileSync(process.execPath, [asNode, script, '--flag', 'x'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
    assert.deepEqual(out, { argv: [script, '--flag', 'x'], runAsNode: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('Daocut runs its bundled CLI without suggesting a second installation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daocut-command-'));
  try {
    const bin = installDaocutCommand(dir, { node: process.execPath, env: {
      DAOCUT_STUDIO_HOME: join(dir, 'studio'), DAOCUT_SHARED_HOME: join(dir, 'studio'),
      DAOCUT_LIBRARY: join(dir, 'projects'), DAOCUT_SKILLS: join(dir, 'skills'),
    } });
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const run = (name, args) => {
      const file = join(bin, name + suffix);
      return process.platform === 'win32'
        ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file, ...args], { encoding: 'utf8' })
        : execFileSync(file, args, { encoding: 'utf8' });
    };
    assert.ok(existsSync(join(bin, 'daocut' + suffix)));
    for (const args of [[], ['--help'], ['look', '--help'], ['--version']]) {
      const current = run('daocut', args);
      if (!args.includes('--version')) {
        assert.match(current, /daocut/);
        assert.doesNotMatch(current, /npx.*(?:daocut|openfilm)|\bOpenFilm\b|`openfilm /);
      }
    }
    const skillFolder = join(dir, 'skills', 'brand-fixture');
    mkdirSync(skillFolder, { recursive: true });
    const preserved = 'Source: https://github.com/openfilm/skills\nProject: D:/OpenFilm/Projects/example\nModule: node_modules/openfilm/bin/openfilm.mjs';
    writeFileSync(join(skillFolder, 'SKILL.md'), `---\nname: brand-fixture\ndescription: A local compatibility fixture.\n---\n${preserved}\nRun \`daocut look\`.\n`);
    const skill = run('daocut', ['skill', 'brand-fixture']);
    assert.ok(skill.includes(preserved), 'real source URLs, stored paths and module paths stay unchanged');
    assert.match(skill, /Run `daocut look`/);
    assert.equal(run('daocut', ['skill', 'brand-fixture']), skill);
    const other = installDaocutCommand(join(dir, 'other'), { platform: process.platform === 'win32' ? 'darwin' : 'win32' });
    const otherSuffix = process.platform === 'win32' ? '' : '.cmd';
    assert.ok(existsSync(join(other, 'daocut' + otherSuffix)));
    assert.ok(existsSync(join(other, 'daocut' + otherSuffix)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


const gitBash = process.platform === 'win32' ? [
  process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
].filter(Boolean).find(existsSync) : null;

test('Windows Git Bash resolves the bundled bare command and preserves paths, arguments and runtime environment', { skip: !gitBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'daocut bash 中文 '));
  try {
    const ffmpeg = join(dir, 'media tools');
    mkdirSync(ffmpeg);
    const browser = join(dir, 'browser files');
    const bin = installDaocutCommand(dir, { node: process.execPath, ffmpeg, env: { PLAYWRIGHT_BROWSERS_PATH: browser } });
    assert.ok(existsSync(join(bin, 'daocut.cmd')));
    assert.ok(existsSync(join(bin, 'daocut')));
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toUpperCase() === 'PATH') delete env[name];
    env.PATH = [bin, process.env.PATH ?? process.env.Path ?? ''].join(';');
    const run = (command) => execFileSync(gitBash, ['-c', command], { encoding: 'utf8', windowsHide: true, env });
    assert.match(run('daocut --version').trim(), /^\d+\.\d+\.\d+/);
    assert.match(run('daocut look --help'), /contact sheet/);
    const script = join(dir, 'show runtime.mjs');
    writeFileSync(script, 'console.log(JSON.stringify({args: process.argv.slice(2), browser: process.env.PLAYWRIGHT_BROWSERS_PATH, path: process.env.PATH, run: process.env.DAOCUT_RUN}));\n');
    writeFileSync(join(bin, 'show-runtime'), commandScript(process.execPath, script, { ffmpeg, env: { PLAYWRIGHT_BROWSERS_PATH: browser } }));
    const actual = JSON.parse(run(`show-runtime 'two words' '中文' 'a"b'`));
    assert.deepEqual(actual.args, ['two words', '中文', 'a"b']);
    assert.equal(actual.browser, browser);
    assert.equal(actual.run, 'daocut');
    assert.equal(actual.path.split(';')[0].replaceAll('\\', '/').toLowerCase(), ffmpeg.replaceAll('\\', '/').toLowerCase());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
