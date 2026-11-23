// DeepSeek Harness hooks in the style of Claude Code (PreToolUse / PostToolUse / Stop), on the Harness's own
// extension points: tools.guard() + tools/pre-execute, tools/post-execute, agent/turn-stopping, fs/*-intent.
//
// Built in (each can be turned off in the row config):
//   guard      deny commands that wreck the PC or the repo (delete a drive / the profile, format, diskpart, reboot,
//              Defender off, HKLM deletes) and ask before history-losing git (push --force, reset --hard, clean -f,
//              branch -D) and download-and-run (iwr | iex, curl | sh). Also keeps the agent off the hook settings.
//   check      after every edit/write/apply_patch: syntax check of the changed files (Python, JS, TypeScript with the
//              project's own typescript, JSON, PowerShell, merge-conflict markers, plus `checkers` from the config);
//              errors are appended to the tool result, so the model fixes them on the next step.
//   stopCheck  when the agent wants to end its turn: the files it edited this turn are checked again; if one is still
//              broken, the agent is sent back to fix it (at most stopMaxContinues times per turn).
//   notify     a Windows notification "DeepSeek Harness: готово" when a turn took at least notify.minSeconds.
// Your own hooks: ~/.dsh/hooks.json (yours) and <project>/.dsh/hooks.json (runs only after `/hooks trust`, and again
// after every change of the file), the format of Claude Code's "hooks" section:
//   { "hooks": { "PreToolUse":  [ { "matcher": "Bash|pwsh", "hooks": [ { "type": "command", "command": "...", "timeout": 30 } ] } ],
//                "PostToolUse": [ { "matcher": "Edit|Write", "hooks": [ ... ] } ],
//                "Stop":        [ { "hooks": [ { "type": "command", "command": "npm test", "timeout": 600 } ] } ] } }
// A command gets the event as JSON on stdin (hook_event_name, tool_name, tool_input, tool_response, cwd, session_id,
// stop_hook_active, edited_files) and runs through cmd.exe in the project folder (env DSH_PROJECT_DIR and
// CLAUDE_PROJECT_DIR). Exit 2 = block: PreToolUse denies the call with stderr as the reason, PostToolUse hands stderr
// to the model, Stop sends the agent back with stderr. JSON on stdout works too ({"decision":"block","reason":...},
// hookSpecificOutput.permissionDecision allow|deny|ask, hookSpecificOutput.additionalContext). Other exit codes are
// errors shown in /hooks, the agent goes on. Stop hooks run only in turns that edited files unless "always": true.
// Matchers are regexes over the Harness tool name and its Claude Code alias (Bash, Edit, Write, Read, Glob, Grep...).
// /hooks shows what is active and the last runs; /hooks trust | untrust for the project file.
// Nothing leaves the PC: hooks run local commands only.
// Mount: cordis.patch.yml row { id: hooks-afkllm, name: dsh-hooks-afkllm, config: {...} }.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

export const name = 'hooks-afkllm'
export const inject = ['tools', 'commands']

const HOME = homedir()
const DSH_HOME = process.env.DSH_HOME ?? join(HOME, '.dsh')
const OUT_CAP = 6000

// ---------------------------------------------------------------------------------------------- helpers

/** Tool arguments arrive parsed; older paths may hand the JSON string. */
export function toolArgs(exec) {
  const a = exec?.arguments
  if (typeof a === 'string') { try { return JSON.parse(a) } catch { return {} } }
  return a && typeof a === 'object' ? a : {}
}

const SHELL_TOOLS = new Set(['pwsh', 'bash', 'exec', 'shell', 'powershell'])
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'edit_file', 'write_file', 'multi_edit'])
const CC_ALIAS = {
  pwsh: 'Bash', bash: 'Bash', exec: 'Bash', shell: 'Bash', powershell: 'Bash',
  edit: 'Edit', apply_patch: 'Edit', edit_file: 'Edit', multi_edit: 'MultiEdit', write: 'Write', write_file: 'Write',
  read: 'Read', glob: 'Glob', grep: 'Grep', web_fetch: 'WebFetch', web_search: 'WebSearch', todo_write: 'TodoWrite',
}

