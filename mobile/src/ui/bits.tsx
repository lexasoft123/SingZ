import React, { useCallback, useEffect, useRef } from 'react'
import { KIT, STEM_COLORS } from './tokens'
import {
  Animated,
  Easing,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type ImageSourcePropType,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native'

/**
 * White at some opacity — the phone's most-used colour by far.
 *
 * There were twenty-two distinct alphas of pure white scattered across four
 * files, several a hundredth apart and none of them named. This does not
 * change any of them; it gives them one origin, so the next person can see
 * the ladder and decide what it should be.
 */
export const white = (a: number): string => `rgba(255,255,255,${a})`

/*
 * Pre-built whites for anything evaluated during render.
 *
 * white() builds a string, and a default parameter or a style callback runs
 * on EVERY render — Bar re-renders on every onChange while a finger is
 * dragging it. Inside StyleSheet.create the call happens once at module load
 * and none of this matters, but these three did not, so they are constants.
 */
const W_PRESSED = white(0.22)
const W_TRACK = white(0.16)
const W_GLYPH = white(0.85)

/**
 * The design language, now derived rather than transcribed.
 *
 * Every one of these was hand-copied from the same mock the desktop was
 * drawn from, and every one of them missed — the accent by a whole hue
 * (#f2c14e against #ffa028), dim and faint by being white-alpha where the
 * desktop is opaque. The phone even carried the desktop's accent in two
 * places already, in PlayerScreen, next to its own different one.
 *
 * They come from the kit now. `bright` and `amberInk` stay local: white is
 * white, and the on-accent ink follows the accent it sits on.
 *
 * dim/faint change colour MODEL here, not just value — white-alpha to
 * opaque. That is right rather than a slip: the background moves too, so
 * the old alphas would have composited to something different anyway.
 */
export const C = {
  bg: KIT.bg,
  text: KIT.text,
  bright: '#ffffff',
  dim: KIT.dim,
  /* NOT for anything meant to be read: #6b6355 on the app's ground is
     3.2:1, under the 4.5:1 AA floor for normal text, and the catalog's
     background image is lighter than the token in its upper half, which
     makes it worse rather than better. Body text that was reaching for
     this now uses `dim` (6.1:1). */
  faint: KIT.faint,
  amber: KIT.accent,
  amberInk: KIT.accentInk,
  red: KIT.danger,
  sheet: KIT.surfaceRaised,
  hairline: KIT.line,
  /* No desktop equivalent: CSS draws these as ghost borders, RN needs a
     fill. Stays a local decision. */
  btnBg: white(0.1)
}

/** The well a StemTile's lanes sit in — darker than any surface, so the lane
 *  colours read as lit. Local by nature: the desktop draws this artwork with
 *  its own geometry and has no equivalent. */
const TILE_WELL = '#17110a'

/* Artwork hues. These are the SHARED stem colours now, so a project's tile
   on the phone matches its lanes on the desktop. */
export const STEM_TILE_COLORS: string[][] = [
  [STEM_COLORS.vocals, STEM_COLORS.drums, STEM_COLORS.bass, STEM_COLORS.other],
  [STEM_COLORS.bass, STEM_COLORS.vocals, STEM_COLORS.other, STEM_COLORS.piano],
  [STEM_COLORS.guitar, STEM_COLORS.other, STEM_COLORS.drums, STEM_COLORS.vocals]
]
const TILE_WIDTHS = ['100%', '72%', '88%', '60%'] as const

/**
 * "Artist — Title" project names, split for display. Desktop-synced songs
 * commonly carry the artist in the name, and on a card one line wide the
 * artist ate the title ("Cat Stevens — Fat…" told nobody which song this
 * is). Splits on the FIRST spaced dash — em, en or hyphen; the spaces are
 * what keep hyphenated words ("Mr-X") whole. The SORT stays on the full
 * name on purpose: an artist's songs clustering together is a feature, and
 * this helper is display only.
 */
export function splitSongName(name: string): { title: string; artist: string | null } {
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(name)
  if (m == null) return { title: name, artist: null }
  return { title: m[2], artist: m[1] }
}

/** Mini artwork: four stem lanes, hue-rotated per project.
 *
 *  `neutral` draws every lane in the `original` hue — an unsplit song has no
 *  stem colours yet, and the artwork saying so is cheaper than a word.
 *  `glow` casts a faint halo in the given hue (a ready song is lit). iOS
 *  only: Android's elevation shadow is black by contract, and a black halo
 *  under a dark card reads as a smudge, not a light.
 */
export function StemTile({
  hue,
  size,
  neutral,
  glow
}: {
  hue: number
  size: number
  neutral?: boolean
  glow?: string
}): React.JSX.Element {
  const colors = neutral
    ? [STEM_COLORS.original, STEM_COLORS.original, STEM_COLORS.original, STEM_COLORS.original]
    : STEM_TILE_COLORS[hue % STEM_TILE_COLORS.length]
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.23,
        backgroundColor: TILE_WELL,
        justifyContent: 'center',
        gap: size * 0.062,
        paddingHorizontal: size * 0.18,
        ...(glow != null && Platform.OS === 'ios'
          ? { shadowColor: glow, shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } }
          : null)
      }}
    >
      {colors.map((c, i) => (
        <View
          key={i}
          style={{ height: size * 0.07, borderRadius: 3, backgroundColor: c, width: TILE_WIDTHS[i] }}
        />
      ))}
    </View>
  )
}

