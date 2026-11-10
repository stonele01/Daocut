import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { admin, bearer, username } from 'better-auth/plugins';
import { CompanyDataError, createCompanyData, validateFeedbackExtras } from './company-data.mjs';
import { createSharedAnalysis } from './shared-analysis.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const categories = new Set(['bug', 'suggestion', 'other']);
const statuses = new Set(['new', 'in_progress', 'resolved', 'closed']);
const isLoopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'].includes(address);
const safeUser = (user) => ({ id: user.id, username: user.username, name: user.name, role: user.role || 'user', enabled: !user.banned });
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
function field(value, name, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(400, 'INVALID_INPUT', `${name}长度须为 ${min}–${max} 个字符`);
  return value.trim();
}
function credentials(body) {
  const account = field(body.username, '账号', 32, 3).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(account)) fail(400, 'INVALID_USERNAME', '账号仅支持英文字母、数字、点、下划线和短横线');
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) fail(400, 'INVALID_PASSWORD', '密码长度须为 10–128 个字符');
  return { username: account, password: body.password };
}
async function readJson(req, limit = 24_576) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'JSON_REQUIRED', '请使用 JSON 请求');
  if (Number(req.headers['content-length'] || 0) > limit) fail(413, 'BODY_TOO_LARGE', '提交内容过大');
  let size = 0; const chunks = [];
  await new Promise((resolve, reject) => {
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted); };
    const onData = (chunk) => { size += chunk.length; if (size > limit) { cleanup(); req.resume(); reject(new HttpError(413, 'BODY_TOO_LARGE', '提交内容过大')); } else chunks.push(chunk); };
    const onEnd = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new HttpError(400, 'REQUEST_INTERRUPTED', '请求连接中断')); };
    const onAborted = onError;
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAborted);
  });
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
  catch { fail(400, 'INVALID_JSON', 'JSON 格式不正确'); }
}
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

