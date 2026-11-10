/** Content-addressed pictures in debug logs; no changes to model requests or conversation history. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const IMAGE_FILE = /^\.film\/logs\/images\/([0-9a-f]{40})\.(jpg|png|webp|gif|avif|bin)$/;

/** Keep image bytes once per project; a failed write leaves callers free to retain the original inline block. */
export function saveLogImage(project, data, mimeType) {
  try {
    const bytes = Buffer.from(String(data ?? ''), 'base64');
    if (!bytes.length) return null;
    const name = createHash('sha1').update(bytes).digest('hex') + '.' + (IMAGE_EXT[mimeType] ?? 'bin');
    const dir = join(project, '.film', 'logs', 'images');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    if (!existsSync(file)) {
      const tmp = file + '.' + process.pid + '.tmp';
      writeFileSync(tmp, bytes);
      renameSync(tmp, file);
    }
    return '.film/logs/images/' + name;
  } catch { return null; }
}

/** Only an app-created picture under this project's real directory can be read; never an arbitrary log-supplied path. */
export function readLogImage(project, file) {
  if (typeof file !== 'string' || !IMAGE_FILE.test(file)) return null;
  try {
    const root = realpathSync(project);
    const path = realpathSync(join(root, file));
    if (relative(root, path).replace(/\\/g, '/') !== file) return null;
    const data = readFileSync(path);
    // Also reject a valid-looking name swapped for a different file or a hard link.
    const [, hash, ext] = IMAGE_FILE.exec(file);
    if (createHash('sha1').update(data).digest('hex') !== hash) return null;
    const mimeType = Object.entries(IMAGE_EXT).find(([, value]) => value === ext)?.[0] ?? 'application/octet-stream';
    return { data, mimeType };
  } catch { return null; }
}

/** Replace the stored copy only; JSON's replacer visits nested tool content as well as model messages. */
export function logImageBlock(project, value) {
  if (value?.type !== 'image' || typeof value.data !== 'string' || !IMAGE_EXT[value.mimeType]) return value;
  const file = saveLogImage(project, value.data, value.mimeType);
  if (!file) return value;
  const { data, ...rest } = value;
  return { ...rest, bytes: Buffer.byteLength(data, 'base64'), file };
}

export function stringifyLogEntry(project, entry) {
  return JSON.stringify(entry, (_key, value) => logImageBlock(project, value));
}

/** Referenced pictures only, used by an explicitly opted-in diagnostics archive; never scans a project directory. */
export function referencedLogImages(text) {
  const files = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'image' && typeof value.file === 'string' && IMAGE_FILE.test(value.file)) files.add(value.file);
    for (const child of Object.values(value)) visit(child);
  };
  for (const line of text.split('\n')) {
    try { visit(JSON.parse(line)); } catch { /* incomplete line */ }
  }
  return [...files];
}
