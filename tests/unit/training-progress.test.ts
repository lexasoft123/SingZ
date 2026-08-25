import { describe,expect,it } from 'vitest'
import { createTrainingCompletionReceipt, defaultTrainingPreferences, deriveTrainingProgress, restoreTrainingCompletionReceipt, restoreTrainingPreferences, restoreTrainingProgress, summarizeTrainingProgress, TRAINING_PROGRESS_HISTORY_LIMIT } from '../../src/shared/training-progress'
import { createTrainingSession,recordTrainingResult,startTrainingSession } from '../../src/shared/training-session'
import type { TrainingSessionData } from '../../src/shared/training-types'

describe('training completion receipts',()=>{
  it('strictly validates preferences, receipts, and derived progress',()=>{
    const receipt=createTrainingCompletionReceipt(completedVocalSession('strict',5,.8,.6),1)
    expect(restoreTrainingCompletionReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
    expect(()=>restoreTrainingCompletionReceipt({...receipt,formatVersion:99})).toThrow(/version/i)
    expect(()=>restoreTrainingCompletionReceipt({...receipt,rawAudio:[]})).toThrow(/unknown|missing/i)
    expect(()=>restoreTrainingCompletionReceipt({...receipt,exercise:'raw-observations'})).toThrow(/exercise/i)
    expect(()=>restoreTrainingPreferences({...defaultTrainingPreferences(),range:{lowMidi:20,highMidi:72}})).toThrow(/note/i)
    const invalid=JSON.parse(JSON.stringify(receipt));invalid.aggregate.stableRatioSum=-1
    expect(()=>restoreTrainingCompletionReceipt(invalid)).toThrow(/ratio/i)
    const inconsistent=JSON.parse(JSON.stringify(receipt));inconsistent.aggregate.attempts++
    expect(()=>restoreTrainingCompletionReceipt(inconsistent)).toThrow(/inconsistent/i)
  })

  it('derives bounded recent UI history but lifetime aggregate from every receipt',()=>{
    const receipts=[]
    for(let i=0;i<TRAINING_PROGRESS_HISTORY_LIMIT+4;i++)receipts.push(createTrainingCompletionReceipt(completedIdentifySession(`history-${i}`,i%2===0),3_000+i))
    const progress=deriveTrainingProgress(defaultTrainingPreferences(),receipts)
    expect(progress.recent).toHaveLength(TRAINING_PROGRESS_HISTORY_LIMIT)
    expect(progress.aggregate.sessions).toBe(TRAINING_PROGRESS_HISTORY_LIMIT+4)
    expect(new Set(progress.recent.map(x=>x.sessionId)).size).toBe(TRAINING_PROGRESS_HISTORY_LIMIT)
    const encoded=JSON.stringify(receipts)
    for(const forbidden of ['observations','rawAudio','microphone','cues','prompts','targets','project.json'])expect(encoded).not.toContain(forbidden)
    expect(restoreTrainingProgress(JSON.parse(JSON.stringify(progress)))).toEqual(progress)
  })

  it('computes vocal metrics and identify outcomes from normalized facts',()=>{
    const progress=deriveTrainingProgress(defaultTrainingPreferences(),[
      createTrainingCompletionReceipt(completedVocalSession('vocal',20,.8,.6),1),
      createTrainingCompletionReceipt(completedIdentifySession('right',true),2),
      createTrainingCompletionReceipt(completedIdentifySession('wrong',false),3)
    ])
    const snapshot=summarizeTrainingProgress(progress)
    expect(snapshot).toMatchObject({sessions:3,attempts:3,tendency:'sharp',averageSignedCents:20,stableRatio:.8,voicedRatio:.6})
    expect(snapshot.landedRate).toBeCloseTo(2/3)
  })

  it('records every distinct interval and arpeggio target degree',()=>{
    for(const exercise of ['interval','arpeggio'] as const){
      const session=completedMultiTargetSession(`degrees-${exercise}`,exercise)
      const receipt=createTrainingCompletionReceipt(session,4)
      const prompt=session.prompts[0]
      const expected=[...new Set(prompt.targets.map(target=>String(target.scaleDegree)))].sort()
      expect(Object.keys(receipt.aggregate.byScaleDegree).sort()).toEqual(expected)
      expect(receipt.aggregate.scaleDegreeOccurrences).toBe(expected.length)
      expect(receipt.aggregate.scaleDegreeOnTargetOccurrences).toBe(expected.length)
      if(exercise==='interval')expect(receipt.aggregate.intervalOccurrences).toBe(1)
      else expect(receipt.aggregate.scaleDegreeOccurrences).toBe(3)
    }
  })

  it('rejects undercounted degree maps and mismatched occurrence outcomes',()=>{
    const receipt=createTrainingCompletionReceipt(completedMultiTargetSession('strict-degrees','interval'),4)
    const undercount=JSON.parse(JSON.stringify(receipt))
    delete undercount.aggregate.byScaleDegree[Object.keys(undercount.aggregate.byScaleDegree)[0]]
    expect(()=>restoreTrainingCompletionReceipt(undercount)).toThrow(/occurrence|degree/i)
    const mismatch=JSON.parse(JSON.stringify(receipt))
    mismatch.aggregate.byScaleDegree[Object.keys(mismatch.aggregate.byScaleDegree)[0]].onTarget=0
    expect(()=>restoreTrainingCompletionReceipt(mismatch)).toThrow(/occurrence/i)
  })

  it('uses the exact concrete target count as the pitch-metric cap',()=>{
    const note=createTrainingCompletionReceipt(completedVocalSession('metric-note',0,1,1),5)
    const inflated=JSON.parse(JSON.stringify(note));inflated.aggregate.stableRatioCount=2;inflated.aggregate.stableRatioSum=1
    expect(()=>restoreTrainingCompletionReceipt(inflated)).toThrow(/metric/i)

    const mixedSession=completedMixedSession('metric-mixed'),mixed=createTrainingCompletionReceipt(mixedSession,6)
    const exact=mixedSession.prompts.reduce((sum,prompt)=>sum+prompt.targets.length,0)
    expect(mixed.aggregate.stableRatioCount).toBe(exact)
    expect(mixed.aggregate.voicedRatioCount).toBe(exact)
    expect(mixed.aggregate.centeredCentsCount).toBe(exact)
    expect(restoreTrainingCompletionReceipt(JSON.parse(JSON.stringify(mixed)))).toEqual(mixed)
  })

  it('rejects pitch metrics in Identify receipts',()=>{
    const receipt=createTrainingCompletionReceipt(completedIdentifySession('identify-metrics',true),7),invalid=JSON.parse(JSON.stringify(receipt))
    invalid.aggregate.centeredCentsCount=1;invalid.aggregate.centeredCentsSum=10
    expect(()=>restoreTrainingCompletionReceipt(invalid)).toThrow(/identify|pitch metric/i)
  })
})

function baseSession(seed:string):TrainingSessionData{return startTrainingSession(createTrainingSession({key:{tonicPc:0,mode:'major'},range:{lowMidi:48,highMidi:72},exercise:'scale-degree',taskMode:'identify',length:1,seed}))}
function completedIdentifySession(seed:string,correct:boolean):TrainingSessionData{const session=baseSession(seed),prompt=session.prompts[0];if(prompt.kind!=='scale-degree')throw new Error('Expected scale degree.');return recordTrainingResult(session,{response:'identify',promptId:prompt.id,answer:{kind:'scale-degree',scaleDegree:correct?prompt.scaleDegree:(prompt.scaleDegree%7)+1},completedAt:100})}
function completedVocalSession(seed:string,cents:number,stable:number,voiced:number):TrainingSessionData{const session=startTrainingSession(createTrainingSession({key:{tonicPc:0,mode:'major'},range:{lowMidi:48,highMidi:72},exercise:'note',taskMode:'find',length:1,seed})),prompt=session.prompts[0];return recordTrainingResult(session,{response:'vocal',promptId:prompt.id,completedAt:100,targets:[{targetIndex:0,classification:'on-target',metrics:{medianCentsError:cents,stableHoldRatio:stable,voicedCoverage:voiced}}]})}
function completedMultiTargetSession(seed:string,exercise:'interval'|'arpeggio'):TrainingSessionData{const session=startTrainingSession(createTrainingSession({key:{tonicPc:0,mode:'major'},range:{lowMidi:36,highMidi:84},exercise,taskMode:'find',length:1,seed,intervalSizes:[3],chordDegrees:[1]})),prompt=session.prompts[0];return recordTrainingResult(session,{response:'vocal',promptId:prompt.id,completedAt:100,targets:prompt.targets.map((_,targetIndex)=>({targetIndex,classification:'on-target',metrics:{}}))})}
function completedMixedSession(seed:string):TrainingSessionData{let session=startTrainingSession(createTrainingSession({key:{tonicPc:0,mode:'major'},range:{lowMidi:36,highMidi:84},exercise:'mixed',mixedKinds:['note','scale-degree','interval','chord-tone','arpeggio'],taskMode:'find',length:5,seed}));while(session.status==='active'){const prompt=session.prompts[session.currentIndex];session=recordTrainingResult(session,{response:'vocal',promptId:prompt.id,completedAt:100,targets:prompt.targets.map((_,targetIndex)=>({targetIndex,classification:'on-target',metrics:{medianCentsError:0,stableHoldRatio:1,voicedCoverage:1}}))})}return session}
