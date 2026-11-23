// The Codex config writers (spec 012 §4.2, §4.3, §4.6): everything `capture
// enable` needs to touch on a Codex machine, as pure functions over strings
// and objects. Task 10 wires the real paths (~/.codex/config.toml, ~/.codex/
// hooks.json, ~/.agents/plugins/marketplace.json) and does the atomic
// writes; this file only decides *what* the new content should be.
//
// The TOML table is added with a line scan, not a TOML library: this shim
// ships zero runtime dependencies (package.json), and `codex mcp add` was
// measured (harnesses.ts's own comment on Codex) to be a guess from OpenAI's
// docs rather than a verified integration -- pulling in a parser to
// reserialise a file we cannot fully round-trip is a worse bet than reading
// and writing back exactly the lines we understand, byte for byte, and
// leaving everything else on the page untouched.
//
// The hooks.json merge mirrors capture.ts's mergeHookSettings/removeHookSettings
// for Claude Code's settings.json -- same replace-ours-keep-foreign
// semantics, same non-string guard on entries we did not write ourselves.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { HookCommandEntry, HookGroup } from './capture.ts'
import { PROFILES } from './harnesses.ts'

// ---------------------------------------------------------------------------
// The [mcp_servers.waku] TOML table
// ---------------------------------------------------------------------------

export const CODEX_TOML_TABLE = '[mcp_servers.waku]'

// Matches the table header on its own line, allowing leading/trailing
// whitespace the way a hand-edited file might have -- but not a header that
// merely appears inside a comment or a longer table name.
const TABLE_HEADER_RE = /^\s*\[mcp_servers\.waku\]\s*$/
// Any other table header -- marks the end of ours.
const NEXT_HEADER_RE = /^\s*\[/
const URL_LINE_RE = /^\s*url\s*=\s*(.+?)\s*$/
const DEFAULT_APPROVAL_LINE = 'default_tools_approval_mode = "approve"'
// Matches a `default_tools_approval_mode = ...` line with ANY value -- used
// only to detect presence within our table's own body ([headerIdx, endIdx),
// the same boundary findUrlLine uses), never to read or judge the value: a
// person's deliberate choice (e.g. "prompt") is left alone untouched.
const APPROVAL_LINE_RE = /^\s*default_tools_approval_mode\s*=/

// Both `"..."` and `'...'` count as quoting (ruling): TOML allows either,
// and a value someone typed by hand is exactly the case this comparison
// exists for.
function unquoteTomlValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

// Detect the file's line ending so the writer preserves it: Windows Codex
// machines use CRLF; Unix-like machines use LF. This ensures that writing to
// an existing file keeps every other byte as found -- a CRLF file stays
// uniformly CRLF, an LF file stays LF.
//
// Splitting on "\n" leaves a trailing "" element whenever the text ends with
// a newline -- an artifact of split, not a real blank line at the end of the
// file. Stripped here once so every line-scanning function below can treat
// `lines[i]` as an actual line without special-casing the last index; the
// trailing newline itself is tracked separately and restored on the way out.
// Any trailing \r on each line (left by CRLF->LF split) is also stripped,
// since regex `.trim()` and `\s` in the table header will match and tolerate
// it but our own appended lines should never have it.
function splitLines(text: string): { lines: string[]; hadTrailingNewline: boolean; lineEnding: '\r\n' | '\n' } {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = text.endsWith('\n')
  const body = hadTrailingNewline ? text.slice(0, -1) : text
  const lines = body.split('\n').map((line) => (lineEnding === '\r\n' && line.endsWith('\r') ? line.slice(0, -1) : line))
  return { lines, hadTrailingNewline, lineEnding }
}

function joinLines(lines: string[], hadTrailingNewline: boolean, lineEnding: '\r\n' | '\n' = '\n'): string {
  return lines.join(lineEnding) + (hadTrailingNewline ? lineEnding : '')
}

// Finds our table's header line and the index where it ends -- either the
// next `[...]` header or the end of the file.
function findWakuTable(lines: string[]): { headerIdx: number; endIdx: number } | undefined {
  const headerIdx = lines.findIndex((l) => TABLE_HEADER_RE.test(l))
  if (headerIdx === -1) return undefined
  let endIdx = lines.length
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (NEXT_HEADER_RE.test(lines[i])) {
      endIdx = i
      break
    }
  }
  return { headerIdx, endIdx }
}

