import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCompanyService } from '../src/service.mjs';

const testRoot = path.resolve(process.env.DAOCUT_COMPANY_TEST_ROOT || 'D:/Daocut/CompanyTests');
await mkdir(testRoot, { recursive: true });
async function fixture(t, startAt = '2026-10-26T02:00:00Z') {
  const dataDir = await mkdtemp(path.join(testRoot, 'quota-'));
  let time = Date.parse(startAt), service, origin;
  const start = async () => {
    service = await createCompanyService({ dataDir, host: '127.0.0.1', port: 0, baseURL: 'http://127.0.0.1:4715', now: () => time });
    await service.listen(); origin = `http://127.0.0.1:${service.server.address().port}`;
  };
  t.after(async () => {
    await service?.close();
    if (!path.resolve(dataDir).startsWith(testRoot + path.sep)) throw new Error('Unsafe quota test cleanup');
    await rm(dataDir, { recursive: true, force: true });
  });
  await start();
  const request = async (route, { token, method = 'GET', body } = {}) => {
    const response = await fetch(origin + '/api/company' + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const adminBody = { username: 'quota.admin', name: '额度测试管理员', password: 'Synthetic-Quota-Admin-42!' };
  const employeeBody = { username: 'quota.employee', name: '额度测试员工', password: 'Synthetic-Quota-User-42!' };
  await request('/setup', { method: 'POST', body: adminBody });
  const adminToken = (await request('/login', { method: 'POST', body: adminBody })).data.token;
  const employee = (await request('/users', { method: 'POST', token: adminToken, body: employeeBody })).data.user;
  const token = (await request('/login', { method: 'POST', body: employeeBody })).data.token;
  const personal = (route, body, method = 'POST') => request(route, { token, method, body });
  const quota = async () => (await personal('/quota', undefined, 'GET')).data.quota;
  const set = async (dailyLimit, monthlyLimit) => request(`/users/${employee.id}/quota`, { token: adminToken, method: 'PUT', body: { dailyLimit, monthlyLimit } });
  const reserve = (id, reservedTokens, patch = {}) => personal('/quota/reserve', { id, model: 'deepseek-flash', reservedTokens, appVersion: 'synthetic-test', ...patch });
  return { request, token, adminToken, employee, personal, quota, set, reserve, advance: (at) => { time = Date.parse(at); }, restart: async () => { await service.close(); await start(); } };
}
const receipt = (id, total, patch = {}) => ({ id, at: '2026-10-26T02:00:00.000Z', model: 'deepseek-flash', input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total, reported: true, incomplete: false, ...patch });

test('quotas default to unlimited, require admin changes, and persist without changing usage', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/quota')).status, 401);
  assert.equal((await f.personal('/quotas', undefined, 'GET')).status, 403);
  assert.equal((await f.personal(`/users/${f.employee.id}/quota`, { dailyLimit: 1, monthlyLimit: 1 }, 'PUT')).status, 403);
  let q = await f.quota();
  assert.equal(q.limited, false); assert.equal(q.daily.limit, null); assert.equal(q.monthly.remaining, null);
  assert.equal(q.userId, f.employee.id); assert.equal(q.enabled, true);
  assert.equal(q.daily.period, '2026-10-26'); assert.equal(q.daily.resetAt, '2026-10-26T16:00:00.000Z');
  assert.equal(q.monthly.period, '2026-10'); assert.equal(q.monthly.resetAt, '2026-10-31T16:00:00.000Z');
  const all = await f.request('/quotas', { token: f.adminToken });
  assert.equal(all.data.timeZone, 'Asia/Shanghai'); assert.equal(all.data.quotas.length, 2);
  for (const bad of [-1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await f.set(bad, null)).status, 400);
  assert.equal((await f.request('/users/no-such-user/quota', { token: f.adminToken, method: 'PUT', body: { dailyLimit: 1, monthlyLimit: null } })).status, 404);
  assert.equal((await f.set(0, null)).status, 200);
  assert.equal((await f.reserve('zero-day', 1)).data.error.code, 'QUOTA_EXCEEDED');
  await f.set(null, 0); assert.equal((await f.reserve('zero-month', 1)).status, 403);
  await f.set(1000, 10000); await f.restart();
  q = await f.quota(); assert.equal(q.daily.limit, 1000); assert.equal(q.monthly.limit, 10000); assert.equal(q.daily.used, 0);
  await f.set(null, null); assert.equal((await f.reserve('unlimited', 1000000)).status, 200);
await t.test('identity comes from session, release only applies before transport, and IDs cannot reopen', async () => {
  await f.personal('/quota/release', { id: 'unlimited', reason: 'not-sent' });
  await f.set(100, 100);
  await f.reserve('own', 100, { userId: 'someone-else' });
  const adminOwn = (await f.request('/quota', { token: f.adminToken })).data.quota;
  assert.equal(adminOwn.daily.reserved, 0); assert.equal((await f.quota()).daily.reserved, 100);
  assert.equal((await f.request('/quota/settle', { token: f.adminToken, method: 'POST', body: { event: receipt('own', 10) } })).status, 404);
  assert.equal((await f.personal('/quota/release', { id: 'own', reason: 'timeout' })).status, 400);
  const released = await f.personal('/quota/release', { id: 'own', reason: 'not-sent' });
  assert.equal(released.data.released, true); assert.equal(released.data.quota.daily.reserved, 0);
  assert.equal((await f.personal('/quota/release', { id: 'own', reason: 'not-sent' })).data.released, true);
  assert.equal((await f.reserve('own', 100)).data.status, 'released');
  await f.reserve('new-id', 100); assert.equal((await f.quota()).daily.reserved, 100);
  for (const bad of [0, -1, 1.1, '1', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await f.reserve('bad', bad)).status, 400);
  assert.equal((await f.personal('/quota/settle', { event: receipt('unreserved', 10) })).status, 404);
});
});

test('atomic admission includes existing usage, prevents concurrent overbooking, and settles once', async (t) => {
  const f = await fixture(t);
  await f.personal('/usage', { events: [receipt('old-today', 20), receipt('old-yesterday', 70, { at: '2026-10-25T02:00:00Z' })] });
  await f.set(100, 180);
  const attempts = await Promise.all([f.reserve('parallel-a', 60), f.reserve('parallel-b', 60)]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 403]);
  const id = attempts.find((r) => r.status === 200).data.id;
  let q = await f.quota(); assert.equal(q.daily.used, 20); assert.equal(q.daily.reserved, 60); assert.equal(q.monthly.used, 90);
  assert.equal((await f.reserve(id, 60)).status, 200); assert.equal((await f.quota()).daily.reserved, 60);
  assert.equal((await f.reserve(id, 61)).data.error.code, 'QUOTA_REQUEST_CONFLICT');
  assert.equal((await f.reserve(id, 60, { model: 'different' })).status, 409);
  const event = receipt(id, 25);
  assert.equal((await f.personal('/quota/settle', { event })).data.settled, true);
  await f.personal('/quota/settle', { event }); await f.personal('/usage', { events: [event] });
  q = await f.quota(); assert.equal(q.daily.used, 45); assert.equal(q.daily.reserved, 0); assert.equal(q.monthly.used, 115);
  assert.equal((await f.reserve(id, 60)).data.status, 'settled', 'settled ID never admits a new request');
  assert.equal((await f.personal('/quota/settle', { event: receipt(id, 1) })).status, 409);
  assert.equal((await f.personal('/usage', { events: [receipt(id, 1)] })).status, 409);
  await f.personal('/usage', { events: [receipt(id, 0, { reported: false, incomplete: true })] });
  assert.equal((await f.quota()).daily.used, 45, 'stale unknown receipt cannot erase the complete one');
  assert.equal((await f.personal('/quota/release', { id, reason: 'not-sent' })).data.released, false);
});

