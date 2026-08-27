import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultTrainingPreferences,
  type TrainingCompletionReceipt,
  type TrainingPreferences
} from '../../src/shared/training-progress'
import {
  loadTrainingProgressFrom,
  readTrainingPreferencesFile,
  recordTrainingReceipt,
  saveTrainingPreferencesFile,
  TRAINING_PREFERENCES_MAX_BYTES,
  type TrainingPreferenceStoreOps
} from '../../src/main/training-progress'

const dirs: string[] = []
const ops: TrainingPreferenceStoreOps = {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('dedicated training preference store', () => {
  it('keeps settings.json byte-for-byte untouched through profile and receipt operations', () => {
    const dir = fixture()
    const settings = join(dir, 'settings.json')
    const profileFile = join(dir, 'training-preferences.json')
    const receipts = join(dir, 'training-receipts')
    const sentinel = Buffer.from('{ "gdrive": "must stay byte-identical", "projectsRoot": "/library" }\n')
    writeFileSync(settings, sentinel)

    const first = preferences(40)
    expect(saveTrainingPreferencesFile(profileFile, first, option('1'))).toEqual({
      ok: true,
      preferences: first
    })
    expect(readTrainingPreferencesFile(profileFile)).toMatchObject({
      ok: true,
      preferences: first,
      exists: true
    })

    const second = preferences(42)
    expect(saveTrainingPreferencesFile(profileFile, second, option('2'))).toEqual({
      ok: true,
      preferences: second
    })
    const stored = readTrainingPreferencesFile(profileFile)
    expect(stored).toMatchObject({ ok: true, preferences: second })
    expect(recordTrainingReceipt(receipts, receipt('separate-store'))).toBe(false)
    if (!stored.ok) throw new Error('Expected stored preferences.')
    expect(loadTrainingProgressFrom(receipts, stored.preferences).aggregate.sessions).toBe(1)
    expect(readFileSync(settings)).toEqual(sentinel)
  })

  it('fully commits short writes and preserves the prior snapshot after zero progress', () => {
    for (let chunk = 1; chunk <= 5; chunk++) {
      const dir = fixture()
      const file = join(dir, 'training-preferences.json')
      const chunked: TrainingPreferenceStoreOps = {
        ...ops,
        writeSync: (fd, buffer, offset, length) =>
          writeSync(fd, buffer, offset, Math.min(chunk, length))
      }
      const value = preferences(39 + chunk)
      expect(saveTrainingPreferencesFile(file, value, {
        ...option(String(chunk)),
        ops: chunked
      })).toEqual({ ok: true, preferences: value })
      expect(readTrainingPreferencesFile(file).ok).toBe(true)
    }

    const dir = fixture()
    const file = join(dir, 'training-preferences.json')
    const prior = preferences(41)
    expect(saveTrainingPreferencesFile(file,prior,option('e')).ok).toBe(true)
    const before=readFileSync(file)
    const zero: TrainingPreferenceStoreOps = { ...ops, writeSync: () => 0 }
    const result = saveTrainingPreferencesFile(file, preferences(44), {
      ...option('f'),
      ops: zero
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('Expected a short-write failure.')
    expect(result.error).toMatch(/progress/i)
    expect(readFileSync(file)).toEqual(before)
  })

  it('preserves malformed, oversized, and unknown-version bytes instead of overwriting them', () => {
    for (const bytes of [
      Buffer.from('{ malformed training preferences'),
      Buffer.alloc(TRAINING_PREFERENCES_MAX_BYTES+1,1),
      Buffer.from(JSON.stringify({ formatVersion: 99, preferences: defaultTrainingPreferences() }))
    ]) {
      const dir = fixture()
      const file = join(dir, 'training-preferences.json')
      writeFileSync(file, bytes)
      const result = saveTrainingPreferencesFile(file, preferences(43), option('a'))
      expect(result).toMatchObject({ ok: false })
      expect(readFileSync(file)).toEqual(bytes)
      expect(readTrainingPreferencesFile(file).ok).toBe(false)
    }
  })

  it('publishes concurrent complete snapshots without hybrid or corrupt bytes', () => {
    const dir = fixture()
    const file = join(dir, 'training-preferences.json')
    const first=preferences(40),second=preferences(46)
    let secondCompleted=false
    const firstOps:TrainingPreferenceStoreOps={
      ...ops,
      renameSync:(source,destination)=>{
        if(destination===file&&!secondCompleted){
          secondCompleted=true
          expect(saveTrainingPreferencesFile(file,second,option('2'))).toEqual({ok:true,preferences:second})
        }
        renameSync(source,destination)
      }
    }
    expect(saveTrainingPreferencesFile(file,first,{...option('1'),ops:firstOps})).toEqual({ok:true,preferences:first})
    expect(secondCompleted).toBe(true)
    expect(readTrainingPreferencesFile(file)).toMatchObject({ok:true,preferences:first})
    expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({formatVersion:1,preferences:first})
  })

  it('preserves a fresh foreign temp, sweeps an old crash temp, and lets the save finish',()=>{
    const dir=fixture(),file=join(dir,'training-preferences.json')
    const oldResidue=`${file}.${'c'.repeat(32)}.tmp`,freshResidue=`${file}.${'d'.repeat(32)}.tmp`
    writeFileSync(oldResidue,'old partial private snapshot')
    writeFileSync(freshResidue,'active foreign private snapshot')
    utimesSync(oldResidue,new Date(0),new Date(0))
    const value=preferences(44)
    expect(saveTrainingPreferencesFile(file,value,option('e'))).toEqual({ok:true,preferences:value})
    expect(existsSync(oldResidue)).toBe(false)
    expect(existsSync(freshResidue)).toBe(true)
    expect(readTrainingPreferencesFile(file)).toMatchObject({ok:true,preferences:value})
  })

  it('preserves the previous profile when write, file fsync, or rename fails', () => {
    const dir = fixture()
    const file = join(dir, 'training-preferences.json')
    const first = preferences(40)
    expect(saveTrainingPreferencesFile(file, first, option('1')).ok).toBe(true)
    const before = readFileSync(file)
    const failureOps:TrainingPreferenceStoreOps[]=[
      {...ops,writeSync:()=>{throw ioError('profile write failed')}},
      {...ops,fsyncSync:()=>{throw ioError('profile fsync failed')}},
      {...ops,renameSync:(source,destination)=>{if(destination===file)throw ioError('profile rename failed');renameSync(source,destination)}}
    ]
    for(const [index,failed] of failureOps.entries()){
      const result=saveTrainingPreferencesFile(file,preferences(46),{...option(String(index+2)),ops:failed})
      expect(result).toMatchObject({ok:false})
      expect(readFileSync(file)).toEqual(before)
    }
  })
})

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'singz-training-preferences-'))
  dirs.push(dir)
  return dir
}

