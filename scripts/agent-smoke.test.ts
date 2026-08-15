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
  liveThinkProse,
  packReadFileForAgent,
  contentLooksStructurallyComplete,
  parseReadFileMeta,
  readFileRangeCacheKey,
  resolveExhaustedReadBudget,
  reconcileTodosWithContent,
  progressTodosFromContent,
  displayThinkProse,
  extractThinkInner,
  pendingPlanWork,
  isBrowserPlanStep,
  settlePlanAfterWork,
  isJunkPlanStep,
  isSoftLayoutPlanStep,
  coerceProductPlan,
  looksLikeToolOrientedPlan,
  isToolOrientedPlanStep,
  isMetaOrSummaryPlanStep,
  isRedundantPlanCompleteProse,
  isFalseSuccessProse,
  isAgentChatNoise,
  detectProseStutter,
  dedupeStutteringProse,
  looksLikeChatQa,
  looksLikeFileEditRequest,
  looksLikeSurgicalFollowUp,
  looksLikeI18nFollowUp,
  looksLikeThemeToggleRequest,
  looksLikeExplicitRewrite,
  shouldBlockSurgicalOverwrite,
  isLandingJsPath,
  isSourcePath,
  filterPlanToCurrentRequest,
  parseGlobalRenameIntent,
  wantsOpenAfterEdit,
  replaceAllCi,
  countOccurrencesCi,
  isFullRewriteFallbackPlanStep,
  evaluateAcceptanceGate,
  stripCodeLeakFromThink,
  extractAssistantHtmlDump,
  looksLikeAssistantHtmlDump,
  isEllipsisOnly,
  type ApiMessage
} from '../src/renderer/src/agent/agentPure'
import {
  estimateContextUsage,
  estimateLocalContextSum
} from '../src/renderer/src/agent/contextUsage'
import { AgentToolRegistry } from '../src/main/agent/AgentToolRegistry'
import { looksLikeShellFileMutation, powershellOperatorMisuse } from '../src/shared/shellErrors'
import {
  CHAT_MAX_CONTENT_CHARS,
  deriveChatTitle,
  extractBrandFromPrompt,
  isAwkwardChatTitle,
  isVisibleChatMessageId,
  pickChatTitle,
  sanitizeModelChatTitle,
  sanitizePersistedMessages,
  THREAD_SUMMARY_MSG_ID,
  type PersistedChatMessage
} from '../src/shared/chats'
import { applySearchReplaceBlocks } from '../src/shared/fastApply'
import { hasDisplayableStats } from '../src/renderer/src/components/MessageStatsInfo'
import { loadProjectRules } from '../src/main/context/ProjectRules'
import {
  AGENT_PLAN_MSG_ID,
  formatPlanExecutePrompt,
  getPlanStatus,
  setPlanStatus,
  stripPlanStatus,
  shouldSkipThinkPlanCeremony,
  looksLikeOpenLandingOnly
} from '../src/renderer/src/agent/runAgentTurn'
import {
  maybeRecordToolEvidence,
  laterSuccessAfterFail,
  type StepEvidence
} from '../src/renderer/src/agent/loop/evidence'
import { honestClosingNote } from '../src/renderer/src/agent/loop/report'
import {
  formatI18nSanityHint,
  htmlJsI18nMismatch,
  htmlI18nKeysMissingFromJs,
  jsI18nDictLooksBroken
} from '../src/renderer/src/agent/loop/i18nSanity'
import { formatEditSanityHint, navLooksUnstyled, htmlJsHasThemeControl } from '../src/renderer/src/agent/loop/editSanity'
import { formatSurgicalFollowUpHint, isHtmlOnlyStacks } from '../src/renderer/src/agent/loop/prompts'
import { truncationGuardMessage, isWholeFileSearchBlock } from '../src/shared/writeThresholds'
import { evidenceSupportsStep, evidenceFromTool, recordEvidence } from '../src/renderer/src/agent/loop/evidence'

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

  it('fingerprints open-html shells as one action regardless of cwd/path', () => {
    const a = fingerprintToolCall('execute_terminal_command', {
      command: 'Start-Process "index.html" -WorkingDirectory "C:\\Users\\afkllm\\Desktop\\Northline"'
    })
    const b = fingerprintToolCall('execute_terminal_command', {
      command: 'Start-Process "index.html" -WorkingDirectory "D:\\testMode"'
    })
    const c = fingerprintToolCall('execute_terminal_command', {
      command: 'Start-Process (Resolve-Path .\\index.html)'
    })
    const d = fingerprintToolCall('execute_terminal_command', {
      command: "Start-Process 'index.html'"
    })
    assert.equal(a, b)
    assert.equal(b, c)
    assert.equal(c, d)
    assert.equal(a, 'execute_terminal_command|open_html_preview')
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

  it('infers write path only for full HTML documents', () => {
    assert.equal(
      inferWritePathFromContent('<!DOCTYPE html><html><body></body></html>'),
      'index.html'
    )
    assert.equal(
      inferWritePathFromContent('body { color: #222; }\n.main { margin: 0; }'),
      null
    )
    assert.equal(
      inferWritePathFromContent(
        'document.querySelector(".nav").addEventListener("click", () => {})'
      ),
      null
    )
    assert.equal(inferWritePathFromContent('{"ok": true}'), null)
    assert.equal(inferWritePathFromContent('# Title\n\nHello'), null)
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
  it('rejects tool-name plans; does not invent a landing template', () => {
    assert.equal(
      isToolOrientedPlanStep('execute_terminal_command для проверки синтаксиса HTML'),
      true
    )
    assert.equal(isToolOrientedPlanStep('Закрыть'), true)
    const raw = parsePlanBlock(
      '<plan>\n' +
        '- execute_terminal_command для проверки синтаксиса HTML\n' +
        '- Start-Process для открытия index.html в AFKLLM Browser\n' +
        '- Визуальная проверка верстки и исправление ошибок\n' +
        '- Закрыть\n' +
        '</plan>'
    )
    assert.equal(looksLikeToolOrientedPlan(raw ?? []), false)
    const coerced = coerceProductPlan(raw, {
      userText:
        'Сделай одностраничный лендинг Bootstrap 5: Navbar, Hero, Features, FAQ, Footer'
    })
    assert.ok(!coerced.some((s) => isToolOrientedPlanStep(s.text)))
    assert.ok(
      !coerced.some((s) => /Navbar|Hero|Features|Footer/i.test(s.text)),
      'must not invent a landing template'
    )
    assert.ok(coerced.some((s) => /визуальн|вёрст|верст/i.test(s.text)))
  })

  it('keeps model plan rows like verify and user-summary', () => {
    const raw = parsePlanBlock(
      '<plan>\n- Написать index.html\n- Проверить вёрстку\n- Сообщить пользователю о результате\n</plan>'
    )
    const coerced = coerceProductPlan(raw, { userText: 'сделай лендинг' })
    assert.ok(coerced.some((s) => /Проверить/i.test(s.text)))
    assert.ok(coerced.some((s) => /Сообщить пользователю/i.test(s.text)))
  })

  it('surgical FAQ fix plan keeps the model section rows', () => {
    const raw = parsePlanBlock(
      '<plan>\n' +
        '- Найти FAQ в index.html\n' +
        '- Заменить белые стили на серые\n' +
        '- Секция: Navbar\n' +
        '- Секция: Hero\n' +
        '- Секция: Features\n' +
        '- Секция: Footer\n' +
        '- Открыть в браузере\n' +
        '</plan>'
    )
    const user =
      'В FAQ блок «Какие модели» не в тему сайта — белая тема, нужен такой же серый'
    const coerced = coerceProductPlan(raw, { userText: user, surgical: true })
    assert.ok(coerced.some((s) => /FAQ|стил|серы|бел/i.test(s.text)))
    assert.ok(coerced.some((s) => /Navbar/i.test(s.text)))
    assert.ok(coerced.some((s) => /Hero/i.test(s.text)))
    assert.ok(!coerced.some((s) => /toggle|переключ/i.test(s.text)))
  })

  it('garbage surgical plan returns empty instead of a stock template', () => {
    const raw = parsePlanBlock(
      '<plan>\n' +
        '- *План хирургического вмешательства:**\n' +
        "- Секция: 'navbar'\n" +
        "- Секция: 'card'\n" +
        "- Секция: 'btn-primary'\n" +
        "- Секция: 'accordion-button'\n" +
        "- Секция: 'badge'\n" +
        '</plan>'
    )
    const user = 'текст плохо читаемый, сделай его белым если страница тёмная'
    const coerced = coerceProductPlan(raw, { userText: user, surgical: true })
    assert.equal(coerced.length, 0)
  })

  it('coerceProductPlan does not auto-surgical from keywords without opts.surgical', () => {
    const raw = parsePlanBlock(
      '<plan>\n- Найти FAQ\n- Поправить цвет текста\n- Открыть в браузере\n</plan>'
    )
    const user = 'текст плохо читаемый, сделай его белым если страница тёмная'
    const coerced = coerceProductPlan(raw, { userText: user })
    assert.ok(coerced.some((s) => /FAQ|цвет|текст|стил/i.test(s.text)))
    assert.ok(!coerced.some((s) => /переключ|toggle/i.test(s.text)))
  })

  it('strips full-rewrite fallback plan steps', () => {
    assert.equal(
      isFullRewriteFallbackPlanStep(
        'Если патч не сработал — переписать файл целиком; иначе закрыть.'
      ),
      true
    )
    assert.equal(isJunkPlanStep('Если патч не сработал — переписать файл целиком'), true)
    const raw = parsePlanBlock(
      '<plan>\n- Поправить FAQ на тёмный\n- Если патч не сработал — переписать файл целиком; иначе закрыть.\n- Открыть в браузере\n</plan>'
    )
    const coerced = coerceProductPlan(raw, {
      userText: 'раздел FAQ сайта должен быть темным',
      surgical: true
    })
    assert.ok(!coerced.some((s) => /переписать\s+файл|целик|если\s+патч/i.test(s.text)))
    assert.ok(coerced.some((s) => /FAQ|тёмн|темн|стил|разметк/i.test(s.text)))
  })

  it('evaluateAcceptanceGate rejects done when any edit failed', () => {
    const gate = evaluateAcceptanceGate({
      finalText: 'Сделано. FAQ тёмный.',
      userWantsNodeTest: false,
      userWantsWebSearch: false,
      userWantsCli: false,
      lastNodeTestOk: null,
      usedWebSearch: false,
      ranCliSmoke: false,
      incompleteCount: 0,
      failedCount: 0,
      completedTools: 3,
      mutatingEditOk: true,
      mutatingEditFailed: true
    })
    assert.equal(gate.claimsDone, true)
    assert.equal(gate.looksPrematureDone, true)
    assert.ok(gate.hardMissing.length > 0)
  })

  it('shouldSkipThinkPlanCeremony only for micro confirms with prior work', () => {
    const landing =
      'Сделай качественный одностраничный лендинг на Bootstrap 5 с Navbar Hero FAQ Footer'
    assert.equal(shouldSkipThinkPlanCeremony(landing, []), false)
    assert.equal(
      shouldSkipThinkPlanCeremony('сделай текст белым', []),
      false
    )
    assert.equal(
      shouldSkipThinkPlanCeremony('сделай текст белым', [
        { id: 'agent-todo-1', role: 'assistant', content: '{}' }
      ]),
      false,
      'feature follow-ups must still think'
    )
    assert.equal(
      shouldSkipThinkPlanCeremony('сделай переключатель темы темная/светлая', [
        { id: 'agent-todo-1', role: 'assistant', content: '{}' }
      ]),
      false
    )
    assert.equal(
      shouldSkipThinkPlanCeremony('ок', [
        { id: 'agent-todo-1', role: 'assistant', content: '{}' }
      ]),
      true
    )
    assert.equal(
      shouldSkipThinkPlanCeremony('продолжи', [
        {
          id: 't1',
          role: 'assistant',
          content: 'wrote',
          toolName: 'write_file'
        }
      ]),
      true
    )
  })

  it('looksLikeOpenLandingOnly matches Cyrillic «открой лендинг» (no \\b)', () => {
    assert.equal(looksLikeOpenLandingOnly('открой лендинг'), true)
    assert.equal(looksLikeOpenLandingOnly('Открой лендинг'), true)
    assert.equal(looksLikeOpenLandingOnly('open index.html'), true)
    assert.equal(looksLikeOpenLandingOnly('сделай лендинг с нуля'), false)
    assert.equal(looksLikeOpenLandingOnly('открой'), false)
    assert.equal(looksLikeOpenLandingOnly('поменяй названия моделей'), false)
    assert.equal(looksLikeOpenLandingOnly('открой лендинг и поменяй цвет'), false)
    assert.equal(looksLikeOpenLandingOnly('исправь FAQ overflow'), false)
    assert.equal(
      looksLikeOpenLandingOnly(
        'везде измени название с NorthLine на AFKLLM, затем открой его'
      ),
      false
    )
  })

  it('parseGlobalRenameIntent + false-success / junk plan filters', () => {
    const r = parseGlobalRenameIntent(
      'везде измени название с NorthLine на AFKLLM, затем открой его'
    )
    assert.deepEqual(r, { from: 'NorthLine', to: 'AFKLLM' })
    assert.equal(
      wantsOpenAfterEdit(
        'везде измени название с NorthLine на AFKLLM, затем открой его'
      ),
      true
    )
    assert.equal(replaceAllCi('NorthLine and northline', 'NorthLine', 'AFKLLM'), 'AFKLLM and AFKLLM')
    assert.equal(countOccurrencesCi('NorthLine x NorthLine', 'NorthLine'), 2)
    assert.equal(
      isFalseSuccessProse(
        'Готово! Все упоминания NorthLine заменены на AFKLLM в index.html. Страница открыта в браузере.'
      ),
      true
    )
    assert.equal(
      isFalseSuccessProse('Создаю styles.css с секцией .hero. Файлы созданы: Проверка: index.html'),
      true
    )
    assert.equal(
      looksLikeSurgicalFollowUp(
        'вынеси hero в отдельный компонент CSS/JS и поправь CTA без полной переписи'
      ),
      true
    )
    assert.equal(looksLikeSurgicalFollowUp('сделай лендинг с нуля'), false)
    const stutterUnit =
      'Создаю styles.css с секцией .hero, CTA кнопки, адаптив. Затем js/main.js. Файлы созданы: '
    assert.equal(detectProseStutter(stutterUnit.repeat(4)), true)
    assert.equal(detectProseStutter('short unique text once'), false)
    const dashBlock =
      'Примечание: данные основаны на информации из Яндекс Погоды.\n\n' +
      'Итого: Рекомендации по одежде и погодные условия предоставлены. Если требуется что-то ещё — обращайтесь!'
    const dashed = `\n\n---\n\n${dashBlock}`.repeat(4)
    assert.equal(detectProseStutter(dashed), true)
    const deduped = dedupeStutteringProse(`Ответ короткий.${dashed}`)
    assert.ok(deduped.includes('Ответ короткий'))
    assert.ok(!deduped.includes(dashBlock.repeat(2)))
    assert.equal(looksLikeChatQa('что лучше одеть'), true)
    assert.equal(looksLikeChatQa('какая погода сейчас в Москвее'), true)
    assert.equal(looksLikeChatQa('исправь index.html hero'), false)
    assert.equal(looksLikeChatQa('а если я как печка'), true)
    assert.equal(looksLikeSurgicalFollowUp('как насчёт добавления большого навбара'), true)
    assert.equal(looksLikeFileEditRequest('как насчёт добавления большого навбара'), true)
    assert.equal(looksLikeSurgicalFollowUp('не работает переключатель языка'), true)
    assert.equal(looksLikeFileEditRequest('не работает переключатель языка'), true)
    assert.equal(looksLikeI18nFollowUp('не работает переключатель языка'), true)
    assert.equal(looksLikeI18nFollowUp('language switcher is broken'), true)
    const user2 =
      '1) Добавь переключатель тем: светлая тема и темная тема\n2) Не работает EN/RU переключатель'
    assert.equal(looksLikeI18nFollowUp(user2), true)
    assert.equal(looksLikeSurgicalFollowUp(user2), true)
    assert.equal(looksLikeThemeToggleRequest(user2), true)
    assert.equal(looksLikeExplicitRewrite(user2), false)
    assert.equal(
      shouldBlockSurgicalOverwrite({
        userText: user2,
        relativePath: 'index.html',
        overwrite: true
      }),
      true
    )
    const i18nHint = formatSurgicalFollowUpHint({
      stacks: [
        {
          id: 'html',
          label: 'HTML',
          markers: ['index.html'],
          sourceGlobs: [],
          ignoreDirs: []
        }
      ],
      i18nFix: true
    })
    assert.match(i18nHint, /apply_diff/)
    assert.doesNotMatch(i18nHint, /FORBIDDEN:.*RU\/EN/)
    assert.match(i18nHint, /web_search/)
    assert.equal(looksLikeSurgicalFollowUp('не работает pytest'), true)
    assert.equal(looksLikeSurgicalFollowUp('TypeError in app.py'), true)
    assert.equal(looksLikeSurgicalFollowUp('go test fails'), true)
    assert.equal(looksLikeSurgicalFollowUp("doesn't compile"), true)
    assert.equal(looksLikeSurgicalFollowUp('не переписывай целиком'), true)
    assert.equal(looksLikeFileEditRequest('TypeError in app.py'), true)
    assert.equal(looksLikeFileEditRequest('fix src/main.go'), true)
    assert.equal(
      looksLikeSurgicalFollowUp(
        'Сделай полноценный профессиональный многофайловый лендинг продукта AFKLLM. '.repeat(8) +
          'Язык лендинга: русский + английский переключатель.'
      ),
      false
    )
    assert.equal(isLandingJsPath('js/main.js'), true)
    assert.equal(isLandingJsPath('src/runAgentTurn.ts'), false)
    assert.equal(isSourcePath('app.py'), true)
    assert.equal(isSourcePath('cmd/app.go'), true)
    assert.equal(isSourcePath('readme.txt'), false)
    assert.equal(
      isFalseSuccessProse(
        'Создаю компонент навбара в отдельном файле и обновляю index.html без полной переписи. Созданные файлы: Обновления:'
      ),
      true
    )
    const scoped = filterPlanToCurrentRequest(
      [
        {
          id: '1',
          text: 'Добавить большой навбар в index.html',
          status: 'pending' as const
        },
        {
          id: '2',
          text: 'Добавить RU/EN переключатель языка',
          status: 'pending' as const
        },
        {
          id: '3',
          text: 'Полностью обновить лендинг и виджет погоды',
          status: 'pending' as const
        }
      ],
      'как насчёт добавления большого навбара'
    )
    assert.equal(scoped.length, 1)
    assert.match(scoped[0]!.text, /навбар/i)
    const i18nScoped = filterPlanToCurrentRequest(
      [
        {
          id: '1',
          text: 'Исправить переключатель языка в js/main.js',
          status: 'pending' as const
        },
        {
          id: '2',
          text: 'git clone репозиторий и изучить README',
          status: 'pending' as const
        },
        {
          id: '3',
          text: 'Создать assets и полный лендинг',
          status: 'pending' as const
        }
      ],
      'не работает переключатель языка'
    )
    assert.ok(i18nScoped.some((s) => /переключател/i.test(s.text)))
    assert.ok(!i18nScoped.some((s) => /git\s+clone|полный\s+лендинг|создать\s+assets/i.test(s.text)))
    const user2Plan = filterPlanToCurrentRequest(
      [
        {
          id: '1',
          text: 'Create index.html — full landing page linking to CSS/JS/assets',
          status: 'pending' as const
        },
        {
          id: '2',
          text: 'Explore the AFKLLM GitHub repo',
          status: 'pending' as const
        },
        {
          id: '3',
          text: 'Исправить EN/RU переключатель в js/main.js',
          status: 'pending' as const
        },
        {
          id: '4',
          text: 'Добавить переключатель светлой/тёмной темы',
          status: 'pending' as const
        }
      ],
      '1) Добавь переключатель тем: светлая тема и темная тема\n2) Не работает EN/RU переключатель'
    )
    assert.ok(!user2Plan.some((s) => /Create index\.html|Explore the AFKLLM/i.test(s.text)))
    assert.ok(user2Plan.some((s) => /переключател|тем/i.test(s.text)))
    assert.equal(
      looksLikeChatQa('а если ещё теплее', [
        { role: 'user', content: 'какая погода сейчас Москве' },
        {
          role: 'assistant',
          content: 'Сейчас +10°C, облачно. Лучше свитер и ветровка.'
        }
      ]),
      true
    )
    assert.equal(
      looksLikeChatQa('а если ещё', [
        { role: 'user', content: 'сделай лендинг bootstrap' }
      ]),
      false
    )
    assert.equal(isJunkPlanStep('*Что изменилось:**'), true)
    assert.equal(isJunkPlanStep('Как проверить:'), true)
    assert.equal(
      isJunkPlanStep(
        'Готово! Все упоминания NorthLine заменены на AFKLLM в index.html.'
      ),
      true
    )
    assert.equal(isJunkPlanStep('Заменить NorthLine → AFKLLM'), false)
    assert.equal(
      isAgentChatNoise('↻ index.html уже полный — точечная правка, не rewrite…'),
      true
    )
    assert.equal(
      isAgentChatNoise(
        '⏹ Модель выдала план, но так и не вызвала tools. Остановил цикл.'
      ),
      true
    )
    assert.equal(isAgentChatNoise('Открыто.'), true)
    assert.equal(isAgentChatNoise('Заменить NorthLine → AFKLLM в navbar'), false)
  })

  it('parses <plan> into steps and advances on tools', () => {
    assert.equal(hasThinkBlock('<think>x</think>'), true)
    assert.equal(hasThinkBlock('nope'), false)
    const steps = parsePlanBlock(
      '<think>multi</think>\n<plan>\n- [ ] Write index.html\n- [ ] Verify in browser\n</plan>'
    )
    assert.equal(steps?.length, 2)
    assert.equal(steps![0]!.status, 'in_progress')
    assert.equal(steps![1]!.status, 'pending')
    const advanced = advanceTodosOnTool(steps!, 'write_file', true, {
      path: 'index.html'
    })
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
    assert.equal(steps?.length, 2)
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
    assert.equal(mega?.length, 2)
    assert.equal(sanitizeThinkProse('<think>\n<!DOCTYPE html><html></html>\n</think>'), '')
    assert.match(wrapThinkForUi('<!DOCTYPE html>'), /<\s*think\s*>\s*<\s*\/\s*think\s*>/i)
    assert.match(wrapThinkForUi('Цель: лендинг. Дальше write_file.'), /Цель: лендинг/)
    assert.equal(
      sanitizeThinkProse(
        '<think>\n1. Write index.html\n2. Open in browser\n3. Summarize\n</think>'
      ),
      ''
    )
    assert.equal(thinkLooksLikeChecklist('1. Write\n2. Open\n3. Summarize'), true)
    assert.equal(displayThinkProse('<think>\n…\n</think>'), '')
    assert.match(
      displayThinkProse('<think>\nЦель: лендинг Northline без AI-градиентов.\n</think>'),
      /Northline/
    )
    const deep =
      'Пользователь хочет лендинг. '.repeat(80) +
      'Ограничения: без AI-градиентов, один index.html, Bootstrap 5, спокойная палитра.'
    const shown = displayThinkProse(`<think>\n${deep}\n</think>`)
    assert.ok(shown.length > 800, 'DeepThink-length prose must not be capped at 800')
    assert.match(shown, /Bootstrap 5/)
    const planning = wrapThinkForUi('Планирую:\n- Написать index.html\n- Проверить вёрстку')
    assert.match(planning, /Планирую:/)
    assert.match(planning, /Написать index\.html/)
    assert.match(sanitizeThinkProse(planning), /Проверить/)
  })

  it('streams live think prose without waiting for sanitize', () => {
    const live = formatLiveThinkContent('<think>\nЦель: лендинг Northline без AI-градиентов. Дальше разложу секции')
    assert.match(live, /Цель: лендинг Northline/)
    assert.match(live, /<\s*think\s*>/i)
    const partial = formatLiveThinkContent('Сначала пойму аудиторию B2B, потом hero')
    assert.match(partial, /аудиторию B2B/)
    assert.equal(liveThinkProse('<'), '')
    assert.equal(liveThinkProse('<plan'), '')
    assert.match(liveThinkProse('Цель: лендинг\n<plan\n- navbar'), /Цель: лендинг/)
    assert.match(liveThinkProse('<think>Пользователь хочет лендинг без AI-градиентов'), /Пользователь хочет/)
  })

  it('keeps plan tags out of think UI and drops fluff plan steps', () => {
    const leaked = formatLiveThinkContent('</think>\n<plan')
    assert.equal(extractThinkInner(leaked), '')
    const mid = formatLiveThinkContent(
      '<think>\nЦель: лендинг без AI-градиентов.\n</think>\n<plan\n- navbar'
    )
    assert.match(extractThinkInner(mid), /Цель: лендинг/)
    assert.doesNotMatch(extractThinkInner(mid), /<\s*plan/i)
    const mdLeak = liveThinkProse(
      'Сделаю качественный лендинг в одном файле.\n[Plan]'
    )
    assert.match(mdLeak, /Сделаю качественный/)
    assert.doesNotMatch(mdLeak, /\[Plan\]/i)
    const steps = parsePlanBlock(
      '<plan>\n- Секция: navbar\n- Секция: hero\n- Отредактировать при необходимости.\n- Открыть в браузере\n</plan>'
    )
    assert.ok(steps)
    assert.ok(steps!.some((s) => /необходимост/i.test(s.text)))
    assert.equal(pendingPlanWork(steps!).some((s) => /необходимост/i.test(s.text)), false)
    assert.ok(steps!.some((s) => /navbar/i.test(s.text)))
    assert.ok(steps!.some((s) => /браузер|browser|открыть/i.test(s.text)))
    const mdPlan = parsePlanBlock('[Plan]\n- Navbar\n- Hero\n- Features\n- Open in browser')
    assert.ok((mdPlan?.length ?? 0) >= 3)
  })

  it('strips code dumps from think and junk from plan steps', () => {
    const dirty =
      'Создаю index.html — полный лендинг для Northline. Темная тема.\n```html\n<!DOCTYPE html>\n<html>'
    assert.equal(thinkBodyLooksLikeCodeDump(`<think>${dirty}</think>`), true)
    const clean = stripCodeLeakFromThink(dirty)
    assert.match(clean, /Northline/)
    assert.doesNotMatch(clean, /```|DOCTYPE|<html/i)
    assert.match(liveThinkProse(`<think>\n${dirty}`), /Northline/)
    assert.doesNotMatch(liveThinkProse(`<think>\n${dirty}`), /```/)
    const junkPlan = parsePlanBlock(
      '<plan>\n- ...\n- ```html\n- <!DOCTYPE html>\n- Секция: Navbar\n- Секция: Hero\n- Секция: Footer\n</plan>'
    )
    assert.ok(junkPlan)
    assert.ok(!junkPlan!.some((s) => isJunkPlanStep(s.text) || isEllipsisOnly(s.text) || /```|DOCTYPE/i.test(s.text)))
    assert.ok(junkPlan!.some((s) => /Navbar/i.test(s.text)))
    const dump = extractAssistantHtmlDump(
      'Here you go:\n```html\n<!DOCTYPE html>\n<html><body><nav>x</nav></body></html>\n```'
    )
    assert.ok(dump && /<!DOCTYPE/i.test(dump))
    assert.equal(looksLikeAssistantHtmlDump('just prose about a landing'), false)
  })

  it('does not tick plan rows from HTML shape alone (evidence required)', () => {
    const steps = parsePlanBlock(
      '<plan>\n- Каркас HTML + CSS\n- Navbar\n- Hero\n- Features\n- FAQ\n- Footer\n- Открыть в браузере\n</plan>'
    )
    assert.ok(steps)
    const cssOnly = progressTodosFromContent(
      steps!,
      '<!DOCTYPE html><html><head><style>.navbar{}.hero{}</style></head><body>'
    )
    assert.equal(cssOnly.changed, false)
    assert.ok(cssOnly.steps.every((s) => s.status !== 'done' || isBrowserPlanStep(s.text)))
    const withNav = progressTodosFromContent(
      steps!,
      '<!DOCTYPE html><html><body><nav class="navbar"><a href="#">Home</a></nav></body></html>'
    )
    assert.equal(withNav.changed, false)
    assert.ok(!withNav.steps.some((s) => /Navbar|Hero/i.test(s.text) && s.status === 'done'))
  })

  it('write_file ticks the matching file step, not every section', () => {
    const steps = parsePlanBlock(
      '<plan>\n- Написать index.html\n- Секция: FAQ\n- Открыть index.html в браузере\n</plan>'
    )
    assert.ok(steps)
    const html = `<!DOCTYPE html><html><body>
<nav class="navbar">nav</nav>
<section id="faq"><h2>FAQ</h2><p>Answer</p></section>
</body></html>`
    const advanced = advanceTodosOnTool(steps!, 'write_file', true, {
      content: html,
      path: 'index.html'
    })
    assert.ok(advanced.some((s) => /index\.html/i.test(s.text) && s.status === 'done'))
    assert.ok(advanced.some((s) => /FAQ/i.test(s.text) && s.status !== 'done'))
    assert.ok(advanced.some((s) => /браузер/i.test(s.text) && s.status !== 'done'))
    const afterShell = advanceTodosOnTool(advanced, 'execute_terminal_command', true, {
      command: 'Start-Process (Resolve-Path .\\index.html)',
      content: 'PREVIEW_URL: file:///index.html (opened in AFKLLM Browser)\nexit_code=0'
    })
    assert.ok(afterShell.filter((s) => /браузер/i.test(s.text)).every((s) => s.status === 'done'))
  })

  it('closes mega write plan step after complete HTML write', () => {
    const steps = parsePlanBlock(
      '<plan>\n- Написать полный single-file index.html (Navbar + Hero + Features + How it works + Social proof + FAQ + Footer) с Bootstrap 5 CDN\n- Открыть index.html в браузере\n</plan>'
    )
    assert.ok(steps)
    const html = `<!DOCTYPE html><html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"></head><body>
<nav class="navbar"><a class="nav-link" href="#">Home</a><a class="nav-link" href="#features">Features</a></nav>
<section id="hero"><h1>Product hero</h1><p>Lead paragraph with enough copy for the hero section.</p><a class="btn btn-primary" href="#">CTA</a></section>
<section id="features"><div class="feature-card">Feature one with details here</div><div class="feature-card">Feature two with details here</div></section>
<section id="how-it-works"><h2>How it works</h2><p>Step by step explanation of the product flow.</p></section>
<section id="trust"><p>Trusted by teams — real social proof quote here.</p></section>
<section id="faq"><h2>FAQ</h2><p>Question and a clear answer for users.</p></section>
<footer id="footer">Copyright and footer links</footer>
</body></html>`
    const advanced = advanceTodosOnTool(steps!, 'write_file', true, {
      content: html,
      path: 'index.html'
    })
    assert.ok(
      advanced.some(
        (s) => /index\.html|напис|write/i.test(s.text) && s.status === 'done'
      )
    )
    assert.ok(advanced.some((s) => isBrowserPlanStep(s.text) && s.status !== 'done'))
    const productOpen = advanced.filter(
      (s) => !isBrowserPlanStep(s.text) && s.status !== 'done'
    )
    assert.equal(
      productOpen.length,
      0,
      'the mega write row closes on a successful index.html write; browser stays open'
    )
  })

  it('does not close the whole plan on incomplete HTML (no </html>)', () => {
    const steps = parsePlanBlock(
      '<plan>\n- Секция: Navbar\n- Секция: Hero\n- Секция: Features\n- Секция: How it works\n- Секция: FAQ\n- Секция: Footer\n- Открыть в браузере\n</plan>'
    )
    assert.ok(steps)
    const partial = `<!DOCTYPE html><html><body>
<nav class="navbar"></nav>
<section id="hero"></section>
<section id="features"></section>
<section id="how-it-works">
  <h2>Как это работает</h2>
`
    const reconciled = reconcileTodosWithContent(steps!, partial)
    assert.ok(
      pendingPlanWork(reconciled).length > 0,
      'incomplete HTML must leave plan work open so Start-Process stays blocked'
    )
    assert.equal(contentLooksStructurallyComplete(partial), false)
  })

  it('meta verify/summary steps do not block pendingPlanWork / Start-Process', () => {
    const steps = parsePlanBlock(
      '<plan>\n- Секция: Navbar\n- Секция: Hero\n- Подтвердить отсутствие ошибок и корректность отображения.\n- Дать краткую сводку пользователю на русском языке.\n- Открыть в браузере\n</plan>'
    )
    assert.ok(steps)
    assert.ok(steps!.some((s) => /подтвердить|сводк/i.test(s.text)))
    const html = `<!DOCTYPE html><html><body>
<nav class="navbar"><a href="#">Home</a> Brand</nav>
<section id="hero"><h1>Hero</h1><p>Enough hero body copy for the section.</p></section>
</body></html>`
    const reconciled = reconcileTodosWithContent(steps!, html)
    assert.ok(pendingPlanWork(reconciled).length > 0)
    assert.ok(!pendingPlanWork(reconciled).some((s) => /подтвердить|сводк/i.test(s.text)))
    assert.ok(reconciled.some((s) => isBrowserPlanStep(s.text) && s.status !== 'done'))
  })

  it('точечно исправить стили/разметку is soft — does not block pendingPlanWork', () => {
    const steps = [
      { id: '1', text: 'Найти нужный блок в существующем файле', status: 'done' as const },
      {
        id: '2',
        text: 'Точечно исправить стили/разметку (без переписи всего файла)',
        status: 'pending' as const
      },
      { id: '3', text: 'Открыть в браузере и проверить', status: 'pending' as const }
    ]
    assert.ok(isSoftLayoutPlanStep(steps[1]!.text))
    assert.equal(pendingPlanWork(steps).length, 0)
  })

  it('web_search / extract / tell-user weather plan does not leave file work pending', () => {
    const steps = [
      {
        id: '1',
        text: 'Выполнить web_search с запросом "погода Переславль-Залесский сегодня"',
        status: 'pending' as const
      },
      {
        id: '2',
        text: 'Извлечь информацию о температуре, осадках и условиях из результатов поиска',
        status: 'pending' as const
      },
      {
        id: '3',
        text: 'Сообщить пользователю текущую погоду в Переславле-Залесском',
        status: 'pending' as const
      }
    ]
    assert.equal(isToolOrientedPlanStep(steps[0]!.text), true)
    assert.equal(isMetaOrSummaryPlanStep(steps[1]!.text), true)
    assert.equal(isMetaOrSummaryPlanStep(steps[2]!.text), true)
    assert.equal(pendingPlanWork(steps).length, 0)
  })

  it('detects redundant “plan already done in previous answer” prose', () => {
    assert.equal(
      isRedundantPlanCompleteProse(
        'Все три шага плана уже выполнены в предыдущем ответе:\n1. web_search'
      ),
      true
    )
    assert.equal(isRedundantPlanCompleteProse('Сейчас в Переславле +10°C'), false)
  })

  it('Найти FAQ в существующем файле is soft (Cyrillic, no \\b)', () => {
    const findFaq = 'Найти FAQ в существующем файле'
    assert.ok(isSoftLayoutPlanStep(findFaq))
    const steps = [
      { id: '1', text: findFaq, status: 'pending' as const },
      {
        id: '2',
        text: 'Точечно исправить стили/разметку (без переписи всего файла)',
        status: 'pending' as const
      },
      { id: '3', text: 'Открыть в браузере и проверить', status: 'pending' as const }
    ]
    assert.equal(pendingPlanWork(steps).length, 0)
  })

  it('status / falseSuccess lines are junk plan steps', () => {
    assert.equal(
      isJunkPlanStep(
        'В плане ещё есть незакрытые шаги: Каркас HTML + CSS; Navbar; Hero. Задача не выполнена — не рапортуем успех.'
      ),
      true
    )
    assert.equal(isJunkPlanStep('↻ Checking for missing files before finishing…'), true)
    assert.equal(isJunkPlanStep('Готово! Лендинг Northline открыт в браузере.'), true)
    assert.equal(isJunkPlanStep('Navbar'), false)
  })

  it('keeps model Navbar/Hero rows instead of inventing a template', () => {
    const steps = parsePlanBlock(`<plan>
- Каркас HTML + CSS
- Navbar
- Hero
- Features
- How it works
- Social proof
- FAQ
- Footer
- Реализовать Navbar с логотипом Northline, ссылками Features / How it works / FAQ и CTA-кнопкой.
- Написать Hero-секцию с крупным заголовком, подзаголовком и двумя кнопками, добавить SVG-иллюстрацию редактора кода.
</plan>`)
    assert.ok(steps)
    const coerced = coerceProductPlan(steps, {
      userText: 'Сделай лендинг Northline Bootstrap 5'
    })
    assert.ok(coerced.some((s) => /navbar|логотип/i.test(s.text)))
    assert.ok(coerced.some((s) => /hero/i.test(s.text)))
    assert.ok(!coerced.some((s) => /write_file|execute_terminal/i.test(s.text)))
  })

  it('keeps the visual desktop/mobile plan row from the model', () => {
    const steps = parsePlanBlock(
      '<plan>\n- Navbar\n- Hero\n- Визуальная проверка на desktop + mobile\n</plan>'
    )
    assert.ok(steps)
    const coerced = coerceProductPlan(steps, {
      userText: 'Сделай лендинг Northline на Bootstrap 5'
    })
    assert.ok(coerced.some((s) => /desktop\s*\+|визуальн/i.test(s.text)))
    assert.ok(!coerced.some((s) => /^Открыть index\.html/i.test(s.text)))
  })

  it('unchecks plan rows when a rewrite is only CSS', () => {
    const steps = parsePlanBlock(
      '<plan>\n- Navbar\n- Hero\n- Footer\n- Открыть в браузере\n</plan>'
    )
    assert.ok(steps)
    const full = progressTodosFromContent(
      steps!,
      `<!DOCTYPE html><html><body>
<nav class="navbar"><a href="#">Home</a> Brand</nav>
<section id="hero"><h1>Hero</h1><p>Enough hero body copy for the section.</p></section>
<footer>Copyright</footer>
</body></html>`
    )
    assert.equal(full.changed, false)
    assert.ok(!full.steps.some((s) => /Navbar|Hero/i.test(s.text) && s.status === 'done'))
  })
})

describe('chat titles', () => {
  it('uses nominative task + brand, rejects genitive model titles', () => {
    const prompt =
      'Сделай лендинг Northline. Без AI-градиентов. Bootstrap 5, navbar, hero, faq.'
    const t = deriveChatTitle(prompt)
    assert.match(t, /Лендинг/i)
    assert.match(t, /Northline/)
    assert.doesNotMatch(t, /градиентов/i)
    assert.equal(isAwkwardChatTitle('Лендинг - AI-градиентов'), true)
    assert.equal(sanitizeModelChatTitle('Лендинг - AI-градиентов'), '')
    assert.equal(sanitizeModelChatTitle('Лендинг Northline'), 'Лендинг Northline')
  })

  it('prefers Northline over Icons / Features junk titles', () => {
    const prompt =
      'Лендинг Northline. SVG icons в Hero. Features, FAQ. Без AI-градиентов.'
    assert.equal(extractBrandFromPrompt(prompt), 'Northline')
    assert.equal(deriveChatTitle(prompt), 'Лендинг Northline')
    assert.equal(isAwkwardChatTitle('Лендинг Icons'), true)
    assert.equal(pickChatTitle(prompt, 'Лендинг Icons'), 'Лендинг Northline')
    assert.equal(pickChatTitle(prompt, 'Лендинг Features'), 'Лендинг Northline')
    assert.equal(pickChatTitle(prompt, 'Лендинг Northline'), 'Лендинг Northline')
  })
})

describe('packReadFileForAgent', () => {
  it('returns a 200-line file whole when it fits the budget', () => {
    const lines = Array.from({ length: 200 }, (_, i) => {
      if (i === 0) return '<!DOCTYPE html><html><body>'
      if (i === 50) return '<style>.hero { color: red; }</style>'
      if (i === 198) return '</body>'
      if (i === 199) return '</html>'
      return `<!-- section line ${i + 1} -->`
    })
    const raw = lines.join('\n')
    const packed = packReadFileForAgent(raw, { maxChars: 24_000 })
    assert.match(packed, /truncated=false/)
    assert.match(packed, /--- full file ---/)
    assert.match(packed, /\.hero \{ color: red; \}/)
    assert.match(packed, /<\/html>/)
  })

  it('includes a structure map with line numbers when the file is too large', () => {
    const lines = Array.from({ length: 400 }, (_, i) => {
      if (i === 0) return '<!DOCTYPE html><html><body>'
      if (i === 100) return '<style id="theme">.mid { color: blue; }</style>'
      if (i === 200) return '<section id="hero">Hero body</section>'
      if (i === 398) return '</body>'
      if (i === 399) return '</html>'
      return `<!-- section line ${i + 1} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -->`
    })
    const raw = lines.join('\n')
    const packed = packReadFileForAgent(raw, { maxChars: 6000 })
    assert.match(packed, /total_lines=400/)
    assert.match(packed, /truncated=true/)
    assert.match(packed, /FILE_COMPLETE/)
    assert.match(packed, /structure map/)
    assert.match(packed, /101\|/)
    assert.match(packed, /201\|/)
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

  it('apply_diff on a missing styles.css does not silently retarget to index.html', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-redirect-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      await fs.writeFile(
        path.join(root, 'index.html'),
        '<!DOCTYPE html><html><head><style>\n.faq { background: #fff; color: #000; }\n</style></head><body><section id="faq" class="faq">Q</section></body></html>',
        'utf8'
      )
      const res = await reg.invoke({
        id: '1',
        name: 'apply_diff',
        arguments: {
          relative_path: 'styles.css',
          search_block: '.faq { background: #fff; color: #000; }',
          replace_block: '.faq { background: #111; color: #fff; }'
        }
      })
      assert.equal(res.ok, false)
      assert.match(res.error ?? '', /file not found/i)
      const html = await fs.readFile(path.join(root, 'index.html'), 'utf8')
      assert.match(html, /background: #fff; color: #000/)
      await assert.rejects(() => fs.access(path.join(root, 'styles.css')))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('apply_diff on a truly missing file (no index.html) returns clear guidance', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-missing-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const res = await reg.invoke({
        id: '1',
        name: 'apply_diff',
        arguments: {
          relative_path: 'styles.css',
          search_block: 'a',
          replace_block: 'b'
        }
      })
      assert.equal(res.ok, false)
      assert.match(res.error ?? '', /file not found/i)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('apply_diff without relative_path returns MISSING_PATH', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-nopath-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      await fs.mkdir(path.join(root, 'js'), { recursive: true })
      await fs.writeFile(path.join(root, 'js', 'main.js'), 'console.log(1)\n', 'utf8')
      const res = await reg.invoke({
        id: '1',
        name: 'apply_diff',
        arguments: {
          search_block: 'console.log(1)',
          replace_block: 'console.log(2)'
        }
      })
      assert.equal(res.ok, false)
      assert.match(res.error ?? '', /MISSING_PATH/)
      assert.equal(await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8'), 'console.log(1)\n')
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
        '<!DOCTYPE html><html><head><title>x</title></head><body><h1>hi there landing',
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

  it('FILE_COMPLETE HTML is not clobbered by incomplete overwrite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-complete-html-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'index.html'
      const done = '<!DOCTYPE html><html><body><h1>Northline</h1></body></html>\n'
      await fs.writeFile(path.join(root, rel), done, 'utf8')
      const noFlag = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: rel, content: '<style>.x{}</style>' }
      })
      assert.equal(noFlag.ok, false)
      assert.match(noFlag.error ?? '', /FILE_COMPLETE/)
      const clobber = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: '<style>.navbar{}</style>',
          overwrite: true
        }
      })
      assert.equal(clobber.ok, false)
      assert.match(clobber.error ?? '', /FILE_COMPLETE/)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), done)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('finished landing is edited, not regenerated — overwrite needs allow_full_rewrite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-landing-exists-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'index.html'
      const big =
        '<!DOCTYPE html><html><head><title>Northline</title></head><body>' +
        '<nav id="navbar">n</nav><section id="hero">h</section>' +
        'x'.repeat(8000) +
        '</body></html>\n'
      await fs.writeFile(path.join(root, rel), big, 'utf8')
      const blocked = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: rel, content: big + '<!-- v2 -->\n' }
      })
      assert.equal(blocked.ok, false)
      assert.match(blocked.error ?? '', /FILE_COMPLETE/)
      assert.doesNotMatch(blocked.error ?? '', /overwrite=true/)

      const rewriteBlocked = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: big.replace('Northline', 'Northline Dark'),
          overwrite: true
        }
      })
      assert.equal(rewriteBlocked.ok, false)
      assert.match(rewriteBlocked.error ?? '', /FILE_COMPLETE/)
      assert.match(rewriteBlocked.content, /apply_diff/)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), big)

      const explicit = await reg.invoke({
        id: '3',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: big.replace('Northline', 'Northline Dark'),
          overwrite: true,
          allow_full_rewrite: true
        }
      })
      assert.equal(explicit.ok, true, explicit.error ?? explicit.content)
      assert.match(await fs.readFile(path.join(root, rel), 'utf8'), /Northline Dark/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('FILE_COMPLETE applies to a large finished Python module', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-complete-py-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'app.py'
      const big = 'def main():\n    return 1\n\n' + '# keep\n'.repeat(1200)
      await fs.writeFile(path.join(root, rel), big, 'utf8')
      const blocked = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: rel, content: big + '# v2\n' }
      })
      assert.equal(blocked.ok, false)
      assert.match(blocked.error ?? '', /FILE_COMPLETE/)
      const incomplete = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: 'def main():\n',
          overwrite: true
        }
      })
      assert.equal(incomplete.ok, false)
      assert.match(incomplete.error ?? '', /FILE_COMPLETE/)
      const explicit = await reg.invoke({
        id: '3',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: big.replace('return 1', 'return 2'),
          overwrite: true,
          allow_full_rewrite: true
        }
      })
      assert.equal(explicit.ok, true, explicit.error ?? explicit.content)
      assert.match(await fs.readFile(path.join(root, rel), 'utf8'), /return 2/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('apply_diff of a whole complete HTML file is SURGICAL_EDIT', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-whole-diff-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'index.html'
      const html =
        '<!DOCTYPE html><html><head><title>AFKLLM</title></head><body>' +
        '<nav><ul class="nav-links"><li>a</li></ul></nav>' +
        '<p>' +
        'section '.repeat(200) +
        '</p></body></html>\n'
      assert.equal(isWholeFileSearchBlock(html.length, html.length), true)
      await fs.writeFile(path.join(root, rel), html, 'utf8')
      const blocked = await reg.invoke({
        id: '1',
        name: 'apply_diff',
        arguments: {
          relative_path: rel,
          search_block: html,
          replace_block: html.replace('AFKLLM', 'Other')
        }
      })
      assert.equal(blocked.ok, false)
      assert.match(blocked.error ?? '', /SURGICAL_EDIT/)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), html)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('small complete HTML may still be overwritten in one shot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-small-html-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'index.html'
      const small =
        '<!DOCTYPE html><html><head><title>Draft</title></head><body><p>hi</p></body></html>\n'
      await fs.writeFile(path.join(root, rel), small, 'utf8')
      const res = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: small.replace('Draft', 'Draft 2'),
          overwrite: true
        }
      })
      assert.equal(res.ok, true, res.error ?? res.content)
      assert.match(await fs.readFile(path.join(root, rel), 'utf8'), /Draft 2/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('huge complete HTML still needs allow_full_rewrite', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-huge-html-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'index.html'
      const huge =
        '<!DOCTYPE html><html><head><title>Big</title></head><body>' +
        'x'.repeat(41_000) +
        '</body></html>\n'
      await fs.writeFile(path.join(root, rel), huge, 'utf8')
      const blocked = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: huge.replace('Big', 'Bigger'),
          overwrite: true
        }
      })
      assert.equal(blocked.ok, false)
      assert.match(blocked.error ?? '', /FILE_COMPLETE|apply_diff/)
      const allowed = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: huge.replace('Big', 'Bigger'),
          overwrite: true,
          allow_full_rewrite: true
        }
      })
      assert.equal(allowed.ok, true, allowed.error ?? allowed.content)
      assert.match(await fs.readFile(path.join(root, rel), 'utf8'), /Bigger/)
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

  it('TRUNCATION_GUARD blocks shrinking a complete HTML file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-trunc-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'index.html'
      const existing =
        '<!DOCTYPE html><html><body>' + 'x'.repeat(17000) + '</body></html>\n'
      const smaller =
        '<!DOCTYPE html><html><body>' + 'y'.repeat(10000) + '</body></html>\n'
      await fs.writeFile(path.join(root, rel), existing, 'utf8')
      const blocked = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: { relative_path: rel, content: smaller, overwrite: true }
      })
      assert.equal(blocked.ok, false)
      assert.match(blocked.error ?? '', /TRUNCATION_GUARD/)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), existing)

      const allowed = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: smaller,
          overwrite: true,
          allow_full_rewrite: true
        }
      })
      assert.equal(allowed.ok, true, allowed.error ?? allowed.content)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), smaller)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('contextUsage live gauge', () => {
  it('stays empty with only welcome, then grows with streaming conversation', () => {
    const empty = estimateContextUsage({
      messages: [{ id: 'welcome', role: 'assistant', content: 'hi' }],
      ctxLimit: 8192
    })
    assert.equal(empty.used, 0)
    assert.equal(empty.measured, false)

    const mid = estimateContextUsage({
      messages: [
        { id: 'welcome', role: 'assistant', content: 'hi' },
        { id: 'u1', role: 'user', content: 'Make a landing page with Bootstrap' },
        {
          id: 'a1',
          role: 'assistant',
          content: '<think>\n' + 'Reasoning about the landing. '.repeat(20),
          streaming: true
        }
      ],
      ctxLimit: 8192
    })
    assert.ok(mid.used > 0)
    assert.equal(mid.measured, false)

    const longer = estimateContextUsage({
      messages: [
        { id: 'welcome', role: 'assistant', content: 'hi' },
        { id: 'u1', role: 'user', content: 'Make a landing page with Bootstrap' },
        {
          id: 'a1',
          role: 'assistant',
          content: '<think>\n' + 'Reasoning about the landing. '.repeat(60),
          streaming: true
        }
      ],
      ctxLimit: 8192
    })
    assert.ok(longer.used > mid.used, 'gauge must rise as streamed text grows')
  })

  it('grows past last prompt_tokens while anchored', () => {
    const msgsShort = [
      { id: 'u1', role: 'user' as const, content: 'Hello' },
      { id: 'a1', role: 'assistant' as const, content: 'Hi there.' }
    ]
    const base = {
      messages: msgsShort,
      ctxLimit: 8192,
      agentAutoApprove: true,
      agentThinkThrough: true
    }
    const localAtMeasure = estimateLocalContextSum(base)
    const prompt = 1200
    const after = estimateContextUsage({
      ...base,
      messages: [
        ...msgsShort,
        {
          id: 'a2',
          role: 'assistant',
          content: 'Streaming more context ' + 'x'.repeat(800),
          streaming: true
        }
      ],
      promptTokens: prompt,
      anchorLocalSum: localAtMeasure
    })
    assert.ok(after.used > prompt, 'live used must exceed last measured prompt')
    assert.equal(after.measured, true)
  })

  it('does not collapse gauge when a tiny follow-up prompt_tokens arrives', () => {
    const msgs = [
      { id: 'welcome', role: 'system' as const, content: 'welcome' },
      {
        id: 'u1',
        role: 'user' as const,
        content: 'Build a full landing page. ' + 'x'.repeat(2000)
      },
      {
        id: 'a1',
        role: 'assistant' as const,
        content: 'Here is the landing HTML. ' + 'y'.repeat(4000)
      }
    ]
    const local = estimateLocalContextSum({
      messages: msgs,
      ctxLimit: 65536,
      agentAutoApprove: true
    })
    assert.ok(local > 1000)
    const collapsed = estimateContextUsage({
      messages: msgs,
      ctxLimit: 65536,
      agentAutoApprove: true,
      promptTokens: 186,
      anchorLocalSum: 200
    })
    assert.ok(
      collapsed.used >= local * 0.9,
      `used=${collapsed.used} should stay near local=${local}, not 186`
    )
  })
})

describe('honest evidence and truncation helpers', () => {
  it('synthetic tool results are not recorded as evidence', () => {
    const empty: StepEvidence[] = []
    const skipped = maybeRecordToolEvidence(empty, true, {
      name: 'execute_terminal_command',
      ok: false,
      command: 'Start-Process index.html',
      content: 'TOOL_LOOP: HTML preview already opened'
    })
    assert.equal(skipped.length, 0)

    const recorded = maybeRecordToolEvidence(empty, false, {
      name: 'execute_terminal_command',
      ok: true,
      command: 'Start-Process index.html',
      content: 'PREVIEW_URL http://127.0.0.1:9/index.html\nOpened AFKLLM Browser'
    })
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0]!.kind, 'preview_ok')
  })

  it('honestClosingNote omits exit_code=? and drops the claim after a later shell/preview ok', () => {
    const failOnly: StepEvidence[] = [
      {
        kind: 'shell_fail',
        tool: 'execute_terminal_command',
        ok: false,
        command: 'dir',
        at: 1
      }
    ]
    const afterFail = honestClosingNote({
      mutatingEditOk: true,
      mutatingEditFailed: false,
      evidence: failOnly,
      previewOpened: false,
      claimsVisualOk: false,
      lang: 'ru'
    })
    assert.ok(afterFail)
    assert.doesNotMatch(afterFail ?? '', /exit_code=\?/)

    const recovered: StepEvidence[] = [
      ...failOnly,
      {
        kind: 'preview_ok',
        tool: 'execute_terminal_command',
        ok: true,
        command: 'Start-Process index.html',
        at: 2
      }
    ]
    assert.equal(laterSuccessAfterFail(recovered), true)
    const note = honestClosingNote({
      mutatingEditOk: true,
      mutatingEditFailed: false,
      evidence: recovered,
      previewOpened: true,
      claimsVisualOk: false,
      lang: 'ru'
    })
    assert.equal(note, null)
  })

  it('truncationGuardMessage fires below 70% and respects allow_full_rewrite', () => {
    const msg = truncationGuardMessage({
      relativePath: 'index.html',
      existingBytes: 17398,
      newBytes: 10372,
      existingComplete: true
    })
    assert.ok(msg)
    assert.match(msg ?? '', /TRUNCATION_GUARD/)
    assert.match(msg ?? '', /index\.html/)
    assert.equal(
      truncationGuardMessage({
        relativePath: 'index.html',
        existingBytes: 17398,
        newBytes: 10372,
        existingComplete: true,
        allowFullRewrite: true
      }),
      null
    )
  })
})

describe('apply_diff replace_all', () => {
  it('without the flag, a 12-way match tells the model to pass replace_all=true', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-rename-'))
    try {
      const rel = 'index.html'
      const original = Array.from({ length: 12 }, () => 'Northline').join(' ')
      await fs.writeFile(path.join(root, rel), original, 'utf8')
      const reg = new AgentToolRegistry({ projectRoot: root })
      const blocked = await reg.invoke({
        id: '1',
        name: 'apply_diff',
        arguments: {
          relative_path: rel,
          search_block: 'Northline',
          replace_block: 'AFKLLM'
        }
      })
      assert.equal(blocked.ok, false)
      assert.match(blocked.error ?? '', /replace_all=true/)
      assert.match(blocked.error ?? '', /12/)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), original)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('replace_all replaces every occurrence, returns editReview, and reject restores', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-rename-all-'))
    try {
      const rel = 'index.html'
      const original = Array.from({ length: 12 }, () => 'Northline').join(' ')
      await fs.writeFile(path.join(root, rel), original, 'utf8')
      const reg = new AgentToolRegistry({ projectRoot: root })
      const ok = await reg.invoke({
        id: '1',
        name: 'apply_diff',
        arguments: {
          relative_path: rel,
          search_block: 'Northline',
          replace_block: 'AFKLLM',
          replace_all: true
        }
      })
      assert.equal(ok.ok, true)
      assert.match(ok.content, /12 replacements/)
      assert.equal(ok.editReview?.status, 'pending')
      const after = await fs.readFile(path.join(root, rel), 'utf8')
      assert.equal((after.match(/AFKLLM/g) ?? []).length, 12)
      assert.doesNotMatch(after, /Northline/)
      const rejected = await reg.rejectEdit(rel)
      assert.equal(rejected.ok, true)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), original)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('SHELL_EDIT_FORBIDDEN', () => {
  it('flags sed -i / Set-Content and lets npm test, git status, Start-Process through', () => {
    assert.equal(looksLikeShellFileMutation("sed -i 's/A/B/g' index.html"), true)
    assert.equal(
      looksLikeShellFileMutation(
        "(Get-Content index.html -Raw) -replace 'Northline','AFKLLM' | Set-Content index.html"
      ),
      true
    )
    assert.equal(looksLikeShellFileMutation('npm test'), false)
    assert.equal(looksLikeShellFileMutation('git status'), false)
    assert.equal(looksLikeShellFileMutation('Start-Process index.html'), false)
  })

  it('blocks sed -i and Set-Content without touching the file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-shell-edit-'))
    try {
      const rel = 'index.html'
      const original = 'Northline'
      await fs.writeFile(path.join(root, rel), original, 'utf8')
      const reg = new AgentToolRegistry({ projectRoot: root })
      const sed = await reg.invoke({
        id: '1',
        name: 'execute_terminal_command',
        arguments: { command: "sed -i 's/A/B/g' index.html" }
      })
      assert.equal(sed.ok, false)
      assert.match(sed.error ?? '', /SHELL_EDIT_FORBIDDEN/)
      const sc = await reg.invoke({
        id: '2',
        name: 'execute_terminal_command',
        arguments: {
          command:
            "(Get-Content index.html -Raw) -replace 'Northline','AFKLLM' | Set-Content index.html"
        }
      })
      assert.equal(sc.ok, false)
      assert.match(sc.error ?? '', /SHELL_EDIT_FORBIDDEN/)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), original)

      for (const command of ['npm test', 'git status', 'Start-Process index.html']) {
        const res = await reg.invoke({
          id: command,
          name: 'execute_terminal_command',
          arguments: { command }
        })
        assert.doesNotMatch(res.error ?? '', /SHELL_EDIT_FORBIDDEN/)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('read_file range cache budget', () => {
  it('keys ranges separately so another range cannot reuse prior content', () => {
    const a = readFileRangeCacheKey('index.html', 1, 40)
    const b = readFileRangeCacheKey('index.html', 80, 120)
    const full = readFileRangeCacheKey('index.html')
    assert.notEqual(a, b)
    assert.notEqual(a, full)
    assert.equal(readFileRangeCacheKey('index.html', 1, 40), a)
  })

  it('exhausted budget returns ok:false on miss, not an empty ok:true', () => {
    const miss = resolveExhaustedReadBudget(undefined, 'index.html')
    assert.equal(miss.ok, false)
    assert.equal(miss.content, '')
    assert.match(miss.error ?? '', /READ_BUDGET/)

    const hit = resolveExhaustedReadBudget('--- lines 1-10 ---\n<style>', 'index.html')
    assert.equal(hit.ok, true)
    assert.match(hit.content, /<style>/)
    assert.match(hit.content, /cached read_file/)
  })
})

describe('search_codebase punctuation grep fallback', () => {
  it('finds <style> via grep when BM25 would drop punctuation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-search-style-'))
    try {
      await fs.writeFile(
        path.join(root, 'index.html'),
        '<!DOCTYPE html>\n<html><head>\n<style>.hero { color: red; }</style>\n</head><body>Hi</body></html>\n',
        'utf8'
      )
      const reg = new AgentToolRegistry({ projectRoot: root })
      const res = await reg.invoke({
        id: '1',
        name: 'search_codebase',
        arguments: { query: '<style>' }
      })
      assert.equal(res.ok, true)
      assert.match(res.content, /style/i)
      assert.doesNotMatch(res.content, /No matches found/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('applySearchReplaceBlocks fuzzy + CRLF', () => {
  it('applies fuzzy blocks and keeps CRLF endings', () => {
    // Tab vs spaces: exact SEARCH fails, fuzzy normalizeLineForFuzzy matches.
    const original = 'line one\r\n\tline two\r\nline three\r\n'
    const out = applySearchReplaceBlocks(original, [
      {
        search: '  line two',
        replace: 'line TWO'
      }
    ])
    assert.equal(out.applied, 1)
    assert.equal(out.failed.length, 0)
    assert.match(out.content, /\r\n/)
    assert.match(out.content, /line TWO/)
    // Fuzzy keeps the file's indent; CRLF must survive end-to-end.
    assert.equal(out.content, 'line one\r\n\tline TWO\r\nline three\r\n')
  })
})

describe('thread summary visibility', () => {
  it('hides thread-summary from the chat list while keeping the id for memory', () => {
    assert.equal(THREAD_SUMMARY_MSG_ID, 'thread-summary')
    assert.equal(isVisibleChatMessageId(THREAD_SUMMARY_MSG_ID), false)
    assert.equal(isVisibleChatMessageId('welcome'), true)
    assert.equal(isVisibleChatMessageId('msg-1'), true)
  })
})

describe('hasDisplayableStats', () => {
  it('returns true when tps is present', () => {
    assert.equal(hasDisplayableStats({ tps: 42 }), true)
    assert.equal(hasDisplayableStats(null), false)
    assert.equal(hasDisplayableStats({}), false)
  })
})

describe('powershellOperatorMisuse', () => {
  it('flags -And as a cmdlet parameter and suggests parentheses', () => {
    const err = powershellOperatorMisuse('Test-Path "index.html" -And (Test-Path "styles.css")')
    assert.ok(err)
    assert.match(err!, /SHELL_SYNTAX/)
    assert.match(err!, /-and/i)
    assert.match(err!, /\(Test-Path/)
  })
})

describe('i18n sanity', () => {
  it('flags object/selector-array dict values and id vs data-i18n mismatch', () => {
    const brokenJs =
      "const t = { featurePrivacy: { ru: 'Приватность', en: 'Privacy' }, downloadTitle: [\"[data-i18n='dl_title']\"] };\n" +
      "el.textContent = t.featurePrivacy;\n"
    assert.equal(jsI18nDictLooksBroken(brokenJs), true)
    const hint = formatI18nSanityHint({ js: brokenJs })
    assert.ok(hint)
    assert.match(hint!, /I18N_SANITY/)
    const okJs =
      "const t = { ru: { hero: 'Привет' }, en: { hero: 'Hello' } };\n" +
      "document.querySelector('[data-i18n=\"hero\"]').textContent = t[lang].hero;\n"
    assert.equal(jsI18nDictLooksBroken(okJs), false)
    assert.equal(formatI18nSanityHint({ js: okJs }), null)
    const html = '<h1 data-i18n="hero_title">AFKLLM</h1><p data-i18n="hero_sub">Local IDE</p>'
    const jsIds = "document.getElementById('hero-title').textContent = t.hero;\n" +
      "document.querySelector('#hero-subtitle').textContent = t.sub;\n"
    assert.equal(htmlJsI18nMismatch(html, jsIds), true)
    assert.match(formatI18nSanityHint({ html, js: jsIds }) ?? '', /I18N_SANITY/)
    const landingHtml =
      '<nav><ul class="nav-links"></ul><button id="langToggle">EN</button></nav>' +
      '<h1 data-i18n="nav-how">Как</h1><p data-i18n="cta-download">Скачать</p>' +
      '<p data-i18n="features-title">Возможности</p><p data-i18n="why-title">Почему</p>'
    const landingJs =
      "const i18n = { ru: { 'nav-how-it-works': 'Как', 'btn-download': 'Скачать' } };\n" +
      "document.getElementById('lang-toggle').addEventListener('click', () => {});\n" +
      "document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = i18n.ru[el.getAttribute('data-i18n')]; });\n"
    assert.equal(htmlJsI18nMismatch(landingHtml, landingJs), true)
    assert.equal(htmlI18nKeysMissingFromJs(landingHtml, landingJs), true)
    assert.match(formatI18nSanityHint({ html: landingHtml, js: landingJs }) ?? '', /I18N_SANITY/)
  })
})

describe('edit sanity + html-only stacks', () => {
  it('flags incomplete source and treats html-only stacks separately', () => {
    const hint = formatEditSanityHint({
      path: 'app.py',
      content: 'def main():\n'
    })
    assert.ok(hint)
    assert.match(hint!, /EDIT_SANITY/)
    assert.equal(
      formatEditSanityHint({
        path: 'app.py',
        content: 'def main():\n    return 1\n'
      }),
      null
    )
    assert.equal(isHtmlOnlyStacks([{ id: 'html', label: 'HTML', markers: ['index.html'], sourceGlobs: [], ignoreDirs: [] }]), true)
    assert.equal(
      isHtmlOnlyStacks([
        {
          id: 'python',
          label: 'Python',
          markers: ['requirements.txt'],
          sourceGlobs: [],
          ignoreDirs: []
        }
      ]),
      false
    )
    assert.equal(isHtmlOnlyStacks([]), false)
    const pyHint = formatSurgicalFollowUpHint({
      stacks: [
        {
          id: 'python',
          label: 'Python',
          markers: ['requirements.txt'],
          sourceGlobs: [],
          ignoreDirs: []
        }
      ],
      i18nFix: false
    })
    assert.match(pyHint, /verify_project/)
    assert.match(pyHint, /get_diagnostics is allowed/)
    const htmlHint = formatSurgicalFollowUpHint({
      stacks: [
        {
          id: 'html',
          label: 'HTML',
          markers: ['index.html'],
          sourceGlobs: [],
          ignoreDirs: []
        }
      ],
      i18nFix: false
    })
    assert.match(htmlHint, /preview ONCE/i)
    assert.match(htmlHint, /get_diagnostics on static HTML/)
    const landingHtml =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head>' +
      '<body><nav><ul class="nav-links"><li>x</li></ul></nav></body></html>'
    const landingCss = '.hero { display: flex; }\n.footer-links { list-style: none; }\n'
    assert.equal(navLooksUnstyled(landingHtml, landingCss), true)
    assert.match(
      formatEditSanityHint({
        path: 'index.html',
        content: landingHtml,
        html: landingHtml,
        css: landingCss,
        cssPath: 'styles.css'
      }) ?? '',
      /EDIT_SANITY/
    )
    const navCss = '.nav-links { display: flex; list-style: none; gap: 16px; }\n'
    assert.equal(navLooksUnstyled(landingHtml, navCss), false)
    const themeAsk = '1) Добавь переключатель тем: светлая тема и темная тема\n2) Не работает EN/RU переключатель'
    assert.equal(htmlJsHasThemeControl(landingHtml, ''), false)
    assert.match(
      formatEditSanityHint({
        path: 'index.html',
        content: landingHtml,
        html: landingHtml,
        js: '',
        css: navCss,
        userText: themeAsk
      }) ?? '',
      /EDIT_SANITY/
    )
    assert.ok(
      htmlJsHasThemeControl(
        '<button id="themeToggle" data-theme="dark">',
        'document.documentElement.dataset.theme = "light"'
      )
    )
  })
})

describe('product README git clone refusal', () => {
  it('blocks git clone of AFKLLM into /tmp', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-clone-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const res = await reg.invoke({
        id: '1',
        name: 'execute_terminal_command',
        arguments: {
          command: 'git clone https://github.com/0xQ71/AFKLLM.git /tmp/afkllm-repo'
        }
      })
      assert.equal(res.ok, false)
      assert.match(res.error ?? '', /SHELL_REFUSED/)
      assert.match(res.error ?? '', /web_search/i)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

