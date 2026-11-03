import React, { useState } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia'
import { KIT } from './tokens'

const BACKGROUND = ['#694528', '#392819', KIT.bg]
const CLEAR = 'rgba(18,15,11,0)'
const TOP_FADE = [KIT.bg, CLEAR]
const BOTTOM_FADE = [CLEAR, KIT.bg]

function VerticalGradient({ colors, style }: { colors: string[]; style: StyleProp<ViewStyle> }): React.JSX.Element {
  const [size, setSize] = useState({ width: 0, height: 0 })
  return (
    <View
      pointerEvents="none"
      style={style}
      onLayout={({ nativeEvent: { layout } }) => setSize(previous =>
        previous.width === layout.width && previous.height === layout.height
          ? previous
          : { width: layout.width, height: layout.height }
      )}
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Rect x={0} y={0} width={size.width} height={size.height}>
          <LinearGradient start={vec(0, 0)} end={vec(0, Math.max(1, size.height))} colors={colors} />
        </Rect>
      </Canvas>
    </View>
  )
}

/** A smooth fade over the actual scene height, with no stretched bitmap texture. */
export const ScreenBackground = React.memo(function ScreenBackground(): React.JSX.Element {
  return <VerticalGradient colors={BACKGROUND} style={StyleSheet.absoluteFill} />
})

/** Hide scrolling lyrics beneath the player controls without a raster overlay. */
export function ScreenScrim({ edge, style }: { edge: 'top' | 'bottom'; style: StyleProp<ViewStyle> }): React.JSX.Element {
  return <VerticalGradient colors={edge === 'top' ? TOP_FADE : BOTTOM_FADE} style={style} />
}
