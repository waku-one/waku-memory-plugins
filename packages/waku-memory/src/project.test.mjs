import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveProject } from './project.ts'

function withDir(fn) { const d = mkdtempSync(join(tmpdir(), 'waku-project-')); try { fn(d) } finally { rmSync(d, { recursive: true, force: true }) } }

test('A11: a .claude/worktrees checkout resolves to the repository', () => withDir((d) => {
  const repo = join(d, 'waku-memory-backend'); mkdirSync(join(repo, '.git', 'worktrees', 'nice-lederberg'), { recursive: true })
  const wt = join(repo, '.claude', 'worktrees', 'nice-lederberg'); mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'nice-lederberg')}\n`)
  assert.equal(resolveProject(wt), 'waku-memory-backend')
}))

test('A11: a sibling checkout resolves to the repository, and a relative gitdir works', () => withDir((d) => {
  const repo = join(d, 'waku-memory-backend'); mkdirSync(join(repo, '.git', 'worktrees', 'spec-011'), { recursive: true })
  const wt = join(d, 'waku-memory-backend-spec-011'); mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, '.git'), 'gitdir: ../waku-memory-backend/.git/worktrees/spec-011\n')
  assert.equal(resolveProject(wt), 'waku-memory-backend')
  assert.equal(resolveProject(join(wt, 'shim')), 'waku-memory-backend') // a subdirectory of the worktree
}))

test('A11: a .git directory, or no git at all, yields the cwd basename', () => withDir((d) => {
  const main = join(d, 'waku-memory-backend'); mkdirSync(join(main, '.git'), { recursive: true }); mkdirSync(join(main, 'shim'))
  assert.equal(resolveProject(main), 'waku-memory-backend')
  assert.equal(resolveProject(join(main, 'shim')), 'shim') // an ancestor's .git directory does not rename a subdirectory
  const plain = join(d, 'plain'); mkdirSync(plain)
  assert.equal(resolveProject(plain), 'plain')
}))

test('A11: a submodule\'s .git file (gitdir: ../.git/modules/<name>) falls back to the cwd basename', () => withDir((d) => {
  const sub = join(d, 'vendor', 'lib'); mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n')
  assert.equal(resolveProject(sub), 'lib')
}))

test('A11: an unreadable .git file yields the cwd basename, never a throw', () => withDir((d) => {
  const dir = join(d, 'test-checkout'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), `gitdir: ${join(d, '.git', 'worktrees', 'test')}\n`)

  // Inject an io object where readFileSync throws EACCES
  const io = {
    statSync,
    readFileSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) }
  }

  const result = resolveProject(dir, io)
  assert.equal(result, basename(dir))
}))
