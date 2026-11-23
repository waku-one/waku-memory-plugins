// Where each harness keeps its MCP config, and how to add to it without
// destroying what is there. One file per harness would be tidier and is not
// worth it yet: the shapes are nearly identical, and the differences are
// worth seeing side by side while there are only two.
//
// This file also carries the *hook* side of "one harness, one profile"
// (spec 012 §4): everything hook.ts needs to know about the harness it is
// running under -- content format, delta formatter, timing budgets, and how
// the brief is printed -- lives on one HarnessProfile per HarnessId, so
// hook.ts itself never asks "which harness is this?" by string compare.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CONTENT_FORMAT, formatDelta, type Piece } from './dialogue.ts'
import { CODEX_CONTENT_FORMAT, formatCodexDelta } from './dialogue-codex.ts'

export type McpConfig = { mcpServers?: Record<string, unknown> }

export function mergeMcpConfig(existing: McpConfig, name: string, url: string): McpConfig {
  const servers = existing.mcpServers ?? {}
  const current = servers[name] as { url?: string } | undefined
  if (current && current.url !== url) {
    // Refuse rather than overwrite. Someone configured this by hand, with a
    // different URL or with headers we cannot see the purpose of, and
    // silently replacing it would undo a deliberate choice with no trace.
    throw new Error(
      `"${name}" is already configured with a different URL (${current.url}). ` +
        `Remove it or pass --name to use a different key.`,
    )
  }
  return { ...existing, mcpServers: { ...servers, [name]: { type: 'http', url } } }
}

// A harness this shim knows how to edit safely, plus whether that knowledge
// was actually confirmed against a real install on some machine this shim
// has run on, rather than copied from documentation.
//
// Only Claude Code is verified. Measured 2026-08-24: `claude mcp add
// --transport http <throwaway-name> <url> -s user` reports "File modified:
// <home>/.claude.json", and the entry lands at that file's top-level
// `mcpServers` key in exactly the shape mergeMcpConfig produces --
// `claude mcp remove ... -s user` was then used to take it back out. (A
// second file, `~/.claude/mcp.json`, also exists on the machine this was
// measured on; a before/after hash showed `claude mcp add` never touches
// it, so it is not a candidate and is left alone here.)
//
// Codex is deliberately not in getHarnesses() -- setup() is spec 005's
// MCP-only path, and remains Claude-Code-only. Codex's own route is
// `capture enable` (task 10, spec 012 §4.6): it writes `~/.codex/config.toml`'s
// [mcp_servers.waku] table and ~/.codex/hooks.json for real, through
// codex-config.ts, rather than only detecting the file and printing an
// unverified pointer at it. Until task 10 that gap was covered by a
// manual-harness list-and-note pair here -- detected but never written,
// because nothing this shim had run on had a real Codex install to check
// the path or the format against. Task 14 (spec 012 §9) deletes that pair
// entirely: a harness `capture enable` now writes to for real has no more
// use for a note telling the reader to configure it by hand, and setup()
// printing one anyway would be actively misleading on a Codex-only
// machine. Whether setup() should also gain Codex as a first-class
// getHarnesses() entry is a parked question for the plan owner, not
// decided here -- see cli.ts's setup() for the "no supported harness
// config was found" outcome that still applies to a Codex-only machine.
export type Harness = {
  name: string
  configPath: string
}

export function getHarnesses(): Harness[] {
  return [{ name: 'Claude Code', configPath: join(homedir(), '.claude.json') }]
}

// Structurally typed rather than taking a Harness, so the same check serves
// both lists -- a manual harness needs exactly the same "is it here?"
// question answered, and duplicating existsSync for it would let the two
// drift.
export function harnessConfigExists(harness: { configPath: string }): boolean {
  return existsSync(harness.configPath)
}

// The SessionEnd flush has to finish inside the hook entry capture.ts
// installs for it, or Claude Code kills the process mid-request with no
// chance to log why. That entry's `timeout` (seconds) is
// SESSION_END_HOOK_TIMEOUT_S, defined here (not in hook.ts) so capture.ts's
// import of it and hook.ts's own use of the Claude Code profile cannot drift
// apart again: until 2026-09-04 the network budget below was 800 ms, derived
// from Claude Code's 1.5 s *default* SessionEnd budget, while the installed
// entry had already raised that budget to 10 s -- and 800 ms is one cold
// round trip to api.waku.one from Yang's machine (three real POST
// /ingest/session calls measured 822, 644 and 1174 ms), so two of every
// three flushes were aborted by our own timer. That is the last turn of
// every session, and all of a single-turn one.
//
// The network budget is the process budget minus what happens before the
// request: `npx -y waku-memory hook` took 2.8 s to reach this code cold
// (2026-09-04), and Node startup, stdin and the transcript read are a few
// hundred milliseconds more. 5 s leaves about 2 s of the 10 s for a slower
// machine. hook.test.mjs pins both bounds. Stop is not bounded this way
// (600 s budget, and runs "async": true), so its path through postDelta does
// not use this.
//
// Defined here rather than in hook.ts to avoid an import cycle: hook.ts
// needs profileFor() from this file, and capture.ts needs these two
// constants -- re-exported from hook.ts, unchanged, so capture.ts's existing
// import keeps working.
export const SESSION_END_HOOK_TIMEOUT_S = 10
export const SESSION_END_TIMEOUT_MS = 5000

