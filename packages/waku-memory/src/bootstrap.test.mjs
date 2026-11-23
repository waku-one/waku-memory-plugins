// Spec 011 §8: the pure half of bootstrap-at-enable -- scanning the
// machine for Claude Code's memory files and transcripts, sizing what is
// unsent, rendering the one list, and parsing the one answer. No network
// anywhere in this file; postBrief-style sending is task 13's job.
//
// The fixture below builds a throwaway ~/.claude under a temp dir (never
// the real one) with mkdtempSync, exactly like project.test.mjs and
// hook.test.mjs do for their own temp trees. `nowMs` is fixed and every
// transcript's mtime is set explicitly with utimesSync, so the window and
// live-session rules are deterministic regardless of when the suite runs.
//
// Two projects have a real cwd ("waku", "work") so their names come from
// resolveProject, not from the slug -- exactly as spec 011 §8 requires.
// A third slug's transcripts never carry a cwd record at all, which
// exercises the "no cwd -> grouped by its own slug, name: null" rule in
// the same place as the watermark/marker/live rules, since none of those
// four conditions cares which project it happens to sit under.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

import { formatDelta } from './dialogue.ts'
import { formatCodexDelta } from './dialogue-codex.ts'
import { readWatermark } from './hook.ts'
import {
  DEFAULT_WINDOW_DAYS,
  LIVE_WINDOW_MS,
  MEMORY_SESSION_ID,
  scanClaudeCode,
  renderBootstrapList,
  parseBootstrapAnswer,
  readHead,
} from './bootstrap.ts'
// Namespace import for task 13's additions (runBootstrap, memoryFileSource):
// a named import of a not-yet-existing export is a link-time SyntaxError
// that takes this whole file down, including every already-green A12 test
// above -- see capture.test.mjs's identical comment for the same reason.
import * as bootstrapModule from './bootstrap.ts'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waku-bootstrap-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Async sibling of withDir above: runBootstrap posts over an injected
// fetchImpl and returns a Promise, so the temp dir must not be torn down
// until that promise settles -- see hook.test.mjs's identical async withDir
// for the exact bug this avoids (a synchronous finally deleting the
// directory out from under a still-pending call).
async function withDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waku-bootstrap-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// cc-dialogue-v1 record shapes (spec 011 §1), one line each. `cwd` sits at
// the top level of the record, a sibling of `type` and `message` -- the
// real shape Claude Code writes, and the field findCwd's line-by-line scan
// looks for.
const userLine = (text, cwd) =>
  JSON.stringify({ type: 'user', ...(cwd ? { cwd } : {}), message: { content: text } }) + '\n'
const assistantLine = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'
const bareLine = (type) => JSON.stringify({ type }) + '\n'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW_MS = Date.UTC(2026, 8, 5, 12, 0, 0) // fixed "now": 2026-09-05 noon UTC
const SINCE_MS = NOW_MS - DEFAULT_WINDOW_DAYS * DAY_MS
const IN_WINDOW = new Date(NOW_MS - 10 * DAY_MS) // well inside the window, nowhere near live
const OLDER_THAN_WINDOW = new Date(NOW_MS - 200 * DAY_MS) // outside a 180-day window
const LIVE_TIME = new Date(NOW_MS) // "now" -- inside the ten-minute live window

function baseOpts(overrides = {}) {
  return { nowMs: NOW_MS, sinceMs: SINCE_MS, liveWindowMs: LIVE_WINDOW_MS, all: false, ...overrides }
}

// ---- tests for readHead ------

test('readHead: small file returns entire contents', () => {
  return withDir((root) => {
    const content = 'small file content\n'
    const filePath = join(root, 'small.txt')
    writeFileSync(filePath, content)
    const buf = readHead(filePath, 256 * 1024)
    assert.equal(buf.toString('utf8'), content)
  })
})

test('readHead: large file returns exactly maxBytes', () => {
  return withDir((root) => {
    const maxBytes = 100 * 1024 // 100 KiB
    const content = 'x'.repeat(300 * 1024) // 300 KiB, well over the limit
    const filePath = join(root, 'large.txt')
    writeFileSync(filePath, content)
    const buf = readHead(filePath, maxBytes)
    assert.equal(buf.length, maxBytes)
    assert.equal(buf.toString('utf8'), content.slice(0, maxBytes))
  })
})

// Builds the fixture described in the task brief: two named projects (one
// with memory files), a too-old slug, a memory-only slug, and a fourth
// slug with no cwd anywhere that carries the four which-sessions-are-listed
// cases (fully sent, a tail, a dropped-spans marker, and a live session).
// Returns every id/path a test needs to assert against.
function buildFixture(root) {
  const claudeDir = join(root, '.claude')
  const stateDir = join(root, 'state')
  const projectsDir = join(claudeDir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const cwds = join(root, 'cwds')
  const wakuCwd = join(cwds, 'waku')
  const workCwd = join(cwds, 'work')
  mkdirSync(wakuCwd, { recursive: true })
  mkdirSync(workCwd, { recursive: true })

  // ---- slug-waku: named project "waku", plus two memory files ----------
  const wakuSlugDir = join(projectsDir, 'slug-waku')
  mkdirSync(join(wakuSlugDir, 'memory'), { recursive: true })
  const wakuSessionId = 'sess-waku-0001'
  const wakuContent =
    bareLine('queue-operation') + bareLine('last-prompt') + userLine('Remember I like TDD.', wakuCwd) + assistantLine('Noted, will do.')
  const wakuPath = join(wakuSlugDir, wakuSessionId + '.jsonl')
  writeFileSync(wakuPath, wakuContent, 'utf8')
  utimesSync(wakuPath, IN_WINDOW, IN_WINDOW)
  writeFileSync(join(wakuSlugDir, 'memory', 'a.md'), '# A\nSome memory A.\n', 'utf8')
  writeFileSync(join(wakuSlugDir, 'memory', 'b.md'), '# B\nSome memory B.\n', 'utf8')

  // ---- slug-work: named project "work", the biggest dialogue, no memory --
  const workSlugDir = join(projectsDir, 'slug-work')
  mkdirSync(workSlugDir, { recursive: true })
  const workSessionId = 'sess-work-0001'
  const workContent =
    bareLine('queue-operation') +
    bareLine('last-prompt') +
    userLine('x'.repeat(2000), workCwd) +
    assistantLine('y'.repeat(2000))
  const workPath = join(workSlugDir, workSessionId + '.jsonl')
  writeFileSync(workPath, workContent, 'utf8')
  utimesSync(workPath, IN_WINDOW, IN_WINDOW)

  // ---- slug-old: outside the window, must not appear at all ------------
  const oldSlugDir = join(projectsDir, 'slug-old')
  mkdirSync(oldSlugDir, { recursive: true })
  const oldCwd = join(cwds, 'old-project')
  mkdirSync(oldCwd, { recursive: true })
  const oldSessionId = 'sess-old-0001'
  const oldContent = bareLine('queue-operation') + userLine('ancient history', oldCwd) + assistantLine('ok')
  const oldPath = join(oldSlugDir, oldSessionId + '.jsonl')
  writeFileSync(oldPath, oldContent, 'utf8')
  utimesSync(oldPath, OLDER_THAN_WINDOW, OLDER_THAN_WINDOW)

  // ---- slug-memoryonly: no transcript at all, memory files only --------
  const memoryOnlySlugDir = join(projectsDir, 'slug-memoryonly')
  mkdirSync(join(memoryOnlySlugDir, 'memory'), { recursive: true })
  writeFileSync(join(memoryOnlySlugDir, 'memory', 'x.md'), '# X\nMemory only note.\n', 'utf8')

  // ---- slug-mixed: no cwd anywhere -> name: null, grouped by its own ----
  // slug. Also carries the four which-sessions-are-listed cases.
  const mixedSlugDir = join(projectsDir, 'slug-mixed')
  mkdirSync(mixedSlugDir, { recursive: true })

  // Fully sent: watermark sits at the file's exact size, no marker -> not
  // listed at all.
  const fullysentId = 'sess-fullysent'
  const fullysentContent = bareLine('queue-operation') + userLine('hi') + assistantLine('hello')
  const fullysentPath = join(mixedSlugDir, fullysentId + '.jsonl')
  writeFileSync(fullysentPath, fullysentContent, 'utf8')
  utimesSync(fullysentPath, IN_WINDOW, IN_WINDOW)
  writeFileSync(join(stateDir, fullysentId), String(Buffer.byteLength(fullysentContent, 'utf8')), 'utf8')

  // Tail: watermark sits below the file's size -> listed, from = watermark,
  // dialogue comes only from the two turns after it.
  const tailId = 'sess-tail'
  const tailLine1 = userLine('first turn')
  const tailLine2 = assistantLine('first reply')
  const tailLine3 = userLine('second turn')
  const tailLine4 = assistantLine('second reply')
  const tailContent = tailLine1 + tailLine2 + tailLine3 + tailLine4
  const tailPath = join(mixedSlugDir, tailId + '.jsonl')
  writeFileSync(tailPath, tailContent, 'utf8')
  utimesSync(tailPath, IN_WINDOW, IN_WINDOW)
  const tailWatermark = Buffer.byteLength(tailLine1 + tailLine2, 'utf8')
  writeFileSync(join(stateDir, tailId), String(tailWatermark), 'utf8')

  // Dropped: watermark sits at the file's exact size (nothing left to send
  // as a tail), but a .dropped marker names two earlier spans -> listed
  // anyway, spans = both, dialogue comes only from the two dropped lines
  // (not from the two lines that were already sent around them).
  const droppedId = 'sess-dropped'
  const dLine1 = userLine('alpha') // span 1
  const dLine2 = assistantLine('already sent, not in any span')
  const dLine3 = userLine('gamma') // span 2
  const dLine4 = assistantLine('also already sent')
  const droppedContent = dLine1 + dLine2 + dLine3 + dLine4
  const droppedPath = join(mixedSlugDir, droppedId + '.jsonl')
  writeFileSync(droppedPath, droppedContent, 'utf8')
  utimesSync(droppedPath, IN_WINDOW, IN_WINDOW)
  const off1 = Buffer.byteLength(dLine1, 'utf8')
  const off2 = off1 + Buffer.byteLength(dLine2, 'utf8')
  const off3 = off2 + Buffer.byteLength(dLine3, 'utf8')
  const off4 = off3 + Buffer.byteLength(dLine4, 'utf8')
  writeFileSync(join(stateDir, droppedId), String(off4), 'utf8') // at exact size
  writeFileSync(join(stateDir, droppedId + '.dropped'), `0-${off1}\n${off2}-${off3}\n`, 'utf8')

  // Live: mtime is "now" -> inside the ten-minute live window -> never
  // listed, regardless of watermark state (none needed).
  const liveId = 'sess-live'
  const liveContent = userLine('just started') + assistantLine('working on it')
  const livePath = join(mixedSlugDir, liveId + '.jsonl')
  writeFileSync(livePath, liveContent, 'utf8')
  utimesSync(livePath, LIVE_TIME, LIVE_TIME)

  // ---- the user-level CLAUDE.md, non-blank -------------------------------
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  writeFileSync(claudeMdPath, '# User conventions\nAlways be concise.\n', 'utf8')

  return {
    claudeDir,
    stateDir,
    wakuSessionId,
    wakuPath,
    workSessionId,
    workPath,
    oldSessionId,
    fullysentId,
    tailId,
    tailPath,
    tailWatermark,
    tailLine3,
    tailLine4,
    droppedId,
    droppedPath,
    dLine1,
    dLine3,
    off1,
    off2,
    off3,
    off4,
    liveId,
    claudeMdPath,
  }
}

// ---- scanClaudeCode --------------------------------------------------------

test('A12: scanClaudeCode groups by resolved project name, sizes sessions, and applies the window/live/watermark/marker rules', () => withDir((root) => {
  const fx = buildFixture(root)
  const scan = scanClaudeCode(fx.claudeDir, fx.stateDir, baseOpts())

  // Exactly four projects survive: waku, work, the no-cwd slug (as two
  // listed sessions under its own slug), and the memory-only slug. The
  // too-old slug and the fully-sent/live sessions leave no trace.
  const byKey = new Map(scan.projects.map((p) => [p.name ?? `slug:${p.slug}`, p]))
  assert.equal(scan.projects.length, 4)
  assert.ok(!byKey.has('old-project'), 'a too-old session must not produce a project entry')

  // -- waku: named via resolveProject(cwd), one session, two memory files --
  const waku = byKey.get('waku')
  assert.ok(waku, 'waku project entry should exist')
  assert.equal(waku.slug, 'slug-waku')
  assert.equal(waku.sessions.length, 1)
  assert.equal(waku.memoryFiles.length, 2)
  assert.ok(waku.memoryFiles.every((p) => p.endsWith('.md')))
  const wakuSession = waku.sessions[0]
  assert.equal(wakuSession.sessionId, fx.wakuSessionId)
  assert.equal(wakuSession.path, fx.wakuPath)
  assert.equal(wakuSession.project, 'waku')
  assert.equal(wakuSession.from, 0) // no watermark file at all
  assert.deepEqual(wakuSession.spans, [])
  assert.ok(wakuSession.dialogueBytes > 0)
  assert.equal(wakuSession.pieces, 1)
  assert.ok(Math.abs(wakuSession.mtimeMs - IN_WINDOW.getTime()) < 2000)
  assert.equal(waku.dialogueBytes, wakuSession.dialogueBytes)

  // -- work: named project, no memory files, the largest dialogue --------
  const work = byKey.get('work')
  assert.ok(work)
  assert.equal(work.sessions.length, 1)
  assert.equal(work.memoryFiles.length, 0)
  assert.equal(work.sessions[0].sessionId, fx.workSessionId)
  assert.ok(work.dialogueBytes > waku.dialogueBytes, 'the 2000-char turns must dwarf the short waku dialogue')

  // -- slug-mixed: no cwd anywhere -> name: null, grouped by its own slug --
  const mixed = byKey.get('slug:slug-mixed')
  assert.ok(mixed, 'the no-cwd slug should form its own name:null entry')
  assert.equal(mixed.name, null)
  assert.equal(mixed.slug, 'slug-mixed')
  assert.equal(mixed.memoryFiles.length, 0)
  const bySessId = new Map(mixed.sessions.map((s) => [s.sessionId, s]))
  assert.equal(mixed.sessions.length, 2, 'fullysent and live must be excluded, leaving tail + dropped')
  assert.ok(!bySessId.has(fx.fullysentId))
  assert.ok(!bySessId.has(fx.liveId))

  const tail = bySessId.get(fx.tailId)
  assert.ok(tail, 'the tail session (watermark below size) must be listed')
  assert.equal(tail.from, fx.tailWatermark)
  assert.deepEqual(tail.spans, [])
  const expectedTailBytes = formatDelta(Buffer.from(fx.tailLine3 + fx.tailLine4, 'utf8')).pieces
    .reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0)
  assert.equal(tail.dialogueBytes, expectedTailBytes)
  assert.ok(tail.dialogueBytes > 0)

  const dropped = bySessId.get(fx.droppedId)
  assert.ok(dropped, 'the marker session must be listed even though its watermark sits at the file size')
  assert.equal(dropped.from, fx.off4) // the watermark, which sits at the file's exact size here
  assert.deepEqual(dropped.spans, [{ start: 0, end: fx.off1 }, { start: fx.off2, end: fx.off3 }])
  const expectedDroppedBytes =
    formatDelta(Buffer.from(fx.dLine1, 'utf8')).pieces.reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0) +
    formatDelta(Buffer.from(fx.dLine3, 'utf8')).pieces.reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0)
  assert.equal(dropped.dialogueBytes, expectedDroppedBytes)
  assert.equal(dropped.pieces, 2) // one piece per span

  // -- slug-memoryonly: no listed transcript, memory files only ----------
  const memoryOnly = byKey.get('slug:slug-memoryonly')
  assert.ok(memoryOnly)
  assert.equal(memoryOnly.name, null)
  assert.equal(memoryOnly.sessions.length, 0)
  assert.equal(memoryOnly.memoryFiles.length, 1)

  // -- ordering: dialogueBytes descending, memory-only entries last ------
  assert.deepEqual(
    scan.projects.map((p) => p.name ?? p.slug),
    ['work', 'slug-mixed', 'waku', 'slug-memoryonly'],
  )

  // -- userClaudeMd: present and non-blank --------------------------------
  assert.ok(scan.userClaudeMd)
  assert.equal(scan.userClaudeMd.path, fx.claudeMdPath)
  assert.match(scan.userClaudeMd.content, /Always be concise/)
}))

