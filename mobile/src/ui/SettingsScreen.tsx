import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { iosNativePlayback } from '../playback/native';
import { C } from './bits';

export default function SettingsScreen({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [supported, setSupported] = useState(false);
  const [detail, setDetail] = useState('Checking native playback…');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    const status = await iosNativePlayback.settingsStatus();
    setEnabled(status.enabled);
    setSupported(status.supported);
    setDetail(status.detail);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (next: boolean): Promise<void> => {
      setEnabled(next);
      setSaving(true);
      try {
        await iosNativePlayback.saveEnabled(next);
        await refresh();
      } catch (error) {
        setEnabled(!next);
        setDetail(error instanceof Error ? error.message : String(error));
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  return (
    <View style={[s.root, { paddingTop: insets.top + 8 }]}>
      <View style={s.header}>
        <Text style={s.title}>Settings</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close Settings"
          onPress={onClose}
          hitSlop={12}
        >
          <Text style={s.close}>Done</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.section}>AUDIO</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={s.copy}>
              <View style={s.experimentalRow}>
                <Text style={s.name}>Native playback</Text>
                <Text style={s.badge}>EXPERIMENTAL</Text>
              </View>
              <Text style={s.description}>
                {Platform.OS === 'ios'
                  ? 'Play eligible WAV/FLAC stem projects through zcore + zdsp. This first cut starts at the beginning and stops; seek, loop, tempo, transpose and metronome stay on the regular player.'
                  : 'This experiment is currently available on iPhone only.'}
              </Text>
            </View>
            {loading ? (
              <ActivityIndicator color={C.amber} />
            ) : (
              <Switch
                value={enabled}
                disabled={saving || (!supported && !enabled)}
                onValueChange={next => void toggle(next)}
                trackColor={{ false: '#4a4339', true: '#7c511d' }}
                thumbColor={enabled ? C.amber : '#b5aa98'}
                accessibilityLabel="Enable experimental native playback"
              />
            )}
          </View>
          <View style={s.divider} />
          <Text style={[s.status, !supported && s.statusUnavailable]}>
            {detail}
          </Text>
          {enabled && supported && (
            <Text style={s.note}>
              Eligible songs open in a clearly limited native player. Other
              songs remain entirely on the regular player.
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    minHeight: 52,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: C.text, fontSize: 28, fontWeight: '800' },
  close: { color: C.amber, fontSize: 16, fontWeight: '700' },
  content: { padding: 20, paddingBottom: 48 },
  section: {
    color: C.dim,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 9,
  },
  card: {
    borderRadius: 18,
    padding: 18,
    backgroundColor: '#17130f',
    borderWidth: 1,
    borderColor: '#3a332a',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  copy: { flex: 1 },
  experimentalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  name: { color: C.text, fontSize: 18, fontWeight: '700' },
  badge: {
    color: C.amber,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    borderWidth: 1,
    borderColor: '#8a571b',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  description: { color: C.dim, fontSize: 14, lineHeight: 20, marginTop: 8 },
  divider: { height: 1, backgroundColor: '#332c24', marginVertical: 16 },
  status: { color: '#d2c8b6', fontSize: 13, lineHeight: 18 },
  statusUnavailable: { color: '#d9907f' },
  note: { color: C.dim, fontSize: 12, lineHeight: 17, marginTop: 10 },
});
