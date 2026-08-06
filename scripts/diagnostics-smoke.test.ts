import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseEslintJson, parseTscOutput } from '../src/shared/diagnostics'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

describe('parseTscOutput', () => {
  it('parses pretty=false lines and relativizes paths', () => {
    const root = 'D:/proj'
    const text = [
      'src/app.ts(12,5): error TS2304: Cannot find name \'foo\'.',
      'D:\\proj\\src\\util.ts(3,1): warning TS6133: \'x\' is declared but never used.'
    ].join('\n')
    const items = parseTscOutput(text, root)
    assert.equal(items.length, 2)
    assert.equal(items[0]!.path, 'src/app.ts')
    assert.equal(items[0]!.line, 12)
    assert.equal(items[0]!.severity, 'error')
    assert.equal(items[0]!.source, 'tsc')
    assert.equal(items[1]!.path, 'src/util.ts')
    assert.equal(items[1]!.severity, 'warning')
  })
})

describe('parseEslintJson', () => {
  it('parses eslint -f json array', () => {
    const root = 'D:/proj'
    const json = JSON.stringify([
      {
        filePath: 'D:\\proj\\src\\a.ts',
        messages: [
          {
            line: 2,
            column: 4,
            severity: 2,
            message: 'Unexpected var',
            ruleId: 'no-var'
          }
        ]
      }
    ])
    const items = parseEslintJson(json, root)
    assert.equal(items.length, 1)
    assert.equal(items[0]!.path, 'src/a.ts')
    assert.equal(items[0]!.severity, 'error')
    assert.equal(items[0]!.source, 'eslint')
    assert.match(items[0]!.message, /no-var/)
  })

  it('returns empty on invalid json', () => {
    assert.deepEqual(parseEslintJson('not-json', '/x'), [])
  })
})

describe('setupComplete default', () => {
  it('defaults to false', () => {
    assert.equal(DEFAULT_SETTINGS.setupComplete, false)
  })
})
