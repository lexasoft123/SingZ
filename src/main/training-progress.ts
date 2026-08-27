import { createHash, randomBytes } from 'node:crypto'
import { app } from 'electron'
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { defaultTrainingPreferences, deriveTrainingProgress, restoreTrainingCompletionReceipt, restoreTrainingPreferences, TRAINING_RECEIPT_MAX_BYTES, type TrainingCompletionReceipt, type TrainingPreferences, type TrainingProgress } from '../shared/training-progress'
import { fsyncDirectorySync, writeAllSync } from './atomic-file'

export type TrainingLoadResult={ok:true;progress:TrainingProgress}|{ok:false;error:string}
export type TrainingRecordResult={ok:true;progress:TrainingProgress;alreadyRecorded:boolean}|{ok:false;error:string}
export type TrainingPreferenceSaveResult={ok:true;preferences:TrainingPreferences}|{ok:false;error:string}
export interface ReceiptStoreOps { mkdirSync:typeof mkdirSync; opendirSync:typeof opendirSync; statSync:typeof statSync; readFileSync:typeof readFileSync; openSync:typeof openSync; writeSync:typeof writeSync; fsyncSync:typeof fsyncSync; closeSync:typeof closeSync; linkSync:typeof linkSync; unlinkSync:typeof unlinkSync }
const OPS:ReceiptStoreOps={mkdirSync,opendirSync,statSync,readFileSync,openSync,writeSync,fsyncSync,closeSync,linkSync,unlinkSync}

export const TRAINING_PREFERENCES_STORE_FORMAT_VERSION=1
export const TRAINING_PREFERENCES_MAX_BYTES=16*1024
export const TRAINING_PREFERENCES_TEMP_STALE_MS=24*60*60*1000
interface TrainingPreferencesDocument{formatVersion:typeof TRAINING_PREFERENCES_STORE_FORMAT_VERSION;preferences:TrainingPreferences}
export type TrainingPreferencesReadResult={ok:true;preferences:TrainingPreferences;exists:boolean}|{ok:false;error:string}
export interface TrainingPreferenceStoreOps{closeSync:typeof closeSync;fsyncSync:typeof fsyncSync;mkdirSync:typeof mkdirSync;openSync:typeof openSync;readFileSync:typeof readFileSync;readdirSync:typeof readdirSync;renameSync:typeof renameSync;statSync:typeof statSync;unlinkSync:typeof unlinkSync;writeSync:typeof writeSync}
const PREFERENCE_OPS:TrainingPreferenceStoreOps={closeSync,fsyncSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,statSync,unlinkSync,writeSync}
interface PreferenceStoreOptions{ops?:TrainingPreferenceStoreOps;nonce?:string}
const PREFERENCE_TEMP_NONCE=/^[a-f0-9]{32}$/

function preferencesFile():string{return join(app.getPath('userData'),'training-preferences.json')}
function receiptsDir():string{return join(app.getPath('userData'),'training-receipts')}
export function loadTrainingProgress():TrainingLoadResult{
  const stored=readTrainingPreferencesFile(preferencesFile());if(!stored.ok)return{ok:false,error:`Could not read training preferences: ${stored.error}`}
  try{return{ok:true,progress:loadTrainingProgressFrom(receiptsDir(),stored.preferences)}}
  catch(error){return{ok:false,error:message(error)}}
}
export function saveTrainingPreferences(raw:unknown):TrainingPreferenceSaveResult{
  return saveTrainingPreferencesFile(preferencesFile(),raw)
}
export function recordTrainingCompletion(raw:unknown):TrainingRecordResult{
  try{
    const receipt=restoreTrainingCompletionReceipt(raw)
    const alreadyRecorded=recordTrainingReceipt(receiptsDir(),receipt)
    const loaded=loadTrainingProgress();if(!loaded.ok)return loaded
    return{ok:true,progress:loaded.progress,alreadyRecorded}
  }catch(error){return{ok:false,error:message(error)}}
}

/** A dedicated training-only profile document. Missing means defaults; any
 * malformed existing bytes are reported and never replaced by a save. */
export function readTrainingPreferencesFile(file:string,ops:TrainingPreferenceStoreOps=PREFERENCE_OPS):TrainingPreferencesReadResult{
  try{
    const size=ops.statSync(file).size
    if(size<=0||size>TRAINING_PREFERENCES_MAX_BYTES)throw new Error('Training preferences are empty or too large.')
    const raw=JSON.parse(ops.readFileSync(file,'utf8')) as unknown
    const document=restorePreferencesDocument(raw)
    return{ok:true,preferences:document.preferences,exists:true}
  }catch(error){
    if(isMissing(error))return{ok:true,preferences:defaultTrainingPreferences(),exists:false}
    return{ok:false,error:message(error)}
  }
}

