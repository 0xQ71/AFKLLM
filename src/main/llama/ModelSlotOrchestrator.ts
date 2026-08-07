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
  slot: 'chat' | 'vision'
) => LlamaProcessOptions | Promise<LlamaProcessOptions>

/**
 * Serializes exclusive GPU use across chat / vision llama-server and
 * one-shot image-gen (sd-cli).
 *
 * Cold disk swap only:
 * - Leaving a slot always kills llama-server (weights leave process memory).
 * - Next slot always starts a fresh process that mmap/loads from disk.
 * - Never park a second model in system RAM (no --n-gpu-layers 0 warm keep).
 * - Slot loads force loadMode=mmap (never mmap+mlock) so pages are not pinned.
 */
export class ModelSlotOrchestrator extends EventEmitter {
  private status: ModelSlotStatus = defaultSlotStatus()
  private switchChain: Promise<void> = Promise.resolve()
  private getLlama: () => LlamaProcessManager | null
  private setLlama: (mgr: LlamaProcessManager | null) => void
  private createLlama: (opts: LlamaProcessOptions) => LlamaProcessManager
  private optsFor: LlamaOptsFactory
  private ensureRuntime: () => Promise<void>

  constructor(deps: {
    getLlama: () => LlamaProcessManager | null
    setLlama: (mgr: LlamaProcessManager | null) => void
    createLlama: (opts: LlamaProcessOptions) => LlamaProcessManager
    optsFor: LlamaOptsFactory
    ensureRuntime: () => Promise<void>
  }) {
    super()
    this.getLlama = deps.getLlama
    this.setLlama = deps.setLlama
    this.createLlama = deps.createLlama
    this.optsFor = deps.optsFor
    this.ensureRuntime = deps.ensureRuntime
  }

  getStatus(): ModelSlotStatus {
    return { ...this.status }
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
    const run = this.switchChain.then(() =>
      this.ensureSlotInner(target, switchOpts)
    )
    this.switchChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async ensureSlotInner(
    target: ModelSlot,
    switchOpts?: { cancelPending?: boolean }
  ): Promise<ModelSlotStatus> {
    if (this.status.slot === target && this.status.phase === 'ready') {
      if (target === 'idle' || target === 'imageGen') {
        // Never trust a stale "imageGen ready" while llama-server still holds VRAM.
        await this.disposeLlama()
        return this.getStatus()
      }
      const llama = this.getLlama()
      if (llama?.currentState === 'ready') return this.getStatus()
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

      // Always drop the live llama-server first — never keep weights in RAM/VRAM.
      await this.disposeLlama()

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

      const llama = this.createLlama(opts)
      this.setLlama(llama)
      await llama.start({ force: true })

      this.setStatus({
        slot: target,
        phase: 'ready',
        detail:
          target === 'vision'
            ? 'Vision model ready (loaded from disk)'
            : 'Chat model ready (loaded from disk)',
        error: undefined
      })
      return this.getStatus()
    } catch (err) {
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

  /** Kill llama-server and drop the manager so nothing stays mapped in RAM/VRAM. */
  private async disposeLlama(): Promise<void> {
    const llama = this.getLlama()
    const port = llama?.port ?? 8080
    if (llama) {
      try {
        await llama.stop()
      } catch {
        /* ignore */
      }
      this.setLlama(null)
    }
    // Belt-and-suspenders: orphans survive when the manager was already null.
    LlamaProcessManager.killListenersOnPort(port)
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
