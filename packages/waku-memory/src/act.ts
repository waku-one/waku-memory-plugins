// `act on|off|status` (spec 071 F1, the E6 experiment): the act channel.
// Before the agent runs a shell command or edits a file, the PreToolUse hook
// asks Waku for the person's rules and how-tos whose triggers name that step
// (hook.ts's postAct). It is an experiment and off by default, so it has its
// own switch: this command adds the hook beside the ones "full-record on"
// wrote, reusing the same hook copy, and turns the person's switch on the
// server on with the saved key. "act off" removes the hook and turns the
// switch off. "full-record off" removes the hook too, with every other one.
//
// Nothing here prompts. A person who runs "act on" asked for it, and the
// command says what it did.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type ClaudeSettings,
  type SettingsWriter,
  addActSettings,
  hasActSettings,
  ownInvocation,
  readClaudeSettings,
  readCodexHooksFile,
  removeActSettings,
} from './capture.ts'
import { type CodexHooksFile, addCodexAct, hasCodexAct, ownCodexIndexPath, removeCodexAct } from './codex-config.ts'
import { CONFIG_FILE_NAME } from './hook.ts'

// The first shim whose hook answers PreToolUse. An older copy would start
// before every tool call and do nothing.
export const ACT_SINCE = '0.13.0'

export const FULL_RECORD_ON = 'npx -y waku-memory@latest full-record on'

export type ActDeps = {
  configDir: string // ~/.waku-memory: config.json (url and key) and the hook copies
  settingsPath: string // ~/.claude/settings.json
  codexHooksPath: string // ~/.codex/hooks.json
  writeSettingsJson: SettingsWriter
  writeJsonFile: (path: string, data: unknown) => void
  fetchImpl: typeof fetch
  log: (line: string) => void // real: console.log
  error: (line: string) => void // real: console.error
}

type Config = { url: string; key: string }

function readConfig(configDir: string): Config | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, CONFIG_FILE_NAME), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const { url, key } = parsed as Record<string, unknown>
    return typeof url === 'string' && url !== '' && typeof key === 'string' && key !== '' ? { url, key } : null
  } catch {
    return null
  }
}

// The version directory a hook copy lives in, from its index.js path.
export function copyVersion(indexPath: string): string | undefined {
  const match = /\/hook\/([^/]+)\/index\.js$/.exec(indexPath.replace(/\\/g, '/'))
  return match ? match[1] : undefined
}

// Whether `version` is ACT_SINCE or later. A version this cannot read is
// not new enough.
export function answersAct(version: string | undefined): boolean {
  const parts = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10))
  if (!version) return false
  const have = parts(version)
  const need = parts(ACT_SINCE)
  if (have.some(Number.isNaN)) return false
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i]
  }
  return true
}

type Plan<T> = { file: T; next: T } | { refused: string } | null

function claudePlan(deps: ActDeps): Plan<ClaudeSettings> {
  const settings = readClaudeSettings(deps.settingsPath)
  if (settings === undefined) return { refused: `${deps.settingsPath} could not be read, so Claude Code was left as it was.` }
  const run = ownInvocation(settings)
  if (!run) return null
  if (!answersAct(copyVersion(run.args?.[0] ?? ''))) {
    return { refused: `Claude Code runs an older Waku hook. Run "${FULL_RECORD_ON}", then run this command again.` }
  }
  return { file: settings, next: addActSettings(settings, run) }
}

function codexPlan(deps: ActDeps): Plan<CodexHooksFile> {
  const file = readCodexHooksFile(deps.codexHooksPath)
  if (file === undefined) return { refused: `${deps.codexHooksPath} could not be read, so Codex was left as it was.` }
  const indexPath = ownCodexIndexPath(file)
  if (!indexPath) return null
  if (!answersAct(copyVersion(indexPath))) {
    return { refused: `Codex runs an older Waku hook. Run "${FULL_RECORD_ON}", then run this command again.` }
  }
  return { file, next: addCodexAct(file, indexPath) }
}

