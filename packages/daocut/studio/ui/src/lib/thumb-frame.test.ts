import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overridesToken, plannedSourceInPoints } from './thumb-frame.ts';
import { planRippleTrim } from './timeline-edit.ts';

test('a ripple head trim exposes the planned source in point for the live picture and waveform', () => {
  const model = [{ index: 0, role: 'video' as const, clips: [{ id: 'a', startMs: 0, endMs: 3000, inMs: 19500, speed: 1, sourceMs: 30000 }] }];
  const left = planRippleTrim(model, ['a'], 'start', -1000, { magnet: true, linkage: true });
  assert.equal(left.placed.get('a')?.startMs, 0);
  assert.equal(left.placed.get('a')?.endMs, 4000);
  assert.equal(plannedSourceInPoints(left.ops).get('a'), 18500);
  const right = planRippleTrim(model, ['a'], 'end', 1000, { magnet: true, linkage: true });
  assert.equal(plannedSourceInPoints(right.ops).has('a'), false);
});

test('a page clip\'s overrides give its thumbnails a token: none without a layer\'s, another for another change', () => {
  assert.equal(overridesToken(undefined), '');
  assert.equal(overridesToken([]), '');
  assert.equal(overridesToken([{ fade: [0.5, 0.5] }]), '', 'its fades alone change no picture');
  const moved = overridesToken([{ at: '#title', t: [10, 0] }]);
  assert.ok(moved);
  assert.equal(overridesToken([{ at: '#title', t: [10, 0] }]), moved, 'the same changes, the same token');
  assert.notEqual(overridesToken([{ at: '#title', t: [20, 0] }]), moved);
  assert.notEqual(overridesToken([{ at: '#title', t: [10, 0], style: { fontSize: '90px' } }]), moved);
});
