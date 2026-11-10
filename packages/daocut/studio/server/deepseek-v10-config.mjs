import { createDecipheriv } from 'node:crypto';

// Pure preparation only: callers provide already-read bytes and an OS-specific unprotect function.
// Chromium Windows OSCrypt v10: https://chromium.googlesource.com/chromium/src/+/112.0.5615.165/components/os_crypt/os_crypt_win.cc
export async function deepSeekConfigFromV10({ localState, agents, sealedKeys, unprotect }) {
  try {
    if (typeof unprotect !== 'function' || !Buffer.isBuffer(sealedKeys)) throw Error();
    const state = JSON.parse(localState);
    const choices = JSON.parse(agents);
    const encoded = state.os_crypt.encrypted_key;
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Error();
    const protectedKey = Buffer.from(encoded, 'base64');
    if (protectedKey.length <= 5 || protectedKey.subarray(0, 5).toString() !== 'DPAPI') throw Error();
    const models = choices.byok.models.filter(m => m.model === 'deepseek-flash' && m.format === 'responses' && typeof m.id === 'string' && m.id);
    if (models.length !== 1) throw Error();
    const model = models[0];
    const url = new URL(model.baseUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.port || url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) throw Error();
    if (sealedKeys.length < 4 + 3 + 12 + 16 || sealedKeys.subarray(0, 7).toString() !== 'enc:v10') throw Error();
    const key = await unprotect(protectedKey.subarray(5));
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error();
    const data = sealedKeys.subarray(7);
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    const keys = JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8'));
    if (!Object.hasOwn(keys, model.id) || typeof keys[model.id] !== 'string' || !keys[model.id].trim()) throw Error();
    return { baseUrl: model.baseUrl, model: model.model, apiKey: keys[model.id] };
  } catch {
    throw Object.assign(new Error('DeepSeek 模型配置不可用'), { code: 'MODEL_CLIENT_UNAVAILABLE' });
  }
}
