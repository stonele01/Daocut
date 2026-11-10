import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, readdir, utimes, copyFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const base=resolve('../../.tmp/shared-existing-20261105/media');
await mkdir(base,{recursive:true});
const scratch=await mkdtemp(join(base,'logical-'));
const envNames=['DAOCUT_HOME','DAOCUT_STUDIO_HOME','DAOCUT_SHARED_HOME','DAOCUT_LIBRARY','DAOCUT_TRASH_DIR','DAOCUT_EXPORTS','TEMP','TMP','PLAYWRIGHT_BROWSERS_PATH','DAOCUT_NO_UPDATE_CHECK'];
const oldEnv=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
const localFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Real service requests are forbidden in this isolated test');return localFetch(input,options);};
for(const k of envNames.filter(k=>!['PLAYWRIGHT_BROWSERS_PATH','DAOCUT_NO_UPDATE_CHECK'].includes(k))){process.env[k]=join(scratch,k);await mkdir(process.env[k],{recursive:true});}
process.env.PLAYWRIGHT_BROWSERS_PATH='D:/Daocut/App/resources/runtime/ms-playwright';process.env.DAOCUT_NO_UPDATE_CHECK='1';
const media=await import('./shared-media.mjs'),files=await import('./files.mjs'),derived=await import('./derived.mjs');
const {filmHtml}=await import('../../src/film-doc.mjs');
const {createProjectBackup,inspectProjectBackup,restoreProjectBackup}=await import('./project-backup.mjs');
let source,sourceHash,libraryRoot,sequence=0;
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
before(async()=>{libraryRoot=join(scratch,'read-only-library');await mkdir(join(libraryRoot,'live'),{recursive:true});source=join(libraryRoot,'live','sample.mp4');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=160x90:r=10:d=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',source],{windowsHide:true});sourceHash=await hash(source);await media.associateSharedLibrary({id:'logical-test-library',name:'Isolated logical source',root:libraryRoot});});
after(async()=>{assert.equal(await hash(source),sourceHash,'source bytes remain unchanged');globalThis.fetch=localFetch;for(const [k,v]of Object.entries(oldEnv)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
async function fixture(){return media.createSharedMediaProject({libraryId:'logical-test-library',videoPath:'live/sample.mp4',requestId:`logical-request-${++sequence}`});}
async function absent(path){assert.equal(await lstat(path).then(()=>false,()=>true),true,'project contains neither source copy nor symlink');}

test('two projects register the same logical source without a copied video or a filesystem link',async()=>{
 const a=await fixture(),b=await fixture();assert.notEqual(a.project.id,b.project.id);
 for(const item of [a,b]){await absent(join(item.project.path,item.asset));const manifest=await media.sharedMediaManifest(item.project.path);assert.equal(manifest.items[item.asset].mode,'reference');assert.equal(manifest.items[item.asset].sha256,sourceHash);assert.equal((await media.resolveSharedMedia(item.project.path,item.asset)).path,source);const listing=await media.listSharedProjectMedia(item.project.path);assert.ok(listing.files.some(f=>f.path===item.asset));assert.equal(listing.links[item.asset].source.status,'available');assert.equal(files.readable(item.project.path,item.asset),source);assert.notEqual(files.inside(item.project.path,item.asset),source,'write path never resolves to library');}
});
test('logical source serves byte ranges and supplies seek frames, waveforms and original audio',async()=>{
 const a=await fixture();const {startPages}=await import('./pages.mjs');const pages=await startPages({port:0,editorOrigin:()=> 'http://127.0.0.1:1',secret:'isolated-test-only',projects:async()=>[a.project]});
 try{const url=pages.folderUrl(a.project)+a.asset;const raw=await readFile(source);const response=await fetch(url,{headers:{Range:'bytes=20-79'}});assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),raw.subarray(20,80));assert.equal((await fetch(url,{method:'HEAD'})).status,200);assert.equal((await fetch(url,{headers:{Range:`bytes=${raw.length+2}-`}})).status,416);
 const facts=await derived.probe(a.project.path,a.asset);assert.equal(facts.audio,true);assert.ok(Math.abs(facts.duration-3)<.15);assert.ok((await derived.frame(a.project.path,a.asset,1500,80)).length>20);const wave=await derived.waveform(a.project.path,a.asset);assert.ok(wave.peaks.some(n=>n>0));const audio=await fetch(url+'?film-sound=1');assert.equal(audio.status,200);assert.ok((await audio.arrayBuffer()).byteLength>1000);await absent(join(a.project.path,a.asset));}finally{await pages.close();}
});
test('logical references survive complete personal backup and restore without copying the original',async()=>{
 const a=await fixture(),backup=join(scratch,'backup');await createProjectBackup(a.project.path,backup);await absent(join(backup,a.asset));const inspection=await inspectProjectBackup(backup);const target=join(scratch,'restored');await restoreProjectBackup({confirmed:true,backupPath:backup,expectedBackupId:inspection.backupId,targetPath:target,mappings:[{libraryId:'logical-test-library',root:libraryRoot}]});await absent(join(target,a.asset));assert.equal((await media.resolveSharedMedia(target,a.asset)).path,source);assert.equal((await derived.probe(target,a.asset)).audio,true);
});
test('unmapped and escaped logical references are refused rather than reading another file',async()=>{
 const a=await fixture(),at=join(a.project.path,'assets/.daocut-source-media.json'),m=JSON.parse(await readFile(at,'utf8'));m.items[a.asset].libraryId='missing-library-id';await writeFile(at,JSON.stringify(m));assert.throws(()=>files.readable(a.project.path,a.asset));m.items[a.asset].libraryId='logical-test-library';m.items[a.asset].relativePath='../outside.mp4';await writeFile(at,JSON.stringify(m));assert.throws(()=>files.readable(a.project.path,a.asset));
});
test('ordinary video export resolves virtual picture and audio and leaves the library untouched',{timeout:180000},async()=>{
 const a=await fixture();await writeFile(join(a.project.path,'film.html'),filmHtml({stage:{w:160,h:90,fps:10},tracks:[{clips:[{id:'a',src:a.asset,at:0,time:[.5,1.5]}]}]}));const {createExports}=await import('./exports.mjs');const exports=createExports();const queued=exports.start(a.project,{kind:'video',codec:'h264',fps:10,audio:true},{folder:process.env.DAOCUT_EXPORTS});let result;for(let i=0;i<240;i++){result=exports.list(a.project.id).find(j=>j.id===queued.id);if(['done','failed','cancelled'].includes(result.status))break;await new Promise(r=>setTimeout(r,300));}assert.equal(result.status,'done',result.error);const out=result.outputs.find(p=>p.endsWith('.mp4'));assert.ok(out);const facts=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',out],{encoding:'utf8',windowsHide:true}));assert.ok(facts.streams.some(s=>s.codec_type==='video'));assert.ok(facts.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(facts.format.duration)-1)<.25);const pcm=execFileSync('ffmpeg',['-v','error','-i',out,'-vn','-ac','1','-ar','8000','-f','s16le','-'],{windowsHide:true});assert.ok(pcm.some(n=>n!==0));const pixel=execFileSync('ffmpeg',['-v','error','-ss','0.2','-i',out,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','-'],{windowsHide:true});assert.ok(pixel[0]>150&&pixel[1]<90&&pixel[2]<90);await absent(join(a.project.path,a.asset));assert.equal(await hash(source),sourceHash);assert.deepEqual(await readdir(libraryRoot),['live']);
});

test('a previously copied local video can bind to a library only after explicit confirmation and equal full hashes', async () => {
 const {createProject}=await import('./projects.mjs');const p=await createProject('Existing local video');await mkdir(join(p.path,'assets'));const asset='assets/local.mp4';await copyFile(source,join(p.path,asset));const before=await stat(join(p.path,asset));
 const input={projectRoot:p.path,assetPath:asset,libraryId:'logical-test-library',videoPath:'live/sample.mp4',confirmed:true};
 await assert.rejects(async()=>media.bindSharedMediaCopy({...input,confirmed:false}));
 const result=await media.bindSharedMediaCopy(input);assert.equal(result.asset,asset);assert.equal(result.source.mode,'verified-copy');assert.equal(result.source.sha256,sourceHash);assert.equal(files.readable(p.path,asset),join(p.path,asset));assert.equal((await media.resolveSharedMedia(p.path,asset)).path,join(p.path,asset));assert.equal((await stat(join(p.path,asset))).mtimeMs,before.mtimeMs);assert.equal((await stat(join(p.path,asset))).ino,before.ino);
 await writeFile(join(p.path,asset),Buffer.alloc(before.size));await assert.rejects(media.bindSharedMediaCopy(input),/content|内容/);await assert.rejects(media.resolveSharedMedia(p.path,asset),/changed|内容/);
});

test('cold logical references require asynchronous identity verification rather than blocking the host on a full hash', async()=>{
 const a=await fixture();const script=`import {resolveMediaReference,prepareMediaReferences} from './src/shared-media-reference.mjs';let cold=false;try{resolveMediaReference(${JSON.stringify(a.project.path)},${JSON.stringify(a.asset)})}catch(e){cold=e.code==='SHARED_MEDIA_UNVERIFIED'}if(!cold)throw Error('cold read must require async preparation');await prepareMediaReferences(${JSON.stringify(a.project.path)});if(!resolveMediaReference(${JSON.stringify(a.project.path)},${JSON.stringify(a.asset)}))throw Error('not resolved');`;
 execFileSync(process.execPath,['--input-type=module','-e',script],{windowsHide:true,env:process.env});
});

test('a same-size same-mtime replacement cannot reuse a logical identity or pass the export guard', async()=>{
 const root=join(scratch,'replacement-library');await mkdir(root);const original=join(root,'same.mp4');await copyFile(source,original);await media.associateSharedLibrary({id:'replacement-library',name:'Replacement test',root});const a=await media.createSharedMediaProject({libraryId:'replacement-library',videoPath:'same.mp4',requestId:'replacement-request'});const before=await stat(original);await writeFile(original,Buffer.alloc(before.size));await utimes(original,before.atime,before.mtime);await assert.rejects(media.resolveSharedMedia(a.project.path,a.asset),/changed/);assert.equal((await media.refreshSharedMedia(a.project.path))[a.asset].status,'needs-confirmation');
 await writeFile(join(a.project.path,'film.html'),filmHtml({stage:{w:160,h:90,fps:10},tracks:[{clips:[{id:'a',src:a.asset,at:0,time:[0,1]}]}]}));const {assertExportSources}=await import('./export-source-guard.mjs');await assert.rejects(assertExportSources(a.project.path,{kind:'video'}),/原片已变化/);
});

test('ordinary project folder and ZIP exports include verified source bytes and omit virtual-only mapping',async()=>{
 const a=await fixture();const {projectFiles,createExports}=await import('./exports.mjs');const selection=await projectFiles(a.project.path,[]);assert.ok(selection.some(f=>f.name===a.asset&&f.file===source));assert.ok(!selection.some(f=>f.name==='assets/.daocut-source-media.json'));
 const exports=createExports();for(const as of ['folder','zip']){const queued=exports.start(a.project,{kind:'project',as,parts:[],name:`logical-${as}`},{folder:process.env.DAOCUT_EXPORTS});let result;for(let i=0;i<200;i++){result=exports.list(a.project.id).find(j=>j.id===queued.id);if(['done','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,20));}assert.equal(result.status,'done',result.error);if(as==='folder'){assert.equal(await hash(join(result.out,a.asset)),sourceHash);await absent(join(result.out,'assets/.daocut-source-media.json'));}else{const zip=await readFile(result.out);assert.ok(zip.includes(Buffer.from(a.asset)));assert.ok(!zip.includes(Buffer.from('.daocut-source-media.json')));}}
});

test('complete backup of a verified local copy preserves that copy and restores offline without symlinks',async()=>{
 const {createProject}=await import('./projects.mjs'),{writeProductAnalysis}=await import('./product-analysis.mjs');const p=await createProject('Local copy backup');await mkdir(join(p.path,'assets'));const asset='assets/copy.mp4';await copyFile(source,join(p.path,asset));await writeProductAnalysis(p.path,{version:1,sources:[{id:'copy-source',assetPath:asset,durationMs:3000}],products:[],intervals:[],candidates:[]});await media.bindSharedMediaCopy({projectRoot:p.path,assetPath:asset,libraryId:'logical-test-library',videoPath:'live/sample.mp4',confirmed:true});
 const backup=join(scratch,'copy-backup');await createProjectBackup(p.path,backup);assert.equal(await hash(join(backup,asset)),sourceHash);const inspection=await inspectProjectBackup(backup),target=join(scratch,'copy-restored');await restoreProjectBackup({confirmed:true,backupPath:backup,expectedBackupId:inspection.backupId,targetPath:target,mappings:[]});assert.equal(await hash(join(target,asset)),sourceHash);assert.equal((await media.resolveSharedMedia(target,asset)).path,join(target,asset));
});
