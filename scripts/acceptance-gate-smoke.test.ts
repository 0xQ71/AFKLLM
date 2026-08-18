/**
 * Smoke: acceptance gate — no false pass / no describe-it nudge after green tests.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateAcceptanceGate, userAskedForCliSmoke } from '../src/renderer/src/agent/agentPure.ts'

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

describe('userAskedForCliSmoke', () => {
  const t01 =
    'Создай в корне проекта Python-скрипт wordfreq.py: считает частоту слов из аргумента-файла или stdin, без учёта регистра, печатает топ-10. Сразу после записи запусти его на коротком тестовом тексте и покажи реальный вывод терминала.'

  it('does not treat a Python stdin script as a product CLI', () => {
    assert.equal(userAskedForCliSmoke(t01), false)
    const g = evaluateAcceptanceGate({
      ...base,
      finalText: 'Готово. wordfreq.py написан и запущен, exit_code=0.',
      userWantsNodeTest: false,
      userWantsCli: userAskedForCliSmoke(t01),
      lastNodeTestOk: null,
      completedTools: 2
    })
    assert.equal(g.hardMissing.length, 0)
    assert.equal(g.looksPrematureDone, false)
  })

  it('detects a JSON cli.js smoke request', () => {
    assert.equal(
      userAskedForCliSmoke(
        'Write cli.js: a CLI that reads argv JSON and/or stdin and prints one JSON result line.'
      ),
      true
    )
  })
})
