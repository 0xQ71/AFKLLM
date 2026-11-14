import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  normalizeBreakpoints,
  parseInspectorWsUrl,
  type DebugBreakpoint,
  type DebugEvent,
  type DebugSessionStatus,
  type DebugStackFrame,
  type DebugStartRequest,
  type DebugStartResult,
  type DebugVariable
} from '../../shared/debug'

type Emit = (event: DebugEvent) => void

interface CdpPending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

/** Minimal Node Inspector (CDP) session. */
export class NodeDebugSession {
  private root = ''
  private child: ChildProcessWithoutNullStreams | null = null
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, CdpPending>()
  private status: DebugSessionStatus = { state: 'idle' }
  private breakpoints: DebugBreakpoint[] = []
  private emit: Emit = () => undefined
  private stderrBuf = ''

  setRoot(root: string): void {
    this.root = resolve(root)
  }

  setEmit(fn: Emit): void {
    this.emit = fn
  }

  getStatus(): DebugSessionStatus {
    return {
      ...this.status,
      stack: this.status.stack ? [...this.status.stack] : undefined,
      variables: this.status.variables ? [...this.status.variables] : undefined
    }
  }

  async start(req: DebugStartRequest): Promise<DebugStartResult> {
    if (this.status.state === 'running' || this.status.state === 'paused' || this.status.state === 'starting') {
      return { ok: false, error: 'Debug session already active', status: this.getStatus() }
    }
    if (!this.root) {
      return { ok: false, error: 'No workspace root', status: this.getStatus() }
    }

    const entry = req.entry.replace(/\\/g, '/').replace(/^\/+/, '')
    const absEntry = resolve(this.root, entry)
    if (!existsSync(absEntry)) {
      return {
        ok: false,
        error: `Entry not found: ${entry}`,
        status: this.getStatus()
      }
    }

    this.breakpoints = normalizeBreakpoints(req.breakpoints ?? [])
    const launch = resolveLaunch(this.root, absEntry, entry)
    if (!launch.ok) {
      this.setStatus({ state: 'error', message: launch.error, entry })
      return { ok: false, error: launch.error, status: this.getStatus() }
    }

    this.setStatus({ state: 'starting', entry, message: 'Starting…' })
    this.stderrBuf = ''

    try {
      await this.spawnAndConnect(launch.cmd, launch.args, launch.cwd)
      await this.cdpSend('Debugger.enable', {})
      await this.cdpSend('Runtime.enable', {})
      await this.applyBreakpoints()
      // --inspect-brk leaves us paused for Continue
      this.setStatus({
        state: 'paused',
        entry,
        message: 'Paused on start',
        reason: 'entry'
      })
      this.emit({ type: 'paused', status: this.getStatus() })
      return { ok: true, status: this.getStatus() }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await this.stop()
      this.setStatus({ state: 'error', entry, message: msg })
      return { ok: false, error: msg, status: this.getStatus() }
    }
  }

  async setBreakpoints(bps: DebugBreakpoint[]): Promise<DebugSessionStatus> {
    this.breakpoints = normalizeBreakpoints(bps)
    if (this.ws && (this.status.state === 'running' || this.status.state === 'paused')) {
      try {
        await this.applyBreakpoints()
      } catch {
        /* ignore */
      }
    }
    return this.getStatus()
  }

  async continue(): Promise<DebugSessionStatus> {
    if (!this.ws) return this.getStatus()
    await this.cdpSend('Debugger.resume', {})
    this.setStatus({ ...this.status, state: 'running', stack: undefined, reason: undefined })
    this.emit({ type: 'resumed', status: this.getStatus() })
    return this.getStatus()
  }

  async stepOver(): Promise<DebugSessionStatus> {
    if (!this.ws) return this.getStatus()
    await this.cdpSend('Debugger.stepOver', {})
    return this.getStatus()
  }

  async stepInto(): Promise<DebugSessionStatus> {
    if (!this.ws) return this.getStatus()
    await this.cdpSend('Debugger.stepInto', {})
    return this.getStatus()
  }

