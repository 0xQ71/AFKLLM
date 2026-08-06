export type ComposerActivityKind =
  | 'read'
  | 'search'
  | 'explore'
  | 'edit'
  | 'delete'
  | 'mkdir'
  | 'list'
  | 'web'
  | 'shell'
  | 'todo'
  | 'planning'
  | 'other'

export type ComposerActivityStatus = 'running' | 'done' | 'error' | 'skipped' | 'partial'

export interface ComposerActivity {
  kind: ComposerActivityKind
  verb: string
  path?: string
  query?: string
  command?: string
  lineStart?: number
  lineEnd?: number
  matchCount?: number
  fileCount?: number
  detail?: string
  status: ComposerActivityStatus
}

export interface AggregateActivityGroup {
  kind: ComposerActivityKind
  count: number
  summary: string
  messageIds: string[]
  sample: ComposerActivity
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

function countLines(text: string): number {
  if (!text) return 0
  const n = text.split(/\r?\n/).length
  // trailing newline does not add an empty visual line for range purposes
  return text.endsWith('\n') ? Math.max(1, n - 1) : n
}

function countGrepMatches(resultContent: string): number {
  if (!resultContent || /no matches found/i.test(resultContent)) return 0
  return resultContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('Explore') && l.includes(':')).length
}

/** Count numbered hits from formatWebSearchHits output. */
function countWebSearchHits(resultContent: string): number {
  if (!resultContent || /no web results/i.test(resultContent)) return 0
  return resultContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s+\S/.test(l)).length
}

export function friendlyShellLabel(command: string): string {
  const c = command.trim()
  if (!c) return 'command'
  if (/typecheck|tsc\b/i.test(c)) {
    if (/syntax|recheck/i.test(c)) return 'Recheck TypeScript after syntax fix'
    if (/delete|confirm/i.test(c)) return 'Typecheck after delete/confirm changes'
    return 'Typecheck'
  }
  if (/npm run test|vitest|jest/i.test(c)) return 'Tests'
  if (/npm run (dev|build|lint)/i.test(c)) {
    const m = c.match(/npm run (\w+)/i)
    return m ? `npm run ${m[1]}` : c.slice(0, 72)
  }
  if (/^git\s+/i.test(c)) return c.slice(0, 72)
  return c.length > 72 ? `${c.slice(0, 69)}…` : c
}

