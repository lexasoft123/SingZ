import React from 'react'
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs'
import { StyleSheet, View } from 'react-native'
import { C, MicGlyph } from './bits'
import { GlassTab, GlassTabBar } from './uikit/native/index.js'

export type RootTab = 'songs' | 'training'
export type RootTabParamList = {
  songs: undefined
  training: undefined
}

const tabMeta: Record<RootTab, { label: string; icon: 'songs' | 'train' }> = {
  songs: { label: 'Songs', icon: 'songs' },
  training: { label: 'Train', icon: 'train' }
}

function isRootTab(name: string): name is RootTab {
  return name === 'songs' || name === 'training'
}

export default function BottomTabs({
  state,
  descriptors,
  navigation,
  insets
}: BottomTabBarProps): React.JSX.Element {
  return (
    <View style={[styles.ground, { paddingBottom: Math.max(6, insets.bottom) }]}>
      <GlassTabBar>
        {state.routes.map((route, index) => {
          if (!isRootTab(route.name)) return null
          const tab = route.name
          const selected = state.index === index
          const options = descriptors[route.key].options
          const fallback = tabMeta[tab]
          const label = typeof options.tabBarLabel === 'string' ? options.tabBarLabel : options.title ?? fallback.label
          return (
            <GlassTab
              key={route.key}
              label={label}
              accessibilityLabel={options.tabBarAccessibilityLabel ?? label}
              testID={options.tabBarButtonTestID}
              selected={selected}
              icon={fallback.icon === 'train' ? <MicGlyph color={selected ? C.amber : C.dim} /> : <SongGlyph color={selected ? C.amber : C.dim} />}
              onPress={() => {
                // Re-selecting a retained audio scene must not pop its stack or
                // restart transport. Only real tab changes enter the router.
                if (selected) return
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true
                })
                if (event.defaultPrevented) return
                navigation.navigate(route.name, route.params)
              }}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
            />
          )
        })}
      </GlassTabBar>
    </View>
  )
}

function SongGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ width: 19, height: 19 }}>
      {[2, 8, 14].map((left, index) => (
        <View
          key={left}
          style={{
            position: 'absolute',
            left,
            top: 3 + index * 2,
            width: 3,
            height: 12 - index * 2,
            borderRadius: 2,
            backgroundColor: color
          }}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  ground: {
    paddingTop: 7,
    paddingHorizontal: 10,
    backgroundColor: C.bg
  }
})
