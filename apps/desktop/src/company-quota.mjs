/** Quota decisions stay in main. ACP transports only IDs, model names and numeric receipts. */
import { randomUUID } from 'node:crypto';
import { reportedUsage } from './model-usage.mjs';
import { companyUsageEvent } from './company-usage.mjs';
const fault = (message, code = 'company-quota') => Object.assign(new Error(message), { code });
export const QUOTA_RESERVE = '_daocut/quota/reserve';
export const QUOTA_RELEASE = '_daocut/quota/release';
export const QUOTA_SETTLE = '_daocut/quota/settle';
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function parseQuotaReserve(input) {
  if (!uuid(input?.id) || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160
      || !Number.isSafeInteger(input.reservedTokens) || input.reservedTokens < 1) throw fault('模型额度请求格式不正确。');
  return { id: input.id, model: input.model, reservedTokens: input.reservedTokens };
}
export function parseQuotaRelease(input) {
  if (!uuid(input?.id) || input.reason !== 'not-sent') throw fault('额度释放请求格式不正确。');
  return { id: input.id, reason: 'not-sent' };
}
export function parseQuotaSettle(input) {
  const event = input?.event;
  if (!uuid(event?.id) || typeof event.model !== 'string' || !event.model.trim() || event.model.length > 160 || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw fault('模型用量回执格式不正确。');
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];
  if (fields.some(key => !Number.isSafeInteger(event[key]) || event[key] < 0)) throw fault('模型用量回执格式不正确。');
  // Reconstruct from numeric fields; never trust caller-supplied total, costs or extra payloads.
  const safe = companyUsageEvent({ answer: { model: event.model, usage: Object.fromEntries(fields.map(key => [key, event[key]])) } }, { id: event.id, at: event.at });
  if (event.incomplete === true) safe.incomplete = true;
  if (event.costs && typeof event.costs === 'object' && !Array.isArray(event.costs)) {
    const costs = Object.fromEntries(Object.entries(event.costs).filter(([currency, amount]) => /^[A-Z]{3}$/.test(currency) && Number.isFinite(amount) && amount >= 0));
    if (Object.keys(costs).length) safe.costs = costs;
  }
  return { event: safe };
}
export function createCompanyQuota({ client, usageReporter, log = () => {} }) {
  const capture = () => {
    const binding = client.sessionBinding();
    if (!binding) throw fault('请先登录公司账号。', 'company-auth-required');
    return binding;
  };
  const current = (identity) => {
    const actual = capture();
    if (!identity || actual.userId !== identity.userId || actual.serverUrl !== identity.serverUrl || actual.epoch !== identity.epoch)
      throw fault('公司账号或登录状态已改变，请重新开始任务。', 'company-quota-identity');
  };
  return {
    capture,
    async authorizeTask({ agent } = {}) {
      await client.assertSession();
      if (agent && agent !== 'byok') {
        const result = await client.quota(capture());
        if (result?.quota?.limited) throw fault('此账号已设置 Token 额度，请使用自行配置的 API 模型；其他智能体暂不支持额度限制。', 'company-quota-adapter');
      }
    },
    async reserve(input, identity) {
      current(identity);
      const result = await client.reserveQuota(parseQuotaReserve(input), identity);
      current(identity);
      if (result?.status !== 'reserved') throw fault('本次模型请求的额度未能预留，请重新发送。');
      return { id: result.id, status: result.status };
    },
    async release(input, identity) {
      current(identity);
      return client.releaseQuota(parseQuotaRelease(input).id, identity);
    },
    async settle(input, identity) {
      const { event } = parseQuotaSettle(input);
      // Persist against the request's original employee before any network operation.
      usageReporter.recordRequest(event, identity);
      try {
        current(identity);
        const result = await client.settleQuota(event, identity);
        usageReporter.acknowledgeRequest(event, identity);
        return { settled: result?.settled === true };
      } catch {
        log('company quota: receipt queued for the original employee; settlement will retry.\n');
        return { settled: false, queued: true };
      }
    },
  };
}


/** The existing one-image connectivity probe keeps its exact request and response. */
export function quotaProbeFetch(fetchImpl, quota, { appVersion } = {}) {
  if (!quota) return fetchImpl;
  return async (url, options) => {
    const body = JSON.parse(options.body), id = randomUUID(), at = new Date().toISOString(), identity = quota.capture();
    const { estimateTokens } = await import('@earendil-works/pi-coding-agent');
    const messages = (body.messages ?? body.input ?? []).map(message => ({ role: 'user', content: (message.content ?? []).map(block =>
      ['text', 'input_text'].includes(block.type) ? { type: 'text', text: block.text } : { type: 'image', data: '', mimeType: 'image/png' }) }));
    const maxOutput = body.max_output_tokens ?? body.max_tokens;
    const reservedTokens = Math.max(1, messages.reduce((sum, message) => sum + estimateTokens(message), 0) + maxOutput);
    options.signal?.throwIfAborted();
    await quota.reserve({ id, model: body.model, reservedTokens }, identity);
    if (options.signal?.aborted) {
      await quota.release({ id, reason: 'not-sent' }, identity).catch(() => {});
      options.signal.throwIfAborted();
    }
    const response = await fetchImpl(url, options);
    // Read a clone so probeModel continues to handle the untouched HTTP result itself.
    const result = await response.clone().json().catch(() => null), raw = result?.usage;
    let usage;
    if (raw && Number.isFinite(raw.prompt_tokens) && Number.isFinite(raw.completion_tokens)) {
      const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
      usage = { input: Math.max(0, raw.prompt_tokens - cacheRead), output: raw.completion_tokens, cacheRead, cacheWrite: 0, reasoning: raw.completion_tokens_details?.reasoning_tokens ?? 0 };
    } else if (raw && Number.isFinite(raw.input_tokens) && Number.isFinite(raw.output_tokens)) {
      const anthropic = String(url).endsWith('/messages');
      const cacheRead = anthropic ? (raw.cache_read_input_tokens ?? 0) : (raw.input_tokens_details?.cached_tokens ?? 0);
      usage = { input: Math.max(0, raw.input_tokens - (anthropic ? 0 : cacheRead)), output: raw.output_tokens,
        cacheRead, cacheWrite: raw.cache_creation_input_tokens ?? 0, reasoning: raw.output_tokens_details?.reasoning_tokens ?? 0 };
    }
    const answer = { model: result?.model ?? body.model, usage };
    if (reportedUsage(answer)) {
      const event = companyUsageEvent({ answer }, { id, at, model: body.model, appVersion });
      await quota.settle({ event }, identity).catch(() => {}); // uncertainty retains the server reservation
    }
    return response;
  };
}
