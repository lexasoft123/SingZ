import { describe,expect,it,vi } from 'vitest'
import { defaultTrainingPreferences,emptyTrainingProgress,type TrainingCompletionReceipt,type TrainingPreferences } from '../../src/shared/training-progress'
import { TrainingProgressMutations } from '../../src/renderer/src/training-progress-persistence'

describe('training mutation queue',()=>{
  it('serializes preference mutations and applies authoritative responses in order',async()=>{
    const first=deferred<any>(),calls:number[]=[],seen:number[]=[]
    const api={savePreferences:vi.fn((value:TrainingPreferences)=>{calls.push(value.range.lowMidi);return calls.length===1?first.promise:Promise.resolve({ok:true as const,preferences:value})}),recordCompletion:vi.fn()}
    const queue=new TrainingProgressMutations(api,vi.fn(),p=>seen.push(p.range.lowMidi),vi.fn())
    const p1={...defaultTrainingPreferences(),range:{lowMidi:40,highMidi:72}},p2={...defaultTrainingPreferences(),range:{lowMidi:41,highMidi:72}}
    queue.savePreferences(p1);queue.savePreferences(p2);expect(calls).toEqual([40])
    first.resolve({ok:true,preferences:p1});await tick();expect(calls).toEqual([40,41]);await tick();expect(seen).toEqual([40,41])
  })

  it('records one completion once and starts immediately',async()=>{
    const record=vi.fn(async()=>({ok:true as const,progress:emptyTrainingProgress(),alreadyRecorded:false}))
    const queue=new TrainingProgressMutations({savePreferences:vi.fn(),recordCompletion:record},vi.fn(),vi.fn(),vi.fn())
    const value=receipt('same');queue.recordCompletion(value);queue.recordCompletion(value);expect(record).toHaveBeenCalledTimes(1);await tick();expect(record).toHaveBeenCalledTimes(1)
  })

  it('surfaces failure and retries the retained mutation',async()=>{
    const errors:Array<string|null>=[],save=vi.fn().mockResolvedValueOnce({ok:false,error:'disk full'}).mockResolvedValueOnce({ok:true,preferences:defaultTrainingPreferences()})
    const queue=new TrainingProgressMutations({savePreferences:save,recordCompletion:vi.fn()},vi.fn(),vi.fn(),e=>errors.push(e))
    queue.savePreferences(defaultTrainingPreferences());await tick();expect(errors).toEqual(['disk full']);queue.retry();await tick();expect(save).toHaveBeenCalledTimes(2);expect(errors.at(-1)).toBeNull()
  })

  it('sends completion immediately while a preference is pending or failed',async()=>{
    const pending=deferred<any>(),record=vi.fn(async()=>({ok:true as const,progress:emptyTrainingProgress(),alreadyRecorded:false}))
    const save=vi.fn(()=>pending.promise),queue=new TrainingProgressMutations({savePreferences:save,recordCompletion:record},vi.fn(),vi.fn(),vi.fn())
    queue.savePreferences(defaultTrainingPreferences());queue.recordCompletion(receipt('shutdown'))
    expect(save).toHaveBeenCalledTimes(1);expect(record).toHaveBeenCalledTimes(1)
    pending.resolve({ok:false,error:'training profile unavailable'});await tick();expect(record).toHaveBeenCalledTimes(1)
  })
  it('flushes the latest coalesced preference synchronously at shutdown',()=>{
    const pending=deferred<any>(),saved:number[]=[]
    const queue=new TrainingProgressMutations({savePreferences:()=>pending.promise,recordCompletion:vi.fn()},vi.fn(),vi.fn(),vi.fn())
    const a={...defaultTrainingPreferences(),range:{lowMidi:40,highMidi:70}},b={...defaultTrainingPreferences(),range:{lowMidi:42,highMidi:72}}
    queue.savePreferences(a);queue.savePreferences(b)
    const result=queue.flushPreferencesSync(value=>{saved.push(value.range.lowMidi);return{ok:true,preferences:value}})
    expect(result.ok).toBe(true);expect(saved).toEqual([42])
  })
})
function receipt(sessionId:string):TrainingCompletionReceipt{return{formatVersion:1,sessionId,completedAt:1,key:{tonicPc:0,mode:'major'},exercise:'note',taskMode:'find',aggregate:{sessions:1,attempts:0,onTarget:0,close:0,centeredCentsSum:0,centeredCentsCount:0,stableRatioSum:0,stableRatioCount:0,voicedRatioSum:0,voicedRatioCount:0,scaleDegreeOccurrences:0,scaleDegreeOnTargetOccurrences:0,scaleDegreeCloseOccurrences:0,intervalOccurrences:0,intervalOnTargetOccurrences:0,intervalCloseOccurrences:0,chordRoleOccurrences:0,chordRoleOnTargetOccurrences:0,chordRoleCloseOccurrences:0,byExercise:{},byScaleDegree:{},byInterval:{},byChordRole:{}}}}
function deferred<T>():{promise:Promise<T>;resolve:(value:T)=>void}{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return{promise,resolve}}
async function tick():Promise<void>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
