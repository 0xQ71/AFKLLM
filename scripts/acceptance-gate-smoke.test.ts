/**
 * Smoke: acceptance gate — no false pass / no describe-it nudge after green tests.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateAcceptanceGate } from '../src/renderer/src/agent/agentPure.ts'

const base = {
  userWantsWebSearch: false,
  userWantsCli: false,
  usedWebSearch: false,
  ranCliSmoke: false,
  incompleteCount: 0,
  failedCount: 0,
  completedTools: 4
}

describe('evaluateAcceptanceGate', () => {
  it('does not nudge after Task completed when latest node --test is green', () => {
    const g = evaluateAcceptanceGate({
      ...base,
      finalText: 'Task completed. Tests pass: node --test scripts/afk_stats.test.mjs.',
      userWantsNodeTest: true,
      lastNodeTestOk: true
    })
    assert.equal(g.acceptanceDone, true)
    assert.equal(g.looksPrematureDone, false)
    assert.equal(g.hardMissing.length, 0)
  })

  it('nudges when model claims pass but latest test failed', () => {
    const g = evaluateAcceptanceGate({
      ...base,
      finalText: 'Task completed. Tests pass.',
      userWantsNodeTest: true,
      lastNodeTestOk: false
    })
    assert.equal(g.acceptanceDone, false)
    assert.equal(g.looksPrematureDone, true)
    assert.match(g.hardMissing.join('\n'), /FAILED/)
  })

  it('nudges when model claims pass but never ran tests', () => {
    const g = evaluateAcceptanceGate({
      ...base,
      finalText: 'Task completed.',
      userWantsNodeTest: true,
      lastNodeTestOk: null
    })
    assert.equal(g.looksPrematureDone, true)
    assert.match(g.hardMissing.join('\n'), /until green/)
  })

  it('does not require "test: PASS" wording when shell was green', () => {
    const g = evaluateAcceptanceGate({
      ...base,
      finalText: 'Task completed. Created scripts/afk_stats.mjs.',
      userWantsNodeTest: true,
      lastNodeTestOk: true
    })
    assert.equal(g.acceptanceDone, true)
    assert.equal(g.looksPrematureDone, false)
  })
})
