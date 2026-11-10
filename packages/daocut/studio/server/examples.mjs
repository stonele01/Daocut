// @ts-check
/**
 * Compatibility for references already saved in a conversation. Daocut no longer offers an examples catalog,
 * downloads examples, or serves their bundled posters. Existing imported projects and cached reference files stay
 * where they are; an old reference may still resolve to its already-downloaded folder.
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** The removed catalog stays empty for older clients. */
export async function listExamples() { return []; }

/** Bundled example media is no longer served. */
export function exampleFile() { return null; }

/** Resolve only a reference already on disk; never fetch or replace existing user data.
 * @param {string} id
 * @param {{ home: string }} options
 */
export async function exampleFolder(id, { home }) {
  if (!/^[\w.-]+$/.test(id) || id === '.' || id === '..') throw new Error('There is no such example.');
  const cache = join(home, 'cache', 'examples');
  const dir = join(cache, id);
  try {
    const path = realpathSync(dir);
    const inside = relative(realpathSync(cache), path);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside) || !existsSync(join(path, 'film.html'))) throw new Error();
    return path;
  } catch { throw new Error('There is no such example.'); }
}
