// `capture enable` / `capture disable` -- the one gesture that turns
// automatic memory capture on, and the disclosure gate it exists to carry.
// Wired by cli.ts, the same split hook.ts established: everything here
// takes its inputs as plain values (a deps bag, an already-decided action)
// so capture.test.mjs can drive it against temp directories and an injected
// prompt, never a real ~/.claude or ~/.waku-memory and never real stdin.
//
// This command is where status.md item 9's disclosure obligation is
// actually discharged: enabling capture means every turn of the user's
// Claude Code sessions is posted to our server and sent on to Anthropic for
// extraction. The gate below is deliberately not a formality -- see
// DISCLOSURE and enable()'s ordering, which prints it and requires a typed
// "y" before anything else happens, including asking for a key.
//
// Zero dependencies, per the shim's package.json: only node:fs, node:path
// and node:util (all built in) below, one constant from hook.ts -- the
// process budget the SessionEnd entry installs, which hook.ts's own network
// budget has to fit under -- and, since task 13, the bootstrap module (spec
// 011 §8): the third question's scan/render/parse (task 12) and send (task
// 13) all live in bootstrap.ts, so enable() below only orchestrates them.
// hook.ts imports nothing from here in return; bootstrap.ts imports from
// hook.ts (the watermark rule) but nothing from this file either.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import {
  type BootstrapAnswer,
  type BootstrapSelection,
  type Scan,
  LIVE_WINDOW_MS,
  parseBootstrapAnswer,
  renderBootstrapList,
  wakuHomeDir,
  runBootstrap,
  scanAll,
} from './bootstrap.ts'
import { CONFIG_FILE_NAME, SESSION_END_HOOK_TIMEOUT_S } from './hook.ts'
// Task 9's Codex writers (spec 012 §4.2, §4.3, §4.6), consumed here rather
// than re-implemented: codex-config.ts already decided *what* the TOML
// table, the hooks.json entries and the marketplace entry should look like,
// as pure functions over strings and objects -- enable()/disable()/status()
// below only decide *when* to call them and what to do with a real
// filesystem. codex-config.ts's own import from this file (HookCommandEntry,
// HookGroup) is `import type`, erased at compile time, so this is not a
// runtime import cycle: loading capture.ts still only ever requires
// node:fs/node:path/node:util, harnesses.ts (via codex-config.ts) and
// bootstrap.ts, the same dependency shape the file header above describes.
import {
  type CodexHooksFile,
  type MarketplaceFile,
  codexPluginPresent,
  codexTomlTablePresent,
  isOwnCodexEntry,
  mergeCodexHooks,
  mergeCodexToml,
  CODEX_PLUGIN_INSTALL,
  hasOldNpmEntry,
  removeOldNpmEntry,
  removeCodexHooks,
  removeCodexToml,
} from './codex-config.ts'

// Task 13 (spec 012 §7): the Sign-in choice's own result type, `import
// type` for the same reason codex-config.ts's own import above is --
// login.ts imports sanitizeKey/writeConfigJson from *this* file, so a
// runtime import here would be a cycle; a type-only one is erased at
// compile time and is not.
import type { LoginResult } from './login.ts'

// spec 024 §4: whether the Waku plugin is installed in Claude Code, by
// either route Claude Code records it -- settings.json's enabledPlugins
// naming `waku@waku-memory` (the marketplace's name is waku-memory), or a
// `waku` folder under that marketplace in the plugin cache. Documented, not
// measured (spec 024 §4); task E1 checks it on a real machine.
export function claudePluginPresent(
  settings: ClaudeSettings,
  pluginsCacheDir: string,
  io: { existsSync: (path: string) => boolean } = { existsSync },
): boolean {
  const enabled = settings.enabledPlugins
  if (enabled !== null && typeof enabled === 'object' && (enabled as Record<string, unknown>)['waku@waku-memory'] === true) {
    return true
  }
  return io.existsSync(join(pluginsCacheDir, 'waku-memory', 'waku'))
}

// CONFIG_FILE_NAME and SESSION_END_HOOK_TIMEOUT_S are imported from hook.ts
// above rather than re-declared: two copies of a name the hook reads and
// this command writes would drift the first time one moved. The dependency
// runs one way only -- hook.ts (the piece that runs unattended on every
// turn) imports nothing from this file (the piece a human runs once).

// Fix round 2 (re-review finding #1, controller ruling R9, spec 012 §4.2):
// the single source of truth for "given one URL a person typed, what is the
// ingest base and what is the MCP endpoint". Round 1 got this only half
// right -- it derived ingestUrl from mcpUrl by stripping a trailing "/mcp",
// but cli.ts's usage text documents "--url <ingest-base>" (an *ingest*-shaped
// value), and dispatch() never computed a "/mcp"-suffixed mcpUrl from that
// shape at all: an ingest-shaped --url with no "/mcp" to strip left
// mcpUrl === ingestUrl, reproducing the exact defect (the ingest base
// reaching the Codex TOML) for anyone who follows the tool's own documented
// flag contract instead of guessing the MCP-shaped alternative.
//
// This function inverts the direction: always derive the *ingest* base first
// (strip trailing slashes, then one trailing "/mcp" if present), then always
// build mcpUrl by appending "/mcp" to that -- so every shape a person could
// reasonably type ("https://x.test", "https://x.test/", "https://x.test/mcp")
// converges on the same correct pair, rather than only working when the
// input happens to already be MCP-shaped. Exported so both dispatch()
// (cli.ts, computing the pair from --url) and disable() below (recovering
// the pair enable() used, from what it stored in config.json) share the one
// rule -- capture.ts is the natural home since cli.ts already imports from
// it and the reverse would be a cycle.
export function urlPair(given: string): { ingestUrl: string; mcpUrl: string } {
  let ingestUrl = given.replace(/\/+$/, '')
  if (ingestUrl.endsWith('/mcp')) ingestUrl = ingestUrl.slice(0, -'/mcp'.length).replace(/\/+$/, '')
  return { ingestUrl, mcpUrl: `${ingestUrl}/mcp` }
}

export type HookCommandEntry = {
  type: 'command'
  command: string
  args?: string[] // exec form (hooks reference): spawned directly, no shell, each element one argument
  async?: true
  timeout?: number
}
export type HookGroup = { matcher?: string; hooks: HookCommandEntry[] }

// What runs: `node <index.js> hook` in exec form (spec 011 §6) -- Claude
// Code spawns command/args directly, no shell, so there is no quoting to
// get wrong and no per-OS shell to disagree about. The 0.1.x shell form
// (`npx -y waku-memory hook`) is what `isOwnEntry` below still has to
// recognise, on a machine that enabled capture before this version existed.
export type HookInvocation = { command: string; args?: string[] }

// The slice of Claude Code's settings.json this file ever reads or writes.
// The index signature is load-bearing: settings.json carries many keys this
// tool has no opinion about (model, permissions, statusLine, ...), and both
// mergeHookSettings and removeHookSettings must pass every one of them
// through untouched.
export type ClaudeSettings = {
  hooks?: Record<string, HookGroup[]>
} & Record<string, unknown>

// `Stop` is where captured content is actually sent -- "async": true so it
// runs in the background without blocking the turn (600s default budget,
// research doc §2). `SessionStart` is synchronous instead, with a 5s
// timeout and a matcher naming the five events worth a brief: its stdout is
// printed straight into the session as context (spec 011 §6, task 9), which
// is exactly why it can no longer be fire-and-forget the way 0.1.x had it.
// `SessionEnd` is the flush: all SessionEnd hooks share a 1.5s-by-default
// exit budget and cannot block Claude Code's own exit, so it carries a
// `timeout` instead of `async` -- raised to SESSION_END_HOOK_TIMEOUT_S
// seconds, the process budget hook.ts's own network budget is derived from
// (its SESSION_END_TIMEOUT_MS comment has the measured detail). `async`
// only affects whether a hook keeps running after Claude Code moves on; for
// an event that already cannot block exit, that distinction does not
// apply, so it is left off rather than set to a value the harness ignores
// anyway (pinned by the given test's `sessionEnd.async === undefined`).
const SESSION_START_MATCHER = 'startup|resume|clear|compact|fork'
function hookEvents(run: HookInvocation): Record<string, HookGroup> {
  const base = run.args
    ? { type: 'command' as const, command: run.command, args: run.args }
    : { type: 'command' as const, command: run.command }
  return {
    Stop: { hooks: [{ ...base, async: true }] },
    SessionStart: { matcher: SESSION_START_MATCHER, hooks: [{ ...base, timeout: 5 }] },
    SessionEnd: { hooks: [{ ...base, timeout: SESSION_END_HOOK_TIMEOUT_S }] },
    // spec 023 §2: one POST per turn. Synchronous with the same 5s budget as
    // SessionStart, not `async` like Stop -- a marker that lands after the
    // turn's first tool call stamps that call with the previous turn's id.
    // Since spec 029 its stdout is the memories injected beside the prompt,
    // which a UserPromptSubmit hook folds into the session as context.
    UserPromptSubmit: { hooks: [{ ...base, timeout: 5 }] },
  }
}

// spec 071 F1: the act channel's group, which only "act on" adds (act.ts).
// Synchronous, because the step waits for its rules; the 3 s process budget
// sits above hook.ts's ACT_TIMEOUT_MS. The matcher names the tools that
// change something: a shell command, and the four ways to edit a file.
export const ACT_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit'
export const ACT_HOOK_TIMEOUT_S = 3
export function actGroup(run: HookInvocation): HookGroup {
  const base = run.args
    ? { type: 'command' as const, command: run.command, args: run.args }
    : { type: 'command' as const, command: run.command }
  return { matcher: ACT_MATCHER, hooks: [{ ...base, timeout: ACT_HOOK_TIMEOUT_S }] }
}

// Ours in either form: a shell command that names the package and ends
// with the subcommand (0.1.x), or an exec-form entry whose last argument is
// `hook` and whose script lives under a `.waku-memory/hook/` directory.
// Deliberately not a single marker constant checked against one field
// anymore -- the exec form has no one field that both names the package and
// the subcommand the way the 0.1.x shell string did, so recognising it
// needs its own arm.
export function isOwnEntry(entry: HookCommandEntry): boolean {
  // settings.json is only validated as a top-level plain object
  // (readClaudeSettings's own comment) -- anything inside `hooks` is
  // whatever some other tool wrote there, so `command` and `args` are
  // `unknown` in practice despite what HookCommandEntry claims at compile
  // time. An entry this cannot prove is shaped the way ours would be is
  // never ours: false, not a thrown TypeError (final review M1 -- a real
  // exec-form entry with a non-string argument used to throw out of here,
  // reaching mergeHookSettings, reaching enable() *after* config.json is
  // already written).
  if (typeof entry.command !== 'string') return false
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== 'string')) return false
    const args = entry.args
    return args[args.length - 1] === 'hook' && args.some((a) => a.replace(/\\/g, '/').includes('/.waku-memory/hook/'))
  }
  return entry.command.includes('waku-memory') && entry.command.trimEnd().endsWith(' hook')
}

// A group is "ours" only if every hook inside it is ours -- mergeHookSettings
// only ever writes single-hook groups, so in practice this means exactly
// one hook isOwnEntry recognises, but the "every" check (rather than
// "some") is what makes removeHookSettings's contract exact: it must never
// delete a group that also carries someone else's hook.
function isOwnGroup(group: HookGroup): boolean {
  return group.hooks.length > 0 && group.hooks.every(isOwnEntry)
}

// Ours if any group under any event is entirely ours -- status() (below)
// needs exactly this yes/no, not the merge/remove machinery.
function hasOwnHooks(settings: ClaudeSettings): boolean {
  if (!settings.hooks) return false
  return Object.values(settings.hooks).some((groups) => groups.some(isOwnGroup))
}

// Replaces any group of ours on each event -- an older version's entry, in
// either form -- with one built from `run`, and keeps every foreign group
// untouched. Idempotent: merging the same invocation twice yields the same
// settings (pinned below), which is what makes running `enable` again, on
// the same version, safe.
//
// spec 071 F1: an act group already there is rebuilt from `run` too, and
// none is added. pruneHookCopies deletes the copy the old group points at.
export function mergeHookSettings(existing: ClaudeSettings, run: HookInvocation): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = { ...(existing.hooks ?? {}) }
  for (const [event, group] of Object.entries(hookEvents(run))) {
    hooks[event] = [...(hooks[event] ?? []).filter((g) => !isOwnGroup(g)), group]
  }
  if ((hooks.PreToolUse ?? []).some(isOwnGroup)) return addActSettings({ ...existing, hooks }, run)
  return { ...existing, hooks }
}

