// The `hook` subcommand's decision logic. Wired by cli.ts: run() reads one
// hook event as JSON off stdin (that part deliberately does not live here --
// see the note on handleHookEvent below) and calls handleHookEvent with the
// parsed event and a real deps bag. Everything in this file takes its
// inputs as plain values, so hook.test.mjs can call it directly against temp
// files and an injected fetchImpl, the same way cli.test.mjs drives
// applyToHarness without touching a real ~/.claude.json.
//
// Claude Code and Codex both land here (spec 012 §4): the event shape and
// the stdin fields this file reads were measured identical across the two,
// so this module itself never asks which harness sent an event -- deps
// carries a HarnessId, handleHookEvent resolves it to one HarnessProfile
// (harnesses.ts's PROFILES) up front, and every harness-specific choice
// (content format, delta formatter, timing budgets, how the brief is
// printed) reads off that one value. A third harness is a third profile,
// never a new branch in this file.
//
// This is the one piece of the shim that runs unattended, on every turn, in
// the middle of somebody else's tool -- see task 14's brief for the full
// argument. Two consequences shape every decision below:
//
//   1. It must never throw and never leave a nonzero exit behind. A capture
//      bug must not read to the user as their actual session failing.
//      handleHookEvent wraps its entire body in one try/catch for exactly
//      this reason, and every expected failure (missing config, no new
//      bytes, a non-2xx response, a rejected fetch) returns through its own
//      branch before ever reaching that catch -- the catch is the net under
//      the net, for whatever this file's author did not think of.
//   2. Content goes to the ingest endpoint and nowhere else, with two
//      deliberate exceptions, both of them the server's answer written to
//      stdout, which the harness folds into the session's context.
//      SessionStart's postBrief writes POST /brief's `text` (run through the
//      harness profile's briefOutput -- identity for Claude Code, the hook
//      JSON contract for Codex) -- the entire point of task 9. And since
//      spec 029, UserPromptSubmit's postTurn sends the prompt to
//      POST /ingest/turn and writes the `context` it answers (through
//      profile.promptOutput): the memories that bear on that prompt. The
//      server uses the prompt for that one search and, since spec 041,
//      keeps its first 2,000 characters in the 30-day retrieval trace.
//      stdout carries the brief and the injected memories and nothing else.
//      Every other channel is stderr (console.error), and never carries a
//      transcript byte, a delta, or any other response body -- only counts,
//      status codes, and the event/session names already on stdin. The one
//      further exception is ruling R4 (spec 012 §4.1): the Codex profile
//      stays silent on stderr too when there is no usable credential, since
//      Codex has no interactive onboarding to have warned the user first.
//
// Zero dependencies, per the brief: only node:fs and node:path here (plus
// the sibling dialogue.ts and harnesses.ts modules -- local files, not npm
// packages), plus the global fetch (Node 18+, no import needed) that
// deps.fetchImpl defaults to at the real call site in cli.ts.

import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { type DialogueEntry, type Piece, formatDelta, renderEntries } from './dialogue.ts'
import { type HarnessId, type HarnessProfile, actOutput, profileFor } from './harnesses.ts'
import { locationOf, resolveProject } from './project.ts'
import { briefNoticeFrom, noticeFrom } from './notice.ts'

// SESSION_END_HOOK_TIMEOUT_S/SESSION_END_TIMEOUT_MS are the Claude Code
// profile's numbers (harnesses.ts's PROFILES.claude_code) -- defined there,
// not here, to avoid an import cycle (this file imports profileFor from
// harnesses.ts; harnesses.ts must not import back). Re-exported unchanged so
// capture.ts's existing `import { ... } from './hook.ts'` keeps working. See
// harnesses.ts's own comment on them for the full derivation.
export { SESSION_END_HOOK_TIMEOUT_S, SESSION_END_TIMEOUT_MS } from './harnesses.ts'

export type HookEvent = {
  hook_event_name: string
  session_id: string
  transcript_path?: string
  cwd?: string
  reason?: string
  last_assistant_message?: string // Stop only (hooks reference); spec 011 §2
  prompt?: string // UserPromptSubmit only; spec 029 sends it for injection
  source?: string // SessionStart only: startup, resume, clear, compact (spec 071 D8)
  // PreToolUse only (spec 071 F1): the tool and its input. postAct reads the
  // command's first word and the file path out of tool_input, and nothing else.
  tool_name?: string
  tool_input?: Record<string, unknown>
}

