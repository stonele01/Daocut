import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { startStudio } from './server.mjs';

test('company authorization blocks new media and subtitle work while keeping projects and rejection responses available', async (t) => {
  const tempRoot = resolve('.test-temp'); mkdirSync(tempRoot, { recursive: true });
  const scratch = mkdtempSync(join(tempRoot, 'company-studio-'));
  const previous = { DAOCUT_STUDIO_HOME: process.env.DAOCUT_STUDIO_HOME, DAOCUT_LIBRARY: process.env.DAOCUT_LIBRARY };
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home');
  process.env.DAOCUT_LIBRARY = join(scratch, 'library');
  let checked = 0, allowed = false;
  const studio = await startStudio({ port: 0, authorizeTask: async () => { checked++; if (!allowed) throw Error('Company login required'); } });
  t.after(async () => {
    await studio.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(scratch.startsWith(tempRoot + sep)); rmSync(scratch, { recursive: true, force: true });
  });
  const api = (path, body) => fetch(studio.origin + path, { method: body ? 'POST' : 'GET',
    headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await api('/api/projects')).status, 200);
  const made = await (await api('/api/projects', { name: 'Company gate test' })).json();
  const film = join(made.project.path, 'film.html');
  const before = readFileSync(film, 'utf8');
  for (const path of ['/api/get', '/api/get/asks/test', '/api/projects/' + made.project.id + '/subtitles/transcribe', '/api/projects/' + made.project.id + '/subtitles/translate']) {
    const response = await api(path, { allow: true });
    assert.equal(response.status, 403, path);
    assert.equal((await response.json()).code, 'company-auth-required');
  }
  assert.equal(checked, 4);
  assert.equal((await api('/api/get/asks/test', { allow: false })).status, 200);
  assert.equal(checked, 4, 'rejecting a spend request needs no active company session');
  assert.equal(existsSync(film), true); assert.equal(readFileSync(film, 'utf8'), before);
  allowed = true;
  assert.equal((await api('/api/get/asks/test', { allow: true })).status, 200);
  assert.equal(checked, 5);
});

