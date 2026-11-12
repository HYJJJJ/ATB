// Module-owned adapter keeps assistant IPC out of the platform preload.
export function assistantDesktop() {
  const desktop = globalThis.window?.atbDesktop;
  if (!desktop?.isDesktop || !desktop.hasModule('assistant')) return undefined;
  return { voice: (action, options = {}) => desktop.invokeModule('assistant', 'voice', { action, ...options }) };
}