test('A12: --all lists every in-window session from byte 0 and ignores every watermark and marker', () => withDir((root) => {
  const fx = buildFixture(root)
  const scan = scanClaudeCode(fx.claudeDir, fx.stateDir, baseOpts({ all: true }))

  const mixed = scan.projects.find((p) => p.slug === 'slug-mixed')
  assert.ok(mixed)
  const ids = mixed.sessions.map((s) => s.sessionId).sort()
  // Every in-window, non-live session is listed under --all, including the
  // one that a normal scan would treat as fully sent -- only "live" (mtime
  // inside the ten-minute window) and "too old" are still excluded.
  assert.deepEqual(ids, [fx.droppedId, fx.fullysentId, fx.tailId].sort())
  for (const s of mixed.sessions) {
    assert.equal(s.from, 0)
    assert.deepEqual(s.spans, [])
  }
  // The too-old and live sessions are unaffected by --all.
  assert.ok(!scan.projects.some((p) => (p.name ?? p.slug) === 'old-project'))
}))

test('A12: two slugs that resolve to the same project name merge into one entry', () => withDir((root) => {
  // Simulates what spec 011 §7's worktree resolution produces in practice
  // (a checkout and its worktree, two different slugs, one repository
  // name) without needing real .git plumbing here -- project.test.mjs
  // already covers resolveProject itself. Two plain directories that
  // happen to share a basename resolve to the same name just as well, and
  // bootstrap.ts's grouping does not care why two slugs agree, only that
  // they do.
  const claudeDir = join(root, '.claude')
  const stateDir = join(root, 'state')
  const projectsDir = join(claudeDir, 'projects')
  const cwdA = join(root, 'cwds', 'merge-1', 'shared-name')
  const cwdB = join(root, 'cwds', 'merge-2', 'shared-name')
  mkdirSync(cwdA, { recursive: true })
  mkdirSync(cwdB, { recursive: true })

  const slugADir = join(projectsDir, 'slug-merge-a')
  mkdirSync(join(slugADir, 'memory'), { recursive: true })
  const sessA = join(slugADir, 'sess-a.jsonl')
  writeFileSync(sessA, bareLine('queue-operation') + userLine('from A', cwdA) + assistantLine('ok A'), 'utf8')
  utimesSync(sessA, IN_WINDOW, IN_WINDOW)

  const slugBDir = join(projectsDir, 'slug-merge-b')
  mkdirSync(join(slugBDir, 'memory'), { recursive: true })
  const sessB = join(slugBDir, 'sess-b.jsonl')
  writeFileSync(sessB, bareLine('queue-operation') + userLine('from B', cwdB) + assistantLine('ok B'), 'utf8')
  utimesSync(sessB, IN_WINDOW, IN_WINDOW)
  writeFileSync(join(slugBDir, 'memory', 'note.md'), '# note\nfrom slug B\n', 'utf8')

  const scan = scanClaudeCode(claudeDir, stateDir, baseOpts())

  assert.equal(scan.projects.length, 1)
  const merged = scan.projects[0]
  assert.equal(merged.name, 'shared-name')
  assert.equal(merged.slug, 'slug-merge-a') // first slug encountered (alphabetical) wins the display slug
  assert.equal(merged.sessions.length, 2)
  assert.deepEqual(merged.sessions.map((s) => s.sessionId).sort(), ['sess-a', 'sess-b'])
  // slug-merge-b's own memory file attaches to the merged entry, not to a
  // second, separate one.
  assert.equal(merged.memoryFiles.length, 1)
  assert.match(merged.memoryFiles[0], /note\.md$/)
}))

test('A12: a slug whose only in-window session is already fully captured still resolves its project name for memory files (task 12 review)', () => withDir((root) => {
  // The gap the reviewer found: findCwd/resolveProject used to run only for
  // *listed* sessions, so a slug whose sole in-window transcript was
  // already captured whole (watermark at the file's exact size, no marker
  // -> not listed) never had its cwd read at all. Its memory files then
  // fell back to the memory-only slug label even though the transcript
  // names a real project -- wrong, because spec 011 §8's fallback trigger
  // is "no transcript in the window", not "no *listed* transcript".
  const claudeDir = join(root, '.claude')
  const stateDir = join(root, 'state')
  const projectsDir = join(claudeDir, 'projects')
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const cwd = join(root, 'cwds', 'myproject')
  mkdirSync(cwd, { recursive: true })

  const slugDir = join(projectsDir, 'slug-fully-captured')
  mkdirSync(join(slugDir, 'memory'), { recursive: true })
  const sessionId = 'sess-fully-captured'
  const content = bareLine('queue-operation') + userLine('hello', cwd) + assistantLine('hi there')
  const path = join(slugDir, sessionId + '.jsonl')
  writeFileSync(path, content, 'utf8')
  utimesSync(path, IN_WINDOW, IN_WINDOW)
  // Watermark at the file's exact size, no .dropped marker -> not listed.
  writeFileSync(join(stateDir, sessionId), String(Buffer.byteLength(content, 'utf8')), 'utf8')
  writeFileSync(join(slugDir, 'memory', 'notes.md'), '# Notes\nSome memory.\n', 'utf8')

  const scan = scanClaudeCode(claudeDir, stateDir, baseOpts())

  const matches = scan.projects.filter((p) => p.slug === 'slug-fully-captured')
  assert.equal(matches.length, 1, 'exactly one entry for this slug')
  const entry = matches[0]
  assert.equal(entry.name, 'myproject', 'the resolved cwd name must survive even though the only session is not listed')
  assert.deepEqual(entry.sessions, [])
  assert.equal(entry.memoryFiles.length, 1)
  assert.match(entry.memoryFiles[0], /notes\.md$/)
  assert.equal(entry.dialogueBytes, 0)
  assert.ok(
    !scan.projects.some((p) => p.slug === 'slug-fully-captured' && p.name === null),
    'no name:null entry must exist for this slug',
  )

  const lines = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS).split('\n')
  const row = lines.find((l) => l.includes('myproject'))
  assert.ok(row, 'the rendered list must show the resolved name')
  assert.match(row, /^\s*1\.\s+myproject\s+1 memory file$/)
  assert.ok(!row.includes('(memory only)'), 'a resolved name is not rendered as memory-only')
  assert.ok(!row.includes('session'), 'an entry with no listed sessions must not show a session count')
}))

test('A12: a missing ~/.claude produces an empty scan, never a throw', () => withDir((root) => {
  const scan = scanClaudeCode(join(root, 'nope', '.claude'), join(root, 'state'), baseOpts())
  assert.deepEqual(scan.projects, [])
  assert.equal(scan.userClaudeMd, null)
}))

