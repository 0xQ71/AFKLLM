// Strata (github.com/Niko1221/Strata, MIT) as a model server for MoE models bigger than the GPU: the hottest experts
// sit in VRAM, the rest in RAM and run on the CPU. On the RTX 5060 Ti 16 GB + 64 GB RAM it serves Qwen3.8-Flash-Next
// IQ3_XXS (47 GB of weights) at ~60 t/s decode and ~850 t/s prefill, where llama.cpp b12063 gets ~18.5 and ~300.
//
// `strata launch` is run once (scripts\strata-setup.cmd): it fetches the engine, prepares the model from the GGUF files
// where they lie, tunes it and saves a preset, whose launch config is %LOCALAPPDATA%\Strata\launch\<preset>.json. AFKLLM
// then starts Strata's own HTTP server (serve/server.py, the process `strata launch` starts too) on a copy of that
// config with our overrides, on the port llama-server would use: the proxy, the model switch and the GPU swap for
// images work unchanged (Strata speaks llama-server's /health, /props, /slots save|restore and OpenAI /v1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface StrataSpec {
  /** the `strata launch --save-preset` name whose launch config this profile starts */
  preset: string
  /** engine flags over the preset's: { "max-context": "131072" } replaces the value, null = a bare flag, '__off__' drops it */
  engineArgs?: Record<string, string | null>
  /** server config keys over the preset's (one level deep for objects such as "vision") */
  config?: Record<string, unknown>
}

export const STRATA_HOME = process.env.STRATA_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Strata')

/**
 * The active Strata Control: its Python, serve/server.py and data. The installer's copy is terminal\current; a newer
 * one installed by `strata update` lives in components\control\<folder> (named by control\active.json), and the old
 * terminal's strata.py hands over to it the same way. Measured 2026-11-23: after updating 0.2.18 -> 0.2.20,
 * terminal\current still pointed at 0.1.64 while 0.1.66 was active.
 */
export function strataRoot(home: string = STRATA_HOME): string {
  try {
    const active = JSON.parse(readFileSync(join(home, 'components', 'control', 'active.json'), 'utf8')) as { folder?: string; version?: string }
    const dir = join(home, 'components', 'control', String(active.folder ?? active.version ?? ''))
    if ((active.folder || active.version) && existsSync(join(dir, 'python', 'python.exe')) && existsSync(join(dir, 'serve'))) return dir
  } catch { /* no update installed: the installer's terminal */ }
  return join(home, 'terminal', 'current')
}

export function strataPython(): string {
  return join(strataRoot(), 'python', 'python.exe')
}

export function strataLaunchConfig(preset: string): string {
  return join(STRATA_HOME, 'launch', `${preset}.json`)
}

/** What is missing before this profile can start, as a message with the fix; undefined when ready. */
export function strataMissing(spec: StrataSpec): string | undefined {
  if (!existsSync(strataPython())) return `Strata is not installed (${strataRoot()}). Install it, then run scripts\\strata-setup.cmd.`
  if (!existsSync(strataLaunchConfig(spec.preset))) return `Strata preset "${spec.preset}" is not set up (${strataLaunchConfig(spec.preset)}). Run scripts\\strata-setup.cmd.`
  return undefined
}

/** The model name Strata reports in /health for this preset. */
export function strataModelName(spec: StrataSpec): string {
  try { return String(JSON.parse(readFileSync(strataLaunchConfig(spec.preset), 'utf8')).model_name ?? '') } catch { return '' }
}

/** Replace, add or drop `--flag [value]` entries of an engine argument list. */
export function mergeEngineArgs(base: string[], over: Record<string, string | null>): string[] {
  const out = [...base]
  for (const [k, v] of Object.entries(over)) {
    const flag = `--${k}`
    const i = out.indexOf(flag)
    const hasValue = i >= 0 && i + 1 < out.length && !out[i + 1].startsWith('--')
    if (v === '__off__') { if (i >= 0) out.splice(i, hasValue ? 2 : 1); continue }
    if (i < 0) { out.push(flag, ...(v === null ? [] : [v])); continue }
    if (v === null) { if (hasValue) out.splice(i + 1, 1) } else if (hasValue) out[i + 1] = v
    else out.splice(i + 1, 0, v)
  }
  return out
}

/**
 * Write the server config for one start: the preset's launch config + our overrides, port and context.
 * Returns the command that starts it (Strata's bundled Python, from its terminal folder).
 */
export function strataCommand(spec: StrataSpec, opts: { port: number; host: string; ctx: number; configDir: string; logDir: string }): {
  exe: string; args: string[]; cwd: string; configPath: string
} {
  const base = JSON.parse(readFileSync(strataLaunchConfig(spec.preset), 'utf8')) as Record<string, unknown>
  const cfg: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(spec.config ?? {})) {
    const old = cfg[k]
    cfg[k] = v && typeof v === 'object' && !Array.isArray(v) && old && typeof old === 'object' && !Array.isArray(old)
      ? { ...(old as object), ...(v as object) } : v
  }
  const args = Array.isArray(base.args) ? (base.args as string[]) : []
  const over = { ...(spec.engineArgs ?? {}), 'max-context': String(opts.ctx) }
  cfg.args = mergeEngineArgs(args, over)
  // The server rebuilds some engine options at every start (the drafter's --spec / --draft-conf, a VRAM fit): only the
  // options in "user_args" count as the person's and win over that (Strata strata_control/user_args.py). Measured
  // 2026-11-23: without it a --spec of ours was replaced by the server's 8.
  const userArgs = Array.isArray(base.user_args) ? (base.user_args as string[]) : []
  cfg.user_args = mergeEngineArgs(userArgs, Object.fromEntries(Object.entries(over).filter(([, v]) => v !== '__off__')))
  delete cfg.args_written
  delete cfg.args_derived
  cfg.port = opts.port
  cfg.host = opts.host
  cfg.open_browser = false
  // the engine's own log next to ours (the server's stdout goes to llama-server-<port>.log, which afk-llama.ps1 tails)
  cfg.log = join(opts.logDir, `strata-engine-${opts.port}.log`)
  if (typeof cfg.slot_save_path === 'string') mkdirSync(cfg.slot_save_path, { recursive: true })
  mkdirSync(opts.configDir, { recursive: true })
  const configPath = join(opts.configDir, `strata-${spec.preset}-${opts.port}.json`)
  writeFileSync(configPath, JSON.stringify(cfg, null, 1))
  return {
    exe: strataPython(),
    args: ['-u', '-m', 'serve.server', '--engine', 'strata', '--config', configPath, '--host', opts.host, '--port', String(opts.port), '--parallel', '1'],
    cwd: strataRoot(),
    configPath,
  }
}