// The two harnesses this shim's hook can run under (spec 012 §4). Codex is
// added by task 8; a third harness is a third id and a third profile, never
// a new branch inside hook.ts.
export type HarnessId = 'claude_code' | 'codex'

// A harness the bootstrap covers for AUTHORED files (skills), which is wider
// than the dialogue harnesses that need a PROFILES entry: Cursor has authored
// skills (skills-cursor/) but no transcripts here, so it is an AuthoredHarness
// without being a HarnessId. Spec 026. Hermes and the Waku agent (031) keep
// authored memory docs and skills, and no transcripts the shim reads. Gemini
// CLI and Windsurf (spec 073 D10) keep one memory file each and nothing else
// the shim reads; their ids are the server's `Harness` values.
export type AuthoredHarness = HarnessId | 'cursor' | 'hermes' | 'waku' | 'gemini' | 'windsurf'

export type HarnessProfile = {
  id: HarnessId
  // What content_format the ingest request carries.
  contentFormat: string
  // Turns a raw transcript-delta buffer into pieces under the ingest cap --
  // dialogue.ts's cc-dialogue-v1 rule for Claude Code, dialogue-codex.ts's
  // codex-dialogue-v1 rule for Codex. Same shape as dialogue.ts's
  // formatDelta so either can be assigned here directly.
  formatDelta: (buf: Buffer, maxPieceBytes?: number) => { pieces: Piece[]; end: number }
  // SessionEnd's network budget and the process-level timeout of the hook
  // entry capture.ts installs for it (Codex caps the hook itself at 3 s;
  // Claude Code's installed entry allows 10 s -- see SESSION_END_TIMEOUT_MS
  // above for the full derivation of the Claude Code numbers).
  sessionEndTimeoutMs: number
  sessionEndHookTimeoutS: number
  // What SessionStart's postBrief actually writes to stdout: identity for
  // Claude Code (plain text, spec 011 §6), the hook JSON contract for Codex
  // (spec 012 §4 -- {"hookSpecificOutput": {"hookEventName": "SessionStart",
  // "additionalContext": text}}).
  // With a notice (notice.ts), Claude Code also answers the JSON contract,
  // whose `systemMessage` is the line the person sees at session start.
  briefOutput: (text: string, notice?: string) => string
  // spec 029: how UserPromptSubmit's injected memories reach the session --
  // plain stdout for Claude Code, the hook JSON contract for Codex, whose
  // hookEventName must name the event that produced it. With a notice
  // (notice.ts) both answer the JSON contract, whose `systemMessage` is the
  // line the person sees; `additionalContext` reaches the model only.
  promptOutput: (text: string, notice?: string) => string
  // Ruling R4 (spec 012 §4.1): Codex-only. When true, and this machine has
  // no usable config.json, every event (SessionStart/Stop/SessionEnd) exits
  // 0 with no stdout and no stderr and makes no fetch call -- Codex has no
  // interactive "capture enable" onboarding yet, so a credential-less
  // install must stay silent rather than spam every hook invocation. Claude
  // Code keeps its existing stderr line for the same case (spec 011 A9: its
  // output is unchanged), which is why this is a per-profile flag and not a
  // hook.ts-wide behavior.
  silentWithoutCredential: boolean
}

const hookJson = (event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse', text: string, notice?: string): string =>
  JSON.stringify({
    ...(notice ? { systemMessage: notice } : {}),
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  })

const promptJson = (text: string, notice?: string): string => hookJson('UserPromptSubmit', text, notice)

// spec 071 F1: PreToolUse's answer, the same for both harnesses. Claude Code
// adds a PreToolUse hook's plain stdout to no context, so this is always the
// JSON form; Codex reads the same `hookSpecificOutput.additionalContext`.
export const actOutput = (text: string, notice?: string): string => hookJson('PreToolUse', text, notice)

export const PROFILES: Record<HarnessId, HarnessProfile> = {
  claude_code: {
    id: 'claude_code',
    contentFormat: CONTENT_FORMAT,
    formatDelta,
    sessionEndTimeoutMs: SESSION_END_TIMEOUT_MS,
    sessionEndHookTimeoutS: SESSION_END_HOOK_TIMEOUT_S,
    briefOutput: (t, notice) => (notice ? hookJson('SessionStart', t, notice) : t),
    promptOutput: (t, notice) => (notice ? promptJson(t, notice) : t),
    silentWithoutCredential: false,
  },
  codex: {
    id: 'codex',
    contentFormat: CODEX_CONTENT_FORMAT,
    formatDelta: formatCodexDelta,
    sessionEndTimeoutMs: 2000,
    sessionEndHookTimeoutS: 3,
    briefOutput: (t, notice) => hookJson('SessionStart', t, notice),
    promptOutput: (t, notice) => promptJson(t, notice),
    silentWithoutCredential: true,
  },
}

export function profileFor(id: string): HarnessProfile | undefined {
  return (PROFILES as Record<string, HarnessProfile>)[id]
}