test('A12: a blank CLAUDE.md counts as absent', () => withDir((root) => {
  const claudeDir = join(root, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(join(claudeDir, 'CLAUDE.md'), '   \n\n  ', 'utf8')
  const scan = scanClaudeCode(claudeDir, join(root, 'state'), baseOpts())
  assert.equal(scan.userClaudeMd, null)
}))

// ---- renderBootstrapList ----------------------------------------------------

test('A12: renderBootstrapList numbers every project, marks memory-only, and prints the CLAUDE.md line', () => withDir((root) => {
  const fx = buildFixture(root)
  const scan = scanClaudeCode(fx.claudeDir, fx.stateDir, baseOpts())
  const text = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
  const lines = text.split('\n')

  assert.equal(lines[0], 'Found memory and history from Claude Code on this machine (last 180 days):')

  // scan.projects order is [work, slug-mixed, waku, slug-memoryonly]
  assert.match(lines[1], /^\s*1\.\s+work\s+1 session, .+ of dialogue$/)
  assert.match(lines[2], /^\s*2\.\s+slug-mixed\s+2 sessions, .+ of dialogue$/)
  assert.match(lines[3], /^\s*3\.\s+waku\s+1 session, .+ of dialogue, 2 memory files$/)
  assert.match(lines[4], /^\s*4\.\s+slug-memoryonly \(memory only\)\s+1 memory file$/)

  const claudeMdLine = lines[5]
  assert.match(claudeMdLine, /^\s*\+\s+~\/\.claude\/CLAUDE\.md \(\d+ KB\)$/)

  assert.equal(lines[6], 'Everything listed is sent to our servers and on to the AI providers that turn it into memories and make them searchable.')
  assert.equal(lines[7], 'www.waku.one/privacy names them. This is an alpha whose data can be lost.')
  assert.equal(lines[8], 'Enter imports all of it; type numbers to leave projects out (e.g. 1 3); n skips.')
  assert.equal(lines.length, 9)
}))

test('A12: renderBootstrapList singularizes one session and marks a missing CLAUDE.md as skipped', () => {
  const scan = {
    projects: [
      { name: 'solo', slug: 'slug-solo', sessions: [{ sessionId: 's1', path: '/x', project: 'solo', from: 0, spans: [], dialogueBytes: 500, pieces: 1, mtimeMs: 0, harness: 'claude_code' }], memoryFiles: [], dialogueBytes: 500, harness: 'claude_code' },
    ],
    userClaudeMd: null,
    harnesses: ['claude_code'],
  }
  const text = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
  const lines = text.split('\n')
  assert.match(lines[1], /^\s*1\.\s+solo\s+1 session, \d+ KB of dialogue$/)
  assert.match(lines[2], /^\s*\+\s+~\/\.claude\/CLAUDE\.md \(empty, skipped\)$/)
})

test('A12: renderBootstrapList sizes above 1 MB in MB with one decimal', () => {
  const scan = {
    projects: [
      { name: 'big', slug: 'slug-big', sessions: [{ sessionId: 's1', path: '/x', project: 'big', from: 0, spans: [], dialogueBytes: 3_460_000, pieces: 20, mtimeMs: 0, harness: 'claude_code' }, { sessionId: 's2', path: '/y', project: 'big', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 0, harness: 'claude_code' }], memoryFiles: [], dialogueBytes: 3_460_000, harness: 'claude_code' },
    ],
    userClaudeMd: null,
    harnesses: ['claude_code'],
  }
  const text = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
  assert.match(text.split('\n')[1], /2 sessions, 3\.3 MB of dialogue/)
})

test('A12: renderBootstrapList under --all (windowDays: null) says "all transcripts" and warns about live sessions', () => {
  const scan = {
    projects: [
      { name: 'p', slug: 'slug-p', sessions: [{ sessionId: 's1', path: '/x', project: 'p', from: 0, spans: [], dialogueBytes: 100, pieces: 1, mtimeMs: 0, harness: 'claude_code' }], memoryFiles: [], dialogueBytes: 100, harness: 'claude_code' },
    ],
    userClaudeMd: null,
    harnesses: ['claude_code'],
  }
  const lines = renderBootstrapList(scan, null).split('\n')
  assert.equal(lines[0], 'Found memory and history from Claude Code on this machine (all transcripts):')
  const liveLineIndex = lines.indexOf('Sessions captured live will be extracted a second time.')
  const sentLineIndex = lines.indexOf('Everything listed is sent to our servers and on to the AI providers that turn it into memories and make them searchable.')
  assert.ok(liveLineIndex > 0, 'the live-session warning must appear')
  assert.ok(liveLineIndex < sentLineIndex, 'it must come before the closing instructions')
})

test('A12: renderBootstrapList on an empty scan returns the one sentence, alone', () => {
  const text = renderBootstrapList({ projects: [], userClaudeMd: null, harnesses: ['claude_code'] }, DEFAULT_WINDOW_DAYS)
  assert.equal(text, 'Nothing from Claude Code to import on this machine.')
})

test('A12: renderBootstrapList with no projects but a non-blank CLAUDE.md still prints it', () => {
  const scan = { projects: [], userClaudeMd: { path: '/home/u/.claude/CLAUDE.md', content: 'Be terse.\n' }, harnesses: ['claude_code'] }
  const lines = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS).split('\n')
  assert.equal(lines[0], 'Found memory and history from Claude Code on this machine (last 180 days):')
  assert.match(lines[1], /^\s*\+\s+~\/\.claude\/CLAUDE\.md \(\d+ KB\)$/)
  assert.equal(lines[2], 'Everything listed is sent to our servers and on to the AI providers that turn it into memories and make them searchable.')
  assert.equal(lines[3], 'www.waku.one/privacy names them. This is an alpha whose data can be lost.')
  assert.equal(lines[4], 'Enter imports all of it; type numbers to leave projects out (e.g. 1 3); n skips.')
  assert.equal(lines.length, 5)
})

test('A12: renderBootstrapList with Codex-only scan names Codex in the header', () => {
  const scan = {
    projects: [
      {
        name: 'waku',
        slug: 'codex:waku',
        memoryFiles: [],
        dialogueBytes: 100,
        harness: 'codex',
        sessions: [
          {
            sessionId: 'sess-1',
            path: '/path/to/file.jsonl',
            project: 'waku',
            from: 0,
            spans: [],
            dialogueBytes: 100,
            pieces: 1,
            mtimeMs: 1000,
            harness: 'codex',
          },
        ],
      },
    ],
    userClaudeMd: null,
    harnesses: ['codex'],
  }
  const lines = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS).split('\n')
  assert.equal(lines[0], 'Found memory and history from Codex on this machine (last 180 days):')
})

test('A12: renderBootstrapList with dual-harness scan names both in the header', () => {
  const scan = {
    projects: [
      {
        name: 'work',
        slug: 'work',
        memoryFiles: [],
        dialogueBytes: 200,
        harness: 'claude_code',
        sessions: [
          {
            sessionId: 'cc-1',
            path: '/path/to/cc.jsonl',
            project: 'work',
            from: 0,
            spans: [],
            dialogueBytes: 200,
            pieces: 1,
            mtimeMs: 1000,
            harness: 'claude_code',
          },
        ],
      },
      {
        name: 'waku',
        slug: 'codex:waku',
        memoryFiles: [],
        dialogueBytes: 100,
        harness: 'codex',
        sessions: [
          {
            sessionId: 'codex-1',
            path: '/path/to/codex.jsonl',
            project: 'waku',
            from: 0,
            spans: [],
            dialogueBytes: 100,
            pieces: 1,
            mtimeMs: 1000,
            harness: 'codex',
          },
        ],
      },
    ],
    userClaudeMd: null,
    harnesses: ['claude_code', 'codex'],
  }
  const lines = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS).split('\n')
  assert.equal(lines[0], 'Found memory and history from Claude Code and Codex on this machine (last 180 days):')
})

test('A12: renderBootstrapList with empty Codex-only scan names Codex in empty message', () => {
  const scan = {
    projects: [],
    userClaudeMd: null,
    harnesses: ['codex'],
  }
  const text = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
  assert.equal(text, 'Nothing from Codex to import on this machine.')
})

test('A12: renderBootstrapList with empty harnesses list (no harness configured) renders without harness phrase', () => {
  const scan = {
    projects: [],
    userClaudeMd: null,
    harnesses: [],
  }
  const text = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
  assert.equal(text, 'Nothing to import on this machine.')
})

// ---- parseBootstrapAnswer ---------------------------------------------------

test('A12: parseBootstrapAnswer: empty answer imports everything', () => {
  assert.deepEqual(parseBootstrapAnswer('', 3), { kind: 'all' })
  assert.deepEqual(parseBootstrapAnswer('   ', 3), { kind: 'all' })
})

test('A12: parseBootstrapAnswer: n or N skips', () => {
  assert.deepEqual(parseBootstrapAnswer('n', 3), { kind: 'skip' })
  assert.deepEqual(parseBootstrapAnswer('N', 3), { kind: 'skip' })
  assert.deepEqual(parseBootstrapAnswer(' n ', 3), { kind: 'skip' })
})

test('A12: parseBootstrapAnswer: numbers exclude, deduplicated and sorted', () => {
  assert.deepEqual(parseBootstrapAnswer('1 3', 3), { kind: 'exclude', numbers: [1, 3] })
  assert.deepEqual(parseBootstrapAnswer('3 1 1', 3), { kind: 'exclude', numbers: [1, 3] })
  assert.deepEqual(parseBootstrapAnswer('2', 3), { kind: 'exclude', numbers: [2] })
})

test('A12: parseBootstrapAnswer: out of range or non-numeric is invalid', () => {
  assert.deepEqual(parseBootstrapAnswer('9', 3), { kind: 'invalid' })
  assert.deepEqual(parseBootstrapAnswer('0', 3), { kind: 'invalid' })
  assert.deepEqual(parseBootstrapAnswer('a', 3), { kind: 'invalid' })
  assert.deepEqual(parseBootstrapAnswer('1 a', 3), { kind: 'invalid' })
  assert.deepEqual(parseBootstrapAnswer('1,3', 3), { kind: 'invalid' })
})

test('A12: constants match the spec', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 180)
  assert.equal(LIVE_WINDOW_MS, 10 * 60 * 1000)
  assert.equal(MEMORY_SESSION_ID, 'bootstrap:claude-code-memory')
})

// ---- A13: runBootstrap and memoryFileSource (task 13, spec 011 §8) --------
//
// Everything below builds its own Scan by hand -- plain object literals
// matching bootstrap.ts's own types, over real files on a throwaway temp
// directory -- rather than by calling scanClaudeCode. runBootstrap only
// ever reads a SessionEntry's sessionId/path/project/from/spans/mtimeMs and
// a ProjectEntry's name/slug/memoryFiles/sessions; dialogueBytes and pieces
// are display-only fields renderBootstrapList uses (A12, above) and are
// never consulted here, so every fixture below sets them to 0. This keeps
// task 13's own tests independent of task 12's scanning logic entirely.

// userLine/assistantLine are already declared above (the A12 fixture).

// A `user` line whose formatted-and-stringified byte length is exactly
// targetBytes, grown one character at a time -- used for the tail fixture,
// which needs a watermark that lands exactly on a line boundary (its `from`
// is a byte offset the test picks, not one formatDelta computed).
function userLineOfSize(targetBytes) {
  let content = ''
  for (;;) {
    const line = userLine(content)
    const bytes = Buffer.byteLength(line, 'utf8')
    if (bytes === targetBytes) return line
    if (bytes > targetBytes) throw new Error(`userLineOfSize: overshot ${targetBytes} at content length ${content.length}`)
    content += 'a'
  }
}

// Records every call as {url, body} (body already JSON.parsed) and answers
// `defaultStatus` (202 unless told otherwise); `overrides` maps a call's
// 0-based index to a different status for that one call -- the only shape
// the "one piece/request fails" tests below need, without a fetchImpl
// written fresh for each one. Mirrors hook.test.mjs's own fakeFetch, which
// only ever needs one fixed status per test and so has no override map.
function fakeFetch(defaultStatus = 202, overrides = {}) {
  const calls = []
  const impl = async (url, init) => {
    const index = calls.length
    const status = index in overrides ? overrides[index] : defaultStatus
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) })
    return { ok: status >= 200 && status < 300, status }
  }
  impl.calls = calls
  return impl
}

function baseDeps(root, overrides = {}) {
  return {
    url: 'https://ingest.test',
    key: 'sekret',
    fetchImpl: fakeFetch(202),
    stateDir: join(root, 'state'),
    all: false,
    ...overrides,
  }
}

