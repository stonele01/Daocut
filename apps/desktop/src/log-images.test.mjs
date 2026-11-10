import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logImageBlock, referencedLogImages, stringifyLogEntry } from 'daocut/log-images';
import { loggedBlocks, openLog, readLog, readLogImage, saveLogImage, writeModelLog } from './chat-store.mjs';
import { registerChatIpc } from './chat-ipc.mjs';
import { exportDiagnostics } from '../../../packages/daocut/studio/server/diagnostics.mjs';
import { recordProblem, problemsFile } from 'daocut/problems';

const root = fileURLToPath(new URL('../.release/log-image-tests/', import.meta.url));
mkdirSync(root, { recursive: true });
const fixture = () => mkdtempSync(join(root, 'case-'));
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const image = () => ({ type: 'image', mimeType: 'image/png', data, annotation: 'keep metadata' });
async function until(read, ready) {
  for (let n = 0; n < 200; n++) {
    const result = read();
    if (ready(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('log did not finish writing');
}

test('prompt, tool event and model logs share one picture without mutating provider payloads or losing other fields', async () => {
  const project = fixture();
  const block = Object.freeze(image());
  const content = Object.freeze([block]);
  const payload = Object.freeze({ role: 'toolResult', content, toolCallId: 'c1' });
  const before = JSON.stringify(payload);
  const event = openLog(project, 'local:images');
  event.write('sent', { prompt: loggedBlocks(project, content) });
  event.write('update', { update: { sessionUpdate: 'tool_call_update', content: [{ type: 'content', content: block }], rawOutput: { content } } });
  event.end();
  const call = { startedAt: 1, prefix: 0, messages: [payload], answer: { usage: { input: 123, output: 7 } } };
  writeModelLog(project, 'local:images', [call, { ...call, prefix: 1, messages: [] }]);
  const log = await until(() => readLog(project, 'local:images'), (value) => value?.events.length === 2);
  const stored = log.calls[0].messages[0].content[0];
  assert.match(stored.file, /^\.film\/logs\/images\/[a-f0-9]{40}\.png$/);
  assert.equal(stored.annotation, 'keep metadata');
  assert.equal(stored.bytes, Buffer.byteLength(data, 'base64'));
  assert.equal(stored.data, undefined);
  assert.equal(log.events[0].prompt[0].file, stored.file);
  assert.equal(log.events[1].update.content[0].content.file, stored.file);
  assert.equal(log.events[1].update.rawOutput.content[0].file, stored.file);
  assert.equal(readdirSync(join(project, '.film/logs/images')).length, 1);
  assert.equal(JSON.stringify(payload), before, 'model request still has its exact image bytes');
  assert.deepEqual(log.calls[0].answer, call.answer, 'usage is unchanged');
  assert.equal(log.calls[1].prefix, 1, 'delta log prefix is unchanged');
  assert.equal(JSON.stringify(log).includes(data), false, 'normal log load and copy stay as references');
  assert.deepEqual(readLogImage(project, stored.file).data, Buffer.from(data, 'base64'));
});

test('streamed model log uses the same image storage boundary; old inline and new reference records both read', async () => {
  const project = fixture();
  const log = openLog(project, 'mixed');
  log.write('prompt');
  log.end();
  const calls = openLog(project, 'mixed', () => {}, '.model');
  calls.write('call', { prefix: 0, messages: [{ role: 'user', content: [image()] }], answer: null });
  calls.end();
  const found = await until(() => readLog(project, 'mixed'), (value) => value?.events.length && value?.calls.length);
  appendFileSync(join(project, '.film/logs/mixed.model.jsonl'), JSON.stringify({ kind: 'call', prefix: 0, messages: [{ role: 'user', content: [image()] }], answer: null }) + '\n');
  const mixed = readLog(project, 'mixed');
  assert.ok(mixed.calls[0].messages[0].content[0].file);
  assert.equal(mixed.calls[1].messages[0].content[0].data, data, 'legacy inline bytes remain viewable');
  assert.deepEqual(readLogImage(project, found.calls[0].messages[0].content[0].file).data, Buffer.from(data, 'base64'));
});

test('failed image storage retains inline data instead of a broken reference or dropped event', async () => {
  const project = fixture();
  mkdirSync(join(project, '.film/logs'), { recursive: true });
  writeFileSync(join(project, '.film/logs/images'), 'a file blocks the image folder');
  const original = image();
  assert.strictEqual(logImageBlock(project, original), original);
  const log = openLog(project, 'fallback');
  log.write('update', { result: original });
  log.end();
  const found = await until(() => readLog(project, 'fallback'), (value) => value?.events.length);
  assert.equal(found.events[0].result.data, data);
  assert.equal(found.events[0].result.file, undefined);
  const text = { type: 'text', data };
  assert.strictEqual(logImageBlock(project, text), text);
  const otherFormat = { type: 'image', mimeType: 'image/svg+xml', data };
  assert.strictEqual(logImageBlock(fixture(), otherFormat), otherFormat, 'unknown formats keep their original inline rendering');
});

test('image reader rejects paths outside the content store, missing and forged files, and symlink escapes', (t) => {
  const project = fixture();
  const file = saveLogImage(project, data, 'image/png');
  for (const bad of ['../outside.png', join(project, file), '.film/logs/../secret', file + '/..', null]) assert.equal(readLogImage(project, bad), null);
  assert.equal(readLogImage(project, '.film/logs/images/' + '0'.repeat(40) + '.png'), null);
  writeFileSync(join(project, file), 'not the content named by this hash');
  assert.equal(readLogImage(project, file), null);
  const outside = fixture();
  const outsideFile = saveLogImage(outside, data, 'image/png');
  const linked = fixture();
  mkdirSync(join(linked, '.film/logs'), { recursive: true });
  try { symlinkSync(join(outside, '.film/logs/images'), join(linked, '.film/logs/images'), 'junction'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.diagnostic('symlink creation unavailable; other boundary cases passed'); return; } throw error; }
  assert.equal(readLogImage(linked, outsideFile), null);
});

test('lazy picture IPC accepts only trusted project requests and validated picture references', async () => {
  const project = fixture();
  const file = saveLogImage(project, data, 'image/png');
  const handlers = new Map();
  registerChatIpc({ handle: (name, fn) => handlers.set(name, fn) }, {
    trusted: (event) => event.trusted === true, projects: async () => [project], dataDir: project, reveal() {}, tell() {}, log() {},
  });
  const read = handlers.get('desktop:chat:log-image');
  assert.deepEqual(await read({ trusted: true }, { project, file }), { data, mimeType: 'image/png' });
  assert.equal(await read({ trusted: true }, { project, file: '../private' }), null);
  await assert.rejects(read({ trusted: true }, { project: join(project, 'other'), file }), /not a project/);
  await assert.rejects(read({}, { project, file }), /not the window/);
});

test('diagnostics includes referenced images once only when conversation inclusion is enabled; legacy text remains intact', async () => {
  const project = fixture();
  const home = join(project, 'home');
  const file = saveLogImage(project, data, 'image/png');
  saveLogImage(project, Buffer.from('unrelated image').toString('base64'), 'image/png');
  const event = { kind: 'update', update: { sessionUpdate: 'tool_call_update', content: [image(), image()] } };
  const text = stringifyLogEntry(project, event);
  assert.deepEqual(referencedLogImages(text), [file]);
  const log = join(project, '.film/logs/problem.jsonl');
  writeFileSync(log, text + '\n' + JSON.stringify({ kind: 'sent', prompt: [image()] }) + '\n');
  const now = new Date();
  recordProblem({ area: 'agent', what: 'test image result', project, log }, { file: problemsFile(home), now });
  const plain = await exportDiagnostics({ report: 'test', home, folder: join(project, 'plain'), now });
  assert.equal(plain.files.some((name) => name.includes('/images/')), false);
  const detailed = await exportDiagnostics({ report: 'test', home, folder: join(project, 'detailed'), now, conversations: true });
  assert.deepEqual(detailed.files.filter((name) => name.includes('/images/')), ['turns/' + file]);
  const zip = readFileSync(detailed.path);
  assert.ok(zip.includes(Buffer.from(data, 'base64')));
  assert.ok(zip.includes(Buffer.from(data)), 'legacy inline log images survive as before');
  assert.ok(!zip.includes(Buffer.from('unrelated image')), 'no directory scan or unrelated picture inclusion');
  assert.ok(existsSync(log));
});
