/** Personal source edits belong to the project, separately from AI candidates and the finished film. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { probe } from './derived.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { productSourcePath } from './product-transcription.mjs';

export const SOURCE_TAKES_FILE = '.film/source-takes.json';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = message => { throw new HttpError(400, `取用片段：${message}`); };
const conflict = message => { throw new HttpError(409, `取用片段：${message}`); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function validateDocument(document) {
  if (!record(document) || document.version !== 1 || !text(document.sourceId) || !text(document.assetPath) || !text(document.signature)
    || !finite(document.durationMs) || document.durationMs <= 0 || !record(document.film) || !Array.isArray(document.film.tracks)) fail('保存内容无效。');
  let signature;
  try { signature = JSON.parse(document.signature); } catch { fail('取用基线无法读取。'); }
  if (!Array.isArray(signature) || signature.length !== 3 || signature[0] !== document.assetPath || signature[1] !== document.durationMs || !Array.isArray(signature[2])) fail('取用基线与素材不一致。');
  const rangeIds = new Set();
  for (const range of signature[2]) {
    if (!Array.isArray(range) || range.length !== 3 || !text(range[0]) || rangeIds.has(range[0]) || !finite(range[1]) || !finite(range[2])
      || range[1] < 0 || range[2] <= range[1] || range[2] > document.durationMs) fail('取用基线的候选身份或时间无效。');
    rangeIds.add(range[0]);
  }
  const ids = new Set();
  for (const track of document.film.tracks) {
    if (!record(track) || !Array.isArray(track.clips)) fail('轨道无效。');
    if (track.attrs !== undefined && (!record(track.attrs) || Object.values(track.attrs).some(value => typeof value !== 'string'))) fail('轨道属性无效。');
    for (const clip of track.clips) {
      if (!record(clip) || !text(clip.id) || ids.has(clip.id) || clip.src !== document.assetPath || !Array.isArray(clip.time)
        || clip.time.length !== 2 || !clip.time.every(finite) || clip.time[0] < 0 || clip.time[1] <= clip.time[0]
        || clip.time[1] * 1000 > document.durationMs + 0.001 || !finite(clip.at) || Math.abs(clip.at - clip.time[0]) > 0.000001) fail('片段身份、素材或原片时间无效。');
      if (clip.attrs !== undefined && (!record(clip.attrs) || Object.values(clip.attrs).some(value => typeof value !== 'string'))) fail('片段属性无效。');
      ids.add(clip.id);
    }
  }
  return document;
}

async function readCollection(root) {
  let value;
  try { value = JSON.parse(await readFile(join(root, SOURCE_TAKES_FILE), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sources: [] };
    conflict('工程中的取用文件无法读取，未覆盖原记录。');
  }
  try {
    if (!record(value) || value.version !== 1 || !Array.isArray(value.sources)) throw new Error('schema');
    const seen = new Set();
    for (const saved of value.sources) {
      if (!record(saved) || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || !text(saved.sourceIdentity)) throw new Error('entry');
      validateDocument(saved.document);
      if (seen.has(saved.document.sourceId)) throw new Error('duplicate');
      seen.add(saved.document.sourceId);
    }
  } catch { conflict('工程中的取用文件格式无效，未覆盖原记录。'); }
  return value;
}

async function sourceVersion(root, sourceId, assetPath) {
  if (!text(sourceId) || (assetPath !== undefined && !text(assetPath))) fail('缺少有效的素材身份。');
  const { analysis } = await readProductAnalysis(root);
  const source = analysis.sources.find(item => item.id === sourceId);
  if (source && assetPath !== undefined && source.assetPath !== assetPath) conflict('素材路径已改变，请重新打开素材。');
  const path = source?.assetPath ?? assetPath ?? sourceId;
  let info;
  try { info = await stat(await productSourcePath(root, path)); }
  catch { conflict('原片当前不可读取，保留已有取用记录。'); }
  if (!info.isFile()) fail('原片必须是文件。');
  // Relative path plus size/mtime travels with a project; browser origins and absolute project paths do not.
  const sourceIdentity = digest({ sourceId, assetPath: path, size: info.size, mtimeMs: info.mtimeMs });
  return { assetPath: path, sourceIdentity, durationMs: source?.durationMs ?? null };
}

export async function readSourceTakes(root, sourceId, assetPath) {
  const value = await readCollection(root);
  const source = await sourceVersion(root, sourceId, assetPath);
  const saved = value.sources.find(item => item.document.sourceId === sourceId);
  if (saved && (saved.sourceIdentity !== source.sourceIdentity || saved.document.assetPath !== source.assetPath)) conflict('原片已改变，旧取用记录未复用也未覆盖。');
  if (saved && source.durationMs !== null && Math.abs(saved.document.durationMs - source.durationMs) > 1) conflict('原片时长已改变，旧取用记录未复用也未覆盖。');
  return saved ?? { revision: 0, sourceIdentity: source.sourceIdentity, document: null };
}

const writes = new Map();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Serialize all sources in this project; revisions are independent for each source. */
export async function writeSourceTakes(root, sourceId, input) {
  if (!record(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !text(input.sourceIdentity)) fail('保存缺少读取版本。');
  const document = structuredClone(validateDocument(input.document));
  if (document.sourceId !== sourceId) fail('请求素材与取用记录不一致。');
  const key = resolve(root);
  const pending = writes.get(key) ?? Promise.resolve();
  const write = pending.catch(() => {}).then(async () => {
    const collection = await readCollection(root);
    const source = await sourceVersion(root, sourceId, document.assetPath);
    if (source.sourceIdentity !== input.sourceIdentity) conflict('原片在编辑期间已改变，未覆盖取用记录。');
    const previous = collection.sources.find(item => item.document.sourceId === sourceId);
    if (previous && previous.sourceIdentity !== source.sourceIdentity) conflict('原片已改变，旧取用记录未覆盖。');
    // A response may be lost after a successful write. Retrying the identical document is a read, not another edit.
    if (previous && JSON.stringify(canonical(previous.document)) === JSON.stringify(canonical(document)) && input.expectedRevision <= previous.revision) return previous;
    if ((previous?.revision ?? 0) !== input.expectedRevision) conflict('其他窗口已保存新修改，请重新读取后再保存。');
    const durationMs = source.durationMs ?? Math.round((await probe(root, source.assetPath)).duration * 1000);
    if (!finite(durationMs) || durationMs <= 0 || Math.abs(document.durationMs - durationMs) > 1) fail('取用时长与原片不一致。');
    const dir = dirname(join(root, SOURCE_TAKES_FILE));
    await mkdir(dir, { recursive: true });
    const base = await realpath(root), actual = await realpath(dir), rel = relative(base, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) conflict('取用记录必须保存在本机工程内。');
    if ((await sourceVersion(root, sourceId, document.assetPath)).sourceIdentity !== source.sourceIdentity) conflict('保存期间原片已改变，未写入取用记录。');
    const saved = { revision: (previous?.revision ?? 0) + 1, sourceIdentity: source.sourceIdentity, document };
    const next = { version: 1, sources: [...collection.sources.filter(item => item.document.sourceId !== sourceId), saved] };
    await writeAtomic(join(root, SOURCE_TAKES_FILE), `${JSON.stringify(next, null, 2)}\n`);
    return saved;
  });
  writes.set(key, write);
  try { return await write; }
  finally { if (writes.get(key) === write) writes.delete(key); }
}

export async function sourceTakesRoute(req, res, root, rest) {
  if (rest !== 'source-takes') return false;
  if (req.method !== 'GET' && req.method !== 'PUT') return false;
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  if (params.getAll('sourceId').length !== 1 || !text(params.get('sourceId')) || params.getAll('assetPath').length > 1) fail('请选择唯一素材。');
  const sourceId = params.get('sourceId');
  const result = req.method === 'GET'
    ? await readSourceTakes(root, sourceId, params.get('assetPath') ?? undefined)
    : await writeSourceTakes(root, sourceId, await readJson(req));
  json(res, 200, result);
  return true;
}
