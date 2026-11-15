import { readFile } from 'node:fs/promises';
import { providersFile as defaultProvidersFile, providerKey } from './keys.mjs';
import { transcribeProductSource } from './product-transcription.mjs';
import doubao from './providers/doubao.mjs';
import { serviceUrl } from './providers/common.mjs';
import { DEEPSEEK_TEXT_POLICY, DEEPSEEK_COMPOSITION_POLICY } from './text-structure.mjs';
export { createDeepSeekTextClient } from './text-structure.mjs';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const transcriptionInfo = { provider: 'doubao', name: '豆包录音转写', endpoint: ENDPOINT, model: 'volc.bigasr.auc_turbo' };

/** Normal desktop wiring. Construction and inspection never submit a service request. */
export function createDesktopAnalysisServices({ textBridge, providersFile = defaultProvidersFile, env = process.env, readAudio, runProvider, mediaReview, visualReview } = {}) {
  async function audioConfig() {
    let settings;
    try { settings = JSON.parse(await readFile(typeof providersFile === 'function' ? providersFile() : providersFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('转写设置无法读取'); settings = {}; }
    // Same key precedence/off semantics as Providers, without readSettings' permission changes.
    settings = { ...settings, keys: settings.keys ?? {}, off: settings.off ?? [] };
    const key = providerKey(doubao, settings, env)?.key;
    const enabled = settings.use?.asr === 'doubao' && !!key && (runProvider || serviceUrl('DOUBAO', ENDPOINT) === ENDPOINT);
    return { info: { ...transcriptionInfo, enabled: !!enabled, ...(!enabled ? { error: '请在设置的服务中选择豆包转写并配置密钥' } : {}) }, key };
  }
  const publicText = async () => await textBridge({ operation: 'public-config' });
  const identity = (config, purpose) => config ? { provider: 'deepseek', endpoint: `${config.baseUrl.replace(/\/$/, '')}/responses`, model: config.model, ...(purpose === 'curated-composition' ? DEEPSEEK_COMPOSITION_POLICY : DEEPSEEK_TEXT_POLICY), configurationId: config.id } : null;
  const modelClient = async ({ system, input, onReceipt, expectedIdentity, purpose }) => {
    const expectedConfig = await publicText();
    if (!expectedConfig) throw Object.assign(new Error('请在模型设置中选择一个直播文字分析模型'), { code: 'MODEL_CLIENT_UNAVAILABLE' });
    const currentIdentity = identity(expectedConfig, purpose);
    if (expectedIdentity && (Object.keys(expectedIdentity).length !== Object.keys(currentIdentity).length || Object.keys(currentIdentity).some(key => expectedIdentity[key] !== currentIdentity[key]))) throw Object.assign(new Error('文字模型配置已变化，请重新确认'), { code: 'MODEL_INPUT_CHANGED' });
    let result;
    try { result = await textBridge({ operation: 'execute', system, input, expectedConfig, ...(purpose ? { purpose } : {}) }); }
    catch (error) { if (error.receipt) await onReceipt?.(error.receipt); throw error; }
    if (result.receipt) await onReceipt?.(result.receipt);
    return result.value;
  };
  modelClient.getCacheIdentity = async ({ purpose } = {}) => identity(await publicText(), purpose);
  const transcribe = async (root, source, options = {}) => {
    const check = async () => {
      const current = await audioConfig();
      if (!current.info.enabled || (options.expectedService && ['provider', 'model', 'endpoint'].some(field => options.expectedService[field] !== current.info[field]))) throw Object.assign(new Error('转写服务配置已变化，音频未发送'), { code: 'ASR_NOT_SUBMITTED', reason: 'configuration' });
      return current.key;
    };
    await check();
    return transcribeProductSource(root, source, { retryUncertain: options.retryUncertain === true, getKey: check,
      ...(readAudio ? { readAudio } : {}), runProvider: async (...args) => { await check(); return (runProvider ?? doubao.run.bind(doubao))(...args); } });
  };
  return {
    sharedAnalysis: { coordinate: (action, body) => textBridge({ operation: 'shared-coordinate', action, body }) },
    // Product analysis no longer starts a separate image-model request. Saved
    // visual evidence remains readable; an injected adapter is for legacy callers.
    liveAnalysis: { transcribe, modelClient, mediaReview, ...(visualReview ? { visualReview } : {}) }, productDiscovery: { modelClient }, requireAnalysisPlan: true,
    analysisServices: async () => {
      const [audio, text] = await Promise.all([audioConfig().catch(() => ({ info: { ...transcriptionInfo, enabled: false, error: '转写设置无法读取' } })), publicText()]);
      return { transcription: audio.info, text: text ? { ...identity(text), name: 'DeepSeek 文字分析', enabled: true, configId: text.id, ...(text.pricing ? { pricing: text.pricing } : {}) } : { provider: 'deepseek', name: 'DeepSeek 文字分析', enabled: false, error: '请在模型设置中选择一个直播文字分析模型（多个模型时需明确选择）' } };
    },
  };
}