/** Filled folder glyph for the source tabs — drawn, like MicGlyph, because an
 *  emoji in a row of tabs is an icon in a row of icons. Filled rather than
 *  outlined: a 1.5px outline at this size read crude next to the label. */
export function FolderGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ width: 16, height: 14 }}>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 7,
          height: 5,
          backgroundColor: color,
          borderTopLeftRadius: 2,
          borderTopRightRadius: 2
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 4,
          width: 16,
          height: 10,
          backgroundColor: color,
          borderRadius: 2
        }}
      />
    </View>
  )
}

/** Play/pause for the transport — drawn triangles and bars instead of the
 *  ▶/❚❚ text glyphs, which Android faces render at whatever weight they
 *  please. */
export function PlayPauseGlyph({
  playing,
  color
}: {
  playing: boolean
  color: string
}): React.JSX.Element {
  return playing ? (
    <View style={{ flexDirection: 'row', gap: 5 }}>
      <View style={{ width: 5, height: 20, borderRadius: 1.5, backgroundColor: color }} />
      <View style={{ width: 5, height: 20, borderRadius: 1.5, backgroundColor: color }} />
    </View>
  ) : (
    <View
      style={{
        marginLeft: 4,
        width: 0,
        height: 0,
        borderLeftWidth: 18,
        borderLeftColor: color,
        borderTopWidth: 11,
        borderTopColor: 'transparent',
        borderBottomWidth: 11,
        borderBottomColor: 'transparent'
      }}
    />
  )
}

/** Back-to-start: a bar and a left-pointing triangle, replacing ⏮︎. */
export function ToStartGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
      <View style={{ width: 2.5, height: 13, borderRadius: 1, backgroundColor: color }} />
      <View
        style={{
          width: 0,
          height: 0,
          borderRightWidth: 11,
          borderRightColor: color,
          borderTopWidth: 7,
          borderTopColor: 'transparent',
          borderBottomWidth: 7,
          borderBottomColor: 'transparent'
        }}
      />
    </View>
  )
}

/** Trash glyph for the swipe actions — the word "Delete" said less than
 *  the shape does, and took more room. */
export function TrashGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ width: 14, height: 16, alignItems: 'center' }}>
      <View style={{ width: 6, height: 2, borderTopLeftRadius: 1, borderTopRightRadius: 1, backgroundColor: color }} />
      <View style={{ width: 14, height: 2, borderRadius: 1, backgroundColor: color, marginTop: 0.5 }} />
      <View
        style={{
          width: 11,
          height: 10,
          marginTop: 1.5,
          borderBottomLeftRadius: 2.5,
          borderBottomRightRadius: 2.5,
          backgroundColor: color
        }}
      />
    </View>
  )
}

/** Redetect glyph — a refresh arc with an arrowhead, drawn. */
export function RedetectGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ width: 16, height: 16 }}>
      <View
        style={{
          position: 'absolute',
          left: 1,
          top: 1,
          width: 14,
          height: 14,
          borderRadius: 7,
          borderWidth: 2,
          borderColor: color,
          borderTopColor: 'transparent',
          transform: [{ rotate: '45deg' }]
        }}
      />
      <View
        style={{
          position: 'absolute',
          right: -1,
          top: 0,
          width: 0,
          height: 0,
          borderLeftWidth: 6,
          borderLeftColor: color,
          borderTopWidth: 4,
          borderTopColor: 'transparent',
          borderBottomWidth: 4,
          borderBottomColor: 'transparent',
          transform: [{ rotate: '-15deg' }]
        }}
      />
    </View>
  )
}

