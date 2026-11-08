import { useEffect, useRef, useState } from 'react'
import { Button } from '@singz/ui'
import { cyclePhysicalDevice, physicalInputLevel, physicalChannels, physicalInventoryIssue, type RoutingPreview, type PhysicalRoutingPreview } from './physical-inputs-model'
import { hasSongRoute, musicOutputCommands, microphoneRouteCommands, routingActivationText, songMonitor, routingChannelCount } from './routing-model'

/** Remote-only route editing. No song stop, prepare or device open is performed by this UI. */
export function RoutingSettings({ preview, controller }: { preview: RoutingPreview; controller: PhysicalRoutingPreview }): React.JSX.Element {
  const state = preview.state
  const [error, setError] = useState('')
  const busy = preview.pending
  const [output, setOutput] = useState<string | null>(null)
  const [pair, setPair] = useState(0)
  const [microphoneOpen, setMicrophoneOpen] = useState(false)
  const [input, setInput] = useState<string | null>(null)
  const [inputChannel, setInputChannel] = useState(0)
  const [microphoneOutput, setMicrophoneOutput] = useState<string | null>(null)
  const [microphonePair, setMicrophonePair] = useState(0)
  // Hydrate draft output once per service epoch, never on meter refreshes.
  const draftEpoch = useRef<string | null>(null)
  useEffect(() => {
    if (!state || draftEpoch.current === state.snapshot.revision.epoch) return
    draftEpoch.current = state.snapshot.revision.epoch
    const committed = songMonitor(state)
    const available = state.inventory.devices.filter(device => device.outputChannels >= 2)
    setOutput(available.find(device => device.uid === committed?.outputUid)?.uid ?? available[0]?.uid ?? null)
    setInput(state.inventory.devices.find(device => device.inputChannels > 0)?.uid ?? null)
    setMicrophoneOutput(available[0]?.uid ?? null)
    setPair(Math.floor((committed?.firstChannel ?? 0) / 2))
  }, [state])
  const outputs = state?.inventory.devices.filter(device => device.outputChannels >= 2) ?? []
  const selected = outputs.find(device => device.uid === output)
  const pairCount = Math.floor(routingChannelCount(selected?.outputChannels ?? 2) / 2)
  const firstChannel = pair * 2
  const devices = state?.snapshot.document?.devices ?? []
  const inputs = state?.inventory.devices.filter(device => device.inputChannels > 0) ?? []
  const selectedInput = inputs.find(device => device.uid === input)
  const channel = inputChannel
  const selectedMicrophoneOutput = outputs.find(device => device.uid === microphoneOutput)
  const microphonePairCount = Math.max(1, Math.floor(routingChannelCount(selectedMicrophoneOutput?.outputChannels ?? 2) / 2))
  const microphoneFirstChannel = microphonePair * 2
  let musicIssue = ''
  if (state && selected) {
    try { musicOutputCommands(state, selected.uid, firstChannel) }
    catch (caught) { musicIssue = caught instanceof Error ? caught.message : 'This output route is unavailable.' }
  }
  let microphoneIssue = ''
  if (state && selectedInput && selectedMicrophoneOutput) {
    try { microphoneRouteCommands(state, selectedInput.uid, channel, selectedMicrophoneOutput.uid, microphoneFirstChannel) }
    catch (caught) { microphoneIssue = caught instanceof Error ? caught.message : 'This microphone route is unavailable.' }
  }
  const cancelDraft = (): void => {
    const committed = state ? songMonitor(state) : null
    setOutput(outputs.find(device => device.uid === committed?.outputUid)?.uid ?? outputs[0]?.uid ?? null)
    setPair(Math.floor((committed?.firstChannel ?? 0) / 2))
    setInput(inputs[0]?.uid ?? null); setInputChannel(0); setMicrophoneOutput(outputs[0]?.uid ?? null); setMicrophonePair(0); setMicrophoneOpen(false); setError('')
  }
  const apply = async (commands: unknown[]): Promise<void> => {
    if (!state) return
    const accepted = await controller.edit(state.snapshot.revision, commands)
    if (accepted) setError('')
  }
  const createSongRoute = (): void => {
    if (!state || !selected) return
    try { void apply(musicOutputCommands(state, selected.uid, firstChannel)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid music route.') }
  }
  const createMicrophoneRoute = (): void => {
    if (!state || !selectedMicrophoneOutput || !selectedInput) return
    try { void apply(microphoneRouteCommands(state, selectedInput.uid, channel, selectedMicrophoneOutput.uid, microphoneFirstChannel)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Invalid microphone route.') }
  }
  return <section className="settings-panel routing-panel" aria-label="Audio routing">
    <div className="settings-panel-heading"><div><h2>Audio routing</h2>
      <p>Music and enabled routes keep running while you browse. Microphone monitoring stays on your mixer unless you explicitly configure a software route.</p></div>
      <Button disabled={busy} onClick={() => { void controller.refresh() }}>Refresh</Button>
    </div>
    {(error || preview.error) && <div className="settings-alert" role="alert"><p>{error || preview.error}</p></div>}
    {state && physicalInventoryIssue(state) && <p role="status">{physicalInventoryIssue(state)}</p>}
    {state && <p className="routing-status" aria-live="polite">{preview.receivedAt === null || preview.error ? 'Routing status unavailable. Refresh to read the audio host.' : routingActivationText(state)} Saved revision {state.snapshot.restoration.desiredGeneration} · Active revision {state.snapshot.restoration.activeGeneration}</p>}
    {!state && !error && <p>Connecting to the audio host…</p>}
    <div className="routing-list">
      {state && <div className="routing-route">
        <h3>Music → speakers {hasSongRoute(state) ? '· change output' : '· new route'}</h3><p>Choose the physical playback channels. Use the documented channels for your interface. Keep microphone monitoring on FLOW 8 hardware and HDMI video only unless you choose another route.</p>
        <div className="routing-actions">
          <Button disabled={busy || !outputs.length} onClick={() => { setOutput(value => cyclePhysicalDevice(outputs, value)); setPair(0) }}>{selected?.name ?? 'No output available'}</Button>
          <Button disabled={busy || !selected} onClick={() => setPair(value => (value + 1) % pairCount)}>Channels {firstChannel + 1}–{firstChannel + 2}</Button>
          <Button disabled={busy || !selected || !!musicIssue} onClick={createSongRoute}>Apply music output</Button>
          <Button disabled={busy} onClick={cancelDraft}>Cancel changes</Button>
          {musicIssue && <p role="status">{musicIssue}</p>}
        </div>
      </div>}
      {state && <div className="routing-route">
        <h3>Microphone monitoring</h3>
        <p>Hardware monitoring on your mixer is the default. Optional software monitoring adds delay and can feed back. Matching stereo outputs share one mix bus. Use it only when the microphone input and speaker output use different interfaces.</p>
        <Button disabled={busy} onClick={() => setMicrophoneOpen(value => !value)}>{microphoneOpen ? 'Hide software setup' : 'Set up optional software monitoring'}</Button>
        {microphoneOpen && <div className="routing-actions">
          <Button disabled={busy || !inputs.length} onClick={() => { setInput(value => cyclePhysicalDevice(inputs, value)); setInputChannel(0) }}>{selectedInput?.name ?? 'No microphone input'}</Button>
          <Button disabled={busy || !selectedInput} onClick={() => setInputChannel(value => (value + 1) % Math.max(1, routingChannelCount(selectedInput?.inputChannels ?? 1)))}>{selectedInput ? physicalChannels(selectedInput)[channel]?.name ?? `Input channel ${channel + 1}` : 'Input channel unavailable'}</Button>
          <Button disabled={busy || !outputs.length} onClick={() => { setMicrophoneOutput(value => cyclePhysicalDevice(outputs, value)); setMicrophonePair(0) }}>→ {selectedMicrophoneOutput?.name ?? 'No output available'}</Button>
          <Button disabled={busy || !selectedMicrophoneOutput} onClick={() => setMicrophonePair(value => (value + 1) % microphonePairCount)}>Output channels {microphoneFirstChannel + 1}–{microphoneFirstChannel + 2}</Button>
          <Button disabled={busy || !selectedMicrophoneOutput || !selectedInput || !!microphoneIssue} onClick={createMicrophoneRoute}>Apply software microphone route</Button>
          <Button disabled={busy} onClick={cancelDraft}>Cancel changes</Button>
          {microphoneIssue && <p role="status">{microphoneIssue}</p>}
        </div>}
      </div>}
      {devices.map(device => <div className="routing-route" key={device.id}>
        <h3>{device.name}</h3>
        {device.routing.sources.map(source => {
          const binding = device.bindings.find(item => item.id === source.id)
          const label = binding?.selector === 'native:singz' ? 'Song' : binding?.kind === 'input-device' ? 'Microphone / input' : source.id
          return <div className="routing-source" key={source.id}>
            <strong>{label}</strong>
            {binding?.kind === 'input-device' && <p className="routing-input-levels">
              {source.connections.filter((wire, index, wires) => wires.findIndex(row => row.sourceChannel === wire.sourceChannel) === index).map(wire => {
                const endpoint = state?.inventory.devices.find(row => row.uid === binding.selector)
                const name = endpoint ? physicalChannels(endpoint)[wire.sourceChannel]?.name : undefined
                const level = physicalInputLevel(preview, binding.selector, wire.sourceChannel)
                return <span key={wire.sourceChannel}>{name ?? `Input ${wire.sourceChannel + 1}`}: {level ? `${Math.round(level.peak * 100)}%` : 'Level unavailable'}</span>
              })}
            </p>}
            <p>{source.connections.map(wire => `${wire.sourceChannel + 1} → ${wire.outputChannel + 1}`).join(' · ') || 'No channels connected'}</p>
            <div className="routing-actions">
              <Button disabled={busy} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { enabled: !source.enabled } }]) }}>{source.enabled ? 'Disable' : 'Enable'}</Button>
              <Button disabled={busy} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { muted: !source.muted } }]) }}>{source.muted ? 'Unmute' : 'Mute'}</Button>
              <Button disabled={busy || source.gain <= 0} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { gain: Math.max(0, source.gain - 0.1) } }]) }}>−</Button>
              <span>{Math.round(source.gain * 100)}%</span>
              <Button disabled={busy || source.gain >= 1} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { gain: Math.min(1, source.gain + 0.1) } }]) }}>+</Button>
            </div>
          </div>
        })}
        {device.monitors.map(monitor => {
          const endpoint = state?.inventory.devices.find(item => item.uid === monitor.deviceSelector)
          const live = state?.snapshot.runtime.monitors.find(item => item.device === device.id && item.monitor === monitor.id)
          return <div className="routing-output" key={monitor.id}><strong>→ {endpoint?.name ?? 'Output offline'}</strong>
            <p>{monitor.connections.map(wire => `${wire.sourceChannel + 1} → ${wire.outputChannel + 1}`).join(' · ')} · {live?.sourceOnline ? 'Source connected' : 'Source unavailable'}</p>
          </div>
        })}
      </div>)}
    </div>
  </section>
}
