import { useIsFocused, useNavigation } from '@react-navigation/native'
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { AppState, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import { Canvas, LinearGradient, Rect, useCanvasRef, vec } from '@shopify/react-native-skia'
import { KIT } from './tokens'

const BACKGROUND = ['#694528', '#392819', KIT.bg]
const CLEAR = 'rgba(18,15,11,0)'
const TOP_FADE = [KIT.bg, CLEAR]
const BOTTOM_FADE = [CLEAR, KIT.bg]

function VerticalGradient({ colors, style, testID, canvasRef }: { colors: string[]; style: StyleProp<ViewStyle>; testID?: string; canvasRef?: ReturnType<typeof useCanvasRef> }): React.JSX.Element {
  const [size, setSize] = useState({ width: 0, height: 0 })
  return (
    <View
      pointerEvents="none"
      testID={testID}
      style={style}
      onLayout={({ nativeEvent: { layout } }) => setSize(previous =>
        previous.width === layout.width && previous.height === layout.height
          ? previous
          : { width: layout.width, height: layout.height }
      )}
    >
      <Canvas ref={canvasRef} style={StyleSheet.absoluteFill}>
        <Rect x={0} y={0} width={size.width} height={size.height}>
          <LinearGradient start={vec(0, 0)} end={vec(0, Math.max(1, size.height))} colors={colors} />
        </Rect>
      </Canvas>
    </View>
  )
}

/** A smooth fade over the actual scene height, with no stretched bitmap texture. */
export const ScreenBackground = React.memo(function ScreenBackground({ style }: { style?: StyleProp<ViewStyle> }): React.JSX.Element {
  return <VerticalGradient colors={BACKGROUND} style={style ?? StyleSheet.absoluteFill} testID="scene-background" />
})

/** Hide scrolling lyrics beneath the player controls without a raster overlay. */
export function ScreenScrim({ edge, style }: { edge: 'top' | 'bottom'; style: StyleProp<ViewStyle> }): React.JSX.Element {
  const focused = useIsFocused()
  const navigation = useNavigation()
  const canvasRef = useCanvasRef()
  useEffect(() => {
    if (!focused) return
    let frame: number | undefined
    const redraw = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = undefined; canvasRef.current?.redraw() })
    }
    // The stage's initial appearance may be a transition on its parent stack.
    // Paint after that native transition, not while its Metal layer is hidden.
    type TransitionNavigation = { addListener(event: 'transitionEnd', listener: () => void): () => void; getParent(): TransitionNavigation | undefined }
    const unsubscribe: (() => void)[] = []
    let current = navigation as unknown as TransitionNavigation | undefined
    while (current) { unsubscribe.push(current.addListener('transitionEnd', redraw)); current = current.getParent() }
    const appState = AppState.addEventListener('change', state => { if (state === 'active') redraw() })
    redraw()
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      unsubscribe.forEach(remove => remove())
      appState.remove()
    }
  }, [focused, navigation, canvasRef])
  return <VerticalGradient colors={edge === 'top' ? TOP_FADE : BOTTOM_FADE} style={style} canvasRef={canvasRef} />
}

const TabBarLayoutContext = createContext<((event: LayoutChangeEvent) => void) | undefined>(undefined)

/** Keep the static drawing surface outside retained native screens. A hidden
 * Metal surface can drop a redraw; switching tabs must never hide this one. */
export function SceneBackgroundRoot({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [tabBarHeight, setTabBarHeight] = useState(0)
  const onTabBarLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.ceil(event.nativeEvent.layout.height)
    setTabBarHeight(previous => previous === next ? previous : next)
  }, [])
  // Match the former scene-sized gradient, rather than stretching it beneath
  // the tab bar and changing its colours on every screen.
  const backgroundStyle = useMemo(() => [StyleSheet.absoluteFill, { bottom: tabBarHeight }], [tabBarHeight])
  return <TabBarLayoutContext.Provider value={onTabBarLayout}>
    <View style={{ flex: 1 }}>
      <ScreenBackground style={backgroundStyle} />
      {children}
    </View>
  </TabBarLayoutContext.Provider>
}

export function useSceneTabBarLayout(): ((event: LayoutChangeEvent) => void) | undefined {
  return useContext(TabBarLayoutContext)
}
