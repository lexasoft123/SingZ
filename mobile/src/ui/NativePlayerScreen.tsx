import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fmtTime, TRACK_META } from '../model';
import {
  releaseProject,
  type LoadedProject,
  type NativePlaybackViewState,
} from '../projects';
import { C, splitSongName, StemTile } from './bits';

export default function NativePlayerScreen({
  active,
  project,
  onBack,
  onFallback,
}: {
  active: boolean;
  project: LoadedProject;
  onBack: () => void;
  onFallback: (project: LoadedProject) => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const handle = project.nativePlayback;
  if (!handle)
    throw new Error('NativePlayerScreen requires a native playback project.');
  const [state, setState] = useState<NativePlaybackViewState>(() =>
    handle.snapshot(),
  );
  const [commandError, setCommandError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => handle.subscribe(() => setState(handle.snapshot())),
    [handle],
  );

  useEffect(() => {
    if (!active)
      void handle.stop('Songs tab hidden').catch(error => {
        if (mounted.current)
          setCommandError(
            error instanceof Error ? error.message : String(error),
          );
      });
  }, [active, handle]);

  useEffect(
    () => () => {
      mounted.current = false;
      void handle.unload('native player unmounted').catch(() => undefined);
    },
    [handle],
  );

  const start = useCallback(async (): Promise<void> => {
    setCommandError(null);
    try {
      const outcome = await handle.start();
      if (!mounted.current) {
        if (outcome.kind === 'fallback') releaseFallback(outcome.project);
        return;
      }
      if (outcome.kind === 'fallback') onFallback(outcome.project);
      else if (outcome.kind === 'failed') setCommandError(outcome.error);
    } catch (error) {
      if (mounted.current)
        setCommandError(error instanceof Error ? error.message : String(error));
    }
  }, [handle, onFallback]);

  const back = useCallback(async (): Promise<void> => {
    setCommandError(null);
    try {
      await handle.unload('left native player');
      if (mounted.current) onBack();
    } catch (error) {
      if (mounted.current)
        setCommandError(error instanceof Error ? error.message : String(error));
    }
  }, [handle, onBack]);

  const stopping = state.phase === 'starting' || state.phase === 'stopping';
  const playing = state.phase === 'playing';
  const canStart = state.phase === 'prepared' || state.phase === 'stopped';
  const progress =
    state.durationSec > 0
      ? Math.max(0, Math.min(1, state.positionSec / state.durationSec))
      : 0;
  const song = splitSongName(project.name);

  return (
    <View
      style={[
        s.root,
        { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 },
      ]}
    >
      <View style={s.header}>
        <Pressable
          onPress={() => void back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back to library"
        >
          <Text style={s.back}>‹</Text>
        </Pressable>
        <StemTile hue={0} size={42} />
        <View style={s.headerCopy}>
          <Text style={s.title} numberOfLines={1}>
            {song.title}
          </Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {song.artist ?? 'SingZ project'}
          </Text>
        </View>
        <Text style={s.badge}>NATIVE · EXPERIMENTAL</Text>
      </View>

      <ScrollView contentContainerStyle={s.content}>
        <View style={s.hero}>
          <Text style={s.heroTitle}>Frame-zero DSP playback</Text>
          <Text style={s.heroCopy}>
            This MVP plays the complete stem mix from the beginning through
            zcore + zdsp. Stop is supported. Seek, pause, loop, metronome, tempo
            and transpose are intentionally unavailable here.
          </Text>
        </View>

        <View style={s.progressCard}>
          <View style={s.timeRow}>
            <Text style={s.time}>{fmtTime(state.positionSec)}</Text>
            <Text style={s.phase}>{phaseLabel(state)}</Text>
            <Text style={s.time}>{fmtTime(state.durationSec)}</Text>
          </View>
          <View style={s.track}>
            <View style={[s.fill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={s.telemetry}>
            generation {state.generation} · audible{' '}
            {state.audibleFrames.toLocaleString()} frames
          </Text>
        </View>

        <Text style={s.section}>DSP LANES</Text>
        <View style={s.lanes}>
          {handle.lanes.map(lane => (
            <View key={lane.id} style={s.lane}>
              <View
                style={[
                  s.dot,
                  {
                    backgroundColor:
                      lane.color ?? TRACK_META[lane.id]?.color ?? C.dim,
                  },
                ]}
              />
              <Text style={s.laneName}>{lane.label}</Text>
              <Text style={s.laneFrames}>
                {lane.totalFrames.toLocaleString()} frames
              </Text>
            </View>
          ))}
        </View>

        {(state.error || commandError) && (
          <View style={s.errorBox}>
            <Text style={s.errorTitle}>Native playback stopped</Text>
            <Text style={s.error}>{state.error ?? commandError}</Text>
          </View>
        )}
      </ScrollView>

      <View style={s.controls}>
        {stopping ? (
          <View style={s.action}>
            <ActivityIndicator color="#17110a" />
          </View>
        ) : playing ? (
          <Pressable
            style={s.action}
            onPress={() => void handle.stop('user stopped')}
            accessibilityRole="button"
            accessibilityLabel="Stop native playback"
          >
            <View style={s.stopGlyph} />
            <Text style={s.actionText}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[s.action, !canStart && s.actionDisabled]}
            disabled={!canStart}
            onPress={() => void start()}
            accessibilityRole="button"
            accessibilityLabel="Start native playback from the beginning"
          >
            <Text style={s.playGlyph}>▶</Text>
            <Text style={s.actionText}>Start from beginning</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function releaseFallback(project: LoadedProject): void {
  // The route vanished after the coordinator's final ownership check but
  // before React received the fallback outcome. No owner can adopt this PCM.
  releaseProject(project);
}

function phaseLabel(state: NativePlaybackViewState): string {
  if (state.phase === 'prepared') return 'READY AT 0:00';
  if (state.phase === 'starting') return 'OPENING OUTPUT';
  if (state.phase === 'playing') return 'NATIVE DSP';
  if (state.phase === 'stopping') return 'STOPPING';
  if (state.phase === 'stopped') return 'STOPPED · RESTARTS AT 0:00';
  return state.terminalReason !== 'none'
    ? state.terminalReason.toUpperCase()
    : 'NEEDS ATTENTION';
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    paddingHorizontal: 18,
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  back: { color: C.text, fontSize: 42, lineHeight: 46, marginRight: 2 },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: C.text, fontSize: 19, fontWeight: '800' },
  subtitle: { color: C.dim, fontSize: 12, marginTop: 2 },
  badge: {
    color: C.amber,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.8,
    borderColor: '#80511c',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  content: { padding: 20, paddingBottom: 130 },
  hero: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#493821',
    backgroundColor: '#18130e',
    padding: 20,
  },
  heroTitle: { color: C.text, fontSize: 22, fontWeight: '800' },
  heroCopy: { color: C.dim, fontSize: 14, lineHeight: 21, marginTop: 9 },
  progressCard: {
    marginTop: 18,
    borderRadius: 18,
    backgroundColor: '#120f0c',
    padding: 16,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  time: { color: '#d7cbb7', fontSize: 13, fontVariant: ['tabular-nums'] },
  phase: { color: C.amber, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  track: {
    height: 7,
    backgroundColor: '#3d352b',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 13,
  },
  fill: { height: 7, backgroundColor: C.amber, borderRadius: 4 },
  telemetry: {
    color: C.dim,
    fontSize: 11,
    marginTop: 10,
    fontVariant: ['tabular-nums'],
  },
  section: {
    color: C.dim,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.4,
    marginTop: 25,
    marginBottom: 8,
  },
  lanes: {
    borderRadius: 17,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#342d25',
  },
  lane: {
    minHeight: 48,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#15120f',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#342d25',
  },
  dot: { width: 9, height: 9, borderRadius: 5, marginRight: 10 },
  laneName: { color: C.text, fontSize: 14, fontWeight: '700', flex: 1 },
  laneFrames: { color: C.dim, fontSize: 11, fontVariant: ['tabular-nums'] },
  errorBox: {
    marginTop: 18,
    borderRadius: 16,
    backgroundColor: '#2b1712',
    borderWidth: 1,
    borderColor: '#74382b',
    padding: 16,
  },
  errorTitle: { color: '#ff9b84', fontWeight: '800', fontSize: 15 },
  error: { color: '#e9b2a6', marginTop: 6, fontSize: 13, lineHeight: 19 },
  controls: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 18,
    alignItems: 'center',
  },
  action: {
    minHeight: 58,
    minWidth: 230,
    paddingHorizontal: 24,
    borderRadius: 29,
    backgroundColor: C.amber,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  actionDisabled: { opacity: 0.35 },
  actionText: { color: '#17110a', fontSize: 15, fontWeight: '900' },
  playGlyph: { color: '#17110a', fontSize: 19 },
  stopGlyph: {
    width: 15,
    height: 15,
    borderRadius: 2,
    backgroundColor: '#17110a',
  },
});
