/**
 * Regenerates THIRD_PARTY_NOTICES.md from installed package metadata.
 * Run: node scripts/generate-third-party-notices.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function findPkgDir(name) {
  // Prefer the package root under node_modules (avoids export-map / dist quirks).
  const scoped = name.startsWith('@')
    ? join(root, 'node_modules', ...name.split('/'))
    : join(root, 'node_modules', name)
  if (existsSync(join(scoped, 'package.json'))) return scoped

  try {
    const entry = require.resolve(`${name}/package.json`, { paths: [root] })
    return dirname(entry)
  } catch {
    try {
      const resolved = require.resolve(name, { paths: [root] })
      let dir = dirname(resolved)
      for (let i = 0; i < 10; i++) {
        const candidate = join(dir, 'package.json')
        if (existsSync(candidate)) {
          const meta = JSON.parse(readFileSync(candidate, 'utf8'))
          if (meta.name === name) return dir
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      /* missing */
    }
  }
  return null
}

function normalizeRepo(raw) {
  if (!raw) return ''
  let url =
    typeof raw === 'string'
      ? raw
      : raw.url || ''
  url = String(url)
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`
  return url
}

function readLicenseText(pkgDir) {
  if (!pkgDir) return null
  const names = [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENSE-MIT',
    'LICENCE',
    'license',
    'license.md',
    'COPYING'
  ]
  for (const name of names) {
    const p = join(pkgDir, name)
    if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  }
  // nested e.g. licenses/LICENSE or LICENSE.*
  try {
    for (const f of readdirSync(pkgDir)) {
      if (/^licen[cs]e/i.test(f) && !f.endsWith('.js')) {
        const p = join(pkgDir, f)
        try {
          const text = readFileSync(p, 'utf8').trim()
          if (text.length > 20 && text.length < 200_000) return text
        } catch {
          /* skip dirs */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

function normalizeLicense(raw) {
  if (!raw) return 'UNKNOWN'
  if (typeof raw === 'object' && raw.type) return String(raw.type)
  return String(raw).replace(/^\(|\)$/g, '').trim()
}

function collectDeps(specMap, section) {
  const rows = []
  for (const name of Object.keys(specMap || {}).sort()) {
    const pkgDir = findPkgDir(name)
    let meta = null
    if (pkgDir && existsSync(join(pkgDir, 'package.json'))) {
      meta = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    }
    const license = normalizeLicense(meta?.license)
    const version = meta?.version || String(specMap[name]).replace(/^[\^~>=<]*/, '') || '?'
    const repository =
      normalizeRepo(meta?.repository) || normalizeRepo(meta?.homepage) || ''
    const licenseText = readLicenseText(pkgDir)
    rows.push({
      section,
      name,
      version,
      license,
      repository,
      licenseText,
      pkgDir: pkgDir ? relative(root, pkgDir).replace(/\\/g, '/') : null
    })
  }
  return rows
}

const direct = [
  ...collectDeps(pkg.dependencies, 'runtime'),
  ...collectDeps(pkg.devDependencies, 'dev / build')
]

// Bundled non-npm (or special) components shipped with the app
const bundled = [
  {
    section: 'bundled',
    name: 'llama.cpp (llama-server)',
    version: 'bundled binary under bin/',
    license: 'MIT',
    repository: 'https://github.com/ggerganov/llama.cpp',
    licenseText: null,
    note: 'Windows binary placed in bin/ at build/install time; not an npm package. Model weights (.gguf) are separate and not covered by AFKLLM MIT.'
  },
  {
    section: 'bundled',
    name: 'Electron (Chromium + Node)',
    version: findPkgDir('electron')
      ? JSON.parse(readFileSync(join(findPkgDir('electron'), 'package.json'), 'utf8')).version
      : 'see package.json',
    license: 'MIT (Electron); Chromium and other components have additional licenses',
    repository: 'https://github.com/electron/electron',
    licenseText: null,
    note: 'Distributed Electron builds include Chromium third-party notices (LICENSES.chromium.html inside the Electron distribution).'
  }
]

const all = [...direct, ...bundled]

const licenseSummary = new Map()
for (const row of all) {
  const key = row.license
  licenseSummary.set(key, (licenseSummary.get(key) || 0) + 1)
}

const lines = []
lines.push('# Third-Party Notices')
lines.push('')
lines.push('This file lists open-source components used by **AFKLLM** and their licenses.')
lines.push('')
lines.push(`- Project license: [MIT](LICENSE) — Copyright (c) 2026 0xQ71`)
lines.push(`- Author: [0xQ71](https://github.com/0xQ71)`)
lines.push(`- Preferred attribution: see [NOTICE](NOTICE)`)
lines.push(`- Generated: ${new Date().toISOString().slice(0, 10)}`)
lines.push(`- Regenerate: \`npm run licenses:third-party\``)
lines.push('')
lines.push('## Summary by SPDX / license id')
lines.push('')
lines.push('| License | Packages (direct + bundled notes) |')
lines.push('|---|---:|')
for (const [lic, n] of [...licenseSummary.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`| ${lic} | ${n} |`)
}
lines.push('')
lines.push('## Direct dependencies')
lines.push('')
lines.push('Declared in `package.json` (runtime and build toolchain). Transitive packages')
lines.push('are also present under `node_modules` / `package-lock.json` and keep their own licenses.')
lines.push('')
lines.push('| Package | Version | License | Repository |')
lines.push('|---|---|---|---|')
for (const row of direct) {
  const repo = row.repository ? `[link](${row.repository})` : '—'
  lines.push(
    `| \`${row.name}\` (${row.section}) | ${row.version} | ${row.license} | ${repo} |`
  )
}
lines.push('')
lines.push('## Bundled / shipped with the app')
lines.push('')
lines.push('| Component | Version / note | License | Repository |')
lines.push('|---|---|---|---|')
for (const row of bundled) {
  const repo = row.repository ? `[link](${row.repository})` : '—'
  lines.push(`| ${row.name} | ${row.version} | ${row.license} | ${repo} |`)
}
lines.push('')
for (const row of bundled) {
  if (row.note) {
    lines.push(`- **${row.name}:** ${row.note}`)
  }
}
lines.push('')
lines.push('## License texts (direct dependencies)')
lines.push('')
lines.push('Where a package ships a LICENSE file, the text is reproduced below.')
lines.push('If the text is missing, see the package directory under `node_modules`.')
lines.push('')

for (const row of direct) {
  lines.push(`### ${row.name}@${row.version}`)
  lines.push('')
  lines.push(`- License: **${row.license}**`)
  if (row.repository) lines.push(`- Repository: ${row.repository}`)
  if (row.pkgDir) lines.push(`- Package path: \`${row.pkgDir}\``)
  lines.push('')
  if (row.licenseText) {
    lines.push('```')
    lines.push(row.licenseText.slice(0, 50_000))
    lines.push('```')
  } else {
    lines.push('_License file not found next to the package; SPDX id above still applies per package.json._')
  }
  lines.push('')
}

lines.push('## Notes')
lines.push('')
lines.push('- Redistributors of AFKLLM binaries should retain this file (or equivalent notices) together with `LICENSE` and `NOTICE`.')
lines.push('- AI model files are **not** listed here; each model publisher sets its own terms.')
lines.push('- For a full transitive inventory at install time you can also run:')
lines.push('  `npx license-checker-rseidelsohn --production --summary`')
lines.push('')

const out = join(root, 'THIRD_PARTY_NOTICES.md')
const body = lines.join('\n')
writeFileSync(out, body, 'utf8')
const legalDir = join(root, 'src', 'renderer', 'src', 'legal')
writeFileSync(join(legalDir, 'THIRD_PARTY_NOTICES.md'), body, 'utf8')
const noticeSrc = join(root, 'NOTICE')
if (existsSync(noticeSrc)) {
  writeFileSync(join(legalDir, 'NOTICE.txt'), readFileSync(noticeSrc, 'utf8'), 'utf8')
}
console.log(`Wrote ${relative(root, out)} and src/renderer/src/legal/ (${all.length} entries)`)
