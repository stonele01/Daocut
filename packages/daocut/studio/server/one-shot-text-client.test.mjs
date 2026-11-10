import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createOneShotTextClient } from './one-shot-text-client.mjs';
import { TEXT_STRUCTURE_PROMPT } from './text-structure.mjs';

function fixture() {
  const authorized = { sourceId: 's', productId: 'p', intervalId: 'i', rangeStartMs: 0, rangeEndMs: 100, cues: [{ startMs: 1, endMs: 99, text: 'synthetic' }] };
  const key = randomBytes(32), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  const sealed = Buffer.concat([Buffer.from('enc:v10'), nonce, cipher.update(JSON.stringify({ id: 'fake-key' })), cipher.final(), cipher.getAuthTag()]);
  const files = { local: JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPItest').toString('base64') } }), agents: JSON.stringify({ byok: { models: [{ id: 'id', model: 'deepseek-flash', format: 'responses', baseUrl: 'https://api.deepseek.com' }] } }), keys: sealed };
  const count = { read: 0, fetch: 0 };
  const options = { enabled: true, getAuthorizedInput: async () => authorized, paths: { localState: 'local', agents: 'agents', sealedKeys: 'keys' }, unprotect: async () => key, readFile: async path => { count.read++; return files[path]; }, fetch: async () => { count.fetch++; return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"candidates":[],"issues":[]}' }] }] }) }; } };
  return { authorized, options, count };
}
const call = value => ({ system: TEXT_STRUCTURE_PROMPT, input: JSON.stringify(value) });

test('disabled by default', () => assert.equal(createOneShotTextClient({}), null));
test('mismatched IDs, text, time or extra fields cannot read credentials or fetch', async () => {
  for (const mutate of [x => x.sourceId = 'other', x => x.productId = 'other', x => x.intervalId = 'other', x => x.rangeEndMs++, x => x.cues[0].text = 'other', x => x.cues[0].endMs--, x => x.extra = 1]) {
    const { authorized, options, count } = fixture(), altered = structuredClone(authorized); mutate(altered);
    await assert.rejects(createOneShotTextClient(options)(call(altered)), error => ['MODEL_CLIENT_UNAVAILABLE', 'MODEL_INPUT_CHANGED'].includes(error.code));
    assert.deepEqual(count, { read: 0, fetch: 0 });
  }
});
test('concurrent calls and failed model calls cannot retry', async () => {
  const { authorized, options, count } = fixture();
  options.fetch = async () => { count.fetch++; throw Error('fake-key'); };
  const client = createOneShotTextClient(options);
  const result = await Promise.allSettled([client(call(authorized)), client(call(authorized))]);
  assert.equal(result.filter(x => x.status === 'rejected').length, 2);
  await assert.rejects(client(call(authorized)));
  assert.equal(count.fetch, 1);
});
test('authorized synthetic input sends exactly once through fake fetch', async () => {
  const { authorized, options, count } = fixture();
  assert.deepEqual(await createOneShotTextClient(options)(call(authorized)), { candidates: [], issues: [] });
  assert.deepEqual(count, { read: 3, fetch: 1 });
});
test('safe HTTP status survives one-shot wrapper without response body', async () => {
  const { authorized, options, count } = fixture();
  options.fetch = async () => { count.fetch++; return { ok: false, status: 429, json: async () => { throw Error('body must not be read'); } }; };
  const client = createOneShotTextClient(options);
  await assert.rejects(client(call(authorized)), error => error.code === 'MODEL_HTTP' && error.httpStatus === 429 && !error.message.includes('fake-key'));
  await assert.rejects(client(call(authorized)));
  assert.equal(count.fetch, 1);
});
