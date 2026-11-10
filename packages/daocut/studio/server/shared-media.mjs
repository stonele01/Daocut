// @ts-check
/**
 * A small, deliberately local bridge between a personal project and shared footage.
 *
 * The project keeps a logical library id plus a path below that library in
 * `assets/.daocut-source-media.json`.  The actual root of that library is a
 * preference of this computer. `assets/<video>` remains the editor's normal
 * media address. New registrations use a verified logical reference without
 * requiring a filesystem link or copying source bytes; old links stay readable.
 */
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { addLinkedPlaces, linkAllowed } from '../../src/media-links.mjs';
import { writeAtomic } from './atomic.mjs';
import { inside, listFiles, relink } from './files.mjs';
import { createProject } from './projects.mjs';
import { readPrefs, writePrefs } from './prefs.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';
import { mediaContentHash, prepareMediaReferences, resolveMediaReference } from '../../src/shared-media-reference.mjs';

export const SHARED_MEDIA_MANIFEST = 'assets/.daocut-source-media.json';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm', '.wmv', '.flv', '.ts', '.mts', '.m2ts']);
const TRANSCRIPT_EXTENSIONS = new Set(['.vtt', '.srt', '.ass', '.ssa', '.lrc', '.txt']);
const ID = /^[a-z0-9][a-z0-9._-]{7,79}$/i;
const MAX_LISTED = 500;

/** A request problem that is safe to show to the person. */
export class SharedMediaError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** @typedef {{ id: string, name: string, root: string, managedFolder?: true }} SharedLibrary */
/** @typedef {{ libraryId: string, libraryName: string, relativePath: string, size: number, mtimeMs: number, mode?: 'reference'|'verified-copy'|'project-reference', sha256?: string, parentProjectId?: string, parentAssetPath?: string }} SourceRecord */
/** @typedef {{ version: 1, items: Record<string, SourceRecord> }} SourceManifest */

const posix = (/** @type {string} */ path) => path.split(sep).join('/');

/** A path stored under a library. It must never name that library itself or climb out of it. */
function sourcePathOf(/** @type {unknown} */ value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value)) throw new SharedMediaError('Choose a video inside the selected material library.');
  const clean = normalize(value.split('/').join(sep));
  const parts = clean.split(sep);
  if (!clean || clean === '.' || parts[0] === '..' || parts.includes('..') || isAbsolute(clean)) throw new SharedMediaError('The selected path must stay inside the material library.');
  return posix(clean);
}

/** A path stored as an asset in a project. */
function assetPathOf(/** @type {unknown} */ value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const clean = normalize(value.split('/').join(sep));
  const parts = clean.split(sep);
  if (parts[0] !== 'assets' || parts.includes('..') || isAbsolute(clean)) return null;
  return posix(clean);
}

function within(/** @type {string} */ root, /** @type {string} */ child) {
  const back = relative(root, child);
  return back === '' || (!back.startsWith(`..${sep}`) && back !== '..' && !isAbsolute(back));
}

/** @param {unknown} value @returns {SharedLibrary | null} */
function libraryOf(value) {
  const raw = /** @type {{ id?: unknown, name?: unknown, root?: unknown } | null} */ (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.name !== 'string' || !raw.name.trim() || typeof raw.root !== 'string' || !isAbsolute(raw.root)) return null;
  return { id: raw.id, name: raw.name.trim().slice(0, 80), root: resolve(raw.root) };
}

