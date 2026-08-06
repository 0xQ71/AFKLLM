import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeBreakpoints,
  parseInspectorWsUrl
} from '../src/shared/debug'
import { smokeDefinitionFixture, smokeReferencesAndOutlineFixture } from '../src/main/lsp/TsLanguageService'
import type { DiagnosticItem } from '../src/shared/diagnostics'

/** Mirror of applyRepoMarkers grouping without Monaco. */
function groupByPath(items: DiagnosticItem[]): Map<string, DiagnosticItem[]> {
  const map = new Map<string, DiagnosticItem[]>()
  for (const d of items) {
    const key = d.path.replace(/\\/g, '/')
    const list = map.get(key) ?? []
    list.push(d)
    map.set(key, list)
  }
  return map
}

describe('parseInspectorWsUrl', () => {
  it('extracts ws url from node inspect banner', () => {
    const banner =
      'Debugger listening on ws://127.0.0.1:9229/0f2c7e8a-1111-2222-3333-444444444444\n' +
      'For help, see: https://nodejs.org/en/docs/inspector\n'
    assert.equal(
      parseInspectorWsUrl(banner),
      'ws://127.0.0.1:9229/0f2c7e8a-1111-2222-3333-444444444444'
    )
  })

  it('returns null when missing', () => {
    assert.equal(parseInspectorWsUrl('no debugger here'), null)
  })
})

describe('normalizeBreakpoints', () => {
  it('dedupes and sorts', () => {
    const out = normalizeBreakpoints([
      { path: 'b.ts', line: 2 },
      { path: 'a.ts', line: 10 },
      { path: 'a.ts', line: 3 },
      { path: 'a.ts', line: 10 },
      { path: '', line: 1 },
      { path: 'x.ts', line: 0 }
    ])
    assert.deepEqual(out, [
      { path: 'a.ts', line: 3 },
      { path: 'a.ts', line: 10 },
      { path: 'b.ts', line: 2 }
    ])
  })
})

describe('marker grouping', () => {
  it('groups diagnostics by normalized path', () => {
    const map = groupByPath([
      {
        id: '1',
        path: 'src\\foo.ts',
        line: 1,
        column: 1,
        severity: 'error',
        message: 'a',
        source: 'tsc'
      },
      {
        id: '2',
        path: 'src/foo.ts',
        line: 2,
        column: 1,
        severity: 'warning',
        message: 'b',
        source: 'eslint'
      }
    ])
    assert.equal(map.get('src/foo.ts')?.length, 2)
  })
})

describe('TsLanguageService definition', () => {
  it('resolves greet across files', async () => {
    const locs = await smokeDefinitionFixture()
    assert.ok(locs.length >= 1, 'expected at least one location')
    assert.ok(
      locs.some((l) => l.path.replace(/\\/g, '/').endsWith('lib.ts')),
      `expected lib.ts in ${JSON.stringify(locs)}`
    )
  })
})

describe('TsLanguageService references + outline', () => {
  it('finds references and document symbols', async () => {
    const { refs, symbols } = await smokeReferencesAndOutlineFixture()
    assert.ok(refs >= 2, `expected >=2 refs, got ${refs}`)
    assert.ok(symbols >= 1, `expected >=1 symbols, got ${symbols}`)
  })
})

describe('TsLanguageService hover', () => {
  it('returns QuickInfo for a local binding', async () => {
    const os = await import('node:os')
    const path = await import('node:path')
    const fsp = await import('node:fs/promises')
    const { TsLanguageService } = await import('../src/main/lsp/TsLanguageService')
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'afkllm-lsp-hover-'))
    try {
      await fsp.writeFile(
        path.join(dir, 'main.ts'),
        'const answer: number = 42\nconsole.log(answer)\n',
        'utf8'
      )
      const svc = new TsLanguageService()
      svc.setRoot(dir)
      const res = svc.getHoverAt('main.ts', 2, 14)
      assert.equal(res.ok, true)
      assert.ok(
        res.contents && /answer|number|const/i.test(res.contents),
        `unexpected hover: ${res.contents}`
      )
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })
})
