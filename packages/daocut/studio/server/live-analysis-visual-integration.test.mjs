// Model and media adapters are injected; fixtures never contact real services or NAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { createLiveAnalysis } from './live-analysis.mjs';
import { createProductWorkflow } from './product-workflow.mjs';
import { createSharedAnalysis } from './shared-analysis.mjs';
import { readProductAnalysis, writeProductAnalysis } from './product-analysis.mjs';

const base = resolve(import.meta.dirname, '../../../../.tmp/visual-live-integration-20261110');
const scope = { sourceId: 's', productId: 'p', intervalId: 'first', startMs: 1000, endMs: 10000, lectureOnly: true };
const identity = { id: 'mock-vision', provider: 'mock', model: 'mock-image-model', endpoint: 'https://mock.invalid/images' };
const cues = [
  { startMs: 1000, endMs: 4000, text: '模拟杯可以单手按压打开。' },
  { startMs: 4000, endMs: 7000, text: '杯盖有密封圈。' },
  { startMs: 7000, endMs: 10000, text: '需要的选好规格下单。' },
  { startMs: 20000, endMs: 23000, text: '返场不混入首次讲解。' },
];
const response = { schema: 'complete-speech-v1', candidates: [
  { firstCue: 0, lastCue: 0, tags: ['卖点'] }, { firstCue: 1, lastCue: 1, tags: ['卖点'] }, { firstCue: 2, lastCue: 2, tags: ['逼单'] },
], issues: [] };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceSha = createHash('sha256').update('synthetic visual fixture source').digest('hex');
const candidateHash = candidates => digest(candidates.map(({ startMs, endMs, text, tags, cueRange }) => ({ startMs, endMs, text, tags: [...tags].sort(), ...(cueRange ? { cueRange } : {}) })).sort((a,b) => a.startMs-b.startMs || a.endMs-b.endMs || a.text.localeCompare(b.text)));
const media = selected => ({ version: 'product-media-review-v1', key: 'c'.repeat(64), sourceSha, status: 'complete', scope: { startMs: selected.startMs, endMs: selected.endMs }, segments: [{ startMs: selected.startMs, endMs: selected.endMs, visual: { status: 'sampled', sampleTimesMs: [selected.startMs], artifactSha256: 'd'.repeat(64) }, audio: { status: 'technical-checked', hasAudio: true, measurementRange: { startMs: selected.startMs, endMs: selected.endMs } }, issues: [] }], issues: [], speechVerified: false, continuousActionVerified: false });
const visual = (selected, candidates, status = 'complete') => ({ version: 'product-visual-review-v1', key: 'e'.repeat(64), sourceSha, candidatesHash: candidateHash(candidates), status, scope: { startMs: selected.startMs, endMs: selected.endMs }, model: identity,
  entries: status === 'complete' ? candidates.map(candidate => ({ startMs: candidate.startMs, endMs: candidate.endMs, cueRange: candidate.cueRange, productMatch: 'match', display: 'shown', evidenceTimesMs: [candidate.startMs], observation: '模拟返回：画面有对应杯子', issues: [] })) : [], issues: status === 'uncertain' ? ['模拟费用状态不明'] : [], speechVerified: false, continuousActionVerified: false });

async function fixture(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(`${base}${sep}`)); await rm(root, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', () => { throw Error('real model/network forbidden'); });
  await mkdir(join(root, 'assets')); await writeFile(join(root, 'assets/source.mp4'), 'synthetic visual fixture source');
  await writeFile(join(root, 'film.html'), 'existing personal film');
  const probeSource = async () => ({ duration: 30 });
  await writeProductAnalysis(root, { version: 1, sources: [{ id:'s', assetPath:'assets/source.mp4', durationMs:30000 }], products:[{id:'p',name:'模拟杯',sourceIds:['s']}], intervals:[{id:'first',sourceId:'s',productId:'p',startMs:1000,endMs:10000},{id:'return',sourceId:'s',productId:'p',startMs:20000,endMs:23000}], candidates:[] }, probeSource);
  const options = { modelIdentity: 'mock-text', probeSource, readTranscript: async () => ({ cues, words: [] }), mediaReview: async (_root,_source,selected) => media(selected) };
  return { root, options, async filmUnchanged() { assert.equal(await readFile(join(root,'film.html'),'utf8'),'existing personal film'); } };
}
async function analyze(live,root,extra={}) { await live.startAnalysis(root,{...scope,...extra}); await live.wait(root,'s'); return live.view(root,'s','first','p',scope); }

