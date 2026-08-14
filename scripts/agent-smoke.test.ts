import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyToolToChecklist,
  buildChecklistFromHistory,
  emptyChecklist,
  formatChecklist,
  formatChecklistUiContent,
  parseChecklistUiContent,
  checklistHasItems,
  fingerprintToolCall,
  looksLikeToolMarkupLeak,
  coerceToolRelativePath,
  inferWritePathFromContent,
  resolveWriteFilePath,
  normalizeApiMessages,
  parseComposerMentions,
  parseThinkBlocks,
  promoteThinkOnlyAnswer,
  mergeChecklistIntoSystem,
  formatNowForAgent,
  parsePlanBlock,
  hasThinkBlock,
  stripPlanBlock,
  advanceTodosOnTool,
  formatTodoUiContent,
  parseTodoUiContent,
  thinkBodyLooksLikeCodeDump,
  thinkLooksLikeChecklist,
  sanitizeThinkProse,
  wrapThinkForUi,
  formatLiveThinkContent,
  packReadFileForAgent,
  contentLooksStructurallyComplete,
  parseReadFileMeta,
  type ApiMessage
} from '../src/renderer/src/agent/agentPure'
import { AgentToolRegistry } from '../src/main/agent/AgentToolRegistry'
import {
  CHAT_MAX_CONTENT_CHARS,
  sanitizePersistedMessages,
  THREAD_SUMMARY_MSG_ID,
  type PersistedChatMessage
} from '../src/shared/chats'
import { loadProjectRules } from '../src/main/context/ProjectRules'
import {
  AGENT_PLAN_MSG_ID,
  formatPlanExecutePrompt,
  getPlanStatus,
  setPlanStatus,
  stripPlanStatus
} from '../src/renderer/src/agent/runAgentTurn'

describe('looksLikeToolMarkupLeak', () => {
  it('detects channel / tool_call leaks', () => {
    assert.equal(
      looksLikeToolMarkupLeak('}<tool_call>|<tool_call>call:write_file{content:'),
      true
    )
    assert.equal(
      looksLikeToolMarkupLeak('[:tool call]><[:channel:call:write_file:content:'),
      true
    )
    assert.equal(looksLikeToolMarkupLeak('const x = 1\nconsole.log(x)\n'), false)
  })

  it('fingerprints identical mkdir / writes', () => {
    const a = fingerprintToolCall('create_directory', {
      relative_path: 'afkllm-landing'
    })
    const b = fingerprintToolCall('create_directory', {
      relative_path: 'afkllm-landing'
    })
    assert.equal(a, b)
    const w1 = fingerprintToolCall('write_file', {
      relative_path: 'a.js',
      content: 'x'
    })
    const w2 = fingerprintToolCall('write_file', {
      relative_path: 'a.js',
      content: 'y'
    })
    assert.notEqual(w1, w2)
  })

  it('coerces path aliases to relative_path', () => {
    assert.equal(coerceToolRelativePath({ path: 'index.html' }), 'index.html')
    assert.equal(coerceToolRelativePath({ file: 'styles.css' }), 'styles.css')
    assert.equal(coerceToolRelativePath({ filename: 'app.js' }), 'app.js')
    assert.equal(coerceToolRelativePath({ content: 'hi' }), null)
    assert.equal(
      coerceToolRelativePath({ path: 'D:\\proj\\index.html' }),
      'D:/proj/index.html'
    )
    assert.equal(coerceToolRelativePath({ path: './styles.css' }), './styles.css')
  })

  it('infers write path from content', () => {
    assert.equal(
      inferWritePathFromContent('<!DOCTYPE html><html><body></body></html>'),
      'index.html'
    )
    assert.equal(
      inferWritePathFromContent('body { color: #222; }\n.main { margin: 0; }'),
      'styles.css'
    )
    assert.equal(
      inferWritePathFromContent(
        'document.querySelector(".nav").addEventListener("click", () => {})'
      ),
      'app.js'
    )
    assert.equal(
      resolveWriteFilePath({
        content: '<!DOCTYPE html>\n<html lang="en"></html>'
      }),
      'index.html'
    )
  })
})