export type HookDeps = {
  configDir: string // default (real deps, built in cli.ts): join(homedir(), '.waku-memory')
  fetchImpl: typeof fetch // default (real deps, built in cli.ts): globalThis.fetch
  // How long a SessionEnd flush may wait on the network before giving up.
  // Defaults to SESSION_END_TIMEOUT_MS; only hook.test.mjs passes it, so
  // the bound can be proven without waiting out the real budget.
  sessionEndTimeoutMs?: number
  // Same idea for SessionStart's POST /brief. Defaults to BRIEF_TIMEOUT_MS;
  // only hook.test.mjs overrides it, so the bound can be proven without
  // waiting out the real one.
  briefTimeoutMs?: number
  // The one channel into the session's context (module comment, rule 2):
  // postBrief writes POST /brief's response text here. Defaults to
  // defaultStdout (the real process.stdout); hook.test.mjs injects a
  // capturing stub instead.
  stdout?: (text: string) => void
  // spec 071 D8 (R4): milliseconds since this hook process started, read
  // when a turn's request finishes. Defaults to process.uptime(); only
  // hook.test.mjs passes it, so the timing it reports is deterministic.
  elapsedMs?: () => number
  // spec 071 F1: PreToolUse's bound. Defaults to ACT_TIMEOUT_MS; only
  // hook.test.mjs overrides it.
  actTimeoutMs?: number
  // Which harness profile (harnesses.ts's PROFILES) this event came from --
  // content format, delta formatter, timing budgets and brief output all
  // follow from this one id. Defaults to 'claude_code', so every existing
  // caller (real cli.ts before task 8, every pre-task-8 test) keeps working
  // unchanged.
  harness?: HarnessId
  // spec 073 D8 (T12): run after the brief at SessionStart, to start a
  // background setup save when a setup file changed. Real: cli.ts's
  // refreshSetupInBackground, which only stats files and spawns; tests leave
  // it out.
  refreshSetup?: () => void
}

// Bumped by hand at release time alongside package.json's "version" -- the
// brief's call: a build-time constant here is fine, and it keeps this file
// free of any fs reach into its own package.json (which would also be
// wrong at runtime, since dist/hook.js does not sit next to package.json
// the way src/hook.ts does). Exported since postBrief's request body and
// hook.test.mjs's drift check (against package.json) both need it; task 14
// (spec 012 §9) bumps this, package.json and the plugin manifest
// (.codex-plugin/plugin.json) to 0.3.0 together.
export const SHIM_VERSION = '0.15.4'

// Exported for capture.ts, which writes the file this module reads.
export const CONFIG_FILE_NAME = 'config.json'

type Config = { url: string; key: string }

// Same-directory temp file + rename, exactly atomicWriteJson's technique in
// cli.ts (see its comment for the full why: rename is only atomic within
// one filesystem, so the temp file has to be a sibling of the real one).
// Not the same function, because this file writes plain decimal text (the
// watermark), not the McpConfig-shaped JSON atomicWriteJson's type signature
// is fixed to -- reusing the pattern rather than reusing the export.
function atomicWriteText(path: string, text: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true }) // first watermark for a session: state/ may not exist yet
  const tmpPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    writeFileSync(tmpPath, text, 'utf8')
    renameSync(tmpPath, path)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // Best-effort cleanup only -- the error below is the one that
      // matters, and a failed cleanup must not hide it.
    }
    throw err
  }
}

