import {
  FILE_FAILING_COPY,
  KEEPS_FAILING_COPY,
  isFileProblem,
  splitFailureCopy,
} from '../src/split/flow'

// Every file-level error the two split natives write into job.json, verbatim
// (SingzSplitRunner.mm DecodeToRawF32Stereo, AudioDecode.kt). A new decode
// error on either side belongs in this list.
const FILE_ERRORS = [
  'Decode failed (unknown)',
  'Could not open this file (unreadable)',
  'No audio in this file',
  'This file changes sample rate mid-stream',
  'The decoder mislabeled its output for this file',
  'The decoder stalled on this file',
]
// The phone's failures: these are the ones "keeps failing on this phone" is for.
const PHONE_ERRORS = [
  // a codec this phone lacks: another copy of the file would fail the same way
  'This phone cannot decode mpeg (no codec)',
  'Splitting stalled — resume to try again',
  'The system stopped the split — resume to continue',
  'The split was interrupted',
  'Ran out of space writing the decoded audio',
  'Could not write the decoded audio',
]

describe('split failure copy', () => {
  test.each(FILE_ERRORS)('a file problem says so from the first failure: %s', error => {
    expect(isFileProblem(error)).toBe(true)
    expect(splitFailureCopy(error, 0)).toBe(FILE_FAILING_COPY)
    expect(splitFailureCopy(error, 3)).toBe(FILE_FAILING_COPY)
  })

  test.each(PHONE_ERRORS)('a phone problem keeps its own wording: %s', error => {
    expect(isFileProblem(error)).toBe(false)
    expect(splitFailureCopy(error, 0)).toBe(error)
    expect(splitFailureCopy(error, 1)).toBe(error)
    expect(splitFailureCopy(error, 2)).toBe(KEEPS_FAILING_COPY)
  })
})

describe('a failed job that still holds the engine', () => {
  // SingzSplitRunner's watchdog records a stall as failed but keeps the runner
  // active until SingZ restarts; Android's :split dies with its stall.
  const { failedJobHoldsEngine } = require('../src/split/service')
  test('an iOS stall keeps other songs waiting', () => {
    expect(failedJobHoldsEngine('Splitting stalled — resume to try again', 'ios')).toBe(true)
  })
  test('an Android stall and every other failure let go', () => {
    expect(failedJobHoldsEngine('Splitting stalled — resume to try again', 'android')).toBe(false)
    for (const error of [...FILE_ERRORS, ...PHONE_ERRORS.filter(e => !/stalled/.test(e))])
      expect(failedJobHoldsEngine(error, 'ios')).toBe(false)
  })
})