// spec 071 F1: PreToolUse's own group replaced by one built from `run`, and
// every foreign group kept.
export function addActSettings(existing: ClaudeSettings, run: HookInvocation): ClaudeSettings {
  const hooks: Record<string, HookGroup[]> = { ...(existing.hooks ?? {}) }
  hooks.PreToolUse = [...(hooks.PreToolUse ?? []).filter((g) => !isOwnGroup(g)), actGroup(run)]
  return { ...existing, hooks }
}

// spec 071 F1: the exact inverse of addActSettings. Every other event's
// groups stay, so full record keeps running.
export function removeActSettings(existing: ClaudeSettings): ClaudeSettings {
  const groups = existing.hooks?.PreToolUse
  if (!groups) return existing
  const { PreToolUse: _drop, ...others } = existing.hooks ?? {}
  const kept = groups.filter((g) => !isOwnGroup(g))
  const hooks: Record<string, HookGroup[]> = kept.length > 0 ? { ...others, PreToolUse: kept } : others
  if (Object.keys(hooks).length === 0) {
    const { hooks: _gone, ...rest } = existing
    return rest as ClaudeSettings
  }
  return { ...existing, hooks }
}

// spec 071 F1: whether PreToolUse holds a group of ours.
export function hasActSettings(existing: ClaudeSettings): boolean {
  return (existing.hooks?.PreToolUse ?? []).some(isOwnGroup)
}

// spec 071 F1: the exec-form invocation "full-record on" wrote, read off its
// UserPromptSubmit group, or undefined when there is none: a 0.1.x shell
// entry (npx, 2.5 s a run) is never reused before every tool call.
export function ownInvocation(existing: ClaudeSettings): HookInvocation | undefined {
  for (const group of existing.hooks?.UserPromptSubmit ?? []) {
    if (!isOwnGroup(group)) continue
    const entry = group.hooks[0]
    if (entry?.args) return { command: entry.command, args: [...entry.args] }
  }
  return undefined
}

// The exact inverse: drops every group that is entirely ours, and drops an
// event key altogether once nothing is left under it -- a stray
// `"SessionStart": []` would be exactly as misleading as leaving the hook in
// place, since both read as "something runs here". Not exported as
// disable()'s whole job: disable() also decides whether there was anything
// to remove at all (see its own comment).
export function removeHookSettings(existing: ClaudeSettings): ClaudeSettings {
  if (!existing.hooks) return existing
  const hooks: Record<string, HookGroup[]> = {}
  for (const [event, groups] of Object.entries(existing.hooks)) {
    const kept = groups.filter((g) => !isOwnGroup(g))
    if (kept.length > 0) hooks[event] = kept
  }
  if (Object.keys(hooks).length === 0) {
    const { hooks: _drop, ...rest } = existing
    return rest as ClaudeSettings
  }
  return { ...existing, hooks }
}

// Copies the shim's own compiled dist/*.js, next to a one-line ESM
// package.json, into a version-numbered directory under configDir --
// installed rather than run via npx (2.5s per hook, measured, on top of
// SessionStart now being synchronous and printing: spec 011 §6) and
// versioned rather than a single fixed path so an in-flight hook from the
// previous version is never overwritten mid-run by the next `enable`
// (pruneHookCopies below cleans up once settings.json has moved on).
// A no-op when sourceDir already *is* the copy -- enable() re-run from
// inside an already-installed copy has nothing left to do.
export function installHookCopy(sourceDir: string, configDir: string, version: string): string {
  const target = join(configDir, 'hook', version)
  const indexPath = join(target, 'index.js').replace(/\\/g, '/') // Claude Code spawns this directly -- see hookInvocation
  if (resolve(sourceDir) === resolve(target)) return indexPath
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(sourceDir)) {
    if (name.endsWith('.js')) copyFileSync(join(sourceDir, name), join(target, name))
  }
  writeFileSync(join(target, 'package.json'), '{"type":"module"}\n', 'utf8') // dist/*.js is ESM
  return indexPath
}

// After settings.json points only at `keep`, every other copy under
// configDir/hook is stale disk. A directory Windows refuses to delete
// (EBUSY: an old hook process still running) is reported and left for the
// next enable to retry -- the entries already point elsewhere, so a copy
// left behind here is wasted space, never a wrong hook running.
export function pruneHookCopies(configDir: string, keep: string): void {
  const root = join(configDir, 'hook')
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keep) continue
    try {
      rmSync(join(root, name), { recursive: true, force: true })
    } catch (err) {
      console.error(
        `Could not remove the old hook copy ${join(root, name)} -- ${(err as Error).message}. ` +
          `It will be removed by the next "full-record on".`,
      )
    }
  }
}

// Exec form (spec 011 §6): Claude Code spawns command/args directly, no
// shell. The command is the Node that ran `enable`, by absolute path, not
// the bare word "node" -- Claude Code ships no Node of its own and a
// launcher's PATH is not guaranteed to have one on it either.
export function hookInvocation(execPath: string, indexPath: string): HookInvocation {
  return { command: execPath.replace(/\\/g, '/'), args: [indexPath, 'hook'] }
}

// The first two sentences are spec 005's "Disclosure" section, shown at the
// moment that discharges status.md item 9's obligation for capture: "before
// anyone outside the three of us is invited, and no later than the day a
// worker is deployed, they need to be told the environment can lose their
// data and that importing [or capturing] sends its contents to Anthropic."
// Both facts, two sentences, nothing softened.
//
// The next three sentences are spec 011 §9 (A15, task 14), added because
// "captured content is sent" on its own reads as "everything on this
// machine is sent" -- not true, and the gap matters enough to name: typed
// text, replies and tool names go; the files an agent reads and the
// commands it runs stay local *unless the agent's own reply quotes them
// back* (the one path by which their content can still leave, so the
// carve-out has to say so rather than imply a cleaner boundary than the
// hook actually draws); reasoning is never sent, full stop. The next
// sentence previews enable()'s own third question (task 13, spec 011 §8):
// "the next question" is literal, not rhetorical -- renderBootstrapList
// (bootstrap.ts) is the list it points at, printed immediately after this
// disclosure and the "y" it gates, before that question is ever asked.
//
// The sixth sentence, appended by task 14 (spec 012 §9): everything above
// was written back when this shim only ran under Claude Code, and reads as
// a Claude-Code-only account of what "captured content" even is on a
// machine where `capture enable` now also wires up Codex (task 10, spec 012
// §4.6). Named rather than implied, because a person enabling capture on a
// Codex-only machine has no other way to learn that the same four hooks
// exist there too, or that installing the Waku plugin instead is the other
// route to the same events (codexPluginPresent, this file's own enable()).
//
// This text names no vendor, on purpose, and spec 025 is why.
//
// It used to name Anthropic. So did nine other strings across two
// repositories -- both plugin manifests, SKILL.md, cli.ts's import
// disclosure, bootstrap.ts's confirm screen, the consent page, the privacy
// policy, and two copies of the prompt on /docs -- with nothing sharing
// them and three comments asking whoever came next to remember. Adding one
// embedding vendor meant editing ten strings, which is a list that was
// always going to end up partly stale, and a stale disclosure is worse
// than a general one.
//
// So a person is told the shape of what happens -- content leaves this
// machine, goes to us, goes on to providers who process it -- and pointed
// at the one document that names them and is kept current. The privacy
// policy's section 4 is that document; it lists every processor, and it is
// the only place a vendor name now belongs. plugin.test.mjs asserts this
// string carries the URL and names nobody, so the list cannot creep back.
export const DISCLOSURE =
  'Captured content is sent to our servers and on to the AI providers that turn it into ' +
  'memories and make them searchable; www.waku.one/privacy names them. ' +
  'This is an alpha whose data can be lost. ' +
  'What you type, what the agent replies, and the names of the tools it uses are sent; ' +
  'the files it reads and the commands it runs are not, except where the agent quotes them in its reply, ' +
  'and its reasoning is never sent. ' +
  'The folder the agent works in and its git repository\'s remote address are sent too, so memories are filed by project. ' +
  'Enabling can also import the memory and history Claude Code already keeps here; the next question lists exactly what. ' +
  'On Codex the same three hooks read ~/.codex/sessions, or the Waku plugin sends each turn as you go.'

// spec 068 D3: `full-record on`'s disclosure. It states the same facts as
// DISCLOSURE above, with two changes. It names what full record adds over
// the plugin, which already sends each prompt and final reply. It drops the
// import preview, because full-record on never asks the import question
// (`import` is its own command now). Names no vendor, for the reason given
// above DISCLOSURE; plugin.test.mjs checks this string too.
export const FULL_RECORD_DISCLOSURE =
  'Full record sends the whole session, not only your prompt and the final reply. ' +
  'What you type, all the text the agent writes, and the names of the tools it uses are sent. ' +
  'The files the agent reads and the commands it runs are not sent, except where the agent quotes them in its reply. ' +
  'The agent\'s reasoning is never sent. ' +
  'The folder the agent works in and its git repository\'s remote address are sent too, so memories are filed by project. ' +
  'All of it goes to our servers and on to the AI providers that turn it into memories and make them searchable; ' +
  'www.waku.one/privacy names them. ' +
  'This is an alpha whose data can be lost. ' +
  'On Codex, full record reads the same things from ~/.codex/sessions.'

// spec 068 D3: the two commands that install the hook. `capture` is
// `capture enable|disable`, kept as a hidden alias for one release and
// unchanged in every word. `full-record` is `full-record on|off`: the same
// install and removal, but it never touches the "Remember from
// conversations" switch (it is on by default, spec 068 D1), never asks the
// import question, and installs the hook beside the plugin instead of
// yielding to it (see enable()'s own comment, step 3 and step 7).
export type HookMode = 'capture' | 'full-record'

const MODE_WORDS: Record<HookMode, { command: string; notDone: string; done: string; offDone: string; notOn: string }> = {
  capture: {
    command: 'capture enable',
    notDone: 'Capture not enabled',
    done: 'Capture enabled',
    offDone: 'Capture disabled',
    notOn: 'Capture was not enabled here',
  },
  'full-record': {
    command: 'full-record on',
    notDone: 'Full record is not on',
    done: 'Full record is on',
    offDone: 'Full record is off',
    notOn: 'Full record was not on here',
  },
}

// spec 068 D3: where a person turns "Auto-save from conversations" on or off.
// The same address the server's own 403 names (capture.py INTEGRATIONS_URL).
export const INTEGRATIONS_URL = 'https://www.waku.one/integrations'

