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
import { streamDeltaText } from '../src/shared/llmDelta.ts'

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

describe('llamaSpec MTP auto', () => {
  it('detects Ornith MTP filenames and skips ordinary GGUFs', async () => {
    const {
      looksLikeMtpGguf,
      looksLikeNvfp4Gguf,
      isBlackwellGpuName,
      shouldEnableDraftMtp,
      speculativeMtpUnsupported,
      mtpDraftMax
    } = await import('../src/shared/llamaSpec.ts')
    assert.equal(looksLikeMtpGguf('C:\\Models\\Ornith-1.0-9B-MTP-Q4_K_M.gguf'), true)
    assert.equal(looksLikeMtpGguf('Ornith-1.0-9B-MTP-NVFP4.gguf'), true)
    assert.equal(looksLikeMtpGguf('Devstral-Small-2-24B-Instruct-2512-IQ4_XS.gguf'), false)
    assert.equal(looksLikeNvfp4Gguf('Ornith-1.0-9B-MTP-NVFP4.gguf'), true)
    assert.equal(isBlackwellGpuName('NVIDIA GeForce RTX 5060 Ti'), true)
    assert.equal(isBlackwellGpuName('NVIDIA GeForce RTX 5090'), true)
    assert.equal(isBlackwellGpuName('NVIDIA RTX 5000 Ada Generation'), false)
    assert.equal(isBlackwellGpuName('NVIDIA RTX A5000'), false)
    assert.equal(isBlackwellGpuName('NVIDIA GeForce RTX 4070'), false)
    assert.equal(isBlackwellGpuName('NVIDIA RTX PRO 6000 Blackwell'), true)
    assert.equal(
      shouldEnableDraftMtp({ modelPath: 'Ornith-1.0-9B-MTP-Q4_K_M.gguf' }),
      true
    )
    assert.equal(
      shouldEnableDraftMtp({
        modelPath: 'Ornith-1.0-9B-MTP-Q4_K_M.gguf',
        mmprojPath: 'mmproj.gguf'
      }),
      true
    )
    assert.equal(
      speculativeMtpUnsupported(
        'error: unknown argument: --spec-type\nfailed to parse CLI'
      ),
      true
    )
    assert.equal(
      speculativeMtpUnsupported(
        'ggml_cuda_init: CUDA error: out of memory\nloading --spec-type draft-mtp'
      ),
      false
    )
    assert.equal(mtpDraftMax('Ornith-1.0-9B-1M-MTP-Q8_0.gguf'), 2)
    assert.equal(mtpDraftMax('Qwen3.5-4B-MTP-Q4_K_M.gguf'), 3)
  })
})

describe('llamaSlotPort', () => {
  it('parks keep-loaded vision on port+2 and swap vision on the chat port', async () => {
    const { llamaSlotPort, llamaSlotPortsToDeny } = await import(
      '../src/shared/llamaSlots.ts'
    )
    assert.equal(llamaSlotPort(8080, 'chat', true), 8080)
    assert.equal(llamaSlotPort(8080, 'apply', true), 8081)
    assert.equal(llamaSlotPort(8080, 'vision', true), 8082)
    assert.equal(llamaSlotPort(8080, 'vision', false), 8080)
    assert.deepEqual(llamaSlotPortsToDeny(8080).sort((a, b) => a - b), [8080, 8081, 8082])
    const { DEFAULT_SETTINGS } = await import('../src/shared/settings.ts')
    assert.equal(DEFAULT_SETTINGS.visionKeepLoaded, true)
  })
})

