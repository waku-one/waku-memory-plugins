// Spec 011 §8: "bootstrap at enable" -- scanning the machine for Claude
// Code's own memory files and transcripts, sizing what each transcript
// would send, rendering the one numbered list, parsing the one answer
// (task 12), and sending whatever the answer did not exclude to
// POST /imports and POST /ingest/session (task 13). Spec 012 §8 (task 11)
// extends the scan to Codex's own rollouts -- scanCodex and scanAll, below
// scanClaudeCode -- reusing the same per-session listing/sizing rule
// (scanTranscript) with only the formatter and the cwd finder differing.
// capture.ts's enable() is the caller: it runs the scan, asks the one
// question, and calls runBootstrap below with the answer (task 13); task 14
// adds the --since/--all/--no-bootstrap flags that change what enable()
// asks for.
//
// Zero dependencies, per the brief: node:fs and node:path, plus the sibling
// dialogue.ts (the Piece type, spec 011 §1/§3), harnesses.ts (PROFILES --
// each harness's own content_format and delta formatter, task 8, so this
// file never hardcodes either), hook.ts
// (readWatermark/writeWatermark/droppedMarkerPath -- the same rules the
// live hook uses to read and advance its own bookkeeping files, not
// reimplemented here) and project.ts (resolveProject, spec 011 §7). hook.ts's
// own postJson is private, so the sending half below writes its own small
// `post` rather than importing it.
//
// Every function below takes plain values (a directory, a Buffer, a Scan)
// so bootstrap.test.mjs can build a throwaway ~/.claude -- or, for the
// sending tests, a hand-built Scan over a throwaway state/transcript
// directory -- under a temp dir and never touch a real one or a real
// network.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { type Piece } from './dialogue.ts'
import { droppedMarkerPath, readWatermark, writeWatermark } from './hook.ts'
import { type AuthoredHarness, type HarnessId, PROFILES } from './harnesses.ts'
import { locationOf, resolveProject } from './project.ts'

export const DEFAULT_WINDOW_DAYS = 180
export const LIVE_WINDOW_MS = 10 * 60 * 1000

// Constant on purpose (spec 011 §8): `capture enable` can be re-run, and a
// fixed session_id lets the ingest inbox's (user_id, session_id,
// content_hash) key recognise an unchanged memory file before the import
// classifier ever runs. Task 13 is the caller; this module only exports it.
export const MEMORY_SESSION_ID = 'bootstrap:claude-code-memory'

export type Span = { start: number; end: number }

export type SessionEntry = {
  sessionId: string // the transcript's file name without .jsonl (Claude Code) or the id after the timestamp in rollout-<ts>-<id>.jsonl (Codex)
  path: string // absolute path of the transcript
  project: string | null // resolveProject(cwd) of the first record with a cwd; null when none
  cwd?: string | null // spec 063: that record's cwd, sent beside `project` so the server can resolve the project
  from: number // 0 (never captured, or --all) or the watermark (a tail)
  spans: Span[] // from the .dropped marker; empty when none or under --all
  dialogueBytes: number // formatted bytes that would be sent (from `from`, or the spans)
  pieces: number // how many requests that is
  mtimeMs: number
  // task 11 (spec 012 §8): which harness produced this transcript --
  // selects the wire content_format and delta formatter in runBootstrap
  // (PROFILES[harness], task 8), the only place that knows the harness.
  harness: HarnessId
}

export type ProjectEntry = {
  name: string | null // resolved from any in-window transcript of this slug, listed or not; null only when none exists or none carries a cwd
  cwd?: string | null // spec 063: the cwd `name` was resolved from; its memory files are sent with it
  slug: string // Claude Code: the projects/<slug> directory name; Codex: `codex:<project-or-session-id>` (task 11)
  sessions: SessionEntry[] // may be empty even when name is set: every in-window session of this slug is already fully captured, but it still has memory files
  memoryFiles: string[] // absolute paths of <slug>/memory/*.md, and the project's CLAUDE.local.md (073 D10); a memory-only agent's own files; [] for a Codex session entry (spec 012 §8)
  dialogueBytes: number // sum over sessions; 0 when sessions is empty
  // task 11: uniform across an entry's own sessions (scanAll never merges a
  // Claude Code and a Codex project under one entry, even when their
  // resolved names agree -- see scanAll's own comment). renderBootstrapList
  // reads this to label a Codex row "(Codex)" instead of string-matching
  // the `codex:` slug prefix. AuthoredHarness, not HarnessId (031): a
  // memory-only harness like Hermes has no dialogue profile but still owns an
  // entry for its authored docs; only entries with sessions carry a HarnessId.
  harness: AuthoredHarness
}

// spec 026: a SKILL.md a person authored. Sent whole (source `skill:<harness>/
// <name>`) and stored as one procedural memory, never extracted — the whole
// point of the spec. `name` is the skill's own directory under skills/.
export type SkillEntry = {
  name: string
  path: string // absolute path of skills/<name>/SKILL.md
  harness: AuthoredHarness
}

export type Scan = {
  projects: ProjectEntry[] // ordered by dialogueBytes descending, memory-only slugs last
  userClaudeMd: { path: string; content: string } | null
  skills: SkillEntry[] // authored SKILL.md files, sorted by name (spec 026)
  harnesses: AuthoredHarness[] // which harnesses the scan covered, e.g. ['claude_code'], ['claude_code', 'codex'], ['claude_code', 'codex', 'cursor'], or []
}

export type ScanOptions = { nowMs: number; sinceMs: number; liveWindowMs: number; all: boolean }

// ---- small filesystem helpers, each with its own do-nothing-on-error rule -

// Directory names directly under a given directory (projects/*, or a
// project's slug directory itself when listing transcripts). A missing
// parent (a fresh machine with no ~/.claude at all, or a slug with no
// memory/ subdirectory) is the same as "nothing here" -- never a throw.
function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

// Top-level files only (never recurses): `projects/<slug>/subagents/` and
// `projects/<slug>/tool-results/` are directories, so they never match
// `isFile()` here and are never read, per the brief.
function listFiles(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(ext))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

// ---- authored skills (spec 026) --------------------------------------------

// Every skills/<name>/SKILL.md under a harness's config dir, one SkillEntry
// each, sorted by name so a skill keeps its place between runs. A missing
// skills/ dir is "no skills", never a throw -- the same shape as a machine
// with no memory files. Only SKILL.md is taken: a skill directory's other
// files (references, scripts, assets) are not memory.
// `skillsSubdir` because the directory name is the harness's, not ours: Claude
// Code and Codex keep skills under `skills/`, Cursor under `skills-cursor/`.
// Every directory under `skillsDir` that directly holds a SKILL.md, at any
// depth, as a '/'-joined path relative to skillsDir. Claude Code, Codex and
// Cursor keep skills one level down (skills/<name>/SKILL.md → `<name>`); Hermes
// nests them under category dirs (skills/apple/apple-notes/SKILL.md →
// `apple/apple-notes`). A dir with a SKILL.md is a skill and is NOT descended
// into, so a skill's own resource subdirs never become sub-skills. The relative
// path becomes the skill's name, which keeps the one-level case unchanged.
// A folder whose name starts with "." is skipped at every depth: Codex keeps
// its own built-in skills under ~/.codex/skills/.system/, and before
// 2026-11-20 they imported as the person's own (skill:codex/.system/...).
function findSkillDirs(root: string, prefix: string = ''): string[] {
  const out: string[] = []
  for (const name of listSubdirs(prefix ? join(root, prefix) : root)) {
    if (name.startsWith('.')) continue
    const rel = prefix ? `${prefix}/${name}` : name
    const skillMd = join(root, rel, 'SKILL.md')
    if (existsSync(skillMd) && statSync(skillMd).isFile()) {
      out.push(rel)
    } else {
      out.push(...findSkillDirs(root, rel))
    }
  }
  return out
}

