import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../../../server/ops.mjs';
import { sourceFilm, reconcileSourceFilm, resolveCandidateTake } from './source-timeline-model.ts';
import { splitHalves } from './timeline-split.ts';
import type { Film } from '../api.ts';

test('overlapping source candidates remain independent and deletion leaves a gap on the source clock', () => {
  const range = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs, sourceId: 's', productId: 'p', kind: 'candidate' as const });
  const film = sourceFilm('s', 'source.mp4', 10000, [range('a', 2000, 6000), range('b', 4000, 8000)]);
  assert.deepEqual(film.tracks[0].clips.map(c => c.time), [[0, 2], [2, 6], [4, 8], [8, 10]]);
  const target = film.tracks[0].clips[1];
  const halves = splitHalves({ startMs: 2000, endMs: 6000, anchor: { trimFrom: 2, parentStartMs: 0 } }, 3000, 6)!;
  const split = applyOps(structuredClone(film), [{ op: 'split', clip: target.id, left: halves.left, right: halves.right }]) as Film;
  assert.deepEqual(split.tracks[0].clips.filter(c => c.attrs?.['data-source-range'] === 'a').map(c => c.time), [[2, 3], [3, 6]]);
  const removed = applyOps(structuredClone(film), [{ op: 'remove', clip: target.id }]) as Film;
  assert.deepEqual(removed.tracks[0].clips.map(c => c.time), [[0, 2], [4, 8], [8, 10]]);
  assert.ok(removed.tracks[0].clips.every(c => c.at === c.time?.[0]));
});

test('migrating a shorter take keeps gaps without changing its evidence identity', () => {
  const range = { id: 'a', startMs: 2000, endMs: 6000, sourceId: 's', productId: 'p', kind: 'candidate' as const };
  const film = sourceFilm('s', 'source.mp4', 10000, [range], { 's:candidate:a:2000:6000': { startMs: 3000, endMs: 5000 } });
  const clips = film.tracks[0].clips;
  assert.deepEqual(clips.find(c => c.attrs?.['data-source-range'] === 'a')?.time, [3, 5]);
  assert.deepEqual(clips.map(c => c.time), [[0, 2], [3, 5], [6, 10]]);
});

test('reconciling preserves candidate deletion and its gap; empty tracks are safe', () => {
  const range = { id: 'a', startMs: 2000, endMs: 6000, sourceId: 's', productId: 'p', kind: 'candidate' as const };
  const fresh = sourceFilm('s', 'source.mp4', 10000, [range]);
  const saved = structuredClone(fresh);
  saved.tracks[0].clips = saved.tracks[0].clips.filter(c => c.attrs?.['data-source-range'] !== 'a');
  const reconciled = reconcileSourceFilm(fresh, saved, fresh);
  assert.equal(reconciled.tracks[0].clips.some(c => c.attrs?.['data-source-range'] === 'a'), false);
  assert.deepEqual(reconciled.tracks[0].clips.map(c => c.time), [[0, 2], [6, 10]]);
  const empty: Film = { tracks: [] };
  assert.deepEqual(reconcileSourceFilm(empty, { tracks: [] }, empty).tracks[0].clips, []);
});

test('refreshing another candidate keeps the unchanged shortened take and its gaps', () => {
  const range = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs, sourceId: 's', productId: 'p', kind: 'candidate' as const });
  const previous = sourceFilm('s', 'source.mp4', 10000, [range('a', 2000, 6000)]);
  const saved = structuredClone(previous);
  saved.tracks[0].clips[1].time = [3, 5]; saved.tracks[0].clips[1].at = 3;
  const fresh = sourceFilm('s', 'source.mp4', 10000, [range('a', 2000, 6000), range('b', 7000, 9000)]);
  const reconciled = reconcileSourceFilm(fresh, saved, previous);
  assert.deepEqual(reconciled.tracks[0].clips.map(c => c.time), [[0, 2], [3, 5], [6, 7], [7, 9], [9, 10]]);
});