describe('visionReusesChatModel', () => {
  it('reuses chat when Vision is “Same as chat” or the same GGUF path', async () => {
    const { visionReusesChatModel, VISION_SAME_AS_CHAT } = await import(
      '../src/shared/visionDetect.ts'
    )
    const ornith =
      'D:/models/Ornith-1-9B-MTP-1M-vision-Q4_K_M.gguf'
    assert.equal(
      visionReusesChatModel({ chatPath: ornith, visionPath: VISION_SAME_AS_CHAT }),
      true
    )
    assert.equal(
      visionReusesChatModel({ chatPath: ornith, visionPath: ornith }),
      true
    )
    assert.equal(
      visionReusesChatModel({ chatPath: ornith, visionPath: '' }),
      false
    )
    assert.equal(
      visionReusesChatModel({
        chatPath: 'D:/models/gemma-4-12b-it-Q4_K_M.gguf',
        visionPath: VISION_SAME_AS_CHAT
      }),
      true
    )
    assert.equal(
      visionReusesChatModel({
        chatPath: 'D:/models/gemma-4-12b-it-Q4_K_M.gguf',
        visionPath: '',
        mmprojPath: ''
      }),
      false
    )
    assert.equal(
      visionReusesChatModel({
        chatPath: ornith,
        visionPath: 'D:/models/Qwen3-VL-8B-Instruct-Q4_K_M.gguf'
      }),
      false
    )
  })

  it('rejects Ornith mmproj for Gemma and matches same-family projectors', async () => {
    const { scoreMmprojForVision, looksLikeMmprojMismatch, isLikelyVisionGguf } =
      await import('../src/shared/visionDetect.ts')
    assert.equal(
      scoreMmprojForVision(
        'C:/Models/mmproj-ornith-9b-f16.gguf',
        'C:/Models/gemma4-v2-Q6_K.gguf'
      ),
      -1
    )
    assert.ok(
      scoreMmprojForVision(
        'C:/Models/mmproj-ornith-9b-f16.gguf',
        'C:/Models/Ornith-1-9B-MTP-1M-vision-Q4_K_M.gguf'
      ) > 0
    )
    assert.equal(isLikelyVisionGguf('gemma4-v2-Q6_K.gguf'), true)
    assert.equal(
      looksLikeMmprojMismatch(
        'mtmd_init_from_file: error: mismatch between text model (n_embd = 3840) and mmproj (n_embd = 4096) hint: you may be using wrong mmproj'
      ),
      true
    )
  })
})

describe('streamDeltaText', () => {
  it('uses reasoning_content when content is empty', () => {
    assert.equal(
      streamDeltaText({ content: '', reasoning_content: 'сначала разберу цель' }),
      'сначала разберу цель'
    )
    assert.equal(streamDeltaText({ content: null, reasoning: 'think' }), 'think')
    assert.equal(
      streamDeltaText({ content: '<plan></plan>', reasoning_content: 'hidden' }),
      '<plan></plan>'
    )
  })
})

describe('Ornith defaults + chat apply', () => {
  it('lifts stock AFKLLM sampling/ctx for Ornith and leaves custom knobs', async () => {
    const {
      DEFAULT_SETTINGS,
      applyOrnithRecommendedTuning,
      profileForModelPath,
      switchModelPath
    } = await import('../src/shared/settings.ts')
    const {
      looksLikeOrnithGguf,
      ORNITH_TEMPERATURE,
      ORNITH_TOP_P,
      ORNITH_TOP_K,
      ORNITH_CTX_SIZE
    } = await import('../src/shared/ornithDefaults.ts')
    const path = 'C:\\Models\\Ornith-1.0-9B-1M-MTP-Q8_0.gguf'
    assert.equal(looksLikeOrnithGguf(path), true)
    const stock = applyOrnithRecommendedTuning({
      ...DEFAULT_SETTINGS,
      modelPath: path
    })
    assert.equal(stock.temperature, ORNITH_TEMPERATURE)
    assert.equal(stock.topP, ORNITH_TOP_P)
    assert.equal(stock.topK, ORNITH_TOP_K)
    assert.equal(stock.ctxSize, ORNITH_CTX_SIZE)
    assert.equal(stock.applyModelPath, '')
    const custom = applyOrnithRecommendedTuning({
      ...DEFAULT_SETTINGS,
      modelPath: path,
      temperature: 0.7,
      topK: 20,
      topP: 0.95,
      ctxSize: 65536
    })
    assert.equal(custom.temperature, 0.7)
    assert.equal(custom.ctxSize, 65536)
    const switched = switchModelPath(DEFAULT_SETTINGS, path)
    assert.equal(switched.temperature, ORNITH_TEMPERATURE)
    assert.equal(profileForModelPath(path).topK, ORNITH_TOP_K)
  })

  it('apply_diff schema tells the agent Chat applies patches', async () => {
    const { AGENT_TOOL_SCHEMAS } = await import('../src/shared/types.ts')
    const diff = AGENT_TOOL_SCHEMAS.find((t) => t.function.name === 'apply_diff')
    assert.ok(diff)
    assert.match(diff.function.description, /Chat/i)
    assert.doesNotMatch(diff.function.description, /coresident apply model/i)
  })
})