function option(suffix: string): { nonce: string } {
  return { nonce: suffix.padStart(32, '0').slice(-32) }
}

function ioError(message:string):NodeJS.ErrnoException{const error=new Error(message) as NodeJS.ErrnoException;error.code='EIO';return error}

function preferences(lowMidi: number): TrainingPreferences {
  return { ...defaultTrainingPreferences(), range: { lowMidi, highMidi: 72 } }
}

function receipt(sessionId: string): TrainingCompletionReceipt {
  return {
    formatVersion: 1,
    sessionId,
    completedAt: 1,
    key: { tonicPc: 0, mode: 'major' },
    exercise: 'note',
    taskMode: 'find',
    aggregate: {
      sessions: 1,
      attempts: 0,
      onTarget: 0,
      close: 0,
      centeredCentsSum: 0,
      centeredCentsCount: 0,
      stableRatioSum: 0,
      stableRatioCount: 0,
      voicedRatioSum: 0,
      voicedRatioCount: 0,
      scaleDegreeOccurrences: 0,
      scaleDegreeOnTargetOccurrences: 0,
      scaleDegreeCloseOccurrences: 0,
      intervalOccurrences: 0,
      intervalOnTargetOccurrences: 0,
      intervalCloseOccurrences: 0,
      chordRoleOccurrences: 0,
      chordRoleOnTargetOccurrences: 0,
      chordRoleCloseOccurrences: 0,
      byExercise: {},
      byScaleDegree: {},
      byInterval: {},
      byChordRole: {}
    }
  }
}
