import { createDeepSeekTextClient } from 'daocut/analysis-services';
import { createProductVisionClient } from './product-vision-client.mjs';

/** Called only by the trusted Studio utility process; no credential-returning renderer IPC. */
export function createDesktopTextService({ roster, company = () => null, quota = () => null, fetch: fetchImpl = fetch, visualStream }) {
  return async message => {
    if (message?.operation === 'shared-coordinate') {
      const client = company();
      if (!client) throw Object.assign(new Error('请先配置并登录公司服务以使用共享分析'), { code: 'SHARED_COMPANY_UNAVAILABLE' });
      return client.sharedAnalysis(message.action, message.body);
    }
    if (message?.operation === 'public-config') return roster()?.analysisModel() ?? null;
    if (message?.operation === 'public-visual-config') return roster()?.visualModel() ?? null;
    if (message?.operation === 'execute-visual') return createProductVisionClient({
      getPublicConfig: async () => roster()?.visualModel() ?? null, getConfig: async () => roster()?.visualModel(true) ?? null,
      ...(fetchImpl !== globalThis.fetch ? { fetch: fetchImpl } : {}), ...(visualStream ? { stream: visualStream } : {}), quota,
    })(message);
    if (message?.operation !== 'execute' || typeof message.system !== 'string' || typeof message.input !== 'string') throw Object.assign(new Error('文字服务请求无效'), { code: 'MODEL_CLIENT_UNAVAILABLE' });
    const current = roster()?.analysisModel();
    if (!current || JSON.stringify(current) !== JSON.stringify(message.expectedConfig)) throw Object.assign(new Error('文字模型配置已变化，请重新确认'), { code: 'MODEL_INPUT_CHANGED' });
    let receipt = null;
    const client = createDeepSeekTextClient({ fetch: fetchImpl, purpose: message.purpose, getPublicConfig: async () => roster()?.analysisModel(), getConfig: async () => {
      if (JSON.stringify(roster()?.analysisModel()) !== JSON.stringify(message.expectedConfig)) throw Object.assign(new Error('文字模型配置已变化'), { code: 'MODEL_INPUT_CHANGED' });
      return roster()?.analysisModel(true);
    } });
    try {
      const value = await client({ system: message.system, input: message.input, onReceipt: value => { receipt = value; } });
      return { value, receipt };
    } catch (error) {
      if (receipt) error.receipt = receipt;
      throw error;
    }
  };
}
