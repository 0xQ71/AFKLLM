// Bridge between the Electron window and the headless agent core (src/core) — the same agent the `afk` CLI runs.
// The renderer only renders events and sends commands; the agent, its tools, permissions, compaction, loop guards,
// vision and the GPU swap for image generation all live here in the main process.
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { Agent } from '../../core/agent'
import { imageGenMissing } from '../../core/imagegen'
import { LlmClient } from '../../core/llm'
import { defaultProfileName, ensureServer, loadConfig, profiles, type ModelProfile, type RunningServer } from '../../core/server'
import { listSessions, loadSession, newSessionId, saveSession } from '../../core/session'
import { GpuSwap, killListener, waitDown } from '../../core/swap'
import { dangerousFolder, isDirectory } from '../../core/workspace'
import { app } from 'electron'
import { dirname } from 'node:path'
import type { GenerateImageRequest, GenerateImageResult } from '../../core/tools'
import type { AgentEvent, PermissionDecision, PermissionMode, PermissionRequest } from '../../core/types'

export interface CoreStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  message?: string
  profile: string
  model?: string
  ctx?: number
  vision: boolean
  imagegen: boolean
}

interface Session {
  id: string
  cwd: string
  created: string
  agent: Agent
  abort: AbortController | null
}

export type CoreEvent =
  | { kind: 'agent'; sessionId: string; event: AgentEvent }
  | { kind: 'permission'; sessionId: string; requestId: number; request: PermissionRequest }
  | { kind: 'status'; status: CoreStatus }
  | { kind: 'activity'; sessionId: string | null; message: string }
  | { kind: 'run_state'; sessionId: string; running: boolean }

const send = (ev: CoreEvent) => {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('core:event', ev)
}

class CoreHost {
  private profileName = defaultProfileName()
  private server: RunningServer | null = null
  private llm: LlmClient | null = null
  private status: CoreStatus = { state: 'idle', profile: this.profileName, vision: false, imagegen: false }
  private starting: Promise<void> | null = null
  private sessions = new Map<string, Session>()
  private pending = new Map<number, (d: PermissionDecision) => void>()
  private nextReq = 1
  private swap: GpuSwap | null = null
  private activeSession: string | null = null

  private profile(): ModelProfile {
    const all = profiles(loadConfig())
    const p = all[this.profileName]
    if (!p) throw new Error(`unknown model profile "${this.profileName}"`)
    return p
  }

  private setStatus(s: Partial<CoreStatus>) {
    this.status = { ...this.status, ...s }
    send({ kind: 'status', status: this.status })
  }

  getStatus(): CoreStatus { return this.status }

