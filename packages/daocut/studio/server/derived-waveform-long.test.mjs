// Four hours of generated audio; this never reads user media or calls external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync, execFile } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { waveform } from './derived.mjs';

const exec = promisify(execFile);
const base = resolve('../../.tmp/long-live-implementation-20261103/wave');
const duration = 4 * 60 * 60;

if (process.argv[2] === '--measure') {
  const root = process.argv[3];
  const startMemory = process.memoryUsage();
  let peakRss = startMemory.rss, peakExternal = startMemory.external, peakHeap = startMemory.heapUsed;
  let decoderCalls = 0, decodedBytes = 0, maxChunkBytes = 0;
  const memory = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakExternal = Math.max(peakExternal, m.external); peakHeap = Math.max(peakHeap, m.heapUsed); };
  const spawn = childProcess.spawn;
  childProcess.spawn = function(name, args, options) {
    const child = spawn(name, args, options);
    if (name === 'ffmpeg' && args.includes('s16le')) {
      decoderCalls++;
      child.stdout.on('data', chunk => { decodedBytes += chunk.length; maxChunkBytes = Math.max(maxChunkBytes, chunk.length); memory(); });
    }
    return child;
  };
  syncBuiltinESMExports();
  const timer = setInterval(memory, 10);
  const started = performance.now();
  const [cold, concurrent] = await Promise.all([waveform(root, 'assets/four-hours.flac'), waveform(root, 'assets/four-hours.flac')]);
  const coldMs = performance.now() - started;
  memory();
  assert.equal(decoderCalls, 1, 'concurrent callers share the same real ffmpeg process');
  assert.equal(decodedBytes, duration * 8000 * 2);
  assert.equal(cold.duration, duration);
  assert.equal(cold.peaks.length, duration * 40);
  assert.deepEqual(concurrent, cold);
  for (let hour = 0; hour < 4; hour++) {
    const start = hour * 3600 * 40;
    assert.equal(cold.peaks[start], 0.5);
    assert.equal(cold.peaks[start + 39], 0.5);
    assert.equal(cold.peaks[start + 40], 0);
    assert.equal(cold.peaks[start + 1000], 0);
  }
  const hotStarted = performance.now();
  assert.deepEqual(await waveform(root, 'assets/four-hours.flac'), cold);
  const hotMs = performance.now() - hotStarted;
  assert.equal(decoderCalls, 1, 'disk-cache reopen does not decode again');
  memory(); clearInterval(timer);
  peakRss = Math.max(peakRss, process.resourceUsage().maxRSS * 1024);
  const report = { synthetic: true, durationSeconds: duration, pcmBytesProcessed: decodedBytes, peakCount: cold.peaks.length,
    decoderCalls, maxObservedChunkBytes: maxChunkBytes, retainedPcmBytesBetweenChunks: 1,
    coldConcurrentMs: coldMs, cachedReopenMs: hotMs, baselineRssBytes: startMemory.rss, peakNodeRssBytes: peakRss,
    peakNodeHeapBytes: peakHeap, peakNodeExternalBytes: peakExternal, externalGrowthBytes: peakExternal - startMemory.external,
    realModelRequests: 0, note: 'Node memory only; ffmpeg child memory was not measured. Peak data and JSON are retained, decoded PCM is streamed.' };
  await writeFile(join(root, 'measurement.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.ok(maxChunkBytes <= 1024 * 1024, `stdout chunk remained bounded: ${maxChunkBytes}`);
  assert.ok(peakExternal - startMemory.external < decodedBytes, 'external buffers never contain the complete decoded stream');
  process.exit(0);
}

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } })();
test('four-hour synthetic waveform streams beyond the former 64 MiB limit and reopens from cache', { timeout: 180000, skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'four-hour-'));
  await mkdir(join(root, 'assets'));
  const input = join(root, 'assets/four-hours.flac');
  // A one-second 0.5-amplitude tone at each hour, silence elsewhere: observable timestamps through the whole file.
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(mod(t\\,3600)\\,1)\\,0.5*sin(2*PI*1000*t)\\,0):s=8000:d=14400', '-c:a', 'flac', '-y', input], { windowsHide: true });
  const { stdout } = await exec(process.execPath, [fileURLToPath(import.meta.url), '--measure', root], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout.trim());
  const files = await readdir(join(root, '.film/cache/waves'));
  assert.equal(files.length, 1);
  const cacheFile = join(root, '.film/cache/waves', files[0]);
  const cacheSize = (await stat(cacheFile)).size;
  const summary = { ...report, projectRoot: root, sourceBytes: (await stat(input)).size, cacheBytes: cacheSize,
    passed: true, checkedAt: new Date().toISOString() };
  assert.ok(cacheSize < 16 * 1024 * 1024, 'the peak cache is compact');
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).peaks.length, duration * 40);
  await writeFile(join(base, 'four-hour-result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
});
