import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import { tokens } from '../tokens/tokens.js';
export const nightStudioNativeTheme = Object.freeze({
    bg: tokens.bg,
    panel: tokens.panel,
    panelDeep: tokens['panel-deep'],
    text: tokens.text,
    dim: tokens.dim,
    faint: tokens.faint,
    accent: tokens.accent,
    accentInk: tokens['accent-ink'],
    accentSoft: tokens['accent-soft'],
    danger: tokens.danger,
    line: tokens.line,
    lineStrong: tokens['line-strong'],
    glassFill: tokens['glass-fill'],
    glassLine: tokens['glass-line'],
    glassRim: tokens['glass-rim'],
    controlFill: tokens['control-fill'],
    controlLine: tokens['control-line'],
    controlRim: tokens['control-rim'],
    footerFill: tokens['footer-fill'],
    shadow: tokens.shadow
});
const NativeThemeContext = createContext(nightStudioNativeTheme);
export function NativeThemeProvider({ theme, children }) {
    return _jsx(NativeThemeContext.Provider, { value: theme, children: children });
}
export function useNativeTheme() {
    return useContext(NativeThemeContext);
}
/** The shared no-blur glass recipe used by Player, Training and bottom tabs. */
export function nativeGlassStyle(theme = nightStudioNativeTheme, elevation = 'surface', platform = Platform.OS) {
    const shadow = elevation === 'dock'
        ? { shadowOpacity: 0.42, shadowRadius: 15, shadowOffset: { width: 0, height: 12 } }
        : { shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 10 } };
    return {
        backgroundColor: theme.glassFill,
        borderWidth: 1,
        borderColor: theme.glassLine,
        borderTopColor: theme.glassRim,
        borderCurve: 'continuous',
        ...(platform === 'ios' && elevation !== 'none' ? { shadowColor: theme.shadow, ...shadow } : null)
    };
}
