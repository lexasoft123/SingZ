import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import BottomTabs, { type RootTabParamList } from '../src/ui/BottomTabs'

const Tabs = createBottomTabNavigator<RootTabParamList>()
const EmptyScene = (): null => null

test('React Navigation owns the persistent Songs and Train tabs', async () => {
  const onTrainPress = jest.fn()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 }
        }}
      >
        <NavigationContainer>
          <Tabs.Navigator
            initialRouteName="songs"
            screenOptions={{ headerShown: false, lazy: false }}
            tabBar={BottomTabs}
          >
            <Tabs.Screen name="songs" component={EmptyScene} options={{ title: 'Songs' }} />
            <Tabs.Screen
              name="training"
              component={EmptyScene}
              options={{ title: 'Train' }}
              listeners={{ tabPress: onTrainPress }}
            />
          </Tabs.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>
    )
  })
  const tabs = tree.root.findAll((node) => node.props.accessibilityRole === 'tab')
  expect([...new Set(tabs.map((tab) => tab.props.accessibilityLabel))]).toEqual(['Songs', 'Train'])
  expect(tabs.find((tab) => tab.props.accessibilityLabel === 'Songs')?.props.accessibilityState).toEqual({
    selected: true
  })
  const train = tabs.find((tab) => tab.props.accessibilityLabel === 'Train' && typeof tab.props.onPress === 'function')!
  await ReactTestRenderer.act(() => train.props.onPress())
  expect(onTrainPress).toHaveBeenCalledTimes(1)
  expect(
    tree.root.findAll((node) => node.props.accessibilityLabel === 'Train' && node.props.accessibilityRole === 'tab')[0]
      .props.accessibilityState
  ).toEqual({
    selected: true
  })

  onTrainPress.mockClear()
  const selectedTrain = tree.root.findAll(
    (node) =>
      node.props.accessibilityLabel === 'Train' &&
      node.props.accessibilityRole === 'tab' &&
      typeof node.props.onPress === 'function'
  )[0]
  await ReactTestRenderer.act(() => selectedTrain.props.onPress())
  expect(onTrainPress).not.toHaveBeenCalled()
  await ReactTestRenderer.act(() => tree.unmount())
})