/** A manifest is project data, not a machine's path configuration. */
function manifestOf(/** @type {unknown} */ value) {
  const raw = /** @type {{ version?: unknown, items?: unknown } | null} */ (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  /** @type {Record<string, SourceRecord>} */
  const items = {};
  if (raw?.version !== 1 || !raw.items || typeof raw.items !== 'object' || Array.isArray(raw.items)) return /** @type {SourceManifest} */ ({ version: 1, items });
  for (const [asset, source] of Object.entries(raw.items).slice(0, 10000)) {
    const assetPath = assetPathOf(asset);
    const item = /** @type {{ libraryId?: unknown, libraryName?: unknown, relativePath?: unknown, size?: unknown, mtimeMs?: unknown } | null} */ (source && typeof source === 'object' && !Array.isArray(source) ? source : null);
    let relativePath = null;
    try { relativePath = sourcePathOf(item?.relativePath); } catch { /* malformed old record: leave it out */ }
    if (!assetPath || !item || typeof item.libraryId !== 'string' || !ID.test(item.libraryId) || typeof item.libraryName !== 'string' || !item.libraryName.trim()
      || !relativePath || !(typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0)
      || !(typeof item.mtimeMs === 'number' && Number.isFinite(item.mtimeMs) && item.mtimeMs >= 0)) continue;
    const extra = /** @type {any} */ (item);
    items[assetPath] = { libraryId: item.libraryId, libraryName: item.libraryName.trim().slice(0, 80), relativePath, size: item.size, mtimeMs: item.mtimeMs,
      ...(['reference', 'verified-copy', 'project-reference'].includes(extra.mode) ? { mode: extra.mode, sha256: extra.sha256 } : {}),
      ...(extra.mode === 'project-reference' ? { parentProjectId: extra.parentProjectId, parentAssetPath: extra.parentAssetPath } : {}) };
  }
  return /** @type {SourceManifest} */ ({ version: 1, items });
}

async function readManifest(/** @type {string} */ projectRoot) {
  try { return manifestOf(JSON.parse(await readFile(join(projectRoot, SHARED_MEDIA_MANIFEST), 'utf8'))); }
  catch { return /** @type {SourceManifest} */ ({ version: 1, items: {} }); }
}

async function writeManifest(/** @type {string} */ projectRoot, /** @type {SourceManifest} */ manifest) {
  const at = join(projectRoot, SHARED_MEDIA_MANIFEST);
  await mkdir(join(projectRoot, 'assets'), { recursive: true });
  await writeAtomic(at, `${JSON.stringify(manifest, null, 2)}\n`);
}

function configuredLibrary(/** @type {string} */ id) {
  const found = readPrefs().sharedMediaLibraries.find((library) => library.id === id);
  return found ? libraryOf(found) : null;
}

async function openedRoot(/** @type {SharedLibrary} */ library) {
  let root;
  try { root = await realpath(library.root); } catch { throw new SharedMediaError(`The local folder for “${library.name}” is unavailable.`, 404); }
  if (!(await stat(root).then((info) => info.isDirectory(), () => false))) throw new SharedMediaError(`The local folder for “${library.name}” is unavailable.`, 404);
  return root;
}

/** Resolve a stored relative path without allowing a symlink to reach outside the selected library. */
async function sourceFile(/** @type {string} */ root, /** @type {string} */ rel) {
  const safe = sourcePathOf(rel);
  const asked = resolve(root, safe.split('/').join(sep));
  if (!within(root, asked)) throw new SharedMediaError('The selected path must stay inside the material library.');
  let real;
  try { real = await realpath(asked); } catch { throw new SharedMediaError('That shared media file is no longer available.', 404); }
  if (!within(root, real)) throw new SharedMediaError('The selected path must stay inside the material library.');
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new SharedMediaError('Choose a video file, not a folder.', 400);
  return { path: real, info, relativePath: safe };
}

/** Add or update a physical root for the same logical library id on this computer only. */
export async function associateSharedLibrary(/** @type {{ id?: unknown, name?: unknown, root?: unknown }} */ { id, name, root }) {
  if (typeof id !== 'string' || !ID.test(id)) throw new SharedMediaError('A valid material library id is required.');
  if (typeof name !== 'string' || !name.trim()) throw new SharedMediaError('Give this material library a name.');
  if (typeof root !== 'string' || !isAbsolute(root)) throw new SharedMediaError('Choose the local root folder for this material library.');
  let real;
  try { real = await realpath(root); } catch { throw new SharedMediaError('That material library folder is unavailable.', 404); }
  if (!(await stat(real).then((info) => info.isDirectory(), () => false))) throw new SharedMediaError('That material library path is not a folder.');
  const now = readPrefs();
  const managed = now.sharedMediaLibraries.find(entry => entry.id === id)?.managedFolder === true;
  const library = { id, name: name.trim().slice(0, 80), root: real, ...(managed ? { managedFolder: /** @type {const} */ (true) } : {}) };
  const sharedMediaLibraries = [...now.sharedMediaLibraries.filter((entry) => entry.id !== id), library];
  writePrefs({ sharedMediaLibraries });
  return library;
}

/** List exactly one chosen product folder; directories below it are deliberately not scanned. */
export async function browseSharedFolder(/** @type {{ libraryId?: unknown, folder?: unknown }} */ { libraryId, folder }) {
  const library = configuredLibrary(String(libraryId ?? ''));
  if (!library) throw new SharedMediaError('Configure this material library on this computer first.', 409);
  return browseSharedLibraryFolder(library, folder);
}

/** The same direct-child listing before a newly selected folder is registered locally. */
export async function browseSharedLibraryFolder(/** @type {SharedLibrary} */ library, /** @type {unknown} */ folder) {
  const root = await openedRoot(library);
  if (typeof folder !== 'string' || !isAbsolute(folder)) throw new SharedMediaError('Choose a product folder inside the material library.');
  let product;
  try { product = await realpath(folder); } catch { throw new SharedMediaError('That product folder is unavailable.', 404); }
  if (!within(root, product) || !(await stat(product).then((info) => info.isDirectory(), () => false))) throw new SharedMediaError('Choose a product folder inside the material library.');
  const relativeFolder = posix(relative(root, product));
  const entries = await readdir(product, { withFileTypes: true });
  /** @type {{ path: string, name: string, size: number, mtimeMs: number }[]} */
  const videos = [];
  /** @type {{ path: string, name: string, size: number, mtimeMs: number }[]} */
  const transcripts = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))) {
    if (entry.name.startsWith('.')) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext) && !TRANSCRIPT_EXTENSIONS.has(ext)) continue;
    const candidate = await sourceFile(root, relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name).catch(() => null);
    if (!candidate) continue;
    const row = { path: candidate.relativePath, name: entry.name, size: candidate.info.size, mtimeMs: Math.round(candidate.info.mtimeMs) };
    if (VIDEO_EXTENSIONS.has(ext)) videos.push(row); else transcripts.push(row);
  }
  return { library: { id: library.id, name: library.name }, folder: relativeFolder, videos: videos.slice(0, MAX_LISTED), transcripts: transcripts.slice(0, MAX_LISTED), moreVideos: videos.length > MAX_LISTED, moreTranscripts: transcripts.length > MAX_LISTED };
}

