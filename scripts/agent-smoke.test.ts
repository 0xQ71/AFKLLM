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
  salvageLeakedToolCalls,
  stripLeakedToolMarkup,
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
  parseTodoUiFailed,
  todoCardFailed,
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
  isFileWorkPlanStep,
  shouldNudgeRemainingFileWork,
  reopenTodosForMissingViteReact,
  isBrowserPlanStep,
  isPreviewHealthCheckPlanStep,
  isFluffPlanStep,
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
  looksLikeImageQa,
  looksLikeFileEditRequest,
  looksLikeSurgicalFollowUp,
  looksLikeI18nFollowUp,
  looksLikeThemeToggleRequest,
  looksLikeExplicitRewrite,
  looksLikeFromScratchTask,
  looksLikeFinishMissingLandingFiles,
  landingBriefAlreadyHasFacts,
  isResearchScavengerPlanStep,
  looksLikeEmptyOrStubWriteContent,
  formatEmptyWriteError,
  formatWriteRedirectChip,
  looksLikeNoCardDumpRequest,
  allowsComposerFullRewrite,
  shouldBlockSurgicalOverwrite,
  shouldBlockSurgicalCssRewrite,
  cssLooksLikeRealStylesheet,
  contentLooksLikeSourceStub,
  formatStubOnDiskHint,
  shouldHandoffWriteToApply,
  shouldPersistIncompleteWrite,
  priorCompleteForWritePath,
  formatApplyHandoffInstruction,
  buildApplyHandoffArgs,
  isComposerApplyPath,
  isLandingJsPath,
  isSourcePath,
  filterPlanToCurrentRequest,
  parseGlobalRenameIntent,
  wantsOpenAfterEdit,
  replaceAllCi,
  countOccurrencesCi,
  isFullRewriteFallbackPlanStep,
  evaluateAcceptanceGate,
  userAskedForCliSmoke,
  looksLikeFromScratchRunTask,
  isCliVerifyCommand,
  cliVerifyLooksSuccessful,
  stripCodeLeakFromThink,
  preferUserFacingCloser,
  looksTruncatedCloser,
  extractAssistantHtmlDump,
  looksLikeAssistantHtmlDump,
  isEllipsisOnly,
  type ApiMessage
} from '../src/renderer/src/agent/agentPure'
import {
  estimateContextUsage,
  estimateLocalContextSum
} from '../src/renderer/src/agent/contextUsage'
import { AgentToolRegistry, isProtectedHarnessFile } from '../src/main/agent/AgentToolRegistry'
import { looksLikeShellFileMutation, powershellOperatorMisuse, POWERSHELL_UNALIAS_CURL, POWERSHELL_AGENT_PTY_INIT } from '../src/shared/shellErrors'
import {
  CHAT_MAX_CONTENT_CHARS,
  deriveChatTitle,
  extractBrandFromPrompt,
  isAwkwardChatTitle,
  isVisibleChatMessageId,
  pickChatTitle,
  sanitizeModelChatTitle,
  sanitizePersistedMessages,
  mergePersistedKeepingCloser,
  isAgentClosingMessageId,
  relocateAgentCloser,
  isReusableEmptySession,
  userAskedForLanding,
  welcomeMessageForLang,
  createEmptySession,
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
import { fallbackWorkDoneCloser, honestClosingNote, resolveTurnCloser, closerMentionsPreview, isNextActionNarration } from '../src/renderer/src/agent/loop/report'
import {
  formatI18nSanityHint,
  formatI18nCloserWhy,
  htmlHasEmptyI18nShells,
  htmlJsI18nMismatch,
  htmlI18nKeysMissingFromJs,
  inventedI18nVerifierPath,
  jsI18nDictLooksBroken,
  jsAssignsNonStringToDom,
  jsI18nUsesDestructiveSplit,
  i18nSanityTargetPaths
} from '../src/renderer/src/agent/loop/i18nSanity'
import {
  formatWriteFileRequiredError,
  formatWriteOnceError,
  formatLandingJsBeforeHtmlHint,
  landingBundleReady,
  looksLikeViteReactTask,
  looksLikeViteReactFromScratch,
  userAskedViteReactPreview,
  looksLikeDevOrPreviewCommand,
  shellResultOpenedPreview,
  markPreviewFromShell,
  collectPathsFromTreeText,
  viteReactScaffoldMissing,
  formatViteReactScaffoldHint,
  isLandingPageScriptPath,
  isViteConfigPath,
  shouldRefuseLandingRewrite,
  shouldRequireWriteFileForApply
} from '../src/renderer/src/agent/loop/landingWriteCap'
import {
  compactTokenThreshold,
  maxTokensForAgent,
  shouldCompactForOverflow
} from '../src/renderer/src/agent/loop/ctxBudget'
import { formatEditSanityHint, navLooksUnstyled, htmlJsHasThemeControl, htmlCssLayoutMismatch, inlineSvgLooksUnsized, formatLandingCssContractHint, extractCssClassNames, unboundJsxClickHandlers, viteHtmlEntryMismatch, jsxCssClassMismatch, jsxMissingCssImports, viteReactHtmlLooksLikePageDump, jsxNestsHtmlRootId, jsxUsesEmojiAsSvgFill, jsxTeleportsControlOffscreen } from '../src/renderer/src/agent/loop/editSanity'
import { stubWriteFileArgs } from '../src/renderer/src/agent/loop/compactWrites'
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

  it('salvages leaked XML write_file instead of stopping the loop', () => {
    const leaked =
      '<think>Now README</think>\n' +
      '<tool_call>\n<function=write_file>\n' +
      '<parameter=content>\n# AFKLLM Landing\nOpen index.html\n</parameter>\n' +
      '<parameter=relative_path>\nREADME.md\n</parameter>\n' +
      '</function>\n</tool_call>'
    assert.equal(looksLikeToolMarkupLeak(leaked), true)
    const calls = salvageLeakedToolCalls(leaked)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.function.name, 'write_file')
    const args = JSON.parse(calls[0]!.function.arguments) as {
      content?: string
      relative_path?: string
    }
    assert.equal(args.relative_path, 'README.md')
    assert.match(args.content ?? '', /AFKLLM Landing/)
    const stripped = stripLeakedToolMarkup(leaked)
    assert.match(stripped, /Now README/)
    assert.doesNotMatch(stripped, /tool_call|function=write_file/)
    assert.match(liveThinkProse(leaked), /Now README/)
    assert.doesNotMatch(liveThinkProse(leaked), /tool_call|function=/)
  })

  it('does not salvage tool XML rehearsed only inside think', () => {
    const leaked =
      '<think>I will search.\n<function=web_search><parameter=query>LTS Node</parameter></function>\n</think>\nNeed a real tool next.'
    assert.equal(salvageLeakedToolCalls(leaked).length, 0)
  })

  it('salvages JSON <tool_call> and truncated function= XML', () => {
    const json =
      '<tool_call>{"name":"web_search","arguments":{"query":"LTS Node.js"}}</tool_call>'
    const jsonCalls = salvageLeakedToolCalls(json)
    assert.equal(jsonCalls.length, 1)
    assert.equal(jsonCalls[0]!.function.name, 'web_search')
    assert.equal(JSON.parse(jsonCalls[0]!.function.arguments).query, 'LTS Node.js')

    const truncated =
      '<function=write_file><parameter=relative_path>src/App.jsx</parameter><parameter=content>\nexport default function App() {\n'
    const cut = salvageLeakedToolCalls(truncated)
    assert.equal(cut.length, 1)
    assert.equal(cut[0]!.function.name, 'write_file')
    const args = JSON.parse(cut[0]!.function.arguments) as {
      relative_path?: string
      content?: string
    }
    assert.equal(args.relative_path, 'src/App.jsx')
    assert.match(args.content ?? '', /function App/)
  })

  it('salvages leaked verify_project XML and strips it from chat text', () => {
    const leaked =
      'Dev-сервер работает.\n' +
      '<tool_call>\n<function=verify_project>\n' +
      '<parameter=command>\nnpm test\n</parameter>\n' +
      '<parameter=mode>\ntest\n</parameter>\n' +
      '</function>\n</tool_call>'
    assert.equal(looksLikeToolMarkupLeak(leaked), true)
    const calls = salvageLeakedToolCalls(leaked)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.function.name, 'verify_project')
    const args = JSON.parse(calls[0]!.function.arguments) as { mode?: string; command?: string }
    assert.equal(args.mode, 'test')
    assert.equal(args.command, 'npm test')
    const stripped = stripLeakedToolMarkup(leaked)
    assert.match(stripped, /Dev-сервер/)
    assert.doesNotMatch(stripped, /tool_call|function=verify_project/)
    assert.equal(looksLikeToolMarkupLeak(stripped), false)
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

describe('compact write_file args', () => {
  it('keeps content and never uses note', () => {
    const raw = stubWriteFileArgs({
      relativePath: 'index.html',
      omittedChars: 4000,
      lineCount: 120,
      latest: true
    })
    const args = JSON.parse(raw) as Record<string, unknown>
    assert.equal(args.relative_path, 'index.html')
    assert.equal(typeof args.content, 'string')
    assert.match(String(args.content), /\[HISTORY_COMPACT\]/)
    assert.doesNotMatch(String(args.content), /^\[omitted/)
    assert.match(String(args.content), /NOT file contents/i)
    assert.equal(args.note, undefined)
    assert.equal(looksLikeEmptyOrStubWriteContent(args.content, 'index.html'), true)
    assert.match(formatEmptyWriteError('index.html'), /EMPTY_WRITE/)
    assert.match(formatEmptyWriteError('index.html'), /HISTORY_COMPACT/)
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

  it('keeps shell stdout in codePreview', () => {
    const out = sanitizePersistedMessages([
      { id: 'welcome', role: 'assistant', content: 'hi' },
      {
        id: 'sh1',
        role: 'assistant',
        content: 'Ran python wordfreq.py',
        toolName: 'execute_terminal_command',
        codePreview: 'the: 4\ncat: 3\nexit_code=0'
      }
    ])
    const sh = out.find((m) => m.id === 'sh1')
    assert.equal(sh?.codePreview, 'the: 4\ncat: 3\nexit_code=0')
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

  it('mergePersistedKeepingCloser inserts host closer before files_changed', () => {
    const closer: PersistedChatMessage = {
      id: 'agent-closing-u1',
      role: 'assistant',
      content: 'Файлы: src/App.jsx. Превью открыто в приложении — вкладка Browser (npm run dev).'
    }
    const files: PersistedChatMessage = {
      id: 'fc1',
      role: 'assistant',
      toolName: '__files_changed__',
      content: '{"files":[]}'
    }
    const prev = [
      { id: 'welcome', role: 'assistant', content: 'hi' },
      { id: 'u1', role: 'user', content: 'go' },
      closer,
      files
    ]
    const stale = [
      { id: 'welcome', role: 'assistant', content: 'hi' },
      { id: 'u1', role: 'user', content: 'go' },
      files
    ]
    const merged = mergePersistedKeepingCloser(prev, stale)
    const ids = merged.map((m) => m.id)
    assert.ok(isAgentClosingMessageId(closer.id))
    assert.equal(ids.indexOf('agent-closing-u1'), ids.indexOf('fc1') - 1)
    assert.equal(
      mergePersistedKeepingCloser(stale, stale).some((m) => isAgentClosingMessageId(m.id)),
      false
    )
  })

  it('strips shell chrome off a host closer on persist', () => {
    const out = sanitizePersistedMessages([
      { id: 'welcome', role: 'assistant', content: 'hi' },
      {
        id: 'agent-closing-u1',
        role: 'assistant',
        content: 'Файлы: src/App.jsx. Превью открыто в приложении — вкладка Browser (npm run dev).',
        toolName: 'execute_terminal_command',
        codePreview: 'npm run dev',
        activity: {
          kind: 'shell',
          verb: 'Running',
          status: 'running',
          command: 'npm run dev'
        }
      }
    ])
    const closer = out.find((m) => m.id === 'agent-closing-u1')
    assert.equal(closer?.toolName, undefined)
    assert.equal(closer?.codePreview, undefined)
    assert.equal(closer?.activity, undefined)
    assert.match(closer?.content ?? '', /Превью открыто/)
    const merged = mergePersistedKeepingCloser(
      [
        {
          id: 'agent-closing-u1',
          role: 'assistant',
          content: 'Превью открыто в приложении — вкладка Browser.',
          toolName: 'execute_terminal_command'
        }
      ],
      [{ id: 'fc1', role: 'assistant', toolName: '__files_changed__', content: '{}' }]
    )
    assert.equal(merged[0]?.toolName, undefined)
  })

  it('relocateAgentCloser moves a mid-thread closer to just before files_changed', () => {
    const msgs: PersistedChatMessage[] = [
      { id: 'u1', role: 'user', content: 'go' },
      {
        id: 'agent-closing-u1',
        role: 'assistant',
        content: 'Превью открыто в приложении — вкладка Browser.'
      },
      { id: 'w1', role: 'assistant', content: 'Edited App.jsx', toolName: 'write_file' },
      { id: 'fc1', role: 'assistant', toolName: '__files_changed__', content: '{}' }
    ]
    relocateAgentCloser(msgs, 'agent-closing-u1')
    const ids = msgs.map((m) => m.id)
    assert.deepEqual(ids, ['u1', 'w1', 'agent-closing-u1', 'fc1'])
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

  it('splits unclosed think before leaked tool_call XML', () => {
    const parts = parseThinkBlocks(
      '<think>\nNext: README.md\n<tool_call>\n<function=write_file>\n<parameter=relative_path>README.md</parameter>\n'
    )
    assert.ok(parts.some((p) => p.kind === 'think' && /README/.test(p.text)))
    assert.ok(parts.some((p) => p.kind === 'text' && /tool_call|function=write_file/.test(p.text)))
    assert.ok(!parts.some((p) => p.kind === 'think' && /function=write_file/.test(p.text)))
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
    assert.equal(
      isToolOrientedPlanStep('Исследовать репозиторий AFKLLM через explore_subagent'),
      true
    )
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

  it('keeps GitHub research plan rows for the model to execute or recover from', () => {
    const brief =
      'Сделай полноценный профессиональный многофайловый лендинг продукта AFKLLM. ' +
      'Факты только из https://github.com/0xQ71/AFKLLM. ' +
      'Local AI coding IDE for Windows: Electron + Monaco + llama.cpp. ' +
      'Локальные GGUF, MIT, Windows x64 installer.'
    assert.equal(landingBriefAlreadyHasFacts(brief), true)
    assert.equal(
      landingBriefAlreadyHasFacts('Сделай лендинг про кофе без ссылок'),
      false
    )
    assert.equal(
      isResearchScavengerPlanStep(
        'Fetch AFKLLM GitHub repo content (read README, source code) to extract accurate product facts for the landing page.'
      ),
      true
    )
    assert.equal(
      isResearchScavengerPlanStep(
        'Создать README.md лендинга — инструкция открыть index.html в браузере'
      ),
      false
    )
    const raw = parsePlanBlock(
      '<plan>\n' +
        '- Fetch AFKLLM GitHub repo content (read README, source code)\n' +
        '- Создать assets/ — SVG-иконки\n' +
        '- Написать styles.css — dark-тема\n' +
        '- Создать README.md лендинга — как открыть\n' +
        '</plan>'
    )
    const coerced = coerceProductPlan(raw, { userText: brief })
    assert.ok(coerced.some((s) => /Fetch AFKLLM GitHub/i.test(s.text)))
    assert.ok(coerced.some((s) => /assets|SVG/i.test(s.text)))
    assert.ok(coerced.some((s) => /styles\.css/i.test(s.text)))
    assert.ok(coerced.some((s) => /README\.md/i.test(s.text)))
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
    assert.equal(looksLikeChatQa('что на этом фото'), true)
    assert.equal(looksLikeImageQa('что на этом фото', true), true)
    assert.equal(looksLikeImageQa('что на этом фото', false), false)
    assert.equal(looksLikeImageQa('сделай лендинг по этому скрину', true), false)
    assert.equal(looksLikeImageQa('исправь кнопку на скрине', true), false)
    assert.equal(looksLikeChatQa('что лучше одеть'), true)
    const signOffLoop =
      'Яблоки на тарелке.\n\n---\nЗадача завершена.\n\n---\nДо новых встреч!\n\n---\nГотов к новым задачам!\n\n---\nЗадача завершена.\n\n---\nКонец сообщения.'
    assert.equal(detectProseStutter(signOffLoop), true)
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
      shouldHandoffWriteToApply({ userText: user2, relativePath: 'js/main.js' }),
      true
    )
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
      '1. Write index.html\n2. Open in browser\n3. Summarize'
    )
    assert.equal(thinkLooksLikeChecklist('1. Write\n2. Open\n3. Summarize'), true)
    assert.match(
      displayThinkProse(
        '<think>\nЦель: React-игра.\nПлан действий:\n1) Vite\n2) Компоненты\n3) Стили\n</think>'
      ),
      /1\) Vite/
    )
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

  it('strips fake <web_search> markup from think', () => {
    const leaked =
      'Нужно найти LTS.\n<web_search>LTS Node.js version site:nodejs.org</web_search>\nПотом ответить.'
    const clean = stripCodeLeakFromThink(leaked)
    assert.doesNotMatch(clean, /<web_search>/i)
    assert.match(clean, /Нужно найти LTS/)
  })

  it('drops English closer meta and keeps the Russian summary', () => {
    const mixed =
      'The task is complete. I should provide a short summary in Russian since the user wrote in Russian.\n\n' +
      'Отлично! Исправление успешно применено и тесты проходят.\n\nБаг устранён точечно, проект не переписан.'
    const out = preferUserFacingCloser(mixed, 'ru')
    assert.doesNotMatch(out, /I should provide/)
    assert.match(out, /Исправление успешно/)
  })

  it('drops Perfect/closing-summary English meta and detects truncated URLs', () => {
    const mixed =
      'Perfect! Now I need to write the closing summary in Russian.\n\n' +
      'Игра готова. Превью: `http:/'
    const out = preferUserFacingCloser(mixed, 'ru')
    assert.doesNotMatch(out, /Perfect/)
    assert.doesNotMatch(out, /closing summary/i)
    assert.match(out, /Игра готова/)
    assert.equal(looksTruncatedCloser(out), true)
    assert.equal(looksTruncatedCloser('Игра готова: http://localhost:3000/'), false)
    assert.equal(looksTruncatedCloser('See `App.jsx` and `main.jsx`.'), false)
    const compile =
      'The user wants me to stop and write a closing summary in Russian. Let me compile what was done:\n\nFiles created/modified: package.json'
    assert.equal(preferUserFacingCloser(compile, 'ru'), '')
    const inThink =
      '<think>Let me summarize.</think>\n\nИгра готова. Превью открыто на http://127.0.0.1:4173/'
    const outThink = preferUserFacingCloser(inThink, 'ru')
    assert.doesNotMatch(outThink, /<think>/i)
    assert.doesNotMatch(outThink, /Let me summarize/)
    assert.match(outThink, /Игра готова/)
    const ruMeta =
      'Пользователь просит дописать заключение, но без новых tool calls. ' +
      'Задача выполнена: файлы записаны, программа запущена успешно с exit_code=0, вывод показан. ' +
      'Нужно просто добавить завершающий текст на русском языке.\n\n' +
      'Программа wordfreq.go создана и успешно запущена — топ-10 слов подсчитан корректно.'
    const outRuMeta = preferUserFacingCloser(ruMeta, 'ru')
    assert.doesNotMatch(outRuMeta, /Пользователь просит/)
    assert.doesNotMatch(outRuMeta, /tool calls/i)
    assert.doesNotMatch(outRuMeta, /завершающий текст/)
    assert.match(outRuMeta, /wordfreq\.go/)
    const longOdd =
      'The terminal keeps showing `npm run dev -- --host 127.0.0.1 --port 3000 because the rewrite pinned a busy port. ' +
      'Next I tried vite --port 5173 which is the IDE. Files: package.json, src/App.jsx.'
    assert.equal(looksTruncatedCloser(longOdd), false)
  })

  it('orders replace before run on an edit plan', () => {
    const coerced = coerceProductPlan(
      [
        {
          id: '1',
          text: 'Запустить node test.js и показать stdout.',
          status: 'pending'
        },
        {
          id: '2',
          text: 'Заменить эту логику на умножение: сумма * (1 + taxRate).',
          status: 'pending'
        }
      ],
      { userText: 'Почини баг в total.js и запусти node test.js', surgical: true }
    )
    const iFix = coerced.findIndex((s) => /Заменить/i.test(s.text))
    const iRun = coerced.findIndex((s) => /Запустить/i.test(s.text))
    assert.ok(iFix >= 0 && iRun >= 0)
    assert.ok(iFix < iRun)
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

  it('Plan steps: and Confirm exit code do not keep pendingPlanWork open', () => {
    const steps = [
      { id: 's1', text: 'Plan steps:', status: 'in_progress' as const },
      { id: 's2', text: 'Write wordfreq.go', status: 'done' as const },
      { id: 's3', text: 'Run go run wordfreq.go', status: 'done' as const },
      {
        id: 's4',
        text: 'Confirm exit code is 0 and output contains expected top words.',
        status: 'pending' as const
      },
      {
        id: 's5',
        text: 'Показать реальный вывод терминала.',
        status: 'in_progress' as const
      }
    ]
    assert.equal(isJunkPlanStep(steps[0]!.text), true)
    assert.equal(isMetaOrSummaryPlanStep(steps[3]!.text), true)
    assert.equal(isMetaOrSummaryPlanStep(steps[4]!.text), true)
    assert.equal(pendingPlanWork(steps).length, 0)
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

  it('T05 verify/summary rows are meta — not leftover file work', () => {
    const verify =
      'Проверить корректность: убедиться, что все секции рендерятся, мобильный адаптив работает, нет синтаксических ошибок.'
    const summary = 'Подвести итог: что создано, ключевые пути, как проверялся результат.'
    assert.equal(isMetaOrSummaryPlanStep(verify), true)
    assert.equal(isMetaOrSummaryPlanStep(summary), true)
    assert.equal(isFileWorkPlanStep(verify), false)
    const steps = [
      { id: 's1', text: 'Создать styles.css', status: 'done' as const },
      { id: 's2', text: 'Создать index.html', status: 'done' as const },
      { id: 's3', text: verify, status: 'in_progress' as const },
      { id: 's4', text: summary, status: 'pending' as const }
    ]
    assert.equal(pendingPlanWork(steps).length, 0)
    const settled = settlePlanAfterWork(steps, { previewOpened: true, edited: true })
    assert.ok(settled.every((s) => s.status === 'done'))
  })

  it('curl localhost / page-loaded plan rows are preview health — not leftover work', () => {
    const curl = 'Проверить, что страница загрузилась без ошибок (curl -I http://localhost:4173)'
    const errors = 'Если есть ошибки — исправить и перезапустить dev-сервер'
    assert.equal(isPreviewHealthCheckPlanStep(curl), true)
    assert.equal(isBrowserPlanStep(curl), true)
    assert.equal(isResearchScavengerPlanStep(curl), false)
    assert.equal(isFluffPlanStep(errors), true)
    const constraints =
      'Ключевые ограничения: React-игра, не HTML; все файлы в корне проекта; запрещён GitHub и чужие папки.'
    assert.equal(isFluffPlanStep(constraints), true)
    const steps = [
      { id: 's1', text: 'Создать App.jsx', status: 'done' as const },
      { id: 's2', text: curl, status: 'in_progress' as const },
      { id: 's3', text: errors, status: 'pending' as const },
      { id: 's4', text: constraints, status: 'in_progress' as const }
    ]
    assert.equal(pendingPlanWork(steps).length, 0)
    const settled = settlePlanAfterWork(steps, { previewOpened: true })
    assert.equal(settled.find((s) => s.id === 's2')?.status, 'done')
    assert.equal(settled.find((s) => s.id === 's4')?.status, 'done')
  })

  it('EMPTY_WRITE chip is not the apply_diff rewrite warning', () => {
    assert.match(formatWriteRedirectChip('EMPTY_WRITE: relative_path="index.html"', 'ru'), /пустая запись/i)
    assert.doesNotMatch(
      formatWriteRedirectChip('EMPTY_WRITE: relative_path="index.html"', 'ru'),
      /apply_diff/
    )
    assert.match(formatWriteRedirectChip('FILE_COMPLETE: index.html', 'ru'), /apply_diff/)
  })

  it('long post-tool closer is not false-success prose', () => {
    const closer =
      'Превью открыто в браузере. Все файлы созданы и проверены. ' +
      'Созданы index.html, styles.css и js/main.js для студии «Северная заводь». ' +
      'Откройте превью в приложении и проверьте секции Navbar, Hero, lodges, FAQ и Footer на desktop и mobile.'
    assert.equal(isFalseSuccessProse(closer), false)
    assert.equal(
      isFalseSuccessProse('Создаю styles.css с секцией .hero. Файлы созданы: Проверка: index.html'),
      true
    )
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
    assert.equal(isJunkPlanStep('План из 3–6 шагов:'), true)
    assert.equal(isJunkPlanStep('Plan of 3-6 atomic product steps'), true)
    assert.equal(isJunkPlanStep('Plan steps:'), true)
    assert.equal(isJunkPlanStep('Шаги плана:'), true)
    assert.equal(isJunkPlanStep('Шаги:'), true)
    assert.equal(isJunkPlanStep('Steps:'), true)
    assert.equal(isJunkPlanStep('Суммарно: создать 3 файла'), true)
    assert.equal(isJunkPlanStep('Summary: Создать Java-программу, скомпилировать, протестировать.'), true)
    assert.equal(
      isJunkPlanStep('Суммируя: создаётся один файл C++, собирается и тестируется.'),
      true
    )
    assert.equal(
      isMetaOrSummaryPlanStep('Суммируя: создаётся один файл C++, собирается и тестируется.'),
      true
    )
    assert.equal(
      isFileWorkPlanStep('Суммируя: создаётся один файл C++, собирается и тестируется.'),
      false
    )
    assert.equal(
      pendingPlanWork([
        {
          id: 's5',
          text: 'Суммируя: создаётся один файл C++, собирается и тестируется.',
          status: 'in_progress'
        }
      ]).length,
      0
    )
    assert.equal(isJunkPlanStep('Написать wordfreq.py'), false)
    const t07d = [
      {
        id: 's1',
        text: 'План: создать wordfreq.go в корне проекта, затем запустить его через go run с тестовым текстом и показать вывод.',
        status: 'done' as const
      },
      { id: 's2', text: 'Шаги:', status: 'in_progress' as const },
      {
        id: 's3',
        text: 'Создать файл wordfreq.go в корне проекта с реализацией подсчёта частоты слов.',
        status: 'done' as const
      },
      {
        id: 's4',
        text: 'Запустить программу через go run wordfreq.go с тестовым текстом.',
        status: 'done' as const
      },
      {
        id: 's5',
        text: 'Показать реальный вывод терминала из запуска.',
        status: 'done' as const
      }
    ]
    assert.equal(pendingPlanWork(t07d).length, 0)
    const t07ePrep =
      'Подготовить короткий тестовый текст (например: "hello world hello foo bar foo baz hello") для запуска.'
    assert.equal(isMetaOrSummaryPlanStep(t07ePrep), true)
    assert.equal(
      pendingPlanWork([
        { id: 's2', text: t07ePrep, status: 'in_progress' as const },
        { id: 's3', text: 'Запустить программу через go run wordfreq.go', status: 'done' as const }
      ]).length,
      0
    )
    const t07Prompt =
      'Создай в корне проекта Go-программу wordfreq.go: считает частоту слов. Сразу после записи запусти её (go run) и покажи реальный вывод терминала.'
    assert.equal(looksLikeFromScratchRunTask(t07Prompt), true)
    assert.equal(isCliVerifyCommand('echo "hello" | go run wordfreq.go'), true)
    assert.equal(isCliVerifyCommand('python -m http.server 4173'), false)
    assert.equal(
      cliVerifyLooksSuccessful(
        'go run ./wordfreq.go test_input.txt',
        '> go run ./wordfreq.go test_input.txt\nНет слов для анализа.\n\nexit_code=0',
        true
      ),
      false
    )
    assert.equal(
      cliVerifyLooksSuccessful(
        'go run ./wordfreq.go test_input.txt',
        '> go run ./wordfreq.go test_input.txt\n1. hello — 3\n2. foo — 2\n\nexit_code=0',
        true
      ),
      true
    )
    assert.equal(
      isJunkPlanStep(
        'Суммарно: создать 3 файла (go.mod, wordfreq.go, test_input.txt), затем выполнить один запуск команды.'
      ),
      true
    )
    const echoed = parsePlanBlock(
      '<plan>\n- План из 3–6 шагов:\n- Написать wordfreq.py\n- Запустить скрипт на тестовом тексте\n</plan>'
    )
    const coercedEcho = coerceProductPlan(echoed)
    assert.ok(!coercedEcho.some((s) => /план\s+из\s+\d/i.test(s.text)))
    assert.ok(coercedEcho.some((s) => /wordfreq/i.test(s.text)))
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

  it('uses quoted Cyrillic brand and ignores negated Northline', () => {
    const prompt =
      'Собери с нуля одностраничный лендинг рыболовной студии «Северная заводь» (lodges / рыбалка, не Northline и не чужой бренд).'
    assert.equal(extractBrandFromPrompt(prompt), 'Северная заводь')
    assert.match(deriveChatTitle(prompt), /Лендинг/i)
    assert.match(deriveChatTitle(prompt), /Северная/)
    assert.doesNotMatch(deriveChatTitle(prompt), /Northline/i)
    assert.equal(pickChatTitle(prompt, 'Лендинг Northline'), deriveChatTitle(prompt))
  })

  it('does not title a React game chat as GitHub', () => {
    const prompt =
      'Собери с нуля в корне этой папки игру на React (Vite + React), тема — рыбалка. Не ходи на GitHub и не пиши в чужие папки.'
    assert.notEqual(extractBrandFromPrompt(prompt), 'GitHub')
    assert.doesNotMatch(deriveChatTitle(prompt), /GitHub/i)
    assert.doesNotMatch(deriveChatTitle(prompt), /^(react|vite)$/i)
    assert.match(deriveChatTitle(prompt), /игра/i)
    assert.match(deriveChatTitle(prompt), /рыбалк/i)
    assert.equal(isAwkwardChatTitle('React'), true)
    assert.equal(isAwkwardChatTitle('Собери нуля корне'), true)
    assert.match(pickChatTitle(prompt, 'React'), /игра/i)
  })

  it('does not treat «не HTML-лендинг» as a landing title', () => {
    const prompt =
      'Собери с нуля в корне этой папки игру на React (Vite + React), тема — рыбалка: крючок/поплавок, можно ловить рыбу, приятный UI.\n' +
      'Это должна быть именно React-игра, не HTML-лендинг. Не ходи на GitHub и не пиши в чужие папки.'
    assert.equal(userAskedForLanding(prompt), false)
    assert.match(deriveChatTitle(prompt), /игра/i)
    assert.match(deriveChatTitle(prompt), /рыбалк/i)
    assert.doesNotMatch(deriveChatTitle(prompt), /собери|нуля|корне/i)
  })

  it('does not title a Python script chat as a landing', () => {
    const prompt =
      'Создай в корне проекта Python-скрипт wordfreq.py: считает частоту слов из аргумента-файла или stdin, без учёта регистра, печатает топ-10. Не делай HTML/лендинг.'
    assert.equal(userAskedForLanding(prompt), false)
    const titled = pickChatTitle(prompt, 'Лендинг Python')
    assert.doesNotMatch(titled, /лендинг/i)
    assert.doesNotMatch(titled, /landing/i)
    assert.match(deriveChatTitle(prompt), /wordfreq/i)
  })

  it('rejects Thinking Process and User-asks titles; prefers Fix file', () => {
    const edit =
      'В total.js баг: налог должен считаться как сумма * (1 + taxRate). Почини точечно. Не делай HTML/лендинг.'
    assert.equal(isAwkwardChatTitle('Thinking Process:'), true)
    assert.equal(isAwkwardChatTitle('Пользователь просит исправить'), true)
    assert.equal(pickChatTitle(edit, 'Thinking Process:'), deriveChatTitle(edit))
    assert.match(deriveChatTitle(edit), /Fix total\.js/i)
    assert.match(deriveChatTitle('Создай wordfreq.go: топ-10 слов, go run.'), /Go wordfreq/i)
  })

  it('reuses an empty New agent session instead of stacking blanks', () => {
    assert.equal(
      isReusableEmptySession({
        title: 'New agent',
        messages: [{ role: 'assistant' }]
      }),
      true
    )
    assert.equal(
      isReusableEmptySession({
        title: 'Fix total.js',
        messages: [{ role: 'assistant' }]
      }),
      false
    )
    assert.equal(
      isReusableEmptySession({
        title: 'New agent',
        messages: [{ role: 'user' }, { role: 'assistant' }]
      }),
      false
    )
  })

  it('persists a Russian welcome for ru UI language', () => {
    const ru = createEmptySession('ru')
    assert.equal(ru.title, 'Новый агент')
    assert.equal(ru.messages[0]?.id, 'welcome')
    assert.match(ru.messages[0]?.content ?? '', /онлайн/i)
    assert.match(welcomeMessageForLang('ru').content, /онлайн/i)
    assert.equal(isReusableEmptySession(ru), true)
  })

  it('refuses deleting harness PROMPT.txt', () => {
    assert.equal(isProtectedHarnessFile('PROMPT.txt'), true)
    assert.equal(isProtectedHarnessFile('src/PROMPT.txt'), true)
    assert.equal(isProtectedHarnessFile('TASK.md'), true)
    assert.equal(isProtectedHarnessFile('brief.md'), true)
    assert.equal(isProtectedHarnessFile('src/App.jsx'), false)
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
      assert.match(res.error ?? '', /WRITE_FILE_REQUIRED/)
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
      assert.match(res.error ?? '', /WRITE_FILE_REQUIRED/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('apply_diff on missing js/main.js returns WRITE_FILE_REQUIRED', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-missing-js-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const res = await reg.invoke({
        id: '1',
        name: 'apply_diff',
        arguments: {
          relative_path: 'js/main.js',
          search_block: 'console.log(1)',
          replace_block: 'console.log(2)'
        }
      })
      assert.equal(res.ok, false)
      assert.match(res.error ?? '', /WRITE_FILE_REQUIRED/)
      assert.match(res.error ?? '', /js\/main\.js/)
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

  it('truncated overwrite of complete JS does not change disk', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-complete-js-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const rel = 'js/main.js'
      await fs.mkdir(path.join(root, 'js'), { recursive: true })
      const done =
        '(function () {\n  const state = { theme: "light" };\n' +
        '  function init() { document.body.dataset.theme = state.theme; }\n' +
        '  init();\n})();\n' +
        '// keep\n'.repeat(800)
      await fs.writeFile(path.join(root, rel), done, 'utf8')
      const truncated = await reg.invoke({
        id: '1',
        name: 'write_file',
        arguments: {
          relative_path: rel,
          content: 'function themeToggle() {\n',
          overwrite: true
        }
      })
      assert.equal(truncated.ok, false)
      assert.match(truncated.error ?? '', /FILE_COMPLETE/)
      assert.equal(await fs.readFile(path.join(root, rel), 'utf8'), done)
      const created = await reg.invoke({
        id: '2',
        name: 'write_file',
        arguments: {
          relative_path: 'js/new.js',
          content:
            '(function () {\n  const ok = true;\n  function init() { return ok; }\n  init();\n})();\n'
        }
      })
      assert.equal(created.ok, true, created.error ?? created.content)
      assert.doesNotMatch(created.content, /FILE_COMPLETE/)
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

  it('fallbackWorkDoneCloser is a visible RU closer with files and preview', () => {
    const closer = fallbackWorkDoneCloser({
      lang: 'ru',
      paths: ['package.json', 'src\\App.jsx'],
      previewOpened: true
    })
    assert.match(closer, /Файлы:/)
    assert.match(closer, /src\/App\.jsx/)
    assert.match(closer, /Превью открыто в приложении/)
    assert.ok(closer.length >= 80)
    assert.equal(preferUserFacingCloser(closer, 'ru'), closer)
    assert.equal(isFalseSuccessProse(closer), false)
    const cliCloser = fallbackWorkDoneCloser({
      lang: 'ru',
      paths: ['wordfreq.go'],
      previewOpened: false
    })
    assert.match(cliCloser, /wordfreq\.go/)
    assert.match(cliCloser, /чипе терминала/)
    assert.doesNotMatch(cliCloser, /npm run dev/)
    const poisoned = resolveTurnCloser({
      lastClosingText: 'Зависимости установлены успешно. Теперь запускаю npm run dev.',
      lang: 'ru',
      paths: ['package.json', 'src/App.jsx'],
      previewOpened: true
    })
    assert.equal(closerMentionsPreview(poisoned), true)
    assert.match(poisoned, /src\/App\.jsx/)
    assert.ok(poisoned.length >= 80)
  })

  it('next-action narration is not a usable closer', () => {
    assert.equal(
      isNextActionNarration(
        'npm install succeeded. Now I need to run npm run dev to start the Vite dev server.'
      ),
      true
    )
    assert.equal(
      isNextActionNarration(
        'All source files are done. Let me start with npm install.\nВсе файлы созданы. Теперь запускаю npm install и dev-сервер.'
      ),
      true
    )
    assert.equal(
      isNextActionNarration(
        'Файлы: src/App.jsx. Превью открыто в приложении — вкладка Browser (npm run dev).'
      ),
      false
    )
    const poisoned = resolveTurnCloser({
      lastClosingText:
        'npm install succeeded. Now I need to run npm run dev to start the Vite dev server.',
      lang: 'ru',
      paths: ['src/App.jsx'],
      previewOpened: false
    })
    assert.equal(isNextActionNarration(poisoned), false)
    assert.match(poisoned, /Файлы:/)
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
    assert.equal(
      looksLikeShellFileMutation(
        'g++ -o wordfreq wordfreq.cpp 2>&1 && echo BUILD_OK || (where cl >nul 2>&1 && echo FOUND_CL)'
      ),
      false
    )
    assert.equal(looksLikeShellFileMutation('where cl >nul 2>&1'), false)
    assert.equal(looksLikeShellFileMutation('echo hello > test.txt'), true)
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

describe('compiler install refusal', () => {
  it('blocks winget/choco MinGW and mingw-builds downloads without writing archives', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-compiler-refuse-'))
    try {
      const reg = new AgentToolRegistry({ projectRoot: root })
      const winget = await reg.invoke({
        id: '1',
        name: 'execute_terminal_command',
        arguments: { command: 'winget install --id MinGW.GCC' }
      })
      assert.equal(winget.ok, false)
      assert.match(winget.error ?? '', /SHELL_REFUSED/)
      const iwr = await reg.invoke({
        id: '2',
        name: 'execute_terminal_command',
        arguments: {
          command:
            "Invoke-WebRequest -Uri 'https://github.com/niXman/mingw-builds-binaries/releases/download/x/mingw.7z' -OutFile mingw.7z"
        }
      })
      assert.equal(iwr.ok, false)
      assert.match(iwr.error ?? '', /SHELL_REFUSED/)
      const names = await fs.readdir(root)
      assert.equal(names.includes('mingw.7z'), false)
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
    assert.equal(hint, null)
    const page = '<!DOCTYPE html><html><body><h1>AFKLLM</h1></body></html>'
    const brokenOnPage = formatI18nSanityHint({ html: page, js: brokenJs })
    assert.match(brokenOnPage ?? '', /I18N_SANITY/)
    assert.match(brokenOnPage ?? '', /object Object/)
    assert.match(formatI18nCloserWhy(brokenOnPage!, 'ru'), /объект/)
    const okJs =
      "const t = { ru: { hero: 'Привет' }, en: { hero: 'Hello' } };\n" +
      "document.querySelector('[data-i18n=\"hero\"]').textContent = t[lang].hero;\n"
    assert.equal(jsI18nDictLooksBroken(okJs), false)
    assert.equal(formatI18nSanityHint({ js: okJs }), null)
    const html = '<!DOCTYPE html><html><body>' +
      '<h1 data-i18n="hero_title">AFKLLM</h1><p data-i18n="hero_sub">Local IDE</p>' +
      '</body></html>'
    const jsIds = "document.getElementById('hero-title').textContent = t.hero;\n" +
      "document.querySelector('#hero-subtitle').textContent = t.sub;\n"
    assert.equal(htmlJsI18nMismatch(html, jsIds), true)
    assert.match(formatI18nSanityHint({ html, js: jsIds }) ?? '', /do not rewrite JS/i)
    const landingHtml =
      '<!DOCTYPE html><html><body>' +
      '<nav><ul class="nav-links"></ul><button id="langToggle">EN</button></nav>' +
      '<h1 data-i18n="nav-how">Как</h1><p data-i18n="cta-download">Скачать</p>' +
      '<p data-i18n="features-title">Возможности</p><p data-i18n="why-title">Почему</p>' +
      '</body></html>'
    const landingJs =
      "const i18n = { ru: { 'nav-how-it-works': 'Как', 'btn-download': 'Скачать' } };\n" +
      "document.getElementById('lang-toggle').addEventListener('click', () => {});\n" +
      "document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = i18n.ru[el.getAttribute('data-i18n')]; });\n"
    assert.equal(htmlJsI18nMismatch(landingHtml, landingJs), true)
    assert.equal(htmlI18nKeysMissingFromJs(landingHtml, landingJs), true)
    assert.match(formatI18nSanityHint({ html: landingHtml, js: landingJs }) ?? '', /I18N_SANITY/)
  })

  it('does not treat textContent = value as [object Object]; flags split/filter', () => {
    assert.equal(
      jsAssignsNonStringToDom("el.textContent = t[key];\n"),
      false
    )
    assert.equal(
      jsAssignsNonStringToDom("el.textContent = value || t[key];\n"),
      false
    )
    assert.equal(
      jsAssignsNonStringToDom("item.textContent = feature;\n"),
      true
    )
    const splitJs =
      "const i18n = { ru: { hero_title: 'AFKLLM' } };\n" +
      "document.querySelectorAll('[data-i18n]').forEach(el => {\n" +
      "  const key = el.dataset.i18n;\n" +
      "  const t = i18n.ru;\n" +
      "  const value = t[key].split(' ').filter(w => w.startsWith('Чат') || '').join(' ');\n" +
      "  el.textContent = value || t[key];\n" +
      "});\n"
    assert.equal(jsI18nUsesDestructiveSplit(splitJs), true)
    assert.equal(jsI18nUsesDestructiveSplit("el.textContent = t[key];\n"), false)
    const hint = formatI18nSanityHint({ js: splitJs })
    assert.match(hint ?? '', /I18N_SANITY/)
    assert.match(hint ?? '', /split/i)
    const blamed = i18nSanityTargetPaths(hint!, { written: 'index.html' })
    assert.ok(blamed.includes('js/main.js'))
  })

  it('flags empty data-i18n shells that hide the page', () => {
    const emptyHtml =
      '<h1 data-i18n="hero.title"></h1><p data-i18n="hero.subtitle"></p>' +
      '<h3 data-i18n="feature1.title"></h3><p data-i18n="feature1.desc"></p>' +
      '<a data-i18n="hero.cta1">Download for Windows</a>'
    assert.equal(htmlHasEmptyI18nShells(emptyHtml), true)
    const emptyPage = `<!DOCTYPE html><html><body>${emptyHtml}</body></html>`
    const hint = formatI18nSanityHint({ html: emptyPage })
    assert.ok(hint)
    assert.match(hint!, /I18N_SANITY/)
    assert.match(hint!, /visible fallback/)
    assert.match(formatI18nCloserWhy(hint!, 'ru'), /пустые data-i18n/)
  })

  it('treats unquoted identifier keys as present', () => {
    const html =
      '<p data-i18n="heroSubtitle">x</p><a data-i18n="ctaDownload">y</a>' +
      '<h2 data-i18n="featuresTitle">z</h2>'
    const js =
      "const i18n = { ru: { heroSubtitle: 'a', ctaDownload: 'b', featuresTitle: 'c' }, en: { heroSubtitle: 'a', ctaDownload: 'b', featuresTitle: 'c' } };\n" +
      "el.textContent = dict[key];\n"
    assert.equal(htmlI18nKeysMissingFromJs(html, js), false)
    assert.equal(jsI18nDictLooksBroken(js), false)
    assert.equal(formatI18nSanityHint({ html, js }), null)
  })

  it('accepts the frozen landing-afkllm html+js pair', async () => {
    const dir = path.join(process.cwd(), 'scripts', 'fixtures', 'landing-afkllm')
    const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8')
    const js = await fs.readFile(path.join(dir, 'js', 'main.js'), 'utf8')
    assert.match(html, /data-i18n="heroSubtitle"/)
    assert.match(html, /data-lang="ru"/)
    assert.match(js, /heroSubtitle:\s*'/)
    assert.match(js, /const i18n = \{/)
    assert.equal(jsI18nDictLooksBroken(js), false)
    assert.equal(htmlI18nKeysMissingFromJs(html, js), false)
    assert.equal(htmlHasEmptyI18nShells(html), false)
    assert.equal(formatI18nSanityHint({ html, js }), null)
  })

  it('refuses invented tmp/check.js unless the user asked', () => {
    const landing = 'Сделай профессиональный лендинг для AFKLLM'
    assert.equal(inventedI18nVerifierPath('tmp/check.js', landing), true)
    assert.equal(inventedI18nVerifierPath('check.js', landing), true)
    assert.equal(inventedI18nVerifierPath('js/main.js', landing), false)
    assert.equal(inventedI18nVerifierPath('tmp/check.js', 'напиши tmp/check.js для аудита ключей'), false)
  })

  it('does not treat missing HTML ids as a JS bug before index.html exists', () => {
    const js =
      "document.getElementById('lang-switcher').addEventListener('click', () => {});\n" +
      "document.getElementById('download-cta').href = 'https://github.com';\n"
    assert.equal(formatI18nSanityHint({ js }), null)
    assert.equal(
      formatI18nSanityHint({ html: '<div id="app"></div>', js }),
      null
    )
    assert.match(formatLandingJsBeforeHtmlHint(), /LANDING_ORDER/)
    assert.match(formatLandingJsBeforeHtmlHint(), /Do NOT rewrite/)
  })
})

describe('landing write cap', () => {
  it('allows a second complete write_file (overwrite is allowed)', () => {
    assert.equal(
      shouldRefuseLandingRewrite({
        path: 'js/main.js',
        completeWritesThisTurn: 0,
        recoveryUsedOnPath: false,
        sanityFailedOnThisPath: false
      }),
      'ok'
    )
    assert.equal(
      shouldRefuseLandingRewrite({
        path: 'js/main.js',
        completeWritesThisTurn: 1,
        recoveryUsedOnPath: false,
        sanityFailedOnThisPath: false
      }),
      'ok'
    )
    assert.equal(
      shouldRefuseLandingRewrite({
        path: 'js/main.js',
        completeWritesThisTurn: 1,
        recoveryUsedOnPath: true,
        sanityFailedOnThisPath: true
      }),
      'ok'
    )
    assert.match(formatWriteOnceError('js/main.js'), /WRITE_ONCE/)
  })

  it('landingBundleReady when css+html+js each have a write', () => {
    const m = new Map<string, number>([
      ['styles.css', 1],
      ['index.html', 1],
      ['js/main.js', 1]
    ])
    assert.equal(landingBundleReady(m), true)
    assert.equal(landingBundleReady(new Map([['styles.css', 1]])), false)
  })

  it('stub CSS/SVG are not complete and do not lock WRITE_ONCE', () => {
    const stubCss = '/* AFKLLM landing */\n:root { --bg: #0a0a0f; }\n'
    const stubSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>\n'
    assert.equal(contentLooksStructurallyComplete(stubCss, 'styles.css'), false)
    assert.equal(contentLooksLikeSourceStub(stubCss, 'styles.css'), true)
    assert.equal(contentLooksStructurallyComplete(stubSvg, 'assets/icon-agent.svg'), false)
    assert.equal(
      shouldRefuseLandingRewrite({
        path: 'styles.css',
        completeWritesThisTurn: 0,
        recoveryUsedOnPath: false,
        sanityFailedOnThisPath: false
      }),
      'ok'
    )
    assert.match(formatStubOnDiskHint('styles.css', stubCss.length), /STUB_ON_DISK/)
    assert.match(formatStubOnDiskHint('styles.css', stubCss.length), /overwrite=true/)
  })
})

describe('Gemma 8k harness', () => {
  it('history compact waits for 99% of real ctx, not ~8k of a 131k window', () => {
    assert.equal(shouldCompactForOverflow(8_000, 131_072), false)
    assert.equal(shouldCompactForOverflow(8_000, 8_192), false)
    assert.equal(compactTokenThreshold(131_072), Math.floor(131_072 * 0.99))
    assert.equal(shouldCompactForOverflow(compactTokenThreshold(131_072), 131_072), true)
    assert.equal(shouldCompactForOverflow(compactTokenThreshold(8_192) - 1, 8_192), false)
    assert.equal(shouldCompactForOverflow(compactTokenThreshold(8_192), 8_192), true)
  })

  it('maxTokensForAgent uses leftover ctx, not another 8192', () => {
    const n = maxTokensForAgent(8192, 5500)
    assert.equal(n, 8192 - 5500 - 256)
    assert.ok(n < 8192)
    assert.ok(n <= 4096)
    assert.equal(maxTokensForAgent(8192, 8000), 256)
    assert.equal(maxTokensForAgent(32768, 4000), 4096)
  })

  it('from-scratch apply_diff on missing js/main.js requires write_file', () => {
    assert.equal(
      shouldRequireWriteFileForApply({
        fromScratch: true,
        path: 'js/main.js',
        completeWritesThisTurn: 0
      }),
      true
    )
    assert.match(formatWriteFileRequiredError('js/main.js'), /WRITE_FILE_REQUIRED/)
    assert.equal(
      shouldRequireWriteFileForApply({
        fromScratch: true,
        path: 'js/main.js',
        completeWritesThisTurn: 1
      }),
      false
    )
    assert.equal(
      shouldRequireWriteFileForApply({
        fromScratch: false,
        path: 'js/main.js',
        completeWritesThisTurn: 0
      }),
      false
    )
  })
})

describe('edit sanity + html-only stacks', () => {
  it('flags unbound JSX click handlers before a playable closer', () => {
    const src = `export default function App() {
  const [cast, setCast] = useState(false)
  const castLine = () => setCast(true)
  return <div className="water">click the water</div>
}`
    assert.deepEqual(unboundJsxClickHandlers(src), ['castLine'])
    assert.equal(
      formatEditSanityHint({
        path: 'package.json',
        content: '{\n  "name": "fishing-game",\n  "scripts": { "dev": "vite" }\n}\n'
      }),
      null
    )
    assert.equal(
      formatEditSanityHint({
        path: 'package.json',
        content:
          'import React from "react"\nexport default function App(){return <button onClick={cast} />}'
      }),
      null
    )
    const hint = formatEditSanityHint({ path: 'src/App.jsx', content: src, js: src })
    assert.ok(hint)
    assert.match(hint!, /EDIT_SANITY/)
    assert.match(hint!, /castLine/)
    const wired = src.replace(
      '<div className="water">click the water</div>',
      '<div className="water" onClick={castLine}>click the water</div>'
    )
    assert.deepEqual(unboundJsxClickHandlers(wired), [])
    assert.equal(
      formatEditSanityHint({ path: 'src/App.jsx', content: wired, js: wired }),
      null
    )
  })

  it('does not treat PascalCase FishingGame as an unbound click handler', () => {
    const src = `const FishingGame = () => {
  const handleCast = () => {}
  return <button onClick={handleCast}>Забросить</button>
}
export default FishingGame`
    assert.deepEqual(unboundJsxClickHandlers(src), [])
    assert.equal(formatEditSanityHint({ path: 'src/App.jsx', content: src, js: src }), null)
  })

  it('flags unplayable fishing JSX: nested #root, emoji SVG fill, bobber teleported offscreen', () => {
    const src = `export default function App() {
  const [bobberPos, setBobberPos] = useState({ x: '50%', y: '75%' })
  const handleBobberClick = () => setBobberPos({ x: '-100%', y: '-100%' })
  return (
    <div id="root">
      <svg><path fill={f.emoji} /></svg>
      <div className="hook-bobber" onClick={handleBobberClick} />
    </div>
  )
}`
    assert.equal(jsxNestsHtmlRootId(src), true)
    assert.equal(jsxUsesEmojiAsSvgFill(src), true)
    assert.equal(jsxTeleportsControlOffscreen(src), true)
    const hint = formatEditSanityHint({ path: 'src/App.jsx', content: src, js: src })
    assert.ok(hint)
    assert.match(hint!, /EDIT_SANITY/)
    assert.match(hint!, /id="root"/)
    assert.match(hint!, /emoji/)
    assert.match(hint!, /-100%/)
  })

  it('flags Vite script src vs App.jsx and JSX/CSS class mismatch', () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<div id="root"></div>' +
      '<script type="module" src="/src/main.jsx"></script>' +
      '</body></html>'
    const jsx =
      'import React from "react"\n' +
      'export default function App(){\n' +
      '  return <div className="container"><div className="fishing-area"><span className="hook">hook</span></div></div>\n' +
      '}\n'
    const css =
      '.game-container{display:flex}.hook-line{height:40px}.float-bobber{animation:bob 1s infinite}' +
      '.score-board{color:#fff}.cast-btn{padding:8px}\n'
    assert.equal(viteHtmlEntryMismatch(html, 'App.jsx'), null)
    assert.equal(viteHtmlEntryMismatch(html.replace('/src/main.jsx', '/App.jsx'), 'App.jsx'), null)
    assert.equal(viteHtmlEntryMismatch(html, 'src/game.jsx'), '/src/main.jsx')
    const missing = jsxCssClassMismatch(jsx, css)
    assert.ok(missing.includes('container'))
    assert.ok(missing.includes('fishing-area'))
    const hint = formatEditSanityHint({
      path: 'index.html',
      content: html,
      html,
      js: jsx,
      jsPath: 'App.jsx',
      css,
      cssPath: 'App.css'
    })
    assert.ok(hint)
    assert.doesNotMatch(hint!, /script src/)
    assert.match(hint!, /className/)
  })

  it('does not treat Vite+React as an HTML landing; flags phantom index.css', () => {
    const brief =
      'Собери с нуля в корне этой папки игру на React (Vite + React), не HTML-лендинг.'
    const dumpHtml =
      '<!DOCTYPE html><html><body><div id="root">' +
      '<h1 data-i18n="gameTitle">Рыбалка</h1><button data-i18n="castButton">Забросить</button>' +
      '</div><script type="module" src="/src/main.jsx"></script></body></html>'
    const viteCfg =
      "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n"
    const mainJsx =
      "import { createRoot } from 'react-dom/client'\nimport './index.css'\nimport App from './App.jsx'\n"
    assert.equal(looksLikeViteReactTask(brief), true)
    assert.equal(isViteConfigPath('vite.config.js'), true)
    assert.equal(isLandingPageScriptPath('vite.config.js'), false)
    assert.equal(isLandingPageScriptPath('js/main.js'), true)
    assert.equal(isLandingPageScriptPath('src/main.jsx'), false)
    assert.equal(viteReactHtmlLooksLikePageDump(dumpHtml), true)
    assert.equal(
      formatI18nSanityHint({
        html: dumpHtml,
        js: viteCfg,
        jsPath: 'vite.config.js',
        userText: brief
      }),
      null
    )
    assert.equal(formatI18nSanityHint({ html: dumpHtml, userText: brief }), null)
    const dumpHint = formatEditSanityHint({
      path: 'index.html',
      content: dumpHtml,
      html: dumpHtml,
      userText: brief
    })
    assert.ok(dumpHint)
    assert.match(dumpHint!, /EDIT_SANITY/)
    assert.match(dumpHint!, /thin shell|App\.jsx/i)
    assert.doesNotMatch(dumpHint!, /I18N_SANITY/)
    assert.deepEqual(jsxMissingCssImports(mainJsx, 'src/App.css'), ['./index.css'])
    const cssHint = formatEditSanityHint({
      path: 'src/main.jsx',
      content: mainJsx,
      js: mainJsx,
      css: '.app{display:flex}\n.water{height:40vh}\n.cast-btn{padding:8px}\n',
      cssPath: 'src/App.css',
      userText: brief
    })
    assert.ok(cssHint)
    assert.match(cssHint!, /index\.css/)
    assert.equal(
      isFluffPlanStep('План действий для сборки React-игры "Рыбалка" на Vite + React:'),
      true
    )
    assert.equal(
      isJunkPlanStep('Каждый шаг создаёт файлы в зависимости друг от друга: сначала конфигурация, потом HTML'),
      true
    )
    const t06 =
      'Собери с нуля в корне этой папки игру на React (Vite + React), тема — рыбалка. Запусти npm run dev или открой превью.'
    assert.equal(looksLikeViteReactFromScratch(t06), true)
    assert.equal(looksLikeFromScratchTask(t06), true)
    assert.equal(userAskedViteReactPreview(t06), true)
    assert.equal(looksLikeDevOrPreviewCommand('npm run dev'), true)
    assert.equal(looksLikeDevOrPreviewCommand('npm install'), false)
    assert.equal(
      shellResultOpenedPreview(
        'VITE ready\nLocal: http://127.0.0.1:4173/\nexit_code=0\nPREVIEW_URL: http://127.0.0.1:4173/ (opened in AFKLLM Browser)'
      ),
      true
    )
    assert.equal(
      shellResultOpenedPreview('  ➜  Local:   http://127.0.0.1:4173/\n'),
      true
    )
    assert.equal(shellResultOpenedPreview('npm install\nexit_code=0'), false)
    assert.equal(
      markPreviewFromShell({
        command: 'npm run dev',
        content: 'Выполнил npm run dev',
        ok: true
      }),
      true
    )
    assert.equal(
      markPreviewFromShell({
        command: 'npm install',
        content: 'added 65 packages\nexit_code=0',
        ok: true
      }),
      false
    )
    assert.deepEqual(
      jsxMissingCssImports("import './App.css'\nexport default function App(){return null}\n", ''),
      []
    )
    assert.equal(
      looksLikeViteReactFromScratch('Fix the broken hook in the existing Vite React game'),
      false
    )
    assert.deepEqual(
      viteReactScaffoldMissing([
        'package.json',
        'vite.config.js',
        'src/App.css',
        'src/main.jsx'
      ]),
      ['index.html', 'app']
    )
    assert.deepEqual(
      viteReactScaffoldMissing([
        'package.json',
        'vite.config.ts',
        'index.html',
        'src/main.jsx',
        'src/App.jsx'
      ]),
      []
    )
    assert.ok(
      collectPathsFromTreeText('src/main.jsx\npackage.json\nvite.config.js').includes(
        'src/main.jsx'
      )
    )
    assert.match(formatViteReactScaffoldHint(['index.html', 'app']), /VITE_REACT_INCOMPLETE/)
    assert.match(formatViteReactScaffoldHint(['index.html', 'app']), /App\.jsx/)
    const reopened = reopenTodosForMissingViteReact(
      [
        { id: 's5', text: 'Создать index.html — пустой div #root', status: 'done' },
        { id: 's7', text: 'Создать src/App.jsx — игровая механика', status: 'done' },
        { id: 's4', text: 'Создать package.json', status: 'done' }
      ],
      ['index.html', 'app']
    )
    assert.equal(reopened[0]!.status, 'in_progress')
    assert.equal(reopened[1]!.status, 'in_progress')
    assert.equal(reopened[2]!.status, 'done')
  })

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
    assert.match(htmlHint, /instruction/)
    assert.doesNotMatch(htmlHint, /write_file overwrite=true with the FULL/)
    const themeHint = formatSurgicalFollowUpHint({
      stacks: [
        {
          id: 'html',
          label: 'HTML',
          markers: ['index.html'],
          sourceGlobs: [],
          ignoreDirs: []
        }
      ],
      i18nFix: false,
      themeToggle: true
    })
    assert.match(themeHint, /apply_diff with a short instruction/)
    assert.match(themeHint, /Do NOT rewrite js\/main\.js/)
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
    const splitHtml =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head>' +
      '<body><header class="site-header"><a class="brand">' +
      '<svg class="brand-icon" viewBox="0 0 32 32"></svg></a>' +
      '<nav class="header-nav"><a class="nav-link">Features</a></nav>' +
      '<button id="langToggle" class="lang-btn">EN</button></header>' +
      '<section class="hero"><div class="hero-inner"><h1 class="hero-title">AFKLLM</h1></div></section>' +
      '</body></html>'
    const splitCss =
      '.navbar { display:flex } .nav-links { display:flex; list-style:none } ' +
      '.hero { min-height:80vh } .hero-content { z-index:1 } .hero-buttons { display:flex } ' +
      '.nav-logo { font-weight:800 }\n'
    assert.equal(htmlCssLayoutMismatch(splitHtml, splitCss), true)
    assert.equal(inlineSvgLooksUnsized(splitHtml, splitCss), true)
    const splitHint =
      formatEditSanityHint({
        path: 'index.html',
        content: splitHtml,
        html: splitHtml,
        css: splitCss,
        cssPath: 'styles.css'
      }) ?? ''
    assert.match(splitHint, /EDIT_SANITY/)
    assert.match(splitHint, /class names are not in CSS/)
    assert.match(splitHint, /svg/)
    const alignedHtml =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head>' +
      '<body><nav class="navbar"><ul class="nav-links"><li><a>x</a></li></ul></nav>' +
      '<section class="hero"><div class="hero-content"><h1>AFKLLM</h1>' +
      '<div class="hero-buttons"><a class="btn-primary">Download</a></div></div></section>' +
      '</body></html>'
    const alignedCss =
      '.navbar { display:flex } .nav-links { display:flex; list-style:none } ' +
      '.hero { min-height:80vh } .hero-content { z-index:1 } .hero-buttons { display:flex } ' +
      '.btn-primary { background:#6c63ff }\n'
    assert.equal(htmlCssLayoutMismatch(alignedHtml, alignedCss), false)
    assert.equal(inlineSvgLooksUnsized(alignedHtml, alignedCss), false)
    const contract = formatLandingCssContractHint(alignedCss)
    assert.ok(contract)
    assert.match(contract!, /LANDING_CONTRACT/)
    assert.match(contract!, /\.navbar/)
    const navContainerCss =
      '.nav-container { display:flex } .hero { min-height:80vh } .hero-title { font-size:4rem } ' +
      '.btn-primary { background:#6c63ff } .feature-grid { display:grid } .footer { padding:2rem } ' +
      '.section { padding:4rem }\n'
    const ownContract = formatLandingCssContractHint(navContainerCss)
    assert.ok(ownContract)
    assert.match(ownContract!, /\.nav-container/)
    assert.doesNotMatch(ownContract!, /\.navbar/)
    const urlCss =
      '.hero { background: url("assets/hero.svg"); min-height:80vh } ' +
      '.hero-content { z-index:1 } .hero-title { font-size:4rem } ' +
      '.btn-primary { background:#6c63ff } .feature-grid { display:grid } .footer { padding:2rem }\n'
    const names = extractCssClassNames(urlCss)
    assert.ok(names.includes('hero'))
    assert.ok(!names.includes('svg'))
    const urlContract = formatLandingCssContractHint(urlCss)
    assert.ok(urlContract)
    assert.doesNotMatch(urlContract!, /\.svg\b/)
  })

  it('flags a feature-card dump when the user forbade AI cards', () => {
    const prompt = 'Сделай лендинг без «AI-карточного» мусора, один сильный hero.'
    assert.equal(looksLikeNoCardDumpRequest(prompt), true)
    const cards =
      '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body>' +
      '<section class="hero"><h1>AFKLLM</h1></section>' +
      '<section id="features">' +
      '<div class="feature-card">a</div><div class="feature-card">b</div>' +
      '<div class="feature-card">c</div><div class="feature-card">d</div>' +
      '<div class="why-card">e</div></section></body></html>'
    const hint =
      formatEditSanityHint({
        path: 'index.html',
        content: cards,
        html: cards,
        css: '.hero { min-height:80vh } .feature-card { padding:1rem } .why-card { padding:1rem }\n',
        userText: prompt
      }) ?? ''
    assert.match(hint, /EDIT_SANITY/)
    assert.match(hint, /card/i)
  })
})

describe('PowerShell curl alias', () => {
  it('drops the IWR curl alias in PTY init and runShell prefix', () => {
    assert.match(POWERSHELL_UNALIAS_CURL, /alias:curl/)
    assert.match(POWERSHELL_UNALIAS_CURL, /alias:where/)
    assert.match(POWERSHELL_AGENT_PTY_INIT, /alias:curl/)
    assert.match(POWERSHELL_AGENT_PTY_INIT, /alias:where/)
    assert.match(POWERSHELL_AGENT_PTY_INIT, /PSReadLine/)
  })
})

describe('composer apply handoff', () => {
  const themeAsk = 'Добавь переключатель темы лендинга (белый/темный)'
  const fromScratch =
    'Сделай полноценный профессиональный многофайловый лендинг продукта AFKLLM. '.repeat(8) +
    'Язык лендинга: русский + английский переключатель. С нуля.'

  it('theme follow-up on existing js/main.js hands off to apply_diff instruction', () => {
    assert.equal(looksLikeThemeToggleRequest(themeAsk), true)
    assert.equal(looksLikeExplicitRewrite(themeAsk), false)
    assert.equal(
      shouldHandoffWriteToApply({ userText: themeAsk, relativePath: 'js/main.js' }),
      true
    )
    assert.equal(isComposerApplyPath('js/main.js'), true)
    const args = buildApplyHandoffArgs({
      relativePath: 'js/main.js',
      userText: themeAsk,
      content: 'function themeToggle() { document.body.dataset.theme = "dark"; }\n'
    })
    assert.equal(args.relative_path, 'js/main.js')
    assert.match(String(args.instruction), /переключатель темы/)
    assert.match(String(args.instruction), /Edit this file only/)
    assert.doesNotMatch(String(args.instruction), /FILE_COMPLETE/)
  })

  it('from-scratch landing brief does not hand off write_file of new modules', () => {
    assert.equal(looksLikeFromScratchTask(fromScratch), true)
    assert.equal(allowsComposerFullRewrite(fromScratch), true)
    assert.equal(
      shouldHandoffWriteToApply({ userText: fromScratch, relativePath: 'js/main.js' }),
      false
    )
    assert.equal(
      shouldHandoffWriteToApply({ userText: fromScratch, relativePath: 'index.html' }),
      false
    )
    assert.equal(
      shouldHandoffWriteToApply({ userText: fromScratch, relativePath: 'css/styles.css' }),
      false
    )
    assert.equal(
      shouldBlockSurgicalOverwrite({
        userText: fromScratch,
        relativePath: 'css/styles.css',
        overwrite: true
      }),
      false
    )
  })

  it('finish-missing HTML/CSS is not surgical CSS on an empty disk', () => {
    const finish = 'не трогай JS, допиши index.html и styles.css'
    assert.equal(looksLikeFinishMissingLandingFiles(finish), true)
    assert.equal(looksLikeFromScratchTask(finish), true)
    assert.equal(looksLikeSurgicalFollowUp(finish), false)
    assert.equal(allowsComposerFullRewrite(finish), true)
    assert.equal(
      shouldHandoffWriteToApply({ userText: finish, relativePath: 'styles.css' }),
      false
    )
    assert.equal(shouldBlockSurgicalCssRewrite({ userText: finish, cssOnDisk: '' }), false)
    assert.equal(
      shouldBlockSurgicalCssRewrite({
        userText: finish,
        cssOnDisk: '/* stub */\n:root { --x: 1; }\n'
      }),
      false
    )
    const realCss =
      ':root { --bg: #0a0a0f; --fg: #e8e8ef; --accent: #7c3aed; --muted: #9ca3af; }\n' +
      'body { margin: 0; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; line-height: 1.6; }\n' +
      '.navbar { display: flex; gap: 16px; align-items: center; padding: 12px 24px; backdrop-filter: blur(16px); }\n' +
      '.hero { min-height: 70vh; padding: 80px 24px; background: radial-gradient(ellipse at top, #1a1030, #0a0a0f); }\n' +
      '.feature-card { border-radius: 12px; backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.08); padding: 24px; }\n'
    assert.equal(cssLooksLikeRealStylesheet(realCss), true)
    assert.equal(
      shouldBlockSurgicalCssRewrite({
        userText: 'поправь только navbar в styles.css без полной переписи',
        cssOnDisk: realCss
      }),
      true
    )
    assert.equal(
      shouldBlockSurgicalOverwrite({
        userText: finish,
        relativePath: 'styles.css',
        overwrite: true
      }),
      false
    )
  })

  it('long landing rebuild without «с нуля» still skips Apply handoff', () => {
    const user =
      'Сделай полноценный профессиональный многофайловый лендинг продукта AFKLLM. ' +
      'Герой, фичи, как это работает, CTA, футер. Факты только из GitHub README. ' +
      'Структура: index.html, styles.css, js/main.js, assets/. ' +
      'Пиши файлы по ходу и в порядке зависимостей: сначала CSS/JS/assets, потом index.html со ссылками. ' +
      'После сборки открой index.html в браузере. Язык: русский + английский переключатель. ' +
      'Современный dark landing, выразительная типографика, адаптив desktop+mobile.'
    assert.ok(user.length > 400)
    assert.equal(looksLikeFromScratchTask(user), true)
    assert.equal(
      shouldHandoffWriteToApply({ userText: user, relativePath: 'css/styles.css' }),
      false
    )
  })

  it('landing plan lists CSS/JS/assets before index.html when the user asked dependency order', () => {
    const user =
      'Сделай полноценный профессиональный многофайловый лендинг продукта AFKLLM. ' +
      'Пиши файлы по ходу и в порядке зависимостей: сначала CSS/JS/assets, потом index.html. ' +
      'Hero, Features, How it works, CTA, Footer. Dark theme, адаптив, README.'
    const coerced = coerceProductPlan(
      [
        {
          id: '1',
          text: 'Написать index.html — собрать все секции: Hero, Features, How it works, Why local, Download, Footer.',
          status: 'pending'
        },
        {
          id: '2',
          text: 'Создать структуру проекта: assets/, css/, js/.',
          status: 'pending'
        },
        {
          id: '3',
          text: 'Написать styles.css — dark theme, типографика, анимации, адаптив.',
          status: 'pending'
        },
        {
          id: '4',
          text: 'Написать js/main.js — переключатель языков, плавная прокрутка.',
          status: 'pending'
        },
        {
          id: '5',
          text: 'Создать SVG-иконки в assets/ для визуализации фич.',
          status: 'pending'
        },
        {
          id: '6',
          text: 'Создать README.md лендинга с инструкциями.',
          status: 'pending'
        },
        {
          id: '7',
          text: 'Открыть index.html в браузере для проверки.',
          status: 'pending'
        }
      ],
      { userText: user }
    )
    const idx = (re: RegExp) => coerced.findIndex((s) => re.test(s.text))
    const structure = idx(/структуру проекта/)
    const css = idx(/styles\.css/)
    const js = idx(/main\.js/)
    const html = idx(/index\.html — собрать/)
    const preview = idx(/браузер/)
    assert.ok(structure >= 0 && css >= 0 && js >= 0 && html >= 0 && preview >= 0)
    assert.ok(structure < css)
    assert.ok(css < js)
    assert.ok(js < html)
    assert.ok(html < preview)
    assert.equal(coerced[0]!.status, 'in_progress')
  })

  it('plan card JSON can mark the header failed without unchecking rows', () => {
    const raw = formatTodoUiContent(
      [{ id: 's1', text: 'Написать styles.css', status: 'done' }],
      { failed: true }
    )
    assert.equal(parseTodoUiFailed(raw), true)
    assert.equal(parseTodoUiContent(raw)?.[0]?.status, 'done')
    assert.equal(parseTodoUiFailed(formatTodoUiContent([{ id: 's1', text: 'x', status: 'done' }])), false)
  })

  it('plan card failed flag clears after a later successful edit', () => {
    const steps = [{ id: 's1', text: 'Написать styles.css', status: 'done' as const }]
    assert.equal(todoCardFailed({ mutatingEditFailed: true, mutatingEditOk: false }), true)
    assert.equal(todoCardFailed({ mutatingEditFailed: true, mutatingEditOk: true }), false)
    assert.equal(todoCardFailed({ mutatingEditFailed: false, mutatingEditOk: true }), false)
    const afterFail = formatTodoUiContent(steps, {
      failed: todoCardFailed({ mutatingEditFailed: true, mutatingEditOk: false })
    })
    assert.equal(parseTodoUiFailed(afterFail), true)
    const afterOk = formatTodoUiContent(steps, {
      failed: todoCardFailed({ mutatingEditFailed: true, mutatingEditOk: true })
    })
    assert.equal(parseTodoUiFailed(afterOk), false)
  })

  it('does not dump a whole module into the Apply instruction', () => {
    const dump =
      '(function () {\n' +
      '  const a = 1;\n  function foo() { return a; }\n  const b = 2;\n  function bar() { return b; }\n'.repeat(
        80
      ) +
      '})();\n'
    const instruction = formatApplyHandoffInstruction({
      userText: themeAsk,
      relativePath: 'js/main.js',
      snippet: dump
    })
    assert.ok(instruction.length < dump.length)
    assert.doesNotMatch(instruction, /Suggested fragment/)
  })

  it('complete HTML buffer does not mark js/main.js complete', () => {
    const html =
      '<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>\n'
    assert.equal(
      priorCompleteForWritePath({
        relativePath: 'js/main.js',
        lastHtml: html,
        lastJs: '',
        lastCss: ''
      }),
      false
    )
    assert.equal(
      priorCompleteForWritePath({
        relativePath: 'index.html',
        lastHtml: html,
        lastJs: '',
        lastCss: ''
      }),
      true
    )
    const js =
      '(function () {\n  const x = 1;\n  function init() { return x; }\n  init();\n})();\n'
    assert.equal(
      priorCompleteForWritePath({
        relativePath: 'js/main.js',
        lastHtml: html,
        lastJs: js,
        lastCss: ''
      }),
      true
    )
  })

  it('does not persist truncated writes onto a complete file', () => {
    assert.equal(shouldPersistIncompleteWrite({ knownComplete: true }), false)
    assert.equal(shouldPersistIncompleteWrite({ knownComplete: false }), true)
  })

  it('isWholeFileSearchBlock still rejects apply_diff of the whole file', () => {
    const html =
      '<!DOCTYPE html><html><head><title>AFKLLM</title></head><body>' +
      '<p>' +
      'section '.repeat(200) +
      '</p></body></html>\n'
    assert.equal(isWholeFileSearchBlock(html.length, html.length), true)
    assert.equal(isWholeFileSearchBlock(40, html.length), false)
  })

  it('keeps file-work nudge after CSS/JS writes when index.html is still open', () => {
    assert.equal(isFileWorkPlanStep('Write index.html — full landing structure'), true)
    assert.equal(isFileWorkPlanStep('Write README.md — brief instructions'), true)
    assert.equal(isFileWorkPlanStep('web_search for weather'), false)
    assert.equal(
      shouldNudgeRemainingFileWork({
        fileWorkCount: 2,
        completedTools: 7,
        landingComplete: false,
        missingNamedFiles: true,
        surgicalFollowUp: false,
        mutatingEditOk: true,
        planFinishNudges: 0
      }),
      true
    )
    assert.equal(
      shouldNudgeRemainingFileWork({
        fileWorkCount: 1,
        completedTools: 1,
        landingComplete: true,
        missingNamedFiles: false,
        surgicalFollowUp: false,
        mutatingEditOk: true,
        planFinishNudges: 0
      }),
      false
    )
    assert.equal(
      shouldNudgeRemainingFileWork({
        fileWorkCount: 1,
        completedTools: 1,
        landingComplete: false,
        missingNamedFiles: true,
        surgicalFollowUp: true,
        mutatingEditOk: true,
        planFinishNudges: 0
      }),
      false
    )
  })
})

