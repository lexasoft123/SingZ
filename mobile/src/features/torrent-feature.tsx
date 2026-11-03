import React from 'react'
import { Pressable, Text } from 'react-native'
import type { TorrentEntryProps } from './torrent-feature.types'
export { default as TorrentScreen } from '../ui/TorrentScreen'
export const torrentsEnabled = true
export function TorrentEntry({ onPress, textStyle, separatorStyle }: TorrentEntryProps): React.JSX.Element {
  return <>
    <Text style={separatorStyle}>·</Text>
    <Pressable accessibilityRole="button" hitSlop={8} onPress={onPress}>
      <Text style={textStyle}>Search RuTracker</Text>
    </Pressable>
  </>
}
