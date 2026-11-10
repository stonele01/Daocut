/** A single scoped picture review through the same Pi model runtime used by the conversation. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fetch as undiciFetch } from 'undici';
import { IMAGE_BUDGET, WAIT_MINUTES, THINKING, modelsJson, providerOf } from './pi-config.mjs';
import { createModelDispatcher, networkFetch } from './pi-network.mjs';
import { quotaStream } from './pi-quota.mjs';
import { QUOTA_RESERVE, QUOTA_SETTLE, QUOTA_RELEASE } from './company-quota.mjs';
import { modelPricing, reportedUsage } from './model-usage.mjs';

const fault = (message, code) => Object.assign(new Error(message), { code });
const same = isDeepStrictEqual;
let dispatcher;
const transport = (input, init) => undiciFetch(input, { ...init, dispatcher: dispatcher ??= createModelDispatcher(WAIT_MINUTES * 60000) });

async function configuredRuntime(config) {
  // An in-memory runtime never reads or modifies the conversation's auth, history or model catalog files.
  const credentials = { read: async () => undefined, list: async () => [], modify: async () => { throw Error('read-only credentials'); }, delete: async () => {} };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const own = { ...config, levels: config.levels ?? [config.effort ?? 'auto'], keyEnv: 'DAOCUT_SCOPED_VISUAL_KEY' };
  const provider = config.effort === 'auto' ? providerOf(config.id) : THINKING(providerOf(config.id));
  const entry = modelsJson([own]).providers[provider];
  if (!entry) throw fault('画面模型配置不可用，请核对现有对话模型设置', 'MODEL_CLIENT_UNAVAILABLE');
  runtime.registerProvider(provider, { ...entry, apiKey: config.apiKey });
  const model = runtime.getModel(provider, config.model);
  if (!model) throw fault('画面模型配置不可用，请核对现有对话模型设置', 'MODEL_CLIENT_UNAVAILABLE');
  return { model, stream: runtime.streamSimple.bind(runtime) };
}

/** Credentials stay in main. Caller persists value/receipt before validating the model's JSON. */
export function createProductVisionClient({ getPublicConfig, getConfig, stream: injectedStream, fetch: fetchImpl = transport, quota = () => null, timeoutMs = WAIT_MINUTES * 60000 } = {}) {
  return async ({ system, input, images, expectedConfig }) => {
    if (typeof system !== 'string' || typeof input !== 'string' || !Array.isArray(images) || !images.length || images.some(image => image?.type !== 'image' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) || typeof image.data !== 'string' || !image.data.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) || images.reduce((sum, image) => sum + image.data.length, 0) > IMAGE_BUDGET) throw fault('画面核查图片或文字输入无效，未发送请求', 'MODEL_INVALID_INPUT');
    const publicConfig = await getPublicConfig();
    if (!publicConfig) throw fault('请先配置可看图的对话模型，画面核查未发送', 'MODEL_CLIENT_UNAVAILABLE');
    if (!same(publicConfig, expectedConfig)) throw fault('画面模型配置已变化，请重新确认', 'MODEL_INPUT_CHANGED');
    const config = await getConfig();
    const { apiKey, ...confirmed } = config ?? {};
    if (!apiKey || !same(publicConfig, confirmed)) throw fault('画面模型配置已变化，请重新确认', 'MODEL_INPUT_CHANGED');
    const { model, stream: sdkStream } = await configuredRuntime(config);
    const context = { systemPrompt: system, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: input }, ...images.map(({ type, data, mimeType }) => ({ type, data, mimeType }))], timestamp: Date.now() }] };
    const receipt = { requestId: randomUUID(), model: config.model, submitted: false, usageKnown: false, stopReason: 'pending' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref?.();
    let sent = false;
    const options = { apiKey, maxTokens: model.maxTokens, maxRetries: 0, toolChoice: 'none', signal: controller.signal,
      ...(config.effort !== 'auto' ? { reasoning: config.effort } : {}),
      fetch: networkFetch(async (url, init) => {
        if (sent) throw fault('本段画面请求已提交，未自动重发，请先核查原请求', 'MODEL_ALREADY_SUBMITTED');
        if (!same(await getPublicConfig(), publicConfig)) throw fault('画面模型配置已变化，请重新确认', 'MODEL_INPUT_CHANGED');
        controller.signal.throwIfAborted(); sent = true; receipt.submitted = true;
        return fetchImpl(url, { ...init, signal: controller.signal });
      }, () => {}),
    };
    try {
      const quotaService = typeof quota === 'function' ? quota() : quota;
      const identity = quotaService?.capture();
      const client = { request: (method, body) => method === QUOTA_RESERVE ? quotaService.reserve(body, identity) : method === QUOTA_SETTLE ? quotaService.settle(body, identity) : method === QUOTA_RELEASE ? quotaService.release(body, identity) : Promise.reject(Error('Unknown quota method')) };
      const stream = quotaStream(injectedStream ?? sdkStream, { client, enabled: Boolean(quotaService), pricing: () => modelPricing(config.pricing),
        onRequest: request => { receipt.quotaRequestId = request.id; }, onWarning: () => { receipt.quotaSyncPending = true; } });
      const response = await stream(model, context, options);
      const answer = await response.result();
      const redact = text => String(text).replaceAll(apiKey, '[redacted]');
      const rawText = (answer.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      receipt.rawText = redact(rawText);
      if (typeof answer.responseId === 'string' && answer.responseId.length <= 256) receipt.requestId = redact(answer.responseId);
      receipt.stopReason = ['stop', 'length', 'toolUse', 'error', 'aborted', 'pending'].includes(answer.stopReason) ? answer.stopReason : 'error';
      const usage = reportedUsage(answer);
      if (usage) { receipt.usageKnown = true; receipt.usage = usage; }
      if (answer.stopReason !== 'stop' || (answer.content ?? []).some(block => block.type === 'toolCall')) throw fault(answer.stopReason === 'error' || answer.stopReason === 'aborted' ? '画面模型请求未完成，结果或费用可能不完整；已保留回执，不会自动重发' : '画面模型输出未完整结束，已保留原始返回及费用回执；请核对后恢复', controller.signal.aborted ? 'MODEL_TIMEOUT' : answer.stopReason === 'error' || answer.stopReason === 'aborted' ? 'MODEL_NETWORK' : 'MODEL_INCOMPLETE');
      return { value: receipt.rawText, receipt };
    } catch (error) {
      const known = ['MODEL_INPUT_CHANGED', 'MODEL_CLIENT_UNAVAILABLE', 'MODEL_INCOMPLETE', 'MODEL_NETWORK', 'MODEL_TIMEOUT'].includes(error.code) || String(error.code ?? '').startsWith('company-');
      const safe = known ? error : fault(controller.signal.aborted ? '画面模型响应超时，请核查原请求后明确重试；不会自动重发' : '画面模型请求未完成，请核查原请求与费用；不会自动重发', controller.signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK');
      safe.receipt = receipt; throw safe;
    } finally { clearTimeout(timer); }
  };
}
