// node --test harness/dsh-screen-afkllm/index.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answerSnippet, buildText, createLevels, parseArgs, parseEffort, parseHotkey } from './index.js'

test('parseEffort / parseArgs: levels, one-off level, effort command', () => {
  assert.equal(parseEffort('LOW'), 'low')
  assert.equal(parseEffort('средний'), 'medium')
  assert.equal(parseEffort('чат'), 'chat')
  assert.equal(parseEffort('какой'), undefined)
  assert.deepEqual(parseArgs(''), { cmd: 'shot', question: '' })
  assert.deepEqual(parseArgs('статус'), { cmd: 'status' })
  assert.deepEqual(parseArgs('какой вариант правильный?'), { cmd: 'shot', question: 'какой вариант правильный?' })
  assert.deepEqual(parseArgs('high какой вариант?'), { cmd: 'shot', effort: 'high', question: 'какой вариант?' })
  assert.deepEqual(parseArgs('effort'), { cmd: 'effort' })
  assert.deepEqual(parseArgs('уровень medium'), { cmd: 'effort', effort: 'medium' })
  assert.deepEqual(parseArgs('effort fast'), { cmd: 'effort', bad: 'fast' })
})

function fakeAgent(effort, status = 'idle') {
  const calls = []
  let sel = { provider: 'afkllm', model: 'flash', reasoningEffort: effort }
  return {
    session: {}, status, calls,
    model: { current: () => sel, select: (s) => { calls.push(s.reasoningEffort); sel = s } },
  }
}

test('levels: idle chat → screenshot level now, chat level back after that turn', () => {
  const lv = createLevels()
  const a = fakeAgent('high')
  lv.use(a, 'low')
  assert.deepEqual(a.calls, ['low'])
  lv.turnEnded(a.session, a)
  assert.deepEqual(a.calls, ['low', 'high'])
  lv.turnEnded(a.session, a)
  assert.equal(a.calls.length, 2)
})

test('levels: busy chat waits for its turn; same level and "chat" change nothing; user pick is kept', () => {
  const lv = createLevels()
  const busy = fakeAgent('high', 'running')
  lv.use(busy, 'low')
  assert.deepEqual(busy.calls, [])
  lv.turnEnded(busy.session, busy)
  assert.deepEqual(busy.calls, ['low'])
  lv.turnEnded(busy.session, busy)
  assert.deepEqual(busy.calls, ['low', 'high'])

  const same = fakeAgent('low')
  lv.use(same, 'low')
  lv.use(same, 'chat')
  assert.deepEqual(same.calls, [])

  const picked = fakeAgent('medium')
  lv.use(picked, 'low')
  picked.model.select({ provider: 'afkllm', model: 'flash', reasoningEffort: 'high' })
  lv.turnEnded(picked.session, picked)
  assert.deepEqual(picked.calls, ['low', 'high'])
})

test('parseHotkey: modifiers, letters, digits, F-keys', () => {
  assert.deepEqual(parseHotkey('Ctrl+Alt+S'), { mods: 3, vk: 0x53, label: 'Ctrl+Alt+S' })
  assert.deepEqual(parseHotkey('ctrl + shift + 1'), { mods: 6, vk: 0x31, label: 'ctrl+shift+1' })
  assert.equal(parseHotkey('F9').vk, 0x78)
  assert.equal(parseHotkey('Win+F24').mods, 8)
  assert.throws(() => parseHotkey('S'), /модификатор/)
  assert.throws(() => parseHotkey('Ctrl+Alt'), /основной клавиши/)
  assert.throws(() => parseHotkey('Ctrl+Space'), /неизвестная/)
})

test('buildText: window, question, black picture', () => {
  const t = buildText({ title: 'Тест по истории', process: 'chrome', dark: false }, 'какой ответ?', 'PROMPT', )
  assert.match(t, /^\[Скриншот: окно «Тест по истории» \(chrome\)\]\nPROMPT\nВопрос пользователя: какой ответ\?$/)
  assert.match(buildText({ title: 'Game', how: 'hotkey', dark: true }, '', 'P'), /по горячей клавише.*\n.*\n\(Картинка почти чёрная/s)
})

test('answerSnippet: the "Ответ:" line first, markdown stripped, shortened', () => {
  assert.equal(answerSnippet('Разбор…\n**Ответ:** B — 1945\nПотому что'), 'Ответ: B — 1945')
  assert.equal(answerSnippet('Просто текст\nещё'), 'Просто текст ещё')
  assert.equal(answerSnippet('x'.repeat(300), 10).length, 10)
  assert.equal(answerSnippet(undefined), '')
})
