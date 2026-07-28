import React, { useEffect, useState } from 'react'
import { StatusBar, View } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { MultitrackEngine } from './src/engine'
import type { LoadedProject } from './src/projects'
import CatalogScreen from './src/ui/CatalogScreen'
import PlayerScreen from './src/ui/PlayerScreen'
import { TEST } from './src/ui/testhooks'

const engine = new MultitrackEngine()
if (TEST) TEST.engine = engine

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)

  useEffect(() => {
    AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default' })
    void AudioManager.setAudioSessionActivity(true)
  }, [])

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: '#0d0a06' }}>
        <StatusBar barStyle="light-content" />
        {project === null ? (
          <CatalogScreen sampleRate={engine.sampleRate} onLoaded={setProject} />
        ) : (
          <PlayerScreen engine={engine} project={project} onBack={() => setProject(null)} />
        )}
      </View>
    </SafeAreaProvider>
  )
}
