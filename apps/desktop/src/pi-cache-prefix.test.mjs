import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentSession } from './agents.mjs';

const root = fileURLToPath(new URL('../.release/cache-prefix/', import.meta.url));
const require = createRequire(import.meta.url);
const undiciUrl = pathToFileURL(require.resolve('undici')).href;
const prompt = [{ type: 'text', text: '读取 film.html 并说明其中的标题，不修改文件。' }];
const items = request => request.input ?? request.messages;
const serialized = value => JSON.stringify(value);

function chatReply(model, n, call) {
  const chunk = (delta, finish_reason = null, extra = {}) => 'data: ' + JSON.stringify({
    id: 'chat_' + n, object: 'chat.completion.chunk', created: 0, model,
    choices: [{ index: 0, delta, finish_reason }], ...extra,
  }) + '\n\n';
  const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + n,
    type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'film.html' }) } }] }
    : { role: 'assistant', content: '标题是 Cache fixture。' };
  return chunk(delta) + chunk({}, call ? 'tool_calls' : 'stop', {
    usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108, prompt_cache_hit_tokens: 64 },
  }) + 'data: [DONE]\n\n';
}

function responsesReply(model, n, call) {
  let sequence = 0;
  const event = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: sequence++, ...data }) + '\n\n';
  const response = { id: 'resp_' + n, object: 'response', created_at: 0, status: 'in_progress', model, output: [] };
  const item = call ? { type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n,
    name: 'read', arguments: JSON.stringify({ path: 'film.html' }), status: 'completed' }
    : { type: 'message', id: 'msg_' + n, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '标题是 Cache fixture。', annotations: [] }] };
  let wire = event('response.created', { response }) + event('response.output_item.added', {
    output_index: 0, item: { ...item, status: 'in_progress', ...(call ? { arguments: '' } : { content: [] }) },
  });
  wire += call ? event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments })
    + event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments })
    : event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
  return wire + event('response.output_item.done', { output_index: 0, item })
    + event('response.completed', { response: { ...response, status: 'completed', output: [item],
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 }, output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 108 } } });
}

