export function pollCompanionRefresh(
  state: { ready: boolean; running: boolean; optimistic: boolean; promptInFlight: boolean; visible: boolean },
  refresh: () => Promise<void>,
): Promise<void> | undefined {
  if ((state.ready || state.running || state.optimistic) && !state.promptInFlight && state.visible) return refresh()
}
