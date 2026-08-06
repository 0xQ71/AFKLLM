import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  createEmptySession,
  DEFAULT_WELCOME_MESSAGE,
  sanitizePersistedMessages,
  type ChatSession,
  type ChatStoreSnapshot,
  type PersistedChatMessage
} from '../../shared/chats'
import { chatRootKey } from '../../shared/workspace'

export { chatRootKey, fsSafeRootKey } from '../../shared/workspace'

const MAX_SESSIONS = 40
const MAX_ROOTS = 24

function blankSnapshot(): ChatStoreSnapshot {
  return { activeId: '', sessions: [] }
}

/** Starter agent snapshot for a newly opened repo. */
function emptySnapshot(): ChatStoreSnapshot {
  const first = createEmptySession()
  return { activeId: first.id, sessions: [first] }
}

/**
 * Chat sessions scoped per workspace root.
 * File: userData/chats.json → { version: 2, activeRoot, roots }
 */
export class ChatStore {
  private path: string
  private activeRootKey = '__none__'
  private roots: Record<string, ChatStoreSnapshot> = {}
  private cache: ChatStoreSnapshot

  constructor() {
    this.path = join(app.getPath('userData'), 'chats.json')
    this.cache = emptySnapshot()
    this.roots[this.activeRootKey] = this.cache
  }

  async load(): Promise<ChatStoreSnapshot> {
    try {
      const raw = await fs.readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      this.hydrate(parsed)
    } catch {
      this.activeRootKey = '__none__'
      this.cache = emptySnapshot()
      this.roots = { [this.activeRootKey]: this.cache }
      await this.persist()
    }
    return this.get()
  }

  /** Switch chat bucket for a project root; persists previous first. */
  async setWorkspaceRoot(root: string): Promise<ChatStoreSnapshot> {
    this.stashCurrent()
    const key = chatRootKey(root)
    // One-time: move pre-repo chats into the first real workspace
    if (this.roots['__legacy__'] && key !== '__none__' && !this.roots[key]) {
      this.roots[key] = this.roots['__legacy__']!
      delete this.roots['__legacy__']
    }
    this.activeRootKey = key
    if (!this.roots[key]) {
      this.roots[key] = emptySnapshot()
    }
    this.cache = this.roots[key]!
    this.trimRoots()
    await this.persist()
    return this.get()
  }

  /**
   * Drop sessions for a workspace root. If active, keep an empty bucket so
   * the composer can create a fresh agent on the next send.
   */
  async forgetRoot(root: string): Promise<ChatStoreSnapshot> {
    const key = chatRootKey(root)
    if (this.activeRootKey === key) {
      this.cache = blankSnapshot()
      this.roots[key] = this.cache
    } else {
      this.stashCurrent()
      delete this.roots[key]
    }
    await this.persist()
    return this.get()
  }

  getWorkspaceKey(): string {
    return this.activeRootKey
  }

  get(): ChatStoreSnapshot {
    return cloneSnapshot(this.cache)
  }

  list(): Array<Omit<ChatSession, 'messages'>> {
    return this.cache.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
  }

