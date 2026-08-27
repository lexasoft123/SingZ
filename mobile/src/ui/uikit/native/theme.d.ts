import { type PropsWithChildren } from 'react';
import { type ViewStyle } from 'react-native';
export interface NativeTheme {
    readonly bg: string;
    readonly panel: string;
    readonly panelDeep: string;
    readonly text: string;
    readonly dim: string;
    readonly faint: string;
    readonly accent: string;
    readonly accentInk: string;
    readonly accentSoft: string;
    readonly danger: string;
    readonly line: string;
    readonly lineStrong: string;
    readonly glassFill: string;
    readonly glassLine: string;
    readonly glassRim: string;
    readonly controlFill: string;
    readonly controlLine: string;
    readonly controlRim: string;
    readonly footerFill: string;
    readonly shadow: string;
}
export declare const nightStudioNativeTheme: NativeTheme;
export declare function NativeThemeProvider({ theme, children }: PropsWithChildren<{
    readonly theme: NativeTheme;
}>): React.JSX.Element;
export declare function useNativeTheme(): NativeTheme;
export type GlassElevation = 'none' | 'surface' | 'dock';
/** The shared no-blur glass recipe used by Player, Training and bottom tabs. */
export declare function nativeGlassStyle(theme?: NativeTheme, elevation?: GlassElevation, platform?: string): ViewStyle;
