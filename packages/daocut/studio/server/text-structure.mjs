import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export const TEXT_STRUCTURE_VERSION = 'text-structure-v2';
export const TEXT_STRUCTURE_TAGS = ['钩子', '故事', '痛点', '卖点', '产品演示', '福利机制', '信任背书', '价格锚点', '行动指令', '逼单'];
export const COMPLETE_SPEECH_SCHEMA = 'complete-speech-v1';
export const TEXT_STRUCTURE_WINDOW_VERSION = 'cue-byte-windows-v1';
export function textStructureWindowPolicy({ maxInputBytes = 32768, contextCues = 2 } = {}) {
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 256 || !Number.isInteger(contextCues) || contextCues < 0 || contextCues > 20) throw failure('MODEL_INPUT_TOO_LARGE', '文字窗口预算或上下文设置无效');
  return { version: TEXT_STRUCTURE_WINDOW_VERSION, maxInputBytes, contextCues };
}
const failure = (code, message) => Object.assign(new Error(message), { code });
// Preserve cue text verbatim; insert a separator only between adjacent Latin words.
const joinCueText = lines => lines.reduce((text, line) => text + (/[A-Za-z]$/.test(text) && /^[A-Za-z]/.test(line.text) ? ' ' : '') + line.text, '');
const reference = await readFile(new URL('./text-structure-reference.txt', import.meta.url), 'utf8');
export const TEXT_STRUCTURE_PROMPT = `本次只提供原片时间基准的 ASR，没有音频和画面。不得标产品演示、原音或画面证据；演示口述只能记为待核实线索。只分析选中商品的一次讲解，不跨返场，不组合或生成成片。
返回机器可读取的 JSON：{"schema":"${COMPLETE_SPEECH_SCHEMA}","candidates":[{"firstCue":0,"lastCue":1,"tags":["痛点","卖点"]}],"issues":[]}。普通完整片段只需 firstCue、lastCue、tags，不输出原话、时间戳、说明报告或 details。必要时增加 conditions（活动/规格等已明确条件的键值）或 review（该片段未解决的问题数组）。索引为输入 cue 零基序号且包含两端；原话、来源、时间、coverage 由程序从输入恢复，不得猜测。
以最小完整表达为单位。必要上下文连续时一起圈入同一范围，不额外说明依赖；痛点与卖点必须连起来才能听懂时保留为一块并标多个作用。真正能独立表达的分别保留，不把整次讲解包成大段。必要内容不连续、当前窗口外或仍无法确认时填 review，不假装已经独立完整，也不编造窗口外索引。只能使用输入 cue 边界，不按字数估算毫秒。
除逼单外的完整话术均可供程序选作开头，不要求先有“钩子”标签，不因不是典型钩子而漏掉素材。福利机制包含价格对比、报价、套餐、买赠与适用条件。完整卖点的不同原话都保留，不要求模型建立核心卖点类别编号。\n判断规则：\n${reference}`;