/** Claude Code matcher: empty or "*" = all, else a regex over the whole tool name (Harness name or CC alias). */
export function matchTool(matcher, toolName) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  let re
  try { re = new RegExp(`^(?:${matcher})$`, 'i') } catch { return matcher === toolName }
  return re.test(toolName) || (CC_ALIAS[toolName] !== undefined && re.test(CC_ALIAS[toolName]))
}

const cut = (s, n = OUT_CAP) => (s.length > n ? `${s.slice(0, n)}\n... (обрезано, ${s.length - n} симв.)` : s)

// ---------------------------------------------------------------------------------------------- guard

const ROOT_TARGET = String.raw`(?:[a-z]:[\\/]?\*?|[a-z]:[\\/](?:windows|users|program files(?: \(x86\))?|programdata)[\\/]?\*?|~[\\/]?\*?|\/\*?|\$home[\\/]?\*?|\$env:(?:userprofile|systemroot|windir|systemdrive|homedrive|programfiles)[\\/]?\*?|%(?:userprofile|systemroot|windir|systemdrive)%[\\/]?\*?)`
const DENY = [
  [new RegExp(String.raw`\b(?:rm|remove-item|ri|del|erase|rd|rmdir)\b[^|;&\n]*?(?:^|\s)["']?${ROOT_TARGET}["']?(?=\s|$|;|\||&|\))`, 'i'),
    'recursive delete of a drive root, Windows, Program Files or the user profile'],
  [/\b(?:format(?:\.com)?\s+[a-z]:|format-volume|clear-disk|initialize-disk|remove-partition|diskpart|mkfs(?:\.\w+)?|dd\s+[^\n]*\bof=\/dev\/)/i, 'formatting or repartitioning a disk'],
  [/\b(?:bcdedit|vssadmin\s+delete|wmic\s+shadowcopy\s+delete|cipher\s+\/w)\b/i, 'boot configuration / shadow copies / wiping free space'],
  [/\b(?:stop-computer|restart-computer|shutdown(?:\.exe)?\s+[/-][srpfh]|logoff)\b/i, 'shutting down, rebooting or logging off the PC'],
  [/\b(?:reg(?:\.exe)?\s+delete\s+["']?hklm|remove-item(?:property)?\b[^\n]*\bhklm:)/i, 'deleting machine-wide registry keys'],
  [/\b(?:set-mppreference\b[^\n]*-disable|add-mppreference\b[^\n]*-exclusion|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off)/i, 'turning off Defender or the firewall'],
  [/\b(?:hooks-trust\.json|[\\/]\.dsh[\\/]hooks\.json|[\\/]\.dsh[\\/]profiles[\\/])/i, 'changing the Harness hook / profile settings (the user does that)'],
]
const ASK = [
  [/\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*(?:\s--force(?!-with-lease)\b|\s-f\b|\s\+\S+)/i, 'git push --force rewrites the remote history'],
  [/\bgit\b[^\n|;&]*\breset\b[^\n|;&]*\s--hard\b/i, 'git reset --hard discards uncommitted changes'],
  [/\bgit\b[^\n|;&]*\bclean\b[^\n|;&]*\s-[a-z]*f/i, 'git clean -f deletes untracked files'],
  [/\bgit\b[^\n|;&]*\b(?:branch\s+(?:-D\b|--delete\s+--force\b)|stash\s+(?:clear|drop)\b|checkout\s+--\s+\.(?:\s|$)|restore\s+(?:--\S+\s+)*\.(?:\s|$))/, 'this git command discards work that may exist nowhere else'],
  [/\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^\n]*\|\s*(?:iex|invoke-expression|sh|bash|python|node|pwsh|powershell)\b/i, 'downloading and running a script in one step'],
]

/** Built-in shell guard: { kind: 'deny' | 'ask', reason } or null. */
export function guardCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null
  for (const [re, why] of DENY) if (re.test(command)) return { kind: 'deny', reason: why }
  for (const [re, why] of ASK) if (re.test(command)) return { kind: 'ask', reason: why }
  return null
}

const PROTECTED = [
  (p) => basename(p).toLowerCase() === 'hooks-trust.json',
  (p) => p.toLowerCase() === join(DSH_HOME, 'hooks.json').toLowerCase(),
  (p) => p.toLowerCase().startsWith(join(DSH_HOME, 'profiles').toLowerCase() + sep),
]
export const isProtectedPath = (abs) => PROTECTED.some((f) => f(abs))

// ---------------------------------------------------------------------------------------------- checks

function run(command, args, { cwd, input, timeoutMs = 30000, env, shell = false } = {}) {
  return new Promise((done) => {
    let child
    try {
      child = spawn(command, args, { cwd, env: env ?? process.env, shell, windowsHide: true })
    } catch (e) { return done({ code: -1, stdout: '', stderr: String(e.message), spawnError: true }) }
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); done(r) } }
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {})
      else child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (c) => { if (stdout.length < 200000) stdout += c })
    child.stderr?.on('data', (c) => { if (stderr.length < 200000) stderr += c })
    child.on('error', (e) => finish({ code: -1, stdout, stderr: stderr || String(e.message), spawnError: e.code === 'ENOENT', timedOut }))
    child.on('close', (code) => finish({ code: timedOut ? -2 : code ?? -1, stdout, stderr, timedOut }))
    child.stdin?.on('error', () => {})
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

