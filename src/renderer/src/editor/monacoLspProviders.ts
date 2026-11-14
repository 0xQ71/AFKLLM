import type * as Monaco from 'monaco-editor'
import type { LspLocation } from '../../../shared/lsp'

const LANGS = ['typescript', 'javascript'] as const

/** Prefer workspace-relative path from Monaco model URI / path prop. */
export function modelToRelPath(model: Monaco.editor.ITextModel): string {
  const uri = model.uri
  let raw = (uri.path || uri.fsPath || uri.toString())
    .replace(/^\/([a-zA-Z]:)/, '$1')
    .replace(/^file:\/\/\//i, '')
    .replace(/\\/g, '/')
  raw = raw.replace(/^inmemory:\/\//i, '').replace(/^\/+/, '')
  // Strip accidental absolute Windows prefix if present under a drive letter path
  // that already embeds the relative project path after a known segment.
  const markers = ['/src/', '/scripts/']
  for (const m of markers) {
    const idx = raw.toLowerCase().indexOf(m.slice(1))
    if (idx > 0) {
      raw = raw.slice(idx)
      break
    }
  }
  return raw.replace(/^\/+/, '')
}

export function registerMonacoLspProviders(
  monaco: typeof Monaco,
  opts: {
    openAt: (path: string, line: number, column: number) => void | Promise<void>
  }
): Monaco.IDisposable {
  const disposables: Monaco.IDisposable[] = []

  for (const lang of LANGS) {
    disposables.push(
      monaco.languages.registerDefinitionProvider(lang, {
        provideDefinition: async (model, position) => {
          const path = modelToRelPath(model)
          const res = await window.api.lsp.definition(
            path,
            position.lineNumber,
            position.column
          )
          if (!res.ok || !res.locations.length) return null
          return res.locations.map((loc) => locationToMonaco(monaco, loc))
        }
      })
    )

    disposables.push(
      monaco.languages.registerHoverProvider(lang, {
        provideHover: async (model, position) => {
          const path = modelToRelPath(model)
          const res = await window.api.lsp.hover(
            path,
            position.lineNumber,
            position.column,
            model.getValue()
          )
          if (!res.ok || !res.contents?.trim()) return null
          // Type signature as a code fence, then prose docs.
          const [signature, ...docParts] = res.contents.split(/\n\n+/)
          const blocks: Monaco.IMarkdownString[] = [
            { value: '```ts\n' + signature.trim() + '\n```' }
          ]
          const docs = docParts.join('\n\n').trim()
          if (docs) blocks.push({ value: docs })
          return {
            contents: blocks,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            )
          }
        }
      })
    )

    disposables.push(
      monaco.languages.registerReferenceProvider(lang, {
        provideReferences: async (model, position) => {
          const path = modelToRelPath(model)
          const res = await window.api.lsp.references(
            path,
            position.lineNumber,
            position.column
          )
          if (!res.ok || !res.locations.length) return []
          return res.locations.map((loc) => locationToMonaco(monaco, loc))
        }
      })
    )

    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(lang, {
        provideDocumentSymbols: async (model) => {
          const path = modelToRelPath(model)
          const res = await window.api.lsp.documentSymbols(path)
          if (!res.ok || !res.symbols.length) return []
          return res.symbols.map((s) => ({
            name: s.name,
            detail: s.kind,
            kind: kindToMonaco(monaco, s.kind),
            tags: [],
            range: new monaco.Range(
              s.line,
              s.column,
              s.endLine ?? s.line,
              s.endColumn ?? s.column + 1
            ),
            selectionRange: new monaco.Range(
              s.line,
              s.column,
              s.line,
              s.column + Math.max(1, s.name.length)
            )
          }))
        }
      })
    )
  }

  disposables.push(
    monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, resource, selectionOrPosition) => {
        const path = (resource.path || resource.fsPath || '')
          .replace(/^\/([a-zA-Z]:)/, '$1')
          .replace(/\\/g, '/')
          .replace(/^\/+/, '')
        let line = 1
        let column = 1
        if (selectionOrPosition) {
          if ('startLineNumber' in selectionOrPosition) {
            line = selectionOrPosition.startLineNumber
            column = selectionOrPosition.startColumn
          } else if ('lineNumber' in selectionOrPosition) {
            line = selectionOrPosition.lineNumber
            column = selectionOrPosition.column
          }
        }
        await opts.openAt(path, line, column)
        return true
      }
    })
  )

  return {
    dispose: () => {
      for (const d of disposables) d.dispose()
    }
  }
}

function kindToMonaco(
  monaco: typeof Monaco,
  kind: string
): Monaco.languages.SymbolKind {
  const k = kind.toLowerCase()
  const SK = monaco.languages.SymbolKind
  if (k.includes('class')) return SK.Class
  if (k.includes('interface')) return SK.Interface
  if (k.includes('enum')) return SK.Enum
  if (k.includes('function') || k.includes('method')) return SK.Function
  if (k.includes('const') || k.includes('var') || k.includes('let')) return SK.Variable
  if (k.includes('property')) return SK.Property
  if (k.includes('module') || k.includes('namespace')) return SK.Module
  if (k.includes('type')) return SK.Interface
  return SK.Variable
}

function locationToMonaco(
  monaco: typeof Monaco,
  loc: LspLocation
): Monaco.languages.Location {
  const uri = monaco.Uri.parse(loc.path)
  return {
    uri,
    range: new monaco.Range(
      loc.line,
      loc.column,
      loc.endLine ?? loc.line,
      loc.endColumn ?? loc.column
    )
  }
}