async function putSwitch(deps: ActDeps, config: Config, on: boolean): Promise<string | null> {
  const target = `${config.url.replace(/\/+$/, '')}/settings/act-channel`
  try {
    const res = await deps.fetchImpl(target, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ on }),
    })
    return res.ok ? null : `Waku answered ${res.status}`
  } catch (err) {
    return `the request failed (${err instanceof Error ? err.message : String(err)})`
  }
}

async function readSwitch(deps: ActDeps, config: Config): Promise<boolean | null> {
  try {
    const res = await deps.fetchImpl(`${config.url.replace(/\/+$/, '')}/settings/act-channel`, {
      headers: { Authorization: `Bearer ${config.key}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { on?: unknown }
    return typeof body.on === 'boolean' ? body.on : null
  } catch {
    return null
  }
}

// Returns true when at least one harness has the hook and the switch is on.
export async function actOn(deps: ActDeps): Promise<boolean> {
  const config = readConfig(deps.configDir)
  if (!config) {
    deps.error(`No Waku key is saved on this computer. Run "${FULL_RECORD_ON}" first.`)
    return false
  }
  const claude = claudePlan(deps)
  const codex = codexPlan(deps)
  for (const plan of [claude, codex]) if (plan && 'refused' in plan) deps.error(plan.refused)
  const wired: string[] = []
  if (claude && 'next' in claude) wired.push('Claude Code')
  if (codex && 'next' in codex) wired.push('Codex')
  if (wired.length === 0) {
    if (!claude && !codex) deps.error(`Full record is off on this computer. Run "${FULL_RECORD_ON}" first.`)
    return false
  }
  // The switch first: hooks that every server answer leaves empty would
  // only slow each step down.
  const failed = await putSwitch(deps, config, true)
  if (failed) {
    deps.error(`Waku could not turn the act channel on: ${failed}. Nothing was changed.`)
    return false
  }
  if (claude && 'next' in claude) deps.writeSettingsJson(deps.settingsPath, claude.next)
  if (codex && 'next' in codex) deps.writeJsonFile(deps.codexHooksPath, codex.next)
  deps.log(`The act channel is on for ${wired.join(' and ')}.`)
  deps.log('Before each shell command and file edit, Waku adds your saved rules for that step.')
  deps.log('Each step waits for Waku for up to 1.5 seconds.')
  deps.log('Run "npx waku-memory act off" to turn it off.')
  return true
}

export async function actOff(deps: ActDeps): Promise<boolean> {
  const settings = readClaudeSettings(deps.settingsPath)
  const codex = readCodexHooksFile(deps.codexHooksPath)
  if (settings && hasActSettings(settings)) deps.writeSettingsJson(deps.settingsPath, removeActSettings(settings))
  if (codex && hasCodexAct(codex)) deps.writeJsonFile(deps.codexHooksPath, removeCodexAct(codex))
  const config = readConfig(deps.configDir)
  const failed = config ? await putSwitch(deps, config, false) : null
  if (failed) {
    deps.error(`The act channel hook was removed, but Waku could not turn the switch off: ${failed}.`)
    return false
  }
  deps.log('The act channel is off. Your rules still reach each session at its start.')
  return true
}

export async function actStatus(deps: ActDeps): Promise<void> {
  const settings = readClaudeSettings(deps.settingsPath)
  const codex = readCodexHooksFile(deps.codexHooksPath)
  const word = (on: boolean) => (on ? 'on' : 'off')
  deps.log(`Claude Code hook: ${word(Boolean(settings && hasActSettings(settings)))}`)
  deps.log(`Codex hook: ${word(Boolean(codex && hasCodexAct(codex)))}`)
  const config = readConfig(deps.configDir)
  const on = config ? await readSwitch(deps, config) : null
  deps.log(`Switch on Waku: ${on === null ? 'unknown' : word(on)}`)
}
