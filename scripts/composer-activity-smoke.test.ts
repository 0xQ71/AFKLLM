/**
 * Smoke: Composer activity labels (Read L…, Grepped, Ran, Explored N files).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregateActivityMessages,
  buildActivityFromTool,
  formatActivityLabel,
  friendlyShellLabel,
  sanitizeActivity
} from '../src/renderer/src/agent/composerActivity.ts'

describe('composerActivity', () => {
  it('formats Read with line range', () => {
    const a = buildActivityFromTool({
      name: 'read_file',
      args: { relative_path: 'src/foo.ts', start_line: 123, end_line: 770 },
      ok: true
    })
    assert.equal(a.verb, 'Read')
    assert.equal(formatActivityLabel(a), 'Read foo.ts L123-770')
  })

  it('infers L1-N from full file content', () => {
    const a = buildActivityFromTool({
      name: 'read_file',
      args: { relative_path: 'a.ts' },
      resultContent: 'a\nb\nc\n',
      ok: true
    })
    assert.equal(a.lineStart, 1)
    assert.equal(a.lineEnd, 3)
    assert.match(formatActivityLabel(a), /Read a\.ts L1-3/)
  })

  it('formats Grepped query', () => {
    const a = buildActivityFromTool({
      name: 'search_codebase',
      args: { query: 'chats.delete|createEmptySession' },
      resultContent: 'src/x.ts:1: foo\nsrc/y.ts:2: bar',
      ok: true
    })
    assert.equal(a.verb, 'Grepped')
    assert.match(formatActivityLabel(a), /Grepped chats\.delete/)
    assert.equal(a.matchCount, 2)
  })

  it('formats Explored N files', () => {
    const a = buildActivityFromTool({
      name: 'explore_subagent',
      args: { goal: 'map chats' },
      fileCount: 6,
      ok: true
    })
    assert.equal(formatActivityLabel(a), 'Explored 6 files')
  })

  it('formats Ran with friendly typecheck label', () => {
    assert.equal(
      friendlyShellLabel('npx tsc --noEmit -p tsconfig.web.json delete confirm'),
      'Typecheck after delete/confirm changes'
    )
    const a = buildActivityFromTool({
      name: 'execute_terminal_command',
      args: { command: 'npx tsc --noEmit syntax recheck' },
      ok: true
    })
    assert.equal(a.verb, 'Ran')
    assert.match(formatActivityLabel(a), /Ran Recheck TypeScript/)
  })

  it('shell chip label uses stdout, not the afk-run wrapper', () => {
    const a = buildActivityFromTool({
      name: 'execute_terminal_command',
      args: {
        command: 'go run wordfreq.go <<< "Go is a programming language"'
      },
      resultContent:
        `note: rewrote Unix shell for PowerShell\n` +
        `& 'C:\\Users\\iron\\AppData\\Local\\Temp\\afk-run-mt0gdyqt.ps1'; Remove-Item -LiteralPath 'C:\\Users\\iron\\AppData\\Local\\Temp\\afk-run-mt0gdyqt.ps1' -Force\n` +
        '> Write-Output -- "Go is a programming language" | go run wordfreq.go\n' +
        'Топ-10 частых слов:\n' +
        '1. and 3\n\nexit_code=0',
      ok: true
    })
    const label = formatActivityLabel(a)
    assert.doesNotMatch(label, /afk-run-/i)
    assert.match(label, /go run wordfreq/)
    assert.match(label, /Топ-10/)
  })

  it('formats Editing basename', () => {
    const a = buildActivityFromTool({
      name: 'apply_patch',
      args: { relative_path: 'src/ChatPanel.tsx' },
      streaming: true
    })
    assert.equal(a.verb, 'Editing')
    assert.equal(formatActivityLabel(a), 'Editing ChatPanel.tsx')
  })

  it('labels EMPTY_WRITE as Write failed not Edited', () => {
    const a = buildActivityFromTool({
      name: 'write_file',
      args: { relative_path: 'src/App.css' },
      ok: false,
      resultContent:
        'EMPTY_WRITE: relative_path="src/App.css" is not a write. Put the FULL file in the content argument.'
    })
    assert.equal(a.verb, 'Write failed')
    assert.equal(a.status, 'error')
    assert.match(formatActivityLabel(a), /Write failed/)
    assert.doesNotMatch(formatActivityLabel(a), /^Edited /)
  })

  it('formats Planning next moves', () => {
    const a = buildActivityFromTool({ name: '__planning__', streaming: true })
    assert.equal(formatActivityLabel(a), 'Planning next moves')
  })

  it('formats Checked to-do list', () => {
    const a = buildActivityFromTool({ name: '__todo__', ok: true })
    assert.equal(formatActivityLabel(a), 'Checked to-do list')
  })

  it('formats web_search with hit count and query', () => {
    const a = buildActivityFromTool({
      name: 'web_search',
      args: { query: 'AbortSignal.timeout' },
      resultContent:
        'Web search: AbortSignal.timeout (via duckduckgo)\n\n1. MDN\n   https://a\n\n2. Spec\n   https://b',
      ok: true
    })
    assert.equal(a.kind, 'web')
    assert.equal(a.matchCount, 2)
    assert.equal(a.status, 'done')
    assert.match(
      formatActivityLabel(a),
      /web_search · ok \(internet search\) · 2 sites · AbortSignal\.timeout/
    )
  })

  it('formats web_search failure', () => {
    const a = buildActivityFromTool({
      name: 'web_search',
      args: { query: 'zzz' },
      resultContent: 'No web results for: zzz',
      ok: false
    })
    assert.equal(a.status, 'error')
    assert.match(formatActivityLabel(a), /web_search · failed · zzz/)
  })

  it('formats web_search skip when offline', () => {
    const a = buildActivityFromTool({
      name: 'web_search',
      args: { query: 'AbortSignal' },
      resultContent:
        'WEB_SEARCH_SKIPPED: no internet / network unreachable. Query was: AbortSignal. Continue without web results.',
      ok: true
    })
    assert.equal(a.status, 'skipped')
    assert.match(
      formatActivityLabel(a),
      /web_search · skip \(no internet\) · AbortSignal/
    )
  })

  it('aggregates consecutive searches', () => {
    const items = [1, 2, 3].map((i) => ({
      id: `s${i}`,
      activity: buildActivityFromTool({
        name: 'search_codebase',
        args: { query: `q${i}` },
        ok: true
      })
    }))
    const groups = aggregateActivityMessages(items)
    assert.equal(groups.length, 1)
    assert.equal(groups[0]!.type, 'group')
    if (groups[0]!.type === 'group') {
      assert.equal(groups[0].group.summary, '3 searches')
    }
  })

  it('sanitizes persisted activity', () => {
    const a = sanitizeActivity({
      kind: 'read',
      verb: 'Read',
      status: 'done',
      path: 'x.ts',
      lineStart: 1,
      lineEnd: 10
    })
    assert.ok(a)
    assert.equal(a!.path, 'x.ts')
    assert.equal(sanitizeActivity({ kind: 'nope' }), undefined)
  })
})