  /** Start (or reuse) llama-server for the current profile. Safe to call many times. */
  async ensure(): Promise<void> {
    if (this.llm && this.status.state === 'ready') return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const profile = this.profile()
      this.setStatus({ state: 'loading', message: `loading ${profile.label}…`, model: profile.label })
      try {
        this.server = await ensureServer(profile, loadConfig(), {
          onProgress: (m) => this.setStatus({ state: 'loading', message: m }),
        })
        this.llm = new LlmClient(this.server.url)
        await this.llm.probe()
        this.swap = imageGenMissing().length ? null : new GpuSwap({
          llmUrl: () => this.server!.url,
          stopLlm: async () => {
            const s = this.server!
            if (s.reused) killListener(Number(new URL(s.url).port))
            else s.stop()
            await waitDown(s.url)
          },
          startLlm: async () => { this.server = await ensureServer(this.profile(), loadConfig()) },
          emit: (m) => send({ kind: 'activity', sessionId: this.activeSession, message: m }),
        })
        this.setStatus({
          state: 'ready', message: undefined, ctx: this.llm.ctxSize,
          vision: !!profile.args?.mmproj || !!profile.strata, imagegen: !!this.swap,
        })
      } catch (e) {
        this.setStatus({ state: 'error', message: (e as Error).message })
        throw e
      } finally {
        this.starting = null
      }
    })()
    return this.starting
  }

  private generateImage = async (req: GenerateImageRequest, signal?: AbortSignal): Promise<GenerateImageResult> => {
    if (!this.swap) throw new Error('image generation is not installed')
    const r = await this.swap.generate(req, signal)
    return { ...r, timings: this.swap.last?.timings ?? r.timings, kvRestored: this.swap.last?.kvRestored ?? r.kvRestored }
  }

  private makeAgent(id: string, cwd: string): Agent {
    const profile = this.profile()
    return new Agent({
      cwd, llm: this.llm!, mode: 'default', sampling: profile.sampling as never,
      vision: !!profile.args?.mmproj || !!profile.strata,
      generateImage: this.swap ? this.generateImage : undefined,
      emit: (event) => send({ kind: 'agent', sessionId: id, event }),
      ask: (request) => new Promise((resolve) => {
        const requestId = this.nextReq++
        this.pending.set(requestId, resolve)
        send({ kind: 'permission', sessionId: id, requestId, request })
      }),
    })
  }

  async open(cwd: string, id?: string): Promise<{ id: string; cwd: string; state: ReturnType<Agent['snapshot']>; mode: PermissionMode }> {
    await this.ensure()
    if (id && this.sessions.has(id)) {
      const s = this.sessions.get(id)!
      return { id, cwd: s.cwd, state: s.agent.snapshot(), mode: s.agent.mode }
    }
    const saved = id ? loadSession(cwd, id) : null
    const sid = saved?.id ?? id ?? newSessionId()
    const agent = this.makeAgent(sid, cwd)
    if (saved) agent.restore(saved)
    const s: Session = { id: sid, cwd, created: saved?.created ?? new Date().toISOString(), agent, abort: null }
    this.sessions.set(sid, s)
    return { id: sid, cwd, state: agent.snapshot(), mode: agent.mode }
  }

  list(cwd: string) {
    return listSessions(cwd).map((f) => ({ id: f.id, title: f.title, updated: f.updated, created: f.created, cwd }))
  }

  async run(id: string, text: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) throw new Error('session is not open')
    if (s.abort) throw new Error('this session is already working; stop it or wait')
    const busy = [...this.sessions.values()].find((x) => x.abort)
    if (busy) throw new Error('another session is working (one GPU): wait for it or stop it')
    await this.ensure()
    s.abort = new AbortController()
    this.activeSession = id
    send({ kind: 'run_state', sessionId: id, running: true })
    try {
      await s.agent.run(text, s.abort.signal)
    } finally {
      s.abort = null
      this.activeSession = null
      saveSession(s.cwd, s.id, s.agent.snapshot(), s.created)
      send({ kind: 'run_state', sessionId: id, running: false })
    }
  }

  abort(id: string) { this.sessions.get(id)?.abort?.abort() }

  setMode(id: string, mode: PermissionMode) {
    const s = this.sessions.get(id)
    if (s) { s.agent.mode = mode; send({ kind: 'agent', sessionId: id, event: { type: 'mode', mode } }) }
  }

  permission(requestId: number, decision: PermissionDecision) {
    this.pending.get(requestId)?.(decision)
    this.pending.delete(requestId)
  }

  async compact(id: string, focus = '') {
    const s = this.sessions.get(id)
    if (!s || s.abort) return
    s.abort = new AbortController()
    send({ kind: 'run_state', sessionId: id, running: true })
    try { await s.agent.compact(s.abort.signal, focus, true) } finally {
      s.abort = null
      saveSession(s.cwd, s.id, s.agent.snapshot(), s.created)
      send({ kind: 'run_state', sessionId: id, running: false })
    }
  }

  clear(id: string) {
    const s = this.sessions.get(id)
    if (s && !s.abort) s.agent.clear()
  }

  /** Is a model loaded by this app (a server another process started — e.g. the CLI — is not ours to unload)? */
  modelLoaded(): { loaded: boolean; ours: boolean; label?: string } {
    if (!this.server || this.status.state !== 'ready') return { loaded: false, ours: false }
    return { loaded: true, ours: !this.server.reused, label: this.status.model }
  }

  /** Stop every run and unload the LLM (+ its vision projector, same process). Frees the GPU. */
  async unload(): Promise<void> {
    for (const s of this.sessions.values()) s.abort?.abort()
    const s = this.server
    this.server = null
    this.llm = null
    if (s && !s.reused) {
      s.stop()
      try { await waitDown(s.url, 20_000) } catch { /* it is being killed anyway */ }
    }
    this.setStatus({ state: 'idle', message: 'model unloaded' })
  }

  shutdown() {
    for (const s of this.sessions.values()) { s.abort?.abort(); s.agent.dispose() }
    if (this.server && !this.server.reused) this.server.stop()
  }
}

