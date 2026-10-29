import { useWindowDimensions } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { mobileLayout } from './layout'

// App's horizontal SafeAreaView reserves scene-owned system areas. Individual
// routes still own their top padding; bottom space belongs to BottomTabs.
export function useMobileLayout() {
  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  return {
    width: window.width - insets.left - insets.right,
    height: window.height - insets.top - insets.bottom,
    fontScale: window.fontScale,
    ...mobileLayout(window.width - insets.left - insets.right, window.height - insets.top - insets.bottom, window.fontScale),
    top: insets.top + 8
  }
}
