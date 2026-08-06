import { languageIdFromPath } from './language'

export interface EditorTab {
  path: string
  name: string
  content: string
  language: string
  dirty: boolean
}

export function createTab(path: string, content: string): EditorTab {
  const normalized = path.replace(/\\/g, '/')
  const name = normalized.split('/').pop() || normalized
  return {
    path: normalized,
    name,
    content,
    language: languageIdFromPath(normalized),
    dirty: false
  }
}
