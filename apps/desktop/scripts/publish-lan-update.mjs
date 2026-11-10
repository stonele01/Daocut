/** Publish electron-builder's unchanged generic-feed artifacts to the company service. */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'));
const yaml = updaterRequire('js-yaml');
const semver = updaterRequire('semver');
async function hash(file) {
  const digest = createHash('sha512');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('base64');
}
const name = (value) => {
  if (typeof value !== 'string' || value !== basename(value) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error('Update metadata must use local artifact filenames.');
  return value;
};
export async function publishLanUpdate(from, dataDir) {
  const source = resolve(from), target = resolve(dataDir, 'updates/win/x64');
  if (source === target) throw new Error('Choose the build output directory, not the existing update directory.');
  const metaFile = join(source, 'latest.yml');
  if ((await stat(metaFile)).size > 100_000) throw new Error('Unexpected update manifest size.');
  const manifest = await readFile(metaFile, 'utf8');
  const metadata = yaml.load(manifest);
  if (!semver.valid(metadata?.version) || !Array.isArray(metadata.files) || !metadata.files.length) throw new Error('Invalid electron-builder update manifest.');
  const files = [];
  for (const file of metadata.files) {
    const filename = name(file.url);
    if (!filename.endsWith('.exe')) throw new Error('Only Windows NSIS installers are supported.');
    const actual = await stat(join(source, filename));
    if (actual.size !== file.size || await hash(join(source, filename)) !== file.sha512) throw new Error(`Installer checksum or size mismatch: ${filename}`);
    await stat(join(source, filename + '.blockmap'));
    files.push(filename, filename + '.blockmap');
  }
  let previous;
  try { previous = yaml.load(await readFile(join(target, 'latest.yml'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.version && !semver.gt(metadata.version, previous.version)) throw new Error(`Published version is already ${previous.version}; use a higher version.`);
  await mkdir(target, {recursive:true});
  for (const filename of files) {
    const destination = join(target, filename);
    let exists = false;
    try { await stat(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
      if (await hash(destination) !== await hash(join(source, filename))) throw new Error(`A different artifact already has this filename: ${filename}`);
      continue;
    }
    await copyFile(join(source, filename), destination + '.publishing');
    await rename(destination + '.publishing', destination);
  }
  // A client only discovers the release after all referenced files are in place.
  await copyFile(metaFile, join(target, 'latest.yml.publishing'));
  await rename(join(target, 'latest.yml.publishing'), join(target, 'latest.yml'));
  return {version:metadata.version, directory:target, files};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const value = key => process.argv.find(arg=>arg.startsWith(`--${key}=`))?.slice(key.length+3);
  const from = value('from');
  if (!from) throw new Error('Usage: node publish-lan-update.mjs --from=<installer output folder> [--data-dir=D:/Daocut/CompanyData]');
  console.log(JSON.stringify(await publishLanUpdate(from, value('data-dir') || 'D:/Daocut/CompanyData'),null,2));
}