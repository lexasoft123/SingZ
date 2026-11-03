import React, { useState } from 'react'
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { TorrentFlow, TorrentViewState } from '../../../src/shared/torrent'
import { C } from './bits'
const size = (bytes: number): string =>
  bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.ceil(bytes / 1000) + ' KB'
export default function TorrentSongSearch({
  flow,
  state
}: {
  flow: TorrentFlow | null
  state: TorrentViewState
}): React.JSX.Element {
  const [artist, setArtist] = useState(state.songArtist),
    [title, setTitle] = useState(state.songTitle)
  const search = (): void => {
    if (!artist.trim() || !title.trim() || state.busy) return
    Keyboard.dismiss()
    void flow?.searchSong(artist, title)
  }
  const progress = state.songProgress
  const button = (label: string, action: () => void, disabled = state.busy) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={action}
      style={[s.button, disabled && { opacity: 0.4 }]}
    >
      <Text style={s.buttonText}>{label}</Text>
    </Pressable>
  )
  return (
    <View style={s.body}>
      <Text style={s.hint}>
        Enter the artist and song. Matching tracks appear here, including songs inside albums and
        discographies.
      </Text>
      <TextInput
        accessibilityLabel="Artist"
        placeholder="Artist, for example Joe Cocker"
        placeholderTextColor={C.dim}
        value={artist}
        onChangeText={setArtist}
        editable={!state.busy}
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={195}
        style={s.input}
        returnKeyType="next"
      />
      <TextInput
        accessibilityLabel="Song title"
        placeholder="Song title, for example First We Take Manhattan"
        placeholderTextColor={C.dim}
        value={title}
        onChangeText={setTitle}
        editable={!state.busy}
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={200}
        style={s.input}
        returnKeyType="search"
        onSubmitEditing={search}
      />
      {button('Find song', search, state.busy || !artist.trim() || !title.trim())}
      <Text style={s.hint}>
        Search checks torrent file lists. Audio downloads when you add a track to the queue.
      </Text>
      {progress && (
        <Text accessibilityRole="text" style={s.hint}>
          {state.busy && progress.stage === 'releases'
            ? 'Finding artist releases…'
            : (progress.stopped ? 'Search stopped. ' : '') +
              'Checked ' +
              progress.checked +
              ' of ' +
              progress.known +
              ' loaded releases.'}{' '}
          {state.songMatches.length} matching tracks · Most seeders first
        </Text>
      )}
      {state.busy &&
        progress &&
        button(
          progress.stopped ? 'Stopping search…' : 'Stop search',
          () => flow?.cancelSongSearch(),
          progress.stopped
        )}
      {state.songMatches.slice(0, 100).map(match => (
        <View key={match.release.id + '-' + match.file.index} style={s.card}>
          <Text style={s.name}>{match.file.name}</Text>
          <Text style={s.hint}>
            {size(match.file.size)} · {match.release.seeders} seeders
          </Text>
          <Text style={s.path}>{match.file.path}</Text>
          <Text style={s.hint}>{match.release.title}</Text>
          {button('Add to queue: ' + match.file.name, () => void flow?.queueSong(match))}
        </View>
      ))}
      {state.songMatches.length > 100 && (
        <Text style={s.hint}>
          Showing the first 100 matches. Use a more specific song title to narrow the results.
        </Text>
      )}
      {!state.busy && progress && !state.songMatches.length && (
        <Text style={s.hint}>
          No matching tracks in the checked releases.
          {progress.hasMore
            ? ' Continue searching more releases.'
            : ' Try another artist spelling or All formats.'}
        </Text>
      )}
      {!state.busy &&
        progress?.hasMore &&
        button(
          'Search more releases',
          () => void flow?.searchSong(state.songArtist, state.songTitle, true)
        )}
    </View>
  )
}
const s = StyleSheet.create({
  body: { gap: 12 },
  hint: { color: C.dim, fontSize: 13, lineHeight: 19 },
  name: { color: C.text, fontSize: 16, fontWeight: '600' },
  path: { color: C.dim, fontSize: 12, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: 12,
    padding: 14,
    color: C.text,
    fontSize: 16
  },
  card: { borderWidth: 1, borderColor: C.hairline, borderRadius: 12, padding: 14, gap: 10 },
  button: { borderRadius: 10, padding: 14, alignItems: 'center', backgroundColor: C.amber },
  buttonText: { color: C.bg, fontSize: 14, fontWeight: '600' }
})
