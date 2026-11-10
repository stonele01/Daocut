import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const repo = resolve(import.meta.dirname, '../../../..');

test('saved-history panel waits for duration, refreshes on identity changes and ignores the previous source response', { timeout: 90000 }, async () => {
  const base = join(repo, '.tmp/folder-flow-20261106/history-refresh');
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'fixture-'));
  const api = join(scratch, 'api.ts'), analysis = join(scratch, 'analysis.ts');
  await writeFile(api, `
    const calls = [];
    let pending = null;
    export const api = {
      existingAnalysisResults: async () => ({results:[]}),
      prefs: async () => ({sharedMediaLibraries:[], sharedAnalysis:{enabled:true,resultRoots:[]}}),
      sharedAnalysisHistory: async (projectId,sourceId) => {
        calls.push({projectId,sourceId});
        if (window.fixture.hold) { window.fixture.hold=false; return new Promise(resolve => {pending=resolve;}); }
        return {results:[{action:'analysis', taskKey:sourceId, resultSha:sourceId, count:sourceId==='b'?7:40}]};
      },
    };
    window.fixture={calls,hold:false,release:()=>pending?.({results:[{action:'analysis',taskKey:'late',resultSha:'late',count:99}]})};
  `);
  await writeFile(analysis, `
    export const readProductAnalysis=async()=>({analysis:{sources:[],products:[]}});
    export const sourceTime=ms=>String(ms);
  `);
  await writeFile(join(scratch, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(scratch, 'entry.tsx'), `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ExistingAnalysisSharing} from ${JSON.stringify(join(repo, 'packages/daocut/studio/ui/src/components/ExistingAnalysisSharing.tsx').replaceAll('\\', '/'))};
    function Fixture(){
      const [source,setSource]=useState({projectId:'one',sourceId:'a',sourcePath:'assets/a.mp4',durationMs:null});
      window.fixture.update=setSource;
      return <ExistingAnalysisSharing {...source} onChanged={async()=>{}} onLocate={()=>{}}/>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `);
  await build({ configFile: false, root: scratch, cacheDir: join(scratch, 'vite-cache'), logLevel: 'silent',
    plugins: [react(), { name: 'fixture-dependencies', resolveId(source) { if (/^(react|react-dom)(\/|$)/.test(source)) return require.resolve(source); } }],
    resolve: { alias: [ { find: '@/api', replacement: api }, { find: '@/lib/product-analysis', replacement: analysis } ] },
    build: { outDir: join(scratch, 'dist'), emptyOutDir: true },
  });
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const file = path.startsWith('/assets/') ? join(scratch, 'dist', path) : join(scratch, 'dist/index.html');
      response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let browser;
  const pageErrors = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: '发布已有分析结果', exact: true }).click();
    await page.getByText('视频信息尚未准备好，完成后会自动读取已有共享结果。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看同事已有结果', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.fixture.calls.length), 0);

    await page.evaluate(() => window.fixture.update({projectId:'one',sourceId:'a',sourcePath:'assets/a.mp4',durationMs:1000}));
    await page.getByText('话术原始结果 · 整场 · 40 条', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.calls.length), 1);

    await page.evaluate(() => {window.fixture.hold=true;window.fixture.update({projectId:'one',sourceId:'a',sourcePath:'assets/a.mp4',durationMs:2000});});
    await page.waitForFunction(() => window.fixture.calls.length === 2);
    await page.evaluate(() => window.fixture.update({projectId:'two',sourceId:'b',sourcePath:'assets/b.mp4',durationMs:3000}));
    await page.getByText('话术原始结果 · 整场 · 7 条', { exact: true }).waitFor();
    await page.evaluate(() => window.fixture.release());
    await page.waitForTimeout(100);
    assert.equal(await page.getByText('话术原始结果 · 整场 · 7 条', { exact: true }).count(), 1);
    assert.equal(await page.getByText('话术原始结果 · 整场 · 99 条', { exact: true }).count(), 0);
    assert.equal(await page.getByText('话术原始结果 · 整场 · 40 条', { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
