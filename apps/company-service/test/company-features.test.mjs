import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';


import { createCompanyService } from '../src/service.mjs';

import Database from 'better-sqlite3';

const testRoot = path.resolve(process.env.DAOCUT_COMPANY_TEST_ROOT || 'D:/Daocut/CompanyTests');
await mkdir(testRoot, { recursive: true });
const services = new Map();
async function temporaryData(t) {
  const folder = await mkdtemp(path.join(testRoot, 'service-'));
  t.after(async () => { await services.get(folder)?.close(); const resolved = path.resolve(folder); if (!resolved.startsWith(`${testRoot}${path.sep}`)) throw new Error('Unsafe test cleanup'); await rm(resolved, { recursive: true, force: true }); });
  return folder;
}
async function start(t, options = {}) {
  const dataDir = options.dataDir || await temporaryData(t);
  const service = await createCompanyService({ dataDir, host: '127.0.0.1', port: 0, baseURL: 'http://127.0.0.1:4715', ...options });
  await service.listen(); services.set(dataDir, service);
  const origin = `http://127.0.0.1:${service.server.address().port}`;
  const request = async (route, { token, cookie, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${origin}${route}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const content = await response.text(); let data = content; if (response.headers.get('content-type')?.includes('application/json')) data = JSON.parse(content);
    return { response, status: response.status, data };
  };
  return { service, request, dataDir, origin };
}
const adminBody = { username: 'test.admin', name: '测试管理员', password: 'Synthetic-Admin-42!' };
const employeeBody = { username: 'test.employee', name: '测试员工', password: 'Synthetic-Employee-42!' };

async function usageActors(t, options) {
  const fixture = await start(t, options);
  const { request } = fixture;
  await request('/api/company/setup', { method: 'POST', body: adminBody });
  const adminLogin = (await request('/api/company/login', { method: 'POST', body: adminBody })).data;
  const employee = (await request('/api/company/users', { method: 'POST', token: adminLogin.token, body: employeeBody })).data.user;
  const token = (await request('/api/company/login', { method: 'POST', body: employeeBody })).data.token;
  const otherBody = { username: 'usage.other', name: '另一员工', password: 'Synthetic-Other-42!' };
  const other = (await request('/api/company/users', { method: 'POST', token: adminLogin.token, body: otherBody })).data.user;
  const otherToken = (await request('/api/company/login', { method: 'POST', body: otherBody })).data.token;
  return { ...fixture, adminToken: adminLogin.token, employee, token, other, otherToken };
}
const usage = (id, patch = {}) => ({ id, at: '2026-10-23T16:00:00.000Z', model: 'deepseek-flash', input: 10, output: 5, cacheRead: 20, cacheWrite: 2, reasoning: 3, total: 37, reported: true, incomplete: false, costs: { CNY: 0.01 }, appVersion: 'test', ...patch });

test('usage is idempotent, tenant-scoped, Shanghai dated, and explicit about missing receipts', async (t) => {
  const { request, token, otherToken, adminToken, employee, other } = await usageActors(t);
  const send = (events, bearer = token) => request('/api/company/usage', { method: 'POST', token: bearer, body: { events } });
  assert.equal((await send([usage('edge-before', { at: '2026-10-23T15:59:59.999Z' }), usage('edge-start'), usage('edge-end', { at: '2026-10-24T15:59:59.999Z' }), usage('edge-after', { at: '2026-10-24T16:00:00Z' })])).status, 200);
  assert.equal((await send([usage('edge-start'), usage('edge-end', { at: '2026-10-24T15:59:59.999Z' })])).status, 200);
  assert.equal((await send([usage('edge-start')], otherToken)).status, 200, 'same event ID scoped to different employee');
  const query = '/api/company/usage?from=2026-10-24&to=2026-10-24';
  let personal = (await request(query, { token })).data;
  assert.equal(personal.totals.requests, 2);
  assert.equal(personal.totals.total, 74, 'cache and reasoning are not double counted');
  assert.equal(personal.totals.output, 10);
  assert.equal(personal.totals.reasoning, 6);
  assert.equal(personal.totals.costs.CNY, 0.02);
  assert.deepEqual(personal.daily.map((day) => day.date), ['2026-10-24']);
  assert.equal(personal.employees.length, 1);
  assert.equal(personal.employees[0].userId, employee.id);
  assert.equal((await request(`${query}&userId=${other.id}`, { token })).status, 403);
  assert.equal((await request(query, { token: adminToken })).data.totals.requests, 3);
  assert.equal((await request(`${query}&model=no-such-model`, { token })).data.totals.requests, 0);
  const missing = usage('missing', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, reported: false, incomplete: false, costs: undefined });
  assert.equal((await send([missing])).status, 200);
  personal = (await request(query, { token })).data;
  assert.equal(personal.totals.requests, 3);
  assert.equal(personal.totals.incompleteRequests, 1);
  assert.equal(personal.totals.reportedRequests, 2);
  assert.equal('costs' in personal.totals, false, 'no misleading partial total cost');
  assert.equal((await send([usage('missing')])).status, 200, 'late receipt replaces incomplete event');
  await send([missing]);
  personal = (await request(query, { token })).data;
  assert.equal(personal.totals.requests, 3);
  assert.equal(personal.totals.incompleteRequests, 0, 'stale retry cannot overwrite complete receipt');
  assert.equal(personal.totals.total, 111);
  assert.equal((await send([usage('bad', { total: 40 })])).status, 400);
  assert.equal((await send([usage('bad', { input: -1 })])).status, 400);
  assert.equal((await send(Array.from({ length: 201 }, (_, index) => usage(`too-many-${index}`)))).status, 400);
  const validBatch = Array.from({ length: 200 }, (_, index) => usage(`batch-${index}`));
  assert.equal((await send(validBatch)).status, 200, '200 event batch exceeds legacy JSON limit and is accepted');
  assert.equal((await request('/api/company/usage?from=2026-02-31&to=2026-10-24', { token })).status, 400);
  assert.equal((await request('/api/company/usage?from=2026-10-25&to=2026-10-24', { token })).status, 400);
  assert.equal((await request(query)).status, 401);
});

