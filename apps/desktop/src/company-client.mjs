/**
 * Company authentication belongs to Electron main. Only a deliberately small public state
 * crosses IPC. Employee model keys, projects and agent logs never enter this client.
 */
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { feedbackExtras } from './company-feedback.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const fault = (message, code = 'company-unavailable', status = 0) => Object.assign(new Error(message), { code, status });
const SHARED_ACTION_FIELDS = {
  status: ['taskKey', 'inputHash'], versions: ['taskKey'], catalog: ['sourceIdentity'], claim: ['taskKey', 'inputHash', 'clientAttemptId', 'familyKey', 'baseResultSha256', 'catalog'],
  submitted: ['taskKey', 'attemptId'], complete: ['taskKey', 'attemptId', 'result'],
  fail: ['taskKey', 'attemptId', 'reason'],
  retry: ['taskKey', 'inputHash', 'expectedAttemptId', 'clientAttemptId', 'acknowledged'],
};

/** Only task metadata crosses the company boundary; media and result bodies stay in the library. */
function sharedMetadata(action, input) {
  const allowed = Object.hasOwn(SHARED_ACTION_FIELDS, action) && SHARED_ACTION_FIELDS[action];
  const invalid = () => { throw fault('共享分析参数无效，仅允许任务与结果标识。', 'SHARED_INVALID_INPUT'); };
  if (!allowed || !input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const { expectedCoordinatorId, ...body } = input;
  if (expectedCoordinatorId !== undefined && (typeof expectedCoordinatorId !== 'string' || !/^[a-f0-9]{64}$/.test(expectedCoordinatorId))) invalid();
  if (Object.keys(body).some(key => !allowed.includes(key))) invalid();
  const optional = action === 'status' ? ['inputHash'] : action === 'claim' ? ['familyKey', 'baseResultSha256', 'catalog'] : [];
  if (allowed.some(key => !optional.includes(key) && !Object.hasOwn(body, key))) invalid();
  if (action === 'claim' && Object.hasOwn(body, 'familyKey') !== Object.hasOwn(body, 'baseResultSha256')) invalid();
  for (const [key, value] of Object.entries(body)) {
    if (key === 'result') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'path,schema,sha256' ||
          typeof value.path !== 'string' || !/^[a-zA-Z0-9._/-]{1,1024}\.json$/.test(value.path) ||
          value.path.split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.')) ||
          typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
          typeof value.schema !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.schema)) invalid();
    } else if (key === 'catalog') {
      if (!value || Object.keys(value).sort().join(',') !== 'action,count,provenance,scope,sourceIdentity' || !/^[a-f0-9]{64}$/.test(value.sourceIdentity) || !['transcription', 'discovery', 'analysis', 'structure-plans'].includes(value.action) || !Number.isSafeInteger(value.count) || value.count < 0) invalid();
      if (value.scope !== null && (!value.scope || Object.keys(value.scope).sort().join(',') !== 'endMs,startMs' || !Number.isFinite(value.scope.startMs) || !Number.isFinite(value.scope.endMs) || value.scope.startMs < 0 || value.scope.endMs <= value.scope.startMs)) invalid();
      const safe = ['kind', 'rangeOrigin', 'model', 'inputRevision', 'originalCacheIdentity', 'warning', 'originalInputHash', 'originalContractHash', 'legacyReview', 'localReconciled', 'effectiveInput', 'rawManifestHash', 'inputStatus', 'inputHashKind', 'scopeInputHash', 'scopeInputOrigin', 'originalAsrMatch'];
      if (!value.provenance || JSON.stringify(value.provenance).length > 4096 || Object.keys(value.provenance).some(k => !safe.includes(k))) invalid();
      for (const [k, v] of Object.entries(value.provenance)) {
        if (k === 'effectiveInput') { if (!v || Object.keys(v).some(x => !['status', 'origin', 'hash', 'cueCount', 'code'].includes(x)) || Object.values(v).some(x => !['string', 'number'].includes(typeof x))) invalid(); }
        else if (v !== null && !['string', 'boolean'].includes(typeof v)) invalid();
      }
    } else if (key === 'acknowledged') { if (value !== true) invalid(); }
    else if (['taskKey', 'inputHash', 'familyKey', 'baseResultSha256', 'sourceIdentity'].includes(key)) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); }
    else if (key === 'reason') { if (!['not-sent', 'provider-failed', 'unknown', 'needs-review'].includes(value)) invalid(); }
    else if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) invalid();
  }
  return { body, expectedCoordinatorId };
}

