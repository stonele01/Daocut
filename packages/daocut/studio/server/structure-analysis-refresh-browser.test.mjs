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

const require = createRequire(import.meta.url), repo = resolve(import.meta.dirname, '../../../..');
test('saved analysis clears the old structure error by reading state without generating plans', { timeout: 60000 }, async () => {
  const base = join(repo, '.tmp/structure-analysis-refresh'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'case-')), apiFile = join(scratch, 'api.ts'), view = join(scratch, 'view.tsx'), empty = join(scratch, 'empty.tsx');
  await writeFile(apiFile, `const f=window.fixture={ready:false,reads:0,writes:0};export const api={
    structureWorkspace:async()=>({ownerId:'p',activeProjectId:'p',drafts:[]}),film:async()=>({folder:'',project:{name:'fixture'}}),
    structurePlans:async()=>{f.reads++;return {status:f.ready?'idle':'unavailable',version:'ai-structure-plans-v6',plans:[],issues:f.ready?[]:[{message:'上次分析失败'}],confirmation:f.ready?{id:'c',enabled:true,openingCount:1,requestCount:1}:undefined}},
    generateStructurePlans:async()=>{f.writes++;throw Error('Must never generate automatically')}
  };`);
  await writeFile(view, `import React from 'react';export function ProjectView({structure}){React.useEffect(()=>{structure.onScope({sourceId:'s',productId:'p',intervalId:'i',startMs:0,endMs:1000})},[structure.onScope]);return <button onClick={()=>{window.fixture.ready=true;structure.onAnalysisUpdated()}}>完成话术分析</button>}`);
  await writeFile(empty, 'export const StructureExportBatches=()=>null;export const useHostPanel=()=>null;');
  await writeFile(join(scratch, 'index.html'), '<div id="root"></div><script type="module" src="/entry.tsx"></script>');
  await writeFile(join(scratch, 'entry.tsx'), `import React from 'react';import {createRoot}from'react-dom/client';import {StructureWorkspace}from ${JSON.stringify(join(repo, 'packages/daocut/studio/ui/src/components/StructureWorkspace.tsx').replaceAll('\\', '/'))};createRoot(document.getElementById('root')).render(<StructureWorkspace projectId="p" onProject={()=>{}} onLeave={()=>{}}/>);`);
  await build({ configFile:false,root:scratch,cacheDir:join(scratch,'cache'),logLevel:'silent',plugins:[react(),{name:'fixture-imports',resolveId(source,importer){
    if(/^(react|react-dom)(\/|$)/.test(source))return require.resolve(source);
    if(importer?.endsWith('/StructureWorkspace.tsx')&&source==='./ProjectView')return view;
    if(source==='./StructureExportBatches'||source==='@/lib/host')return empty;
  }}],resolve:{alias:[{find:/^\.\/ProjectView$/,replacement:view},{find:/^\.\/StructureExportBatches$/,replacement:empty},{find:'@/lib/host',replacement:empty},{find:'@/api',replacement:apiFile},{find:'@',replacement:join(repo,'packages/daocut/studio/ui/src')}]},build:{outDir:join(scratch,'dist'),emptyOutDir:true}});
  const server=createServer(async(req,res)=>{try{const p=new URL(req.url,'http://localhost').pathname;const file=p.startsWith('/assets/')?join(scratch,'dist',p):join(scratch,'dist/index.html');res.setHeader('content-type',file.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(file));}catch{res.writeHead(404).end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.DAOCUT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const page=await browser.newPage(),origin=`http://127.0.0.1:${server.address().port}`;page.setDefaultTimeout(8000);
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.goto(origin);await page.getByText('暂时不能拼结构：上次分析失败').waitFor();
    await page.getByRole('button',{name:'完成话术分析',exact:true}).click();
    await page.getByText('暂时不能拼结构：上次分析失败').waitFor({state:'detached'});
    await page.getByRole('button',{name:'拼结构',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>({reads:window.fixture.reads,writes:window.fixture.writes})),{reads:2,writes:0});
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