// Whether a [mcp_servers.waku] table exists in config.toml at all --
// regardless of whose url it carries or whether it is otherwise ours.
// status() (capture.ts) uses this to warn about a duplicate MCP server when
// the Waku plugin is also present: the plugin's own route and this table
// both register a `waku` MCP server with Codex, whoever's url the table
// holds, so presence alone is the question -- not the url-equality
// mergeCodexToml/removeCodexToml check for a table this tool may write to
// or remove.
export function codexTomlTablePresent(configToml: string): boolean {
  const { lines } = splitLines(configToml)
  return lines.some((l) => TABLE_HEADER_RE.test(l))
}

// The first `url = ...` line inside [headerIdx, endIdx) -- the table body.
function findUrlLine(lines: string[], headerIdx: number, endIdx: number): { index: number; value: string } | undefined {
  for (let i = headerIdx + 1; i < endIdx; i++) {
    const m = URL_LINE_RE.exec(lines[i])
    if (m) return { index: i, value: unquoteTomlValue(m[1]) }
  }
  return undefined
}

function codexTomlBlock(url: string, lineEnding: '\r\n' | '\n' = '\n'): string {
  return `${lineEnding}${CODEX_TOML_TABLE}${lineEnding}url = "${url}"${lineEnding}${DEFAULT_APPROVAL_LINE}${lineEnding}`
}

// Appends `\n[mcp_servers.waku]\nurl = "<url>"\ndefault_tools_approval_mode =
// "approve"\n`, preceded by one blank line, when no such table exists yet.
// Refuses -- leaves `existing` byte-for-byte untouched -- when a table is
// already there with a different (or unreadable) url: someone configured
// this by hand, and silently replacing it would undo a deliberate choice
// with no trace (same reasoning as harnesses.ts's mergeMcpConfig refusal for
// Claude Code's config).
//
// When the table already carries exactly our url, presence of a
// `default_tools_approval_mode` line (ANY value) decides the rest: if it is
// there, the table is left alone -- unchanged -- because a value someone
// set by hand (e.g. "prompt") is a deliberate choice this must not
// overwrite. If it is missing -- the state the old `codexNote` told people
// to write by hand, and what was measured left on a real machine on
// 2026-09-08 -- the line is inserted immediately after the `url` line and
// 'wrote' is returned: without it, the model's calls to the waku tools wait
// on an interactive approval prompt, and `codex exec` (non-interactive)
// hangs outright. The scan for an existing approval line, like the url
// scan, stops at the table's own endIdx (the next `[` header or EOF), so a
// `default_tools_approval_mode` belonging to a later table is never
// mistaken for ours and never blocks ours from being added.
export function mergeCodexToml(existing: string, url: string): { text: string; result: 'wrote' | 'unchanged' | 'refused' } {
  const { lines, hadTrailingNewline, lineEnding } = splitLines(existing)
  const table = findWakuTable(lines)
  if (table) {
    const found = findUrlLine(lines, table.headerIdx, table.endIdx)
    if (!found || found.value !== url) return { text: existing, result: 'refused' }
    const hasApproval = lines.slice(table.headerIdx + 1, table.endIdx).some((l) => APPROVAL_LINE_RE.test(l))
    if (hasApproval) return { text: existing, result: 'unchanged' }
    const newLines = [...lines.slice(0, found.index + 1), DEFAULT_APPROVAL_LINE, ...lines.slice(found.index + 1)]
    return { text: joinLines(newLines, hadTrailingNewline, lineEnding), result: 'wrote' }
  }
  const hasTrailingNewline = existing.endsWith('\n')
  const base = hasTrailingNewline ? existing : existing + lineEnding
  return { text: base + codexTomlBlock(url, lineEnding), result: 'wrote' }
}

