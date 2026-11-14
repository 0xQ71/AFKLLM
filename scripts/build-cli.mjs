// Builds the AFKLLM CLI as one Windows executable: release/cli/afk.exe
//   1. esbuild bundles src/cli/main.ts (and the headless core) into one CommonJS file
//   2. Node's single-executable-application support turns it into a blob
//   3. a copy of node.exe gets the AFKLLM icon/version (rcedit, if electron-builder cached it) and the blob (postject)
// Usage: npm run build:cli
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(root, 'build-cli')
const outDir = join(root, 'release', 'cli')
const bin = (n) => join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${n}.cmd` : n)
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: work, shell: cmd.endsWith('.cmd'), ...opts })
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
mkdirSync(outDir, { recursive: true })

console.log('· bundling src/cli/main.ts')
run(bin('esbuild'), [join(root, 'src/cli/main.ts'), '--bundle', '--platform=node', '--target=node22', '--format=cjs',
  // @napi-rs/canvas is a native addon (WebP -> PNG in afk api); the exe runs without it (server.ts falls back)
  `--outfile=${join(work, 'afk.cjs')}`, '--external:@napi-rs/canvas', '--log-level=warning'])

console.log('· making the single-executable blob')
writeFileSync(join(work, 'sea-config.json'), JSON.stringify({
  main: 'afk.cjs', output: 'afk.blob', disableExperimentalSEAWarning: true, useCodeCache: false,
}))
run(process.execPath, ['--experimental-sea-config', 'sea-config.json'])

const exe = join(work, 'afk.exe')
copyFileSync(process.execPath, exe)

const rcedit = findRcedit()
if (rcedit) {
  console.log('· icon and version info')
  const v = version.replace(/-.*/, '')
  run(rcedit, [exe, '--set-icon', join(root, 'build', 'icon.ico'), '--set-file-version', v, '--set-product-version', v,
    '--set-version-string', 'ProductName', 'AFKLLM CLI', '--set-version-string', 'FileDescription', 'AFKLLM local coding agent',
    '--set-version-string', 'CompanyName', '0xQ71', '--set-version-string', 'OriginalFilename', 'afk.exe',
    '--set-version-string', 'InternalName', 'afk', '--set-version-string', 'LegalCopyright', 'Copyright © 2026 0xQ71'])
} else {
  console.log('· rcedit not found (electron-builder cache): afk.exe keeps the node icon')
}

console.log('· injecting the blob')
run(bin('postject'), [exe, 'NODE_SEA_BLOB', 'afk.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'])

const target = join(outDir, 'afk.exe')
try {
  copyFileSync(exe, target)
} catch (e) {
  console.error(`could not replace ${target} (is afk.exe running?): ${e.message}`)
  process.exit(1)
}
console.log(`✓ ${target}`)

function findRcedit() {
  // e.g. %LOCALAPPDATA%/electron-builder/Cache/winCodeSign-2.6.0/winCodeSign-2.6.0-5puky/rcedit-x64.exe
  const cache = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache')
  if (!existsSync(cache)) return null
  for (const p of safeDirs(cache).filter((d) => /winCodeSign/i.test(d))) {
    for (const sub of [p, ...safeDirs(p)]) {
      const exe = join(sub, 'rcedit-x64.exe')
      if (existsSync(exe)) return exe
    }
  }
  return null
}

function safeDirs(p) {
  try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(p, d.name)) } catch { return [] }
}