function scanSkills(configDir: string, harness: AuthoredHarness, skillsSubdir: string = 'skills'): SkillEntry[] {
  const skillsDir = join(configDir, skillsSubdir)
  return findSkillDirs(skillsDir).map((name) => ({
    name,
    path: join(skillsDir, name, 'SKILL.md'),
    harness,
  }))
}

// Hermes profile (031). Hermes keeps its memory index at `memories/MEMORY.md`
// and its agent convention at `hermes-agent/AGENTS.md` — both Knowledge — and
// its skills (usually nested under category dirs) at `skills/`. It has no
// transcripts the shim reads, so like Cursor it is an AuthoredHarness that
// contributes authored files only: one entry for its docs, plus its skills, no
// sessions. Absent files → no entry; absent dir → no skills, never a throw.
function scanHermes(hermesDir: string): { projects: ProjectEntry[]; skills: SkillEntry[] } {
  const docs = [
    join(hermesDir, 'memories', 'MEMORY.md'),
    join(hermesDir, 'hermes-agent', 'AGENTS.md'),
  ].filter((p) => existsSync(p) && statSync(p).isFile())
  const projects: ProjectEntry[] =
    docs.length > 0
      ? [{ name: 'Hermes', slug: 'hermes', sessions: [], memoryFiles: docs, dialogueBytes: 0, harness: 'hermes' }]
      : []
  return { projects, skills: scanSkills(hermesDir, 'hermes') }
}

// Waku agent profile (031 task 3). waku-agent spec 003 writes each fact to
// <home>/memory/<id>.md, one file per fact -- the shape Claude Code's own
// memory directory has -- so each file imports whole as one Knowledge memory,
// `waku-memory:Waku/<id>.md`. Skills under <home>/skills import as
// `skill:waku/<name>`. state.db is never read (node:sqlite needs Node 22.5 and
// this package supports 20), and neither is the generated MEMORY.md: it holds
// every episode and is rewritten after every turn. Absent dir or no fact files
// -> no entry, never a throw.
function scanWaku(wakuDir: string): { projects: ProjectEntry[]; skills: SkillEntry[] } {
  const memoryDir = join(wakuDir, 'memory')
  const facts = listFiles(memoryDir, '.md').map((f) => join(memoryDir, f))
  const projects: ProjectEntry[] =
    facts.length > 0
      ? [{ name: 'Waku', slug: 'waku', sessions: [], memoryFiles: facts, dialogueBytes: 0, harness: 'waku' }]
      : []
  return { projects, skills: scanSkills(wakuDir, 'waku') }
}

// spec 073 D10: an agent that keeps what it remembers in one file the person
// can read, following 031's pattern: one entry named for the agent, its
// file(s) sent whole as Knowledge under `<harness>-memory:`, no sessions.
// Absent files -> no entry, never a throw.
function scanMemoryDocs(
  files: string[],
  name: string,
  slug: string,
  harness: AuthoredHarness,
): ProjectEntry[] {
  const docs = files.filter((p) => existsSync(p) && statSync(p).isFile())
  return docs.length > 0
    ? [{ name, slug, sessions: [], memoryFiles: docs, dialogueBytes: 0, harness }]
    : []
}

// Gemini CLI: `/memory add` appends to ~/.gemini/GEMINI.md, which also holds
// the person's own global instructions.
function scanGemini(geminiDir: string): ProjectEntry[] {
  return scanMemoryDocs([join(geminiDir, 'GEMINI.md')], 'Gemini', 'gemini', 'gemini')
}

// Windsurf: the global rules file. Its own generated memories are kept in
// the app, not in a file this can read.
function scanWindsurf(windsurfDir: string): ProjectEntry[] {
  return scanMemoryDocs([join(windsurfDir, 'memories', 'global_rules.md')], 'Windsurf', 'windsurf', 'windsurf')
}

// Codex Memories: every Markdown file directly under ~/.codex/memories/. The
// feature is off by default and only a third party documents its layout, so
// this reads the one shape it can be and nothing deeper; spec 073 T17
// measures it on a real machine.
function scanCodexMemories(codexDir: string): ProjectEntry[] {
  const dir = join(codexDir, 'memories')
  return scanMemoryDocs(listFiles(dir, '.md').map((f) => join(dir, f)), 'Codex', 'codex-memories', 'codex')
}

// Claude Code's CLAUDE.local.md: the person's own notes for one project,
// beside its CLAUDE.md and kept out of git. Read only in the projects the
// scan already found, at the cwd their sessions ran in; never a disk walk.
function addClaudeLocalMd(projects: ProjectEntry[]): void {
  const seen = new Set<string>()
  for (const entry of projects) {
    if (entry.harness !== 'claude_code' || !entry.cwd) continue
    const path = join(entry.cwd, 'CLAUDE.local.md')
    if (seen.has(path)) continue
    seen.add(path)
    try {
      if (statSync(path).isFile()) entry.memoryFiles.push(path)
    } catch {
      // No such file: the common case.
    }
  }
}

// Where the Waku agent keeps its memory (waku-agent spec 002): WAKU_HOME when
// set, else ~/.waku. The shim looks in this one place and never walks the disk
// for .waku folders; a person whose memory is still in a repo's ./.waku is told
// by the agent to copy it into ~/.waku, and the next `capture enable` finds it.
export function wakuHomeDir(env: Record<string, string | undefined>, homeDir: string): string {
  return env.WAKU_HOME ? env.WAKU_HOME : join(homeDir, '.waku')
}

// 'skill:<harness>/<name>' (spec 026). Bounded like memoryFileSource: a name so
// long the source would exceed 200 chars is cut from its own left end so the
// prefix and the harness always survive.
export function skillSource(harness: AuthoredHarness, name: string): string {
  const prefix = `skill:${harness}/`
  const overflow = prefix.length + name.length - MAX_SOURCE_LENGTH
  return prefix + (overflow > 0 ? name.slice(overflow) : name)
}

// ---- bounded head read for finding cwd without reading the whole file -----

// Read up to maxBytes from the start of a file, returning the buffer of
// bytes actually read (may be less than maxBytes if the file is smaller).
// Used to find a transcript's cwd without buffering the entire file into
// memory -- the first cwd sits on line 3–6 of every transcript on a
// reference machine; 256 KiB is hundreds of lines.
export function readHead(path: string, maxBytes: number = 256 * 1024): Buffer {
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(maxBytes)
  let bytesRead: number
  try {
    bytesRead = readSync(fd, buf, 0, maxBytes, 0)
  } finally {
    closeSync(fd)
  }
  return buf.subarray(0, bytesRead)
}

// ---- reading one transcript's header for cwd -------------------------------

// The first record that carries a string `cwd`, scanning line by line and
// parsing each with JSON.parse in its own try/catch -- a transcript's first
// lines are queue-operation/last-prompt/bridge-session records with none.
// Split on raw 0x0a bytes, the same boundary formatDelta uses, so a line's
// trailing \r (a CRLF transcript) rides along into JSON.parse, which
// tolerates it as trailing whitespace.
function findCwd(buf: Buffer): string | null {
  let start = 0
  for (;;) {
    const nl = buf.indexOf(0x0a, start)
    const line = nl === -1 ? buf.subarray(start) : buf.subarray(start, nl)
    if (line.length > 0) {
      try {
        const rec: unknown = JSON.parse(line.toString('utf8'))
        if (rec !== null && typeof rec === 'object' && typeof (rec as { cwd?: unknown }).cwd === 'string') {
          return (rec as { cwd: string }).cwd
        }
      } catch {
        // Not JSON (or not an object): not this record's job to carry cwd.
      }
    }
    if (nl === -1) return null
    start = nl + 1
  }
}

