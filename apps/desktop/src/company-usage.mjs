/**
 * Employee usage is a receipt outbox, not a second model request. Only turns explicitly
 * registered after this feature starts are read. Paths remain in the local checkpoint;
 * the company receives a small allowlisted receipt, bound to the employee at turn start.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readLog } from './chat-store.mjs';
import { summarizeUsage } from './model-usage.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const sameOwner = (a, b) => a?.serverUrl === b?.serverUrl && a?.userId === b?.userId;
const safeModel = (value) => typeof value === 'string' && value.trim() ? value.replace(/[\r\n\0]/g, '').trim().slice(0, 160) : 'unknown';
const numbers = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];

/** No messages, paths, credentials, provider addresses or prompt text leave this function. */
export function companyUsageEvent(call, { id, at, model = 'unknown', appVersion }) {
  const usage = summarizeUsage([call ?? { answer: null }]);
  const event = { id, at, model: safeModel(call?.answer?.model ?? call?.answer?.responseModel ?? model) };
  for (const key of numbers) event[key] = Math.max(0, Math.round(usage[key]));
  event.total = event.input + event.output + event.cacheRead + event.cacheWrite;
  // Reasoning is a subset of output; never add it to total a second time.
  event.reasoning = Math.min(event.output, event.reasoning);
  event.reported = usage.reported === 1;
  event.incomplete = usage.missing > 0;
  if (usage.unpriced === 0 && Object.keys(usage.costs).length) event.costs = usage.costs;
  if (typeof appVersion === 'string') event.appVersion = appVersion.slice(0, 40);
  return event;
}

/**
 * client.state() returns the current public company state. submitUsage({events}, owner)
 * must recheck owner before sending: changing accounts may never reassign queued usage.
 * recoverNativeTurn reimports a registered native session after restart, using its saved
 * interval. Timing/readLog options are injectable for offline tests; BYOK uses its own log.
 */