// Mirrors real fetch's own cancellation contract: the returned promise only
// settles when the caller's AbortSignal fires, exactly like a connection
// that never answers (a black-holed proxy -- final review M2). Identical to
// hook.test.mjs's own hangingFetch, duplicated rather than shared for the
// same reason fakeFetch above is: this file and hook.test.mjs never import
// from each other.
function hangingFetch() {
  const impl = (url, init) =>
    new Promise((resolve, reject) => {
      const signal = init && init.signal
      if (!signal) return // no signal wired up -- would hang forever, same as a real stuck request
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  return impl
}

// ---- memoryFileSource -------------------------------------------------------

test('A13: memoryFileSource uses the project name, or the slug when there is none', () => {
  assert.equal(bootstrapModule.memoryFileSource('claude_code', 'waku', 'slug-waku', 'notes.md'), 'claude-code-memory:waku/notes.md')
  assert.equal(
    bootstrapModule.memoryFileSource('claude_code', null, 'slug-memoryonly', 'notes.md'),
    'claude-code-memory:slug-memoryonly/notes.md',
  )
})

test('031: memoryFileSource names its harness — Claude Code keeps its prefix, others carry their own', () => {
  // Claude Code keeps the original prefix (back-compat + the 026 cleanup).
  assert.equal(bootstrapModule.memoryPrefix('claude_code'), 'claude-code-memory:')
  // Every other harness names itself, so its docs attribute to it, not Claude Code.
  assert.equal(bootstrapModule.memoryFileSource('hermes', 'Hermes', 'hermes', 'MEMORY.md'), 'hermes-memory:Hermes/MEMORY.md')
  assert.equal(bootstrapModule.memoryFileSource('codex', 'p', 'slug', 'AGENTS.md'), 'codex-memory:p/AGENTS.md')
  assert.equal(bootstrapModule.memoryFileSource('cursor', 'p', 'slug', '.cursorrules'), 'cursor-memory:p/.cursorrules')
})

test('A13: memoryFileSource cuts a long name from the left so the source stays at 200 characters and still names the file', () => {
  const longName = 'x'.repeat(300)
  const source = bootstrapModule.memoryFileSource('claude_code', longName, 'slug', 'notes.md')
  assert.equal(source.length, 200)
  assert.ok(source.startsWith('claude-code-memory:'))
  assert.ok(source.endsWith('/notes.md'))
  // the cut came off the *left* of the name, not the file name
  assert.ok(source.includes('x'.repeat(50)))
})

// ---- runBootstrap: the main fixture (order, bodies, watermarks) -----------

// Two memory-file projects (a named one and a memory-only slug) and one
// project carrying the three which-sessions-are-listed cases the brief
// names: never captured, a tail, and a spans session with a .dropped
// marker naming two spans -- plus a non-blank user CLAUDE.md.
function buildSendFixture(root) {
  const stateDir = join(root, 'state')
  const filesDir = join(root, 'files')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(filesDir, { recursive: true })

  const memADir = join(filesDir, 'mem-alpha')
  mkdirSync(memADir, { recursive: true })
  const alphaFile1 = join(memADir, 'notes.md')
  const alphaFile2 = join(memADir, 'more.md')
  writeFileSync(alphaFile1, '# Notes\nMemory A.\n', 'utf8')
  writeFileSync(alphaFile2, '# More\nMemory A2.\n', 'utf8')

  const memOnlyDir = join(filesDir, 'mem-only')
  mkdirSync(memOnlyDir, { recursive: true })
  const memOnlyFile = join(memOnlyDir, 'x.md')
  writeFileSync(memOnlyFile, '# X\nMemory only.\n', 'utf8')

  const projectAlpha = {
    name: 'alpha',
    slug: 'slug-alpha',
    sessions: [],
    memoryFiles: [alphaFile1, alphaFile2],
    dialogueBytes: 0,
    harness: 'claude_code',
  }
  const projectMemoryOnly = {
    name: null,
    slug: 'slug-memoryonly',
    sessions: [],
    memoryFiles: [memOnlyFile],
    dialogueBytes: 0,
    harness: 'claude_code',
  }

  // never captured: from 0, the whole file is new
  const neverContent = userLine('hello there') + assistantLine('hi, how can I help?')
  const neverPath = join(filesDir, 'sess-never.jsonl')
  writeFileSync(neverPath, neverContent, 'utf8')

  // a tail: the first 100 bytes are one complete line already sent; only
  // what comes after `from: 100` is new.
  const tailLine1 = userLineOfSize(100)
  const tailLine2 = assistantLine('second turn reply')
  const tailContent = tailLine1 + tailLine2
  const tailPath = join(filesDir, 'sess-tail.jsonl')
  writeFileSync(tailPath, tailContent, 'utf8')
  assert.equal(Buffer.byteLength(tailLine1, 'utf8'), 100) // fixture sanity: from lands exactly on the line boundary

  // a spans session: watermark at the file's exact size (nothing left as a
  // tail), a .dropped marker naming two earlier spans.
  const dLine1 = userLine('alpha span content')
  const dLine2 = assistantLine('already sent, not a span')
  const dLine3 = userLine('gamma span content')
  const dLine4 = assistantLine('also already sent')
  const spansContent = dLine1 + dLine2 + dLine3 + dLine4
  const spansPath = join(filesDir, 'sess-spans.jsonl')
  writeFileSync(spansPath, spansContent, 'utf8')
  const off1 = Buffer.byteLength(dLine1, 'utf8')
  const off2 = off1 + Buffer.byteLength(dLine2, 'utf8')
  const off3 = off2 + Buffer.byteLength(dLine3, 'utf8')
  const off4 = off3 + Buffer.byteLength(dLine4, 'utf8')
  writeFileSync(join(stateDir, 'sess-spans'), String(off4), 'utf8')
  writeFileSync(join(stateDir, 'sess-spans.dropped'), `0-${off1}\n${off2}-${off3}\n`, 'utf8')

  const projectBeta = {
    name: 'beta',
    slug: 'slug-beta',
    memoryFiles: [],
    dialogueBytes: 0,
    harness: 'claude_code',
    sessions: [
      { sessionId: 'sess-never', path: neverPath, project: 'beta', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 3000, harness: 'claude_code' },
      { sessionId: 'sess-tail', path: tailPath, project: 'beta', from: 100, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 2000, harness: 'claude_code' },
      {
        sessionId: 'sess-spans',
        path: spansPath,
        project: 'beta',
        from: off4,
        spans: [{ start: 0, end: off1 }, { start: off2, end: off3 }],
        dialogueBytes: 0,
        pieces: 0,
        mtimeMs: 1000,
        harness: 'claude_code',
      },
    ],
  }

  const userClaudeMd = { path: join(root, 'CLAUDE.md'), content: '# User conventions\nAlways be concise.\n' }
  const scan = { projects: [projectAlpha, projectMemoryOnly, projectBeta], userClaudeMd, harnesses: ['claude_code'] }

  return { scan, stateDir, neverContent, tailLine2, off1, off2, off3, off4 }
}

test('A13: runBootstrap sends memory files before sessions, sessions newest first, with the documented request bodies', () =>
  withDirAsync(async (root) => {
    const fx = buildSendFixture(root)
    const fetchImpl = fakeFetch(202)
    const deps = baseDeps(root, { fetchImpl, stateDir: fx.stateDir })

    const result = await bootstrapModule.runBootstrap(fx.scan, { kind: 'all' }, deps)

    const calls = fetchImpl.calls
    const importCalls = calls.filter((c) => c.url.endsWith('/imports'))
    const sessionCalls = calls.filter((c) => c.url.endsWith('/ingest/session'))

    // ---- order: every /imports call precedes every /ingest/session call --
    assert.equal(importCalls.length, 3) // alpha's batch, memory-only's batch, the user CLAUDE.md
    assert.equal(calls.indexOf(importCalls.at(-1)) < calls.indexOf(sessionCalls[0]), true)

    // ---- alpha: project set, both files, in scan order --------------------
    const alphaCall = importCalls[0]
    assert.equal(alphaCall.body.session_id, 'bootstrap:claude-code-memory')
    assert.equal(alphaCall.body.project, 'alpha')
    assert.deepEqual(alphaCall.body.files.map((f) => f.source), [
      'claude-code-memory:alpha/notes.md',
      'claude-code-memory:alpha/more.md',
    ])
    assert.equal(alphaCall.headers.Authorization, 'Bearer sekret')
    assert.equal(alphaCall.headers['Content-Type'], 'application/json')

    // ---- memory-only: no project field, source uses the slug ------------
    const memOnlyCall = importCalls[1]
    assert.equal('project' in memOnlyCall.body, false)
    assert.equal(memOnlyCall.body.files[0].source, 'claude-code-memory:slug-memoryonly/x.md')

    // ---- the user CLAUDE.md: its own request, no project -----------------
    const claudeMdCall = importCalls[2]
    assert.equal('project' in claudeMdCall.body, false)
    assert.equal(claudeMdCall.body.session_id, 'bootstrap:claude-code-memory')
    assert.equal(claudeMdCall.body.files.length, 1)
    assert.equal(claudeMdCall.body.files[0].source, 'claude-code-user:CLAUDE.md')
    assert.equal(claudeMdCall.body.files[0].content, fx.scan.userClaudeMd.content)

    // ---- sessions: newest first (mtimeMs descending), every field present -
    const sessionOrder = [...new Set(sessionCalls.map((c) => c.body.session_id))]
    assert.deepEqual(sessionOrder, ['sess-never', 'sess-tail', 'sess-spans'])
    for (const c of sessionCalls) {
      assert.equal(c.body.harness, 'claude_code')
      assert.equal(c.body.source, 'backfill')
      assert.equal(c.body.content_format, 'cc-dialogue-v1')
      assert.equal(c.body.project, 'beta')
    }

    // ---- result: counts -----------------------------------------------
    assert.equal(result.memoryFiles, 4) // alpha's 2 + memory-only's 1 + the user CLAUDE.md
    assert.equal(result.failed, 0)
    assert.equal(result.sessions, 3)

    // ---- watermarks: never-captured, tail, and spans (A13's own rule) ----
    assert.equal(readWatermark(join(fx.stateDir, 'sess-never')), formatDelta(Buffer.from(fx.neverContent, 'utf8')).end)
    assert.equal(
      readWatermark(join(fx.stateDir, 'sess-tail')),
      100 + formatDelta(Buffer.from(fx.tailLine2, 'utf8')).end,
    )
    assert.equal(readFileSync(join(fx.stateDir, 'sess-spans'), 'utf8'), String(fx.off4)) // unchanged
    assert.equal(existsSync(join(fx.stateDir, 'sess-spans.dropped')), false) // marker deleted
  }))

// ---- exclude / skip ---------------------------------------------------------

test('A13: exclude drops a project\'s memory files and sessions, by 1-based scan.projects position', () =>
  withDirAsync(async (root) => {
    const fx = buildSendFixture(root)
    const fetchImpl = fakeFetch(202)
    const deps = baseDeps(root, { fetchImpl, stateDir: fx.stateDir })

    // scan.projects order is [alpha(1), memory-only(2), beta(3)] -- drop beta.
    const result = await bootstrapModule.runBootstrap(fx.scan, { kind: 'exclude', numbers: [3] }, deps)

    assert.equal(fetchImpl.calls.some((c) => c.url.endsWith('/ingest/session')), false)
    assert.equal(result.sessions, 0)
    assert.equal(result.pieces, 0)
    assert.equal(result.memoryFiles, 4) // alpha's 2 + memory-only's 1 + the user CLAUDE.md -- unaffected
  }))

test('A13: skip sends nothing and returns zeros', () =>
  withDirAsync(async (root) => {
    const fx = buildSendFixture(root)
    const fetchImpl = fakeFetch(202)
    const deps = baseDeps(root, { fetchImpl, stateDir: fx.stateDir })

    const result = await bootstrapModule.runBootstrap(fx.scan, { kind: 'skip' }, deps)

    assert.equal(fetchImpl.calls.length, 0)
    assert.deepEqual(result, { memoryFiles: 0, skills: 0, sessions: 0, pieces: 0, failed: 0 })
  }))

// ---- memory files: batching, oversized files -------------------------------

test('A13: memory files batch at 50 per request within one project, the same project on every batch', () =>
  withDirAsync(async (root) => {
    const memDir = join(root, 'mem')
    mkdirSync(memDir, { recursive: true })
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const files = []
    for (let i = 0; i < 60; i++) {
      const p = join(memDir, `note-${String(i).padStart(2, '0')}.md`)
      writeFileSync(p, `# note ${i}\n`, 'utf8')
      files.push(p)
    }
    const scan = {
      projects: [{ name: 'p', slug: 'slug-p', sessions: [], dialogueBytes: 0, memoryFiles: files }],
      userClaudeMd: null,
    }
    const fetchImpl = fakeFetch(202)
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    const importCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/imports'))
    assert.equal(importCalls.length, 2)
    assert.equal(importCalls[0].body.files.length, 50)
    assert.equal(importCalls[1].body.files.length, 10)
    assert.equal(importCalls[0].body.project, 'p')
    assert.equal(importCalls[1].body.project, 'p')
    assert.equal(result.memoryFiles, 60)
    assert.equal(result.failed, 0)
  }))

test('A13: a memory file over 256 KiB is never sent and counts as failed; a normal-sized sibling still sends', () =>
  withDirAsync(async (root) => {
    const memDir = join(root, 'mem')
    mkdirSync(memDir, { recursive: true })
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const bigPath = join(memDir, 'huge.md')
    writeFileSync(bigPath, 'x'.repeat(257 * 1024), 'utf8')
    const smallPath = join(memDir, 'small.md')
    writeFileSync(smallPath, '# small\n', 'utf8')

    const scan = {
      projects: [{ name: 'p', slug: 'slug-p', sessions: [], dialogueBytes: 0, memoryFiles: [bigPath, smallPath], harness: 'claude_code' }],
      userClaudeMd: null,
    }
    const fetchImpl = fakeFetch(202)
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(result.failed, 1)
    assert.equal(result.memoryFiles, 1)
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(fetchImpl.calls[0].body.files.length, 1)
    assert.equal(fetchImpl.calls[0].body.files[0].source, 'claude-code-memory:p/small.md')
  }))

// ---- sessions: failure handling ---------------------------------------------

test('A13: a fatal failure on one session\'s first piece leaves its watermark unwritten, counts one failed, and later sessions still send', () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    const failingContent = userLine('will fail') + assistantLine('reply')
    const failingPath = join(filesDir, 'sess-failing.jsonl')
    writeFileSync(failingPath, failingContent, 'utf8')

    const okContent = userLine('will succeed') + assistantLine('reply2')
    const okPath = join(filesDir, 'sess-ok.jsonl')
    writeFileSync(okPath, okContent, 'utf8')

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [
            { sessionId: 'sess-failing', path: failingPath, project: 'p', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 2000, harness: 'claude_code' },
            { sessionId: 'sess-ok', path: okPath, project: 'p', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 1000, harness: 'claude_code' },
          ],
        },
      ],
      userClaudeMd: null,
    }

    // Both sessions format to exactly one piece each, so call index 0 is
    // sess-failing's only piece (newest mtimeMs sends first) and index 1 is
    // sess-ok's.
    const fetchImpl = fakeFetch(202, { 0: 500 })
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(existsSync(join(stateDir, 'sess-failing')), false)
    assert.equal(result.failed, 1)
    assert.equal(result.sessions, 1)
    assert.ok(fetchImpl.calls.some((c) => c.body.session_id === 'sess-ok'))
    assert.ok(readWatermark(join(stateDir, 'sess-ok')) > 0)
  }))

