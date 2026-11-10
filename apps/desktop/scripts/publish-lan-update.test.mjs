import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, rmdir, rename, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishLanUpdate } from './publish-lan-update.mjs';


const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'));
const yaml = updaterRequire('js-yaml');
const companyRequire = createRequire(new URL('../../company-service/package.json', import.meta.url));
let companyDependenciesInstalled = true;
try { companyRequire.resolve('better-auth'); companyRequire.resolve('better-sqlite3'); } catch { companyDependenciesInstalled = false; }
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.release');
const digest = bytes => createHash('sha512').update(bytes).digest('base64');
async function fixture(t) {
  await mkdir(fixtureRoot, { recursive: true });
  const folder = await mkdtemp(join(fixtureRoot, 'publish-lan-test-'));
  const cleanup = async () => {
    const target = resolve(folder);
    if (!target.startsWith(fixtureRoot + sep) || !target.includes('publish-lan-test-')) throw new Error('Unsafe fixture cleanup target');
    await rm(target, { recursive: true, force: true });
  };
  t.after(cleanup);
  return { folder, dataDir: join(folder, 'company'), target: join(folder, 'company', 'updates', 'win', 'x64') };
}
async function build(folder, version, { bytes = Buffer.from('synthetic NSIS installer bytes for update publication tests'), filename = `Daocut-Setup-${version}-x64.exe` } = {}) {
  await mkdir(folder, { recursive: true });
  const metadata = { version, files: [{ url: filename, sha512: digest(bytes), size: bytes.length }], path: filename, sha512: digest(bytes), releaseDate: '2026-10-23T00:00:00.000Z' };
  const manifest = yaml.dump(metadata);
  const blockmap = Buffer.from('synthetic blockmap fixture; never distributed');
  await writeFile(join(folder, filename), bytes);
  await writeFile(join(folder, filename + '.blockmap'), blockmap);
  await writeFile(join(folder, 'latest.yml'), manifest);
  return { folder, filename, bytes, blockmap, manifest, metadata };
}
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

test('publisher preserves builder manifest bytes and rejects checksum or size mismatch before publishing', async t => {
  const f = await fixture(t);
  const valid = await build(join(f.folder, 'valid'), '1.2.3');
  const result = await publishLanUpdate(valid.folder, f.dataDir);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.directory, f.target);
  assert.equal(await readFile(join(f.target, 'latest.yml'), 'utf8'), valid.manifest);
  assert.deepEqual(await readFile(join(f.target, valid.filename)), valid.bytes);
  assert.deepEqual(await readFile(join(f.target, valid.filename + '.blockmap')), valid.blockmap);
  const badHash = await build(join(f.folder, 'bad-hash'), '1.2.4');
  badHash.metadata.files[0].sha512 = digest(Buffer.from('different data'));
  await writeFile(join(badHash.folder, 'latest.yml'), yaml.dump(badHash.metadata));
  await assert.rejects(publishLanUpdate(badHash.folder, f.dataDir), /checksum or size mismatch/i);
  assert.equal(await readFile(join(f.target, 'latest.yml'), 'utf8'), valid.manifest);
  assert.equal(await exists(join(f.target, badHash.filename)), false);
  const badSize = await build(join(f.folder, 'bad-size'), '1.2.5');
  badSize.metadata.files[0].size++;
  await writeFile(join(badSize.folder, 'latest.yml'), yaml.dump(badSize.metadata));
  await assert.rejects(publishLanUpdate(badSize.folder, f.dataDir), /checksum or size mismatch/i);
  assert.equal(await readFile(join(f.target, 'latest.yml'), 'utf8'), valid.manifest);
});

test('publisher rejects equal versions, downgrades, and path-bearing artifact URLs', async t => {
  const f = await fixture(t);
  const current = await build(join(f.folder, 'current'), '2.0.0');
  await publishLanUpdate(current.folder, f.dataDir);
  for (const version of ['2.0.0', '1.9.9', '2.0.0-beta.1']) {
    const candidate = await build(join(f.folder, version), version);
    await assert.rejects(publishLanUpdate(candidate.folder, f.dataDir), /use a higher version/i);
  }
  const invalid = await build(join(f.folder, 'invalid'), '2.0.1');
  invalid.metadata.files[0].url = '../outside.exe';
  await writeFile(join(invalid.folder, 'latest.yml'), yaml.dump(invalid.metadata));
  await assert.rejects(publishLanUpdate(invalid.folder, f.dataDir), /local artifact filenames/i);
  assert.equal(await readFile(join(f.target, 'latest.yml'), 'utf8'), current.manifest);
});