// The exact inverse of the "wrote" branch above: removes the header, the
// `url` line and the `default_tools_approval_mode` line, and the one blank
// line that preceded the header if it is there -- and only when the table's
// url equals ours AND the table holds nothing else. A table a person added
// a line to (even a comment) is left alone entirely: "nothing" is the safe
// answer whenever removal cannot be proven to touch only what we wrote. The
// two lines must also be in the order codexTomlBlock wrote them (url, then
// the approval mode) -- `body[0]`/`body[1]` are checked positionally, not
// searched for, so a file where someone reordered them fails the same way
// an added line would and is left untouched.
//
// Bug fix (measured on a real machine, 2026-09-17): `body` is
// `lines.slice(headerIdx + 1, endIdx)`, and `endIdx` is the next `[` header
// or EOF -- so whenever anything follows our table (Codex's own
// `[projects.'...']`, `[hooks.state.'...']`, or simply another table that
// was already in the file, as in the real shape below), the body carries a
// trailing blank line that is the separator before that next header, not
// content of ours. The old code counted that separator as a third body line
// and refused every time, which is the common case, not the rare one --
// `mergeCodexToml` only ever appends at EOF, but Codex itself routinely
// appends more tables after ours later. Trailing blank lines at the end of
// the body are therefore trimmed off before the length/content check below,
// and are left in place (not removed) on the way out, since they are the
// separator that already existed between our table and whatever follows --
// exactly as many of them as were there before our block ever existed.
// A non-blank line anywhere in the body beyond our own two still refuses,
// the same as before; only trailing *blank* lines are ever excused.
//
// R22 (final review, spec 012): a `[mcp_servers.waku.<sub>]` header
// immediately after our two lines is a TOML sub-table of ours, not an
// unrelated table -- findWakuTable's endIdx (shared with mergeCodexToml)
// stops at it the same as at any other header, so the body-length check
// above would otherwise see exactly our two lines and remove them, leaving
// the sub-table behind. TOML then implicitly recreates mcp_servers.waku,
// empty and with no url, the moment that sub-table is parsed -- so this is
// refused before the body is even read.
export function removeCodexToml(existing: string, url: string): { text: string; result: 'removed' | 'nothing' } {
  const { lines, hadTrailingNewline, lineEnding } = splitLines(existing)
  const table = findWakuTable(lines)
  if (!table) return { text: existing, result: 'nothing' }
  const { headerIdx, endIdx } = table
  if (endIdx < lines.length && /^\s*\[mcp_servers\.waku\./.test(lines[endIdx])) {
    return { text: existing, result: 'nothing' }
  }
  // Trim trailing blank lines off the body: they are the separator before
  // whatever comes next (another header, or EOF), not something we wrote.
  let bodyEnd = endIdx
  while (bodyEnd > headerIdx + 1 && lines[bodyEnd - 1] === '') bodyEnd--
  const body = lines.slice(headerIdx + 1, bodyEnd)
  const urlLine = body.length > 0 ? URL_LINE_RE.exec(body[0]) : null
  const urlMatches = urlLine !== null && unquoteTomlValue(urlLine[1]) === url
  const defaultLineMatches = body.length > 1 && body[1].trim() === DEFAULT_APPROVAL_LINE
  if (body.length !== 2 || !urlMatches || !defaultLineMatches) {
    return { text: existing, result: 'nothing' }
  }
  const hasBlankBefore = headerIdx > 0 && lines[headerIdx - 1] === ''
  const removeStart = hasBlankBefore ? headerIdx - 1 : headerIdx
  // Keep from bodyEnd onward -- the trailing separator blanks trimmed above,
  // and everything from the next header (or EOF) on -- so those separator
  // lines survive exactly as they were before our block existed.
  const newLines = [...lines.slice(0, removeStart), ...lines.slice(bodyEnd)]
  return { text: joinLines(newLines, hadTrailingNewline, lineEnding), result: 'removed' }
}

// ---------------------------------------------------------------------------
// ~/.codex/hooks.json
// ---------------------------------------------------------------------------

// The slice of hooks.json this file ever reads or writes -- mirrors
// capture.ts's ClaudeSettings: `description` and any other top-level key
// pass through untouched, this only ever looks at `hooks`.
export type CodexHooksFile = { description?: string; hooks?: Record<string, HookGroup[]> }

// Codex runs hook commands through a shell (unlike Claude Code's exec-form
// entries), so the invocation is one shell string per platform rather than
// a command/args pair -- `command_windows` is Codex's own field for the
// Windows variant.
export type CodexHookEntry = HookCommandEntry & {
  command_windows?: string
  async?: boolean
  timeout?: number
  statusMessage?: string
}

// The marker that names an entry as ours: it can only appear in a command
// this shim generated, never in something a person or another tool wrote by
// hand (the leading space rules out an unrelated command that merely ends
// in a word containing "hook").
const OWN_CODEX_MARKER = ' hook --harness codex'

function codexHookCommand(indexPath: string): { command: string; command_windows: string } {
  const posix = indexPath.replace(/\\/g, '/')
  const windows = indexPath.replace(/\//g, '\\')
  return {
    command: `node "${posix}" hook --harness codex`,
    command_windows: `node "${windows}" hook --harness codex`,
  }
}

// The events capture.ts's Claude Code profile installs, reshaped for Codex:
// same event split (SessionStart brief, Stop flush, SessionEnd flush-on-exit,
// and, since spec 023 §2, UserPromptSubmit's turn marker), different timing
// and output contract per PROFILES.codex (harnesses.ts) and spec 012 §4.
// `statusMessage` is Codex's own field for what SessionStart shows while the
// hook runs; Codex has no matching notion for the other events, so it is left
// off there. The matcher omits "fork" -- unlike Claude Code's
// SESSION_START_MATCHER, Codex has no fork event to name (controller ruling).
export function codexHookEntries(
  indexPath: string,
): Record<'SessionStart' | 'Stop' | 'SessionEnd' | 'UserPromptSubmit', HookGroup[]> {
  const { command, command_windows } = codexHookCommand(indexPath)
  const base: CodexHookEntry = { type: 'command', command, command_windows }
  // Built as named variables, not inline literals, before landing in a
  // `hooks: HookCommandEntry[]` position -- CodexHookEntry's extra fields
  // (statusMessage, command_windows, timeout, a boolean async) are fine on a
  // value structurally, but TypeScript's excess-property check would reject
  // an *inline* object literal with fields HookCommandEntry does not name.
  const sessionStartHook: CodexHookEntry = { ...base, timeout: 5, statusMessage: 'Waku memory' }
  const stopHook: CodexHookEntry = { ...base, async: true, timeout: 600 }
  const sessionEndHook: CodexHookEntry = { ...base, timeout: PROFILES.codex.sessionEndHookTimeoutS }
  const userPromptHook: CodexHookEntry = { ...base, timeout: 5 }
  return {
    SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [sessionStartHook] }],
    Stop: [{ hooks: [stopHook] }],
    SessionEnd: [{ hooks: [sessionEndHook] }],
    // spec 023 §2, same reasoning as the Claude Code profile. A Codex machine
    // running the plugin instead writes the same row through session.hook,
    // with Codex's own turn id.
    UserPromptSubmit: [{ hooks: [userPromptHook] }],
  }
}