test('confirmed workflow counts and freezes the visual request, then saves one scoped review with unchanged text and film', async t => {
  const f=await fixture(t); let text=0, images=0;
  const service={identity:async()=>identity,review:async(root,source,selected,candidates,technical,options)=>{
    images++; assert.equal(root,f.root); assert.equal(source.id,'s'); assert.deepEqual([selected.startMs,selected.endMs],[1000,10000]);
    assert.equal(candidates.length,3); assert.deepEqual(options.expectedIdentity,identity); assert.equal(technical.status,'complete'); return visual(selected,candidates);
  }};
  const live=createLiveAnalysis({...f.options,modelClient:async()=>{text++;return structuredClone(response);},visualReview:service});
  const workflow=createProductWorkflow({liveAnalysis:live,discovery:{view:async()=>({status:'idle'})},analysisServices:async()=>({text:{enabled:true,provider:'mock',model:'mock-text',endpoint:'https://mock.invalid/text'}}),readTranscript:f.options.readTranscript});
  const plan=await workflow.plan(f.root,{action:'analysis',...scope});
  assert.equal(plan.visual.requestCount,1); assert.deepEqual(plan.visual.identity,identity); assert.equal(plan.requestCount,2); assert.equal(images,0);
  await workflow.execute(f.root,{confirmed:true,plan}); await workflow.wait(f.root,'s');
  const state=await live.view(f.root,'s','first','p',scope);
  assert.equal(state.analysis.status,'complete'); assert.equal(state.analysis.visualReview.status,'complete'); assert.equal(text,1); assert.equal(images,1);
  assert.deepEqual((await readProductAnalysis(f.root)).analysis.candidates.map(c=>c.text),cues.slice(0,3).map(c=>c.text));
  const again=await workflow.plan(f.root,{action:'analysis',...scope}); assert.equal(again.requestCount,0);
  await workflow.execute(f.root,{confirmed:true,plan:again}); await workflow.wait(f.root,'s'); assert.equal(images,1); assert.equal(text,1); await f.filmUnchanged();
});

test('legacy completed analysis and direct unconfirmed visual identity never send images; explicit planned supplement is cached', async t => {
  const f=await fixture(t); let images=0,text=0;
  const live=createLiveAnalysis({...f.options,modelClient:async()=>{text++;return structuredClone(response);},visualReview:{identity:async()=>identity,review:async(_root,_source,selected,candidates)=>{images++;return visual(selected,candidates);}}});
  await analyze(live,f.root); assert.equal(images,0);
  await analyze(live,f.root,{expectedVisualIdentity:identity}); assert.equal(images,0,'existing result is not silently upgraded');
  const before=await readFile(join(f.root,'.film/product-analysis.json'),'utf8');
  const plan=await live.visualPlan(f.root,scope); assert.equal(plan.requestCount,1); assert.equal(images,0);
  await assert.rejects(live.reviewVisual(f.root,{confirmed:false,plan}),/确认/);
  const checked=await live.reviewVisual(f.root,{confirmed:true,plan}); assert.equal(checked.analysis.visualReview.status,'complete'); assert.equal(images,1); assert.equal(text,1);
  const cached=await live.visualPlan(f.root,scope); assert.equal(cached.requestCount,0);
  await live.reviewVisual(f.root,{confirmed:true,plan:cached}); assert.equal(images,1);
  assert.equal(await readFile(join(f.root,'.film/product-analysis.json'),'utf8'),before); await f.filmUnchanged();
});

