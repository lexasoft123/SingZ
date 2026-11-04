import React from 'react'
import { HeaderAction } from '@singz/ui/native'

/** App-facing name for the shared UIKit header action. */
export function HeaderIconButton({ label, onPress, children }: {
  label: string
  onPress: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return <HeaderAction label={label} onPress={onPress}>{children}</HeaderAction>
}
