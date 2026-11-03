import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewProps
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { quickStartCopy, latinMobileGuideCopy, QUICK_START_SEEN } from '../../../src/shared/quick-start'
import { placeGuide, type GuideRect } from '../../../src/shared/quick-start/placement'
import { useLocale } from '../i18n'
import { getStoredText, setStoredText } from '../latency'
import { log } from '../log'
import { C } from './bits'
import { TEST } from './testhooks'

type Scope = 'catalog' | 'player'
interface Step {
  anchor: string
  title: string
  body: string
}
const GuideContext = createContext({
  register: (_id: string, _node: View | null): void => {},
  start: (_scope: Scope): void => {}
})
export const useQuickStart = () => useContext(GuideContext)
export function useGuideAnchor(id: string): (node: View | null) => void {
  const { register } = useQuickStart()
  return useCallback((node: View | null) => register(id, node), [id, register])
}
export function GuideTarget({ id, ...props }: ViewProps & { id: string }): React.JSX.Element {
  const ref = useGuideAnchor(id)
  return <View {...props} ref={ref} collapsable={false} />
}
async function remember(): Promise<void> {
  try {
    await setStoredText(QUICK_START_SEEN, 'seen')
  } catch (error) {
    log('quick-start', String(error), 'error')
  }
}

export function QuickStartWelcome({ onStart }: { onStart: () => void }): React.JSX.Element | null {
  const locale = useLocale()
  const copy = quickStartCopy(locale, 'mobile')
  const latin = latinMobileGuideCopy(locale)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    let mounted = true
    void getStoredText(QUICK_START_SEEN)
      .then(seen => {
        if (mounted) setVisible(seen !== 'seen')
      })
      .catch(() => {
        if (mounted) setVisible(true)
      })
    return () => {
      mounted = false
    }
  }, [])
  if (!visible) return null
  const dismiss = (): void => {
    setVisible(false)
    void remember()
  }
  return (
    <View style={s.welcome}>
      <Text style={s.heading}>{copy.title}</Text>
      <Text style={s.body}>
        {latin?.welcomeBody ?? (locale === 'ru'
          ? 'Подсказки покажут настоящие кнопки на этом экране. Гид можно повторить в настройках.'
          : 'Follow the balloons beside the controls on this screen. Replay the guide from Settings at any time.')}
      </Text>
      <View style={s.actions}>
        <Pressable accessibilityRole="button" onPress={dismiss} style={s.button}>
          <Text style={s.secondary}>{copy.later}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            dismiss()
            onStart()
          }}
          style={[s.button, s.primary]}
        >
          <Text style={s.primaryText}>{copy.start}</Text>
        </Pressable>
      </View>
    </View>
  )
}

