/** Tracks whether an agent turn is running so close-to-tray can warn. */

let busy = false
let stopFn: (() => void) | null = null

export function setAgentGenerationBusy(next: boolean): void {
  busy = next
}

export function isAgentGenerationBusy(): boolean {
  return busy
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
