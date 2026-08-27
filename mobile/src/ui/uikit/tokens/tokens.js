/*
 * The night-studio design tokens — the source of truth.
 *
 * Pure data, ZERO imports. That is deliberate and load-bearing: React Native
 * cannot read CSS custom properties, so the phone needs these same values as
 * a plain object, and a file with no imports can be consumed by anything
 * (Vite, Metro, vitest, jest, node) without dragging a DOM or RN type
 * environment along with it.
 *
 * tokens.css is GENERATED from this file — never edit it by hand.
 *
 * Values here are exactly what SingZ's styles.css :root held before the kit
 * existed. Phase 1 moves ownership, not appearance.
 */
/** Colour, surface and type tokens. Consumers override these to re-theme. */
export const tokens = {
    // surfaces
    bg: '#12100d',
    panel: '#1b1814',
    'panel-deep': '#0f0d0a',
    // translucent native surfaces. These are semantic design-system values,
    // not component implementation details: Player, Training and navigation
    // all use the same material recipe.
    'glass-fill': 'rgba(24, 20, 17, 0.55)',
    'glass-line': 'rgba(255, 240, 220, 0.05)',
    'glass-rim': 'rgba(255, 240, 220, 0.14)',
    'control-fill': 'rgba(24, 20, 17, 0.46)',
    'control-line': 'rgba(255, 240, 220, 0.10)',
    'control-rim': 'rgba(255, 240, 220, 0.18)',
    'footer-fill': 'rgba(12, 10, 8, 0.96)',
    shadow: '#000000',
    // hairlines
    line: 'rgba(255, 240, 214, 0.08)',
    'line-strong': 'rgba(255, 240, 214, 0.2)',
    // foreground
    text: '#f4efe6',
    dim: '#9b917e',
    faint: '#6b6355',
    // brand
    accent: '#ffa028',
    'accent-deep': '#ff8a1f',
    'accent-soft': 'rgba(255, 160, 40, 0.13)',
    /** Text ON an accent fill — dark enough to read against #ffa028. */
    'accent-ink': '#241705',
    /** A surface that floats ABOVE the app — modal cards, popovers. Lighter
     *  than --panel because it sits over a darkened, blurred scrim. */
    'surface-raised': '#1e1a15',
    // status
    danger: '#ff7a5c',
    success: '#58d68a',
    /** Danger as FOREGROUND — a button's text and border, which needs more
     *  lift than --sz-danger has against a dark ground. */
    'danger-strong': '#ff8a7a',
    'danger-strong-line': 'rgba(255, 138, 122, 0.4)',
    'danger-strong-wash': 'rgba(255, 138, 122, 0.12)',
    /** A danger-tinted raised surface and its text — the toast. Separate
     *  tokens because a light theme needs a light tint here, not a dark one. */
    'danger-surface': '#2b1c13',
    'danger-surface-text': '#ffb9a6',
    'danger-surface-line': 'rgba(255, 122, 92, 0.45)',
    // type. The kit declares the variables but ships no fonts: the two
    // @fontsource-variable packages belong to the app, and a duplicate
    // @font-face set would double the woff2 in every consumer's bundle.
    'font-display': 'system-ui, sans-serif',
    'font-mono': "ui-monospace, 'SF Mono', monospace"
};
/** `--sz-accent` etc. The prefix exists so a consumer's own :root cannot
 *  silently collide with the kit's — a collision should be a rename error,
 *  not a cascade coin-flip decided by stylesheet order. */
export const cssVar = (name) => `--sz-${name}`;
/** The whole set as a `:root { … }` block. Used to generate tokens.css. */
export function toCss() {
    const body = Object.keys(tokens)
        .map((k) => `  ${cssVar(k)}: ${tokens[k]};`)
        .join('\n');
    return `:root {\n${body}\n}\n`;
}
