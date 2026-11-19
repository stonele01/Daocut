/** Assemble frozen selected edits, then use the ordinary Jianying export queue once. */
import fs from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { clipSpan, filmHtml, kindOf, readFilmFile } from '../../src/film-doc.mjs';
import { subtitlesForExport } from './captions.mjs';
import { filmSubtitleShown } from './film-subtitle.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const planGapSeconds = 1;
const revisionOf = (parts, gapSeconds) => {
  const revisions = parts.map(part => [part.root, part.revision]);
  // Batches saved before timeline gaps were introduced must still resume their original edit.
  return hash(gapSeconds === undefined ? revisions : { revisions, gapSeconds });
};
const hashFile = async file => { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex'); };

export async function captureCombinedExport(project, { selected, itemRoot, capture }) {
  const parts = [];
  for (const { plan, ordinal } of selected) {
    const root = join(itemRoot, String(ordinal).padStart(3, '0'));
    const snapshot = await capture(project, { plan, itemRoot: root });
    if (resolve(snapshot.root) !== resolve(root) || !snapshot.revision) throw Error('导出快照身份无效');
    parts.push(snapshot);
  }
  return { kind: 'combined', root: itemRoot, parts, gapSeconds: planGapSeconds, revision: revisionOf(parts, planGapSeconds), fps: parts[0].fps,
    origin: parts.every(part => part.origin === parts[0].origin) ? parts[0].origin : 'mixed' };
}

export async function materializeCombinedExport(snapshot, { materialize, ...options }) {
  if (!snapshot.parts?.length || snapshot.revision !== revisionOf(snapshot.parts, snapshot.gapSeconds)
    || snapshot.parts.some(part => resolve(dirname(part.root)) !== resolve(snapshot.root) || !/^\d+$/.test(part.root.split(/[\\/]/).at(-1)))) throw Error('合并导出版本不匹配');
  // Reuse range extraction, verification and the same media cache for every plan.
  const prepared = [];
  for (const part of snapshot.parts) {
    try { prepared.push(await materialize(part, options) ?? part); }
    catch (error) { throw Object.assign(new Error(`方案 ${part.root.split(/[\\/]/).at(-1)}：${error.message}`, { cause: error }), { code: error.code, status: error.status }); }
  }
  const recut = prepared.some(part => part.exportRoot === join(part.root, 'selected-export-recut'));
  const exportRoot = join(snapshot.root, recut ? 'combined-export-recut' : 'combined-export');
  const stage = `${exportRoot}.preparing-${randomUUID()}`;
  await fs.mkdir(join(stage, 'assets'), { recursive: true });
  try {
    const tracks = [], cues = [], sources = new Map();
    let canvas, offset = 0, serial = 0;
    for (const [index, part] of prepared.entries()) {
      if (index > 0) offset += snapshot.gapSeconds ?? 0;
      const root = part.exportRoot ?? part.root;
      const film = readFilmFile(await fs.readFile(join(root, 'film.html'), 'utf8')).value;
      if (!film) throw Error('固定方案无法读取');
      canvas ??= film.stage;
      let duration = 0;
      for (const [trackIndex, track] of film.tracks.entries()) {
        // Share a lane only when its visibility/audio flags match; otherwise keep the saved state.
        const laneKey = JSON.stringify([trackIndex, Boolean(track.hidden), Boolean(track.muted)]);
        let lane = tracks.find(value => value.key === laneKey);
        if (!lane) { lane = { key: laneKey, trackIndex, ...track, clips: [] }; tracks.push(lane); }
        for (const original of track.clips) {
          const clip = structuredClone(original), span = clipSpan(clip);
          duration = Math.max(duration, (clip.at ?? 0) + span.length);
          const source = join(root, clip.src);
          let asset = sources.get(source);
          if (!asset) {
            asset = `assets/selected-${++serial}${extname(clip.src)}`;
            try { await fs.link(source, join(stage, asset)); }
            catch (e) { if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(e.code)) throw e; await fs.copyFile(source, join(stage, asset), constants.COPYFILE_EXCL); }
            sources.set(source, asset);
          }
          clip.id = `plan-${index + 1}-${clip.id}`; clip.src = asset;
          clip.at = Math.round(((clip.at ?? 0) + offset) * 1e6) / 1e6;
          if (kindOf(clip) !== 'sound' && (canvas.w !== film.stage.w || canvas.h !== film.stage.h)) {
            const scale = Math.min(canvas.w / film.stage.w, canvas.h / film.stage.h);
            const box = clip.box ?? { x: 0, y: 0, w: film.stage.w, h: film.stage.h };
            clip.box = { ...box, x: box.x * scale + (canvas.w - film.stage.w * scale) / 2, y: box.y * scale + (canvas.h - film.stage.h * scale) / 2,
              w: (box.w ?? film.stage.w) * scale, h: (box.h ?? film.stage.h) * scale };
          }
          lane.clips.push(clip);
        }
      }
      if (!(duration > 0)) throw Error('所选方案为空，未导出不完整的合并工程');
      const captions = await subtitlesForExport(root);
      cues.push(...filmSubtitleShown(captions.cues, captions.style).map(cue => ({ ...cue, startMs: cue.startMs + offset * 1000,
        ...(cue.words ? { words: cue.words.map(word => ({ ...word, startMs: word.startMs + offset * 1000 })) } : {}) })));
      offset += duration;
    }
    await fs.writeFile(join(stage, 'film.html'), filmHtml({ stage: canvas, tracks: tracks.sort((a, b) => a.trackIndex - b.trackIndex).map(({ key, trackIndex, ...track }) => track) }));
    const saved = JSON.stringify({ revision: snapshot.revision, cues });
    await fs.writeFile(join(stage, 'combined.json'), saved);
    // An interrupted attempt may already have assembled the same edit. Do not overwrite it.
    try { await fs.rename(stage, exportRoot); }
    catch (e) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(e.code)) throw e;
      if (await fs.readFile(join(exportRoot, 'combined.json'), 'utf8') !== saved
        || await fs.readFile(join(exportRoot, 'film.html'), 'utf8') !== await fs.readFile(join(stage, 'film.html'), 'utf8')) throw Error('已保存的合并工程发生变化，请重新建立导出批次');
      for (const [source, asset] of sources) if (await hashFile(join(exportRoot, asset)) !== await hashFile(source)) throw Error('已保存的合并素材发生变化，请重新建立导出批次');
    }
    return { ...snapshot, exportRoot, cues };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