const JSONC_NAME = /^(?:tsconfig.*|jsconfig.*|\.eslintrc|devcontainer|settings|launch|tasks|extensions|keybindings|\.babelrc|deno|biome|\.swcrc)\.json$/i

/** Lines with <<<<<<< / >>>>>>> left from a merge. */
export function conflictMarkers(text) {
  const out = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) if (/^(?:<{7}|>{7})(?: |$)/.test(lines[i])) out.push(i + 1)
  return out
}

/** JSON syntax error with a line number, or null. */
export function jsonError(text) {
  try { JSON.parse(text.replace(/^﻿/, '')); return null } catch (e) {
    const m = /position (\d+)/.exec(e.message)
    const line = m ? text.slice(0, Number(m[1])).split('\n').length : undefined
    return line ? `line ${line}: ${e.message}` : e.message
  }
}

function findUp(start, rel) {
  let d = start
  for (let i = 0; i < 40; i++) {
    const p = join(d, rel)
    if (existsSync(p)) return p
    const up = dirname(d)
    if (up === d) return undefined
    d = up
  }
  return undefined
}

const PY_CHECK = 'import ast,sys\nf=sys.argv[1]\nast.parse(open(f,"rb").read(),f)'
const PS_CHECK = `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:AFK_CHECK_FILE,[ref]$t,[ref]$e);foreach($x in $e){'line '+$x.Extent.StartLineNumber+':'+$x.Extent.StartColumnNumber+': '+$x.Message}`
const TS_CHECK = `const ts=require(process.env.AFK_TS);const fs=require('fs');const f=process.env.AFK_CHECK_FILE;
const r=ts.transpileModule(fs.readFileSync(f,'utf8'),{fileName:f,reportDiagnostics:true,compilerOptions:{jsx:ts.JsxEmit.Preserve,target:ts.ScriptTarget.ESNext}});
for(const d of r.diagnostics||[]){const p=d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start):null;
console.log((p?'line '+(p.line+1)+':'+(p.character+1)+': ':'')+ts.flattenDiagnosticMessageText(d.messageText,'\\n'))}`

function nodeCmd() { return process.env.AFK_NODE ?? 'node' }

/**
 * Syntax check of one file: a problem text, or null (fine / not checkable / tool missing).
 * `checkers` maps an extension to a command template with {file}; it replaces the built-in check for that extension.
 */