// spec 071 F1: the act channel's group for Codex, which only "act on" adds
// (act.ts). Codex names a shell command Bash and apply_patch Edit or Write.
export const CODEX_ACT_MATCHER = 'Bash|Edit|Write'
export function codexActGroup(indexPath: string): HookGroup {
  const { command, command_windows } = codexHookCommand(indexPath)
  const hook: CodexHookEntry = { type: 'command', command, command_windows, timeout: 3 }
  return { matcher: CODEX_ACT_MATCHER, hooks: [hook] }
}

// spec 071 F1: the hook copy an entry of ours runs, read off its command,
// or undefined.
export function codexIndexPath(entry: unknown): string | undefined {
  if (!isOwnCodexEntry(entry)) return undefined
  const command = (entry as { command?: unknown }).command
  const match = typeof command === 'string' ? /^node "([^"]+)" hook --harness codex$/.exec(command) : null
  return match ? match[1] : undefined
}

// Ours in either field. `entry` is `unknown`, the same way isOwnEntry in
// capture.ts treats settings.json contents as untrusted: hooks.json is only
// validated as a top-level object, so anything nested under `hooks` could be
// whatever another tool wrote there. Never throws -- a malformed entry
// (a non-string `command`) is simply not ours.
export function isOwnCodexEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const e = entry as Record<string, unknown>
  const inCommand = typeof e.command === 'string' && e.command.includes(OWN_CODEX_MARKER)
  const inCommandWindows = typeof e.command_windows === 'string' && e.command_windows.includes(OWN_CODEX_MARKER)
  return inCommand || inCommandWindows
}

// A group is "ours" only if every hook inside it is ours -- see capture.ts's
// isOwnGroup for why "every" (not "some") is what makes the remove side
// exact.
function isOwnCodexGroup(group: HookGroup): boolean {
  return group.hooks.length > 0 && group.hooks.every(isOwnCodexEntry)
}

