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

  it('tolerates "*** Begin Patch ***" / "*** End Patch ***" trailing stars', () => {
    const r = parseApplyPatch(`*** Begin Patch ***
*** Update File: index.html
@@
-  <div class="faq">old</div>
+  <div class="faq bg-dark text-white">new</div>
*** End Patch ***`)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.ops.length, 1)
    assert.equal(r.ops[0]!.type, 'update')
    assert.equal(r.ops[0]!.path, 'index.html')
  })

  it('converts unified --- a/ +++ b/ diffs into Update File ops', () => {
    const r = parseApplyPatch(`--- a/index.html
+++ b/index.html
@@ -1,3 +1,3 @@
 <html>
-  <p class="muted">gray</p>
+  <p class="muted">white</p>
 </html>
`)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.ops[0]!.type, 'update')
    assert.equal(r.ops[0]!.path, 'index.html')
    assert.ok((r.ops[0]!.hunks?.length ?? 0) >= 1)
    const original = `<html>
  <p class="muted">gray</p>
</html>
`
    const applied = applyHunksToText(original, r.ops[0]!.hunks!)
    assert.equal(applied.ok, true, applied.error)
    assert.match(applied.content!, /white/)
  })

  it('converts mixed Begin Patch + --- a/ headers', () => {
    const r = parseApplyPatch(`*** Begin Patch ***
--- a/index.html
+++ b/index.html
@@
-  <div class="faq">old</div>
+  <div class="faq bg-dark">new</div>
*** End Patch ***`)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.ops[0]!.path, 'index.html')
  })

  it('tolerates "Update File:" without *** prefix', () => {
    const r = parseApplyPatch(`Update File: index.html
@@
-  <div class="faq">old</div>
+  <div class="faq bg-dark text-white">new</div>`)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.ops[0]!.type, 'update')
    assert.equal(r.ops[0]!.path, 'index.html')
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
