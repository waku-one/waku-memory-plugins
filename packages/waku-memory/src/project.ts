// Spec 011 §7: the project is the directory name, except that a git
// worktree names the repository it belongs to. A worktree's `.git` is a
// file holding `gitdir: <repo>/.git/worktrees/<name>`; a checkout's `.git`
// is a directory. Read with fs only -- no git binary.
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

// The two fs calls are injectable so a test can make the `.git` file
// unreadable on every platform (a real permission failure is not
// reproducible on Windows). Real callers pass nothing.
export type ProjectIo = { statSync: typeof statSync; readFileSync: typeof readFileSync }

export function resolveProject(cwd: string, io: ProjectIo = { statSync, readFileSync }): string {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    const dotGit = join(dir, '.git')
    let stat
    try { stat = io.statSync(dotGit) } catch { stat = undefined }
    if (stat?.isDirectory()) return basename(start)
    if (stat?.isFile()) {
      let content: string
      try {
        content = io.readFileSync(dotGit, 'utf8') as string
      } catch {
        return basename(start) // unreadable: the checkout's own name, never a throw (§7)
      }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(content)
      if (m) {
        const gitdir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1])
        const wt = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gitdir)
        if (wt) return basename(wt[1])
      }
      return basename(start)
    }
    const parent = dirname(dir)
    if (parent === dir) return basename(start)
    dir = parent
  }
}

// ---- spec 063: the keys the server resolves a session's project from -------
//
// `resolveProject` above stays the `project` name every post already sends.
// Beside it, each post now sends `cwd` and, inside a git checkout, `repo`:
// the checkout's root and its `origin` remote. The server matches those
// against the person's projects (spec 063 D2), so a subdirectory, a worktree,
// a second clone and a renamed folder all land in one project. Read with fs
// only, like resolveProject; any failure leaves out what it could not read.

export type RepoKeys = { root: string; remote?: string }
export type Location = { cwd: string; repo?: RepoKeys }

export function resolveRepo(cwd: string, io: ProjectIo = { statSync, readFileSync }): RepoKeys | null {
  let dir = resolve(cwd)
  for (;;) {
    const dotGit = join(dir, '.git')
    let stat
    try { stat = io.statSync(dotGit) } catch { stat = undefined }
    if (stat?.isDirectory()) return withRemote(dir, join(dotGit, 'config'), io)
    if (stat?.isFile()) {
      // A worktree or a submodule: `.git` names the git directory. A
      // worktree's keeps its config in the common directory `commondir`
      // points to; a submodule's git directory is its own common directory.
      let content: string
      try { content = io.readFileSync(dotGit, 'utf8') as string } catch { return { root: dir } }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(content)
      if (!m) return { root: dir }
      const gitdir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1])
      let common = gitdir
      try {
        const c = (io.readFileSync(join(gitdir, 'commondir'), 'utf8') as string).trim()
        if (c) common = isAbsolute(c) ? c : resolve(gitdir, c)
      } catch { /* no commondir: the git directory is its own */ }
      return withRemote(dir, join(common, 'config'), io)
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function withRemote(root: string, config: string, io: ProjectIo): RepoKeys {
  let text: string
  try { text = io.readFileSync(config, 'utf8') as string } catch { return { root } }
  const url = originUrl(text)
  const remote = url === null ? null : normalizeRemote(url)
  return remote === null ? { root } : { root, remote }
}

// The `url` of `[remote "origin"]` in a git config file, or null.
export function originUrl(config: string): string | null {
  let inOrigin = false
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const section = /^\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]/.exec(line)
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin'
      continue
    }
    if (!inOrigin) continue
    const kv = /^url\s*=\s*(.*)$/i.exec(line)
    if (kv) {
      const value = kv[1].trim().replace(/^"(.*)"$/, '$1')
      return value === '' ? null : value
    }
  }
  return null
}

// `host/owner/repo` in lower case: no scheme, no credentials, no port, no
// `.git`. The server applies the same rule (project_repository.py's
// normalize_remote); this copy exists so a credential in a remote URL never
// leaves the machine.
export function normalizeRemote(url: string): string | null {
  let value = url.trim()
  if (value === '') return null
  const scheme = /^[a-z][a-z0-9+.\-]*:\/\//i.exec(value)
  if (scheme) {
    const rest = value.slice(scheme[0].length)
    if (scheme[0].toLowerCase() === 'file://') {
      value = rest
    } else {
      const slash = rest.indexOf('/')
      const authority = slash === -1 ? rest : rest.slice(0, slash)
      const path = slash === -1 ? '' : rest.slice(slash)
      let host = authority.slice(authority.lastIndexOf('@') + 1)
      host = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      value = host + path
    }
  } else if (!/^[a-z]:[\\/]/i.test(value) && !/^[/.~]/.test(value)) {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
    if (scp) value = `${scp[1]}/${scp[2].replace(/^\/+/, '')}`
  }
  value = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  if (value.toLowerCase().endsWith('.git')) value = value.slice(0, -4).replace(/\/+$/, '')
  value = value.toLowerCase()
  return value === '' ? null : value
}

// What a post spreads into its body: `{ cwd }`, plus `repo` inside a checkout.
export function locationOf(cwd: string, io: ProjectIo = { statSync, readFileSync }): Location {
  const repo = resolveRepo(cwd, io)
  return repo === null ? { cwd } : { cwd, repo }
}