export function buildActivityFromTool(params: {
  name: string
  args?: Record<string, unknown>
  resultContent?: string
  streaming?: boolean
  ok?: boolean
  /** Saved to disk but needs more appends (INCOMPLETE_WRITE). */
  partial?: boolean
  fileCount?: number
  toolsUsed?: number
}): ComposerActivity {
  const args = params.args ?? {}
  const streaming = Boolean(params.streaming)
  const ok = params.ok !== false
  const status: ComposerActivityStatus = streaming
    ? 'running'
    : params.partial
      ? 'partial'
      : ok
        ? 'done'
        : 'error'

  const path =
    typeof args.relative_path === 'string'
      ? args.relative_path
      : typeof args.dir_path === 'string'
        ? args.dir_path
        : typeof args.patch === 'string'
          ? (args.patch.match(/\*\*\* (?:Update|Add|Delete) File:\s*(\S+)/)?.[1] ??
            undefined)
          : undefined

  const query =
    typeof args.query === 'string'
      ? args.query
      : typeof args.goal === 'string'
        ? args.goal
        : undefined

  const command =
    typeof args.command === 'string' ? args.command : undefined

  const startRaw = Number(args.start_line ?? args.offset)
  const endRaw = Number(args.end_line ?? args.limit)
  let lineStart =
    Number.isFinite(startRaw) && startRaw > 0 ? Math.floor(startRaw) : undefined
  let lineEnd =
    Number.isFinite(endRaw) && endRaw > 0 ? Math.floor(endRaw) : undefined

  switch (params.name) {
    case 'read_file': {
      if (!streaming && params.resultContent && lineStart == null) {
        const n = countLines(params.resultContent)
        if (n > 0) {
          lineStart = 1
          lineEnd = n
        }
      } else if (
        lineStart != null &&
        lineEnd == null &&
        params.resultContent &&
        !streaming
      ) {
        lineEnd = lineStart + countLines(params.resultContent) - 1
      }
      return {
        kind: 'read',
        verb: streaming ? 'Reading' : 'Read',
        path,
        lineStart,
        lineEnd,
        status
      }
    }
    case 'search_codebase': {
      const matchCount = streaming
        ? undefined
        : countGrepMatches(params.resultContent ?? '')
      return {
        kind: 'search',
        verb: streaming ? 'Searching' : 'Grepped',
        query,
        matchCount,
        status
      }
    }
    case 'explore_subagent': {
      const fileCount = params.fileCount
      return {
        kind: 'explore',
        verb: streaming ? 'Exploring' : 'Explored',
        query,
        fileCount,
        detail:
          !streaming && fileCount != null
            ? undefined
            : query
              ? query.slice(0, 72)
              : undefined,
        status
      }
    }
    case 'write_file':
    case 'apply_patch':
    case 'apply_diff':
      return {
        kind: 'edit',
        verb: streaming ? 'Editing' : 'Edited',
        path,
        status
      }
    case 'delete_file':
      return {
        kind: 'delete',
        verb: streaming ? 'Deleting' : 'Deleted',
        path,
        status
      }
    case 'create_directory':
      return {
        kind: 'mkdir',
        verb: streaming ? 'Creating' : 'Created',
        path,
        status
      }
    case 'list_directory':
      return {
        kind: 'list',
        verb: streaming ? 'Listing' : 'Listed',
        path: path || '.',
        status
      }
    case 'web_search': {
      const isSkip =
        !streaming && /WEB_SEARCH_SKIPPED/i.test(params.resultContent ?? '')
      const matchCount =
        streaming || isSkip
          ? undefined
          : countWebSearchHits(params.resultContent ?? '')
      const webStatus: ComposerActivityStatus = streaming
        ? 'running'
        : isSkip
          ? 'skipped'
          : ok
            ? 'done'
            : 'error'
      return {
        kind: 'web',
        verb: streaming
          ? 'web_search'
          : isSkip
            ? 'web_search · skip'
            : ok
              ? 'web_search · ok'
              : 'web_search · failed',
        query,
        matchCount,
        detail: isSkip
          ? 'no internet'
          : streaming
            ? undefined
            : ok
              ? `${matchCount ?? 0} sites`
              : undefined,
        status: webStatus
      }
    }
    case 'execute_terminal_command':
      return {
        kind: 'shell',
        verb: streaming ? 'Running' : 'Ran',
        command,
        detail: command ? friendlyShellLabel(command) : undefined,
        status
      }
    case 'read_terminal':
      return {
        kind: 'shell',
        verb: streaming ? 'Reading terminal' : 'Read terminal',
        status
      }
    case '__planning__':
      return {
        kind: 'planning',
        verb: 'Planning next moves',
        status: streaming ? 'running' : 'done'
      }
    case '__todo__':
      return {
        kind: 'todo',
        verb: streaming ? 'Updating to-do list' : 'Checked to-do list',
        status
      }
    default:
      return {
        kind: 'other',
        verb: streaming ? 'Working' : params.name || 'Tool',
        path,
        query,
        command,
        detail: query || command,
        status
      }
  }
}

export function formatActivityParts(activity: ComposerActivity): {
  verb: string
  target?: string
  suffix?: string
  pathLabel?: string
  lineRange?: string
} {
  const { verb, path, query, command, lineStart, lineEnd, fileCount, detail } =
    activity

  if (activity.kind === 'planning') {
    return { verb: 'Planning next moves' }
  }
  if (activity.kind === 'todo') {
    return { verb }
  }
  if (activity.kind === 'explore' && fileCount != null) {
    const n = fileCount
    return {
      verb: activity.status === 'running' ? 'Exploring' : 'Explored',
      target: n === 1 ? '1 file' : `${n} files`
    }
  }
  if (activity.kind === 'explore') {
    return { verb, target: detail || (query ? query.slice(0, 72) : undefined) }
  }
  if (activity.kind === 'search') {
    return {
      verb,
      target: query ? query.slice(0, 96) : undefined,
      suffix:
        activity.matchCount === 0 && activity.status === 'done'
          ? 'no matches'
          : undefined
    }
  }
  if (activity.kind === 'read' && path) {
    const range =
      lineStart != null && lineEnd != null
        ? `L${lineStart}-${lineEnd}`
        : lineStart != null
          ? `L${lineStart}`
          : undefined
    return {
      verb,
      pathLabel: basename(path),
      lineRange: range,
      target: range ? `${basename(path)} ${range}` : basename(path)
    }
  }
  if (activity.kind === 'edit' || activity.kind === 'delete' || activity.kind === 'mkdir') {
    const verbOut =
      activity.status === 'error'
        ? `${verb} · failed`
        : activity.status === 'partial'
          ? `${verb} · partial`
          : verb
    return {
      verb: verbOut,
      pathLabel: path ? basename(path) : undefined,
      target: path ? basename(path) : activity.status === 'error' ? '(no path)' : undefined
    }
  }
  if (activity.kind === 'list') {
    return { verb, target: path || '.' }
  }
  if (activity.kind === 'web') {
    const q = query ? query.slice(0, 96) : undefined
    if (activity.status === 'running') {
      return { verb: 'web_search', target: q, suffix: 'searching the web…' }
    }
    if (activity.status === 'skipped') {
      return { verb: 'web_search', target: q, suffix: 'skip (no internet)' }
    }
    if (activity.status === 'error') {
      return { verb: 'web_search', target: q, suffix: 'failed' }
    }
    const n = activity.matchCount ?? 0
    return {
      verb: 'web_search',
      target: q,
      suffix: `ok (internet search) · ${n} ${n === 1 ? 'site' : 'sites'}`
    }
  }
  if (activity.kind === 'shell') {
    return { verb, target: detail || (command ? friendlyShellLabel(command) : undefined) }
  }
  return {
    verb,
    target: path ? basename(path) : detail || query || command
  }
}