/** No configuration or secret is read until a caller invokes the returned client. */
export function createDeepSeekTextClient({ getConfig, getPublicConfig, fetch: fetchImpl, timeoutMs = 180000 }) {
  if (typeof getConfig !== 'function' || typeof fetchImpl !== 'function') throw new Error('需要注入配置读取器和 fetch');
  // This reader must contain public configuration only. In particular, GET state
  // inspection must never call getConfig, which may decrypt stored credentials.
  const publicIdentity = value => {
    if (!value || typeof value.model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(value.model)) return null;
    let url;
    try { url = new URL(value.baseUrl); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.username || url.password || url.port || !['/', '/v1', '/v1/'].includes(url.pathname) || url.search || url.hash) return null;
    return { provider: 'deepseek', endpoint: `${url.origin}${url.pathname.replace(/\/$/, '')}/responses`, model: value.model, maxOutputTokens: 16384, reasoningEffort: 'low' };
  };
  const client = async ({ system, input, onReceipt }) => {
    let config;
    try { config = await getConfig(); } catch { throw Object.assign(new Error('DeepSeek 模型配置不可用'), { code: 'MODEL_CLIENT_UNAVAILABLE' }); }
    if (!config || typeof config.apiKey !== 'string' || !config.apiKey.trim() || typeof config.model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(config.model)) throw Object.assign(new Error('DeepSeek 模型配置不可用'), { code: 'MODEL_CLIENT_UNAVAILABLE' });
    let url;
    try { url = new URL(config.baseUrl); } catch { throw Object.assign(new Error('DeepSeek 地址无效'), { code: 'MODEL_CLIENT_UNAVAILABLE' }); }
    if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com' || url.username || url.password || url.port || !['/', '/v1', '/v1/'].includes(url.pathname) || url.search || url.hash) throw Object.assign(new Error('DeepSeek 地址无效'), { code: 'MODEL_CLIENT_UNAVAILABLE' });
    const endpoint = `${url.origin}${url.pathname.replace(/\/$/, '')}/responses`;
    if (typeof getPublicConfig === 'function' && JSON.stringify(publicIdentity(await getPublicConfig())) !== JSON.stringify(publicIdentity(config))) throw failure('MODEL_INPUT_CHANGED', '模型公开配置与执行配置不一致');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('MODEL_TIMEOUT', '模型请求超时')); }, timeoutMs); });
    try {
      const transport = (async () => {
        let response;
        try {
          response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, max_output_tokens: 16384, reasoning: { effort: 'low' }, input: [{ role: 'system', content: system }, { role: 'user', content: input }] }) });
        } catch (error) { throw controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError' ? failure('MODEL_TIMEOUT', '模型请求超时') : failure('MODEL_NETWORK', '模型网络请求失败'); }
        if (!response.ok) throw Object.assign(failure('MODEL_HTTP', '模型服务返回 HTTP 错误'), { httpStatus: Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : null });
        let body;
        try { body = await response.json(); } catch { throw controller.signal.aborted ? failure('MODEL_TIMEOUT', '模型请求超时') : failure('MODEL_INVALID_JSON', '模型响应 JSON 无效'); }
        if (controller.signal.aborted) throw failure('MODEL_TIMEOUT', '模型请求超时');
        const usage = Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens'].filter(key => Number.isFinite(body.usage?.[key]) && body.usage[key] >= 0).map(key => [key, body.usage[key]]));
        await onReceipt?.({ provider: 'deepseek', model: config.model, endpoint, requestId: typeof body.id === 'string' ? body.id.slice(0, 200) : null, httpStatus: response.status ?? 200, status: body.status === 'completed' ? 'completed' : 'incomplete', usage });
        if (body.status !== 'completed') throw failure('MODEL_INCOMPLETE', '模型响应未完成或达到输出上限');
        const text = (body.output ?? []).flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text).join('');
        try { return JSON.parse(text); } catch { throw failure('MODEL_INVALID_JSON', '模型输出 JSON 无效'); }
      })();
      return await Promise.race([transport, timeout]);
    } finally { clearTimeout(timer); }
  };
  client.getCacheIdentity = async () => typeof getPublicConfig === 'function' ? publicIdentity(await getPublicConfig()) : null;
  return client;
}

function validateInput({ sourceId, productId, intervalId, cues, rangeStartMs, rangeEndMs }) {
  if (![sourceId, productId, intervalId].every(x => typeof x === 'string' && x) || !Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeStartMs >= rangeEndMs || !Array.isArray(cues) || !cues.length) throw new Error('无效的来源、讲解范围或 ASR');
  for (const [index, cue] of cues.entries()) {
    if (typeof cue.text !== 'string' || !cue.text || !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < rangeStartMs || cue.endMs > rangeEndMs || cue.startMs >= cue.endMs || (index && cue.startMs < cues[index - 1].startMs)) throw new Error('ASR 时间或内容无效，不能静默截断');
  }
}