test('A13: a 413 on one piece is counted and failed, but the session continues to its next piece', () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    // Two turns, each ~150 KiB: together over MAX_PIECE_BYTES (200 KiB), so
    // formatDelta cuts them into two pieces, one per turn.
    const bigLine1 = userLine('x'.repeat(150 * 1024))
    const bigLine2 = assistantLine('y'.repeat(150 * 1024))
    const content = bigLine1 + bigLine2
    const path = join(filesDir, 'sess-big.jsonl')
    writeFileSync(path, content, 'utf8')

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [{ sessionId: 'sess-big', path, project: 'p', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 1, harness: 'claude_code' }],
        },
      ],
      userClaudeMd: null,
    }

    const fetchImpl = fakeFetch(202, { 0: 413 })
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(fetchImpl.calls.length, 2) // the 413 did not stop the session -- the second piece was still sent
    assert.equal(result.pieces, 1) // only the second (2xx) piece counts
    assert.equal(result.failed, 1) // not every piece answered 2xx
    assert.equal(result.sessions, 0)
    const expectedEnd = formatDelta(Buffer.from(content, 'utf8')).end
    assert.equal(readWatermark(join(stateDir, 'sess-big')), expectedEnd) // still consumed past the 413'd piece
  }))

// ---- sessions: per-piece watermark pinning and the .dropped marker --------
// (task 13 review, R12: a 413 on a tail or a span piece must leave a record
// in the marker, and a fatal failure must still pin the watermark at the
// last piece that actually succeeded.)

test("A13: a 500 on piece 2 of 3 leaves the watermark at piece 1's end and does not send piece 3", () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    // Three turns, each ~150 KiB: any two together are over MAX_PIECE_BYTES
    // (200 KiB), so formatDelta cuts them into three pieces, one per turn --
    // the 413 fixture above, one turn longer.
    const line1 = userLine('x'.repeat(150 * 1024))
    const line2 = assistantLine('y'.repeat(150 * 1024))
    const line3 = userLine('z'.repeat(150 * 1024))
    const content = line1 + line2 + line3
    const path = join(filesDir, 'sess-three.jsonl')
    writeFileSync(path, content, 'utf8')

    const pieces = formatDelta(Buffer.from(content, 'utf8')).pieces
    assert.equal(pieces.length, 3) // fixture sanity: exactly three pieces

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [{ sessionId: 'sess-three', path, project: 'p', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 1, harness: 'claude_code' }],
        },
      ],
      userClaudeMd: null,
    }

    const fetchImpl = fakeFetch(202, { 1: 500 }) // fails piece 2 of 3 (0-based call index 1)
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(fetchImpl.calls.length, 2) // the fatal failure stops before piece 3 is ever sent
    assert.equal(readWatermark(join(stateDir, 'sess-three')), pieces[0].end) // pinned at piece 1's end, not piece 3's
    assert.equal(result.failed, 1)
    assert.equal(result.sessions, 0)
    assert.equal(result.pieces, 1)
  }))

test('A13: a 413 on a tail piece records its span in the marker, advances past it, and counts the session failed', () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    const line1 = userLine('x'.repeat(150 * 1024))
    const line2 = assistantLine('y'.repeat(150 * 1024))
    const line3 = userLine('z'.repeat(150 * 1024))
    const content = line1 + line2 + line3
    const path = join(filesDir, 'sess-three-413.jsonl')
    writeFileSync(path, content, 'utf8')

    const pieces = formatDelta(Buffer.from(content, 'utf8')).pieces
    assert.equal(pieces.length, 3) // fixture sanity: exactly three pieces

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [
            { sessionId: 'sess-three-413', path, project: 'p', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 1, harness: 'claude_code' },
          ],
        },
      ],
      userClaudeMd: null,
    }

    const fetchImpl = fakeFetch(202, { 1: 413 }) // 413s piece 2 of 3 (0-based call index 1)
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(fetchImpl.calls.length, 3) // the 413 does not stop the session -- piece 3 still goes
    const expectedEnd = formatDelta(Buffer.from(content, 'utf8')).end
    assert.equal(readWatermark(join(stateDir, 'sess-three-413')), expectedEnd) // advances to the formatter's end
    assert.equal(
      readFileSync(join(stateDir, 'sess-three-413.dropped'), 'utf8'),
      `${pieces[0].end}-${pieces[1].end}\n`,
    )
    assert.equal(result.failed, 1)
  }))

test('A13: a 413 on one of two spans keeps that span in the marker and drops the other', () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    const dLine1 = userLine('span alpha content')
    const dLine2 = assistantLine('already sent, not a span')
    const dLine3 = userLine('span beta content')
    const dLine4 = assistantLine('also already sent')
    const content = dLine1 + dLine2 + dLine3 + dLine4
    const path = join(filesDir, 'sess-twospans.jsonl')
    writeFileSync(path, content, 'utf8')
    const off1 = Buffer.byteLength(dLine1, 'utf8')
    const off2 = off1 + Buffer.byteLength(dLine2, 'utf8')
    const off3 = off2 + Buffer.byteLength(dLine3, 'utf8')
    const off4 = off3 + Buffer.byteLength(dLine4, 'utf8')
    // Fully captured already -- nothing new as a tail -- with a marker
    // naming the same two spans the SessionEntry below carries.
    writeFileSync(join(stateDir, 'sess-twospans'), String(off4), 'utf8')
    writeFileSync(join(stateDir, 'sess-twospans.dropped'), `0-${off1}\n${off2}-${off3}\n`, 'utf8')

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [
            {
              sessionId: 'sess-twospans',
              path,
              project: 'p',
              from: off4,
              spans: [
                { start: 0, end: off1 },
                { start: off2, end: off3 },
              ],
              dialogueBytes: 0,
              pieces: 0,
              mtimeMs: 1,
              harness: 'claude_code',
            },
          ],
        },
      ],
      userClaudeMd: null,
    }

    const fetchImpl = fakeFetch(202, { 0: 413 }) // the first span's only piece 413s; the second span's succeeds
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(fetchImpl.calls.length, 2) // both spans are still sent
    assert.equal(readFileSync(join(stateDir, 'sess-twospans'), 'utf8'), String(off4)) // watermark untouched
    assert.equal(
      readFileSync(join(stateDir, 'sess-twospans.dropped'), 'utf8'),
      `0-${off1}\n`, // only the failed span remains; the succeeded one is dropped
    )
    assert.equal(result.failed, 1)
    assert.equal(result.sessions, 0)
  }))

// (task 13 re-review, R13: a 413's marker line must survive a later fatal
// failure in the same run -- it was being held only in memory until an
// end-of-run write that a `stopped` session skips entirely.)

test("A13: a tail 413 followed by a 500 keeps the 413's marker line and leaves the watermark at piece 2's end", () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    const line1 = userLine('x'.repeat(150 * 1024))
    const line2 = assistantLine('y'.repeat(150 * 1024))
    const line3 = userLine('z'.repeat(150 * 1024))
    const content = line1 + line2 + line3
    const path = join(filesDir, 'sess-413-then-500.jsonl')
    writeFileSync(path, content, 'utf8')

    const pieces = formatDelta(Buffer.from(content, 'utf8')).pieces
    assert.equal(pieces.length, 3) // fixture sanity: exactly three pieces, same shape as the 413-only test above

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [
            { sessionId: 'sess-413-then-500', path, project: 'p', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 1, harness: 'claude_code' },
          ],
        },
      ],
      userClaudeMd: null,
    }

    // Piece 2 of 3 (0-based call index 1) 413s; piece 3 (0-based call index
    // 2) then hits a fatal 500 in the same tail -- the 413's hole must
    // survive that later fatal failure, not just the ones with no failure
    // after them.
    const fetchImpl = fakeFetch(202, { 1: 413, 2: 500 })
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(fetchImpl.calls.length, 3) // the 413 continues the session; the 500 then stops it
    assert.equal(
      readFileSync(join(stateDir, 'sess-413-then-500.dropped'), 'utf8'),
      `${pieces[0].end}-${pieces[1].end}\n`, // the 413's hole, committed the moment it happened -- not discarded by the later 500
    )
    assert.equal(readWatermark(join(stateDir, 'sess-413-then-500')), pieces[1].end) // advanced past the 413, not past the 500
    assert.equal(result.failed, 1)
    assert.equal(result.sessions, 0)
  }))

test('A13: a stopped run leaves a pre-existing span\'s marker line in place', () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    const dLine1 = userLine('span alpha content')
    const dLine2 = assistantLine('already sent, not a span')
    const dLine3 = userLine('span beta content')
    const dLine4 = assistantLine('also already sent')
    const content = dLine1 + dLine2 + dLine3 + dLine4
    const path = join(filesDir, 'sess-twospans-throw.jsonl')
    writeFileSync(path, content, 'utf8')
    const off1 = Buffer.byteLength(dLine1, 'utf8')
    const off2 = off1 + Buffer.byteLength(dLine2, 'utf8')
    const off3 = off2 + Buffer.byteLength(dLine3, 'utf8')
    const off4 = off3 + Buffer.byteLength(dLine4, 'utf8')
    // Fully captured already -- nothing new as a tail -- with a marker
    // naming the same two spans the SessionEntry below carries.
    writeFileSync(join(stateDir, 'sess-twospans-throw'), String(off4), 'utf8')
    writeFileSync(join(stateDir, 'sess-twospans-throw.dropped'), `0-${off1}\n${off2}-${off3}\n`, 'utf8')

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [
            {
              sessionId: 'sess-twospans-throw',
              path,
              project: 'p',
              from: off4,
              spans: [
                { start: 0, end: off1 },
                { start: off2, end: off3 },
              ],
              dialogueBytes: 0,
              pieces: 0,
              mtimeMs: 1,
              harness: 'claude_code',
            },
          ],
        },
      ],
      userClaudeMd: null,
    }

    // The first span's only piece succeeds; the second span's piece throws
    // outright (a rejected fetch, not just a bad status) -- the other stop
    // path the sendSession comment names alongside a fatal non-2xx.
    let calls = 0
    const fetchImpl = async () => {
      calls++
      if (calls === 1) return { ok: true, status: 202 }
      throw new Error('simulated network failure')
    }
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    assert.equal(calls, 2) // the throw stops the session right after the second span's only piece is attempted
    assert.equal(
      readFileSync(join(stateDir, 'sess-twospans-throw.dropped'), 'utf8'),
      `0-${off1}\n${off2}-${off3}\n`, // both original lines survive -- a stopped run rewrites nothing, even though span 1 just succeeded
    )
    assert.equal(readFileSync(join(stateDir, 'sess-twospans-throw'), 'utf8'), String(off4)) // watermark bytes unchanged
    assert.equal(result.failed, 1)
    assert.equal(result.sessions, 0)
  }))

