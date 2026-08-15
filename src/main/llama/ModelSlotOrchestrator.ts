import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { getLLMQueue } from './LLMQueueManager'
import {
  LlamaProcessManager,
  type LlamaProcessOptions
} from './LlamaProcessManager'
import type { ModelSlot, ModelSlotStatus } from '../../shared/modelSlots'
import { defaultSlotStatus } from '../../shared/modelSlots'

export type LlamaOptsFactory = (
  slot: 'chat' | 'vision' | 'apply'
) => LlamaProcessOptions | Promise<LlamaProcessOptions>

/**
 * Serializes exclusive GPU use across chat / vision llama-server and
 * one-shot image-gen (sd-cli).
 *
 * Chat slot may keep a coresident apply llama-server (port+1) in the same VRAM.
 * Vision / idle / imageGen always kill both processes (cold disk swap for VL).
 *
 * Cold disk swap for exclusive slots:
 * - Leaving chat/vision always kills llama-server (weights leave process memory).
 * - Next slot always starts a fresh process that mmap/loads from disk.
 * - Never park a second model in system RAM (no --n-gpu-layers 0 warm keep).
 * - Slot loads force loadMode=mmap (never mmap+mlock) so pages are not pinned.
 */
export class ModelSlotOrchestrator extends EventEmitter {
  private status: ModelSlotStatus = defaultSlotStatus()
  private switchChain: Promise<void> = Promise.resolve()
  private switchGen = 0
  private getLlama: () => LlamaProcessManager | null
  private setLlama: (mgr: LlamaProcessManager | null) => void
  private getApplyLlama: () => LlamaProcessManager | null
  private setApplyLlama: (mgr: LlamaProcessManager | null) => void
  private createLlama: (opts: LlamaProcessOptions) => LlamaProcessManager
  private optsFor: LlamaOptsFactory
  private ensureRuntime: () => Promise<void>
  private lastApplyError?: string

  constructor(deps: {
    getLlama: () => LlamaProcessManager | null
    setLlama: (mgr: LlamaProcessManager | null) => void
    getApplyLlama: () => LlamaProcessManager | null
    setApplyLlama: (mgr: LlamaProcessManager | null) => void
    createLlama: (opts: LlamaProcessOptions) => LlamaProcessManager
    optsFor: LlamaOptsFactory
    ensureRuntime: () => Promise<void>
  }) {
    super()
    this.getLlama = deps.getLlama
    this.setLlama = deps.setLlama
    this.getApplyLlama = deps.getApplyLlama
    this.setApplyLlama = deps.setApplyLlama
    this.createLlama = deps.createLlama
    this.optsFor = deps.optsFor
    this.ensureRuntime = deps.ensureRuntime
  }

  getStatus(): ModelSlotStatus {
    return { ...this.status }
  }

  getApplyError(): string | undefined {
    return this.lastApplyError ?? this.getApplyLlama()?.error
  }

