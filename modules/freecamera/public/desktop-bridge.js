// This module adapter keeps camera methods out of the platform preload.
const bridge = globalThis.window?.atbDesktop;
export const cameraDesktop = bridge?.isDesktop && bridge.hasModule?.('freecamera') ? Object.freeze({
  isDesktop: true,
  openCompute: () => bridge.invokeModule('freecamera', 'compute-open'),
  closeCompute: options => bridge.invokeModule('freecamera', 'compute-close', options),
  computeHeartbeat: options => bridge.invokeModule('freecamera', 'compute-heartbeat', options),
  detectionState: () => bridge.invokeModule('freecamera', 'detection-state'),
  configureDetection: options => bridge.invokeModule('freecamera', 'detection-configure', options),
  detectFrame: options => bridge.invokeModule('freecamera', 'detection-frame', options),
  beginRecording: options => bridge.invokeModule('freecamera', 'recording-begin', options),
  writeRecording: options => bridge.invokeModule('freecamera', 'recording-write', options),
  endRecording: options => bridge.invokeModule('freecamera', 'recording-end', options),
  saveSnapshot: options => bridge.invokeModule('freecamera', 'snapshot', options),
  openConnectionSettings: () => bridge.openConnectionSettings(),
  returnToViewer: () => bridge.returnToViewer(),
  saveConnectionDraft: options => bridge.saveConnectionDraft(options),
  connectionState: () => bridge.connectionState(),
  chooseConnectionCertificate: () => bridge.chooseConnectionCertificate(),
  selectConnection: options => bridge.selectConnection(options),
  notify: options => bridge.notify(options),
}) : undefined;
