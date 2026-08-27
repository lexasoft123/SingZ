import type { ChordToneRole, TrainingDirectionChoice, TrainingExerciseKind, TrainingExerciseSelection, TrainingRange, TrainingSessionData, TrainingTaskMode } from './training-types'

export const TRAINING_PROGRESS_FORMAT_VERSION = 1
export const TRAINING_PREFERENCES_FORMAT_VERSION = 2
export const TRAINING_RECEIPT_FORMAT_VERSION = 1
export const TRAINING_PROGRESS_HISTORY_LIMIT = 100
export const TRAINING_RECEIPT_MAX_BYTES = 16 * 1024

export type TrainingNotationPreference = 'note-names' | 'scale-degrees' | 'movable-do'
export interface TrainingPreferences { readonly formatVersion: typeof TRAINING_PREFERENCES_FORMAT_VERSION; readonly tonicPc: number; readonly keyMode: 'major' | 'minor'; readonly exercise: TrainingExerciseSelection; readonly length: number; readonly range: TrainingRange; readonly notation: TrainingNotationPreference; readonly taskMode: TrainingTaskMode; readonly direction: TrainingDirectionChoice; readonly intervalSizes: readonly number[]; readonly chordDegrees: readonly number[] }
export interface TrainingOutcomeCounter { readonly attempts: number; readonly onTarget: number; readonly close: number }
export interface TrainingProgressAggregate {
  readonly sessions: number; readonly attempts: number; readonly onTarget: number; readonly close: number
  readonly centeredCentsSum: number; readonly centeredCentsCount: number; readonly stableRatioSum: number; readonly stableRatioCount: number; readonly voicedRatioSum: number; readonly voicedRatioCount: number
  readonly scaleDegreeOccurrences:number; readonly scaleDegreeOnTargetOccurrences:number; readonly scaleDegreeCloseOccurrences:number
  readonly intervalOccurrences:number; readonly intervalOnTargetOccurrences:number; readonly intervalCloseOccurrences:number
  readonly chordRoleOccurrences:number; readonly chordRoleOnTargetOccurrences:number; readonly chordRoleCloseOccurrences:number
  readonly byExercise: Readonly<Partial<Record<TrainingExerciseKind, TrainingOutcomeCounter>>>
  readonly byScaleDegree: Readonly<Record<string, TrainingOutcomeCounter>>
  readonly byInterval: Readonly<Record<string, TrainingOutcomeCounter>>
  readonly byChordRole: Readonly<Partial<Record<ChordToneRole, TrainingOutcomeCounter>>>
}
export interface TrainingRecentSession { readonly sessionId: string; readonly completedAt: number; readonly key: { readonly tonicPc: number; readonly mode: 'major' | 'minor' }; readonly exercise: TrainingExerciseSelection; readonly taskMode: TrainingTaskMode; readonly attempts: number; readonly onTarget: number; readonly close: number; readonly averageCenteredCents: number | null; readonly stableRatio: number | null; readonly voicedRatio: number | null }
/** Bounded normalized completion facts only. Receipt files are the lifetime dedupe ledger. */
export interface TrainingCompletionReceipt { readonly formatVersion: typeof TRAINING_RECEIPT_FORMAT_VERSION; readonly sessionId: string; readonly completedAt: number; readonly key: { readonly tonicPc: number; readonly mode: 'major' | 'minor' }; readonly exercise: TrainingExerciseSelection; readonly taskMode: TrainingTaskMode; readonly aggregate: TrainingProgressAggregate }
export interface TrainingProgress { readonly formatVersion: typeof TRAINING_PROGRESS_FORMAT_VERSION; readonly profile: TrainingPreferences; readonly recent: readonly TrainingRecentSession[]; readonly aggregate: TrainingProgressAggregate }
export interface TrainingProgressSnapshot { readonly sessions: number; readonly attempts: number; readonly landedRate: number | null; readonly tendency: 'sharp' | 'flat' | 'centered' | 'not-enough-pitch'; readonly averageSignedCents: number | null; readonly stableRatio: number | null; readonly voicedRatio: number | null; readonly weakerExercises: readonly string[]; readonly weakerScaleDegrees: readonly string[]; readonly weakerIntervals: readonly string[]; readonly weakerChordRoles: readonly string[] }

