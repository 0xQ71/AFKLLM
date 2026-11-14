// Permission policy. Modes (cycled with shift+tab in the CLI):
//   default      ask before edits and commands
//   acceptEdits  edits inside the project go through; commands still ask
//   plan         read-only: edits/commands are refused until the user leaves plan mode
//   auto         AUTO MODE: everything runs without asking, except actions that are hard to undo or
//                reach outside the project — those still ask (interactive) or are refused (headless).
import { isInside } from './tools'
import type { PermissionMode, PermissionRequest, ToolKind } from './types'

export type Verdict = { action: 'allow' } | { action: 'ask'; reason?: string } | { action: 'deny'; message: string }

/** Commands auto mode never runs on its own. Matched case-insensitively against the whole command. */
const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r)\b.*(\s\/(\s|$)|~|\*|\.\.)/, 'recursive force delete of a broad path'],
  [/\bremove-item\b[^;|]*-recurse[^;|]*(\s[a-z]:\\?(\s|$|['"])|\s\\|\s~|\$env:|\.\.)/i, 'recursive delete outside the project'],
  [/\b(rd|rmdir)\s+\/s\b/i, 'recursive directory delete'],
  [/\bformat(-volume)?\s+[a-z]:/i, 'disk format'],
  [/\b(diskpart|bcdedit|mkfs|fdisk|shutdown|restart-computer|stop-computer)\b/i, 'system-level command'],
  [/\breg(\.exe)?\s+(delete|add)\b|\bremove-itemproperty\b.*hk(lm|cu)/i, 'registry change'],
  [/\bgit\s+push\b/i, 'pushes to a remote'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|restore\s+--source|branch\s+-D|rebase)\b/i, 'discards git history or uncommitted work'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bgh\s+(release|pr\s+merge|repo\s+delete)\b/i, 'publishes outside this machine'],
  [/(curl|wget|invoke-webrequest|iwr|irm|invoke-restmethod)\b[^|]*\|\s*(sh|bash|iex|invoke-expression)\b/i, 'pipes a download into a shell'],
  [/\bset-executionpolicy\b|\bnetsh\b|\bnew-netfirewallrule\b/i, 'changes system security settings'],
  [/\b(stop-process|taskkill)\b[^;|]*(explorer|winlogon|csrss|lsass|svchost)/i, 'kills a system process'],
]

export function dangerousReason(command: string): string | null {
  for (const [re, why] of DANGEROUS) if (re.test(command)) return why
  return null
}

export class PermissionPolicy {
  /** "don't ask again" keys for this session: "edit", "shell:npm", … */
  remembered = new Set<string>()

  constructor(public mode: PermissionMode, public root: string) {}

  decide(kind: ToolKind, req: Omit<PermissionRequest, 'tool' | 'kind'>): Verdict {
    if (kind === 'meta') return { action: 'allow' }
    if (kind === 'read') {
      // the agent works inside the project folder: looking outside it needs the user's OK (in every mode)
      if (!isInside(req.detail, this.root) && !this.remembered.has(req.ruleKey)) {
        return { action: 'ask', reason: 'reads outside the project folder' }
      }
      return { action: 'allow' }
    }

    if (this.mode === 'plan') {
      return {
        action: 'deny',
        message: 'Plan mode is on: do not edit files or run commands yet. Finish investigating, then present your plan ' +
          'as a concise numbered list and stop; the user will switch modes to let you execute it.',
      }
    }

    const outside = kind === 'edit' && !isInside(req.detail, this.root)
    if (kind === 'edit') {
      if (outside) return { action: 'ask', reason: 'writes outside the project folder' }
      if (this.mode === 'auto' || this.mode === 'acceptEdits' || this.remembered.has('edit')) return { action: 'allow' }
      return { action: 'ask' }
    }

    // exec
    const danger = dangerousReason(req.detail)
    if (danger) return { action: 'ask', reason: danger }
    if (this.mode === 'auto' || this.remembered.has(req.ruleKey)) return { action: 'allow' }
    return { action: 'ask' }
  }
}
