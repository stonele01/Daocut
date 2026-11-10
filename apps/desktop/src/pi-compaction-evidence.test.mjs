import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readLogImage, saveLogImage } from 'daocut/log-images';
import { EVIDENCE_FOOTER_START, EVIDENCE_FOOTER_END, prepareCompactionEvidence, stripEvidenceFooter } from './pi-compaction-evidence.mjs';

const testRoot = fileURLToPath(new URL('../../../.release/tests/compaction-evidence/', import.meta.url));
mkdirSync(testRoot, { recursive: true });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const slash = (value) => value.replace(/\\/g, '/');
const user = (content) => ({ role: 'user', content, timestamp: 1 });
const assistant = (content) => ({
  role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
  api: 'openai-completions', provider: 'synthetic', model: 'synthetic', stopReason: 'stop', timestamp: 2,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function fixture() {
  const project = mkdtempSync(join(testRoot, '项目 with spaces-'));
  const manager = SessionManager.create(project, join(project, '.film', 'chat', 'agent'));
  return { project, manager, directory: join(project, '.film', 'chat', 'context', manager.getSessionId()) };
}
function files(directory, prefix) { return readdirSync(directory).filter((file) => file.startsWith(prefix)).map((file) => join(directory, file)); }
function records(directory) {
  return files(directory, 'entry-').map((file) => {
    const text = readFileSync(file, 'utf8');
    const start = text.indexOf('\n{') + 1;
    return { file, text, entry: JSON.parse(text.slice(start, text.lastIndexOf('\n' + String.fromCharCode(96).repeat(3)))) };
  });
}

test('real SDK branch archives full long tool results, parameters and details without changing session or source files', () => {
  const f = fixture();
  const asset = join(f.project, '素材 sample.txt');
  writeFileSync(asset, 'Synthetic asset remains unchanged.');
  const longResult = 'ASR complete text\n'.repeat(350) + '关键条件在 2000 字符之后：保留 00:05.120–00:21.450，不能删掉退换说明。';
  const request = '使用 素材 sample.txt；先剪好放到时间轴，不导出。';
  f.manager.appendMessage(user(request));
  f.manager.appendMessage(assistant([
    { type: 'thinking', thinking: 'private internal trace must not be archived' },
    { type: 'toolCall', id: 'asr-1', name: 'bash', arguments: { command: 'daocut transcribe "素材 sample.txt"', timeout: 120 } },
  ]));
  f.manager.appendMessage({ role: 'toolResult', toolCallId: 'asr-1', toolName: 'bash', content: [{ type: 'text', text: longResult }], details: { fullOutputPath: 'D:/synthetic output/full asr.txt', exitCode: 0 }, isError: false, timestamp: 3 });
  f.manager.appendMessage(assistant('Read complete ASR; edit not yet started.'));
  const originalFile = readFileSync(f.manager.getSessionFile());
  const originalEntries = structuredClone(f.manager.getEntries());
  const result = prepareCompactionEvidence(f.manager, f.project);
  const archived = records(f.directory);
  assert.equal(archived.length, 4);
  const tool = archived.find(({ entry }) => entry.message.role === 'toolResult').entry.message;
  assert.equal(tool.content[0].text, longResult);
  assert.equal(tool.details.fullOutputPath, 'D:/synthetic output/full asr.txt');
  const call = archived.find(({ entry }) => entry.message.content?.some?.((block) => block.type === 'toolCall')).entry.message;
  assert.deepEqual(call.content, [{ type: 'toolCall', id: 'asr-1', name: 'bash', arguments: { command: 'daocut transcribe "素材 sample.txt"', timeout: 120 } }]);
  const index = readFileSync(files(f.directory, 'index-')[0], 'utf8');
  const entryIds = originalEntries.filter((entry) => entry.type === 'message').map((entry) => entry.id);
  for (let n = 0; n < entryIds.length; n++) {
    assert.ok(index.includes((n + 1) + '. Entry ' + entryIds[n]));
    if (n) assert.ok(index.indexOf(entryIds[n]) > index.indexOf(entryIds[n - 1]));
  }
  for (const { file } of archived) assert.ok(index.includes(slash(file)));
  assert.match(index, /toolResult · bash · asr-1/);
  assert.ok(result.footer.includes(request));
  assert.ok(result.footer.includes(slash(f.manager.getSessionFile())));
  assert.deepEqual(Object.keys(result), ['footer'], 'only mechanical retained evidence is returned, no new summary instruction');
  assert.equal(archived.some(({ text }) => text.includes('private internal trace')), false);
  assert.deepEqual(f.manager.getEntries(), originalEntries);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), originalFile);
  assert.equal(readFileSync(asset, 'utf8'), 'Synthetic asset remains unchanged.');
});

