import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createStructureWorkspace } from './structure-workspace.mjs';

test('structure batch routes use the parent project and only the submitted selection', async t => {
  const calls = [], project = { id: 'parent', path: 'D:/CodexWork/Daocut/.tmp/no-batch-route-project' };
  const batches = Object.fromEntries(['list', 'create', 'retry', 'cancel', 'reveal'].map(action => [action, async (...args) => { calls.push([action, ...args]); return { action }; }]));
  const workspace = createStructureWorkspace({ plans: {}, batches });
  const server = createServer(async (req, res) => {
    try { if (!await workspace.route(req, res, project, req.url.slice(1))) { res.statusCode = 404; res.end('{}'); } }
    catch (error) { res.statusCode = error.status ?? 500; res.end(JSON.stringify({ error: error.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.deepEqual(await call('structure-exports'), { action: 'list' });
  const request = { taskKey: 'public-version', planIds: ['selected-2', 'selected-5'], requestId: 'request-1', sourceId: 's', productId: 'p', intervalId: 'once', name: '随行杯', folder: 'D:/CodexWork/Daocut/.tmp/test-output' };
  await call('structure-exports', 'POST', request);
  await call('structure-exports/batch-1/retry', 'POST', {});
  await call('structure-exports/batch-1/cancel', 'POST', {});
  await call('structure-exports/batch-1/reveal', 'POST', { folder: 'ignored-arbitrary-client-path' });
  assert.deepEqual(calls.map(c => [c[0], c[1].id]), [['list', 'parent'], ['create', 'parent'], ['retry', 'parent'], ['cancel', 'parent'], ['reveal', 'parent']]);
  assert.deepEqual(calls[1][2], request);
  assert.equal(calls[2][2], 'batch-1');
  assert.deepEqual(calls[4].slice(2), ['batch-1']);
});
