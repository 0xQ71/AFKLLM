import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeAgentShellCommand,
  peelLeadingCd,
  rewriteBashOperators
} from '../src/shared/shellNormalize'
import {
  classifyBrowserOpenCommand,
  extractLocalPreviewUrl,
  extractOpenHtmlRelativePath,
  looksLikeLocalServerCommand,
  looksLikeOpenHtmlCommand,
  normalizePreviewUrl,
  pathToFileUrl
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

  it('ignores LLM bare port / echo; keeps Vite Local (any port)', () => {
    assert.equal(
      extractLocalPreviewUrl('> Start-Process chrome.exe http://127.0.0.1:8080/index.html'),
      null
    )
    assert.equal(
      extractLocalPreviewUrl('Listening on http://127.0.0.1:8080/', { denyPorts: [8080] }),
      null
    )
    assert.equal(
      extractLocalPreviewUrl('  ➜  Local:   http://localhost:5173/'),
      'http://localhost:5173/'
    )
    // Labeled Vite/serve on 8080 is allowed (real preview), not bare LLM URL
    assert.equal(
      extractLocalPreviewUrl('  ➜  Local:   http://localhost:8080/', { denyPorts: [8080] }),
      'http://localhost:8080/'
    )
  })

  it('classifies file open vs Vite URL vs LLM mistake', () => {
    assert.equal(
      classifyBrowserOpenCommand('Start-Process (Resolve-Path .\\index.html)')?.kind,
      'workspace_html'
    )
    assert.deepEqual(
      classifyBrowserOpenCommand('Start-Process chrome.exe http://localhost:5173/'),
      { kind: 'local_http', url: 'http://localhost:5173/' }
    )
    assert.equal(
      classifyBrowserOpenCommand(
        'Start-Process chrome.exe http://127.0.0.1:8080/index.html',
        [8080]
      )?.kind,
      'llm_mistake'
    )
    assert.equal(looksLikeOpenHtmlCommand('Start-Process chrome.exe http://localhost:5173/'), true)
  })

  it('pathToFileUrl + open-html path extraction', () => {
    assert.equal(pathToFileUrl('D:\\test\\index.html'), 'file:///D:/test/index.html')
    assert.equal(
      extractOpenHtmlRelativePath(
        'Start-Process "index.html" -WorkingDirectory "D:\\test"',
        '.'
      ),
      'index.html'
    )
    assert.equal(
      extractOpenHtmlRelativePath('Start-Process (Resolve-Path .\\index.html)', '.'),
      'index.html'
    )
  })

  it('detects common serve commands', () => {
    assert.equal(looksLikeLocalServerCommand('npm run dev'), true)
    assert.equal(looksLikeLocalServerCommand('npx vite'), true)
    assert.equal(looksLikeLocalServerCommand('python -m http.server 8080'), true)
    assert.equal(looksLikeLocalServerCommand('javac Main.java'), false)
  })
})