test('visual uncertainty preserves completed text and requires an explicit reviewed retry without resubmitting text', async t => {
  const f=await fixture(t); let text=0,images=0,journalComplete=false;
  const live=createLiveAnalysis({...f.options,modelClient:async()=>{text++;return structuredClone(response);},visualReview:{identity:async()=>identity,recovery:async()=>({recoverable:journalComplete}),review:async(_root,_source,selected,candidates,_media,options)=>{images++; if(images>1){assert.equal(options.retryAcknowledged,true);journalComplete=true;} return visual(selected,candidates,images===1?'uncertain':'complete');}}});
  const done=await analyze(live,f.root,{expectedVisualIdentity:identity}); assert.equal(done.analysis.status,'complete'); assert.equal(done.analysis.visualReview.status,'uncertain');
  await analyze(live,f.root,{expectedVisualIdentity:identity}); assert.equal(images,1); assert.equal(text,1);
  const plan=await live.visualPlan(f.root,scope); assert.equal(plan.retryRequired,true);
  await assert.rejects(live.reviewVisual(f.root,{confirmed:true,plan}),/核查|重试|不明|不确定/); assert.equal(images,1);
  await live.reviewVisual(f.root,{confirmed:true,plan,retryAcknowledged:true}); assert.equal(images,2); assert.equal(text,1); await f.filmUnchanged();
});

test('visual plan rejects changed configuration or candidate input and shared import reuses the saved record', async t => {
  const f=await fixture(t); let configured=identity,images=0;
  const live=createLiveAnalysis({...f.options,modelClient:async()=>structuredClone(response),visualReview:{identity:async()=>configured,review:async(_root,_source,selected,candidates)=>{images++;return visual(selected,candidates);}}});
  await analyze(live,f.root); const plan=await live.visualPlan(f.root,scope);
  configured={...identity,model:'changed'}; await assert.rejects(live.reviewVisual(f.root,{confirmed:true,plan}),/变化|改变|核对/); assert.equal(images,0); configured=identity;
  const done=await live.reviewVisual(f.root,{confirmed:true,plan});
  configured={...identity,model:'another-image-model'};
  assert.equal((await live.view(f.root,'s','first','p',scope)).analysis.stale,false,'changing the visual model does not invalidate saved text');
  assert.equal((await live.visualPlan(f.root,scope)).requestCount,0,'completed visual evidence is reusable across configuration changes');
  await analyze(live,f.root,{expectedVisualIdentity:configured}); assert.equal(images,1); configured=identity;
  const payload=await live.exportShared(f.root,'s','first'); assert.deepEqual(payload.visualReview,done.analysis.visualReview);
  const receiver=await fixture(t), reject=async()=>assert.fail('shared visual result must not rerun service');
  const reused=createLiveAnalysis({...receiver.options,modelClient:reject,visualReview:{identity:async()=>identity,review:reject}});
  await reused.importShared(receiver.root,'s',scope,payload,{sha256:'b'.repeat(64)});
  const reopened=await analyze(reused,receiver.root,{expectedVisualIdentity:identity}); assert.deepEqual(reopened.analysis.visualReview,payload.visualReview);
  const oldPlan=await live.visualPlan(f.root,scope); const changed=(await readProductAnalysis(f.root)).analysis; changed.candidates[0].text+='已修正'; await writeProductAnalysis(f.root,changed,f.options.probeSource);
  await assert.rejects(live.reviewVisual(f.root,{confirmed:true,plan:oldPlan}),/变化|改变|核对/); assert.equal(images,1); await receiver.filmUnchanged();
});

