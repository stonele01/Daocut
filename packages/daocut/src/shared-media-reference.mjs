// @ts-check
/** Read-only logical media references. No writable project-path helper calls this module. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { studioHomeDir } from './locations.mjs';
import { readableLink } from './media-links.mjs';

/** One read-only HTTP operation reuses verified metadata; no TTL or cross-request trust. */
const snapshots = new AsyncLocalStorage();
export async function withMediaReferenceSnapshot(/** @type {() => any} */ work) {
 const cache = new Map();
 try { return await snapshots.run(cache, work); } finally { cache.clear(); }
}
const referenceKey = (/** @type {string} */ root, /** @type {string} */ rel) => JSON.stringify([resolve(root), rel]);
const MANIFEST='assets/.daocut-source-media.json';
const MEDIA=/\.(mp4|mov|mkv|avi|m4v|webm|wmv|flv|ts|mts|m2ts|wav|m4a|mp3|aac|ogg|flac|png|jpe?g|webp)$/i;
/** @type {Map<string,string>} */
const hashes=new Map();
/** @type {Map<string,Promise<string>>} */
const pending=new Map();
const listeners=new Map();
export const SAMPLED_MEDIA_IDENTITY='sampled-sha256-v1';
const BLOCK=1024*1024, SAMPLES=8;
/** @typedef {{bytesRead:number,totalBytes:number,sourceBytes:number,cached:boolean,identityKind:string}} IdentityProgress */
/** @typedef {{identityKind?:string,onProgress?:(value:IdentityProgress)=>void}} IdentityOptions */
const fail=(/** @type {string} */ message)=>Object.assign(new Error(message),{status:409,code:'SHARED_MEDIA_REFERENCE'});
const inside=(/** @type {string} */ root,/** @type {string} */ path)=>{const back=relative(root,path);return !isAbsolute(back)&&back!=='..'&&!back.startsWith(`..${sep}`);};
/** @param {unknown} raw */
function safeRelative(raw){
 if(typeof raw!=='string'||!raw||raw.includes('\\')||raw.includes('\0')||raw.includes(':')||isAbsolute(raw)||raw.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw fail('Invalid logical media path');
 return raw;
}
/** Only explicitly marked entries use the new path; old filesystem links retain their existing checks.
 * @param {string} root @returns {Record<string, any>} */
export function mediaReferences(root){
 let data;try{data=JSON.parse(readFileSync(join(root,MANIFEST),'utf8'));}catch(error){if(/** @type {NodeJS.ErrnoException} */(error).code==='ENOENT')return {};throw fail('Shared media manifest is unreadable');}
 /** @type {Record<string,any>} */
 const out={};for(const [asset,record]of Object.entries(/** @type {Record<string,any>} */(data?.items??{}))){
  if(!['reference','project-reference'].includes(record?.mode))continue;
  if(data.version!==1||safeRelative(asset)!==asset||!asset.startsWith('assets/')||!MEDIA.test(asset)||!record||!(/^[a-z0-9][a-z0-9._-]{7,79}$/i.test(record.libraryId))||!(/^[a-f0-9]{64}$/.test(record.sha256))||!Number.isFinite(record.size)||record.size<0||!Number.isFinite(record.mtimeMs)||record.mtimeMs<0)throw fail('Invalid logical media identity');
  if(record.identityKind!==undefined&&record.identityKind!==SAMPLED_MEDIA_IDENTITY)throw fail('Unsupported media identity');
  safeRelative(record.relativePath);if(!MEDIA.test(record.relativePath))throw fail('Only registered media may be read from a library');
  if(record.mode==='project-reference'&&(!/^[\w-]{6,80}$/.test(record.parentProjectId??'')||safeRelative(record.parentAssetPath)!==record.parentAssetPath||record.parentAssetPath!==asset||record.relativePath!==asset||!MEDIA.test(record.parentAssetPath)))throw fail('Invalid parent-project media identity');
  out[asset]=record;
 }return out;
}
const version=(/** @type {string} */path,/** @type {import('node:fs').Stats} */info)=>JSON.stringify([path,info.size,info.mtimeMs,info.ctimeMs,info.ino]);
const hashKey=(/** @type {string} */path,/** @type {import('node:fs').Stats} */info,/** @type {string|undefined} */kind)=>kind===SAMPLED_MEDIA_IDENTITY?`${kind}:${version(path,info)}`:version(path,info);
function remember(/** @type {string} */key,/** @type {string} */hash){if(hashes.size>=256)hashes.delete(/** @type {string} */(hashes.keys().next().value));hashes.set(key,hash);}
/** Keep verified identities across app restarts; changed file metadata invalidates the record.
 * Full content verification remains the default. Sampled identities are explicitly marked and
 * only identify editing sources; backups and verified copies still check every byte.
 * @param {string} path @param {IdentityOptions} [options] */
export async function mediaContentHash(path,{identityKind,onProgress}={}){
 if(identityKind!==undefined&&identityKind!==SAMPLED_MEDIA_IDENTITY)throw fail('Unsupported media identity');
 const before=await stat(path),key=hashKey(path,before,identityKind),cached=hashes.get(key);
 const sampled=identityKind===SAMPLED_MEDIA_IDENTITY,totalBytes=sampled?Math.min(before.size,BLOCK*SAMPLES):before.size;
 const progress=(/** @type {number} */bytesRead,cached=false)=>({bytesRead,totalBytes,sourceBytes:before.size,cached,identityKind:identityKind??'sha256'});
 if(cached){onProgress?.(progress(totalBytes,true));return cached;}
 if(onProgress){if(!listeners.has(key))listeners.set(key,new Set());listeners.get(key).add(onProgress);onProgress(progress(0));}
 const report=(/** @type {number} */bytes,cached=false)=>{for(const callback of listeners.get(key)??[])callback(progress(bytes,cached));};
 let work=pending.get(key);
 if(!work){
  work=(async()=>{
   const directory=join(studioHomeDir(),'cache','media-identities-v1');
   const file=join(directory,createHash('sha256').update(key).digest('hex')+'.json');
   let saved;
   try{saved=JSON.parse(await readFile(file,'utf8'));}catch{/* Missing or incomplete cache falls back to a full read. */}
   if(saved?.version===1&&saved.key===key&&/^[a-f0-9]{64}$/.test(saved.sha256??'')){
    if(hashKey(path,await stat(path),identityKind)!==key)throw fail('Shared media changed during identity verification');
    remember(key,saved.sha256);report(totalBytes,true);return saved.sha256;
   }
   const h=createHash('sha256');let bytes=0;
   if(sampled){
    h.update(`${SAMPLED_MEDIA_IDENTITY}\0${before.size}\0`);
    const file=await open(path,'r');
    try{
     const count=before.size>BLOCK*SAMPLES?SAMPLES:1,length=count===1?before.size:BLOCK,buffer=Buffer.alloc(length);
     for(let index=0;index<count;index++){
      const position=count===1?0:Math.floor((before.size-BLOCK)*index/(count-1));
      let offset=0;
      while(offset<length){const result=await file.read(buffer,offset,length-offset,position+offset);if(!result.bytesRead)throw fail('Shared media changed during identity verification');offset+=result.bytesRead;}
      h.update(buffer);bytes+=length;report(bytes);
     }
    }finally{await file.close();}
   }else for await(const part of createReadStream(path,{highWaterMark:BLOCK})){h.update(part);bytes+=part.length;report(bytes);}
   if(hashKey(path,await stat(path),identityKind)!==key)throw fail('Shared media changed during identity verification');
   const sha=h.digest('hex');remember(key,sha);
   try{await mkdir(directory,{recursive:true});await writeFile(file,JSON.stringify({version:1,key,sha256:sha}));}catch{/* A cache write failure must not prevent using the verified original. */}
   return sha;
  })();
  pending.set(key,work);void work.finally(()=>pending.delete(key)).catch(()=>{});
 }
 try{return await work;}finally{if(onProgress){listeners.get(key)?.delete(onProgress);if(!listeners.get(key)?.size)listeners.delete(key);}}
}
/** New editing references read at most eight MiB, independent of the original's size.
 * Existing unmarked references retain their full SHA-256 identity and shared analysis keys.
 * @param {string} path @param {IdentityOptions} [options] */
export async function mediaEditingIdentity(path,options={}){
 const identityKind=(await stat(path)).size>BLOCK*SAMPLES?SAMPLED_MEDIA_IDENTITY:undefined;
 return {...(identityKind?{identityKind}:{}),sha256:await mediaContentHash(path,{...options,identityKind})};
}
/** Locate a registered reference without following unregistered paths.
 * @param {string} root @param {string} rel @returns {{path:string,info:import('node:fs').Stats,reference:any}|null} */
function candidate(root,rel){
 const cached=snapshots.getStore()?.get(referenceKey(root,rel));if(cached)return cached;
 const records=mediaReferences(root),record=records[rel];if(!record)return null;
 if(record.mode==='project-reference'){
  const home=realpathSync.native(resolve(root,'../../..'));
  const meta=JSON.parse(readFileSync(join(root,'.film/structure-draft.json'),'utf8'));
  if(!/^[a-f0-9]{24}$/.test(meta?.draftId??'')||meta.draftId!==basename(root)||resolve(root)!==join(home,'.film','structure-drafts',meta.draftId)||meta.parentRelative!=='../../..'||meta.parentProjectId!==record.parentProjectId||readFileSync(join(home,'.film/id'),'utf8').trim()!==record.parentProjectId)throw fail('Parent project identity or draft location changed');
  const asked=resolve(home,...record.parentAssetPath.split('/'));
  if(!inside(join(home,'assets'),asked))throw fail('Parent media must stay inside assets');
  const path=realpathSync.native(asked);
  if(!inside(join(home,'assets'),path)&&!readableLink(home,asked))throw fail('Parent media is not an authorized project asset');
  if(existsSync(join(root,...rel.split('/'))))throw fail('Logical media reference conflicts with an existing project file');
  const info=statSync(path);if(!info.isFile()||info.size!==record.size||Math.abs(info.mtimeMs-record.mtimeMs)>2000)throw fail('Parent media changed and needs confirmation');
  return {path,info,reference:record};
 }
 const prefs=JSON.parse(readFileSync(join(studioHomeDir(),'prefs.json'),'utf8'));
 const library=prefs?.sharedMediaLibraries?.find((/** @type {any} */l)=>l.id===record.libraryId&&typeof l.root==='string'&&isAbsolute(l.root));if(!library)throw fail('Configure this material library on this computer first.');
 const home=realpathSync.native(library.root),asked=resolve(home,...record.relativePath.split('/'));
 if(!inside(home,asked))throw fail('Shared media must stay inside its library');const path=realpathSync.native(asked);if(!inside(home,path))throw fail('Shared media must stay inside its library');
 if(existsSync(join(root,...rel.split('/'))))throw fail('Logical media reference conflicts with an existing project file');
 const info=statSync(path);if(!info.isFile()||info.size!==record.size||Math.abs(info.mtimeMs-record.mtimeMs)>2000)throw fail('Shared media changed and needs confirmation');
 return {path,info,reference:record};
}
async function candidateAsync(/** @type {string} */ root,/** @type {string} */ rel){
 const records=mediaReferences(root),record=records[rel];if(!record)return null;
 if(record.mode==='project-reference'){
  const home=await realpath(resolve(root,'../../..'));
  const meta=JSON.parse(readFileSync(join(root,'.film/structure-draft.json'),'utf8'));
  if(!/^[a-f0-9]{24}$/.test(meta?.draftId??'')||meta.draftId!==basename(root)||resolve(root)!==join(home,'.film','structure-drafts',meta.draftId)||meta.parentRelative!=='../../..'||meta.parentProjectId!==record.parentProjectId||readFileSync(join(home,'.film/id'),'utf8').trim()!==record.parentProjectId)throw fail('Parent project identity or draft location changed');
  const asked=resolve(home,...record.parentAssetPath.split('/'));
  if(!inside(join(home,'assets'),asked))throw fail('Parent media must stay inside assets');
  const path=await realpath(asked);
  if(!inside(join(home,'assets'),path)&&!readableLink(home,asked))throw fail('Parent media is not an authorized project asset');
  if(existsSync(join(root,...rel.split('/'))))throw fail('Logical media reference conflicts with an existing project file');
  const info=await stat(path);if(!info.isFile()||info.size!==record.size||Math.abs(info.mtimeMs-record.mtimeMs)>2000)throw fail('Parent media changed and needs confirmation');
  return {path,info,reference:record};
 }
 const prefs=JSON.parse(readFileSync(join(studioHomeDir(),'prefs.json'),'utf8'));
 const library=prefs?.sharedMediaLibraries?.find((/** @type {any} */l)=>l.id===record.libraryId&&typeof l.root==='string'&&isAbsolute(l.root));if(!library)throw fail('Configure this material library on this computer first.');
 const home=await realpath(library.root),asked=resolve(home,...record.relativePath.split('/'));
 if(!inside(home,asked))throw fail('Shared media must stay inside its library');const path=await realpath(asked);if(!inside(home,path))throw fail('Shared media must stay inside its library');
 if(existsSync(join(root,...rel.split('/'))))throw fail('Logical media reference conflicts with an existing project file');
 const info=await stat(path);if(!info.isFile()||info.size!==record.size||Math.abs(info.mtimeMs-record.mtimeMs)>2000)throw fail('Shared media changed and needs confirmation');
 return {path,info,reference:record};
}

/** Synchronous consumers only use identities already checked by their asynchronous entry points.
 * @param {string} root @param {string} rel */
export function resolveMediaReference(root,rel){
 const result=candidate(root,rel);if(!result)return null;
 const sha=hashes.get(hashKey(result.path,result.info,result.reference.identityKind));
 if(!sha)throw Object.assign(fail('Shared media identity needs asynchronous verification'),{code:'SHARED_MEDIA_UNVERIFIED'});
 if(sha!==result.reference.sha256)throw fail('Shared media content changed and needs confirmation');
 return result;
}

/** Capture reference metadata without reading the whole original. Callers must verify the captured
 * SHA-256 before using its bytes; this does not replace resolveMediaReference's verified read boundary.
 * @param {string} root @param {string} rel */
export function inspectMediaReference(root,rel){return candidate(root,rel);}

/** Prepare one requested source, or all references before a render. Concurrent checks share one stream.
 * @param {string} root @param {string} [rel] */
export async function prepareMediaReferences(root,rel){
 for(const asset of rel===undefined?Object.keys(mediaReferences(root)):[rel]){
  const key=referenceKey(root,asset),cache=snapshots.getStore();if(cache?.has(key))continue;
  const result=await candidateAsync(root,asset);if(!result)continue;
  if(await mediaContentHash(result.path,{identityKind:result.reference.identityKind})!==result.reference.sha256)throw fail('Shared media content changed and needs confirmation');
  cache?.set(key,result);
 }
}

/** The safe project URL for a render's browser codec check.
 * @param {string} root @param {string} file */
export function mediaReferenceAsset(root,file){
 for(const asset of Object.keys(mediaReferences(root))){if(resolveMediaReference(root,asset)?.path===file)return asset;}return null;
}
