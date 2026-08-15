import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatTelemetryLogLine,
  normalizeTelemetryEvent,
  parseTelemetryLogText,
  rotateLogContent
} from '../src/shared/telemetry'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

describe('normalizeTelemetryEvent', () => {
  it('accepts ui_boundary events', () => {
    const ev = normalizeTelemetryEvent({
      kind: 'ui_boundary',
      message: 'boom',
      stack: 'Error: boom\n  at x',
      source: 'renderer'
    })
    assert.ok(ev)
    assert.equal(ev!.kind, 'ui_boundary')
    assert.equal(ev!.message, 'boom')
    assert.ok(ev!.at)
  })

  it('rejects empty message / bad kind', () => {
    assert.equal(normalizeTelemetryEvent({ kind: 'error', message: '  ' }), null)
    assert.equal(normalizeTelemetryEvent({ kind: 'nope', message: 'x' }), null)
  })
})

describe('formatTelemetryLogLine', () => {
  it('includes kind and message', () => {
    const line = formatTelemetryLogLine({
      kind: 'error',
      message: 'hello world',
      at: '2026-01-01T00:00:00.000Z',
      source: 'test'
    })
    assert.match(line, /ERROR/)
    assert.match(line, /hello world/)
    assert.match(line, /\[test\]/)
  })

  it('includes extra fields on the same line', () => {
    const line = formatTelemetryLogLine({
      kind: 'info',
      message: 'round result',
      at: '2026-01-01T00:00:00.000Z',
      source: 'agent:tool',
      extra: { round: 0, toolCalls: 1 }
    })
    assert.match(line, /round result/)
    assert.match(line, /"toolCalls":1/)
  })
})

describe('parseTelemetryLogText', () => {
  it('parses timestamp, level, and message', () => {
    const text = formatTelemetryLogLine({
      kind: 'info',
      message: 'Server started.',
      at: '2026-01-01T04:16:27.000Z',
      source: 'main'
    })
    const entries = parseTelemetryLogText(text)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.level, 'INFO')
    assert.match(entries[0]!.message, /Server started/)
    assert.match(entries[0]!.time, /\d{2}:\d{2}:\d{2}/)
  })

  it('attaches stack continuation lines', () => {
    const entries = parseTelemetryLogText(
      '2026-01-01T00:00:00.000Z ERROR boom\n  at foo\n  at bar\n'
    )
    assert.equal(entries.length, 1)
    assert.match(entries[0]!.message, /boom/)
    assert.match(entries[0]!.message, /at foo/)
  })
})

describe('rotateLogContent', () => {
  it('keeps content under max', () => {
    const s = 'abc\n'
    assert.equal(rotateLogContent(s, 100, 50), s)
  })

  it('trims oversized logs', () => {
    const big = 'x'.repeat(2000) + '\nline2\n'
    const out = rotateLogContent(big, 500, 200)
    assert.ok(out.startsWith('--- log rotated ---'))
    assert.ok(Buffer.byteLength(out, 'utf8') < 500)
  })
})

describe('collectLogsToFile default', () => {
  it('defaults to true', () => {
    assert.equal(DEFAULT_SETTINGS.collectLogsToFile, true)
  })
})
