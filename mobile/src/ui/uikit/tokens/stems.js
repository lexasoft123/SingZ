/*
 * Stem colours — the one table both the desktop and the phone must agree on.
 *
 * Pure data, ZERO imports, so React Native can read it too.
 *
 * These are not decoration. A project opened on the desktop and again on the
 * phone is the same project, and Bass has to be the same blue in both places
 * or the colour stops meaning anything. They had drifted: the phone's vocals
 * was #ff5d66 against the desktop's #ff5c65 — one digit, in two channels,
 * transcribed by hand from the same mock.
 *
 * Desktop values win, because that is where the design was authored.
 */
export const STEM_META = {
    original: { label: 'Full mix', color: '#bfb49d' },
    vocals: { label: 'Vocals', color: '#ff5c65' },
    drums: { label: 'Drums', color: '#ffc53d' },
    bass: { label: 'Bass', color: '#527dff' },
    guitar: { label: 'Guitar', color: '#f98424' },
    piano: { label: 'Piano', color: '#da81da' },
    other: { label: 'Instruments', color: '#27e7bb' }
};
/**
 * Lane colours for a singer's own added tracks. Every hue here is far from
 * all six stem colours above — an added track next to Bass must not read as
 * another shade of Bass.
 */
export const CUSTOM_COLORS = [
    '#c7e06a',
    '#ff9ad5',
    '#6fd8ff',
    '#e8dcc0',
    '#a98cff'
];
/** Convenience for hosts that just want the six lane hues in fixed order. */
export const STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