test('failed artifact copy leaves previous feed intact; retry publishes metadata only after complete artifacts', async t => {
  const f = await fixture(t);
  const previous = await build(join(f.folder, 'previous'), '3.0.0');
  await publishLanUpdate(previous.folder, f.dataDir);
  const next = await build(join(f.folder, 'next'), '3.0.1');
  // Block the blockmap staging filename to simulate an interrupted/failed filesystem write.
  const obstruction = join(f.target, next.filename + '.blockmap.publishing');
  await mkdir(obstruction);
  await assert.rejects(publishLanUpdate(next.folder, f.dataDir));
  assert.deepEqual(await readFile(join(f.target, next.filename)), next.bytes, 'the installer was copied first');
  assert.equal(await exists(join(f.target, next.filename + '.blockmap')), false);
  assert.equal(await readFile(join(f.target, 'latest.yml'), 'utf8'), previous.manifest, 'clients still discover the complete old release');
  await rmdir(obstruction);
  await publishLanUpdate(next.folder, f.dataDir);
  assert.equal(await readFile(join(f.target, 'latest.yml'), 'utf8'), next.manifest);
  assert.deepEqual(await readFile(join(f.target, next.filename + '.blockmap')), next.blockmap);
  assert.deepEqual(await readFile(join(f.target, previous.filename)), previous.bytes, 'previous version remains available');
  assert.equal(await exists(join(f.target, 'latest.yml.publishing')), false);
});

test('publisher does not replace an existing installer with different content', async t => {
  const f = await fixture(t);
  const previous = await build(join(f.folder, 'previous'), '4.0.0', { filename: 'Daocut-Setup-x64.exe' });
  await publishLanUpdate(previous.folder, f.dataDir);
  const next = await build(join(f.folder, 'next'), '4.0.1', { filename: previous.filename, bytes: Buffer.from('different synthetic installer') });
  await assert.rejects(publishLanUpdate(next.folder, f.dataDir), /different artifact already has this filename/i);
  assert.deepEqual(await readFile(join(f.target, previous.filename)), previous.bytes);
  assert.equal(await readFile(join(f.target, 'latest.yml'), 'utf8'), previous.manifest);
});

test('published win/x64 feed and artifact ranges are served by the actual company file route', { skip: companyDependenciesInstalled ? false : 'Install the independent company-service npm package to run this integration test.' }, async t => {
  const { createCompanyService } = await import('../../company-service/src/service.mjs');
  const f = await fixture(t);
  const artifact = await build(join(f.folder, 'build'), '5.0.0', { bytes: Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') });
  await publishLanUpdate(artifact.folder, f.dataDir);
  const service = await createCompanyService({ dataDir: f.dataDir, host: '127.0.0.1', port: 0, baseURL: 'http://127.0.0.1:4715' });
  try {
    await service.listen();
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const manifest = await fetch(base + '/updates/win/x64/latest.yml');
    assert.equal(manifest.status, 200);
    assert.equal(await manifest.text(), artifact.manifest);
    assert.equal(manifest.headers.get('cache-control'), 'no-cache');
    const url = base + '/updates/win/x64/' + artifact.filename;
    const full = await fetch(url); assert.deepEqual(Buffer.from(await full.arrayBuffer()), artifact.bytes);
    const partial = await fetch(url, { headers: { Range: 'bytes=4-9' } });
    assert.equal(partial.status, 206); assert.equal(await partial.text(), '456789');
    assert.equal(partial.headers.get('content-range'), `bytes 4-9/${artifact.bytes.length}`);
    assert.equal(partial.headers.get('content-length'), '6');
    const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
    assert.equal(suffix.status, 206); assert.equal(await suffix.text(), 'XYZ');
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(artifact.bytes.length)); assert.equal(await head.text(), '');
    assert.equal((await fetch(url, { headers: { Range: 'bytes=999-' } })).status, 416);
    assert.equal((await fetch(base + '/updates/win/x64/' + artifact.filename + '.blockmap')).status, 200);
    assert.equal((await fetch(base + '/updates/win/arm64/latest.yml')).status, 404);
    assert.equal((await fetch(base + '/updates/win/x64/%2e%2e%2fserver-key.pem')).status, 404);
    assert.equal((await fetch(base + '/updates/win/x64/..%5cserver-key.pem')).status, 404);
    assert.equal((await fetch(url, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416, 'the feed is explicitly single-range');
    const privateDirectory = join(f.folder, 'outside-update-root');
    await mkdir(privateDirectory);
    await writeFile(join(privateDirectory, artifact.filename), 'private fixture must not be served');
    await rename(f.target, f.target + '-published');
    await symlink(privateDirectory, f.target, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await fetch(url)).status, 404, 'directory junctions cannot escape the allowed update path');
  } finally { await service.close(); }
});

