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
 * Serializes exclusive GPU use across chat llama-server and
 * one-shot image-gen (sd-cli).
 *
 * Chat slot may keep optional vision (port+2). Patches run on the chat model
 * in the same VRAM when visionKeepLoaded is on.
 * Vision cold-swap (keep off) still kills chat+apply and occupies the chat port.
 * imageGen / idle always kill every llama-server.
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
  private getVisionLlama: () => LlamaProcessManager | null
  private setVisionLlama: (mgr: LlamaProcessManager | null) => void
  private keepVisionLoaded: () => boolean
  private visionReusesChat: () => boolean
  private createLlama: (opts: LlamaProcessOptions) => LlamaProcessManager
  private optsFor: LlamaOptsFactory
  private ensureRuntime: () => Promise<void>
  private lastApplyError?: string
  private lastVisionError?: string

  constructor(deps: {
    getLlama: () => LlamaProcessManager | null
    setLlama: (mgr: LlamaProcessManager | null) => void
    getApplyLlama: () => LlamaProcessManager | null
    setApplyLlama: (mgr: LlamaProcessManager | null) => void
    getVisionLlama: () => LlamaProcessManager | null
    setVisionLlama: (mgr: LlamaProcessManager | null) => void
    keepVisionLoaded: () => boolean
    visionReusesChat: () => boolean
    createLlama: (opts: LlamaProcessOptions) => LlamaProcessManager
    optsFor: LlamaOptsFactory
    ensureRuntime: () => Promise<void>
  }) {
    super()
    this.getLlama = deps.getLlama
    this.setLlama = deps.setLlama
    this.getApplyLlama = deps.getApplyLlama
    this.setApplyLlama = deps.setApplyLlama
    this.getVisionLlama = deps.getVisionLlama
    this.setVisionLlama = deps.setVisionLlama
    this.keepVisionLoaded = deps.keepVisionLoaded
    this.visionReusesChat = deps.visionReusesChat
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

  getVisionError(): string | undefined {
    return this.lastVisionError ?? this.getVisionLlama()?.error
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
      void this.getVisionLlama()?.stop()
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

    const keepVision = this.keepVisionLoaded()
    const reuseVision = this.visionReusesChat()

    if (reuseVision && target === 'vision') {
      return this.ensureSlotInner('chat', { ...switchOpts, cancelPending: false }, gen)
    }

    if (keepVision && target === 'vision' && this.status.phase === 'ready') {
      if (await this.visionMatchesWanted(gen)) {
        return this.getStatus()
      }
    }

    if (this.status.slot === target && this.status.phase === 'ready') {
      if (target === 'idle' || target === 'imageGen') {
        // Never trust a stale "imageGen ready" while llama-server still holds VRAM.
        await this.disposeLlama()
        return this.getStatus()
      }
      if (target === 'chat' || target === 'vision') {
        const llama = this.getLlama()
        const opts = await this.optsFor(keepVision && target === 'vision' ? 'chat' : target)
        const sameChat =
          llama?.currentState === 'ready' &&
          llama.modelPath === opts.modelPath &&
          (llama.mmprojPath || '') === (opts.mmprojPath || '')
        if (target === 'vision' && !keepVision) {
          if (sameChat) return this.getStatus()
        } else if (target === 'chat' && sameChat && (await this.applyMatchesWanted(gen))) {
          if (await this.visionMatchesWanted(gen)) return this.getStatus()
        }
      }
    }

    this.setStatus({
      phase: 'switching',
      detail: detailForTarget(target),
      error: undefined
    })

    try {
      const skipCancel = keepVision && target === 'vision'
      if (switchOpts?.cancelPending !== false && !skipCancel) {
        getLLMQueue().cancelAll('slot_switch')
      }

      if (keepVision && target === 'vision') {
        await this.ensureRuntime()
        const detail = await this.startVisionCoresident(gen, this.status.detail || 'Chat ready')
        if (gen !== this.switchGen) return this.getStatus()
        const chatUp = this.getLlama()?.currentState === 'ready'
        this.setStatus({
          slot: chatUp ? 'chat' : 'vision',
          phase: 'ready',
          detail,
          error: undefined
        })
        return this.getStatus()
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
            ? 'Vision model path is not set or missing. Configure it in Settings → Model.'
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
        if (keepVision) {
          detail = await this.startVisionCoresident(gen, detail)
          if (gen !== this.switchGen) {
            await this.disposeLlama()
            return this.getStatus()
          }
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

  /** True when no leftover apply process is running (Apply slot is retired). */
  private async applyMatchesWanted(gen: number): Promise<boolean> {
    if (gen !== this.switchGen) return false
    const apply = this.getApplyLlama()
    return !apply || apply.currentState === 'stopped'
  }

  /**
   * Apply GGUF is retired — Chat applies patches. Stop any leftover port+1 process.
   */
  private async startApplyCoresident(
    _gen: number,
    chatDetail: string
  ): Promise<string> {
    this.lastApplyError = undefined
    const existing = this.getApplyLlama()
    if (existing) {
      try {
        await existing.stop()
      } catch {
        /* ignore */
      }
      this.setApplyLlama(null)
    }
    return chatDetail
  }

  /** True when vision is not wanted, or coresident vision is ready on the wanted path. */
  private async visionMatchesWanted(gen: number): Promise<boolean> {
    if (gen !== this.switchGen) return false
    if (this.visionReusesChat()) {
      const leftover = this.getVisionLlama()
      if (leftover && leftover.currentState !== 'stopped') return false
      const llama = this.getLlama()
      let wantMm = ''
      try {
        wantMm = (await this.optsFor('chat')).mmprojPath?.trim() || ''
      } catch {
        wantMm = ''
      }
      return (
        llama?.currentState === 'ready' &&
        Boolean(llama.mmprojPath?.trim()) &&
        (llama.mmprojPath || '') === wantMm &&
        !this.lastVisionError
      )
    }
    if (!this.keepVisionLoaded()) {
      const leftover = this.getVisionLlama()
      return !leftover || leftover.currentState === 'stopped'
    }
    let visionOpts: LlamaProcessOptions
    try {
      visionOpts = await this.optsFor('vision')
    } catch {
      return !this.getVisionLlama()
    }
    const want = visionOpts.modelPath?.trim() || ''
    const vision = this.getVisionLlama()
    if (!want) {
      return !vision || vision.currentState === 'stopped'
    }
    return (
      !!vision &&
      vision.currentState === 'ready' &&
      vision.modelPath === want &&
      (vision.mmprojPath || '') === (visionOpts.mmprojPath || '') &&
      !this.lastVisionError
    )
  }

  /**
   * Soft-start vision on port+2 after chat is ready. Failures leave chat up.
   */
  private async startVisionCoresident(
    gen: number,
    chatDetail: string
  ): Promise<string> {
    this.lastVisionError = undefined
    if (this.visionReusesChat()) {
      const leftover = this.getVisionLlama()
      if (leftover) {
        try {
          await leftover.stop()
        } catch {
          /* ignore */
        }
        this.setVisionLlama(null)
      }
      const llama = this.getLlama()
      if (llama?.currentState === 'ready' && llama.mmprojPath?.trim()) {
        if (/Apply ready/i.test(chatDetail)) {
          return 'Chat + Apply + Vision ready (same GGUF + mmproj)'
        }
        return 'Chat + Vision ready (same GGUF + mmproj)'
      }
      this.lastVisionError =
        llama?.droppedMmprojPath
          ? `mmproj does not match Chat (n_embd). Dropped ${llama.droppedMmprojPath.replace(/^.*[/\\]/, '')}. Pick a projector for this GGUF.`
          : 'Chat is the VL model — set a matching mmproj (or place *mmproj*.gguf next to the GGUF), then Load.'
      return `${chatDetail} · Vision failed: ${this.lastVisionError}`
    }
    let visionOpts: LlamaProcessOptions
    try {
      visionOpts = await this.optsFor('vision')
    } catch (err) {
      this.lastVisionError = err instanceof Error ? err.message : String(err)
      return `${chatDetail} · Vision failed: ${this.lastVisionError}`
    }

    const path = visionOpts.modelPath?.trim() || ''
    if (!path) {
      return chatDetail
    }
    if (!existsSync(path)) {
      this.lastVisionError = `Vision model not found: ${path}`
      return `${chatDetail} · Vision failed: ${this.lastVisionError}`
    }
    const mm = visionOpts.mmprojPath?.trim()
    if (!mm || !existsSync(mm)) {
      this.lastVisionError =
        'Vision mmproj is not set or missing. Set visionMmprojPath or place a *mmproj*.gguf next to the vision model.'
      return `${chatDetail} · Vision failed: ${this.lastVisionError}`
    }

    const existing = this.getVisionLlama()
    if (
      existing?.currentState === 'ready' &&
      existing.modelPath === path &&
      (existing.mmprojPath || '') === mm
    ) {
      this.lastVisionError = undefined
      return coresidentReadyDetail(chatDetail, true)
    }

    if (existing) {
      try {
        await existing.stop()
      } catch {
        /* ignore */
      }
      this.setVisionLlama(null)
    }

    this.setStatus({
      phase: 'switching',
      detail: 'Loading vision model into VRAM…'
    })

    visionOpts.loadMode = 'mmap'
    const vision = this.createLlama(visionOpts)
    this.setVisionLlama(vision)
    try {
      await vision.start({ force: true })
      if (gen !== this.switchGen) return chatDetail
      this.lastVisionError = undefined
      return coresidentReadyDetail(chatDetail, true)
    } catch (err) {
      this.lastVisionError = err instanceof Error ? err.message : String(err)
      try {
        await vision.stop()
      } catch {
        /* ignore */
      }
      this.setVisionLlama(null)
      LlamaProcessManager.killListenersOnPort(visionOpts.port ?? 8082)
      return `${chatDetail} · Vision failed: ${this.lastVisionError}`
    }
  }

  /** Kill chat + apply + vision llama-servers so nothing stays mapped in RAM/VRAM. */
  private async disposeLlama(): Promise<void> {
    const llama = this.getLlama()
    const apply = this.getApplyLlama()
    const vision = this.getVisionLlama()
    const ports = new Set<number>()
    if (llama) ports.add(llama.port)
    if (apply) ports.add(apply.port)
    if (vision) ports.add(vision.port)
    if (ports.size === 0) ports.add(8080)

    for (const mgr of [llama, apply, vision]) {
      if (!mgr) continue
      try {
        await mgr.stop()
      } catch {
        /* ignore */
      }
    }
    this.setLlama(null)
    this.setApplyLlama(null)
    this.setVisionLlama(null)
    this.lastApplyError = undefined
    this.lastVisionError = undefined

    for (const port of ports) {
      LlamaProcessManager.killListenersOnPort(port)
    }
    // Let the OS reclaim CUDA context / mmap pages before the next load.
    await new Promise((r) => setTimeout(r, 750))
  }
}

function coresidentReadyDetail(chatDetail: string, visionUp: boolean): string {
  if (visionUp && /Apply ready/i.test(chatDetail)) {
    return 'Chat + Apply + Vision ready (coresident in VRAM)'
  }
  if (visionUp) return `${chatDetail.replace(/ \(loaded from disk\)/, '')} + Vision ready`
  return chatDetail
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
