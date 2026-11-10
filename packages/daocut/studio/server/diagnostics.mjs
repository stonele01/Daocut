import { brandEnv } from '../../src/brand-env.mjs';
// @ts-check
/**
 * Settings → Developer's diagnostic file: one zip with everything that says why something went wrong lately, for a
 * person to look at and then attach to an issue. The copied report is short; this is the rest of it:
 *
 *   report.txt          the report the page copies (`daocut doctor`, the browser, the desktop app's agents)
 *   problems.jsonl      the problems of the last KEEP_DAYS days (src/problems.mjs)
 *   logs/…              the last of each log Studio and the desktop app write (DAOCUT_APP_LOGS)
 *   turns/…             the logs of the turns the last agent problems were in. Unless `conversations`, only how they
 *                       went (turnLogForFile): never a word the person or the agent wrote, a tool's title, command,
 *                       input or output, or anything from the person's files
 *   agents/codex.txt    Codex's own warnings and errors around each of its problems, from its log database
 *
 * Everything in it is redacted as problems are (the home folder as ~, no keys, tokens or email addresses).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { readLogImage, referencedLogImages } from '../../src/log-images.mjs';
import { exportsDefault, studioHomeDir } from '../../src/locations.mjs';
import { KEEP_DAYS, problemsFile, recentProblems, redact } from '../../src/problems.mjs';
import { zipFiles } from './zip.mjs';

/** The most of a log that goes in: its end. */
const LOG_TAIL = 1 << 20;
/** How many of the last agent problems bring their turn's log, and how much of each. */
const TURNS_MAX = 5;
const TURN_MAX = 2 << 20;
/** Codex's log around a problem: from this long before it to this long after. */
const CODEX_BEFORE_S = 120;
const CODEX_AFTER_S = 15;

/** A path a problem wrote with the home folder as ~, back to where it is. @param {string} path */
const expand = (path) => (path.startsWith('~') ? join(homedir(), path.slice(1)) : path);

/** The end of a file, from a whole line. @param {string} file @param {number} max */
function tail(file, max) {
  const text = readFileSync(file, 'utf8');
  return text.length > max ? text.slice(text.length - max).replace(/^[^\n]*\n/, '') : text;
}

/* what a turn's log says of how it went, never what was said: kept whole */
const TURN_KINDS = new Set(['start', 'done', 'exit', 'cancel', 'set-option', 'steer-answer', 'permission-answer']);
/* the agent's own updates that say how it goes, not what it says or does */
const STATE_UPDATES = new Set(['notice', 'session_info_update', 'usage_update', 'current_mode_update', 'config_option_update', 'available_commands_update']);
/* asked of the person: that it was, and when, never what */
const ASKED = new Set(['permission', 'question', 'question-answer']);

/**
 * A turn's log as it goes in the file: whole with `conversations`; else only how it went: its start and how it ended,
 * the agent's notices and state, the prompt's agent, model and program without its words, each tool's step as its
 * kind, name, status and exit code (no title, command, input or output), and when it asked the person something.
 * @param {string} text @param {boolean} conversations
 */
export function turnLogForFile(text, conversations) {
  if (conversations) return text;
  return text.split('\n').flatMap((line) => {
    let e;
    try { e = line ? JSON.parse(line) : null; } catch { return []; }
    if (!e || typeof e !== 'object') return [];
    if (TURN_KINDS.has(e.kind)) return [line];
    if (e.kind === 'update' && STATE_UPDATES.has(e.update?.sessionUpdate)) return [line];
    if (e.kind === 'update' && (e.update?.sessionUpdate === 'tool_call' || e.update?.sessionUpdate === 'tool_call_update')) {
      const { sessionUpdate, toolCallId, name, kind, status } = e.update;
      const exitCode = e.update.rawOutput?.exit_code ?? e.update.rawOutput?.exitCode;
      return [JSON.stringify({ t: e.t, kind: 'update', update: { sessionUpdate, toolCallId, name, kind, status, ...(Number.isInteger(exitCode) ? { exitCode } : {}) } })];
    }
    if (ASKED.has(e.kind)) return [JSON.stringify({ t: e.t, kind: e.kind, words: '(left out)' })];
    if (e.kind === 'prompt') {
      const { t, kind, agent, meta, session, opened } = e;
      return [JSON.stringify({ t, kind, agent, model: meta?.model ?? null, agentInfo: session?.agentInfo ?? null,
        program: opened?.program ?? null, adapter: opened?.adapter ?? null, words: '(left out)' })];
    }
    return [];
  }).join('\n');
}