// ---- the .dropped marker: one "start-end" span per line --------------------

// Mirrors the shape hook.ts's postDelta appends
// (`${previousEnd}-${piece.end}\n`, spec 011 §3). A missing marker is "no
// spans", not an error -- most sessions never 413.
function readDroppedSpans(markerPath: string): Span[] {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return []
  }
  const spans: Span[] = []
  for (const line of raw.split('\n')) {
    const m = /^(\d+)-(\d+)$/.exec(line.trim())
    if (m) spans.push({ start: Number(m[1]), end: Number(m[2]) })
  }
  return spans
}

// ---- which sessions are listed, and from where (spec 011 §8) --------------

type Listing = { listed: boolean; from: number; spans: Span[] }

// The watermark/marker rule, read the same way the live hook writes it:
// no watermark file -> from 0; a watermark below the file's size -> a tail;
// a .dropped marker -> spans, regardless of where the watermark sits; a
// watermark at or past the size with no marker -> not listed. `--all`
// short-circuits all of it: every session in the window is listed from
// byte 0, watermarks and markers alike ignored.
function determineListing(watermarkPath: string, markerPath: string, fileSize: number, all: boolean): Listing {
  if (all) return { listed: true, from: 0, spans: [] }
  const watermarkExists = existsSync(watermarkPath)
  const watermark = watermarkExists ? readWatermark(watermarkPath) : 0
  const markerExists = existsSync(markerPath)
  const spans = markerExists ? readDroppedSpans(markerPath) : []
  const listed = !watermarkExists || watermark < fileSize || markerExists
  return { listed, from: watermark, spans }
}

// ---- sizing one session -----------------------------------------------------

function sumPieceBytes(pieces: Piece[]): number {
  return pieces.reduce((sum, p) => sum + Buffer.byteLength(p.text, 'utf8'), 0)
}

// A harness's own delta formatter -- dialogue.ts's formatDelta for Claude
// Code, dialogue-codex.ts's formatCodexDelta for Codex (task 11) -- taken as
// PROFILES[harness].formatDelta (harnesses.ts, task 8) rather than imported
// directly, so this file never has to know either formatter by name.
type FormatDeltaFn = (buf: Buffer, maxPieceBytes?: number) => { pieces: Piece[]; end: number }

// formatDeltaFn(buf.subarray(from)) plus formatDeltaFn(buf.subarray(start,
// end)) per span (spec 011 §8) -- the same formatter the live hook posts
// with, so the size shown is the size that would actually be sent. Offsets
// are clamped defensively: a hand-edited or stale watermark/marker must
// size to *something* rather than throw out of a pure scan.
function sizeSession(
  buf: Buffer,
  from: number,
  spans: Span[],
  formatDeltaFn: FormatDeltaFn,
): { dialogueBytes: number; pieces: number } {
  const clampedFrom = Math.min(Math.max(from, 0), buf.length)
  const tail = formatDeltaFn(buf.subarray(clampedFrom))
  let dialogueBytes = sumPieceBytes(tail.pieces)
  let pieces = tail.pieces.length
  for (const span of spans) {
    const start = Math.min(Math.max(span.start, 0), buf.length)
    const end = Math.min(Math.max(span.end, start), buf.length)
    const result = formatDeltaFn(buf.subarray(start, end))
    dialogueBytes += sumPieceBytes(result.pieces)
    pieces += result.pieces.length
  }
  return { dialogueBytes, pieces }
}

// ---- the per-session helper (spec 011 §8, extended to Codex by spec 012 --
// §8, task 11): the window/live rule, the watermark/.dropped listing rule,
// and sizing with the harness's own formatter, factored out of
// scanClaudeCode so scanCodex applies exactly the same rules -- only the
// formatter and how a transcript's cwd is found differ per harness. `null`
// means this file is not even a candidate (outside the window, or still
// inside the ten-minute live-session grace period): the caller must not
// create a SessionEntry, and -- for Claude Code's own slug-name fallback --
// must not resolve a project name from it either, exactly as before this
// was factored out.
type TranscriptScan =
  | { listed: false; cwd: string | null }
  | { listed: true; cwd: string | null; from: number; spans: Span[]; dialogueBytes: number; pieces: number }

function scanTranscript(
  path: string,
  mtimeMs: number,
  size: number,
  sessionId: string,
  stateDir: string,
  opts: ScanOptions,
  formatDeltaFn: FormatDeltaFn,
  findCwdFn: (buf: Buffer) => string | null,
): TranscriptScan | null {
  if (mtimeMs < opts.sinceMs) return null // outside the window, --all included: --all is about watermarks, not the window
  if (opts.nowMs - mtimeMs < opts.liveWindowMs) return null // its own Stop hook (or, for Codex, nothing yet -- still, the file may still be growing) is still capturing it

  const watermarkPath = join(stateDir, sessionId)
  const markerPath = droppedMarkerPath(watermarkPath)
  const listing = determineListing(watermarkPath, markerPath, size, opts.all)

  if (!listing.listed) {
    // Captured whole already, no holes: no SessionEntry, but the caller may
    // still want this transcript's cwd (Claude Code's slug-name fallback,
    // scanClaudeCode below) -- so this is resolved regardless of listing.
    let cwd: string | null = null
    try {
      cwd = findCwdFn(readHead(path))
    } catch {
      // Unreadable: leave the name unresolved, same as "no cwd".
    }
    return { listed: false, cwd }
  }

  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return null // disappeared between stat and read
  }
  const cwd = findCwdFn(buf)
  const { dialogueBytes, pieces } = sizeSession(buf, listing.from, listing.spans, formatDeltaFn)
  return { listed: true, cwd, from: listing.from, spans: listing.spans, dialogueBytes, pieces }
}

// ---- grouping ---------------------------------------------------------------

// The map key sessions and memory files are grouped under: the resolved
// project name when there is one (so two slugs -- a checkout and its
// worktree -- can merge into one entry, spec 011 §7), else the slug itself,
// so two different no-cwd slugs never accidentally merge into one `null`
// bucket (spec 011 §8's "a session with no cwd goes under the slug").
function groupKey(project: string | null, slug: string): string {
  return project !== null ? `name:${project}` : `slug:${slug}`
}

function compareProjectEntries(a: ProjectEntry, b: ProjectEntry): number {
  const aMemoryOnly = a.sessions.length === 0
  const bMemoryOnly = b.sessions.length === 0
  if (aMemoryOnly !== bMemoryOnly) return aMemoryOnly ? 1 : -1
  if (aMemoryOnly) return a.slug.localeCompare(b.slug) // deterministic among themselves; all read 0 bytes
  if (b.dialogueBytes !== a.dialogueBytes) return b.dialogueBytes - a.dialogueBytes
  return (a.name ?? a.slug).localeCompare(b.name ?? b.slug) // tie-break, e.g. two empty sessions
}

// ---- the user-level CLAUDE.md ----------------------------------------------

function readUserClaudeMd(claudeDir: string): Scan['userClaudeMd'] {
  const path = join(claudeDir, 'CLAUDE.md')
  try {
    const content = readFileSync(path, 'utf8')
    return content.trim() === '' ? null : { path, content }
  } catch {
    return null
  }
}

// ---- the scan ---------------------------------------------------------------

