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

test('daily preparation uses one explicit confirmation for transcription and discovery', { timeout: 90000 }, async t => {
  const base = join(repo, '.tmp/daily-flow-20261106/preparation'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'fixture-')), apiFile = join(scratch, 'api.ts'), empty = join(scratch, 'empty.tsx');
  await writeFile(empty, 'export const ExistingAnalysisSharing=()=>null; export const TranscriptSeamReview=()=>null; export const ProductSharedVersions=()=>null;');
  await writeFile(apiFile, `
    const states = new Map();
    const initial = id => ({ source:{id,assetPath:'assets/'+id+'.mp4',durationMs:1000}, ready:false,discoveryReady:false,busy:false,
      transcription:{status:'idle'},discovery:{status:'idle'} });
    const fixture = window.fixture = { calls:[], plans:[], state:id => {if(!states.has(id)) states.set(id,initial(id));return states.get(id);},
      fail:false,reuse:false,hold:false,pending:null,accepted:false,notifications:0 };
    export const api = {
      productWorkflowStatus: async (_,id) => structuredClone(fixture.state(id)),
      productWorkflowPlan: async (_,request) => {fixture.plans.push(request);return { ...request, source:fixture.state(request.sourceId).source,
        enabled:true,cached:fixture.reuse,requestCount:fixture.reuse?0:1,reusedRequests:fixture.reuse?1:0,
        service:{name:'模拟服务',model:'fake',endpoint:'local://fake'},cost:{basis:'模拟请求',uncertain:false},
        ...(fixture.reuse ? {shared:{mode:'reuse',result:{sha256:'a'.repeat(64)}}}:{}),
        retryRequired:fixture.state(request.sourceId).transcription.status==='failed', identity:'fixture-plan' }},
      executeProductWorkflow: async (_,plan,reviewed) => {
        fixture.calls.push({prepare:plan.prepare,action:plan.action,sourceId:plan.sourceId,reviewed,requestCount:plan.requestCount});
        if(fixture.hold) await new Promise(resolve=>fixture.pending=resolve);
        if(fixture.fail) {fixture.state(plan.sourceId).transcription={status:'failed',error:'提交状态不明'};throw Error('提交状态不明，请先核查');}
        if(fixture.accepted){Object.assign(fixture.state(plan.sourceId),{busy:true,transcription:{status:'running'},shared:{mode:'busy',reason:'共享任务未完成，请核查记录；不会自动重发请求'}});return;}
        if(plan.action==='transcription') fixture.state(plan.sourceId).transcription={status:'complete'};
        else {fixture.state(plan.sourceId).discovery={status:'complete'};fixture.state(plan.sourceId).ready=true;fixture.state(plan.sourceId).discoveryReady=true;}
        if(plan.prepare){fixture.state(plan.sourceId).discovery={status:'complete'};fixture.state(plan.sourceId).ready=true;fixture.state(plan.sourceId).discoveryReady=true;}
      }
    };
  `);
  await writeFile(join(scratch, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
  await writeFile(join(scratch, 'entry.tsx'), `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {ProductPreparation} from ${JSON.stringify(join(repo, 'packages/daocut/studio/ui/src/components/ProductPreparation.tsx').replaceAll('\\', '/'))};
    function App(){const [id,setId]=useState('a');const [tick,refresh]=useState(0);window.fixture.source=setId;window.fixture.refresh=()=>refresh(n=>n+1);
      return <ProductPreparation projectId="project" source={{id,assetPath:'assets/'+id+'.mp4',durationMs:1000}} refreshKey={tick} onReady={async()=>{window.fixture.notifications++}} onLocate={()=>{}}/>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `);
  await build({ configFile:false,root:scratch,cacheDir:join(scratch,'vite-cache'),logLevel:'silent',
    plugins:[react(),{name:'isolated-dependencies',resolveId(source,importer){
      if(/^(react|react-dom)(\/|$)/.test(source))return require.resolve(source);
      if(importer?.endsWith('/ProductPreparation.tsx') && /^\.\/(ExistingAnalysisSharing|TranscriptSeamReview|ProductSharedVersions)$/.test(source))return empty;
    }}],resolve:{alias:[{find:/^\.\/(ExistingAnalysisSharing|TranscriptSeamReview|ProductSharedVersions)$/,replacement:empty},{find:'@/api',replacement:apiFile},{find:'@',replacement:join(repo,'packages/daocut/studio/ui/src')}]},build:{outDir:join(scratch,'dist'),emptyOutDir:true}});
  const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://localhost').pathname;const file=path.startsWith('/assets/')?join(scratch,'dist',path):join(scratch,'dist/index.html');res.setHeader('content-type',file.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(file));}catch{res.writeHead(404).end();}});
  server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.DAOCUT_TEST_BROWSER||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
    const origin=`http://127.0.0.1:${server.address().port}`,context=await browser.newContext();
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await context.newPage();page.setDefaultTimeout(5000);
    const open=async()=>{await page.goto(origin);await page.getByRole('button',{name:'转写并拆品',exact:true}).waitFor();};
    await t.test('one confirmation prepares the source without another stage dialog',async()=>{
      await open();await page.getByRole('button',{name:'转写并拆品',exact:true}).click();
      const first=page.getByRole('dialog',{name:'确认转写并拆品'});await first.waitFor();
      assert.equal(await first.getAttribute('aria-modal'),'true');
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),0);
      await first.getByRole('button',{name:'确认转写并拆品',exact:true}).click();
      await page.getByText('商品段已准备好',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),1);
      assert.equal(await page.evaluate(()=>window.fixture.calls[0].prepare),true);
    });
    await t.test('cancel and source switching never carry a previous confirmation into the next source',async()=>{
      await open();await page.getByRole('button',{name:'转写并拆品',exact:true}).click();
      await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);
      await page.getByRole('button',{name:'转写并拆品',exact:true}).click();await page.getByRole('dialog').waitFor();
      await page.evaluate(()=>window.fixture.source('b'));await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),0);
      await page.getByRole('button',{name:'转写并拆品',exact:true}).click();await page.getByRole('dialog').waitFor();
      assert.equal(await page.evaluate(()=>window.fixture.plans.at(-1).sourceId),'b');
    });
    await t.test('a local accepted task refreshes the other controls without claiming a coworker owns it',async()=>{
      await open();await page.evaluate(()=>window.fixture.accepted=true);
      await page.getByRole('button',{name:'转写并拆品',exact:true}).click();
      await page.getByRole('button',{name:'确认转写并拆品',exact:true}).click();
      await page.getByText('正在处理，完成后自动保存',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.fixture.notifications),1);
      assert.equal(await page.getByText('同事正在分析，完成后可复用',{exact:true}).count(),0);
      assert.equal(await page.getByText('共享任务未完成，请核查记录；不会自动重发请求',{exact:true}).count(),0);
      assert.equal(await page.getByRole('button',{name:'转写并拆品',exact:true}).count(),0);
    });
    await t.test('unknown submission is not automatically retried or continued',async()=>{
      await open();await page.evaluate(()=>window.fixture.fail=true);await page.getByRole('button',{name:'转写并拆品',exact:true}).click();
      await page.getByRole('button',{name:'确认转写并拆品',exact:true}).click();await page.getByText('提交状态不明，请先核查',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),1);
      await page.getByRole('button',{name:'返回任务状态',exact:true}).click();
      await page.getByRole('button',{name:'继续转写拆品',exact:true}).click();
      await page.getByRole('checkbox',{name:'已核查服务记录，确认显式重试'}).waitFor();
      assert.equal(await page.getByRole('button',{name:'确认转写并拆品',exact:true}).isDisabled(),true);
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),1);
    });
    await t.test('an old submitted stage finishing late cannot close a new source confirmation',async()=>{
      await open();await page.evaluate(()=>window.fixture.hold=true);
      await page.getByRole('button',{name:'转写并拆品',exact:true}).click();await page.getByRole('button',{name:'确认转写并拆品',exact:true}).click();
      await page.waitForFunction(()=>window.fixture.calls.length===1&&window.fixture.pending);
      await page.evaluate(()=>window.fixture.source('b'));await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
      await page.getByRole('button',{name:'转写并拆品',exact:true}).click();await page.waitForFunction(()=>window.fixture.plans.at(-1).sourceId==='b');
      await page.evaluate(()=>window.fixture.pending());
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.match(await page.getByRole('dialog').innerText(),/assets\/b\.mp4/);
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),1,'switching only cancels continuation, not a submitted provider request');
    });
    await t.test('existing shared results are reused within the same confirmation',async()=>{
      await open();await page.evaluate(()=>window.fixture.reuse=true);
      await page.getByRole('button',{name:'转写并拆品',exact:true}).click();
      await page.getByRole('button',{name:'确认转写并拆品',exact:true}).click();
      await page.getByText('商品段已准备好',{exact:true}).waitFor();
      assert.equal(await page.evaluate(()=>window.fixture.calls.length),1);
      assert.equal(await page.evaluate(()=>window.fixture.calls.reduce((n,x)=>n+x.requestCount,0)),0);
    });
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
