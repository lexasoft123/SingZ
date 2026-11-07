export type JourneyPage =
  | 'home'
  | 'setup'
  | 'network'
  | 'phones'
  | 'storage'
  | 'diagnostics'
  | 'system'
  | 'privacy'

export type SafeAreaPercent = 0 | 3 | 5

export interface JourneyHubProps {
  active?: boolean
  initialPage?: JourneyPage
  onBack: () => void
  onOpenAudio: () => void
  onOpenCollection: () => void
  onSignOut?: () => Promise<boolean>
  onLibraryChanged: () => void
  activeProjectDir: string | null
  playbackActive: boolean
  onSafeAreaChange: (percent: SafeAreaPercent) => void
}

export interface JourneyHubHandle {
  back(): boolean
  open(page: JourneyPage): void
  isInteractionLocked(): boolean
}
