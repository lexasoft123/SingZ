import { useEffect, useRef, useState } from 'react'
import { Button } from '@singz/ui'
import { cyclePhysicalDevice, physicalInputLevel, physicalChannels, physicalInventoryIssue, type RoutingPreview, type PhysicalRoutingPreview } from './physical-inputs-model'
import { hasSongRoute, musicOutputCommands, microphoneRouteCommands, routingActivationText, songMonitor, routingChannelCount, routingGainSteps, ROUTING_GAIN_STEPS, stepRoutingGain } from './routing-model'
import { tMicrophone, tSettings } from './settings-i18n'

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
    catch (caught) { musicIssue = caught instanceof Error ? caught.message : tSettings('box.settings.routing.outputUnavailable') }
  }
  let microphoneIssue = ''
  if (state && selectedInput && selectedMicrophoneOutput) {
    try { microphoneRouteCommands(state, selectedInput.uid, channel, selectedMicrophoneOutput.uid, microphoneFirstChannel) }
    catch (caught) { microphoneIssue = caught instanceof Error ? caught.message : tSettings('box.settings.routing.microphoneUnavailable') }
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
    catch (caught) { setError(caught instanceof Error ? caught.message : tSettings('box.settings.routing.invalidMusic')) }
  }
  const createMicrophoneRoute = (): void => {
    if (!state || !selectedMicrophoneOutput || !selectedInput) return
    try { void apply(microphoneRouteCommands(state, selectedInput.uid, channel, selectedMicrophoneOutput.uid, microphoneFirstChannel)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : tSettings('box.settings.routing.invalidMicrophone')) }
  }
  return <section className="settings-panel routing-panel" aria-label={tSettings('box.settings.routing.title')}>
    <div className="settings-panel-heading"><div><h2>{tSettings('box.settings.routing.title')}</h2>
      <p>{tSettings('box.settings.routing.help')}</p></div>
      <Button disabled={busy} onClick={() => { void controller.refresh() }}>{tSettings('box.settings.routing.refresh')}</Button>
    </div>
    {(error || preview.error) && <div className="settings-alert" role="alert"><p>{error || preview.error}</p></div>}
    {state && physicalInventoryIssue(state) && <p role="status">{physicalInventoryIssue(state)}</p>}
    {state && <p className="routing-status" aria-live="polite">{preview.receivedAt === null || preview.error ? tSettings('box.settings.routing.statusUnavailable') : routingActivationText(state)}</p>}
    {!state && !error && <p>{tSettings('box.settings.routing.connecting')}</p>}
    <div className="routing-list">
      {state && <div className="routing-route">
        <h3>{tSettings(hasSongRoute(state) ? 'box.settings.routing.musicChange' : 'box.settings.routing.musicNew')}</h3><p>{tSettings('box.settings.routing.musicHelp')}</p>
        <div className="routing-actions">
          <Button disabled={busy || !outputs.length} onClick={() => { setOutput(value => cyclePhysicalDevice(outputs, value)); setPair(0) }}>{selected?.name ?? tSettings('box.settings.routing.noOutput')}</Button>
          <Button disabled={busy || !selected} onClick={() => setPair(value => (value + 1) % pairCount)}>{tSettings('box.settings.routing.channels', { first: firstChannel + 1, last: firstChannel + 2 })}</Button>
          <Button disabled={busy || !selected || !!musicIssue} onClick={createSongRoute}>{tSettings('box.settings.routing.applyMusic')}</Button>
          <Button disabled={busy} onClick={cancelDraft}>{tSettings('box.settings.routing.cancel')}</Button>
          {musicIssue && <p role="status">{musicIssue}</p>}
        </div>
      </div>}
      {state && <div className="routing-route">
        <h3>{tSettings('box.settings.routing.microphoneTitle')}</h3>
        <p>{tSettings('box.settings.routing.microphoneHelp')}</p>
        <Button disabled={busy} onClick={() => setMicrophoneOpen(value => !value)}>{tSettings(microphoneOpen ? 'box.settings.routing.hideSoftware' : 'box.settings.routing.showSoftware')}</Button>
        {microphoneOpen && <div className="routing-actions">
          <Button disabled={busy || !inputs.length} onClick={() => { setInput(value => cyclePhysicalDevice(inputs, value)); setInputChannel(0) }}>{selectedInput?.name ?? tSettings('box.settings.routing.noMicrophone')}</Button>
          <Button disabled={busy || !selectedInput} onClick={() => setInputChannel(value => (value + 1) % Math.max(1, routingChannelCount(selectedInput?.inputChannels ?? 1)))}>{selectedInput ? physicalChannels(selectedInput)[channel]?.name ?? tMicrophone('box.microphones.channelLabel', { channel: channel + 1 }) : tSettings('box.settings.routing.inputChannelUnavailable')}</Button>
          <Button disabled={busy || !outputs.length} onClick={() => { setMicrophoneOutput(value => cyclePhysicalDevice(outputs, value)); setMicrophonePair(0) }}>→ {selectedMicrophoneOutput?.name ?? tSettings('box.settings.routing.noOutput')}</Button>
          <Button disabled={busy || !selectedMicrophoneOutput} onClick={() => setMicrophonePair(value => (value + 1) % microphonePairCount)}>{tSettings('box.settings.routing.outputChannels', { first: microphoneFirstChannel + 1, last: microphoneFirstChannel + 2 })}</Button>
          <Button disabled={busy || !selectedMicrophoneOutput || !selectedInput || !!microphoneIssue} onClick={createMicrophoneRoute}>{tSettings('box.settings.routing.applyMicrophone')}</Button>
          <Button disabled={busy} onClick={cancelDraft}>{tSettings('box.settings.routing.cancel')}</Button>
          {microphoneIssue && <p role="status">{microphoneIssue}</p>}
        </div>}
      </div>}
      {devices.map(device => <div className="routing-route" key={device.id}>
        <h3>{device.name}</h3>
        {device.routing.sources.map(source => {
          const binding = device.bindings.find(item => item.id === source.id)
          const label = binding?.selector === 'native:singz' ? tSettings('box.settings.routing.song') : binding?.kind === 'input-device' ? tSettings('box.settings.routing.inputSource') : source.id
          return <div className="routing-source" key={source.id}>
            <strong>{label}</strong>
            {binding?.kind === 'input-device' && <p className="routing-input-levels">
              {source.connections.filter((wire, index, wires) => wires.findIndex(row => row.sourceChannel === wire.sourceChannel) === index).map(wire => {
                const endpoint = state?.inventory.devices.find(row => row.uid === binding.selector)
                const name = endpoint ? physicalChannels(endpoint)[wire.sourceChannel]?.name : undefined
                const level = physicalInputLevel(preview, binding.selector, wire.sourceChannel)
                return <span key={wire.sourceChannel}>{name ?? tSettings('box.settings.routing.inputShort', { channel: wire.sourceChannel + 1 })}: {level ? `${Math.round(level.peak * 100)}%` : tMicrophone('box.microphones.levelUnavailable')}</span>
              })}
            </p>}
            <p>{source.connections.map(wire => `${wire.sourceChannel + 1} → ${wire.outputChannel + 1}`).join(' · ') || tSettings('box.settings.routing.noConnections')}</p>
            <div className="routing-actions">
              <Button disabled={busy} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { enabled: !source.enabled } }]) }}>{tSettings(source.enabled ? 'box.settings.routing.disable' : 'box.settings.routing.enable')}</Button>
              <Button disabled={busy} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { muted: !source.muted } }]) }}>{tSettings(source.muted ? 'box.settings.routing.unmute' : 'box.settings.routing.mute')}</Button>
              <Button data-routing-gain="down" aria-label={tSettings('box.settings.routing.gainDown', { name: label })} disabled={busy || routingGainSteps(source.gain) <= 0} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { gain: stepRoutingGain(source.gain, -1) } }]) }}>−</Button>
              <span>{Math.round(source.gain * 100)}%</span>
              <Button data-routing-gain="up" aria-label={tSettings('box.settings.routing.gainUp', { name: label })} disabled={busy || routingGainSteps(source.gain) >= ROUTING_GAIN_STEPS} onClick={() => { void apply([{ type: 'setSourceControls', device: device.id, source: source.id, controls: { gain: stepRoutingGain(source.gain, 1) } }]) }}>+</Button>
            </div>
          </div>
        })}
        {device.monitors.map(monitor => {
          const endpoint = state?.inventory.devices.find(item => item.uid === monitor.deviceSelector)
          const live = state?.snapshot.runtime.monitors.find(item => item.device === device.id && item.monitor === monitor.id)
          return <div className="routing-output" key={monitor.id}><strong>→ {endpoint?.name ?? tSettings('box.settings.routing.outputOffline')}</strong>
            <p>{monitor.connections.map(wire => `${wire.sourceChannel + 1} → ${wire.outputChannel + 1}`).join(' · ')} · {tSettings(live?.sourceOnline ? 'box.settings.routing.sourceConnected' : 'box.settings.routing.sourceUnavailable')}</p>
          </div>
        })}
      </div>)}
    </div>
  </section>
}