export function validateCompanyProfile(input, { allowLoopbackHttp = false } = {}) {
  if (!input || typeof input !== 'object') throw fault('公司连接文件格式不正确。', 'company-profile');
  let url;
  try { url = new URL(input.serverUrl); } catch { throw fault('公司服务地址不正确。', 'company-profile'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) {
    throw fault('公司地址必须是 HTTPS 服务地址，不能包含账号、路径或查询参数。', 'company-profile');
  }
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  const caPem = typeof input.caPem === 'string' ? input.caPem.trim() : '';
  if (caPem.length > 65536 || (caPem && !/^-----BEGIN CERTIFICATE-----/.test(caPem))) throw fault('公司证书格式不正确。', 'company-profile');
  if (caPem) {
    try { new X509Certificate(caPem); } catch { throw fault('公司证书无法读取。', 'company-profile'); }
  }
  return { name: name || '公司工作台', serverUrl: url.origin, caPem };
}

/** HTTPS uses ordinary chain, hostname and expiry checks with the imported company CA. No redirects. */
export function companyRequest(profile, endpoint, { method = 'GET', token, body, timeoutMs = 12000, allowLoopbackHttp = false } = {}) {
  const trusted = validateCompanyProfile(profile, { allowLoopbackHttp });
  if (!/^\/[a-z]+$/.test(endpoint) && !/^\/feedback\/[A-Za-z0-9-]{1,80}$/.test(endpoint) && !/^\/quota\/(reserve|settle|release)$/.test(endpoint) && !/^\/shared-analysis\/(status|claim|submitted|complete|fail|retry|versions|catalog)$/.test(endpoint)) return Promise.reject(fault('未知公司接口。'));
  const url = new URL('/api/company' + endpoint, trusted.serverUrl);
  const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = request(url, {
      // Trust the explicitly imported service certificate as the chain anchor, including Electron/BoringSSL.
      method, agent: false, rejectUnauthorized: true, ...(trusted.caPem ? { ca: trusted.caPem, allowPartialTrustChain: true } : {}),
      headers: { accept: 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) { res.destroy(); reject(fault('公司服务响应过大。')); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(fault('公司服务连接中断，请重试。')));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(fault('公司服务没有返回有效数据。')); return; }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const message = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 300) : '公司服务暂时不可用。';
          reject(fault(message, String(data?.error?.code ?? 'company-unavailable'), status));
        } else resolve(data);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(fault('连接公司服务超时，请检查网络。')));
    req.on('error', (error) => reject(error.status !== undefined ? error : fault(
      /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(error.code)) ? '公司服务器证书验证失败，请重新导入管理员提供的连接文件。' : '无法连接公司服务，请检查网络或联系管理员。')));
    req.end(bytes);
  });
}

/** Electron updater only: trust the imported leaf for its exact host, preserving system TLS elsewhere. */
export function companyCertificateDecision(profile, request, now = Date.now()) {
  if (!profile?.caPem) return -3;
  let host;
  try { host = new URL(profile.serverUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return -3; }
  if (String(request.hostname).replace(/^\[|\]$/g, '').toLowerCase() !== host) return -3;
  try {
    const pinned = new X509Certificate(profile.caPem);
    const actual = new X509Certificate(request.certificate.data);
    if (!pinned.raw.equals(actual.raw) || now < Date.parse(actual.validFrom) || now >= Date.parse(actual.validTo)) return -2;
    if (!(isIP(host) ? actual.checkIP(host) : actual.checkHost(host))) return -2;
    return 0;
  } catch { return -2; }
}

function publicUser(input) {
  if (!input || typeof input.id !== 'string' || typeof input.username !== 'string' || typeof input.role !== 'string') throw fault('公司账号响应格式不正确。');
  return { id: input.id, username: input.username, name: typeof input.name === 'string' ? input.name : input.username,
    role: input.role, ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}) };
}
const binding = (profile) => createHash('sha256').update(JSON.stringify(profile)).digest('hex');