/** Preferences are a complete strict snapshot, so no cross-process merge or
 * lock is needed. Each writer publishes an fsynced private temp with one
 * atomic replace; concurrent writers can only leave one complete snapshot. */
export function saveTrainingPreferencesFile(file:string,raw:unknown,options:PreferenceStoreOptions={}):TrainingPreferenceSaveResult{
  let preferences:TrainingPreferences
  try{preferences=restoreTrainingPreferences(raw)}catch(error){return{ok:false,error:message(error)}}
  const ops=options.ops??PREFERENCE_OPS,nonce=options.nonce??randomBytes(16).toString('hex')
  const parent=dirname(file),temporary=`${file}.${nonce}.tmp`
  try{
    if(!PREFERENCE_TEMP_NONCE.test(nonce))throw new RangeError('Training preference temporary identity is invalid.')
    ops.mkdirSync(parent,{recursive:true});sweepPreferenceTemps(file,ops)
    const current=readTrainingPreferencesFile(file,ops)
    if(!current.ok)throw new Error(`Could not read existing training preferences: ${current.error}`)
    const document:TrainingPreferencesDocument={formatVersion:TRAINING_PREFERENCES_STORE_FORMAT_VERSION,preferences}
    const bytes=Buffer.from(JSON.stringify(document,null,2))
    if(bytes.byteLength>TRAINING_PREFERENCES_MAX_BYTES)throw new Error('Training preferences are too large.')
    let fd:number|undefined
    try{fd=ops.openSync(temporary,'wx',0o600);writeAllSync(fd,bytes,(handle,buffer,offset,length)=>ops.writeSync(handle,buffer,offset,length));ops.fsyncSync(fd)}
    finally{if(fd!==undefined)ops.closeSync(fd)}
    ops.renameSync(temporary,file);fsyncDirectorySync(parent,ops)
    return{ok:true,preferences}
  }catch(error){return{ok:false,error:message(error)}}finally{
    try{ops.unlinkSync(temporary)}catch(error){if(!isMissing(error)){/* own temp cleanup is best effort */}}
  }
}

function restorePreferencesDocument(raw:unknown):TrainingPreferencesDocument{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RangeError('Training preference file is invalid.')
  const value=raw as Record<string,unknown>,keys=Object.keys(value)
  if(keys.length!==2||!keys.includes('formatVersion')||!keys.includes('preferences'))throw new RangeError('Training preference file has unknown or missing fields.')
  if(value.formatVersion!==TRAINING_PREFERENCES_STORE_FORMAT_VERSION)throw new RangeError('Unsupported training preference file version.')
  return{formatVersion:TRAINING_PREFERENCES_STORE_FORMAT_VERSION,preferences:restoreTrainingPreferences(value.preferences)}
}

function sweepPreferenceTemps(file:string,ops:TrainingPreferenceStoreOps):void{
  const parent=dirname(file),base=escapeRegex(basename(file))
  let names:string[];try{names=ops.readdirSync(parent) as string[]}catch{return}
  const temporary=new RegExp(`^${base}\\.[a-f0-9]{32}\\.tmp$`),now=Date.now()
  for(const name of names){
    if(!temporary.test(name))continue
    const path=join(parent,name)
    let mtimeMs:number;try{mtimeMs=ops.statSync(path).mtimeMs}catch{continue}
    if(!Number.isFinite(mtimeMs)||now-mtimeMs<TRAINING_PREFERENCES_TEMP_STALE_MS)continue
    try{ops.unlinkSync(path)}catch{/* orphan cleanup is best effort */}
  }
}
function validPid(value:unknown):value is number{return Number.isInteger(value)&&(value as number)>=1&&(value as number)<=0x7fffffff}
function pidIsAlive(pid:number):boolean{if(!validPid(pid))return false;try{process.kill(pid,0);return true}catch(error){const code=(error as NodeJS.ErrnoException).code;return code!=='ESRCH'&&code!=='ERR_INVALID_ARG_TYPE'&&code!=='ERR_OUT_OF_RANGE'}}
function escapeRegex(value:string):string{return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}

