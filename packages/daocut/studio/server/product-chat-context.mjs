import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { HttpError, json } from './http.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { productSourcePath, readProductTranscript } from './product-transcription.mjs';
import { productTranscriptRange } from './product-transcript-range.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const segment = ({ startMs, endMs, text }) => ({ startMs, endMs, text });

function validateSelection(selection) {
  if (!selection || !['sourceId', 'productId', 'intervalId'].every(key => typeof selection[key] === 'string' && selection[key].trim())) throw new HttpError(400, '请选择一个已保存的商品讲解段。');
  if (!Number.isFinite(selection.startMs) || !Number.isFinite(selection.endMs) || selection.startMs < 0 || selection.endMs <= selection.startMs) throw new HttpError(400, '商品段起止时间无效。');
}

async function savedSelection(root, selection) {
  const { analysis } = await readProductAnalysis(root);
  // Inspection scopes and private source takes are deliberately not lecture intervals.
  const interval = analysis.intervals.find(item => item.id === selection.intervalId);
  const source = analysis.sources.find(item => item.id === selection.sourceId);
  const product = analysis.products.find(item => item.id === selection.productId);
  if (!interval || !source || !product || interval.sourceId !== source.id || interval.productId !== product.id || !product.sourceIds.includes(source.id)) throw new HttpError(409, '所选商品讲解段已不存在或归属已改变，请重新选择。');
  if (interval.startMs !== selection.startMs || interval.endMs !== selection.endMs) throw new HttpError(409, '商品段边界尚未保存或已经改变，请保存并重新选择后再分析。');
  if (!Number.isFinite(source.durationMs) || source.durationMs <= 0 || interval.endMs > source.durationMs) throw new HttpError(409, '原片时长尚未确认，无法验证商品段范围。');
  return { source, scope: { sourceId: source.id, productId: product.id, intervalId: interval.id, productName: product.name, startMs: interval.startMs, endMs: interval.endMs } };
}

async function sourceVersion(root, source) {
  const path = await realpath(await productSourcePath(root, source.assetPath));
  const info = await stat(path);
  if (!info.isFile()) throw new HttpError(409, '所选原片不可读取。');
  return { path, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino };
}

/** Read existing, provenance-checked subtitles only. This module never starts a task. */
export async function readProductChatContext(root, selection) {
  validateSelection(selection);
  const { source, scope } = await savedSelection(root, selection);
  let transcript, before;
  try {
    before = await sourceVersion(root, source);
    transcript = await readProductTranscript(root, source);
  } catch {
    throw new HttpError(409, '当前素材的已保存转写无法安全复用，请检查来源绑定或未完成任务；未发起转写。');
  }
  if (!transcript) throw new HttpError(409, '当前素材没有可用的已保存转写，请先完成或确认转写；未发起转写。');
  if (transcript.sourceId !== source.id) throw new HttpError(409, '已保存转写与所选原片不一致。');
  const { cues, segments, omittedBoundaryWords } = productTranscriptRange(transcript, scope, source.durationMs);

  // A drag/save or source replacement during the read must not return a stale scope.
  const latest = await savedSelection(root, selection);
  const after = await sourceVersion(root, latest.source);
  if (digest({ source, scope, fingerprint: before }) !== digest({ ...latest, fingerprint: after })) throw new HttpError(409, '商品段或原片在读取期间发生变化，请重新选择。');
  const transcriptVersion = digest({ version: 'product-chat-context-v1', source, scope, fingerprint: after, cues: cues.map(segment), words: transcript.words, text: transcript.text, ...(transcript.unalignedRanges?.length ? { unalignedRanges: transcript.unalignedRanges } : {}) });
  return { scope, transcriptVersion, segments, ...(omittedBoundaryWords ? { omittedBoundaryWords } : {}) };
}

export async function productChatContextRoute(req, res, root, rest) {
  if (rest !== 'product-chat-context' || req.method !== 'GET') return false;
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  const selection = {};
  for (const key of ['sourceId', 'productId', 'intervalId', 'startMs', 'endMs']) {
    if (params.getAll(key).length !== 1 || !params.get(key)?.trim()) throw new HttpError(400, '商品段请求缺少唯一、有效的身份或边界。');
    selection[key] = key.endsWith('Ms') ? Number(params.get(key)) : params.get(key);
  }
  json(res, 200, await readProductChatContext(root, selection));
  return true;
}
