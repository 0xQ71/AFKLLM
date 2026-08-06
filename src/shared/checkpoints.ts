/** Agent turn checkpoints (file snaps + chat rewind). */

export const CHECKPOINT_MAX_PER_SESSION = 20
/** Skip files larger than this (utf8 length). */
export const CHECKPOINT_MAX_FILE_CHARS = 512_000

export interface CheckpointFileSnap {
  path: string
  /** Existed before the turn mutated it */
  existed: boolean
  /** Prior contents; null if new / skipped (`skipped` set) */
  previous: string | null
  skipped?: 'too_large' | 'binary'
}

export interface AgentCheckpoint {
  id: string
  sessionId: string
  createdAt: number
  /** User message that started the turn (rewind keeps messages before it) */
  messageId: string
  label: string
  files: CheckpointFileSnap[]
}

export interface CheckpointListItem {
  id: string
  sessionId: string
  createdAt: number
  messageId: string
  label: string
  fileCount: number
}

export interface CheckpointCommitInput {
  sessionId: string
  messageId: string
  label: string
  files: CheckpointFileSnap[]
}

export interface CheckpointRewindResult {
  ok: boolean
  checkpointId: string
  restoredPaths: string[]
  truncatedAfterMessageId: string
  error?: string
}

export function pruneCheckpointsKeepingLatest(
  items: AgentCheckpoint[],
  maxPerSession: number
): AgentCheckpoint[] {
  const bySession = new Map<string, AgentCheckpoint[]>()
  for (const c of items) {
    const list = bySession.get(c.sessionId) ?? []
    list.push(c)
    bySession.set(c.sessionId, list)
  }
  const out: AgentCheckpoint[] = []
  for (const list of bySession.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt)
    out.push(...list.slice(-maxPerSession))
  }
  out.sort((a, b) => a.createdAt - b.createdAt)
  return out
}