/** Budget the actual UTF-8 prompt and input, without guessing token counts or cutting a cue. */
export function textStructureWindows({ sourceId, productId, intervalId, cues, rangeStartMs, rangeEndMs, prompt = TEXT_STRUCTURE_PROMPT, maxInputBytes, contextCues }) {
  validateInput({ sourceId, productId, intervalId, cues, rangeStartMs, rangeEndMs });
  const policy = textStructureWindowPolicy({ maxInputBytes, contextCues });
  const fixed = Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(JSON.stringify({ sourceId, productId, intervalId, rangeStartMs, rangeEndMs, cues: [] }), 'utf8');
  const sizes = cues.map(cue => Buffer.byteLength(JSON.stringify(cue), 'utf8'));
  if (sizes.some(size => fixed + size > policy.maxInputBytes)) throw failure('MODEL_INPUT_TOO_LARGE', '单条字幕与提示词超出文字窗口预算，请先检查字幕边界');
  const windows = [];
  for (let first = 0; first < cues.length;) {
    let end = first, bytes = fixed;
    while (end < cues.length && bytes + sizes[end] + (end > first ? 1 : 0) <= policy.maxInputBytes) {
      bytes += sizes[end] + (end > first ? 1 : 0); end++;
    }
    if (end === first) throw failure('MODEL_INPUT_TOO_LARGE', '文字窗口预算不足');
    windows.push({ index: windows.length, firstCue: first, lastCue: end - 1, cues: cues.slice(first, end), bytes });
    if (end === cues.length) break;
    first = Math.max(first + 1, end - policy.contextCues);
  }
  return windows;
}

function mergeCompleteSpeechDuplicate(previous, candidate) {
  const left = previous.details?.composition, right = candidate.details?.composition;
  const leftCompact = left?.contract === COMPLETE_SPEECH_SCHEMA, rightCompact = right?.contract === COMPLETE_SPEECH_SCHEMA;
  if (!leftCompact && !rightCompact) return; // Keep legacy reuse unchanged.
  const problems = [], conditions = { ...(left?.conditions ?? {}) };
  for (const [key, value] of Object.entries(right?.conditions ?? {})) {
    if (Object.hasOwn(conditions, key) && conditions[key] !== value) problems.push(`条件 ${key} 在分窗结果中冲突（${JSON.stringify(conditions[key])} / ${JSON.stringify(value)}）`);
    else conditions[key] = value;
  }
  if (!leftCompact || !rightCompact) problems.push('同一范围的分窗结果完整性标记不一致，请核对后使用');
  previous.details = { ...previous.details,
    review: [...new Set([...(previous.details?.review ?? []), ...(candidate.details?.review ?? []), ...problems])],
    composition: { ...(leftCompact ? left : right), conditions,
      status: !problems.length && left?.status === 'confirmed' && right?.status === 'confirmed' ? 'confirmed' : 'pending' } };
}

export function combineTextStructureWindows({ outputs, sourceId, intervalId, cues, version = TEXT_STRUCTURE_VERSION }) {
  const candidates = [], seen = new Map();
  for (const [windowIndex, output] of outputs.entries()) for (const candidate of output.candidates) {
    const key = JSON.stringify([candidate.sourceId, candidate.productId, candidate.intervalId, candidate.cueRange, [...candidate.tags].sort()]);
    const previous = seen.get(key);
    if (previous) { previous.windowIndices.push(windowIndex); mergeCompleteSpeechDuplicate(previous, candidate); continue; }
    const next = { ...structuredClone(candidate), windowIndices: [windowIndex] };
    seen.set(key, next); candidates.push(next);
  }
  candidates.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const completeSpeech = outputs.some(output => output.schema === COMPLETE_SPEECH_SCHEMA) || candidates.some(candidate => candidate.details?.composition?.contract === COMPLETE_SPEECH_SCHEMA);
  return { ...(completeSpeech ? { schema: COMPLETE_SPEECH_SCHEMA } : {}), candidates, coverage: [{ sourceId, intervalId, asrRanges: cues.map(cue => [cue.startMs, cue.endMs]), audioRanges: [], videoRanges: [] }], issues: [...new Set(outputs.flatMap(output => output.issues))], version };
}

const roleForTag = { 钩子: 'hook', 故事: 'story', 痛点: 'pain', 卖点: 'core', 产品演示: 'display', 福利机制: 'offer', 价格锚点: 'offer', 信任背书: 'trust', 行动指令: 'purchase', 逼单: 'purchase' };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
function completeSpeechDetails(item, tags, lines) {
  const conditions = item.conditions ?? {}, review = item.review ?? [];
  if (!record(conditions) || Object.values(conditions).some(value => !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) || !strings(review)) throw failure('MODEL_CONSTRAINT', '模型结果违反格式或来源约束');
  const roles = [...new Set(tags.map(tag => roleForTag[tag]))];
  const identity = createHash('sha256').update(JSON.stringify([Math.min(...lines.map(c => c.startMs)), Math.max(...lines.map(c => c.endMs)), joinCueText(lines)])).digest('hex').slice(0, 24);
  return { subtypes: [], reason: '完整话术范围', evidence: ['ASR'], context: '', repetition: '', review: [...review],
    composition: { contract: COMPLETE_SPEECH_SCHEMA, status: review.length ? 'pending' : 'confirmed', roles, coreIds: roles.includes('core') ? [`speech-${identity}`] : [], requires: [], conditions: { ...conditions }, excludes: [] } };
}