export function defaultTrainingPreferences(): TrainingPreferences { return { formatVersion:TRAINING_PREFERENCES_FORMAT_VERSION, tonicPc:0, keyMode:'major', exercise:'note', length:20, range: { lowMidi: 48, highMidi: 72 }, notation: 'note-names', taskMode: 'imitate', direction: 'both', intervalSizes: [2,3,4,5,6,7,8], chordDegrees: [1,2,3,4,5,6,7] } }
export function emptyTrainingProgress(profile = defaultTrainingPreferences()): TrainingProgress { return { formatVersion: TRAINING_PROGRESS_FORMAT_VERSION, profile: clonePreferences(profile), recent: [], aggregate: emptyAggregate() } }

export function restoreTrainingPreferences(raw: unknown): TrainingPreferences {
  const v = object(raw, 'Training preferences')
  const legacy=v.formatVersion===1
  if(!legacy&&v.formatVersion!==TRAINING_PREFERENCES_FORMAT_VERSION)throw new RangeError('Unsupported training preferences version.')
  exactKeys(v,legacy
    ? ['formatVersion','range','notation','taskMode','direction','intervalSizes','chordDegrees']
    : ['formatVersion','tonicPc','keyMode','exercise','length','range','notation','taskMode','direction','intervalSizes','chordDegrees'], 'Training preferences')
  const range = object(v.range, 'Training range'); exactKeys(range, ['lowMidi','highMidi'], 'Training range')
  const lowMidi = integer(range.lowMidi,36,84,'Low note'), highMidi = integer(range.highMidi,lowMidi,84,'High note')
  if (!['note-names','scale-degrees','movable-do'].includes(String(v.notation))) throw new RangeError('Notation preference is invalid.')
  if (!['imitate','find','identify'].includes(String(v.taskMode))) throw new RangeError('Task preference is invalid.')
  if (!['ascending','descending','both'].includes(String(v.direction))) throw new RangeError('Direction preference is invalid.')
  if(!legacy&&!['major','minor'].includes(String(v.keyMode)))throw new RangeError('Key mode preference is invalid.')
  if(!legacy&&!isExerciseSelection(v.exercise))throw new RangeError('Exercise preference is invalid.')
  return { formatVersion:TRAINING_PREFERENCES_FORMAT_VERSION, tonicPc:legacy?0:integer(v.tonicPc,0,11,'Key pitch class'), keyMode:legacy?'major':v.keyMode as 'major'|'minor', exercise:legacy?'note':v.exercise as TrainingExerciseSelection, length:legacy?20:integer(v.length,1,1_000,'Session length'), range:{lowMidi,highMidi}, notation:v.notation as TrainingNotationPreference, taskMode:v.taskMode as TrainingTaskMode, direction:v.direction as TrainingDirectionChoice, intervalSizes:numberList(v.intervalSizes,2,8,'Interval preferences'), chordDegrees:numberList(v.chordDegrees,1,7,'Chord preferences') }
}
export function updateTrainingPreferences(progress: TrainingProgress, patch: Partial<TrainingPreferences>): TrainingProgress { return { ...progress, profile: restoreTrainingPreferences({ ...progress.profile, ...patch }) } }