export async function checkFile(file, { checkers = {}, timeoutMs = 20000 } = {}) {
  let st
  try { st = statSync(file) } catch { return null }
  if (!st.isFile() || st.size > 4 * 1024 * 1024) return null
  const ext = extname(file).toLowerCase()
  const problems = []
  let text = null
  try { text = readFileSync(file, 'utf8') } catch { return null }
  if (text.includes('\u0000')) return null // binary
  const markers = conflictMarkers(text)
  if (markers.length) problems.push(`merge conflict markers left at line ${markers.slice(0, 5).join(', ')}`)

  const env = { ...process.env, AFK_CHECK_FILE: file }
  const custom = checkers[ext]
  if (typeof custom === 'string' && custom.trim()) {
    const r = await run(custom.replaceAll('{file}', `"${file}"`), [], { cwd: dirname(file), env, timeoutMs, shell: true })
    if (!r.spawnError && r.code !== 0) problems.push((r.stdout + r.stderr).trim() || `checker exited with ${r.code}`)
  } else if (ext === '.json' && !JSONC_NAME.test(basename(file))) {
    const e = jsonError(text)
    if (e) problems.push(e)
  } else if (ext === '.py' || ext === '.pyw') {
    const r = await run('python', ['-I', '-c', PY_CHECK, file], { env, timeoutMs })
    if (!r.spawnError && r.code !== 0 && !r.timedOut) {
      const lines = r.stderr.trim().split(/\r?\n/)
      problems.push(lines.slice(-4).join('\n'))
    }
  } else if (['.js', '.mjs', '.cjs'].includes(ext)) {
    const r = await run(nodeCmd(), ['--check', file], { env, timeoutMs })
    if (!r.spawnError && r.code !== 0 && !r.timedOut) problems.push(r.stderr.trim().split(/\r?\n/).filter((l) => !/^\s*at |^Node\.js v/.test(l)).slice(0, 6).join('\n'))
  } else if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
    const ts = findUp(dirname(file), join('node_modules', 'typescript', 'lib', 'typescript.js'))
    if (ts) {
      const r = await run(nodeCmd(), ['-e', TS_CHECK], { env: { ...env, AFK_TS: ts }, timeoutMs })
      if (!r.spawnError && !r.timedOut && r.stdout.trim()) problems.push(r.stdout.trim().split(/\r?\n/).slice(0, 8).join('\n'))
    }
  } else if (['.ps1', '.psm1', '.psd1'].includes(ext)) {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_CHECK], { env, timeoutMs })
    if (!r.spawnError && !r.timedOut && r.stdout.trim()) problems.push(r.stdout.trim().split(/\r?\n/).slice(0, 8).join('\n'))
  }
  return problems.length ? cut(problems.join('\n'), 2000) : null
}

/** Absolute paths a tool call changed: the fs intents seen for it, else file_path / path from its arguments. */
export function changedFiles(seen, args, cwd) {
  const out = new Set(seen ?? [])
  if (out.size === 0) for (const k of ['file_path', 'path', 'filePath']) {
    if (typeof args?.[k] === 'string' && args[k]) out.add(isAbsolute(args[k]) ? args[k] : resolve(cwd ?? process.cwd(), args[k]))
  }
  return [...out]
}

// ---------------------------------------------------------------------------------------------- hook files

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const TRUST_FILE = join(DSH_HOME, 'hooks-trust.json')

function readTrust() { try { return JSON.parse(readFileSync(TRUST_FILE, 'utf8')) } catch { return {} } }
function writeTrust(t) { mkdirSync(DSH_HOME, { recursive: true }); writeFileSync(TRUST_FILE, JSON.stringify(t, null, 2)) }

/** Parse a hooks.json body (Claude Code's {"hooks": {...}} or the bare event map). */
export function parseHooks(text) {
  const j = JSON.parse(text.replace(/^﻿/, ''))
  const map = j && typeof j === 'object' && j.hooks && typeof j.hooks === 'object' ? j.hooks : j
  const out = {}
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop']) {
    const groups = Array.isArray(map?.[ev]) ? map[ev] : []
    out[ev] = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])
      .filter((h) => h && (h.type ?? 'command') === 'command' && typeof h.command === 'string' && h.command.trim())
      .map((h) => ({ matcher: g.matcher, command: h.command, timeout: Number(h.timeout) > 0 ? Number(h.timeout) : 60, always: h.always === true })))
  }
  return out
}