  async stepOut(): Promise<DebugSessionStatus> {
    if (!this.ws) return this.getStatus()
    await this.cdpSend('Debugger.stepOut', {})
    return this.getStatus()
  }

  async stop(): Promise<DebugSessionStatus> {
    try {
      this.ws?.close()
    } catch {
      /* */
    }
    this.ws = null
    for (const [, p] of this.pending) {
      p.reject(new Error('stopped'))
    }
    this.pending.clear()
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        /* */
      }
      this.child = null
    }
    this.setStatus({ state: 'stopped', message: 'Stopped' })
    this.emit({ type: 'exited', status: this.getStatus() })
    return this.getStatus()
  }

  private async spawnAndConnect(
    cmd: string,
    args: string[],
    cwd: string
  ): Promise<void> {
    return new Promise((resolveP, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env },
        shell: false
      })
      this.child = child
      let settled = false

      const onData = (buf: Buffer): void => {
        const text = buf.toString('utf8')
        this.stderrBuf += text
        this.emit({
          type: 'output',
          status: this.getStatus(),
          output: text
        })
        const wsUrl = parseInspectorWsUrl(this.stderrBuf)
        if (wsUrl && !settled) {
          settled = true
          void this.connectWs(wsUrl)
            .then(() => resolveP())
            .catch(reject)
        }
      }

      child.stderr.on('data', onData)
      child.stdout.on('data', (buf: Buffer) => {
        this.emit({
          type: 'output',
          status: this.getStatus(),
          output: buf.toString('utf8')
        })
      })
      child.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`Process exited before debugger ready (code ${code})`))
        } else {
          void this.stop()
        }
      })

      setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('Timed out waiting for Debugger listening URL'))
        }
      }, 15_000)
    })
  }

  private async connectWs(url: string): Promise<void> {
    await new Promise<void>((resolveP, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      ws.onopen = () => resolveP()
      ws.onerror = () => reject(new Error('WebSocket connection failed'))
      ws.onmessage = (ev) => this.onWsMessage(String(ev.data))
      ws.onclose = () => {
        this.ws = null
      }
    })
  }

  private onWsMessage(raw: string): void {
    let msg: {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { message?: string }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'Debugger.paused') {
      void this.handlePaused(msg.params ?? {})
    } else if (msg.method === 'Debugger.resumed') {
      this.setStatus({
        ...this.status,
        state: 'running',
        stack: undefined,
        variables: undefined
      })
      this.emit({ type: 'resumed', status: this.getStatus() })
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params?.args as Array<{ value?: unknown; description?: string }>) ?? []
      const text = args
        .map((a) => (a.value != null ? String(a.value) : a.description ?? ''))
        .join(' ')
      if (text) {
        this.emit({ type: 'output', status: this.getStatus(), output: text + '\n' })
      }
    }
  }

  private async handlePaused(params: Record<string, unknown>): Promise<void> {
    const callFrames = (params.callFrames as Array<{
      callFrameId: string
      functionName: string
      location: { scriptId: string; lineNumber: number; columnNumber?: number }
      url: string
      scopeChain?: Array<{
        type: string
        object?: { objectId?: string }
      }>
    }>) ?? []

    const stack: DebugStackFrame[] = []
    for (let i = 0; i < callFrames.length; i++) {
      const f = callFrames[i]!
      const path = urlToRelPath(f.url, this.root)
      stack.push({
        id: i,
        name: f.functionName || '(anonymous)',
        path: path ?? undefined,
        line: f.location.lineNumber + 1,
        column: (f.location.columnNumber ?? 0) + 1
      })
    }

    const variables = await this.collectLocals(callFrames[0])

    this.setStatus({
      ...this.status,
      state: 'paused',
      stack,
      variables,
      reason: String(params.reason ?? 'breakpoint'),
      message: `Paused (${params.reason ?? 'breakpoint'})`
    })
    this.emit({ type: 'paused', status: this.getStatus() })
  }

  private async collectLocals(
    frame:
      | {
          scopeChain?: Array<{
            type: string
            object?: { objectId?: string }
          }>
        }
      | undefined
  ): Promise<DebugVariable[]> {
    if (!frame?.scopeChain?.length) return []
    const out: DebugVariable[] = []
    for (const scope of frame.scopeChain) {
      if (scope.type === 'global' || scope.type === 'with') continue
      const objectId = scope.object?.objectId
      if (!objectId) continue
      try {
        const res = (await this.cdpSend('Runtime.getProperties', {
          objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: true
        })) as {
          result?: Array<{
            name: string
            value?: { type?: string; value?: unknown; description?: string; className?: string }
          }>
        }
        for (const prop of res.result ?? []) {
          if (!prop.name || prop.name.startsWith('__')) continue
          const v = prop.value
          let value = 'undefined'
          if (v) {
            if (v.value !== undefined) value = JSON.stringify(v.value)
            else if (v.description) value = v.description
            else if (v.className) value = v.className
            else value = v.type ?? '…'
          }
          out.push({
            name: prop.name,
            value: value.slice(0, 200),
            type: v?.type,
            scope: scope.type
          })
          if (out.length >= 80) return out
        }
      } catch {
        /* best-effort */
      }
    }
    return out
  }

  private async applyBreakpoints(): Promise<void> {
    for (const bp of this.breakpoints) {
      const abs = resolve(this.root, bp.path).replace(/\\/g, '/')
      const fileUrl = pathToFileUrl(abs)
      try {
        await this.cdpSend('Debugger.setBreakpointByUrl', {
          url: fileUrl,
          lineNumber: bp.line - 1,
          columnNumber: 0
        })
      } catch {
        // urlRegex fallback for path endings
        try {
          const escaped = bp.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          await this.cdpSend('Debugger.setBreakpointByUrl', {
            urlRegex: escaped.replace(/\//g, '[/\\\\]'),
            lineNumber: bp.line - 1
          })
        } catch {
          /* best-effort */
        }
      }
    }
  }

  private cdpSend(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolveP, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Debugger not connected'))
        return
      }
      const id = this.nextId++
      this.pending.set(id, { resolve: resolveP, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 10_000)
    })
  }

  private setStatus(s: DebugSessionStatus): void {
    this.status = s
    this.emit({ type: 'status', status: this.getStatus() })
  }
}

