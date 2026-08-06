import type { LlamaRuntimePack } from './llamaRuntime'

export type LlamaGhAsset = {
  name: string
  size: number
  browser_download_url: string
  digest?: string
}

/** True when a release has at least one Windows llama-server zip we can install. */
export function releaseHasWindowsRuntime(assets: LlamaGhAsset[]): boolean {
  return assets.some((a) =>
    /^llama-b\d+-bin-win-(cpu|vulkan|cuda-[\d.]+)-x64\.zip$/i.test(a.name)
  )
}

export function pickAssetsForVariant(
  assets: LlamaGhAsset[],
  variant: LlamaRuntimePack
): { server: LlamaGhAsset | null; cudart: LlamaGhAsset | null; variant: LlamaRuntimePack } {
  if (variant === 'cpu') {
    const server =
      assets.find((a) => /^llama-b\d+-bin-win-cpu-x64\.zip$/i.test(a.name)) ?? null
    return { server, cudart: null, variant: 'cpu' }
  }

  if (variant === 'vulkan') {
    const server =
      assets.find((a) => /^llama-b\d+-bin-win-vulkan-x64\.zip$/i.test(a.name)) ?? null
    return { server, cudart: null, variant: 'vulkan' }
  }

  if (variant === 'cuda-12.4') {
    const server =
      assets.find((a) => /^llama-b\d+-bin-win-cuda-12\.4-x64\.zip$/i.test(a.name)) ?? null
    if (!server) return { server: null, cudart: null, variant: 'cuda-12.4' }
    const cudart =
      assets.find((a) => a.name.toLowerCase() === 'cudart-llama-bin-win-cuda-12.4-x64.zip') ??
      assets.find((a) => /^cudart-llama-bin-win-cuda-12\.4-x64\.zip$/i.test(a.name)) ??
      null
    return { server, cudart, variant: 'cuda-12.4' }
  }

  const server =
    assets.find(
      (a) =>
        /^llama-b\d+-bin-win-cuda-[\d.]+-x64\.zip$/i.test(a.name) &&
        !/cuda-12\.4/i.test(a.name) &&
        !/cudart/i.test(a.name)
    ) ?? null
  if (!server) return { server: null, cudart: null, variant: 'cuda' }
  const m = server.name.match(/cuda-([\d.]+)-x64/i)
  const ver = m?.[1]
  const cudart =
    (ver
      ? assets.find((a) => a.name.toLowerCase() === `cudart-llama-bin-win-cuda-${ver}-x64.zip`)
      : null) ??
    assets.find(
      (a) =>
        /^cudart-llama-bin-win-cuda-[\d.]+-x64\.zip$/i.test(a.name) &&
        !/cuda-12\.4/i.test(a.name)
    ) ??
    null
  return { server, cudart, variant: 'cuda' }
}

/** Pick newest release that has Windows runtime zips (skips incomplete /latest uploads). */
export function pickUsableRelease<T extends { tag_name: string; assets: LlamaGhAsset[] }>(
  latest: T | null,
  list: T[]
): T | null {
  if (latest && releaseHasWindowsRuntime(latest.assets)) return latest
  return (
    list.find((r) => r?.tag_name && Array.isArray(r.assets) && releaseHasWindowsRuntime(r.assets)) ??
    null
  )
}