export function loadTrainingProgressFrom(dir:string,preferences:TrainingPreferences,ops:ReceiptStoreOps=OPS):TrainingProgress{
  const profile=restoreTrainingPreferences(preferences)
  try{ops.mkdirSync(dir,{recursive:true})}catch(error){throw new Error(`Could not open training history: ${message(error)}`)}
  sweepDeadTemps(dir,ops)
  function* receipts():Generator<TrainingCompletionReceipt>{
    const directory=ops.opendirSync(dir)
    try{for(let entry=directory.readSync();entry;entry=directory.readSync()){
      const name=entry.name
      if(name.startsWith('.tmp-'))continue
      if(!/^[a-f0-9]{64}\.json$/.test(name))throw new Error(`Training history contains an invalid receipt filename: ${name}`)
      const file=join(dir,name),size=ops.statSync(file).size
      if(size<=0||size>TRAINING_RECEIPT_MAX_BYTES)throw new Error(`Training receipt ${name} is empty or too large.`)
      let receipt:TrainingCompletionReceipt
      try{receipt=restoreTrainingCompletionReceipt(JSON.parse(ops.readFileSync(file,'utf8')))}catch(error){throw new Error(`Training receipt ${name} is invalid: ${message(error)}`)}
      if(receiptName(receipt.sessionId)!==name)throw new Error(`Training receipt ${name} does not match its session id.`)
      yield receipt
    }}finally{directory.closeSync()}
  }
  return deriveTrainingProgress(profile,receipts())
}

/** Writes and fsyncs a private temp, then hard-links it to the exclusive final
 * name. The link is an atomic no-overwrite commit across processes. */
export function recordTrainingReceipt(dir:string,raw:unknown,options:{ops?:ReceiptStoreOps;pid?:number;nonce?:string;afterCommit?:()=>void}={}):boolean{
  const ops=options.ops??OPS,receipt=restoreTrainingCompletionReceipt(raw),json=JSON.stringify(receipt),bytes=Buffer.from(json)
  if(Buffer.byteLength(json)>TRAINING_RECEIPT_MAX_BYTES)throw new RangeError('Training receipt is too large.')
  ops.mkdirSync(dir,{recursive:true})
  const final=join(dir,receiptName(receipt.sessionId)),pid=options.pid??process.pid,nonce=options.nonce??randomBytes(8).toString('hex')
  const temporary=join(dir,`.tmp-${pid}-${nonce}`);let fd:number|undefined,committed=false
  try{
    fd=ops.openSync(temporary,'wx',0o600);writeAllSync(fd,bytes,(handle,buffer,offset,length)=>ops.writeSync(handle,buffer,offset,length));ops.fsyncSync(fd);ops.closeSync(fd);fd=undefined
    try{ops.linkSync(temporary,final);committed=true;fsyncDirectorySync(dir,ops)}catch(error){
      if(!isAlreadyExists(error))throw error
      const existing=readReceiptFile(final,ops)
      if(JSON.stringify(existing)!==json)throw new Error(`Training session receipt collision for ${receipt.sessionId}.`)
    }
    if(committed)options.afterCommit?.()
    return !committed
  }finally{
    if(fd!==undefined)try{ops.closeSync(fd)}catch{/* best effort */}
    try{ops.unlinkSync(temporary)}catch(error){if(!isMissing(error))throw error}
  }
}

function readReceiptFile(file:string,ops:ReceiptStoreOps):TrainingCompletionReceipt{
  const size=ops.statSync(file).size;if(size<=0||size>TRAINING_RECEIPT_MAX_BYTES)throw new Error('Existing training receipt is empty or too large.')
  try{return restoreTrainingCompletionReceipt(JSON.parse(ops.readFileSync(file,'utf8')))}catch(error){throw new Error(`Existing training receipt is invalid: ${message(error)}`)}
}

export function receiptName(sessionId:string):string{return`${createHash('sha256').update(sessionId).digest('hex')}.json`}
function sweepDeadTemps(dir:string,ops:ReceiptStoreOps):void{
  const directory=ops.opendirSync(dir)
  try{for(let entry=directory.readSync();entry;entry=directory.readSync()){
    const name=entry.name
    const match=/^\.tmp-(\d+)-[a-zA-Z0-9_-]+$/.exec(name);if(!match)continue
    const pid=Number(match[1]);if(pidIsAlive(pid))continue
    try{ops.unlinkSync(join(dir,name))}catch{/* orphan cleanup is best effort */}
  }}finally{directory.closeSync()}
}
function isAlreadyExists(error:unknown):boolean{return(error as NodeJS.ErrnoException)?.code==='EEXIST'}
function isMissing(error:unknown):boolean{return(error as NodeJS.ErrnoException)?.code==='ENOENT'}
function message(error:unknown):string{return error instanceof Error?error.message:String(error)}