export function scanClaudeCode(claudeDir: string, stateDir: string, opts: ScanOptions): Scan {
  const projectsDir = join(claudeDir, 'projects')
  const entries = new Map<string, ProjectEntry>()
  // Which group a slug's own sessions landed in, so that slug's memory
  // files (read after its sessions, below) attach to the same entry
  // instead of accidentally starting a second one.
  const slugGroup = new Map<string, string>()

  for (const slug of listSubdirs(projectsDir)) {
    const slugDir = join(projectsDir, slug)
    // The slug's resolved project name, from *any* in-window, non-live
    // transcript of this slug -- listed or not (task 12 review finding).
    // Without this, a slug whose only in-window session was already
    // captured whole (watermark at the file's exact size, no marker: not
    // listed, below) never had its cwd read at all, so on a second
    // `capture enable` -- the scenario MEMORY_SESSION_ID's stable id
    // exists for -- its memory files would lose the project name the
    // moment the live hook finished capturing its sessions. Spec 011 §8's
    // memory-only fallback trigger is "no transcript in the window", not
    // "no *listed* transcript", and those differ for exactly this slug.
    // Resolved lazily: once a name is found, a later unlisted transcript
    // of the same slug is not opened just to look for one.
    let slugProjectName: string | null = null
    let slugCwd: string | null = null

    for (const file of listFiles(slugDir, '.jsonl')) {
      const path = join(slugDir, file)
      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(path)
      } catch {
        continue // disappeared between readdir and stat; nothing to report
      }
      const mtimeMs = stat.mtimeMs
      const sessionId = file.slice(0, -'.jsonl'.length)
      const scanned = scanTranscript(path, mtimeMs, stat.size, sessionId, stateDir, opts, PROFILES.claude_code.formatDelta, findCwd)
      if (scanned === null) continue // outside the window, or still live

      if (!scanned.listed) {
        // Captured whole already, no holes: no SessionEntry (unchanged),
        // but this transcript's cwd still counts toward the slug's
        // resolved name so its memory files keep the project name instead
        // of falling back to the slug (see slugProjectName above).
        if (slugProjectName === null && scanned.cwd !== null) {
          slugProjectName = resolveProject(scanned.cwd)
          slugCwd = scanned.cwd
        }
        continue
      }

      const project = scanned.cwd !== null ? resolveProject(scanned.cwd) : null
      if (slugProjectName === null && project !== null) {
        slugProjectName = project
        slugCwd = scanned.cwd
      }

      const session: SessionEntry = {
        sessionId,
        path,
        project,
        cwd: scanned.cwd,
        from: scanned.from,
        spans: scanned.spans,
        dialogueBytes: scanned.dialogueBytes,
        pieces: scanned.pieces,
        mtimeMs,
        harness: 'claude_code',
      }

      const key = groupKey(project, slug)
      let entry = entries.get(key)
      if (!entry) {
        entry = { name: project, cwd: scanned.cwd, slug, sessions: [], memoryFiles: [], dialogueBytes: 0, harness: 'claude_code' }
        entries.set(key, entry)
      }
      entry.sessions.push(session)
      entry.dialogueBytes += scanned.dialogueBytes
      if (!slugGroup.has(slug)) slugGroup.set(slug, key)
    }

    const memoryFiles = listFiles(join(slugDir, 'memory'), '.md').map((f) => join(slugDir, 'memory', f))
    if (memoryFiles.length > 0) {
      // Attach to the entry this slug's own listed sessions landed in, if
      // any; otherwise to the entry for its resolved project name -- a
      // slug whose in-window sessions are all already captured but still
      // resolves a cwd keeps that name here, with sessions: [] (task 12
      // review); otherwise this slug has no in-window transcript with a
      // cwd at all and becomes its own memory-only entry (name: null,
      // shown by its own slug).
      const key = slugGroup.get(slug) ?? groupKey(slugProjectName, slug)
      let entry = entries.get(key)
      if (!entry) {
        entry = { name: slugProjectName, cwd: slugCwd, slug, sessions: [], memoryFiles: [], dialogueBytes: 0, harness: 'claude_code' }
        entries.set(key, entry)
      }
      entry.memoryFiles.push(...memoryFiles)
    }
  }

  const projects = [...entries.values()].sort(compareProjectEntries)
  return {
    projects,
    userClaudeMd: readUserClaudeMd(claudeDir),
    skills: scanSkills(claudeDir, 'claude_code'),
    harnesses: ['claude_code'],
  }
}

// ---- Codex's rollout file name ----------------------------------------------
//
// rollout-<19-char timestamp>-<id>.jsonl, e.g.
// rollout-2026-09-07T10-37-45-a1b2c3d4-....jsonl -- the session id is
// everything after the timestamp and its trailing dash (spec 012 §8). A
// name that does not fit this shape is not a rollout this shim understands
// and is skipped, never guessed at.
const ROLLOUT_FILE_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/

function parseCodexSessionId(fileName: string): string | null {
  const m = ROLLOUT_FILE_RE.exec(fileName)
  return m ? m[1] : null
}

