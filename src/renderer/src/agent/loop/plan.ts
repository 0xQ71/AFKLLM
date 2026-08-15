import type { AgentTodoStep } from '../agentPure'
import {
  evidenceSupportsStep,
  recordEvidence,
  evidenceFromTool,
  type StepEvidence
} from './evidence'

function rebalance(steps: AgentTodoStep[]): AgentTodoStep[] {
  if (steps.some((s) => s.status === 'in_progress')) return steps
  const p = steps.find((s) => s.status === 'pending')
  if (p) p.status = 'in_progress'
  return steps
}

/**
 * Close a plan row only when this tool produced matching evidence.
 * Successful list/read/search never ticks a product step.
 */
export function advanceTodosOnEvidence(
  steps: AgentTodoStep[],
  evidence: StepEvidence[],
  tool: { name: string; ok: boolean; path?: string; command?: string; content?: string }
): { steps: AgentTodoStep[]; evidence: StepEvidence[] } {
  const ev = evidenceFromTool(tool)
  const nextEvidence = ev ? recordEvidence(evidence, ev) : evidence
  if (!tool.ok || steps.length === 0 || !ev) {
    return { steps, evidence: nextEvidence }
  }

  const next = steps.map((s) => ({ ...s }))
  let marked = 0
  for (const s of next) {
    if (s.status === 'done') continue
    if (evidenceSupportsStep(s.text, nextEvidence)) {
      s.status = 'done'
      marked++
    }
  }
  if (marked === 0) return { steps: next, evidence: nextEvidence }
  return { steps: rebalance(next), evidence: nextEvidence }
}

/** Never treat “all checkboxes” as proof the user task is done. */
export function planCheckmarksAreNotSuccess(steps: AgentTodoStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.status === 'done')
}