/** A duplicate click or a retry with this same id waits for/returns the one create operation for this Studio session. */
const creations = new Map();

/** Create the personal project and its read-only logical reference. It intentionally does not edit film.html. */
export function createSharedMediaProject(/** @type {{ libraryId?: unknown, videoPath?: unknown, requestId?: unknown }} */ { libraryId, videoPath, requestId }, /** @type {{ initialize?: (root: string, input: { assetPath: string, sourceId: string, expectedAnalysis: any }) => Promise<any> }} */ { initialize } = {}) {
  if (typeof requestId !== 'string' || !/^[a-z0-9-]{8,100}$/i.test(requestId)) throw new SharedMediaError('A creation request id is required.');
  const earlier = creations.get(requestId);
  if (earlier) return earlier;
  const work = (async () => {
    const library = configuredLibrary(String(libraryId ?? ''));
    if (!library) throw new SharedMediaError('Configure this material library on this computer first.', 409);
    const root = await openedRoot(library);
    const source = await sourceFile(root, String(videoPath ?? ''));
    if (!VIDEO_EXTENSIONS.has(extname(source.path).toLowerCase())) throw new SharedMediaError('Choose a video file.');
    const productDir = dirname(source.relativePath);
    const product = productDir === '.' ? basename(root) : basename(productDir);
    const project = await createProject(product || basename(source.path, extname(source.path)) || 'Untitled');
    const asset = await referenceAsset(project.path, basename(source.path));
    if (!asset) throw new SharedMediaError('The shared video could not be linked into the project.', 500);
    const manifest = await readManifest(project.path);
    manifest.items[asset] = {
      libraryId: library.id,
      libraryName: library.name,
      relativePath: source.relativePath,
      size: source.info.size,
      mtimeMs: Math.round(source.info.mtimeMs),
      mode: 'reference', sha256: await mediaContentHash(source.path),
    };
    await writeManifest(project.path, manifest);
    const sourceId = randomUUID();
    const initial = await writeProductAnalysis(project.path, {
      version: 1,
      sources: [{ id: sourceId, assetPath: asset, durationMs: null }],
      products: [{ id: randomUUID(), name: product || basename(source.path, extname(source.path)), sourceIds: [sourceId] }],
      intervals: [], candidates: [],
    });
    const sharedRead = initialize ? await initialize(project.path, { assetPath: asset, sourceId, expectedAnalysis: initial.analysis }) : undefined;
    return { project, asset, source: manifest.items[asset], ...(sharedRead ? { sharedRead } : {}) };
  })();
  creations.set(requestId, work);
  /* A failed request may be retried; a successful one remains so a delayed duplicate never makes another project. */
  void work.catch(() => { if (creations.get(requestId) === work) creations.delete(requestId); });
  return work;
}

