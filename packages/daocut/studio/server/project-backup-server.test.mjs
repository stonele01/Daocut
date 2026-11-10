import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startStudio } from './server.mjs';
import { createProjectBackup } from './project-backup.mjs';

test('ordinary backup inspection and restore route opens a new personal project without model requests', { timeout: 30000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/shared-v2-20261105/backup-http');
  await mkdir(base, { recursive: true }); const scratch = await mkdtemp(join(base, 'case-'));
  const env = ['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_NO_UPDATE_CHECK'];
  const old = Object.fromEntries(env.map(k => [k, process.env[k]]));
  for (const key of env.slice(0, 3)) process.env[key] = join(scratch, key);
  process.env.DAOCUT_NO_UPDATE_CHECK = '1';
  const project = join(scratch, 'original'), backup = join(scratch, 'backup'), restored = join(scratch, 'restored');
  await mkdir(join(project, '.film'), { recursive: true });
  await writeFile(join(project, 'film.html'), '<!doctype html><html><body>personal timeline</body></html>');
  await writeFile(join(project, '.film/product-analysis.json'), JSON.stringify({ version: 1, sources: [], products: [{ id: 'p', name: '人工修改保留' }], intervals: [], candidates: [] }));
  await createProjectBackup(project, backup);
  let external = 0;
  const studio = await startStudio({ port: 0, key: 'backup-http-only', openBrowser() {}, authorizeTask: async () => { external++; throw Error('no model authorization in restore'); } });
  t.after(async () => { await studio.close(); for (const key of env) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; });
  const post = async (path, input) => {
    const response = await fetch(`${studio.origin}/api/${path}`, { method: 'POST', headers: { 'x-studio-key': studio.key, 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const inspected = await post('project-backups/inspect', { path: backup });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.body)); assert.ok(inspected.body.backupId);
  const input = { backupPath: backup, targetPath: restored, expectedBackupId: inspected.body.backupId, mappings: [], confirmed: true };
  const result = await post('project-backups/restore', input);
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.project.path, restored); assert.ok(result.body.project.id);
  assert.match(await readFile(join(restored, '.film/product-analysis.json'), 'utf8'), /人工修改保留/);
  assert.deepEqual(await readFile(join(project, 'film.html')), await readFile(join(restored, 'film.html')));
  const duplicate = await post('project-backups/restore', input); assert.equal(duplicate.status, 409);
  const denied = await post('project-backups/restore', { ...input, targetPath: join(scratch, 'unconfirmed'), confirmed: false }); assert.equal(denied.status, 400);
  assert.equal(external, 0);
});
