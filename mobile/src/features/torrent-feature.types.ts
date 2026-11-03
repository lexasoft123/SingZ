import type { StyleProp, TextStyle } from 'react-native'
import type { PickedFile } from '../writer'
export interface TorrentScreenProps {
  onClose: () => void
  onImport: (file: PickedFile) => void
}
export interface TorrentEntryProps {
  onPress: () => void
  textStyle: StyleProp<TextStyle>
  separatorStyle: StyleProp<TextStyle>
}