describe('normalizeApiMessages', () => {
  it('merges consecutive user messages', () => {
    const out = normalizeApiMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ])
    assert.equal(out.length, 2)
    assert.equal(out[0]!.role, 'system')
    assert.equal(out[1]!.role, 'user')
    assert.match(out[1]!.content ?? '', /a[\s\S]*b/)
  })

  it('folds orphan tool into user (no user after bare tool crash)', () => {
    const out = normalizeApiMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      { role: 'tool', content: 'orphan', tool_call_id: 't1' }
    ])
    const roles = out.map((m) => m.role)
    assert.ok(!roles.includes('tool') || out.some((m) => m.role === 'user'))
    const last = out[out.length - 1]!
    assert.equal(last.role, 'user')
    assert.match(last.content ?? '', /orphan/)
  })

  it('keeps tool after assistant tool_calls', () => {
    const out = normalizeApiMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' }
    ] as ApiMessage[])
    const roles = out.map((m) => m.role)
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool'])
  })

  it('inserts user after system before assistant', () => {
    const out = normalizeApiMessages([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'hi' }
    ])
    assert.equal(out[0]!.role, 'system')
    assert.equal(out[1]!.role, 'user')
    assert.equal(out[2]!.role, 'assistant')
  })

  it('never places user directly after tool (Devstral Jinja)', () => {
    const out = normalizeApiMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'write_file', arguments: '{}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: 'verify missing files' }
    ] as ApiMessage[])
    const roles = out.map((m) => m.role)
    assert.deepEqual(roles, [
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user'
    ])
    for (let i = 1; i < roles.length; i++) {
      if (roles[i] === 'user') {
        assert.notEqual(roles[i - 1], 'tool')
      }
    }
  })

  it('allows assistant text after tool results', () => {
    const out = normalizeApiMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'assistant', content: 'Task completed' }
    ] as ApiMessage[])
    const roles = out.map((m) => m.role)
    assert.deepEqual(roles, [
      'system',
      'user',
      'assistant',
      'tool',
      'assistant'
    ])
  })
})

describe('checklist', () => {
  it('marks write_file success as done', () => {
    const cl = emptyChecklist()
    applyToolToChecklist(
      cl,
      'write_file',
      { relative_path: 'a/index.html' },
      { ok: true, content: 'wrote' }
    )
    assert.deepEqual(cl.done, ['a/index.html'])
    assert.equal(cl.incomplete.length, 0)
  })

  it('marks INCOMPLETE_WRITE as incomplete', () => {
    const cl = emptyChecklist()
    applyToolToChecklist(
      cl,
      'write_file',
      { relative_path: 'index.html' },
      { ok: false, content: 'INCOMPLETE_WRITE: saved partial', error: 'incomplete' }
    )
    assert.deepEqual(cl.incomplete, ['index.html'])
    assert.ok(!cl.done.includes('index.html'))
  })

  it('marks FILE_EXISTS as failed', () => {
    const cl = emptyChecklist()
    applyToolToChecklist(
      cl,
      'write_file',
      { relative_path: 'x.ts' },
      { ok: false, content: 'FILE_EXISTS', error: 'exists' }
    )
    assert.ok(cl.failed.some((f) => f.startsWith('x.ts')))
  })

  it('rebuilds from history tool bubbles', () => {
    const cl = buildChecklistFromHistory([
      {
        id: '1',
        role: 'assistant',
        content: '✓ write_file · a.py',
        toolName: 'write_file',
        filePath: 'a.py'
      },
      {
        id: '2',
        role: 'assistant',
        content: '⚠ incomplete write_file · b.py — append next',
        toolName: 'write_file',
        filePath: 'b.py'
      }
    ])
    assert.deepEqual(cl.done, ['a.py'])
    assert.deepEqual(cl.incomplete, ['b.py'])
    assert.match(formatChecklist(cl), /Agent checklist/)
  })
})

