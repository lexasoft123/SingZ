import { useEffect, useState } from 'react'
import { register } from '../../shared/i18n/core'
import { nativeOffer } from '../../shared/i18n/en/native-offer'
import type { NativeHandoverReport, NativeOffer } from '../../shared/native-handover'

// English copy for the offer lives with the lazy offer chunk, not the eager entry.
register('en', nativeOffer)

type Storage = Pick<globalThis.Storage, 'getItem'>
const json = (storage: Storage, key: string): unknown => {
  try { const raw = storage.getItem(key); return raw === null ? undefined : JSON.parse(raw) } catch { return undefined }
}

/** The stored preference values the native app cannot read (it never opens
 * Chromium localStorage), unvalidated: main validates and shapes the export. */
export function collectNativeHandoverReport(storage: Storage): NativeHandoverReport {
  let karaoke: boolean | undefined
  try {
    const raw = storage.getItem('singz.karaoke')
    karaoke = raw === '1' ? true : raw === '0' ? false : undefined
  } catch { karaoke = undefined }
  return {
    audio: json(storage, 'singz.audio'),
    metronome: json(storage, 'singz.met'),
    karaoke,
    trainingPractice: json(storage, 'singz.training.practice'),
    trainingProgram: json(storage, 'singz.training.program')
  }
}

/** The current offer (never available unless the build enables it), kept live. */
export function useNativeOffer(): NativeOffer {
  const [offer, setOffer] = useState<NativeOffer>({ available: false })
  useEffect(() => {
    let live = true
    void window.singz.nativeOfferNow().then((o) => { if (live) setOffer(o) }).catch(() => {})
    const off = window.singz.onNativeOffer(setOffer)
    return () => { live = false; off() }
  }, [])
  return offer
}

export function openNativeOffer(): void {
  void window.singz.openNativeOffer(collectNativeHandoverReport(localStorage)).catch(() => {})
}
