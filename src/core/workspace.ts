// The agent works inside ONE project folder (the CLI's current directory, the desktop app's chosen folder). Some
// folders are a bad place to let an autonomous agent read, write and run commands: drive roots, the home folder and
// its Desktop/Downloads/Documents, Windows and Program Files. dangerousFolder() names the problem so the CLI / GUI
// can ask the user to confirm or pick another folder.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'

const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase()

export function dangerousFolder(dir: string, appDir?: string): string | null {
  const d = norm(dir)
  const root = norm(parse(resolve(dir)).root)
  if (d === root || d + sep === root || /^[a-z]:$/.test(d)) return 'this is the root of a drive'
  const home = norm(homedir())
  if (d === home) return 'this is your whole user folder'
  for (const sub of ['Desktop', 'Downloads', 'Documents', 'OneDrive', 'AppData']) {
    const p = norm(join(homedir(), sub))
    if (d === p) return `this is your ${sub} folder, not a project`
    if (sub === 'AppData' && (d + sep).startsWith(p + sep)) return 'this is inside AppData (program settings and data)'
  }
  const sys = [
    [process.env.SystemRoot ?? 'C:\\Windows', 'Windows'],
    [process.env.ProgramFiles ?? 'C:\\Program Files', 'Program Files'],
    [process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Program Files (x86)'],
    [process.env.ProgramData ?? 'C:\\ProgramData', 'ProgramData'],
  ]
  for (const [p, name] of sys) {
    const n = norm(p)
    if (d === n || (d + sep).startsWith(n + sep)) return `this is inside ${name} (system files)`
  }
  if (appDir && (d === norm(appDir) || (d + sep).startsWith(norm(appDir) + sep))) return 'this is the AFKLLM program folder itself'
  return null
}

export function isDirectory(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
}
