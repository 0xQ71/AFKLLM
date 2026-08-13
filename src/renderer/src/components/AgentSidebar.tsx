import { ChatPanel } from './ChatPanel'
import type { QueueManager } from '../llm/queueManager'
import type { EditorSelectionContext } from '../agent/runAgentTurn'
import type { SessionMeta } from './ChatPanel'

interface AgentSidebarProps {
  queue: QueueManager
  openFile?: { path: string; content: string }
  selection?: EditorSelectionContext | null
  llmReady: boolean
  ctxSize?: number | null
  editorTheme?: string
  onOpenPath?: (relativePath: string) => void
  newAgentSignal?: number
  switchSessionSignal?: { id: string; nonce: number } | null
  hideSessionChrome?: boolean
  onSessionsChange?: (sessions: SessionMeta[], activeId: string | null) => void
  headerActions?: React.ReactNode
  workspaceKey?: string | null
  gitBranch?: string | null
  needsFolderToChat?: boolean
  onRequestFolderForSend?: (text: string) => void
  pendingSendSignal?: { text: string; nonce: number; restoreOnly?: boolean } | null
  onOpenFolder?: () => void
  onOpenImagePreview?: (url: string, name?: string) => void
  onOpenImageGenSettings?: () => void
}

export function AgentSidebar(props: AgentSidebarProps): React.JSX.Element {
  return <ChatPanel {...props} fill />
}
