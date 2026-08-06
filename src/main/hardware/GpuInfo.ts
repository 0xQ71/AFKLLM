import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GpuInfo } from '../../shared/hfStore'

const execFileAsync = promisify(execFile)

let cached: GpuInfo | null | undefined

/**
 * Best-effort NVIDIA GPU probe via nvidia-smi.
 * Returns null when CUDA tooling is unavailable (AMD/Intel/no driver).
 */
export async function detectGpuInfo(force = false): Promise<GpuInfo | null> {
  if (!force && cached !== undefined) return cached

  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true }
    )
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (!line) {
      cached = null
      return null
    }
    // "NVIDIA GeForce RTX 5060 Ti, 16311"
    const comma = line.lastIndexOf(',')
    const name = (comma >= 0 ? line.slice(0, comma) : line).trim()
    const memRaw = (comma >= 0 ? line.slice(comma + 1) : '').trim()
    const vramMb = Math.round(Number(memRaw))
    if (!name || !Number.isFinite(vramMb) || vramMb <= 0) {
      cached = null
      return null
    }
    const info: GpuInfo = {
      name,
      vramMb,
      vramGb: Math.round((vramMb / 1024) * 10) / 10
    }
    cached = info
    return info
  } catch {
    cached = null
    return null
  }
}