export async function createCompanyService(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DAOCUT_COMPANY_DATA || 'D:/Daocut/CompanyData');
  const host = options.host || process.env.DAOCUT_COMPANY_HOST || '127.0.0.1';
  const port = Number(options.port ?? process.env.DAOCUT_COMPANY_PORT ?? 4715);
  const tls = options.tls;
  if (!isLoopback(host) && !tls) throw new Error('局域网服务须配置 TLS 证书。无证书时仅允许 127.0.0.1 本机运行。');
  const baseURL = options.baseURL || process.env.DAOCUT_COMPANY_URL || `${tls ? 'https' : 'http'}://${host === '::1' ? '[::1]' : host}:${port}`;
  const base = new URL(baseURL);
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash || (tls && base.protocol !== 'https:') || (!tls && base.protocol !== 'http:')) throw new Error('DAOCUT_COMPANY_URL 必须是服务根地址，且协议须与 TLS 配置一致');
  await mkdir(dataDir, { recursive: true });
  const updatesDir = path.resolve(options.updatesDir || process.env.DAOCUT_COMPANY_UPDATES || path.join(dataDir, 'updates'));
  await mkdir(updatesDir, { recursive: true });
  const secretPath = path.join(dataDir, 'auth-secret');
  let secret;
  try { secret = (await readFile(secretPath, 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; secret = randomBytes(48).toString('base64url'); try { await writeFile(secretPath, secret, { flag: 'wx', mode: 0o600 }); } catch (error2) { if (error2.code !== 'EEXIST') throw error2; secret = (await readFile(secretPath, 'utf8')).trim(); } }
  if (secret.length < 32) throw new Error('auth-secret 文件无效，请恢复原始密钥');
  const db = new Database(path.join(dataDir, 'company.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  const authOptions = {
    appName: 'Daocut Company', baseURL, basePath: '/api/auth', secret, database: db,
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 10, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
    advanced: { cookiePrefix: 'daocut-company', useSecureCookies: Boolean(tls), ipAddress: { ipAddressHeaders: ['x-daocut-client-ip'] } },
    trustedOrigins: [base.origin],
    rateLimit: { enabled: true, window: 60, max: 100, customRules: { '/sign-in/username': { window: 60, max: 8 } } },
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 32, usernameValidator: (value) => /^[a-z0-9][a-z0-9._-]*$/i.test(value) }), admin(), bearer({ requireSignature: true })],
  };
  const { runMigrations } = await getMigrations(authOptions);
  await runMigrations();
  const auth = betterAuth(authOptions);
  db.exec(`CREATE TABLE IF NOT EXISTS company_feedback (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES user(id), category TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, appVersion TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new', adminNote TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS company_feedback_user ON company_feedback(userId, createdAt);`);
  const companyData = createCompanyData(db, { now: options.now });
  const sharedAnalysis = createSharedAnalysis(db, { now: options.now });
  let setupBusy = false;
  const setupRequired = () => db.prepare('SELECT COUNT(*) AS count FROM user').get().count === 0;
  const authHeaders = (req) => {
    const headers = new Headers({ 'content-type': 'application/json', origin: base.origin, 'x-daocut-client-ip': req.socket.remoteAddress || 'unknown' });
    if (req.headers.authorization) headers.set('authorization', req.headers.authorization);
    if (req.headers.cookie) headers.set('cookie', req.headers.cookie);
    return headers;
  };
  async function authRequest(req, endpoint, body, method = 'POST') {
    const response = await auth.handler(new Request(`${base.origin}/api/auth${endpoint}`, { method, headers: authHeaders(req), ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}) }));
    const data = await response.json();
    if (!response.ok) throw new HttpError(response.status, data.code || 'AUTH_ERROR', data.message || '账号操作失败');
    return { response, data };
  }
  async function session(req, adminOnly = false) {
    const result = await auth.api.getSession({ headers: authHeaders(req), query: { disableCookieCache: true } });
    if (!result) fail(401, 'UNAUTHENTICATED', '请重新登录');
    const current = db.prepare('SELECT * FROM user WHERE id = ?').get(result.user.id);
    if (!current || current.banned) fail(401, 'ACCOUNT_DISABLED', '账号已停用，请联系管理员');
    if (adminOnly && current.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '仅管理员可操作');
    return { user: safeUser(current), expiresAt: new Date(result.session.expiresAt).toISOString() };
  }
  const copyCookies = (response, res) => { const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('set-cookie', cookies); };
  const feedbackById = (id) => db.prepare('SELECT f.*, u.name AS userName, u.username FROM company_feedback f JOIN user u ON u.id = f.userId WHERE f.id = ?').get(id);

  async function handler(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const requestOrigin = `${tls ? 'https' : 'http'}://${req.headers.host || ''}`;
      const local = isLoopback(req.socket.remoteAddress);
      let requestHost;
      try { requestHost = new URL(requestOrigin).hostname.replace(/^\[|\]$/g, ''); } catch { fail(400, 'INVALID_HOST', '服务地址不正确'); }
      if (requestOrigin !== base.origin && !(local && isLoopback(requestHost))) fail(400, 'INVALID_HOST', '请使用配置的公司服务地址');
      if (req.headers.origin && req.headers.origin !== requestOrigin) fail(403, 'ORIGIN_REJECTED', '请从公司服务页面操作');
      const requestUrl = new URL(req.url, base.origin);
      const pathname = requestUrl.pathname;
      const method = req.method;
      if (pathname === '/api/company/health' && method === 'GET') return json(res, 200, { ok: true, setupRequired: setupRequired(), service: 'Daocut Company', version: '0.1.0' });
      if (pathname === '/api/company/setup' && method === 'POST') {
        if (!local) fail(403, 'LOCAL_SETUP_ONLY', '请在服务器电脑本机创建首位管理员');
        if (setupBusy || !setupRequired()) fail(409, 'ALREADY_CONFIGURED', '已完成初始化，请登录');
        setupBusy = true;
        try {
          const body = await readJson(req); const input = credentials(body); const name = field(body.name, '姓名', 80);
          const result = await auth.api.createUser({ body: { email: `${input.username}@users.daocut.invalid`, password: input.password, name, role: 'admin', data: { username: input.username, displayUsername: input.username } } });
          return json(res, 201, { user: safeUser(result.user) });
        } finally { setupBusy = false; }
      }
      if (pathname === '/api/company/login' && method === 'POST') {
        const input = credentials(await readJson(req));
        const { response, data } = await authRequest(req, '/sign-in/username', input);
        const token = response.headers.get('set-auth-token');
        if (!token) fail(500, 'AUTH_TOKEN_MISSING', '登录令牌生成失败');
        copyCookies(response, res);
        const signedHeaders = new Headers({ authorization: `Bearer ${token}` });
        const result = await auth.api.getSession({ headers: signedHeaders });
        if (!result) fail(500, 'AUTH_SESSION_MISSING', '登录会话生成失败');
        return json(res, 200, { user: safeUser(data.user), token, expiresAt: new Date(result.session.expiresAt).toISOString() });
      }
      if (pathname === '/api/company/session' && method === 'GET') return json(res, 200, await session(req));
      if (pathname === '/api/company/logout' && method === 'POST') {
        const { response } = await authRequest(req, '/sign-out', {}); copyCookies(response, res); return json(res, 200, { ok: true });
      }
      if (pathname === '/api/company/password' && method === 'POST') {
        await session(req); const body = await readJson(req); credentials({ username: 'validate', password: body.newPassword });
        const { response } = await authRequest(req, '/change-password', { currentPassword: field(body.currentPassword, '原密码', 128), newPassword: body.newPassword, revokeOtherSessions: true });
        copyCookies(response, res); return json(res, 200, { ok: true });
      }
      if (pathname === '/api/company/users' && method === 'GET') {
        await session(req, true);
        return json(res, 200, { users: db.prepare('SELECT * FROM user ORDER BY createdAt DESC').all().map(safeUser) });
      }
      if (pathname === '/api/company/users' && method === 'POST') {
        await session(req, true); const body = await readJson(req); const input = credentials(body); const name = field(body.name, '姓名', 80);
        const { data } = await authRequest(req, '/admin/create-user', { email: `${input.username}@users.daocut.invalid`, password: input.password, name, role: 'user', data: { username: input.username, displayUsername: input.username } });
        return json(res, 201, { user: safeUser(data.user) });
      }
      const userRoute = pathname.match(/^\/api\/company\/users\/([^/]+)\/(password|status)$/);
      if (userRoute && method === 'POST') {
        const actor = await session(req, true); const id = userRoute[1]; const body = await readJson(req);
        if (!db.prepare('SELECT id FROM user WHERE id = ?').get(id)) fail(404, 'NOT_FOUND', '账号不存在');
        if (userRoute[2] === 'password') {
          credentials({ username: 'validate', password: body.password });
          await authRequest(req, '/admin/set-user-password', { userId: id, newPassword: body.password });
          await authRequest(req, '/admin/revoke-user-sessions', { userId: id });
        } else {
          if (typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled 必须为布尔值');
          if (!body.enabled && id === actor.user.id) fail(400, 'SELF_DISABLE', '不能停用当前管理员');
          await authRequest(req, body.enabled ? '/admin/unban-user' : '/admin/ban-user', { userId: id, ...(!body.enabled ? { banReason: '管理员停用账号' } : {}) });
        }
        return json(res, 200, { ok: true });
      }
      if (pathname === '/api/company/feedback' && method === 'POST') {
        const actor = await session(req); const body = await readJson(req, 10 * 1024 * 1024);
        if (!categories.has(body.category)) fail(400, 'INVALID_CATEGORY', '请选择反馈类型');
        const extras = validateFeedbackExtras(body);
        const id = randomUUID(); const now = new Date().toISOString();
        db.transaction(() => {
          db.prepare('INSERT INTO company_feedback (id, userId, category, title, description, appVersion, platform, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, actor.user.id, body.category, field(body.title, '标题', 120), field(body.description, '说明', 8000), field(body.appVersion ?? '', '版本', 80, 0), field(body.platform ?? '', '系统', 120, 0), now, now);
          companyData.saveFeedbackExtras(id, extras);
        })();
        return json(res, 201, { feedback: companyData.feedbackMeta(feedbackById(id)) });
      }
      if (pathname === '/api/company/feedback' && method === 'GET') {
        const actor = await session(req);
        const query = `SELECT f.id, f.userId, f.category, f.title, f.description, f.appVersion, f.platform,
          f.status, f.adminNote, f.createdAt, f.updatedAt, (f.diagnostics <> '') AS hasDiagnostics,
          u.name AS userName, u.username FROM company_feedback f JOIN user u ON u.id = f.userId`;
        const feedback = actor.user.role === 'admin' ? db.prepare(`${query} ORDER BY f.createdAt DESC LIMIT 500`).all() : db.prepare(`${query} WHERE f.userId = ? ORDER BY f.createdAt DESC LIMIT 500`).all(actor.user.id);
        return json(res, 200, { feedback: feedback.map((item) => companyData.feedbackMeta(item)) });
      }
      const attachmentRoute = pathname.match(/^\/api\/company\/feedback\/([^/]+)\/attachments\/([^/]+)$/);
      if (attachmentRoute && method === 'GET') {
        const actor = await session(req); const item = feedbackById(attachmentRoute[1]);
        if (!item || (actor.user.role !== 'admin' && item.userId !== actor.user.id)) fail(404, 'NOT_FOUND', '截图不存在');
        const attachment = db.prepare('SELECT * FROM company_feedback_attachment WHERE feedbackId=? AND id=?').get(item.id, attachmentRoute[2]);
        if (!attachment) fail(404, 'NOT_FOUND', '截图不存在');
        res.writeHead(200, { 'content-type': attachment.mimeType, 'content-length': attachment.size, 'cache-control': 'no-store', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, '%27')}` });
        return res.end(attachment.bytes);
      }
      const feedbackRoute = pathname.match(/^\/api\/company\/feedback\/([^/]+)$/);
      if (feedbackRoute && method === 'GET') {
        const actor = await session(req); const item = feedbackById(feedbackRoute[1]);
        if (!item || (actor.user.role !== 'admin' && item.userId !== actor.user.id)) fail(404, 'NOT_FOUND', '反馈不存在');
        return json(res, 200, { feedback: companyData.feedbackMeta(item, true) });
      }
      if (feedbackRoute && method === 'PATCH') {
        await session(req, true); const body = await readJson(req); const id = feedbackRoute[1];
        if (!statuses.has(body.status)) fail(400, 'INVALID_STATUS', '请选择处理状态');
        if (!feedbackById(id)) fail(404, 'NOT_FOUND', '反馈不存在');
        db.prepare('UPDATE company_feedback SET status = ?, adminNote = ?, updatedAt = ? WHERE id = ?').run(body.status, field(body.adminNote ?? '', '处理说明', 4000, 0), new Date().toISOString(), id);
        return json(res, 200, { feedback: companyData.feedbackMeta(feedbackById(id)) });
      }
      if (pathname === '/api/company/quota' && method === 'GET') {
        const actor = await session(req);
        return json(res, 200, { quota: companyData.quotaSummary(actor.user.id), timeZone: 'Asia/Shanghai' });
      }
      if (pathname === '/api/company/quotas' && method === 'GET') {
        await session(req, true);
        return json(res, 200, { quotas: companyData.allQuotas(), timeZone: 'Asia/Shanghai' });
      }
      const quotaUserRoute = pathname.match(/^\/api\/company\/users\/([^/]+)\/quota$/);
      if (quotaUserRoute && method === 'PUT') {
        await session(req, true);
        return json(res, 200, { quota: companyData.setQuota(quotaUserRoute[1], await readJson(req)), timeZone: 'Asia/Shanghai' });
      }
      const quotaAction = pathname.match(/^\/api\/company\/quota\/(reserve|settle|release)$/);
      if (quotaAction && method === 'POST') {
        const actor = await session(req); const body = await readJson(req);
        const action = { reserve: companyData.reserveQuota, settle: companyData.settleQuota, release: companyData.releaseQuota }[quotaAction[1]];
        return json(res, 200, { ...action(actor.user.id, body), timeZone: 'Asia/Shanghai' });
      }
      const sharedAnalysisAction = pathname.match(/^\/api\/company\/shared-analysis\/(status|claim|submitted|complete|fail|retry|versions|catalog)$/);
      if (sharedAnalysisAction && method === 'POST') {
        const actor = await session(req); const body = await readJson(req);
        return json(res, 200, sharedAnalysis[sharedAnalysisAction[1]](actor.user.id, body));
      }
      if (pathname === '/api/company/usage' && method === 'POST') {
        const actor = await session(req); const body = await readJson(req, 256 * 1024);
        return json(res, 200, companyData.recordUsage(actor.user.id, body));
      }
      if (pathname === '/api/company/usage' && method === 'GET') {
        const actor = await session(req);
        return json(res, 200, companyData.usageSummary(actor.user, requestUrl.searchParams));
      }
      if (pathname.startsWith('/updates/') && ['GET', 'HEAD'].includes(method)) {
        let requested; try { requested = decodeURIComponent(pathname.slice(9)); } catch { fail(400, 'INVALID_PATH', '文件名不正确'); }
        const windowsFeed = requested.startsWith('win/x64/');
        const filename = windowsFeed ? requested.slice('win/x64/'.length) : requested;
        if (!filename || path.basename(filename) !== filename || /[\\/\x00-\x1f:]/.test(filename) || !/\.(exe|zip|blockmap|ya?ml|json)$/i.test(filename)) fail(404, 'NOT_FOUND', '文件不存在');
        const root = await realpath(updatesDir);
        const expectedDirectory = windowsFeed ? path.join(root, 'win', 'x64') : root;
        let target;
        try { target = await realpath(path.join(expectedDirectory, filename)); } catch (error) { if (error.code === 'ENOENT') fail(404, 'NOT_FOUND', '文件不存在'); throw error; }
        // Resolve the final file and compare with the allowed literal directory: symlinks/junctions cannot escape.
        if (path.dirname(target).toLowerCase() !== expectedDirectory.toLowerCase()) fail(404, 'NOT_FOUND', '文件不存在');
        const info = await stat(target); if (!info.isFile()) fail(404, 'NOT_FOUND', '文件不存在');
        const headers = { 'content-type': /\.ya?ml$/i.test(filename) ? 'text/yaml' : 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': /\.(ya?ml|json)$/i.test(filename) ? 'no-cache' : 'public, max-age=3600' };
        let start = 0; let end = info.size - 1; let status = 200;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end(); }
          start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2])); end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); return res.end(); }
          status = 206; headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
        }
        headers['content-length'] = Math.max(0, end - start + 1); res.writeHead(status, headers);
        if (method === 'HEAD' || info.size === 0) return res.end();
        const stream = createReadStream(target, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
      }
      if (['GET', 'HEAD'].includes(method) && ['/', '/admin', '/app.js', '/style.css', '/brand.svg'].includes(pathname)) {
        const name = ['/', '/admin'].includes(pathname) ? 'index.html' : pathname.slice(1);
        const body = await readFile(path.join(publicDir, name));
        res.writeHead(200, { 'content-type': name.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-length': body.length });
        return res.end(method === 'HEAD' ? undefined : body);
      }
      fail(404, 'NOT_FOUND', '请求地址不存在');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (!(error instanceof HttpError) && !(error instanceof CompanyDataError)) console.error('Company service request failed:', error.message);
      const status = Number.isInteger(error.status) ? error.status : Number.isInteger(error.statusCode) ? error.statusCode : 500;
      json(res, status, { error: { code: error.body?.code || error.code || 'INTERNAL_ERROR', message: status < 500 ? (error.body?.message || error.message) : '服务暂时无法处理，请稍后重试' } });
    }
  }
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler);
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return { server, dataDir, updatesDir, baseURL, async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); return server.address(); }, async close() { if (server.listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); db.close(); } };
}