// spec 068 D3: after `full-record on`, one read of the switch -- GET /capture
// lists `harnesses[].enabled`. A harness whose switch is off gets one line,
// because full record sends nothing for it until the person turns it on.
// Best-effort and bounded: any failure (network, a non-2xx, a body of another
// shape, five seconds without an answer) prints nothing, since the install
// itself already succeeded and this line is advice. Reads only; the PUT
// stays capture enable's alone.
const SWITCH_READ_TIMEOUT_MS = 5_000
export async function reportSwitchesOff(
  fetchImpl: typeof fetch,
  ingestUrl: string,
  key: string,
  harnesses: Array<'claude_code' | 'codex'>,
): Promise<void> {
  if (harnesses.length === 0) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SWITCH_READ_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${ingestUrl.replace(/\/+$/, '')}/capture`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (!res.ok) return
    const body: unknown = await res.json()
    const rows = (body as { harnesses?: unknown } | null)?.harnesses
    if (!Array.isArray(rows)) return
    for (const harness of harnesses) {
      const row = rows.find((r) => r !== null && typeof r === 'object' && (r as { harness?: unknown }).harness === harness)
      if (row !== undefined && (row as { enabled?: unknown }).enabled === false) {
        console.log(
          `"Auto-save from conversations" is off for ${HARNESS_LABELS[harness]}, so full record sends nothing yet. ` +
            `Turn it on at ${INTEGRATIONS_URL}.`,
        )
      }
    }
  } catch {
    // Advice only -- see this function's own comment.
  } finally {
    clearTimeout(timer)
  }
}

// Exported so cli.ts's usage text can point at the same URL without a
// second copy of it drifting out of sync.
//
// www.waku.one, not waku-mem.vercel.app, which this was until 2026-09-01 --
// changed before the first npm publish rather than after, because `npx`
// ships a default and an installed user keeps it until they update. That is
// exactly how the API address became a cutover instead of an edit (spec
// 008): a string that reaches strangers is expensive to move afterwards and
// free to move now. tech.md calls the Vercel host an earlier one, kept and
// not retired; this is the product's own address.
export const KEYS_PAGE_URL = 'https://www.waku.one/account/keys'

// Shared by disable() and, since task 13, enable()'s own verify-fail
// refusal (controller ruling R14): both places are telling the user the
// exact same true thing -- a real credential is on disk even though this
// command did not finish -- so this is the one string, not two copies of it
// drifting apart the way the Codex refusal messages already warn against
// (see codexTomlRefusalMessage above).
function stillSavedMessage(configPath: string): string {
  return `Your API key is still saved at ${configPath}. Revoke it at ${KEYS_PAGE_URL} if you want to fully remove access.`
}

// The only mechanism this file trusts to write settings.json -- injected so
// the real one (cli.ts's atomicWriteJson, same-directory temp file + rename)
// can be passed in without capture.ts importing cli.ts back. capture.ts must
// never gain a second, hand-rolled writer for this file.
export type SettingsWriter = (path: string, data: ClaudeSettings) => void

// The credential decision (task 13, spec 012 §7, controller rulings
// R13/R14): what `capture enable` does about the first question, decided by
// cli.ts's dispatch() from `--login`/`--key`/neither and passed to enable()
// below as its own parameter (not a CaptureDeps field -- unlike deps.login,
// which is the *mechanism* enable() calls, this is the *choice* of whether
// and how to call it, and belongs with the other per-invocation arguments,
// not the environment).
//   - 'ask': no flag was given -- enable() asks the Sign-in question, unless
//     a usable key is already stored (R13).
//   - 'login': `--login` -- skip the question, go straight to deps.login().
//   - 'key': `--key <key>` -- skip the question and deps.login() both; the
//     key is already known.
export type Credential = { kind: 'ask' } | { kind: 'login' } | { kind: 'key'; key: string }

export type CaptureDeps = {
  claudeDir: string // e.g. ~/.claude -- its existence is the evidence Claude Code is installed
  settingsPath: string // e.g. ~/.claude/settings.json
  configDir: string // e.g. ~/.waku-memory -- where config.json (the credential) and the hook copy live
  hookSourceDir: string // the shim's own compiled dist/*.js -- installHookCopy's source; real: next to cli.ts's own compiled file (see cli.ts)
  version: string // real: SHIM_VERSION (hook.ts) -- the directory installHookCopy copies into and pruneHookCopies keeps
  execPath: string // the Node that ran enable, by absolute path; real: process.execPath
  verifyHook: (run: HookInvocation) => boolean // real: spawns run once with a throwaway event and checks it exits 0
  prompt: (question: string) => Promise<string> // real: node:readline, asked visibly; see cli.ts
  writeSettingsJson: SettingsWriter // real: cli.ts's atomicWriteJson
  fetchImpl: typeof fetch // real: globalThis.fetch -- runBootstrap's own network calls (task 13, spec 011 §8)
  // The third question, spec 011 §8: null means --all (every transcript,
  // watermarks ignored); a number is the window in days (DEFAULT_WINDOW_DAYS
  // in real use). `enabled: false` is `--no-bootstrap` (task 14 wires both
  // flags) -- skips the scan and the question entirely, asking exactly the
  // two questions capture v1 always asked.
  // `answer` is --answer's raw text: the answer to "> " given on the command
  // line, so an agent can import what the person chose without a terminal.
  // `list` is --list: the list id the answer was given for (see listId).
  bootstrap: { windowDays: number | null; enabled: boolean; answer?: string; list?: string }
  // Whether a person can still type an answer: stdin is a terminal and has
  // not closed. Real: cli.ts's withTerminalPrompt. chooseImport reads it
  // before and after "> ", and sends nothing when it is false.
  answerable: () => boolean

  // Codex (task 10, spec 012 §4.6): detected the same way claudeDir is --
  // the path's existence is the evidence Codex is installed. All four are
  // real paths under the user's home directory in cli.ts's realCaptureDeps;
  // capture.test.mjs points them at a temp dir instead.
  codexConfigPath: string // ~/.codex/config.toml -- the [mcp_servers.waku] table
  codexHooksPath: string // ~/.codex/hooks.json -- the four hook entries
  codexPluginsCacheDir: string // ~/.codex/plugins/cache -- codexPluginPresent's second detection route
  marketplacePath: string // ~/.agents/plugins/marketplace.json -- the personal marketplace entry
  // spec 024 §4: where Claude Code caches an installed plugin --
  // ~/.claude/plugins/cache/<marketplace>/<plugin>. claudePluginPresent's
  // second detection route, beside settings.json's enabledPlugins.
  claudePluginsCacheDir: string
  // Fix round 1 (spec 012 §4.2): the MCP endpoint (https://api.waku.one/mcp
  // by default) -- what cli.ts's setup writes into Claude Code's own
  // ~/.claude.json and what the Codex TOML's [mcp_servers.waku] table must
  // carry, as distinct from `url` (enable()'s/config.json's own parameter),
  // which is the ingest base hook.ts's endpointUrl() appends its own path
  // segments onto and would double up on a "/mcp" suffix.
  mcpUrl: string
  // Real: cli.ts's atomic same-directory-temp-plus-rename writer, generalised
  // to `unknown` -- capture.ts has no more opinion about CodexHooksFile vs
  // MarketplaceFile than writeSettingsJson above has about ClaudeSettings.
  // Two writers rather than one SettingsWriter-shaped one because the TOML
  // table is text, not JSON: writeText writes exactly the string it is
  // given (no JSON.stringify, no added newline -- mergeCodexToml's `text`
  // is already the complete file), while writeJsonFile serialises the way
  // atomicWriteJson always has.
  writeText: (path: string, text: string) => void
  writeJsonFile: (path: string, data: unknown) => void

  // Task 13 (spec 012 §7): the browser sign-in flow (login.ts's login()),
  // called right where a pasted key used to be asked for unconditionally --
  // see enable()'s own resolveCredential/runLogin below. Real: cli.ts's
  // `() => login(realLoginDeps(ingestUrl))`.
  login: () => Promise<LoginResult>
}

// Reads settings.json the same way applyToHarness (cli.ts) reads a harness
// config: missing or blank is a blank slate (undefined here would wrongly
// refuse the single most common first run -- no settings.json yet at all);
// anything non-blank that fails to parse, or does not parse to a plain
// object, is real corruption and returns undefined so the caller refuses
// rather than risks merging into -- and later overwriting -- a file it
// could not understand.
export function readClaudeSettings(settingsPath: string): ClaudeSettings | undefined {
  let raw: string
  try {
    raw = readFileSync(settingsPath, 'utf8')
  } catch {
    return {}
  }
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as ClaudeSettings
  } catch {
    return undefined
  }
}

// Reads ~/.codex/hooks.json the same way readClaudeSettings above reads
// settings.json: missing or blank is a blank slate (a fresh machine, or one
// where Codex itself has no hooks.json yet); anything non-blank that fails
// to parse, or does not parse to a plain object, is real corruption and
// returns undefined so enable() refuses rather than risks merging into --
// and overwriting -- a file it could not understand.
export function readCodexHooksFile(path: string): CodexHooksFile | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as CodexHooksFile
  } catch {
    return undefined
  }
}

// Reads ~/.agents/plugins/marketplace.json. Missing or blank is `undefined`.
// A file that does not parse is 'invalid'. enable() writes no entry into
// this file since 0.15.0. It only takes out the entry that earlier versions
// wrote (removeOldNpmEntry), so it leaves an invalid file alone and goes on.
function readMarketplaceFile(path: string): MarketplaceFile | undefined | 'invalid' {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  if (raw.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'invalid'
    return parsed as MarketplaceFile
  } catch {
    return 'invalid'
  }
}

// Ours if any group under any event is entirely ours -- mirrors isOwnGroup
// above, but over CodexHooksFile/isOwnCodexEntry: status() (below) needs to
// answer "did we write this file" without codex-config.ts having to export
// its own private isOwnCodexGroup.
function hasOwnCodexHooks(file: CodexHooksFile): boolean {
  if (!file.hooks) return false
  return Object.values(file.hooks).some((groups) => groups.some((g) => g.hooks.length > 0 && g.hooks.every(isOwnCodexEntry)))
}

// The one place that writes config.json -- enable() below (a pasted key)
// and, since task 12, login.ts (a minted one) both funnel through here so
// the file's shape and its permissions never drift between the two paths.
// {mode: 0o600} is a request, not a guarantee: Windows has no POSIX
// owner-only bit for writeFileSync to set, so this line is best-effort
// there and fully effective on Unix. Correct to pass on every platform
// regardless -- harmless where it cannot apply, the right thing where it
// can. Not routed through atomicWriteJson: that writer has no mode
// parameter, and this file is small, freshly created, and not something
// Claude Code itself reads concurrently the way settings.json is -- the
// atomic temp-file-plus-rename technique earns its complexity there, not
// here.
export function writeConfigJson(configDir: string, config: { url: string; key: string }): void {
  mkdirSync(configDir, { recursive: true }) // first run: ~/.waku-memory may not exist yet
  const configPath = join(configDir, CONFIG_FILE_NAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

// Human-readable labels for the two harnesses this file posts consent for --
// printed for the person (disable()'s "turned off on the server" line),
// never sent over the wire (postConsent's own `harness` parameter is the
// wire value). Mirrors capture.py's HARNESS_LABELS
// (apps/api/src/waku_api/capture.py) without importing it -- this is a shim
// file, with no import across the repo boundary.
const HARNESS_LABELS: Record<'claude_code' | 'codex', string> = { claude_code: 'Claude Code', codex: 'Codex' }

// spec 024 §2: the shim's door onto consent. Posted after the person types
// "y" and before any hook entry is written, so a machine never holds hooks
// whose every Stop would be refused. The key is the person's own, minted by
// their login; a "y" in their terminal is the gesture spec 005 accepts.
export async function postConsent(
  fetchImpl: typeof fetch,
  ingestUrl: string,
  key: string,
  harness: 'claude_code' | 'codex',
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; status: number | null; message: string }> {
  const target = `${ingestUrl.replace(/\/+$/, '')}/capture/${harness}`
  try {
    const res = await fetchImpl(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ enabled }),
    })
    if (res.ok) return { ok: true }
    return { ok: false, status: res.status, message: `/capture/${harness} responded ${res.status}` }
  } catch (err) {
    return { ok: false, status: null, message: `PUT /capture/${harness} failed -- ${err instanceof Error ? err.message : String(err)}` }
  }
}

// 'bad-answer' (2026-11-20): an --answer that does not fit the list, or a
// missing or different --list. Nothing is written.
export type EnableResult = 'enabled' | 'declined' | 'refused' | 'bad-answer'

// Only printable ASCII can be part of a bearer key. Non-printable
// characters at either *end* came from the terminal, not the person: on
// 2026-09-04 a Windows console delivered Ctrl+V's own control code (0x16)
// ahead of the key, `.trim()` left it in place, and every hook call then
// failed with an opaque "fetch failed" (undici refusing the Authorization
// header). Whitespace and non-ASCII (an IME's full-width space, say) are
// stripped from the ends for the same reason.
//
// Anything non-printable left *inside* is a different thing: the paste
// held more than the key ("Bearer mem_sk_..."), and stripping it would
// glue two tokens into one wrong key that looks right -- the 0.1.1 review
// reproduced exactly that, with the next hook's 401 landing in a
// background process nobody watches. So the interior count is returned,
// not repaired, and askForKey refuses on it.
export function sanitizeKey(raw: string): { key: string; removed: number; interior: number } {
  const printable = (c: string): boolean => {
    const code = c.charCodeAt(0)
    return code >= 0x21 && code <= 0x7e
  }
  const chars = [...raw]
  let start = 0
  let end = chars.length
  while (start < end && !printable(chars[start])) start++
  while (end > start && !printable(chars[end - 1])) end--
  const kept = chars.slice(start, end)
  return {
    key: kept.join(''),
    removed: chars.length - kept.length,
    interior: kept.filter((c) => !printable(c)).length,
  }
}

const KEY_ATTEMPTS = 3

// What every key minted at KEYS_PAGE_URL starts with (api_key_repository.py:
// PREFIX + token_urlsafe(32)). A key without it is warned about, not
// refused: the server's opinion is the only one that counts, and a refusal
// here would make a future prefix change strand every user on this shim.
const KEY_PREFIX = 'mem_sk_'

// The sanitizeKey checks and their messages, factored out of askForKey so
// resolveCredential's `--key` path (fix round 1, finding 3) can apply the
// exact same rules to a key that arrived on the command line instead of
// through a prompt: a flag is not "typed", but it crosses a shell boundary
// the same way a paste crosses a terminal one, and it is exactly as capable
// of carrying a leading Ctrl+V byte or a "Bearer " prefix pasted by
// mistake -- a flag used to skip these checks entirely (finding 3's bug).
// `printEmptyHint` exists only to match askForKey's own choice to suppress
// the "paste it again" hint on its last attempt (no more attempts are
// coming); every one-shot caller (the `--key` path) passes false for the
// same reason -- there is no re-ask to hint toward. No branch below ever
// prints the key or any part of it -- counts and a prefix only.
function checkPastedKey(raw: string, printEmptyHint: boolean): string | null {
  const { key, removed, interior } = sanitizeKey(raw)
  if (interior > 0) {
    console.log(
      `The pasted text has ${interior} character(s) inside it that cannot be part of a key -- ` +
        `more than the key was pasted. Paste the key itself, nothing else.`,
    )
    return null
  }
  if (key === '') {
    if (printEmptyHint) {
      console.log('That did not contain a usable key -- paste the key itself, nothing else.')
    }
    return null
  }
  if (removed > 0) {
    console.log(
      `Removed ${removed} non-printable character(s) from the ends of the pasted key -- ` +
        `a terminal can add Ctrl+V's own code ahead of what it pastes.`,
    )
  }
  if (!key.startsWith(KEY_PREFIX)) {
    console.log(
      `Note: the key does not start with ${KEY_PREFIX}, which every key minted at ${KEYS_PAGE_URL} does. ` +
        `Saving it as pasted; if the hook reports 401, run this command again with a fresh key.`,
    )
  }
  return key
}

