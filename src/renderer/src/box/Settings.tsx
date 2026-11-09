import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Button } from '@singz/ui'
import type { BoxMetronomeOverride } from '../../../shared/box-contract'
import type {
  DesktopAudioHostDevice,
  DesktopAudioHostInventoryResult
} from '../../../shared/types'
import { tSettings, tMicrophone } from './settings-i18n'
import {
  formatSampleRate,
  formatSampleRateRanges,
  initialSettingsState,
  inputDevices,
  outputApplyIssue,
  outputDevices,
  settingsReducer
} from './settings-model'
import { RoutingSettings } from './RoutingSettings'
import { physicalInputDevices, physicalChannels, physicalInputLevel, physicalInventoryIssue, selectPhysicalChannel, usePhysicalRoutingPreview, type PhysicalSelection, type RoutingPreview } from './physical-inputs-model'
import { microphoneChannelLevel, useMicrophoneSnapshot, type BoxMicrophones, type MicrophoneSnapshot } from './microphones'
import './settings.css'

export interface BoxSettingsProps {
  metronomeOverride?: BoxMetronomeOverride | null
  metronomeBusy?: boolean
  metronomeError?: string | null
  onMetronomeOverride?: (mode: BoxMetronomeOverride) => Promise<void>
  microphones?: BoxMicrophones
  microphoneSnapshot?: MicrophoneSnapshot
  inventory: DesktopAudioHostInventoryResult | null
  loading: boolean
  error: string | null
  currentOutputUid: string | null
  playbackActive: boolean
  onRefresh: () => void
  onApplyOutput: (uid: string) => Promise<void>
  onBack: () => void
  canApplyOutput?: boolean
  applyUnavailableReason?: string | null
}

