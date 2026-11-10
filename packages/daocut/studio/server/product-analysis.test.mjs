import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProductAnalysis, updateProductAnalysis, writeProductAnalysis, PRODUCT_ANALYSIS_FILE } from './product-analysis.mjs';

test('validates probed durations and references, preserves offline data and durable undo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-analysis-'));
  const probe = async () => ({ duration: 10 });
  const data = { version: 1, sources: [{ id: 's', assetPath: 'a.mp4', durationMs: 10000 }], products: [{ id: 'p', name: '商品', sourceIds: ['s'] }], intervals: [{ id: 'i', productId: 'p', sourceId: 's', startMs: 0, endMs: 5000 }], candidates: [{ id: 'c', productId: 'p', intervalId: 'i', sourceId: 's', startMs: 1000, endMs: 2000, text: '介绍', tags: [], origin: 'manual', version: 1 }] };
  try {
    assert.equal((await readProductAnalysis(root)).history, null);
    await assert.rejects(writeProductAnalysis(root, { ...data, sources: [{ ...data.sources[0], durationMs: 12000 }], intervals: [{ ...data.intervals[0], endMs: 11000 }] }, probe), /probed duration/);
    await assert.rejects(writeProductAnalysis(root, { ...data, candidates: [{ ...data.candidates[0], productId: 'other' }] }, probe), /candidate/);
    await writeProductAnalysis(root, data, probe);
    const without = { ...data, intervals: [], candidates: [] };
    await writeProductAnalysis(root, without, async () => { throw Error('offline'); });
    assert.deepEqual((await readProductAnalysis(root)).history, data);
    await writeProductAnalysis(root, data, async () => { throw Error('offline'); });
    assert.deepEqual((await readProductAnalysis(root)).analysis, data);
    await assert.rejects(writeProductAnalysis(root, { ...data, intervals: [{ ...data.intervals[0], endMs: 6000 }] }, async () => { throw Error('offline'); }), /cannot probe/);
    await mkdir(join(root, '.film'), { recursive: true });
    const file = join(root, PRODUCT_ANALYSIS_FILE);
    await writeFile(file, '{ broken');
    await assert.rejects(writeProductAnalysis(root, data, probe), /not overwritten/);
    assert.equal(await readFile(file, 'utf8'), '{ broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale client save conflicts with queued AI and manual edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-analysis-concurrent-'));
  const probe = async () => ({ duration: 10 });
  const initial = { version: 1, sources: [{ id: 's', assetPath: 'a.mp4', durationMs: 10000 }], products: [{ id: 'p', name: '初始', sourceIds: ['s'] }], intervals: [{ id: 'i', productId: 'p', sourceId: 's', startMs: 0, endMs: 5000 }], candidates: [] };
  try {
    await writeProductAnalysis(root, initial, probe);
    const previous = structuredClone((await readProductAnalysis(root)).analysis);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const ai = updateProductAnalysis(root, async data => {
      entered(); await gate;
      data.products[0].name = '人工修正';
      data.candidates.push({ id: 'ai', productId: 'p', intervalId: 'i', sourceId: 's', startMs: 100, endMs: 1000, text: '报价', tags: ['价格锚点'], origin: 'ai-text', version: 1 });
      return data;
    }, probe);
    await ready;
    const staleEdit = structuredClone(previous);
    staleEdit.products[0].name = '旧窗口修改';
    const staleSave = writeProductAnalysis(root, staleEdit, probe, previous);
    release();
    await ai;
    await assert.rejects(staleSave, { status: 409 });
    const latest = (await readProductAnalysis(root)).analysis;
    assert.equal(latest.products[0].name, '人工修正');
    assert.equal(latest.candidates[0].id, 'ai');
    const next = structuredClone(latest);
    next.products[0].name = '用户重新应用';
    await writeProductAnalysis(root, next, probe, latest);
    assert.equal((await readProductAnalysis(root)).analysis.products[0].name, '用户重新应用');
  } finally { await rm(root, { recursive: true, force: true }); }
});
