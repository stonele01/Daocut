/** Request/reply bridge for the Studio utility process. Timed-out submissions are never resent. */
import { WAIT_MINUTES } from './pi-config.mjs';
const sharedErrors = {
  'company-unconfigured': '请先配置并登录公司服务',
  'company-auth-required': '请先登录有效的公司账号',
  'company-unavailable': '公司服务暂时无法连接，请恢复连接后核查任务；不会自动重发',
  SHARED_COORDINATOR_CHANGED: '公司服务已切换，请回到原公司服务恢复共享任务',
  SHARED_FORBIDDEN: '仅领取此任务的账号可更新它，请等待或复用共享结果',
  SHARED_STALE_ATTEMPT: '此任务已被明确重试替换，请刷新状态',
  SHARED_COMPANY_UNAVAILABLE: '请先配置并登录公司服务以使用共享分析',
  SHARED_INPUT_CONFLICT: '共享任务输入不一致，请刷新后核对',
  SHARED_REQUEST_CONFLICT: '共享请求标识已使用，请刷新任务状态',
  SHARED_RESULT_CONFLICT: '共享首版已保存，不能覆盖，请刷新后复用',
  SHARED_STATE_CONFLICT: '共享任务状态已变化，请刷新后核对',
  SHARED_NOT_FOUND: '找不到共享任务，请核对公司服务与素材库',
  SHARED_INVALID_INPUT: '共享任务参数无效，未提交请求',
};

/** Public IPC failures do not forward arbitrary company responses or credentials. */
export function studioAnalysisError(error) {
  const sharedMessage = Object.hasOwn(sharedErrors, error.code) ? sharedErrors[error.code] : null;
  const publicModelError = ['MODEL_INPUT_CHANGED', 'MODEL_TIMEOUT', 'MODEL_HTTP', 'MODEL_NETWORK', 'MODEL_INCOMPLETE', 'MODEL_INVALID_JSON', 'MODEL_INVALID_INPUT'].includes(error.code);
  return { ok: false, error: sharedMessage || (publicModelError ? error.message : '文字服务配置不可用'), code: error.code || 'MODEL_CLIENT_UNAVAILABLE', ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}), ...(error.receipt ? { receipt: error.receipt } : {}) };
}

export function createStudioAnalysisBridge({ send, subscribe, timeoutMs = 310000, visualTimeoutMs = WAIT_MINUTES * 60000 + 10000 }) {
  let sequence = 0;
  const pending = new Map();
  subscribe(message => {
    if (message?.type !== 'analysis-response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.ok) request.resolve(message.value);
    else request.reject(Object.assign(new Error(message.error || '文字服务不可用'), { code: message.code || 'MODEL_CLIENT_UNAVAILABLE', ...(message.httpStatus ? { httpStatus: message.httpStatus } : {}), ...(message.receipt ? { receipt: message.receipt } : {}) }));
  });
  return request => new Promise((resolve, reject) => {
    const id = String(++sequence);
    const visual = request.operation === 'execute-visual' || request.operation === 'public-visual-config';
    const wait = request.operation === 'public-config' || request.operation === 'public-visual-config' ? Math.min(timeoutMs, 15000) : visual ? visualTimeoutMs : timeoutMs;
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`${visual ? '画面' : '文字'}服务响应超时，请核查后明确重试；不会自动重发`), { code: 'MODEL_TIMEOUT' })); }, wait);
    pending.set(id, { resolve, reject, timer });
    try { send({ type: 'analysis-request', id, request }); }
    catch { clearTimeout(timer); pending.delete(id); reject(Object.assign(new Error('文字服务未连接'), { code: 'MODEL_CLIENT_UNAVAILABLE' })); }
  });
}