// Asks up to KEY_ATTEMPTS times. null means the person never pasted anything
// usable, and enable() then ends with the same "nothing was written"
// guarantee that declining the disclosure carries.
async function askForKey(deps: CaptureDeps): Promise<string | null> {
  for (let attempt = 1; attempt <= KEY_ATTEMPTS; attempt++) {
    const raw = await deps.prompt(`Paste an API key from ${KEYS_PAGE_URL} (it is shown once, at mint time): `)
    const key = checkPastedKey(raw, attempt < KEY_ATTEMPTS)
    if (key !== null) return key
  }
  return null
}

// The Sign-in choice (spec 012 §7, controller ruling R13): the first thing
// enable() asks once the disclosure gate is past, whenever `credential` is
// { kind: 'ask' } and config.json holds no usable key yet (readStoredKey
// below). Verbatim -- capture.test.mjs and cli.test.mjs's usage text both
// depend on this exact string, so a wording change here is a break of that
// contract, not a cosmetic edit.
export const SIGN_IN_QUESTION = 'Sign in [1] in the browser (recommended) [2] by pasting a key: '

// Same "stop pestering the person" budget askForKey's own KEY_ATTEMPTS
// gives a pasted key -- an answer that is neither "1" nor "2" three times
// running is treated the same as declining outright.
const SIGN_IN_ATTEMPTS = 3

// Reads just the `key` field out of config.json, the way hook.ts's own
// readConfig reads {url, key} for the hook's real network calls: a
// non-empty string or nothing usable at all (missing file, malformed JSON,
// a `key` that is absent, empty, or not a string) -- R13's "already holds a
// usable key" test, and runLogin's own read-back of what deps.login() just
// wrote. Never prints what it finds.
function readStoredKey(configDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, CONFIG_FILE_NAME), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      const key = (parsed as { key?: unknown }).key
      if (typeof key === 'string' && key.length > 0) return key
    }
  } catch {
    // Missing, unreadable, or not valid JSON -- no stored key.
  }
  return null
}

// What resolveCredential/runLogin below hand back to enable(): the key to
// write, and whether it is already on disk. `skipWriteConfig` is true only
// when the key came from a successful deps.login() call -- login.ts's own
// login() already calls writeConfigJson itself the moment it reaches
// 'signed-in' (the same function enable() calls for a pasted key), so
// enable() must not write it a second time, and a later verifyHook failure
// must not claim "nothing was written" (controller ruling R14) when this is
// true -- see both use sites in enable() below. 'refused' (fix round 1,
// finding 2) is distinct from 'declined': the person did sign in, but
// config.json came back unreadable -- a bug, not a choice -- so enable()
// must not fold it into the ordinary "you declined" wording, and must not
// proceed with an empty key either (that is exactly what used to happen
// here, silently: `key: key ?? ''`).
type CredentialResolution = { key: string; skipWriteConfig: boolean } | 'declined' | 'refused'

// deps.login() is login.ts's login(): it already wrote config.json itself
// by the time it returns 'signed-in' (writeConfigJson, sanitizeKey -- both
// this file's own), so the key is read back here rather than threaded
// across the deps boundary a second way. A non-'signed-in' result
// ('timeout' or 'refused') means login() never reached that write --
// nothing is on disk, and the one sentence R14 gives verbatim is accurate.
// A 'signed-in' result whose key cannot be read back -- config.json is
// missing, unreadable, malformed, or its `key` field is empty or not a
// string; see readStoredKey -- is a refusal, not a silent empty-key
// continue: fix round 1 finding 2 found the old code here (`key: key ??
// ''`) letting enable() sail on through installHookCopy/verifyHook/
// writeSettingsJson with no working credential on disk and nothing printed.
async function runLogin(deps: CaptureDeps, notDone: string): Promise<CredentialResolution> {
  const result = await deps.login()
  if (result !== 'signed-in') {
    console.log(`${notDone} -- sign-in did not complete; nothing was written.`)
    return 'declined'
  }
  const key = readStoredKey(deps.configDir)
  if (key === null) {
    const configPath = join(deps.configDir, CONFIG_FILE_NAME)
    console.error(`Signed in, but the key could not be read back from ${configPath} -- nothing else was written.`)
    return 'refused'
  }
  return { key, skipWriteConfig: true }
}

// The credential decision itself (controller rulings R13/R14). `credential`
// is enable()'s own third parameter, not a CaptureDeps field -- see
// Credential's own comment for why -- and is `undefined` only for the
// legacy call shape every enable() call predating task 13 used (a bare
// `enable(url, deps)`, still exactly what every test written before this
// task passes): that path is untouched, byte for byte, from what askForKey
// alone did before this function existed, which is what keeps those tests
// green without editing a single one of them.
//   - undefined: ask for a pasted key directly (askForKey, unchanged).
//   - { kind: 'key' }: nothing is asked, but the value still goes through
//     checkPastedKey (fix round 1, finding 3) -- a flag is not typed, but it
//     is exactly as capable of carrying a stray leading byte or an empty
//     string as a paste is, and it used to skip validation entirely.
//   - { kind: 'login' }: deps.login() runs immediately -- nothing is asked.
//   - { kind: 'ask' }: a stored, usable key short-circuits everything with
//     one line and no question (R13); otherwise the Sign-in choice is
//     asked, up to SIGN_IN_ATTEMPTS times, and "1"/"2" branch into
//     login()/askForKey() respectively. A third invalid answer declines,
//     the same shape askForKey's own attempts loop already has.
//
// spec 068 D3: `notDone` is the first half of every "nothing happened"
// sentence below. capture enable keeps its own "Capture not enabled"; import
// and full-record on pass their own, so neither prints the word "capture".
async function resolveCredential(
  deps: CaptureDeps,
  credential: Credential | undefined,
  notDone: string = 'Capture not enabled',
): Promise<CredentialResolution> {
  if (credential === undefined) {
    const key = await askForKey(deps)
    if (key === null) {
      console.log(`${notDone} -- no usable key was entered; nothing was written.`)
      return 'declined'
    }
    return { key, skipWriteConfig: false }
  }

  if (credential.kind === 'key') {
    // No re-ask: a flag is not interactive, so a bad --key declines
    // outright (printEmptyHint: false) instead of prompting for another one.
    const key = checkPastedKey(credential.key, false)
    if (key === null) {
      console.log(`${notDone} -- no usable key was entered; nothing was written.`)
      return 'declined'
    }
    return { key, skipWriteConfig: false }
  }

  if (credential.kind === 'login') {
    return runLogin(deps, notDone)
  }

  // credential.kind === 'ask'
  const stored = readStoredKey(deps.configDir)
  if (stored !== null) {
    console.log(`Using the key already stored in ${deps.configDir}/${CONFIG_FILE_NAME}.`)
    return { key: stored, skipWriteConfig: false }
  }

  for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt++) {
    const answer = (await deps.prompt(SIGN_IN_QUESTION)).trim()
    if (answer === '1') return runLogin(deps, notDone)
    if (answer === '2') {
      const key = await askForKey(deps)
      if (key === null) {
        console.log(`${notDone} -- no usable key was entered; nothing was written.`)
        return 'declined'
      }
      return { key, skipWriteConfig: false }
    }
    if (attempt < SIGN_IN_ATTEMPTS) console.log('Enter 1 or 2.')
  }
  console.log(`${notDone} -- no valid answer was given; nothing was written.`)
  return 'declined'
}

// A parsed BootstrapAnswer still carries `invalid`; runBootstrap's own
// BootstrapSelection does not (its three real outcomes are `all`, `skip` and
// `exclude`) -- chooseImport's own re-ask loop below is where a
// still-invalid second answer becomes `skip`, so by the time this is called
// that case has already been decided; this is a plain, total mapping, never
// itself a decision point.
function toSelection(answer: BootstrapAnswer): BootstrapSelection {
  if (answer.kind === 'exclude') return { kind: 'exclude', numbers: answer.numbers }
  if (answer.kind === 'all') return { kind: 'all' }
  return { kind: 'skip' } // 'skip', or a still-invalid second answer
}

// The third question, spec 011 §8: asks '> ' once, and on an invalid answer
// prints the one-line hint and asks once more -- a second invalid answer is
// treated as skip rather than asked a third time, the same "stop pestering
// the person" reasoning A12's own parseBootstrapAnswer comment gives for
// only ever re-asking once.
//
// 2026-11-20 (Yang): nobody answering is no longer Enter. The console's setup
// prompt had the person's agent run `npx -y waku-memory import`; the agent's
// shell gives the shim no terminal, the read came back empty, and an empty
// answer imported every project, every agent's folder and every skill before
// the person saw the list. Now `--answer` (the same text a person would type,
// or "all" for Enter) answers without a terminal, and with neither a
// terminal nor --answer, or when the terminal's input closes before an
// answer (Ctrl-D), nothing is sent and the list is followed by
// unansweredMessage's instructions. Enter at a real terminal still imports
// everything, as the list's last line says.
//
// The numbers in an --answer point into a list an earlier run printed, and
// the list can change in between: a session that was still live joins it,
// and projects are ordered by size. So that run prints a list id (listId),
// and an --answer other than n is taken only with `--list <id>` matching the
// list scanned now. The id travels with the answer, so another run in
// between (a second agent, a rerun) cannot make an old answer fit a new
// list. A missing or different id sends nothing and prints the new list and
// its id. The id is checked before the answer's numbers, so a changed list
// is always reported as changed. `--answer n` needs no id: it sends nothing.
type ImportChoice = BootstrapSelection | { kind: 'unanswered' } | { kind: 'bad-answer' } | { kind: 'list-changed' }

// A scan and the minute it was taken at. A run with --list scans again at
// the minute in that id (importScan), so a session that crossed the
// ten-minute live mark since the first run stays out, as it was then.
type ImportScan = { scan: Scan; anchorMs: number }

const MINUTE_MS = 60_000
// How old a list id may be. An older one counts as a changed list.
const LIST_ID_MAX_AGE_MS = 24 * 60 * MINUTE_MS

// The list id: "L", eight hex characters of sha256, "-", and the scan's
// minute in base 36, e.g. "L7c3e9a1f-hn3x2k". The leading letter keeps a
// shell such as PowerShell from reading the id as a number. The hash covers
// everything an answer can refer to: the window, the minute, each numbered
// project in order with its session files and memory files (CLAUDE.local.md
// is one of them), the user CLAUDE.md, and the skills' files.
export function listId(scan: Scan, windowDays: number | null, anchorMs: number): string {
  const canonical = {
    windowDays,
    anchorMs,
    projects: scan.projects.map((p) => ({
      harness: p.harness,
      slug: p.slug,
      name: p.name,
      sessions: p.sessions.map((s) => s.path),
      memoryFiles: p.memoryFiles,
    })),
    claudeMd: scan.userClaudeMd?.path ?? null,
    skills: (scan.skills ?? []).map((s) => s.path).sort(),
  }
  const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 8)
  return `L${hash}-${(anchorMs / MINUTE_MS).toString(36)}`
}

