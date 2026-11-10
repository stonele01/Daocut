import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackSourceTracks } from './source-timeline-layout.ts';
import type { TimelineBlock, TimelineTrack } from './timeline-layout.ts';
const block = (id: string, startMs: number, endMs: number): TimelineBlock => ({ id, clipId: id, loc: `film.html#0.${id}`, title: id, kind: 'video', startMs, endMs, inMs: startMs, anchor: { move: 'at', resize: 'end', trimFrom: startMs / 1000, parentStartMs: 0 } });
const row = (blocks: TimelineBlock[], index = 0): TimelineTrack => ({ lane: `v${index}`, index, docIndex: 0, kind: 'visual', role: 'video', name: null, blocks });
test('one row retains original clips and reports exact changing overlap sets', () => {
  const a = block('a', 0, 3000), b = block('b', 1000, 5000), c = block('c', 2000, 4000), d = block('d', 5000, 6000);
  const result = stackSourceTracks([row([a, d]), row([b]), row([c])], 68);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].height, 68);
  assert.equal(result.tracks[0].blocks[1], b);
  assert.equal(b.inMs, 1000);
  assert.deepEqual(result.segments, [
    { startMs: 1000, endMs: 2000, blockIds: ['a', 'b'] },
    { startMs: 2000, endMs: 3000, blockIds: ['a', 'b', 'c'] },
    { startMs: 3000, endMs: 4000, blockIds: ['b', 'c'] },
  ]);
  assert.deepEqual([...result.overlaps].sort(), ['a', 'b', 'c']);
});
test('touching intervals do not overlap and empty input stays empty', () => {
  assert.deepEqual(stackSourceTracks([row([block('a', 0, 1000), block('b', 1000, 2000)])], 68).segments, []);
  assert.deepEqual(stackSourceTracks([], 68).tracks, []);
});
