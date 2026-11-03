import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, View } from 'react-native'
import { BlurMask, Canvas, Group, RoundedRect } from '@shopify/react-native-skia'
import { useDerivedValue, useFrameCallback, useReducedMotion, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { KIT } from './tokens'
import { emptyPeakMeter, meterBrickFill, meterIndex, meterZone, peakMeterAtRest, stepPeakMeter, type PeakMeterMotion } from './peak-meter-motion'

// Yellow and red occupy the same level zones in both meter sizes.
const COLORS = [KIT.success, '#ffd05b', KIT.danger] as const

function Brick({ index, count, width, height, motion, clipped }: {
  index: number; count: number; width: number; height: number
  motion: SharedValue<PeakMeterMotion>; clipped: boolean
}): React.JSX.Element {
  const gap = 2
  const brickWidth = Math.max(0, (width - gap * (count - 1)) / count)
  const x = index * (brickWidth + gap)
  const color = COLORS[meterZone(index, count)]
  const trailOpacity = useDerivedValue(() => motion.value.trail[index])
  const liveWidth = useDerivedValue(() => brickWidth * meterBrickFill(motion.value.liveDb, index, count))
  return <Group>
    <RoundedRect x={x} y={0} width={brickWidth} height={height} r={1} color={clipped ? KIT.danger : KIT.faint} opacity={clipped ? 0.24 : 0.3} />
    <RoundedRect x={x} y={0} width={brickWidth} height={height} r={1} color={color} opacity={trailOpacity} />
    <RoundedRect x={x} y={0} width={liveWidth} height={height} r={1} color={color} />
  </Group>
}

/** A tiny Skia surface keeps per-frame ballistics off the JS/lyrics tree. */
export function AnimatedPeakMeter({ db, peakDb = db, mini = false, clipped = false, identity, enabled = true }: {
  db: number; peakDb?: number; mini?: boolean; clipped?: boolean; identity: object; enabled?: boolean
}): React.JSX.Element {
  const count = mini ? 16 : 40
  const height = mini ? 9 : 16
  const [width, setWidth] = useState(0)
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const reduced = useReducedMotion()
  const target = useSharedValue(-Infinity)
  const peakTarget = useSharedValue(-Infinity)
  const motion = useSharedValue(emptyPeakMeter(count))
  const lastTimestamp = useSharedValue(0)
  const accumulatedMs = useSharedValue(0)
  const epoch = useSharedValue(0)
  const pendingStop = useSharedValue(false)
  const latestEpoch = useRef(0)
  const frameRef = useRef<{ setActive: (value: boolean) => void } | null>(null)
  const stop = useCallback((finishedEpoch: number) => {
    if (finishedEpoch === latestEpoch.current) frameRef.current?.setActive(false)
  }, [])
  const frame = useFrameCallback(info => {
    const now = info.timestamp
    const elapsed = lastTimestamp.value > 0 ? Math.min(100, Math.max(0, now - lastTimestamp.value)) : 0
    lastTimestamp.value = now
    accumulatedMs.value += elapsed
    // Coalesce callbacks faster than ProMotion's display cadence.
    if (accumulatedMs.value < 4) return
    const next = stepPeakMeter(motion.value, target.value, accumulatedMs.value, peakTarget.value)
    accumulatedMs.value = 0
    motion.value = next
    if (peakMeterAtRest(next) && !pendingStop.value) {
      pendingStop.value = true
      scheduleOnRN(stop, epoch.value)
    }
  }, false)
  frameRef.current = frame

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'))
    return () => subscription.remove()
  }, [])
  useEffect(() => { motion.value = emptyPeakMeter(count) }, [identity, count, motion])
  useEffect(() => {
    latestEpoch.current += 1
    epoch.value = latestEpoch.current
    pendingStop.value = false
    target.value = foreground && enabled ? db : -Infinity
    peakTarget.value = foreground && enabled ? peakDb : -Infinity
    if (!foreground || !enabled) {
      frame.setActive(false)
      motion.value = emptyPeakMeter(count)
    } else if (reduced) {
      // Reduced motion retains the held peak but omits falling/trailing motion.
      frame.setActive(false)
      const snapshot = stepPeakMeter(motion.value, db, 100, peakDb)
      snapshot.liveDb = Number.isFinite(db) ? Math.max(-60, Math.min(0, db)) : -60
      snapshot.trail.fill(0)
      if (snapshot.liveDb <= -60) snapshot.peakDb = -60
      motion.value = snapshot
    } else {
      lastTimestamp.value = 0
      accumulatedMs.value = 0
      frame.setActive(true)
    }
    return () => frame.setActive(false)
  }, [db, peakDb, foreground, enabled, reduced, identity, count, frame, motion, target, peakTarget, epoch, pendingStop, lastTimestamp, accumulatedMs])

  const gap = 2
  const brickWidth = Math.max(0, (width - gap * (count - 1)) / count)
  const peakX = useDerivedValue(() => Math.max(0, meterIndex(motion.value.peakDb, count)) * (brickWidth + gap))
  const peakOpacity = useDerivedValue(() => motion.value.peakDb > -60 ? 1 : 0)
  const peakColor = useDerivedValue(() => COLORS[meterZone(Math.max(0, meterIndex(motion.value.peakDb, count)), count)])
  return <View testID={mini ? 'song-output-mini-meter' : 'song-output-full-meter'}
    style={{ width: '100%', height, borderRadius: 3, overflow: 'hidden', backgroundColor: KIT.panelDeep }}
    onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))}>
    {width > 0 && <Canvas style={{ width, height }} pointerEvents="none" accessible={false}>
      {Array.from({ length: count }, (_, index) => <Brick key={index} index={index} count={count} width={width} height={height} motion={motion} clipped={clipped} />)}
      <Group opacity={peakOpacity}>
        <RoundedRect x={peakX} y={0} width={brickWidth} height={height} r={1} color={peakColor}>
          <BlurMask blur={mini ? 2 : 4} style="outer" />
        </RoundedRect>
        <RoundedRect x={peakX} y={0} width={brickWidth} height={height} r={1} color={peakColor} />
        <RoundedRect x={peakX} y={0} width={brickWidth} height={mini ? 1 : 2} r={1} color={KIT.text} opacity={0.45} />
      </Group>
    </Canvas>}
  </View>
}