// Reads the byte offset left by a previous run. Missing file (first event
// for this session) or blank/unparseable content are all the same thing to
// the caller: "trust nothing, start from the top" -- never a throw.
//
// The whole trimmed string must be digits: Number.parseInt("1200\x00junk",
// 10) === 1200, not NaN, so a bare parseInt would trust the numeric prefix
// of a partially-corrupted file. A trusted-but-wrong offset that lands past
// the real transcript size makes readDelta report "nothing new" while
// content that was never actually sent sits unsent -- silent data loss, not
// merely an extra resend, which is why this is stricter than it looks.
//
// Falling back to 0 after several prior *successful* sends resends a
// concatenation the server has never hashed before -- content_hash
// (job_repository.py) is a whole-body SHA-256, not overlap-aware, so the
// inbox dedupe does NOT catch this case the way it catches a byte-identical
// retry (see postDelta). That resend is re-enqueued and re-extracted:
// bounded cost (duplicate jobs/facts), not lost or corrupted data. A
// garbled watermark can in practice only come from something other than
// this module's own atomicWriteText writing it (that always writes a clean
// non-negative integer), so this is cheap insurance against a corrupted
// local file, not a path this module's own writes are expected to hit.
// Exported: a later run (spec 011 §8's bootstrap) reads watermarks with
// the hook's own rule rather than re-implementing it.
export function readWatermark(watermarkPath: string): number {
  try {
    const raw = readFileSync(watermarkPath, 'utf8').trim()
    if (!/^\d+$/.test(raw)) return 0
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

// Exported so postDelta (and a later run -- spec 011 §8's bootstrap) can
// advance the watermark the same way after each piece that succeeds: one
// atomic write, never a partial one a crash could leave mid-byte.
export function writeWatermark(watermarkPath: string, offset: number): void {
  atomicWriteText(watermarkPath, String(offset))
}

// spec 011 §3: beside the watermark, not instead of it -- a session that
// drops one span is still capturing everything else, and this file is the
// record of where the holes are.
export function droppedMarkerPath(watermarkPath: string): string {
  return watermarkPath + '.dropped'
}

// Pure read: formats what the file holds past the watermark by the
// cc-dialogue-v1 rule and returns the surviving pieces with absolute byte
// offsets, but writes nothing -- handleHookEvent only persists a piece's
// `end` after the POST built from its `text` actually succeeds (see
// postDelta). null covers two different "nothing to send yet" cases that
// the caller treats the same way: no transcript to read at all (missing or
// unreadable file -- e.g. transcript_path's documented async-write lag,
// research doc §2, means the file may not exist yet on a very short
// session), or bytes past the watermark that do not yet contain one
// complete line (spec 011 §2 -- a read landing inside a write must not
// send half a JSON record; the next event's read starts from the same
// watermark and sees the completed line). A non-null result can still hold
// zero pieces -- every new line was dropped by the formatting rule -- and
// the caller still advances the watermark to `end` in that case, per
// formatDelta's own contract.
export function readDelta(
  transcriptPath: string,
  watermarkPath: string,
  // Which formatting rule to run past the watermark -- dialogue.ts's
  // cc-dialogue-v1 by default (every caller before task 8, and every reader
  // test above, wants exactly that); postDelta below passes the running
  // event's profile.formatDelta instead, so the same watermark/piece
  // machinery serves codex-dialogue-v1 too without a second copy of this
  // function.
  formatDeltaFn: (buf: Buffer, maxPieceBytes?: number) => { pieces: Piece[]; end: number } = formatDelta,
): { pieces: Piece[]; end: number; offset: number } | null {
  let buf: Buffer
  try {
    buf = readFileSync(transcriptPath)
  } catch {
    return null
  }
  const offset = readWatermark(watermarkPath)
  if (offset >= buf.length) return null // nothing new since last watermark (also covers a shrunk/rotated file)
  const { pieces, end } = formatDeltaFn(buf.subarray(offset))
  if (end === 0) return null // the only new bytes are an incomplete trailing line
  return { pieces: pieces.map((p) => ({ ...p, end: offset + p.end })), end: offset + end, offset }
}

// Reads {url, key} from <configDir>/config.json. Anything short of a clean
// {url: string, key: string} object -- the file absent (task 15 has not run
// yet, or this is a harness other than Claude Code with capture never
// enabled), empty, malformed JSON, or missing/empty fields -- is reported
// as "no config" rather than distinguished further: the caller's response
// (log one line, send nothing) is identical either way, and the specific
// reason is exactly the kind of detail that is not worth a second log line
// per conventions.md §8's "every do-nothing branch logs why", not "logs
// why in detail".
function readConfig(configDir: string): Config | null {
  try {
    const raw = readFileSync(join(configDir, CONFIG_FILE_NAME), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const { url, key } = parsed as Record<string, unknown>
    if (typeof url !== 'string' || url === '' || typeof key !== 'string' || key === '') return null
    return { url, key }
  } catch {
    return null
  }
}

// config.url is the bare API origin (e.g. "https://api.example.test"); this
// is the one place that turns it into a full endpoint, so a trailing slash
// in a hand-edited config.json can't produce "https://host//ingest/...".
function endpointUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path
}

// The `detail` of a 4xx from the door, when the body is JSON with one.
// final review, Important 2: the 402 (capture paused) still carries a plain
// string there -- capture.py's own comment says so, and this shim has never
// branched on it, only printed it -- so a string `detail` becomes
// `{ message }`. The 403 (capture off) now carries an object,
// `{code, message}` (ingest.py); when both fields are strings this returns
// them as given, so the caller can tell a capture_off 403 apart from any
// other one instead of guessing from status code alone. Anything else --
// no JSON body at all, a detail that is neither a string nor an object with
// usable fields -- is `{}`, the same "nothing to print or match on" this
// always returned as `undefined`.
async function readDetail(res: Response): Promise<{ message?: string; code?: string }> {
  return res
    .json()
    .then((b: unknown) => {
      const d = b && typeof b === 'object' ? (b as { detail?: unknown }).detail : undefined
      if (typeof d === 'string') return { message: d }
      if (d && typeof d === 'object') {
        const { message, code } = d as { message?: unknown; code?: unknown }
        return {
          ...(typeof message === 'string' ? { message } : {}),
          ...(typeof code === 'string' ? { code } : {}),
        }
      }
      return {}
    })
    .catch(() => ({}))
}

function postJson(
  deps: HookDeps,
  config: Config,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return deps.fetchImpl(endpointUrl(config.url, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify(body),
    signal,
  })
}

// undici wraps every network-level failure as TypeError("fetch failed") and
// puts the reason on `cause` -- a DNS name, a refused connection, our own
// abort, or (2026-09-04) an Authorization header carrying a control
// character. The wrapper alone told an operator nothing. The cause is an
// error class, a code and a sentence, never the request that failed, so
// printing it keeps rule 2 of the module comment.
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  if (!(cause instanceof Error)) return err.message
  const code = (cause as { code?: unknown }).code
  const codePart = typeof code === 'string' ? ` ${code}` : ''
  return `${err.message} (cause: ${cause.name}${codePart}: ${cause.message})`
}

// §6: 0.16 s start-up + one round trip measured 0.6-1.2 s; a black hole
// (server up but never answering) would otherwise hold the session's first
// turn open indefinitely, since nothing before postBrief bounds this wait.
export const BRIEF_TIMEOUT_MS = 3000

// The memories a session opens with (spec 011 §5, §6, A9): posts the
// harness/version/project triple to /brief and writes whatever `text` it
// answers with to stdout, which Claude Code folds straight into the
// session's context. Mirrors postHeartbeat's shape (same config read, same
// do-nothing-and-log branches) but now bounded by an AbortController --
// unlike a heartbeat nobody was waiting on, a hung /brief request sits in
// the middle of the user's SessionStart, so this cannot wait forever.
async function postBrief(event: HookEvent, deps: HookDeps, profile: HarnessProfile): Promise<void> {
  const config = readConfig(deps.configDir)
  if (!config) {
    // Ruling R4 (spec 012 §4.1): Codex-only, quiet without a credential --
    // no stdout, no stderr, no fetch call. Claude Code keeps this line
    // (spec 011 A9: its output is unchanged).
    if (!profile.silentWithoutCredential) {
      console.error(`waku-memory hook: no usable config at ${join(deps.configDir, CONFIG_FILE_NAME)} -- no brief.`)
    }
    return
  }
  if (typeof event.cwd !== 'string' || event.cwd === '') {
    // No project to ask for. A do-nothing branch says why (conventions §8).
    console.error('waku-memory hook: no cwd on this SessionStart event -- no brief.')
    return
  }
  const project = resolveProject(event.cwd)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.briefTimeoutMs ?? BRIEF_TIMEOUT_MS)
  try {
    // POST, not GET: `project` is caller-supplied free text and a query
    // string would put it in every access log (spec 011 §5). session_id
    // travels here too (spec 012 §4) -- every harness, not just Codex.
    const res = await postJson(
      deps,
      config,
      '/brief',
      {
        harness: profile.id, version: SHIM_VERSION, project, session_id: event.session_id, ...locationOf(event.cwd),
        // spec 071 D8: a brief after a compaction starts the session's
        // shown-set again, so the server needs to know which one this is.
        ...(typeof event.source === 'string' && event.source !== '' && event.source.length <= 50
          ? { source: event.source } : {}),
      },
      controller.signal,
    )
    if (!res.ok) {
      console.error(`waku-memory hook: /brief responded ${res.status} -- no brief.`)
      return
    }
    const body = (await res.json()) as { text?: unknown; shown?: unknown; visible?: unknown; memory_ids?: unknown }
    if (typeof body.text === 'string' && body.text !== '') {
      // Identity for Claude Code (plain text); Codex wraps it in the hook
      // JSON contract (spec 012 §4) -- the only place that knows which is
      // profile.briefOutput itself, never a check here.
      (deps.stdout ?? defaultStdout)(profile.briefOutput(body.text, briefNoticeFrom(project, body)))
    } else if (body.text !== '') {
      // A 2xx with missing or non-string text is a failure like any other.
      // An empty string is the server withholding the brief from this
      // session for an experiment (spec 071 G4), so the hook prints nothing.
      console.error('waku-memory hook: /brief responded with no usable text -- no brief.')
    }
  } catch (err) {
    // This catch also handles a 2xx response whose body is not valid JSON.
    console.error(`waku-memory hook: POST /brief failed -- ${errorMessage(err)}.`)
    if (controller.signal.aborted) {
      const timing = readTiming(deps.configDir)
      writeTiming(deps.configDir, { ...timing, timeouts: timing.timeouts + 1 })
    }
  } finally {
    clearTimeout(timer)
  }
}

