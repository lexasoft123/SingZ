/** Only native route-identity failures may reopen capture automatically.
 * Permission failures and interruptions require a fresh user gesture. */
export function isTrainingInputRouteChange(error: string): boolean {
  return [
    'iOS audio route changed; restart capture',
    'iOS audio route changed while opening RemoteIO',
    'iOS audio route changed before capture started',
    'iOS audio route changed while capture started',
    'iOS audio route changed while preparing capture',
    'iOS audio session has no active input route',
    'iOS active input route does not match the selected device',
    'iOS audio route changed after the input session was prepared',
    'iOS audio input session lease changed; restart capture'
  ].includes(error)
}
