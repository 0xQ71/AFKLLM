import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import {
  changeLetter,
  isStagedChange,
  isUnstagedChange,
  type GitFileChange
} from '../src/shared/git'
import { GitService } from '../src/main/git/GitService'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8'
  })
  return String(stdout)
}

describe('git helpers', () => {
  it('classifies staged / unstaged / untracked', () => {
    const staged: GitFileChange = { path: 'a.ts', indexStatus: 'M', workTreeStatus: ' ' }
    const unstaged: GitFileChange = { path: 'b.ts', indexStatus: ' ', workTreeStatus: 'M' }
    const both: GitFileChange = { path: 'c.ts', indexStatus: 'M', workTreeStatus: 'M' }
    const untracked: GitFileChange = { path: 'd.ts', indexStatus: '?', workTreeStatus: '?' }

    assert.equal(isStagedChange(staged), true)
    assert.equal(isUnstagedChange(staged), false)
    assert.equal(isStagedChange(unstaged), false)
    assert.equal(isUnstagedChange(unstaged), true)
    assert.equal(isStagedChange(both), true)
    assert.equal(isUnstagedChange(both), true)
    assert.equal(isStagedChange(untracked), false)
    assert.equal(isUnstagedChange(untracked), true)
    assert.equal(changeLetter(untracked, 'worktree'), '?')
    assert.equal(changeLetter(staged, 'index'), 'M')
  })
})

describe('GitService integration', () => {
  let dir = ''
  const svc = new GitService()

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'afkllm-git-'))
    await git(dir, ['init'])
    await git(dir, ['config', 'user.email', 'test@afkllm.local'])
    await git(dir, ['config', 'user.name', 'AFKLLM Test'])
    // default branch name varies; create initial commit
    await writeFile(join(dir, 'README.md'), '# hi\n', 'utf8')
    await git(dir, ['add', 'README.md'])
    await git(dir, ['commit', '-m', 'init'])
    svc.setRoot(dir)
  })

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('reports available status on clean repo', async () => {
    const st = await svc.status()
    assert.equal(st.available, true)
    assert.ok(st.branch)
    assert.equal(st.files.length, 0)
    assert.equal(st.stagedCount, 0)
    assert.equal(st.unstagedCount, 0)
  })

  it('detects untracked, stages, commits, and logs', async () => {
    await writeFile(join(dir, 'app.ts'), 'export const x = 1\n', 'utf8')
    let st = await svc.status()
    assert.ok(st.files.some((f) => f.path === 'app.ts'))
    assert.ok(st.unstagedCount >= 1)

    const stage = await svc.stage(['app.ts'])
    assert.equal(stage.ok, true)
    st = await svc.status()
    assert.ok(st.stagedCount >= 1)
    const stagedFile = st.files.find((f) => f.path === 'app.ts')
    assert.ok(stagedFile)
    assert.equal(isStagedChange(stagedFile!), true)

    const diff = await svc.diff('app.ts', true)
    assert.equal(diff.error, undefined)
    assert.match(diff.newText, /export const x/)

    const empty = await svc.commit('   ')
    assert.equal(empty.ok, false)

    const commit = await svc.commit('add app.ts')
    assert.equal(commit.ok, true, commit.error)
    st = await svc.status()
    assert.equal(st.files.length, 0)

    const log = await svc.log(10)
    assert.ok(log.length >= 2)
    assert.equal(log[0]!.subject, 'add app.ts')
    assert.ok(log[0]!.shortHash)
    assert.ok(typeof log[0]!.graph === 'string')

    const detail = await svc.show(log[0]!.hash)
    assert.equal(detail.error, undefined)
    assert.equal(detail.subject, 'add app.ts')
    assert.match(detail.patch, /app\.ts/)
  })

  it('stageAll / unstageAll round-trip', async () => {
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.ts'), 'a\n', 'utf8')
    await writeFile(join(dir, 'src', 'b.ts'), 'b\n', 'utf8')

    const all = await svc.stageAll()
    assert.equal(all.ok, true)
    let st = await svc.status()
    assert.ok(st.stagedCount >= 2)

    const un = await svc.unstageAll()
    assert.equal(un.ok, true)
    st = await svc.status()
    assert.equal(st.stagedCount, 0)
    assert.ok(st.unstagedCount >= 2)
  })

  it('returns unavailable outside a git repo', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'afkllm-nongit-'))
    try {
      const orphan = new GitService()
      orphan.setRoot(bare)
      const st = await orphan.status()
      assert.equal(st.available, false)
      assert.equal(st.files.length, 0)
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('fetch/pull/push return GitOkResult shape', async () => {
    // No remote configured → expect soft failure, not throw
    const fetchRes = await svc.fetch()
    assert.equal(typeof fetchRes.ok, 'boolean')
    const pullRes = await svc.pull()
    assert.equal(typeof pullRes.ok, 'boolean')
    const pushRes = await svc.push()
    assert.equal(typeof pushRes.ok, 'boolean')
  })
})
