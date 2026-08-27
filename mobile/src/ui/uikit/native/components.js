import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { nativeGlassStyle, useNativeTheme } from './theme.js';
export function GlassSurface({ radius = 24, elevation = 'surface', style, children, ...props }) {
    const theme = useNativeTheme();
    return _jsx(View, { ...props, style: [nativeGlassStyle(theme, elevation), { borderRadius: radius }, style], children: children });
}
export function GlassHeader({ title, onBack, backLabel = 'Back', trailing }) {
    const theme = useNativeTheme();
    return (_jsxs(GlassSurface, { radius: 31, style: s.header, children: [_jsx(Pressable, { collapsable: false, accessibilityRole: "button", accessibilityLabel: backLabel, hitSlop: 10, pressRetentionOffset: 12, onPress: onBack, style: ({ pressed }) => [s.headerAction, pressed && s.pressed], children: _jsx(Text, { pointerEvents: "none", style: [s.backChevron, { color: theme.text }], children: "\u2039" }) }), _jsx(Text, { pointerEvents: "none", accessibilityRole: "header", style: [s.headerTitle, { color: theme.text }], children: title }), _jsx(View, { pointerEvents: "box-none", style: s.headerTrailing, children: trailing })] }));
}
export function ChoiceChip({ label, selected = false, disabled = false, onPress, style }) {
    const theme = useNativeTheme();
    return (_jsx(Pressable, { accessibilityRole: "button", accessibilityState: { selected, disabled }, disabled: disabled, onPress: onPress, style: ({ pressed }) => [
            s.chip,
            { backgroundColor: theme.controlFill, borderColor: theme.controlLine, borderTopColor: theme.controlRim },
            selected && { borderColor: theme.accent, borderTopColor: theme.accent, backgroundColor: theme.accentSoft },
            disabled && s.disabled,
            pressed && s.pressed,
            style
        ], children: _jsx(Text, { style: [s.chipText, { color: selected ? theme.accent : theme.dim }], children: label }) }));
}
export function PrimaryAction({ label, icon, onPress, disabled = false, style }) {
    const theme = useNativeTheme();
    return (_jsxs(Pressable, { accessibilityRole: "button", accessibilityLabel: label, disabled: disabled, onPress: onPress, style: ({ pressed }) => [s.primary, { backgroundColor: theme.accent }, disabled && s.disabled, pressed && s.pressed, style], children: [icon, _jsx(Text, { style: [s.primaryText, { color: theme.accentInk }], children: label })] }));
}
export function RoundAction({ label, icon, onPress, size = 54, backgroundColor, disabled = false }) {
    const theme = useNativeTheme();
    return (_jsx(Pressable, { accessibilityRole: "button", accessibilityLabel: label, hitSlop: 8, disabled: disabled, onPress: onPress, style: ({ pressed }) => ({
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: pressed ? theme.controlRim : backgroundColor ?? theme.controlFill,
            opacity: disabled ? 0.35 : 1,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: theme.controlLine
        }), children: icon }));
}
export function SettingsCard({ children, style }) {
    return _jsx(GlassSurface, { radius: 26, style: [s.settingsCard, style], children: children });
}
export function Hairline() {
    const theme = useNativeTheme();
    return _jsx(View, { style: [s.hairline, { backgroundColor: theme.line }] });
}
export function SettingsRow({ label, value, expanded = false, onPress }) {
    const theme = useNativeTheme();
    return (_jsxs(Pressable, { accessibilityRole: "button", accessibilityState: { expanded }, onPress: onPress, style: ({ pressed }) => [s.settingsRow, pressed && s.pressed], children: [_jsx(Text, { style: [s.settingsLabel, { color: theme.dim }], children: label }), _jsxs(View, { style: s.settingsValueRow, children: [_jsx(Text, { numberOfLines: 1, style: [s.settingsValue, { color: theme.text }], children: value }), _jsx(Text, { style: [s.settingsChevron, { color: theme.accent }], children: expanded ? '⌃' : '›' })] })] }));
}
export function StickyActionFooter({ children, style }) {
    const theme = useNativeTheme();
    return _jsx(View, { style: [s.stickyFooter, { backgroundColor: theme.footerFill, borderTopColor: theme.line, shadowColor: theme.shadow }, style], children: children });
}
export function GlassTabBar({ children, style }) {
    return _jsx(GlassSurface, { radius: 32, elevation: "dock", accessibilityRole: "tablist", style: [s.tabBar, style], children: children });
}
export function GlassTab({ label, accessibilityLabel = label, selected, icon, onPress, onLongPress, testID }) {
    const theme = useNativeTheme();
    const color = selected ? theme.accent : theme.dim;
    return (_jsxs(Pressable, { accessibilityRole: "tab", accessibilityLabel: accessibilityLabel, accessibilityState: { selected }, testID: testID, onPress: onPress, onLongPress: onLongPress, style: ({ pressed }) => [s.tab, selected && { backgroundColor: theme.accentSoft, borderWidth: 1, borderColor: theme.controlRim }, pressed && s.pressed], children: [icon, _jsx(Text, { style: [s.tabLabel, { color }], children: label })] }));
}
export function FeatureCard({ title, description, glyph, onPress }) {
    const theme = useNativeTheme();
    return (_jsxs(Pressable, { accessibilityRole: "button", onPress: onPress, style: ({ pressed }) => [nativeGlassStyle(theme), s.featureCard, pressed && s.pressed], children: [_jsx(View, { pointerEvents: "none", style: s.featureGlyphRail, children: _jsx(View, { style: s.featureGlyph, children: glyph }) }), _jsxs(View, { style: s.featureCopy, children: [_jsx(Text, { style: [s.featureTitle, { color: theme.text }], children: title }), _jsx(Text, { style: [s.featureDescription, { color: theme.dim }], children: description })] })] }));
}
export function ListEntry({ title, detail, trailing, onPress }) {
    const theme = useNativeTheme();
    return (_jsxs(Pressable, { accessibilityRole: "button", onPress: onPress, style: ({ pressed }) => [nativeGlassStyle(theme), s.listEntry, pressed && s.pressed], children: [_jsxs(View, { style: s.listEntryCopy, children: [_jsx(Text, { style: [s.featureTitle, { color: theme.text }], children: title }), _jsx(Text, { style: [s.featureDescription, { color: theme.dim }], children: detail })] }), trailing ?? _jsx(Text, { style: [s.listChevron, { color: theme.accent }], children: "\u203A" })] }));
}
export function ReferenceControls(props) {
    const theme = useNativeTheme();
    const position = Math.max(0, Math.min(1, props.volumePosition));
    const minPercent = props.volumeMinPercent ?? 0;
    const maxPercent = props.volumeMaxPercent ?? 100;
    return (_jsxs(GlassSurface, { radius: 25, accessibilityRole: "adjustable", accessibilityLabel: "Reference sound volume", accessibilityValue: { min: minPercent, max: maxPercent, now: props.volumePercent, text: `${props.volumePercent} percent` }, style: s.referencePanel, children: [_jsxs(View, { style: s.referenceHeader, children: [_jsxs(View, { children: [_jsx(Text, { style: [s.utilityLabel, { color: theme.dim }], children: "REFERENCE SOUND" }), _jsxs(Text, { style: [s.referenceValue, { color: theme.text }], children: [props.volumePercent, "%"] })] }), _jsxs(Pressable, { accessibilityRole: "button", accessibilityLabel: props.testLabel, disabled: props.testing, onPress: props.onTest, style: ({ pressed }) => [s.referenceTest, { backgroundColor: theme.accent }, (pressed || props.testing) && s.pressed], children: [props.testIcon, _jsx(Text, { style: [s.referenceTestText, { color: theme.accentInk }], children: props.testing ? 'Playing…' : props.testLabel })] })] }), _jsxs(View, { style: s.referenceVolumeRow, children: [_jsx(RoundAction, { label: "Decrease reference volume", icon: _jsx(Text, { style: [s.referenceStepText, { color: theme.text }], children: "\u2212" }), onPress: props.onDecrease, size: 48, disabled: props.decreaseDisabled }), _jsx(View, { style: [s.referenceTrack, { backgroundColor: theme.controlLine }], children: _jsx(View, { style: [s.referenceFill, { width: `${Math.round(position * 100)}%`, backgroundColor: theme.accent }] }) }), _jsx(RoundAction, { label: "Increase reference volume", icon: _jsx(Text, { style: [s.referenceStepText, { color: theme.text }], children: "+" }), onPress: props.onIncrease, size: 48, disabled: props.increaseDisabled })] }), props.hint && _jsx(Text, { style: [s.referenceHint, { color: theme.dim }], children: props.hint }), props.pitchWindow && _jsxs(_Fragment, { children: [_jsx(Hairline, {}), _jsxs(View, { style: s.pitchWindow, children: [_jsxs(View, { children: [_jsx(Text, { style: [s.utilityLabel, { color: theme.dim }], children: "PITCH WINDOW" }), _jsxs(Text, { style: [s.pitchWindowValue, { color: theme.text }], children: ["\u00B1", props.pitchWindow.value, "\u00A2"] })] }), _jsx(View, { style: s.choiceRow, children: props.pitchWindow.options.map((value) => _jsx(ChoiceChip, { label: `±${value}¢`, selected: props.pitchWindow?.value === value, onPress: () => props.pitchWindow?.onChange(value) }, value)) })] })] })] }));
}
export function PitchTarget({ noteName, eyebrow, sequence = [], testID, style }) {
    const theme = useNativeTheme();
    const match = /^(.*?)(-?\d+)$/.exec(noteName);
    const pitch = match?.[1] ?? noteName;
    const octave = match?.[2] ?? '';
    const octaveOffset = pitch.length > 1 ? 76 : 58;
    const activeSequenceIndex = sequence.findIndex((item) => item.state === 'active');
    return (_jsxs(View, { testID: testID, style: [s.targetArea, style], children: [_jsx(Text, { style: [s.targetEyebrow, { color: theme.accent }], children: eyebrow }), _jsxs(View, { accessibilityLabel: `Target note ${noteName}`, style: s.targetLockup, children: [_jsx(Text, { style: [s.targetPitch, { color: theme.text }], children: pitch }), _jsx(Text, { style: [s.targetOctave, { color: theme.accent, marginLeft: octaveOffset }], children: octave })] }), sequence.length > 1 && _jsx(View, { accessibilityLabel: `Note ${Math.max(0, activeSequenceIndex) + 1} of ${sequence.length}`, style: s.targetSequence, children: sequence.map((item, index) => _jsx(View, { style: [s.targetSequenceItem, { backgroundColor: theme.panelDeep, borderColor: theme.controlLine }, item.state === 'done' && { backgroundColor: theme.line, borderColor: theme.lineStrong }, item.state === 'active' && { backgroundColor: theme.accentSoft, borderColor: theme.accent }], children: _jsx(Text, { style: [s.targetSequenceText, { color: item.state === 'future' ? theme.dim : theme.text }], children: item.label }) }, `${item.label}-${index}`)) })] }));
}
export function Countdown({ value, label = 'SING IN', hint }) {
    const theme = useNativeTheme();
    const spokenLabel = `${label.charAt(0)}${label.slice(1).toLowerCase()}`;
    return _jsxs(View, { accessibilityLabel: `${spokenLabel} ${value}`, style: s.countdown, children: [_jsx(Text, { style: [s.countdownLabel, { color: theme.accent }], children: label }), _jsx(Text, { accessibilityLiveRegion: "polite", style: [s.countdownNumber, { color: theme.text, textShadowColor: theme.accent }], children: value }), _jsx(Text, { style: [s.countdownHint, { color: theme.dim }], children: hint })] });
}
export function PitchMeter(props) {
    const theme = useNativeTheme();
    const x = props.cents === null ? 50 : Math.max(6, Math.min(94, 50 + props.cents * 0.8));
    return (_jsxs(View, { style: s.meterWrap, children: [_jsxs(View, { style: s.meterLabels, children: [_jsx(Text, { style: [s.meterEdge, { color: theme.dim }], children: "FLAT" }), _jsxs(Text, { style: [s.meterCenterLabel, { color: theme.accent }], children: ["\u00B1", props.pitchWindowCents, "\u00A2"] }), _jsx(Text, { style: [s.meterEdge, { color: theme.dim }], children: "SHARP" })] }), _jsxs(GlassSurface, { radius: 30, elevation: "none", accessibilityLabel: props.accessibilityReading ?? props.reading, style: s.meter, children: [_jsx(View, { style: [s.targetZone, { left: `${50 - props.pitchWindowCents * 0.8}%`, width: `${props.pitchWindowCents * 1.6}%`, backgroundColor: theme.accentSoft }] }), _jsx(View, { style: [s.meterCenter, { backgroundColor: theme.accent }] }), props.cents !== null && _jsx(View, { style: [s.pitchMarker, { left: `${x}%`, backgroundColor: props.centered ? theme.accent : theme.text, borderColor: props.centered ? theme.text : theme.lineStrong, shadowColor: theme.accent }] })] }), _jsxs(View, { style: s.livePitchRow, children: [_jsxs(View, { children: [_jsx(Text, { style: [s.livePitchLabel, { color: theme.dim }], children: "YOU ARE SINGING" }), _jsx(Text, { accessibilityLiveRegion: "polite", style: [s.livePitchNote, { color: theme.text }], children: props.detectedNote ?? '—' })] }), _jsx(Text, { style: [s.meterReading, { color: theme.text }], children: props.reading })] }), _jsx(View, { accessibilityLabel: `${props.instruction}. ${Math.round(props.progress * 100)} percent complete.`, style: [s.progressTrack, { backgroundColor: theme.line }], children: _jsx(View, { style: [s.progressFill, { width: `${Math.round(Math.max(0, Math.min(1, props.progress)) * 100)}%`, backgroundColor: theme.accent }] }) }), _jsx(Text, { accessibilityLiveRegion: "polite", style: [s.meterInstruction, { color: props.centered ? theme.accent : theme.dim }], children: props.instruction }), _jsx(Text, { style: [s.meterHint, { color: theme.dim }], children: props.hint })] }));
}
export function TransportDock({ left, center, right, hint }) {
    const theme = useNativeTheme();
    const side = (item) => _jsx(View, { style: s.transportSlot, children: item ? _jsxs(_Fragment, { children: [_jsx(RoundAction, { label: item.accessibilityLabel, icon: item.icon, onPress: item.onPress ?? (() => undefined) }), _jsx(Text, { style: [s.transportLabel, { color: theme.dim }], children: item.caption })] }) : _jsx(View, { style: s.transportSpacer }) });
    return (_jsxs(GlassSurface, { radius: 36, style: s.transportDock, children: [_jsxs(View, { style: s.transportRow, children: [side(left), _jsxs(View, { style: s.transportMainSlot, children: [_jsx(View, { accessibilityLabel: center.accessibilityLabel, style: [s.transportMain, { backgroundColor: theme.accent, shadowColor: theme.accent }], children: center.icon }), _jsx(Text, { style: [s.transportLabel, { color: theme.dim }], children: center.caption })] }), side(right)] }), _jsx(Text, { style: [s.transportHint, { color: theme.faint }], children: hint })] }));
}
const s = StyleSheet.create({
    pressed: { opacity: 0.65 },
    disabled: { opacity: 0.35 },
    header: { minHeight: 62, flexDirection: 'row', marginBottom: 4, paddingHorizontal: 10, alignItems: 'center' },
    headerAction: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center', zIndex: 20, elevation: 4 },
    backChevron: { fontSize: 30, lineHeight: 32, fontWeight: '600', marginTop: -4 },
    headerTitle: { flex: 1, fontSize: 20, fontWeight: '900', letterSpacing: -0.4, textAlign: 'center' },
    headerTrailing: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    chip: { minHeight: 42, minWidth: 42, paddingHorizontal: 13, borderRadius: 15, borderCurve: 'continuous', borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
    chipText: { fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
    primary: { minHeight: 54, borderRadius: 18, paddingHorizontal: 22, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center' },
    primaryText: { fontSize: 16, fontWeight: '900' },
    settingsCard: { paddingHorizontal: 16, paddingVertical: 3 },
    hairline: { height: StyleSheet.hairlineWidth },
    settingsRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
    settingsLabel: { fontSize: 13, fontWeight: '700' },
    settingsValueRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 9 },
    settingsValue: { flexShrink: 1, fontSize: 16, fontWeight: '900' },
    settingsChevron: { fontSize: 26, lineHeight: 28 },
    stickyFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, borderTopWidth: StyleSheet.hairlineWidth, shadowOpacity: 0.55, shadowRadius: 18, shadowOffset: { width: 0, height: -8 } },
    tabBar: { minHeight: 64, flexDirection: 'row', paddingVertical: 8, paddingHorizontal: 12, gap: 12 },
    tab: { flex: 1, minHeight: 48, borderRadius: 24, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', gap: 2 },
    tabLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
    featureCard: { minHeight: 112, borderRadius: 24, borderCurve: 'continuous', paddingVertical: 17, paddingLeft: 17, paddingRight: 78, justifyContent: 'center' },
    featureGlyphRail: { position: 'absolute', top: 0, right: 14, bottom: 0, width: 54, alignItems: 'center', justifyContent: 'center' },
    featureGlyph: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
    featureCopy: { width: '100%' },
    featureTitle: { fontSize: 18, fontWeight: '800' },
    featureDescription: { fontSize: 13, lineHeight: 19, marginTop: 3 },
    listEntry: { minHeight: 80, borderRadius: 22, borderCurve: 'continuous', paddingVertical: 16, paddingLeft: 16, paddingRight: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    listEntryCopy: { flex: 1, minWidth: 0 },
    listChevron: { fontSize: 32 },
    referencePanel: { padding: 16, gap: 12 },
    referenceHeader: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    utilityLabel: { fontSize: 12, lineHeight: 16, fontWeight: '900', letterSpacing: 1.2 },
    referenceValue: { fontSize: 28, lineHeight: 34, fontWeight: '900', letterSpacing: -0.7 },
    referenceTest: { minWidth: 132, minHeight: 52, borderRadius: 18, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
    referenceTestText: { fontSize: 15, lineHeight: 20, fontWeight: '900' },
    referenceVolumeRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
    referenceStepText: { fontSize: 28, lineHeight: 31, fontWeight: '700' },
    referenceTrack: { flex: 1, height: 12, borderRadius: 6, overflow: 'hidden' },
    referenceFill: { height: '100%', borderRadius: 6 },
    referenceHint: { fontSize: 12, lineHeight: 17, textAlign: 'center' },
    pitchWindow: { gap: 12 },
    pitchWindowValue: { fontSize: 24, lineHeight: 30, fontWeight: '900', letterSpacing: -0.5 },
    choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    targetArea: { width: '100%', height: 222, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 18 },
    targetEyebrow: { fontSize: 11, fontWeight: '900', letterSpacing: 2 },
    targetLockup: { position: 'relative', width: '100%', height: 181, alignItems: 'center', justifyContent: 'center' },
    targetPitch: { position: 'absolute', left: 0, right: 0, fontSize: 166, lineHeight: 181, fontWeight: '900', letterSpacing: -8, textAlign: 'center' },
    targetOctave: { position: 'absolute', left: '50%', top: 25, fontSize: 52, lineHeight: 60, fontWeight: '900' },
    targetSequence: { position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
    targetSequenceItem: { minWidth: 54, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 },
    targetSequenceText: { fontSize: 14, lineHeight: 18, fontWeight: '800' },
    countdown: { flex: 1, width: '100%', minHeight: 156, alignItems: 'center', justifyContent: 'center', paddingBottom: 8 },
    countdownLabel: { fontSize: 13, lineHeight: 18, fontWeight: '900', letterSpacing: 3.2 },
    countdownNumber: { fontSize: 112, lineHeight: 120, fontWeight: '900', fontVariant: ['tabular-nums'], textAlign: 'center', textShadowRadius: 24 },
    countdownHint: { fontSize: 15, lineHeight: 22, fontWeight: '700', textAlign: 'center' },
    meterWrap: { flex: 1, width: '100%', justifyContent: 'center', gap: 7, paddingBottom: 4 },
    meterLabels: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
    meterEdge: { fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
    meterCenterLabel: { fontSize: 10, fontWeight: '900', letterSpacing: 1.2 },
    meter: { width: '100%', height: 112, overflow: 'hidden' },
    targetZone: { position: 'absolute', top: 0, bottom: 0 },
    meterCenter: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2 },
    pitchMarker: { position: 'absolute', top: 41, width: 44, height: 44, marginLeft: -22, borderRadius: 22, borderWidth: 4, shadowOpacity: 0.75, shadowRadius: 14 },
    livePitchRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10 },
    livePitchLabel: { fontSize: 9, lineHeight: 12, fontWeight: '900', letterSpacing: 1.4 },
    livePitchNote: { fontSize: 38, lineHeight: 42, fontWeight: '900', letterSpacing: -1 },
    meterReading: { flex: 1, fontSize: 17, lineHeight: 24, fontWeight: '900', textAlign: 'right', marginLeft: 16 },
    progressTrack: { width: '100%', height: 8, borderRadius: 4, overflow: 'hidden' },
    progressFill: { height: '100%', borderRadius: 4 },
    meterInstruction: { fontSize: 18, lineHeight: 24, fontWeight: '900', textAlign: 'center', paddingHorizontal: 12 },
    meterHint: { fontSize: 12, lineHeight: 17, textAlign: 'center', paddingHorizontal: 12 },
    transportDock: { width: '100%', minHeight: 126, marginTop: 8, paddingHorizontal: 18, paddingTop: 11, paddingBottom: 9, justifyContent: 'center' },
    transportRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    transportSlot: { width: 76, alignItems: 'center', justifyContent: 'center', gap: 3 },
    transportMainSlot: { width: 76, alignItems: 'center', justifyContent: 'center', gap: 3 },
    transportSpacer: { width: 54, height: 54 },
    transportMain: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', shadowOpacity: 0.24, shadowRadius: 12 },
    transportLabel: { fontSize: 10, lineHeight: 12, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
    transportHint: { fontSize: 10.5, lineHeight: 14, fontWeight: '700', letterSpacing: 0.2, textAlign: 'center' }
});
