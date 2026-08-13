import { dirname, join } from 'node:path'
import { existsSync, promises as fs } from 'node:fs'
import { DEFAULT_MODELS_DIR, type AppSettings } from '../../shared/settings'
import { isLikelyVisionGguf, scoreMmprojForVision, scoreVisionGguf } from '../../shared/visionDetect'
import { scanGgufModels, scanMmprojFiles } from './ModelScanner'

function isEmptyOrMissing(path: string | undefined): boolean {
  const t = path?.trim() ?? ''
  if (!t) return true
  return !existsSync(t)
}

export { scoreVisionGguf, isLikelyVisionGguf, scoreMmprojForVision }

export function visionPathsNeedAutofill(settings: AppSettings): boolean {
  return isEmptyOrMissing(settings.visionModelPath)
}

/**
 * When visionModelPath is empty/missing, pick best VL GGUF under modelsDir
 * and a matching mmproj (explicit path when found).
 */
export async function autofillVisionPaths(
  settings: AppSettings
): Promise<Partial<AppSettings>> {
  if (!visionPathsNeedAutofill(settings)) return {}

  const dir = settings.modelsDir?.trim() || DEFAULT_MODELS_DIR
  if (!dir || !existsSync(dir)) return {}

  const models = await scanGgufModels(dir)
  let best: { path: string; score: number } | null = null
  for (const m of models) {
    const score = scoreVisionGguf(m.path)
    if (score < 0) continue
    if (!best || score > best.score) best = { path: m.path, score }
  }
  if (!best) return {}

  const patch: Partial<AppSettings> = { visionModelPath: best.path }

  if (isEmptyOrMissing(settings.visionMmprojPath)) {
    const mmprojs = await scanMmprojFiles(dir)
    const visionDir = dirname(best.path)
    let bestMm: { path: string; score: number } | null = null
    for (const mm of mmprojs) {
      let score = scoreMmprojForVision(mm.path, best.path)
      if (dirname(mm.path) === visionDir) score += 20
      if (score < 0) continue
      if (!bestMm || score > bestMm.score) bestMm = { path: mm.path, score }
    }
    if (bestMm) {
      patch.visionMmprojPath = bestMm.path
    } else {
      try {
        const entries = await fs.readdir(visionDir)
        const sibling = entries.find(
          (n) => n.toLowerCase().endsWith('.gguf') && /mmproj/i.test(n)
        )
        if (sibling) patch.visionMmprojPath = join(visionDir, sibling)
      } catch {
        /* ignore */
      }
    }
  }

  return patch
}
