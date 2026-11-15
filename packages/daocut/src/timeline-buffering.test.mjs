import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('slow seeks finish before another correction and play promises are not flooded', async () => {
  const source = await readFile(new URL('./timeline.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function roll(c,'), source.indexOf('/**', source.indexOf('function roll(c,')));
  for (const latency of [600, 1000]) {
    let now = 0, requests = 0, completions = 0, due = Infinity, time = 0, playCalls = 0;
    const video = { readyState: 4, seeking: false, ended: false, paused: true, playbackRate: 1.3,
      get currentTime() { return time; }, set currentTime(value) { time = value; due = now + latency; this.seeking = true; requests++; },
      play() { playCalls++; this.paused = false; return Promise.resolve(); } };
    const context = vm.createContext({ performance: { now: () => now }, ROLL_SEEK: .5, ROLL_STEER: .04, ROLL_SETTLE: .01, ROLL_NUDGE: .03 });
    vm.runInContext(body + '\nthis.roll = roll;', context);
    const clip = { el: video, span: { speed: 1.3 } };
    for (now = 0; now <= 5000; now += 20) {
      if (now >= due) { due = Infinity; video.seeking = false; completions++; }
      if (!video.seeking && !video.paused) time += .02 * video.playbackRate;
      context.roll(clip, 100 + now / 1000 * 1.3, 1);
      await Promise.resolve();
    }
    assert.ok(completions > 0, 'decoding must finish even when seek latency exceeds the correction threshold');
    assert.ok(requests <= 4, 'buffering must not restart decoding on every frame');
    assert.equal(playCalls, 1);
  }
});
