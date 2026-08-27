import type { TrainingCompletionReceipt, TrainingPreferences, TrainingProgress } from '../../shared/training-progress'

type CompletionResult={ok:true;progress:TrainingProgress;alreadyRecorded?:boolean}|{ok:false;error:string}
type PreferenceResult={ok:true;preferences:TrainingPreferences}|{ok:false;error:string}

/** Completions have an independent high-priority lane: a failed/slow preference
 * can never delay the durable completion receipt. Preference changes coalesce
 * to the newest unsent value. */
export class TrainingProgressMutations {
  private preferenceDesired:{value:TrainingPreferences;fingerprint:string}|null=null
  private preferenceRunning=false
  private completionRunning=false
  private readonly completions:TrainingCompletionReceipt[]=[]
  private readonly completionKeys=new Set<string>()
  private savedPreferenceFingerprint=''
  private latestPreference:TrainingPreferences|null=null
  private preferenceError:string|null=null
  private completionError:string|null=null
  constructor(private readonly api:{savePreferences:(value:TrainingPreferences)=>Promise<PreferenceResult>;recordCompletion:(value:TrainingCompletionReceipt)=>Promise<CompletionResult>},private readonly onProgress:(progress:TrainingProgress)=>void,private readonly onPreferences:(preferences:TrainingPreferences)=>void,private readonly onError:(error:string|null)=>void){}

  markLoaded(progress:TrainingProgress):void{this.savedPreferenceFingerprint=JSON.stringify(progress.profile)}
  savePreferences(value:TrainingPreferences):void{
    const fingerprint=JSON.stringify(value)
    if(fingerprint===this.savedPreferenceFingerprint&&!this.preferenceDesired)return
    this.latestPreference=value;this.preferenceDesired={value,fingerprint};void this.pumpPreference()
  }
  recordCompletion(value:TrainingCompletionReceipt):void{
    if(this.completionKeys.has(value.sessionId))return
    this.completionKeys.add(value.sessionId);this.completions.push(value);void this.pumpCompletion()
  }
  retry():void{void this.pumpCompletion();void this.pumpPreference()}
  flushPreferencesSync(save:(value:TrainingPreferences)=>PreferenceResult):PreferenceResult|{ok:true;preferences:null}{
    if(!this.latestPreference)return{ok:true,preferences:null}
    const result=save(this.latestPreference)
    if(result.ok){this.savedPreferenceFingerprint=JSON.stringify(result.preferences);this.preferenceDesired=null;this.preferenceError=null;this.emitError()}
    else{this.preferenceError=result.error;this.emitError()}
    return result
  }

  private async pumpPreference():Promise<void>{
    if(this.preferenceRunning||!this.preferenceDesired)return
    const job=this.preferenceDesired;this.preferenceDesired=null;this.preferenceRunning=true
    let failed=false
    try{
      const result=await safe(()=>this.api.savePreferences(job.value))
      if(!result.ok){failed=true;this.preferenceError=result.error;if(!this.preferenceDesired)this.preferenceDesired=job;this.emitError();return}
      this.savedPreferenceFingerprint=job.fingerprint;this.preferenceError=null;this.onPreferences(result.preferences);this.emitError()
    }finally{
      this.preferenceRunning=false
      if(this.preferenceDesired&&(!failed||this.preferenceDesired.fingerprint!==job.fingerprint))void this.pumpPreference()
    }
  }
  private async pumpCompletion():Promise<void>{
    if(this.completionRunning||!this.completions.length)return
    this.completionRunning=true
    try{
      while(this.completions.length){
        const receipt=this.completions[0],result=await safe(()=>this.api.recordCompletion(receipt))
        if(!result.ok){this.completionError=result.error;this.emitError();return}
        this.completions.shift();this.completionKeys.delete(receipt.sessionId);this.completionError=null;this.onProgress(result.progress);this.emitError()
      }
    }finally{this.completionRunning=false}
  }
  private emitError():void{this.onError(this.completionError??this.preferenceError)}
}

async function safe<T extends {ok:true}|{ok:false;error:string}>(run:()=>Promise<T>):Promise<T|{ok:false;error:string}>{try{return await run()}catch(error){return{ok:false,error:error instanceof Error?error.message:String(error)}}}
