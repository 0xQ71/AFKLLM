import { useCallback, useState } from 'react'

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

function readStored(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n)) return fallback
    return clamp(n, min, max)
  } catch {
    return fallback
  }
}

/** Persisted panel width (px) with clamp on every update. */
export function useLayoutWidth(
  key: string,
  fallback: number,
  min: number,
  max: number
): [number, (next: number | ((prev: number) => number)) => void] {
  const [width, setWidth] = useState(() => readStored(key, fallback, min, max))

  const set = useCallback(
    (next: number | ((prev: number) => number)) => {
      setWidth((prev) => {
        const raw = typeof next === 'function' ? next(prev) : next
        const c = clamp(raw, min, max)
        try {
          localStorage.setItem(key, String(Math.round(c)))
        } catch {
          /* ignore quota */
        }
        return c
      })
    },
    [key, min, max]
  )

  return [width, set]
}

export const LAYOUT = {
  rail: { key: 'afkllm.layout.railWidth', fallback: 220, min: 160, max: 420 },
  workspace: { key: 'afkllm.layout.workspaceWidth', fallback: 560, min: 280, max: 1400 },
  tree: { key: 'afkllm.layout.treeWidth', fallback: 220, min: 140, max: 480 },
  chatMin: 260
} as const
