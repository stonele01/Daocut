import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { startStudio } from './server.mjs';
import { filmHtml, readFilmFile } from '../../src/film-doc.mjs';

test('source edits render correct synthetic MP4', { timeout: 240000 }, async () => {
  const base = resolve('../../.tmp'); await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'source-axis-verified-'));
  const oldEnv = Object.fromEntries(['DAOCUT_STUDIO_HOME', 'DAOCUT_LIBRARY', 'DAOCUT_TRASH_DIR', 'DAOCUT_EXPORTS', 'PLAYWRIGHT_BROWSERS_PATH', 'TEMP', 'TMP'].map(k => [k, process.env[k]]));
  process.env.DAOCUT_STUDIO_HOME = join(scratch, 'home'); process.env.DAOCUT_LIBRARY = join(scratch, 'library'); process.env.DAOCUT_TRASH_DIR = join(scratch, 'trash');
  process.env.DAOCUT_EXPORTS = join(scratch, 'exports'); process.env.PLAYWRIGHT_BROWSERS_PATH = 'D:/Daocut/App/resources/runtime/ms-playwright'; process.env.TEMP = join(scratch,'temp'); process.env.TMP = process.env.TEMP;
  await mkdir(process.env.DAOCUT_TRASH_DIR); await mkdir(process.env.DAOCUT_EXPORTS); await mkdir(process.env.TEMP);
  let studio, browser, step = 'setup';
  try {
    studio = await startStudio({ port: 0, editorDir: process.env.DAOCUT_TEST_EDITOR_DIR ? resolve(process.env.DAOCUT_TEST_EDITOR_DIR) : undefined, openBrowser: () => {} });
    const api = async (path, method = 'GET', body) => {
      const r = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(r.status, 200, 'fixture API failed'); return r.json();
    };
    const { project } = await api('/api/projects', 'POST', { path: join(scratch, 'synthetic-project') });
    await mkdir(join(project.path, 'assets'), { recursive: true });
    for (const [name,baseColor,afterColor,transition,hz] of [['a','red','blue',20,440],['b','green','yellow',21,880]]) {
      const picture=`color=c=${baseColor}:s=320x180:r=10:d=30,drawbox=x=0:y=0:w=iw:h=ih:color=${afterColor}:t=fill:enable='gte(t,${transition})'`;
      execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',picture,'-f','lavfi','-i',`sine=frequency=${hz}:duration=30`,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',join(project.path,'assets',`synthetic-${name}.mp4`)],{windowsHide:true});
    }
    const tags = ['钩子', '痛点', '卖点', '产品演示', '价格锚点', '行动指令'];
    const starts = [1000, 4000, 7000, 10000, 17000, 22000];
    const analysis = { version: 1, sources: ['a', 'b'].map(id => ({ id, assetPath: `assets/synthetic-${id}.mp4`, durationMs: null })), products: [{ id: 'p', name: '合成测试商品', sourceIds: ['a', 'b'] }], intervals: [{ id: 'i', productId: 'p', sourceId: 'a', startMs: 0, endMs: 29000 }, { id: 'j', productId: 'p', sourceId: 'b', startMs: 15000, endMs: 29000 }], candidates: [...tags.map((tag, n) => ({ id: `c${n}`, productId: 'p', intervalId: 'i', sourceId: 'a', startMs: starts[n], endMs: starts[n] + 2500, text: `合成${tag}`, tags: [tag], origin: 'synthetic-test', version: 1 })), { id: 'tiny', productId: 'p', intervalId: 'i', sourceId: 'a', startMs: 3950, endMs: 3999, text: '合成短候选', tags: ['钩子'], origin: 'synthetic-test', version: 1 }, { id: 'multi', productId: 'p', intervalId: 'i', sourceId: 'a', startMs: 12000, endMs: 16000, text: '合成多标签', tags: ['钩子', '痛点'], origin: 'synthetic-test', version: 1 }, { id: 'other', productId: 'p', intervalId: 'j', sourceId: 'b', startMs: 20000, endMs: 23000, text: '合成切换来源', tags: ['行动指令'], origin: 'synthetic-test', version: 1 }] };
    await api(`/api/projects/${project.id}/product-analysis`, 'PUT', { analysis });
    const filmPath = join(project.path, 'film.html');
    await writeFile(filmPath, filmHtml({ stage: { w: 320, h: 180 }, tracks: [{ clips: [{ id: 'synthetic-clip', src: 'assets/synthetic-a.mp4', at: 0, time: [0, 2] }] }] }));
    const before = await readFile(filmPath, 'utf8');
    const analysisPath = join(project.path, '.film', 'product-analysis.json');
    const beforeAnalysis = await readFile(analysisPath, 'utf8');
    const mediaPath = join(project.path, 'assets', 'synthetic-b.mp4');
    const hash = async () => createHash('sha256').update(await readFile(mediaPath)).digest('hex');
    const beforeHash = await hash();
    const hashA = async () => createHash('sha256').update(await readFile(join(project.path, 'assets', 'synthetic-a.mp4'))).digest('hex');
    const beforeHashA = await hashA();
    browser = await chromium.launch({ executablePath: process.env.DAOCUT_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    await page.route('**/live-analysis**', route => route.fulfill({ json: { transcription: { status: 'idle', segments: [] }, analysis: { status: 'idle' } } }));
    step = 'open synthetic project';
    await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
    await page.getByRole('button', { name: '商品与结构' }).click();
    await page.getByRole('button', { name: '合成测试商品' }).first().waitFor();
    const axis = page.locator('[data-source-axis]'); await axis.waitFor();
    const source = page.locator('[data-timeline-scope="source"]');
    const main = page.locator('[data-timeline-scope="main"]');
    step='add B candidate through the source axis';
    await page.getByLabel('候选显示范围', { exact: true }).getByRole('button', { name: '该商品全部讲解', exact: true }).click();
    await page.getByRole('button',{name:/^行动指令\s+\d+$/}).click();
    await page.getByLabel('候选片段').getByText('合成切换来源').click();
    const bCandidate=source.locator('[data-source-candidate="other"]').first(); await bCandidate.waitFor();
    const dragToTimeline=async block=>{
      await block.scrollIntoViewIfNeeded(); const a=await block.boundingBox(), scroll=await main.locator('.tl-scroll').boundingBox(), last=await main.locator('[data-block-kind="video"]').last().boundingBox(); assert.ok(a&&scroll&&last);
      const x=Math.min(scroll.x+scroll.width-20,last.x+last.width+80);
      await page.mouse.move(a.x+a.width/2,a.y+a.height/2); await page.mouse.down(); await page.mouse.move(x,last.y+last.height/2,{steps:30}); await page.waitForTimeout(300); await page.mouse.up();
      await page.waitForTimeout(1500);
    };
    await dragToTimeline(bCandidate);
    let doc=readFilmFile(await readFile(filmPath,'utf8')).doc; assert.ok(doc, 'valid edited film');
    assert.ok(doc.tracks.flatMap(t=>t.clips).some(c=>c.src==='assets/synthetic-b.mp4'),'candidate B was written');
    step='add A ordinary source range';
    await page.getByRole('button',{name:/^钩子\s+\d+$/}).click();
    await page.getByLabel('候选片段').getByText('合成钩子',{exact:true}).click();
    const gray=source.locator('[data-source-context][data-source-start="19500"][data-source-end="22000"]').first(); await gray.waitFor();
    await dragToTimeline(gray);
    doc=readFilmFile(await readFile(filmPath,'utf8')).doc;
    let clips=doc.tracks.flatMap(t=>t.clips).filter(c=>c.src?.startsWith('assets/synthetic-')).sort((a,b)=>(a.at??0)-(b.at??0));
    assert.equal(clips.length,3,JSON.stringify(clips));
    assert.deepEqual(clips.map(c=>c.src),['assets/synthetic-a.mp4','assets/synthetic-a.mp4','assets/synthetic-b.mp4']);
    assert.deepEqual(clips[1].time,[19.5,22]);
    step='extend the assembled gray clip';
    const grayAdded=main.locator('[data-block-kind="video"]').nth(1);
    const edge=grayAdded.locator('[data-trim="end"]'); await edge.scrollIntoViewIfNeeded(); const eb=await edge.boundingBox(); assert.ok(eb);
    await page.mouse.move(eb.x+eb.width/2,eb.y+eb.height/2); await page.mouse.down(); await page.mouse.move(eb.x+eb.width/2+30,eb.y+eb.height/2,{steps:20}); await page.mouse.up(); await page.waitForTimeout(1500);
    doc=readFilmFile(await readFile(filmPath,'utf8')).doc;
    clips=doc.tracks.flatMap(t=>t.clips).filter(c=>c.src?.startsWith('assets/synthetic-')).sort((a,b)=>(a.at??0)-(b.at??0));
    assert.ok(clips[1].time[1]>22,'right trim restores source after 22 seconds');
    const finalFilm=await readFile(filmPath,'utf8');
    assert.equal(await readFile(analysisPath,'utf8'),beforeAnalysis); assert.equal(await hash(),beforeHash); assert.equal(await hashA(),beforeHashA);
    step='export MP4 through the UI';
    const requested=page.waitForResponse(r=>r.url().includes(`/projects/${project.id}/exports`) && r.request().method()==='POST');
    await page.getByRole('button',{name:'导出',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:'导出'}); await dialog.waitFor();
    await dialog.getByRole('button',{name:'导出',exact:true}).click();
    const response=await requested; assert.equal(response.status(),200); const queued=await response.json();
    const id=(queued.exports??[queued.export])[0].id; let job;
    for(let i=0;i<240;i++) {const result=await api(`/api/projects/${project.id}/exports`); job=result.exports.find(j=>j.id===id); if(job&&['done','failed','cancelled'].includes(job.status))break; await new Promise(resolve=>setTimeout(resolve,500));}
    assert.equal(job?.status,'done',`export status ${job?.status}: ${job?.error??''}`);
    const out=job.outputs?.[0]; assert.ok(out && out.toLowerCase().endsWith('.mp4') && out.startsWith(process.env.DAOCUT_EXPORTS),'output stays in project temp exports');
    step='verify output length, source images and sound';
    const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',out],{encoding:'utf8',windowsHide:true}));
    const expectedEnd=Math.max(...clips.map(c=>(c.at??0)+(c.time[1]-c.time[0])));
    assert.ok(Math.abs(Number(info.format.duration)-expectedEnd)<0.25,`duration ${info.format.duration} vs ${expectedEnd}`);
    assert.ok(info.streams.some(s=>s.codec_type==='audio'),'export has audio');
    const pixel=(file,seconds)=>{const raw=execFileSync('ffmpeg',['-v','error','-ss',String(seconds),'-i',file,'-frames:v','1','-vf','crop=2:2:160:90','-f','rawvideo','-pix_fmt','rgb24','-'],{windowsHide:true}); assert.ok(raw.length>=3);return [...raw.subarray(0,3)];};
    const tone=(file,seconds)=>{const raw=execFileSync('ffmpeg',['-v','error','-ss',String(seconds),'-i',file,'-t','0.5','-vn','-ac','1','-ar','8000','-f','f32le','-'],{windowsHide:true}); const n=raw.length/4; assert.ok(n>2000); const power=hz=>{let re=0,im=0;for(let i=0;i<n;i++){const v=raw.readFloatLE(i*4),a=2*Math.PI*hz*i/8000;re+=v*Math.cos(a);im+=v*Math.sin(a);}return Math.hypot(re,im);};return {a:power(440),b:power(880)};};
    for(const c of clips){
      const len=c.time[1]-c.time[0], at=c.at??0, src=join(project.path,...c.src.split('/'));
      for(const delta of [0.25,len-0.25]){const actual=pixel(out,at+delta), expected=pixel(src,c.time[0]+delta); assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<35),`${c.src} frame at ${delta}: ${actual} vs ${expected}`);}
      const sound=tone(out,at+Math.max(0.1,len/2-0.25)); assert.ok(c.src.includes('-a.')?sound.a>sound.b*4:sound.b>sound.a*4,`${c.src} tone ${JSON.stringify(sound)}`);
    }
    assert.equal(await readFile(filmPath,'utf8'),finalFilm); assert.equal(await readFile(analysisPath,'utf8'),beforeAnalysis); assert.equal(await hash(),beforeHash); assert.equal(await hashA(),beforeHashA);
    const artifact=resolve('../../.tmp/source-film-export-verified.mp4'); await copyFile(out,artifact); console.log(`Synthetic export: ${artifact}; duration ${info.format.duration}; source clips ${clips.length}`);
  } catch(error) { throw new Error(`Synthetic export test failed at: ${step}`,{cause:error}); }
  finally {
    await browser?.close(); await studio?.close();
    for(const [k,v] of Object.entries(oldEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await rm(scratch,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
