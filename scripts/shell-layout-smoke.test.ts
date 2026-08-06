import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  diffStatFromCodePreview,
  diffStatFromPatchText,
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

describe('formatDiffStat', () => {
  it('formats +N -M', () => {
    assert.equal(formatDiffStat({ added: 3, removed: 1 }), '+3 -1')
    assert.equal(formatDiffStat({ added: 2, removed: 0 }), '+2')
    assert.equal(formatDiffStat({ added: 0, removed: 0 }), null)
  })
})