export function createTrainingCompletionReceipt(session: TrainingSessionData, completedAt = Date.now()): TrainingCompletionReceipt {
  if (session.status !== 'completed' || session.results.length !== session.prompts.length) throw new RangeError('Only a completed training session can be recorded.')
  if (session.results.length > 1_000) throw new RangeError('Training session is too large.')
  const a = mutableAggregate(emptyAggregate()); a.sessions = 1
  for (const result of session.results) {
    const prompt = session.prompts.find((p) => p.id === result.promptId)
    if (!prompt) throw new RangeError('Training result has no matching prompt.')
    if (result.response === 'skipped') continue
    const exercise = ensureCounter(a.byExercise,prompt.kind); exercise.attempts++; a.attempts++
    let landed: 'onTarget'|'close'|null = null
    if (result.response === 'identify') landed = result.correct ? 'onTarget' : null
    else {
      const classes = result.targets.map((target) => target.classification)
      if (classes.length && classes.every((x) => x === 'on-target')) landed = 'onTarget'
      else if (classes.length && classes.every((x) => x === 'on-target' || x === 'close')) landed = 'close'
      for (const target of result.targets) {
        const m = target.metrics
        if ((target.classification === 'on-target' || target.classification === 'close') && m.medianCentsError !== undefined) { a.centeredCentsSum += m.medianCentsError; a.centeredCentsCount++ }
        if (m.stableHoldRatio !== undefined) { a.stableRatioSum += m.stableHoldRatio; a.stableRatioCount++ }
        if (m.voicedCoverage !== undefined) { a.voicedRatioSum += m.voicedCoverage; a.voicedRatioCount++ }
      }
    }
    if (landed) { a[landed]++; exercise[landed]++ }
    const degreeOutcomes=new Map<number,Array<'onTarget'|'close'|null>>()
    for(let index=0;index<prompt.targets.length;index++){
      const degree=prompt.targets[index].scaleDegree
      let outcome=landed
      if(result.response==='vocal'){
        const target=result.targets.find(item=>item.targetIndex===index)
        outcome=target?.classification==='on-target'?'onTarget':target?.classification==='close'?'close':null
      }
      const values=degreeOutcomes.get(degree)??[];values.push(outcome);degreeOutcomes.set(degree,values)
    }
    for(const [degree,outcomes] of degreeOutcomes){const outcome=outcomes.every(value=>value==='onTarget')?'onTarget':outcomes.every(value=>value==='onTarget'||value==='close')?'close':null;addOutcome(ensureCounter(a.byScaleDegree,String(degree)),outcome);a.scaleDegreeOccurrences++}
    if (prompt.kind === 'interval') {addOutcome(ensureCounter(a.byInterval,`${prompt.intervalNumber}-${prompt.direction}`),landed);a.intervalOccurrences++}
    if (prompt.kind === 'chord-tone') {addOutcome(ensureCounter(a.byChordRole,prompt.role),landed);a.chordRoleOccurrences++}
  }
  const degreeTotals=totals(a.byScaleDegree),intervalTotals=totals(a.byInterval),chordTotals=totals(a.byChordRole)
  a.scaleDegreeOnTargetOccurrences=degreeTotals.onTarget;a.scaleDegreeCloseOccurrences=degreeTotals.close
  a.intervalOnTargetOccurrences=intervalTotals.onTarget;a.intervalCloseOccurrences=intervalTotals.close
  a.chordRoleOnTargetOccurrences=chordTotals.onTarget;a.chordRoleCloseOccurrences=chordTotals.close
  return restoreTrainingCompletionReceipt({ formatVersion:TRAINING_RECEIPT_FORMAT_VERSION, sessionId:session.id, completedAt, key:{...session.config.key}, exercise:session.config.exercise, taskMode:session.config.taskMode, aggregate:freezeAggregate(a) })
}