  /** Session metas for many roots; does not change the active bucket. */
  listByRoots(roots: string[]): Record<string, Array<Omit<ChatSession, 'messages'>>> {
    this.stashCurrent()
    const out: Record<string, Array<Omit<ChatSession, 'messages'>>> = {}
    for (const root of roots) {
      const key = chatRootKey(root)
      const snap = this.roots[key]
      if (!snap?.sessions?.length) {
        out[root] = []
        continue
      }
      out[root] = snap.sessions
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, title, createdAt, updatedAt }) => ({
          id,
          title,
          createdAt,
          updatedAt
        }))
    }
    return out
  }

  getSession(id: string): ChatSession | null {
    const s = this.cache.sessions.find((x) => x.id === id)
    return s ? { ...s, messages: s.messages.map((m) => ({ ...m })) } : null
  }

  async setActive(id: string): Promise<ChatStoreSnapshot> {
    if (!this.cache.sessions.some((s) => s.id === id)) return this.get()
    this.cache.activeId = id
    await this.persist()
    return this.get()
  }

  async create(): Promise<ChatStoreSnapshot> {
    const session = createEmptySession()
    this.cache.sessions.unshift(session)
    this.cache.activeId = session.id
    this.trimSessions()
    await this.persist()
    return this.get()
  }

  async delete(id: string): Promise<ChatStoreSnapshot> {
    this.cache.sessions = this.cache.sessions.filter((s) => s.id !== id)
    if (this.cache.sessions.length === 0) {
      this.cache.activeId = ''
    } else if (this.cache.activeId === id) {
      this.cache.activeId = this.cache.sessions[0]!.id
    }
    await this.persist()
    return this.get()
  }

  async updateMessages(
    id: string,
    messages: PersistedChatMessage[],
    title?: string
  ): Promise<ChatStoreSnapshot> {
    const idx = this.cache.sessions.findIndex((s) => s.id === id)
    if (idx === -1) return this.get()
    const prev = this.cache.sessions[idx]!
    const cleaned = sanitizePersistedMessages(messages)
    const nextTitle =
      title?.trim() ||
      deriveTitle(cleaned) ||
      prev.title ||
      'New agent'
    this.cache.sessions[idx] = {
      ...prev,
      title: nextTitle,
      updatedAt: Date.now(),
      messages: cleaned
    }
    if (id === this.cache.activeId) {
      const [s] = this.cache.sessions.splice(idx, 1)
      this.cache.sessions.unshift(s!)
    }
    await this.persist()
    return this.get()
  }

  private stashCurrent(): void {
    this.roots[this.activeRootKey] = cloneSnapshot(this.cache)
  }

  private hydrate(parsed: Record<string, unknown>): void {
    // Legacy v1: { activeId, sessions }
    if (Array.isArray(parsed.sessions)) {
      const snap = sanitizeSnapshot(parsed as Partial<ChatStoreSnapshot>)
      this.activeRootKey = '__legacy__'
      this.roots = { [this.activeRootKey]: snap }
      this.cache = snap
      return
    }

    // v2: { version, activeRoot, roots }
    const rootsIn = parsed.roots
    this.roots = {}
    if (rootsIn && typeof rootsIn === 'object') {
      for (const [k, v] of Object.entries(rootsIn as Record<string, unknown>)) {
        this.roots[k] = sanitizeSnapshot(v as Partial<ChatStoreSnapshot>)
      }
    }
    const active =
      typeof parsed.activeRoot === 'string' && parsed.activeRoot
        ? parsed.activeRoot
        : Object.keys(this.roots)[0] || '__none__'
    this.activeRootKey = active
    if (!this.roots[this.activeRootKey]) {
      this.roots[this.activeRootKey] = emptySnapshot()
    }
    this.cache = this.roots[this.activeRootKey]!
  }

  private trimSessions(): void {
    if (this.cache.sessions.length <= MAX_SESSIONS) return
    const active = this.cache.activeId
    const rest = this.cache.sessions
      .filter((s) => s.id !== active)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS - 1)
    const keep = this.cache.sessions.find((s) => s.id === active)
    this.cache.sessions = keep ? [keep, ...rest] : rest
  }

  private trimRoots(): void {
    const keys = Object.keys(this.roots)
    if (keys.length <= MAX_ROOTS) return
    const ranked = keys
      .map((k) => {
        const snap = this.roots[k]!
        const latest = Math.max(0, ...snap.sessions.map((s) => s.updatedAt))
        return { k, latest }
      })
      .sort((a, b) => b.latest - a.latest)
    const keep = new Set(
      [this.activeRootKey, ...ranked.slice(0, MAX_ROOTS - 1).map((x) => x.k)]
    )
    for (const k of keys) {
      if (!keep.has(k)) delete this.roots[k]
    }
  }

  private async persist(): Promise<void> {
    this.stashCurrent()
    await fs.mkdir(dirname(this.path), { recursive: true })
    const payload = {
      version: 2,
      activeRoot: this.activeRootKey,
      roots: this.roots
    }
    await fs.writeFile(this.path, JSON.stringify(payload), 'utf8')
  }
}

function cloneSnapshot(s: ChatStoreSnapshot): ChatStoreSnapshot {
  return {
    activeId: s.activeId,
    sessions: s.sessions.map((x) => ({
      ...x,
      messages: x.messages.map((m) => ({ ...m }))
    }))
  }
}

function sanitizeSnapshot(input: Partial<ChatStoreSnapshot>): ChatStoreSnapshot {
  const sessions = Array.isArray(input.sessions)
    ? input.sessions
        .map(sanitizeSession)
        .filter((s): s is ChatSession => s != null)
    : []
  let activeId = typeof input.activeId === 'string' ? input.activeId : ''
  if (!sessions.some((s) => s.id === activeId)) {
    activeId = sessions[0]?.id ?? ''
  }
  if (!activeId && sessions.length === 0) {
    return blankSnapshot()
  }
  return { activeId, sessions }
}

function sanitizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id : ''
  if (!id) return null
  const messages = Array.isArray(o.messages)
    ? sanitizePersistedMessages(o.messages as PersistedChatMessage[])
    : [{ ...DEFAULT_WELCOME_MESSAGE }]
  return {
    id,
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : 'New agent',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
    messages
  }
}

function deriveTitle(messages: PersistedChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!firstUser) return ''
  const line = firstUser.content.trim().split(/\n/)[0] ?? ''
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}
