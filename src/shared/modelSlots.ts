/** Exclusive VRAM slots: only one heavy runtime occupies the GPU at a time. */

export type ModelSlot = 'chat' | 'vision' | 'imageGen' | 'idle'

export type ModelSlotPhase = 'ready' | 'switching' | 'error'

export interface ModelSlotStatus {
  slot: ModelSlot
  phase: ModelSlotPhase
  detail: string
  error?: string
}

export function defaultSlotStatus(): ModelSlotStatus {
  return { slot: 'idle', phase: 'ready', detail: '' }
}

export function isModelSlot(v: unknown): v is ModelSlot {
  return v === 'chat' || v === 'vision' || v === 'imageGen' || v === 'idle'
}
