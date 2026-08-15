import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { detectStacks, commandForMode, formatStackPromptSection } from '../src/shared/projectStack'
import {
  extractErrorFocus,
  isUserInterruptExit,
  looksLikeGuiLaunchCommand,
  productReadmeCloneRefusal,
  recursiveListingRefusal
} from '../src/shared/shellErrors'
import {
  userAskedVerify,
  shouldNudgeVerify,
  stackSupportsVerify
} from '../src/renderer/src/agent/loop/verify'
import { allowsFullOverwrite } from '../src/shared/writeThresholds'
import { contentLooksStructurallyComplete, isLandingJsPath, isSourcePath } from '../src/renderer/src/agent/loop/completeness'
import { evidenceSupportsStep, evidenceFromTool, recordEvidence } from '../src/renderer/src/agent/loop/evidence'
import { advanceTodosOnEvidence } from '../src/renderer/src/agent/loop/plan'
import { AgentToolRegistry } from '../src/main/agent/AgentToolRegistry'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('stack detect', () => {
  it('detects Maven, Go, CMake, csproj, Python, Cargo, npm', () => {
    const files = [
      'pom.xml',
      'go.mod',
      'CMakeLists.txt',
      'App.csproj',
      'requirements.txt',
      'Cargo.toml',
      'package.json'
    ]
    const ids = detectStacks(files).map((s) => s.id).sort()
    assert.ok(ids.includes('java-maven'))
    assert.ok(ids.includes('go'))
    assert.ok(ids.includes('cmake'))
    assert.ok(ids.includes('dotnet'))
    assert.ok(ids.includes('python'))
    assert.ok(ids.includes('rust'))
    assert.ok(ids.includes('node'))
  })

  it('commandForMode uses stack defaults', () => {
    const [go] = detectStacks(['go.mod'])
    assert.equal(commandForMode(go!, 'build'), 'go build ./...')
    assert.equal(commandForMode(go!, 'test'), 'go test ./...')
  })

  it('unknown stack prompt does not mention Bootstrap', () => {
    const text = formatStackPromptSection([])
    assert.match(text, /unknown/i)
    assert.doesNotMatch(text, /Bootstrap/)
  })

  it('static HTML prompt forbids recursive verify scavenger hunts', () => {
    const [html] = detectStacks(['index.html'])
    assert.equal(html?.id, 'html')
    assert.equal(commandForMode(html!, 'build'), null)
    assert.equal(stackSupportsVerify([html!]), false)
    const text = formatStackPromptSection([html!])
    assert.match(text, /FORBIDDEN|Get-ChildItem -Recurse/i)
    assert.match(text, /one preview|one-shot|ONCE/i)
  })
})

describe('verify nudge intent', () => {
  it('does not treat «после сборки открой» as a verify ask', () => {
    assert.equal(
      userAskedVerify('После сборки открой index.html в превью и кратко подтверди'),
      false
    )
    assert.equal(userAskedVerify('Сделай профессиональный лендинг для AFKLLM'), false)
    assert.equal(shouldNudgeVerify({ userText: 'После сборки открой', stacks: [] }), false)
  })

  it('fires only on explicit test/build asks when the stack has commands', () => {
    assert.equal(userAskedVerify('проверь сборку проекта'), true)
    assert.equal(userAskedVerify('запусти тесты'), true)
    assert.equal(userAskedVerify('run npm test'), true)
    const node = detectStacks(['package.json'])[0]!
    assert.equal(stackSupportsVerify([node]), true)
    assert.equal(
      shouldNudgeVerify({ userText: 'проверь сборку', stacks: [node] }),
      true
    )
    const html = detectStacks(['index.html'])[0]!
    assert.equal(
      shouldNudgeVerify({ userText: 'проверь сборку', stacks: [html] }),
      false
    )
  })
})

describe('recursive listing refusal', () => {
  it('blocks unbounded Get-ChildItem -Recurse', () => {
    assert.match(
      recursiveListingRefusal('Get-ChildItem -Recurse -File | Select-Object FullName') ?? '',
      /SHELL_REFUSED/
    )
    assert.equal(recursiveListingRefusal('Get-ChildItem -Depth 2'), null)
    assert.equal(recursiveListingRefusal('npm test'), null)
  })
})