/** Add selected direct children of one product folder to an existing project. */
const additions = new Map();
/** @param {{ projectRoot?: unknown, libraryId?: unknown, folder?: unknown, videoPaths?: unknown }} options */
export async function addSharedMedia({ projectRoot, libraryId, folder, videoPaths }) {
  if (typeof projectRoot !== 'string') throw new SharedMediaError('A project is required.');
  if (!Array.isArray(videoPaths) || !videoPaths.length || videoPaths.length > MAX_LISTED || videoPaths.some((path) => typeof path !== 'string')) throw new SharedMediaError('Choose one or more videos.');
  const previous = additions.get(projectRoot) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    const listing = await browseSharedFolder({ libraryId, folder });
    const allowed = new Set(listing.videos.map((video) => video.path));
    const paths = [...new Set(videoPaths.map(sourcePathOf))];
    if (paths.some((path) => !allowed.has(path))) throw new SharedMediaError('Choose videos directly inside the selected product folder.');
    const library = configuredLibrary(String(libraryId ?? ''));
    if (!library) throw new SharedMediaError('Configure this material library on this computer first.', 409);
    const root = await openedRoot(library);
    const sources = await Promise.all(paths.map((path) => sourceFile(root, path)));
    const manifest = await readManifest(projectRoot);
    const assets = [];
    for (const source of sources) {
      const existing = Object.entries(manifest.items).find(([, item]) => item.libraryId === library.id && item.relativePath === source.relativePath);
      if (existing) { assets.push(existing[0]); continue; }
      const asset = await referenceAsset(projectRoot, basename(source.path), manifest);
      if (!asset) throw new SharedMediaError('The shared video could not be linked into the project.', 500);
      manifest.items[asset] = { libraryId: library.id, libraryName: library.name, relativePath: source.relativePath, size: source.info.size, mtimeMs: Math.round(source.info.mtimeMs), mode: 'reference', sha256: await mediaContentHash(source.path) };
      await writeManifest(projectRoot, manifest);
      assets.push(asset);
    }
    return { assets };
  });
  additions.set(projectRoot, work);
  try { return await work; } finally { if (additions.get(projectRoot) === work) additions.delete(projectRoot); }
}

/** @typedef {{ libraryId: string, libraryName: string, relativePath: string, size: number, mtimeMs: number, status: 'available' | 'unconfigured' | 'offline' | 'needs-confirmation' }} SharedLinkState */

/**
 * Verify logical references by content hash, or repoint a legacy managed link that still agrees with size/time.
 * Legacy metadata is only a warning-level comparison; a mismatch is never silently relinked.
 */