  private setStatus(patch: Partial<ModelSlotStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.getStatus())
  }

  /** Update banner text without changing slot (e.g. sd-cli step progress). */
  setDetail(detail: string, phase?: ModelSlotStatus['phase']): void {
    this.setStatus({
      detail,
      ...(phase ? { phase } : {})
    })
  }

  /**
   * Queue slot switches so concurrent ensureSlot calls serialize.
   * @param opts.cancelPending — abort in-flight LLM jobs (default true).
   *   Pass false when restoring chat after generate_image so the agent turn
   *   that owns the tool invoke is not treated as cancelled mid-flight.
   */
  ensureSlot(
    target: ModelSlot,
    switchOpts?: { cancelPending?: boolean }
  ): Promise<ModelSlotStatus> {
    // Unload must interrupt an in-flight spawn; otherwise the queue waits
    // until waitUntilReady finishes (up to ~10 min) before idle runs.
    if (target === 'idle' || target === 'imageGen') {
      void this.getLlama()?.stop()
      void this.getApplyLlama()?.stop()
    }
    const gen = ++this.switchGen
    const run = this.switchChain.then(() =>
      this.ensureSlotInner(target, switchOpts, gen)
    )
    this.switchChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async ensureSlotInner(
    target: ModelSlot,
    switchOpts: { cancelPending?: boolean } | undefined,
    gen: number
  ): Promise<ModelSlotStatus> {
    if (gen !== this.switchGen) return this.getStatus()

    if (this.status.slot === target && this.status.phase === 'ready') {
      if (target === 'idle' || target === 'imageGen') {
        // Never trust a stale "imageGen ready" while llama-server still holds VRAM.
        await this.disposeLlama()
        return this.getStatus()
      }
      if (target === 'chat' || target === 'vision') {
        const llama = this.getLlama()
        const opts = await this.optsFor(target)
        const sameChat =
          llama?.currentState === 'ready' &&
          llama.modelPath === opts.modelPath &&
          (target !== 'vision' ||
            (llama.mmprojPath || '') === (opts.mmprojPath || ''))
        if (target === 'vision') {
          if (sameChat) return this.getStatus()
        } else if (sameChat && (await this.applyMatchesWanted(gen))) {
          return this.getStatus()
        }
      }
    }

    this.setStatus({
      phase: 'switching',
      detail: detailForTarget(target),
      error: undefined
    })

    try {
      if (switchOpts?.cancelPending !== false) {
        getLLMQueue().cancelAll('slot_switch')
      }

      // Always drop live llama-servers first — never keep weights in RAM/VRAM.
      await this.disposeLlama()
      if (gen !== this.switchGen) return this.getStatus()

      if (target === 'idle' || target === 'imageGen') {
        this.setStatus({
          slot: target,
          phase: 'ready',
          detail:
            target === 'imageGen'
              ? 'Model on disk · VRAM free for image generation'
              : 'Model unloaded to disk',
          error: undefined
        })
        return this.getStatus()
      }

      await this.ensureRuntime()
      const opts = await this.optsFor(target)
      // Always mmap from disk for slot swaps — never mlock (pins RAM) or full RAM load.
      opts.loadMode = 'mmap'
      if (!opts.modelPath?.trim() || !existsSync(opts.modelPath)) {
        throw new Error(
          target === 'vision'
            ? 'Vision model path is not set or missing. Configure it in Settings → Multimodal.'
            : 'Chat model path is not set or missing.'
        )
      }
      if (target === 'vision') {
        const mm = opts.mmprojPath?.trim()
        if (!mm || !existsSync(mm)) {
          throw new Error(
            'Vision mmproj is not set or missing. Set visionMmprojPath or place a *mmproj*.gguf next to the vision model.'
          )
        }
      }

      this.setStatus({
        phase: 'switching',
        detail:
          target === 'vision'
            ? 'Loading vision model from disk…'
            : 'Loading chat model from disk…'
      })

      const llama = this.createLlama(opts)
      this.setLlama(llama)
      await llama.start({ force: true })
      if (gen !== this.switchGen) {
        await this.disposeLlama()
        return this.getStatus()
      }

      let detail =
        target === 'vision'
          ? 'Vision model ready (loaded from disk)'
          : 'Chat model ready (loaded from disk)'

      if (target === 'chat') {
        detail = await this.startApplyCoresident(gen, detail)
        if (gen !== this.switchGen) {
          await this.disposeLlama()
          return this.getStatus()
        }
      }

      this.setStatus({
        slot: target,
        phase: 'ready',
        detail,
        error: undefined
      })
      return this.getStatus()
    } catch (err) {
      if (gen !== this.switchGen) return this.getStatus()
      const msg = err instanceof Error ? err.message : String(err)
      this.setStatus({
        slot: this.status.slot,
        phase: 'error',
        detail: msg,
        error: msg
      })
      throw err
    }
  }

  /** True when apply path empty and no process, or apply ready on the wanted path. */
  private async applyMatchesWanted(gen: number): Promise<boolean> {
    if (gen !== this.switchGen) return false
    let applyOpts: LlamaProcessOptions
    try {
      applyOpts = await this.optsFor('apply')
    } catch {
      return !this.getApplyLlama()
    }
    const want = applyOpts.modelPath?.trim() || ''
    const apply = this.getApplyLlama()
    if (!want) {
      return !apply || apply.currentState === 'stopped'
    }
    return (
      !!apply &&
      apply.currentState === 'ready' &&
      apply.modelPath === want &&
      !this.lastApplyError
    )
  }

  /**
   * Soft-start apply on port+1 after chat is ready. Failures leave chat up.
   */
  private async startApplyCoresident(
    gen: number,
    chatDetail: string
  ): Promise<string> {
    this.lastApplyError = undefined
    let applyOpts: LlamaProcessOptions
    try {
      applyOpts = await this.optsFor('apply')
    } catch (err) {
      this.lastApplyError = err instanceof Error ? err.message : String(err)
      return `${chatDetail} · Apply failed: ${this.lastApplyError}`
    }

    const path = applyOpts.modelPath?.trim() || ''
    if (!path) {
      return chatDetail
    }
    if (!existsSync(path)) {
      this.lastApplyError = `Apply model not found: ${path}`
      return `${chatDetail} · Apply failed: ${this.lastApplyError}`
    }

    this.setStatus({
      phase: 'switching',
      detail: 'Loading apply model into VRAM…'
    })

    applyOpts.loadMode = 'mmap'
    const apply = this.createLlama(applyOpts)
    this.setApplyLlama(apply)
    try {
      await apply.start({ force: true })
      if (gen !== this.switchGen) return chatDetail
      this.lastApplyError = undefined
      return 'Chat + Apply ready (coresident in VRAM)'
    } catch (err) {
      this.lastApplyError = err instanceof Error ? err.message : String(err)
      try {
        await apply.stop()
      } catch {
        /* ignore */
      }
      this.setApplyLlama(null)
      LlamaProcessManager.killListenersOnPort(applyOpts.port ?? 8081)
      return `${chatDetail} · Apply failed: ${this.lastApplyError}`
    }
  }

  /** Kill chat + apply llama-servers so nothing stays mapped in RAM/VRAM. */
  private async disposeLlama(): Promise<void> {
    const llama = this.getLlama()
    const apply = this.getApplyLlama()
    const ports = new Set<number>()
    if (llama) ports.add(llama.port)
    if (apply) ports.add(apply.port)
    if (ports.size === 0) ports.add(8080)

    for (const mgr of [llama, apply]) {
      if (!mgr) continue
      try {
        await mgr.stop()
      } catch {
        /* ignore */
      }
    }
    this.setLlama(null)
    this.setApplyLlama(null)
    this.lastApplyError = undefined

    for (const port of ports) {
      LlamaProcessManager.killListenersOnPort(port)
    }
    // Let the OS reclaim CUDA context / mmap pages before the next load.
    await new Promise((r) => setTimeout(r, 750))
  }
}

function detailForTarget(target: ModelSlot): string {
  switch (target) {
    case 'vision':
      return 'Loading vision model from disk…'
    case 'chat':
      return 'Loading chat model from disk…'
    case 'imageGen':
      return 'Unloading model to disk · freeing VRAM…'
    case 'idle':
      return 'Unloading model to disk…'
    default:
      return 'Switching model…'
  }
}
