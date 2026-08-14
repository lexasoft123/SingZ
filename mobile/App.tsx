import React, { useCallback, useEffect, useState } from 'react'
import { StatusBar, View } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { MultitrackEngine } from './src/engine'
import { logStartup } from './src/log'
import { releaseProject, type LoadedProject } from './src/projects'
import { C } from './src/ui/bits'
import CatalogScreen from './src/ui/CatalogScreen'
import PlayerScreen from './src/ui/PlayerScreen'
import { TEST } from './src/ui/testhooks'

const engine = new MultitrackEngine()
if (TEST) TEST.engine = engine

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)

  useEffect(() => {
    // First line of the session, before anything can go wrong underneath it.
    void logStartup()
    AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default' })
    void AudioManager.setAudioSessionActivity(true)
  }, [])

  /* Closing a song frees its stems here, where they are owned: the engine
   * drops its tracks and source nodes, and the LoadedProject stops holding
   * the buffers so the last reference dies with this state update. Waiting
   * for GC to notice instead is what let songs stack up to a jetsam kill. */
  const closeProject = useCallback(() => {
    engine.unload()
    setProject((p) => {
      releaseProject(p)
      return null
    })
  }, [])

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <StatusBar barStyle="light-content" />
        {project === null ? (
          <CatalogScreen sampleRate={engine.sampleRate} onLoaded={setProject} />
        ) : (
          <PlayerScreen engine={engine} project={project} onBack={closeProject} />
        )}
      </View>
    </SafeAreaProvider>
  )
}
