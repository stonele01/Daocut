import test from 'node:test';
import assert from 'node:assert/strict';
import doubao from './doubao.mjs';

const requestId = 'b34a0238-e734-4c90-bcd8-b14e805db965';
const audio = Buffer.from('synthetic isolated audio');
const credential = 'synthetic-provider-secret';
const responseBody = () => ({ audio_info: { duration: 2500 }, result: { text: '合成一句。', utterances: [{ text: '合成一句。', start_time: 200, end_time: 1800, words: [{ text: '合成一句', start_time: 200, end_time: 1800 }] }] } });
const context = onResponse => ({ key: credential, root: '/synthetic', signal: new AbortController().signal, read: async () => audio, say: () => {}, ...(onResponse ? { onResponse } : {}) });
const run = onResponse => doubao.run('asr', { src: 'assets/synthetic.mp4', requestId }, context(onResponse));
const reply = (body, status = 200, serviceStatus = '20000000') => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'X-Api-Status-Code': serviceStatus } });

test('successful raw response is awaited before parsed transcript is returned and carries no request secrets', async t => {
  const raw = responseBody(), receipts = [];
  let sent = 0, release, archived = false;
  t.mock.method(globalThis, 'fetch', async () => { sent++; return reply(raw); });
  const done = run(async receipt => { receipts.push(receipt); await new Promise(resolve => { release = resolve; }); archived = true; });
  let settled = false; void done.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(receipts.length, 1);
  assert.equal(settled, false, 'the provider must wait for local archive completion');
  assert.deepEqual(receipts[0], { provider: 'doubao', model: 'volc.bigasr.auc_turbo', requestId, httpStatus: 200, serviceStatus: '20000000', body: raw });
  release(); const result = await done;
  assert.equal(archived, true); assert.equal(sent, 1);
  assert.equal(result.index[0].text, raw.result.text);
  assert.ok(!JSON.stringify(receipts).includes(credential));
  assert.ok(!JSON.stringify(receipts).includes(audio.toString('base64')));
});

test('invalid provider timestamps and failed business status retain complete JSON before validation throws', async t => {
  const receipts = []; let sent = 0;
  const invalid = responseBody(); invalid.result.utterances[0].words[0].start_time = 'not-a-time';
  const bodies = [invalid, responseBody()];
  t.mock.method(globalThis, 'fetch', async () => reply(bodies[sent], 200, ++sent === 1 ? '20000000' : '45000001'));
  await assert.rejects(run(receipt => receipts.push(receipt)), /nonnumeric/);
  await assert.rejects(run(receipt => receipts.push(receipt)), /did not report recognition success/);
  assert.equal(sent, 2); assert.equal(receipts.length, 2);
  assert.deepEqual(receipts[0].body, invalid);
  assert.deepEqual(receipts[1].body, bodies[1]);
  assert.equal(receipts[1].serviceStatus, '45000001');
});

test('HTTP failure archives safe JSON metadata without echoing credentials or uploaded audio and never retries', async t => {
  const receipts = []; let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => { sent++; return reply({ error: `echo ${credential}`, nested: [audio.toString('base64')] }, 403, '45000001'); });
  await assert.rejects(run(receipt => receipts.push(receipt)), error => /HTTP 403/.test(error.message) && !error.message.includes(credential));
  assert.equal(sent, 1); assert.equal(receipts.length, 1);
  assert.equal(receipts[0].httpStatus, 403);
  assert.deepEqual(receipts[0].body, { error: 'echo [redacted]', nested: ['[redacted]'] });
  assert.ok(!JSON.stringify(receipts).includes(credential));
  assert.ok(!JSON.stringify(receipts).includes(audio.toString('base64')));
});

test('local archive failure is preserved and cannot trigger parsing, fallback or a second request', async t => {
  let sent = 0, saved = 0;
  const failure = Object.assign(new Error('Local archive failed'), { code: 'ASR_RESPONSE_SAVE_FAILED' });
  t.mock.method(globalThis, 'fetch', async () => { sent++; return reply({ invalid: 'cannot be parsed as a transcript' }); });
  await assert.rejects(run(async () => { saved++; throw failure; }), error => error === failure);
  assert.equal(saved, 1); assert.equal(sent, 1);
});

test('unreadable JSON response reports uncertain submission with request ID and no automatic resubmission', async t => {
  let sent = 0, saved = 0;
  t.mock.method(globalThis, 'fetch', async () => { sent++; return new Response(credential, { status: 200, headers: { 'X-Api-Status-Code': '20000000' } }); });
  await assert.rejects(run(() => { saved++; }), error => error.message.includes(requestId) && /Not retried/.test(error.message) && /response/.test(error.message) && !error.message.includes(credential));
  assert.equal(sent, 1); assert.equal(saved, 0);
});

test('existing callers without an archive callback retain successful and HTTP error behavior', async t => {
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => ++sent === 1 ? reply(responseBody()) : new Response('', { status: 402 }));
  assert.equal((await run()).index[0].text, '合成一句。');
  await assert.rejects(run(), /balance/);
  assert.equal(sent, 2);
});