// Every rollout-*.jsonl under <codexDir>/sessions, at any depth -- Codex
// nests them by date (sessions/2026/09/07/rollout-...) on a real machine.
// Same do-nothing-on-error rule as listSubdirs/listFiles above: a missing
// or unreadable directory is "nothing here", never a throw.
function safeReaddirWithTypes(dir: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function listRolloutFiles(sessionsDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const d of safeReaddirWithTypes(dir)) {
      const full = join(dir, d.name)
      if (d.isDirectory()) walk(full)
      else if (d.isFile() && d.name.startsWith('rollout-') && d.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(sessionsDir)
  return out.sort()
}

// ---- reading a rollout's cwd from its session_meta record ------------------
//
// Codex's own record shape (spec 012 §5): cwd sits under `payload.cwd` of
// the first `session_meta` record, not at the top level the way Claude
// Code's own `cwd` field does (findCwd above) -- a different finder, same
// line-by-line-JSON.parse shape.
function findCodexCwd(buf: Buffer): string | null {
  let start = 0
  for (;;) {
    const nl = buf.indexOf(0x0a, start)
    const line = nl === -1 ? buf.subarray(start) : buf.subarray(start, nl)
    if (line.length > 0) {
      try {
        const rec: unknown = JSON.parse(line.toString('utf8'))
        if (rec !== null && typeof rec === 'object') {
          const r = rec as { type?: unknown; payload?: unknown }
          if (r.type === 'session_meta' && r.payload !== null && typeof r.payload === 'object') {
            const cwd = (r.payload as { cwd?: unknown }).cwd
            if (typeof cwd === 'string') return cwd
          }
        }
      } catch {
        // Not JSON (or not an object): not this record's job to carry cwd.
      }
    }
    if (nl === -1) return null
    start = nl + 1
  }
}

// ---- the Codex scan (task 11, spec 012 §8) ----------------------------------
//
// Codex has no memory files, so unlike scanClaudeCode there is no
// slug-directory grouping and no need to preserve a resolved name for a
// memory attachment that never exists here: an entry with no listed session
// simply never appears. A rollout whose cwd cannot be resolved at all is
// grouped under its own session id -- scanClaudeCode's "no cwd -> its own
// bucket" rule (spec 011 §8), with the session id standing in for the slug
// a Codex rollout has no directory of its own to be grouped by.
export function scanCodex(codexDir: string, stateDir: string, opts: ScanOptions): ProjectEntry[] {
  const sessionsDir = join(codexDir, 'sessions')
  const entries = new Map<string, ProjectEntry>()

  for (const path of listRolloutFiles(sessionsDir)) {
    const file = basename(path)
    const sessionId = parseCodexSessionId(file)
    if (sessionId === null) {
      console.error(`capture enable: skipping ${path} -- file name does not match rollout-<timestamp>-<id>.jsonl`)
      continue
    }

    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      continue // disappeared between the walk and stat; nothing to report
    }

    const scanned = scanTranscript(path, stat.mtimeMs, stat.size, sessionId, stateDir, opts, PROFILES.codex.formatDelta, findCodexCwd)
    if (scanned === null || !scanned.listed) continue // outside the window, still live, or already fully captured

    const project = scanned.cwd !== null ? resolveProject(scanned.cwd) : null
    const key = project !== null ? `name:${project}` : `session:${sessionId}`

    const session: SessionEntry = {
      sessionId,
      path,
      project,
      cwd: scanned.cwd,
      from: scanned.from,
      spans: scanned.spans,
      dialogueBytes: scanned.dialogueBytes,
      pieces: scanned.pieces,
      mtimeMs: stat.mtimeMs,
      harness: 'codex',
    }

    let entry = entries.get(key)
    if (!entry) {
      entry = {
        name: project,
        cwd: scanned.cwd,
        slug: `codex:${project ?? sessionId}`,
        sessions: [],
        memoryFiles: [],
        dialogueBytes: 0,
        harness: 'codex',
      }
      entries.set(key, entry)
    }
    entry.sessions.push(session)
    entry.dialogueBytes += scanned.dialogueBytes
  }

  return [...entries.values()].sort(compareProjectEntries)
}

// ---- both harnesses, one scan (task 11, spec 012 §8) ------------------------
//
// `null` means "this harness is not on this machine" -- capture.ts's
// enable() passes deps.claudeDir only when it exists, and
// dirname(deps.codexConfigPath) only when ~/.codex/config.toml exists.
// Concatenated and re-sorted together (not Claude Code's list with Codex's
// appended): compareProjectEntries is the exact ordering scanClaudeCode
// already used, so a Codex project with more dialogue than every Claude
// Code project still sorts above them. userClaudeMd is Claude Code's alone
// -- Codex has no equivalent (spec 012 §8).
export function scanAll(
  claudeDir: string | null,
  codexDir: string | null,
  cursorDir: string | null,
  hermesDir: string | null,
  stateDir: string,
  opts: ScanOptions,
  // Last and optional (031 task 3) so every existing caller keeps its shape.
  wakuDir: string | null = null,
  // spec 073 D10, after wakuDir for the same reason.
  geminiDir: string | null = null,
  windsurfDir: string | null = null,
): Scan {
  const harnesses: AuthoredHarness[] = []
  if (claudeDir !== null) harnesses.push('claude_code')
  if (codexDir !== null) harnesses.push('codex')
  // Cursor is a harness the scan covers for its authored skills only -- it has
  // no sessions or memory files here, so it adds nothing to `projects`.
  if (cursorDir !== null) harnesses.push('cursor')
  // Hermes (031) contributes authored docs AND skills, but no sessions.
  if (hermesDir !== null) harnesses.push('hermes')
  // The Waku agent (031 task 3): fact files and skills, no sessions.
  if (wakuDir !== null) harnesses.push('waku')
  // spec 073 D10: one memory file each, no sessions, no skills.
  if (geminiDir !== null) harnesses.push('gemini')
  if (windsurfDir !== null) harnesses.push('windsurf')

  const claudeCode: Scan =
    claudeDir !== null
      ? scanClaudeCode(claudeDir, stateDir, opts)
      : { projects: [], userClaudeMd: null, skills: [], harnesses: [] }
  const codexProjects = codexDir !== null ? scanCodex(codexDir, stateDir, opts) : []
  const hermes = hermesDir !== null ? scanHermes(hermesDir) : { projects: [], skills: [] }
  const waku = wakuDir !== null ? scanWaku(wakuDir) : { projects: [], skills: [] }
  addClaudeLocalMd(claudeCode.projects)
  const projects = [
    ...claudeCode.projects,
    ...codexProjects,
    ...(codexDir !== null ? scanCodexMemories(codexDir) : []),
    ...hermes.projects,
    ...waku.projects,
    ...(geminiDir !== null ? scanGemini(geminiDir) : []),
    ...(windsurfDir !== null ? scanWindsurf(windsurfDir) : []),
  ].sort(compareProjectEntries)
  // Authored skills from every harness that keeps them: Claude Code and Codex
  // under `skills/`, Cursor under `skills-cursor/`, Hermes under `skills/` too.
  // All are `procedure` memories the worker stores whole (spec 026); the harness
  // on each SkillEntry is what its `skill:<harness>/<name>` source carries.
  const skills: SkillEntry[] = [
    ...claudeCode.skills,
    ...(codexDir !== null ? scanSkills(codexDir, 'codex') : []),
    ...(cursorDir !== null ? scanSkills(cursorDir, 'cursor', 'skills-cursor') : []),
    ...hermes.skills,
    ...waku.skills,
  ]
  return { projects, userClaudeMd: claudeCode.userClaudeMd, skills, harnesses }
}

// ---- rendering the one list (spec 011 §8) ----------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// task 11: labels a Codex project "(Codex)" from the entry's own `harness`
// field -- never by string-matching the `codex:` slug prefix, so a future
// third harness only has to set its own `harness` correctly to get its own
// label here (see renderBootstrapList's own comment, spec 012 §8).
function displayLabel(entry: ProjectEntry): string {
  const label = entry.name ?? entry.slug
  return entry.harness === 'codex' ? `${label} (Codex)` : label
}

// The label for an entry with no listed sessions: its resolved name alone
// when it has one -- every in-window session is already fully captured,
// but it still has memory files (task 12 review) -- or its slug marked
// "(memory only)" when it has no resolved name at all. "0 sessions" is
// never shown for either shape.
function noSessionsLabel(entry: ProjectEntry): string {
  return entry.name ?? `${entry.slug} (memory only)`
}

function renderSessionRow(entry: ProjectEntry, label: string): string {
  let stats = `${plural(entry.sessions.length, 'session')}, ${formatSize(entry.dialogueBytes)} of dialogue`
  if (entry.memoryFiles.length > 0) stats += `, ${plural(entry.memoryFiles.length, 'memory file')}`
  return `${label}   ${stats}`
}

function renderNoSessionsRow(entry: ProjectEntry, label: string): string {
  return `${label}   ${plural(entry.memoryFiles.length, 'memory file')}`
}

// Build a display name for the harnesses the scan covered. An empty list
// means neither harness was configured on this machine: renders as
// "Nothing to import on this machine." (no harness phrase).
const HARNESS_LABEL: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  hermes: 'Hermes',
  waku: 'Waku',
  gemini: 'Gemini CLI',
  windsurf: 'Windsurf',
}