test('feedback diagnostics and screenshots retain permissions, limits, and compact listing', async (t) => {
  const { request, origin, token, otherToken, adminToken, employee } = await usageActors(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const body = { category: 'bug', title: '诊断合成反馈', description: '没有真实员工数据', diagnostics: { report: '<script>alert(1)</script>\nBasic synthetic report', details: 'x'.repeat(30_000) }, attachments: [{ name: '测试截图.png', mimeType: 'image/png', data: png.toString('base64') }] };
  const post = await request('/api/company/feedback', { method: 'POST', token, body });
  assert.equal(post.status, 201, JSON.stringify(post.data));
  const id = post.data.feedback.id;
  const listed = (await request('/api/company/feedback', { token: adminToken })).data.feedback[0];
  assert.equal(listed.hasDiagnostics, true);
  assert.equal('diagnostics' in listed, false);
  assert.equal('data' in listed.attachments[0], false);
  assert.equal('bytes' in listed.attachments[0], false);
  const detail = (await request(`/api/company/feedback/${id}`, { token })).data.feedback;
  assert.deepEqual(detail.diagnostics, body.diagnostics);
  assert.equal((await request(`/api/company/feedback/${id}`, { token: otherToken })).status, 404);
  const imageRoute = `/api/company/feedback/${id}/attachments/${listed.attachments[0].id}`;
  const imageResponse = await fetch(`${origin}${imageRoute}`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), png);
  assert.equal((await request(imageRoute, { token: otherToken })).status, 404);
  assert.equal((await request(imageRoute)).status, 401);
  for (const invalid of [
    { attachments: [{ ...body.attachments[0], mimeType: 'image/jpeg' }] },
    { attachments: Array(4).fill(body.attachments[0]) },
    { attachments: [{ ...body.attachments[0], data: Buffer.from('<svg/onload=alert(1)>').toString('base64') }] },
    { diagnostics: { report: '中'.repeat(22_000) } },
    { diagnostics: { report: 'ok', details: 'x'.repeat(256 * 1024 + 1) } },
    { attachments: [{ ...body.attachments[0], data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }] },
  ]) assert.equal((await request('/api/company/feedback', { method: 'POST', token, body: { ...body, ...invalid } })).status, 400);
  assert.equal((await request('/api/company/feedback', { method: 'POST', token, body: { ...body, extra: 'x'.repeat(10 * 1024 * 1024) } })).status, 413);
  assert.equal((await request('/api/company/feedback', { token })).data.feedback.length, 1, 'invalid attachments do not leave partial feedback');
  const appScript = (await request('/app.js')).data;
  assert.ok(appScript.includes('esc(diagnostic.report)') && appScript.includes('esc(diagnostic.details)'), 'diagnostics are rendered as escaped text');
  await t.test('listing reads metadata without materializing diagnostic bodies', () => checkFeedbackList({ request, token, otherToken, adminToken, employee }));
});

