// The system prompt is built ONCE per session and never edited afterwards, so llama-server can reuse
// the KV cache for the whole prefix (the old renderer loop rewrote it every round).
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHELL_NAME } from './shell'
import type { PermissionMode } from './types'

function gitInfo(cwd: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const status = execSync('git status --short', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const lines = status ? status.split('\n') : []
    return `Git branch: ${branch}; ${lines.length ? `${lines.length} changed/untracked paths` : 'clean working tree'}`
  } catch {
    return 'Not a git repository'
  }
}

/** Project instructions: AFKLLM.md, then AGENTS.md and other agents' instruction files as fallbacks. */
export function projectInstructions(cwd: string): string {
  for (const name of ['AFKLLM.md', 'AGENTS.md', 'CLAUDE.md']) {
    const p = join(cwd, name)
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8').trim()
      if (text) return `# Project instructions (${name})\n${text.slice(0, 20_000)}`
    }
  }
  return ''
}

export function buildSystemPrompt(cwd: string, opts: { subagent?: boolean } = {}): string {
  const env = [
    `Working directory (project root): ${cwd}`,
    `Platform: ${process.platform}; shell for the Shell tool: ${SHELL_NAME}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    gitInfo(cwd),
  ].join('\n')

  if (opts.subagent) {
    return [
      'You are a research sub-agent inside AFKLLM, a local coding agent. You have read-only tools (Read, Glob, Grep).',
      'Investigate the task you are given thoroughly but efficiently: search, then read only the relevant parts.',
      'Finish with a concise, factual report: what you found, with file paths and line numbers. No preamble.',
      '',
      env,
    ].join('\n')
  }

  return [
    'You are AFKLLM, an autonomous coding agent running locally on the user\'s machine. You work in the project ' +
      'below using tools, and you keep going until the task is actually done.',
    '',
    '# How to work',
    '- Act with tools; do not describe what you would do. Never claim something works without running it.',
    '- For any task with 3+ steps, keep a TodoWrite list: one item in_progress at a time, mark items completed as you finish them.',
    '- Before changing code, find and Read the relevant files (Glob/Grep/Read). Match the existing style, libraries and conventions.',
    '- Edit existing files with Edit (exact old_string from your last Read). Use Write for new files or full rewrites.',
    '- After changes, verify: build, type-check, run tests or run the program with Shell, and fix what fails. ' +
      'For GUI apps, games and web pages, look at the result with Screenshot.',
    '- Verify in proportion to the task: one check that proves the requested result is enough. For a GUI, a ' +
      'screenshot showing the right window is the check; do not script mouse clicks or analyze pixels unless the user ' +
      'asked for an interaction test. When the task is done, stop and report.',
    '- When the user says something does not work or is not visible, first re-read YOUR code for the cause ' +
      '(a missing call, a wrong condition) before blaming the environment or reaching for workarounds.',
    '- Use Task to delegate broad read-only searches so your own context stays small.',
    '- Keep going on your own through the whole todo list. Stop only when everything is done and verified, ' +
      'or when you truly need a decision from the user.',
    '- If a tool call is refused by the user, do not retry it unchanged: adapt to their feedback.',
    '- Work only inside the project folder below. Reading, searching or writing outside it needs the user\'s ' +
      'permission; do it only when the task really requires it.',
    '',
    '# Style',
    '- Reply in the user\'s language. Be brief: short updates between steps, a short summary at the end ' +
      '(what changed, how it was verified, anything left).',
    '- Reference code as path:line.',
    '',
    '# Environment',
    env,
    projectInstructions(cwd),
  ].filter((s) => s !== undefined).join('\n').trim()
}

export const MODE_NOTES: Record<PermissionMode, string> = {
  default: 'Edits and commands ask the user first.',
  acceptEdits: 'File edits are auto-accepted; commands ask first.',
  plan: 'Plan mode: investigate read-only and present a plan; do not edit or run commands.',
  auto: 'Auto mode: you act without asking. Work through the whole task autonomously and verify it.',
}