function harnessPhrase(harnesses: AuthoredHarness[]): string {
  const labels = harnesses.map((h) => HARNESS_LABEL[h] ?? h)
  if (labels.length === 0) return ''
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

export function renderBootstrapList(scan: Scan, windowDays: number | null): string {
  const { projects, userClaudeMd, harnesses } = scan
  const skills = scan.skills ?? [] // ?? [] for a Scan built before this field (the .mjs tests)
  const phrase = harnessPhrase(harnesses)
  if (projects.length === 0 && userClaudeMd === null && skills.length === 0) {
    return phrase === '' ? 'Nothing to import on this machine.' : `Nothing from ${phrase} to import on this machine.`
  }

  const numbered = projects.map((entry, i) => ({ entry, n: i + 1 }))
  const withSessions = numbered.filter((r) => r.entry.sessions.length > 0)
  const noSessions = numbered.filter((r) => r.entry.sessions.length === 0)
  // Two independent alignment columns, not one shared across the whole
  // list: a long memory-only slug (the D--Code-... shape spec 011 §8 shows)
  // would otherwise push every session row's stats out just to line up
  // with it.
  const sessionLabelWidth = withSessions.reduce((w, r) => Math.max(w, displayLabel(r.entry).length), 0)
  const noSessionsLabelWidth = noSessions.reduce((w, r) => Math.max(w, noSessionsLabel(r.entry).length), 0)
  // Fixed at 2 extra columns beyond the widest index, so "1." through
  // "99." (the common case) right-justify with room to spare; a fourth
  // slug's worth of digits just narrows that margin rather than breaking.
  const numWidth = String(projects.length).length + 2

  const lines: string[] = []
  const windowPhrase = windowDays === null ? 'all transcripts' : `last ${windowDays} days`
  lines.push(`Found memory and history from ${phrase} on this machine (${windowPhrase}):`)

  for (const { entry, n } of numbered) {
    const prefix = String(n).padStart(numWidth) + '. '
    lines.push(
      entry.sessions.length > 0
        ? prefix + renderSessionRow(entry, displayLabel(entry).padEnd(sessionLabelWidth))
        : prefix + renderNoSessionsRow(entry, noSessionsLabel(entry).padEnd(noSessionsLabelWidth)),
    )
  }

  const plusPrefix = '+'.padStart(numWidth) + ' '
  lines.push(
    userClaudeMd === null
      ? `${plusPrefix}~/.claude/CLAUDE.md (empty, skipped)`
      : `${plusPrefix}~/.claude/CLAUDE.md (${formatSize(Buffer.byteLength(userClaudeMd.content, 'utf8'))})`,
  )

  // Authored skills, one summary line (spec 026). Only when there are any, so
  // a machine with no skills reads exactly as it did before this landed. Skills
  // come from any harness now (031: Claude Code, Codex, Cursor, Hermes), so the
  // line names each with its count instead of the one hardcoded `~/.claude/skills`
  // path — which said "Claude Code" for a Cursor or Hermes skill.
  if (skills.length > 0) {
    const byHarness = new Map<AuthoredHarness, number>()
    for (const s of skills) byHarness.set(s.harness, (byHarness.get(s.harness) ?? 0) + 1)
    const label = (h: AuthoredHarness) => HARNESS_LABEL[h] ?? h
    const parts = [...byHarness.entries()]
      .sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0])))
      .map(([h, n]) => `${n} ${label(h)}`)
    lines.push(`${plusPrefix}${plural(skills.length, 'skill')} (${parts.join(', ')})`)
  }

  // --all resends every listed session from byte 0 regardless of what the
  // live hook already captured -- the only way to recover a span a 0.1.x
  // hook dropped without leaving a marker (spec 011 §8) -- so anything the
  // live hook already sent is extracted a second time. Said once, here,
  // rather than discovered later as duplicate facts.
  if (windowDays === null) {
    lines.push('Sessions captured live will be extracted a second time.')
  }

  // Names no processor, like every other product string -- see capture.ts's
  // comment on DISCLOSURE. www.waku.one/privacy is the one list, and this
  // screen is reachable without ever seeing DISCLOSURE (`waku-memory
  // import` runs on its own), so the pointer has to be here too.
  lines.push('Everything listed is sent to our servers and on to the AI providers that turn it into memories and make them searchable.')
  lines.push('www.waku.one/privacy names them. This is an alpha whose data can be lost.')
  lines.push('Enter imports all of it; type numbers to leave projects out (e.g. 1 3); n skips.')

  return lines.join('\n')
}

// ---- parsing the one answer -------------------------------------------------

export type BootstrapAnswer =
  | { kind: 'all' }
  | { kind: 'skip' }
  | { kind: 'exclude'; numbers: number[] }
  | { kind: 'invalid' }

// Enter (blank) imports everything; n/N skips everything; a whitespace-
// separated list of integers, each within 1..count, leaves those projects
// out; anything else is invalid, and the caller (capture.ts's
// askBootstrapSelection, task 13) re-asks once before treating a second
// invalid answer as skip.
export function parseBootstrapAnswer(answer: string, count: number): BootstrapAnswer {
  const trimmed = answer.trim()
  if (trimmed === '') return { kind: 'all' }
  if (trimmed === 'n' || trimmed === 'N') return { kind: 'skip' }

  const numbers: number[] = []
  for (const token of trimmed.split(/\s+/)) {
    if (!/^\d+$/.test(token)) return { kind: 'invalid' }
    const n = Number.parseInt(token, 10)
    if (n < 1 || n > count) return { kind: 'invalid' }
    numbers.push(n)
  }
  const unique = [...new Set(numbers)].sort((a, b) => a - b)
  return { kind: 'exclude', numbers: unique }
}

// ---- sending the bootstrap (spec 011 §8, task 13) --------------------------
//
// A BootstrapAnswer (above) still has an `invalid` case for the caller's own
// re-ask loop; by the time enable() calls runBootstrap, that has already
// resolved to one of the three real outcomes below.
export type BootstrapSelection = { kind: 'all' } | { kind: 'skip' } | { kind: 'exclude'; numbers: number[] }

export type BootstrapDeps = {
  url: string // the ingest base (config.json's url) -- endpointUrl below strips a trailing slash the same way hook.ts's does
  key: string
  fetchImpl: typeof fetch
  stateDir: string // <configDir>/state -- where watermark and .dropped files live, same as hook.ts
  all: boolean // --all: every session sent from byte 0, watermarks and markers alike ignored, per §8's --all paragraph
  // How long any one backfill request may wait on the network before giving
  // up. Defaults to BACKFILL_TIMEOUT_MS; only bootstrap.test.mjs overrides
  // it, so the bound can be proven without waiting out the real one --
  // mirrors hook.ts's sessionEndTimeoutMs/briefTimeoutMs, same reasoning.
  backfillTimeoutMs?: number
}

export type BootstrapResult = {
  memoryFiles: number
  skills: number
  sessions: number
  pieces: number
  failed: number
}

// ImportRequest's bound (spec 011 §8): a project's memory files are sent in
// requests of at most this many files each, since `project` is one value
// per request and files from two different projects can never share one.
const MAX_IMPORT_FILES = 50

// The ingest cap (spec 011 §8's "Memory files" paragraph): a memory file (or
// the user's CLAUDE.md) over this is skipped and counted as failed, never
// sent -- POST /imports would 413 on it anyway, and this saves the request.
const MAX_IMPORT_FILE_BYTES = 256 * 1024

// ImportFile.source's bound (spec 011 §8). Cutting from the *left* of the
// label -- never the `/<file>` suffix -- is what keeps the file name legible
// in the imports list even when the project name or slug alone would have
// overflowed it.
const MAX_SOURCE_LENGTH = 200

// The `<harness>-memory:` prefix a memory doc's source carries (spec 011 §8,
// widened by 031). Claude Code keeps its original `claude-code-memory:` — the
// name the worker and the 026 cleanup already know, and back-compat for a
// 0.8.x shim's sources; every other harness names itself so its docs attribute
// to it and not to Claude Code. The worker's `harness_for` reads this back.
export function memoryPrefix(harness: AuthoredHarness): string {
  return harness === 'claude_code' ? 'claude-code-memory:' : `${harness}-memory:`
}

// '<harness>-memory:<name-or-slug>/<file>' (spec 011 §8). `name` is the project
// a transcript under this slug resolved, or null for a memory-only slug
// (renderBootstrapList's "(memory only)" row) -- the same value the scan
// attaches to the ProjectEntry, never decoded from the slug itself (§8 explains
// why: a hyphenated slug is ambiguous). A label so long the source would exceed
// 200 characters is cut from its own left end until it fits, so the prefix and
// the file always survive.
export function memoryFileSource(
  harness: AuthoredHarness,
  name: string | null,
  slug: string,
  file: string,
): string {
  const label = name ?? slug
  const prefix = memoryPrefix(harness)
  const suffix = `/${file}`
  const overflow = prefix.length + label.length + suffix.length - MAX_SOURCE_LENGTH
  const trimmedLabel = overflow > 0 ? label.slice(overflow) : label
  return prefix + trimmedLabel + suffix
}

// Mirrors hook.ts's endpointUrl/postJson exactly (the brief: hook.ts's own
// postJson is private, so this file writes its own small `post` with "the
// same shape"). Kept local rather than exported from hook.ts so the two
// senders -- the live hook and this one-shot backfill -- stay independent:
// neither one's change can silently move the other's request shape.
function endpointUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path
}