export const coreHost = new CoreHost()

export function registerCoreIpc(): void {
  ipcMain.handle('core:status', () => coreHost.getStatus())
  ipcMain.handle('core:ensure', async () => { await coreHost.ensure(); return coreHost.getStatus() })
  ipcMain.handle('core:sessions', (_e, cwd: string) => coreHost.list(cwd))
  ipcMain.handle('core:open', (_e, cwd: string, id?: string) => coreHost.open(cwd, id))
  ipcMain.handle('core:run', (_e, id: string, text: string) => coreHost.run(id, text))
  ipcMain.handle('core:abort', (_e, id: string) => coreHost.abort(id))
  ipcMain.handle('core:mode', (_e, id: string, mode: PermissionMode) => coreHost.setMode(id, mode))
  ipcMain.handle('core:permission', (_e, requestId: number, decision: PermissionDecision) => coreHost.permission(requestId, decision))
  ipcMain.handle('core:compact', (_e, id: string, focus?: string) => coreHost.compact(id, focus))
  ipcMain.handle('core:clear', (_e, id: string) => coreHost.clear(id))
  ipcMain.handle('core:model-loaded', () => coreHost.modelLoaded())
  ipcMain.handle('core:unload', () => coreHost.unload())
  ipcMain.handle('core:default-folder', async () => {
    const f = process.env.AFK_PROJECT
    if (!f || !isDirectory(f)) return null
    return (await confirmFolder(f)) === 'ok' ? f : null
  })
  ipcMain.handle('core:pick-folder', async () => {
    for (;;) {
      const r = await dialog.showOpenDialog(focused(), { properties: ['openDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      const verdict = await confirmFolder(r.filePaths[0])
      if (verdict === 'ok') return r.filePaths[0]
      if (verdict === 'cancel') return null
    }
  })
  // a folder remembered from an earlier start is re-checked before use
  ipcMain.handle('core:check-folder', async (_e, f: string) => isDirectory(f) && (await confirmFolder(f)) === 'ok')
}

function focused(): BrowserWindow {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

/** The agent works only inside the chosen folder; a drive root, the home folder, Windows… needs an explicit yes. */
async function confirmFolder(f: string): Promise<'ok' | 'other' | 'cancel'> {
  const why = dangerousFolder(f, app.isPackaged ? dirname(process.execPath) : undefined)
  if (!why) return 'ok'
  const r = await dialog.showMessageBox(focused(), {
    type: 'warning',
    title: 'AFKLLM',
    message: `Работать в папке ${f}?`,
    detail: `${ruWhy(why)}. Агент сможет читать, менять и запускать всё внутри этой папки. Лучше выбрать папку конкретного проекта.`,
    buttons: ['Выбрать другую папку', 'Да, работать здесь', 'Отмена'],
    defaultId: 0, cancelId: 2, noLink: true,
  })
  return r.response === 1 ? 'ok' : r.response === 0 ? 'other' : 'cancel'
}

function ruWhy(why: string): string {
  const m = /^this is your (\w+) folder/.exec(why)
  if (m) return `Это папка ${m[1]}, а не проект`
  const sys = /^this is inside (.+) \(system files\)/.exec(why)
  if (sys) return `Это внутри ${sys[1]} (системные файлы)`
  return RU_WHY[why] ?? why
}

const RU_WHY: Record<string, string> = {
  'this is the root of a drive': 'Это корень диска',
  'this is your whole user folder': 'Это вся папка пользователя',
  'this is inside AppData (program settings and data)': 'Это внутри AppData (настройки и данные программ)',
  'this is the AFKLLM program folder itself': 'Это папка самой программы AFKLLM',
}
