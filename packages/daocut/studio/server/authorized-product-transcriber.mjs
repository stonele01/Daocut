import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readDoubaoKey } from './doubao-config.mjs';
import { productSourcePath, transcribeProductSource } from './product-transcription.mjs';
import { serviceUrl } from './providers/common.mjs';
import doubao from './providers/doubao.mjs';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const reject = () => Object.assign(new Error('The authorized source or service changed; no audio was uploaded.'), { code: 'ASR_NOT_SUBMITTED', reason: 'source' });

/** An authorization supplied by trusted startup code, never by a browser request. Disabled by default. */
export function createAuthorizedProductTranscriber({ enabled = false, projectRoot, source: authorized, providersFile, getKey, readAudio, runProvider, audioPolicy, probeSource } = {}) {
  if (!enabled) return null;
  if (!isAbsolute(projectRoot ?? '') || !authorized || typeof authorized.id !== 'string' || typeof authorized.assetPath !== 'string' || !Number.isFinite(authorized.size) || !Number.isFinite(authorized.mtimeMs) || (typeof getKey !== 'function' && !isAbsolute(providersFile ?? ''))) throw new Error('An explicit project, source fingerprint and credential reader are required.');
  return async (root, source, { retryUncertain = false } = {}) => {
    if (await realpath(root) !== await realpath(projectRoot) || source.id !== authorized.id || source.assetPath !== authorized.assetPath) throw reject();
    const input = await productSourcePath(root, source.assetPath), info = await stat(input);
    if (info.size !== authorized.size || info.mtimeMs !== authorized.mtimeMs || (authorized.ctimeMs !== undefined && info.ctimeMs !== authorized.ctimeMs)) throw reject();
    const checkEndpoint = () => { if (!runProvider && serviceUrl('DOUBAO', ENDPOINT) !== ENDPOINT) throw reject(); };
    checkEndpoint();
    return transcribeProductSource(root, source, {
      getKey: getKey ?? (() => readDoubaoKey(providersFile)),
      retryUncertain, ...(readAudio ? { readAudio } : {}), ...(audioPolicy ? { audioPolicy } : {}), ...(probeSource ? { probeSource } : {}),
      runProvider: runProvider ?? (async (...args) => { checkEndpoint(); return doubao.run(...args); }),
    });
  };
}
