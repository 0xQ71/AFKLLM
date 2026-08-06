import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeAgentShellCommand,
  peelLeadingCd,
  rewriteBashOperators
} from '../src/shared/shellNormalize'
import {
  extractLocalPreviewUrl,
  looksLikeLocalServerCommand,
  normalizePreviewUrl
} from '../src/shared/localPreview'

describe('shellNormalize', () => {
  it('rewrites && and || outside quotes', () => {
    assert.equal(rewriteBashOperators('javac A.java && java A'), 'javac A.java; java A')
    assert.equal(
      rewriteBashOperators('echo "a && b" && true'),
      'echo "a && b"; true'
    )
  })

  it('peels leading cd into cwd', () => {
    const r = peelLeadingCd('cd Calculator/src && javac Calculator.java', '.')
    assert.equal(r.cwdRel, 'Calculator/src')
    assert.equal(r.command, 'javac Calculator.java')
  })

  it('normalizeAgentShellCommand on win32', () => {
    const r = normalizeAgentShellCommand(
      'cd Calculator && javac --module-path src -m Calculator',
      '.',
      'win32'
    )
    assert.equal(r.cwdRel, 'Calculator')
    assert.equal(r.command, 'javac --module-path src -m Calculator')
    assert.ok(r.note)
  })

  it('keeps explicit cwd when peeling', () => {
    const r = normalizeAgentShellCommand('cd other && ls', 'Calculator', 'win32')
    assert.equal(r.cwdRel, 'Calculator')
    assert.match(r.command, /cd other/)
  })
})

describe('localPreview', () => {
  it('extracts Vite Local URL', () => {
    const url = extractLocalPreviewUrl(
      '  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.2:5173/'
    )
    assert.equal(url, 'http://localhost:5173/')
  })

  it('rewrites 0.0.0.0 to 127.0.0.1', () => {
    assert.equal(
      normalizePreviewUrl('http://0.0.0.0:8080/'),
      'http://127.0.0.1:8080/'
    )
    const url = extractLocalPreviewUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/)')
    assert.equal(url, 'http://127.0.0.1:8000/')
  })

  it('detects common serve commands', () => {
    assert.equal(looksLikeLocalServerCommand('npm run dev'), true)
    assert.equal(looksLikeLocalServerCommand('npx vite'), true)
    assert.equal(looksLikeLocalServerCommand('python -m http.server 8080'), true)
    assert.equal(looksLikeLocalServerCommand('javac Main.java'), false)
  })
})