/** Lyrics glyph — three text lines. */
export function LyricsGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ width: 14, height: 12, justifyContent: 'space-between' }}>
      <View style={{ width: 14, height: 2, borderRadius: 1, backgroundColor: color }} />
      <View style={{ width: 10, height: 2, borderRadius: 1, backgroundColor: color }} />
      <View style={{ width: 12, height: 2, borderRadius: 1, backgroundColor: color }} />
    </View>
  )
}

/** Speaker glyph for the mixer's Mute — crossed when muted. M and S were
 *  mixing-desk initials; the glyphs say what happens to the sound. Drawn
 *  with the RN border-triangle trick, the same reasoning as MicGlyph. */
export function SpeakerGlyph({
  color,
  slashed
}: {
  color: string
  slashed?: boolean
}): React.JSX.Element {
  return (
    <View style={{ width: 13, height: 14 }}>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 4,
          width: 4,
          height: 6,
          borderRadius: 1,
          backgroundColor: color
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: 3,
          top: 1,
          width: 0,
          height: 0,
          borderRightWidth: 8,
          borderRightColor: color,
          borderTopWidth: 6,
          borderTopColor: 'transparent',
          borderBottomWidth: 6,
          borderBottomColor: 'transparent'
        }}
      />
      {slashed === true && (
        <View
          style={{
            position: 'absolute',
            left: -2,
            top: 6,
            width: 17,
            height: 2,
            borderRadius: 1,
            backgroundColor: color,
            transform: [{ rotate: '-45deg' }]
          }}
        />
      )}
    </View>
  )
}

/** Headphones glyph for the mixer's Solo — hear only this. */
export function HeadphonesGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View style={{ width: 14, height: 12 }}>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 14,
          height: 12,
          borderWidth: 2,
          borderColor: color,
          borderBottomWidth: 0,
          borderTopLeftRadius: 7,
          borderTopRightRadius: 7
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: -1,
          bottom: 0,
          width: 4,
          height: 6,
          borderRadius: 1.5,
          backgroundColor: color
        }}
      />
      <View
        style={{
          position: 'absolute',
          right: -1,
          bottom: 0,
          width: 4,
          height: 6,
          borderRadius: 1.5,
          backgroundColor: color
        }}
      />
    </View>
  )
}

/** Phone glyph for the source tabs — outline with a home bar. */
export function PhoneGlyph({ color }: { color: string }): React.JSX.Element {
  return (
    <View
      style={{
        width: 10,
        height: 15,
        borderWidth: 1.5,
        borderColor: color,
        borderRadius: 3,
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: 1
      }}
    >
      <View style={{ width: 3, height: 1.5, borderRadius: 1, backgroundColor: color }} />
    </View>
  )
}

/** Mixer glyph (three slider rails with knobs), drawn with plain views. */
export function MixGlyph({ color = W_GLYPH }: { color?: string }): React.JSX.Element {
  const knob = (top: number): object => ({
    position: 'absolute',
    top,
    left: -3.5,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: color,
    backgroundColor: 'transparent'
  })
  return (
    <View style={{ width: 22, height: 20, flexDirection: 'row', justifyContent: 'space-between' }}>
      {[5, 9, 3].map((k, i) => (
        <View key={i} style={{ width: 2, backgroundColor: color, borderRadius: 1 }}>
          <View style={knob(k)} />
        </View>
      ))}
    </View>
  )
}

/**
 * Microphone glyph (capsule, cradle, stem), drawn with plain views.
 *
 * Its five neighbours in the transport are line art and this one was 🎤 — a
 * full-colour emoji in a row of monochrome glyphs. The file already refuses
 * that twice on purpose: ⏮︎ carries a variation selector to keep it
 * monochrome, and the Song button is ••• rather than a gear because a gear
 * has no guaranteed text presentation on Android. There is no microphone
 * character with a dependable text presentation to reach for, so it is drawn,
 * the way MixGlyph is. The 🎤 in running copy and on the sung-line marker
 * stays: an emoji in a sentence is an emoji, not an icon in a row of icons.
 */