// spec 071 D8 (R4): how long the previous UserPromptSubmit hook took, start
// of the process to the end of its request, and how many of the shim's
// bounded requests (/brief, /ingest/turn) gave up on BRIEF_TIMEOUT_MS since
// the last report. A hook cannot report on itself before it ends, so the
// numbers ride on the next POST /ingest/turn, and a 2xx clears the count.
// Numbers only, in the config directory; a missing or unreadable file is
// "nothing to report", never a throw.
export const HOOK_TIMING_FILE = 'hook-timing.json'
type HookTiming = { last_ms?: number; timeouts: number }

function readTiming(configDir: string): HookTiming {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, HOOK_TIMING_FILE), 'utf8')) as Record<string, unknown>
    const last = raw.last_ms
    const timeouts = raw.timeouts
    return {
      ...(typeof last === 'number' && Number.isInteger(last) && last >= 0 ? { last_ms: last } : {}),
      timeouts: typeof timeouts === 'number' && Number.isInteger(timeouts) && timeouts >= 0 ? timeouts : 0,
    }
  } catch {
    return { timeouts: 0 }
  }
}

function writeTiming(configDir: string, timing: HookTiming): void {
  try {
    atomicWriteText(join(configDir, HOOK_TIMING_FILE), JSON.stringify(timing))
  } catch {
    // Timing is a measurement, not a function of the hook: losing one is
    // a gap in a chart, never a failed prompt.
  }
}