// ---- final review M2: backfill requests are bounded by a timeout ----------
//
// Before this fix, bootstrap.ts's own `post()` called deps.fetchImpl with no
// AbortSignal at all -- Node's fetch has no default timeout, so a
// black-holed connection (a dead proxy) hung `capture enable` indefinitely
// at the counts line, with no output and no way out but Ctrl-C. hangingFetch
// above stands in for exactly that connection: it never settles on its own,
// only when the signal it was given aborts -- so this test would hang until
// the suite's own runner timeout if `post()` were not internally bounded.
// The budget is injected small (backfillTimeoutMs) so the test proves
// "bounded at the budget" without waiting out the real 30 s default.

test('A13/M2: a hung backfill request is bounded by its timeout, not left to hang forever', () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })

    const content = userLine('will time out') + assistantLine('reply')
    const path = join(filesDir, 'sess-hangs.jsonl')
    writeFileSync(path, content, 'utf8')

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [{ sessionId: 'sess-hangs', path, project: 'p', from: 0, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 1, harness: 'claude_code' }],
        },
      ],
      userClaudeMd: null,
    }

    const start = Date.now()
    const result = await bootstrapModule.runBootstrap(
      scan,
      { kind: 'all' },
      baseDeps(root, { fetchImpl: hangingFetch(), stateDir, backfillTimeoutMs: 20 }),
    )
    const elapsed = Date.now() - start

    // Loose on purpose, same reasoning as hook.test.mjs's identical
    // assertion: the wall clock only has to exclude the 30 s default, so a
    // slow CI box cannot fail it.
    assert.ok(elapsed < 3000, `expected the backfill request to bail out well under the default budget, took ${elapsed}ms`)
    // A timed-out request is a failure exactly like a network error is
    // today (R12/R13): the run stops and the watermark is left unwritten,
    // the same outcome the "fatal failure" test above asserts for a
    // rejected fetch.
    assert.equal(existsSync(join(stateDir, 'sess-hangs')), false)
    assert.equal(result.failed, 1)
    assert.equal(result.sessions, 0)
  }))

// ---- --all: force byte 0, clean up a stale marker --------------------------

test('A13: deps.all sends a watermarked session from byte 0 regardless of its own `from`, and removes a stale marker', () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    mkdirSync(stateDir, { recursive: true })
    const filesDir = join(root, 'files')
    mkdirSync(filesDir, { recursive: true })
    const content = userLine('first') + assistantLine('reply') + userLine('second') + assistantLine('reply2')
    const path = join(filesDir, 'sess-all.jsonl')
    writeFileSync(path, content, 'utf8')
    // A stale watermark partway through, and a stale .dropped marker -- a
    // scan taken under --all already reports spans: [] (task 12), so the
    // marker's continued existence on disk is the only sign of it here.
    writeFileSync(join(stateDir, 'sess-all'), '10', 'utf8')
    writeFileSync(join(stateDir, 'sess-all.dropped'), '0-5\n', 'utf8')

    const scan = {
      projects: [
        {
          name: 'p',
          slug: 'slug-p',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [{ sessionId: 'sess-all', path, project: 'p', from: 10, spans: [], dialogueBytes: 0, pieces: 0, mtimeMs: 1, harness: 'claude_code' }],
        },
      ],
      userClaudeMd: null,
    }
    const fetchImpl = fakeFetch(202)
    const result = await bootstrapModule.runBootstrap(
      scan,
      { kind: 'all' },
      baseDeps(root, { fetchImpl, stateDir, all: true }),
    )

    const call = fetchImpl.calls.find((c) => c.url.endsWith('/ingest/session'))
    assert.ok(call)
    const wholeFile = formatDelta(Buffer.from(content, 'utf8'))
    assert.equal(call.body.content, wholeFile.pieces[0].text) // sent from byte 0, not from 10
    assert.equal(readWatermark(join(stateDir, 'sess-all')), wholeFile.end)
    assert.equal(existsSync(join(stateDir, 'sess-all.dropped')), false) // stale marker removed
    assert.equal(result.sessions, 1)
    assert.equal(result.failed, 0)
  }))

// ---- task 11: scanCodex / scanAll (spec 012 §8) ----------------------------
//
// Codex rollouts live under <codexDir>/sessions/**/rollout-<19-char
// timestamp>-<id>.jsonl (Codex nests them by year/month/day on a real
// machine); the session id is the text after the timestamp and its
// trailing dash. cwd comes from the first record's session_meta.payload.cwd
// -- a different shape from Claude Code's own top-level `cwd` field -- and
// dialogue is cut with formatCodexDelta (codex-dialogue-v1), not
// formatDelta. Everything else -- the window, the ten-minute live rule, the
// watermark/.dropped listing rule -- is the exact same per-session helper
// scanClaudeCode uses (bootstrap.ts's scanTranscript); the
// "scanAll(claudeDir, null, ...) equals scanClaudeCode" test below is what
// proves the extraction changed nothing about the Claude Code path.

const codexRolloutLine = (record) => JSON.stringify(record) + '\n'
const codexSessionMetaLine = (cwd) => codexRolloutLine({ type: 'session_meta', payload: { id: 'sess-meta', cwd } })
const codexUserLine = (text) =>
  codexRolloutLine({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  })
const codexAssistantLine = (text) =>
  codexRolloutLine({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  })

// Builds <root>/.codex/sessions/2026/09/07/ with four rollouts covering the
// same four which-sessions-are-listed cases buildFixture above covers for
// Claude Code: a tail (watermark below size), a dropped-spans marker, a
// live session (mtime "now", must never be listed), and one outside the
// window entirely (a different cwd, so a bug that ignored the window would
// show up as a third session under "waku" or a second project). Also drops
// one rollout whose file name does not fit the rollout-<timestamp>-<id>
// shape, to prove that is skipped rather than thrown on. `stateDir` is the
// same directory buildFixture above uses when both are built on the same
// root, matching spec 012 §8's "same stateDir naming, keyed by session id".
function buildCodexFixture(root) {
  const codexDir = join(root, '.codex')
  const stateDir = join(root, 'state')
  const sessionsDir = join(codexDir, 'sessions', '2026', '09', '07')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const cwds = join(root, 'codex-cwds')
  const wakuCwd = join(cwds, 'waku')
  const oldCwd = join(cwds, 'codex-old-project')
  mkdirSync(wakuCwd, { recursive: true })
  mkdirSync(oldCwd, { recursive: true })

  // ---- tail: watermark below file size -> listed, from = watermark ------
  const tailId = 'tail-0001-uuid'
  const tailMeta = codexSessionMetaLine(wakuCwd)
  const tailLine1 = codexUserLine('first turn')
  const tailLine2 = codexAssistantLine('first reply')
  const tailLine3 = codexUserLine('second turn')
  const tailLine4 = codexAssistantLine('second reply')
  const tailContent = tailMeta + tailLine1 + tailLine2 + tailLine3 + tailLine4
  const tailPath = join(sessionsDir, `rollout-2026-09-07T10-37-45-${tailId}.jsonl`)
  writeFileSync(tailPath, tailContent, 'utf8')
  utimesSync(tailPath, IN_WINDOW, IN_WINDOW)
  const tailWatermark = Buffer.byteLength(tailMeta + tailLine1 + tailLine2, 'utf8')
  writeFileSync(join(stateDir, tailId), String(tailWatermark), 'utf8')

  // ---- dropped: watermark at exact size, .dropped marker -> listed, spans
  const droppedId = 'dropped-0002-uuid'
  const dMeta = codexSessionMetaLine(wakuCwd)
  const dLine1 = codexUserLine('alpha')
  const dLine2 = codexAssistantLine('already sent, not in any span')
  const dLine3 = codexUserLine('gamma')
  const dLine4 = codexAssistantLine('also already sent')
  const droppedContent = dMeta + dLine1 + dLine2 + dLine3 + dLine4
  const droppedPath = join(sessionsDir, `rollout-2026-09-07T10-38-00-${droppedId}.jsonl`)
  writeFileSync(droppedPath, droppedContent, 'utf8')
  utimesSync(droppedPath, IN_WINDOW, IN_WINDOW)
  const metaLen = Buffer.byteLength(dMeta, 'utf8')
  const off1 = metaLen + Buffer.byteLength(dLine1, 'utf8')
  const off2 = off1 + Buffer.byteLength(dLine2, 'utf8')
  const off3 = off2 + Buffer.byteLength(dLine3, 'utf8')
  const off4 = off3 + Buffer.byteLength(dLine4, 'utf8')
  writeFileSync(join(stateDir, droppedId), String(off4), 'utf8') // at exact size
  writeFileSync(join(stateDir, droppedId + '.dropped'), `${metaLen}-${off1}\n${off2}-${off3}\n`, 'utf8')

  // ---- live: mtime "now" -> never listed regardless of watermark state ---
  const liveId = 'live-0003-uuid'
  const liveContent = codexSessionMetaLine(wakuCwd) + codexUserLine('just started') + codexAssistantLine('working on it')
  const livePath = join(sessionsDir, `rollout-2026-09-07T10-39-00-${liveId}.jsonl`)
  writeFileSync(livePath, liveContent, 'utf8')
  utimesSync(livePath, LIVE_TIME, LIVE_TIME)

  // ---- old: outside the window -> must not appear at all ----------------
  const oldId = 'old-0004-uuid'
  const oldContent = codexSessionMetaLine(oldCwd) + codexUserLine('ancient history') + codexAssistantLine('ok')
  const oldPath = join(sessionsDir, `rollout-2026-09-07T10-40-00-${oldId}.jsonl`)
  writeFileSync(oldPath, oldContent, 'utf8')
  utimesSync(oldPath, OLDER_THAN_WINDOW, OLDER_THAN_WINDOW)

  // ---- malformed file name: skipped, must never throw --------------------
  const malformedPath = join(sessionsDir, 'rollout-not-a-timestamp.jsonl')
  writeFileSync(malformedPath, codexUserLine('nope'), 'utf8')
  utimesSync(malformedPath, IN_WINDOW, IN_WINDOW)

  return {
    codexDir,
    stateDir,
    wakuCwd,
    tailId,
    tailPath,
    tailWatermark,
    tailLine3,
    tailLine4,
    droppedId,
    droppedPath,
    dLine1,
    dLine3,
    metaLen,
    off1,
    off2,
    off3,
    off4,
    liveId,
    oldId,
    malformedPath,
  }
}