// The minute a list id was scanned at, or null when the id is malformed, in
// the future, or older than LIST_ID_MAX_AGE_MS. Null counts as a changed list.
export function anchorFromListId(list: string, nowMs: number): number | null {
  const match = /^l[0-9a-f]{8}-([0-9a-z]{1,9})$/.exec(list.trim().toLowerCase())
  if (!match) return null
  const anchorMs = Number.parseInt(match[1], 36) * MINUTE_MS
  if (!Number.isSafeInteger(anchorMs) || anchorMs > nowMs || nowMs - anchorMs > LIST_ID_MAX_AGE_MS) return null
  return anchorMs
}

// The person's three choices, in the order the setup prompt names them.
function answerOptions(projectCount: number): string[] {
  const options: Array<[string, string]> = [
    ['--answer all', 'imports everything on the list.'],
    ['--answer n', 'imports nothing.'],
  ]
  if (projectCount === 1) options.push(['--answer 1', 'imports everything except project 1.'])
  if (projectCount > 1) options.push(['--answer "1 2"', 'imports everything except projects 1 and 2.'])
  const width = Math.max(...options.map(([flag]) => flag.length))
  return options.map(([flag, what]) => `  ${flag.padEnd(width)}  ${what}`)
}

function askLine(projectCount: number, again: boolean): string {
  const ask = again ? 'Ask them again whether to import' : 'Ask them whether to import'
  return projectCount === 0
    ? `${ask} all of it or none of it.`
    : `${ask} all of it, none of it, or all except some of the numbered projects.`
}

function rerunLine(id: string): string {
  return `Then run the same command again with --list ${id} and one of these answers:`
}

// Printed after the list and its id when nobody answered. The reader is
// usually an agent, so it says what to ask and which flags carry the reply.
export function unansweredMessage(projectCount: number, id: string): string {
  return [
    'Nothing was imported, because nobody typed an answer.',
    'Show the person the list above.',
    askLine(projectCount, false),
    rerunLine(id),
    ...answerOptions(projectCount),
  ].join('\n')
}

// Printed after the current list and its id when an --answer came without
// --list (`missing`), or with the id of a different list.
export function listChangedMessage(projectCount: number, id: string, missing: boolean): string {
  return [
    missing
      ? 'Nothing was imported, because the command has no --list.'
      : 'Nothing was imported, because the list changed since the person saw it.',
    missing ? 'Show the person the list above.' : 'Show the person the new list above.',
    askLine(projectCount, !missing),
    rerunLine(id),
    ...answerOptions(projectCount),
  ].join('\n')
}

export function badAnswerMessage(given: string, projectCount: number): string {
  const fits =
    projectCount === 0 ? 'all or n' : projectCount === 1 ? 'all, n, or 1' : `all, n, or project numbers from 1 to ${projectCount}`
  return `Nothing was imported, because --answer "${given}" is not ${fits}.`
}

// --answer (and --list) against the list just scanned. It prints nothing and
// writes nothing, so enable() can check it before its disclosure; the caller
// prints `message` after the list.
function resolveGivenAnswer(
  { scan, anchorMs }: ImportScan,
  given: string,
  list: string | undefined,
  windowDays: number | null,
): BootstrapSelection | { kind: 'bad-answer' | 'list-changed'; message: string } {
  const projectCount = scan.projects.length
  const text = given.trim()
  if (text === 'n' || text === 'N') return { kind: 'skip' }
  const id = listId(scan, windowDays, anchorMs)
  if (list?.trim().toLowerCase() !== id.toLowerCase()) {
    return { kind: 'list-changed', message: `List id: ${id}\n\n${listChangedMessage(projectCount, id, list === undefined)}` }
  }
  const answer =
    text === '' ? ({ kind: 'invalid' } as const) : parseBootstrapAnswer(text.toLowerCase() === 'all' ? '' : text, projectCount)
  if (answer.kind === 'invalid') return { kind: 'bad-answer', message: badAnswerMessage(given, projectCount) }
  return toSelection(answer)
}

async function chooseImport(imported: ImportScan, deps: CaptureDeps): Promise<ImportChoice> {
  const { scan, anchorMs } = imported
  const projectCount = scan.projects.length
  const { answer: given, list, windowDays } = deps.bootstrap
  if (given !== undefined) {
    const resolved = resolveGivenAnswer(imported, given, list, windowDays)
    if ('message' in resolved) {
      console.log(resolved.message.startsWith('List id:') ? resolved.message : `\n${resolved.message}`)
      return { kind: resolved.kind }
    }
    return resolved
  }

  const unanswered = (): ImportChoice => {
    const id = listId(scan, windowDays, anchorMs)
    console.log(`List id: ${id}`)
    console.log('')
    console.log(unansweredMessage(projectCount, id))
    return { kind: 'unanswered' }
  }
  if (!deps.answerable()) return unanswered()
  let answer = parseBootstrapAnswer(await deps.prompt('> '), projectCount)
  if (!deps.answerable()) return unanswered()
  if (answer.kind === 'invalid') {
    console.log('Enter, numbers, or n.')
    answer = parseBootstrapAnswer(await deps.prompt('> '), projectCount)
    if (!deps.answerable()) return unanswered()
  }
  return toSelection(answer)
}

// The import's scan (spec 011 §8, widened by spec 012 §8 and 031), shared by
// enable()'s step 10 and, since spec 068 D3, importHistory() below.
// task 11 (spec 012 §8): scanAll(null, ...) / scanAll(..., null) means
// "this harness is not on this machine" -- the same evidence
// (claudeDirExists / codexConfigExists) enable() already uses to decide
// whether to touch each harness's own config at all.
function scanForImport(
  deps: CaptureDeps,
  claudeDirExists: boolean,
  codexConfigExists: boolean,
  windowDays: number | null,
  nowMs: number,
): Scan {
  const stateDir = join(deps.configDir, 'state')
  // ~/.cursor is a sibling of ~/.claude; its existence is the evidence Cursor
  // is installed, the same test claudeDir/codexConfigPath already use. Only
  // its authored skills (skills-cursor/) are scanned -- Cursor has no
  // sessions or memory files here.
  const cursorDir = join(dirname(deps.claudeDir), '.cursor')
  // ~/.hermes is a sibling of ~/.claude; its existence is the evidence Hermes
  // is installed (031), the same test cursorDir uses. It contributes its
  // authored docs and skills, no sessions.
  const hermesDir = join(dirname(deps.claudeDir), '.hermes')
  // The Waku agent (031 task 3): WAKU_HOME when set, else ~/.waku -- one
  // place, never a disk walk. It contributes its fact files and skills.
  const wakuDir = wakuHomeDir(process.env, dirname(deps.claudeDir))
  // spec 073 D10: Gemini CLI's ~/.gemini and Windsurf's ~/.codeium/windsurf,
  // siblings of ~/.claude like the three above.
  const geminiDir = join(dirname(deps.claudeDir), '.gemini')
  const windsurfDir = join(dirname(deps.claudeDir), '.codeium', 'windsurf')
  return scanAll(
    claudeDirExists ? deps.claudeDir : null,
    codexConfigExists ? dirname(deps.codexConfigPath) : null,
    existsSync(cursorDir) ? cursorDir : null,
    existsSync(hermesDir) ? hermesDir : null,
    stateDir,
    {
      nowMs,
      sinceMs: windowDays === null ? 0 : nowMs - windowDays * 86_400_000,
      liveWindowMs: LIVE_WINDOW_MS,
      all: windowDays === null,
    },
    existsSync(wakuDir) ? wakuDir : null,
    existsSync(geminiDir) ? geminiDir : null,
    existsSync(windsurfDir) ? windsurfDir : null,
  )
}

// The import's scan at a whole minute. With --answer and a --list whose
// minute is valid, it scans at that minute first, and keeps that scan when
// it still has the id: the list the person saw, measured against the files
// on disk now. Otherwise it scans at the current minute, so a changed list
// prints with a fresh id. A file modified after the id's minute counts as
// live in that scan, so it stays out exactly as it did in the first run.
function importScan(deps: CaptureDeps, claudeDirExists: boolean, codexConfigExists: boolean): ImportScan {
  const { windowDays, answer, list } = deps.bootstrap
  const nowMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS
  const anchorMs = answer !== undefined && list !== undefined ? anchorFromListId(list, nowMs) : null
  if (anchorMs !== null) {
    const scan = scanForImport(deps, claudeDirExists, codexConfigExists, windowDays, anchorMs)
    if (listId(scan, windowDays, anchorMs).toLowerCase() === list!.trim().toLowerCase()) return { scan, anchorMs }
  }
  return { scan: scanForImport(deps, claudeDirExists, codexConfigExists, windowDays, nowMs), anchorMs: nowMs }
}

// Whether a scan is worth the "> " question -- the condition enable() has
// always used, kept in one place now that importHistory() asks it too.
// 2026-11-20: skills count too. A machine with skills and nothing else
// printed its list and then stopped without asking, so its skills were never
// sent; runBootstrap sends them on any answer but n.
function hasImportQuestion(scan: Scan): boolean {
  return scan.projects.length > 0 || scan.userClaudeMd !== null || (scan.skills ?? []).length > 0
}

// Sends what the person selected and prints the one counts line. Shared by
// enable()'s step 10 and importHistory().
async function sendImport(
  scan: Scan,
  selection: BootstrapSelection,
  url: string,
  key: string,
  deps: CaptureDeps,
  windowDays: number | null,
): Promise<void> {
  const result = await runBootstrap(scan, selection, {
    url,
    key,
    fetchImpl: deps.fetchImpl,
    stateDir: join(deps.configDir, 'state'),
    all: windowDays === null,
  })
  let line = `${result.memoryFiles} memory files`
  if (result.skills > 0) line += `, ${result.skills} skills`
  line += ` queued, ${result.sessions} sessions queued in ${result.pieces} pieces`
  if (result.failed > 0) line += `, ${result.failed} failed`
  console.log(line)
}

// The Codex TOML refusal, worded the same way harnesses.ts's mergeMcpConfig
// refuses a conflicting Claude Code entry (its own comment there: "someone
// configured this by hand ... silently replacing it would undo a deliberate
// choice with no trace"). mergeCodexToml's 'refused' result does not carry
// the conflicting url back (only the unchanged text), so this cannot name it
// the way mergeMcpConfig's thrown message does -- naming the table and the
// file it lives in is the closest equivalent.
function codexTomlRefusalMessage(codexConfigPath: string): string {
  return (
    `[mcp_servers.waku] in ${codexConfigPath} is already configured with a different URL. ` +
    `Remove it or edit the file by hand.`
  )
}