const candidate = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs, sourceId: 's', productId: 'p', kind: 'candidate' as const });
const fixture = (...ranges: ReturnType<typeof candidate>[]) => sourceFilm('s', 'source.mp4', 10000, ranges);
const copyThroughDisk = (film: Film): Film => JSON.parse(JSON.stringify(film));

test('same-ID reanalysis preserves a split and trim through multiple reopen/reanalysis cycles', () => {
  const previous = fixture(candidate('a', 2000, 6000));
  const target = previous.tracks[0].clips.find(clip => clip.attrs?.['data-source-range'] === 'a')!;
  const halves = splitHalves({ startMs: 2000, endMs: 6000, anchor: { trimFrom: 2, parentStartMs: 0 } }, 4000, 6)!;
  const edited = applyOps(structuredClone(previous), [{ op: 'split', clip: target.id, left: halves.left, right: halves.right }]) as Film;
  edited.tracks[0].clips.find(clip => clip.id === target.id)!.time = [2.5, 3.5];
  edited.tracks[0].clips.find(clip => clip.id === target.id)!.at = 2.5;
  const next = fixture(candidate('a', 1000, 7000));
  const result = reconcileSourceFilm(next, copyThroughDisk(edited), previous);
  const rerun = reconcileSourceFilm(fixture(candidate('a', 500, 8000)), copyThroughDisk(result), next);
  assert.deepEqual(rerun.tracks[0].clips.filter(clip => clip.attrs?.['data-source-range'] === 'a').map(clip => clip.time), [[2.5, 3.5], [4, 6]]);
  assert.deepEqual(resolveCandidateTake(rerun, 'a', `${target.id}-b`), { clipId: `${target.id}-b`, startMs: 4000, endMs: 6000 });
  assert.equal(resolveCandidateTake(rerun, 'a')?.startMs, 2500);
  assert.deepEqual(previous.tracks[0].clips.find(clip => clip.id === target.id)?.time, [2, 6], 'reconciliation never mutates a saved or generated input');
});

test('candidate deletion remains deleted after changed bounds, removal, reopen and later return', () => {
  const previous = fixture(candidate('a', 2000, 6000));
  const saved = structuredClone(previous);
  saved.tracks[0].clips = saved.tracks[0].clips.filter(clip => clip.attrs?.['data-source-range'] !== 'a');
  const changed = fixture(candidate('a', 1000, 7000));
  const first = reconcileSourceFilm(changed, saved, previous);
  assert.equal(resolveCandidateTake(first, 'a'), null, 'deleted take must not fall back to original AI range');
  const absent = fixture(candidate('b', 7000, 9000));
  const second = reconcileSourceFilm(absent, copyThroughDisk(first), changed);
  const returned = reconcileSourceFilm(fixture(candidate('a', 2000, 6000), candidate('b', 7000, 9000)), copyThroughDisk(second), absent);
  assert.equal(resolveCandidateTake(returned, 'a'), null);
  assert.equal(returned.tracks[0].clips.some(clip => clip.time![0] < 6 && clip.time![1]! > 2), false, 'no gray refill of a deleted candidate');
});

test('edited gray footage and deleted gray footage survive new candidates without refilling gaps', () => {
  const previous = fixture(candidate('a', 2000, 6000));
  const saved = structuredClone(previous);
  saved.tracks[0].clips = saved.tracks[0].clips.filter(clip => clip.time![0] !== 6);
  saved.tracks[0].clips[0].time = [0.5, 1.5]; saved.tracks[0].clips[0].at = 0.5;
  const next = fixture(candidate('a', 2000, 6000), candidate('b', 7000, 9000));
  const reconciled = reconcileSourceFilm(next, copyThroughDisk(saved), previous);
  assert.deepEqual(reconciled.tracks[0].clips.filter(clip => !clip.attrs?.['data-source-range']).map(clip => clip.time), [[0.5, 1.5]]);
  const again = reconcileSourceFilm(fixture(candidate('a', 2000, 6000)), copyThroughDisk(reconciled), next);
  assert.deepEqual(again.tracks[0].clips.filter(clip => !clip.attrs?.['data-source-range']).map(clip => clip.time), [[0.5, 1.5]]);
});

