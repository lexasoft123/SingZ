/** Colour, surface and type tokens. Consumers override these to re-theme. */
export declare const tokens: {
    readonly bg: "#12100d";
    readonly panel: "#1b1814";
    readonly 'panel-deep': "#0f0d0a";
    readonly 'glass-fill': "rgba(24, 20, 17, 0.55)";
    readonly 'glass-line': "rgba(255, 240, 220, 0.05)";
    readonly 'glass-rim': "rgba(255, 240, 220, 0.14)";
    readonly 'control-fill': "rgba(24, 20, 17, 0.46)";
    readonly 'control-line': "rgba(255, 240, 220, 0.10)";
    readonly 'control-rim': "rgba(255, 240, 220, 0.18)";
    readonly 'footer-fill': "rgba(12, 10, 8, 0.96)";
    readonly shadow: "#000000";
    readonly line: "rgba(255, 240, 214, 0.08)";
    readonly 'line-strong': "rgba(255, 240, 214, 0.2)";
    readonly text: "#f4efe6";
    readonly dim: "#9b917e";
    readonly faint: "#6b6355";
    readonly accent: "#ffa028";
    readonly 'accent-deep': "#ff8a1f";
    readonly 'accent-soft': "rgba(255, 160, 40, 0.13)";
    /** Text ON an accent fill — dark enough to read against #ffa028. */
    readonly 'accent-ink': "#241705";
    /** A surface that floats ABOVE the app — modal cards, popovers. Lighter
     *  than --panel because it sits over a darkened, blurred scrim. */
    readonly 'surface-raised': "#1e1a15";
    readonly danger: "#ff7a5c";
    readonly success: "#58d68a";
    /** Danger as FOREGROUND — a button's text and border, which needs more
     *  lift than --sz-danger has against a dark ground. */
    readonly 'danger-strong': "#ff8a7a";
    readonly 'danger-strong-line': "rgba(255, 138, 122, 0.4)";
    readonly 'danger-strong-wash': "rgba(255, 138, 122, 0.12)";
    /** A danger-tinted raised surface and its text — the toast. Separate
     *  tokens because a light theme needs a light tint here, not a dark one. */
    readonly 'danger-surface': "#2b1c13";
    readonly 'danger-surface-text': "#ffb9a6";
    readonly 'danger-surface-line': "rgba(255, 122, 92, 0.45)";
    readonly 'font-display': "system-ui, sans-serif";
    readonly 'font-mono': "ui-monospace, 'SF Mono', monospace";
};
export type TokenName = keyof typeof tokens;
/** `--sz-accent` etc. The prefix exists so a consumer's own :root cannot
 *  silently collide with the kit's — a collision should be a rename error,
 *  not a cascade coin-flip decided by stylesheet order. */
export declare const cssVar: (name: TokenName) => string;
/** The whole set as a `:root { … }` block. Used to generate tokens.css. */
export declare function toCss(): string;
