/**
 * Smoke: llama.cpp runtime asset picking + incomplete /latest fallback.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  pickAssetsForVariant,
  pickUsableRelease,
  releaseHasWindowsRuntime,
  type LlamaGhAsset
} from '../src/shared/llamaRuntimeAssets.ts'
import { LLAMA_RUNTIME_PACKS } from '../src/shared/llamaRuntime.ts'

function asset(name: string, size = 1): LlamaGhAsset {
  return {
    name,
    size,
    browser_download_url: `https://example.test/${name}`
  }
}

const fullAssets: LlamaGhAsset[] = [
  asset('llama-b10295-bin-win-cpu-x64.zip', 16_000_000),
  asset('llama-b10295-bin-win-vulkan-x64.zip', 30_000_000),
  asset('llama-b10295-bin-win-cuda-12.4-x64.zip', 250_000_000),
  asset('llama-b10295-bin-win-cuda-13.3-x64.zip', 150_000_000),
  asset('cudart-llama-bin-win-cuda-12.4-x64.zip', 370_000_000),
  asset('cudart-llama-bin-win-cuda-13.3-x64.zip', 370_000_000)
]

describe('llama runtime assets', () => {
  it('detects incomplete releases (cudart-only)', () => {
    assert.equal(
      releaseHasWindowsRuntime([asset('cudart-llama-bin-win-cuda-12.4-x64.zip')]),
      false
    )
    assert.equal(releaseHasWindowsRuntime(fullAssets), true)
  })

  it('picks cpu / vulkan / cuda-12.4 / cuda packs', () => {
    const cpu = pickAssetsForVariant(fullAssets, 'cpu')
    assert.equal(cpu.server?.name, 'llama-b10295-bin-win-cpu-x64.zip')
    assert.equal(cpu.cudart, null)

    const vulkan = pickAssetsForVariant(fullAssets, 'vulkan')
    assert.equal(vulkan.server?.name, 'llama-b10295-bin-win-vulkan-x64.zip')

    const c12 = pickAssetsForVariant(fullAssets, 'cuda-12.4')
    assert.equal(c12.server?.name, 'llama-b10295-bin-win-cuda-12.4-x64.zip')
    assert.equal(c12.cudart?.name, 'cudart-llama-bin-win-cuda-12.4-x64.zip')

    const cuda = pickAssetsForVariant(fullAssets, 'cuda')
    assert.equal(cuda.server?.name, 'llama-b10295-bin-win-cuda-13.3-x64.zip')
    assert.equal(cuda.cudart?.name, 'cudart-llama-bin-win-cuda-13.3-x64.zip')
  })

  it('covers every declared pack variant', () => {
    for (const pack of LLAMA_RUNTIME_PACKS) {
      const picked = pickAssetsForVariant(fullAssets, pack)
      assert.ok(picked.server, `missing server for ${pack}`)
      assert.equal(picked.variant, pack)
    }
  })

  it('skips incomplete /latest and falls back to previous full release', () => {
    const incomplete = {
      tag_name: 'b10297',
      assets: [asset('cudart-llama-bin-win-cuda-12.4-x64.zip')]
    }
    const full = { tag_name: 'b10295', assets: fullAssets }
    const picked = pickUsableRelease(incomplete, [incomplete, full])
    assert.equal(picked?.tag_name, 'b10295')
  })
})

describe('llama.cpp GitHub releases (live)', () => {
  it('finds a usable Windows release and all four packs', async () => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AFKLLM-runtime-smoke',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    const latestRes = await fetch(
      'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest',
      { headers }
    )
    assert.equal(latestRes.ok, true)
    const latest = (await latestRes.json()) as {
      tag_name: string
      assets: LlamaGhAsset[]
    }

    const listRes = await fetch(
      'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10',
      { headers }
    )
    assert.equal(listRes.ok, true)
    const list = (await listRes.json()) as Array<{
      tag_name: string
      assets: LlamaGhAsset[]
    }>

    const usable = pickUsableRelease(latest, list)
    assert.ok(usable, 'no usable Windows release')
    assert.ok(releaseHasWindowsRuntime(usable.assets))

    for (const pack of LLAMA_RUNTIME_PACKS) {
      const picked = pickAssetsForVariant(usable.assets, pack)
      assert.ok(picked.server, `live release ${usable.tag_name} missing ${pack}`)
    }
  })
})