test('A14: scanCodex groups rollouts by resolved project, sizes with formatCodexDelta, and applies the window/live/watermark/marker rules', () =>
  withDir((root) => {
    const fx = buildCodexFixture(root)
    const projects = bootstrapModule.scanCodex(fx.codexDir, fx.stateDir, baseOpts())

    assert.equal(projects.length, 1, 'only the in-window, non-live sessions produce a project')
    const waku = projects[0]
    assert.equal(waku.name, 'waku')
    assert.equal(waku.slug, 'codex:waku')
    assert.equal(waku.memoryFiles.length, 0)
    assert.equal(waku.harness, 'codex')

    const byId = new Map(waku.sessions.map((s) => [s.sessionId, s]))
    assert.equal(waku.sessions.length, 2, 'tail and dropped are listed; live, old, and the malformed name are not')
    assert.ok(!byId.has(fx.liveId))
    assert.ok(!byId.has(fx.oldId))
    for (const s of waku.sessions) assert.equal(s.harness, 'codex')

    const tail = byId.get(fx.tailId)
    assert.ok(tail, 'the tail session (watermark below size) must be listed')
    assert.equal(tail.from, fx.tailWatermark)
    assert.deepEqual(tail.spans, [])
    const expectedTailBytes = formatCodexDelta(Buffer.from(fx.tailLine3 + fx.tailLine4, 'utf8')).pieces.reduce(
      (n, p) => n + Buffer.byteLength(p.text, 'utf8'),
      0,
    )
    assert.equal(tail.dialogueBytes, expectedTailBytes)
    assert.ok(tail.dialogueBytes > 0)

    const dropped = byId.get(fx.droppedId)
    assert.ok(dropped, 'the marker session must be listed even though its watermark sits at the file size')
    assert.equal(dropped.from, fx.off4)
    assert.deepEqual(dropped.spans, [
      { start: fx.metaLen, end: fx.off1 },
      { start: fx.off2, end: fx.off3 },
    ])
    const expectedDroppedBytes =
      formatCodexDelta(Buffer.from(fx.dLine1, 'utf8')).pieces.reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0) +
      formatCodexDelta(Buffer.from(fx.dLine3, 'utf8')).pieces.reduce((n, p) => n + Buffer.byteLength(p.text, 'utf8'), 0)
    assert.equal(dropped.dialogueBytes, expectedDroppedBytes)

    assert.equal(waku.dialogueBytes, tail.dialogueBytes + dropped.dialogueBytes)
  }))

test('A14: a rollout file name that does not fit rollout-<timestamp>-<id>.jsonl is skipped, with a stderr line, never thrown', () =>
  withDir((root) => {
    const fx = buildCodexFixture(root)
    const realError = console.error
    const lines = []
    console.error = (...args) => lines.push(args.join(' '))
    let projects
    try {
      projects = bootstrapModule.scanCodex(fx.codexDir, fx.stateDir, baseOpts())
    } finally {
      console.error = realError
    }
    assert.ok(
      lines.some((l) => l.includes('rollout-not-a-timestamp.jsonl')),
      'stderr should name the skipped file',
    )
    for (const p of projects) {
      for (const s of p.sessions) assert.notEqual(s.path, fx.malformedPath)
    }
  }))

test('A14: scanAll(claudeDir, null, ...) matches scanClaudeCode exactly -- the extraction changed nothing', () =>
  withDir((root) => {
    const fx = buildFixture(root)
    const direct = scanClaudeCode(fx.claudeDir, fx.stateDir, baseOpts())
    const viaAll = bootstrapModule.scanAll(fx.claudeDir, null, null, null, fx.stateDir, baseOpts())
    assert.deepEqual(viaAll, direct)
  }))

test('A14: scanAll(null, codexDir, ...) reports no Claude Code project and no userClaudeMd', () =>
  withDir((root) => {
    const fx = buildCodexFixture(root)
    const scan = bootstrapModule.scanAll(null, fx.codexDir, null, null, fx.stateDir, baseOpts())
    assert.equal(scan.userClaudeMd, null)
    assert.ok(scan.projects.every((p) => p.harness === 'codex'))
    assert.equal(scan.projects.length, 1)
  }))

test('A14: scanAll concatenates Claude Code and Codex projects, sorted together by dialogueBytes descending, and the Codex label survives rendering', () =>
  withDir((root) => {
    const ccFx = buildFixture(root)
    const codexFx = buildCodexFixture(root)
    assert.equal(ccFx.stateDir, codexFx.stateDir, 'fixture sanity: both harnesses share one stateDir, per spec 012 §8')

    const scan = bootstrapModule.scanAll(ccFx.claudeDir, codexFx.codexDir, null, null, ccFx.stateDir, baseOpts())

    const codexEntries = scan.projects.filter((p) => p.harness === 'codex')
    assert.equal(codexEntries.length, 1)
    assert.equal(codexEntries[0].name, 'waku')
    assert.equal(codexEntries[0].slug, 'codex:waku')

    const ccEntries = scan.projects.filter((p) => p.harness === 'claude_code')
    assert.equal(ccEntries.length, 4) // same four the standalone scanClaudeCode test finds

    // Sorted by dialogueBytes descending across both harnesses together
    // (memory-only entries -- Claude Code's alone, Codex never has one --
    // always sort last, same rule compareProjectEntries already applies).
    const withSessions = scan.projects.filter((p) => p.sessions.length > 0)
    for (let i = 1; i < withSessions.length; i++) {
      assert.ok(withSessions[i - 1].dialogueBytes >= withSessions[i].dialogueBytes)
    }
    assert.ok(scan.projects.slice(withSessions.length).every((p) => p.sessions.length === 0))

    assert.equal(scan.userClaudeMd.path, ccFx.claudeMdPath) // userClaudeMd stays Claude Code's alone

    const rendered = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
    assert.match(rendered, /waku \(Codex\)/) // the Codex "waku" entry is labelled
    const lines = rendered.split('\n')
    const workLine = lines.find((l) => /\bwork\b/.test(l))
    assert.ok(workLine, 'the Claude Code "work" project should still be rendered')
    assert.ok(!workLine.includes('(Codex)'), 'a Claude Code project must not be labelled "(Codex)"')
  }))

test("A14: runBootstrap posts each session's own harness and content_format (PROFILES, task 8), never one hardcoded value", () =>
  withDirAsync(async (root) => {
    const stateDir = join(root, 'state')
    const filesDir = join(root, 'files')
    mkdirSync(stateDir, { recursive: true })
    mkdirSync(filesDir, { recursive: true })

    const ccContent = userLine('cc turn') + assistantLine('cc reply')
    const ccPath = join(filesDir, 'sess-cc.jsonl')
    writeFileSync(ccPath, ccContent, 'utf8')

    const codexContent = codexSessionMetaLine('/home/yang/waku') + codexUserLine('codex turn') + codexAssistantLine('codex reply')
    const codexPath = join(filesDir, 'sess-codex.jsonl')
    writeFileSync(codexPath, codexContent, 'utf8')

    const scan = {
      projects: [
        {
          name: 'cc-project',
          slug: 'slug-cc',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'claude_code',
          sessions: [
            {
              sessionId: 'sess-cc',
              path: ccPath,
              project: 'cc-project',
              from: 0,
              spans: [],
              dialogueBytes: 0,
              pieces: 0,
              mtimeMs: 2,
              harness: 'claude_code',
            },
          ],
        },
        {
          name: 'codex-project',
          slug: 'codex:codex-project',
          memoryFiles: [],
          dialogueBytes: 0,
          harness: 'codex',
          sessions: [
            {
              sessionId: 'sess-codex',
              path: codexPath,
              project: 'codex-project',
              from: 0,
              spans: [],
              dialogueBytes: 0,
              pieces: 0,
              mtimeMs: 1,
              harness: 'codex',
            },
          ],
        },
      ],
      userClaudeMd: null,
    }

    const fetchImpl = fakeFetch(202)
    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, baseDeps(root, { fetchImpl, stateDir }))

    const sessionCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/ingest/session'))
    const byId = new Map(sessionCalls.map((c) => [c.body.session_id, c.body]))

    const cc = byId.get('sess-cc')
    assert.ok(cc)
    assert.equal(cc.harness, 'claude_code')
    assert.equal(cc.content_format, 'cc-dialogue-v1')

    const codex = byId.get('sess-codex')
    assert.ok(codex)
    assert.equal(codex.harness, 'codex')
    assert.equal(codex.content_format, 'codex-dialogue-v1')
    assert.match(codex.content, /codex turn/)
    assert.match(codex.content, /codex reply/)

    assert.equal(result.sessions, 2)
    assert.equal(result.failed, 0)
  }))

// ---- authored skills (spec 026, task 2) ------------------------------------

test('026: skillSource is skill:<harness>/<name>, left-trimmed to fit 200 chars', () => {
  assert.equal(bootstrapModule.skillSource('claude_code', 'teach-the-concept'), 'skill:claude_code/teach-the-concept')
  const long = 'x'.repeat(300)
  const src = bootstrapModule.skillSource('claude_code', long)
  assert.ok(src.length <= 200, 'bounded to 200')
  assert.ok(src.startsWith('skill:claude_code/'), 'prefix and harness always survive')
})

test('026: scanClaudeCode finds each skills/<name>/SKILL.md, sorted, and skips a dir without one', () =>
  withDir((root) => {
    const claudeDir = join(root, '.claude')
    mkdirSync(join(claudeDir, 'skills', 'teach-the-concept'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'teach-the-concept', 'SKILL.md'), '# teach\n')
    mkdirSync(join(claudeDir, 'skills', 'brainstorming'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'brainstorming', 'SKILL.md'), '# brainstorm\n')
    // A skill directory with no SKILL.md is not a skill -- negative case.
    mkdirSync(join(claudeDir, 'skills', 'not-a-skill'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'not-a-skill', 'README.md'), '# readme\n')

    const scan = scanClaudeCode(claudeDir, join(root, 'state'), baseOpts())
    assert.deepEqual(
      scan.skills.map((s) => s.name),
      ['brainstorming', 'teach-the-concept'],
    )
    assert.ok(scan.skills.every((s) => s.harness === 'claude_code'))
    assert.ok(scan.skills.every((s) => s.path.endsWith('/SKILL.md')))
  }))

