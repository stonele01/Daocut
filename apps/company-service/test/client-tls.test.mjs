import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';
import { companyRequest } from '../../desktop/src/company-client.mjs';

// Deliberately independent of service.mjs and SQLite: also runs in packaged Electron RunAsNode.
// Certificates and keys are synthetic and remain in memory; only ephemeral loopback ports are used.
async function serviceLeaf({ expired = false, ip = '127.0.0.1' } = {}) {
  const now = Date.now();
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Daocut Company LAN' }], {
    keySize: 2048, algorithm: 'sha256',
    notBeforeDate: new Date(now - 2 * 24 * 60 * 60_000),
    notAfterDate: new Date(now + (expired ? -1 : 1) * 24 * 60 * 60_000),
    // Match setup-lan.mjs: a server leaf, without CA or keyCertSign privileges.
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip }] },
    ],
  });
  const cert = new X509Certificate(pems.cert);
  assert.equal(cert.ca, false);
  assert.equal(cert.verify(cert.publicKey), true, 'the fixture is self-signed');
  return pems;
}

async function localServer(t, pems) {
  const received = [];
  const server = createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    received.push({ method: req.method, path: req.url, authorization: req.headers.authorization,
      contentType: req.headers['content-type'], body: text ? JSON.parse(text) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { received, profile: { name: 'Synthetic company',
    serverUrl: `https://127.0.0.1:${server.address().port}`, caPem: pems.cert } };
}

async function rejectsCertificate(request, received) {
  await assert.rejects(request, (error) => {
    assert.equal(error.code, 'company-unavailable');
    assert.match(error.message, /证书验证失败/);
    return true;
  });
  assert.equal(received.length, 0, 'TLS must reject before any application request arrives');
}

test('companyRequest validates service leaf certificates in Node and Electron', async (t) => {
  const valid = await serviceLeaf();
  const wrong = await serviceLeaf();
  const expired = await serviceLeaf({ expired: true });
  const mismatch = await serviceLeaf({ ip: '127.0.0.2' });
  assert.notEqual(new X509Certificate(valid.cert).fingerprint256, new X509Certificate(wrong.cert).fingerprint256);
  assert.ok(Date.parse(new X509Certificate(expired.cert).validTo) < Date.now());
  assert.equal(new X509Certificate(mismatch.cert).checkIP('127.0.0.1'), undefined);

  await t.test('GET accepts the explicitly trusted valid service leaf', async (t) => {
    const { profile, received } = await localServer(t, valid);
    assert.deepEqual(await companyRequest(profile, '/health'), { ok: true });
    assert.deepEqual(received, [{ method: 'GET', path: '/api/company/health',
      authorization: undefined, contentType: undefined, body: undefined }]);
  });
  await t.test('POST sends JSON and a synthetic bearer after successful TLS verification', async (t) => {
    const { profile, received } = await localServer(t, valid);
    const body = { category: 'bug', title: '合成 TLS 测试', description: 'No account or project data' };
    assert.deepEqual(await companyRequest(profile, '/feedback', {
      method: 'POST', token: 'synthetic-test-token', body,
    }), { ok: true });
    assert.deepEqual(received, [{ method: 'POST', path: '/api/company/feedback',
      authorization: 'Bearer synthetic-test-token', contentType: 'application/json', body }]);
  });
  await t.test('rejects a self-signed service when no CA was imported', async (t) => {
    const { profile, received } = await localServer(t, valid);
    await rejectsCertificate(companyRequest({ ...profile, caPem: '' }, '/health'), received);
  });
  await t.test('rejects a different imported certificate with the same subject', async (t) => {
    const { profile, received } = await localServer(t, valid);
    await rejectsCertificate(companyRequest({ ...profile, caPem: wrong.cert }, '/health'), received);
  });
  await t.test('rejects an expired certificate even when explicitly trusted', async (t) => {
    const { profile, received } = await localServer(t, expired);
    await rejectsCertificate(companyRequest(profile, '/health'), received);
  });
  await t.test('rejects a SAN mismatch even when explicitly trusted', async (t) => {
    const { profile, received } = await localServer(t, mismatch);
    await rejectsCertificate(companyRequest(profile, '/health'), received);
  });
});