export function restoreTrainingCompletionReceipt(raw: unknown): TrainingCompletionReceipt {
  const v=object(raw,'Training receipt'); exactKeys(v,['formatVersion','sessionId','completedAt','key','exercise','taskMode','aggregate'],'Training receipt')
  if(v.formatVersion!==TRAINING_RECEIPT_FORMAT_VERSION) throw new RangeError('Unsupported training receipt version.')
  const key=object(v.key,'Training receipt key'); exactKeys(key,['tonicPc','mode'],'Training receipt key')
  if(!isExerciseSelection(v.exercise)) throw new RangeError('Exercise is invalid.')
  if(!['imitate','find','identify'].includes(String(v.taskMode))) throw new RangeError('Task mode is invalid.')
  if(!['major','minor'].includes(String(key.mode))) throw new RangeError('Key mode is invalid.')
  const aggregate=restoreAggregate(v.aggregate); if(aggregate.sessions!==1) throw new RangeError('A completion receipt must represent one session.')
  if(aggregate.attempts>1_000) throw new RangeError('Training receipt attempt count is invalid.')
  const metricLimit=(aggregate.byExercise.note?.attempts??0)+(aggregate.byExercise['scale-degree']?.attempts??0)+(aggregate.byExercise['chord-tone']?.attempts??0)+(aggregate.byExercise.interval?.attempts??0)*2+(aggregate.byExercise.arpeggio?.attempts??0)*3
  if(aggregate.centeredCentsCount>metricLimit||aggregate.stableRatioCount>metricLimit||aggregate.voicedRatioCount>metricLimit||Math.abs(aggregate.centeredCentsSum)>aggregate.centeredCentsCount*1_200)throw new RangeError('Training receipt metric counts are invalid.')
  if(v.taskMode==='identify'&&(aggregate.centeredCentsCount!==0||aggregate.centeredCentsSum!==0||aggregate.stableRatioCount!==0||aggregate.stableRatioSum!==0||aggregate.voicedRatioCount!==0||aggregate.voicedRatioSum!==0))throw new RangeError('Identify training receipts cannot contain pitch metrics.')
  for(const map of [aggregate.byExercise,aggregate.byScaleDegree,aggregate.byInterval,aggregate.byChordRole])for(const counter of Object.values(map))if(counter.attempts>aggregate.attempts)throw new RangeError('Training receipt outcome count exceeds its attempts.')
  const degreeTotals=totals(aggregate.byScaleDegree),intervalTotals=totals(aggregate.byInterval),chordTotals=totals(aggregate.byChordRole)
  if(degreeTotals.attempts!==aggregate.scaleDegreeOccurrences||degreeTotals.onTarget!==aggregate.scaleDegreeOnTargetOccurrences||degreeTotals.close!==aggregate.scaleDegreeCloseOccurrences||intervalTotals.attempts!==aggregate.intervalOccurrences||intervalTotals.onTarget!==aggregate.intervalOnTargetOccurrences||intervalTotals.close!==aggregate.intervalCloseOccurrences||chordTotals.attempts!==aggregate.chordRoleOccurrences||chordTotals.onTarget!==aggregate.chordRoleOnTargetOccurrences||chordTotals.close!==aggregate.chordRoleCloseOccurrences)throw new RangeError('Training receipt occurrence totals are inconsistent.')
  if(aggregate.scaleDegreeOccurrences>aggregate.attempts*3||aggregate.intervalOccurrences>aggregate.attempts||aggregate.chordRoleOccurrences>aggregate.attempts)throw new RangeError('Training receipt occurrence count exceeds real prompts or targets.')
  if(v.exercise!=='mixed'&&aggregate.attempts>0&&(Object.keys(aggregate.byExercise).length!==1||!aggregate.byExercise[v.exercise]))throw new RangeError('Training receipt exercise outcomes do not match its exercise.')
  const intervalExercise=aggregate.byExercise.interval??{attempts:0,onTarget:0,close:0},chordExercise=aggregate.byExercise['chord-tone']??{attempts:0,onTarget:0,close:0}
  if(JSON.stringify(intervalTotals)!==JSON.stringify(intervalExercise)||JSON.stringify(chordTotals)!==JSON.stringify(chordExercise))throw new RangeError('Training receipt skill outcomes are inconsistent.')
  const baseDegreeAttempts=(aggregate.byExercise.note?.attempts??0)+(aggregate.byExercise['scale-degree']?.attempts??0)+(aggregate.byExercise['chord-tone']?.attempts??0),arpeggioAttempts=aggregate.byExercise.arpeggio?.attempts??0,intervalAttempts=intervalExercise.attempts
  const minimumDegrees=baseDegreeAttempts+arpeggioAttempts*3+intervalAttempts,maximumDegrees=minimumDegrees+intervalAttempts
  if(aggregate.scaleDegreeOccurrences<minimumDegrees||aggregate.scaleDegreeOccurrences>maximumDegrees)throw new RangeError('Training receipt scale-degree occurrences are inconsistent.')
  return { formatVersion:TRAINING_RECEIPT_FORMAT_VERSION, sessionId:restoreSessionId(v.sessionId), completedAt:integer(v.completedAt,0,Number.MAX_SAFE_INTEGER,'Completion timestamp'), key:{tonicPc:integer(key.tonicPc,0,11,'Key pitch class'),mode:key.mode as 'major'|'minor'}, exercise:v.exercise, taskMode:v.taskMode as TrainingTaskMode, aggregate }
}

