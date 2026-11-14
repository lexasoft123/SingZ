import type { DesktopRouteLatencySnapshot } from '../../src/shared/types'
export const nativeRouteLatency = (ns = '175000000'): DesktopRouteLatencySnapshot => ({
  interfaceVersion: 1, structSize: 88, routeGeneration: '42', provenance: 'platform-reported', flags: 25,
  confidencePermille: 0, measuredAtNs: '1234567890', automaticPresentationNs: ns,
  renderDeviceNs: '900000000', externalRouteNs: '800000000', userTrimNs: '0', graphToAudibleNs: ns
})
