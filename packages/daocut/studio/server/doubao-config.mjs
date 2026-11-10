import { readFile } from 'node:fs/promises';

// Read on demand only. Do not use readSettings: it changes file permissions.
export async function readDoubaoKey(configFile) {
  let body;
  try { body = await readFile(configFile, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Existing transcription configuration could not be read.');
  }
  let settings;
  try { settings = JSON.parse(body); }
  catch { throw new Error('Existing transcription configuration is invalid.'); }
  const key = settings?.keys?.doubao;
  return typeof key === 'string' && key.trim() ? key : null;
}