export function deriveTrainingProgress(profile: TrainingPreferences, rawReceipts: Iterable<unknown>): TrainingProgress {
  const aggregate=mutableAggregate(emptyAggregate()),recentReceipts:TrainingCompletionReceipt[]=[]
  for(const raw of rawReceipts){
    const receipt=restoreTrainingCompletionReceipt(raw);addAggregate(aggregate,receipt.aggregate)
    recentReceipts.push(receipt)
    recentReceipts.sort((a,b)=>b.completedAt-a.completedAt||a.sessionId.localeCompare(b.sessionId))
    if(recentReceipts.length>TRAINING_PROGRESS_HISTORY_LIMIT)recentReceipts.pop()
  }
  const recent=recentReceipts.map(receiptToRecent)
  return {formatVersion:TRAINING_PROGRESS_FORMAT_VERSION,profile:clonePreferences(profile),recent,aggregate:restoreAggregate(freezeAggregate(aggregate))}
}

export function restoreTrainingProgress(raw:unknown):TrainingProgress{
  const v=object(raw,'Training progress'); exactKeys(v,['formatVersion','profile','recent','aggregate'],'Training progress')
  if(v.formatVersion!==TRAINING_PROGRESS_FORMAT_VERSION) throw new RangeError('Unsupported training progress version.')
  if(!Array.isArray(v.recent)||v.recent.length>TRAINING_PROGRESS_HISTORY_LIMIT) throw new RangeError('Training history is invalid.')
  const recent=v.recent.map(restoreRecent); if(new Set(recent.map(x=>x.sessionId)).size!==recent.length) throw new RangeError('Training history contains duplicate sessions.')
  const aggregate=restoreAggregate(v.aggregate); if(aggregate.sessions<recent.length) throw new RangeError('Training aggregate session count is invalid.')
  return {formatVersion:TRAINING_PROGRESS_FORMAT_VERSION,profile:restoreTrainingPreferences(v.profile),recent,aggregate}
}

export function summarizeTrainingProgress(progress:TrainingProgress):TrainingProgressSnapshot{const a=progress.aggregate,cents=ratio(a.centeredCentsSum,a.centeredCentsCount);return{sessions:a.sessions,attempts:a.attempts,landedRate:ratio(a.onTarget+a.close,a.attempts),tendency:cents===null?'not-enough-pitch':cents>10?'sharp':cents< -10?'flat':'centered',averageSignedCents:cents,stableRatio:ratio(a.stableRatioSum,a.stableRatioCount),voicedRatio:ratio(a.voicedRatioSum,a.voicedRatioCount),weakerExercises:weakest(a.byExercise),weakerScaleDegrees:weakest(a.byScaleDegree),weakerIntervals:weakest(a.byInterval),weakerChordRoles:weakest(a.byChordRole)}}