async function checkFeedbackList({ request, token, otherToken, adminToken, employee }) {
  const body = { category: 'bug', title: 'Large synthetic diagnostic', description: 'List metadata only', diagnostics: { report: 'r'.repeat(64 * 1024), details: 'd'.repeat(256 * 1024) } };
  const posted = await request('/api/company/feedback', { method: 'POST', token, body });
  assert.equal(posted.status, 201);
  const plain = await request('/api/company/feedback', { method: 'POST', token: otherToken, body: { category: 'other', title: 'No diagnostic', description: 'A separate employee record' } });
  assert.equal(plain.status, 201);

  // Observe real SQLite result rows, not just the already-filtered HTTP response.
  const prepared = Database.prototype.prepare;
  const listRows = [];
  Database.prototype.prepare = function (sql, ...args) {
    const statement = prepared.call(this, sql, ...args);
    if (/\bFROM\s+company_feedback\b/i.test(sql)) {
      const all = statement.all;
      statement.all = function (...values) {
        const rows = all.apply(this, values);
        listRows.push(rows);
        return rows;
      };
    }
    return statement;
  };
  let adminList, ownList;
  try {
    adminList = await request('/api/company/feedback', { token: adminToken });
    ownList = await request('/api/company/feedback', { token });
  } finally { Database.prototype.prepare = prepared; }

  assert.equal(adminList.status, 200);
  assert.equal(ownList.status, 200);
  assert.equal(listRows.length, 2, 'both list routes ran against the real database');
  for (const rows of listRows) for (const row of rows) {
    assert.equal('diagnostics' in row, false, 'large diagnostic JSON must not cross the SQLite/JS boundary for a list');
  }
  const listed = adminList.data.feedback.find((item) => item.id === posted.data.feedback.id);
  assert.equal(listed.hasDiagnostics, true);
  assert.equal(listed.userName, employee.name);
  assert.equal(listed.username, employee.username);
  assert.equal('diagnostics' in listed, false);
  assert.equal(adminList.data.feedback.find((item) => item.id === plain.data.feedback.id).hasDiagnostics, false);
  assert.ok(ownList.data.feedback.some((item) => item.id === posted.data.feedback.id));
  assert.ok(ownList.data.feedback.every((item) => item.userId === employee.id));
  assert.equal(ownList.data.feedback.some((item) => item.id === plain.data.feedback.id), false);
  const detail = await request(`/api/company/feedback/${posted.data.feedback.id}`, { token });
  assert.deepEqual(detail.data.feedback.diagnostics, body.diagnostics, 'details remain available on demand');
}

test('existing company feedback tables migrate without losing accounts or records', async (t) => {
  const dataDir = await temporaryData(t);
  const db = new Database(path.join(dataDir, 'company.sqlite'));
  db.exec(`CREATE TABLE company_feedback (id TEXT PRIMARY KEY,userId TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,appVersion TEXT NOT NULL DEFAULT '',platform TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'new',adminNote TEXT NOT NULL DEFAULT '',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
    INSERT INTO company_feedback VALUES ('legacy','legacy-user','bug','旧反馈','保留旧内容','','','new','','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z');`);
  db.close();
  const first = await start(t, { dataDir });
  await first.service.close(); services.delete(dataDir);
  const check = new Database(path.join(dataDir, 'company.sqlite'));
  assert.equal(check.prepare('SELECT description FROM company_feedback WHERE id=?').get('legacy').description, '保留旧内容');
  assert.equal(check.prepare('SELECT diagnostics FROM company_feedback WHERE id=?').get('legacy').diagnostics, '');
  assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name='company_usage'").get());
  check.close();
  const second = await start(t, { dataDir });
  assert.equal((await second.request('/api/company/health')).status, 200, 'migration can be rerun');
});
