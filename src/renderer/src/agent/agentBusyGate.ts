/** Tracks whether an agent turn is running so close-to-tray can warn. */

let busy = false
let stopFn: (() => void) | null = null
const busyListeners = new Set<(next: boolean) => void>()

export function setAgentGenerationBusy(next: boolean): void {
  if (busy === next) return
  busy = next
  for (const fn of busyListeners) {
    try {
      fn(next)
    } catch {
      /* ignore */
    }
  }
}

export function isAgentGenerationBusy(): boolean {
  return busy
}

/** Subscribe to agent busy changes (e.g. abort FIM when agent starts). */
export function onAgentGenerationBusy(fn: (next: boolean) => void): () => void {
  busyListeners.add(fn)
  return () => {
    busyListeners.delete(fn)
  }
}

/** Register ChatPanel stop handler; returns unregister. */
export function registerAgentGenerationStop(fn: () => void): () => void {
  stopFn = fn
  return () => {
    if (stopFn === fn) stopFn = null
  }
}

export function stopAgentGeneration(): void {
  stopFn?.()
}
