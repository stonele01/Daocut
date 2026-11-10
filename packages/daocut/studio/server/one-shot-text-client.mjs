import { readFile } from 'node:fs/promises';
import { createDeepSeekTextClient, TEXT_STRUCTURE_PROMPT } from './text-structure.mjs';
import { deepSeekConfigFromV10 } from './deepseek-v10-config.mjs';

// Source identity is established by getAuthorizedInput, not by this module or the input IDs.
export function createOneShotTextClient({ enabled, getAuthorizedInput, paths, unprotect, fetch: fetchImpl, readFile: read = readFile }) {
  if (enabled !== true) return null;
  if (typeof getAuthorizedInput !== 'function' || typeof unprotect !== 'function' || typeof fetchImpl !== 'function' || typeof read !== 'function' || !paths || !['localState', 'agents', 'sealedKeys'].every(k => typeof paths[k] === 'string' && paths[k])) throw new Error('一次性文字分析配置不可用');
  let used = false;
  return async ({ system, input }) => {
    if (used) throw new Error('一次性文字分析已使用');
    used = true;
    try {
      if (system !== TEXT_STRUCTURE_PROMPT || typeof input !== 'string') throw Error();
      const actual = JSON.parse(input);
      let expected;
      try { expected = await getAuthorizedInput(); } catch { throw Object.assign(new Error('本地授权输入已变化或不可读取'), { code: 'MODEL_INPUT_CHANGED' }); }
      const fields = ['sourceId', 'productId', 'intervalId', 'rangeStartMs', 'rangeEndMs'];
      if (!expected || !actual || fields.some(k => actual[k] !== expected[k]) || !Array.isArray(actual.cues) || !Array.isArray(expected.cues) || actual.cues.length !== expected.cues.length) throw Object.assign(new Error(), { code: 'MODEL_INPUT_CHANGED' });
      if (actual.cues.some((cue, i) => !cue || !expected.cues[i] || cue.text !== expected.cues[i].text || cue.startMs !== expected.cues[i].startMs || cue.endMs !== expected.cues[i].endMs || Object.keys(cue).sort().join() !== Object.keys(expected.cues[i]).sort().join() || Object.keys(cue).some(k => !['text', 'startMs', 'endMs'].includes(k)))) throw Object.assign(new Error(), { code: 'MODEL_INPUT_CHANGED' });
      if (Object.keys(actual).sort().join() !== [...fields, 'cues'].sort().join()) throw Error();
      const client = createDeepSeekTextClient({ fetch: fetchImpl, getConfig: async () => {
        const [localState, agents, sealedKeys] = await Promise.all([read(paths.localState, 'utf8'), read(paths.agents, 'utf8'), read(paths.sealedKeys)]);
        return deepSeekConfigFromV10({ localState, agents, sealedKeys, unprotect });
      } });
      return await client({ system, input });
    } catch (error) {
      const allowed = { MODEL_TIMEOUT: '模型请求超时', MODEL_NETWORK: '模型网络请求失败', MODEL_HTTP: '模型服务返回 HTTP 错误', MODEL_INCOMPLETE: '模型响应未完成或达到输出上限', MODEL_INVALID_JSON: '模型输出 JSON 无效', MODEL_INPUT_CHANGED: '本地授权输入已变化或不可读取' };
      const code = Object.hasOwn(allowed, error?.code) ? error.code : 'MODEL_CLIENT_UNAVAILABLE';
      throw Object.assign(new Error(allowed[code] ?? '一次性文字分析不可用'), { code }, code === 'MODEL_HTTP' && Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {});
    }
  };
}
