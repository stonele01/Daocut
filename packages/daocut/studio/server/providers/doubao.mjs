// @ts-check
/** Doubao recorded-speech recognition with the person's Volcengine Speech API key. */
import { randomUUID } from 'node:crypto';
import { billedBy, needed, noBalance, serviceUrl } from './common.mjs';

const NAME = 'Doubao';
const MODEL = 'volc.bigasr.auc_turbo';
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
/** Keep the complete JSON response, except any echoed request secrets. The archive receives its own copy.
 * @param {unknown} value @param {string[]} secrets @returns {unknown} */
function archivedBody(value, secrets) {
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => archivedBody(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(archivedBody(key, secrets)), archivedBody(item, secrets)]));
  return value;
}
/** Convert only actual service timestamps, in milliseconds, to Daocut words in seconds.
 * @param {any} body @param {string | null} status */
export function doubaoResult(body, status) {
  if (status !== '20000000') throw new Error('Doubao did not report recognition success. Check Speech service access and balance. Not retried.');
  const result = body?.result;
  if (!result || typeof result.text !== 'string' || !Array.isArray(result.utterances)) throw new Error('Doubao returned no transcript or utterance timestamps.');
  const words = [];
  const rawWords = [];
  const cues = [];
  let cuesValid = result.utterances.length > 0;
  let previousCue = -1;
  const duration = body?.audio_info?.duration;
  let previous = -1;
  for (const line of result.utterances) {
    if (typeof line?.text !== 'string' || !line.text.trim() || !Number.isFinite(line.start_time) || !Number.isFinite(line.end_time) || line.start_time < 0 || line.end_time <= line.start_time || line.start_time < previousCue || (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && line.end_time > duration + 150)) cuesValid = false;
    else { cues.push({ text: line.text, startMs: line.start_time, endMs: line.end_time }); previousCue = line.start_time; }
    if (!Array.isArray(line?.words)) throw new Error('Doubao returned no word timestamps.');
    for (const w of line.words) {
      rawWords.push(w);
      if (!w || typeof w.text !== 'string' || !w.text.trim()) continue;
      if (typeof w.start_time !== 'number' || typeof w.end_time !== 'number') throw new Error('Doubao returned nonnumeric timestamps.');
      const start = w.start_time / 1000, end = w.end_time / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start < previous
        || (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && w.end_time > duration + 150)) throw new Error('Doubao returned invalid or out-of-range word timestamps.');
      words.push({ token: w.text, start, end });
      previous = start;
    }
  }
  // ITN can turn spoken words into numbers or symbols in result.text. Keep both service outputs as returned.
  if (!words.length) throw new Error('Doubao returned no word timestamps.');
  return { text: result.text, words, rawWords, cues: cuesValid ? cues : null };
}

/** @type {import('./contract.mjs').Provider} */
export default {
  id: 'doubao', name: NAME, env: 'DOUBAO_ASR_API_KEY', speechFormat: 'mp3',
  keysUrl: 'https://console.volcengine.com/speech/app',
  billingUrl: 'https://console.volcengine.com/finance/overview/',
  verbs: ['asr'], models: { asr: [{ id: MODEL, name: MODEL }] },
  async run(verb, args, ctx) {
    if (verb !== 'asr') throw new Error(`${NAME} does not do ${verb}.`);
    const src = needed(args, 'src');
    const bytes = Buffer.from(await ctx.read(src));
    if (!bytes.length || bytes.length >= 100_000_000) throw new Error('Doubao requires audio smaller than 100 MB. No audio was uploaded.');
    const requestId = typeof args.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(args.requestId) ? args.requestId : randomUUID();
    const send = () => fetch(serviceUrl('DOUBAO', ENDPOINT), {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(180_000)]),
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': ctx.key, 'X-Api-Resource-Id': MODEL, 'X-Api-Request-Id': requestId, 'X-Api-Sequence': '-1' },
        body: JSON.stringify({ user: { uid: 'daocut-local' }, audio: { data: bytes.toString('base64') }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, show_utterances: true } }),
      });
    let response;
    for (let attempt = 0; ; attempt++) {
      try { response = await send(); break; }
      catch (cause) {
        const code = cause?.cause?.code;
        const beforeConnection = ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
        if (attempt === 0 && beforeConnection && !ctx.signal.aborted) continue;
        const diagnostic = beforeConnection ? '连接服务失败（' + code + '）' : ctx.signal.aborted ? '客户端中止请求' : cause?.name === 'TimeoutError' ? '等待服务响应超时' : '网络请求中断' + (code === 'ECONNRESET' ? '（连接被重置）' : '');
        throw Object.assign(new Error(`Doubao was interrupted or timed out and may have charged. Check the console before retrying. Request id: ${requestId}. Not retried.`), { diagnostic });
      }
    }
    const status = response.headers.get('X-Api-Status-Code');
    let body;
    if (response.ok || ctx.onResponse) {
      try { body = await response.json(); }
      catch {
        if (response.ok) throw Object.assign(new Error(`Doubao response could not be read and may have charged. Check the console before retrying. Request id: ${requestId}. Not retried.`), { diagnostic: "服务回包未能完整读取" });
        // A non-JSON HTTP error still preserves the existing safe HTTP/balance error below.
      }
    }
    if (ctx.onResponse && body !== undefined) {
      // Await local persistence before validation. Propagate save errors unchanged; never resend a paid request.
      await ctx.onResponse({ provider: 'doubao', model: MODEL, requestId, httpStatus: response.status,
        serviceStatus: /** @type {string | null} */ (archivedBody(status, [ctx.key, bytes.toString('base64')])),
        body: archivedBody(body, [ctx.key, bytes.toString('base64')]) });
    }
    if (!response.ok) {
      if (response.status === 402) throw Object.assign(noBalance(NAME), { diagnostic: '服务返回 HTTP 402（余额或计费问题）' });
      throw Object.assign(new Error(`Doubao HTTP ${response.status}. Use a Volcengine Speech API key with flash recognition access (not an Ark chat key), and check the balance. Request id: ${requestId}. Not retried.`), { diagnostic: "服务返回 HTTP " + response.status });
    }
    let result;
    try { result = doubaoResult(body, status); } catch (error) { throw Object.assign(error, { diagnostic: status === "20000000" ? "服务回包缺少有效转写或时间戳" : "服务未返回成功状态" + (/^\d{8}$/.test(status ?? "") ? "（" + status + "）" : "") }); }
    return { files: [], index: [{ src, ...result, transcribed: true }],
      receipt: { provider: 'doubao', model: MODEL, src, text: result.text, words: result.words.length, requestId }, cost: billedBy(NAME) };
  },
};