test('user and tool images are readable local references with original bytes and no inline duplicate', () => {
  const f = fixture();
  f.manager.appendMessage(user([{ type: 'text', text: '按图中位置留白。' }, { type: 'image', data: png, mimeType: 'image/png' }]));
  f.manager.appendMessage({ role: 'toolResult', toolCallId: 'look-1', toolName: 'look', content: [{ type: 'image', data: png, mimeType: 'image/png' }], details: { imagePosition: '00:21.450' }, timestamp: 2 });
  const before = readFileSync(f.manager.getSessionFile());
  const result = prepareCompactionEvidence(f.manager, f.project);
  const archived = records(f.directory);
  for (const { entry, text } of archived) {
    const block = entry.message.content.find((part) => part.type === 'image');
    assert.equal(block.data, undefined);
    assert.deepEqual(readLogImage(f.project, block.file).data, Buffer.from(png, 'base64'));
    assert.equal(text.includes(png), false);
  }
  const userImage = archived.find(({ entry }) => entry.message.role === 'user').entry.message.content[1];
  assert.ok(result.footer.includes(slash(join(f.project, userImage.file))));
  assert.equal(result.footer.includes(png), false);
  assert.equal(readdirSync(join(f.project, '.film', 'logs', 'images')).length, 1);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), before);
});

test('existing valid image references are reused and invalid references fail rather than omit evidence', () => {
  const f = fixture();
  const imageFile = saveLogImage(f.project, png, 'image/png');
  f.manager.appendMessage(user([{ type: 'image', file: imageFile, mimeType: 'image/png' }]));
  const result = prepareCompactionEvidence(f.manager, f.project);
  assert.ok(result.footer.includes(imageFile));
  const bad = fixture();
  bad.manager.appendMessage(user([{ type: 'image', file: imageFile, mimeType: 'image/png' }]));
  assert.throws(() => prepareCompactionEvidence(bad.manager, bad.project), /Could not preserve an image/);
  assert.equal(files(bad.directory, 'index-').length, 0);
});

test('repeated preparation reuses immutable entries and indexes; new branch content creates a new index', () => {
  const f = fixture();
  f.manager.appendMessage(user('先按参考片做。'));
  f.manager.appendMessage(assistant('Project inspected.'));
  const first = prepareCompactionEvidence(f.manager, f.project);
  const snapshot = readdirSync(f.directory).map((name) => ({ name, text: readFileSync(join(f.directory, name), 'utf8'), mtime: statSync(join(f.directory, name)).mtimeMs }));
  const second = prepareCompactionEvidence(f.manager, f.project);
  assert.deepEqual(second, first);
  assert.equal(readdirSync(f.directory).length, snapshot.length);
  for (const saved of snapshot) {
    assert.equal(readFileSync(join(f.directory, saved.name), 'utf8'), saved.text);
    assert.equal(statSync(join(f.directory, saved.name)).mtimeMs, saved.mtime);
  }
  f.manager.appendMessage(user('改成不加音乐。'));
  prepareCompactionEvidence(f.manager, f.project);
  assert.equal(files(f.directory, 'entry-').length, 3);
  assert.equal(files(f.directory, 'index-').length, 2);
  for (const saved of snapshot) assert.equal(readFileSync(join(f.directory, saved.name), 'utf8'), saved.text);
});

test('all long user requirements and subsequent corrections stay verbatim and in branch order', () => {
  const f = fixture();
  const requirements = [
    '开始需要配乐。' + '完整原话不要截断。'.repeat(400) + '尾部条件：保留面料和退换条件。',
    '刚才配乐取消，换成只保留人声。',
    '最终只剪好放到时间轴，不要导出，也不要删除原素材。',
  ];
  for (const text of requirements) f.manager.appendMessage(user(text));
  const { footer } = prepareCompactionEvidence(f.manager, f.project);
  requirements.forEach((text, n) => {
    assert.ok(footer.includes(text));
    if (n) assert.ok(footer.indexOf(text) > footer.indexOf(requirements[n - 1]));
  });
  assert.match(footer, /后续明确纠正或取消会替代此前对应要求/);
  assert.match(footer, /不是新增任务/);
});