export function createCompanyUsageReporter({ dataDir, client, appVersion, log = () => {},
  readTurn = readLog, recoverNativeTurn = null, now = Date.now, retryMs = 30_000, settleMs = 30_000, lateMs = 2_000 }) {
  const file = join(dataDir, 'company-usage-queue.json');
  let store = { version: 1, installation: randomUUID(), enabledAt: new Date(now()).toISOString(), turns: {}, pending: {}, lastSyncedAt: null };
  let error = null;
  let stopped = false;
  let flushing = null;
  const late = new Set();
  const recover = new Set();
  const note = (message) => { error = message; try { log(`company usage: ${message}\n`); } catch { /* reporting never interrupts editing */ } };
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version !== 1 || typeof saved.installation !== 'string' || !saved.turns || !saved.pending) throw new Error('unsupported queue');
      store = saved;
      // A previous process ended. Recover only its registered logs, not every project.
      for (const turn of Object.values(store.turns)) {
        turn.finishedAt ??= now();
        if (turn.agent !== 'byok' && turn.nativeRecord && recoverNativeTurn) {
          turn.nativeRecord.to ??= turn.finishedAt;
          recover.add(turn.id);
        }
      }
    }
  } catch { note('本地用量待同步记录无法读取；请通过问题反馈提交诊断。'); }

  const persist = () => {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(store), { mode: 0o600 });
      renameSync(file + '.tmp', file);
      return true;
    } catch { note('本地用量记录未能保存，将在当前运行期间继续尝试。'); return false; }
  };
  const owner = () => {
    try {
      const state = client.state();
      return state?.status === 'signed-in' && typeof state.serverUrl === 'string' && typeof state.user?.id === 'string'
        ? { serverUrl: state.serverUrl, userId: state.user.id } : null;
    } catch { return null; }
  };
  const queue = (turn, key, call, model) => {
    // A native turn with no log has one unknown marker. Bind it once to its first
    // actual request; subsequent late insertions cannot steal that request's ID.
    if (key === 'unknown') turn.placeholder = true;
    else if (turn.placeholder && !turn.placeholderFor) turn.placeholderFor = key;
    const id = typeof call?.quotaRequestId === 'string' && /^[a-f0-9-]{36}$/i.test(call.quotaRequestId)
      ? call.quotaRequestId : hash(`${turn.id}:${turn.placeholderFor === key ? 'unknown' : key}`);
    const started = typeof call?.startedAt === 'number' && Number.isFinite(call.startedAt) ? call.startedAt : turn.startedAt;
    const event = companyUsageEvent(call, { id, at: new Date(started).toISOString(), model, appVersion });
    const fingerprint = JSON.stringify(event);
    if (turn.sent?.[id] === fingerprint || store.pending[id]?.fingerprint === fingerprint) return;
    store.pending[id] = { owner: turn.owner, turn: turn.id, event, fingerprint };
  };
  const collect = (turn) => {
    try {
      const record = readTurn(turn.project, turn.turnId);
      const calls = (record?.calls ?? []).filter((call) => !call?.kind || call.kind === 'call');
      let settings = null;
      let messages = [], thread = null, source = null;
      const requests = new Map();
      calls.forEach((call, index) => {
        if (call.settings !== undefined) settings = call.settings;
        if (call.thread !== undefined) thread = call.thread;
        if (call.source !== undefined) source = call.source;
        messages = [...messages.slice(0, Number.isSafeInteger(call.prefix) ? call.prefix : 0), ...(call.messages ?? [])];
        // BYOK's own model log is append-only. Native records can be re-sorted when
        // a subagent flushes late, so use their original request identity instead.
        const explicit = (typeof call.requestId === 'string' && call.requestId.length > 0) || (typeof call.quotaRequestId === 'string' && call.quotaRequestId.length > 0);
        const key = turn.agent === 'byok' ? (call.quotaRequestId ? `quota:${call.quotaRequestId}` : `append:${index}`) : explicit ? `source:${call.requestId}`
          : `legacy:${hash(JSON.stringify({ at: call.startedAt ?? null, thread: thread?.id ?? null, source, messages }))}`;
        const previous = requests.get(key);
        const model = settings?.model ?? turn.model;
        if (!previous) requests.set(key, { call, model, ambiguous: false });
        else {
          // Old logs can lack enough identity to distinguish two identical calls.
          // Count their maximum known receipt once and expose an unknown marker;
          // inventing a second billable request would overstate employee usage.
          const selected = summarizeUsage([call]).total >= summarizeUsage([previous.call]).total ? { call, model } : previous;
          requests.set(key, { ...selected, ambiguous: previous.ambiguous || !explicit });
        }
      });
      for (const [key, request] of requests) {
        queue(turn, key, request.call, request.model);
        if (request.ambiguous) queue(turn, `${key}:ambiguous`, null, request.model);
      }
      // BYOK writes actual attempts itself; no call means no known API request (including
      // a local greeting or compact's "nothing to compact"). Native agents may not expose receipts.
      if (!calls.length && turn.finishedAt != null && turn.agent !== 'byok' && !turn.skipEmpty && !turn.placeholderFor)
        queue(turn, 'unknown', null, turn.model);
    } catch { note('读取当前任务的用量回执失败，统计可能不完整。'); }
  };
  const state = () => ({ enabledAt: store.enabledAt, pending: Object.keys(store.pending).length,
    monitoring: Object.keys(store.turns).length, lastSyncedAt: store.lastSyncedAt, error });
  const flush = () => {
    if (flushing) return flushing;
    if (stopped) return Promise.resolve(state());
    flushing = (async () => {
      for (const turn of Object.values(store.turns)) {
        if (recover.has(turn.id)) {
          // Import only this registered native session and time interval, before
          // collecting its receipt or retiring its checkpoint. BYOK logs need no import.
          await recoverNativeTurn({ agent: turn.agent, cwd: turn.project, turnId: turn.turnId, ...turn.nativeRecord });
          recover.delete(turn.id);
        }
        collect(turn);
      }
      // Checkpoint first. Network success must not precede durable local evidence.
      if (!persist()) return state();
      const current = owner();
      if (current) {
        const batch = Object.values(store.pending).filter((item) => sameOwner(item.owner, current)).slice(0, 100);
        if (batch.length) {
          try {
            await client.submitUsage({ events: batch.map((item) => item.event) }, current);
            for (const item of batch) {
              if (store.pending[item.event.id]?.fingerprint === item.fingerprint) delete store.pending[item.event.id];
              const turn = store.turns[item.turn];
              if (turn && sameOwner(turn.owner, item.owner)) (turn.sent ??= {})[item.event.id] = item.fingerprint;
            }
            store.lastSyncedAt = new Date(now()).toISOString();
            error = null;
          } catch { note('用量暂未同步，将在公司连接恢复后重试。'); }
        }
      }
      for (const [id, turn] of Object.entries(store.turns)) {
        if (turn.finishedAt != null && now() - turn.finishedAt >= settleMs) delete store.turns[id];
      }
      persist();
      return state();
    })().catch(() => { note('用量同步未完成，将稍后重试。'); return state(); }).finally(() => { flushing = null; });
    return flushing;
  };
  const startTurn = ({ project, turnId, model, agent = 'byok', skipEmpty = false, identity = undefined, nativeRecord = null }) => {
    if (stopped || typeof project !== 'string' || !project || typeof turnId !== 'string' || !turnId) return null;
    // identity is only provided by main's own async session bookkeeping, never renderer input.
    const selected = identity === undefined ? owner() : identity;
    if (!selected?.serverUrl || !selected?.userId) return null;
    const id = hash(`${store.installation}:${resolve(project).toLowerCase()}:${turnId}`);
    if (!store.turns[id]) store.turns[id] = { id, project, turnId, owner: { ...selected }, model: safeModel(model), agent,
      startedAt: now(), skipEmpty, sent: {},
      ...(agent !== 'byok' && typeof nativeRecord?.sessionId === 'string' && nativeRecord.sessionId && Number.isFinite(nativeRecord.from)
        ? { nativeRecord: { sessionId: nativeRecord.sessionId, from: nativeRecord.from,
          agentLog: typeof nativeRecord.agentLog === 'string' ? nativeRecord.agentLog : null } } : {}),
    };
    persist();
    return { id, owner: { ...store.turns[id].owner } };
  };
  const checkpointTurn = (token, to = now()) => {
    const turn = token && store.turns[token.id];
    if (!turn?.nativeRecord || stopped) return;
    turn.nativeRecord.to ??= to;
    turn.finishedAt ??= to;
    persist();
  };
  const finishTurn = async (token) => {
    const turn = token && store.turns[token.id];
    if (!turn || stopped) return state();
    turn.finishedAt ??= now();
    collect(turn);
    persist();
    const result = await flush();
    if (lateMs > 0 && !stopped) {
      const timer = setTimeout(() => { late.delete(timer); void flush(); }, lateMs);
      timer.unref?.();
      late.add(timer);
    }
    return result;
  };
  const timer = retryMs > 0 ? setInterval(() => { void flush(); }, retryMs) : null;
  timer?.unref?.();
  // Materialize the start date even if no model request is made during this run.
  persist();
  // The quota path uses the existing durable outbox. A failed direct settlement is replayed by /usage.
  const recordRequest = (event, identity) => {
    if (stopped || !identity?.serverUrl || !identity?.userId) throw new Error('公司用量记录无法保存。');
    const fingerprint = JSON.stringify(event);
    store.pending[event.id] = { owner: { serverUrl: identity.serverUrl, userId: identity.userId }, turn: null, event, fingerprint };
    if (!persist()) throw new Error('公司用量记录无法保存，已保留额度占用。');
    return fingerprint;
  };
  const acknowledgeRequest = (event, identity) => {
    const item = store.pending[event.id];
    if (item && sameOwner(item.owner, identity) && item.fingerprint === JSON.stringify(event)) {
      delete store.pending[event.id]; persist();
    }
  };
  return { startTurn, checkpointTurn, finishTurn, flush, state, recordRequest, acknowledgeRequest,
    stop() {
      // Bound native work still active during a normal application quit.
      const endedAt = now();
      for (const turn of Object.values(store.turns)) if (turn.nativeRecord) {
        turn.nativeRecord.to ??= endedAt;
        turn.finishedAt ??= endedAt;
      }
      stopped = true; clearInterval(timer); for (const item of late) clearTimeout(item); late.clear(); persist();
    } };
}
