/** Downloaded llama-server from ggml-org/llama.cpp GitHub releases. */

export type LlamaRuntimePack = 'cpu' | 'cuda-12.4' | 'cuda' | 'vulkan'

/** User choice in Settings → Runtime (auto picks CUDA when NVIDIA GPU is present). */
export type LlamaRuntimeSelection = LlamaRuntimePack | 'auto'

export const LLAMA_RUNTIME_PACKS: LlamaRuntimePack[] = [
  'cpu',
  'cuda-12.4',
  'cuda',
  'vulkan'
]

/** @deprecated use LlamaRuntimePack */
export type LlamaRuntimeVariant = LlamaRuntimePack

export type LlamaRuntimePhase =
  | 'idle'
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'ready'
  | 'error'

export type LlamaRuntimeSource =
  | 'dev-bin'
  | 'bundled'
  | 'downloaded'
  | 'custom'
  | 'missing'

export interface LlamaRuntimeProgress {
  phase: LlamaRuntimePhase
  label: string
  bytesReceived: number
  bytesTotal: number
  fraction: number
  bytesPerSecond?: number
  file?: string
  error?: string
  tag?: string
  variant?: LlamaRuntimePack
}

export interface LlamaRuntimePackStatus {
  variant: LlamaRuntimePack
  ready: boolean
  tag: string | null
  binaryPath: string | null
  /** Installed tag differs from newest usable GitHub release */
  updateAvailable?: boolean
}

export interface LlamaRuntimeStatus {
  ready: boolean
  binaryPath: string | null
  dir: string
  tag: string | null
  /** Active pack for the current selection */
  variant: LlamaRuntimePack | null
  source: LlamaRuntimeSource
  latestTag?: string | null
  updateAvailable?: boolean
  /** Installed packs under userData/llama-runtime/{pack}/ */
  packs: LlamaRuntimePackStatus[]
}

export interface LlamaRuntimeEnsureOptions {
  force?: boolean
  /** Which pack to install; defaults to settings / auto */
  variant?: LlamaRuntimeSelection
  /** @deprecated use variant !== 'cpu' && variant !== 'auto' with explicit pack */
  preferCuda?: boolean
}

export function isLlamaRuntimePack(v: unknown): v is LlamaRuntimePack {
  return (
    v === 'cpu' ||
    v === 'cuda-12.4' ||
    v === 'cuda' ||
    v === 'vulkan'
  )
}

export function isLlamaRuntimeSelection(v: unknown): v is LlamaRuntimeSelection {
  return v === 'auto' || isLlamaRuntimePack(v)
}

export function llamaRuntimePackLabel(
  pack: LlamaRuntimePack,
  tag?: string | null
): string {
  const base: Record<LlamaRuntimePack, string> = {
    cpu: 'CPU llama.cpp (Windows)',
    'cuda-12.4': 'CUDA 12 llama.cpp (Windows)',
    cuda: 'CUDA llama.cpp (Windows)',
    vulkan: 'Vulkan llama.cpp (Windows)'
  }
  return tag ? `${base[pack]} ${tag}` : base[pack]
}
