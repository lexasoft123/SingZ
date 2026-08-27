import { closeSync,existsSync,fsyncSync,linkSync,mkdirSync,mkdtempSync,openSync,opendirSync,readFileSync,rmSync,statSync,unlinkSync,writeFileSync,writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { defaultTrainingPreferences,TRAINING_RECEIPT_MAX_BYTES,type TrainingCompletionReceipt } from '../../src/shared/training-progress'
import { loadTrainingProgressFrom,receiptName,recordTrainingReceipt,type ReceiptStoreOps } from '../../src/main/training-progress'

const dirs:string[]=[]
const ops:ReceiptStoreOps={closeSync,fsyncSync,linkSync,mkdirSync,openSync,opendirSync,readFileSync,statSync,unlinkSync,writeSync}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
describe('main-owned training receipt store',()=>{
  it('merges two stale processes and keeps lifetime dedupe beyond recent history',()=>{
    const dir=fixture();const a=receipt('A',1),b=receipt('B',2)
    expect(recordTrainingReceipt(dir,a)).toBe(false)
    expect(recordTrainingReceipt(dir,b)).toBe(false)
    for(let i=0;i<1_001;i++)recordTrainingReceipt(dir,receipt(`later-${i}`,10+i))
    const before=loadTrainingProgressFrom(dir,defaultTrainingPreferences())
    expect(before.aggregate.sessions).toBe(1_003);expect(before.recent).toHaveLength(100)
    expect(recordTrainingReceipt(dir,a)).toBe(true)
    expect(loadTrainingProgressFrom(dir,defaultTrainingPreferences())).toEqual(before)
  })

  it('recovers when the receipt lands but the first response fails',()=>{
    const dir=fixture(),value=receipt('crash',1)
    expect(()=>recordTrainingReceipt(dir,value,{afterCommit:()=>{throw new Error('response lost')}})).toThrow(/response lost/)
    expect(recordTrainingReceipt(dir,value)).toBe(true)
    expect(loadTrainingProgressFrom(dir,defaultTrainingPreferences()).aggregate.sessions).toBe(1)
  })

  it('rejects a same-session receipt with different normalized facts',()=>{
    const dir=fixture(),original=receipt('collision',1),different=receipt('collision',2)
    expect(recordTrainingReceipt(dir,original)).toBe(false)
    expect(()=>recordTrainingReceipt(dir,different)).toThrow(/collision/i)
    expect(loadTrainingProgressFrom(dir,defaultTrainingPreferences()).recent[0].completedAt).toBe(1)
  })

  it('fully commits short writes and leaves no final receipt after zero progress',()=>{
    const dir=fixture(),value=receipt('short-write',1)
    const chunked:ReceiptStoreOps={...ops,writeSync:(fd,buffer,offset,length)=>writeSync(fd,buffer,offset,Math.min(5,length))}
    expect(recordTrainingReceipt(dir,value,{ops:chunked,nonce:'chunked'})).toBe(false)
    expect(JSON.parse(readFileSync(join(dir,receiptName(value.sessionId)),'utf8'))).toEqual(value)
    const failed=receipt('zero-write',2),zero:ReceiptStoreOps={...ops,writeSync:()=>0}
    expect(()=>recordTrainingReceipt(dir,failed,{ops:zero,nonce:'zero'})).toThrow(/progress/i)
    expect(existsSync(join(dir,receiptName(failed.sessionId)))).toBe(false)
  })

  it('reports malformed, oversized, and filename-mismatched receipts',()=>{
    const malformed=fixture();writeFileSync(join(malformed,receiptName('bad')),'{"nope":true}')
    expect(()=>loadTrainingProgressFrom(malformed,defaultTrainingPreferences())).toThrow(/invalid/i)
    const oversized=fixture();writeFileSync(join(oversized,receiptName('large')),'x'.repeat(TRAINING_RECEIPT_MAX_BYTES+1))
    expect(()=>loadTrainingProgressFrom(oversized,defaultTrainingPreferences())).toThrow(/too large/i)
    const mismatch=fixture();writeFileSync(join(mismatch,receiptName('wrong')),JSON.stringify(receipt('other',1)))
    expect(()=>loadTrainingProgressFrom(mismatch,defaultTrainingPreferences())).toThrow(/session id/i)
  })

  it('rejects inflated and exercise-inconsistent receipt counters',()=>{
    const inflated=JSON.parse(JSON.stringify(receipt('inflated',1)));inflated.aggregate.byScaleDegree['1'].attempts=2;inflated.aggregate.scaleDegreeOccurrences=2
    expect(()=>recordTrainingReceipt(fixture(),inflated)).toThrow(/occurrence|exceeds/i)
    const mismatch=JSON.parse(JSON.stringify(receipt('exercise',1)));mismatch.exercise='interval'
    expect(()=>recordTrainingReceipt(fixture(),mismatch)).toThrow(/exercise/i)
  })
})
function fixture():string{const dir=mkdtempSync(join(tmpdir(),'singz-receipts-'));dirs.push(dir);return dir}
function receipt(sessionId:string,completedAt:number):TrainingCompletionReceipt{return{formatVersion:1,sessionId,completedAt,key:{tonicPc:0,mode:'major'},exercise:'note',taskMode:'find',aggregate:{sessions:1,attempts:1,onTarget:1,close:0,centeredCentsSum:0,centeredCentsCount:0,stableRatioSum:0,stableRatioCount:0,voicedRatioSum:0,voicedRatioCount:0,scaleDegreeOccurrences:1,scaleDegreeOnTargetOccurrences:1,scaleDegreeCloseOccurrences:0,intervalOccurrences:0,intervalOnTargetOccurrences:0,intervalCloseOccurrences:0,chordRoleOccurrences:0,chordRoleOnTargetOccurrences:0,chordRoleCloseOccurrences:0,byExercise:{note:{attempts:1,onTarget:1,close:0}},byScaleDegree:{'1':{attempts:1,onTarget:1,close:0}},byInterval:{},byChordRole:{}}}}
