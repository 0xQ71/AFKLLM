import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import {
  applySearchReplaceBlocks,
  buildInlineEditMessages,
  extractSurroundingLines,
  parseSearchReplaceBlocks
} from './diffUtils'
import type { QueueManager } from '../llm/queueManager'
import type { DiffPreviewPayload } from '../../../shared/types'
import { AFK_SCROLLBAR } from './monacoSetup'

export interface InlineEditModalProps {
  open: boolean
  onClose: () => void
  /** Monaco editor instance that owns the selection */
  editor: Monaco.editor.IStandaloneCodeEditor | null
  filePath: string
  queue: QueueManager
  editorTheme?: string
  /** Chat model is loaded — Ctrl+K uses Morph SEARCH/REPLACE on Chat. */
  applyReady?: boolean
  /** Called after user Accepts — parent should persist content */
  onAccept: (payload: { filePath: string; content: string }) => void
}

type Phase = 'prompt' | 'loading' | 'diff' | 'error'

/**
 * Ctrl+K overlay: instruction input → LLM SEARCH/REPLACE → Monaco DiffEditor.
 * Accept: Ctrl+Enter · Reject: Escape
 */
export function InlineEditModal({
  open,
  onClose,
  editor,
  filePath,
  queue,
  editorTheme = 'afkllm-dark',
  applyReady = false,
  onAccept
}: InlineEditModalProps): React.JSX.Element | null {
  const [instruction, setInstruction] = useState('')
  const [phase, setPhase] = useState<Phase>('prompt')
  const [error, setError] = useState<string | null>(null)
  const [streamPreview, setStreamPreview] = useState('')
  const [preview, setPreview] = useState<DiffPreviewPayload | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectionSnapshot = useRef<{
    selectedCode: string
    surrounding: string
    fullText: string
    languageId: string
    range: Monaco.IRange
  } | null>(null)

  useEffect(() => {
    if (!open || !editor) return

    const model = editor.getModel()
    if (!model) return

    const selection = editor.getSelection()
    const selectedCode = selection
      ? model.getValueInRange(selection)
      : model.getLineContent(editor.getPosition()?.lineNumber ?? 1)

    const range = selection ?? {
      startLineNumber: editor.getPosition()?.lineNumber ?? 1,
      startColumn: 1,
      endLineNumber: editor.getPosition()?.lineNumber ?? 1,
      endColumn: selectedCode.length + 1
    }

    selectionSnapshot.current = {
      selectedCode,
      surrounding: extractSurroundingLines(
        model.getValue(),
        range.startLineNumber,
        range.endLineNumber,
        50
      ),
      fullText: model.getValue(),
      languageId: model.getLanguageId(),
      range
    }

    setInstruction('')
    setPhase('prompt')
    setError(null)
    setStreamPreview('')
    setPreview(null)

    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, editor])

  // Live apply-model tokens so the overlay never looks frozen.
  useEffect(() => {
    if (!open) return
    let streamed = ''
    return window.api.agent.onApplyToken(({ token }) => {
      streamed += token
      setStreamPreview(streamed.slice(-1200))
    })
  }, [open])

  const runEdit = useCallback(async () => {
    const snap = selectionSnapshot.current
    if (!snap || !instruction.trim()) return

    setPhase('loading')
    setError(null)
    setStreamPreview('')

    try {
      // Morph SEARCH/REPLACE on Chat (thinking off). Falls back to the chat queue.
      const applyResult = applyReady
        ? await window.api.agent.applyEdit({
            instruction: instruction.trim(),
            filePath,
            content: snap.fullText,
            region: {
              startLine: snap.range.startLineNumber,
              endLine: snap.range.endLineNumber
            }
          })
        : null

      if (applyResult?.ok && applyResult.content != null) {
        setPreview({
          original: snap.fullText,
          modified: applyResult.content,
          languageId: snap.languageId,
          filePath,
          blocks: [],
          applied: applyResult.applied ?? 1,
          failed: []
        })
        setPhase('diff')
        return
      }

      const messages = buildInlineEditMessages({
        instruction: instruction.trim(),
        selectedCode: snap.selectedCode,
        filePath,
        surroundingContext: snap.surrounding,
        languageId: snap.languageId
      })

      let streamed = ''
      const result = await queue.chatStream({
        messages,
        maxTokens: 4096,
        temperature: 0.2,
        onToken: (tok) => {
          streamed += tok
          setStreamPreview(streamed.slice(-1200))
        }
      })

      if (result.aborted || result.error) {
        throw new Error(result.error ?? 'Request aborted')
      }

      const text = result.text || streamed
      const blocks = parseSearchReplaceBlocks(text)
      if (!blocks.length) {
        throw new Error(
          applyResult?.error ?? 'Model returned no SEARCH/REPLACE blocks'
        )
      }

      const applied = applySearchReplaceBlocks(snap.fullText, blocks)
      if (applied.applied === 0) {
        throw new Error(
          applied.failed.map((f) => `Block ${f.index}: ${f.reason}`).join('\n') ||
            'No SEARCH blocks could be applied'
        )
      }

      setPreview({
        original: snap.fullText,
        modified: applied.content,
        languageId: snap.languageId,
        filePath,
        blocks,
        applied: applied.applied,
        failed: applied.failed
      })
      setPhase('diff')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [instruction, filePath, queue, applyReady])

  const accept = useCallback(() => {
    if (!preview || !editor) return
    const model = editor.getModel()
    if (!model) return

    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: preview.modified }],
      () => null
    )
    onAccept({ filePath: preview.filePath, content: preview.modified })
    onClose()
  }, [preview, editor, onAccept, onClose])

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (phase === 'prompt' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void runEdit()
      return
    }
    if (phase === 'diff' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      accept()
    }
  }

  const onDiffMount: DiffOnMount = (diffEditor) => {
    diffEditor.focus()
  }

  if (!open) return null

  return (
    <div
      className="absolute inset-x-0 top-8 z-50 flex justify-center px-4"
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label="Inline edit"
    >
      <div className="w-full max-w-3xl overflow-hidden rounded-lg border border-ink-line bg-ink-900/95 shadow-2xl backdrop-blur">
        {phase === 'prompt' || phase === 'loading' || phase === 'error' ? (
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2 text-xs text-ink-mute">
              <kbd className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px]">
                Ctrl+K
              </kbd>
              <span>Edit selection · Enter to run · Esc to cancel</span>
            </div>
            <input
              ref={inputRef}
              type="text"
              value={instruction}
              disabled={phase === 'loading'}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Describe the edit…"
              className="w-full rounded-md border border-ink-line bg-ink-950 px-3 py-2 font-mono text-sm text-ink-bright outline-none ring-signal focus:ring-1"
            />
            {phase === 'loading' && (
              <div className="mt-2 space-y-1">
                <p className="text-xs text-signal">Generating SEARCH/REPLACE…</p>
                {streamPreview ? (
                  <pre className="max-h-28 overflow-auto rounded border border-ink-line bg-ink-950 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-ink-soft whitespace-pre-wrap">
                    {streamPreview}
                  </pre>
                ) : null}
              </div>
            )}
            {phase === 'error' && error && (
              <p className="mt-2 whitespace-pre-wrap text-xs text-red-400">{error}</p>
            )}
          </div>
        ) : null}

        {phase === 'diff' && preview && (
          <div className="flex h-[min(60vh,480px)] flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-ink-line px-3 py-2 text-xs text-ink-mute">
              <div className="min-w-0 truncate">
                <span>
                  Diff · {preview.applied}/{preview.blocks.length} applied
                  {preview.failed.length
                    ? ` · ${preview.failed.length} failed`
                    : ''}{' '}
                  · {preview.filePath}
                </span>
                {preview.failed.length > 0 && (
                  <div className="mt-0.5 truncate text-[10px] text-amber-400" title={preview.failed.map((f) => `#${f.index}: ${f.reason}`).join('\n')}>
                    {preview.failed.map((f) => `#${f.index}: ${f.reason}`).join(' · ')}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded px-2 py-1 hover:bg-ink-800"
                >
                  Reject <kbd className="ml-1 font-mono text-[10px]">Esc</kbd>
                </button>
                <button
                  type="button"
                  onClick={accept}
                  className="rounded bg-signal px-2 py-1 text-signal-on hover:bg-signal-dim"
                >
                  Accept <kbd className="ml-1 font-mono text-[10px]">Ctrl+Enter</kbd>
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <DiffEditor
                original={preview.original}
                modified={preview.modified}
                language={preview.languageId}
                theme={editorTheme}
                onMount={onDiffMount}
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  fontFamily: '"IBM Plex Mono", Consolas, monospace',
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  scrollbar: AFK_SCROLLBAR,
                  overviewRulerLanes: 0,
                  overviewRulerBorder: false
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