test('visual tool failure keeps text complete and a source boundary change during supplement cannot overwrite the saved analysis', async t => {
  const f=await fixture(t); let text=0,images=0;
  const live=createLiveAnalysis({...f.options,modelClient:async()=>{text++;return structuredClone(response);},visualReview:{identity:async()=>identity,review:async()=>{images++;throw Error('mock transport failure');}}});
  const failed=await analyze(live,f.root,{expectedVisualIdentity:identity}); assert.equal(failed.analysis.status,'complete'); assert.ok(['failed','uncertain'].includes(failed.analysis.visualReview.status)); assert.equal(text,1);
  const plan=await live.visualPlan(f.root,scope); const changed=(await readProductAnalysis(f.root)).analysis; changed.intervals[0].endMs=11000; await writeProductAnalysis(f.root,changed,f.options.probeSource);
  await assert.rejects(live.reviewVisual(f.root,{confirmed:true,plan,retryAcknowledged:true}),/变化|改变|范围|边界/); assert.equal(images,1); assert.equal(text,1); await f.filmUnchanged();
});

test('saved raw visual reply is recovered before any paid retry and without resubmitting text or images', async t => {
  const f=await fixture(t); let text=0,images=0,recoverable=false;
  const live=createLiveAnalysis({...f.options,modelClient:async()=>{text++;return structuredClone(response);},visualReview:{
    identity:async()=>identity,
    recovery:async()=>({recoverable}),
    review:async(_root,_source,selected,candidates,_technical,options)=>{
      if(!recoverable){images++;recoverable=true;throw Error('raw response saved but final record write interrupted');}
      assert.equal(options.retryAcknowledged,false,'local recovery must not authorize another paid request');
      return visual(selected,candidates);
    },
  }});
  await analyze(live,f.root,{expectedVisualIdentity:identity}); assert.equal(images,1); assert.equal(text,1);
  const plan=await live.visualPlan(f.root,scope);
  assert.equal(plan.recoverable,true); assert.equal(plan.requestCount,0); assert.equal(plan.retryRequired,false); assert.equal(plan.cost.estimate,0);
  const restored=await live.reviewVisual(f.root,{confirmed:true,plan}); assert.equal(restored.analysis.visualReview.status,'complete');
  assert.equal(images,1); assert.equal(text,1); await f.filmUnchanged();
});

test('visual GET plan and duplicate POST confirmation coalesce without another image request', {timeout:5000}, async t => {
  const f=await fixture(t); let images=0,release,entered;
  const gate=new Promise(resolve=>{release=resolve;}), inTool=new Promise(resolve=>{entered=resolve;});
  const live=createLiveAnalysis({...f.options,modelClient:async()=>structuredClone(response),visualReview:{identity:async()=>identity,review:async(_root,_source,selected,candidates)=>{images++;entered();await gate;return visual(selected,candidates);}}});
  await analyze(live,f.root);
  const call=async(method,rest,body)=>{
    const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]); req.method=method;
    req.url=`/${rest}?${new URLSearchParams(Object.fromEntries(Object.entries(scope).map(([k,v])=>[k,String(v)])))}`;
    let value,status; const res={writeHead(code){status=code;},end(text){value=JSON.parse(text);}};
    assert.equal(await live(req,res,f.root,rest),true); return {status,value};
  };
  const {value:plan,status}=await call('GET','live-analysis/visual-plan'); assert.equal(status,200); assert.equal(images,0);
  assert.equal(plan.service.model,identity.model); assert.equal(plan.service.endpoint,identity.endpoint); assert.equal(plan.service.identity,undefined);
  const first=call('POST','live-analysis/review-visual',{confirmed:true,plan}); await inTool;
  const second=call('POST','live-analysis/review-visual',{confirmed:true,plan}); release();
  const results=await Promise.all([first,second]); assert.equal(images,1); assert.ok(results.every(result=>result.status===200)); await f.filmUnchanged();
});

