import React from 'react'
import ReactTestRenderer, { act } from 'react-test-renderer'
import { View } from 'react-native'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import RootNavigator from '../src/ui/RootNavigator'
import WhatsNewScreen from '../src/ui/WhatsNewScreen'
import { getStoredText } from '../src/latency'
import type { MultitrackEngine } from '../src/engine'

jest.mock('../src/ui/CatalogScreen', () => () => null)
jest.mock('../src/ui/PlayerScreen', () => () => null)
jest.mock('../src/latency', () => ({
  ...jest.requireActual('../src/latency'),
  getStoredText: jest.fn(async () => '0.26.3'),
  setStoredText: jest.fn(async () => undefined)
}))

const Tabs = createBottomTabNavigator<{ songs: undefined; training: undefined }>()
const Empty = () => <View />

// Real routers preserve the parent tab history that caused this regression.
test.each(['close', 'done'])('%s dismisses startup news after visiting Training', async button => {
  jest.mocked(getStoredText).mockResolvedValue('0.26.3')
  const navigation = createNavigationContainerRef<{ songs: undefined; training: undefined }>()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await act(async () => {
    tree = ReactTestRenderer.create(<SafeAreaProvider><NavigationContainer ref={navigation}>
      <Tabs.Navigator initialRouteName="songs" backBehavior="history" screenOptions={{ headerShown: false, lazy: false }}>
        <Tabs.Screen name="songs">{() => <RootNavigator
          engine={{ sampleRate: 48000 } as MultitrackEngine} route={null} trimMs={0}
          onTrim={() => {}} onProjectLoaded={() => {}} onProjectClosed={() => {}} onTrainingFacts={() => {}}
        />}</Tabs.Screen>
        <Tabs.Screen name="training" component={Empty} />
      </Tabs.Navigator>
    </NavigationContainer></SafeAreaProvider>)
  })
  try {
    await act(() => navigation.navigate('training'))
    await act(() => navigation.navigate('songs'))
    expect(navigation.canGoBack()).toBe(true)
    const news = tree.root.findByType(WhatsNewScreen)
    const buttons = news.findAll(node => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function')
    await act(() => buttons[button === 'close' ? 0 : buttons.length - 1].props.onPress())
    const state = navigation.getRootState()!
    expect(state.routes[state.index].name).toBe('songs')
    const songs = state.routes.find(route => route.name === 'songs')!.state!
    expect(songs.routes.map(route => route.name)).toEqual(['Catalog'])
    expect(tree.root.findAllByType(WhatsNewScreen)).toHaveLength(0)

    // Manual news opening must still return to Settings.
    await act(() => navigation.navigate('songs', { screen: 'Settings' } as never))
    await act(() => navigation.navigate('songs', { screen: 'WhatsNew' } as never))
    await act(() => tree.root.findByType(WhatsNewScreen).props.onClose())
    const manualState = navigation.getRootState()!.routes.find(route => route.name === 'songs')!.state!
    expect(manualState.routes.map(route => route.name)).toEqual(['Catalog', 'Settings'])
  } finally {
    await act(() => tree.unmount())
  }
})
