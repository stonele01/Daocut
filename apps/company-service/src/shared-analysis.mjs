import { createHash, randomUUID } from 'node:crypto';
import { CompanyDataError } from './company-data.mjs';

const fail = (message, code = 'INVALID_INPUT', status = 400) => { throw new CompanyDataError(message, code, status); };
const conflict = (message, code = 'SHARED_STATE_CONFLICT') => fail(message, code, 409);
function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) fail('共享分析参数不正确');
}
const hash = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('共享分析标识须为 SHA-256');
  return value;
};
const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) fail('共享分析请求标识不正确');
  return value;
};
function resultMetadata(value) {
  fields(value, ['path', 'sha256', 'schema']);
  hash(value.sha256);
  if (typeof value.path !== 'string' || !/^[a-zA-Z0-9._/-]{1,1024}\.json$/.test(value.path) ||
      value.path.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.'))) fail('结果须使用安全的相对 JSON 路径');
  if (typeof value.schema !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.schema)) fail('共享结果格式版本不正确');
  return { path: value.path, sha256: value.sha256, schema: value.schema };
}
function catalogMetadata(value) {
  fields(value, ['sourceIdentity', 'action', 'scope', 'count', 'provenance']); hash(value.sourceIdentity);
  if (!['transcription', 'discovery', 'analysis', 'structure-plans'].includes(value.action) || !Number.isSafeInteger(value.count) || value.count < 0) fail('历史结果目录信息无效');
  if (value.scope !== null) { fields(value.scope, ['startMs', 'endMs']); if (!Number.isFinite(value.scope.startMs) || !Number.isFinite(value.scope.endMs) || value.scope.startMs < 0 || value.scope.endMs <= value.scope.startMs) fail('历史范围无效'); }
  if (!value.provenance || typeof value.provenance !== 'object' || JSON.stringify(value.provenance).length > 4096) fail('历史来源说明无效');
  const allowed = ['kind', 'rangeOrigin', 'model', 'inputRevision', 'originalCacheIdentity', 'warning', 'originalInputHash', 'originalContractHash', 'legacyReview', 'localReconciled', 'effectiveInput', 'rawManifestHash', 'inputStatus', 'inputHashKind', 'scopeInputHash', 'scopeInputOrigin', 'originalAsrMatch'];
  if (Object.keys(value.provenance).some(key => !allowed.includes(key))) fail('目录不得包含私人结果或凭证');
  for (const [key, item] of Object.entries(value.provenance)) {
    if (key === 'effectiveInput') {
      fields(item, ['status', 'origin'], ['hash', 'cueCount', 'code']);
      if (Object.values(item).some(v => !['string', 'number'].includes(typeof v))) fail('目录不得包含输入正文');
    } else if (item !== null && !['string', 'boolean'].includes(typeof item)) fail('目录不得包含输入正文或私有配置');
  }
  return value;
}

