/** Freeze selected structure edits before any large-media copy or queued export starts. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';
import { inspectMediaReference } from '../../src/shared-media-reference.mjs';
import { readable } from './files.mjs';
import { listStructureDrafts, STRUCTURE_DRAFT_META } from './structure-drafts.mjs';
import { FILM_SUBTITLE_DEFAULT } from './film-subtitle.mjs';
import { frameRateOf } from './project-settings.mjs';
import { transcriptPath, translationsOf } from './transcripts.mjs';

const SNAPSHOT = '.film/structure-export-snapshot.json';
const STATIC_MEDIA = /\.(mp4|mov|mkv|avi|m4v|webm|wmv|flv|ts|mts|m2ts|wav|m4a|mp3|aac|ogg|flac|png|jpe?g|webp|gif|bmp|tiff?)$/i;
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'STRUCTURE_EXPORT_SNAPSHOT' }); };
const inside = (root, path) => { const back = relative(resolve(root), resolve(path)); return back === '' || (!isAbsolute(back) && back !== '..' && !back.startsWith(`..${sep}`)); };
const safeAsset = value => typeof value === 'string' && value.startsWith('assets/') && !/[\\:\0]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
const identity = info => ({ size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev });
const sameIdentity = (left, right) => ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(key => left[key] === right[key]);
const optional = async path => fs.lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const fileHash = async path => { const h = createHash('sha256'); for await (const part of createReadStream(path)) h.update(part); return h.digest('hex'); };

function publicFilm(plan, analysis, parentFilm) {
  if (!plan?.id || !Array.isArray(plan.clips) || !plan.clips.length || ![1, 1.3].includes(plan.speed)) fail('公共方案缺少完整片段或播放速度无效');
  const sourceIds = new Set(plan.clips.map(clip => clip.sourceId));
  const source = sourceIds.size === 1 && analysis.sources?.find(item => sourceIds.has(item.id));
  if (!source || !safeAsset(source.assetPath) || !(source.durationMs > 0)) fail('公共方案原片或时长无效');
  const scope = analysis.intervals?.find(item => item.id === plan.scope?.intervalId && item.sourceId === source.id && item.productId === plan.scope?.productId);
  if (!scope || ['sourceId', 'productId', 'startMs', 'endMs'].some(key => plan.scope?.[key] !== scope[key])) fail('商品讲解范围已变化，未导出旧范围方案');
  let at = 0;
  const clips = plan.clips.map((clip, index) => {
    if (!Number.isSafeInteger(clip.startMs) || !Number.isSafeInteger(clip.endMs) || clip.startMs < scope.startMs || clip.endMs > scope.endMs || clip.endMs > source.durationMs || clip.endMs <= clip.startMs || typeof clip.text !== 'string' || !clip.text.trim() || !Array.isArray(clip.roles) || !Array.isArray(clip.coreIds) || (clip.assetPath !== undefined && clip.assetPath !== source.assetPath)) fail('公共方案片段边界、原话或原片身份无效');
    const value = { id: `structure-${index + 1}`, src: source.assetPath, at: at / (1000 * plan.speed), time: [clip.startMs / 1000, clip.endMs / 1000], speed: plan.speed, attrs: { 'data-structure-source-id': clip.sourceId, 'data-structure-original-text': clip.text, 'data-structure-roles': clip.roles.join('|'), 'data-structure-core-ids': clip.coreIds.join('|') } };
    at += clip.endMs - clip.startMs; return value;
  });
  if (Math.abs(at / plan.speed - plan.durationMs) > 1 || !Number.isFinite(plan.durationMs)) fail('公共方案时长与片段不一致');
  return filmHtml({ stage: structuredClone(parentFilm.stage), tracks: [{ clips }] });
}

/** Captures small documents only. All returned fields can be persisted as JSON. */
export async function captureStructureExport(project, { plan, itemRoot }) {
  const parent = await fs.realpath(project.path), output = resolve(itemRoot);
  if (await optional(output)) fail('导出快照目录已经存在，未覆盖已有内容');
  const guards = new Map(), files = new Map();
  async function small(root, rel, required = false) {
    const path = join(root, rel), info = await optional(path);
    if (!info) { if (required) fail(`导出资料缺失：${rel}`); guards.set(path, null); return null; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024 || !inside(root, await fs.realpath(path))) fail(`不支持的导出资料：${rel}`);
    const bytes = await fs.readFile(path);
    if (!sameIdentity(identity(info), identity(await fs.stat(path)))) fail(`导出资料读取期间发生变化：${rel}`);
    guards.set(path, { identity: identity(info), hash: hash(bytes) });
    return bytes;
  }
  const parentId = (await small(parent, '.film/id', true)).toString('utf8').trim();
  if (project.id !== parentId) fail('工程身份已变化，未创建导出快照');
  const matches = (await listStructureDrafts(parent)).filter(item => item.meta.planId === plan?.id && item.meta.planVersion === (plan?.version ?? 1));
  if (matches.length > 1) fail('同一方案存在多份私人草稿，请先核对要导出的草稿');
  const draft = matches[0], sourceRoot = draft?.root ?? parent;
  const sourceProjectId = (await small(sourceRoot, '.film/id', true)).toString('utf8').trim();
  if (draft) await small(sourceRoot, STRUCTURE_DRAFT_META, true);
  const filmBytes = await small(sourceRoot, 'film.html', true), parsed = readFilmFile(filmBytes.toString('utf8'));
  if (!parsed.doc || !parsed.value) fail('成片文件无法读取，未创建导出快照');
  let film = filmBytes;
  if (!draft) {
    const analysisBytes = await small(parent, '.film/product-analysis.json', true);
    film = Buffer.from(publicFilm(plan, JSON.parse(analysisBytes.toString('utf8')), parsed.value));
  }
  files.set('film.html', film);
  const chosen = readFilmFile(film.toString('utf8')).value;
  const assets = [...new Set(chosen.tracks.flatMap(track => track.clips.map(clip => clip.src)))];
  if (!assets.length) fail('所选草稿没有可导出的片段');
  if (assets.some(asset => !safeAsset(asset) || !STATIC_MEDIA.test(asset))) fail('批量结构导出暂不支持网页、动态依赖或非静态素材，请使用普通导出');
  for (const rel of ['.film/settings.json', '.film/subtitles.json', '.film/markers.json']) {
    const bytes = await small(sourceRoot, rel);
    if (bytes) files.set(rel, bytes);
  }
  if (!files.has('.film/subtitles.json')) files.set('.film/subtitles.json', Buffer.from(JSON.stringify(FILM_SUBTITLE_DEFAULT)));
  const rawManifest = await small(sourceRoot, 'assets/.daocut-source-media.json');
  const manifest = rawManifest ? JSON.parse(rawManifest.toString('utf8')) : null;
  const media = [], transcriptLists = new Map();
  for (const assetPath of assets) {
    const reference = inspectMediaReference(sourceRoot, assetPath);
    const sourcePath = await fs.realpath(reference?.path ?? readable(sourceRoot, assetPath));
    const info = await fs.stat(sourcePath);
    if (!info.isFile()) fail(`原片不可用：${assetPath}`);
    const record = reference?.reference ?? manifest?.items?.[assetPath];
    if (record && (info.size !== record.size || (record.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(record.sha256)))) fail(`原片身份已变化：${assetPath}`);
    media.push({ assetPath, sourcePath, identity: identity(info), ...(record?.sha256 ? { sha256: record.sha256 } : {}) });
    const translations = (await translationsOf(sourceRoot, assetPath)).sort(); transcriptLists.set(assetPath, translations);
    for (const rel of [transcriptPath(assetPath), ...translations.map(language => transcriptPath(assetPath, language))]) {
      const bytes = await small(sourceRoot, rel); if (bytes) files.set(rel, bytes);
    }
  }
  const fileList = [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes), size: bytes.length })).sort((a, b) => a.path.localeCompare(b.path));
  const settings = files.has('.film/settings.json') ? JSON.parse(files.get('.film/settings.json').toString('utf8')) : {};
  const fps = frameRateOf(settings.fps) ?? 30;
  const revision = hash({ planId: plan.id, planVersion: plan.version ?? 1, sourceProjectId, origin: draft ? 'private' : 'public', files: fileList, media, fps });
  const snapshot = { version: 1, root: output, revision, origin: draft ? 'private' : 'public', sourceProjectId, planId: plan.id, planVersion: plan.version ?? 1, files: fileList, media, fps };
  await fs.mkdir(dirname(output), { recursive: true });
  const stage = `${output}.capturing-${randomUUID()}`;
  await fs.mkdir(stage);
  try {
    for (const [rel, bytes] of files) { const path = join(stage, rel); await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, bytes, { flag: 'wx' }); }
    await fs.writeFile(join(stage, SNAPSHOT), JSON.stringify(snapshot), { flag: 'wx' });
    for (const [path, expected] of guards) {
      const current = await optional(path);
      if (!expected ? current !== null : !current || !current.isFile() || current.isSymbolicLink() || !sameIdentity(expected.identity, identity(current)) || hash(await fs.readFile(path)) !== expected.hash) fail('导出资料在准备期间发生变化，请保存完成后重新导出');
    }
    for (const [asset, expected] of transcriptLists) if (JSON.stringify((await translationsOf(sourceRoot, asset)).sort()) !== JSON.stringify(expected)) fail('字幕在准备期间发生变化，请重新导出');
    for (const source of media) if (!sameIdentity(identity(await fs.stat(source.sourcePath)), source.identity)) fail(`原片在准备期间发生变化：${source.assetPath}`);
    const currentDrafts = (await listStructureDrafts(parent)).filter(item => item.meta.planId === plan.id && item.meta.planVersion === (plan.version ?? 1));
    if (currentDrafts.length !== matches.length || currentDrafts[0]?.root !== draft?.root) fail('个人草稿在准备期间发生变化，请重新导出');
    if (await optional(output)) fail('导出快照目录已经存在，未覆盖已有内容');
    await fs.rename(stage, output);
    return snapshot;
  } finally { if (inside(dirname(output), stage)) await fs.rm(stage, { recursive: true, force: true }); }
}

