// @ts-check
/** Read-only logical media references. No writable project-path helper calls this module. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { studioHomeDir } from './locations.mjs';
import { readableLink } from './media-links.mjs';

const MANIFEST='assets/.daocut-source-media.json';
const MEDIA=/\.(mp4|mov|mkv|avi|m4v|webm|wmv|flv|ts|mts|m2ts|wav|m4a|mp3|aac|ogg|flac|png|jpe?g|webp)$/i;
/** @type {Map<string,string>} */
const hashes=new Map();
/** @type {Map<string,Promise<string>>} */
const pending=new Map();
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
  safeRelative(record.relativePath);if(!MEDIA.test(record.relativePath))throw fail('Only registered media may be read from a library');
  if(record.mode==='project-reference'&&(!/^[\w-]{6,80}$/.test(record.parentProjectId??'')||safeRelative(record.parentAssetPath)!==record.parentAssetPath||record.parentAssetPath!==asset||record.relativePath!==asset||!MEDIA.test(record.parentAssetPath)))throw fail('Invalid parent-project media identity');
  out[asset]=record;
 }return out;
}
const version=(/** @type {string} */path,/** @type {import('node:fs').Stats} */info)=>JSON.stringify([path,info.size,info.mtimeMs,info.ctimeMs,info.ino]);
function remember(/** @type {string} */key,/** @type {string} */hash){if(hashes.size>=256)hashes.delete(/** @type {string} */(hashes.keys().next().value));hashes.set(key,hash);}
/** Stream once when registering/validating; regular media reads reuse the unchanged file identity.
 * @param {string} path */
export async function mediaContentHash(path){const before=statSync(path),key=version(path,before),cached=hashes.get(key);if(cached)return cached;let work=pending.get(key);if(!work){work=(async()=>{const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);if(version(path,statSync(path))!==key)throw fail('Shared media changed during identity verification');const sha=h.digest('hex');remember(key,sha);return sha;})();pending.set(key,work);void work.finally(()=>pending.delete(key)).catch(()=>{});}return work;}
/** Locate a registered reference without following unregistered paths.
 * @param {string} root @param {string} rel @returns {{path:string,info:import('node:fs').Stats,reference:any}|null} */
function candidate(root,rel){
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

/** Synchronous consumers only use identities already checked by their asynchronous entry points.
 * @param {string} root @param {string} rel */
export function resolveMediaReference(root,rel){
 const result=candidate(root,rel);if(!result)return null;
 const sha=hashes.get(version(result.path,result.info));
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
 for(const asset of rel===undefined?Object.keys(mediaReferences(root)):[rel]){const result=candidate(root,asset);if(!result)continue;await mediaContentHash(result.path);resolveMediaReference(root,asset);}
}

/** The safe project URL for a render's browser codec check.
 * @param {string} root @param {string} file */
export function mediaReferenceAsset(root,file){
 for(const asset of Object.keys(mediaReferences(root))){if(resolveMediaReference(root,asset)?.path===file)return asset;}return null;
}