describe('sanitizePersistedMessages', () => {
  it('returns welcome when empty', () => {
    const out = sanitizePersistedMessages([])
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'welcome')
  })

  it('keeps agent-checklist bubble', () => {
    const out = sanitizePersistedMessages([
      { id: 'welcome', role: 'assistant', content: 'hi' },
      {
        id: 'agent-checklist',
        role: 'assistant',
        content: JSON.stringify({
          kind: 'agent-checklist',
          done: ['index.html'],
          incomplete: [],
          failed: [],
          shells: []
        })
      },
      { id: 'u1', role: 'user', content: 'do it' }
    ])
    assert.ok(out.some((m) => m.id === 'agent-checklist'))
    assert.ok(out.some((m) => m.id === 'u1'))
  })

  it('truncates huge content', () => {
    const big = 'x'.repeat(CHAT_MAX_CONTENT_CHARS + 500)
    const out = sanitizePersistedMessages([
      { id: '1', role: 'user', content: big } as PersistedChatMessage
    ])
    assert.equal(out[0]!.content.length, CHAT_MAX_CONTENT_CHARS)
  })

  it('keeps generation stats on messages', () => {
    const out = sanitizePersistedMessages([
      { id: 'welcome', role: 'assistant', content: 'hi' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'done',
        stats: { tps: 27.4, completionTokens: 16, genMs: 592, turnElapsedMs: 2500 }
      }
    ])
    const a = out.find((m) => m.id === 'a1')
    assert.ok(a?.stats)
    assert.equal(a!.stats!.tps, 27.4)
    assert.equal(a!.stats!.completionTokens, 16)
    assert.equal(a!.stats!.turnElapsedMs, 2500)
  })

  it('keeps thread-summary after welcome', () => {
    const out = sanitizePersistedMessages([
      { id: 'welcome', role: 'assistant', content: 'hi' },
      { id: 'u1', role: 'user', content: 'old' },
      {
        id: THREAD_SUMMARY_MSG_ID,
        role: 'assistant',
        content: '## Thread memory\nGoals: ship P12'
      },
      { id: 'u2', role: 'user', content: 'continue' }
    ])
    const ids = out.map((m) => m.id)
    assert.ok(ids.includes(THREAD_SUMMARY_MSG_ID))
    assert.equal(ids.indexOf(THREAD_SUMMARY_MSG_ID), ids.indexOf('welcome') + 1)
  })

  it('keeps agent-plan and agent-checklist bubbles', () => {
    const out = sanitizePersistedMessages([
      { id: 'welcome', role: 'assistant', content: 'hi' },
      {
        id: AGENT_PLAN_MSG_ID,
        role: 'assistant',
        content: '1. Do thing\n\n_Status: pending_'
      },
      {
        id: 'agent-checklist',
        role: 'assistant',
        content: JSON.stringify({
          kind: 'agent-checklist',
          done: [],
          incomplete: ['a.ts'],
          failed: [],
          shells: []
        })
      }
    ])
    assert.ok(out.some((m) => m.id === AGENT_PLAN_MSG_ID))
    assert.ok(out.some((m) => m.id === 'agent-checklist'))
  })
})

describe('plan helpers', () => {
  it('set/get/strip plan status and format execute prompt', () => {
    const raw = '## Plan\n1. Add button\n2. Wire click'
    const pending = setPlanStatus(raw, 'pending')
    assert.equal(getPlanStatus(pending), 'pending')
    assert.equal(stripPlanStatus(pending), raw)
    const exec = formatPlanExecutePrompt(pending)
    assert.match(exec, /Approved plan/)
    assert.match(exec, /Add button/)
    assert.ok(!/_Status:/i.test(exec))
  })
})