test('026: an absent skills/ dir is no skills, never a throw', () =>
  withDir((root) => {
    const claudeDir = join(root, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const scan = scanClaudeCode(claudeDir, join(root, 'state'), baseOpts())
    assert.deepEqual(scan.skills, [])
  }))

test('026: runBootstrap sends each SKILL.md to /imports with a skill: source', () =>
  withDirAsync(async (root) => {
    const claudeDir = join(root, '.claude')
    mkdirSync(join(claudeDir, 'skills', 'teach-the-concept'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'teach-the-concept', 'SKILL.md'), '# teach\nName the concept.\n')

    const scan = scanClaudeCode(claudeDir, join(root, 'state'), baseOpts())
    const fetchImpl = fakeFetch(202)
    const deps = baseDeps(root, { fetchImpl, stateDir: join(root, 'state') })

    const result = await bootstrapModule.runBootstrap(scan, { kind: 'all' }, deps)

    const importCalls = fetchImpl.calls.filter((c) => c.url.endsWith('/imports'))
    const sources = importCalls.flatMap((c) => c.body.files.map((f) => f.source))
    assert.ok(sources.includes('skill:claude_code/teach-the-concept'), 'the skill is sent with a skill: source')
    assert.equal(result.skills, 1)
  }))

test('026: renderBootstrapList shows a skills summary line when there are skills', () => {
  const scan = {
    projects: [
      { name: 'p', slug: 'slug-p', sessions: [{ sessionId: 's1', path: '/x', project: 'p', from: 0, spans: [], dialogueBytes: 100, pieces: 1, mtimeMs: 0, harness: 'claude_code' }], memoryFiles: [], dialogueBytes: 100, harness: 'claude_code' },
    ],
    userClaudeMd: null,
    skills: [
      { name: 'teach-the-concept', path: '/x/skills/teach-the-concept/SKILL.md', harness: 'claude_code' },
      { name: 'brainstorming', path: '/x/skills/brainstorming/SKILL.md', harness: 'claude_code' },
    ],
    harnesses: ['claude_code'],
  }
  const text = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
  assert.match(text, /\+\s+2 skills \(2 Claude Code\)/)
})

test('031: the skills summary names each harness with its count, most first', () => {
  const scan = {
    projects: [],
    userClaudeMd: null,
    skills: [
      { name: 'a', path: '/x/a/SKILL.md', harness: 'claude_code' },
      { name: 'b', path: '/x/b/SKILL.md', harness: 'claude_code' },
      { name: 'c', path: '/x/c/SKILL.md', harness: 'hermes' },
      { name: 'd', path: '/x/d/SKILL.md', harness: 'codex' },
    ],
    harnesses: ['claude_code', 'codex', 'hermes'],
  }
  const text = renderBootstrapList(scan, DEFAULT_WINDOW_DAYS)
  // Most-first, so Claude Code (2) leads; the single-skill harnesses break ties
  // by label. No hardcoded "~/.claude/skills" that mislabels a Hermes skill.
  assert.match(text, /\+\s+4 skills \(2 Claude Code, 1 Codex, 1 Hermes\)/)
  assert.equal(text.includes('~/.claude/skills'), false)
})

test('026: scanAll scans Codex skills (skills/) and Cursor skills (skills-cursor/)', () =>
  withDir((root) => {
    const codexDir = join(root, '.codex')
    mkdirSync(join(codexDir, 'skills', 'supermemory-status'), { recursive: true })
    writeFileSync(join(codexDir, 'skills', 'supermemory-status', 'SKILL.md'), '# codex skill\n')

    const cursorDir = join(root, '.cursor')
    mkdirSync(join(cursorDir, 'skills-cursor', 'automate'), { recursive: true })
    writeFileSync(join(cursorDir, 'skills-cursor', 'automate', 'SKILL.md'), '# cursor skill\n')

    const scan = bootstrapModule.scanAll(null, codexDir, cursorDir, null, join(root, 'state'), baseOpts())

    const bySource = scan.skills.map((s) => bootstrapModule.skillSource(s.harness, s.name)).sort()
    assert.deepEqual(bySource, ['skill:codex/supermemory-status', 'skill:cursor/automate'])
    assert.ok(scan.harnesses.includes('codex'))
    assert.ok(scan.harnesses.includes('cursor'))
  }))

test('skills in a hidden folder are not the person\'s: Codex\'s .system skills are skipped', () =>
  withDir((root) => {
    const codexDir = join(root, '.codex')
    mkdirSync(join(codexDir, 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(codexDir, 'skills', 'my-skill', 'SKILL.md'), '# mine\n')
    mkdirSync(join(codexDir, 'skills', '.system', 'skill-creator'), { recursive: true })
    writeFileSync(join(codexDir, 'skills', '.system', 'skill-creator', 'SKILL.md'), '# built in\n')
    // A hidden folder deeper down is skipped too, and so is a hidden skill.
    mkdirSync(join(codexDir, 'skills', 'group', '.cache', 'tmp'), { recursive: true })
    writeFileSync(join(codexDir, 'skills', 'group', '.cache', 'tmp', 'SKILL.md'), '# cached\n')
    mkdirSync(join(codexDir, 'skills', '.hidden-skill'), { recursive: true })
    writeFileSync(join(codexDir, 'skills', '.hidden-skill', 'SKILL.md'), '# hidden\n')

    const scan = bootstrapModule.scanAll(null, codexDir, null, null, join(root, 'state'), baseOpts())

    assert.deepEqual(
      scan.skills.map((s) => bootstrapModule.skillSource(s.harness, s.name)),
      ['skill:codex/my-skill'],
    )
  }))

test('031: scanAll scans Hermes memory docs as one entry and its skills, nested or flat', () =>
  withDir((root) => {
    const hermesDir = join(root, '.hermes')
    mkdirSync(join(hermesDir, 'memories'), { recursive: true })
    writeFileSync(join(hermesDir, 'memories', 'MEMORY.md'), '# hermes memory index\n')
    mkdirSync(join(hermesDir, 'hermes-agent'), { recursive: true })
    writeFileSync(join(hermesDir, 'hermes-agent', 'AGENTS.md'), '# hermes agent\n')
    // A nested skill (under a category dir) and a flat one — both must be found.
    mkdirSync(join(hermesDir, 'skills', 'apple', 'apple-notes'), { recursive: true })
    writeFileSync(join(hermesDir, 'skills', 'apple', 'apple-notes', 'SKILL.md'), '# nested\n')
    mkdirSync(join(hermesDir, 'skills', 'computer-use'), { recursive: true })
    writeFileSync(join(hermesDir, 'skills', 'computer-use', 'SKILL.md'), '# flat\n')

    const scan = bootstrapModule.scanAll(null, null, null, hermesDir, join(root, 'state'), baseOpts())

    assert.ok(scan.harnesses.includes('hermes'))
    // Both docs fold into one Hermes entry, no sessions.
    const hermesEntry = scan.projects.find((p) => p.harness === 'hermes')
    assert.ok(hermesEntry, 'a Hermes project entry exists')
    assert.equal(hermesEntry.memoryFiles.length, 2)
    assert.equal(hermesEntry.sessions.length, 0)
    // Skills carry the harness and a nesting-preserving name.
    const bySource = scan.skills.map((s) => bootstrapModule.skillSource(s.harness, s.name)).sort()
    assert.deepEqual(bySource, ['skill:hermes/apple/apple-notes', 'skill:hermes/computer-use'])
  }))

test('031: an absent ~/.hermes contributes nothing and never throws', () =>
  withDir((root) => {
    const scan = bootstrapModule.scanAll(null, null, null, join(root, '.hermes'), join(root, 'state'), baseOpts())
    assert.equal(scan.harnesses.includes('hermes'), true) // the dir was passed; it just holds nothing
    assert.deepEqual(scan.skills, [])
    assert.deepEqual(scan.projects, [])
  }))

// ---- 031 task 3: the Waku agent ------------------------------------------
// waku-agent spec 003 writes each fact to <home>/memory/<id>.md, one file per
// fact. The shim imports those files as Knowledge and <home>/skills as skills.
// It never reads state.db (Node 20 has no node:sqlite) and never the
// generated MEMORY.md, which holds every episode and changes every turn.

function wakuHome(root) {
  const wakuDir = join(root, '.waku')
  mkdirSync(join(wakuDir, 'memory'), { recursive: true })
  writeFileSync(join(wakuDir, 'memory', '412.md'), '---\nsubject: acme\n---\nAcme cut its price to $19.\n')
  writeFileSync(join(wakuDir, 'memory', '7.md'), '---\nsubject: alex\n---\nAlex prefers morning meetings.\n')
  writeFileSync(join(wakuDir, 'MEMORY.md'), '# Waku memory\n## Episodes\n- talked about treg\n')
  writeFileSync(join(wakuDir, 'state.db'), 'not read')
  mkdirSync(join(wakuDir, 'skills', 'company-brain'), { recursive: true })
  writeFileSync(join(wakuDir, 'skills', 'company-brain', 'SKILL.md'), '# company brain\n')
  return wakuDir
}

test('031 task 3: scanAll imports each Waku fact file and Waku skill, and nothing else', () =>
  withDir((root) => {
    const wakuDir = wakuHome(root)
    const scan = bootstrapModule.scanAll(null, null, null, null, join(root, 'state'), baseOpts(), wakuDir)

    assert.ok(scan.harnesses.includes('waku'))
    const entry = scan.projects.find((p) => p.harness === 'waku')
    assert.ok(entry, 'a Waku entry exists')
    assert.equal(entry.sessions.length, 0)
    assert.deepEqual(entry.memoryFiles.map((f) => basename(f)).sort(), ['412.md', '7.md'])
    const sources = entry.memoryFiles
      .map((f) => bootstrapModule.memoryFileSource(entry.harness, entry.name, entry.slug, basename(f)))
      .sort()
    assert.deepEqual(sources, ['waku-memory:Waku/412.md', 'waku-memory:Waku/7.md'])
    assert.deepEqual(
      scan.skills.map((s) => bootstrapModule.skillSource(s.harness, s.name)),
      ['skill:waku/company-brain'],
    )
  }))

test('031 task 3: an absent or empty Waku home contributes nothing and never throws', () =>
  withDir((root) => {
    const missing = bootstrapModule.scanAll(null, null, null, null, join(root, 'state'), baseOpts(), join(root, '.waku'))
    assert.deepEqual(missing.projects, [])
    assert.deepEqual(missing.skills, [])
    mkdirSync(join(root, '.waku'))
    const empty = bootstrapModule.scanAll(null, null, null, null, join(root, 'state'), baseOpts(), join(root, '.waku'))
    assert.deepEqual(empty.projects, [])
  }))

test('031 task 3: the bootstrap list names Waku', () =>
  withDir((root) => {
    const scan = bootstrapModule.scanAll(null, null, null, null, join(root, 'state'), baseOpts(), wakuHome(root))
    const text = bootstrapModule.renderBootstrapList(scan, 180)
    assert.match(text, /Waku/)
  }))

test('031 task 3: wakuHomeDir prefers WAKU_HOME, else ~/.waku', () => {
  assert.equal(bootstrapModule.wakuHomeDir({ WAKU_HOME: '/x/home' }, '/Users/a'), '/x/home')
  assert.equal(bootstrapModule.wakuHomeDir({}, '/Users/a'), join('/Users/a', '.waku'))
  assert.equal(bootstrapModule.wakuHomeDir({ WAKU_HOME: '' }, '/Users/a'), join('/Users/a', '.waku'))
})

// ---- spec 073 D10: more agent stores --------------------------------------
// Gemini CLI's GEMINI.md, Windsurf's global rules, the files Codex Memories
// writes and a project's CLAUDE.local.md, each imported whole as Knowledge
// under its agent's `<harness>-memory:` prefix, like 031's Hermes.

test('073 D10: scanAll imports GEMINI.md, global_rules.md and Codex memories, one entry each', () =>
  withDir((root) => {
    const geminiDir = join(root, '.gemini')
    mkdirSync(geminiDir, { recursive: true })
    writeFileSync(join(geminiDir, 'GEMINI.md'), '## Gemini Added Memories\n- I use pnpm.\n')
    writeFileSync(join(geminiDir, 'settings.json'), '{}')
    const windsurfDir = join(root, '.codeium', 'windsurf')
    mkdirSync(join(windsurfDir, 'memories'), { recursive: true })
    writeFileSync(join(windsurfDir, 'memories', 'global_rules.md'), 'Answer in English.\n')
    const codexDir = join(root, '.codex')
    mkdirSync(join(codexDir, 'memories', 'deeper'), { recursive: true })
    writeFileSync(join(codexDir, 'memories', 'preferences.md'), 'Tabs, not spaces.\n')
    writeFileSync(join(codexDir, 'memories', 'deeper', 'not-read.md'), 'x\n')
    writeFileSync(join(codexDir, 'memories', 'state.json'), '{}')

    const scan = bootstrapModule.scanAll(
      null, codexDir, null, null, join(root, 'state'), baseOpts(), null, geminiDir, windsurfDir,
    )

    assert.ok(scan.harnesses.includes('gemini') && scan.harnesses.includes('windsurf'))
    const sources = scan.projects
      .flatMap((p) => p.memoryFiles.map((f) => bootstrapModule.memoryFileSource(p.harness, p.name, p.slug, basename(f))))
      .sort()
    assert.deepEqual(sources, [
      'codex-memory:Codex/preferences.md',
      'gemini-memory:Gemini/GEMINI.md',
      'windsurf-memory:Windsurf/global_rules.md',
    ])
    assert.ok(scan.projects.every((p) => p.sessions.length === 0))
    const text = bootstrapModule.renderBootstrapList(scan, 30)
    assert.match(text, /Gemini CLI/)
    assert.match(text, /Windsurf/)
  }))

test('073 D10: an agent folder without its memory file contributes nothing and never throws', () =>
  withDir((root) => {
    const scan = bootstrapModule.scanAll(
      null, join(root, '.codex'), null, null, join(root, 'state'), baseOpts(), null,
      join(root, '.gemini'), join(root, '.codeium', 'windsurf'),
    )
    assert.deepEqual(scan.projects, [])
  }))

test("073 D10: a project's CLAUDE.local.md is one more of its memory files", () =>
  withDir((root) => {
    const fx = buildFixture(root)
    writeFileSync(join(root, 'cwds', 'waku', 'CLAUDE.local.md'), 'My sandbox URL is local.\n')

    const scan = bootstrapModule.scanAll(fx.claudeDir, null, null, null, fx.stateDir, baseOpts())

    const waku = scan.projects.find((p) => p.name === 'waku')
    assert.ok(waku)
    const local = waku.memoryFiles.filter((f) => basename(f) === 'CLAUDE.local.md')
    assert.equal(local.length, 1)
    assert.equal(
      bootstrapModule.memoryFileSource(waku.harness, waku.name, waku.slug, basename(local[0])),
      'claude-code-memory:waku/CLAUDE.local.md',
    )
    const work = scan.projects.find((p) => p.name === 'work')
    assert.deepEqual(work.memoryFiles, [])
  }))