export function MicGlyph({ color = W_GLYPH }: { color?: string }): React.JSX.Element {
  return (
    <View style={{ width: 22, height: 20, alignItems: 'center' }}>
      <View style={{ width: 8, height: 11, borderRadius: 4, backgroundColor: color }} />
      {/* the cradle: a full border with the top edge dropped, which is how a
          half-circle is drawn without a path */}
      <View
        style={{
          width: 16,
          height: 8,
          marginTop: -3,
          borderWidth: 2,
          borderColor: color,
          borderTopColor: 'transparent',
          borderBottomLeftRadius: 8,
          borderBottomRightRadius: 8
        }}
      />
      <View style={{ width: 2, height: 3, backgroundColor: color }} />
    </View>
  )
}

/**
 * A round icon button. `label` is not optional in spirit — every one of these
 * holds a glyph and nothing else, so without it a screen reader announces
 * "button" and leaves the singer to guess which of the six it landed on.
 */
export function RoundBtn({
  size = 47,
  onPress,
  children,
  bg = C.btnBg,
  label
}: {
  size?: number
  onPress: () => void
  children: React.ReactNode
  bg?: string
  label?: string
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: pressed ? W_PRESSED : bg,
        alignItems: 'center',
        justifyContent: 'center'
      })}
    >
      {children}
    </Pressable>
  )
}

export function Chip({
  label,
  active,
  activeColor = C.amber,
  onPress,
  disabled,
  icon
}: {
  label: string
  active: boolean
  activeColor?: string
  onPress: () => void
  disabled?: boolean
  icon?: ImageSourcePropType
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      // Chips are toggles and multi-selects: the lit state IS the value, so it
      // has to travel to the screen reader as state rather than as colour.
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !!disabled }}
      style={[
        b.chip,
        icon != null && { flexDirection: 'row', alignItems: 'center', gap: 6 },
        active && { backgroundColor: activeColor, borderColor: activeColor },
        disabled && { opacity: 0.4 }
      ]}
    >
      {icon != null && <Image source={icon} style={{ width: 13, height: 13 }} />}
      <Text style={[b.chipText, active && { color: C.amberInk }]}>{label}</Text>
    </Pressable>
  )
}

export function Stepper({
  label,
  valueText,
  onStep,
  suffix
}: {
  label: string
  valueText: string
  onStep: (dir: 1 | -1) => void
  suffix?: string
}): React.JSX.Element {
  return (
    <View style={b.stepRow}>
      <Text style={b.stepLabel}>{label}</Text>
      {/* "−" and "+" alone say nothing out loud; name the thing they move. */}
      <Pressable
        style={b.stepBtn}
        hitSlop={6}
        onPress={() => onStep(-1)}
        accessibilityRole="button"
        accessibilityLabel={`Decrease ${label}`}
      >
        <Text style={b.stepBtnText}>−</Text>
      </Pressable>
      <Text style={b.stepValue} accessibilityLabel={`${label}, ${valueText}`}>
        {valueText}
      </Text>
      <Pressable
        style={b.stepBtn}
        hitSlop={6}
        onPress={() => onStep(1)}
        accessibilityRole="button"
        accessibilityLabel={`Increase ${label}`}
      >
        <Text style={b.stepBtnText}>+</Text>
      </Pressable>
      {suffix ? <Text style={b.stepSuffix}>{suffix}</Text> : null}
    </View>
  )
}

/**
 * Horizontal drag/tap bar. onChange per move (cheap preview / volume);
 * onCommit once at finger-up — expensive actions belong there.
 */