function loadFile(path) {
  if (!existsSync(path)) return null
  try {
    const buf = readFileSync(path)
    return { path, hash: sha(buf), hooks: parseHooks(buf.toString('utf8')) }
  } catch (e) { return { path, error: e.message, hooks: { PreToolUse: [], PostToolUse: [], Stop: [] } } }
}

/** User hooks always; project hooks only when the user trusted this exact file content. */
export function loadHooks(cwd) {
  const user = loadFile(join(DSH_HOME, 'hooks.json'))
  const project = cwd ? loadFile(join(cwd, '.dsh', 'hooks.json')) : null
  if (project && !project.error) project.trusted = readTrust()[project.path.toLowerCase()] === project.hash
  const active = { PreToolUse: [], PostToolUse: [], Stop: [] }
  for (const src of [user, project?.trusted ? project : null]) {
    if (!src || src.error) continue
    for (const ev of Object.keys(active)) active[ev].push(...src.hooks[ev].map((h) => ({ ...h, source: src.path })))
  }
  return { user, project, active }
}

/** Run one command hook; returns the Claude Code style outcome. */
export async function runHook(hook, payload, cwd) {
  const env = { ...process.env, DSH_PROJECT_DIR: cwd ?? '', CLAUDE_PROJECT_DIR: cwd ?? '' }
  const t0 = Date.now()
  const r = await run(hook.command, [], { cwd: cwd && existsSync(cwd) ? cwd : undefined, input: JSON.stringify(payload), env, timeoutMs: hook.timeout * 1000, shell: true })
  let json
  const s = r.stdout.trim()
  if (s.startsWith('{')) { try { json = JSON.parse(s) } catch { /* plain text */ } }
  const spec = json?.hookSpecificOutput ?? {}
  let decision = 'none'
  let reason = ''
  if (r.code === 2) { decision = 'block'; reason = r.stderr.trim() || s }
  else if (r.code === 0 && json) {
    const d = spec.permissionDecision ?? json.decision
    if (d === 'deny' || d === 'block') decision = 'block'
    else if (d === 'ask') decision = 'ask'
    reason = String(spec.permissionDecisionReason ?? json.reason ?? '')
  }
  return {
    decision, reason: cut(reason), context: typeof spec.additionalContext === 'string' ? cut(spec.additionalContext) : '',
    code: r.code, timedOut: r.timedOut, error: r.code !== 0 && r.code !== 2 ? cut((r.stderr || r.stdout).trim(), 500) : '',
    ms: Date.now() - t0,
  }
}

// ---------------------------------------------------------------------------------------------- notify

const xmlEsc = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

export function toastScript(appId, title, body) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(body)}</text></binding></visual></toast>`
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${xml.replaceAll("'", "''")}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId.replaceAll("'", "''")}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('\n')
}

function toast(appId, title, body) {
  if (process.platform !== 'win32') return
  const enc = Buffer.from(toastScript(appId, title, body), 'utf16le').toString('base64')
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { windowsHide: true, stdio: 'ignore', detached: true })
    p.on('error', () => {})
    p.unref()
  } catch { /* no notification, nothing else breaks */ }
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`
}

// ---------------------------------------------------------------------------------------------- plugin

const userMessage = (text) => Object.freeze({
  role: 'user', id: randomUUID(), source: { kind: 'hooks-afkllm' }, content: [{ type: 'text', text }],
})