// This ledger coordinates admission and publication, not external-provider exactly-once execution.
// All transactions are short and synchronous. Never run network/NAS IO inside a transaction.
export function createSharedAnalysis(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS company_shared_analysis (
    taskKey TEXT PRIMARY KEY, inputHash TEXT NOT NULL, ownerId TEXT NOT NULL REFERENCES user(id),
    attemptId TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('claimed','submitted','complete','failed','uncertain')),
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, result TEXT, failureReason TEXT
  );
  CREATE TABLE IF NOT EXISTS company_shared_analysis_attempt (
    attemptId TEXT PRIMARY KEY, taskKey TEXT NOT NULL REFERENCES company_shared_analysis(taskKey),
    ownerId TEXT NOT NULL REFERENCES user(id), clientAttemptId TEXT NOT NULL,
    previousAttemptId TEXT, createdAt TEXT NOT NULL, UNIQUE(ownerId,clientAttemptId)
  );
  CREATE TABLE IF NOT EXISTS company_shared_analysis_version (
    taskKey TEXT PRIMARY KEY REFERENCES company_shared_analysis(taskKey), familyKey TEXT NOT NULL,
    sequence INTEGER NOT NULL, baseSha TEXT, UNIQUE(familyKey, sequence)
  );
  CREATE TABLE IF NOT EXISTS company_shared_analysis_catalog (
    taskKey TEXT PRIMARY KEY REFERENCES company_shared_analysis(taskKey), sourceIdentity TEXT NOT NULL, metadata TEXT NOT NULL
  );
  INSERT OR IGNORE INTO company_shared_analysis_version(taskKey,familyKey,sequence)
    SELECT taskKey,taskKey,1 FROM company_shared_analysis WHERE taskKey NOT IN (SELECT taskKey FROM company_shared_analysis_version);`);
  const currentTime = () => new Date(now()).toISOString();
  const rowByKey = (taskKey) => db.prepare('SELECT * FROM company_shared_analysis WHERE taskKey=?').get(taskKey);
  const byClient = (ownerId, clientAttemptId) => db.prepare('SELECT * FROM company_shared_analysis_attempt WHERE ownerId=? AND clientAttemptId=?').get(ownerId, clientAttemptId);
  const taskView = (row) => row ? {
    // Reuse the existing ledger storage; review is a durable reason, not permission to upload again.
    taskKey: row.taskKey, inputHash: row.inputHash, status: row.failureReason === 'needs-review' ? 'needs-review' : row.status, ownerId: row.ownerId,
    attemptId: row.attemptId, createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.result ? { result: JSON.parse(row.result) } : {}),
    ...(row.failureReason ? { failureReason: row.failureReason } : {}),
  } : null;
  function sameInput(row, inputHash) {
    if (row && inputHash !== undefined && row.inputHash !== inputHash) conflict('这场共享分析的输入与已登记输入不一致', 'SHARED_INPUT_CONFLICT');
  }
  function ownedAttempt(ownerId, body) {
    const row = rowByKey(body.taskKey);
    if (!row) fail('找不到共享分析任务', 'SHARED_NOT_FOUND', 404);
    if (row.attemptId !== body.attemptId) conflict('这次执行已被明确重试替换，不能继续提交', 'SHARED_STALE_ATTEMPT');
    if (row.ownerId !== ownerId) fail('仅领取此任务的账号可更新它', 'SHARED_FORBIDDEN', 403);
    return row;
  }
  function validateAttempt(ownerId, body, extras = []) {
    id(ownerId); fields(body, ['taskKey', 'attemptId', ...extras]); hash(body.taskKey); id(body.attemptId);
  }
  const recordAttempt = (attemptId, taskKey, ownerId, clientAttemptId, previousAttemptId, at) => {
    db.prepare('INSERT INTO company_shared_analysis_attempt (attemptId,taskKey,ownerId,clientAttemptId,previousAttemptId,createdAt) VALUES (?,?,?,?,?,?)')
      .run(attemptId, taskKey, ownerId, clientAttemptId, previousAttemptId, at);
  };
  const acquiredView = (row, ownerId, attemptId) => ({ task: taskView(row), acquired: row.status === 'claimed' && row.ownerId === ownerId && row.attemptId === attemptId });
  function status(ownerId, body) {
    id(ownerId); fields(body, ['taskKey'], ['inputHash']); hash(body.taskKey);
    if (body.inputHash !== undefined) hash(body.inputHash);
    const row = rowByKey(body.taskKey); sameInput(row, body.inputHash);
    return { task: taskView(row) };
  }
  function claim(ownerId, body) {
    id(ownerId); fields(body, ['taskKey', 'inputHash', 'clientAttemptId'], ['familyKey', 'baseResultSha256', 'catalog']); hash(body.taskKey); hash(body.inputHash); id(body.clientAttemptId);
    const catalog = body.catalog === undefined ? null : catalogMetadata(body.catalog);
    const familyKey = body.familyKey === undefined ? body.taskKey : hash(body.familyKey);
    if (familyKey !== body.taskKey) {
      hash(body.baseResultSha256);
      if (createHash('sha256').update(JSON.stringify([familyKey, body.inputHash, body.baseResultSha256])).digest('hex') !== body.taskKey) fail('新版本任务身份不正确');
    } else if (body.baseResultSha256 !== undefined) fail('首版本不需要基版标识');
    return db.transaction(() => {
      const version = db.prepare('SELECT * FROM company_shared_analysis_version WHERE taskKey=?').get(body.taskKey);
      if (version && version.familyKey !== familyKey) conflict('任务不能改属另一场分析');
      if (familyKey !== body.taskKey && !db.prepare("SELECT 1 FROM company_shared_analysis_version v JOIN company_shared_analysis a ON a.taskKey=v.taskKey WHERE v.familyKey=? AND a.status='complete' AND json_extract(a.result,'$.sha256')=?").get(familyKey, body.baseResultSha256)) conflict('新版本须基于已完整保存的共享结果');
      const row = rowByKey(body.taskKey); sameInput(row, body.inputHash);
      const replay = byClient(ownerId, body.clientAttemptId);
      if (replay && (replay.taskKey !== body.taskKey || replay.previousAttemptId !== null)) conflict('同一请求标识不能改变用途', 'SHARED_REQUEST_CONFLICT');
      if (row) {
        if (catalog) { const prior = db.prepare('SELECT metadata FROM company_shared_analysis_catalog WHERE taskKey=?').get(body.taskKey); if (!prior || prior.metadata !== JSON.stringify(catalog)) conflict('已有历史结果目录身份不能改变'); }
        return acquiredView(row, ownerId, replay?.attemptId);
      }
      const at = currentTime(), attemptId = randomUUID();
      db.prepare("INSERT INTO company_shared_analysis (taskKey,inputHash,ownerId,attemptId,status,createdAt,updatedAt) VALUES (?,?,?,?,'claimed',?,?)")
        .run(body.taskKey, body.inputHash, ownerId, attemptId, at, at);
      recordAttempt(attemptId, body.taskKey, ownerId, body.clientAttemptId, null, at);
      const sequence = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM company_shared_analysis_version WHERE familyKey=?').get(familyKey).next;
      db.prepare('INSERT INTO company_shared_analysis_version(taskKey,familyKey,sequence,baseSha) VALUES (?,?,?,?)').run(body.taskKey, familyKey, sequence, body.baseResultSha256 ?? null);
      if (catalog) db.prepare('INSERT INTO company_shared_analysis_catalog(taskKey,sourceIdentity,metadata) VALUES (?,?,?)').run(body.taskKey, catalog.sourceIdentity, JSON.stringify(catalog));
      return acquiredView(rowByKey(body.taskKey), ownerId, attemptId);
    }).immediate();
  }
  function submitted(ownerId, body) {
    validateAttempt(ownerId, body);
    return db.transaction(() => {
      const row = ownedAttempt(ownerId, body);
      if (row.status !== 'claimed') return { task: taskView(row), sendAllowed: false };
      // Persist before transport. A lost acknowledgement must NOT grant another send.
      db.prepare("UPDATE company_shared_analysis SET status='submitted',updatedAt=? WHERE taskKey=?").run(currentTime(), body.taskKey);
      return { task: taskView(rowByKey(body.taskKey)), sendAllowed: true };
    }).immediate();
  }
  function complete(ownerId, body) {
    validateAttempt(ownerId, body, ['result']); const result = JSON.stringify(resultMetadata(body.result));
    return db.transaction(() => {
      const row = ownedAttempt(ownerId, body);
      if (row.status === 'complete') {
        if (row.result !== result) conflict('已保存的第一份共享结果不可覆盖', 'SHARED_RESULT_CONFLICT');
        return { task: taskView(row) };
      }
      if (!['submitted', 'uncertain'].includes(row.status)) conflict('当前任务尚未提交，或已经明确失败');
      db.prepare("UPDATE company_shared_analysis SET status='complete',result=?,failureReason=NULL,updatedAt=? WHERE taskKey=?").run(result, currentTime(), body.taskKey);
      return { task: taskView(rowByKey(body.taskKey)) };
    }).immediate();
  }
  function failAttempt(ownerId, body) {
    validateAttempt(ownerId, body, ['reason']);
    if (!['not-sent', 'provider-failed', 'unknown', 'needs-review'].includes(body.reason)) fail('请选择有效的失败状态');
    return db.transaction(() => {
      const row = ownedAttempt(ownerId, body);
      const nextStatus = ['unknown', 'needs-review'].includes(body.reason) ? 'uncertain' : 'failed';
      if (row.status === nextStatus && row.failureReason === body.reason) return { task: taskView(row) };
      const allowed = body.reason === 'needs-review' ? ['submitted', 'uncertain'] : ['claimed', 'submitted'];
      if (!allowed.includes(row.status) ||
          (body.reason === 'not-sent' && row.status !== 'claimed') ||
          (body.reason === 'provider-failed' && row.status !== 'submitted')) conflict('不能把当前任务改为此失败状态');
      db.prepare('UPDATE company_shared_analysis SET status=?,failureReason=?,updatedAt=? WHERE taskKey=?').run(nextStatus, body.reason, currentTime(), body.taskKey);
      return { task: taskView(rowByKey(body.taskKey)) };
    }).immediate();
  }
  function retry(ownerId, body) {
    id(ownerId); fields(body, ['taskKey', 'inputHash', 'expectedAttemptId', 'clientAttemptId', 'acknowledged']);
    hash(body.taskKey); hash(body.inputHash); id(body.expectedAttemptId); id(body.clientAttemptId);
    if (body.acknowledged !== true) fail('重试前须明确确认可能重复计费');
    return db.transaction(() => {
      const row = rowByKey(body.taskKey);
      if (!row) fail('找不到共享分析任务', 'SHARED_NOT_FOUND', 404);
      sameInput(row, body.inputHash);
      if (row.failureReason === 'needs-review') conflict('音频分段已完成，接缝待核对；不能重新上传已完成音频');
      const replay = byClient(ownerId, body.clientAttemptId);
      if (replay) {
        if (replay.taskKey !== body.taskKey || replay.previousAttemptId !== body.expectedAttemptId) conflict('同一重试标识不能改变用途', 'SHARED_REQUEST_CONFLICT');
        return acquiredView(row, ownerId, replay.attemptId);
      }
      if (row.attemptId !== body.expectedAttemptId) conflict('任务状态已变化，请重新核对', 'SHARED_STALE_ATTEMPT');
      if (row.status === 'complete') conflict('已有成功的共享结果，不能再次执行');
      // No lease expiry or automatic takeover: an active owner must explicitly recover their attempt.
      if (['claimed', 'submitted'].includes(row.status) && row.ownerId !== ownerId) fail('其他同事正在处理，仅原账号可明确恢复未完成任务', 'SHARED_FORBIDDEN', 403);
      const at = currentTime(), attemptId = randomUUID();
      recordAttempt(attemptId, body.taskKey, ownerId, body.clientAttemptId, row.attemptId, at);
      db.prepare("UPDATE company_shared_analysis SET ownerId=?,attemptId=?,status='claimed',failureReason=NULL,updatedAt=? WHERE taskKey=?")
        .run(ownerId, attemptId, at, body.taskKey);
      return acquiredView(rowByKey(body.taskKey), ownerId, attemptId);
    }).immediate();
  }
  function versions(ownerId, body) {
    id(ownerId); fields(body, ['taskKey']); hash(body.taskKey);
    const versions = db.prepare("SELECT a.*,v.sequence FROM company_shared_analysis_version v JOIN company_shared_analysis a ON a.taskKey=v.taskKey WHERE v.familyKey=? AND a.status='complete' ORDER BY v.sequence").all(body.taskKey).map(row => ({ ...taskView(row), sequence: row.sequence }));
    return { versions, latest: versions.at(-1) ?? null };
  }
  function catalog(ownerId, body) {
    id(ownerId); fields(body, ['sourceIdentity']); hash(body.sourceIdentity);
    const rows = db.prepare("SELECT a.*,c.metadata FROM company_shared_analysis_catalog c JOIN company_shared_analysis a ON a.taskKey=c.taskKey WHERE c.sourceIdentity=? AND a.status='complete' ORDER BY a.createdAt,a.taskKey").all(body.sourceIdentity);
    return { results: rows.map(row => ({ ...taskView(row), catalog: JSON.parse(row.metadata) })) };
  }
  return { status, claim, submitted, complete, fail: failAttempt, retry, versions, catalog };
}