async function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !isAbsolute(snapshot.root) || !/^[a-f0-9]{64}$/.test(snapshot.revision ?? '')) fail('导出快照身份无效');
  const stored = JSON.parse(await fs.readFile(join(snapshot.root, SNAPSHOT), 'utf8'));
  const captured = { ...snapshot }; delete captured.frozenMedia;
  if (JSON.stringify(stored) !== JSON.stringify(captured)) fail('导出快照记录已变化');
  for (const file of snapshot.files) if (!inside(snapshot.root, join(snapshot.root, file.path)) || hash(await fs.readFile(join(snapshot.root, file.path))) !== file.sha256) fail('导出快照内容已变化，未使用新的修改');
}

async function frozenMedia(source, mediaRoot) {
  const check = async () => {
    const info = await fs.stat(source.sourcePath);
    if (!info.isFile() || !sameIdentity(identity(info), source.identity)) fail(`原片在排队期间发生变化：${source.assetPath}`);
  };
  await check();
  const key = hash([source.sourcePath, source.identity]), target = join(mediaRoot, `${key}${extname(source.assetPath).toLowerCase()}`);
  const existing = await optional(target);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== source.identity.size) fail('已冻结素材发生变化');
    const sha256 = await fileHash(target), expected = source.sha256 ?? await fileHash(source.sourcePath);
    await check();
    if (sha256 !== expected) fail('已冻结素材与原片身份不一致');
    return { path: target, sha256, identity: identity(await fs.stat(target)) };
  }
  const part = `${target}.copying-${randomUUID()}`;
  try {
    await fs.copyFile(source.sourcePath, part, constants.COPYFILE_EXCL);
    const copied = await fs.stat(part), sha256 = await fileHash(part);
    await check();
    if (copied.size !== source.identity.size || (source.sha256 && sha256 !== source.sha256)) fail(`原片内容与保存的身份不一致：${source.assetPath}`);
    await fs.rename(part, target);
    return { path: target, sha256, identity: identity(await fs.stat(target)) };
  } finally { await fs.rm(part, { force: true }); }
}

