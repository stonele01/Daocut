/** Complete personal-project backups. Media on a shared library is verified, never copied. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { productSourcePath } from './product-transcription.mjs';
import { associateSharedLibrary } from './shared-media.mjs';
import { rebindRestoredProject } from './project-backup-rebind.mjs';
import { rebindStructureDrafts } from './structure-drafts.mjs';
import { ProjectBackupError } from './project-backup-error.mjs';
import { readPrefs, writePrefs, sharedAnalysisOf } from './prefs.mjs';
export { ProjectBackupError } from './project-backup-error.mjs';

export const PROJECT_BACKUP_MANIFEST = '.daocut-project-backup.json';
const STATE_FILES = new Set(['settings.json', 'subtitles.json', 'markers.json', 'product-analysis.json', 'source-takes.json', 'restore-provenance.json', 'structure-draft.json', 'structure-workspace.json']);
const STATE_DIRS = new Set(['product-transcripts', 'product-discovery', 'live-analysis', 'shared-analysis', 'structure-drafts']);
const EXCLUDED = new Set(['.git', 'node_modules', '.DS_Store', '.env', 'providers.json', 'byok-keys', 'company-session.bin', PROJECT_BACKUP_MANIFEST]);
const forbiddenKey = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|password|client[-_]?secret|app[-_]?secret)$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const posix = path => path.split(sep).join('/');
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const safePath = (root, path) => {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new ProjectBackupError('备份路径无效');
  const result = resolve(root, path); if (!within(resolve(root), result)) throw new ProjectBackupError('备份路径超出工程'); return result;
};
const optionalJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function absent(path) { try { await lstat(path); throw new ProjectBackupError('目标目录已存在，请选择新的个人工程目录', 409); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
async function sha256(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
function noSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey.test(key) && child) throw new ProjectBackupError('工程持久结果包含凭据字段，备份已停止；请先检查该结果');
    noSecrets(child);
  }
}
async function assertOrdinaryPath(root, path) {
  const rel = relative(root, path); let current = root;
  for (const part of rel.split(sep)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new ProjectBackupError('备份内容不能通过链接读取外部文件'); }
}
async function listProjectFiles(root, shared) {
  const output = [];
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = entry.name, path = prefix ? `${prefix}/${name}` : name;
      if (EXCLUDED.has(name) || name.startsWith('.env.') || (Object.hasOwn(shared, path) && shared[path].mode !== 'verified-copy')) continue;
      if ((prefix === '.film' || prefix.endsWith('/.film')) && !STATE_FILES.has(name) && !STATE_DIRS.has(name) && !(prefix.endsWith('/.film') && name === 'id')) continue;
      if (prefix.endsWith('/structure-drafts') && !/^[a-f0-9]{24}$/.test(name)) continue;
      if (!prefix && name.startsWith('.') && name !== '.film') continue;
      if (entry.isSymbolicLink()) throw new ProjectBackupError(`工程中有未登记的外部链接，无法完整备份：${path}`);
      if (entry.isDirectory()) await walk(join(dir, name), path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await walk(root); if (!output.includes('film.html')) throw new ProjectBackupError('所选目录不是可备份的工程'); return output.sort();
}

/** Writes a complete manifest last, then publishes the new directory by same-volume rename. */
export async function createProjectBackup(projectRoot, targetPath, options = {}) {
  const root = await realpath(projectRoot), target = resolve(targetPath);
  if (target === root || within(root, target)) throw new ProjectBackupError('备份目录必须在当前工程之外');
  await absent(target); await mkdir(dirname(target), { recursive: true });
  const stage = join(dirname(target), `.${basename(target)}.partial-${randomUUID()}`);
  const shared = (await optionalJson(join(root, 'assets/.daocut-source-media.json')))?.items ?? {};
  const analysis = await optionalJson(join(root, '.film/product-analysis.json'));
  const sources = [];
  for (const source of analysis?.sources ?? []) {
    safePath(root, source.assetPath);
    const input = await (options.resolveSource ?? productSourcePath)(root, source.assetPath), info = await stat(input);
    if (!info.isFile()) throw new ProjectBackupError('来源素材不可读取，无法确认备份身份');
    const resolvedPath = await realpath(input);
    sources.push({ sourceId: source.id, assetPath: source.assetPath, durationMs: source.durationMs, ...shared[source.assetPath], sha256: await sha256(input), size: info.size,
      fingerprint: { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, path: resolvedPath }, ino: info.ino });
  }
  for (const assetPath of Object.keys(shared)) if (!sources.some(source => source.assetPath === assetPath)) throw new ProjectBackupError('有共享素材未登记到商品来源，无法完整备份；请先修正素材关联');
  const files = [];
  try {
    await mkdir(stage);
    for (const path of await listProjectFiles(root, shared)) {
      options.signal?.throwIfAborted(); const input = safePath(root, path), output = safePath(stage, path), info = await stat(input);
      if (path.endsWith('.json')) noSecrets(JSON.parse(await readFile(input, 'utf8')));
      const before = await sha256(input); await mkdir(dirname(output), { recursive: true }); await (options.copyFile ?? copyFile)(input, output);
      await utimes(output, info.atime, info.mtime);
      if (await sha256(output) !== before || await sha256(input) !== before) throw new ProjectBackupError('工程正在修改，未生成混合版本备份，请保存后重试');
      files.push({ path, size: info.size, sha256: before }); options.onBytes?.(info.size);
    }
    // Recheck the whole snapshot, not merely each file during its copy.
    for (const file of files) if (await sha256(safePath(root, file.path)) !== file.sha256) throw new ProjectBackupError('工程正在修改，备份未完成');
    for (const source of sources) {
      const current = await stat(source.fingerprint.path);
      if (current.size !== source.fingerprint.size || current.mtimeMs !== source.fingerprint.mtimeMs || current.ctimeMs !== source.fingerprint.ctimeMs
        || (source.libraryId ? await sha256(source.fingerprint.path) !== source.sha256 : files.find(file => file.path === source.assetPath)?.sha256 !== source.sha256)) throw new ProjectBackupError('来源素材正在变化，备份未完成');
    }
    const manifest = { version: 1, state: 'complete', backupId: randomUUID(), name: basename(root), createdAt: new Date().toISOString(), sources, files };
    await writeFile(join(stage, PROJECT_BACKUP_MANIFEST), JSON.stringify({ ...manifest, manifestHash: digest(JSON.stringify(manifest)) }, null, 2), { flag: 'wx' });
    options.signal?.throwIfAborted(); await absent(target); await rename(stage, target); return { path: target, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function checkedBackup(path) {
  const root = await realpath(path); let manifest;
  try { manifest = await optionalJson(join(root, PROJECT_BACKUP_MANIFEST)); } catch { throw new ProjectBackupError('完整备份清单无法读取'); }
  if (!manifest || manifest.version !== 1 || manifest.state !== 'complete' || !Array.isArray(manifest.files) || !Array.isArray(manifest.sources)) throw new ProjectBackupError('该目录不是完整备份，不能恢复');
  const { manifestHash, ...body } = manifest;
  if (manifestHash !== digest(JSON.stringify(body))) throw new ProjectBackupError('备份清单校验失败');
  const seen = new Set();
  for (const file of manifest.files) {
    const input = safePath(root, file.path); if (seen.has(file.path)) throw new ProjectBackupError('备份文件重复'); seen.add(file.path);
    await assertOrdinaryPath(root, input);
    const info = await stat(input); if (!info.isFile() || info.size !== file.size || await sha256(input) !== file.sha256) throw new ProjectBackupError(`备份文件校验失败：${file.path}`);
  }
  if (!seen.has('film.html')) throw new ProjectBackupError('完整备份缺少工程文件');
  for (const source of manifest.sources) { safePath(root, source.assetPath); if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new ProjectBackupError('来源内容校验信息无效'); }
  return { root, manifest };
}
export async function inspectProjectBackup(path) {
  const { root, manifest } = await checkedBackup(path);
  let hasPendingResults = false;
  for (const file of manifest.files.filter(file => file.path.startsWith('.film/shared-analysis/') && file.path.endsWith('.json'))) {
    const state = await optionalJson(safePath(root, file.path)); hasPendingResults ||= !!state?.outbox;
  }
  return { backupId: manifest.backupId, name: manifest.name, fileCount: manifest.files.length, sources: manifest.sources, hasPendingResults,
    libraries: [...new Map(manifest.sources.filter(source => source.libraryId && source.mode !== 'verified-copy').map(source => [source.libraryId, { id: source.libraryId, name: source.libraryName }])).values()] };
}

export async function restoreProjectBackup(input, options = {}) {
  if (input.confirmed !== true) throw new ProjectBackupError('请确认恢复到新个人工程');
  const { root, manifest } = await checkedBackup(input.backupPath);
  if (input.expectedBackupId !== manifest.backupId) throw new ProjectBackupError('备份已变化，请重新检查');
  if (!isAbsolute(input.targetPath ?? '')) throw new ProjectBackupError('请选择新个人工程的绝对路径');
  const target = resolve(input.targetPath); if (target === root || within(root, target)) throw new ProjectBackupError('恢复目录不能位于备份内'); await absent(target);
  const mappings = new Map((input.mappings ?? []).map(mapping => [mapping.libraryId, mapping.root]));
  const requestedRoots = input.resultRoots ?? [];
  if (sharedAnalysisOf({ resultRoots: requestedRoots }).resultRoots.length !== requestedRoots.length) throw new ProjectBackupError('共享结果目录映射无效');
  const resolvedSources = [];
  for (const source of manifest.sources) {
    let path;
    if (source.libraryId && source.mode !== 'verified-copy') {
      const mapped = mappings.get(source.libraryId); if (!mapped || !isAbsolute(mapped)) throw new ProjectBackupError(`请映射素材库：${source.libraryName}`);
      const libraryRoot = await realpath(mapped); path = await realpath(safePath(libraryRoot, source.relativePath));
      if (!within(libraryRoot, path)) throw new ProjectBackupError('素材库映射超出库目录');
    } else path = safePath(root, source.assetPath);
    const verifiedInfo = await stat(path);
    if (!verifiedInfo.isFile() || await sha256(path) !== source.sha256) throw new ProjectBackupError(`同名素材内容不一致，未恢复：${source.assetPath}`);
    resolvedSources.push({ ...source, resolvedPath: path, verifiedInfo });
  }
  await mkdir(dirname(target), { recursive: true }); const stage = join(dirname(target), `.${basename(target)}.restore-${randomUUID()}`), warnings = [];
  try {
    await mkdir(stage);
    for (const file of manifest.files) { const output = safePath(stage, file.path), from = safePath(root, file.path); await mkdir(dirname(output), { recursive: true }); await (options.copyFile ?? copyFile)(from, output); const info = await stat(from); await utimes(output, info.atime, info.mtime); if (await sha256(output) !== file.sha256) throw new ProjectBackupError('恢复文件校验失败'); }
    const shared = await optionalJson(join(stage, 'assets/.daocut-source-media.json'));
    for (const source of resolvedSources.filter(source => source.libraryId)) {
      const record = shared?.items?.[source.assetPath];
      if (shared?.version !== 1 || !record || record.libraryId !== source.libraryId || record.relativePath !== source.relativePath || record.mode !== source.mode
        || (source.mode != null && !['reference', 'verified-copy'].includes(source.mode))) throw new ProjectBackupError('共享素材与备份来源身份不一致，恢复已停止');
      // Old backups omitted mode and depended on native file symlinks. Full bytes and the saved
      // library identity were checked above: restore the same source as a read-only logical reference.
      const mode = source.mode === 'verified-copy' ? 'verified-copy' : 'reference';
      if (mode === 'reference' && manifest.files.some(file => file.path === source.assetPath)) throw new ProjectBackupError('共享素材引用与备份中的实体文件冲突');
      Object.assign(record, { mode, sha256: source.sha256, size: source.verifiedInfo.size, mtimeMs: source.verifiedInfo.mtimeMs });
    }
    if (shared) await writeFile(join(stage, 'assets/.daocut-source-media.json'), JSON.stringify(shared));
    warnings.push(...await rebindRestoredProject(stage, target, resolvedSources, { ...options, resultRoots: input.resultRoots ?? [], backupId: manifest.backupId }));
    await rebindStructureDrafts(stage, resolvedSources);
    await mkdir(join(stage, '.film'), { recursive: true });
    await writeFile(join(stage, '.film/restore-provenance.json'), JSON.stringify({ backupId: manifest.backupId, restoredAt: new Date().toISOString(), sources: resolvedSources.map(({ sourceId, sha256: contentHash }) => ({ sourceId, contentHash })), warnings }));
    // A NAS file can be replaced while the personal files are being copied. Do not publish that
    // half-valid restoration; only the new staging directory is discarded, never the source/backup.
    for (const source of resolvedSources.filter(source => source.libraryId && source.mode !== 'verified-copy')) {
      const contentHash = await sha256(source.resolvedPath), info = await stat(source.resolvedPath);
      if (contentHash !== source.sha256 || ['size', 'mtimeMs', 'ctimeMs', 'ino'].some(key => info[key] !== source.verifiedInfo[key])) throw new ProjectBackupError('来源素材在恢复期间发生变化，恢复已停止');
    }
    await absent(target); await rename(stage, target);
  } finally { await rm(stage, { recursive: true, force: true }); }
  // These are explicit local library associations, never a write to the library itself.
  try {
    for (const source of resolvedSources.filter(source => source.libraryId && source.mode !== 'verified-copy')) await (options.associateLibrary ?? associateSharedLibrary)({ id: source.libraryId, name: source.libraryName, root: mappings.get(source.libraryId) });
    if (requestedRoots.length) {
      const prefs = readPrefs(), merged = new Map(prefs.sharedAnalysis.resultRoots.map(mapping => [mapping.libraryId, mapping]));
      for (const mapping of requestedRoots) merged.set(mapping.libraryId, mapping);
      writePrefs({ sharedAnalysis: { ...prefs.sharedAnalysis, resultRoots: [...merged.values()] } });
    }
  } catch { warnings.push('工程已完整恢复，但本机素材库映射保存失败；请在素材库设置重新关联后使用原片。'); }
  return { path: target, warnings };
}
