import { useState } from 'react'
import { createLazyDialogRoute } from './LazyDialogRoute'
import { t } from '../i18n'
import type { DriveProjectsProps } from './DriveProjects'
const DriveProjects = createLazyDialogRoute<DriveProjectsProps>([
  // @ts-expect-error Vite recovery module identity.
  () => import('./DriveProjects?dialog-route=primary'),
  // @ts-expect-error Vite recovery module identity.
  () => import('./DriveProjects?dialog-route=recovery')
], {
  get name() { return t('library.drive.title') },
  get opening() { return t('app.dialog.setupModal.opening') },
  get failureTitle() { return t('app.dialog.setupModal.failureTitle') },
  get failureMessage() { return t('app.dialog.setupModal.failureMessage') }
})
export default function DriveProjectsButton({ onOpen }: { onOpen: (path: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="src-link" onClick={() => setOpen(true)}>{t('library.drive.title')}</button>
    {open && <DriveProjects onOpen={onOpen} onClose={() => setOpen(false)} />}
  </>
}