test('two projects reuse one shared text and visual analysis without replacing either personal film', async t => {
  const first=await fixture(t), second=await fixture(t); let text=0,images=0,serial=0; const tasks=new Map();
  const coordinate=async(op,body)=>{
    let task=tasks.get(body.taskKey);
    if(op==='status') return {task:structuredClone(task??null)};
    if(op==='claim') { if(task)return {acquired:false,task:structuredClone(task)}; task={status:'claimed',taskKey:body.taskKey,inputHash:body.inputHash,attemptId:`mock-${++serial}`};tasks.set(body.taskKey,task);return {acquired:true,task:structuredClone(task)}; }
    assert.equal(task.attemptId,body.attemptId);
    if(op==='submitted'){const sendAllowed=task.status==='claimed';task.status='submitted';return {sendAllowed,task:structuredClone(task)};}
    if(op==='complete'){task.status='complete';task.result=body.result;}
    if(op==='fail')task.status='uncertain'; return {task:structuredClone(task)};
  };
  const make=f=>{
    const live=createLiveAnalysis({...f.options,modelClient:async()=>{text++;return structuredClone(response);},visualReview:{identity:async()=>identity,review:async(_root,_source,selected,candidates)=>{images++;return visual(selected,candidates);}}});
    const shared=createSharedAnalysis({coordinate,settings:()=>({enabled:true,resultRoots:[{libraryId:'mock-library',root:join(first.root,'isolated-shared')}]}),readManifest:async()=>({items:{'assets/source.mp4':{libraryId:'mock-library',relativePath:'synthetic/source.mp4'}}})});
    const workflow=createProductWorkflow({liveAnalysis:live,discovery:{view:async()=>({status:'idle'})},sharedAnalysis:shared,readTranscript:f.options.readTranscript,analysisServices:async()=>({text:{enabled:true,provider:'mock',model:'mock-text',endpoint:'https://mock.invalid/text'}})});
    return {live,workflow};
  };
  const a=make(first),b=make(second);
  const run=async(f,w)=>{const plan=await w.plan(f.root,{action:'analysis',...scope});await w.execute(f.root,{confirmed:true,plan});await w.wait(f.root,'s');return plan;};
  await run(first,a.workflow); assert.equal(text,1);assert.equal(images,1);
  const plan=await run(second,b.workflow);assert.equal(plan.shared.mode,'reuse');assert.equal(plan.requestCount,0);assert.equal(plan.visual.requestCount,0);
  const av=await a.live.view(first.root,'s','first','p',scope),bv=await b.live.view(second.root,'s','first','p',scope);
  assert.deepEqual(bv.analysis.visualReview,av.analysis.visualReview);assert.equal(text,1);assert.equal(images,1);await first.filmUnchanged();await second.filmUnchanged();
});

test('renaming a product retains text but marks its named visual judgment stale without automatically requesting images', async t => {
  const f=await fixture(t);let text=0,images=0;
  const live=createLiveAnalysis({...f.options,modelClient:async()=>{text++;return structuredClone(response);},visualReview:{identity:async()=>identity,review:async(_root,_source,selected,candidates)=>{images++;assert.equal(selected.productName,'模拟杯');return {...visual(selected,candidates),productName:selected.productName};}}});
  const done=await analyze(live,f.root,{expectedVisualIdentity:identity});assert.equal(done.analysis.visualReviewStale,false);
  const changed=(await readProductAnalysis(f.root)).analysis;changed.products[0].name='已更正的另一商品';await writeProductAnalysis(f.root,changed,f.options.probeSource);
  const state=await live.view(f.root,'s','first','p',scope);assert.equal(state.analysis.status,'complete');assert.equal(state.analysis.stale,false);assert.equal(state.analysis.visualReviewStale,true);
  assert.equal(state.analysis.visualReview.productName,'模拟杯','the original judgment remains traceable');
  const plan=await live.visualPlan(f.root,scope);assert.equal(plan.cached,false);assert.equal(plan.requestCount,1);
  await analyze(live,f.root,{expectedVisualIdentity:identity});assert.equal(images,1);assert.equal(text,1);await f.filmUnchanged();
});
