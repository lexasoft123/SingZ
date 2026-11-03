import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { t } from '../i18n'
import { createLazyDialogRoute } from './LazyDialogRoute'
import type { PhoneSignInProps } from './PhoneSignIn'

export type DriveSignInResult = { ok: true } | { ok: false; error: string }
const SignInContext = createContext<() => Promise<DriveSignInResult>>(() => Promise.resolve({ ok: false, error: 'Sign-in unavailable' }))
export const useDriveSignIn = (): (() => Promise<DriveSignInResult>) => useContext(SignInContext)
const PhoneSignIn = createLazyDialogRoute<PhoneSignInProps>([
  // @ts-expect-error Vite creates separate module identities for recovery.
  () => import('./PhoneSignIn?dialog-route=primary'),
  // @ts-expect-error See the primary attempt above.
  () => import('./PhoneSignIn?dialog-route=recovery')
], {
  get name() { return t('library.projectPicker.connectDrive') },
  get opening() { return t('app.dialog.setupModal.opening') },
  get failureTitle() { return t('app.dialog.setupModal.failureTitle') },
  get failureMessage() { return t('app.dialog.setupModal.failureMessage') }
})

/** Both catalog entry points share one request; obsolete dialogs cannot complete a newer request. */
export function DriveSignInProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [dialog, setDialog] = useState<{ id: number } | null>(null)
  const seq = useRef(0)
  const pending = useRef<{ id: number; resolve: (result: DriveSignInResult) => void } | null>(null)
  const finish = useCallback((id: number, result: DriveSignInResult) => {
    if (pending.current?.id !== id) return
    pending.current.resolve(result); pending.current = null; setDialog(null)
  }, [])
  const complete = useCallback((result: DriveSignInResult) => { if (dialog) finish(dialog.id, result) }, [dialog, finish])
  const close = useCallback(() => { if (dialog) finish(dialog.id, { ok: false, error: t('main.error.googleSignInCancelled') }) }, [dialog, finish])
  const signIn = useCallback(async (): Promise<DriveSignInResult> => {
    const state = await window.singz.gdriveStatus()
    if (state.signInMode !== 'device') return window.singz.gdriveSignIn()
    if (pending.current) return { ok: false, error: t('library.common.finishGoogleSignIn') }
    const id = ++seq.current
    return new Promise<DriveSignInResult>(resolve => { pending.current = { id, resolve }; setDialog({ id }) })
  }, [])
  useEffect(() => () => {
    if (pending.current) {
      void window.singz.gdriveDeviceCancel().catch(() => undefined)
      pending.current.resolve({ ok: false, error: t('main.error.googleSignInCancelled') }); pending.current = null
    }
  }, [])
  return <SignInContext.Provider value={signIn}>{children}
    {dialog && <PhoneSignIn key={dialog.id} finish={complete} onClose={close} />}
  </SignInContext.Provider>
}