function elapsedOf(deps: HookDeps): number {
  return Math.max(0, Math.round(deps.elapsedMs ? deps.elapsedMs() : process.uptime() * 1000))
}

// spec 023 §2: the turn just opened, and since spec 029 the memories that bear
// on what was typed. Shaped exactly like postBrief (same config read, same
// do-nothing-and-log branches, same AbortController).
//
// The prompt travels to POST /ingest/turn, which uses it for one injection
// search (spec 029) and keeps its first 2,000 characters in the 30-day
// retrieval trace (spec 041); the marker itself is still ids and a timestamp. The answer's `context`, when there is one, is the second thing
// this module may write to stdout (module comment, rule 2), through the
// profile's promptOutput. A server older than spec 029 answers 204 with no
// body, and that prints nothing.
//
// It is registered synchronously, with a real timeout, rather than async like
// Stop. A marker that lands after the turn's first tool call would stamp that
// call with the previous turn's id, which is the exact mis-attribution this
// whole spec exists to remove -- and an injection that lands after the prompt
// is no use at all. BRIEF_TIMEOUT_MS caps the wait, so the prompt is never
// held open by a server that is up and never answering.
async function postTurn(event: HookEvent, deps: HookDeps, profile: HarnessProfile): Promise<void> {
  const config = readConfig(deps.configDir)
  if (!config) {
    // Ruling R4 (spec 012 §4.1): Codex stays quiet without a credential.
    if (!profile.silentWithoutCredential) {
      console.error(`waku-memory hook: no usable config at ${join(deps.configDir, CONFIG_FILE_NAME)} -- no turn marker.`)
    }
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.briefTimeoutMs ?? BRIEF_TIMEOUT_MS)
  const timing = readTiming(deps.configDir)
  let reported = false
  try {
    const res = await postJson(
      deps,
      config,
      '/ingest/turn',
      {
        harness: profile.id,
        session_id: event.session_id,
        // The server numbers this session's turns; neither harness gives its
        // hook a turn id. Codex's own turn id reaches the same table through
        // the plugin route's session.hook instead.
        ...(event.cwd ? { project: resolveProject(event.cwd), ...locationOf(event.cwd) } : {}),
        ...(typeof event.prompt === 'string' && event.prompt !== '' ? { prompt: event.prompt } : {}),
        ...(timing.last_ms !== undefined ? { hook_ms: timing.last_ms, hook_timeouts: timing.timeouts } : {}),
      },
      controller.signal,
    )
    reported = res.ok
    if (!res.ok) {
      // The prompt proceeds either way: a missing marker costs attribution
      // for one turn, and nothing else.
      console.error(`waku-memory hook: /ingest/turn responded ${res.status} -- no turn marker.`)
      return
    }
    if (res.status === 204) return // a server from before spec 029: a marker, no answer
    const body = (await res.json()) as { context?: unknown } | undefined
    if (body && typeof body.context === 'string' && body.context !== '') {
      (deps.stdout ?? defaultStdout)(profile.promptOutput(body.context, noticeFrom(body.context)))
    }
  } catch (err) {
    // Also a 2xx whose body is not JSON: the prompt proceeds with nothing added.
    console.error(`waku-memory hook: POST /ingest/turn failed -- ${errorMessage(err)}.`)
  } finally {
    clearTimeout(timer)
    // This hook's own time, for the next turn to report. A 2xx carried the
    // count, so it starts again; a timeout adds to whatever is still unsent.
    const unsent = reported && timing.last_ms !== undefined ? 0 : timing.timeouts
    writeTiming(deps.configDir, {
      last_ms: elapsedOf(deps),
      timeouts: unsent + (controller.signal.aborted ? 1 : 0),
    })
  }
}

// spec 071 F1: the act channel. A tool call waits for this hook, so its
// request gives up sooner than the brief's: a slow server costs each step at
// most this long, and the step then runs with nothing added.
export const ACT_TIMEOUT_MS = 1500

// The command's first word, without its directory, or undefined. The rest
// of the command never leaves this machine.
export function firstWord(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined
  const word = command.trim().split(/\s+/)[0] ?? ''
  const name = word.slice(word.replace(/\\/g, '/').lastIndexOf('/') + 1)
  return name === '' ? undefined : name
}

