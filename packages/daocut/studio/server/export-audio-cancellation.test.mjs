import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/cancellation-fixes-20261105/process');
const hash = data => createHash('sha256').update(data).digest('hex');

for (const kind of ['audio', 'nle-stems']) test(`${kind} export cancellation closes the mixing encoder and leaves no output or partial`, { timeout: 30_000 }, async t => {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'export-')), root = join(dir, 'project'), output = join(dir, 'exports');
  const envKeys = ['DAOCUT_HOME', 'DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_EXPORTS', 'TEMP', 'TMP', 'PLAYWRIGHT_BROWSERS_PATH', 'DAOCUT_NO_UPDATE_CHECK'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) {
    if (key === 'PLAYWRIGHT_BROWSERS_PATH') process.env[key] = 'D:/Daocut/App/resources/runtime/ms-playwright';
    else if (key === 'DAOCUT_NO_UPDATE_CHECK') process.env[key] = '1';
    else { process.env[key] = key === 'DAOCUT_EXPORTS' ? output : join(dir, key); await mkdir(process.env[key], { recursive: true }); }
  }
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'only isolated loopback requests');
    return fetch(input, options);
  };
  const originalSpawn = childProcess.spawn;
  let manager, encoder, job, cancelledAt;
  t.after(async () => {
    await manager?.stopAll();
    childProcess.spawn = originalSpawn; syncBuiltinESMExports(); globalThis.fetch = fetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  await mkdir(join(root, 'assets'), { recursive: true });
  const source = join(root, 'assets/tone.wav');
  const generated = childProcess.spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', source], { windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const originalHash = hash(await readFile(source));
  await writeFile(join(root, 'film.html'), filmHtml({ stage: { w: 160, h: 90 }, tracks: [{ clips: [{ id: 'tone', src: 'assets/tone.wav', at: 0, time: [0, 5] }] }] }));
  await writeFile(join(output, 'keep.txt'), 'pre-existing export stays');
  childProcess.spawn = (command, args, options) => {
    // Real, finite five-second audio. Slow only its input reading so cancellation occurs while the actual mix runs.
    if (command === 'ffmpeg' && args.includes('[out]')) {
      const inputAt = args.indexOf('-i');
      args = [...args.slice(0, inputAt), '-re', ...args.slice(inputAt)];
      encoder = originalSpawn(command, args, options);
      encoder.once('spawn', () => { cancelledAt = performance.now(); manager.cancel(job.id); });
      return encoder;
    }
    return originalSpawn(command, args, options);
  };
  syncBuiltinESMExports();
  const { createExports } = await import('./exports.mjs');
  manager = createExports();
  const project = { id: `isolated-${kind}`, name: 'Synthetic audio', path: root };
  job = manager.start(project, kind === 'audio' ? { kind: 'audio', format: 'wav' } : { kind: 'nle', format: 'fcpxml', audio: 'stems', subtitles: false, media: 'copy' });
  let result;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    result = manager.list(project.id).find(item => item.id === job.id);
    if (['done', 'failed', 'cancelled'].includes(result.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(encoder, `mix started: ${result?.error ?? result?.status}`);
  assert.equal(result.status, 'cancelled', result.error);
  assert.deepEqual(result.outputs, []);
  assert.deepEqual(await readdir(output), ['keep.txt']);
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'pre-existing export stays');
  assert.equal(hash(await readFile(source)), originalHash);
  t.diagnostic(JSON.stringify({ pid: encoder.pid, elapsedMs: Math.round(performance.now() - cancelledAt), exitCode: encoder.exitCode, signalCode: encoder.signalCode }));
  assert.ok(encoder.exitCode !== null || encoder.signalCode !== null, 'encoder actually exited');
  assert.notEqual(encoder.exitCode, 0, 'cancelled encoder did not silently finish all the audio');
  assert.ok(performance.now() - cancelledAt < 2500, 'cancellation stops the finite mix before natural completion');
});
