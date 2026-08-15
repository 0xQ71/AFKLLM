import type { SearchReplaceBlock } from '../../../shared/types'
import {
  applySearchReplaceBlocks,
  parseSearchReplaceBlocks as parseShared,
  type ApplyBlocksResult
} from '../../../shared/fastApply'
import { formatNowForAgent } from '../agent/agentPure'

export type { ApplyBlocksResult }
export { applySearchReplaceBlocks }
export function parseSearchReplaceBlocks(
  text: string,
  opts?: { allowEmptySearch?: boolean }
): SearchReplaceBlock[] {
  return parseShared(text, { allowEmptySearch: opts?.allowEmptySearch ?? true })
}

/** Build the system + user prompts for Ctrl+K inline edit. */
export function buildInlineEditMessages(params: {
  instruction: string
  selectedCode: string
  filePath: string
  surroundingContext: string
  languageId: string
}): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `You are a precise code-editing assistant.
Return ONLY one or more SEARCH/REPLACE blocks. No prose, no markdown fences.

Format (exact markers):
<<<<<<< SEARCH
[exact original snippet to find]
=======
[replacement snippet]
>>>>>>> REPLACE

Rules:
- SEARCH must match the file (or a unique substring) EXACTLY, including whitespace.
- Prefer the smallest unique SEARCH that covers the change.
- Multiple disjoint SEARCH/REPLACE blocks are encouraged when several independent edits are needed.
- Do not merge unrelated edits into one block.
- Language: ${params.languageId}

${formatNowForAgent()}`

  const user = `File: ${params.filePath}

Surrounding context (±50 lines):
\`\`\`${params.languageId}
${params.surroundingContext}
\`\`\`

Selected code to edit:
\`\`\`${params.languageId}
${params.selectedCode}
\`\`\`

Instruction: ${params.instruction}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]
}

/** Extract ±N lines around a 1-based selection range. */
export function extractSurroundingLines(
  fullText: string,
  startLine1: number,
  endLine1: number,
  radius = 50
): string {
  const lines = fullText.replace(/\r\n/g, '\n').split('\n')
  const from = Math.max(0, startLine1 - 1 - radius)
  const to = Math.min(lines.length, endLine1 + radius)
  return lines.slice(from, to).join('\n')
}

/** Re-export for callers that typed against local SearchReplaceBlock usage. */
export type { SearchReplaceBlock }
