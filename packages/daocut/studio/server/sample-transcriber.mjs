import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readDoubaoKey } from './doubao-config.mjs';
import { transcribeProductSource } from './product-transcription.mjs';
import { serviceUrl } from './providers/common.mjs';
import doubao from './providers/doubao.mjs';

const SAMPLE = 'assets/氨基酸2023.6.1.mp4';
const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
const checkEndpoint = () => {
  if (serviceUrl('DOUBAO', ENDPOINT) !== ENDPOINT) throw Object.assign(new Error('Unofficial transcription endpoint refused; audio was not uploaded.'), { code: 'ASR_NOT_SUBMITTED', reason: 'endpoint' });
};

// Trusted startup code supplies the project and installed settings location; requests cannot select either.
export function createSampleTranscriber({ enabled = false, projectRoot, providersFile, runProvider, readAudio } = {}) {
  if (enabled !== true) return null;
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot) || typeof providersFile !== 'string' || !isAbsolute(providersFile)) throw new Error('Sample transcription requires an absolute project and configuration path.');
  return async (root, source) => {
    let allowed;
    try { allowed = await realpath(projectRoot); } catch { throw new Error('The authorized sample project is unavailable.'); }
    let requested;
    try { requested = await realpath(root); } catch { throw new Error('The requested project is unavailable.'); }
    if (requested !== allowed || source?.assetPath !== SAMPLE) throw new Error('Only the authorized sample in its personal project can be transcribed.');
    if (!runProvider) checkEndpoint();
    return transcribeProductSource(requested, source, {
      getKey: () => readDoubaoKey(providersFile),
      runProvider: runProvider ?? (async (...args) => { checkEndpoint(); return doubao.run(...args); }),
      ...(readAudio ? { readAudio } : {}),
    });
  };
}