function deviceName(device: DesktopAudioHostDevice): string {
  return device.label.trim() || tSettings('box.settings.unnamedDevice')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function Settings({
  metronomeOverride = null, metronomeBusy = false, metronomeError = null, onMetronomeOverride,
  microphones,
  microphoneSnapshot: microphoneSnapshotProp,
  inventory,
  loading,
  error,
  currentOutputUid,
  playbackActive,
  onRefresh,
  onApplyOutput,
  onBack,
  canApplyOutput = true,
  applyUnavailableReason = null
}: BoxSettingsProps): React.JSX.Element {
  const [routingOpen, setRoutingOpen] = useState(false)
  // Subscribe here, not in BoxApp, so 5 Hz level telemetry re-renders only this surface.
  const microphoneSnapshot = useMicrophoneSnapshot(microphones, microphoneSnapshotProp)
  // Interfaces plugged in after boot must be known before a channel can be toggled or started.
  useEffect(() => { void microphones?.refreshDevices() }, [microphones])
  const persistent = typeof window !== 'undefined' && window.singz?.boxAudioPersistent === true
  const physical = usePhysicalRoutingPreview(persistent)
  const [physicalSelection, setPhysicalSelection] = useState<PhysicalSelection>(null)
  const outputs = useMemo(() => outputDevices(inventory), [inventory])
  const inputs = useMemo(() => inputDevices(inventory), [inventory])
  const outputUids = useMemo(() => outputs.map(device => device.uid), [outputs])
  const knownOutputUids = !loading && inventory?.ok === true ? outputUids : null
  const [state, dispatch] = useReducer(settingsReducer, currentOutputUid, initialSettingsState)
  const pendingRequest = useRef<{ uid: string; settled: boolean } | null>(null)

  useLayoutEffect(() => {
    dispatch({ type: 'sync', currentOutputUid, outputUids: knownOutputUids })
  }, [currentOutputUid, knownOutputUids])

  useLayoutEffect(() => {
    if (state.pendingOutputUid === null && pendingRequest.current?.settled) {
      pendingRequest.current = null
    }
  }, [state.pendingOutputUid])

  useEffect(() => () => {
    pendingRequest.current = null
  }, [])

  const pending = state.pendingOutputUid !== null
  const microphonePending = microphoneSnapshot?.phase === 'starting' || microphoneSnapshot?.phase === 'stopping'
  const issue = outputApplyIssue({
    uid: state.draftOutputUid,
    committedOutputUid: state.committedOutputUid,
    outputs,
    canApplyOutput,
    loading,
    pending
  })
  const inventoryError = inventory && !inventory.ok ? inventory.error : null
  const parentError = error && error !== inventoryError ? error : null
  const selectionDisabled = pending || loading || !canApplyOutput
  const accepted = state.acceptedOutputUid !== null && state.acceptedOutputUid === currentOutputUid
  const unavailableReason = applyUnavailableReason || tSettings('box.settings.routeUnavailable')

  const selectOutput = (uid: string): void => {
    dispatch({ type: 'select-output', uid, outputs, canApplyOutput, loading })
  }

  const applyOutput = (): void => {
    const uid = state.draftOutputUid
    const activeRequest = pendingRequest.current
    if (
      uid === null || issue !== null || state.pendingOutputUid !== null ||
      (activeRequest !== null && !activeRequest.settled)
    ) return
    const started = settingsReducer(state, {
      type: 'apply-started',
      outputs,
      canApplyOutput,
      loading
    })
    if (started === state) return
    const requestIdentity = { uid, settled: false }
    pendingRequest.current = requestIdentity
    dispatch({ type: 'apply-started', outputs, canApplyOutput, loading })

    const rejected = (caught: unknown): void => {
      if (pendingRequest.current !== requestIdentity) return
      requestIdentity.settled = true
      pendingRequest.current = null
      dispatch({ type: 'apply-rejected', uid, message: errorText(caught) })
    }

    let request: Promise<void>
    try {
      request = onApplyOutput(uid)
    } catch (caught) {
      rejected(caught)
      return
    }
    void request.then(() => {
      if (pendingRequest.current !== requestIdentity) return
      requestIdentity.settled = true
      dispatch({ type: 'apply-resolved', uid })
    }, rejected)
  }

  let actionStatus = ''
  if (state.phase === 'applying') actionStatus = tSettings('box.settings.applying')
  else if (state.phase === 'awaiting-readback') actionStatus = tSettings('box.settings.awaitingReadback')
  else if (!canApplyOutput) actionStatus = unavailableReason
  else if (accepted) actionStatus = tSettings('box.settings.appliedForSession')
  else if (state.draftOutputUid !== null && state.draftOutputUid !== state.committedOutputUid) {
    actionStatus = tSettings('box.settings.draftReady')
  }

  return <main className="box-settings" data-surface="settings" data-routing={routingOpen ? 'open' : 'closed'} aria-label={tSettings('box.settings.navigation')}>
    <div className="settings-heading">
      <div>
        <h1>{tSettings('box.settings.title')}</h1>
        <p>{tSettings('box.settings.subtitle')}</p>
      </div>
      <div className="settings-heading-actions">
        <Button data-settings-routing disabled={pending || !persistent} onClick={() => setRoutingOpen(value => !value)}>{tSettings(routingOpen ? 'box.settings.devicesView' : 'box.settings.routingView')}</Button>
        <Button data-settings-refresh disabled={routingOpen || pending || loading} onClick={() => { onRefresh(); void microphones?.refreshDevices(); void physical.controller.refresh() }}>
          {loading ? tSettings('box.settings.refreshing') : tSettings('box.settings.refresh')}
        </Button>
        <Button data-settings-back disabled={pending || microphonePending || metronomeBusy} onClick={onBack}>← {tSettings('box.settings.back')}</Button>
      </div>
    </div>

    {routingOpen ? <RoutingSettings preview={physical.preview} controller={physical.controller} /> : <><div className="settings-content">
      <section className="settings-panel settings-output-panel" aria-labelledby="box-settings-outputs">
        <div className="settings-panel-heading">
          <div>
            <h2 id="box-settings-outputs">{tSettings('box.settings.outputs')}</h2>
            <p>{tSettings(canApplyOutput ? 'box.settings.outputsHelp' : 'box.settings.outputsReadOnlyHelp')}</p>
          </div>
          {loading && inventory !== null && <span className="settings-panel-state">{tSettings('box.settings.refreshing')}</span>}
        </div>

        {playbackActive && <p className="settings-pause-caption">{tSettings('box.settings.applyPauseCaption')}</p>}
        {parentError && <div className="settings-alert" role="alert"><p>{parentError}</p></div>}
        {inventoryError && <div className="settings-alert" role="alert">
          <strong>{tSettings('box.settings.errorTitle')}</strong>
          <p>{inventoryError}</p>
        </div>}
        {state.error?.kind === 'device-disconnected' && <div className="settings-alert" role="alert">
          <p>{tSettings('box.settings.deviceDisconnected')}</p>
        </div>}
        {state.error?.kind === 'apply-failed' && <div className="settings-alert" role="alert">
          <p>{tSettings('box.settings.applyFailed', { error: state.error.message })}</p>
        </div>}

        <section className="settings-global-overrides" aria-label={tSettings('box.settings.globalOverrides')}>
          <h3>{tSettings('box.settings.globalOverrides')} · {tSettings('box.settings.metronome')}</h3>
          <p>{tSettings('box.settings.metronomePause')}</p>
          <div role="radiogroup" aria-label={tSettings('box.settings.metronome')}>
            {(['song', 'off'] as const).map(mode => <Button key={mode} role="radio"
              data-metronome-override={mode} aria-checked={metronomeOverride === mode}
              disabled={metronomeBusy || pending || !onMetronomeOverride}
              onClick={() => { void onMetronomeOverride?.(mode).catch(() => undefined) }}>
              {tSettings(mode === 'off' ? 'box.settings.metronomeOff' : 'box.settings.metronomeSong')}
            </Button>)}
          </div>
          {metronomeBusy && <p role="status">{tSettings('box.settings.metronomeApplying')}</p>}
          {!metronomeBusy && metronomeOverride === null && <p>{tSettings('box.settings.metronomeUnknown')}</p>}
          {metronomeError && <p role="alert">{metronomeError}</p>}
        </section>
        <div className="settings-output-list" role="radiogroup" aria-label={tSettings('box.settings.outputList')}>
          {outputs.map(device => {
            const draft = state.draftOutputUid === device.uid
            const current = currentOutputUid === device.uid
            return <Button
              key={device.uid}
              className="settings-output-row"
              role="radio"
              aria-checked={draft}
              aria-disabled={selectionDisabled}
              disabled={pending || loading}
              data-settings-output={device.uid}
              onClick={() => selectOutput(device.uid)}
            >
              <span className="settings-radio" aria-hidden="true" />
              <span className="settings-device-copy">
                <strong>{deviceName(device)}</strong>
                <span>{tSettings('box.settings.outputChannels', { count: device.outputChannels })} · {formatSampleRate(device.nominalSampleRate)}</span>
              </span>
              <span className="settings-row-badges">
                {device.defaultOutput && <small>{tSettings('box.settings.defaultOutput')}</small>}
                {current && <small className="settings-current-badge">{tSettings('box.settings.current')}</small>}
                {draft && !current && <small className="settings-draft-badge">{tSettings('box.settings.draft')}</small>}
              </span>
            </Button>
          })}

          {loading && inventory === null && <div className="settings-empty">
            <h3>{tSettings('box.settings.loadingTitle')}</h3>
            <p>{tSettings('box.settings.loadingBody')}</p>
          </div>}
          {!loading && inventory?.ok && outputs.length === 0 && <div className="settings-empty">
            <h3>{tSettings('box.settings.noOutputsTitle')}</h3>
            <p>{tSettings('box.settings.noOutputsBody')}</p>
          </div>}
          {!loading && inventory === null && !parentError && <div className="settings-empty">
            <h3>{tSettings('box.settings.errorTitle')}</h3>
            <p>{tSettings('box.settings.noInventory')}</p>
          </div>}
        </div>
      </section>

      {persistent ? <PhysicalInputsPanel preview={physical.preview} selection={microphoneSnapshot ? microphoneSnapshot.selection : physicalSelection}
        microphones={microphones} microphoneSnapshot={microphoneSnapshot}
        onSelect={(uid, channel) => {
          const selected = selectPhysicalChannel(physical.preview.state, uid, channel)
          if (selected) { if (microphones) microphones.select(selected); else setPhysicalSelection(selected) }
        }} /> : <aside className="settings-panel settings-input-panel" aria-labelledby="box-settings-inputs">
        <div className="settings-panel-heading">
          <div>
            <h2 id="box-settings-inputs">{tSettings('box.settings.inputs')}</h2>
            <p>{tSettings('box.settings.inputsHelp')}</p>
          </div>
          <span className="settings-panel-state">{tSettings('box.settings.readOnly')}</span>
        </div>

        <div className="settings-input-list" aria-label={tSettings('box.settings.inputList')}>
          {inputs.map(device => {
            const rates = formatSampleRateRanges(device)
            return <article
              className="settings-input-row"
              key={device.uid}
              data-settings-input={device.uid}
              data-remote-focus
              tabIndex={0}
            >
              <div className="settings-input-name">
                <strong>{deviceName(device)}</strong>
                <span>{tSettings('box.settings.inputChannels', { count: device.inputChannels })}</span>
              </div>
              <dl>
                <div>
                  <dt>{tSettings('box.settings.nominalRate')}</dt>
                  <dd aria-label={device.nominalSampleRate > 0 ? undefined : tSettings('box.settings.sampleRateUnknown')}>
                    {formatSampleRate(device.nominalSampleRate)}
                  </dd>
                </div>
                <div>
                  <dt>{tSettings('box.settings.supportedRates')}</dt>
                  <dd aria-label={rates === '—' ? tSettings('box.settings.sampleRatesUnknown') : undefined}>{rates}</dd>
                </div>
              </dl>
            </article>
          })}
          {!loading && inputs.length === 0 &&
            (inventoryError !== null || (parentError !== null && inventory === null)) &&
            <div className="settings-empty settings-input-empty">
              <p>{tSettings('box.settings.inputUnavailable')}</p>
            </div>}
          {!loading && inventory?.ok && inputs.length === 0 && <div className="settings-empty settings-input-empty">
            <h3>{tSettings('box.settings.noInputsTitle')}</h3>
          </div>}
          {loading && inventory === null && <div className="settings-empty settings-input-empty">
            <h3>{tSettings('box.settings.loadingTitle')}</h3>
          </div>}
          {!loading && inventory === null && !parentError && <div className="settings-empty settings-input-empty">
            <p>{tSettings('box.settings.inputUnavailable')}</p>
          </div>}
        </div>
        <p className="settings-mic-setup">{tSettings('box.settings.microphoneSetup')}</p>
      </aside>}
    </div>

    <div className="settings-action-band">
      <p className="settings-action-status" aria-live="polite">{actionStatus}</p>
      <div className="settings-actions">
        <Button
          data-settings-cancel
          disabled={pending}
          onClick={() => { dispatch({ type: 'cancel', outputUids: knownOutputUids }); microphones?.resetSelection() }}
        >
          {tSettings('box.settings.cancel')}
        </Button>
        <Button variant="primary" data-settings-apply disabled={issue !== null} onClick={applyOutput}>
          {state.phase === 'applying' ? tSettings('box.settings.applying') : tSettings('box.settings.apply')}
        </Button>
      </div>
    </div></>}

    <footer className="settings-footer">
      <span className="box-key">↑ ↓ ← →</span><span>{tSettings('box.settings.hintMove')}</span>
      <span className="box-key">OK</span><span>{tSettings('box.settings.hintSelect')}</span>
      <span className="box-key">Back</span><span>{tSettings('box.settings.back')}</span>
    </footer>
  </main>
}

/** Physical capture inventory is independent of the virtual song producer.
 * Channel buttons toggle private analysis inputs without changing speaker routes. */
export function PhysicalInputsPanel({ preview, selection, onSelect, microphones, microphoneSnapshot }: {
  microphones?: BoxMicrophones
  microphoneSnapshot?: MicrophoneSnapshot
  preview: RoutingPreview
  selection: PhysicalSelection
  onSelect: (uid: string, channel: number) => void
}): React.JSX.Element {
  const devices = physicalInputDevices(preview.state)
  const issue = preview.error || physicalInventoryIssue(preview.state)
  const microphonePending = microphoneSnapshot?.phase === 'starting' || microphoneSnapshot?.phase === 'stopping'
  const active = microphoneSnapshot?.active
  return <aside className="settings-panel settings-input-panel" aria-labelledby="box-settings-physical-inputs">
    <div className="settings-panel-heading"><div>
      <h2 id="box-settings-physical-inputs">{tMicrophone('box.microphones.inputsTitle')}</h2>
      <p>{tMicrophone('box.microphones.interfaceHelp')}</p>
    </div></div>
    {issue && <p className="settings-input-status" role="status">{issue}</p>}
    <div className="settings-input-list" aria-label={tMicrophone('box.microphones.physicalChannels')}>
      {devices.map(device => <section key={device.uid} data-settings-physical-device={device.uid}>
        <div className="settings-input-name"><strong>{device.name}</strong>
          <span>{tSettings('box.settings.inputChannels', { count: device.inputChannels })}{device.rate ? ` · ${formatSampleRate(device.rate)}` : ''}</span>
        </div>
        <div role="group" aria-label={tMicrophone('box.microphones.deviceChannelGroup', { device: device.name })}>
          {physicalChannels(device).map(({ channel, name }) => {
            const enabled = !microphones || !!microphoneSnapshot?.enabledChannelsByDevice[device.uid]?.includes(channel)
            const privateLevel = microphoneChannelLevel(microphoneSnapshot, device.uid, channel)
            const level = active?.uid === device.uid
              ? privateLevel === null ? null : { peak: privateLevel, rms: privateLevel }
              : physicalInputLevel(preview, device.uid, channel)
            return <Button key={channel} className="settings-physical-channel" aria-pressed={enabled}
              disabled={!!issue || preview.pending || microphoneSnapshot?.phase === 'uncertain'}
              data-settings-input={device.uid} data-input-channel={channel} data-remote-focus
              onClick={() => { if (microphones) void microphones.toggleChannel(device.uid, channel); else onSelect(device.uid, channel) }}>
              <span className="settings-channel-name">{channel + 1}. {name}</span>
              {!enabled ? <span className="settings-channel-unavailable">{tMicrophone('box.microphones.disabled')}</span> : level ? <span className="settings-input-meter" role="meter" aria-label={tMicrophone('box.microphones.namedLevel', { name })}
                aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, level.peak)}
                aria-valuetext={level.peak > 1 ? tMicrophone('box.microphones.clipping') : tMicrophone('box.microphones.percent', { value: Math.round(level.peak * 100) })}>
                <span style={{ transform: `scaleX(${Math.min(1, level.peak)})` }} />
              </span> : <span className="settings-channel-unavailable">{tMicrophone('box.microphones.levelUnavailable')}</span>}
            </Button>
          })}
        </div>
        {device.inputChannels > 64 && <p className="settings-input-status">{tMicrophone('box.microphones.limit64')}</p>}
      </section>)}
      {!issue && devices.length === 0 && <p className="settings-input-status">{tMicrophone('box.microphones.noPhysical')}</p>}
    </div>
    {microphones && microphoneSnapshot ? <div className="settings-analysis-controls">
      <p>{microphoneSnapshot.phase === 'running' && active
        ? tMicrophone('box.microphones.running', { device: active.label, channel: active.channel + 1 })
        : microphoneSnapshot.phase === 'starting' ? tMicrophone('box.microphones.starting')
        : microphoneSnapshot.phase === 'stopping' ? tMicrophone('box.microphones.stopping')
        : microphoneSnapshot.capability === 'unavailable' ? tMicrophone('box.microphones.unavailable')
        : microphoneSnapshot.capability === 'unknown' ? tMicrophone('box.microphones.checking')
        : tMicrophone('box.microphones.select')}</p>
      {(microphoneSnapshot.error || microphoneSnapshot.inventoryError) && <p role="alert">{microphoneSnapshot.error || microphoneSnapshot.inventoryError}</p>}
      <div className="routing-actions">
        <Button data-microphone-start disabled={!selection || !!issue || !!microphoneSnapshot.inventoryError || microphonePending || (microphoneSnapshot.phase === 'running' && active?.uid === selection?.uid && active?.channel === selection?.channel) || microphoneSnapshot.capability !== 'available' || microphoneSnapshot.phase === 'uncertain'}
          onClick={() => { void microphones.start() }}>{tMicrophone(active ? 'box.microphones.switch' : 'box.microphones.start')}</Button>
        <Button data-microphone-stop disabled={microphoneSnapshot.phase === 'stopping' || (!active && microphoneSnapshot.phase !== 'uncertain' && microphoneSnapshot.phase !== 'starting')}
          onClick={() => { void microphones.stop() }}>{tMicrophone('box.microphones.stop')}</Button>
        <Button disabled={microphonePending} onClick={microphones.resetSelection}>{tMicrophone('box.microphones.cancel')}</Button>
      </div>
      <p className="settings-mic-setup">{tMicrophone('box.microphones.note')}</p>
    </div> : <p className="settings-mic-setup">{tMicrophone('box.microphones.routeNote')}</p>}
  </aside>
}