// Replaces any group of ours on each event with a freshly built one, keeps
// every foreign group untouched -- the same replace-not-skip semantics as
// capture.ts's mergeHookSettings, so re-running `capture enable` after an
// upgrade always lands the current entry rather than leaving a stale one
// beside it.
//
// spec 071 F1: an act group already there is rebuilt too, and none is added.
export function mergeCodexHooks(existing: CodexHooksFile, indexPath: string): CodexHooksFile {
  const hooks: Record<string, HookGroup[]> = { ...(existing.hooks ?? {}) }
  for (const [event, groups] of Object.entries(codexHookEntries(indexPath))) {
    hooks[event] = [...(hooks[event] ?? []).filter((g) => !isOwnCodexGroup(g)), ...groups]
  }
  if ((hooks.PreToolUse ?? []).some(isOwnCodexGroup)) return addCodexAct({ ...existing, hooks }, indexPath)
  return { ...existing, hooks }
}

// spec 071 F1: PreToolUse's own group replaced by one for `indexPath`.
export function addCodexAct(existing: CodexHooksFile, indexPath: string): CodexHooksFile {
  const hooks: Record<string, HookGroup[]> = { ...(existing.hooks ?? {}) }
  hooks.PreToolUse = [...(hooks.PreToolUse ?? []).filter((g) => !isOwnCodexGroup(g)), codexActGroup(indexPath)]
  return { ...existing, hooks }
}

// spec 071 F1: the exact inverse of addCodexAct.
export function removeCodexAct(existing: CodexHooksFile): CodexHooksFile {
  const groups = existing.hooks?.PreToolUse
  if (!groups) return existing
  const { PreToolUse: _drop, ...others } = existing.hooks ?? {}
  const kept = groups.filter((g) => !isOwnCodexGroup(g))
  const hooks: Record<string, HookGroup[]> = kept.length > 0 ? { ...others, PreToolUse: kept } : others
  if (Object.keys(hooks).length === 0) {
    const { hooks: _gone, ...rest } = existing
    return rest as CodexHooksFile
  }
  return { ...existing, hooks }
}

// spec 071 F1: whether PreToolUse holds a group of ours.
export function hasCodexAct(existing: CodexHooksFile): boolean {
  return (existing.hooks?.PreToolUse ?? []).some(isOwnCodexGroup)
}

// spec 071 F1: the hook copy "full-record on" wired, read off its
// UserPromptSubmit group.
export function ownCodexIndexPath(existing: CodexHooksFile): string | undefined {
  for (const group of existing.hooks?.UserPromptSubmit ?? []) {
    if (!isOwnCodexGroup(group)) continue
    const path = codexIndexPath(group.hooks[0])
    if (path) return path
  }
  return undefined
}

// The exact inverse: drops every group that is entirely ours, and drops an
// event key altogether once nothing is left under it.
export function removeCodexHooks(existing: CodexHooksFile): CodexHooksFile {
  if (!existing.hooks) return existing
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(existing.hooks)) {
    const kept = groups.filter((g) => !isOwnCodexGroup(g))
    if (kept.length > 0) hooks[event] = kept
  }
  if (Object.keys(hooks).length === 0) {
    const { hooks: _drop, ...rest } = existing
    return rest as CodexHooksFile
  }
  return { ...existing, hooks }
}

// ---------------------------------------------------------------------------
// The personal marketplace: ~/.agents/plugins/marketplace.json
// ---------------------------------------------------------------------------

// The slice of marketplace.json this file ever reads or writes -- other keys
// and other plugins pass through untouched, matched by index signature.
export type MarketplaceFile = {
  name?: string
  interface?: { displayName?: string }
  plugins?: Array<Record<string, unknown>>
}