/**
 * Codex's own warnings and errors around these times (each problem's), from its log database (logs_*.sqlite in its
 * home), as text; null when there is none to read (no Codex, a Node without node:sqlite, a database it cannot open).
 * @param {string} dir Codex's home @param {number[]} times milliseconds
 */
export async function codexLogAround(dir, times) {
  if (!times.length || !existsSync(dir)) return null;
  const file = readdirSync(dir).filter((n) => /^logs_\d+\.sqlite$/.test(n)).sort().pop();
  if (!file) return null;
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return null; }
  let db;
  try {
    db = new sqlite.DatabaseSync(join(dir, file), { readOnly: true });
    const query = db.prepare("SELECT ts, level, target, feedback_log_body AS body FROM logs WHERE ts BETWEEN ? AND ? AND level IN ('ERROR', 'WARN') ORDER BY ts, ts_nanos LIMIT 400");
    const parts = times.map((ms) => {
      const at = Math.floor(ms / 1000);
      const rows = /** @type {{ ts: number, level: string, target: string, body: string | null }[]} */ (query.all(at - CODEX_BEFORE_S, at + CODEX_AFTER_S));
      return [`Around ${new Date(ms).toISOString()}:`, ...(rows.length ? rows.map((r) => `  ${new Date(r.ts * 1000).toISOString()} ${r.level} ${r.target} ${String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 1000)}`) : ['  (nothing)'])].join('\n');
    });
    return redact(parts.join('\n\n'));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

/** A name for the file, by the time: `Daocut diagnostics 2026-10-18 1013.zip`. @param {Date} now */
export function diagnosticsName(now) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `Daocut diagnostics ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

/** The feedback body is a compact diagnostic, not a copy of the original log or a memory summary.
 * Keep complete JSON records, the initial request and recent failure evidence within each turn's budget.
 * ZIP export deliberately keeps its existing, explicitly opted-in full-log behavior.
 * @param {string} text @param {boolean} conversations @param {number} limit
 */
function feedbackTurnForFile(text, conversations, limit) {
  const marker = '[已截短；完整记录请在本机导出诊断文件]';
  let shortened = false;
  /** @param {string} value @param {number} max */
  const shorten = (value, max) => {
    if (value.length <= max) return value;
    shortened = true;
    const half = Math.floor(max / 2);
    return value.slice(0, half).replace(/[\uD800-\uDBFF]$/, '') + marker
      + value.slice(-half).replace(/^[\uDC00-\uDFFF]/, '');
  };
  /** Strip media before string limits; never load a referenced image into submitted text.
   * @param {any} value @param {number} max @param {number} [depth] @returns {any}
   */
  const compact = (value, max, depth = 0) => {
    if (typeof value === 'string') {
      if (/^data:(image|audio|video)\/[^;,]+;base64,/i.test(value)) return '[媒体内容省略]';
      return shorten(value, max);
    }
    if (!value || typeof value !== 'object') return value;
    if (depth > 12) { shortened = true; return marker; }
    if (Array.isArray(value)) {
      const values = value.length > 64 ? [...value.slice(0, 32), marker, ...value.slice(-32)] : value;
      if (value.length > 64) shortened = true;
      return values.map((item) => compact(item, max, depth + 1));
    }
    const media = ['image', 'audio', 'video', 'base64'].includes(value.type) || /^(image|audio|video)\//.test(value.mimeType || value.mime_type || value.media_type || '');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      media && ['data', 'blob', 'base64'].includes(key) && typeof item === 'string'
        ? `[媒体内容省略，编码字符数 ${item.length}]` : compact(item, max, depth + 1)]));
  };
  /** @typedef {{ order: number, line: string, size: number }} Row */
  /** @type {Row[][]} */
  const groups = [[], [], []];
  const sizes = [0, 0, 0];
  /** @type {Row | null} */
  let firstPrompt = null;
  let order = 0;
  /** @type {any} */
  let pending = null;
  /** @param {any} event */
  const add = (event) => {
    const important = ['prompt', 'sent', 'start', 'done', 'exit', 'cancel'].includes(event.kind);
    const priority = important ? 0 : event.kind === 'update' && /^(tool_call|tool_call_update|notice|usage_update)$/.test(event.update?.sessionUpdate) ? 1 : 2;
    const line = redact(JSON.stringify(compact(event, important ? 8192 : 2048)));
    const row = { order: order++, line, size: Buffer.byteLength(line) + 1 };
    if (!firstPrompt && event.kind === 'prompt') { firstPrompt = row; return; }
    groups[priority].push(row); sizes[priority] += row.size;
    while (sizes[priority] > limit && groups[priority].length > 1) {
      sizes[priority] -= /** @type {Row} */ (groups[priority].shift()).size; shortened = true;
    }
  };
  const flush = () => {
    if (!pending) return;
    const { event, head, tail: end, chars, chunks, through } = pending;
    event.update.content.text = chars <= 4096 ? head : head.slice(0, 2048).replace(/[\uD800-\uDBFF]$/, '') + marker + end.replace(/^[\uDC00-\uDFFF]/, '');
    if (chars > 4096) shortened = true;
    if (chunks > 1) { event.chunks = chunks; event.through = through; }
    add(event); pending = null;
  };
  // Iterate lines without allocating a second array for an entire large log.
  for (let offset = 0; offset < text.length;) {
    const end = text.indexOf('\n', offset);
    const raw = text.slice(offset, end < 0 ? text.length : end); offset = end < 0 ? text.length : end + 1;
    let event;
    try { event = JSON.parse(conversations ? raw : turnLogForFile(raw, false)); }
    catch { if (raw.trim() && conversations) shortened = true; continue; }
    if (!event || typeof event !== 'object') continue;
    const chunk = event.kind === 'update' && ['agent_thought_chunk', 'agent_message_chunk'].includes(event.update?.sessionUpdate)
      && event.update?.content?.type === 'text' && typeof event.update.content.text === 'string';
    if (chunk) {
      if (pending && pending.event.update.sessionUpdate !== event.update.sessionUpdate) flush();
      const content = event.update.content.text;
      if (!pending) pending = { event, head: '', tail: '', chars: 0, chunks: 0, through: event.t };
      pending.head = (pending.head + content).slice(0, 4096);
      pending.tail = (pending.tail + content).slice(-2048);
      pending.chars += content.length; pending.chunks++; pending.through = event.t;
    } else { flush(); add(event); }
  }
  flush();
  // Reserve a marker even when not needed, so removal never cuts a JSON line or UTF-8 sequence.
  let remaining = limit - Buffer.byteLength(marker) - 2;
  /** @type {Row[]} */
  const selected = [];
  const take = (/** @type {Row} */ row) => {
    if (row.size <= remaining) { selected.push(row); remaining -= row.size; }
    else shortened = true;
  };
  if (firstPrompt) take(firstPrompt);
  for (const group of groups) for (let i = group.length - 1; i >= 0; i--) take(group[i]);
  return selected.sort((a, b) => a.order - b.order).map((row) => row.line).join('\n') + (shortened ? '\n' + marker : '');
}

/** Bounded text for an explicitly submitted company feedback, without creating a ZIP or reading footage.
 * @param {{ conversations?: boolean, home?: string, now?: Date }} [options]
 */
export function feedbackDiagnostics({ conversations = false, home = studioHomeDir(), now = new Date() } = {}) {
  const problems = recentProblems({ file: problemsFile(home), days: KEEP_DAYS, now });
  const parts = ['Daocut · 最近的问题'];
  // The newest problems must not be crowded out by older records before any failed turn is attached.
  const problemLines = []; let problemBytes = 0;
  for (let i = problems.length - 1; i >= 0; i--) {
    const p = problems[i];
    const line = redact(JSON.stringify({ t: p.t, area: p.area, agent: p.agent, step: p.step, code: p.code, what: p.what }));
    if (problemBytes + Buffer.byteLength(line) + 1 > 32 * 1024) { parts.push('[较早问题已截短；完整记录请在本机导出诊断文件]'); break; }
    problemLines.unshift(line); problemBytes += Buffer.byteLength(line) + 1;
  }
  parts.push(...problemLines);
  const turns = [...new Set(problems.filter((p) => p.area === 'agent' && typeof p.log === 'string')
    .map((p) => expand(/** @type {string} */ (p.log))))].slice(-TURNS_MAX);
  const labels = turns.map((_, index) => `\n失败回合 ${index + 1}${conversations ? '（含对话）' : '（仅运行状态）'}`);
  const reserved = Buffer.byteLength([...parts, ...labels].join('\n')) + turns.length * 2;
  const perTurn = Math.floor((256 * 1024 - reserved) / Math.max(1, turns.length));
  for (const [index, file] of turns.entries()) {
    try {
      if (existsSync(file)) parts.push(labels[index], feedbackTurnForFile(readFileSync(file, 'utf8'), conversations, perTurn));
    } catch { parts.push(`失败回合 ${index + 1}：记录暂时无法读取`); }
  }
  return { details: parts.join('\n') };
}


/**
 * Write the diagnostic file; → where it is.
 * @param {{ report: string, conversations?: boolean, folder?: string, home?: string, appLogs?: string | null, now?: Date }} options
 */
export async function exportDiagnostics({ report, conversations = false, folder = exportsDefault(), home = studioHomeDir(), appLogs = brandEnv('APP_LOGS') ?? null, now = new Date() }) {
  /** @type {{ name: string, data: Buffer }[]} */
  const entries = [];
  const add = (/** @type {string} */ name, /** @type {string} */ text) => entries.push({ name, data: Buffer.from(text) });

  add('report.txt', redact(report));
  const problems = recentProblems({ file: problemsFile(home), days: KEEP_DAYS, now });
  add('problems.jsonl', problems.map((p) => JSON.stringify(p)).join('\n') + (problems.length ? '\n' : ''));

  /* the logs: Studio's (its home's logs/) and the desktop app's (its own logs/), the end of each */
  for (const [under, dir] of /** @type {const} */ ([['studio', join(home, 'logs')], ['app', appLogs]])) {
    if (!dir || !isAbsolute(dir) || !existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.log')).sort()) {
      try { if (statSync(join(dir, name)).isFile()) add(`logs/${under}/${name}`, redact(tail(join(dir, name), LOG_TAIL))); } catch { /* unreadable */ }
    }
  }

  /* the turns of the last agent problems, each once */
  const turns = [...new Set(problems.filter((p) => p.area === 'agent' && typeof p.log === 'string').map((p) => expand(/** @type {string} */ (p.log))))].slice(-TURNS_MAX);
  const pictures = new Set();
  for (const file of turns) {
    try {
      if (!existsSync(file)) continue;
      const text = turnLogForFile(tail(file, TURN_MAX), conversations);
      add('turns/' + basename(file), redact(text));
      if (!conversations) continue;
      const project = dirname(dirname(dirname(file)));
      if (join(project, '.film', 'logs') !== dirname(file)) continue;
      for (const reference of referencedLogImages(text)) {
        const name = 'turns/' + reference;
        if (pictures.has(name)) continue;
        const picture = readLogImage(project, reference);
        if (!picture) continue;
        entries.push({ name, data: picture.data });
        pictures.add(name);
      }
    } catch { /* unreadable */ }
  }

  /* Codex's own log around each of its problems */
  const codex = problems.filter((p) => p.area === 'agent' && /^codex$/i.test(String(p.agentId ?? p.agent ?? '')));
  if (codex.length) {
    const dir = expand(String(codex.at(-1)?.ownLogs ?? join('~', '.codex')));
    const text = await codexLogAround(dir, codex.slice(-TURNS_MAX).map((p) => Date.parse(p.t)).filter(Number.isFinite));
    if (text) add('agents/codex.txt', text);
  }

  await mkdir(folder, { recursive: true });
  const out = join(folder, diagnosticsName(now));
  await zipFiles(out, entries);
  return { path: out, files: entries.map((e) => e.name), conversations };
}
