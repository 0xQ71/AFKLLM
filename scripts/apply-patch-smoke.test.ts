import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyHunksToText,
  filterExploreToolSchemas,
  parseApplyPatch
} from '../src/shared/applyPatch'

describe('parseApplyPatch', () => {
  it('parses Add File', () => {
    const r = parseApplyPatch(`*** Begin Patch
*** Add File: src/hi.ts
+export const hi = 1
*** End Patch`)
    assert.equal(r.ok, true)
    assert.equal(r.ops.length, 1)
    assert.equal(r.ops[0]!.type, 'add')
    assert.equal(r.ops[0]!.path, 'src/hi.ts')
    assert.deepEqual(r.ops[0]!.addLines, ['export const hi = 1'])
  })

  it('parses Update File hunk', () => {
    const r = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
 const x = 1
-const y = 2
+const y = 3
*** End Patch`)
    assert.equal(r.ok, true)
    assert.equal(r.ops[0]!.type, 'update')
    assert.equal(r.ops[0]!.hunks!.length, 1)
    assert.equal(r.ops[0]!.hunks![0]!.lines.length, 3)
  })

  it('parses Delete File', () => {
    const r = parseApplyPatch(`*** Begin Patch
*** Delete File: gone.ts
*** End Patch`)
    assert.equal(r.ok, true)
    assert.equal(r.ops[0]!.type, 'delete')
    assert.equal(r.ops[0]!.path, 'gone.ts')
  })

  it('errors on empty', () => {
    const r = parseApplyPatch('')
    assert.equal(r.ok, false)
  })
})

describe('applyHunksToText', () => {
  it('applies a simple replacement', () => {
    const original = 'const x = 1\nconst y = 2\nconst z = 3\n'
    const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
 const x = 1
-const y = 2
+const y = 99
 const z = 3
*** End Patch`)
    assert.equal(parsed.ok, true)
    const applied = applyHunksToText(original, parsed.ops[0]!.hunks!)
    assert.equal(applied.ok, true)
    assert.match(applied.content!, /const y = 99/)
    assert.doesNotMatch(applied.content!, /const y = 2/)
  })

  it('fails on hunk mismatch', () => {
    const original = 'hello\n'
    const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
-nope
+yes
*** End Patch`)
    const applied = applyHunksToText(original, parsed.ops[0]!.hunks!)
    assert.equal(applied.ok, false)
    assert.match(applied.error!, /hunk mismatch/)
  })
})

describe('filterExploreToolSchemas', () => {
  it('keeps only read-only tools', () => {
    const schemas = [
      { function: { name: 'read_file' } },
      { function: { name: 'write_file' } },
      { function: { name: 'explore_subagent' } },
      { function: { name: 'search_codebase' } },
      { function: { name: 'web_search' } }
    ]
    const filtered = filterExploreToolSchemas(schemas)
    assert.deepEqual(
      filtered.map((s) => s.function.name),
      ['read_file', 'search_codebase', 'web_search']
    )
  })
})