// What a tool is about to change: Edit, Write and MultiEdit name it
// `file_path`, NotebookEdit `notebook_path`.
function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  const path = input?.file_path ?? input?.notebook_path
  return typeof path === 'string' && path !== '' ? path : undefined
}

// spec 071 F1: the rules and how-tos saved for the step the agent is about
// to take. Only "npx waku-memory act on" registers this hook, and the
// server answers only for a person whose act channel is on. The request
// carries the tool's name, the command's first word and the file path; the
// answer's `context` is the third thing this module may write to stdout
// (module comment, rule 2), as the hook JSON both harnesses read for
// PreToolUse. Quiet on stderr unless a request fails: this runs before
// every tool call.
async function postAct(event: HookEvent, deps: HookDeps, profile: HarnessProfile): Promise<void> {
  const config = readConfig(deps.configDir)
  if (!config || typeof event.tool_name !== 'string' || event.tool_name === '') return
  const word = firstWord(event.tool_input?.command)
  const filePath = filePathOf(event.tool_input)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.actTimeoutMs ?? ACT_TIMEOUT_MS)
  try {
    const res = await postJson(
      deps,
      config,
      '/ingest/act',
      {
        harness: profile.id,
        session_id: event.session_id,
        tool_name: event.tool_name,
        ...(word ? { word } : {}),
        ...(filePath ? { file_path: filePath } : {}),
        ...(event.cwd ? { project: resolveProject(event.cwd), ...locationOf(event.cwd) } : {}),
      },
      controller.signal,
    )
    if (!res.ok) {
      console.error(`waku-memory hook: /ingest/act responded ${res.status} -- nothing added to this step.`)
      return
    }
    const body = (await res.json()) as { context?: unknown; notice?: unknown } | undefined
    if (body && typeof body.context === 'string' && body.context !== '') {
      const notice = typeof body.notice === 'string' && body.notice !== '' ? body.notice : undefined
      ;(deps.stdout ?? defaultStdout)(actOutput(body.context, notice))
    }
  } catch (err) {
    console.error(`waku-memory hook: POST /ingest/act failed -- ${errorMessage(err)}.`)
  } finally {
    clearTimeout(timer)
  }
}

