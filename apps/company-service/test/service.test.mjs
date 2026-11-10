import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { companyRequest, companyCertificateDecision } from '../../desktop/src/company-client.mjs';
import { X509Certificate } from 'node:crypto';
import { createCompanyService } from '../src/service.mjs';
import { setupLan, lanAddresses } from '../src/setup-lan.mjs';

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

test('accounts, signed sessions, revocation, feedback isolation, and admin triage', async (t) => {
  const { request, dataDir } = await start(t);
  assert.equal((await request('/api/company/health')).data.setupRequired, true);
  const setup = await request('/api/company/setup', { method: 'POST', body: adminBody });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));
  assert.equal(setup.data.user.role, 'admin');
  assert.equal((await request('/api/company/setup', { method: 'POST', body: adminBody })).status, 409);
  assert.equal((await request('/api/auth/sign-up/email', { method: 'POST', body: {} })).status, 404);
  assert.equal((await request('/api/company/users')).status, 401);
  const adminLogin = await request('/api/company/login', { method: 'POST', body: adminBody });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.data));
  const adminToken = adminLogin.data.token;
  assert.ok(adminToken.includes('.'), 'Bearer token is signed');
  const cookie = adminLogin.response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.equal((await request('/api/company/session', { cookie })).data.user.username, adminBody.username);
  assert.equal((await request('/api/company/users', { token: adminToken })).data.users.length, 1);
  const create = await request('/api/company/users', { method: 'POST', token: adminToken, body: employeeBody });
  assert.equal(create.status, 201, JSON.stringify(create.data));
  const employeeId = create.data.user.id;
  const employeeLogin = await request('/api/company/login', { method: 'POST', body: employeeBody });
  assert.equal(employeeLogin.status, 200, JSON.stringify(employeeLogin.data));
  const token = employeeLogin.data.token;
  assert.equal((await request('/api/company/session', { token })).data.user.enabled, true);
  assert.equal((await request('/api/company/session', { token: token.split('.')[0] })).status, 401, 'unsigned bearer is rejected');
  assert.equal((await request('/api/company/users', { token })).status, 403);
  const feedback = await request('/api/company/feedback', { method: 'POST', token, body: { category: 'bug', title: '合成测试反馈', description: '仅使用测试文本，不含真实素材', appVersion: '0.0.0-test', platform: 'test' } });
  assert.equal(feedback.status, 201, JSON.stringify(feedback.data));
  const id = feedback.data.feedback.id;
  assert.equal((await request(`/api/company/feedback/${id}`, { method: 'PATCH', token, body: { status: 'closed' } })).status, 403);
  const other = { username: 'test.other', name: '另一位测试员工', password: 'Synthetic-Other-42!' };
  assert.equal((await request('/api/company/users', { method: 'POST', token: adminToken, body: other })).status, 201);
  const otherToken = (await request('/api/company/login', { method: 'POST', body: other })).data.token;
  assert.deepEqual((await request('/api/company/feedback', { token: otherToken })).data.feedback, []);
  const triage = await request(`/api/company/feedback/${id}`, { method: 'PATCH', token: adminToken, body: { status: 'resolved', adminNote: '测试已完成' } });
  assert.equal(triage.status, 200);
  assert.equal((await request('/api/company/feedback', { token })).data.feedback[0].adminNote, '测试已完成');
  assert.equal((await request(`/api/company/users/${employeeId}/status`, { method: 'POST', token: adminToken, body: { enabled: false } })).status, 200);
  assert.equal((await request('/api/company/session', { token })).status, 401, 'disable revokes active session');
  assert.equal((await request('/api/company/login', { method: 'POST', body: employeeBody })).status, 403, 'disabled user cannot login');
  assert.equal((await request(`/api/company/users/${employeeId}/status`, { method: 'POST', token: adminToken, body: { enabled: true } })).status, 200);
  const restoredToken = (await request('/api/company/login', { method: 'POST', body: employeeBody })).data.token;
  assert.ok(restoredToken);
  const newPassword = 'Synthetic-New-Password-42!';
  assert.equal((await request(`/api/company/users/${employeeId}/password`, { method: 'POST', token: adminToken, body: { password: newPassword } })).status, 200);
  assert.equal((await request('/api/company/session', { token: restoredToken })).status, 401, 'reset password revokes active session');
  assert.equal((await request('/api/company/login', { method: 'POST', body: employeeBody })).status, 401, 'old password rejected');
  const changedLogin = await request('/api/company/login', { method: 'POST', body: { ...employeeBody, password: newPassword } });
  assert.equal(changedLogin.status, 200, JSON.stringify(changedLogin.data));
  assert.equal((await request('/api/company/logout', { method: 'POST', token: changedLogin.data.token, body: {} })).status, 200);
  assert.equal((await request('/api/company/session', { token: changedLogin.data.token })).status, 401, 'logout revokes token');
  assert.equal((await request(`/api/company/users/${setup.data.user.id}/status`, { method: 'POST', token: adminToken, body: { enabled: false } })).status, 400);
  const databaseBytes = await readFile(path.join(dataDir, 'company.sqlite-wal'));
  assert.equal(databaseBytes.includes(Buffer.from(employeeBody.password)), false, 'plaintext password is never persisted');
});