export function apply(ctx, config = {}) {
  const opt = {
    guard: config.guard !== false,
    check: config.check !== false,
    stopCheck: config.stopCheck !== false,
    stopMaxContinues: Number(config.stopMaxContinues ?? 3),
    checkers: config.checkers ?? {},
    notify: config.notify === false ? null : { minSeconds: 60, appId: 'com.deepseek.dsh', ...(config.notify ?? {}) },
  }
  /** @type {WeakMap<object, Set<string>>} tool execution -> files it changed (from fs intents) */
  const touched = new WeakMap()
  /** session -> { turn, edited: Set, broken: Map<file, problem>, continues, started, lastText } */
  const sessions = new WeakMap()
  const log = []
  const note = (entry) => { log.push({ at: new Date().toLocaleTimeString('ru-RU'), ...entry }); if (log.length > 30) log.shift() }

  const state = (session) => {
    let s = sessions.get(session)
    if (!s) { s = { turn: 0, edited: new Set(), broken: new Map(), continues: 0, started: Date.now(), lastText: '' }; sessions.set(session, s) }
    return s
  }
  const cwdOf = (agent) => agent?.session?.cwd ?? agent?.session?.header?.cwd ?? process.cwd()
  const isSub = (agent) => agent?.session?.header?.origin === 'subagent'

  // --- PreToolUse: built-in denials are a guard (order-independent, synchronous)
  if (opt.guard) {
    ctx.tools.guard((exec) => {
      const a = toolArgs(exec)
      if (SHELL_TOOLS.has(exec.name)) {
        const g = guardCommand(a.command ?? a.cmd ?? a.script)
        if (g?.kind === 'deny') { note({ hook: 'guard', tool: exec.name, decision: 'deny', reason: g.reason }); return `Blocked by the AFKLLM hooks guard: ${g.reason}. Do not retry it in another form; if it is really needed, tell the user the exact command and let them run it.` }
      }
      if (EDIT_TOOLS.has(exec.name)) {
        const p = typeof a.file_path === 'string' ? resolve(cwdOf(exec.agent), a.file_path) : ''
        if (p && isProtectedPath(p)) { note({ hook: 'guard', tool: exec.name, decision: 'deny', reason: p }); return 'Blocked by the AFKLLM hooks guard: hook and profile settings are changed by the user only.' }
      }
      return undefined
    })
  }

  // --- PreToolUse: asks + user hooks (may await)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const a = toolArgs(exec)
    let mine = null
    if (opt.guard && SHELL_TOOLS.has(exec.name)) {
      const g = guardCommand(a.command ?? a.cmd ?? a.script)
      if (g?.kind === 'ask') { mine = { kind: 'ask', reason: `AFKLLM hooks: ${g.reason}`, displayReason: { en: `Hooks: ${g.reason}. Allow?`, ru: `Хуки: ${g.reason}. Разрешить?` } }; note({ hook: 'guard', tool: exec.name, decision: 'ask', reason: g.reason }) }
    }
    if (exec.agent) {
      const cwd = cwdOf(exec.agent)
      const { active } = loadHooks(cwd)
      for (const h of active.PreToolUse) {
        if (!matchTool(h.matcher, exec.name)) continue
        const r = await runHook(h, { hook_event_name: 'PreToolUse', session_id: String(exec.agent.session?.id ?? ''), cwd, tool_name: CC_ALIAS[exec.name] ?? exec.name, harness_tool_name: exec.name, tool_input: a }, cwd)
        note({ hook: `PreToolUse: ${h.command}`, tool: exec.name, decision: r.decision, reason: r.reason || r.error, ms: r.ms })
        if (r.decision === 'block') return { kind: 'deny', reason: `Blocked by a PreToolUse hook (${h.command}): ${r.reason || 'no reason given'}` }
        if (r.decision === 'ask' && !mine) mine = { kind: 'ask', reason: `PreToolUse hook: ${r.reason}`, displayReason: { en: `Hook asks: ${r.reason || h.command}`, ru: `Хук спрашивает: ${r.reason || h.command}` } }
      }
    }
    const d = await next()
    return mine && d.kind === 'allow' ? mine : d
  })

  // --- which files a tool call changes (the actor of an fs intent is the tool execution)
  const capture = (target, actor) => {
    if (!actor || typeof actor !== 'object') return
    let set = touched.get(actor)
    if (!set) { set = new Set(); touched.set(actor, set) }
    const p = target?.displayPath
    if (typeof p === 'string' && p) set.add(isAbsolute(p) ? p : resolve(cwdOf(actor.agent), p))
  }
  for (const ev of ['fs/write-intent', 'fs/edit-intent']) {
    ctx.on(ev, async (target, actor, next) => { const r = await next(); capture(target, actor); return r })
  }

  // --- PostToolUse: syntax check + user hooks
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || !exec.agent) return decision
    const notes = []
    const extra = []
    const cwd = cwdOf(exec.agent)
    const a = toolArgs(exec)
    if (EDIT_TOOLS.has(exec.name) && !result.isError) {
      const files = changedFiles(touched.get(exec), a, cwd)
      const s = state(exec.agent.session)
      for (const f of files) s.edited.add(f)
      if (opt.check) {
        for (const f of files) {
          const p = await checkFile(f, { checkers: opt.checkers })
          if (p) { s.broken.set(f, p); notes.push(`${f}:\n${p}`) } else s.broken.delete(f)
        }
        if (notes.length) note({ hook: 'check', tool: exec.name, decision: 'errors', reason: files.join(', ') })
      }
    }
    const { active } = loadHooks(cwd)
    for (const h of active.PostToolUse) {
      if (!matchTool(h.matcher, exec.name)) continue
      const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      const r = await runHook(h, { hook_event_name: 'PostToolUse', session_id: String(exec.agent.session?.id ?? ''), cwd, tool_name: CC_ALIAS[exec.name] ?? exec.name, harness_tool_name: exec.name, tool_input: a, tool_response: { is_error: !!result.isError, text: cut(text, 20000) } }, cwd)
      note({ hook: `PostToolUse: ${h.command}`, tool: exec.name, decision: r.decision, reason: r.reason || r.error, ms: r.ms })
      if (r.decision === 'block') extra.push(`PostToolUse hook (${h.command}): ${r.reason}`)
      if (r.context) extra.push(r.context)
    }
    if (!notes.length && !extra.length) return decision
    const parts = []
    if (notes.length) parts.push(`[hooks] Syntax check after this edit found problems. Fix them before going on:\n${notes.join('\n\n')}`)
    if (extra.length) parts.push(`[hooks]\n${extra.join('\n\n')}`)
    const content = [...(decision.content ?? result.content ?? []), { type: 'text', text: parts.join('\n\n') }]
    return { ...decision, content }
  })

  // --- turn bookkeeping + notification
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/start') {
      const s = state(session)
      s.turn = event.data?.turn ?? s.turn + 1; s.edited = new Set(); s.broken = new Map(); s.continues = 0; s.started = event.time ?? Date.now(); s.lastText = ''
    } else if (event?.type === 'assistant/message') {
      const t = (event.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
      if (t) state(session).lastText = t
    } else if (event?.type === 'turn/end' && opt.notify && session?.header?.origin !== 'subagent') {
      const s = state(session)
      const ms = (event.time ?? Date.now()) - s.started
      const kind = event.data?.kind ?? event.data?.end?.kind
      if (ms < opt.notify.minSeconds * 1000 || kind === 'aborted') return
      const head = kind === 'error' ? `Ошибка после ${formatDuration(ms)}` : `Готово за ${formatDuration(ms)}`
      const body = s.lastText.replace(/[#*`_>|]/g, '').replace(/\s+/g, ' ').slice(0, 160) || 'Агент закончил ход.'
      toast(opt.notify.appId, head, body)
    }
  })

  // --- Stop: re-check edited files, then user Stop hooks; send the agent back when something is wrong
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (!agent || isSub(agent)) return
    const s = state(agent.session)
    if (s.continues >= opt.stopMaxContinues) return
    const cwd = cwdOf(agent)
    const reasons = []
    if (opt.stopCheck && s.edited.size) {
      for (const f of s.edited) {
        if (signal?.aborted) return
        const p = await checkFile(f, { checkers: opt.checkers })
        if (p) reasons.push(`${f} still fails its syntax check:\n${p}`)
      }
    }
    const { active } = loadHooks(cwd)
    for (const h of active.Stop) {
      if (signal?.aborted) return
      if (!h.always && s.edited.size === 0) continue
      const r = await runHook(h, { hook_event_name: 'Stop', session_id: String(agent.session?.id ?? ''), cwd, stop_hook_active: s.continues > 0, edited_files: [...s.edited] }, cwd)
      note({ hook: `Stop: ${h.command}`, decision: r.decision, reason: r.reason || r.error, ms: r.ms })
      if (r.decision === 'block') reasons.push(`Stop hook \`${h.command}\` did not pass:\n${r.reason}`)
    }
    if (!reasons.length || signal?.aborted) return
    s.continues++
    note({ hook: 'stop', decision: `continue ${s.continues}/${opt.stopMaxContinues}` })
    agent.inject(userMessage(`[hooks] The turn is not finished yet (automatic check ${s.continues} of ${opt.stopMaxContinues}):\n\n${reasons.join('\n\n')}\n\nFix this, re-run the check, then finish. If it cannot be fixed within the task, say so plainly to the user.`))
  })

  // --- /hooks
  const show = ({ agent }) => {
    const cwd = cwdOf(agent)
    const { user, project, active } = loadHooks(cwd)
    const count = (h) => `PreToolUse ${h.PreToolUse.length}, PostToolUse ${h.PostToolUse.length}, Stop ${h.Stop.length}`
    const on = (b) => (b ? 'вкл' : 'выкл')
    const lines = [
      `Встроенные: защита ${on(opt.guard)}, проверка после правки ${on(opt.check)}, проверка перед концом хода ${on(opt.stopCheck)} (до ${opt.stopMaxContinues} возвратов), уведомление ${opt.notify ? `от ${opt.notify.minSeconds} с` : 'выкл'}.`,
      `Твои (${join(DSH_HOME, 'hooks.json')}): ${user ? (user.error ? `ошибка: ${user.error}` : count(user.hooks)) : 'файла нет'}.`,
      `Проекта (${join(cwd, '.dsh', 'hooks.json')}): ${project ? (project.error ? `ошибка: ${project.error}` : `${count(project.hooks)}, ${project.trusted ? 'доверен' : 'НЕ доверен — не запускается; посмотри файл и введи /hooks trust'}`) : 'файла нет'}.`,
      `Сейчас работают: ${count(active)}.`,
    ]
    if (log.length) lines.push('', 'Последние срабатывания:', ...log.slice(-12).map((e) => `${e.at} ${e.hook}${e.tool ? ` [${e.tool}]` : ''} → ${e.decision}${e.ms !== undefined ? ` (${e.ms} мс)` : ''}${e.reason ? `: ${String(e.reason).slice(0, 160)}` : ''}`))
    return lines.join('\n')
  }
  const hooksCommand = async ({ rawInput, agent }) => {
    const arg = (rawInput ?? '').trim().toLowerCase()
    const cwd = cwdOf(agent)
    const file = join(cwd, '.dsh', 'hooks.json')
    if (arg === '' || arg === 'status') return { kind: 'success', text: show({ agent }) }
    if (arg === 'trust' || arg === 'untrust') {
      const t = readTrust()
      if (arg === 'untrust') { delete t[file.toLowerCase()]; writeTrust(t); return { kind: 'success', text: `Хуки проекта больше не запускаются: ${file}` } }
      const f = loadFile(file)
      if (!f) return { kind: 'error', text: `Нет файла ${file}` }
      if (f.error) return { kind: 'error', text: `Файл не разобран: ${f.error}` }
      t[file.toLowerCase()] = f.hash; writeTrust(t)
      const cmds = ['PreToolUse', 'PostToolUse', 'Stop'].flatMap((ev) => f.hooks[ev].map((h) => `  ${ev}${h.matcher ? ` [${h.matcher}]` : ''}: ${h.command}`))
      return { kind: 'success', text: `Доверено (до следующего изменения файла):\n${cmds.join('\n') || '  (команд нет)'}` }
    }
    return { kind: 'error', text: 'Использование: /hooks [trust | untrust]' }
  }
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'hooks',
      description: 'Хуки AFKLLM: что включено, последние срабатывания; /hooks trust — разрешить хуки проекта',
      input: { hint: '[trust | untrust]' },
      handler: hooksCommand,
    })
  }, 'hooks-afkllm')
}
