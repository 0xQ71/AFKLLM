// Which Strata Control afk starts (src/core/strata.ts strataRoot): the one `strata update` installed and named in
// components\control\active.json, else the installer's terminal\current. No Strata needed: a fake folder tree.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { mergeEngineArgs, strataRoot } from '../src/core/strata'

const home = mkdtempSync(join(tmpdir(), 'afk-strata-'))
after(() => rmSync(home, { recursive: true, force: true }))

test('strataRoot: the installer terminal when no update is active', () => {
  assert.equal(strataRoot(home), join(home, 'terminal', 'current'))
})

test('strataRoot: the Control folder named in active.json once it has python and serve', () => {
  const ctl = join(home, 'components', 'control')
  mkdirSync(join(ctl, '0.1.66', 'python'), { recursive: true })
  writeFileSync(join(ctl, 'active.json'), JSON.stringify({ version: '0.1.66', folder: '0.1.66' }))
  // python.exe and serve/ missing: an unfinished install is not used
  assert.equal(strataRoot(home), join(home, 'terminal', 'current'))
  writeFileSync(join(ctl, '0.1.66', 'python', 'python.exe'), '')
  mkdirSync(join(ctl, '0.1.66', 'serve'))
  assert.equal(strataRoot(home), join(ctl, '0.1.66'))
  writeFileSync(join(ctl, 'active.json'), '{broken')
  assert.equal(strataRoot(home), join(home, 'terminal', 'current'))
})

test('mergeEngineArgs replaces, adds and drops flags', () => {
  const base = ['--pack', 'p', '--spec', '4', '--vision']
  assert.deepEqual(mergeEngineArgs(base, { spec: '6', 'kv-grow': null, vision: '__off__' }), ['--pack', 'p', '--spec', '6', '--kv-grow'])
})
