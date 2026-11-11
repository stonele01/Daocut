/** Each structure draft is a private child project; media remains a read-only reference. */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { filmHtml } from '../../src/film-doc.mjs';
import { mediaContentHash } from '../../src/shared-media-reference.mjs';
import { readable } from './files.mjs';
import { readProjectFilm } from './film.mjs';
import { readSubtitleStyle, writeSubtitleStyle } from './captions.mjs';
import { FILM_SUBTITLE_DEFAULT } from './film-subtitle.mjs';
import { productSourcePath } from './product-transcription.mjs';
import { sharedMediaManifest } from './shared-media.mjs';
import { transcriptPath, translationsOf } from './transcripts.mjs';

export const STRUCTURE_DRAFTS_DIR = '.film/structure-drafts';
export const STRUCTURE_DRAFT_META = '.film/structure-draft.json';
const creating = new Map();
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { status: 409 }); };
const readJson = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const within = (root, path) => { const part = relative(root, path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); };
const assetPath = value => typeof value === 'string' && value.startsWith('assets/') && !value.includes('\\') && !value.includes(':') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));

/** Metadata resolves its parent from the fixed child-project location, never a stored absolute path. */
export async function structureDraftContext(root) {
  const meta = await readJson(join(root, STRUCTURE_DRAFT_META));
  if (!meta) return null;
  const parentRoot = resolve(root, '../../..');
  if (meta.version !== 1 || !/^[a-f0-9]{24}$/.test(meta.draftId ?? '') || meta.draftId !== basename(root)
    || resolve(root) !== join(parentRoot, STRUCTURE_DRAFTS_DIR, meta.draftId) || meta.parentRelative !== '../../..') fail('结构草稿与父工程位置不一致，未覆盖草稿');
  const parentId = (await readFile(join(parentRoot, '.film/id'), 'utf8')).trim();
  if (parentId !== meta.parentProjectId) fail('结构草稿与父工程身份不一致，未覆盖草稿');
  return { ...meta, parentRoot };
}