// Until 0.14.7, `full-record on` and `capture enable` wrote this entry on a
// Codex machine without the plugin. The entry told Codex to install the
// plugin from the npm package. Since 0.15.0 the npm package holds the CLI
// only, and the plugin comes from waku-one/waku-memory-plugins (spec 083).
// The CLI writes no marketplace entry now. It takes this one out where the
// plugin is not installed, because an install from it would find no plugin.
export const OLD_NPM_MARKETPLACE_ENTRY = {
  name: 'waku',
  source: { source: 'npm', package: 'waku-memory' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Developer Tools',
}

// How a person installs the plugin in Codex. The repository's README gives
// the same two commands.
export const CODEX_PLUGIN_INSTALL = [
  '  codex plugin marketplace add waku-one/waku-memory-plugins',
  '  codex plugin add waku@waku-memory',
].join('\n')

function isOldNpmEntry(plugin: Record<string, unknown>): boolean {
  const source = plugin.source
  if (plugin.name !== 'waku' || source === null || typeof source !== 'object') return false
  const { source: kind, package: pkg } = source as { source?: unknown; package?: unknown }
  return kind === 'npm' && pkg === 'waku-memory'
}

// Whether the personal marketplace still holds the entry above.
export function hasOldNpmEntry(existing: MarketplaceFile | undefined): boolean {
  return existing?.plugins?.some(isOldNpmEntry) ?? false
}

// Takes the entry above out. Every other key and every other plugin stays,
// a `waku` entry with another source included: a person wrote that one.
export function removeOldNpmEntry(existing: MarketplaceFile | undefined): { data: MarketplaceFile | undefined; result: 'removed' | 'unchanged' } {
  if (existing === undefined || !hasOldNpmEntry(existing)) {
    return { data: existing, result: 'unchanged' }
  }
  return { data: { ...existing, plugins: (existing.plugins ?? []).filter((p) => !isOldNpmEntry(p)) }, result: 'removed' }
}

// ---------------------------------------------------------------------------
// Plugin detection
// ---------------------------------------------------------------------------

// Matches `[plugins."waku@<marketplace>"]` -- the table config.toml carries
// once the plugin is actually installed (as opposed to merely listed in a
// marketplace file, which only makes it available). Ruling R21: both quoting
// styles TOML allows for the key count, the same reasoning as
// unquoteTomlValue above -- a table someone hand-edited is exactly the case
// this needs to tolerate.
const PLUGIN_TABLE_HEADER_RE = /^\s*\[plugins\.(?:"waku@[^"]*"|'waku@[^']*')\]\s*$/
const ENABLED_FALSE_RE = /^\s*enabled\s*=\s*false\b/

// R21 (final review, spec 012): the config.toml table is authoritative when
// present -- returns true/false for "the table says so", or undefined when
// there is no such table at all (the cache probe's cue to run). A table
// with no `enabled` line at all means present (Codex's own default); one
// that sets `enabled = false` means absent, full stop, regardless of what
// the plugin cache still has lying around. Scans only up to the next table
// header, the same boundary findWakuTable uses above for
// [mcp_servers.waku].
function wakuPluginTableStatus(configToml: string): boolean | undefined {
  const { lines } = splitLines(configToml)
  const headerIdx = lines.findIndex((l) => PLUGIN_TABLE_HEADER_RE.test(l))
  if (headerIdx === -1) return undefined
  let endIdx = lines.length
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (NEXT_HEADER_RE.test(lines[i])) {
      endIdx = i
      break
    }
  }
  const disabled = lines.slice(headerIdx + 1, endIdx).some((l) => ENABLED_FALSE_RE.test(l))
  return !disabled
}

// Detects whether the Waku plugin is already installed, by either route
// Codex uses: the config.toml table (source of truth once Codex has loaded
// it -- ruling R21, wakuPluginTableStatus above), or a `waku` directory
// under some marketplace's entry in Codex's plugin cache (on this machine,
// `~/.codex/plugins/cache/<marketplace>/<plugin>` -- present even before
// config.toml is regenerated). The cache probe runs only when no table
// exists at all: a lingering cache directory from an uninstalled plugin, or
// one from before a table with `enabled = false` was added, must not
// override what the table now says. `io` defaults to node:fs's real
// existsSync/readdirSync; tests inject a stand-in so this stays a pure
// function over its inputs otherwise. Any error reading the cache directory
// (ENOENT when it does not exist yet, or anything else) means "not present
// by that route".
export function codexPluginPresent(
  configToml: string,
  pluginsCacheDir: string,
  io: { existsSync: (path: string) => boolean; readdirSync: (path: string) => string[] } = { existsSync, readdirSync },
): boolean {
  const tableStatus = wakuPluginTableStatus(configToml)
  if (tableStatus !== undefined) return tableStatus
  let marketplaces: string[]
  try {
    marketplaces = io.readdirSync(pluginsCacheDir)
  } catch {
    return false
  }
  return marketplaces.some((m) => io.existsSync(join(pluginsCacheDir, m, 'waku')))
}
