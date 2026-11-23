import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { locationOf, normalizeRemote, originUrl, resolveRepo } from './project.ts'

// spec 063 P3: the root and origin remote the server resolves a project from.

function withDir(fn) { const d = mkdtempSync(join(tmpdir(), 'waku-repo-')); try { fn(d) } finally { rmSync(d, { recursive: true, force: true }) } }

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = https://github.com/someone/else.git
[remote "origin"]
\turl = https://ian:ghp_secret@github.com/ShenSeanChen/waku-memory-backend.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
`
const REMOTE = 'github.com/shenseanchen/waku-memory-backend'

function checkout(d, name = 'waku-memory-backend') {
  const repo = join(d, name)
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'config'), CONFIG)
  mkdirSync(join(repo, 'shim', 'src'), { recursive: true })
  return repo
}

test('a subdirectory names its checkout root and the origin remote, without credentials', () => withDir((d) => {
  const repo = checkout(d)
  assert.deepEqual(resolveRepo(join(repo, 'shim', 'src')), { root: resolve(repo), remote: REMOTE })
  assert.deepEqual(resolveRepo(repo), { root: resolve(repo), remote: REMOTE })
  assert.equal(JSON.stringify(locationOf(repo)).includes('secret'), false)
}))

test('a worktree names its own root and the common directory\'s remote', () => withDir((d) => {
  const repo = checkout(d)
  const gitdir = join(repo, '.git', 'worktrees', 'spec-063')
  mkdirSync(gitdir, { recursive: true })
  writeFileSync(join(gitdir, 'commondir'), '../..\n')
  const wt = join(d, 'waku-memory-backend-063'); mkdirSync(join(wt, 'apps'), { recursive: true })
  writeFileSync(join(wt, '.git'), 'gitdir: ../waku-memory-backend/.git/worktrees/spec-063\n')
  assert.deepEqual(resolveRepo(join(wt, 'apps')), { root: resolve(wt), remote: REMOTE })
}))

test('a checkout with no origin sends only its root; no checkout sends nothing', () => withDir((d) => {
  const repo = join(d, 'notes'); mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'config'), '[core]\n\tbare = false\n')
  assert.deepEqual(resolveRepo(repo), { root: resolve(repo) })
  const plain = join(d, 'plain'); mkdirSync(plain)
  // tmpdir() itself may sit inside a checkout on a developer's machine; only
  // assert there is no repo when the walk reaches the filesystem root clean.
  const found = resolveRepo(plain)
  assert.ok(found === null || !found.root.startsWith(resolve(plain)))
  assert.deepEqual(locationOf(repo), { cwd: repo, repo: { root: resolve(repo) } })
}))

test('an unreadable config or .git file gives the root alone, never a throw', () => withDir((d) => {
  const repo = checkout(d)
  const io = { statSync, readFileSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
  assert.deepEqual(resolveRepo(repo, io), { root: resolve(repo) })
  const wt = join(d, 'wt'); mkdirSync(wt)
  writeFileSync(join(wt, '.git'), 'gitdir: /nowhere\n')
  assert.deepEqual(resolveRepo(wt, io), { root: resolve(wt) })
}))

test('originUrl reads only [remote "origin"]', () => {
  assert.equal(originUrl(CONFIG), 'https://ian:ghp_secret@github.com/ShenSeanChen/waku-memory-backend.git')
  assert.equal(originUrl('[remote "upstream"]\n\turl = x\n'), null)
  assert.equal(originUrl(''), null)
})

test('every spelling of a remote is one key, as on the server', () => {
  for (const url of [
    'git@github.com:ShenSeanChen/waku-memory-backend.git',
    'https://github.com/ShenSeanChen/waku-memory-backend',
    'https://ian:tok@github.com/ShenSeanChen/waku-memory-backend.git/',
    'ssh://git@github.com:22/ShenSeanChen/waku-memory-backend.git',
    'git://github.com/ShenSeanChen/waku-memory-backend',
  ]) assert.equal(normalizeRemote(url), REMOTE, url)
  assert.equal(normalizeRemote('/srv/git/Thing.git'), '/srv/git/thing')
  assert.equal(normalizeRemote('file:///srv/git/thing.git'), '/srv/git/thing')
  assert.equal(normalizeRemote('C:\\repos\\thing.git'), 'c:/repos/thing')
  assert.equal(normalizeRemote('  '), null)
})
