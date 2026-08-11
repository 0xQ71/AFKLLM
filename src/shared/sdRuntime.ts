export type SdRuntimeProgress = {
  phase: 'idle' | 'resolving' | 'downloading' | 'extracting' | 'ready' | 'error'
  label: string
  fraction: number
  error?: string
  tag?: string
}

export type SdRuntimeStatus = {
  ready: boolean
  binaryPath: string | null
  dir: string
  tag: string | null
  source: 'custom' | 'downloaded' | 'missing'
  error?: string
  /** Latest GitHub release tag from last check (cached). */
  latestTag?: string | null
  /** True when installed (downloaded) tag differs from latestTag after a check. */
  updateAvailable?: boolean
  /** Last check failure message (offline / GitHub error). */
  checkError?: string | null
}

export type SdRuntimeEnsureOptions = {
  force?: boolean
}