function pathToFileUrl(abs: string): string {
  const normalized = abs.replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(normalized)) {
    return 'file:///' + normalized
  }
  return 'file://' + normalized
}

function urlToRelPath(url: string, root: string): string | null {
  if (!url) return null
  let path = url
  if (path.startsWith('file://')) {
    path = decodeURIComponent(path.replace(/^file:\/\/\//, '').replace(/^file:\/\//, ''))
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1)
  }
  path = path.replace(/\\/g, '/')
  const rootN = root.replace(/\\/g, '/')
  if (path.toLowerCase().startsWith(rootN.toLowerCase() + '/')) {
    return path.slice(rootN.length + 1)
  }
  if (path.toLowerCase().startsWith(rootN.toLowerCase())) {
    return path.slice(rootN.length).replace(/^\//, '')
  }
  return null
}

function resolveLaunch(
  root: string,
  absEntry: string,
  relEntry: string
): { ok: true; cmd: string; args: string[]; cwd: string } | { ok: false; error: string } {
  const ext = relEntry.includes('.')
    ? relEntry.slice(relEntry.lastIndexOf('.')).toLowerCase()
    : ''
  const cwd = root
  const nodeCmd = 'node'

  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') {
    const hasTsx = existsSync(join(root, 'node_modules', 'tsx'))
    if (!hasTsx) {
      return {
        ok: false,
        error: 'TypeScript debug needs tsx in the project (npm i -D tsx)'
      }
    }
    return {
      ok: true,
      cmd: nodeCmd,
      args: ['--inspect-brk=0', '--import', 'tsx', absEntry],
      cwd
    }
  }

  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
    return {
      ok: true,
      cmd: nodeCmd,
      args: ['--inspect-brk=0', absEntry],
      cwd
    }
  }

  return {
    ok: false,
    error: 'Open a .js / .ts file to debug (Node Inspector MVP)'
  }
}
