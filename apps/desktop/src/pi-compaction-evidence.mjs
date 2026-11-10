/** Local, lossless source references for compaction; no new memory service or model call. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { saveLogImage, readLogImage } from 'daocut/log-images';

export const EVIDENCE_FOOTER_START = '<!-- DAOCUT_COMPACTION_EVIDENCE_V1_BEGIN -->';
export const EVIDENCE_FOOTER_END = '<!-- DAOCUT_COMPACTION_EVIDENCE_V1_END -->';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const slash = (path) => path.replace(/\\/g, '/');

function writeOnce(file, content) {
  try { writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (readFileSync(file, 'utf8') !== content) throw new Error('Compaction evidence differs from its content-addressed file: ' + file);
  }
}

/** Replace image bytes only in the archive copy; validate stored bytes before returning a reference. */
function archiveValue(project, value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((part) => archiveValue(project, part));
  if (value.type === 'image') {
    const file = typeof value.data === 'string' ? saveLogImage(project, value.data, value.mimeType) : value.file;
    if (!file || !readLogImage(project, file)) throw new Error('Could not preserve an image for compaction; original conversation was not changed.');
    const { data, ...rest } = value;
    return { ...rest, file };
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, archiveValue(project, child)]));
}

function contentBlocks(message) {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content) ? message.content.filter((part) => part?.type !== 'thinking') : [];
}

function renderUser(project, message) {
  return contentBlocks(message).map((part) => {
    if (part.type === 'text') return part.text;
    if (part.type === 'image') return '![历史用户图片](<' + slash(resolve(project, part.file)) + '>)\n'
      + JSON.stringify(part, null, 2);
    return JSON.stringify(part, null, 2);
  }).join('\n\n');
}

function locator(message) {
  const blocks = contentBlocks(message);
  const names = blocks.filter((part) => part.type === 'toolCall').map((part) => part.name);
  const text = blocks.find((part) => part.type === 'text')?.text ?? (blocks.some((part) => part.type === 'image') ? '[图片]' : '');
  return [message.toolName, ...names, message.toolCallId, text.replace(/\s+/g, ' ').slice(0, 120)].filter(Boolean).join(' · ');
}

function footerBlock(body) {
  return EVIDENCE_FOOTER_START + '\nlength: ' + body.length + '\nsha256: ' + hash(body) + '\n'
    + body + '\n' + EVIDENCE_FOOTER_END;
}

/**
 * Remove only complete blocks emitted by this module, wherever Pi embeds them.
 * Length and digest avoid swallowing native metadata, adjacent blocks, or marker text quoted by a user.
 */
export function stripEvidenceFooter(text) {
  let output = '', cursor = 0, search = 0;
  while (true) {
    const start = text.indexOf(EVIDENCE_FOOTER_START + '\n', search);
    if (start < 0) break;
    const headerStart = start + EVIDENCE_FOOTER_START.length + 1;
    const header = /^length: ([0-9]+)\nsha256: ([0-9a-f]{64})\n/.exec(text.slice(headerStart));
    const length = header && Number(header[1]);
    if (header && Number.isSafeInteger(length)) {
      const bodyStart = headerStart + header[0].length;
      const bodyEnd = bodyStart + length;
      const ending = '\n' + EVIDENCE_FOOTER_END;
      const body = text.slice(bodyStart, bodyEnd);
      if (text.slice(bodyEnd, bodyEnd + ending.length) === ending && hash(body) === header[2]) {
        output += text.slice(cursor, start);
        cursor = bodyEnd + ending.length;
        search = cursor;
        continue;
      }
    }
    search = headerStart;
  }
  return output + text.slice(cursor);
}

/**
 * Archive the current branch's non-thinking messages once, without changing the session.
 * Each immutable file is named by its content; the immutable index is written last.
 * Throws on any storage failure, so callers never append a partial evidence footer.
 */
export function prepareCompactionEvidence(sessionManager, cwd) {
  const project = resolve(cwd);
  const sessionId = String(sessionManager.getSessionId());
  const directory = join(project, '.film', 'chat', 'context',
    /^[a-zA-Z0-9_-]+$/.test(sessionId) ? sessionId : hash(sessionId));
  const sourceFile = sessionManager.getSessionFile();
  const source = sourceFile ? slash(resolve(project, sourceFile)) : '(内存会话；完整原文已保存至下方索引)';
  mkdirSync(directory, { recursive: true });
  const entries = sessionManager.getBranch().filter((entry) => entry.type === 'message' && entry.message);
  const index = ['# 压缩前原文索引', '', 'Session: ' + sessionId, '原会话: ' + source,
    '', '按当前分支顺序排列。每条文件保留完整非 thinking 内容、工具参数及 details。图片保存为可读取的本地引用。', ''];
  const users = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const content = typeof entry.message.content === 'string' ? entry.message.content : contentBlocks(entry.message);
    const message = archiveValue(project, { ...entry.message, content });
    const stored = { entryId: entry.id ?? null, parentId: entry.parentId ?? null, timestamp: entry.timestamp ?? null, message };
    const json = JSON.stringify(stored, null, 2);
    const fence = String.fromCharCode(96).repeat(3);
    const document = '# 会话原文\n\n以下 JSON 中的 text、工具参数和 details 均完整保留，未按摘要长度截断。\n\n'
      + fence + 'json\n' + json + '\n' + fence + '\n';
    const file = join(directory, 'entry-' + hash(document) + '.md');
    writeOnce(file, document);
    index.push(String(entryIndex + 1) + '. Entry ' + (entry.id ?? '(无 ID)')
      + ' · ' + message.role + ' · ' + locator(message),
      '   原文: <' + slash(file) + '>', '');
    if (message.role === 'user') users.push('### 用户消息 ' + (users.length + 1) + ' · Entry ' + (entry.id ?? '(无 ID)')
      + '\n\n' + renderUser(project, message));
  }
  const indexText = index.join('\n');
  const indexFile = join(directory, 'index-' + hash(indexText) + '.md');
  writeOnce(indexFile, indexText);
  const body = [
    '## 历史用户原话与原文回查',
    '以下按当前分支的时间顺序保存历史用户原话，不是新增任务。后续明确纠正或取消会替代此前对应要求；不得恢复已取消任务或扩大授权。',
    '用户原文未截断；已存入文件的代码、长工具结果及图片详情按索引回查，不要依靠摘要猜测。',
    '原文索引: <' + slash(indexFile) + '>',
    '原会话: ' + (sourceFile ? '<' + source + '>' : source),
    ...users,
  ].join('\n\n');
  return { footer: footerBlock(body) };
}