export async function listStructureDrafts(parentRoot) {
  const dir = join(parentRoot, STRUCTURE_DRAFTS_DIR);
  const entries = await readdir(dir, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const drafts = [];
  for (const entry of entries.filter(item => item.isDirectory() && /^[a-f0-9]{24}$/.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(dir, entry.name), meta = await structureDraftContext(root);
    if (meta) drafts.push({ root, meta });
  }
  return drafts;
}

/** Compare private work while an asynchronous shared import is in progress. */
export async function structureDraftPrivateState(parentRoot) {
  const base = join(parentRoot, STRUCTURE_DRAFTS_DIR), result = [];
  const entries = await readdir(base, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const smallState = new Set(['settings.json', 'subtitles.json', 'markers.json', 'product-analysis.json', 'source-takes.json', 'structure-draft.json']);
  async function walk(root, prefix = '') {
    for (const item of await readdir(root, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) fail('结构草稿不能通过链接保存个人修改');
      if (prefix.endsWith('/.film') && !smallState.has(item.name)) continue;
      if (item.isDirectory()) { if (item.name === '.film' || item.name === 'assets' || prefix.includes('/assets')) await walk(join(root, item.name), rel); }
      else if (item.isFile() && (item.name === 'film.html' || /\.(json|vtt)$/i.test(item.name))) result.push([rel, digest(await readFile(join(root, item.name), 'utf8'))]);
    }
  }
  for (const entry of entries.filter(item => item.isDirectory() && /^[a-f0-9]{24}$/.test(item.name))) await walk(join(base, entry.name), entry.name);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Restore child identities only after project-backup has verified all source bytes. */
export async function rebindStructureDrafts(parentRoot, sources) {
  const base = join(parentRoot, STRUCTURE_DRAFTS_DIR);
  const entries = await readdir(base, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const drafts = entries.filter(item => item.isDirectory() && /^[a-f0-9]{24}$/.test(item.name));
  if (!drafts.length) return;
  const parentProjectId = randomUUID();
  await writeFile(join(parentRoot, '.film/id'), `${parentProjectId}\n`);
  const parentManifest = await readJson(join(parentRoot, 'assets/.daocut-source-media.json'));
  const restoredIds = new Map();
  for (const entry of drafts) {
    const root = join(base, entry.name), meta = await readJson(join(root, STRUCTURE_DRAFT_META));
    if (meta?.version !== 1 || meta.draftId !== entry.name || meta.parentRelative !== '../../..') fail('备份中的结构草稿身份无效');
    const manifest = await readJson(join(root, 'assets/.daocut-source-media.json'));
    if (manifest?.version !== 1) fail('备份中的结构草稿缺少原片引用');
    for (const [asset, record] of Object.entries(manifest.items ?? {})) {
      const source = sources.find(item => item.assetPath === asset);
      if (!source || record.sha256 !== source.sha256 || record.size !== source.size) fail('备份中的草稿与父工程原片内容不一致');
      if (record.mode === 'project-reference') {
        if (record.parentProjectId !== meta.parentProjectId || record.parentAssetPath !== asset) fail('备份中的草稿原片引用身份不一致');
        record.parentProjectId = parentProjectId; record.libraryId = `project-${digest(parentProjectId).slice(0, 24)}`;
      } else if (record.mode === 'reference') {
        const parentRecord = parentManifest?.items?.[asset];
        if (!parentRecord || parentRecord.mode !== 'reference' || record.libraryId !== parentRecord.libraryId || record.relativePath !== parentRecord.relativePath) fail('备份中的草稿素材库引用不一致');
        Object.assign(record, parentRecord);
      } else fail('备份中的草稿原片引用类型无效');
    }
    meta.parentProjectId = parentProjectId;
    await writeFile(join(root, 'assets/.daocut-source-media.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(root, STRUCTURE_DRAFT_META), JSON.stringify(meta, null, 2));
    const oldId = await readFile(join(root, '.film/id'), 'utf8').then(value => value.trim(), error => { if (error.code === 'ENOENT') return `sd-${meta.draftId}`; throw error; });
    const nextId = `sd-${randomUUID()}`; restoredIds.set(oldId, nextId);
    await writeFile(join(root, '.film/id'), `${nextId}\n`);
  }
  const selectionPath = join(parentRoot, '.film/structure-workspace.json'), selection = await readJson(selectionPath);
  if (selection) await writeFile(selectionPath, JSON.stringify({ version: 1, activeProjectId: restoredIds.get(selection.activeProjectId) ?? parentProjectId }));
}

/** Small private documents are copied, never linked. Analysis configuration, jobs and credentials are excluded. */
async function copySmallFile(parent, child, rel, required = false) {
  let file;
  try { file = readable(parent, rel); } catch { file = join(parent, rel); }
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT' && !required) return null; throw error; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) fail(`草稿资料不能安全复制：${rel}`);
  const output = join(child, rel); await mkdir(dirname(output), { recursive: true }); await copyFile(file, output);
}

function checkedPlan(plan, analysis) {
  if (!plan || typeof plan.id !== 'string' || !plan.id || plan.id.length > 300 || !Array.isArray(plan.clips) || !plan.clips.length || ![1, 1.3].includes(plan.speed)) fail('结构方案缺少有效片段或播放速度无效');
  const sourceIds = [...new Set(plan.clips.map(clip => clip.sourceId))];
  if (sourceIds.length !== 1) fail('结构草稿只能使用当前讲解段的原片');
  const source = analysis.sources?.find(item => item.id === sourceIds[0]);
  if (!source || !assetPath(source.assetPath) || !(source.durationMs > 0)) fail('结构方案原片不存在或时长无效');
  const scopes = analysis.intervals?.filter(item => item.sourceId === source.id && (!plan.scope?.intervalId || item.id === plan.scope.intervalId)
    && plan.clips.every(clip => Number.isFinite(clip.startMs) && Number.isFinite(clip.endMs) && clip.startMs >= item.startMs && clip.endMs <= item.endMs && clip.endMs > clip.startMs)) ?? [];
  if (scopes.length !== 1) fail('结构方案不属于唯一的当前讲解段，未创建草稿');
  const scope = scopes[0];
  if (plan.scope && ['sourceId', 'productId', 'startMs', 'endMs'].some(key => plan.scope[key] !== undefined && plan.scope[key] !== scope[key])) fail('商品讲解范围已变化，请按当前方案重新选择');
  const clips = plan.clips.map(clip => {
    if ((clip.assetPath !== undefined && clip.assetPath !== source.assetPath) || clip.endMs > source.durationMs || typeof clip.text !== 'string' || !clip.text.trim()
      || !Array.isArray(clip.roles) || !Array.isArray(clip.coreIds)) fail('结构方案片段身份或原话无效');
    return { ...clip, assetPath: source.assetPath };
  });
  const durationMs = clips.reduce((sum, clip) => sum + clip.endMs - clip.startMs, 0) / plan.speed;
  if (!Number.isFinite(plan.durationMs) || Math.abs(plan.durationMs - durationMs) > 1) fail('结构方案时长与原片边界不一致');
  return { source, scope: { sourceId: scope.sourceId, productId: scope.productId, intervalId: scope.id, startMs: scope.startMs, endMs: scope.endMs }, clips, speed: plan.speed, durationMs };
}

/** Caller registers the returned root with openProject; this module never changes the global project list. */
export function ensureStructureDraft(parentRoot, { parentProjectId, plan }) {
  const key = JSON.stringify([resolve(parentRoot), parentProjectId, plan?.id, plan?.version ?? 1]);
  const previous = creating.get(key); if (previous) return previous;
  const work = create(parentRoot, parentProjectId, plan).finally(() => creating.delete(key));
  creating.set(key, work); return work;
}

async function create(parentRoot, parentProjectId, plan) {
  const parent = await realpath(parentRoot);
  if ((await readFile(join(parent, '.film/id'), 'utf8')).trim() !== parentProjectId) fail('父工程身份已变化，未创建草稿');
  if (await structureDraftContext(parent)) fail('请从原工程选择结构方案，不能在草稿内再嵌套草稿');
  const restored = (await listStructureDrafts(parent)).find(item => item.meta.planId === plan?.id && item.meta.planVersion === (plan?.version ?? 1));
  if (restored) return restored;
  const draftId = digest([parentProjectId, plan?.id, plan?.version ?? 1]).slice(0, 24);
  const base = join(parent, STRUCTURE_DRAFTS_DIR), root = join(base, draftId);
  const existing = await structureDraftContext(root);
  if (existing) return { root, meta: existing };
  const analysis = await readJson(join(parent, '.film/product-analysis.json'));
  const checked = checkedPlan(plan, analysis ?? {});
  const parentFilm = await readProjectFilm(parent);
  if (!parentFilm.value) fail('父工程成片文件无法读取，未创建草稿');
  await mkdir(base, { recursive: true });
  if (!within(parent, await realpath(base))) fail('结构草稿目录不能指向父工程之外');
  const stage = join(base, `.preparing-${randomUUID()}`);
  try {
  await mkdir(join(stage, '.film'), { recursive: true }); await mkdir(join(stage, 'assets'), { recursive: true });
  const source = checked.source, sourcePath = await productSourcePath(parent, source.assetPath), info = await stat(sourcePath);
  const sha256 = await mediaContentHash(sourcePath);
  const parentManifest = await sharedMediaManifest(parent), shared = parentManifest.items[source.assetPath];
  const record = shared?.mode === 'reference' ? structuredClone(shared) : {
    libraryId: `project-${digest(parentProjectId).slice(0, 24)}`, libraryName: '个人工程原片', relativePath: source.assetPath,
    mode: 'project-reference', parentProjectId, parentAssetPath: source.assetPath, size: info.size, mtimeMs: info.mtimeMs, sha256,
  };
  await writeFile(join(stage, 'assets/.daocut-source-media.json'), JSON.stringify({ version: 1, items: { [source.assetPath]: record } }, null, 2));
  for (const rel of ['.film/settings.json', '.film/subtitles.json', '.film/markers.json', '.film/product-analysis.json', '.film/source-takes.json']) await copySmallFile(parent, stage, rel);
  // An explicit snapshot prevents an untouched draft from inheriting another draft's browser-wide last style.
  await writeSubtitleStyle(stage, await readSubtitleStyle(parent) ?? FILM_SUBTITLE_DEFAULT);
  for (const rel of [transcriptPath(source.assetPath), ...(await translationsOf(parent, source.assetPath)).map(language => transcriptPath(source.assetPath, language))]) await copySmallFile(parent, stage, rel);
  let at = 0;
  const film = { stage: structuredClone(parentFilm.value.stage), tracks: [{ clips: checked.clips.map((clip, index) => {
    const value = { id: `structure-${index + 1}`, src: clip.assetPath, at: at / (1000 * checked.speed), time: [clip.startMs / 1000, clip.endMs / 1000], speed: checked.speed, attrs: { 'data-structure-source-id': clip.sourceId, 'data-structure-original-text': clip.text, 'data-structure-roles': clip.roles.join('|'), 'data-structure-core-ids': clip.coreIds.join('|') } };
    at += clip.endMs - clip.startMs; return value;
  }) }] };
  await writeFile(join(stage, 'film.html'), filmHtml(film));
  const meta = { version: 1, draftId, parentProjectId, parentRelative: '../../..', planId: plan.id, planVersion: plan.version ?? 1, scope: checked.scope, durationMs: checked.durationMs, createdAt: new Date().toISOString(), plan: structuredClone(plan) };
  await writeFile(join(stage, '.film/id'), `sd-${draftId}\n`);
  await writeFile(join(stage, STRUCTURE_DRAFT_META), JSON.stringify(meta, null, 2));
  // Publishing a complete child folder does not touch the parent's film or source files.
  try { await rename(stage, root); }
  catch (error) { const current = await structureDraftContext(root); if (!current) throw error; }
  return { root, meta: await structureDraftContext(root) };
  } finally { if (within(base, stage)) await rm(stage, { recursive: true, force: true }); }
}