export function formatActivityLabel(activity: ComposerActivity): string {
  if (activity.kind === 'explore' && activity.fileCount != null) {
    const n = activity.fileCount
    const v = activity.status === 'running' ? 'Exploring' : 'Explored'
    return `${v} ${n === 1 ? '1 file' : `${n} files`}`
  }
  if (activity.kind === 'web') {
    const parts = formatActivityParts(activity)
    const bits = [parts.verb]
    if (parts.suffix) bits.push(parts.suffix)
    if (parts.target) bits.push(parts.target)
    return bits.join(' · ')
  }
  const parts = formatActivityParts(activity)
  const bits = [parts.verb]
  if (parts.target) bits.push(parts.target)
  if (parts.suffix) bits.push(`(${parts.suffix})`)
  return bits.join(' ')
}

export function aggregateActivityMessages(
  items: Array<{ id: string; activity: ComposerActivity; streaming?: boolean }>
): Array<
  | { type: 'single'; id: string; activity: ComposerActivity }
  | { type: 'group'; group: AggregateActivityGroup }
> {
  const out: Array<
    | { type: 'single'; id: string; activity: ComposerActivity }
    | { type: 'group'; group: AggregateActivityGroup }
  > = []

  let i = 0
  while (i < items.length) {
    const cur = items[i]!
    // Don't aggregate while any in the run is still streaming
    if (cur.streaming || cur.activity.status === 'running') {
      out.push({ type: 'single', id: cur.id, activity: cur.activity })
      i++
      continue
    }

    const kind = cur.activity.kind
    if (kind !== 'search' && kind !== 'read' && kind !== 'explore') {
      out.push({ type: 'single', id: cur.id, activity: cur.activity })
      i++
      continue
    }

    let j = i + 1
    while (j < items.length) {
      const n = items[j]!
      if (n.streaming || n.activity.status === 'running') break
      if (n.activity.kind !== kind) break
      j++
    }

    if (j - i < 2) {
      out.push({ type: 'single', id: cur.id, activity: cur.activity })
      i++
      continue
    }

    const slice = items.slice(i, j)
    const count = slice.length
    let summary: string
    if (kind === 'search') {
      summary = `${count} searches`
    } else if (kind === 'read') {
      summary = count === 1 ? '1 file' : `Explored ${count} files`
      summary = `Explored ${count} files`
    } else {
      const files = slice.reduce((acc, s) => acc + (s.activity.fileCount ?? 1), 0)
      summary = `Explored ${files} files`
    }

    out.push({
      type: 'group',
      group: {
        kind,
        count,
        summary,
        messageIds: slice.map((s) => s.id),
        sample: slice[slice.length - 1]!.activity
      }
    })
    i = j
  }

  return out
}

export function sanitizeActivity(raw: unknown): ComposerActivity | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const kind = o.kind
  const verb = o.verb
  const status = o.status
  if (typeof kind !== 'string' || typeof verb !== 'string') return undefined
  if (
    status !== 'running' &&
    status !== 'done' &&
    status !== 'error' &&
    status !== 'skipped' &&
    status !== 'partial'
  ) {
    return undefined
  }
  const out: ComposerActivity = {
    kind: kind as ComposerActivityKind,
    verb,
    status
  }
  if (typeof o.path === 'string') out.path = o.path
  if (typeof o.query === 'string') out.query = o.query
  if (typeof o.command === 'string') out.command = o.command
  if (typeof o.detail === 'string') out.detail = o.detail
  if (typeof o.lineStart === 'number') out.lineStart = o.lineStart
  if (typeof o.lineEnd === 'number') out.lineEnd = o.lineEnd
  if (typeof o.matchCount === 'number') out.matchCount = o.matchCount
  if (typeof o.fileCount === 'number') out.fileCount = o.fileCount
  return out
}
