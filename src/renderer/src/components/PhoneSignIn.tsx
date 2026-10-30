import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '@singz/ui'
import { getLocale } from '../../../shared/i18n'
import type { DriveDeviceChallenge, DriveDeviceFailure } from '../../../shared/drive-device'
import type { DriveSignInResult } from './DriveSignInProvider'
export interface PhoneSignInProps { finish: (result: DriveSignInResult) => void; onClose: () => void }
const words = {
  en: {
    title: 'Connect Google Drive', intro: 'Scan with your phone, then enter this code and approve access.',
    waiting: 'Waiting for approval on your phone…', loading: 'Getting your sign-in code…',
    expires: 'Expires in', cancel: 'Cancel', retry: 'Get a new code', browser: 'Use this device’s browser',
    qr: 'Open Google verification on your phone', code: 'Approval code',
    errors: {
      'not-configured': 'Phone sign-in has not been enabled for this device. Ask the device administrator to complete its sign-in setup.',
      'invalid-client': 'Google could not start phone sign-in. Ask the device administrator to check its sign-in setup.',
      denied: 'Access was declined. You can try again.', expired: 'This code has expired. Get a new code to try again.',
      network: 'Could not reach Google. Check the connection and try again.',
      'invalid-response': 'Google returned an incomplete sign-in response. Please try again.',
      cancelled: 'Sign-in cancelled.', 'save-failed': 'Could not save sign-in on this device. Check its available storage.',
      'unknown-session': 'This sign-in has ended. Get a new code to try again.'
    }
  },
  ru: {
    title: 'Подключить Google Drive', intro: 'Отсканируйте код телефоном, введите код подтверждения и разрешите доступ.',
    waiting: 'Ожидаем подтверждения на телефоне…', loading: 'Получаем код для входа…',
    expires: 'Действует ещё', cancel: 'Отмена', retry: 'Получить новый код', browser: 'Открыть браузер на этом устройстве',
    qr: 'Открыть подтверждение Google на телефоне', code: 'Код подтверждения',
    errors: {
      'not-configured': 'Вход с телефона ещё не настроен. Попросите администратора устройства завершить настройку входа.',
      'invalid-client': 'Google не смог начать вход с телефона. Попросите администратора проверить настройки входа.',
      denied: 'Доступ не разрешён. Можно попробовать снова.', expired: 'Срок действия кода истёк. Получите новый код.',
      network: 'Не удалось связаться с Google. Проверьте подключение и попробуйте снова.',
      'invalid-response': 'Google вернул неполные данные для входа. Попробуйте снова.',
      cancelled: 'Вход отменён.', 'save-failed': 'Не удалось сохранить вход. Проверьте свободное место на устройстве.',
      'unknown-session': 'Этот сеанс входа завершён. Получите новый код.'
    }
  }
}
const copy = () => words[getLocale() === 'ru' ? 'ru' : 'en']
export default function PhoneSignIn({ finish }: PhoneSignInProps): React.JSX.Element {
  const text = copy()
  const [challenge, setChallenge] = useState<DriveDeviceChallenge | null>(null)
  const [error, setError] = useState<DriveDeviceFailure | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [closing, setClosing] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const session = useRef<string | undefined>(undefined)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const close = useCallback(async (): Promise<void> => {
    setClosing(true)
    const result = await window.singz.gdriveDeviceCancel(session.current).catch(() => undefined)
    finish(result?.complete ? { ok: true } : { ok: false, error: copy().errors.cancelled })
  }, [finish])
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    session.current = undefined; setChallenge(null); setError(null)
    cancelButton.current?.focus()
    const poll = async (id: string): Promise<void> => {
      try {
        const state = await window.singz.gdriveDeviceStatus(id)
        if (!active) return
        setNow(Date.now())
        if (state.phase === 'complete') { finish({ ok: true }); return }
        if (state.phase !== 'pending') { setError(state.code ?? 'unknown-session'); return }
        timer = setTimeout(() => { void poll(id) }, 1000)
      } catch { if (active) setError('network') }
    }
    void window.singz.gdriveDeviceStart().then(result => {
      if (!active) {
        if (result.ok) void window.singz.gdriveDeviceCancel(result.challenge.sessionId)
        return
      }
      if (!result.ok) { setError(result.code); return }
      session.current = result.challenge.sessionId
      setChallenge(result.challenge)
      setNow(Date.now())
      timer = setTimeout(() => { void poll(result.challenge.sessionId) }, 1000)
    }).catch(() => { if (active) setError('network') })
    return () => {
      active = false; clearTimeout(timer)
      void window.singz.gdriveDeviceCancel(session.current).catch(() => undefined)
    }
  }, [attempt, finish])
  useEffect(() => {
    const keys = (event: KeyboardEvent): void => {
      if (['Escape', 'BrowserBack', 'GoBack'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); if (!closing) void close(); return
      }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(event.key)) return
      const buttons = [...(content.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!buttons.length) return
      event.preventDefault(); event.stopPropagation()
      const backwards = ['ArrowLeft', 'ArrowUp'].includes(event.key) || (event.key === 'Tab' && event.shiftKey)
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(at + (backwards ? -1 : 1) + buttons.length) % buttons.length].focus()
    }
    window.addEventListener('keydown', keys, true)
    return () => window.removeEventListener('keydown', keys, true)
  }, [close, closing])
  const seconds = challenge ? Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000)) : 0
  return <Modal onClose={() => { if (!closing) void close() }} cardClassName="drive-phone-signin" aria-label={text.title} persistent><div ref={content}>
    <h2>{text.title}</h2>
    {error ? <p role="alert">{text.errors[error]}</p> : challenge ? <>
      <p>{text.intro}</p>
      <div className="drive-phone-body">
        <img className="drive-phone-qr" src={challenge.qrDataUrl} alt={text.qr} width={300} height={300} />
        <div className="drive-phone-instructions">
          <div className="drive-phone-url">{challenge.verificationUrl}</div>
          <div className="drive-phone-code" aria-label={text.code}>{challenge.userCode}</div>
          <p role="status">{text.waiting}</p>
          <p className="fine">{text.expires} {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</p>
        </div>
      </div>
    </> : <p role="status">{text.loading}</p>}
    <div className="drive-phone-actions">
      {error && error !== 'not-configured' && <button type="button" className="pill primary" disabled={closing} onClick={() => setAttempt(n => n + 1)}>{text.retry}</button>}
      <button type="button" className="pill ghost" ref={cancelButton} disabled={closing} onClick={() => void close()}>{text.cancel}</button>

    </div>
  </div></Modal>
}