test('only the current branch is indexed, while source file keeps other branches', () => {
  const f = fixture();
  const firstId = f.manager.appendMessage(user('公共起点。'));
  f.manager.appendMessage(user('其他分支的要求不应进入当前摘要。'));
  f.manager.branch(firstId);
  f.manager.appendMessage(user('当前分支的要求。'));
  const before = readFileSync(f.manager.getSessionFile());
  const result = prepareCompactionEvidence(f.manager, f.project);
  assert.ok(result.footer.includes('公共起点。'));
  assert.ok(result.footer.includes('当前分支的要求。'));
  assert.equal(result.footer.includes('其他分支的要求'), false);
  assert.equal(records(f.directory).length, 2);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), before);
});

test('footer stripping preserves surrounding native metadata and handles multiple blocks without crossing', () => {
  const f = fixture();
  f.manager.appendMessage(user('历史原话\n' + EVIDENCE_FOOTER_START + '\n不是机器生成的完整块\n' + EVIDENCE_FOOTER_END));
  const one = prepareCompactionEvidence(f.manager, f.project).footer;
  f.manager.appendMessage(user('后续修改。'));
  const two = prepareCompactionEvidence(f.manager, f.project).footer;
  const prefix = '<previous-summary>\nExisting checkpoint\n';
  const native = '\n<read-files>film.html</read-files>\n<modified-files>title.html</modified-files>\n## Turn Context\nNative prefix summary.';
  assert.equal(stripEvidenceFooter(prefix + one + native + '\n</previous-summary>'), prefix + native + '\n</previous-summary>');
  assert.equal(stripEvidenceFooter('A' + one + 'B' + two + 'C'), 'ABC');
  assert.equal(stripEvidenceFooter(one + two), '');
  const incomplete = EVIDENCE_FOOTER_START + '\nlength: 12\nsha256: ' + '0'.repeat(64) + '\ntruncated';
  assert.equal(stripEvidenceFooter(incomplete + ' unchanged'), incomplete + ' unchanged');
  const tampered = one.replace('历史原话', '改写原话');
  assert.equal(stripEvidenceFooter(tampered), tampered);
});

test('archive write failure throws before returning any footer or modifying source session', () => {
  const f = fixture();
  f.manager.appendMessage(user('不能丢失这个要求。'));
  const before = readFileSync(f.manager.getSessionFile());
  writeFileSync(join(f.project, '.film', 'chat', 'context'), 'blocked by an existing file');
  let result;
  assert.throws(() => { result = prepareCompactionEvidence(f.manager, f.project); });
  assert.equal(result, undefined);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), before);
});

test('image write failure prevents a partial footer and index', () => {
  const f = fixture();
  f.manager.appendMessage(user('This text may be archived before the failure.'));
  f.manager.appendMessage(user([{ type: 'image', data: png, mimeType: 'image/png' }]));
  mkdirSync(join(f.project, '.film', 'logs'), { recursive: true });
  writeFileSync(join(f.project, '.film', 'logs', 'images'), 'blocked');
  const before = readFileSync(f.manager.getSessionFile());
  let result;
  assert.throws(() => { result = prepareCompactionEvidence(f.manager, f.project); }, /Could not preserve an image/);
  assert.equal(result, undefined);
  assert.equal(files(f.directory, 'index-').length, 0);
  assert.deepEqual(readFileSync(f.manager.getSessionFile()), before);
});

test('a corrupt existing content-addressed file is never overwritten or returned as evidence', () => {
  const f = fixture();
  f.manager.appendMessage(user('保存完整原话。'));
  prepareCompactionEvidence(f.manager, f.project);
  const archived = files(f.directory, 'entry-')[0];
  writeFileSync(archived, 'unexpected damaged archive');
  assert.throws(() => prepareCompactionEvidence(f.manager, f.project), /differs from its content-addressed file/);
  assert.equal(readFileSync(archived, 'utf8'), 'unexpected damaged archive');
});
