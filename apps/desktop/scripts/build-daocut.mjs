/**
 * Build an unsigned Daocut Windows x64 app from this checkout.
 * Build Studio and shell first; then: node apps/desktop/scripts/build-daocut.mjs
 * Optional: --nsis, --runtime=<prepared runtime>, --updates=<company HTTPS updates base>,
 * --studio-dist=<isolated Studio build>, --shell-dist=<isolated shell build>.
 * Keeps earlier builds. No source package or existing installation is modified.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { companyReleaseProfile, releaseBaseUrl, windowsUpdateFeed } from './daocut-release-config.mjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '../..');
const release = join(desktop, '.release');
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this target on Windows x64.');
const runtime = resolve(option('runtime') || join(release, 'runtime/win-x64'));
// An installed Electron is an explicit local optimization; CI uses electron-builder's locked version.
const electronSource = option('electron-source') ? resolve(option('electron-source')) : null;
const companyProfileSource = option('company-profile');
if (companyProfileSource && !isAbsolute(companyProfileSource)) throw new Error('--company-profile must be an absolute JSON file path.');
const companyProfile = companyProfileSource ? companyReleaseProfile(JSON.parse(readFileSync(companyProfileSource, 'utf8').replace(/^\uFEFF/, ''))) : null;
const updates = releaseBaseUrl(option('updates'));
const feed = windowsUpdateFeed(updates);
if (feed && !process.argv.includes('--nsis')) throw new Error('An update-enabled Windows release requires --nsis.');
const resume = option('resume');
const defaultWork = join(release, 'win-x64');
const work = resolve(resume || option('work') || (existsSync(defaultWork) ? `${defaultWork}-${Date.now()}` : defaultWork));
const stage = join(work, 'app');
const out = join(work, resume ? `out-${Date.now()}` : 'out');
const icon = join(desktop, 'build/icon.ico');
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const protocol = resolve(repo, 'packages/daocut');
const studioDist = resolve(option('studio-dist') || join(protocol, 'studio/ui/dist'));
const shellDist = resolve(option('shell-dist') || join(desktop, 'shell/dist'));
const inside = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
if (!inside(release, work)) throw new Error(`Build output must be below ${release}`);
if (!resume && existsSync(work)) throw new Error(`Refusing to overwrite an earlier build: ${work}`);
for (const file of [icon, join(shellDist, 'index.html'), join(studioDist, 'index.html'), join(runtime, 'ffmpeg/ffmpeg.exe'), join(runtime, 'ffmpeg/ffprobe.exe'), join(runtime, 'ffmpeg/LICENSE')]) {
  if (!existsSync(file)) throw new Error(`Missing build input: ${file}`);
}
mkdirSync(release, { recursive: true });
if (!inside(realpathSync(repo), realpathSync(release))) throw new Error('The .release directory resolves outside this checkout.');
if (!resume) mkdirSync(work);
else if (!existsSync(join(stage, 'node_modules'))) throw new Error('Resume requires a completed dependency stage.');
const companyProfileFile = join(work, 'company-profile.json');
if (companyProfile) writeFileSync(companyProfileFile, `${JSON.stringify(companyProfile, null, 2)}\n`);
const cache = join(release, 'cache');
mkdirSync(cache, { recursive: true });
Object.assign(process.env, {
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  ELECTRON_BUILDER_CACHE: join(cache, 'electron-builder'),
  ELECTRON_CACHE: join(cache, 'electron'),
  electron_config_cache: join(cache, 'electron'),
  pnpm_config_pm_on_fail: 'ignore',
  npm_config_cache: join(cache, 'npm'),
  npm_config_ignore_scripts: 'true',
});

// Execute pnpm's JavaScript entry directly: this avoids Windows .cmd quoting and shell expansion.
const pnpmCli = [option('pnpm-cli'), process.env.npm_execpath, ...process.env.PATH.split(delimiter).flatMap((bin) => [
  join(bin, 'pnpm.cjs'), join(bin, 'pnpm.mjs'),
  join(bin, 'node_modules/pnpm/bin/pnpm.cjs'), join(bin, 'node_modules/pnpm/bin/pnpm.mjs'),
  resolve(bin, '../../node/node_modules/pnpm/bin/pnpm.cjs'), resolve(bin, '../../node/node_modules/pnpm/bin/pnpm.mjs'),
])].find((file) => file && /pnpm\.(cjs|mjs)$/.test(file) && existsSync(file));
if (!pnpmCli) throw new Error('Cannot locate pnpm JavaScript entry; pass --pnpm-cli=<path to pnpm.cjs or pnpm.mjs>.');
const pnpm = (args) => execFileSync(process.execPath, [pnpmCli, ...args], { cwd: repo, stdio: 'inherit', windowsHide: true });
const pnpmMajor = Number(execFileSync(process.execPath, [pnpmCli, '--version'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim().split('.')[0]);
console.log(`Daocut ${pkg.version}: staging production dependencies in ${stage}`);
if (!resume) pnpm(['--ignore-scripts', '--filter', './apps/desktop', 'deploy', '--prod', ...(pnpmMajor >= 10 ? ['--legacy'] : []), '--no-optional', stage]);
else console.log('Reusing production dependencies and copying the current application sources.');
// These build outputs are ignored by Git, so deploy's default packlist may omit them.
copyFresh(join(desktop, 'src'), join(stage, 'src'));
dropStagedFile(join(stage, 'src/openfilm-command.mjs'));
copyFresh(shellDist, join(stage, 'shell/dist'));

cpSync(join(protocol, 'THIRD_PARTY_NOTICES.md'), join(stage, 'THIRD_PARTY_NOTICES.md'));

// Replace files atomically: pnpm may have deployed them as hard links to the checkout/store.
const replaceJson = (file, data) => {
  const temporary = `${file}.daocut-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, file);
};
const stagedPkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
replaceJson(join(stage, 'package.json'), {
  name: 'daocut-desktop', productName: 'Daocut', version: pkg.version,
  description: 'Daocut desktop video editor by Daotian', author: 'Daotian', license: 'MIT', private: true,
  type: 'module', main: 'src/main.mjs', dependencies: Object.fromEntries(Object.entries(stagedPkg.dependencies).map(([name, version]) => [name === 'openfilm' ? 'daocut' : name, version])),
});
// A reused dependency stage may still have the old top-level workspace link.
const legacyCoreLink = join(stage, 'node_modules/openfilm');
const coreLink = join(stage, 'node_modules/daocut');
if (!existsSync(coreLink) && existsSync(legacyCoreLink)) renameSync(legacyCoreLink, coreLink);
const stagedRequire = createRequire(join(stage, 'package.json'));
const stagedProtocol = dirname(stagedRequire.resolve('daocut/package.json'));
if (!inside(realpathSync(stage), realpathSync(stagedProtocol))) throw new Error('Deployed Daocut resolves outside the isolated staging directory.');
// A resumed build must include current core/server changes, not only the desktop shell.
for (const path of ['src', 'bin', 'skills', 'studio/server', 'studio/client.mjs', 'studio/ui/dist', 'product.json', 'MANUAL.md']) {
  copyFresh(path === 'studio/ui/dist' ? studioDist : join(protocol, path), join(stagedProtocol, path));
}
dropStagedFile(join(stagedProtocol, 'bin/openfilm.mjs'));
for (const entry of readdirSync(join(stagedProtocol, 'skills'), { withFileTypes: true })) {
  if (entry.isDirectory() && existsSync(join(stagedProtocol, 'skills', entry.name, 'daocut.json'))) dropStagedFile(join(stagedProtocol, 'skills', entry.name, 'openfilm.json'));
}
// Retain staged dependency metadata while refreshing the current core version and CLI entry points.
const stagedCoreFile = join(stagedProtocol, 'package.json');
const stagedCorePackage = JSON.parse(readFileSync(stagedCoreFile, 'utf8'));
const currentCorePackage = JSON.parse(readFileSync(join(protocol, 'package.json'), 'utf8'));
replaceJson(stagedCoreFile, { ...stagedCorePackage, name: currentCorePackage.name, version: currentCorePackage.version, bin: currentCorePackage.bin, exports: currentCorePackage.exports });
const productFile = join(stagedProtocol, 'product.json');
const product = JSON.parse(readFileSync(productFile, 'utf8'));
replaceJson(productFile, { ...product, desktop: { ...product.desktop, updates }, company: { ...product.company, required: Boolean(companyProfile) } });
if (!existsSync(join(stagedProtocol, 'studio/ui/dist/index.html'))) throw new Error('Deployed Studio build is missing.');
const playwrightRequire = createRequire(join(stagedProtocol, 'package.json'));
const playwright = dirname(playwrightRequire.resolve('playwright-core/package.json'));
const browsers = JSON.parse(readFileSync(join(playwright, 'browsers.json'), 'utf8')).browsers;
const chromium = browsers.find((browser) => browser.name === 'chromium-headless-shell');
const browserExe = join(runtime, 'ms-playwright', `chromium_headless_shell-${chromium.revision}`, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
if (!existsSync(browserExe)) throw new Error(`Bundled browser does not match Playwright: ${browserExe}`);

const builder = require('electron-builder');
const electronVersion = require('electron/package.json').version;
const electronDist = electronSource ? await prepareElectronDist(electronVersion) : undefined;
await builder.build({
  projectDir: stage, publish: 'never', win: process.argv.includes('--nsis') ? ['nsis'] : ['dir'], x64: true,
  config: {
    appId: 'com.daotian.daocut', productName: 'Daocut', copyright: 'Copyright © 2026 Daotian',
    electronVersion, electronDist, npmRebuild: false, nodeGypRebuild: false, buildDependenciesFromSource: false,
    asar: true,
    asarUnpack: ['node_modules/daocut/**', 'node_modules/@agentclientprotocol/**', 'node_modules/playwright-core/**'],
    files: ['src/**/*', '!src/**/*.test.mjs', 'shell/dist/**/*', 'package.json', 'node_modules/**/*', '!LICENSE', '!node_modules/daocut/LICENSE', '!node_modules/@daocut/shared/LICENSE', 'THIRD_PARTY_NOTICES.md'],
    extraResources: [
      ...(companyProfile ? [{ from: companyProfileFile, to: 'company-profile.json' }] : []),
      { from: runtime, to: 'runtime', filter: ['**/*', '!ms-playwright/.links/**'] },

      { from: join(protocol, 'THIRD_PARTY_NOTICES.md'), to: 'THIRD_PARTY_NOTICES.md' },
    ],
    directories: { output: out, buildResources: join(desktop, 'build') },
    electronFuses: {
      runAsNode: true, enableCookieEncryption: true, enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
    },
    publish: feed ? [{ provider: 'generic', url: feed, channel: 'latest', useMultipleRangeRequest: false }] : null,
    win: { icon, executableName: 'Daocut', signAndEditExecutable: false, signExecutable: false, artifactName: 'Daocut-Setup-${version}-${arch}.${ext}' },
    nsis: {
      oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false,
      installerIcon: icon, uninstallerIcon: icon, shortcutName: 'Daocut', deleteAppDataOnUninstall: false,

    },
    afterPack: stampWindowsResources,
  },
});
const app = join(out, 'win-unpacked');
await verifyWindowsResources(app);
for (const file of ['resources/app.asar.unpacked/node_modules/daocut/bin/daocut.mjs', 'resources/app.asar.unpacked/node_modules/daocut/studio/ui/dist/index.html']) {
  if (!existsSync(join(app, file))) throw new Error(`Packaged file missing: ${file}`);
}
const packagedProduct = JSON.parse(readFileSync(join(app, 'resources/app.asar.unpacked/node_modules/daocut/product.json'), 'utf8'));
if ((packagedProduct.desktop?.updates || '') !== updates) throw new Error('Packaged update base does not match the requested release.');
if (packagedProduct.company?.required !== Boolean(companyProfile)) throw new Error('Packaged company login requirement does not match the requested release.');
const packagedProfile = join(app, 'resources/company-profile.json');
if (companyProfile && JSON.stringify(JSON.parse(readFileSync(packagedProfile, 'utf8'))) !== JSON.stringify(companyProfile)) throw new Error('Packaged company profile does not match the validated release profile.');
if (!companyProfile && existsSync(packagedProfile)) throw new Error('An unexpected company profile was packaged.');
const updaterConfig = join(app, 'resources/app-update.yml');
if (Boolean(feed) !== existsSync(updaterConfig)) throw new Error('Packaged updater configuration does not match the requested release.');
if (feed && process.argv.includes('--nsis') && !existsSync(join(out, 'latest.yml'))) throw new Error('The update feed metadata was not generated.');
console.log(`\nReady: ${join(app, 'Daocut.exe')}\nUpdates: ${feed ?? 'disabled'}\nRuntime: ${runtime}\nASAR integrity: verified\nThe app has not been launched by this build script.`);

