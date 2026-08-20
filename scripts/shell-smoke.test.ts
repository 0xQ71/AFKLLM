import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeAgentShellCommand,
  peelLeadingCd,
  rewriteBashOperators,
  rewriteWhereAlias,
  rewriteWhichCommand,
  rewriteCompilerHelpProbe,
  rewriteBashHeredoc,
  stripAfkPtyChrome,
  isAfkPtyChromeLine,
  cliStdoutLooksVacuous,
  isCliVerifyCommand
} from '../src/shared/shellNormalize'
import {
  classifyBrowserOpenCommand,
  extractLocalPreviewUrl,
  extractOpenHtmlRelativePath,
  looksLikeLocalServerCommand,
  looksLikeViteScaffoldCommand,
  looksLikeLocalPreviewHealthCheck,
  looksLikeOpenHtmlCommand,
  normalizePreviewUrl,
  pathToFileUrl,
  rewriteLocalDevServerCommand,
  rewriteViteScaffoldCommand,
  AFK_SAFE_VITE_PORT,
  devCommandNeedsNodeModules
} from '../src/shared/localPreview'
import { processKillRefusal, compilerInstallRefusal } from '../src/shared/shellErrors'

describe('shellNormalize', () => {
  it('rewrites && and || outside quotes', () => {
    assert.equal(
      rewriteBashOperators('javac A.java && java A'),
      'javac A.java; if ($?) { java A }'
    )
    assert.equal(
      rewriteBashOperators('echo "a && b" && true'),
      'echo "a && b"; if ($?) { true }'
    )
    assert.equal(
      rewriteBashOperators('test -f x && echo yes || echo no'),
      'test -f x; if ($?) { echo yes }; if (-not $?) { echo no }'
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

  it('rewrites find|head and /dev/null for PowerShell', () => {
    const find = normalizeAgentShellCommand(
      'find . -name "index.html" -type f 2>/dev/null | head -5',
      '.',
      'win32'
    )
    assert.match(find.command, /Get-ChildItem/)
    assert.match(find.command, /Select-Object -First 5/)
    assert.doesNotMatch(find.command, /\/dev\/null/)
    assert.ok(find.note)

    const nullRedir = normalizeAgentShellCommand('dir 2>/dev/null', '.', 'win32')
    assert.match(nullRedir.command, /2>\$null/)
  })

  it('rewrites bash here-string to a PowerShell stdin pipe', () => {
    const r = normalizeAgentShellCommand(
      'go run wordfreq.go <<< "hello world hello"',
      '.',
      'win32'
    )
    assert.match(r.command, /Write-Output -- "hello world hello" \| go run wordfreq\.go/)
    assert.doesNotMatch(r.command, /<<</)
    assert.ok(r.note)
  })

  it('strips afk-run wrapper echo from PTY output', () => {
    const raw =
      `& 'C:\\Users\\iron\\AppData\\Local\\Temp\\afk-run-mt0gdyqt.ps1'; Remove-Item -LiteralPath 'C:\\Users\\iron\\AppData\\Local\\Temp\\afk-run-mt0gdyqt.ps1' -Force -ErrorAction SilentlyContinue\n` +
      '> Write-Output -- "hello world" | go run wordfreq.go\n' +
      'Топ-10 частых слов:\n' +
      '1. and 3\n' +
      '__AFK_EXIT_mt0gdyqt__0'
    const out = stripAfkPtyChrome(raw)
    assert.doesNotMatch(out, /afk-run-/i)
    assert.doesNotMatch(out, /__AFK_EXIT_/)
    assert.match(out, /> Write-Output/)
    assert.match(out, /Топ-10 частых слов/)
  })

  it('treats empty wordfreq stdout as vacuous even with exit 0', () => {
    assert.equal(
      cliStdoutLooksVacuous('> go run ./wordfreq.go test_input.txt\nНет слов для анализа.\n\nexit_code=0'),
      true
    )
    assert.equal(cliStdoutLooksVacuous('> go run wordfreq.go\n1. hello — 3\n2. foo — 2\n\nexit_code=0'), false)
  })

  it('rewrites cmd >nul and bare cwd .exe for PowerShell', () => {
    const nul = normalizeAgentShellCommand('where cl >nul 2>&1', '.', 'win32')
    assert.match(nul.command, />\$null/)
    assert.doesNotMatch(nul.command, />nul/)
    assert.match(nul.command, /where\.exe/)

    const exe = normalizeAgentShellCommand('wordfreq.exe test.txt', '.', 'win32')
    assert.equal(exe.command, '.\\wordfreq.exe test.txt')

    const already = normalizeAgentShellCommand('.\\wordfreq.exe test.txt', '.', 'win32')
    assert.equal(already.command.includes('.\\wordfreq.exe'), true)

    const cl = normalizeAgentShellCommand('cl.exe /EHsc wordfreq.cpp', '.', 'win32')
    assert.match(cl.command, /^cl\.exe /)
    assert.equal(isCliVerifyCommand('cl.exe /EHsc wordfreq.cpp'), false)
    assert.equal(isCliVerifyCommand('.\\wordfreq.exe test.txt'), true)
    assert.equal(isCliVerifyCommand('dotnet run -- project.csproj'), true)
  })

  it('rewrites PowerShell where alias to where.exe', () => {
    assert.equal(rewriteWhereAlias('where cl.exe'), 'where.exe cl.exe')
    const n = normalizeAgentShellCommand('where cl.exe', '.', 'win32')
    assert.equal(n.command, 'where.exe cl.exe')
    assert.equal(rewriteWhereAlias('Where-Object Name'), 'Where-Object Name')
    assert.equal(rewriteWhereAlias('where { $_.Name -eq "cl" }'), 'where { $_.Name -eq "cl" }')
    assert.equal(rewriteWhereAlias('where.exe gcc'), 'where.exe gcc')
  })

  it('rewrites which / compiler /? / bash heredoc for PowerShell', () => {
    assert.equal(rewriteWhichCommand('which cl'), 'where.exe cl')
    const which = normalizeAgentShellCommand('which csc', '.', 'win32')
    assert.equal(which.command, 'where.exe csc')
    assert.equal(rewriteCompilerHelpProbe('cl /? | Select-Object -First 3'), 'where.exe cl')
    const help = normalizeAgentShellCommand('csc /?', '.', 'win32')
    assert.equal(help.command, 'where.exe csc')
    const heredoc = rewriteBashHeredoc("cat > WordFreq.java <<'EOF'\nclass A {}\nEOF")
    assert.match(heredoc, /Set-Content/)
    assert.match(heredoc, /class A \{\}/)
    assert.equal(isAfkPtyChromeLine('ErrorAction SilentlyContinue'), true)
    assert.equal(isAfkPtyChromeLine('ntinue'), true)
    const crumb = stripAfkPtyChrome(
      'Remove-Item -LiteralPath x -Force -ErrorAction SilentlyContinue\n1. hello 3\n'
    )
    assert.doesNotMatch(crumb, /SilentlyContinue|ntinue/i)
    assert.match(crumb, /1\. hello 3/)
  })

  it('refuses machine package-manager toolchain installs, not project deps', () => {
    assert.match(
      compilerInstallRefusal('winget install --id MinGW.GCC') ?? '',
      /SHELL_REFUSED/
    )
    assert.match(compilerInstallRefusal('choco install mingw -y') ?? '', /SHELL_REFUSED/)
    assert.match(compilerInstallRefusal('winget install Python.Python.3.12') ?? '', /SHELL_REFUSED/)
    assert.match(
      compilerInstallRefusal('winget install Microsoft.DotNet.SDK.8') ?? '',
      /SHELL_REFUSED/
    )
    assert.match(
      compilerInstallRefusal(
        "Invoke-WebRequest -Uri 'https://github.com/niXman/mingw-builds-binaries/releases/latest' -OutFile release.json"
      ) ?? '',
      /SHELL_REFUSED/
    )
    assert.match(
      compilerInstallRefusal('curl -L -o gcc.tar.xz https://example.com/gcc.tar.xz') ?? '',
      /SHELL_REFUSED/
    )
    assert.equal(compilerInstallRefusal('cl /EHsc /Fe:wordfreq wordfreq.cpp'), null)
    assert.equal(compilerInstallRefusal('npm install'), null)
    assert.equal(compilerInstallRefusal('dotnet restore'), null)
    assert.equal(compilerInstallRefusal('curl -I http://localhost:4173'), null)
    assert.equal(processKillRefusal('npm run dev'), null)
  })

  it('strips PROCESS_ENDED leftover ontinue from PTY output', () => {
    const raw =
      'ontinue\n' +
      '> .\\wordfreq.exe test.txt\n' +
      'Top 10 most frequent words:\n' +
      'the — 7\n'
    const out = stripAfkPtyChrome(raw)
    assert.doesNotMatch(out, /ontinue/)
    assert.match(out, /Top 10/)
  })
})

describe('localPreview', () => {
  it('extracts Vite Local URL', () => {
    const url = extractLocalPreviewUrl(
      '  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.2:5173/'
    )
    assert.equal(url, 'http://localhost:5173/')
  })

  it('npm run dev needs node_modules; install and python do not', () => {
    assert.equal(devCommandNeedsNodeModules('npm run dev'), true)
    assert.equal(devCommandNeedsNodeModules('npm run dev -- --host 127.0.0.1'), true)
    assert.equal(devCommandNeedsNodeModules('npm install'), false)
    assert.equal(devCommandNeedsNodeModules('python -m http.server 4173'), false)
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
    assert.equal(
      extractLocalPreviewUrl('  ➜  Local:   http://localhost:5173/', { denyPorts: [5173] }),
      null
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
    assert.equal(looksLikeOpenHtmlCommand("Start-Process 'index.html'"), true)
    assert.equal(looksLikeOpenHtmlCommand('Start-Process index.html'), true)
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
    assert.equal(
      extractOpenHtmlRelativePath(
        'Start-Process "D:\\projects\\afkllm\\afkllm\\dist\\browser.html"',
        '.'
      ),
      'index.html'
    )
  })

  it('detects common serve commands', () => {
    assert.equal(looksLikeLocalServerCommand('npm run dev'), true)
    assert.equal(looksLikeLocalServerCommand('npx vite'), true)
    assert.equal(looksLikeLocalServerCommand('python -m http.server 8080'), true)
    assert.equal(looksLikeLocalServerCommand('javac Main.java'), false)
  })

  it('treats Vite Local: on port 3000 as a ready preview URL', () => {
    const url = extractLocalPreviewUrl(
      '  ➜  Local:   http://localhost:3000/\n  ➜  Network: use --host to expose'
    )
    assert.equal(url, 'http://localhost:3000/')
  })

  it('pins Vite npm run dev off 3000/5173/8080 when no --port', () => {
    assert.equal(
      rewriteLocalDevServerCommand('npm run dev'),
      `npm run dev -- --host 127.0.0.1 --port ${AFK_SAFE_VITE_PORT}`
    )
    assert.equal(
      rewriteLocalDevServerCommand('npm run dev -- --port 5174'),
      'npm run dev -- --port 5174 --host 127.0.0.1'
    )
    assert.equal(
      rewriteLocalDevServerCommand('npm run dev -- --host 127.0.0.1 --port 3000'),
      `npm run dev -- --host 127.0.0.1 --port ${AFK_SAFE_VITE_PORT}`
    )
    assert.equal(
      rewriteLocalDevServerCommand('npx vite --port 5173'),
      `npx vite --port ${AFK_SAFE_VITE_PORT} --host 127.0.0.1`
    )
    assert.equal(rewriteLocalDevServerCommand('python -m http.server 8000'), 'python -m http.server 8000')
  })

  it('treats curl -I localhost as a preview health check', () => {
    assert.equal(looksLikeLocalPreviewHealthCheck('curl -I http://localhost:4173'), true)
    assert.equal(looksLikeLocalPreviewHealthCheck('Invoke-WebRequest http://127.0.0.1:4173'), true)
    assert.equal(looksLikeLocalPreviewHealthCheck('curl https://github.com/foo'), false)
    assert.equal(looksLikeLocalPreviewHealthCheck('npm run dev'), false)
  })

  it('does not treat create-vite as a local server or pin --port 4173', () => {
    const create = 'npm create vite@latest fishing-game -- --template react'
    assert.equal(looksLikeViteScaffoldCommand(create), true)
    assert.equal(looksLikeLocalServerCommand(create), false)
    assert.equal(
      rewriteLocalDevServerCommand(create),
      create
    )
    assert.equal(
      rewriteViteScaffoldCommand(create),
      'npx --yes create-vite@latest . --template react --no-interactive'
    )
    assert.equal(
      looksLikeLocalServerCommand(rewriteViteScaffoldCommand(create)),
      false
    )
    assert.equal(
      rewriteViteScaffoldCommand(
        'npm create vite@latest fishing-game -- --template react --host 127.0.0.1 --port 4173'
      ),
      'npx --yes create-vite@latest . --template react --no-interactive'
    )
    assert.equal(looksLikeLocalServerCommand('npm run dev'), true)
    assert.equal(
      rewriteLocalDevServerCommand('npm run dev'),
      `npm run dev -- --host 127.0.0.1 --port ${AFK_SAFE_VITE_PORT}`
    )
  })

  it('refuses taskkill / Stop-Process of arbitrary PIDs', () => {
    assert.match(processKillRefusal('taskkill /PID 4192 /F') ?? '', /SHELL_REFUSED/)
    assert.match(processKillRefusal('Stop-Process -Id 4192 -Force') ?? '', /SHELL_REFUSED/)
    assert.equal(processKillRefusal('npm run dev'), null)
  })
})
