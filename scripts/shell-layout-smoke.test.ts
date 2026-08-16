import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  diffStatFromCodePreview,
  diffStatFromPatchText,
  diffStatFromBeforeAfter,
  formatDiffStat
} from '../src/shared/diffStat'

describe('diffStatFromPatchText', () => {
  it('counts added and removed lines', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.ts',
      '@@',
      '-old',
      '+new',
      '+extra',
      '*** End Patch'
    ].join('\n')
    assert.deepEqual(diffStatFromPatchText(text), { added: 2, removed: 1 })
  })

  it('ignores +++ --- headers', () => {
    const text = '--- a\n+++ b\n@@\n-x\n+y\n'
    assert.deepEqual(diffStatFromPatchText(text), { added: 1, removed: 1 })
  })
})

describe('diffStatFromCodePreview', () => {
  it('treats write_file as all added', () => {
    const s = diffStatFromCodePreview('write_file', 'a\nb\nc')
    assert.deepEqual(s, { added: 3, removed: 0 })
  })

  it('parses apply_patch preview', () => {
    const s = diffStatFromCodePreview('apply_patch', '-a\n+b\n+c')
    assert.deepEqual(s, { added: 2, removed: 1 })
  })
})

describe('diffStatFromBeforeAfter', () => {
  it('counts a new file as added lines only', () => {
    const after = 'one\ntwo\nthree\n'
    assert.deepEqual(diffStatFromBeforeAfter('', after), { added: 3, removed: 0 })
  })

  it('does not treat a 642-line dump as the disk file', () => {
    const dump = Array.from({ length: 642 }, (_, i) => `line ${i}`).join('\n')
    const onDisk = Array.from({ length: 215 }, (_, i) => `keep ${i}`).join('\n')
    const fromDump = diffStatFromCodePreview('write_file', dump)
    assert.equal(fromDump?.added, 642)
    const fromDisk = diffStatFromBeforeAfter('', onDisk)
    assert.equal(fromDisk.added, 215)
    assert.equal(fromDisk.removed, 0)
  })

  it('counts a one-line replace as +1 -1', () => {
    assert.deepEqual(diffStatFromBeforeAfter('hello\nworld\n', 'hello\nthere\n'), {
      added: 1,
      removed: 1
    })
  })
})

describe('formatDiffStat', () => {
  it('formats +N -M', () => {
    assert.equal(formatDiffStat({ added: 3, removed: 1 }), '+3 -1')
    assert.equal(formatDiffStat({ added: 2, removed: 0 }), '+2')
    assert.equal(formatDiffStat({ added: 0, removed: 0 }), null)
  })
})
