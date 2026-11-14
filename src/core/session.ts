// Session persistence: <project>/.afkllm/sessions/<id>.json, rewritten after every turn.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentState } from './agent'
import { textOf } from './types'

export interface SessionFile extends AgentState {
  id: string
  cwd: string
  created: string
  updated: string
  title: string
}

export function sessionsDir(cwd: string): string {
  return join(cwd, '.afkllm', 'sessions')
}

export function newSessionId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function saveSession(cwd: string, id: string, state: AgentState, created: string): void {
  const dir = sessionsDir(cwd)
  mkdirSync(dir, { recursive: true })
  const firstUser = state.messages.find((m) => m.role === 'user')
  const title = textOf(firstUser?.content ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').slice(0, 80)
  const data: SessionFile = { id, cwd, created, updated: new Date().toISOString(), title, ...state }
  const tmp = join(dir, `${id}.json.tmp`)
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, join(dir, `${id}.json`))
}

export function listSessions(cwd: string): SessionFile[] {
  const dir = sessionsDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .map((p) => { try { return JSON.parse(readFileSync(p, 'utf8')) as SessionFile } catch { return null } })
    .filter((s): s is SessionFile => !!s)
}

export function loadSession(cwd: string, id?: string): SessionFile | null {
  const all = listSessions(cwd)
  return id ? all.find((s) => s.id === id || s.id.startsWith(id)) ?? null : all[0] ?? null
}