describe('loadProjectRules', () => {
  it('loads .afkllm/rules.md and rules/*.md', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-rules-'))
    try {
      await fs.mkdir(path.join(root, '.afkllm', 'rules'), { recursive: true })
      await fs.writeFile(
        path.join(root, '.afkllm', 'rules.md'),
        'Always use TypeScript.',
        'utf8'
      )
      await fs.writeFile(
        path.join(root, '.afkllm', 'rules', 'style.md'),
        'Prefer const over let.',
        'utf8'
      )
      const snap = await loadProjectRules(root)
      assert.match(snap.text, /Project rules/)
      assert.match(snap.text, /TypeScript/)
      assert.match(snap.text, /Prefer const/)
      assert.ok(snap.files.length >= 2)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('returns empty when no .afkllm rules', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afk-norules-'))
    try {
      const snap = await loadProjectRules(root)
      assert.equal(snap.text, '')
      assert.deepEqual(snap.files, [])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('parseComposerMentions', () => {
  it('strips @file @selection @codebase flags', () => {
    const m = parseComposerMentions('fix login @file @selection please @codebase')
    assert.equal(m.file, true)
    assert.equal(m.selection, true)
    assert.equal(m.codebase, true)
    assert.match(m.cleanText, /fix login/)
    assert.ok(!/@file|@selection|@codebase/i.test(m.cleanText))
  })

  it('returns false flags when absent', () => {
    const m = parseComposerMentions('hello world')
    assert.equal(m.file, false)
    assert.equal(m.selection, false)
    assert.equal(m.codebase, false)
    assert.equal(m.cleanText, 'hello world')
  })
})

describe('parseThinkBlocks', () => {
  it('splits think and text parts', () => {
    const parts = parseThinkBlocks(
      '<think>\nGoal: fix build\nOption A vs B → pick A\n</think>\nWill patch main.ts'
    )
    assert.equal(parts.length, 2)
    assert.equal(parts[0]!.kind, 'think')
    assert.match(parts[0]!.text, /Goal: fix build/)
    assert.equal(parts[1]!.kind, 'text')
    assert.match(parts[1]!.text, /Will patch/)
  })

  it('supports thinking tag alias', () => {
    const parts = parseThinkBlocks('<thinking>root cause: missing import</thinking>ok')
    assert.equal(parts[0]!.kind, 'think')
    assert.equal(parts[1]!.kind, 'text')
  })

  it('returns plain text when no tags', () => {
    const parts = parseThinkBlocks('just answer')
    assert.deepEqual(parts, [{ kind: 'text', text: 'just answer' }])
  })

  it('treats unclosed think as think, not visible text', () => {
    const parts = parseThinkBlocks('<think>\nGoal: wire hero.png\nthen patch HTML')
    assert.equal(parts.length, 1)
    assert.equal(parts[0]!.kind, 'think')
    assert.match(parts[0]!.text, /hero\.png/)
    const promoted = promoteThinkOnlyAnswer('<think>\nThe page is a landing hero.')
    assert.match(promoted, /landing hero/)
    assert.ok(!/<think>/i.test(promoted))
  })
})

describe('mergeChecklistIntoSystem', () => {
  it('keeps compact memory when injecting a fresh checklist', () => {
    const sys =
      'You are AFKLLM.\n\n[Context compacted due to context-window pressure]\n' +
      'Already wrote index.html and generated/hero.png.\n' +
      '\n\n[Agent checklist]\n✓ done: old.html\n[/Agent checklist]'
    const next = mergeChecklistIntoSystem(
      sys,
      '\n\n[Agent checklist]\n✓ done: index.html\n[/Agent checklist]'
    )
    assert.match(next, /generated\/hero\.png/)
    assert.match(next, /index\.html/)
    assert.ok(!/old\.html/.test(next))
  })
})

describe('checklist UI payload', () => {
  it('round-trips checklist JSON for the chat bubble', () => {
    const cl = {
      done: ['index.html'],
      incomplete: ['styles.css'],
      failed: [] as string[],
      shells: ['npm run build']
    }
    assert.equal(checklistHasItems(cl), true)
    const raw = formatChecklistUiContent(cl)
    const parsed = parseChecklistUiContent(raw)
    assert.deepEqual(parsed, cl)
  })

  it('parseThinkBlocks keeps think foldable even when promote unwraps for API', () => {
    const raw = '<think>\nGoal: landing\n</think>'
    const parts = parseThinkBlocks(raw)
    assert.equal(parts[0]!.kind, 'think')
    const promoted = promoteThinkOnlyAnswer(raw)
    assert.match(promoted, /Goal: landing/)
    assert.ok(!/<think>/i.test(promoted))
  })
})

describe('agent todo plan', () => {
  it('parses <plan> into steps and advances on tools', () => {
    assert.equal(hasThinkBlock('<think>x</think>'), true)
    assert.equal(hasThinkBlock('nope'), false)
    const steps = parsePlanBlock(
      '<think>multi</think>\n<plan>\n- [ ] Write index.html\n- [ ] Verify in browser\n</plan>'
    )
    assert.equal(steps?.length, 2)
    assert.equal(steps![0]!.status, 'in_progress')
    assert.equal(steps![1]!.status, 'pending')
    const advanced = advanceTodosOnTool(steps!, 'write_file', true)
    assert.equal(advanced[0]!.status, 'done')
    assert.equal(advanced[1]!.status, 'in_progress')
    const ui = formatTodoUiContent(advanced)
    assert.deepEqual(parseTodoUiContent(ui)?.map((s) => s.text), [
      'Write index.html',
      'Verify in browser'
    ])
    assert.equal(stripPlanBlock('hi\n<plan>\n- a\n</plan>\nbye'), 'hi\n\nbye')
  })

  it('splits compound landing steps and rejects code dumps in think', () => {
    const steps = parsePlanBlock(
      '<plan>\n- [ ] Написать index.html со всеми секциями (navbar, hero, features, how it works, social proof, FAQ, footer)\n- [ ] Открыть в браузере\n</plan>'
    )
    assert.ok((steps?.length ?? 0) >= 5)
    assert.equal(
      thinkBodyLooksLikeCodeDump(
        '<think>\n<!DOCTYPE html><html><style>:root{}</style>\n</think>'
      ),
      true
    )
    assert.equal(thinkBodyLooksLikeCodeDump('<think>\nGoal: landing. Next: write_file.\n</think>'), false)
    const mega = parsePlanBlock(
      '<plan>\n- [ ] Write index.html — полный лендинг Northline с Bootstrap 5, встроенным CSS, SVG-иллюстрациями и семантической разметкой.\n- [ ] Открыть в браузере\n</plan>'
    )
    assert.ok((mega?.length ?? 0) >= 6)
    assert.equal(sanitizeThinkProse('<think>\n<!DOCTYPE html><html></html>\n</think>'), '')
    assert.match(wrapThinkForUi('<!DOCTYPE html>'), /…/)
    assert.match(wrapThinkForUi('Цель: лендинг. Дальше write_file.'), /Цель: лендинг/)
    assert.equal(
      sanitizeThinkProse(
        '<think>\n1. Write index.html\n2. Open in browser\n3. Summarize\n</think>'
      ),
      ''
    )
    assert.equal(thinkLooksLikeChecklist('1. Write\n2. Open\n3. Summarize'), true)
  })

  it('streams live think prose without waiting for sanitize', () => {
    const live = formatLiveThinkContent('<think>\nЦель: лендинг Northline без AI-градиентов. Дальше разложу секции')
    assert.match(live, /Цель: лендинг Northline/)
    assert.match(live, /<\s*think\s*>/i)
    // Partial stream must stay visible (sanitize would often empty incomplete dumps)
    const partial = formatLiveThinkContent('Сначала пойму аудиторию B2B, потом hero')
    assert.match(partial, /аудиторию B2B/)
  })
})

describe('packReadFileForAgent', () => {
  it('includes head, tail, total_lines and FILE_COMPLETE for long HTML', () => {
    const lines = Array.from({ length: 400 }, (_, i) => {
      if (i === 0) return '<!DOCTYPE html><html><body>'
      if (i === 398) return '</body>'
      if (i === 399) return '</html>'
      return `<!-- section line ${i + 1} -->`
    })
    const raw = lines.join('\n')
    const packed = packReadFileForAgent(raw, { headLines: 80, tailLines: 40, maxChars: 6000 })
    assert.match(packed, /total_lines=400/)
    assert.match(packed, /truncated=true/)
    assert.match(packed, /FILE_COMPLETE/)
    assert.match(packed, /lines 1-80/)
    assert.match(packed, /<\/html>/)
    assert.match(packed, /Do NOT rewrite/)
    const meta = parseReadFileMeta(packed)
    assert.equal(meta.totalLines, 400)
    assert.equal(meta.truncated, true)
    assert.equal(contentLooksStructurallyComplete(raw), true)
  })
})

describe('formatNowForAgent', () => {
  it('includes weekday, ISO date, time, and timezone', () => {
    const fixed = new Date('2026-08-04T10:15:30+03:00')
    const s = formatNowForAgent(fixed)
    assert.match(s, /Current local datetime/)
    assert.match(s, /2026-08-04/)
    assert.match(s, /\d{2}:\d{2}:\d{2}/)
    assert.match(s, /UTC[+-]\d{2}:\d{2}/)
  })
})

describe('AgentToolRegistry edit review', () => {
  it('reject restores previous content; accept clears pending', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-edit-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'note.txt'
      await fs.writeFile(path.join(root, rel), 'v1', 'utf8')

      const wrote = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: rel, content: 'v2', overwrite: true }
      })
      assert.equal(wrote.ok, true)
      assert.equal(wrote.editReview?.status, 'pending')
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), 'v2')

      const rejected = await reg.rejectEdit(rel)
      assert.equal(rejected.ok, true)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), 'v1')

      const wrote2 = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: { relative_path: rel, content: 'v3', overwrite: true }
      })
      assert.equal(wrote2.ok, true)
      const accepted = reg.acceptEdit(rel)
      assert.equal(accepted.ok, true)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), 'v3')
      const rejectAgain = await reg.rejectEdit(rel)
      assert.equal(rejectAgain.ok, false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('reject deletes newly created file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-edit-new-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'brand-new.ts'
      const wrote = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: rel, content: 'export const x = 1\n' }
      })
      assert.equal(wrote.ok, true)
      assert.ok(wrote.editReview)
      await reg.rejectEdit(rel)
      await assert.rejects(() => fs.access(path.join(root, rel)))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('FILE_EXISTS on small files tells the model to overwrite=true', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-exists-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'index.html'
      await fs.writeFile(
        path.join(root, rel),
        '<!DOCTYPE html><html><body><h1>landing</h1><p>hello world page</p></body></html>\n',
        'utf8'
      )
      const blocked = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: rel, content: '<html><body>bye</body></html>\n' }
      })
      assert.equal(blocked.ok, false)
      assert.match(blocked.error ?? '', /overwrite=true/)
      const ok = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: '<html><body>bye</body></html>\n',
          overwrite: true
        }
      })
      assert.equal(ok.ok, true)
      assert.match(await fs.readFile(path.join(root, rel), 'utf8'), /bye/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rename + searchFiles', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-ws-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      await reg.createFile('src/hello.ts', 'const AFKLLM_MARKER = 1\n')
      const renamed = await reg.renamePath('src/hello.ts', 'src/hi.ts')
      assert.equal(renamed.ok, true)
      const found = await reg.searchFiles('AFKLLM_MARKER')
      assert.equal(found.ok, true)
      assert.ok(found.matches.some((m) => m.path === 'src/hi.ts'))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('getPendingDiff returns before/after', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-diff-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      await fs.writeFile(path.join(root, 'a.ts'), 'old\n', 'utf8')
      await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: 'a.ts', content: 'new\n', overwrite: true }
      })
      const diff = await reg.getPendingDiff('a.ts')
      assert.equal(diff.ok, true)
      assert.equal(diff.previous, 'old\n')
      assert.equal(diff.current, 'new\n')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