/** encrypt/decrypt are main's safeStorage callbacks; null means this session stays in memory. */
export function createCompanyClient({ dataDir, appVersion, platform = process.platform, encrypt = null, decrypt = null,
  profileFile = null, request = companyRequest, onChange = () => {}, allowLoopbackHttp = false }) {
  const profilePath = join(dataDir, 'company-profile.json');
  const sessionPath = join(dataDir, 'company-session.bin');
  let profile = null;
  let token = null;
  let epoch = 0;
  let current = { configured: false, status: 'unconfigured', appVersion };
  const snapshot = () => structuredClone(current);
  const update = (status, user, error) => {
    current = { configured: Boolean(profile), ...(profile ? { serverUrl: profile.serverUrl, companyName: profile.name } : {}),
      status, ...(user ? { user } : {}), ...(error ? { error } : {}), appVersion };
    onChange(snapshot());
    return snapshot();
  };
  const atomicWrite = (path, contents) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path + '.tmp', contents, { mode: 0o600 });
    renameSync(path + '.tmp', path);
  };
  const forget = () => { try { rmSync(sessionPath, { force: true }); } catch { /* memory is already cleared */ } };
  const persist = () => {
    forget();
    if (!token || !profile || !encrypt) return;
    try { atomicWrite(sessionPath, encrypt(JSON.stringify({ token, profile: binding(profile) }))); } catch { /* unavailable keychain: memory only */ }
  };
  const valid = (version, secret) => epoch === version && token === secret;
  const invalidated = (error) => error?.status === 401 || (error?.status === 403 && !/^(QUOTA_|SHARED_)/.test(String(error?.code)));
  function fail(error, version, secret) {
    if (!valid(version, secret)) return snapshot();
    if (invalidated(error)) { epoch++; token = null; forget(); }
    return update(invalidated(error) ? 'signed-out' : 'unavailable', undefined, error instanceof Error ? error.message : '无法连接公司服务。');
  }
  const call = (endpoint, options = {}, selected = profile) => {
    if (!selected) return Promise.reject(fault('请先导入公司连接文件。', 'company-unconfigured'));
    return request(selected, endpoint, { ...options, allowLoopbackHttp });
  };
  try {
    const file = existsSync(profilePath) ? profilePath : profileFile;
    if (file && existsSync(file)) {
      profile = validateCompanyProfile(JSON.parse(readFileSync(file, 'utf8')), { allowLoopbackHttp });
      if (decrypt && existsSync(sessionPath)) {
        try {
          const saved = JSON.parse(decrypt(readFileSync(sessionPath)));
          if (saved.profile === binding(profile) && typeof saved.token === 'string') token = saved.token;
        } catch { forget(); }
      }
      current = { configured: true, serverUrl: profile.serverUrl, companyName: profile.name, status: token ? 'checking' : 'signed-out', appVersion };
    }
  } catch { current.error = '公司连接文件无法读取，请重新导入。'; }

  async function refresh({ quiet = false } = {}) {
    if (!profile) return snapshot();
    if (!token) return update('signed-out');
    const version = epoch, secret = token;
    if (!quiet) update('checking');
    try {
      const result = await call('/session', { token: secret });
      if (!valid(version, secret)) return snapshot();
      const user = publicUser(result.user);
      if (user.enabled === false) throw fault('此公司账号已停用，请联系管理员。', 'account-disabled', 403);
      return update('signed-in', user);
    } catch (error) { return fail(error, version, secret); }
  }
  async function assertSession() {
    const version = epoch;
    const result = await refresh({ quiet: true });
    if (version !== epoch || result.status !== 'signed-in' || !token) throw fault(result.error || '请先登录公司账号。', 'company-auth-required', 403);
    return result;
  }
  async function authenticated(endpoint, options = {}, expectedIdentity = null) {
    if (expectedIdentity?.epoch !== undefined && expectedIdentity.epoch !== epoch) throw fault('公司登录状态已改变，请重新开始任务。', 'company-quota-identity');
    await assertSession();
    if (expectedIdentity?.epoch !== undefined && expectedIdentity.epoch !== epoch) throw fault('公司登录状态已改变，请重新开始任务。', 'company-quota-identity');
    if (expectedIdentity && (current.user?.id !== expectedIdentity.userId || profile?.serverUrl !== expectedIdentity.serverUrl)) {
      throw fault(endpoint === '/usage' || endpoint.startsWith('/quota') ? '用量记录属于另一个公司账号，将在该账号登录后同步。' : '公司账号已切换，请重新提交反馈。', 'company-usage-identity');
    }
    const version = epoch, secret = token;
    try {
      const result = await call(endpoint, { ...options, token: secret });
      if (!valid(version, secret)) throw fault('公司登录状态已改变，请重试。', 'company-auth-required', 403);
      return result;
    } catch (error) { if (!error.status || error.status >= 500 || invalidated(error)) fail(error, version, secret); throw error; }
  }

  return {
    state: snapshot, refresh, assertSession,
    // Main-process binding only. The epoch also distinguishes a new login to the same account.
    sessionBinding: () => current.status === 'signed-in' && current.user?.id && profile
      ? { serverUrl: profile.serverUrl, userId: current.user.id, epoch } : null,
    quota: (identity) => authenticated('/quota', {}, identity),
    reserveQuota: (input, identity) => authenticated('/quota/reserve', { method: 'POST', body: { id: input.id, model: input.model, reservedTokens: input.reservedTokens, appVersion } }, identity),
    releaseQuota: (id, identity) => authenticated('/quota/release', { method: 'POST', body: { id, reason: 'not-sent' } }, identity),
    settleQuota: (event, identity) => authenticated('/quota/settle', { method: 'POST', body: { event } }, identity),
    async sharedAnalysis(action, input) {
      const { body, expectedCoordinatorId } = sharedMetadata(action, input);
      if (!profile) throw fault('请先配置并登录公司服务。', 'company-unconfigured');
      const coordinationId = createHash('sha256').update(JSON.stringify({ serverUrl: profile.serverUrl, caPem: profile.caPem })).digest('hex');
      if (expectedCoordinatorId && expectedCoordinatorId !== coordinationId) throw fault('公司服务已切换，请回到原公司服务恢复共享任务。', 'SHARED_COORDINATOR_CHANGED');
      // Freeze the selected company even if login/configuration changes while session verification awaits.
      const identity = { serverUrl: profile.serverUrl, userId: current.user?.id, epoch };
      if (!identity.userId) { await assertSession(); identity.userId = current.user?.id; }
      const result = await authenticated('/shared-analysis/' + action, { method: 'POST', body }, identity);
      return { ...result, coordinationId };
    },
    transportProfile: () => profile ? structuredClone(profile) : null,
    configure(input) {
      const next = validateCompanyProfile(input, { allowLoopbackHttp });
      atomicWrite(profilePath, JSON.stringify(next, null, 2));
      epoch++; profile = next; token = null; forget();
      return update('signed-out');
    },
    async login(input) {
      if (!profile) return snapshot();
      const username = typeof input?.username === 'string' ? input.username.trim() : '';
      const password = typeof input?.password === 'string' ? input.password : '';
      epoch++; token = null; forget();
      if (!username || username.length > 120 || !password || password.length > 1024) return update('signed-out', undefined, '请输入有效账号和密码。');
      const version = epoch;
      update('checking');
      try {
        const result = await call('/login', { method: 'POST', body: { username, password } });
        if (version !== epoch) return snapshot();
        const user = publicUser(result.user);
        if (user.enabled === false) throw fault('此公司账号已停用。', 'account-disabled', 403);
        if (typeof result.token !== 'string' || !result.token || result.token.length > 16384) throw fault('公司登录响应格式不正确。');
        token = result.token; persist();
        return update('signed-in', user);
      } catch (error) {
        if (version !== epoch) return snapshot();
        return update(invalidated(error) ? 'signed-out' : 'unavailable', undefined, error.message);
      }
    },
    async logout() {
      const selected = profile, secret = token;
      epoch++; token = null; forget();
      update(profile ? 'signed-out' : 'unconfigured');
      if (selected && secret) await call('/logout', { method: 'POST', token: secret, body: {} }, selected).catch(() => {});
      return snapshot();
    },
    async submitFeedback(input) {
      const { category, title, description } = input ?? {};
      if (!['bug', 'suggestion', 'other'].includes(category) || typeof title !== 'string' || !title.trim() || title.trim().length > 120 ||
          typeof description !== 'string' || !description.trim() || description.trim().length > 8000) throw fault('请填写反馈类型、标题（120 字以内）和描述（8000 字以内）。', 'invalid-feedback');
      const extra = feedbackExtras(input);
      const identity = input.identity ?? { serverUrl: profile?.serverUrl, userId: current.user?.id };
      if (typeof identity.serverUrl !== 'string' || typeof identity.userId !== 'string') throw fault('请先登录公司账号。', 'company-auth-required');
      return authenticated('/feedback', { method: 'POST', timeoutMs: 30000, body: { category, title: title.trim(), description: description.trim(), appVersion, platform, ...extra } }, identity);
    },
    feedback: () => authenticated('/feedback'),
    feedbackDetails(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id)) throw fault('反馈编号无效。', 'invalid-feedback');
      return authenticated('/feedback/' + id);
    },
    submitUsage(input, expectedIdentity) {
      if (!expectedIdentity?.userId || !expectedIdentity?.serverUrl || !Array.isArray(input?.events) || input.events.length > 200) {
        throw fault('用量记录格式不正确。', 'invalid-usage');
      }
      // The host reporter constructs numeric receipts; no renderer IPC accepts usage submissions.
      const fields = ['id', 'at', 'model', 'input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'reported', 'incomplete', 'costs', 'appVersion'];
      const events = input.events.map((event) => Object.fromEntries(fields.filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]])));
      return authenticated('/usage', { method: 'POST', body: { events } }, expectedIdentity);
    },
    async adminUrl() {
      const result = await assertSession();
      if (result.user?.role !== 'admin') throw fault('仅管理员可以打开管理后台。', 'company-forbidden', 403);
      return new URL('/admin', profile.serverUrl).href;
    },
  };
}