async function fixture(api, { linkedSkill = false } = {}) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'case-'));
  const paths = Object.fromEntries(['project', 'home', 'prefs', 'mine', 'data', 'tmp'].map(name => [name, join(dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  writeFileSync(join(paths.project, 'film.html'), '<!doctype html><title>Cache fixture</title>');
  writeFileSync(join(paths.project, 'AGENTS.md'), 'Synthetic project rule: inspect the title before answering.');
  writeFileSync(join(paths.prefs, 'prefs.json'), '{}');
  for (const name of ['z-fixture', 'a-fixture']) {
    const folder = join(paths.mine, name);
    mkdirSync(folder);
    const text = '---\nname: ' + name + '\ndescription: Synthetic title inspection instructions.\n---\n\nRead references/note.txt beside this skill.';
    if (linkedSkill && name === 'z-fixture') {
      const shared = join(dir, 'shared-skill.md');
      writeFileSync(shared, text);
      symlinkSync(shared, join(folder, 'SKILL.md'), 'file');
    } else writeFileSync(join(folder, 'SKILL.md'), text);
    mkdirSync(join(folder, 'references'));
    writeFileSync(join(folder, 'references', 'note.txt'), 'Resource belongs to ' + name);
  }
  const projectSkill = join(paths.project, 'skills', 'a-fixture');
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(join(projectSkill, 'SKILL.md'), '---\nname: a-fixture\ndescription: Project skill wins over the same name in mine.\n---\n\nRead film.html.');
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const request = JSON.parse(body);
      requests.push(request);
      if (requests.length > 8) { res.writeHead(400); res.end('fixture request limit'); return; }
      const call = requests.length % 2 === 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(api === 'openai-responses' ? responsesReply(request.model, requests.length, call)
        : chatReply(request.model, requests.length, call));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const localOrigin = 'http://127.0.0.1:' + server.address().port;
  const preload = join(dir, 'loopback-only.mjs');
  writeFileSync(preload, 'import { Agent } from ' + JSON.stringify(undiciUrl) + ';\n'
    + 'const original = Agent.prototype.dispatch;\nAgent.prototype.dispatch = function (options, handler) {\n'
    + '  if (new URL(options.origin).origin !== "https://api.deepseek.com") throw new Error("Network disabled by test fixture");\n'
    + '  return original.call(this, { ...options, origin: ' + JSON.stringify(localOrigin) + ' }, handler);\n};\n');
  const sessions = [];
  const create = resume => {
    const session = new AgentSession({ agent: 'byok', cwd: paths.project, ...(resume ? { resume } : {}),
      skills: { dataDir: paths.data, mine: paths.mine, home: paths.home, prefsHome: paths.prefs },
      harness: { home: paths.home, models: [{ id: 'cache-fixture', name: 'Synthetic cache fixture', api,
        baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DAOCUT_CACHE_TEST_KEY', model: 'deepseek-flash',
        levels: ['auto', 'max'], effort: 'max' }], model: 'cache-fixture',
        env: { DAOCUT_CACHE_TEST_KEY: 'sk-synthetic-no-provider-access',
          NODE_OPTIONS: '--import=' + pathToFileURL(preload).href, TEMP: paths.tmp, TMP: paths.tmp } },
    });
    sessions.push(session);
    return session;
  };
  return { requests, create, paths, close() {
    for (const session of sessions) session.close();
    server.closeAllConnections(); server.close();
  } };
}

// Real ACP child + installed Pi + actual provider serialization; the dispatcher above only permits loopback delivery.
// These tests establish prefix equality, not a measured cache hit at DeepSeek.
for (const api of ['openai-completions', 'openai-responses']) {
  test(api + ': stable system, tools and history prefixes across tool calls, turns and session reopening', { timeout: 60000 }, async () => {
    const f = await fixture(api);
    try {
      const first = f.create();
      const info = await first.start();
      await first.prompt(prompt);
      assert.equal(f.requests.length, 2);
      const system = items(f.requests[0])[0].content;
      assert.deepEqual([...system.matchAll(/<name>([^<]+)<\/name>/g)].map(match => match[1]), ['a-fixture', 'z-fixture']);
      assert.ok(system.includes('Project skill wins over the same name in mine.'), 'canonicalizing and sorting retain the selected same-name skill');
      await first.prompt([{ type: 'text', text: '再读取一次相同文件并复核标题。' }]);
      assert.equal(f.requests.length, 4);
      for (let i = 1; i < 4; i++) {
        assert.ok(serialized(items(f.requests[i]).slice(0, items(f.requests[i - 1]).length)) === serialized(items(f.requests[i - 1])),
          'ordinary tool and user turns append to the previous serialized message prefix');
      }
      first.close();
      const fresh = f.create();
      await fresh.start();
      await fresh.prompt(prompt);
      assert.equal(f.requests.length, 6);
      assert.ok(serialized(items(f.requests[4])) === serialized(items(f.requests[0])),
        'reopening with the same project and skills must not inject a random skill staging path');
      fresh.close();
      const resumed = f.create(info.sessionId);
      await resumed.start();
      await resumed.prompt([{ type: 'text', text: '继续读取相同文件复核标题。' }]);
      assert.equal(f.requests.length, 8);
      assert.ok(serialized(items(f.requests[6]).slice(0, items(f.requests[3]).length)) === serialized(items(f.requests[3])),
        'resuming the original session preserves the existing serialized message prefix');
      for (const request of f.requests) {
        assert.equal(serialized(request.tools), serialized(f.requests[0].tools), 'tool declarations and order stay byte-identical');
        assert.equal(items(request)[0].role, 'system');
        assert.equal(serialized(items(request)[0]), serialized(items(f.requests[0])[0]), 'stable leading system message');
        assert.ok(!serialized(request).includes('"cache_control"'), 'DeepSeek receives no Anthropic cache-control fields');
        assert.ok(!serialized(items(request)).includes('"timestamp":'), 'local message timestamps are not serialized into provider history');
      }
    } finally { f.close(); }
  });
}

test('a symlinked SKILL.md keeps relative resources in its owning skill directory', { timeout: 60000 }, async t => {
  let f;
  try { f = await fixture('openai-responses', { linkedSkill: true }); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('File symlinks require Windows Developer Mode or symlink privilege');
    throw error;
  }
  try {
    const session = f.create();
    await session.start();
    await session.prompt(prompt);
    const system = items(f.requests[0])[0].content;
    const location = /<name>z-fixture<\/name>[\s\S]*?<location>([^<]+)<\/location>/.exec(system)?.[1];
    assert.equal(location, join(f.paths.mine, 'z-fixture', 'SKILL.md'));
    assert.equal(readFileSync(join(dirname(location), 'references', 'note.txt'), 'utf8'), 'Resource belongs to z-fixture');
  } finally { f.close(); }
});