export async function refreshSharedMedia(/** @type {string} */ projectRoot) {
  const manifest = await readManifest(projectRoot);
  /** @type {Record<string, SharedLinkState>} */
  const states = {};
  for (const [asset, source] of Object.entries(manifest.items)) {
    const base = { libraryId: source.libraryId, libraryName: source.libraryName, relativePath: source.relativePath, size: source.size, mtimeMs: source.mtimeMs };
    if (source.mode === 'verified-copy' || source.mode === 'project-reference') {
      try { await resolveSharedMedia(projectRoot, asset); states[asset] = { ...base, status: 'available' }; }
      catch { states[asset] = { ...base, status: 'needs-confirmation' }; }
      continue;
    }
    const library = configuredLibrary(source.libraryId);
    if (!library) { states[asset] = { ...base, status: 'unconfigured' }; continue; }
    let root;
    try { root = await openedRoot(library); } catch { states[asset] = { ...base, status: 'offline' }; continue; }
    let candidate;
    try { candidate = await sourceFile(root, source.relativePath); } catch { states[asset] = { ...base, status: 'offline' }; continue; }
    /* SMB timestamp precision can differ slightly; this check remains advisory and errs on asking the person. */
    if (candidate.info.size !== source.size || Math.abs(candidate.info.mtimeMs - source.mtimeMs) > 2000) {
      states[asset] = { ...base, status: 'needs-confirmation' };
      continue;
    }
    if (source.mode === 'reference') {
      try { await mediaContentHash(candidate.path); resolveMediaReference(projectRoot, asset); states[asset] = { ...base, status: 'available' }; }
      catch { states[asset] = { ...base, status: 'needs-confirmation' }; }
      continue;
    }
    const link = join(projectRoot, asset.split('/').join(sep));
    const entry = await lstat(link).catch(() => null);
    if (!entry?.isSymbolicLink()) { states[asset] = { ...base, status: 'offline' }; continue; }
    if (!linkAllowed(candidate.path)) addLinkedPlaces([candidate.path]);
    const current = await realpath(link).catch(() => null);
    if (current !== candidate.path) await relink(projectRoot, asset, candidate.path);
    states[asset] = { ...base, status: 'available' };
  }
  return states;
}

/** The ordinary media listing, enriched only for shared-media links. */
export async function listSharedProjectMedia(/** @type {string} */ projectRoot) {
  const states = await refreshSharedMedia(projectRoot);
  const listing = await listFiles(projectRoot);
  /** @type {Record<string, { to: string, missing?: true, source?: SharedLinkState }>} */
  const links = listing.links;
  for (const [asset, source] of Object.entries(states)) {
    if (links[asset]) links[asset] = { ...links[asset], source };
  }
  return listing;
}

/** A project can only bind a library it actually references; the physical path never enters its manifest. */
export async function associateProjectLibrary(/** @type {{ projectRoot?: unknown, libraryId?: unknown, root?: unknown }} */ { projectRoot, libraryId, root }) {
  if (typeof projectRoot !== 'string') throw new SharedMediaError('A project is required.');
  if (typeof libraryId !== 'string') throw new SharedMediaError('A material library id is required.');
  const manifest = await readManifest(projectRoot);
  const source = Object.values(manifest.items).find((item) => item.libraryId === libraryId);
  if (!source) throw new SharedMediaError('This project does not reference that material library.', 404);
  return associateSharedLibrary({ id: source.libraryId, name: source.libraryName, root });
}

/** Kept for tests and future diagnostics; never returned as a local filesystem path. */
export async function sharedMediaManifest(/** @type {string} */ projectRoot) {
  return readManifest(projectRoot);
}

