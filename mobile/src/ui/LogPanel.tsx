import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { clearLog, fmtTime, formatLog, logEntries, onLogLine, type LogEntry } from '../log'
import { C } from './bits'

/**
 * The desktop's Log dialog, on the phone: the same columns (time, source,
 * line), the same follow-the-tail behaviour, and Share where the desktop has
 * Copy — a phone log is worth nothing until it can leave the phone.
 */
export default function LogPanel({
  visible,
  onClose
}: {
  visible: boolean
  onClose: () => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const body = useRef<ScrollView>(null)
  /** Follow new lines unless the reader scrolled up to look at something. */
  const stick = useRef(true)

  useEffect(() => {
    if (!visible) return
    let alive = true
    void logEntries().then((all) => {
      if (alive) setEntries(all)
    })
    const off = onLogLine((e) => setEntries((prev) => [...prev, e]))
    return () => {
      alive = false
      off()
    }
  }, [visible])

  const share = useCallback(() => {
    void Share.share({ message: formatLog(entries) })
  }, [entries])

  /* On a release build there is no inspector and no run-as: this log is the
     whole record of what happened. One unconfirmed tap used to wipe it. */
  const confirmClear = useCallback(() => {
    Alert.alert('Clear the log?', 'This is the only record of what the app has done.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: () => void clearLog().then(() => setEntries([]))
      }
    ])
  }, [])

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[s.sheet, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 10 }]}>
        <View style={s.head}>
          <Text style={s.title}>Log</Text>
          <Text style={s.count}>{entries.length} lines</Text>
          <View style={s.actions}>
            <Pressable hitSlop={8} onPress={share} accessibilityRole="button" accessibilityLabel="Share the log">
              <Text style={s.link}>Share</Text>
            </Pressable>
            <Pressable
              hitSlop={8}
              onPress={confirmClear}
              accessibilityRole="button"
              accessibilityLabel="Clear the log"
            >
              <Text style={s.link}>Clear</Text>
            </Pressable>
            <Pressable hitSlop={8} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close the log">
              <Text style={s.link}>Close</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView
          ref={body}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
            stick.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 40
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (stick.current) body.current?.scrollToEnd({ animated: false })
          }}
        >
          {entries.length === 0 && <Text style={s.empty}>Nothing logged yet.</Text>}
          {entries.map((e, i) => (
            <View key={`${e.t}-${i}`} style={s.row}>
              <Text style={s.time}>{fmtTime(e.t)}</Text>
              <Text style={s.src}>{e.source}</Text>
              <Text style={[s.msg, e.level !== 'info' && { color: C.red }]}>{e.line}</Text>
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 16 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  title: { color: C.text, fontSize: 20, fontWeight: '700' },
  count: { color: C.dim, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 16, marginLeft: 'auto' },
  link: { color: C.amber, fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 8, paddingVertical: 3, alignItems: 'flex-start' },
  time: { color: C.dim, fontSize: 11, fontVariant: ['tabular-nums'], width: 58 },
  src: { color: C.dim, fontSize: 11, width: 54 },
  msg: { color: C.text, fontSize: 12.5, flex: 1 },
  empty: { color: C.dim, fontSize: 13, paddingVertical: 20, textAlign: 'center' }
})