test('an initial untouched full-source block is carved for candidates but never fills later holes', () => {
  const previous = fixture();
  const next = fixture(candidate('a', 2000, 6000));
  const first = reconcileSourceFilm(next, previous, previous);
  assert.deepEqual(first.tracks[0].clips.map(clip => clip.time), [[0, 2], [2, 6], [6, 10]]);
  const last = reconcileSourceFilm(fixture(candidate('a', 2000, 6000), candidate('b', 7000, 9000)), copyThroughDisk(first), next);
  assert.deepEqual(last.tracks[0].clips.map(clip => clip.time), [[0, 2], [2, 6], [6, 7], [7, 9], [9, 10]]);
  assert.equal(new Set(last.tracks[0].clips.map(clip => clip.id)).size, last.tracks[0].clips.length);
});

test('removed AI identities retain edited takes as personal footage without stale candidate labels', () => {
  const previous = fixture(candidate('a', 2000, 6000));
  const saved = structuredClone(previous);
  const taken = saved.tracks[0].clips.find(clip => clip.attrs?.['data-source-range'] === 'a')!;
  taken.time = [3, 5]; taken.at = 3;
  const changed = fixture(candidate('new-id', 2500, 6500));
  const first = reconcileSourceFilm(changed, saved, previous);
  const retained = first.tracks[0].clips.find(clip => clip.attrs?.['data-source-kind'] === 'take')!;
  assert.deepEqual(retained.time, [3, 5]);
  assert.equal(retained.attrs?.['data-source-range'], '');
  assert.equal(retained.attrs?.['data-source-origin-range'], 'a');
  assert.equal(resolveCandidateTake(first, 'a'), null);
  const reopened = reconcileSourceFilm(fixture(candidate('another-id', 1500, 4500)), copyThroughDisk(first), changed);
  assert.deepEqual(reopened.tracks[0].clips.find(clip => clip.attrs?.['data-source-kind'] === 'take')?.time, [3, 5]);
});

test('legacy takes without origin metadata preserve candidate and gray edits when migrated', () => {
  const previous = fixture(candidate('a', 2000, 6000));
  const saved = structuredClone(previous);
  for (const clip of saved.tracks[0].clips) {
    delete clip.attrs!['data-source-base-start']; delete clip.attrs!['data-source-base-end'];
  }
  saved.tracks[0].clips[0].time = [0, 1];
  saved.tracks[0].clips[1].time = [3, 5]; saved.tracks[0].clips[1].at = 3;
  const result = reconcileSourceFilm(fixture(candidate('a', 1000, 8000)), saved, previous);
  assert.equal(resolveCandidateTake(result, 'a')?.startMs, 3000);
  assert.deepEqual(result.tracks[0].clips.filter(clip => !clip.attrs?.['data-source-range']).map(clip => clip.time), [[0, 1], [8, 10]]);
});

test('invalid and fractional source boundaries remain finite and within the source', () => {
  const range = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs, sourceId: 's', productId: 'p', kind: 'candidate' as const });
  const film = sourceFilm('s', 'source.mp4', 1000.9, [range('good', -0.1, 800.8), range('bad', NaN, 500)], { 's:candidate:good:0:800.8': { startMs: Infinity, endMs: 200 } });
  assert.equal(film.tracks[0].clips.some(c => c.attrs?.['data-source-range'] === 'bad'), false);
  for (const clip of film.tracks[0].clips) {
    assert.ok(clip.time && clip.time.length === 2 && clip.time[0] >= 0 && clip.time[1] <= 1 && clip.time[1] > clip.time[0]);
    assert.equal(clip.at, clip.time[0]);
  }
});
