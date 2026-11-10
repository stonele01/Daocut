// @ts-check
/** Read-only checks at execution time. A queued export must not silently use a replaced shared original. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { readFilmFile } from '../../src/film-doc.mjs';
import { inProject } from './files.mjs';
import { linkKind, rewriteLinks } from './page-links.mjs';
import { resolveSharedMedia, sharedMediaManifest, SHARED_MEDIA_MANIFEST } from './shared-media.mjs';

const digest = async (/** @type {string} */ path) => {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const json = async (/** @type {string} */ path) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined; throw new Error('共享素材身份记录无法读取，导出已停止，请先核对工程'); }
};
const unchanged = (/** @type {import('node:fs').Stats} */ a, /** @type {import('node:fs').Stats} */ b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;

/** Follow the existing page-link grammar, without rendering pages or repairing any media links.
 * Runtime-computed page paths cannot be enumerated statically: check all registered shared sources in that case.
 * @param {string} root @param {import('./exports.mjs').ExportAsk} ask @param {string[]} all
 */
async function dependencies(root, ask, all) {
  if (ask.kind === 'project') return new Set(all);
  const used = new Set(), seen = new Set(); let runtimePaths = false;
  async function visit(/** @type {string} */ path, clipOnly = false) {
    path = posix.normalize(path.replaceAll('\\', '/'));
    if (seen.has(path) || path.startsWith('../') || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return;
    seen.add(path); if (all.includes(path)) used.add(path);
    const kind = linkKind(path); if (!kind) return;
    const input = inProject(root, path); if (!input) return;
    let body;
    try { body = await readFile(input, 'utf8'); } catch { return; }
    const next = new Set();
    let structuredFilm = false;
    if (kind === 'html') {
      const { doc } = readFilmFile(body);
      if (doc) {
        structuredFilm = true;
        for (const track of doc.tracks) for (const clip of track.clips) {
          if (clipOnly && ask.kind === 'video' && ask.clip && clip.id !== ask.clip) continue;
          next.add(posix.join(posix.dirname(path), clip.src));
        }
      }
    }
    // A structured film's selected clips are the authority; scanning its HTML again would re-add unselected clips.
    if (!structuredFilm) {
      const links = rewriteLinks(body, kind, posix.dirname(path), posix.dirname(path), target => { next.add(target); return target; });
      // Custom page scripts may assign src, construct Audio, or fetch paths at runtime. Do not claim a static
      // URL grammar proves which registered originals they will use; conservatively check all for that page.
      if (links.unseen.length || kind === 'js' || (kind === 'html' && /<script\b/i.test(body))) runtimePaths = true;
    }
    for (const target of next) await visit(target);
  }
  const film = inProject(root, 'film.html');
  if (film && await stat(film).then(info => info.isFile(), () => false)) await visit('film.html', true);
  else await visit('index.html');
  return runtimePaths ? new Set(all) : used;
}

/** Strong identities already saved by the shared-analysis workflow; old projects may have none.
 * Conflicting saved identities are deliberately not guessed by picking the latest file.
 * @param {string} root @param {Record<string, import('./shared-media.mjs').SourceRecord>} sources @param {Set<string>} used
 */
async function savedHashes(root, sources, used) {
  const out = new Map();
  for (const asset of used) if (['reference', 'verified-copy'].includes(sources[asset]?.mode ?? '') && sources[asset].sha256) out.set(asset, new Set([sources[asset].sha256]));
  const dir = join(root, '.film/shared-analysis');
  let names;
  try { names = await readdir(dir); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return out; throw error; }
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const saved = await json(join(dir, name)), identity = saved?.descriptor?.source;
    if (!identity) continue;
    for (const asset of used) {
      const source = sources[asset];
      if (identity.libraryId !== source.libraryId || identity.relativePath !== source.relativePath) continue;
      if (!/^[a-f0-9]{64}$/.test(identity.sha256)) throw new Error(`共享素材身份记录无效，导出已停止：${asset}`);
      const values = out.get(asset) ?? new Set(); values.add(identity.sha256); out.set(asset, values);
    }
  }
  return out;
}

/** Returns a cheap final check so a file changed during export is not published as a successful result.
 * This is a validation boundary, not a lock on an external NAS or a snapshot of its bytes.
 * @param {string} root @param {import('./exports.mjs').ExportAsk} ask
 */
export async function assertExportSources(root, ask) {
  if (ask.kind === 'subtitles' || (ask.kind === 'project' && ask.backup)) return async () => {};
  const raw = await json(join(root, SHARED_MEDIA_MANIFEST)); if (raw === undefined) return async () => {};
  const manifest = await sharedMediaManifest(root);
  if (raw?.version !== 1 || !raw.items || typeof raw.items !== 'object' || Array.isArray(raw.items)
    || Object.keys(raw.items).length !== Object.keys(manifest.items).length) throw new Error('共享素材清单无效，导出已停止，请先核对工程');
  const used = await dependencies(root, ask, Object.keys(manifest.items));
  if (!used.size) return async () => {};
  const expected = await savedHashes(root, manifest.items, used);
  /** @type {{ asset: string, path: string, info: import('node:fs').Stats }[]} */
  const checked = [];
  for (const asset of used) {
    let found;
    try { found = await resolveSharedMedia(root, asset); }
    catch (error) {
      const reason = /changed|confirmation/i.test(error instanceof Error ? error.message : '') ? '原片已变化，需要确认' : '原片不可用、未关联或链接不匹配';
      throw new Error(`共享素材导出已停止：${asset}；${reason}，请先在素材区核对来源`);
    }
    const hashes = expected.get(asset);
    if (hashes && (hashes.size !== 1 || !hashes.has(await digest(found.path)))) throw new Error(`共享素材内容与工程保存的原片身份不一致，导出已停止：${asset}`);
    const after = await stat(found.path);
    if (!unchanged(found.info, after)) throw new Error(`共享素材校验期间发生变化，导出已停止：${asset}`);
    checked.push({ asset, path: found.path, info: after });
  }
  return async () => {
    for (const source of checked) {
      let current;
      try { current = await resolveSharedMedia(root, source.asset); } catch { throw new Error(`共享素材导出期间不可用或发生变化：${source.asset}`); }
      if (current.path !== source.path || !unchanged(current.info, source.info)) throw new Error(`共享素材导出期间发生变化：${source.asset}`);
    }
  };
}
