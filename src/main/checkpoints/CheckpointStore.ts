import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { fsSafeRootKey } from '../../shared/workspace'
import {
  CHECKPOINT_MAX_FILE_CHARS,
  CHECKPOINT_MAX_PER_SESSION,
  pruneCheckpointsKeepingLatest,
  type AgentCheckpoint,
  type CheckpointCommitInput,
  type CheckpointFileSnap,
  type CheckpointListItem,
  type CheckpointRewindResult
} from '../../shared/checkpoints'

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

interface IndexFile {
  version: 1
  checkpoints: AgentCheckpoint[]
}

/** Persists turn checkpoints under userData/checkpoints/{fsSafeRootKey}/. */
export class CheckpointStore {
  private rootKey = '__none__'
  private projectRoot = ''
  private index: IndexFile = { version: 1, checkpoints: [] }

  setWorkspaceRoot(root: string): void {
    this.projectRoot = resolve(root)
    this.rootKey = fsSafeRootKey(root)
  }

  private dir(): string {
    return join(app.getPath('userData'), 'checkpoints', this.rootKey)
  }

  private indexPath(): string {
    return join(this.dir(), 'index.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath(), 'utf8')
      const parsed = JSON.parse(raw) as IndexFile
      if (parsed?.version === 1 && Array.isArray(parsed.checkpoints)) {
        this.index = {
          version: 1,
          checkpoints: parsed.checkpoints.filter(
            (c) => c && typeof c.id === 'string' && typeof c.sessionId === 'string'
          )
        }
        return
      }
    } catch {
      /* fresh */
    }
    this.index = { version: 1, checkpoints: [] }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true })
    await fs.writeFile(this.indexPath(), JSON.stringify(this.index), 'utf8')
  }

  list(sessionId?: string): CheckpointListItem[] {
    let list = this.index.checkpoints
    if (sessionId) list = list.filter((c) => c.sessionId === sessionId)
    return list
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => ({
        id: c.id,
        sessionId: c.sessionId,
        createdAt: c.createdAt,
        messageId: c.messageId,
        label: c.label,
        fileCount: c.files.length
      }))
  }

  get(id: string): AgentCheckpoint | null {
    return this.index.checkpoints.find((c) => c.id === id) ?? null
  }

  /**
   * Snapshot a turn. Idempotent on messageId; stores empty-file cps for chat-only rewind.
   */
  async commit(input: CheckpointCommitInput): Promise<AgentCheckpoint | null> {
    const existing = this.index.checkpoints.find(
      (c) => c.sessionId === input.sessionId && c.messageId === input.messageId
    )
    if (existing) return existing

    const files = sanitizeFiles(input.files)
    const cp: AgentCheckpoint = {
      id: newId(),
      sessionId: input.sessionId,
      createdAt: Date.now(),
      messageId: input.messageId,
      label: (input.label || 'turn').slice(0, 120),
      files
    }

    this.index.checkpoints.push(cp)
    const kept = pruneCheckpointsKeepingLatest(
      this.index.checkpoints,
      CHECKPOINT_MAX_PER_SESSION
    )
    this.index.checkpoints = kept
    await this.persist()
    return cp
  }

  /** Restore files; drop this cps and newer ones for the session. Caller truncates chat. */
  async rewind(
    id: string,
    restoreFile: (snap: CheckpointFileSnap) => Promise<void>
  ): Promise<CheckpointRewindResult> {
    const cp = this.get(id)
    if (!cp) {
      return {
        ok: false,
        checkpointId: id,
        restoredPaths: [],
        truncatedAfterMessageId: '',
        error: 'Checkpoint not found'
      }
    }

    const restoredPaths: string[] = []
    for (const f of cp.files) {
      if (f.skipped) continue
      try {
        await restoreFile(f)
        restoredPaths.push(f.path)
      } catch (err) {
        return {
          ok: false,
          checkpointId: id,
          restoredPaths,
          truncatedAfterMessageId: cp.messageId,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    this.index.checkpoints = this.index.checkpoints.filter(
      (c) =>
        !(
          c.sessionId === cp.sessionId &&
          (c.id === cp.id || c.createdAt >= cp.createdAt)
        )
    )
    await this.persist()

    return {
      ok: true,
      checkpointId: cp.id,
      restoredPaths,
      truncatedAfterMessageId: cp.messageId
    }
  }

  async forgetSession(sessionId: string): Promise<void> {
    const before = this.index.checkpoints.length
    this.index.checkpoints = this.index.checkpoints.filter(
      (c) => c.sessionId !== sessionId
    )
    if (this.index.checkpoints.length !== before) await this.persist()
  }
}

function sanitizeFiles(files: CheckpointFileSnap[]): CheckpointFileSnap[] {
  const out: CheckpointFileSnap[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (!f?.path) continue
    const path = f.path.replace(/\\/g, '/')
    if (seen.has(path)) continue
    seen.add(path)
    if (f.skipped) {
      out.push({ path, existed: f.existed, previous: null, skipped: f.skipped })
      continue
    }
    if (f.previous != null && f.previous.length > CHECKPOINT_MAX_FILE_CHARS) {
      out.push({ path, existed: f.existed, previous: null, skipped: 'too_large' })
      continue
    }
    if (f.previous != null && /[\u0000]/.test(f.previous.slice(0, 4096))) {
      out.push({ path, existed: f.existed, previous: null, skipped: 'binary' })
      continue
    }
    out.push({
      path,
      existed: !!f.existed,
      previous: f.previous
    })
  }
  return out
}

/** Pending-edit map → snaps with size limits. */
export function pendingMapToSnaps(
  pending: Iterable<[string, { existed: boolean; previous: string }]>
): CheckpointFileSnap[] {
  const out: CheckpointFileSnap[] = []
  for (const [path, snap] of pending) {
    if (snap.previous.length > CHECKPOINT_MAX_FILE_CHARS) {
      out.push({
        path: path.replace(/\\/g, '/'),
        existed: snap.existed,
        previous: null,
        skipped: 'too_large'
      })
    } else {
      out.push({
        path: path.replace(/\\/g, '/'),
        existed: snap.existed,
        previous: snap.previous
      })
    }
  }
  return out
}
