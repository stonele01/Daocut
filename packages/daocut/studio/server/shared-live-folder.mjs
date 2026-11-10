// @ts-check
/** Folder identity and personal-project selection. Original video bytes are never written. */
import { lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { readPrefs, writePrefs } from './prefs.mjs';
import { readState, markOpened } from './projects.mjs';
import { browseSharedLibraryFolder, createSharedMediaProject, sharedMediaManifest, SharedMediaError } from './shared-media.mjs';
import { mediaContentHash } from '../../src/shared-media-reference.mjs';

const DIRECTORY = '.daocut-shared';
const MANIFEST = 'manifest.json';
const ID = /^[a-z0-9][a-z0-9._-]{7,79}$/i;
const HEX = /^[a-f0-9]{64}$/;
const identityProbe = createHash('sha256').update('daocut-live-folder-initialization-v1').digest('hex');
const inside = (/** @type {string} */ root, /** @type {string} */ target) => { const r = relative(root, target); return !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`); };
const fail = (/** @type {string} */ message, status = 409) => new SharedMediaError(message, status);
const errorCode = (/** @type {unknown} */ error) => /** @type {NodeJS.ErrnoException | undefined} */ (error)?.code;
/** @typedef {{ version: 1, libraryId: string, name: string, resultPath: '.daocut-shared', coordinationId: string }} FolderManifest */
/** @typedef {{ coordinate?: (action: string, body: any) => Promise<any>, openFile?: typeof open, initialize?: (root: string, input: any) => Promise<any>, refresh?: (root: string) => Promise<any> }} Dependencies */
/** @typedef {{ folder?: unknown, videoPath?: unknown, requestId?: unknown, projectId?: unknown, createNew?: boolean }} OpenInput */
/** @typedef {{ status: 'ready'|'needs-initialization', folder: string, name: string, resultRoot: string|null, legacy: boolean, library?: import('./shared-media.mjs').SharedLibrary, videos: {path:string,name:string,size:number,mtimeMs:number}[], transcripts: {path:string,name:string,size:number,mtimeMs:number}[], moreVideos:boolean,moreTranscripts:boolean,warnings:string[] }} LiveFolder */

async function folderAt(/** @type {unknown} */ value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw fail('请选择完整的直播文件夹路径', 400);
  let folder;
  try { folder = await realpath(value); if (!(await stat(folder)).isDirectory()) throw Error(); }
  catch { throw fail('直播文件夹无法读取，请检查路径与读取权限', 404); }
  return folder;
}
async function metadataAt(/** @type {string} */ folder) {
  const directory = join(folder, DIRECTORY), path = join(directory, MANIFEST);
  try {
    const actual = await realpath(directory);
    if (actual !== directory && !inside(folder, actual)) throw fail('共享结果目录超出所选直播文件夹');
  } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
  let text;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw fail('直播说明文件格式无效，请核对；没有覆盖原记录');
    text = await readFile(path, 'utf8');
  } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(text); } catch { throw fail('直播说明文件尚未完整或已损坏，请核对；没有另建编号'); }
  if (value?.version !== 1 || typeof value.libraryId !== 'string' || !ID.test(value.libraryId)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80
    || value.resultPath !== DIRECTORY || !HEX.test(value.coordinationId ?? '')) throw fail('直播说明文件格式或结果目录无效，请核对；没有覆盖原记录');
  return /** @type {FolderManifest} */ (value);
}
async function coordinatorIdentity(/** @type {Dependencies['coordinate']} */ coordinate, /** @type {string|null} */ expected) {
  if (typeof coordinate !== 'function') throw fail('请先连接公司服务，再初始化或读取共享直播');
  const result = await coordinate('status', { taskKey: identityProbe, ...(expected ? { expectedCoordinatorId: expected } : {}) });
  if (!HEX.test(result?.coordinationId ?? '') || (expected && result.coordinationId !== expected)) throw fail('此直播属于另一公司服务，请连接原公司服务；没有重新分析');
  return result.coordinationId;
}
/** @returns {Promise<FolderManifest>} */
async function writeNewMetadata(/** @type {string} */ folder, /** @type {FolderManifest} */ metadata, /** @type {typeof open} */ openFile) {
  const directory = join(folder, DIRECTORY);
  try {
    await mkdir(directory, { recursive: true });
    if (!inside(folder, await realpath(directory))) throw fail('共享结果目录超出所选直播文件夹');
    const file = await openFile(join(directory, MANIFEST), 'wx');
    try { await file.writeFile(`${JSON.stringify(metadata, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    return metadata;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      // Another process may still be completing the exclusive write. Never replace its ID.
      for (let count = 0; count < 25; count++) {
        try { const winner = await metadataAt(folder); if (winner) return winner; } catch { /* incomplete concurrent write */ }
        await setTimeout(20);
      }
      throw fail('直播说明文件未完整保存，请核对后重试；没有另建编号');
    }
    if (['EACCES', 'EPERM', 'EROFS'].includes(errorCode(error) ?? '')) throw fail('没有权限写入直播分析目录，请联系目录管理者；未建立共享任务');
    throw error;
  }
}
async function oldLibrary(/** @type {string} */ folder) {
  const matches = [];
  for (const library of readPrefs().sharedMediaLibraries) {
    const root = await realpath(library.root).catch(() => null);
    if (root && inside(root, folder)) {
      if (library.managedFolder) throw fail('这场直播的说明文件已丢失，请恢复或核对原说明；没有降级旧库或生成新编号');
      matches.push({ ...library, root });
    }
  }
  if (matches.length > 1) throw fail('此直播匹配多个旧素材库，请在素材库设置中核对，未更换编号');
  return matches[0] ?? null;
}
function register(/** @type {FolderManifest} */ metadata, /** @type {string} */ folder) {
  const now = readPrefs(), root = join(folder, DIRECTORY);
  const library = { id: metadata.libraryId, name: metadata.name, root: folder, managedFolder: /** @type {const} */ (true) };
  writePrefs({
    sharedMediaLibraries: [...now.sharedMediaLibraries.filter(l => l.id !== library.id), library],
    sharedAnalysis: { enabled: true, resultRoots: [...now.sharedAnalysis.resultRoots.filter(r => r.libraryId !== library.id), { libraryId: library.id, root, coordinationId: metadata.coordinationId }] },
  });
  return library;
}
/** @param {{ folder?: unknown, initialize?: boolean }} input @param {Dependencies} [dependencies] @returns {Promise<LiveFolder>} */
export async function inspectLiveFolder({ folder: requested, initialize = false }, { coordinate, openFile = open } = {}) {
  const folder = await folderAt(requested), name = basename(folder).slice(0, 80) || '直播';
  let metadata = await metadataAt(folder);
  const legacy = !metadata ? await oldLibrary(folder) : null;
  const previewLibrary = legacy ?? { id: metadata?.libraryId ?? 'uninitialized-live-folder', name: metadata?.name ?? name, root: folder };
  const listing = await browseSharedLibraryFolder(previewLibrary, folder);
  if (!listing.videos.length) throw fail('此文件夹没有可打开的视频，请选择直接存放原视频的直播文件夹');
  const details = { folder, name, videos: listing.videos, transcripts: listing.transcripts, moreVideos: listing.moreVideos, moreTranscripts: listing.moreTranscripts };
  if (legacy) {
    const now = readPrefs(), resultRoot = now.sharedAnalysis.resultRoots.find(r => r.libraryId === legacy.id)?.root ?? null;
    if (resultRoot && !now.sharedAnalysis.enabled) writePrefs({ sharedAnalysis: { ...now.sharedAnalysis, enabled: true } });
    return { ...details, status: 'ready', legacy: true, library: legacy, resultRoot, warnings: resultRoot ? [] : ['此旧素材库尚未配置共享结果目录，请在素材库设置中沿用原结果位置；未生成新编号'] };
  }
  if (!metadata) {
    const present = await readdir(join(folder, DIRECTORY)).catch(error => { if (errorCode(error) === 'ENOENT') return []; throw error; });
    if (present.some(file => file !== MANIFEST)) throw fail('此目录已有共享文件但缺少直播说明，请核对原编号；未创建新编号或重新分析');
  }
  if (!metadata && !initialize) return { ...details, status: 'needs-initialization', legacy: false, resultRoot: join(folder, DIRECTORY), warnings: [] };
  if (!metadata) {
    const coordinationId = await coordinatorIdentity(coordinate, null);
    metadata = await writeNewMetadata(folder, { version: 1, libraryId: randomUUID(), name, resultPath: DIRECTORY, coordinationId }, openFile);
  }
  await coordinatorIdentity(coordinate, metadata.coordinationId);
  const established = metadata;
  const old = readPrefs().sharedMediaLibraries.find(l => l.id === established.libraryId);
  if (old) {
    const root = await realpath(old.root).catch(() => null);
    if (root && root !== folder) throw fail('此直播编号已关联另一个仍存在的目录，请核对是否复制了整场文件夹；未改旧关联');
  }
  const library = register(metadata, folder);
  return { ...details, status: 'ready', legacy: false, library, resultRoot: join(folder, DIRECTORY), warnings: [] };
}

const pendingOpens = new Map();
/** @param {OpenInput} input @param {Dependencies} [dependencies] */
export async function openLiveProject(input, dependencies = {}) {
  if (typeof input.requestId !== 'string' || !/^[a-z0-9-]{8,100}$/i.test(input.requestId)) throw fail('打开请求标识无效', 400);
  const signature = JSON.stringify(input), earlier = pendingOpens.get(input.requestId);
  if (earlier) { if (earlier.signature !== signature) throw fail('同一打开请求不能改变直播或工程'); return earlier.work; }
  const work = openPersonal(input, dependencies);
  pendingOpens.set(input.requestId, { signature, work });
  try { return await work; } finally { pendingOpens.delete(input.requestId); }
}
async function openPersonal(/** @type {OpenInput} */ input, /** @type {Dependencies} */ dependencies) {
  const live = await inspectLiveFolder({ folder: input.folder }, dependencies);
  if (live.status !== 'ready' || !live.library) throw fail('请先初始化直播共享目录');
  const video = live.videos.find(v => v.path === input.videoPath);
  if (!video) throw fail('请选择此直播文件夹中列出的视频', 400);
  const path = join(live.library.root, ...video.path.split('/'));
  const sha256 = await mediaContentHash(path);
  const matches = []; let replaced = false;
  for (const recent of (await readState()).recent) {
    if (!(await stat(join(recent.path, 'film.html')).catch(() => null))?.isFile()) continue;
    for (const [asset, source] of Object.entries((await sharedMediaManifest(recent.path)).items)) {
      if (source.libraryId !== live.library.id || source.relativePath !== video.path) continue;
      if (source.sha256 !== sha256 || source.size !== video.size || Math.abs(source.mtimeMs - video.mtimeMs) > 2000) { replaced = true; continue; }
      const info = await stat(recent.path);
      matches.push({ project: { ...recent, name: basename(recent.path), missing: false, createdAt: Math.round(info.birthtimeMs || info.ctimeMs) }, asset, source });
      break;
    }
  }
  if (replaced && !matches.length) throw fail('原视频内容或时间已变化，可能已被替换，请核对来源；没有打开旧分析或重新分析');
  if (input.projectId && input.createNew) throw fail('请选择继续已有工程或新建工程', 400);
  if (!input.createNew) {
    const selected = input.projectId ? matches.find(m => m.project.id === input.projectId) : matches.length === 1 ? matches[0] : null;
    if (input.projectId && !selected) throw fail('所选工程与此视频身份不匹配');
    if (selected) {
      const sharedRead = await dependencies.refresh?.(selected.project.path);
      return { status: 'opened', reused: true, project: await markOpened(selected.project.id), asset: selected.asset, source: selected.source, ...(sharedRead ? { sharedRead } : {}) };
    }
    if (matches.length > 1) return { status: 'choose-project', projects: matches.map(m => m.project) };
  }
  const made = await createSharedMediaProject({ libraryId: live.library.id, videoPath: video.path, requestId: input.requestId }, { initialize: dependencies.initialize });
  return { status: 'opened', reused: false, ...made };
}
