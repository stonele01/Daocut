/**
 * The `daocut` command the chat's agents run: this app's copy of the package, so the Studio it finds is the one in
 * the window, at the version the window runs. A small script in the app's data folder, put first on the agents' PATH;
 * it runs the package's CLI with the app's own Node (Electron as Node). Reads no Electron module.
 *
 * DAOCUT_NO_UPDATE_CHECK: the CLI's "a newer daocut is out, run npx -y daocut@latest" is not for this copy. The
 * app updates itself, and with it this command and the window's Studio: there is nothing for an agent to run.
 *
 * What the command alone needs from the app is set in it, not given to the agent: the app's ffmpeg first on its PATH
 * (`ffmpeg`) and the headless browser it draws pages in (`env`, PLAYWRIGHT_BROWSERS_PATH). The agent's own commands run
 * with the person's ffmpeg and their own browsers, as in their terminal.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { nodeBinary } from './node-runtime.mjs';

const require = createRequire(import.meta.url);

/** The package's CLI. */
export function daocutCli() {
  const manifest = require.resolve('daocut/package.json');
  const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin.daocut;
  return join(dirname(manifest), bin);
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The script's text: Electron as Node, running the CLI with whatever it was given, with the app's ffmpeg and `env`. */
export function commandScript(node, cli, { ffmpeg = null, env = {}, platform = process.platform } = {}) {
  // Git Bash accepts drive paths for executables, but PATH entries must use its POSIX form.
  const slash = (path) => platform === 'win32' ? path.replaceAll('\\', '/') : path;
  node = slash(node);
  cli = slash(cli);
  const searchPath = ffmpeg && (platform === 'win32' ? `"$(cygpath -u ${sq(ffmpeg)})"` : sq(ffmpeg));
  const set = [...Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`), ...(searchPath ? [`PATH=${searchPath}:"$PATH"`] : [])];
  return `#!/bin/sh\n# Daocut's bundled command (written by the app; changes are lost)\n${set.map((s) => `${s} `).join('')}ELECTRON_RUN_AS_NODE=1 DAOCUT_NO_UPDATE_CHECK=1 DAOCUT_RUN=daocut exec ${sq(node)} ${sq(cli)} "$@"\n`;
}

/** The same for Windows: a `.cmd` (what a command line there finds as `daocut`). */
export function commandScriptWindows(node, cli, { ffmpeg = null, env = {} } = {}) {
  const set = [...Object.entries(env).map(([k, v]) => `set "${k}=${v}"\r\n`), ...(ffmpeg ? [`set "PATH=${ffmpeg};%PATH%"\r\n`] : [])];
  return `@echo off\r\nrem Daocut's bundled command (written by the app; changes are lost)\r\nsetlocal\r\n${set.join('')}set ELECTRON_RUN_AS_NODE=1\r\nset DAOCUT_NO_UPDATE_CHECK=1\r\nset DAOCUT_RUN=daocut\r\n"${node}" "${cli}" %*\r\n`;
}

/**
 * Write the command into `<dir>/bin` and answer that folder, for PATH. `ffmpeg`: the app's ffmpeg folder, first on the
 * command's PATH; `env`: what else it runs with.
 */
export function installDaocutCommand(dir, { node = nodeBinary(), platform = process.platform, ffmpeg = null, env = {} } = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  if (platform === 'win32') {
    for (const name of ['daocut.cmd']) {
      writeFileSync(join(bin, name), commandScriptWindows(node, daocutCli(), { ffmpeg, env }));
    }
  }
  // npm's Windows bin links provide both .cmd and extensionless sh launchers. Git Bash does not
  // resolve a bare `daocut` to daocut.cmd, although cmd.exe and PowerShell do.
  for (const name of ['daocut']) {
    const file = join(bin, name);
    writeFileSync(file, commandScript(node, daocutCli(), { ffmpeg, env, platform }));
    chmodSync(file, 0o755);
  }
  return bin;
}
