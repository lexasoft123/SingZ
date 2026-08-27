export interface StemMeta {
    label: string;
    color: string;
}
export declare const STEM_META: Record<string, StemMeta>;
/**
 * Lane colours for a singer's own added tracks. Every hue here is far from
 * all six stem colours above — an added track next to Bass must not read as
 * another shade of Bass.
 */
export declare const CUSTOM_COLORS: string[];
/** Convenience for hosts that just want the six lane hues in fixed order. */
export declare const STEM_ORDER: readonly ["vocals", "drums", "bass", "guitar", "piano", "other"];