async function stampWindowsResources({ appOutDir }) {
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const file = join(appOutDir, 'Daocut.exe');
  const exe = PE.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(exe);
  const icons = ResEdit.Data.IconFile.from(readFileSync(icon));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icons.icons.map((item) => item.data));
  const info = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  info.setFileVersion(major, minor, patch, 0, 1033);
  info.setProductVersion(major, minor, patch, 0, 1033);
  info.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: 'Daocut', FileDescription: 'Daocut', CompanyName: 'Daotian', OriginalFilename: 'Daocut.exe',
    InternalName: 'Daocut', LegalCopyright: 'Copyright © 2026 Daotian',
    FileVersion: pkg.version, ProductVersion: pkg.version,
  });
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(exe);
  writeFileSync(file, Buffer.from(exe.generate()));
  await verifyWindowsResources(appOutDir);
}

async function verifyWindowsResources(appOutDir) {
  const ResEdit = await import('resedit');
  const PE = await import('pe-library');
  const exe = PE.NtExecutable.from(readFileSync(join(appOutDir, 'Daocut.exe')), { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(exe);
  const info = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  const strings = info?.getStringValues({ lang: 1033, codepage: 1200 });
  if (strings?.ProductName !== 'Daocut' || strings?.CompanyName !== 'Daotian' || strings?.OriginalFilename !== 'Daocut.exe') throw new Error('Daocut PE branding verification failed.');
  const iconHash = (item) => createHash('sha256').update(Buffer.from(item.isRaw() ? item.bin : item.generate())).digest('hex');
  const expectedIcons = ResEdit.Data.IconFile.from(readFileSync(icon)).icons.map((item) => iconHash(item.data)).sort();
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries).find((item) => item.id === 1 && item.lang === 1033);
  const actualIcons = (group?.getIconItemsFromEntries(resources.entries) ?? []).map(iconHash).sort();
  if (JSON.stringify(expectedIcons) !== JSON.stringify(actualIcons)) throw new Error('Executable icons do not match the Daocut icon file.');
  const integrity = resources.entries.find((entry) => entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR');
  if (!integrity) throw new Error('Electron ASAR integrity resource is missing.');
  const asar = join(appOutDir, 'resources/app.asar');
  const fd = openSync(asar, 'r');
  let header;
  try {
    const prefix = Buffer.alloc(16);
    readSync(fd, prefix, 0, 16, 0);
    header = Buffer.alloc(prefix.readUInt32LE(12));
    readSync(fd, header, 0, header.length, 16);
  } finally { closeSync(fd); }
  const hash = createHash('sha256').update(header).digest('hex');
  const entries = JSON.parse(Buffer.from(integrity.bin).toString('utf8').replace(/\0+$/, ''));
  const entry = entries.find((item) => item.file.replaceAll('\\', '/') === 'resources/app.asar');
  if (entry?.alg !== 'SHA256' || entry.value !== hash) throw new Error('Executable ASAR integrity does not match the packaged archive.');
}
/** Reuse a matching installed runtime without its old app, updater, installer or integrity hash. */
async function prepareElectronDist(version) {
  const sourceExe = ['Daocut.exe', 'OpenFilm.exe', 'electron.exe'].map((name) => join(electronSource, name)).find(existsSync);
  if (!existsSync(sourceExe)) throw new Error(`Electron source is missing: ${sourceExe}`);
  const bytes = readFileSync(sourceExe);
  if (!bytes.includes(Buffer.from(`Electron/${version}\0`)) && !bytes.includes(Buffer.from(`Electron/${version} `))) {
    // Electron embeds this token in its user-agent string; the immediately following byte is a delimiter.
    const token = Buffer.from(`Electron/${version}`);
    const at = bytes.indexOf(token);
    if (at < 0 || /[0-9.]/.test(String.fromCharCode(bytes[at + token.length]))) throw new Error(`Installed Electron does not match ${version}.`);
  }
  const dist = join(work, 'electron-dist');
  if (resume && existsSync(join(dist, 'electron.exe')) && readFileSync(join(dist, 'version'), 'utf8') === version) return dist;
  mkdirSync(dist);
  for (const entry of readdirSync(electronSource, { withFileTypes: true })) {
    if (entry.name === 'locales' || (entry.isFile() && /\.(dll|pak|bin|dat|json|txt|html)$/i.test(entry.name))) {
      cpSync(join(electronSource, entry.name), join(dist, entry.name), { recursive: true });
    }
  }
  const PE = await import('pe-library');
  const exe = PE.NtExecutable.from(bytes, { ignoreCert: true });
  const resources = PE.NtExecutableResource.from(exe);
  resources.entries.splice(0, resources.entries.length, ...resources.entries.filter((entry) => !(entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR')));
  resources.outputResource(exe);
  writeFileSync(join(dist, 'electron.exe'), Buffer.from(exe.generate()));
  writeFileSync(join(dist, 'version'), version);
  console.log(`Reusing Electron ${version} from ${electronSource} (isolated copy).`);
  return dist;
}
/** Replace files through a temporary sibling so pnpm hard links never write through to its store. */
function copyFresh(from, to) {
  if (dirname(from) === join(protocol, 'studio/server') && ['real-nas-integration.mjs', 'source-axis-fixture-temp.mjs'].includes(from.split(/[\\/]/).at(-1))) return;
  let entries;
  try { entries = readdirSync(from, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOTDIR') throw error;
    if (/\.test\.[cm]?[jt]sx?$/.test(from)) return;
    mkdirSync(dirname(to), { recursive: true });
    const temporary = `${to}.daocut-${process.pid}.tmp`;
    cpSync(from, temporary, { force: false, errorOnExist: true });
    renameSync(temporary, to);
    return;
  }
  mkdirSync(to, { recursive: true });
  for (const entry of entries) copyFresh(join(from, entry.name), join(to, entry.name));
}
/** Remove only obsolete code files in this verified isolated staging directory. */
function dropStagedFile(file) {
  if (!inside(stage, file)) throw new Error('Refusing a stale-file cleanup outside the stage.');
  rmSync(file, { force: true });
}
