import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { TorrentJob, TorrentQueue } from '../../../src/shared/torrent'
import { C } from './bits'
export default function TorrentDownloads({
  queue,
  busy,
  onPause,
  onResume,
  onRemove,
  onAdd,
  onBrowse
}: {
  queue: TorrentQueue
  busy: boolean
  onPause: () => void
  onResume: () => void
  onRemove: (job: TorrentJob) => void
  onAdd: (job: TorrentJob) => void
  onBrowse: () => void
}): React.JSX.Element {
  const action = (label: string, run: () => void, primary = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy}
      onPress={run}
      style={[s.button, primary && s.primary, busy && { opacity: 0.4 }]}
    >
      <Text style={[s.buttonText, primary && { color: C.bg }]}>{label}</Text>
    </Pressable>
  )
  const waiting = queue.downloads.filter(j => j.state !== 'complete'),
    ready = queue.downloads.filter(j => j.state === 'complete')
  return (
    <View style={s.section}>
      <Text style={s.title}>Downloads</Text>
      <Text style={s.hint}>
        One song downloads at a time. Completed files stay here until you remove them.
      </Text>
      {action('Find more songs', onBrowse)}
      {waiting.length > 0 && (
        <>
          <Text style={s.heading}>Download queue · {waiting.length}</Text>
          {action(
            queue.paused ? 'Resume queue' : 'Pause queue',
            queue.paused ? onResume : onPause,
            true
          )}
          {waiting.map(j => (
            <View key={j.release + '-' + j.index} style={s.card}>
              <Text style={s.name}>{j.name}</Text>
              <Text style={s.hint}>
                {j.state === 'queued'
                  ? 'Queued'
                  : j.state === 'paused'
                    ? 'Paused'
                    : j.state === 'error'
                      ? 'Needs attention'
                      : j.state === 'verifying'
                        ? 'Finishing'
                        : Math.min(100, Math.floor((j.done / j.size) * 100)) + '% downloaded'}{' '}
                · {(j.size / 1e6).toFixed(1)} MB
              </Text>
              {j.error ? <Text style={s.error}>{j.error}</Text> : null}
              {action('Cancel ' + j.name, () => onRemove(j))}
            </View>
          ))}
        </>
      )}
      <Text style={s.heading}>Ready to add · {ready.length}</Text>
      <Text style={s.hint}>
        Closing or cancelling Add song keeps the downloaded original safe here.
      </Text>
      {ready.map(j => (
        <View key={j.release + '-' + j.index} style={s.card}>
          <Text style={s.name}>{j.name}</Text>
          <Text style={s.hint}>{(j.size / 1e6).toFixed(1)} MB · Downloaded</Text>
          {action('Add song: ' + j.name, () => onAdd(j), true)}
          {action('Remove download: ' + j.name, () => onRemove(j))}
        </View>
      ))}
      {!queue.downloads.length && <Text style={s.hint}>No downloads yet.</Text>}
    </View>
  )
}
const s = StyleSheet.create({
  section: { gap: 12 },
  title: { fontSize: 26, fontWeight: '700', color: C.text },
  heading: { fontSize: 17, fontWeight: '700', color: C.text, marginTop: 10 },
  name: { fontSize: 16, fontWeight: '600', color: C.text },
  hint: { fontSize: 13, lineHeight: 19, color: C.dim },
  error: { color: '#d66', fontSize: 13 },
  card: {
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: 12,
    padding: 14,
    gap: 10
  },
  button: {
    padding: 12,
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: 10,
    alignItems: 'center'
  },
  primary: { backgroundColor: C.amber, borderColor: C.amber },
  buttonText: { color: C.text, fontSize: 14, fontWeight: '600' }
})
