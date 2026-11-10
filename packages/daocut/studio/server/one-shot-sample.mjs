import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { confirmSampleInspectionScope } from './live-analysis.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { productSourcePath, readProductTranscript } from './product-transcription.mjs';
import { createOneShotTextClient } from './one-shot-text-client.mjs';

// This factory is only called by trusted startup code. It creates no route or service.
// cueDigest must be captured separately from the exact transcript the user approved.
export function createOneShotSample({ enabled, root, sourcePath, sourceId, productId, intervalId, cueDigest, probeSource, readTranscript = readProductTranscript, ...clientOptions }) {
  if (enabled !== true) return null;
  if (![root, sourcePath, sourceId, productId, intervalId].every(v => typeof v === 'string' && v) || !/^[a-f0-9]{64}$/.test(cueDigest)) throw new Error('样片授权信息不完整');
  const getAuthorizedInput = async () => {
    const project = await realpath(root);
    const { analysis } = await readProductAnalysis(project);
    const source = analysis.sources.find(s => s.id === sourceId);
    if (!source || !analysis.products.some(p => p.id === productId && p.sourceIds.includes(sourceId)) || await realpath(await productSourcePath(project, source.assetPath)) !== await realpath(sourcePath)) throw new Error('样片身份不匹配');
    const transcript = await readTranscript(project, source);
    const cues = transcript?.cues?.map(({ text, startMs, endMs }) => ({ startMs, endMs, text }));
    if (!Array.isArray(cues) || cues.length !== 49 || cues.some(c => typeof c.text !== 'string' || !c.text || !Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.startMs < 0 || c.endMs > 132470 || c.startMs >= c.endMs) || createHash('sha256').update(JSON.stringify(cues)).digest('hex') !== cueDigest) throw new Error('已验收字幕不匹配');
    return { sourceId, productId, intervalId, rangeStartMs: 0, rangeEndMs: 132470, cues };
  };
  const modelClient = createOneShotTextClient({ ...clientOptions, enabled: true, getAuthorizedInput });
  return { modelClient, prepareScope: async () => { await getAuthorizedInput(); return confirmSampleInspectionScope(await realpath(root), { sourceId, productId, intervalId }, probeSource); } };
}
