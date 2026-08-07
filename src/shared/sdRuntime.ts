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
}
