// Smoke test for image generation alone (no LLM): start ComfyUI, one image, stop. Prints VRAM peak.
//   npx tsx scripts/imagegen-smoke.ts <out.png> ["prompt" ...]   (one image per prompt; default: two seeds of a test prompt)
import { ComfyRunner, imageGenMissing } from '../src/core/imagegen'
import { vramUsedMiB } from '../src/core/swap'

const out = process.argv[2]
 const prompts = process.argv.slice(3)
const prompt = 'A cozy pixel-art game title screen: a small wooden tavern at night in a snowy forest, warm light in the windows, the title "AFK QUEST" in bold golden pixel letters at the top, 16-bit style, crisp pixels'
const missing = imageGenMissing()
if (missing.length) { console.error('missing:', missing); process.exit(1) }
let peak = 0
const timer = setInterval(() => { peak = Math.max(peak, vramUsedMiB()) }, 500)
const comfy = new ComfyRunner()
const t0 = Date.now()
let last = ''
const say = (m: string) => {
  const k = m.replace(/\s*·\s*(step )?\d+(\/\d+|s)$/, '')
  const step = /step (\d+)\//.exec(m)?.[1]
  if (k !== last || (step && Number(step) % 5 === 0)) console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
  last = k
}
async function main() {
try {
  await comfy.start(say)
  console.log(`ComfyUI up in ${((Date.now() - t0) / 1000).toFixed(1)}s · VRAM ${vramUsedMiB()} MiB`)
  const jobs = prompts.length ? prompts.map((p, i) => ({ p, seed: i + 1 })) : [{ p: prompt, seed: 1 }, { p: prompt, seed: 2 }]
  for (const { p, seed } of jobs) {
    const r = await comfy.generate({ prompt: p, out: out.replace(/\.png$/, `-${seed}.png`), seed, width: 1344, height: 768 }, say)
    console.log(`image seed ${seed}: ${r.width}x${r.height} in ${r.seconds.toFixed(1)}s → ${r.path} · VRAM peak so far ${peak} MiB`)
  }
} catch (e) {
  console.error('FAILED:', (e as Error).message, '\nlog:', comfy.logPath)
} finally {
  await comfy.stop()
  clearInterval(timer)
  console.log(`stopped · VRAM now ${vramUsedMiB()} MiB · peak ${peak} MiB`)
}
}
void main()