export function QuickStartProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const locale = useLocale()
  const copy = quickStartCopy(locale, 'mobile')
  const latin = latinMobileGuideCopy(locale)
  const ru = locale === 'ru'
  const registry = useRef(new Map<string, View>())
  const register = useCallback((id: string, node: View | null) => {
    if (node) registry.current.set(id, node)
    else registry.current.delete(id)
  }, [])
  const [tour, setTour] = useState<{ steps: Step[]; index: number } | null>(null)
  const [rect, setRect] = useState<GuideRect | null>(null)
  const [cardHeight, setCardHeight] = useState(250)
  const viewport = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const request = useRef(0)
  const measureAnchor = useCallback(
    (anchor: string): Promise<GuideRect | null> =>
      new Promise(resolve => {
        const node = registry.current.get(anchor)
        if (!node) {
          resolve(null)
          return
        }
        const timeout = setTimeout(() => resolve(null), 1000)
        node.measureInWindow((x, y, width, height) => {
          clearTimeout(timeout)
          if (registry.current.get(anchor) !== node) {
            resolve(null)
            return
          }
          const left = Math.max(4, x - 5),
            top = Math.max(insets.top + 4, y - 5)
          const right = Math.min(viewport.width - 4, x + width + 5)
          const bottom = Math.min(viewport.height - insets.bottom - 4, y + height + 5)
          resolve(
            width > 0 && height > 0 && right - left > 12 && bottom - top > 12
              ? { left, top, width: right - left, height: bottom - top }
              : null
          )
        })
      }),
    [viewport.width, viewport.height, insets.top, insets.bottom]
  )
  const start = useCallback(
    (scope: Scope) => {
      const candidates: Step[] =
        scope === 'catalog'
          ? [
              {
                anchor: 'catalog-library',
                title: latin?.libraryTitle ?? (ru ? 'Выберите библиотеку' : 'Choose your library'),
                body: latin?.libraryBody ?? (ru
                  ? 'Здесь можно переключаться между Google Drive, выбранной папкой и песнями на телефоне. Выберите песню ниже, чтобы открыть её.'
                  : 'Switch between Google Drive, a chosen folder and songs on this phone here. Select a song below to open it.')
              },
              { anchor: 'catalog-add', title: copy.steps.library[0], body: copy.steps.library[1] },
              { anchor: 'catalog-split', title: copy.steps.split[0], body: copy.steps.split[1] },
              {
                anchor: 'catalog-sample',
                title: latin?.sampleTitle ?? (ru ? 'Попробуйте демопесню' : 'Try the sample song'),
                body: latin?.sampleBody ?? (ru
                  ? 'Эта песня уже разделена на дорожки. Откройте её, затем нажмите «?» в плеере, чтобы познакомиться с микшером, текстом и повтором.'
                  : 'This song already has its stems. Open it, then tap ? in the player for a tour of the mixer, lyrics and practice controls.')
              },
              {
                anchor: 'training-tab',
                title: copy.steps.training[0],
                body: copy.steps.training[1]
              },
              {
                anchor: 'catalog-settings',
                title: copy.steps.settings[0],
                body: copy.steps.settings[1]
              }
            ]
          : [
              {
                anchor: 'player-mixer',
                title: copy.steps.stems[0],
                body: latin?.mixerBody ?? (ru
                  ? 'Эта кнопка открывает микшер. В нём можно приглушить вокал, изменить громкость отдельных дорожек или включить соло.'
                  : 'Open the mixer here to lower or mute Vocals, adjust each stem’s volume, or solo a part.')
              },
              { anchor: 'player-lyrics', title: copy.steps.lyrics[0], body: copy.steps.lyrics[1] },
              {
                anchor: 'player-loop',
                title: copy.steps.practice[0],
                body: latin?.loopBody ?? (ru
                  ? 'Нажмите A в начале нужного фрагмента, затем B в конце. Плеер будет повторять этот отрывок.'
                  : 'Tap A at the start of a passage, then B at its end. The player repeats that section while you practise.')
              },
              {
                anchor: 'player-practice',
                title: latin?.practiceTitle ?? (ru ? 'Настройте занятия' : 'Adjust your practice'),
                body: latin?.practiceBody ?? (ru
                  ? 'Здесь открываются настройки тональности, темпа, метронома и чередования «слушаю / пою».'
                  : 'Open Practice here for pitch, speed, metronome and alternating listen/sing settings.')
              },
              {
                anchor: 'training-tab',
                title: copy.steps.training[0],
                body: copy.steps.training[1]
              },
              {
                anchor: 'player-about',
                title: latin?.detailsTitle ?? (ru ? 'Информация о песне' : 'Song details'),
                body: latin?.detailsBody ?? (ru
                  ? 'Эта кнопка открывает сведения о песне. Повторить гид можно кнопкой «?» рядом с ней.'
                  : 'Open song details here. Replay this guide with the ? button beside it whenever you need a refresher.')
              }
            ]
      const sequence = ++request.current
      void Promise.all(
        candidates.map(async step => ({ step, rect: await measureAnchor(step.anchor) }))
      ).then(measured => {
        if (sequence !== request.current) return
        const visible = measured.filter(item => item.rect !== null)
        if (visible.length) {
          setRect(visible[0].rect)
          setTour({ steps: visible.map(item => item.step), index: 0 })
        }
      })
    },
    [copy, latin, ru, measureAnchor]
  )
  const value = useMemo(() => ({ register, start }), [register, start])
  const step = tour?.steps[tour.index]
  const currentStep = useRef(step)
  currentStep.current = step
  const measure = useCallback(() => {
    if (!step) return
    void measureAnchor(step.anchor).then(bounds => {
      if (currentStep.current === step) setRect(bounds)
    })
  }, [step, measureAnchor])
  useEffect(() => {
    measure()
    if (step) AccessibilityInfo.announceForAccessibility(step.title)
  }, [step, measure])
  useEffect(
    () => () => {
      request.current++
    },
    []
  )
  const close = (): void => {
    request.current++
    setTour(null)
    setRect(null)
    void remember()
  }
  const move = (delta: number): void => {
    if (!tour) return
    const index = tour.index + delta
    if (index >= tour.steps.length) {
      close()
      return
    }
    if (index < 0) return
    setRect(null)
    setTour({ ...tour, index })
  }
  const placement = placeGuide(
    rect,
    { ...viewport, top: insets.top, bottom: insets.bottom },
    cardHeight
  )
  if (TEST) {
    TEST.startQuickStart = start
    TEST.nextQuickStart = () => move(1)
    TEST.backQuickStart = () => move(-1)
    TEST.closeQuickStart = close
    TEST.quickStart = tour
      ? { index: tour.index, count: tour.steps.length, anchor: step?.anchor, rect, placement }
      : null
  }
  return (
    <GuideContext.Provider value={value}>
      {children}
      <Modal
        visible={tour !== null}
        transparent
        animationType="none"
        statusBarTranslucent
        onShow={measure}
        onRequestClose={close}
      >
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
          {rect ? (
            <>
              <View style={[s.shade, { top: 0, left: 0, right: 0, height: rect.top }]} />
              <View
                style={[s.shade, { top: rect.top, left: 0, width: rect.left, height: rect.height }]}
              />
              <View
                style={[
                  s.shade,
                  { top: rect.top, left: rect.left + rect.width, right: 0, height: rect.height }
                ]}
              />
              <View
                style={[s.shade, { top: rect.top + rect.height, left: 0, right: 0, bottom: 0 }]}
              />
              <View
                pointerEvents="none"
                style={[
                  s.highlight,
                  { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                ]}
              />
            </>
          ) : (
            <View style={[StyleSheet.absoluteFill, s.shade]} />
          )}
          {tour && step && (
            <View
              style={[
                s.balloon,
                {
                  left: placement.left,
                  top: placement.top,
                  width: placement.width,
                  maxHeight: placement.maxHeight
                }
              ]}
            >
              {rect && placement.side !== 'none' && (
                <View
                  style={[
                    s.arrow,
                    placement.side === 'top'
                      ? { top: -7, left: placement.arrow - 7 }
                      : placement.side === 'bottom'
                      ? { bottom: -7, left: placement.arrow - 7 }
                      : placement.side === 'left'
                      ? { left: -7, top: placement.arrow - 7 }
                      : { right: -7, top: placement.arrow - 7 }
                  ]}
                />
              )}
              <ScrollView
                style={{ maxHeight: placement.maxHeight }}
                contentContainerStyle={s.card}
                onContentSizeChange={(_width, height) => setCardHeight(Math.ceil(height))}
              >
                <Text style={s.eyebrow}>
                  {copy.title} · {tour.index + 1} / {tour.steps.length}
                </Text>
                <Text accessibilityRole="header" style={s.heading}>
                  {step.title}
                </Text>
                <Text style={s.body}>{step.body}</Text>
                <View style={s.actions}>
                  <Pressable accessibilityRole="button" onPress={close} style={s.button}>
                    <Text style={s.secondary}>{copy.skip}</Text>
                  </Pressable>
                  <View style={s.row}>
                    {tour.index > 0 && (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => {
                          move(-1)
                        }}
                        style={s.button}
                      >
                        <Text style={s.secondary}>{copy.back}</Text>
                      </Pressable>
                    )}
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => move(1)}
                      style={[s.button, s.primary]}
                    >
                      <Text style={s.primaryText}>
                        {tour.index === tour.steps.length - 1 ? copy.done : copy.next}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </ScrollView>
            </View>
          )}
        </View>
      </Modal>
    </GuideContext.Provider>
  )
}
const s = StyleSheet.create({
  welcome: { padding: 18, marginVertical: 12, borderRadius: 18, backgroundColor: C.sheet, gap: 12 },
  shade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,.7)' },
  highlight: { position: 'absolute', borderColor: C.amber, borderWidth: 2, borderRadius: 8 },
  balloon: {
    position: 'absolute',
    backgroundColor: '#272019',
    borderColor: '#6e5030',
    borderWidth: 1,
    borderRadius: 14,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12
  },
  arrow: {
    position: 'absolute',
    width: 14,
    height: 14,
    backgroundColor: '#272019',
    transform: [{ rotate: '45deg' }]
  },
  card: { padding: 16, gap: 12 },
  eyebrow: { color: C.amber, fontSize: 12 },
  heading: { color: C.text, fontSize: 20, fontWeight: '700' },
  body: { color: C.text, fontSize: 14, lineHeight: 21 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4
  },
  row: { flexDirection: 'row', gap: 2 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10, borderRadius: 24 },
  primary: { backgroundColor: C.amber },
  primaryText: { color: C.amberInk, fontSize: 14, fontWeight: '700' },
  secondary: { color: C.text, fontSize: 14 }
})