// final review M2: a black-holed connection (a dead proxy -- this machine
// runs Clash on 127.0.0.1:7897) otherwise hangs `capture enable` forever at
// the counts line, since Node's fetch has no default timeout of its own.
// 30 s per request, not per run: sendSession below awaits one piece at a
// time, so a many-piece backfill is meant to take a while, and this only
// has to bound each individual request the way hook.ts's postJson callers
// already bound theirs (postBrief, postDelta's per-piece controller).
export const BACKFILL_TIMEOUT_MS = 30_000

async function post(deps: BootstrapDeps, path: string, body: unknown): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.backfillTimeoutMs ?? BACKFILL_TIMEOUT_MS)
  try {
    return await deps.fetchImpl(endpointUrl(deps.url, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

// true on a 2xx response, false on any other status or a thrown fetch --
// the one shape every /imports request below needs, since a memory file
// (unlike a session's pieces) never distinguishes 413 from any other
// failure: an oversized file is filtered out before this is ever called, so
// a 413 here would mean the door disagrees with MAX_IMPORT_FILE_BYTES, and
// that is exactly as fatal to this batch as a 500 would be.
async function postOk(deps: BootstrapDeps, path: string, body: unknown): Promise<boolean> {
  try {
    const res = await post(deps, path, body)
    return res.ok
  } catch {
    return false
  }
}

// One project's memory files, batched at MAX_IMPORT_FILES, plus the user's
// CLAUDE.md (its own request, no project) when the scan found one -- spec
// 011 §8's "Memory files" paragraph, in full. `projects` is already the
// selection-filtered list (runBootstrap below); this function does not
// know about `exclude` or `skip` at all. Returns files sent in a 2xx
// request (`sent`) and files that were never sent -- oversized, or sent in
// a request that did not answer 2xx (`failed`) -- one count per file either
// way, matching how runBootstrap tallies sessions.
async function sendMemoryFiles(
  projects: ProjectEntry[],
  userClaudeMd: Scan['userClaudeMd'],
  deps: BootstrapDeps,
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0

  for (const entry of projects) {
    if (entry.memoryFiles.length === 0) continue

    const items: { source: string; content: string }[] = []
    for (const file of entry.memoryFiles) {
      let content: string
      try {
        content = readFileSync(file, 'utf8')
      } catch {
        failed++ // disappeared between the scan and the send -- never sent, same as oversized
        continue
      }
      if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_FILE_BYTES) {
        failed++
        continue
      }
      items.push({
        source: memoryFileSource(entry.harness, entry.name, entry.slug, basename(file)),
        content,
      })
    }

    for (let i = 0; i < items.length; i += MAX_IMPORT_FILES) {
      const batch = items.slice(i, i + MAX_IMPORT_FILES)
      const body: Record<string, unknown> = { session_id: MEMORY_SESSION_ID, files: batch }
      if (entry.name !== null) body.project = entry.name
      if (entry.cwd) Object.assign(body, locationOf(entry.cwd))
      if (await postOk(deps, '/imports', body)) sent += batch.length
      else failed += batch.length
    }
  }

  if (userClaudeMd !== null) {
    if (Buffer.byteLength(userClaudeMd.content, 'utf8') > MAX_IMPORT_FILE_BYTES) {
      failed++
    } else {
      const body = {
        session_id: MEMORY_SESSION_ID,
        files: [{ source: 'claude-code-user:CLAUDE.md', content: userClaudeMd.content }],
      }
      if (await postOk(deps, '/imports', body)) sent++
      else failed++
    }
  }

  return { sent, failed }
}

// Authored SKILL.md files, each sent whole to /imports with a `skill:` source
// (spec 026), so the worker stores one procedural memory and never extracts.
// Skills are user-level, not per-project -- like the user CLAUDE.md -- so no
// `project` is sent. Batched at MAX_IMPORT_FILES; reuses MEMORY_SESSION_ID, so
// re-import is idempotent per file on the (user, session_id, content_hash)
// inbox key. Returns sent/failed per file, matching sendMemoryFiles.
async function sendSkills(
  skills: SkillEntry[],
  deps: BootstrapDeps,
): Promise<{ sent: number; failed: number }> {
  let sent = 0
  let failed = 0

  const items: { source: string; content: string }[] = []
  for (const skill of skills) {
    let content: string
    try {
      content = readFileSync(skill.path, 'utf8')
    } catch {
      failed++ // disappeared between scan and send -- never sent, same as oversized
      continue
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_FILE_BYTES) {
      failed++
      continue
    }
    items.push({ source: skillSource(skill.harness, skill.name), content })
  }

  for (let i = 0; i < items.length; i += MAX_IMPORT_FILES) {
    const batch = items.slice(i, i + MAX_IMPORT_FILES)
    if (await postOk(deps, '/imports', { session_id: MEMORY_SESSION_ID, files: batch })) {
      sent += batch.length
    } else {
      failed += batch.length
    }
  }

  return { sent, failed }
}

// task 11 (spec 012 §8): harness and content_format both come off the
// session's own `harness` field via PROFILES (harnesses.ts, task 8) -- the
// profile is the only place that knows the harness, so a session never
// carries anything but its own harness's wire shape regardless of which
// scanner (scanClaudeCode or scanCodex) produced it.
function sessionBody(session: SessionEntry, content: string): Record<string, unknown> {
  return {
    harness: session.harness,
    session_id: session.sessionId,
    source: 'backfill',
    content,
    content_format: PROFILES[session.harness].contentFormat,
    ...(session.project !== null ? { project: session.project } : {}),
    ...(session.cwd ? locationOf(session.cwd) : {}),
  }
}

// One session, spec 011 §8's "Which sessions"/"Transcripts"/watermark
// paragraphs: the tail first (from `from`, or from byte 0 under --all,
// through the end of the file -- watermark writes, the same rule the live
// hook applies), then every span in order (never a watermark write). Any
// non-2xx other than 413, or a thrown fetch, stops the whole session right
// there -- no more pieces, no more spans, the watermark stays at whatever
// the last piece left it. The marker on disk is left exactly as it stands
// at that moment: whatever it held when this run started, plus any
// tail-413 lines this run has already committed to it (see below) --
// never rewritten, never erased (task 13 re-review, R13). That can
// over-list a span this run would otherwise have cleared (a later
// `enable` just re-sends it, at the cost of duplicate facts), but it can
// never lose a hole -- which matters because this session's true state
// past the failure point is otherwise unknown.
//
// A 413 -- on a tail piece or a span's piece -- never stops the session,
// unlike any other failure: it means this one piece can never succeed
// (§3), not that the connection or the server is failing, so the loop
// counts it and moves on to the next piece. A tail 413 commits its
// absolute byte range, `${previousEnd}-${pieceEnd}`, to the marker file
// the moment it happens -- `mkdirSync` + `appendFileSync`, the same
// durability the live hook's own 413 branch uses (hook.ts's postDelta) --
// *before* the watermark advances past it, and is also pushed onto
// `holeLines` for the end-of-run rewrite further down. Committing only to
// `holeLines` and writing the marker solely at that end-of-run rewrite was
// the bug the re-review found (R13): a later fatal failure or thrown fetch
// elsewhere in the same run sets `stopped`, which skips the rewrite
// entirely and used to discard the hole silently even though the
// watermark had already advanced past it. A span 413, by contrast, only
// ever touches `holeLines` -- keeping that whole span's *original*
// `start-end` (not a piece-level range: a span can itself be several
// pieces, and the ones that did succeed are still a hole until the whole
// span is clean) -- because the marker already holds that span's line
// from a previous run, so leaving it untouched until the rewrite is
// correct whether this run stops or completes; the span's own remaining
// pieces are still attempted regardless, since a partially-sent span is no
// better tracked than a wholly-unsent one.
//
// `holeLines` collects this run's tail-413 lines (already durable on disk,
// per above) and every failed span's original line, in order, but is only
// turned into a marker *rewrite* once, at the very end, and only when
// nothing stopped the session early: empty means unlink the marker (every
// tail piece and every span this run attempted came back 2xx, so a stale
// marker on disk is now wrong); non-empty means overwrite it with exactly
// those lines -- replacing both the pre-run span lines and this run's own
// provisional tail-413 appends with one final, correct account -- so a
// later `enable` resends precisely what is still missing and nothing this
// run already covered. That full-replace rule is what makes a --all run
// correct despite `session.spans` always being `[]` there (the scan clears
// it under --all, spec 011 §8's --all paragraph): a clean full resend from
// byte 0 clears a stale marker the same as any other session when it
// completes, and a 413 during that resend leaves the marker holding only
// *this run's* hole, not the old one the from-0 send already covered --
// while a --all run that gets stopped instead leaves the pre-existing
// marker plus this run's own appended tail lines in place, same as any
// other stopped session.
async function sendSession(session: SessionEntry, deps: BootstrapDeps): Promise<{ ok: boolean; pieces: number }> {
  const watermarkPath = join(deps.stateDir, session.sessionId)
  const markerPath = droppedMarkerPath(watermarkPath)

  let buf: Buffer
  try {
    buf = readFileSync(session.path)
  } catch {
    return { ok: false, pieces: 0 } // the transcript disappeared between the scan and the send
  }

  let piecesSent = 0
  let ok = true
  let stopped = false
  // Every hole this run knows about, as marker-line text (`start-end`, no
  // trailing newline yet) -- see the function comment for how it is built
  // and why it replaces rather than amends whatever the marker held before.
  const holeLines: string[] = []

  // task 11: this session's own harness picks the formatter -- never
  // dialogue.ts's formatDelta unconditionally, so a Codex session's pieces
  // are cut with formatCodexDelta instead.
  const formatDeltaFn = PROFILES[session.harness].formatDelta

  // ---- the tail: from `from` (or 0 under --all) to the end of the file ----
  const from = deps.all ? 0 : Math.min(Math.max(session.from, 0), buf.length)
  const tail = formatDeltaFn(buf.subarray(from))
  let previousEnd = from
  for (const piece of tail.pieces) {
    let res: Response
    try {
      res = await post(deps, '/ingest/session', sessionBody(session, piece.text))
    } catch {
      ok = false
      stopped = true
      break
    }
    if (res.status === 413) {
      // spec 011 §3/§8, task 13 re-review (R13): commit the hole to the
      // marker file the moment it happens -- mkdirSync + appendFileSync,
      // the same durability the live hook's own 413 branch uses (hook.ts's
      // postDelta) -- *before* advancing the watermark past it. Keeping
      // this only in `holeLines` until the end-of-run rewrite further down
      // was the bug the re-review found: a later fatal failure or thrown
      // fetch elsewhere in this same run sets `stopped`, which skips that
      // rewrite entirely (see below) and would silently discard this hole
      // even though the watermark has already moved past it. `holeLines`
      // still gets the line too, so a run that finishes clean folds it into
      // that single end-of-run rewrite rather than leaving this immediate
      // append as the marker's last word.
      const line = `${previousEnd}-${from + piece.end}`
      mkdirSync(dirname(markerPath), { recursive: true })
      appendFileSync(markerPath, `${line}\n`)
      holeLines.push(line)
      ok = false
      writeWatermark(watermarkPath, from + piece.end)
      previousEnd = from + piece.end
      continue
    }
    if (!res.ok) {
      ok = false
      stopped = true
      break
    }
    writeWatermark(watermarkPath, from + piece.end)
    previousEnd = from + piece.end
    piecesSent++
  }

  if (!stopped) {
    // formatDelta's own contract (spec 011 §2/§3, mirrored from hook.ts's
    // postDelta): consume to the formatter's overall end even when that is
    // past the last piece actually sent, so a trailing run of
    // bookkeeping-only lines is never re-read on the next enable.
    const absoluteEnd = from + tail.end
    if (tail.pieces.length === 0 || absoluteEnd > previousEnd) writeWatermark(watermarkPath, absoluteEnd)

    // ---- the spans: never a watermark write -----------------------------
    for (const span of session.spans) {
      const start = Math.min(Math.max(span.start, 0), buf.length)
      const end = Math.min(Math.max(span.end, start), buf.length)
      const spanDelta = formatDeltaFn(buf.subarray(start, end))
      let spanOk = true
      for (const piece of spanDelta.pieces) {
        let res: Response
        try {
          res = await post(deps, '/ingest/session', sessionBody(session, piece.text))
        } catch {
          ok = false
          stopped = true
          break
        }
        if (res.status === 413) {
          ok = false
          spanOk = false
          continue
        }
        if (!res.ok) {
          ok = false
          stopped = true
          break
        }
        piecesSent++
      }
      if (stopped) break
      // The span's original range, not a piece-level one -- see the
      // function comment: a partially-sent span is still, as a whole, a
      // hole to record.
      if (!spanOk) holeLines.push(`${span.start}-${span.end}`)
    }

    if (!stopped) {
      if (holeLines.length === 0) {
        try {
          unlinkSync(markerPath)
        } catch {
          // No marker to remove -- the common case (most sessions never 413).
        }
      } else {
        mkdirSync(dirname(watermarkPath), { recursive: true }) // mirrors hook.ts's own 413 branch
        writeFileSync(markerPath, holeLines.map((line) => `${line}\n`).join(''))
      }
    }
  }

  return { ok, pieces: piecesSent }
}

// The whole selection, spec 011 §8's "Order" paragraph: memory files first
// (projects in scan.projects order), then transcripts newest first across
// every selected project, all enqueued and none awaited for extraction.
// `skip` sends nothing and returns zeros before touching the network at
// all; `exclude` drops the numbered projects (1-based, scan.projects order)
// from both the memory-file pass and the session pass; `all` sends
// everything the scan found. Nothing here decides *what* enable() prints --
// see capture.ts, which turns this result into the one counts line.
export async function runBootstrap(
  scan: Scan,
  selection: BootstrapSelection,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  if (selection.kind === 'skip') return { memoryFiles: 0, skills: 0, sessions: 0, pieces: 0, failed: 0 }

  const excluded = selection.kind === 'exclude' ? new Set(selection.numbers) : null
  const projects = excluded === null ? scan.projects : scan.projects.filter((_, i) => !excluded.has(i + 1))

  const { sent: memoryFiles, failed: memoryFailed } = await sendMemoryFiles(projects, scan.userClaudeMd, deps)
  // Skills are user-level, not per-project, so `exclude` (which drops numbered
  // projects) never drops a skill -- the whole authored set goes on every run
  // that is not `skip`, the same as the user CLAUDE.md.
  // `?? []` for a Scan built before this field existed (only the .mjs tests do
  // that; scanClaudeCode/scanAll always set it). A real scan with no skills is
  // already [] from scanSkills, so this changes nothing for them.
  const { sent: skills, failed: skillsFailed } = await sendSkills(scan.skills ?? [], deps)

  const sessions = projects.flatMap((p) => p.sessions).sort((a, b) => b.mtimeMs - a.mtimeMs)
  let sessionsOk = 0
  let pieces = 0
  let failed = memoryFailed + skillsFailed
  for (const session of sessions) {
    const result = await sendSession(session, deps)
    pieces += result.pieces
    if (result.ok) sessionsOk++
    else failed++
  }

  return { memoryFiles, skills, sessions: sessionsOk, pieces, failed }
}