/** Materialize persistent media once per batch; hard links always point at our copy, never an original. */
export async function materializeStructureExport(snapshot, { mediaRoot, mediaCache = new Map() }) {
  await validateSnapshot(snapshot);
  const root = resolve(mediaRoot); await fs.mkdir(root, { recursive: true });
  const frozen = [];
  for (const source of snapshot.media) {
    if (!safeAsset(source.assetPath) || !STATIC_MEDIA.test(source.assetPath) || !isAbsolute(source.sourcePath)) fail('导出素材引用无效');
    const info = await fs.stat(source.sourcePath);
    if (!sameIdentity(identity(info), source.identity)) fail(`原片在排队期间发生变化：${source.assetPath}`);
    const key = JSON.stringify([root, source.sourcePath, source.identity]);
    let work = mediaCache.get(key);
    if (!work) {
      work = frozenMedia(source, root); mediaCache.set(key, work);
      void work.catch(() => { if (mediaCache.get(key) === work) mediaCache.delete(key); });
    }
    const copied = await work, output = join(snapshot.root, source.assetPath), cacheInfo = await fs.stat(copied.path);
    // Linking changes ctime, but must never change the copied file's identity, size or contents timestamp.
    if (['size', 'mtimeMs', 'ino', 'dev'].some(key => cacheInfo[key] !== copied.identity[key]) || (source.sha256 && source.sha256 !== copied.sha256)) fail('已冻结素材发生变化或与原片身份不一致');
    await fs.mkdir(dirname(output), { recursive: true });
    const present = await optional(output);
    if (present) {
      if (present.isSymbolicLink() || present.ino !== cacheInfo.ino || present.dev !== cacheInfo.dev) fail('导出素材位置已有其他文件，未覆盖');
    } else {
      try { await fs.link(copied.path, output); }
      catch (error) { fail(`当前导出位置不支持硬链接，已停止，未重复复制整场原片：${error.code ?? error.message}`); }
    }
    frozen.push({ assetPath: source.assetPath, sha256: copied.sha256, path: output });
  }
  await validateSnapshot(snapshot);
  return { ...snapshot, frozenMedia: frozen };
}
