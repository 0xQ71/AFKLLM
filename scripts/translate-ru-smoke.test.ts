/**
 * Smoke: markdown split / chunk helpers for store README translation.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chunkForTranslate,
  looksMostlyCyrillic,
  splitMarkdownForTranslate
} from '../src/main/hf/translateRu.ts'

describe('translateRu markdown helpers', () => {
  it('detects cyrillic blurbs', () => {
    assert.equal(looksMostlyCyrillic('Сильный coding / agent'), true)
    assert.equal(looksMostlyCyrillic('Strong coding agent instruct'), false)
  })

  it('keeps fenced code untranslated as separate segments', () => {
    const md = 'Intro text\n\n```ts\nconst x = 1\n```\n\nOutro'
    const segs = splitMarkdownForTranslate(md)
    assert.equal(segs.length, 3)
    assert.equal(segs[0]!.kind, 'text')
    assert.equal(segs[1]!.kind, 'code')
    assert.match(segs[1]!.text, /const x = 1/)
    assert.equal(segs[2]!.kind, 'text')
  })

  it('chunks long paragraphs', () => {
    const long = 'word '.repeat(200)
    const parts = chunkForTranslate(long, 80)
    assert.ok(parts.length > 2)
    assert.ok(parts.every((p) => p.length <= 80 + 5))
  })
})