function receiptToRecent(r:TrainingCompletionReceipt):TrainingRecentSession{const a=r.aggregate;return{sessionId:r.sessionId,completedAt:r.completedAt,key:r.key,exercise:r.exercise,taskMode:r.taskMode,attempts:a.attempts,onTarget:a.onTarget,close:a.close,averageCenteredCents:ratio(a.centeredCentsSum,a.centeredCentsCount),stableRatio:ratio(a.stableRatioSum,a.stableRatioCount),voicedRatio:ratio(a.voicedRatioSum,a.voicedRatioCount)}}
function emptyAggregate():TrainingProgressAggregate{return freezeAggregate({sessions:0,attempts:0,onTarget:0,close:0,centeredCentsSum:0,centeredCentsCount:0,stableRatioSum:0,stableRatioCount:0,voicedRatioSum:0,voicedRatioCount:0,scaleDegreeOccurrences:0,scaleDegreeOnTargetOccurrences:0,scaleDegreeCloseOccurrences:0,intervalOccurrences:0,intervalOnTargetOccurrences:0,intervalCloseOccurrences:0,chordRoleOccurrences:0,chordRoleOnTargetOccurrences:0,chordRoleCloseOccurrences:0,byExercise:{},byScaleDegree:{},byInterval:{},byChordRole:{}})}
type MutableCounter={attempts:number;onTarget:number;close:number}
type MutableAggregate={sessions:number;attempts:number;onTarget:number;close:number;centeredCentsSum:number;centeredCentsCount:number;stableRatioSum:number;stableRatioCount:number;voicedRatioSum:number;voicedRatioCount:number;scaleDegreeOccurrences:number;scaleDegreeOnTargetOccurrences:number;scaleDegreeCloseOccurrences:number;intervalOccurrences:number;intervalOnTargetOccurrences:number;intervalCloseOccurrences:number;chordRoleOccurrences:number;chordRoleOnTargetOccurrences:number;chordRoleCloseOccurrences:number;byExercise:Record<string,MutableCounter>;byScaleDegree:Record<string,MutableCounter>;byInterval:Record<string,MutableCounter>;byChordRole:Record<string,MutableCounter>}
function mutableAggregate(v:TrainingProgressAggregate):MutableAggregate{const copy=(m:Readonly<Record<string,TrainingOutcomeCounter>>)=>Object.fromEntries(Object.entries(m).map(([k,x])=>[k,{...x}]));return{...v,byExercise:copy(v.byExercise),byScaleDegree:copy(v.byScaleDegree),byInterval:copy(v.byInterval),byChordRole:copy(v.byChordRole)}}
function freezeAggregate(v:MutableAggregate):TrainingProgressAggregate{return{...v}}
function addAggregate(into:MutableAggregate,add:TrainingProgressAggregate):void{for(const key of ['sessions','attempts','onTarget','close','centeredCentsSum','centeredCentsCount','stableRatioSum','stableRatioCount','voicedRatioSum','voicedRatioCount','scaleDegreeOccurrences','scaleDegreeOnTargetOccurrences','scaleDegreeCloseOccurrences','intervalOccurrences','intervalOnTargetOccurrences','intervalCloseOccurrences','chordRoleOccurrences','chordRoleOnTargetOccurrences','chordRoleCloseOccurrences'] as const)into[key]+=add[key];for(const name of ['byExercise','byScaleDegree','byInterval','byChordRole'] as const)for(const [key,c] of Object.entries(add[name])){const x=ensureCounter(into[name],key);x.attempts+=c.attempts;x.onTarget+=c.onTarget;x.close+=c.close}}
function ensureCounter(m:Record<string,MutableCounter>,k:string):MutableCounter{return(m[k]??={attempts:0,onTarget:0,close:0})}
function addOutcome(c:MutableCounter,l:'onTarget'|'close'|null):void{c.attempts++;if(l)c[l]++}
function totals(map:Readonly<Record<string,TrainingOutcomeCounter>>):TrainingOutcomeCounter{return Object.values(map).reduce((sum,counter)=>({attempts:sum.attempts+counter.attempts,onTarget:sum.onTarget+counter.onTarget,close:sum.close+counter.close}),{attempts:0,onTarget:0,close:0})}
function weakest(m:Readonly<Record<string,TrainingOutcomeCounter>>):string[]{return Object.entries(m).filter(([,v])=>v.attempts>=2).sort((a,b)=>landedRate(a[1])-landedRate(b[1])||b[1].attempts-a[1].attempts||a[0].localeCompare(b[0])).slice(0,3).map(([k])=>k)}
function landedRate(c:TrainingOutcomeCounter):number{return c.attempts===0?1:(c.onTarget+c.close)/c.attempts}
function restoreRecent(raw:unknown):TrainingRecentSession{const v=object(raw,'Recent training session');exactKeys(v,['sessionId','completedAt','key','exercise','taskMode','attempts','onTarget','close','averageCenteredCents','stableRatio','voicedRatio'],'Recent training session');const key=object(v.key,'Recent session key');exactKeys(key,['tonicPc','mode'],'Recent session key');if(!isExerciseSelection(v.exercise))throw new RangeError('Exercise is invalid.');if(!['imitate','find','identify'].includes(String(v.taskMode)))throw new RangeError('Task mode is invalid.');if(!['major','minor'].includes(String(key.mode)))throw new RangeError('Key mode is invalid.');const attempts=integer(v.attempts,0,1000,'Attempt count'),onTarget=integer(v.onTarget,0,attempts,'On-target count'),close=integer(v.close,0,attempts,'Close count');if(onTarget+close>attempts)throw new RangeError('Recent landed counts are invalid.');return{sessionId:restoreSessionId(v.sessionId),completedAt:integer(v.completedAt,0,Number.MAX_SAFE_INTEGER,'Completion timestamp'),key:{tonicPc:integer(key.tonicPc,0,11,'Key pitch class'),mode:key.mode as 'major'|'minor'},exercise:v.exercise,taskMode:v.taskMode as TrainingTaskMode,attempts,onTarget,close,averageCenteredCents:nullableFinite(v.averageCenteredCents,-1200,1200,'Average cents'),stableRatio:nullableFinite(v.stableRatio,0,1,'Stable ratio'),voicedRatio:nullableFinite(v.voicedRatio,0,1,'Voiced ratio')}}
function restoreAggregate(raw:unknown):TrainingProgressAggregate{const v=object(raw,'Training aggregate'),keys=['sessions','attempts','onTarget','close','centeredCentsSum','centeredCentsCount','stableRatioSum','stableRatioCount','voicedRatioSum','voicedRatioCount','scaleDegreeOccurrences','scaleDegreeOnTargetOccurrences','scaleDegreeCloseOccurrences','intervalOccurrences','intervalOnTargetOccurrences','intervalCloseOccurrences','chordRoleOccurrences','chordRoleOnTargetOccurrences','chordRoleCloseOccurrences'] as const;exactKeys(v,[...keys,'byExercise','byScaleDegree','byInterval','byChordRole'],'Training aggregate');const count=(k:typeof keys[number])=>integer(v[k],0,Number.MAX_SAFE_INTEGER,k),finite=(k:typeof keys[number])=>finiteNumber(v[k],-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,k);const a={sessions:count('sessions'),attempts:count('attempts'),onTarget:count('onTarget'),close:count('close'),centeredCentsSum:finite('centeredCentsSum'),centeredCentsCount:count('centeredCentsCount'),stableRatioSum:finite('stableRatioSum'),stableRatioCount:count('stableRatioCount'),voicedRatioSum:finite('voicedRatioSum'),voicedRatioCount:count('voicedRatioCount'),scaleDegreeOccurrences:count('scaleDegreeOccurrences'),scaleDegreeOnTargetOccurrences:count('scaleDegreeOnTargetOccurrences'),scaleDegreeCloseOccurrences:count('scaleDegreeCloseOccurrences'),intervalOccurrences:count('intervalOccurrences'),intervalOnTargetOccurrences:count('intervalOnTargetOccurrences'),intervalCloseOccurrences:count('intervalCloseOccurrences'),chordRoleOccurrences:count('chordRoleOccurrences'),chordRoleOnTargetOccurrences:count('chordRoleOnTargetOccurrences'),chordRoleCloseOccurrences:count('chordRoleCloseOccurrences'),byExercise:counterMap(v.byExercise,['note','scale-degree','interval','chord-tone','arpeggio']),byScaleDegree:counterMap(v.byScaleDegree,['1','2','3','4','5','6','7']),byInterval:counterMap(v.byInterval,/^[2-8]-(?:ascending|descending)$/),byChordRole:counterMap(v.byChordRole,['root','third','fifth'])};if(a.onTarget+a.close>a.attempts)throw new RangeError('Aggregate landed counts are invalid.');if((a.centeredCentsCount===0&&a.centeredCentsSum!==0)||a.stableRatioSum<0||a.voicedRatioSum<0||a.stableRatioSum>a.stableRatioCount||a.voicedRatioSum>a.voicedRatioCount||(a.stableRatioCount===0&&a.stableRatioSum!==0)||(a.voicedRatioCount===0&&a.voicedRatioSum!==0))throw new RangeError('Aggregate ratios are invalid.');const total=totals(a.byExercise);if(total.attempts!==a.attempts||total.onTarget!==a.onTarget||total.close!==a.close)throw new RangeError('Aggregate exercise counts are inconsistent.');const degreeTotals=totals(a.byScaleDegree),intervalTotals=totals(a.byInterval),chordTotals=totals(a.byChordRole);if(degreeTotals.attempts!==a.scaleDegreeOccurrences||degreeTotals.onTarget!==a.scaleDegreeOnTargetOccurrences||degreeTotals.close!==a.scaleDegreeCloseOccurrences||intervalTotals.attempts!==a.intervalOccurrences||intervalTotals.onTarget!==a.intervalOnTargetOccurrences||intervalTotals.close!==a.intervalCloseOccurrences||chordTotals.attempts!==a.chordRoleOccurrences||chordTotals.onTarget!==a.chordRoleOnTargetOccurrences||chordTotals.close!==a.chordRoleCloseOccurrences)throw new RangeError('Aggregate occurrence totals are inconsistent.');return a}
function counterMap(raw:unknown,allowed:readonly string[]|RegExp):Record<string,TrainingOutcomeCounter>{const v=object(raw,'Outcome map'),out:Record<string,TrainingOutcomeCounter>={};if(Object.keys(v).length>16)throw new RangeError('Outcome map is too large.');for(const[k,x]of Object.entries(v)){if(allowed instanceof RegExp?!allowed.test(k):!allowed.includes(k))throw new RangeError('Outcome key is invalid.');const c=object(x,'Outcome counter');exactKeys(c,['attempts','onTarget','close'],'Outcome counter');const attempts=integer(c.attempts,0,Number.MAX_SAFE_INTEGER,'Outcome attempts'),onTarget=integer(c.onTarget,0,attempts,'Outcome on-target'),close=integer(c.close,0,attempts,'Outcome close');if(onTarget+close>attempts)throw new RangeError('Outcome landed counts are invalid.');out[k]={attempts,onTarget,close}}return out}
function isExerciseSelection(v:unknown):v is TrainingExerciseSelection{return['note','scale-degree','interval','chord-tone','arpeggio','mixed'].includes(String(v))}
function clonePreferences(v:TrainingPreferences):TrainingPreferences{return restoreTrainingPreferences({...v,range:{...v.range},intervalSizes:[...v.intervalSizes],chordDegrees:[...v.chordDegrees]})}
function object(raw:unknown,label:string):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new RangeError(`${label} is invalid.`);return raw as Record<string,unknown>}
function exactKeys(v:Record<string,unknown>,keys:readonly string[],label:string):void{if(Object.keys(v).some(k=>!keys.includes(k))||keys.some(k=>!(k in v)))throw new RangeError(`${label} has unknown or missing fields.`)}
function integer(raw:unknown,low:number,high:number,label:string):number{if(!Number.isSafeInteger(raw)||(raw as number)<low||(raw as number)>high)throw new RangeError(`${label} is invalid.`);return raw as number}
function finiteNumber(raw:unknown,low:number,high:number,label:string):number{if(typeof raw!=='number'||!Number.isFinite(raw)||raw<low||raw>high)throw new RangeError(`${label} is invalid.`);return raw}
function nullableFinite(raw:unknown,low:number,high:number,label:string):number|null{return raw===null?null:finiteNumber(raw,low,high,label)}
function restoreSessionId(raw:unknown):string{if(typeof raw!=='string'||raw.length<1||raw.length>160)throw new RangeError('Session id is invalid.');return raw}
function numberList(raw:unknown,low:number,high:number,label:string):number[]{if(!Array.isArray(raw)||raw.length>high-low+1)throw new RangeError(`${label} are invalid.`);const values=raw.map(v=>integer(v,low,high,label));if(new Set(values).size!==values.length)throw new RangeError(`${label} contain duplicates.`);return values.sort((a,b)=>a-b)}
function ratio(sum:number,count:number):number|null{return count===0?null:sum/count}