test('missing and partial receipts keep the unresolved budget across restart; late usage settles it', async (t) => {
  const f = await fixture(t); await f.set(100, 200);
  await f.reserve('missing', 60);
  await f.personal('/quota/settle', { event: receipt('missing', 0, { reported: false, incomplete: true }) });
  await f.restart(); f.advance('2026-10-26T05:00:00Z');
  let q = await f.quota(); assert.equal(q.daily.used, 0); assert.equal(q.daily.reserved, 60, 'no timeout silently assumes a free request');
  await f.personal('/usage', { events: [receipt('missing', 10, { incomplete: true })] });
  q = await f.quota(); assert.equal(q.daily.used, 10); assert.equal(q.daily.reserved, 50);
  assert.equal((await f.personal('/usage', { events: [receipt('missing', 5, { incomplete: true })] })).status, 409);
  assert.equal((await f.personal('/quota/release', { id: 'missing', reason: 'not-sent' })).status, 409);
  assert.equal((await f.reserve('would-overbook', 41)).status, 403);
  await f.personal('/usage', { events: [receipt('missing', 30)] });
  q = await f.quota(); assert.equal(q.daily.used, 30); assert.equal(q.daily.reserved, 0);
  await f.reserve('underestimated', 50);
  await f.personal('/quota/settle', { event: receipt('underestimated', 90) });
  q = await f.quota(); assert.equal(q.daily.used, 120); assert.equal(q.daily.remaining, 0);
  assert.equal((await f.reserve('next', 1)).status, 403, 'actual usage is never truncated to the estimate');
});

test('server admission time pins late receipts to the right Shanghai day and month', async (t) => {
  const f = await fixture(t, '2026-10-31T15:59:59Z'); await f.set(100, 100);
  await f.reserve('last-day', 70); await f.reserve('still-pending', 30);
  f.advance('2026-10-31T16:00:01Z');
  let q = await f.quota(); assert.equal(q.daily.period, '2026-11-01'); assert.equal(q.monthly.period, '2026-11');
  assert.equal(q.daily.used + q.daily.reserved, 0); assert.equal(q.monthly.remaining, 100);
  await f.personal('/usage', { events: [receipt('last-day', 20, { at: '2027-01-01T00:00:00Z' })] });
  q = await f.quota(); assert.equal(q.daily.used, 0);
  const previous = await f.personal('/usage?from=2026-10-31&to=2026-10-31', undefined, 'GET');
  assert.equal(previous.data.totals.total, 20, 'client clock cannot move a reserved request to a different budget period');
  await f.reserve('new-month', 100); assert.equal((await f.quota()).monthly.reserved, 100);
});