/** Segmented source switcher (the approved catalog prototype). */
export function Seg({
  segments,
  active,
  onSelect
}: {
  segments: {
    key: string
    label: string
    icon?: ImageSourcePropType
    emoji?: string
    /** A drawn glyph, given the colour the segment's label renders in. */
    glyph?: (color: string) => React.ReactNode
  }[]
  active: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  return (
    <View style={b.segTrack}>
      {segments.map((s) => {
        const on = s.key === active
        return (
          <Pressable
            key={s.key}
            onPress={() => onSelect(s.key)}
            // One of these wins; `selected` is what says so out loud.
            accessibilityRole="button"
            accessibilityLabel={s.label}
            accessibilityState={{ selected: on }}
            style={[b.segBtn, on && { backgroundColor: C.amber }]}
          >
            {s.icon != null && <Image source={s.icon} style={{ width: 13, height: 13 }} />}
            {s.emoji != null && <Text style={{ fontSize: 12 }}>{s.emoji}</Text>}
            {s.glyph != null && s.glyph(on ? C.amberInk : white(0.5))}
            <Text style={[b.segText, on && { color: C.amberInk }]} numberOfLines={1}>
              {s.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

export function Bar({
  value,
  onChange,
  onCommit,
  color,
  height = 22,
  track = W_TRACK,
  label,
  valueText,
  rail
}: {
  value: number
  onChange: (v: number) => void
  onCommit?: (v: number) => void
  color: string
  height?: number
  track?: string
  /** What this bar controls, for the screen reader. */
  label?: string
  /** How to say the current value out loud (defaults to a percentage). */
  valueText?: (v: number) => string
  /** Replace the default 5px track + knob with a custom rail (the player's
   *  waveform seek bar). Gets the displayed fraction; the touch strip, the
   *  gesture arbitration and the screen-reader surface stay Bar's. */
  rail?: (pct: number) => React.ReactNode
}): React.JSX.Element {
  const width = useRef(1)
  const last = useRef(0)
  /* Where the finger landed, and whether it has since moved sideways enough to
     mean it. The bar claims the responder on touch-DOWN (that is what makes
     tap-to-set work), and it now sits inside the mixer's ScrollView — so
     writing the value on grant would set a lane's volume to wherever a finger
     happened to touch on its way to scrolling past it. Nothing is written
     until the gesture declares itself: sideways beyond the slop is a drag, a
     release with no movement is a tap, and a vertical drag is the scroller's,
     which takes the responder away and leaves the value alone. */
  const pending = useRef<number | null>(null)
  const engaged = useRef(false)
  /** Moved far enough, in any direction, that this is no longer a tap. */
  const strayed = useRef(false)
  const origin = useRef({ x: 0, y: 0 })
  const posOf = (e: GestureResponderEvent): number =>
    Math.max(0, Math.min(1, e.nativeEvent.locationX / width.current))
  /* page coordinates are what survive the finger leaving this view; location*
     is the fallback. Anything non-finite becomes 0 so the comparisons below
     stay decidable — a NaN makes every `<=` false, which would let a gesture
     engage by default, which is the opposite of what is wanted here. */
  const ptOf = (e: GestureResponderEvent): { x: number; y: number } => {
    const n = e.nativeEvent
    const x = Number.isFinite(n.pageX) ? n.pageX : n.locationX
    const y = Number.isFinite(n.pageY) ? n.pageY : n.locationY
    return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
  }
  const SLOP = 6

  const grant = useCallback((e: GestureResponderEvent) => {
    pending.current = posOf(e)
    origin.current = ptOf(e)
    engaged.current = false
    strayed.current = false
  }, [])

  const move = useCallback(
    (e: GestureResponderEvent) => {
      const p = ptOf(e)
      const dx = p.x - origin.current.x
      const dy = p.y - origin.current.y
      if (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP) strayed.current = true
      if (!engaged.current) {
        // Stated positively so it fails CLOSED: only a clearly sideways drag
        // moves a fader. Anything else is the scroller's gesture passing
        // through, and must leave the value alone.
        const sideways = Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy)
        if (!sideways) return
        engaged.current = true
      }
      const v = posOf(e)
      last.current = v
      onChange(v)
    },
    [onChange]
  )
  const commit = useCallback(
    (e: GestureResponderEvent) => {
      // A release that never moved at all is a tap: apply where it landed. One
      // that strayed without engaging was a scroll that happened to start here.
      // The release position is checked as well as the moves, because a fast
      // flick can arrive as down-then-up with no move event in between — and
      // that must not be mistaken for a tap where it started.
      const p = ptOf(e)
      const wandered =
        strayed.current ||
        Math.abs(p.x - origin.current.x) > SLOP ||
        Math.abs(p.y - origin.current.y) > SLOP
      const tapped = !engaged.current && !wandered && pending.current !== null
      if (tapped) {
        last.current = pending.current as number
        onChange(pending.current as number)
      }
      const acted = engaged.current || tapped
      pending.current = null
      engaged.current = false
      strayed.current = false
      if (acted) onCommit?.(last.current)
    },
    [onChange, onCommit]
  )

  /* The scroller took over. Anything already dragged stands (and still has to
     commit, or the scrubber's dragPos would stay pinned); an un-engaged
     gesture writes nothing at all. */
  const terminate = useCallback(() => {
    const wasEngaged = engaged.current
    pending.current = null
    engaged.current = false
    strayed.current = false
    if (wasEngaged) onCommit?.(last.current)
  }, [onCommit])
  /* Screen-reader stepping. "adjustable" is what makes VoiceOver and TalkBack
     offer swipe-up/down at all, and without these actions that gesture has
     nothing to call. */
  const nudge = useCallback(
    (dir: 1 | -1) => {
      const v = Math.max(0, Math.min(1, value + dir * 0.05))
      last.current = v
      onChange(v)
      onCommit?.(v)
    },
    [value, onChange, onCommit]
  )
  const pct = Math.max(0, Math.min(1, value))
  return (
    <View
      /* 44 pt is the documented minimum touch target; this was 22 — half of
         it — for every mixer fader and 26 for the scrubber. The RAIL stays
         5 px: what grows is the invisible area a finger may land in. */
      style={{ height: Math.max(height, 44), justifyContent: 'center' }}
      /* ViewProps.accessible defaults to false, and iOS maps it straight to
         isAccessibilityElement — without it VoiceOver cannot focus the bar,
         never offers swipe-up/down, and onAccessibilityAction is dead. */
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(pct * 100),
        text: valueText ? valueText(pct) : `${Math.round(pct * 100)} percent`
      }}
      /* 'activate' is declared so it is HANDLED, not because it does anything:
         `accessible` makes the bar a double-tap target, and with nothing
         claiming the activation both screen readers fall back to a simulated
         tap at the element's centre — which the responder path below would
         read as a genuine tap and slam the fader to 50% (or seek the scrubber
         to the middle of the song). Declaring it puts ACTION_CLICK in
         Android's map; onAccessibilityTap does the same job on iOS. Both then
         land in the handler above, which ignores everything but the two real
         actions. The labels are for VoiceOver's rotor, which otherwise reads
         the raw action names aloud. */
      onAccessibilityTap={() => {}}
      accessibilityActions={[
        { name: 'increment', label: 'Increase' },
        { name: 'decrement', label: 'Decrease' },
        // Android only: it exists to put ACTION_CLICK in the map so the click
        // is SWALLOWED rather than falling through as a centre tap. iOS has
        // onAccessibilityTap for that, and turns every entry here into a
        // VoiceOver rotor action — so listing it there would advertise an
        // "Adjust" that does nothing. No label, so TalkBack says the generic
        // "activate" instead of promising an action it will not perform.
        ...(Platform.OS === 'android' ? [{ name: 'activate' }] : [])
      ]}
      onAccessibilityAction={(e) => {
        // Only the two we declare; 'activate'/'escape'/'magicTap' also arrive
        // here and must not be read as "move it down".
        if (e.nativeEvent.actionName === 'increment') nudge(1)
        else if (e.nativeEvent.actionName === 'decrement') nudge(-1)
      }}
      onLayout={(e: LayoutChangeEvent) => {
        width.current = Math.max(1, e.nativeEvent.layout.width)
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={grant}
      onResponderMove={move}
      onResponderRelease={commit}
      onResponderTerminate={terminate}
    >
      {rail != null ? (
        rail(pct)
      ) : (
        <>
          <View style={{ height: 5, borderRadius: 3, backgroundColor: track, overflow: 'hidden' }}>
            <View
              pointerEvents="none"
              style={{
                width: `${pct * 100}%`,
                height: '100%',
                borderRadius: 3,
                backgroundColor: color
              }}
            />
          </View>
          {/* The knob. Without it a fader at 100% — which every stem is by default
              — was a solid coloured line with no handle and a track too dim to
              read: it looked like a divider, not something you could drag. */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: `${pct * 100}%`,
              marginLeft: -7,
              width: 14,
              height: 14,
              borderRadius: 7,
              backgroundColor: color,
              borderWidth: 2,
              borderColor: KIT.bg
            }}
          />
        </>
      )}
    </View>
  )
}

/**
 * A bottom sheet inside a `<Modal>`: a tap-anywhere-else scrim and the panel.
 *
 * The scrim is a SIBLING of the panel and never its ancestor, which is the
 * whole point of this component existing. Wrapping the panel in the scrim's
 * `Pressable` — the obvious way to write it — silently stops the panel
 * scrolling on iOS: `RCTScrollViewComponentView._shouldDisableScrollInteraction`
 * walks the native superviews of a scroll view and, on finding one that is the
 * JS responder, makes `touchesShouldCancelInContentView:` return NO, so the pan
 * never begins. Measured on the Practice sheet: three swipes, three touches
 * delivered to the ScrollView, zero drags, and Trim unreachable on every song.
 * It read as intermittent only because `setIsJSResponder` lands on the main
 * queue and can lose the race with the first gesture after a fresh mount.
 *
 * A sibling scrim also needs no `onPress={() => {}}` on the panel to swallow
 * taps: RN's responder negotiation walks the touch target's ANCESTORS, and the
 * scrim is not one, so a tap on the panel never reaches it.
 *
 * `accessible={false}` on the scrim: left accessible it becomes ONE element
 * over the whole modal reading "Close, button", with the faders, chips and
 * steppers unreachable behind it. `onAccessibilityEscape` is the screen-reader
 * way out.
 */
export function Sheet({
  onClose,
  pad,
  children
}: {
  onClose: () => void
  pad?: StyleProp<ViewStyle>
  children: React.ReactNode
}): React.JSX.Element {
  /* The scrim EASES to its 45% black instead of snapping there — the modal
     slides its panel in, and a wash that lands fully dark on frame one reads
     as a flash, not a dimming ("shadow animation is harsh"). 200ms
     decelerate, native driver, one run per open; the slide itself stays the
     system's (retiming it means replacing Modal, which this sheet's whole
     scroll-arbitration comment is about not destabilising). Close needs no
     fade: the Modal unmounts the scrim with the panel. */
  const scrim = useRef(new Animated.Value(0)).current
  useEffect(() => {
    Animated.timing(scrim, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start()
  }, [scrim])
  return (
    <View style={b.sheetWrap}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.45)', opacity: scrim }]}
      />
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessible={false} />
      <View style={[b.sheet, pad]} accessible={false} onAccessibilityEscape={onClose}>
        {children}
      </View>
    </View>
  )
}

export const b = StyleSheet.create({
  segTrack: {
    flexDirection: 'row',
    backgroundColor: white(0.055),
    borderWidth: 1,
    borderColor: C.hairline,
    borderRadius: 14,
    padding: 3,
    gap: 3
  },
  segBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 4,
    borderRadius: 11
  },
  segText: { color: white(0.5), fontSize: 13.5, fontWeight: '700' },
  chip: {
    borderWidth: 1.5,
    borderColor: white(0.16),
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent'
  },
  chipText: { color: white(0.6), fontSize: 13.5, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 13, marginTop: 12 },
  stepLabel: { color: C.text, fontSize: 14.5, width: 78 }, // "Loudness"/"Interval" must not wrap
  stepBtn: {
    width: 33,
    height: 33,
    borderRadius: 17,
    borderWidth: 1.5,
    borderColor: white(0.2),
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepBtnText: { color: C.text, fontSize: 17, fontWeight: '700' },
  stepValue: {
    color: C.text,
    fontSize: 16,
    fontWeight: '700',
    minWidth: 52,
    textAlign: 'center',
    fontVariant: ['tabular-nums']
  },
  stepSuffix: { color: C.dim, fontSize: 12.5 },
  /* The 45% black lives on the animated scrim layer inside Sheet now. */
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.sheet,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 22,
    paddingBottom: 34,
    maxHeight: '80%'
  },
  grab: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: white(0.25),
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 14
  },
  sheetTitle: { color: C.bright, fontSize: 19, fontWeight: '800', marginBottom: 14, letterSpacing: -0.2 },
  sec: { borderTopWidth: 1, borderTopColor: C.hairline, paddingVertical: 15 },
  secFirst: { borderTopWidth: 0, paddingTop: 2 },
  secLab: {
    color: C.dim,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 11
  },
  segs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  hint: { color: white(0.5), fontSize: 12.5, marginTop: 10, lineHeight: 18 }
})