// The one gesture that turns capture on. Order is deliberate and each step
// depends on the one before it having succeeded:
//   1. refuse if neither harness is on this machine -- Claude Code's
//      directory or Codex's config.toml is the evidence, the shim's own
//      edit-don't-create rule adapted from cli.ts's harness handling. Widened
//      from "Claude Code only" (spec 012 §4/§4.6, task 10): a Codex-only
//      machine is now a real target, not a refusal.
//   2. when claudeDir exists, refuse if the existing settings.json cannot be
//      safely read -- checked here, before the disclosure, so a machine this
//      can never work on fails fast instead of making the user type through
//      a consent flow first only to hit a wall at the end. Skipped
//      altogether on a Codex-only machine: there is no settings.json to
//      protect.
//   3. when codexConfigPath exists, detect the plugin (codexPluginPresent).
//      If it is not there, compute the TOML merge (mergeCodexToml) and read
//      hooks.json -- all before the disclosure, for the
//      same reason as step 2: a refusal (a foreign [mcp_servers.waku] table,
//      or a hooks.json that does not parse) must cost the user nothing and write
//      nothing, exactly like a Claude Code refusal. If the plugin *is*
//      there, none of this runs: it already carries the hooks and the MCP
//      server, so writing our own beside it would be redundant at best and a
//      second, conflicting route to the same events at worst -- the plugin
//      wins, and step 8 below prints that instead of touching either file.
//      Instead, compute removeCodexToml(tomlText, deps.mcpUrl) (bug fix
//      against a gap spec 012 §4.6 left open: it only covers plugin-then-
//      enable, and a machine enabled before the plugin arrived is left
//      carrying both forever) -- 'nothing' whenever there is no table of
//      ours to remove (none at all, someone else's url, or one a person
//      edited), computed here for step 8 to act on the same "decide before
//      consent, write after" way codexTomlMerge already does;
//   4. print the disclosure and demand a typed "y" -- before anything else,
//      including asking for the key, so declining costs the user nothing
//      and asks for nothing;
//   5. only then resolve the credential -- the Sign-in question, deps.login(),
//      askForKey, or the already-known --key value, decided by `credential`
//      (task 13, spec 012 §7, resolveCredential's own comment has the full
//      decision table);
//   6. install a local copy of the shim under configDir/hook/<version> and
//      run it for real -- verifyHook -- before anything is wired into
//      settings.json. A copy that does not even start (a corrupted copy, a
//      Node too old for it, ...) must never become the thing Claude Code
//      calls on every turn, so a failed verification removes the copy this
//      call made under configDir/hook/<version> (and configDir/hook itself,
//      if that copy was the only thing under it) and refuses right here,
//      before config.json or settings.json is ever touched. A refusal
//      removes only a copy this call made, though: installHookCopy is a
//      no-op when hookSourceDir already *is* configDir/hook/<version> --
//      enable running from inside the copy already installed there, which
//      is what hookSourceDir (derived from the running cli.js's own
//      import.meta.url) gives once a copy is in place -- and then this call
//      installed nothing, so a failed verification leaves that directory
//      alone: it may be the very copy settings.json still points at from an
//      earlier, successful enable, and it is not this call's to delete.
//      installHookCopy's mkdirSync(..., { recursive: true }) creates every
//      ancestor directory on the way down, though, so the one thing a
//      first-ever run can still leave behind after refusing here is an
//      empty configDir -- not removed, since it is the config directory
//      itself, not anything this step wrote into it;
//   7. write config.json, then (when claudeDir exists) merge and write
//      settings.json with the now-verified invocation. Everything before
//      this point (refusing, declining, a failed verification) writes
//      nothing new to disk -- step 6's own cleanup is what makes that true
//      when a failed verification follows a real copy, down to the
//      empty-configDir exception described there; when installHookCopy was
//      instead a no-op, this call had nothing of its own to remove, and the
//      pre-existing copy it leaves in place was never new. This step itself
//      is not atomic across the two files, though: config.json is committed
//      to disk first, so a failure on the settings.json write right after --
//      disk full, a permission error -- does leave a real credential saved
//      with no hook actually installed, i.e. capture silently not active
//      despite config.json existing. Accepted rather than guarded against
//      (no rollback, no pre-write dry run): the failure still propagates out
//      of enable() to cli.ts's runCaptureCommand, which reports it and sets
//      a nonzero exit code, so it is not silent; it fails toward "capture
//      not enabled" rather than a consent bypass; and re-running `enable`
//      repairs it, since writing config.json again is a plain overwrite
//      (capture.test.mjs's "running twice" test);
//   8. when codexConfigPath exists: print the plugin sentence and touch
//      neither Codex file if the plugin is present -- except for step 3's
//      codexTomlRemoval: when it says 'removed', write the table's removal
//      back (the same deps.writeText enable's other Codex writes use) and
//      print the one sentence explaining why, before falling through to
//      step 9 -- hooks.json is still left alone in this change (a separate,
//      undecided double-capture question, per this task's own brief).
//      Otherwise write the TOML table (only when step 3's merge actually
//      changed it -- 'unchanged' writes nothing), merge and write hooks.json
//      unconditionally (the same idempotent replace-ours-keep-foreign write
//      settings.json always gets), and take the pre-0.15.0 npm entry out of
//      the personal marketplace when it is there (removeOldNpmEntry);
//   9. prune every other hook/<version> copy now that settings.json (and, on
//      Codex, hooks.json) point only at this one (pruneHookCopies) --
//      best-effort, never fatal, and only after both writes so a prune
//      failure can never leave either file pointing at a copy this step just
//      deleted.
//   10. when deps.bootstrap.enabled (task 13, spec 011 §8): scan the machine
//      for Claude Code's own memory files and transcripts (scanClaudeCode) --
//      skipped, with an empty scan standing in, when claudeDir does not
//      exist (task 11 replaces this with a scan over both harnesses; this
//      task only has to keep a Codex-only machine from crashing on a scan
//      path that is not there) -- and, only if that scan found something,
//      print the one numbered list and ask the third and last question. This
//      runs after the hooks are wired in and verified, deliberately:
//      bootstrap is additional value once capture itself is real, not a
//      precondition for it, and its own failure (a bad answer, a network
//      error inside runBootstrap) must never undo a successful enable -- so
//      nothing below this point can turn 'enabled' into anything else. An
//      empty scan (nothing found, no user CLAUDE.md) says so and asks
//      nothing at all: the person who has nothing to import should not be
//      asked whether to skip importing it.
//   11. the trust line, last, only when this run actually wrote Codex's
//      hooks.json (step 8's non-plugin branch): Codex will not run a hook it
//      has not seen a person approve, so a run that wired the entries in but
//      never said so would read as done when one more step remains.
//
// `mode` (spec 068 D3) is 'capture' for `capture enable`, the hidden alias,
// which keeps every step above exactly as written. 'full-record' is
// `full-record on`, and changes four things:
//   - it shows FULL_RECORD_DISCLOSURE instead of DISCLOSURE;
//   - it skips step 5's consent post: the switch is on by default (spec 068
//     D1), and D3 says neither new command touches it;
//   - it skips step 10, the import question, whatever deps.bootstrap says:
//     `import` is its own command now;
//   - it installs the hook beside a plugin instead of yielding to it (steps
//     3, 7 and 8). Yielding made sense when the plugin and the hook sent the
//     same thing; full record sends more, and the server stands the plugin
//     down for a session the hook has claimed (spec 068 D4), so the two
//     never both write. The plugin's MCP server still wins: on Codex the
//     TOML table stays unwritten, as before.
// After the install it reads the switch once (reportSwitchesOff) and says so
// when it is off for a harness it just wired.
export async function enable(
  url: string,
  deps: CaptureDeps,
  credential?: Credential,
  mode: HookMode = 'capture',
): Promise<EnableResult> {
  const fullRecord = mode === 'full-record'
  const words = MODE_WORDS[mode]
  const claudeDirExists = existsSync(deps.claudeDir)
  const codexConfigExists = existsSync(deps.codexConfigPath)
  if (!claudeDirExists && !codexConfigExists) {
    console.error(
      `Neither Claude Code (${deps.claudeDir}) nor Codex (${deps.codexConfigPath}) was found on this machine -- ` +
        `install one of them first, then run "npx waku-memory ${words.command}" again.`,
    )
    return 'refused'
  }

  // An --answer is checked before the disclosure and before anything is
  // written (2026-11-20). A missing or different --list, or an answer that
  // does not fit the list, ends here with the list and what to run, as
  // `import` does, and writes nothing at all.
  let early: { imported: ImportScan; selection: BootstrapSelection } | undefined
  if (!fullRecord && deps.bootstrap.enabled && deps.bootstrap.answer !== undefined) {
    const { windowDays } = deps.bootstrap
    const imported = importScan(deps, claudeDirExists, codexConfigExists)
    const { scan } = imported
    if (hasImportQuestion(scan)) {
      const resolved = resolveGivenAnswer(imported, deps.bootstrap.answer, deps.bootstrap.list, windowDays)
      if ('message' in resolved) {
        console.log(renderBootstrapList(scan, windowDays))
        console.log(resolved.message.startsWith('List id:') ? resolved.message : `\n${resolved.message}`)
        return 'bad-answer'
      }
      early = { imported, selection: resolved }
    }
  }

  let existingSettings: ClaudeSettings = {}
  let claudePluginPresentHere = false
  if (claudeDirExists) {
    const read = readClaudeSettings(deps.settingsPath)
    if (read === undefined) {
      console.error(
        `${deps.settingsPath}'s content is not something this tool can safely merge into -- ` +
          `leaving it untouched. Nothing was written.`,
      )
      return 'refused'
    }
    existingSettings = read
    claudePluginPresentHere = claudeDirExists && claudePluginPresent(existingSettings, deps.claudePluginsCacheDir)
  }
  // spec 068 D3: only capture enable yields to the Claude Code plugin; see
  // this function's own comment on `mode`.
  const yieldToClaudePlugin = claudePluginPresentHere && !fullRecord

  // Step 3: everything Codex needs decided and checked before the
  // disclosure -- see this function's own comment above for why. Left at
  // their blank-slate defaults (false / undefined / {}) when codexConfigPath
  // does not exist or the plugin is already present; step 8 below only reads
  // codexTomlMerge/codexHooksFile/codexMarketplaceFile inside the branch
  // where they were actually computed.
  let codexPluginPresentHere = false
  let codexTomlMerge: { text: string; result: 'wrote' | 'unchanged' | 'refused' } | undefined
  let codexHooksFile: CodexHooksFile = {}
  let codexMarketplaceFile: MarketplaceFile | undefined
  // Change 1 (bug fix against spec 012 §4.6, which only covers plugin-then-
  // enable): computed here, in the plugin-present arm, the same "decide
  // before the disclosure, write after consent" shape codexTomlMerge already
  // uses below -- removeCodexToml only ever removes the exact block enable()
  // itself wrote (an exact url match, a two-line body, no sub-table right
  // after), so a table a person edited by hand, or one with someone else's
  // url, comes back 'nothing' and step 8 changes nothing and prints nothing
  // about it.
  let codexTomlRemoval: { text: string; result: 'removed' | 'nothing' } | undefined
  if (codexConfigExists) {
    const tomlText = readFileSync(deps.codexConfigPath, 'utf8')
    codexPluginPresentHere = codexPluginPresent(tomlText, deps.codexPluginsCacheDir)
    if (codexPluginPresentHere) {
      codexTomlRemoval = removeCodexToml(tomlText, deps.mcpUrl)
    } else {
      // deps.mcpUrl, not `url`: `url` is the ingest base (config.json's own
      // value in real use), and the TOML's [mcp_servers.waku] table needs
      // the MCP endpoint instead (spec 012 §4.2) -- see CaptureDeps.mcpUrl.
      codexTomlMerge = mergeCodexToml(tomlText, deps.mcpUrl)
      if (codexTomlMerge.result === 'refused') {
        console.error(codexTomlRefusalMessage(deps.codexConfigPath))
        return 'refused'
      }
    }

    // spec 068 D3: full record writes hooks.json beside the plugin too, so
    // it reads (and may refuse on) that file in both arms.
    if (!codexPluginPresentHere || fullRecord) {
      const readHooks = readCodexHooksFile(deps.codexHooksPath)
      if (readHooks === undefined) {
        console.error(
          `${deps.codexHooksPath}'s content is not something this tool can safely merge into -- ` +
            `leaving it untouched. Nothing was written.`,
        )
        return 'refused'
      }
      codexHooksFile = readHooks
    }

    // Read in both arms. The file is only ever made smaller (step 8), so a
    // file that does not parse is left alone and refuses nothing.
    const readMarketplace = readMarketplaceFile(deps.marketplacePath)
    codexMarketplaceFile = readMarketplace === 'invalid' ? undefined : readMarketplace
  }

  console.log(fullRecord ? FULL_RECORD_DISCLOSURE : DISCLOSURE)
  console.log('')
  const confirmation = await deps.prompt('Type "y" to continue, anything else to cancel: ')
  if (confirmation.trim().toLowerCase() !== 'y') {
    console.log(`${words.notDone} -- nothing was written.`)
    return 'declined'
  }

  const credentialResult = await resolveCredential(deps, credential, words.notDone)
  if (credentialResult === 'declined') return 'declined'
  // Fix round 1, finding 2: signed-in but config.json came back unreadable
  // -- a bug, not "the person declined" -- so this is refused before ever
  // reaching installHookCopy, exactly like every other pre-flight refusal
  // above in this function.
  if (credentialResult === 'refused') return 'refused'
  const { key, skipWriteConfig } = credentialResult
  const configPath = join(deps.configDir, CONFIG_FILE_NAME)

  // spec 024 §2: consent first, then the install. One post per harness this
  // run wires; a failure stops here with nothing installed. spec 068 D3:
  // capture enable only -- full-record on never writes the switch.
  const ingestUrl = urlPair(url).ingestUrl
  const harnessesToConsent: Array<'claude_code' | 'codex'> = []
  if (!fullRecord && claudeDirExists) harnessesToConsent.push('claude_code')
  if (!fullRecord && codexConfigExists) harnessesToConsent.push('codex')
  for (const harness of harnessesToConsent) {
    const posted = await postConsent(deps.fetchImpl, ingestUrl, key, harness, true)
    if (!posted.ok) {
      console.error(`Capture not enabled -- ${posted.message}; nothing was installed.`)
      if (skipWriteConfig) console.error(stillSavedMessage(configPath))
      return 'refused'
    }
  }

  const indexPath = installHookCopy(deps.hookSourceDir, deps.configDir, deps.version)
  const run = hookInvocation(deps.execPath, indexPath)
  if (!deps.verifyHook(run)) {
    // Undo the copy this call just installed -- but only if it made one.
    // installHookCopy no-ops when hookSourceDir already *is* the target
    // directory (enable re-run from inside the installed copy); deleting
    // the target in that case would remove a pre-existing directory this
    // call never wrote, possibly the very copy settings.json still points
    // at from an earlier, successful enable.
    if (resolve(deps.hookSourceDir) !== resolve(dirname(indexPath))) {
      rmSync(dirname(indexPath), { recursive: true, force: true })
      const hookRoot = join(deps.configDir, 'hook')
      try {
        if (readdirSync(hookRoot).length === 0) rmSync(hookRoot, { recursive: true, force: true })
      } catch {
        // hookRoot is already gone -- nothing left to prune
      }
    }
    if (skipWriteConfig) {
      // Controller ruling R14: the credential came from deps.login(), which
      // already wrote config.json with a real, minted key before this run
      // ever reached installHookCopy -- unlike every other credential path,
      // where config.json is not written until after verifyHook succeeds
      // (below). "nothing was written" would be false here, so this shares
      // disable()'s own sentence (stillSavedMessage) instead of a second
      // copy of it.
      console.error(`The hook entry did not run (${run.command} ${(run.args ?? []).join(' ')}).`)
      console.error(stillSavedMessage(configPath))
    } else {
      console.error(
        `The hook entry did not run (${run.command} ${(run.args ?? []).join(' ')}) -- ` +
          `nothing was written.`,
      )
    }
    return 'refused'
  }

  if (!skipWriteConfig) writeConfigJson(deps.configDir, { url, key })

  if (claudeDirExists) {
    if (yieldToClaudePlugin) {
      console.log(
        'The Waku plugin carries the hooks and the MCP server for Claude Code; enable adds login and the history import',
      )
    } else {
      const merged = mergeHookSettings(existingSettings, run)
      deps.writeSettingsJson(deps.settingsPath, merged)
    }
  }

  // Step 8: the Codex writes -- or, when the plugin already carries them,
  // exactly one sentence and neither file touched. codexHooksWrittenThisRun
  // gates the trust line (step 11): true whenever hooks.json was actually
  // written this run, which -- unlike the TOML table, conditioned on its
  // own merge having changed anything -- is
  // every time this branch runs at all (mergeCodexHooks's replace-ours
  // semantics write the file even when the entries end up identical, the
  // same way settings.json above always gets written).
  let codexTomlRemovedThisRun = false
  let codexHooksWrittenThisRun = false
  if (codexConfigExists) {
    if (codexPluginPresentHere) {
      if (!fullRecord) {
        console.log(
          'The Waku plugin carries the hooks and the MCP server for Codex; enable adds login and the history import',
        )
      }
      // Change 1: enable() itself wrote [mcp_servers.waku] on an earlier run
      // (the plugin arrived after -- spec 012 §4.6 only handles the other
      // order), and that table is now redundant with the plugin's own MCP
      // server: two waku servers sharing one sign-in is exactly the OAuth
      // refresh-token-reuse failure this change exists to prevent (see this
      // task's own brief). codexTomlRemoval is undefined only when
      // codexConfigExists is false, which cannot be true inside this block.
      if (codexTomlRemoval!.result === 'removed') {
        deps.writeText(deps.codexConfigPath, codexTomlRemoval!.text)
        codexTomlRemovedThisRun = true
        console.log(
          'Removed the [mcp_servers.waku] table enable wrote earlier: the Waku plugin already provides that server, ' +
            "and two waku servers sharing one sign-in can make Codex's sign-in fail.",
        )
      }
    } else if (codexTomlMerge!.result === 'wrote') {
      deps.writeText(deps.codexConfigPath, codexTomlMerge!.text)
    }
    // spec 068 D3: full record writes hooks.json beside the plugin as well.
    if (!codexPluginPresentHere || fullRecord) {
      const mergedHooks = mergeCodexHooks(codexHooksFile, indexPath)
      deps.writeJsonFile(deps.codexHooksPath, mergedHooks)
      codexHooksWrittenThisRun = true
    }
    // Until 0.14.7 this step wrote an entry that installed the plugin from
    // npm. The npm package holds no plugin since 0.15.0 (spec 083), so the
    // entry goes where nothing was installed from it. Where the plugin is
    // installed, the entry may be what Codex installed it from, so it stays
    // and the person is told how to install from the plugin's repository.
    if (hasOldNpmEntry(codexMarketplaceFile)) {
      if (codexPluginPresentHere) {
        console.log(
          `${deps.marketplacePath} lists the Waku plugin from npm, and the npm package no longer holds the plugin. ` +
            `If Codex installed the plugin from that entry, install it again:\n${CODEX_PLUGIN_INSTALL}`,
        )
      } else {
        deps.writeJsonFile(deps.marketplacePath, removeOldNpmEntry(codexMarketplaceFile).data!)
        console.log(
          `Removed the Waku entry from ${deps.marketplacePath}. It installed the plugin from npm, ` +
            `and the npm package no longer holds the plugin. To install the plugin in Codex, run:\n${CODEX_PLUGIN_INSTALL}`,
        )
      }
    }
  }

  pruneHookCopies(deps.configDir, deps.version)

  console.log('')
  const wrote = [configPath]
  if (claudeDirExists && !yieldToClaudePlugin) wrote.push(deps.settingsPath)
  if (codexConfigExists && !codexPluginPresentHere && codexTomlMerge!.result === 'wrote') wrote.push(deps.codexConfigPath)
  if (codexHooksWrittenThisRun) wrote.push(deps.codexHooksPath)
  if (codexTomlRemovedThisRun) wrote.push(deps.codexConfigPath)
  console.log(`${words.done} -- wrote ${wrote.join(', ')}.`)
  if (claudeDirExists && !yieldToClaudePlugin) console.log('Start a new Claude Code session to pick up the hooks.')
  if (fullRecord && (claudePluginPresentHere || (codexPluginPresentHere && codexHooksWrittenThisRun))) {
    // spec 068 D4: the server stands the plugin down for a session once the
    // hook has claimed it (shim_seen), so the plugin stops writing its own
    // copy of that session.
    console.log('The Waku plugin stays installed. For each new session, Waku uses the full record instead of the plugin\'s per-turn copy.')
  }

  if (fullRecord) {
    const wired: Array<'claude_code' | 'codex'> = []
    if (claudeDirExists) wired.push('claude_code')
    if (codexHooksWrittenThisRun) wired.push('codex')
    await reportSwitchesOff(deps.fetchImpl, ingestUrl, key, wired)
  }

  if (!fullRecord && deps.bootstrap.enabled) {
    const { windowDays } = deps.bootstrap
    // The scan made before the disclosure when --answer was given, so the
    // answer is used against the list it was checked against.
    const imported = early?.imported ?? importScan(deps, claudeDirExists, codexConfigExists)
    const { scan } = imported

    console.log('')
    // renderBootstrapList already returns the one "nothing found" sentence
    // for an empty scan (A12) -- reusing it here, rather than a second copy
    // of that literal string, is what keeps the two from drifting apart.
    // The question itself is skipped on exactly the same condition: a
    // person with nothing to import should not be asked whether to skip it.
    console.log(renderBootstrapList(scan, windowDays))
    if (hasImportQuestion(scan)) {
      const selection = early?.selection ?? (await chooseImport(imported, deps))
      if (selection.kind === 'all' || selection.kind === 'exclude' || selection.kind === 'skip') {
        await sendImport(scan, selection, url, key, deps, windowDays)
      }
    }
  }

  if (codexHooksWrittenThisRun) {
    console.log('')
    console.log("Codex runs new hooks only after you trust them: open /hooks in Codex and trust Waku's four entries.")
  }

  return 'enabled'
}

