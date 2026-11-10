import { randomUUID } from 'node:crypto';

export class CompanyDataError extends Error {
  constructor(message, code = 'INVALID_INPUT', status = 400) { super(message); this.status = status; this.code = code; }
}
const invalid = (message) => { throw new CompanyDataError(message); };
const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];
const dayInShanghai = (at) => new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 10);
function dateBoundary(value, fallback) {
  const day = value || fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00+08:00`)) || dayInShanghai(`${day}T00:00:00+08:00`) !== day) invalid('日期须为有效的 YYYY-MM-DD');
  return { day, at: new Date(`${day}T00:00:00+08:00`).toISOString() };
}
function usageEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('用量记录格式不正确');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.id)) invalid('用量记录 ID 不正确');
  if (typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.at) || !Number.isFinite(Date.parse(value.at))) invalid('用量时间须包含时区');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) invalid('模型名称不正确');
  if (typeof value.reported !== 'boolean' || typeof value.incomplete !== 'boolean') invalid('用量完整性标记不正确');
  for (const name of tokenFields) if (!Number.isSafeInteger(value[name]) || value[name] < 0) invalid(`${name} 须为非负整数`);
  if (value.reasoning > value.output) invalid('推理 Token 应包含在输出 Token 内');
  if (value.total !== value.input + value.output + value.cacheRead + value.cacheWrite) invalid('Token 总数应等于未缓存输入、输出和缓存读写之和');
  if (value.appVersion !== undefined && (typeof value.appVersion !== 'string' || value.appVersion.length > 80)) invalid('版本名称过长');
  let costs = null;
  if (value.costs !== undefined) {
    if (!value.costs || Array.isArray(value.costs) || typeof value.costs !== 'object' || !Object.keys(value.costs).length || Object.keys(value.costs).length > 8) invalid('费用格式不正确');
    costs = {};
    for (const [currency, amount] of Object.entries(value.costs)) {
      if (!/^[A-Z]{3}$/.test(currency) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1e9) invalid('费用须为有效货币与非负金额');
      costs[currency] = amount;
    }
  }
  return { ...Object.fromEntries(tokenFields.map((key) => [key, value[key]])), id: value.id, at: new Date(value.at).toISOString(), model: value.model.trim(), reported: value.reported, incomplete: value.incomplete || !value.reported, costs, appVersion: value.appVersion || '' };
}
function textBytes(value, limit, label) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > limit) invalid(`${label}过长或格式不正确`);
  return value;
}
export function validateFeedbackExtras(body) {
  let diagnostics = null;
  if (body.diagnostics !== undefined) {
    if (!body.diagnostics || Array.isArray(body.diagnostics) || typeof body.diagnostics !== 'object') invalid('诊断格式不正确');
    diagnostics = { report: textBytes(body.diagnostics.report, 64 * 1024, '基础诊断'), ...(body.diagnostics.details === undefined ? {} : { details: textBytes(body.diagnostics.details, 256 * 1024, '详细诊断') }) };
  }
  const input = body.attachments ?? [];
  if (!Array.isArray(input) || input.length > 3) invalid('最多添加 3 张截图');
  const attachments = input.map((item) => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || /[\x00-\x1f]/.test(item.name)) invalid('截图名称不正确');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType) || typeof item.data !== 'string' || item.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) invalid('截图须为 PNG、JPEG 或 WebP');
    if (item.data.length > Math.ceil(2 * 1024 * 1024 / 3) * 4) invalid('单张截图不能超过 2 MiB');
    const bytes = Buffer.from(item.data, 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) invalid('单张截图不能超过 2 MiB');
    const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR';
    const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
    const webp = bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
    if (!({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp })[item.mimeType]) invalid('截图内容与图片格式不一致');
    return { id: randomUUID(), name: item.name.replace(/[\\/]/g, '_'), mimeType: item.mimeType, size: bytes.length, bytes };
  });
  return { diagnostics, attachments };
}

export function createCompanyData(db, { now = Date.now } = {}) {
  const currentTime = () => new Date(now()).toISOString();
  const columns = db.prepare('PRAGMA table_info(company_feedback)').all();
  if (!columns.some((column) => column.name === 'diagnostics')) db.exec("ALTER TABLE company_feedback ADD COLUMN diagnostics TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS company_feedback_attachment (
    id TEXT PRIMARY KEY, feedbackId TEXT NOT NULL REFERENCES company_feedback(id) ON DELETE CASCADE,
    name TEXT NOT NULL, mimeType TEXT NOT NULL, size INTEGER NOT NULL, bytes BLOB NOT NULL
  ); CREATE INDEX IF NOT EXISTS company_feedback_attachment_feedback ON company_feedback_attachment(feedbackId);
  CREATE TABLE IF NOT EXISTS company_usage (
    userId TEXT NOT NULL REFERENCES user(id), id TEXT NOT NULL, at TEXT NOT NULL, model TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL,
    reasoning INTEGER NOT NULL, total INTEGER NOT NULL, reported INTEGER NOT NULL, incomplete INTEGER NOT NULL,
    costs TEXT, appVersion TEXT NOT NULL DEFAULT '', syncedAt TEXT NOT NULL, PRIMARY KEY(userId,id)
  ); CREATE INDEX IF NOT EXISTS company_usage_at ON company_usage(at);
  CREATE INDEX IF NOT EXISTS company_usage_user_at ON company_usage(userId,at);
  CREATE TABLE IF NOT EXISTS company_quota (
    userId TEXT PRIMARY KEY REFERENCES user(id), dailyLimit INTEGER, monthlyLimit INTEGER, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS company_quota_reservation (
    userId TEXT NOT NULL REFERENCES user(id), id TEXT NOT NULL, model TEXT NOT NULL,
    reservedTokens INTEGER NOT NULL, createdAt TEXT NOT NULL, appVersion TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'reserved', updatedAt TEXT NOT NULL, PRIMARY KEY(userId,id)
  ); CREATE INDEX IF NOT EXISTS company_quota_reservation_period ON company_quota_reservation(userId,createdAt,status);`);
  const attachmentMeta = (id) => db.prepare('SELECT id,name,mimeType,size FROM company_feedback_attachment WHERE feedbackId = ? ORDER BY rowid').all(id);
  const feedbackMeta = (row, detail = false) => {
    if (!row) return null;
    const { diagnostics: raw, hasDiagnostics, ...item } = row;
    return { ...item, hasDiagnostics: Boolean(raw ?? hasDiagnostics), attachments: attachmentMeta(row.id), ...(detail && raw ? { diagnostics: JSON.parse(raw) } : {}) };
  };
  const saveFeedbackExtras = (id, extras) => {
    if (extras.diagnostics) db.prepare('UPDATE company_feedback SET diagnostics = ? WHERE id = ?').run(JSON.stringify(extras.diagnostics), id);
    const insert = db.prepare('INSERT INTO company_feedback_attachment (id,feedbackId,name,mimeType,size,bytes) VALUES (?,?,?,?,?,?)');
    for (const item of extras.attachments) insert.run(item.id, id, item.name, item.mimeType, item.size, item.bytes);
  };
  const insertUsage = db.prepare(`INSERT INTO company_usage (userId,id,at,model,input,output,cacheRead,cacheWrite,reasoning,total,reported,incomplete,costs,appVersion,syncedAt)
    VALUES (@userId,@id,@at,@model,@input,@output,@cacheRead,@cacheWrite,@reasoning,@total,@reported,@incomplete,@costs,@appVersion,@syncedAt)
    ON CONFLICT(userId,id) DO UPDATE SET at=excluded.at,model=excluded.model,input=excluded.input,output=excluded.output,
    cacheRead=excluded.cacheRead,cacheWrite=excluded.cacheWrite,reasoning=excluded.reasoning,total=excluded.total,
    reported=excluded.reported,incomplete=excluded.incomplete,costs=excluded.costs,appVersion=excluded.appVersion,syncedAt=excluded.syncedAt
    WHERE excluded.reported >= company_usage.reported AND excluded.incomplete <= company_usage.incomplete`);
  function recordUsage(userId, body) {
    if (!Array.isArray(body.events) || !body.events.length || body.events.length > 200) invalid('每次提交 1–200 条用量记录');
    const events = body.events.map(usageEvent); const syncedAt = currentTime();
    db.transaction(() => { for (const event of events) writeUsage(userId, event, syncedAt); }).immediate();
    return { accepted: events.length, ids: events.map((event) => event.id), syncedAt };
  }
  const reservation = (userId, id) => db.prepare('SELECT * FROM company_quota_reservation WHERE userId=? AND id=?').get(userId, id);
  function writeUsage(userId, value, syncedAt) {
    const held = reservation(userId, value.id);
    // A request belongs to the server's admission period, even when its receipt arrives tomorrow.
    const event = held ? { ...value, at: held.createdAt } : value;
    if (held) {
      const previous = db.prepare('SELECT * FROM company_usage WHERE userId=? AND id=?').get(userId, event.id);
      if (previous && Number(event.reported) >= previous.reported && Number(event.incomplete) <= previous.incomplete &&
          (event.total < previous.total || (previous.reported && !previous.incomplete && tokenFields.some((key) => event[key] !== previous[key])))) {
        throw new CompanyDataError('这条请求的用量回执与已保存的完整回执不一致', 'QUOTA_RECEIPT_CONFLICT', 409);
      }
    }
    insertUsage.run({ ...event, userId, reported: Number(event.reported), incomplete: Number(event.incomplete), costs: event.costs === null ? null : JSON.stringify(event.costs), syncedAt });
    if (held) {
      const saved = db.prepare('SELECT reported,incomplete FROM company_usage WHERE userId=? AND id=?').get(userId, event.id);
      if (saved?.reported && !saved.incomplete) db.prepare("UPDATE company_quota_reservation SET status='settled',updatedAt=? WHERE userId=? AND id=?").run(syncedAt, userId, event.id);
    }
  }
  const quotaId = (value) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) invalid('请求 ID 不正确');
    return value;
  };
  function quotaSummary(userId, at = currentTime()) {
    const user = db.prepare('SELECT id,name,username,banned FROM user WHERE id=?').get(userId);
    if (!user) throw new CompanyDataError('账号不存在', 'NOT_FOUND', 404);
    const limits = db.prepare('SELECT dailyLimit,monthlyLimit FROM company_quota WHERE userId=?').get(userId) ?? { dailyLimit: null, monthlyLimit: null };
    const day = dayInShanghai(at), month = day.slice(0, 7);
    const dayStart = dateBoundary(day).at, monthStart = dateBoundary(`${month}-01`).at;
    const [year, monthNumber] = month.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(year, monthNumber, 1) - 8 * 3600_000).toISOString();
    const period = (label, start, end, limit) => {
      const used = db.prepare('SELECT COALESCE(SUM(total),0) AS n FROM company_usage WHERE userId=? AND at>=? AND at<?').get(userId, start, end).n;
      // Partial receipts and their reservation describe one request, never two charges.
      const reserved = db.prepare(`SELECT COALESCE(SUM(MAX(r.reservedTokens-COALESCE(u.total,0),0)),0) AS n
        FROM company_quota_reservation r LEFT JOIN company_usage u ON u.userId=r.userId AND u.id=r.id
        WHERE r.userId=? AND r.createdAt>=? AND r.createdAt<? AND r.status='reserved'`).get(userId, start, end).n;
      return { period: label, limit, used, reserved, remaining: limit === null ? null : Math.max(0, limit - used - reserved), resetAt: end };
    };
    return { userId: user.id, name: user.name, username: user.username, enabled: !user.banned,
      limited: limits.dailyLimit !== null || limits.monthlyLimit !== null,
      daily: period(day, dayStart, new Date(Date.parse(dayStart) + 86400_000).toISOString(), limits.dailyLimit),
      monthly: period(month, monthStart, nextMonth, limits.monthlyLimit) };
  }
  function allQuotas() {
    const at = currentTime();
    return db.prepare('SELECT id FROM user ORDER BY name').all().map((user) => quotaSummary(user.id, at));
  }
  function setQuota(userId, body) {
    for (const key of ['dailyLimit', 'monthlyLimit']) {
      if (body[key] !== null && (!Number.isSafeInteger(body[key]) || body[key] < 0)) invalid('每日和每月额度须为非负整数，或 null 表示不限额');
    }
    return db.transaction(() => {
      quotaSummary(userId);
      db.prepare(`INSERT INTO company_quota(userId,dailyLimit,monthlyLimit,updatedAt) VALUES (?,?,?,?)
        ON CONFLICT(userId) DO UPDATE SET dailyLimit=excluded.dailyLimit,monthlyLimit=excluded.monthlyLimit,updatedAt=excluded.updatedAt`)
        .run(userId, body.dailyLimit, body.monthlyLimit, currentTime());
      return quotaSummary(userId);
    }).immediate();
  }
  function reserveQuota(userId, body) {
    const id = quotaId(body.id);
    if (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200) invalid('模型名称不正确');
    if (!Number.isSafeInteger(body.reservedTokens) || body.reservedTokens < 1) invalid('预留 Token 须为正整数');
    if (body.appVersion !== undefined && (typeof body.appVersion !== 'string' || body.appVersion.length > 80)) invalid('版本名称过长');
    const model = body.model.trim();
    return db.transaction(() => {
      const existing = reservation(userId, id);
      if (existing) {
        if (existing.model !== model || existing.reservedTokens !== body.reservedTokens) throw new CompanyDataError('同一请求 ID 的预留参数不能改变', 'QUOTA_REQUEST_CONFLICT', 409);
        return { id, status: existing.status, quota: quotaSummary(userId) };
      }
      if (db.prepare('SELECT id FROM company_usage WHERE userId=? AND id=?').get(userId, id)) throw new CompanyDataError('此请求 ID 已有用量记录，不能重新执行', 'QUOTA_REQUEST_CONFLICT', 409);
      const at = currentTime(), quota = quotaSummary(userId, at);
      for (const [key, label] of [['daily', '今日'], ['monthly', '本月']]) {
        if (quota[key].remaining !== null && quota[key].remaining < body.reservedTokens) {
          throw new CompanyDataError(`${label} Token 剩余额度不足以开始这次 AI 请求，请联系管理员调整额度。已完成的剪辑仍保留。`, 'QUOTA_EXCEEDED', 403);
        }
      }
      db.prepare('INSERT INTO company_quota_reservation(userId,id,model,reservedTokens,createdAt,appVersion,updatedAt) VALUES (?,?,?,?,?,?,?)')
        .run(userId, id, model, body.reservedTokens, at, body.appVersion ?? '', at);
      return { id, status: 'reserved', quota: quotaSummary(userId, at) };
    }).immediate();
  }
  function settleQuota(userId, body) {
    const event = usageEvent(body.event);
    return db.transaction(() => {
      if (!reservation(userId, event.id)) throw new CompanyDataError('找不到这次请求的预留记录', 'QUOTA_REQUEST_NOT_FOUND', 404);
      writeUsage(userId, event, currentTime());
      const status = reservation(userId, event.id).status;
      return { id: event.id, status, settled: status === 'settled', quota: quotaSummary(userId) };
    }).immediate();
  }
  function releaseQuota(userId, body) {
    const id = quotaId(body.id);
    if (body.reason !== 'not-sent') invalid('仅可释放确认尚未发送给模型的请求');
    return db.transaction(() => {
      const held = reservation(userId, id);
      if (!held) throw new CompanyDataError('找不到这次请求的预留记录', 'QUOTA_REQUEST_NOT_FOUND', 404);
      if (held.status === 'reserved') {
        if (db.prepare('SELECT id FROM company_usage WHERE userId=? AND id=?').get(userId, id)) throw new CompanyDataError('这次请求已有用量回执，不能按未发送释放', 'QUOTA_REQUEST_CONFLICT', 409);
        db.prepare("UPDATE company_quota_reservation SET status='released',updatedAt=? WHERE userId=? AND id=?").run(currentTime(), userId, id);
      }
      const status = reservation(userId, id).status;
      return { id, status, released: status === 'released', quota: quotaSummary(userId) };
    }).immediate();
  }
  function usageSummary(actor, search) {
    const today = dayInShanghai(currentTime());
    const from = dateBoundary(search.get('from'), `${today.slice(0, 7)}-01`);
    const to = dateBoundary(search.get('to'), today);
    if (from.day > to.day) invalid('开始日期不能晚于结束日期');
    const until = new Date(Date.parse(to.at) + 86400_000).toISOString();
    const requestedUser = search.get('userId');
    if (actor.role !== 'admin' && requestedUser && requestedUser !== actor.id) throw new CompanyDataError('仅可查看自己的用量', 'FORBIDDEN', 403);
    const userId = actor.role === 'admin' ? requestedUser : actor.id;
    const conditions = ['e.at >= ?', 'e.at < ?']; const values = [from.at, until];
    if (userId) { conditions.push('e.userId = ?'); values.push(userId); }
    const model = search.get('model'); if (model) { conditions.push('e.model = ?'); values.push(model); }
    const rows = db.prepare(`SELECT e.*, u.name AS userName,u.username FROM company_usage e JOIN user u ON u.id=e.userId WHERE ${conditions.join(' AND ')} ORDER BY e.at`).all(...values);
    const aggregate = (items) => {
      const result = { requests: items.length, reportedRequests: 0, incompleteRequests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, lastSyncedAt: null };
      const costs = {}; let completeCosts = items.length > 0;
      for (const item of items) {
        result.reportedRequests += item.reported; result.incompleteRequests += item.incomplete;
        for (const name of tokenFields) result[name] += item[name];
        if (!result.lastSyncedAt || item.syncedAt > result.lastSyncedAt) result.lastSyncedAt = item.syncedAt;
        if (!item.costs || item.incomplete) completeCosts = false;
        else for (const [currency, amount] of Object.entries(JSON.parse(item.costs))) costs[currency] = (costs[currency] || 0) + amount;
      }
      if (completeCosts) result.costs = costs;
      return result;
    };
    const grouped = (key, extra) => {
      const groups = new Map();
      for (const row of rows) { const value = key(row); if (!groups.has(value)) groups.set(value, []); groups.get(value).push(row); }
      return [...groups.entries()].map(([value, items]) => ({ ...extra(value, items[0]), ...aggregate(items) }));
    };
    const scopedUsers = actor.role === 'admin' ? (userId ? db.prepare('SELECT id,name,username FROM user WHERE id=?').all(userId) : db.prepare('SELECT id,name,username FROM user ORDER BY name').all()) : db.prepare('SELECT id,name,username FROM user WHERE id=?').all(actor.id);
    const employeeTotals = new Map(grouped((row) => row.userId, (id, row) => ({ userId: id, name: row.userName, username: row.username })).map((item) => [item.userId, item]));
    const employees = scopedUsers.map((user) => {
      const total = employeeTotals.get(user.id) || { userId: user.id, name: user.name, username: user.username, ...aggregate([]) };
      const last = db.prepare('SELECT MAX(syncedAt) AS lastSyncedAt FROM company_usage WHERE userId=?').get(user.id).lastSyncedAt;
      return { ...total, lastSyncedAt: last };
    });
    const allModels = actor.role === 'admin' && !userId ? db.prepare('SELECT DISTINCT model FROM company_usage ORDER BY model').all() : db.prepare('SELECT DISTINCT model FROM company_usage WHERE userId=? ORDER BY model').all(userId || actor.id);
    return { from: from.day, to: to.day, timeZone: 'Asia/Shanghai', totals: aggregate(rows), daily: grouped((row) => dayInShanghai(row.at), (date) => ({ date })), employees, models: grouped((row) => row.model, (name) => ({ model: name })), availableModels: allModels.map((item) => item.model), lastSyncedAt: employees.map((item) => item.lastSyncedAt).filter(Boolean).sort().at(-1) || null };
  }
  return { feedbackMeta, saveFeedbackExtras, recordUsage, usageSummary, quotaSummary, allQuotas, setQuota, reserveQuota, settleQuota, releaseQuota };
}
