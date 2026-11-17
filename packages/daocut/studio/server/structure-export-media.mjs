/** Save the selected ranges, then hand their rebased edit to the existing Jianying exporter. */
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import { clipSpan, kindOf, filmHtml, readFilmFile } from '../../src/film-doc.mjs';
import { mediaContentHash, SAMPLED_MEDIA_IDENTITY } from '../../src/shared-media-reference.mjs';
import { probeSource } from './nle.mjs';
import { clipCues } from './captions.mjs';
import { parseVtt, transcriptPath, translationsOf, vttOf } from './transcripts.mjs';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashFile = async file => { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex'); };
const optional = async file => fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
const sameSource = (info, saved) => ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev'].every(key => info[key] === saved[key]);
const error = message => Object.assign(new Error(message), { code: 'STRUCTURE_EXPORT_MEDIA', status: 409 });

async function checkSource(source) {
  if (!sameSource(await fs.stat(source.sourcePath), source.identity)) throw error('原片在排队期间发生变化，请重新选择方案导出');
  if (await mediaContentHash(source.sourcePath, { identityKind: SAMPLED_MEDIA_IDENTITY }) !== source.captureHash) throw error('原片内容已变化，未导出其他版本');
  // Old project references use a full digest. Reuse its verified cache, but never treat it as a sampled digest.
  if (source.sha256 && !source.identityKind && await mediaContentHash(source.sourcePath) !== source.sha256) throw error('原片内容与保存的身份不一致');
}

async function encode(source, range, facts, part) {
  const video = facts.hasVideo ? ['-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-threads', '2', '-fps_mode', 'passthrough'] : ['-vn'];
  const audio = facts.hasAudio ? ['-map', '0:a:0', '-af', 'aresample=48000:async=1:first_pts=0,apad', '-c:a', 'aac', '-b:a', '192k'] : ['-an'];
  await new Promise((done, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', String(range.from), '-i', source.sourcePath,
      '-t', String(range.to - range.from), ...video, ...audio, '-sn', '-dn', '-movflags', '+faststart', part], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let message = '';
    child.stderr.on('data', bytes => { message = (message + bytes).slice(-6000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? done() : reject(Object.assign(error(`选段保存失败：${message.trim() || `ffmpeg ${code}`}`), /space left|disk.*full/i.test(message) ? { code: 'ENOSPC' } : {})));
  });
}

async function segment(source, range, facts, mediaRoot) {
  await checkSource(source);
  const key = sha(['selected-media-v1', source.sourcePath, source.identity, source.captureHash, range]);
  const target = join(mediaRoot, `${key}${range ? facts.hasVideo ? '.mp4' : '.m4a' : extname(source.assetPath)}`), receiptFile = target + '.json';
  const receiptText = await optional(receiptFile);
  if (receiptText) {
    const saved = JSON.parse(receiptText), info = await fs.stat(target);
    if (saved.key !== key || info.size !== saved.size || await hashFile(target) !== saved.sha256) throw error('已保存选段发生变化，未覆盖已有文件');
    return { ...saved, path: target, info };
  }
  const exists = await fs.stat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (exists) throw error('选段文件缺少完成记录，请重新建立导出批次');
  const space = await fs.statfs(mediaRoot), available = Number(space.bsize) * Number(space.bavail);
  const estimated = range ? Math.ceil((range.to - range.from) * (facts.hasVideo ? Math.max(1e6, (facts.w || 1920) * (facts.h || 1080) * (facts.fps || 30) * 0.25) / 8 + 24000 : 24000)) : source.identity.size;
  if (available < estimated + 16 * 1024 ** 2) throw Object.assign(error(`导出磁盘空间不足：所用片段预计需要 ${(estimated / 1e6).toFixed(1)} MB，当前可用 ${(available / 1e6).toFixed(1)} MB。请释放空间后继续。`), { code: 'ENOSPC' });
  const part = join(mediaRoot, `${key}.${randomUUID()}.part${extname(target)}`);
  try {
    if (range) {
      await encode(source, range, facts, part);
      const actual = await probeSource(part), tolerance = Math.max(0.08, 2 / (facts.fps || 30));
      if (!Number.isFinite(actual.duration) || Math.abs(actual.duration - (range.to - range.from)) > tolerance || Boolean(actual.hasVideo) !== Boolean(facts.hasVideo) || Boolean(actual.hasAudio) !== Boolean(facts.hasAudio)) throw error('选段时长或音画轨道不符，未发布不完整片段');
    } else await fs.copyFile(source.sourcePath, part, constants.COPYFILE_EXCL);
    await checkSource(source);
    const saved = { key, sha256: await hashFile(part), size: (await fs.stat(part)).size, range };
    await fs.rename(part, target);
    await fs.writeFile(receiptFile, JSON.stringify(saved), { flag: 'wx' });
    return { ...saved, path: target, info: await fs.stat(target) };
  } finally { await fs.rm(part, { force: true }); }
}

async function transcriptForClip(snapshot, source, asset, span, directory) {
  const original = await optional(join(snapshot.root, transcriptPath(source.assetPath)));
  if (!original) return;
  const parsed = parseVtt(original), alt = new Map(), languages = await translationsOf(snapshot.root, source.assetPath);
  for (const language of languages) for (const line of parseVtt(await fs.readFile(join(snapshot.root, transcriptPath(source.assetPath, language)), 'utf8')).lines) alt.set(line.startMs, { ...alt.get(line.startMs), [language]: line.text });
  // Use the existing caption cutter, including words, translations and manual subtitle cuts.
  const cues = clipCues(parsed.lines, { fromMs: span.from * 1000, startMs: 0, durMs: span.length * 1000, speed: span.speed }, { alt, cut: parsed.cut });
  const lines = language => cues.map(cue => {
    let index = 0;
    const marks = !language && cue.words?.map(word => { const at = cue.text.indexOf(word.text, index); index = Math.max(index, at + word.text.length); return { index: Math.max(0, at), startMs: Math.round(word.startMs * span.speed) }; });
    return { text: language ? cue.alt?.[language] ?? '' : cue.text, startMs: Math.round(cue.startMs * span.speed), endMs: Math.round((cue.startMs + cue.durMs) * span.speed), ...(marks ? { marks } : {}) };
  }).filter(line => line.text);
  await fs.writeFile(join(directory, transcriptPath(asset)), vttOf(lines(), { speaker: parsed.speaker, cut: true }));
  for (const language of languages) await fs.writeFile(join(directory, transcriptPath(asset, language)), vttOf(lines(language), { cut: true }));
}

export async function materializeSelectedMedia(snapshot, { mediaRoot, mediaCache, validateSnapshot }) {
  const root = resolve(mediaRoot); await fs.mkdir(root, { recursive: true });
  const exportRoot = join(snapshot.root, 'selected-export'), receiptFile = join(exportRoot, '.film/selected-export.json');
  const previous = await optional(receiptFile);
  if (previous) {
    const receipt = JSON.parse(previous);
    if (receipt.revision !== snapshot.revision) throw error('选段导出版本已变化');
    for (const file of receipt.files) if (await hashFile(join(exportRoot, file.path)) !== file.sha256) throw error('已保存的选段导出内容已变化');
    return { ...snapshot, exportRoot };
  }
  const stage = `${exportRoot}.preparing-${randomUUID()}`;
  await fs.mkdir(join(stage, '.film'), { recursive: true }); await fs.mkdir(join(stage, 'assets'));
  try {
    const originalFilm = await fs.readFile(join(snapshot.root, 'film.html'), 'utf8'), film = readFilmFile(originalFilm).value;
    if (!film) throw error('固定方案无法读取');
    for (const file of snapshot.files.filter(f => f.path.startsWith('.film/'))) { await fs.mkdir(dirname(join(stage, file.path)), { recursive: true }); await fs.copyFile(join(snapshot.root, file.path), join(stage, file.path)); }
    let serial = 0;
    const factsCache = new Map();
    for (const track of film.tracks) for (const clip of track.clips) {
      const source = snapshot.media.find(s => s.assetPath === clip.src);
      if (!source) throw error('固定方案缺少片段原片');
      const moving = ['video', 'sound'].includes(kindOf(clip));
      if (!factsCache.has(source.sourcePath)) factsCache.set(source.sourcePath, await probeSource(source.sourcePath));
      const facts = factsCache.get(source.sourcePath), span = clipSpan(clip, facts.duration), range = moving ? { from: span.from, to: span.to } : null;
      const key = JSON.stringify([root, source.sourcePath, source.identity, source.captureHash, range]);
      let work = mediaCache.get(key);
      if (!work) { work = segment(source, range, facts, root); mediaCache.set(key, work); void work.catch(e => { if (e.code !== 'ENOSPC' && mediaCache.get(key) === work) mediaCache.delete(key); }); }
      const saved = await work, info = await fs.stat(saved.path), asset = `assets/selected-${++serial}${extname(saved.path)}`;
      if (['size', 'mtimeMs', 'ino', 'dev'].some(k => info[k] !== saved.info[k])) throw error('已保存选段发生变化');
      try { await fs.link(saved.path, join(stage, asset)); }
      catch (e) { if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(e.code)) throw e; await fs.copyFile(saved.path, join(stage, asset), constants.COPYFILE_EXCL); }
      if (moving) { await transcriptForClip(snapshot, source, asset, span, stage); clip.time = [0, span.to - span.from]; }
      clip.src = asset;
    }
    await fs.writeFile(join(stage, 'film.html'), filmHtml(film, originalFilm));
    await validateSnapshot(snapshot);
    for (const source of snapshot.media) await checkSource(source);
    const files = [];
    async function visit(dir, prefix = '') { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const rel = prefix + entry.name; if (entry.isDirectory()) await visit(join(dir, entry.name), rel + '/'); else files.push({ path: rel, sha256: await hashFile(join(dir, entry.name)) }); } }
    await visit(stage);
    await fs.writeFile(join(stage, '.film/selected-export.json'), JSON.stringify({ revision: snapshot.revision, files }));
    await fs.rename(stage, exportRoot);
    return { ...snapshot, exportRoot };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
