import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveModelWithCompanySession } from './company-ipc.mjs';

test('company model save never probes while signed out, disabled or unavailable', async () => {
  let probes = 0;
  for (const message of ['请先登录公司账号。', '此公司账号已停用。', '无法连接公司服务。']) {
    const result = await saveModelWithCompanySession({ model: 'synthetic' }, {
      authorizeTask: async () => { throw new Error(message); },
      saveModel: async () => { probes++; return { ok: true }; },
    });
    assert.deepEqual(result, { ok: false, error: message, code: 'company-auth-required' });
  }
  assert.equal(probes, 0);
});

test('company model save checks the session once before the existing model validation', async () => {
  const order = [];
  const config = { model: 'synthetic', key: 'synthetic-test-only' };
  const result = await saveModelWithCompanySession(config, {
    authorizeTask: async () => { order.push('session'); },
    saveModel: async (input) => { assert.equal(input, config); order.push('probe'); return { ok: true, id: 'synthetic' }; },
  });
  assert.deepEqual(order, ['session', 'probe']);
  assert.deepEqual(result, { ok: true, id: 'synthetic' });
});
