// @ts-check
/**
 * A deliberately synthetic project for trying the product/structure editor.
 * It stays entirely in a normal local project folder: no NAS source, AI call,
 * transcript, or real product data is involved.
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createProject } from './projects.mjs';
import { writeProductAnalysis } from './product-analysis.mjs';

const exec = promisify(execFile);
const DURATION_SECONDS = 12;

const videos = [
  ['demo-source-a.mp4', '3b82f6'],
  ['demo-source-b.mp4', '0f766e'],
  ['demo-source-c.mp4', 'a16207'],
];

/** Fresh data each time: `writeProductAnalysis` fills source durations in its saved copy. */
export function demoProductAnalysis() {
  const sourceA = 'demo-source-a';
  const sourceB = 'demo-source-b';
  const sourceC = 'demo-source-c';
  const cleanser = 'demo-cleanser';
  const serum = 'demo-serum';
  const cream = 'demo-cream';
  const unanalysed = 'demo-unanalysed';
  return {
    version: 1,
    sources: [
      { id: sourceA, assetPath: 'assets/demo-source-a.mp4', durationMs: null },
      { id: sourceB, assetPath: 'assets/demo-source-b.mp4', durationMs: null },
      { id: sourceC, assetPath: 'assets/demo-source-c.mp4', durationMs: null },
    ],
    products: [
      { id: cleanser, name: '演示洁面（演示数据）', sourceIds: [sourceA, sourceB] },
      { id: serum, name: '演示精华（演示数据）', sourceIds: [sourceA, sourceC] },
      { id: cream, name: '演示面霜（演示数据）', sourceIds: [sourceB, sourceC] },
      { id: unanalysed, name: '演示商品（尚未分析）', sourceIds: [sourceA] },
    ],
    intervals: [
      { id: 'demo-cleanser-a-1', productId: cleanser, sourceId: sourceA, startMs: 0, endMs: 3500 },
      { id: 'demo-cleanser-a-2', productId: cleanser, sourceId: sourceA, startMs: 7500, endMs: 10500 },
      { id: 'demo-cleanser-b-1', productId: cleanser, sourceId: sourceB, startMs: 1800, endMs: 4800 },
      { id: 'demo-serum-a-1', productId: serum, sourceId: sourceA, startMs: 3700, endMs: 7000 },
      { id: 'demo-serum-c-1', productId: serum, sourceId: sourceC, startMs: 1000, endMs: 3000 },
      { id: 'demo-serum-c-2', productId: serum, sourceId: sourceC, startMs: 7600, endMs: 10500 },
      { id: 'demo-cream-b-1', productId: cream, sourceId: sourceB, startMs: 5000, endMs: 7600 },
      { id: 'demo-cream-c-1', productId: cream, sourceId: sourceC, startMs: 3100, endMs: 6800 },
      { id: 'demo-cream-c-2', productId: cream, sourceId: sourceC, startMs: 9000, endMs: 11000 },
      { id: 'demo-unanalysed-a-1', productId: unanalysed, sourceId: sourceA, startMs: 10500, endMs: 12000 },
    ],
    candidates: [
      { id: 'demo-candidate-1', productId: cleanser, intervalId: 'demo-cleanser-a-1', sourceId: sourceA, startMs: 400, endMs: 1700, text: '【演示数据】虚构钩子与痛点片段', tags: ['钩子', '痛点'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-2', productId: cleanser, intervalId: 'demo-cleanser-a-1', sourceId: sourceA, startMs: 2200, endMs: 3400, text: '【演示数据】虚构卖点与产品演示片段', tags: ['卖点', '产品演示'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-3', productId: cleanser, intervalId: 'demo-cleanser-a-2', sourceId: sourceA, startMs: 7900, endMs: 9800, text: '【演示数据】虚构价格锚点与行动指令', tags: ['价格锚点', '行动指令'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-4', productId: cleanser, intervalId: 'demo-cleanser-b-1', sourceId: sourceB, startMs: 2100, endMs: 4200, text: '【演示数据】重复钩子与卖点片段', tags: ['钩子', '卖点'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-5', productId: serum, intervalId: 'demo-serum-a-1', sourceId: sourceA, startMs: 4200, endMs: 5900, text: '【演示数据】虚构精华钩子片段', tags: ['钩子'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-6', productId: serum, intervalId: 'demo-serum-c-1', sourceId: sourceC, startMs: 1400, endMs: 2600, text: '【演示数据】虚构产品演示片段', tags: ['产品演示', '卖点'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-7', productId: serum, intervalId: 'demo-serum-c-2', sourceId: sourceC, startMs: 8000, endMs: 9900, text: '【演示数据】虚构价格与行动片段', tags: ['价格锚点', '行动指令'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-8', productId: cream, intervalId: 'demo-cream-b-1', sourceId: sourceB, startMs: 5200, endMs: 7000, text: '【演示数据】虚构面霜痛点与卖点片段', tags: ['痛点', '卖点'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-9', productId: cream, intervalId: 'demo-cream-c-1', sourceId: sourceC, startMs: 3400, endMs: 6200, text: '【演示数据】虚构面霜产品演示片段', tags: ['产品演示', '卖点'], origin: 'demo-data', version: 'demo-v1' },
      { id: 'demo-candidate-10', productId: cream, intervalId: 'demo-cream-c-2', sourceId: sourceC, startMs: 9200, endMs: 10500, text: '【演示数据】虚构面霜价格与行动片段', tags: ['价格锚点', '行动指令'], origin: 'demo-data', version: 'demo-v1' },
    ],
  };
}

/** @param {string} path @param {string} color */
async function makeVideo(path, color) {
  await exec('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=10:d=${DURATION_SECONDS}`,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path,
  ], { windowsHide: true });
}

/** Create one ordinary local project whose sources are only generated colour clips. */
export async function createProductAnalysisDemo() {
  try { await exec('ffmpeg', ['-version'], { windowsHide: true }); }
  catch { throw new Error('演示数据需要本机 FFmpeg；未创建演示工程。'); }
  const project = await createProject('演示数据 商品结构与素材筛选');
  const assets = join(project.path, 'assets');
  await mkdir(assets, { recursive: true });
  for (const [name, color] of videos) await makeVideo(join(assets, name), color);
  await writeProductAnalysis(project.path, demoProductAnalysis());
  return { project };
}