test('request boundaries, published update ranges, and static management page', async (t) => {
  const { request, dataDir, origin } = await start(t);
  assert.equal((await request('/admin')).status, 200);
  assert.equal((await request('/style.css')).status, 200);
  assert.equal((await request('/api/company/setup', { method: 'POST', body: adminBody, headers: { origin: 'https://other.invalid' } })).status, 403);
  const concurrentSetup = await Promise.all([
    request('/api/company/setup', { method: 'POST', body: adminBody, headers: { origin } }),
    request('/api/company/setup', { method: 'POST', body: { ...adminBody, username: 'racing.admin' }, headers: { origin } }),
  ]);
  assert.deepEqual(concurrentSetup.map((result) => result.status).sort(), [201, 409], 'only one initial administrator can win');
  const oversized = await request('/api/company/login', { method: 'POST', body: { username: 'test.admin', password: 'x'.repeat(30_000) } });
  assert.equal(oversized.status, 413);
  const chunked = await new Promise((resolve, reject) => { const req = http.request(origin + '/api/company/login', { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); req.on('error', reject); req.write('{"username":"test.admin","password":"'); req.write('x'.repeat(30_000)); req.end('"}'); });
  assert.equal(chunked, 413, 'chunked oversized requests are also rejected');
  assert.equal((await request('/api/company/login', { method: 'POST', body: { username: 'x', password: 'x' } })).status, 400);
  const wrongHost = await new Promise((resolve, reject) => { const req = http.get(origin + '/api/company/health', { headers: { host: 'attacker.invalid' } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); req.on('error', reject); });
  assert.equal(wrongHost, 400);
  await writeFile(path.join(dataDir, 'updates', 'Daocut-Test.exe'), Buffer.from('0123456789'));
  const download = await request('/updates/Daocut-Test.exe'); assert.equal(download.data, '0123456789');
  const range = await request('/updates/Daocut-Test.exe', { headers: { range: 'bytes=2-5' } }); assert.equal(range.status, 206); assert.equal(range.data, '2345');
  const invalidRange = await request('/updates/Daocut-Test.exe', { headers: { range: 'bytes=100-' } }); assert.equal(invalidRange.status, 416);
  assert.equal((await request('/updates/%2e%2e%2fserver-key.pem')).status, 404);
  assert.equal((await request('/updates/..%5cserver-key.pem')).status, 404);
  assert.equal((await request('/updates/auth-secret')).status, 404);
  assert.equal((await request('/updates/')).status, 404);
});

test('TLS profile trusts only its certificate and includes localhost plus selected IP', async (t) => {
  const dataDir = await temporaryData(t);
  const result = await setupLan({ dataDir, ip: '127.0.0.1' });
  const profile = JSON.parse(await readFile(result.profilePath, 'utf8'));
  assert.deepEqual(Object.keys(profile).sort(), ['caPem', 'name', 'serverUrl']);
  assert.equal(profile.caPem.includes('PRIVATE KEY'), false);
  const cert = new X509Certificate(profile.caPem);
  assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1'); assert.equal(cert.checkHost('localhost'), 'localhost');
  const tls = { key: await readFile(path.join(dataDir, 'server-key.pem')), cert: profile.caPem };
  const service = await createCompanyService({ dataDir, host: '127.0.0.1', port: 0, baseURL: 'https://127.0.0.1:4715', tls });
  await service.listen(); services.set(dataDir, service);
  const url = `https://127.0.0.1:${service.server.address().port}/api/company/health`;
  const request = (ca) => new Promise((resolve, reject) => { const req = https.get(url, { ca }, (res) => { let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); }); req.on('error', reject); });
  assert.equal((await request(profile.caPem)).status, 200);
  const desktopProfile = { ...profile, serverUrl: new URL(url).origin };
  assert.equal((await companyRequest(desktopProfile, '/health')).ok, true, 'real desktop client trusts generated certificate');
  await assert.rejects(companyRequest({ ...desktopProfile, caPem: '' }, '/health'), /证书/);
  const wrongFolder = await temporaryData(t);
  const wrongCertificate = await setupLan({ dataDir: wrongFolder, ip: '127.0.0.1' });
  const wrongProfile = JSON.parse(await readFile(wrongCertificate.profilePath, 'utf8'));
  await assert.rejects(companyRequest({ ...desktopProfile, caPem: wrongProfile.caPem }, '/health'), /证书/);
  const presented = { hostname: '127.0.0.1', certificate: { data: profile.caPem } };
  assert.equal(companyCertificateDecision(desktopProfile, presented), 0);
  assert.equal(companyCertificateDecision(desktopProfile, { ...presented, hostname: 'unrelated.invalid' }), -3);
  assert.equal(companyCertificateDecision(desktopProfile, { ...presented, certificate: { data: wrongProfile.caPem } }), -2);
  assert.equal(companyCertificateDecision(desktopProfile, presented, Date.parse(cert.validTo) + 1000), -2);
  assert.equal(companyCertificateDecision({ ...desktopProfile, serverUrl: 'https://127.0.0.2:4715' }, { ...presented, hostname: '127.0.0.2' }), -2);
  await assert.rejects(request(undefined), /self-signed|certificate/i);
  assert.equal((await setupLan({ dataDir, ip: '127.0.0.1' })).fingerprint, result.fingerprint, 'rerunning setup preserves trust');
});

test('LAN HTTP listener is refused', async () => {
  await assert.rejects(createCompanyService({ host: '0.0.0.0', dataDir: path.join(testRoot, 'unused') }), /TLS/);
});




test('bootstrap rejects a real LAN socket even on the server computer', { skip: lanAddresses().length === 0 }, async (t) => {
  const dataDir = await temporaryData(t); const ip = lanAddresses()[0].address;
  const result = await setupLan({ dataDir, ip });
  const profile = JSON.parse(await readFile(result.profilePath, 'utf8'));
  const service = await createCompanyService({ dataDir, host: '0.0.0.0', port: 0, baseURL: `https://${ip}:4715`, tls: { cert: profile.caPem, key: await readFile(path.join(dataDir, 'server-key.pem')) } });
  await service.listen(); services.set(dataDir, service);
  const response = await new Promise((resolve, reject) => { const req = https.request(`https://${ip}:${service.server.address().port}/api/company/setup`, { method: 'POST', ca: profile.caPem, headers: { host: `${ip}:4715`, 'content-type': 'application/json' } }, (res) => { let body = ''; res.on('data', (part) => { body += part; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) })); }); req.on('error', reject); req.end(JSON.stringify(adminBody)); });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'LOCAL_SETUP_ONLY');
});
