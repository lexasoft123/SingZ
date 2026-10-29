import React from 'react'
import ReactTestRenderer, { act } from 'react-test-renderer'
import { Modal, View } from 'react-native'
import { QuickStartProvider, useQuickStart } from '../src/ui/QuickStart'
import { TEST } from '../src/ui/testhooks'

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 })
}))

jest.mock('../src/i18n', () => ({ useLocale: () => 'en' }))
jest.mock('../src/latency', () => ({
  getStoredText: jest.fn(async () => 'seen'),
  setStoredText: jest.fn(async () => undefined)
}))
jest.mock('../src/log', () => ({ log: jest.fn() }))
jest.mock('../src/ui/bits', () => ({
  C: { text: '#fff', amber: '#ffa028', amberInk: '#000', sheet: '#272019' }
}))

type Measure = (x: number, y: number, width: number, height: number) => void
let api: ReturnType<typeof useQuickStart>
function Controls(): React.JSX.Element {
  api = useQuickStart()
  return <View />
}
async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await act(async () => {
    tree = ReactTestRenderer.create(
      <QuickStartProvider>
        <Controls />
      </QuickStartProvider>
    )
  })
  return tree
}
const controls = TEST as {
  closeQuickStart: () => void
  nextQuickStart: () => void
  quickStart: { anchor: string; count: number; index: number; rect: unknown } | null
}

describe('mobile guide native measurements', () => {
  let tree: ReactTestRenderer.ReactTestRenderer
  afterEach(async () => {
    if (tree) await act(async () => tree.unmount())
  })

  it('does not reopen a dismissed tour when a native measurement arrives late', async () => {
    tree = await mount()
    const callbacks: Measure[] = []
    api.register('catalog-library', {
      measureInWindow: (callback: Measure) => callbacks.push(callback)
    } as unknown as View)
    await act(async () => {
      api.start('catalog')
    })
    await act(async () => {
      controls.closeQuickStart()
    })
    await act(async () => {
      callbacks.forEach(callback => callback(20, 120, 300, 44))
    })
    expect(tree.root.findByType(Modal).props.visible).toBe(false)
    expect(controls.quickStart).toBeNull()
  })

  it('only guides controls visible in the window and completes through the normal transition', async () => {
    tree = await mount()
    api.register('catalog-library', {
      measureInWindow: (callback: Measure) => callback(20, 120, 300, 44)
    } as unknown as View)
    api.register('catalog-sample', {
      measureInWindow: (callback: Measure) => callback(20, -500, 300, 60)
    } as unknown as View)
    await act(async () => {
      api.start('catalog')
    })
    expect(controls.quickStart).toMatchObject({ anchor: 'catalog-library', count: 1, index: 0 })
    expect(tree.root.findByType(Modal).props.visible).toBe(true)
    await act(async () => {
      controls.nextQuickStart()
    })
    expect(tree.root.findByType(Modal).props.visible).toBe(false)
  })

  it('drops coordinates from a control that was unmounted during measurement', async () => {
    tree = await mount()
    let reply!: Measure
    api.register('catalog-library', {
      measureInWindow: (callback: Measure) => {
        reply = callback
      }
    } as unknown as View)
    await act(async () => {
      api.start('catalog')
    })
    api.register('catalog-library', null)
    await act(async () => {
      reply(20, 120, 300, 44)
    })
    expect(tree.root.findByType(Modal).props.visible).toBe(false)
  })
})
