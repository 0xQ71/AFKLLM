// Build a grep-friendly API index of the installed Godot build, one line per class member, for local agents:
// a model's memory mixes Godot 3 / 4.x names, the engine's own --doctool output does not.
//   node scripts/godot-api-index.mjs <godot.exe> [out.txt]
// Default output: ~/.dsh/knowledge/godot-<version>-api.txt. Lines look like:
//   class Node3D < Node < Object
//   Node3D.look_at(target: Vector3, up: Vector3 = Vector3(0, 1, 0), use_model_front: bool = false) -> void
//   Node3D.global_position: Vector3 = Vector3(0, 0, 0)            [property]
//   Node3D.visibility_changed()                                    [signal]
//   BaseMaterial3D.BILLBOARD_ENABLED = 1                           [enum BillboardMode]
//   @GlobalScope.sin(angle_rad: float) -> float
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const [godot, outArg] = process.argv.slice(2)
if (!godot) { console.error('usage: node scripts/godot-api-index.mjs <godot.exe> [out.txt]'); process.exit(2) }
const version = execFileSync(godot, ['--version'], { encoding: 'utf8' }).trim().split(/\r?\n/).pop().replace(/\.official.*$/, '')
const out = outArg ?? join(homedir(), '.dsh', 'knowledge', `godot-${version.replace(/\.stable$/, '')}-api.txt`)

// --doctool needs a project folder to run in; an empty one is enough
const work = mkdtempSync(join(tmpdir(), 'godot-doc-'))
writeFileSync(join(work, 'project.godot'), 'config_version=5\n')
mkdirSync(join(work, 'doc'))  // --doctool writes nothing into a folder that does not exist yet
try { execFileSync(godot, ['--headless', '--path', work, '--doctool', join(work, 'doc')], { stdio: 'ignore', timeout: 300000 }) } catch {}

const files = []
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.xml')) files.push(p) } }
walk(join(work, 'doc'))
if (!files.length) { console.error('doctool wrote nothing'); process.exit(1) }

const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : undefined }
const params = (body) => [...body.matchAll(/<param\b[^>]*\/?>/g)].map((m) => {
  const d = attr(m[0], 'default'); return `${attr(m[0], 'name')}: ${attr(m[0], 'type')}${d !== undefined ? ' = ' + d : ''}`
}).join(', ')
const pad = (s, tag) => (s.length < 64 ? s + ' '.repeat(64 - s.length) : s + '  ') + tag

const classes = new Map()
for (const f of files) {
  const x = readFileSync(f, 'utf8')
  const head = x.match(/<class\b[^>]*>/)
  if (!head) continue
  classes.set(attr(head[0], 'name'), { inherits: attr(head[0], 'inherits'), x })
}
const chain = (n) => { const c = []; let k = classes.get(n)?.inherits; while (k && c.length < 20) { c.push(k); k = classes.get(k)?.inherits } return c }

const lines = [
  `# Godot ${version} API index, generated from this engine's --doctool by AFKLLM scripts/godot-api-index.mjs.`,
  '# One line per member. Inherited members are listed under the class that defines them: see the "class" line',
  '# for the chain. Search: Select-String -Path <this file> -Pattern "^Node3D\\." ; "look_at\\(" ; "BILLBOARD_"',
  '',
]
for (const [name, { x }] of [...classes].sort((a, b) => a[0].localeCompare(b[0]))) {
  const ch = chain(name)
  lines.push(`class ${name}${ch.length ? ' < ' + ch.join(' < ') : ''}`)
  for (const m of x.matchAll(/<constructor\b[^>]*>([\s\S]*?)<\/constructor>/g)) lines.push(pad(`${name}(${params(m[1])})`, '[constructor]'))
  for (const m of x.matchAll(/<method\b([^>]*)>([\s\S]*?)<\/method>/g)) {
    const ret = m[2].match(/<return\b[^>]*\/?>/), q = attr(m[1], 'qualifiers')
    const sig = `${name}.${attr(m[1], 'name')}(${params(m[2])}${q?.includes('vararg') ? ', ...' : ''}) -> ${ret ? attr(ret[0], 'type') : 'void'}`
    lines.push(q ? pad(sig, `[${q}]`) : sig)
  }
  for (const m of x.matchAll(/<member\b[^>]*>/g)) {
    const d = attr(m[0], 'default'), e = attr(m[0], 'enum')
    lines.push(pad(`${name}.${attr(m[0], 'name')}: ${e ?? attr(m[0], 'type')}${d !== undefined ? ' = ' + d : ''}`, '[property]'))
  }
  for (const m of x.matchAll(/<signal\b([^>]*)>([\s\S]*?)<\/signal>/g)) lines.push(pad(`${name}.${attr(m[1], 'name')}(${params(m[2])})`, '[signal]'))
  for (const m of x.matchAll(/<constant\b[^>]*>/g)) {
    const e = attr(m[0], 'enum')
    lines.push(pad(`${name}.${attr(m[0], 'name')} = ${attr(m[0], 'value')}`, e ? `[enum ${e}]` : '[constant]'))
  }
  for (const m of x.matchAll(/<annotation\b([^>]*)>([\s\S]*?)<\/annotation>/g)) lines.push(pad(`${attr(m[1], 'name')}(${params(m[2])})`, '[annotation]'))
  for (const m of x.matchAll(/<theme_item\b[^>]*>/g)) lines.push(pad(`${name}.${attr(m[0], 'name')}: ${attr(m[0], 'type')}`, `[theme ${attr(m[0], 'data_type')}]`))
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, lines.join('\n') + '\n')
rmSync(work, { recursive: true, force: true })
console.log(`${out}: ${classes.size} classes, ${lines.length} lines`)