// 'unanswered': nobody could answer "> " and --answer was not given.
// 'bad-answer': --answer did not parse. 'list-changed': --list was missing
// or named another list. All three send nothing (chooseImport).
export type ImportResult =
  | 'imported'
  | 'nothing'
  | 'skipped'
  | 'declined'
  | 'refused'
  | 'unanswered'
  | 'bad-answer'
  | 'list-changed'

// `npx waku-memory import` (spec 068 D3): enable()'s step 10 on its own. It
// installs no hook and never touches the "Auto-save from conversations"
// switch. The order puts every question after the one that needs it:
//   1. scan, locally -- reads files only, sends nothing. An empty scan prints
//      renderBootstrapList's "nothing to import" sentence and stops, asking
//      nothing and needing no credential.
//   2. print the list. renderBootstrapList ends with the import's own
//      disclosure (sent to our servers and on to the providers named at
//      www.waku.one/privacy; an alpha whose data can be lost) -- the same
//      screen capture enable has always shown before this question.
//   3. ask "> ", or read --answer. A skip sends nothing and ends here,
//      without asking for a credential at all, and so does no answer at all
//      (no terminal, or its input closed): chooseImport prints what to run.
//   4. resolve the credential the way capture enable does (a saved key,
//      --login, --key, or the Sign-in question). A pasted or --key key is
//      saved to config.json so the next command does not ask again; a key
//      from login() is already there, and a stored key is left as it was.
//   5. send, and print the one counts line.
export async function importHistory(url: string, deps: CaptureDeps, credential?: Credential): Promise<ImportResult> {
  const { windowDays } = deps.bootstrap
  const imported = importScan(deps, existsSync(deps.claudeDir), existsSync(deps.codexConfigPath))
  const { scan } = imported
  console.log(renderBootstrapList(scan, windowDays))
  if (!hasImportQuestion(scan)) return 'nothing'

  const selection = await chooseImport(imported, deps)
  if (selection.kind === 'unanswered' || selection.kind === 'bad-answer' || selection.kind === 'list-changed') {
    return selection.kind
  }
  if (selection.kind === 'skip') {
    console.log('Nothing was imported.')
    return 'skipped'
  }

  const storedBefore = readStoredKey(deps.configDir)
  const credentialResult = await resolveCredential(deps, credential, 'Nothing was imported')
  if (credentialResult === 'declined') return 'declined'
  if (credentialResult === 'refused') return 'refused'
  const { key, skipWriteConfig } = credentialResult
  if (!skipWriteConfig && key !== storedBefore) writeConfigJson(deps.configDir, { url, key })

  await sendImport(scan, selection, url, key, deps, windowDays)
  return 'imported'
}

// disable() takes no --url flag (never has -- see disable()'s own comment),
// so there is nothing on argv to derive the Codex MCP url from the way
// dispatch() derives it for enable(). The one record of what enable()
// actually used is config.json's own `url` field: whatever ingest base a
// person passed to "capture enable --url ..." (or the default, if they
// passed none) is exactly what got written there, and urlPair() rebuilds
// the matching mcpUrl from it the same way dispatch() built it forwards
// (fix round 2, re-review finding #2, controller ruling R9). Falling back to
// deps.mcpUrl (the default) only when config.json is missing, unreadable, or
// carries no usable url string -- a machine where the credential file was
// hand-deleted, or never existed because enable() itself failed partway --
// is a *best-effort* guess, not a promise: it can only be right when the
// machine was enabled with the default url in the first place, but it is no
// worse than fix round 1's own always-use-deps.mcpUrl behavior for that one
// case, and strictly better for every other one.
function resolveDisableMcpUrl(configDir: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, CONFIG_FILE_NAME), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      const storedUrl = (parsed as { url?: unknown }).url
      if (typeof storedUrl === 'string' && storedUrl.length > 0) return urlPair(storedUrl).mcpUrl
    }
  } catch {
    // Missing, unreadable, or not valid JSON -- fall back below.
  }
  return fallback
}