/** Read a registered logical source, verified local copy, or legacy link without changing source bytes or permissions. */
export async function resolveSharedMedia(/** @type {string} */ projectRoot, /** @type {string} */ assetPath) {
  const safe = assetPathOf(assetPath);
  if (!safe || safe !== assetPath) throw new SharedMediaError('Invalid shared media asset.');
  const source = (await readManifest(projectRoot)).items[safe];
  if (!source) throw new SharedMediaError('This asset is not registered as shared media.', 404);
  if (source.mode === 'verified-copy') {
    const path = inside(projectRoot, safe), info = await stat(path);
    if (!info.isFile() || info.size !== source.size || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '') || await mediaContentHash(path) !== source.sha256) throw new SharedMediaError('The local source content changed and needs confirmation.', 409);
    return { path, info };
  }
  if (source.mode === 'reference' || source.mode === 'project-reference') {
    await prepareMediaReferences(projectRoot, assetPath);
    const resolved = resolveMediaReference(projectRoot, assetPath);
    if (!resolved) throw new SharedMediaError('Invalid logical media reference', 409);
    return { path: resolved.path, info: resolved.info };
  }
  const library = configuredLibrary(source.libraryId);
  if (!library) throw new SharedMediaError('Configure this material library on this computer first.', 409);
  const candidate = await sourceFile(await openedRoot(library), source.relativePath);
  if (candidate.info.size !== source.size || Math.abs(candidate.info.mtimeMs - source.mtimeMs) > 2000) throw new SharedMediaError('The shared media has changed and needs confirmation.', 409);
  const link = join(projectRoot, safe.split('/').join(sep));
  const entry = await lstat(link).catch(() => null);
  if (!entry?.isSymbolicLink() || await realpath(link).catch(() => null) !== candidate.path) throw new SharedMediaError('The registered shared media link does not match its library.', 409);
  return { path: candidate.path, info: candidate.info };
}

/** Bind an existing ordinary video after proving equality with the library source. No media bytes change.
 * @param {{projectRoot:string,assetPath:unknown,libraryId:unknown,videoPath:unknown,confirmed:unknown}} input */
export async function bindSharedMediaCopy({ projectRoot, assetPath, libraryId, videoPath, confirmed }) {
  if (confirmed !== true) throw new SharedMediaError('Please confirm the existing copy association.', 409);
  const asset = assetPathOf(assetPath);
  if (!asset || asset !== assetPath || !VIDEO_EXTENSIONS.has(extname(asset).toLowerCase())) throw new SharedMediaError('Choose an existing project video.');
  const local = inside(projectRoot, asset), localInfo = await lstat(local);
  if (!localInfo.isFile() || localInfo.isSymbolicLink()) throw new SharedMediaError('Choose an ordinary local video copy.');
  const library = configuredLibrary(String(libraryId ?? ''));
  if (!library) throw new SharedMediaError('Configure this material library on this computer first.', 409);
  const shared = await sourceFile(await openedRoot(library), String(videoPath ?? ''));
  if (!VIDEO_EXTENSIONS.has(extname(shared.path).toLowerCase()) || shared.info.size !== localInfo.size) throw new SharedMediaError('The local and shared video content does not match.', 409);
  const [sha256, remoteHash] = await Promise.all([mediaContentHash(local), mediaContentHash(shared.path)]);
  if (sha256 !== remoteHash) throw new SharedMediaError('The local and shared video content does not match.', 409);
  const manifest = await readManifest(projectRoot);
  const source = /** @type {SourceRecord} */ ({ libraryId: library.id, libraryName: library.name, relativePath: shared.relativePath, size: localInfo.size, mtimeMs: Math.round(shared.info.mtimeMs), mode: 'verified-copy', sha256 });
  manifest.items[asset] = source;
  await writeManifest(projectRoot, manifest);
  return { asset, source };
}

/** Reserve only a logical name. The source bytes and filesystem are never copied or linked.
 * @param {string} projectRoot @param {string} name @param {SourceManifest|null} [manifest] */
async function referenceAsset(projectRoot, name, manifest = null) {
  const records = manifest ?? await readManifest(projectRoot);
  await mkdir(join(projectRoot, 'assets'), { recursive: true });
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  let asset = `assets/${name}`, n = 2;
  while (records.items[asset] || await lstat(join(projectRoot, asset)).then(() => true, () => false)) asset = `assets/${stem} ${n++}${ext}`;
  return asset;
}