/** The caller supplies a model client; this module does not access credentials or persist data. */
export async function analyzeTextStructure({ sourceId, productId, intervalId, cues, rangeStartMs, rangeEndMs, client, prompt = TEXT_STRUCTURE_PROMPT, version = TEXT_STRUCTURE_VERSION, cueIndexOffset = 0 }) {
  if (typeof client !== 'function') throw Object.assign(new Error('文字分析需要可用的模型客户端'), { code: 'MODEL_CLIENT_UNAVAILABLE' });
  validateInput({ sourceId, productId, intervalId, cues, rangeStartMs, rangeEndMs });
  if (!Number.isInteger(cueIndexOffset) || cueIndexOffset < 0) throw new Error('无效字幕索引偏移');
  const response = await client({ system: prompt, input: JSON.stringify({ sourceId, productId, intervalId, rangeStartMs, rangeEndMs, cues }) });
  if (!response || response.truncated || (response.schema !== undefined && response.schema !== COMPLETE_SPEECH_SCHEMA) || !Array.isArray(response.candidates) || !Array.isArray(response.issues) || response.issues.some(x => typeof x !== 'string')) throw failure('MODEL_CONSTRAINT', '模型结果违反格式或来源约束');
  const completeSpeech = response.schema === COMPLETE_SPEECH_SCHEMA;
  const candidates = response.candidates.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw failure('MODEL_CONSTRAINT', '模型结果违反格式或来源约束');
    const { firstCue, lastCue } = item;
    if (!Number.isInteger(firstCue) || !Number.isInteger(lastCue) || firstCue < 0 || lastCue < firstCue || lastCue >= cues.length || !Array.isArray(item.tags) || !item.tags.length || item.tags.some(t => !TEXT_STRUCTURE_TAGS.includes(t) || t === '产品演示')) throw failure('MODEL_CONSTRAINT', '模型结果违反格式或来源约束');
    const lines = cues.slice(firstCue, lastCue + 1);
    const tags = completeSpeech ? item.tags.map(tag => tag === '价格锚点' ? '福利机制' : tag === '逼单' ? '行动指令' : tag) : item.tags;
    const details = completeSpeech ? completeSpeechDetails(item, tags, lines) : item.details;
    if (!details || !strings(details.subtypes) || typeof details.reason !== 'string' || !details.reason.trim() || !Array.isArray(details.evidence) || details.evidence.length !== 1 || details.evidence[0] !== 'ASR' || typeof details.context !== 'string' || typeof details.repetition !== 'string' || !strings(details.review)) throw failure('MODEL_CONSTRAINT', '模型结果违反格式或来源约束');
    return { id: randomUUID(), sourceId, productId, intervalId, startMs: Math.min(...lines.map(c => c.startMs)), endMs: Math.max(...lines.map(c => c.endMs)), text: joinCueText(lines), tags: [...new Set(tags)], origin: 'ai-text', version, details: { ...details, review: [...new Set([...details.review, '仅依据 ASR；画面、声音和句级边界待核实'])] }, cueRange: [firstCue + cueIndexOffset, lastCue + cueIndexOffset] };
  });
  candidates.sort((a, b) => a.startMs - b.startMs);
  const compactOutput = completeSpeech || candidates.some(candidate => candidate.details?.composition?.contract === COMPLETE_SPEECH_SCHEMA);
  return { ...(compactOutput ? { schema: COMPLETE_SPEECH_SCHEMA } : {}), candidates, coverage: [{ sourceId, intervalId, asrRanges: cues.map(c => [c.startMs, c.endMs]), audioRanges: [], videoRanges: [] }], issues: [...response.issues, '未检查原音及画面'], version };
}
