import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { chromium } from 'playwright-core';

test('variable-height speech cards settle after overflowing, filtering and resizing', { timeout: 30000 }, async t => {
  const base = resolve(import.meta.dirname, '../../../../.tmp/virtual-list-stability');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-'));
  const require = createRequire(new URL('../../package.json', import.meta.url));
  const { build } = createRequire(require.resolve('vite'))('esbuild');
  const source = await readFile(new URL('../ui/src/components/VirtualList.tsx', import.meta.url), 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  t.after(async () => { await browser.close(); assert.ok(dir.startsWith(base + sep)); await rm(dir, { recursive: true, force: true }); });
  const page = await browser.newPage();
  for (const fixed of [false, true]) {
    const component = fixed ? source : source.replace(", scrollbarGutter: 'stable'", '');
    const output = await build({ stdin: { contents: component + `
      import { createRoot } from 'react-dom/client';
      const words = '话'.repeat(442);
      function App() {
        const [long, setLong] = React.useState(false);
        window.changeCards = setLong;
        return <VirtualList items={long ? [1,2] : [1]} itemKey={n=>String(n)} estimateHeight={()=>160} maxHeight={360} label="话术" gap={6}
          renderItem={n=><article style={{padding:16,minHeight:long?90:30,boxSizing:'border-box'}}>{long && n === 1 ? words : '短话术'} {n}</article>} />;
      }
      createRoot(document.getElementById('root')).render(<App />);
    `, loader: 'tsx', resolveDir: resolve(import.meta.dirname, '../../') }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
    await page.setContent('<style>*{box-sizing:border-box}body{font:14px/20px sans-serif}.w-full{width:100%}.overflow-y-auto{overflow-y:auto}.relative{position:relative}.absolute{position:absolute}.left-0{left:0}.top-0{top:0}</style><div id="root" style="width:520px"></div>');
    await page.addScriptTag({ content: output.outputFiles[0].text });
    const sample = async () => page.evaluate(async () => {
      const seen = [];
      for (let i = 0; i < 50; i++) {
        await new Promise(requestAnimationFrame);
        const list = document.querySelector('[data-virtual-list]');
        seen.push([list.clientWidth,list.clientHeight,...[...list.querySelectorAll('[data-virtual-row]')].map(row=>row.getBoundingClientRect().top)].join(','));
      }
      return seen.slice(15);
    });
    await sample();
    await page.evaluate(() => window.changeCards(true));
    const seen = await sample();
    t.diagnostic(JSON.stringify({ fixed, positions: [...new Set(seen)] }));
    if (!fixed) { assert.ok(new Set(seen).size > 1, 'control reproduces the scrollbar measurement loop'); continue; }
    assert.equal(new Set(seen).size, 1, 'long text stays still');
    await page.evaluate(() => window.changeCards(false));
    assert.equal(new Set(await sample()).size, 1, 'filtered short cards stay still');
    await page.evaluate(() => { window.changeCards(true); document.getElementById('root').style.width = '310px'; });
    assert.equal(new Set(await sample()).size, 1, 'wrapped text settles after a panel resize');
  }
});