const defaultStdout = (text: string): void => {
  process.stdout.write(text + '\n')
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

// spec 011 §2: the text of every assistant: entry after the last user:
// entry, joined by one space -- what "Claude's final response" (the hooks
// reference's own words for last_assistant_message) means at record
// granularity. assistant used tool: entries (role 'tool') are names, not
// text, and are skipped rather than treated as a boundary. Scoping to the
// trailing run, instead of searching the whole delta, is deliberate: a
// short reply like "Done." that also occurred several turns earlier must
// not be mistaken for the current turn's reply just because the words
// match.
export function trailingAssistantText(entries: DialogueEntry[]): string {
  let lastUser = -1
  entries.forEach((e, i) => {
    if (e.role === 'user') lastUser = i
  })
  return entries
    .slice(lastUser + 1)
    .filter((e) => e.role === 'assistant')
    .map((e) => e.text)
    .join(' ')
}

async function postDelta(
  event: HookEvent,
  deps: HookDeps,
  source: 'stop' | 'session-end',
  profile: HarnessProfile,
): Promise<void> {
  // Config is checked before transcript_path, deliberately: ruling R4 (spec
  // 012 §4.1) says a Codex event with no usable config.json exits quietly
  // regardless of what else about the event is missing or malformed --
  // checking transcript_path first would let that branch's stderr line fire
  // ahead of the credential check and break the "no stderr at all" promise.
  const configPath = join(deps.configDir, CONFIG_FILE_NAME)
  const config = readConfig(deps.configDir)
  if (!config) {
    if (!profile.silentWithoutCredential) {
      console.error(`waku-memory hook: no usable config at ${configPath} -- skipping.`)
    }
    return
  }
  if (!event.transcript_path) {
    console.error(`waku-memory hook: no transcript_path on this ${event.hook_event_name} event -- skipping.`)
    return
  }

  // session_id arrives parsed from stdin and is used as a path segment
  // below -- basename() strips any embedded separators (e.g. "../../x") so
  // a malformed value cannot walk the watermark path outside
  // configDir/state. The same-user trust boundary already limits the blast
  // radius, but this removes the footgun rather than relying on that alone.
  const watermarkPath = join(deps.configDir, 'state', basename(event.session_id))
  let delta = readDelta(event.transcript_path, watermarkPath, profile.formatDelta)

  if (delta === null) {
    // spec 011 §2: the transcript can lag the turn past every complete
    // line it holds. On Stop, a non-empty last_assistant_message is
    // Claude's own record of what it just said (the hooks reference: "use
    // this field rather than reading transcript_path" for exactly this
    // reason) -- when the file has nothing new at all, that reply has not
    // landed in it yet, and this is the only chance to send it before the
    // next event finds it in the file for real and skips it (the
    // trailing-run check below). The piece's `end` is the current
    // watermark: nothing from the file is being consumed, only the
    // out-of-band message.
    if (source === 'stop' && typeof event.last_assistant_message === 'string' && event.last_assistant_message.trim() !== '') {
      const current = readWatermark(watermarkPath)
      const entry: DialogueEntry = { role: 'assistant', text: event.last_assistant_message }
      delta = { pieces: [{ entries: [entry], text: renderEntries([entry]), end: current }], end: current, offset: current }
    } else {
      console.error(`waku-memory hook: nothing new in the transcript for session ${event.session_id} -- skipping.`)
      return
    }
  }

  // spec 011 §2: append last_assistant_message as one more assistant:
  // entry unless the trailing run already reads it, on normalised
  // whitespace -- so a final turn split across two text blocks (joined by
  // the harness with a newline or a blank line) still matches. This runs
  // on the structured entries, never on a piece's already-joined text,
  // because a text can itself contain a blank line and the joined form
  // cannot be split back to find the boundary between records.
  if (source === 'stop' && typeof event.last_assistant_message === 'string' && event.last_assistant_message.trim() !== '') {
    const msg = event.last_assistant_message
    const all = delta.pieces.flatMap((p) => p.entries)
    const present = squash(trailingAssistantText(all)).includes(squash(msg))
    if (!present) {
      const entry: DialogueEntry = { role: 'assistant', text: msg }
      const last = delta.pieces[delta.pieces.length - 1]
      if (last) {
        last.entries.push(entry)
        last.text = renderEntries(last.entries)
      } else {
        delta.pieces.push({ entries: [entry], text: renderEntries([entry]), end: delta.end })
      }
    }
  }

  // Only session-end is bounded -- see harnesses.ts's SESSION_END_TIMEOUT_MS
  // comment. One deadline for the whole flush, not one budget per piece:
  // several pieces each getting the full budget would let a many-piece
  // session run far longer than the budget the installed hook entry
  // actually gives the process. Stop's deadline stays undefined, so every
  // piece's controller below is undefined too -- identical to not passing a
  // signal at all. profile.sessionEndTimeoutMs is Codex's 2000 ms or Claude
  // Code's 5000 ms; deps.sessionEndTimeoutMs (test-only) overrides either.
  const budgetMs = deps.sessionEndTimeoutMs ?? profile.sessionEndTimeoutMs
  const deadline = source === 'session-end' ? Date.now() + budgetMs : undefined

  let previousEnd = delta.offset
  for (const piece of delta.pieces) {
    const controller = deadline !== undefined ? new AbortController() : undefined
    const timer = controller ? setTimeout(() => controller.abort(), Math.max(0, deadline! - Date.now())) : undefined

    let res: Response
    try {
      res = await postJson(
        deps,
        config,
        '/ingest/session',
        {
          harness: profile.id,
          session_id: event.session_id,
          source,
          content: piece.text,
          content_format: profile.contentFormat,
          ...(event.cwd ? { project: resolveProject(event.cwd), ...locationOf(event.cwd) } : {}),
        },
        controller?.signal,
      )
    } catch (err) {
      // Network error, DNS failure, our own SessionEnd timeout firing --
      // all reject rather than resolving with a bad status. The watermark
      // stays at the last piece that succeeded; the ingest inbox's
      // (user_id, session_id, content_hash) dedupe recognizes a retry of
      // byte-identical content as already-seen and no-ops it for free.
      // That guarantee is specific to retrying *this* unchanged piece --
      // see readWatermark's comment for the resend it does NOT cover.
      console.error(`waku-memory hook: POST /ingest/session failed -- ${errorMessage(err)}.`)
      return
    } finally {
      // Must run before any of the res.ok handling below, success or not --
      // an uncleared timer holds the process open for no reason once the
      // request has settled.
      if (timer) clearTimeout(timer)
    }

    if (res.status === 413) {
      // The endpoint has no server-side chunking (MAX_INGEST_CONTENT_BYTES
      // in ingest.py, checked before any repository call) -- a piece is
      // already cut under MAX_PIECE_BYTES, so this is the backstop for the
      // one record that is itself over the cap (spec 011 §3), which no
      // dialogue record should ever be. One span per line, appended -- a
      // second drop in the same session adds a line, never overwrites the
      // first, so bootstrap (§8) can see every hole.
      mkdirSync(dirname(watermarkPath), { recursive: true })
      appendFileSync(droppedMarkerPath(watermarkPath), `${previousEnd}-${piece.end}\n`)
      console.error(
        `waku-memory hook: /ingest/session responded 413 for session ${event.session_id} -- ` +
          `dropping this piece and advancing past it.`,
      )
    } else if (res.status === 402) {
      // spec 013 §6: capture is paused (the trial ended, no seat). The
      // server's own sentence names what still works and where to upgrade,
      // so it is printed as given. The watermark stays, like any non-2xx:
      // after an upgrade the next event sends the gap rather than losing it.
      const detail = await readDetail(res)
      console.error(
        `waku-memory hook: ${detail.message ?? 'capture is paused -- see https://www.waku.one/settings/plan'}`,
      )
      return
    } else if (res.status === 403) {
      // final review, Important 2: only a 403 whose detail carries
      // code === 'capture_off' (ingest.py) is the person's switch for this
      // harness being off -- an ordinary 403 (an expired token, a proxy
      // refusing the request, ...) is not, and must not be read as one just
      // because the status code matches.
      const detail = await readDetail(res)
      if (detail.code === 'capture_off') {
        // spec 024 §2: the person's switch for this harness is off. Print
        // the door's sentence, then advance past this piece like a 413: a
        // turn typed while the switch was off is never sent after it is
        // turned on.
        console.error(
          `waku-memory hook: ${detail.message ?? 'capture is off for this harness -- turn it on at https://www.waku.one/integrations'}`,
        )
        // falls through to writeWatermark below
      } else {
        // Same non-2xx handling as the !res.ok arm just below: watermark left.
        console.error(`waku-memory hook: /ingest/session responded ${res.status} -- watermark left unchanged.`)
        return
      }
    } else if (!res.ok) {
      // 422 included (spec 011 §4, deployment order): an API that does not
      // yet know content_format leaves the watermark where it is, same as
      // any other non-2xx (5xx, 401, a 403 that is not capture_off) -- the
      // next event resends the whole growing delta rather than losing this piece.
      console.error(`waku-memory hook: /ingest/session responded ${res.status} -- watermark left unchanged.`)
      return
    }

    // Past this point: res.ok (202 queued / 200 deduped) or 413 (see
    // above) both advance the watermark the same way, to this piece's end.
    writeWatermark(watermarkPath, piece.end)
    previousEnd = piece.end
  }

  // spec 011 §3: a delta that produced zero pieces (every new line was
  // dropped by the formatting rule) still consumes to `delta.end` --
  // formatDelta's own contract -- so those lines are never re-read. The
  // same catches a trailing run of dropped lines after the last real
  // piece, when that piece's own `end` stops short of the full delta.
  if (delta.pieces.length === 0 || delta.end > previousEnd) writeWatermark(watermarkPath, delta.end)
}

// Entry point cli.ts's run() calls after reading and JSON.parsing stdin --
// stdin reading deliberately does not live here (see the module comment and
// task 14's brief) so this function's whole surface is plain values a test
// can construct directly, no process.stdin involved.
//
// The one try/catch below is not "the error handling"; it is the backstop
// behind branches that already handle every failure mode the brief names
// (missing/malformed config, an empty delta, a non-2xx response, a rejected
// fetch) without throwing. Reaching this catch means something those
// branches did not anticipate happened -- possibly even `event` itself
// being null or some other non-object JSON.parse handed back for
// degenerate stdin (e.g. literal "null") -- and it still must not become an
// uncaught rejection in cli.ts's fire-and-forget call.
export async function handleHookEvent(event: HookEvent, deps: HookDeps): Promise<void> {
  try {
    if (event === null || typeof event !== 'object') {
      console.error('waku-memory hook: received a malformed hook event on stdin -- skipping.')
      return
    }
    // The only place that asks "which harness?" -- everything downstream
    // (postBrief, postDelta, readDelta) takes the answer as a profile, never
    // as a string to compare against. deps.harness is typed HarnessId, so
    // profileFor always finds an entry in PROFILES; cli.ts's dispatch() is
    // what rejects an unknown --harness value before this is ever reached.
    const profile = profileFor(deps.harness ?? 'claude_code')!
    switch (event.hook_event_name) {
      case 'SessionStart':
        await postBrief(event, deps, profile)
        // After the brief, never before it: the brief is what the session waits on.
        try {
          deps.refreshSetup?.()
        } catch (err) {
          console.error(`waku-memory hook: setup refresh failed -- ${errorMessage(err)}.`)
        }
        return
      case 'UserPromptSubmit':
        await postTurn(event, deps, profile)
        return
      case 'PreToolUse':
        await postAct(event, deps, profile)
        return
      case 'Stop':
        await postDelta(event, deps, 'stop', profile)
        return
      case 'SessionEnd':
        await postDelta(event, deps, 'session-end', profile)
        return
      default:
        console.error(`waku-memory hook: ignoring unhandled event "${String(event.hook_event_name)}".`)
        return
    }
  } catch (err) {
    console.error(`waku-memory hook: unexpected failure -- ${errorMessage(err)}.`)
  }
}
