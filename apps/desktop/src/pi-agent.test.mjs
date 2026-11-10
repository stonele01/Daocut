import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { AgentSession, ownAgentPrompt } = await import(process.env.DAOCUT_TEST_PACKAGED_SRC
  ? pathToFileURL(join(process.env.DAOCUT_TEST_PACKAGED_SRC, 'agents.mjs')).href : './agents.mjs');

/** A service on the Chat Completions API that answers "ok" and notes the model each request named (and each request, and its key). */
async function service({ broke = false, fails = null, busyOnce = false, largest = Infinity, reply = null } = {}) {
  const asked = [];
  const bodies = [];
  const keys = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { model } = JSON.parse(body || '{}');
      asked.push(model);
      bodies.push(JSON.parse(body || '{}'));
      keys.push(String(req.headers.authorization ?? ''));
      /* a proxy in front of the service refusing a body past its size, with its own HTML page */
      if (body.length > largest) { res.writeHead(413, { 'content-type': 'text/html' }); res.end('<html><head><title>413 Request Entity Too Large</title></head><body><center><h1>413 Request Entity Too Large</h1></center><hr><center>openresty</center></body></html>'); return; }
      if (broke) { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } })); return; }
      if (busyOnce && asked.length === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'The service is busy.' } })); return; }
      if (fails) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: fails } })); return; }
      const result = reply?.(bodies.at(-1), asked.length) ?? {};
      if (result.error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: result.error } })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (choice, extra = {}) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [choice], ...extra })}\n\n`;
      res.end(chunk({ index: 0, delta: { role: 'assistant', content: result.text ?? 'ok' }, finish_reason: null })
        + chunk({ index: 0, delta: {}, finish_reason: result.finish ?? 'stop' }, { usage: result.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
        + 'data: [DONE]\n\n');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { asked, bodies, keys, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}

/** One of the person's own models, as the roster's harness gives it (pi-config.mjs OwnModel). */
const own = (id, url, over = {}) => ({ id, name: id, api: 'openai-completions', baseUrl: url, keyEnv: `DAOCUT_BYOK_KEY_${id}`, model: id, levels: ['auto'], effort: 'auto', ...over });

test("the own key's models, each on its own service and key, are the session's model option; a turn after a switch goes to the other service", { timeout: 60_000 }, async () => {
  const first = await service();
  const second = await service();
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: {
      home: mkdtempSync(join(tmpdir(), 'of-pi-home-')),
      models: [own('a', first.url, { name: 'Vision', model: 'vision' }), own('b', second.url, { name: 'Big', model: 'big' })],
      model: 'a',
      env: { DAOCUT_BYOK_KEY_a: 'sk-first', DAOCUT_BYOK_KEY_b: 'sk-second' },
    },
  });
  try {
    const info = await session.start();
    const option = info.configOptions.find((o) => o.id === 'model');
    assert.equal(option.category, 'model');
    assert.equal(option.currentValue, 'a', 'the first model to begin with');
    assert.deepEqual(option.options, [{ value: 'a', name: 'Vision' }, { value: 'b', name: 'Big' }], 'by their names');
    await session.prompt([{ type: 'text', text: 'hi' }]);
    const system = first.bodies.at(-1).messages.find((m) => m.role === 'system');
    assert.ok(system?.content.includes(ownAgentPrompt()), 'the actual request carries the business rules and editing essentials');
    const switched = await session.setConfigOption('model', 'b');
    assert.equal(switched.configOptions[0].currentValue, 'b');
    await session.prompt([{ type: 'text', text: 'again' }]);
    assert.deepEqual([first.asked, first.keys], [['vision'], ['Bearer sk-first']], 'the first on its own service, with its key');
    assert.deepEqual([second.asked, second.keys], [['big'], ['Bearer sk-second']], 'the other on its own, with its own');
    await assert.rejects(session.setConfigOption('model', 'other'), 'a model not set up is refused');
  } finally {
    session.close();
    first.close();
    second.close();
  }
});

test('a model\'s efforts are the session\'s effort option: Auto sends no reasoning setting, a level sends that level', { timeout: 60_000 }, async () => {
  const svc = await service();
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: {
      home: mkdtempSync(join(tmpdir(), 'of-pi-home-')),
      models: [own('thinker', svc.url, { levels: ['auto', 'off', 'low', 'high'], effort: 'low' }), own('plain', svc.url)],
      model: 'thinker',
      env: { DAOCUT_BYOK_KEY_thinker: 'sk-test', DAOCUT_BYOK_KEY_plain: 'sk-test' },
    },
  });
  const effortOf = (options) => options.find((o) => o.id === 'effort');
  try {
    const info = await session.start();
    const effort = effortOf(info.configOptions);
    assert.equal(effort.category, 'thought_level');
    assert.deepEqual(effort.options.map((o) => o.value), ['auto', 'off', 'low', 'high'], 'only the efforts it was given');
    assert.equal(effort.currentValue, 'low', 'the one it starts on');
    await session.prompt([{ type: 'text', text: 'one' }]);
    assert.equal(svc.bodies.at(-1).reasoning_effort, 'low');

    await session.setConfigOption('effort', 'high');
    await session.prompt([{ type: 'text', text: 'two' }]);
    assert.equal(svc.bodies.at(-1).reasoning_effort, 'high');

    await session.setConfigOption('effort', 'auto');
    await session.prompt([{ type: 'text', text: 'three' }]);
    assert.equal(svc.bodies.at(-1).reasoning_effort, undefined, 'Auto: nothing about reasoning');
    await assert.rejects(session.setConfigOption('effort', 'max'), 'an effort it was not given is refused');

    /* a model given no efforts offers none, and is asked with none */
    const plain = await session.setConfigOption('model', 'plain');
    assert.equal(effortOf(plain.configOptions), undefined);
    await session.prompt([{ type: 'text', text: 'four' }]);
    assert.equal(svc.bodies.at(-1).model, 'plain');
    assert.equal(svc.bodies.at(-1).reasoning_effort, undefined);
  } finally {
    session.close();
    svc.close();
  }
});

test('a service with no balance left is named for the model the turn was on, not the first one', { timeout: 60_000 }, async () => {
  const first = await service();
  const second = await service({ broke: true });
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: {
      home: mkdtempSync(join(tmpdir(), 'of-pi-home-')),
      models: [own('a', first.url), own('b', second.url)],
      model: 'a',
      env: { DAOCUT_BYOK_KEY_a: 'sk-first', DAOCUT_BYOK_KEY_b: 'sk-second' },
    },
  });
  try {
    await session.start();
    await session.setConfigOption('model', 'b');
    const error = await session.prompt([{ type: 'text', text: 'hi' }]).then(() => null, (e) => e);
    assert.equal(error?.code, 'balance');
    assert.equal(error.balance.provider, new URL(second.url).host);
  } finally {
    session.close();
    first.close();
    second.close();
  }
});

test('a turn that fails says why, as the service said it, not "Internal error"', { timeout: 60_000 }, async () => {
  const svc = await service({ fails: 'The model `big` does not exist.' });
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('a', svc.url)], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'sk' } },
  });
  try {
    await session.start();
    const error = await session.prompt([{ type: 'text', text: 'hi' }]).then(() => null, (e) => e);
    assert.match(error?.message ?? '', /The model `big` does not exist\./);
    assert.equal(error.code, -32603);
  } finally {
    session.close();
    svc.close();
  }
});

test('a conversation too long for the model says so, and where its context is set', { timeout: 60_000 }, async () => {
  const svc = await service({ fails: "This model's maximum context length is 1000 tokens. However, you requested about 2000 tokens." });
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('a', svc.url)], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'sk' } },
  });
  try {
    await session.start();
    const error = await session.prompt([{ type: 'text', text: 'hi' }]).then(() => null, (e) => e);
    assert.equal(error?.message, "The conversation is too long for the model. The model's context may be smaller than set in Settings: lower it there.");
    assert.match(error.data?.details ?? '', /maximum context length is 1000 tokens/, 'what the service said goes too');
  } finally {
    session.close();
    svc.close();
  }
});

test('a service that fails and is tried again says so in the chat as a notice, and the turn goes on', { timeout: 60_000 }, async () => {
  const svc = await service({ busyOnce: true });
  const updates = [];
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('a', svc.url)], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'sk' } },
    onUpdate: (update) => updates.push(update),
  });
  try {
    await session.start();
    assert.equal(await session.prompt([{ type: 'text', text: 'hi' }]), 'end_turn');
    assert.equal(svc.asked.length, 2, 'asked twice');
    const notices = updates.filter((u) => u.sessionUpdate === 'notice');
    assert.equal(notices.length, 1, 'one notice, and none once it answers');
    assert.equal(notices[0].severity, 'warning');
    assert.equal(notices[0].title, 'The model service failed; trying again (1 of 1).');
    assert.match(notices[0].description, /The service is busy/);
  } finally {
    session.close();
    svc.close();
  }
});

/** A picture of noise, which no encoding makes smaller: `w` × `h`, RGB, as a PNG. */
function noisePng(w, h) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), randomBytes(w * 3)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

test('a request refused as too large is tried again at once with half of its pictures, and the turn goes on', { timeout: 60_000 }, async () => {
  const svc = await service({ largest: 8 * 1024 * 1024 });
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('a', svc.url)], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'sk' } },
  });
  /* fourteen pictures of about 0.95 MB each (Pi sends them as they are): 13 MB, past this service's 8 MB */
  const pictures = Array.from({ length: 14 }, () => ({ type: 'image', mimeType: 'image/png', data: noisePng(560, 420).toString('base64') }));
  try {
    await session.start();
    await session.prompt([{ type: 'text', text: 'look' }, ...pictures]);
    assert.equal(svc.bodies.length, 2, 'refused once, then tried again');
    const last = JSON.stringify(svc.bodies.at(-1));
    assert.ok(last.length < 8 * 1024 * 1024, 'the request tried again is within the service\'s size');
    assert.equal((last.match(/left out of this request to keep it small/g) ?? []).length, 7, 'half of the pictures left out, the oldest');
  } finally {
    session.close();
    svc.close();
  }
});

test('a request still too large when tried again with half of its pictures says so, and the next message goes on with fewer', { timeout: 60_000 }, async () => {
  const svc = await service({ largest: 4 * 1024 * 1024 });
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('a', svc.url)], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'sk' } },
  });
  const pictures = Array.from({ length: 14 }, () => ({ type: 'image', mimeType: 'image/png', data: noisePng(560, 420).toString('base64') }));
  try {
    await session.start();
    const error = await session.prompt([{ type: 'text', text: 'look' }, ...pictures]).then(() => null, (e) => e);
    assert.match(error?.message ?? '', /too large for the model service, even with older pictures left out/);
    await session.prompt([{ type: 'text', text: 'go on' }]);
    assert.ok(JSON.stringify(svc.bodies.at(-1)).length < 4 * 1024 * 1024, 'the next message goes with fewer pictures still');
  } finally {
    session.close();
    svc.close();
  }
});

test('a request too large with no pictures in it is not tried again, and says so', { timeout: 60_000 }, async () => {
  const svc = await service({ largest: 10 });
  const session = new AgentSession({
    agent: 'byok',
    cwd: mkdtempSync(join(tmpdir(), 'of-pi-')),
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('a', svc.url)], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'sk' } },
  });
  try {
    await session.start();
    const error = await session.prompt([{ type: 'text', text: 'hi' }]).then(() => null, (e) => e);
    assert.match(error?.message ?? '', /too large for the model service/);
    assert.equal(svc.bodies.length, 1, 'not tried again');
  } finally {
    session.close();
    svc.close();
  }
});

test('each Pi model call keeps a price snapshot beside the provider usage', { timeout: 60_000 }, async () => {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const svc = await service();
  const cwd = mkdtempSync(join(tmpdir(), 'of-pi-pricing-'));
  const logs = join(cwd, '.film', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'local-pricing.jsonl'), JSON.stringify({ kind: 'prompt', agent: 'byok', t: Date.now() }) + '\n');
  const pricing = { currency: 'CNY', input: 2, output: 8 };
  const session = new AgentSession({ agent: 'byok', cwd,
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('priced', svc.url, { pricing })],
      model: 'priced', env: { DAOCUT_BYOK_KEY_priced: 'synthetic-test-only' } },
  });
  try {
    await session.start();
    await session.prompt([{ type: 'text', text: 'synthetic fixture' }], { turnId: 'local:pricing' });
    const file = join(logs, 'local-pricing.model.jsonl');
    let calls = [];
    for (let i = 0; i < 100 && !calls.length; i += 1) {
      if (existsSync(file)) calls = readFileSync(file, 'utf8').split('\n').flatMap((line) => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } }).filter((line) => line.kind === 'call');
      if (!calls.length) await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].pricing, pricing);
    assert.equal(calls[0].answer.usage.input, 1);
    assert.equal(calls[0].answer.usage.output, 1);
    assert.equal(JSON.stringify(calls).includes('synthetic-test-only'), false);
  } finally { session.close(); svc.close(); }
});

test('automatic overflow recovery through ACP retries the streamed summary once, logs usage and keeps normal reasoning', { timeout: 60_000 }, async () => {
  const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const updates = [];
  const svc = await service({ reply: (_, n) => n === 1 ? { error: 'prompt is too long: 130000 tokens > 128000 maximum' }
    : n === 2 ? { text: 'INCOMPLETE SUMMARY MUST NOT APPEAR', finish: 'length', usage: { prompt_tokens: 24000, completion_tokens: 8192, total_tokens: 32192 } }
      : n === 3 ? { text: 'Complete checkpoint: product A 00:05.120 to 00:21.450; keep subtitles; no music.', usage: { prompt_tokens: 24000, completion_tokens: 80, total_tokens: 24080 } }
        : { text: 'Continuing the approved edit.' } });
  const cwd = mkdtempSync(join(tmpdir(), 'of-pi-compaction-'));
  const logs = join(cwd, '.film', 'logs');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'local-compaction.jsonl'), JSON.stringify({ kind: 'prompt', agent: 'byok', t: Date.now() }) + '\n');
  const pricing = { currency: 'CNY', input: 2, output: 8 };
  const session = new AgentSession({ agent: 'byok', cwd, onUpdate: (u) => updates.push(u),
    harness: { home: mkdtempSync(join(tmpdir(), 'of-pi-home-')), models: [own('fixture', svc.url, { levels: ['low', 'max'], effort: 'max', maxOutputTokens: 32000, pricing })],
      model: 'fixture', env: { DAOCUT_BYOK_KEY_fixture: 'synthetic-local-only' } },
  });
  try {
    await session.start();
    const prompt = 'Product A 00:05.120 to 00:21.450; keep subtitles; no music. ' + 'Previously approved editing context. '.repeat(2600);
    assert.equal(await session.prompt([{ type: 'text', text: prompt }], { turnId: 'local:compaction' }), 'end_turn');
    const contexts = updates.filter((u) => u.sessionUpdate === 'usage_update' || u._meta?.['daocut/contextUsage'] === null);
    assert.ok(contexts.some((u) => u._meta?.['daocut/contextUsage'] === null), 'native post-compaction unknown is forwarded');
    assert.ok(contexts.filter((u) => u._meta?.['daocut/contextUsage'] === null).every((u) => u._meta['daocut/contextBreakdown'] === undefined), 'unknown compaction snapshots never carry stale categories');
    const afterCompaction = contexts.at(-1);
    assert.equal(afterCompaction.sessionUpdate, 'usage_update');
    assert.equal(afterCompaction.used, 2, 'new response supplies the reduced context; summary billing is excluded');
    assert.equal(afterCompaction._meta?.['daocut/contextBreakdown']?.source, 'local-estimate', 'details return with the next valid native snapshot');
    assert.equal(svc.bodies.length, 4);
    assert.deepEqual(svc.bodies.map((b) => b.reasoning_effort), ['max', 'low', 'low', 'max']);
    const cap = (b) => b.max_completion_tokens ?? b.max_tokens;
    assert.deepEqual(svc.bodies.slice(1, 3).map(cap), [8192, 16384]);
    assert.deepEqual(svc.bodies[1].messages, svc.bodies[2].messages, 'retry preserves the complete native summary request');
    assert.equal(JSON.stringify(svc.bodies.slice(1, 3)).includes('DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN'), false, 'source archive is not injected into native summary requests');
    assert.equal(JSON.stringify(updates).includes('INCOMPLETE SUMMARY'), false, 'partial summary never reaches the chat');
    const modelLog = join(logs, 'local-compaction.model.jsonl');
    let calls = [];
    for (let i = 0; i < 100 && calls.length < 4; i += 1) {
      if (existsSync(modelLog)) calls = readFileSync(modelLog, 'utf8').split('\n').flatMap((line) => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } }).filter((e) => e.kind === 'call');
      if (calls.length < 4) await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(calls.length, 4, 'every ordinary and summary attempt uses the existing call log');
    assert.deepEqual(calls.slice(1, 3).map((c) => c.answer.usage.output), [8192, 80]);
    assert.ok(calls.every((c) => JSON.stringify(c.pricing) === JSON.stringify(pricing)));
    assert.equal(JSON.stringify(calls).includes('synthetic-local-only'), false);
    const folder = join(cwd, '.film', 'chat', 'agent');
    const entries = readdirSync(folder).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(folder, f), 'utf8').trim().split('\n').map(JSON.parse));
    assert.ok(entries.some((e) => e.type === 'message' && e.message.role === 'user' && JSON.stringify(e.message).includes(prompt)));
    const checkpoints = entries.filter((e) => e.type === 'compaction');
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].summary.includes('INCOMPLETE SUMMARY'), false);
    assert.match(checkpoints[0].summary, /00:05.120 to 00:21.450/);
  } finally { session.close(); svc.close(); }
});


test('native context snapshots use the current request, switch windows, resume and isolate sessions', { timeout: 60000 }, async () => {
  const svc = await service({ reply: (_, n) => ({ usage: { prompt_tokens: n === 1 ? 24000 : 32000, completion_tokens: 500, total_tokens: n === 1 ? 24500 : 32500 } }) });
  const cwd = mkdtempSync(join(tmpdir(), 'daocut-context-'));
  const harness = { home: mkdtempSync(join(tmpdir(), 'daocut-context-home-')), models: [own('a', svc.url, { context: 128000 }), own('b', svc.url, { context: 256000 })], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'synthetic', DAOCUT_BYOK_KEY_b: 'synthetic' } };
  const updates = [];
  const session = new AgentSession({ agent: 'byok', cwd, harness, onUpdate: (u) => updates.push(u) });
  let resumed, fresh;
  const latest = (list) => list.filter((u) => u.sessionUpdate === 'usage_update').at(-1);
  const settled = async () => new Promise((done) => setTimeout(done, 40));
  try {
    const info = await session.start();
    await session.prompt([{ type: 'text', text: 'First synthetic request' }]);
    await settled();
    const first = latest(updates);
    assert.deepEqual({ used: first.used, size: first.size }, { used: 24500, size: 128000 });
    const breakdown = (u) => u._meta?.['daocut/contextBreakdown'];
    assert.equal(breakdown(first)?.source, 'local-estimate');
    assert.ok(breakdown(first).system > 0 && breakdown(first).tools > 0 && breakdown(first).messages > 0);
    assert.deepEqual(Object.keys(breakdown(first)).sort(), ['messages', 'source', 'system', 'tools'], 'only numeric categories and their source leave the harness');
    await session.prompt([{ type: 'text', text: 'Second synthetic request' }]);
    await settled();
    assert.equal(latest(updates).used, 32500, 'current context, not 57000 billed tokens');
    assert.ok(breakdown(latest(updates)).messages > breakdown(first).messages, 'new projected message content is reflected');
    await session.setConfigOption('model', 'b');
    await settled();
    assert.equal(latest(updates).size, 256000, 'native model window changes without another request');
    assert.equal(latest(updates).used, 32500);
    session.close();
    const resumedUpdates = [];
    resumed = new AgentSession({ agent: 'byok', cwd, harness, resume: info.sessionId, onUpdate: (u) => resumedUpdates.push(u) });
    const resumedInfo = await resumed.start();
    await settled();
    assert.equal(resumedInfo.configOptions.find((o) => o.id === 'model').currentValue, 'a', 'resume uses the configured starting model');
    assert.deepEqual({ used: latest(resumedUpdates).used, size: latest(resumedUpdates).size }, { used: 32500, size: 128000 }, 'resumed context uses its actual model window');
    assert.deepEqual(breakdown(latest(resumedUpdates)), breakdown(latest(updates)), 'resumed projected categories match the same session');
    const freshUpdates = [];
    fresh = new AgentSession({ agent: 'byok', cwd, harness, onUpdate: (u) => freshUpdates.push(u) });
    await fresh.start();
    await settled();
    assert.notEqual(latest(freshUpdates)?.used, 32500, 'a new conversation cannot inherit prior context');
    assert.equal(breakdown(latest(freshUpdates)), undefined, 'new conversation has no request breakdown to inherit');
  } finally { session.close(); resumed?.close(); fresh?.close(); svc.close(); }
});


test('running IPC restores the current model together with native context after a model switch', { timeout: 60000 }, async () => {
  const { registerLocalAgentIpc } = await import('./local-agents-ipc.mjs');
  const svc = await service();
  const handlers = new Map();
  const ipc = registerLocalAgentIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { trusted: () => true,
    harness: async () => ({ home: mkdtempSync(join(tmpdir(), 'daocut-context-ipc-home-')), models: [own('a', svc.url), own('b', svc.url, { context: 256000 })], model: 'a', env: { DAOCUT_BYOK_KEY_a: 'synthetic', DAOCUT_BYOK_KEY_b: 'synthetic' } }),
  });
  const event = { sender: { once() {}, isDestroyed: () => false, send() {} } };
  const call = (name, args = {}) => handlers.get('desktop:local-agents:' + name)(event, args);
  try {
    const started = await call('start', { agent: 'byok', cwd: mkdtempSync(join(tmpdir(), 'daocut-context-ipc-')) });
    assert.equal(started.ok, true);
    assert.equal((await call('set-option', { key: started.key, configId: 'model', value: 'b' })).ok, true);
    const meta = { turnId: 'local:context-ipc', projectId: 'p', sessionId: 'c' };
    assert.equal((await call('prompt', { key: started.key, text: 'Synthetic fixture', meta })).ok, true);
    const held = (await call('running'))[0];
    assert.equal(held.info.configOptions.find((o) => o.id === 'model').currentValue, 'b');
    assert.deepEqual(held.info.authMethods, []);
    assert.equal(held.events.filter((e) => e.update?.sessionUpdate === 'usage_update').at(-1).update.size, 256000);
  } finally { ipc.closeAll(); svc.close(); }
});


test('company quota ACP reserves before the model, settles actual receipts, then blocks without losing prior history', { timeout: 60000 }, async () => {
  const { mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs');
  const svc = await service(), held = [], settled = [];
  const cwd = mkdtempSync(join(tmpdir(), 'quota-acp-'));
  const logs = join(cwd, '.film', 'logs'); mkdirSync(logs, { recursive: true });
  for (const turn of ['accepted', 'blocked']) writeFileSync(join(logs, `local-${turn}.jsonl`), JSON.stringify({ kind: 'prompt', agent: 'byok', t: Date.now() }) + '\n');
  const identity = { userId: 'employee', serverUrl: 'https://company.synthetic', epoch: 1 };
  const quota = { capture: () => identity, reserve: async (input, owner) => {
    assert.equal(owner, identity); assert.equal(svc.bodies.length, held.length);
    if (held.length) throw new Error('今日 Token 额度不足，请联系管理员');
    held.push(input); return { id: input.id, status: 'reserved' };
  }, settle: async ({ event }, owner) => { assert.equal(owner, identity); settled.push(event); return { settled: true }; } };
  const session = new AgentSession({ agent: 'byok', cwd, quota,
    harness: { home: mkdtempSync(join(tmpdir(), 'quota-home-')), models: [own('fixture', svc.url)], model: 'fixture', env: { DAOCUT_BYOK_KEY_fixture: 'synthetic-only' } } });
  try {
    await session.start();
    assert.equal(await session.prompt([{ type: 'text', text: 'Explain the synthetic project.' }], { turnId: 'local:accepted' }), 'end_turn');
    assert.equal(held.length, 1); assert.equal(settled.length, 1); assert.equal(settled[0].id, held[0].id); assert.equal(settled[0].total, 2);
    await assert.rejects(session.prompt([{ type: 'text', text: 'Explain another part.' }], { turnId: 'local:blocked' }), /额度不足/);
    assert.equal(svc.bodies.length, 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    const calls = readFileSync(join(logs, 'local-accepted.model.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.kind === 'call');
    assert.equal(calls[0].quotaRequestId, held[0].id);
    assert.doesNotMatch(JSON.stringify(calls), /synthetic-only/);
    const directory = join(cwd, '.film', 'chat', 'agent');
    const saved = readdirSync(directory).filter(x => x.endsWith('.jsonl')).map(f => readFileSync(join(directory, f), 'utf8')).join('\n');
    assert.match(saved, /Explain the synthetic project/); assert.match(saved, /"text":"ok"/);
  } finally { session.close(); svc.close(); }
});

test('company quota covers SDK transient retries with separate IDs and preserves uncertain reservations', { timeout: 60000 }, async () => {
  const svc = await service({ busyOnce: true }), held = [], settled = [];
  const quota = { capture: () => ({ userId: 'synthetic', epoch: 1 }), reserve: async input => { held.push(input); return { id: input.id, status: 'reserved' }; }, settle: async ({ event }) => { settled.push(event); return {}; } };
  const session = new AgentSession({ agent: 'byok', cwd: mkdtempSync(join(tmpdir(), 'quota-retry-')), quota,
    harness: { home: mkdtempSync(join(tmpdir(), 'quota-retry-home-')), models: [own('fixture', svc.url)], model: 'fixture', env: { DAOCUT_BYOK_KEY_fixture: 'synthetic-only' } } });
  try {
    await session.start(); await session.prompt([{ type: 'text', text: 'Explain this synthetic project.' }]);
    assert.equal(svc.bodies.length, 2); assert.equal(held.length, 2); assert.notEqual(held[0].id, held[1].id);
    assert.deepEqual(settled.map(event => event.id), [held[1].id]);
  } finally { session.close(); svc.close(); }
});


test('company quota overlapping prompt cannot change the running request employee', { timeout: 60000 }, async () => {
  const svc = await service(), owners = [];
  let owner = { userId: 'A', epoch: 1 }, release, reserved;
  const entered = new Promise(resolve => { reserved = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const quota = { capture: () => owner, reserve: async (input, identity) => { owners.push(identity.userId); reserved(); await gate; return { id: input.id, status: 'reserved' }; }, settle: async (_input, identity) => { owners.push(identity.userId); return {}; } };
  const session = new AgentSession({ agent: 'byok', cwd: mkdtempSync(join(tmpdir(), 'quota-overlap-')), quota,
    harness: { home: mkdtempSync(join(tmpdir(), 'quota-overlap-home-')), models: [own('fixture', svc.url)], model: 'fixture', env: { DAOCUT_BYOK_KEY_fixture: 'synthetic-only' } } });
  try {
    await session.start();
    const first = session.prompt([{ type: 'text', text: 'Explain the project.' }]);
    await entered; owner = { userId: 'B', epoch: 2 };
    await assert.rejects(session.prompt([{ type: 'text', text: 'Second concurrent task.' }]), /当前任务完成/);
    release(); await first;
    assert.deepEqual(owners, ['A', 'A']); assert.equal(svc.bodies.length, 1);
  } finally { release(); session.close(); svc.close(); }
});