describe('product README clone refusal', () => {
  it('blocks cloning AFKLLM or cloning into /tmp', () => {
    assert.match(
      productReadmeCloneRefusal(
        'git clone https://github.com/0xQ71/AFKLLM.git /tmp/afkllm-repo'
      ) ?? '',
      /SHELL_REFUSED/
    )
    assert.match(
      productReadmeCloneRefusal('git clone https://github.com/foo/bar.git /tmp/bar') ?? '',
      /SHELL_REFUSED/
    )
    assert.equal(productReadmeCloneRefusal('git clone https://github.com/foo/bar.git'), null)
    assert.equal(productReadmeCloneRefusal('git status'), null)
  })
})

describe('verify_project static HTML one-shot', () => {
  it('checks entry files without shell and without recurse', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-html-verify-'))
    try {
      await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>x</title>', 'utf8')
      await fs.writeFile(path.join(root, 'styles.css'), 'body{}', 'utf8')
      await fs.mkdir(path.join(root, 'js'))
      await fs.writeFile(path.join(root, 'js', 'main.js'), 'console.log(1)', 'utf8')
      const reg = new AgentToolRegistry({ projectRoot: root })
      const res = await reg.invoke({
        id: '1',
        name: 'verify_project',
        arguments: { mode: 'build' }
      })
      assert.equal(res.ok, true)
      assert.match(res.content, /static HTML/)
      assert.match(res.content, /OK {2}index\.html/)
      assert.match(res.content, /Do NOT Get-ChildItem -Recurse/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('shell honesty', () => {
  it('Go / C# / rust / cmake / pytest / gcc markers are ERROR_FOCUS', () => {
    assert.match(extractErrorFocus('main.go:12:4: undefined: Foo') ?? '', /main\.go:12:4/)
    assert.match(extractErrorFocus('error CS1001: Identifier expected') ?? '', /CS1001/)
    assert.match(extractErrorFocus('error[E0308]: mismatched types') ?? '', /E0308/)
    assert.match(extractErrorFocus('CMake Error: ...') ?? '', /CMake Error/)
    assert.match(extractErrorFocus('===== FAILURES =====\nE   AssertionError') ?? '', /FAILURES|AssertionError/)
    assert.match(extractErrorFocus('[  FAILED  ] Foo.Bar') ?? '', /FAILED/)
    assert.match(extractErrorFocus('FAILURE: Build failed with an exception.') ?? '', /FAILURE: Build failed/)
    assert.match(extractErrorFocus('foo.c:10:2: error: unknown type') ?? '', /foo\.c:10:2/)
  })

  it('Ctrl+C codes are user interrupt; GUI launch is detected by command', () => {
    assert.equal(isUserInterruptExit(0xc000013a), true)
    assert.equal(isUserInterruptExit(1), false)
    assert.equal(looksLikeGuiLaunchCommand('Start-Process .\\app.exe'), true)
    assert.equal(looksLikeGuiLaunchCommand('go build ./...'), false)
  })

  it('nonzero exit without traceback is ok:false', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-shell-'))
    try {
      const reg = new AgentToolRegistry({
        projectRoot: root,
        confirmTerminal: async () => true,
        runVisibleCommand: async () => ({
          output: 'compile failed (no standard marker)',
          exitCode: 1
        })
      })
      const r = await reg.invoke({
        id: '1',
        name: 'execute_terminal_command',
        arguments: { command: 'go build .' }
      })
      assert.equal(r.ok, false)
      assert.match(r.content, /TERMINAL_ERROR/)
      assert.match(r.content, /exit_code=1/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('GUI close without traceback stays PROCESS_ENDED', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'afkllm-gui-'))
    try {
      const reg = new AgentToolRegistry({
        projectRoot: root,
        confirmTerminal: async () => true,
        runVisibleCommand: async () => ({
          output: '',
          exitCode: 1
        })
      })
      const r = await reg.invoke({
        id: '1',
        name: 'execute_terminal_command',
        arguments: { command: 'Start-Process .\\Calculator.exe' }
      })
      assert.equal(r.ok, true)
      assert.match(r.content, /PROCESS_ENDED/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('completeness by language', () => {
  it('HTML still needs </html>', () => {
    assert.equal(contentLooksStructurallyComplete('<html><body>hi', 'index.html'), false)
    assert.equal(
      contentLooksStructurallyComplete('<html><body>hi</body></html>', 'index.html'),
      true
    )
  })

  it('Java / Go / Python / JSON are not forever-incomplete', () => {
    assert.equal(
      contentLooksStructurallyComplete(
        'class A { public static void main(String[] a) {} }',
        'A.java'
      ),
      true
    )
    assert.equal(
      contentLooksStructurallyComplete('package main\nfunc main() {}\n', 'main.go'),
      true
    )
    assert.equal(contentLooksStructurallyComplete('def add(a, b):\n    return a + b\n', 'a.py'), true)
    assert.equal(contentLooksStructurallyComplete('{"a": 1}', 'a.json'), true)
    assert.equal(contentLooksStructurallyComplete('def add(a, b):\n', 'a.py'), false)
  })

  it('isLandingJsPath matches js/main.js only', () => {
    assert.equal(isLandingJsPath('js/main.js'), true)
    assert.equal(isLandingJsPath('main.js'), true)
    assert.equal(isLandingJsPath('src/renderer/src/agent/runAgentTurn.ts'), false)
    assert.equal(isSourcePath('app.py'), true)
    assert.equal(isSourcePath('main.go'), true)
    assert.equal(isSourcePath('src/app.ts'), true)
  })
})

describe('evidence-gated plan', () => {
  it('a successful read does not tick product steps', () => {
    const steps = [{ id: '1', text: 'Написать Calculator.java', status: 'in_progress' as const }]
    const { steps: next } = advanceTodosOnEvidence(steps, [], {
      name: 'read_file',
      ok: true,
      path: 'Calculator.java'
    })
    assert.equal(next[0]!.status, 'in_progress')
  })

  it('a successful write on the named file ticks that step only', () => {
    const steps = [
      { id: '1', text: 'Написать Calculator.java', status: 'in_progress' as const },
      { id: '2', text: 'Запустить тесты', status: 'pending' as const }
    ]
    const { steps: next, evidence } = advanceTodosOnEvidence(steps, [], {
      name: 'write_file',
      ok: true,
      path: 'Calculator.java',
      content: 'class Calculator {}'
    })
    assert.equal(next.find((s) => s.id === '1')?.status, 'done')
    assert.equal(next.find((s) => s.id === '2')?.status, 'in_progress')
    assert.equal(evidenceSupportsStep('Запустить тесты', evidence), false)
  })

  it('tests step needs a green test command, not any tool', () => {
    let log = recordEvidence(
      [],
      evidenceFromTool({ name: 'write_file', ok: true, path: 'a.py' })!
    )
    assert.equal(evidenceSupportsStep('Запустить pytest', log), false)
    log = recordEvidence(
      log,
      evidenceFromTool({
        name: 'execute_terminal_command',
        ok: true,
        command: 'python -m pytest -q',
        content: 'exit_code=0'
      })!
    )
    assert.equal(evidenceSupportsStep('Запустить pytest', log), true)
  })

  it('web_search ticks weather/search plan rows and does not need a write', () => {
    const steps = [
      {
        id: '1',
        text: 'Выполнить web_search с запросом "погода Переславль"',
        status: 'in_progress' as const
      },
      {
        id: '2',
        text: 'Извлечь информацию о температуре и осадках',
        status: 'pending' as const
      },
      {
        id: '3',
        text: 'Сообщить пользователю текущую погоду',
        status: 'pending' as const
      }
    ]
    const { steps: next, evidence } = advanceTodosOnEvidence(steps, [], {
      name: 'web_search',
      ok: true,
      content: 'temp +10'
    })
    assert.ok(evidence.some((e) => e.kind === 'search_ok'))
    assert.equal(next.find((s) => s.id === '1')?.status, 'done')
    assert.equal(evidenceSupportsStep(steps[0]!.text, evidence), true)
  })
})

describe('write thresholds', () => {
  it('java/python/cs share the large overwrite gate', () => {
    assert.equal(allowsFullOverwrite('Main.java', 5000), true)
    assert.equal(allowsFullOverwrite('Main.java', 20_000), true)
    assert.equal(allowsFullOverwrite('Main.java', 50_000), false)
    assert.equal(allowsFullOverwrite('app.py', 12_000), true)
  })
})