// The ingest-base sibling of resolveDisableMcpUrl above, for the same reason
// and read from the same config.json field: config.json's `url` is the
// ingest base enable() was called with (its own `url` parameter), not the
// mcpUrl the TOML table carries -- postConsent needs the former.
function resolveDisableIngestUrl(configDir: string, fallback: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, CONFIG_FILE_NAME), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      const storedUrl = (parsed as { url?: unknown }).url
      // final review, minor: normalised through urlPair, mirroring
      // resolveDisableMcpUrl above -- config.json's stored `url` can itself
      // carry a trailing slash or a "/mcp" suffix (whatever a person typed
      // to "capture enable --url ..."), and postConsent's own
      // `${ingestUrl.replace(/\/+$/, '')}/capture/${harness}` only strips
      // the trailing slash, never a stray "/mcp" -- unnormalised, that would
      // build "https://x.test/mcp/capture/claude_code" instead of
      // ".../capture/claude_code".
      if (typeof storedUrl === 'string' && storedUrl.length > 0) return urlPair(storedUrl).ingestUrl
    }
  } catch {
    // Missing, unreadable, or not valid JSON -- fall back below.
  }
  return fallback
}

export type DisableResult = 'disabled' | 'nothing-to-disable' | 'refused'

// Removes exactly what enable() added and nothing else, from both harnesses
// (ruling R6, task 10): Claude Code's hook entries when claudeDir exists
// (unchanged from before this task), Codex's hooks.json entries and its
// [mcp_servers.waku] TOML table when codexConfigPath exists. Deliberately
// leaves config.json in place in every case: the
// key is the user's to revoke on the keys page, not this tool's to delete --
// disabling capture and revoking the credential are two different
// decisions, and conflating them would make "disable" destructive in a way
// its name does not promise. It leaves the personal marketplace alone too.
//
// `mode` (spec 068 D3): 'full-record' is `full-record off`. It removes the
// same entries with its own wording, and it skips the consent post below:
// D3 says neither new command touches the switch, and full-record off
// removes the hook only.
export async function disable(deps: CaptureDeps, mode: HookMode = 'capture'): Promise<DisableResult> {
  const words = MODE_WORDS[mode]
  const codexConfigExists = existsSync(deps.codexConfigPath)

  const existingSettings = readClaudeSettings(deps.settingsPath)
  if (existingSettings === undefined) {
    console.error(
      `${deps.settingsPath}'s content is not something this tool can safely modify -- leaving it untouched.`,
    )
    return 'refused'
  }

  let codexHooksFile: CodexHooksFile = {}
  if (codexConfigExists) {
    const read = readCodexHooksFile(deps.codexHooksPath)
    if (read === undefined) {
      console.error(
        `${deps.codexHooksPath}'s content is not something this tool can safely modify -- leaving it untouched.`,
      )
      return 'refused'
    }
    codexHooksFile = read
  }

  const configPath = join(deps.configDir, CONFIG_FILE_NAME)
  let changed = false

  const removedSettings = removeHookSettings(existingSettings)
  if (!isDeepStrictEqual(removedSettings, existingSettings)) {
    deps.writeSettingsJson(deps.settingsPath, removedSettings)
    console.log(`${words.offDone} -- removed the hook entries from ${deps.settingsPath}.`)
    changed = true
  }

  if (codexConfigExists) {
    const removedHooks = removeCodexHooks(codexHooksFile)
    const hooksChanged = !isDeepStrictEqual(removedHooks, codexHooksFile)
    if (hooksChanged) {
      deps.writeJsonFile(deps.codexHooksPath, removedHooks)
    }

    // removeCodexToml only removes the table when its url is ours --
    // resolveDisableMcpUrl (fix round 2, spec 012 §4.2, re-review finding #2),
    // not deps.mcpUrl directly: disable() has no --url flag, so deps.mcpUrl
    // is always whatever default dispatch() filled in, regardless of what
    // "capture enable --url ..." actually used on this machine. config.json
    // is the record of that real value; see resolveDisableMcpUrl's own
    // comment for the fallback this takes when that record is gone.
    const tomlText = readFileSync(deps.codexConfigPath, 'utf8')
    const mcpUrlForToml = resolveDisableMcpUrl(deps.configDir, deps.mcpUrl)
    const removedToml = removeCodexToml(tomlText, mcpUrlForToml)
    const tomlChanged = removedToml.result === 'removed'
    if (tomlChanged) {
      deps.writeText(deps.codexConfigPath, removedToml.text)
    }

    // One honest sentence per file actually touched (fix round 2, re-review
    // finding #2): the old single message here always said "removed the
    // Codex hook entries" whenever *either* file changed, which claimed the
    // TOML table was gone even on the runs where only hooks.json changed and
    // removeCodexToml's own url comparison left the table exactly where it
    // was -- silently, since success was reported either way.
    if (hooksChanged) {
      console.log(`${words.offDone} -- removed the Codex hook entries from ${deps.codexHooksPath}.`)
      changed = true
    }
    if (tomlChanged) {
      console.log(`${words.offDone} -- removed the Codex MCP server entry from ${deps.codexConfigPath}.`)
      changed = true
    }
  }

  // spec 024 §2, final review Critical 1: the other door onto consent, off.
  // Keyed on a stored key and a detected harness -- existsSync(deps.claudeDir)
  // for Claude Code, codexConfigExists for Codex -- never on `changed`. On
  // the plugin route, disable() has no local hook entries to remove at all
  // (the plugin carries them, not this tool): `changed` would stay false
  // forever there, and returning early on it, the way this used to, meant
  // "capture disable" on such a machine posted nothing and left the person's
  // consent row on even though every printed line told them it was off. Run
  // above the `!changed` guard below so that guard can never skip it. Only
  // with a stored key; without one there is nothing to authenticate the post
  // with, and the console's switch is the person's other way to turn it off.
  const key = mode === 'capture' ? readStoredKey(deps.configDir) : null
  const postedOff: Array<'claude_code' | 'codex'> = []
  if (key !== null) {
    const ingestUrl = resolveDisableIngestUrl(deps.configDir, urlPair(deps.mcpUrl).ingestUrl)
    const harnesses: Array<'claude_code' | 'codex'> = []
    if (existsSync(deps.claudeDir)) harnesses.push('claude_code')
    if (codexConfigExists) harnesses.push('codex')
    for (const harness of harnesses) {
      const posted = await postConsent(deps.fetchImpl, ingestUrl, key, harness, false)
      if (!posted.ok) {
        console.error(`Capture disabled here, but ${posted.message}; turn it off at https://www.waku.one/integrations.`)
      } else {
        postedOff.push(harness)
      }
    }
  }

  if (!changed) {
    // The post above is the only thing this call did -- say so per harness,
    // so the person sees it actually happened, rather than reading only the
    // sentence below that (correctly) says there was nothing local to touch.
    for (const harness of postedOff) {
      console.log(`Capture turned off on the server for ${HARNESS_LABELS[harness]}.`)
    }
    console.log(`${words.notOn} -- nothing to remove.`)
    return 'nothing-to-disable'
  }

  console.log(stillSavedMessage(configPath))
  return 'disabled'
}

// Ruling R5 (task 10, spec 012 §4.6): one line per detected harness -- its
// directory or config file exists -- naming whether our hooks are actually
// installed there, as opposed to merely detected (setup()'s own "found but
// nothing to change" language, harnesses.ts's getHarnesses()), then exactly
// one line for the key. Reads files only, through the same helpers
// enable()/disable() use to decide what is theirs; never writes, and never
// prints the key itself, only whether one is stored.
//
// Change 2 (this task): on the plugin route, two additional read-only lines
// -- neither changes what this function writes (nothing, still) -- name the
// two ways a machine can end up double-capturing on Codex: our own
// [mcp_servers.waku] table left over beside the plugin (codexTomlTablePresent,
// regardless of whose url it carries -- either one is a second registered
// MCP server), and our own hooks.json entries still installed beside the
// plugin's (hasOwnCodexHooks, the same check the non-plugin branch below
// already makes).
export async function status(deps: CaptureDeps): Promise<void> {
  if (existsSync(deps.claudeDir)) {
    const settings = readClaudeSettings(deps.settingsPath)
    const installed = settings !== undefined && hasOwnHooks(settings)
    const pluginPresent = settings !== undefined && claudePluginPresent(settings, deps.claudePluginsCacheDir)
    if (pluginPresent) {
      console.log('Claude Code: the Waku plugin is installed; it carries the hooks and the MCP server.')
      if (installed) {
        console.log(
          'Claude Code: our own hook entries are also installed beside the plugin -- run "capture disable" to remove them.',
        )
      }
    }
    if (installed) {
      console.log(`Claude Code: hooks installed (${deps.settingsPath})`)
    } else if (pluginPresent) {
      // final review, minor: "not configured" reads as nothing is capturing
      // -- wrong on a plugin-route machine, where the plugin's own hooks
      // (not this tool's) are what run. Named instead of silence, so status
      // gives an honest answer for exactly the case Change 2 above already
      // knows how to detect.
      console.log('Claude Code: no CLI hook entries installed (the plugin carries them).')
    } else {
      console.log('Claude Code: not configured')
    }
  }

  if (existsSync(deps.codexConfigPath)) {
    const tomlText = readFileSync(deps.codexConfigPath, 'utf8')
    if (codexPluginPresent(tomlText, deps.codexPluginsCacheDir)) {
      console.log('Codex: plugin route')
      // Change 2: read-only warnings about the two ways this machine can
      // end up with capture running twice on Codex -- an [mcp_servers.waku]
      // table left over from before the plugin arrived (Change 1 is what
      // "capture enable" now does about the first one), or our own
      // hooks.json entries still sitting beside the plugin's. Neither check
      // writes anything; both just read the same files enable()/disable()
      // already read.
      if (codexTomlTablePresent(tomlText)) {
        console.log(
          "Codex: two waku MCP servers (the plugin's and [mcp_servers.waku]) -- run capture enable to remove the table",
        )
      }
      const hooksFile = readCodexHooksFile(deps.codexHooksPath)
      if (hooksFile !== undefined && hasOwnCodexHooks(hooksFile)) {
        console.log(
          'Codex: both routes are installed -- a turn can be captured twice until the session is claimed, and capture disable removes ours',
        )
      }
    } else {
      const hooksFile = readCodexHooksFile(deps.codexHooksPath)
      const installed = hooksFile !== undefined && hasOwnCodexHooks(hooksFile)
      console.log(installed ? `Codex: hooks installed (${deps.codexHooksPath})` : 'Codex: not configured')
    }
  }

  console.log(readStoredKey(deps.configDir) !== null ? 'Key: stored' : 'Key: none')
}

// `npx waku-memory full-record status` (spec 068 D3): status() above, worded
// as full record. One line per detected harness saying whether the hook is
// installed, and whether the plugin is there to send each prompt and final
// reply without it; one warning when Codex has two waku MCP servers; then
// the key line. Reads only, through the same helpers status() uses, and
// never prints the key.
export async function fullRecordStatus(deps: CaptureDeps): Promise<void> {
  const pluginLine = 'The Waku plugin is installed and sends each prompt and final reply.'
  if (existsSync(deps.claudeDir)) {
    const settings = readClaudeSettings(deps.settingsPath)
    const installed = settings !== undefined && hasOwnHooks(settings)
    const pluginPresent = settings !== undefined && claudePluginPresent(settings, deps.claudePluginsCacheDir)
    if (installed) console.log(`Claude Code: full record is on (${deps.settingsPath}).`)
    else console.log(`Claude Code: full record is off.${pluginPresent ? ` ${pluginLine}` : ''}`)
  }

  if (existsSync(deps.codexConfigPath)) {
    const tomlText = readFileSync(deps.codexConfigPath, 'utf8')
    const pluginPresent = codexPluginPresent(tomlText, deps.codexPluginsCacheDir)
    const hooksFile = readCodexHooksFile(deps.codexHooksPath)
    const installed = hooksFile !== undefined && hasOwnCodexHooks(hooksFile)
    if (installed) console.log(`Codex: full record is on (${deps.codexHooksPath}).`)
    else console.log(`Codex: full record is off.${pluginPresent ? ` ${pluginLine}` : ''}`)
    if (pluginPresent && codexTomlTablePresent(tomlText)) {
      console.log(
        "Codex: two waku MCP servers are configured, the plugin's and [mcp_servers.waku]. " +
          'Run "npx waku-memory full-record on" to remove the table.',
      )
    }
  }

  console.log(readStoredKey(deps.configDir) !== null ? 'Key: stored' : 'Key: none')
}
