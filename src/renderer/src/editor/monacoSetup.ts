import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { monacoThemeId, type UiTheme } from '../../../shared/theme'

/**
 * Bundle Monaco from node_modules — Electron CSP blocks the CDN,
 * which is why the editor stuck on "Loading…".
 */
export const AFK_EDITOR_THEME = 'afkllm-classic'

export function setupMonaco(): typeof monaco {
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === 'json') return new jsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    }
  }

  loader.config({ monaco })

  // Enable Cursor-like TS/JS hover + syntax markers from Monaco's ts.worker.
  const tsDefaults = monaco.languages.typescript.typescriptDefaults
  const jsDefaults = monaco.languages.typescript.javascriptDefaults
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    esModuleInterop: true,
    allowJs: true,
    checkJs: false,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    reactNamespace: 'React',
    allowSyntheticDefaultImports: true
  }
  tsDefaults.setCompilerOptions(compilerOptions)
  jsDefaults.setCompilerOptions(compilerOptions)
  tsDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false
  })
  jsDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false
  })

  monaco.editor.defineTheme('afkllm-classic', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1f1f1f',
      'editorGutter.background': '#1f1f1f',
      'editorLineNumber.foreground': '#6e6e6e',
      'editorLineNumber.activeForeground': '#9d9d9d',
      'editorCursor.foreground': '#3794ff',
      'editor.selectionBackground': '#3794ff44',
      'editor.inactiveSelectionBackground': '#3794ff22',
      'editor.lineHighlightBackground': '#2b2b2b66',
      'editorWidget.background': '#181818',
      'editorWidget.border': '#2b2b2b',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#3c3c3c66',
      'scrollbarSlider.hoverBackground': '#505050aa',
      'scrollbarSlider.activeBackground': '#3794ff99',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#1f1f1f'
    }
  })

  // Alias for older code paths
  monaco.editor.defineTheme('afkllm-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
      'editorGutter.background': '#1e1e1e',
      'editorLineNumber.foreground': '#858585',
      'editorLineNumber.activeForeground': '#b0b0b0',
      'editorCursor.foreground': '#3794ff',
      'editor.selectionBackground': '#3794ff44',
      'editor.inactiveSelectionBackground': '#3794ff22',
      'editor.lineHighlightBackground': '#2a2d2e66',
      'editorWidget.background': '#252526',
      'editorWidget.border': '#3c3c3c',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#42424266',
      'scrollbarSlider.hoverBackground': '#4e4e4eaa',
      'scrollbarSlider.activeBackground': '#3794ff99',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#1e1e1e'
    }
  })

  monaco.editor.defineTheme('afkllm-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editorGutter.background': '#ffffff',
      'editorLineNumber.foreground': '#8b8b8b',
      'editorLineNumber.activeForeground': '#616161',
      'editorCursor.foreground': '#005fb8',
      'editor.selectionBackground': '#add6ff',
      'editor.inactiveSelectionBackground': '#e5ebf1',
      'editor.lineHighlightBackground': '#f3f3f3',
      'editorWidget.background': '#f3f3f3',
      'editorWidget.border': '#e5e5e5',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#c8c8c866',
      'scrollbarSlider.hoverBackground': '#a8a8a8aa',
      'scrollbarSlider.activeBackground': '#005fb899',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#ffffff'
    }
  })

  monaco.editor.defineTheme('afkllm-sepia', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#faf6eb',
      'editorGutter.background': '#faf6eb',
      'editorLineNumber.foreground': '#9a856c',
      'editorLineNumber.activeForeground': '#7a654e',
      'editorCursor.foreground': '#8b5a2b',
      'editor.selectionBackground': '#c4a57466',
      'editor.inactiveSelectionBackground': '#e8dcc466',
      'editor.lineHighlightBackground': '#f4ecd8',
      'editorWidget.background': '#f4ecd8',
      'editorWidget.border': '#d4c4a8',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#c4a57466',
      'scrollbarSlider.hoverBackground': '#a88858aa',
      'scrollbarSlider.activeBackground': '#8b5a2b99',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#faf6eb'
    }
  })

  monaco.editor.defineTheme('afkllm-deep-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#000000',
      'editorGutter.background': '#000000',
      'editorLineNumber.foreground': '#6a6a6a',
      'editorLineNumber.activeForeground': '#9a9a9a',
      'editorCursor.foreground': '#3794ff',
      'editor.selectionBackground': '#3794ff44',
      'editor.inactiveSelectionBackground': '#3794ff22',
      'editor.lineHighlightBackground': '#0a0a0a',
      'editorWidget.background': '#000000',
      'editorWidget.border': '#1a1a1a',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#22222266',
      'scrollbarSlider.hoverBackground': '#333333aa',
      'scrollbarSlider.activeBackground': '#3794ff99',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#000000'
    }
  })

  monaco.editor.defineTheme('afkllm-amoled', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#000000',
      'editorGutter.background': '#000000',
      'editorLineNumber.foreground': '#6a6a6a',
      'editorLineNumber.activeForeground': '#9a9a9a',
      'editorCursor.foreground': '#3794ff',
      'editor.selectionBackground': '#3794ff44',
      'editor.inactiveSelectionBackground': '#3794ff22',
      'editor.lineHighlightBackground': '#0a0a0a',
      'editorWidget.background': '#000000',
      'editorWidget.border': '#1a1a1a',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#22222266',
      'scrollbarSlider.hoverBackground': '#333333aa',
      'scrollbarSlider.activeBackground': '#3794ff99',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#000000'
    }
  })

  monaco.editor.defineTheme('afkllm-solarized-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#002b36',
      'editorGutter.background': '#002b36',
      'editorLineNumber.foreground': '#586e75',
      'editorLineNumber.activeForeground': '#839496',
      'editorCursor.foreground': '#268bd2',
      'editor.selectionBackground': '#073642aa',
      'editor.inactiveSelectionBackground': '#07364266',
      'editor.lineHighlightBackground': '#073642',
      'editorWidget.background': '#073642',
      'editorWidget.border': '#586e75',
      'scrollbar.shadow': '#00000000',
      'scrollbarSlider.background': '#586e7566',
      'scrollbarSlider.hoverBackground': '#657b83aa',
      'scrollbarSlider.activeBackground': '#268bd299',
      'editorOverviewRuler.border': '#00000000',
      'minimap.background': '#002b36'
    }
  })

  return monaco
}

export function applyMonacoTheme(theme: UiTheme): void {
  monaco.editor.setTheme(monacoThemeId(theme))
}

export const AFK_SCROLLBAR = {
  verticalScrollbarSize: 8,
  horizontalScrollbarSize: 8,
  arrowSize: 0,
  useShadows: false,
  verticalHasArrows: false,
  horizontalHasArrows: false,
  vertical: 'auto' as const,
  horizontal: 'auto' as const,
  alwaysConsumeMouseWheel: false
}
