import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { deepSeekConfigFromV10 } from './deepseek-v10-config.mjs';

function fixture() {
  const key = randomBytes(32), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ sample: 'fake-secret' })), cipher.final()]);
  return {
    localState: JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIfake').toString('base64') } }),
    agents: JSON.stringify({ byok: { models: [{ id: 'sample', model: 'deepseek-flash', format: 'responses', baseUrl: 'https://api.deepseek.com' }] } }),
    sealedKeys: Buffer.concat([Buffer.from('enc:v10'), nonce, ciphertext, cipher.getAuthTag()]),
    unprotect: async bytes => { assert.equal(bytes.toString(), 'fake'); return key; },
  };
}

test('synthetic v10 config returns only the selected in-memory model', async () => {
  const config = await deepSeekConfigFromV10(fixture());
  assert.deepEqual(config, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'fake-secret' });
});

test('malformed, ambiguous, tampered and unprotect failures all return sanitized errors', async () => {
  const cases = [];
  let x = fixture(); x.sealedKeys[x.sealedKeys.length - 1] ^= 1; cases.push(x);
  x = fixture(); x.unprotect = async () => { throw Error('fake-secret'); }; cases.push(x);
  x = fixture(); x.unprotect = async () => Buffer.alloc(1); cases.push(x);
  x = fixture(); x.localState = '{}'; cases.push(x);
  x = fixture(); x.sealedKeys = Buffer.from('enc:v20'); cases.push(x);
  x = fixture(); x.agents = JSON.stringify({ byok: { models: [{ id: 'sample', model: 'deepseek-flash', format: 'responses', baseUrl: 'https://evil.example' }] } }); cases.push(x);
  x = fixture(); const a = JSON.parse(x.agents); a.byok.models.push(a.byok.models[0]); x.agents = JSON.stringify(a); cases.push(x);
  for (const input of cases) await assert.rejects(deepSeekConfigFromV10(input), { code: 'MODEL_CLIENT_UNAVAILABLE', message: 'DeepSeek 模型配置不可用' });
});
