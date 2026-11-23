// `setup save` and `setup auto` (spec 073 C, D6-D8, tasks T11 and T12): the
// computer half of the setup list. It reads the user-level files where this
// computer's agents keep their MCP servers, plugins, hooks, permissions,
// subagents, commands and scheduled tasks, removes every secret value, and
// saves the list to Waku (POST /setup/snapshots), so a new computer or a new
// account can be set up the same way. A repository's own .mcp.json, .claude/
// and .cursor/ travel with the repository and are not read.
//
// Secrets never leave the computer (D7). An MCP server's env and header
// values are all removed, whatever they hold; so are a URL's user and
// password, a query value whose name says key, token, secret, password or
// auth, and an argument after a flag that says the same. Every other string
// goes through a port of waku_domain.redact's patterns, and a string under a
// key that names a secret is removed too. Each removed value becomes
// `<secret:NAME>`, so the restore can say what a server needs. The server
// checks every save with the same rules (waku_domain.setup) and refuses one
// that still matches; an item that still matches here is left out of the
// save and named, so an honest save never meets that refusal.
//
// After the first save, the SessionStart hook compares the files' sizes and
// times with the last save's and starts `setup save --auto` in the
// background when one changed (setupNeedsRefresh). The background save sends
// nothing when what it read is what it sent last time.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'

import { type HookCommandEntry, isOwnEntry } from './capture.ts'
import { CONFIG_FILE_NAME, SHIM_VERSION } from './hook.ts'

export const SETUP_STATE_FILE = 'setup.json'

// waku_domain.setup's caps, so a save is never refused for size.
export const MAX_ITEMS = 500
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_RAW_BYTES = 1_000_000
export const NAME_CHARS = 200
export const LABEL_CHARS = 120

// How long the SessionStart check waits after the last one. Claude Code
// rewrites ~/.claude.json at every start, so without it each new session
// would start a background save.
export const REFRESH_EVERY_MS = 10 * 60 * 1000

export type SetupItem = {
  type: string
  app: string
  name: string
  body: Record<string, unknown>
}

export type SetupReading = {
  items: SetupItem[]
  sections: Record<string, unknown> // the parts of each config file read, as sent: `raw` (D1)
  removed: number // secret values replaced by <secret:NAME>
  leftOut: string[] // items not sent, each with why
  unreadable: string[] // files that exist but could not be read
}

export type SetupPlace = { home: string; platform: NodeJS.Platform }

// ---------------------------------------------------------------------------
// Secrets: a port of waku_domain.redact (071 D9) and waku_domain.setup
// ---------------------------------------------------------------------------

const REDACTED = '[redacted]'
const PLACEHOLDER = /<secret:[A-Za-z0-9_.-]{1,100}>/g
const IS_PLACEHOLDER = /^<secret:[A-Za-z0-9_.-]{1,100}>$/

// The same patterns, in the same order, as redact.py. Each keeps what
// redact keeps around the value (`Bearer `, a URL's user and host, a `.env`
// name) and hands the value to `mark`.
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g
const BEARER = /\b(bearer\s+)([A-Za-z0-9\-._~+/]{7,}[A-Za-z0-9\-_~+/]=*)/gi
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const KEY_PREFIXES = new RegExp(
  '(?<![A-Za-z0-9_\\-])(?:' +
    'sk-ant-[A-Za-z0-9_\\-]{20,}' +
    '|sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\\-]{20,}' +
    '|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}' +
    '|whsec_[A-Za-z0-9]{16,}' +
    '|(?:AKIA|ASIA)[0-9A-Z]{16}' +
    '|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}' +
    '|xox[abposr]-[A-Za-z0-9\\-]{10,}' +
    '|AIza[0-9A-Za-z_\\-]{35}' +
    '|npm_[A-Za-z0-9]{30,}' +
    '|sbp_[A-Za-z0-9]{30,}|sb_secret_[A-Za-z0-9_\\-]{20,}' +
    '|pa-[A-Za-z0-9_\\-]{30,}' +
    '|mem_sk_[A-Za-z0-9_\\-]{20,}' +
    ')',
  'g',
)
const ENV_LINE = /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?))(\s*=\s*)(['"]?)([^\s'"]{4,})\3/g
const QUOTED =
  /\b((?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)['"]?\s*[:=]\s*)(['"])([^'"\s]{4,})\2/gi
const URL_PASSWORD = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/g

const ENV_NAME = /^[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIALS?)$/
const QUOTED_NAME =
  /(?:^|[^A-Za-z0-9_])(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)$/i
const REFERENCE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/

// The words D7 names for a flag or a query parameter whose value goes.
const SECRET_WORD = /key|token|secret|password|passwd|pwd|auth/i

type Mark = (name: string, value: string) => string

function applyPatterns(text: string, mark: Mark): string {
  let out = text.replace(PRIVATE_KEY, (m) => mark('private-key', m))
  out = out.replace(URL_PASSWORD, (_m, head: string, pw: string, at: string) => `${head}${mark('url-password', pw)}${at}`)
  out = out.replace(BEARER, (_m, head: string, token: string) => `${head}${mark('bearer', token)}`)
  out = out.replace(JWT, (m) => mark('jwt', m))
  out = out.replace(KEY_PREFIXES, (m) => mark('key', m))
  out = out.replace(
    ENV_LINE,
    (_m, name: string, eq: string, q: string, value: string) => `${name}${eq}${q}${mark(name, value)}${q}`,
  )
  return out.replace(QUOTED, (_m, head: string, q: string, value: string) => {
    const name = /^[A-Za-z_-]+/.exec(head)?.[0] ?? 'value'
    return `${head}${q}${mark(name, value)}${q}`
  })
}

// waku_domain.setup.holds_secret: a placeholder counts as already removed.
export function holdsSecret(text: string): boolean {
  const marked = text.replace(PLACEHOLDER, REDACTED)
  return applyPatterns(marked, () => REDACTED) !== marked
}

export function namesSecret(key: string): boolean {
  return ENV_NAME.test(key) || QUOTED_NAME.test(key)
}

function isValue(text: string): boolean {
  const bare = text.replace(PLACEHOLDER, '').split(REDACTED).join('').trim()
  return bare !== '' && !REFERENCE.test(bare)
}

// waku_domain.setup.value_holds_secret: each string on its own, and a
// string under a key that names a secret.
export function valueHoldsSecret(value: unknown, key?: string): boolean {
  if (Array.isArray(value)) return value.some((v) => valueHoldsSecret(v, key))
  if (isObject(value)) return Object.entries(value).some(([k, v]) => holdsSecret(k) || valueHoldsSecret(v, k))
  if (typeof value === 'string') return holdsSecret(value) || (key !== undefined && namesSecret(key) && isValue(value))
  return false
}

function placeholderName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'value'
}

// One save's remover: replaces a value with its placeholder and counts it,
// leaving a value that already is a placeholder as it is.
function remover(reading: SetupReading): Mark {
  return (name, value) => {
    if (IS_PLACEHOLDER.test(value)) return value
    reading.removed++
    return `<secret:${placeholderName(name)}>`
  }
}

// A placeholder already in the text is set aside first: its colon would
// read as a URL's `user:password`. The stand-in has no colon and no space.
export function scrubText(text: string, mark: Mark): string {
  const kept: string[] = []
  const hidden = text.replace(PLACEHOLDER, (p) => `\uE000${kept.push(p) - 1}\uE001`)
  const out = applyPatterns(hidden, (name, value) => (value.includes('\uE000') ? value : mark(name, value)))
  return out.replace(/\uE000(\d+)\uE001/g, (_m, index: string) => kept[Number(index)])
}

// Every string through the patterns, every URL through scrubUrl wherever it
// sits (a server reached through `mcp-remote <url>` has it in `args`, a
// marketplace in `source.url`), and a string under a secret's name replaced
// whole.
export function scrubValue(value: unknown, mark: Mark, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, mark, key))
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, mark, k)
    return out
  }
  if (typeof value !== 'string') return value
  const text = scrubText(URL_START.test(value) ? scrubUrl(value, mark) : value, mark)
  return key !== undefined && namesSecret(key) && isValue(text) ? mark(key, text) : text
}

export function scrubUrl(url: string, mark: Mark): string {
  const noUser = url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#@]+)@/, (_m, scheme: string, user: string) =>
    `${scheme}${mark('url-user', user)}@`,
  )
  return noUser.replace(/([?&])([^=&#]*)=([^&#]*)/g, (m, lead: string, name: string, value: string) =>
    value !== '' && SECRET_WORD.test(name) ? `${lead}${name}=${mark(name, value)}` : m,
  )
}

const URL_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

// A flag that names a secret: `--api-key`, `--token`, `-password`.
function secretFlag(arg: string): string | undefined {
  const m = /^--?([A-Za-z0-9_-]+)$/.exec(arg)
  return m && SECRET_WORD.test(m[1]) ? m[1] : undefined
}

export function scrubArgs(args: unknown[], mark: Mark): unknown[] {
  const out: unknown[] = []
  let after: string | undefined
  for (const arg of args) {
    if (typeof arg !== 'string') {
      out.push(arg)
      after = undefined
      continue
    }
    const inline = /^(--?([A-Za-z0-9_-]+))=(.+)$/.exec(arg)
    if (after !== undefined && !arg.startsWith('-')) out.push(mark(after, arg))
    else if (inline && SECRET_WORD.test(inline[2])) out.push(`${inline[1]}=${mark(inline[2], inline[3])}`)
    else out.push(arg)
    after = secretFlag(arg)
  }
  return out
}

// D7 for one MCP server, in any app's shape: Claude Code's and Cursor's
// `env` and `headers`, Codex's `env` and `http_headers`. Codex's
// `env_http_headers` and `bearer_token_env_var` name variables, not values,
// and stay. A `${VAR}` reference stays too: it holds nothing.
export function scrubServer(config: Record<string, unknown>, mark: Mark): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const field of ['env', 'headers', 'http_headers']) {
    const values = out[field]
    if (!isObject(values)) continue
    const kept: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(values)) {
      kept[name] = typeof value === 'string' && REFERENCE.test(value.trim()) ? value : mark(name, String(value))
    }
    out[field] = kept
  }
  if (Array.isArray(out.args)) out.args = scrubArgs(out.args, mark)
  return scrubValue(out, mark) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Reading: one function per row of D8's table
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(doc: unknown, key: string): Record<string, unknown> | undefined {
  if (!isObject(doc)) return undefined
  const value = doc[key]
  return isObject(value) && Object.keys(value).length > 0 ? value : undefined
}

export function display(home: string, path: string): string {
  const rel = relative(home, path)
  return rel.startsWith('..') ? path : `~/${rel.split(sep).join('/')}`
}

type Ctx = { place: SetupPlace; reading: SetupReading; mark: Mark; files: string[] }

function readText(ctx: Ctx, path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    const text = readFileSync(path, 'utf8')
    ctx.files.push(path)
    return text
  } catch {
    ctx.reading.unreadable.push(display(ctx.place.home, path))
    return undefined
  }
}

function readJson(ctx: Ctx, path: string): Record<string, unknown> | undefined {
  const text = readText(ctx, path)
  if (text === undefined || text.trim() === '') return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (isObject(parsed)) return parsed
  } catch {
    // Falls through to unreadable below.
  }
  ctx.reading.unreadable.push(display(ctx.place.home, path))
  return undefined
}

export const TYPE_WORD: Record<string, string> = {
  mcp_server: 'MCP server',
  plugin: 'plugin',
  marketplace: 'marketplace',
  scheduled_task: 'scheduled task',
  subagent: 'subagent',
  command: 'command',
  output_style: 'output style',
  hook: 'hook',
  permissions: 'permissions',
  settings: 'settings',
  // An account's items (spec 073 D6), which `setup list` prints too.
  connector: 'connector',
  project: 'project',
  custom_gpt: 'custom GPT',
}

function add(ctx: Ctx, item: SetupItem): void {
  const { reading } = ctx
  const what = `${TYPE_WORD[item.type] ?? item.type} "${item.name}"`
  if (reading.items.some((i) => i.type === item.type && i.app === item.app && i.name === item.name)) return
  if (item.name.length > NAME_CHARS) {
    reading.leftOut.push(`${TYPE_WORD[item.type] ?? item.type} "${item.name.slice(0, 40)}…": its name is over ${NAME_CHARS} characters`)
  } else if (valueHoldsSecret(item.body) || holdsSecret(item.name)) {
    reading.leftOut.push(`${what}: it may still hold a secret`)
  } else if (Buffer.byteLength(JSON.stringify(item.body)) > MAX_BODY_BYTES) {
    reading.leftOut.push(`${what}: over 64 KB`)
  } else if (reading.items.length >= MAX_ITEMS) {
    reading.leftOut.push(`${what}: over ${MAX_ITEMS} items`)
  } else {
    reading.items.push(item)
  }
}

function section(ctx: Ctx, path: string, value: Record<string, unknown>): void {
  if (Object.keys(value).length === 0) return
  ctx.reading.sections[display(ctx.place.home, path)] = valueHoldsSecret(value)
    ? 'left out: it may still hold a secret'
    : value
}

function addServers(
  ctx: Ctx,
  app: string,
  servers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const sent: Record<string, unknown> = {}
  for (const [name, config] of Object.entries(servers)) {
    if (!isObject(config)) continue
    const body = scrubServer(config, ctx.mark)
    sent[name] = body
    // A local-scope server is named for its project too, so the same server
    // in two projects is two items.
    const project = typeof extra.project === 'string' ? extra.project : undefined
    add(ctx, {
      type: 'mcp_server',
      app,
      name: project ? `${name} · ${basename(project)}` : name,
      body: project ? { ...body, ...extra, server: name } : { ...body, ...extra },
    })
  }
  return sent
}

// Markdown files under `dir`, by their path below it: `frontend/component`.
function markdownFiles(ctx: Ctx, dir: string, nested: boolean): { name: string; path: string }[] {
  const found: { name: string; path: string }[] = []
  const walk = (at: string, prefix: string) => {
    let entries
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name)
      if (entry.isDirectory() && nested) walk(path, `${prefix}${entry.name}/`)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push({ name: `${prefix}${entry.name.slice(0, -3)}`, path })
    }
  }
  if (existsSync(dir)) {
    ctx.files.push(dir)
    walk(dir, '')
  }
  return found
}

function addMarkdown(ctx: Ctx, app: string, type: string, dir: string, nested: boolean): void {
  for (const file of markdownFiles(ctx, dir, nested)) {
    const text = readText(ctx, file.path)
    if (text === undefined) continue
    add(ctx, {
      type,
      app,
      name: file.name,
      body: { file: display(ctx.place.home, file.path), text: scrubText(text, ctx.mark) },
    })
  }
}

function readClaudeCode(ctx: Ctx): void {
  const { home } = ctx.place
  const claudeJsonPath = join(home, '.claude.json')
  const claudeJson = readJson(ctx, claudeJsonPath)
  // Only the server lists: the rest of ~/.claude.json is the app's own state
  // (the account, history, tips) and never leaves the computer.
  const fromClaudeJson: Record<string, unknown> = {}
  const userServers = objectAt(claudeJson, 'mcpServers')
  if (userServers) fromClaudeJson.mcpServers = addServers(ctx, 'claude_code', userServers, { scope: 'user' })
  const projects: Record<string, unknown> = {}
  for (const [project, entry] of Object.entries(objectAt(claudeJson, 'projects') ?? {})) {
    const servers = objectAt(entry, 'mcpServers')
    if (servers) projects[project] = { mcpServers: addServers(ctx, 'claude_code', servers, { scope: 'local', project }) }
  }
  if (Object.keys(projects).length > 0) fromClaudeJson.projects = projects
  section(ctx, claudeJsonPath, fromClaudeJson)

  const settingsPath = join(home, '.claude', 'settings.json')
  const settings = readJson(ctx, settingsPath)
  const fromSettings: Record<string, unknown> = {}
  const marketplaces = objectAt(settings, 'extraKnownMarketplaces')
  if (marketplaces) {
    fromSettings.extraKnownMarketplaces = scrubValue(marketplaces, ctx.mark)
    for (const [name, value] of Object.entries(fromSettings.extraKnownMarketplaces as Record<string, unknown>)) {
      if (isObject(value)) add(ctx, { type: 'marketplace', app: 'claude_code', name, body: value })
    }
  }
  const plugins = objectAt(settings, 'enabledPlugins')
  if (plugins) {
    fromSettings.enabledPlugins = plugins
    for (const [name, on] of Object.entries(plugins)) {
      add(ctx, { type: 'plugin', app: 'claude_code', name, body: { enabled: on === true } })
    }
  }
  const hooks = objectAt(settings, 'hooks')
  if (hooks) {
    const kept: Record<string, unknown[]> = {}
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) continue
        // Waku's own hook is put back by "full-record on", from its own copy.
        const foreign = group.hooks.filter((h) => isObject(h) && !isOwnEntry(h as HookCommandEntry))
        if (foreign.length === 0) continue
        const matcher = typeof group.matcher === 'string' && group.matcher !== '' ? group.matcher : undefined
        const body = scrubValue({ ...group, hooks: foreign }, ctx.mark) as Record<string, unknown>
        ;(kept[event] ??= []).push(body)
        let name = matcher ? `${event} ${matcher}` : event
        for (let n = 2; ctx.reading.items.some((i) => i.type === 'hook' && i.app === 'claude_code' && i.name === name); n++) {
          name = `${matcher ? `${event} ${matcher}` : event} #${n}`
        }
        add(ctx, { type: 'hook', app: 'claude_code', name, body: { event, ...body } })
      }
    }
    if (Object.keys(kept).length > 0) fromSettings.hooks = kept
  }
  const permissions = objectAt(settings, 'permissions')
  if (permissions) {
    fromSettings.permissions = scrubValue(permissions, ctx.mark)
    add(ctx, { type: 'permissions', app: 'claude_code', name: 'permissions', body: fromSettings.permissions as Record<string, unknown> })
  }
  const chosen: Record<string, unknown> = {}
  for (const key of ['model', 'outputStyle']) {
    if (settings && typeof settings[key] === 'string') chosen[key] = settings[key]
  }
  if (Object.keys(chosen).length > 0) {
    Object.assign(fromSettings, chosen)
    add(ctx, { type: 'settings', app: 'claude_code', name: 'settings', body: chosen })
  }
  section(ctx, settingsPath, fromSettings)

  const knownPath = join(home, '.claude', 'plugins', 'known_marketplaces.json')
  const known = readJson(ctx, knownPath)
  const fromKnown: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(known ?? {})) {
    if (!isObject(value) || !isObject(value.source)) continue
    // Where it was cloned to and when is this computer's business.
    const body = { source: scrubValue(value.source, ctx.mark) }
    fromKnown[name] = body
    add(ctx, { type: 'marketplace', app: 'claude_code', name, body })
  }
  section(ctx, knownPath, fromKnown)

  addMarkdown(ctx, 'claude_code', 'subagent', join(home, '.claude', 'agents'), true)
  addMarkdown(ctx, 'claude_code', 'command', join(home, '.claude', 'commands'), true)
  addMarkdown(ctx, 'claude_code', 'output_style', join(home, '.claude', 'output-styles'), false)
}

// The keys of ~/.codex/config.toml that say how Codex runs, beside its
// servers and profiles. Everything else in the file stays on the computer.
const CODEX_SETTINGS = ['model', 'model_provider', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode', 'profile']

function readCodex(ctx: Ctx): void {
  const { home } = ctx.place
  const configPath = join(home, '.codex', 'config.toml')
  const text = readText(ctx, configPath)
  if (text !== undefined) {
    let doc: Record<string, unknown> | undefined
    try {
      doc = parseToml(text)
    } catch {
      ctx.reading.unreadable.push(display(home, configPath))
    }
    const fromConfig: Record<string, unknown> = {}
    const servers = objectAt(doc, 'mcp_servers')
    if (servers) fromConfig.mcp_servers = addServers(ctx, 'codex', servers)
    const chosen: Record<string, unknown> = {}
    for (const key of CODEX_SETTINGS) if (doc && doc[key] !== undefined) chosen[key] = doc[key]
    const sandbox = objectAt(doc, 'sandbox_workspace_write')
    if (sandbox) chosen.sandbox_workspace_write = sandbox
    if (Object.keys(chosen).length > 0) {
      const body = scrubValue(chosen, ctx.mark) as Record<string, unknown>
      Object.assign(fromConfig, body)
      add(ctx, { type: 'settings', app: 'codex', name: 'settings', body })
    }
    const profiles = objectAt(doc, 'profiles')
    if (profiles) {
      fromConfig.profiles = scrubValue(profiles, ctx.mark)
      for (const [name, value] of Object.entries(fromConfig.profiles as Record<string, unknown>)) {
        if (isObject(value)) add(ctx, { type: 'settings', app: 'codex', name: `profile ${name}`, body: value })
      }
    }
    section(ctx, configPath, fromConfig)
  }
  addMarkdown(ctx, 'codex', 'command', join(home, '.codex', 'prompts'), false)
}

function readServerFile(ctx: Ctx, app: string, path: string): void {
  const servers = objectAt(readJson(ctx, path), 'mcpServers')
  if (servers) section(ctx, path, { mcpServers: addServers(ctx, app, servers) })
}

// Cowork keeps each scheduled task as a folder with a SKILL.md; the
// folder's name is the task's.
function readCowork(ctx: Ctx): void {
  const dir = join(ctx.place.home, 'Documents', 'Claude', 'Scheduled')
  if (!existsSync(dir)) return
  ctx.files.push(dir)
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    ctx.reading.unreadable.push(display(ctx.place.home, dir))
    return
  }
  for (const name of names) {
    const path = join(dir, name, 'SKILL.md')
    const text = readText(ctx, path)
    if (text === undefined) continue
    add(ctx, {
      type: 'scheduled_task',
      app: 'cowork',
      name,
      body: { file: display(ctx.place.home, path), text: scrubText(text, ctx.mark) },
    })
  }
}

// Every file and folder D8 reads on this platform. Claude Desktop and
// Cowork are read on a Mac only: their Windows paths, and Gemini CLI's and
// Windsurf's anywhere, are unmeasured, and their readers wait on task T17.
function read(place: SetupPlace): { reading: SetupReading; files: string[] } {
  const reading: SetupReading = { items: [], sections: {}, removed: 0, leftOut: [], unreadable: [] }
  const ctx: Ctx = { place, reading, mark: remover(reading), files: [] }
  readClaudeCode(ctx)
  readCodex(ctx)
  readServerFile(ctx, 'cursor', join(place.home, '.cursor', 'mcp.json'))
  if (place.platform === 'darwin') {
    readServerFile(ctx, 'claude_desktop', join(place.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
    readCowork(ctx)
  }
  return { reading, files: ctx.files }
}

export function readSetup(place: SetupPlace): SetupReading {
  return read(place).reading
}

// ---------------------------------------------------------------------------
// A TOML reader for ~/.codex/config.toml
// ---------------------------------------------------------------------------

// The shim ships no runtime dependency (package.json), so this reads the
// TOML Codex writes and people hand-edit: tables, arrays of tables, dotted
// and quoted keys, the four string forms, numbers, booleans, arrays and
// inline tables. A date is kept as its text. Anything else throws, and the
// file is reported as unreadable rather than half read.
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let table = root
  let i = 0
  const n = text.length

  const fail = (what: string): never => {
    throw new Error(`${what} at offset ${i}`)
  }
  const skipSpace = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
  }
  const skipComment = () => {
    skipSpace()
    if (text[i] === '#') while (i < n && text[i] !== '\n') i++
  }
  // Blank lines and comments, between statements and inside arrays.
  const skipBlank = () => {
    for (;;) {
      while (i < n && ' \t\r\n'.includes(text[i])) i++
      if (text[i] !== '#') return
      while (i < n && text[i] !== '\n') i++
    }
  }
  const endOfLine = () => {
    skipComment()
    if (text[i] === '\r') i++
    if (i < n && text[i] !== '\n') fail('expected the end of the line')
    i++
  }
  const expect = (s: string) => {
    if (!text.startsWith(s, i)) fail(`expected "${s}"`)
    i += s.length
  }

  const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  const basicString = (): string => {
    const multi = text.startsWith('"""', i)
    i += multi ? 3 : 1
    if (multi && text[i] === '\r') i++
    if (multi && text[i] === '\n') i++
    let out = ''
    for (;;) {
      if (i >= n) fail('unterminated string')
      if (multi ? text.startsWith('"""', i) : text[i] === '"') {
        i += multi ? 3 : 1
        // """ may end with up to two more quotes that belong to the string.
        while (multi && text[i] === '"') {
          out += '"'
          i++
        }
        return out
      }
      const c = text[i]
      if (!multi && c === '\n') fail('newline in a string')
      if (c !== '\\') {
        out += c
        i++
        continue
      }
      const e = text[i + 1]
      if (multi && (e === '\n' || e === '\r' || e === ' ' || e === '\t')) {
        // A line-ending backslash drops the newline and the space after it.
        i++
        while (i < n && ' \t\r\n'.includes(text[i])) i++
        continue
      }
      if (e === 'u' || e === 'U') {
        const len = e === 'u' ? 4 : 8
        const hex = text.slice(i + 2, i + 2 + len)
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail('bad unicode escape')
        out += String.fromCodePoint(Number.parseInt(hex, 16))
        i += 2 + len
        continue
      }
      if (!(e in ESCAPES)) fail('bad escape')
      out += ESCAPES[e]
      i += 2
    }
  }
  const literalString = (): string => {
    const multi = text.startsWith("'''", i)
    i += multi ? 3 : 1
    if (multi && text[i] === '\r') i++
    if (multi && text[i] === '\n') i++
    const close = multi ? "'''" : "'"
    const end = text.indexOf(close, i)
    if (end < 0) fail('unterminated string')
    let stop = end
    while (multi && text[stop + 3] === "'") stop++
    const out = text.slice(i, stop)
    if (!multi && out.includes('\n')) fail('newline in a string')
    i = stop + close.length
    return out
  }

  const BARE = /[A-Za-z0-9_-]+/y
  const simpleKey = (): string => {
    if (text[i] === '"') return basicString()
    if (text[i] === "'") return literalString()
    BARE.lastIndex = i
    const m = BARE.exec(text)
    if (!m) return fail('expected a key')
    i += m[0].length
    return m[0]
  }
  const key = (): string[] => {
    const parts: string[] = []
    for (;;) {
      skipSpace()
      const part = simpleKey()
      if (part === '__proto__') fail('unsupported key')
      parts.push(part)
      skipSpace()
      if (text[i] !== '.') return parts
      i++
    }
  }
  const tableAt = (from: Record<string, unknown>, path: string[]): Record<string, unknown> => {
    let at = from
    for (const part of path) {
      let next = at[part]
      if (Array.isArray(next)) next = next[next.length - 1]
      if (next === undefined) {
        next = {}
        at[part] = next
      }
      if (!isObject(next)) fail(`"${part}" is not a table`)
      at = next as Record<string, unknown>
    }
    return at
  }
  const set = (into: Record<string, unknown>, path: string[], value: unknown) => {
    const parent = tableAt(into, path.slice(0, -1))
    parent[path[path.length - 1]] = value
  }

  const TOKEN = /[^,\]}\s#]+/y
  const NUMBER = /^[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?$/
  const value = (): unknown => {
    const c = text[i]
    if (c === '"') return basicString()
    if (c === "'") return literalString()
    if (c === '[') {
      i++
      const items: unknown[] = []
      for (;;) {
        skipBlank()
        if (text[i] === ']') break
        items.push(value())
        skipBlank()
        if (text[i] === ',') i++
        else if (text[i] !== ']') fail('expected "," or "]"')
      }
      i++
      return items
    }
    if (c === '{') {
      i++
      const inline: Record<string, unknown> = {}
      skipSpace()
      if (text[i] === '}') {
        i++
        return inline
      }
      for (;;) {
        const k = key()
        expect('=')
        skipSpace()
        set(inline, k, value())
        skipSpace()
        if (text[i] === ',') {
          i++
          continue
        }
        expect('}')
        return inline
      }
    }
    TOKEN.lastIndex = i
    const m = TOKEN.exec(text)
    if (!m) return fail('expected a value')
    i += m[0].length
    const token = m[0]
    if (token === 'true') return true
    if (token === 'false') return false
    if (NUMBER.test(token)) return Number(token.replace(/_/g, ''))
    if (/^[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+)$/.test(token)) return Number(token.replace(/_/g, ''))
    if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^\d{2}:\d{2}/.test(token) || /^[+-]?(?:inf|nan)$/.test(token)) return token
    return fail(`unexpected "${token}"`)
  }

  for (;;) {
    skipBlank()
    if (i >= n) return root
    if (text[i] === '[') {
      const array = text[i + 1] === '['
      i += array ? 2 : 1
      const path = key()
      expect(array ? ']]' : ']')
      if (array) {
        const parent = tableAt(root, path.slice(0, -1))
        const last = path[path.length - 1]
        const list = parent[last] ?? []
        if (!Array.isArray(list)) fail(`"${last}" is not an array of tables`)
        table = {}
        ;(list as unknown[]).push(table)
        parent[last] = list
      } else {
        table = tableAt(root, path)
      }
      endOfLine()
      continue
    }
    const path = key()
    expect('=')
    skipSpace()
    set(table, path, value())
    endOfLine()
  }
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export type SetupState = {
  label?: string
  auto?: boolean
  digest?: string // what the last save sent, so a background save can skip
  stamps?: Record<string, string> // size and time of each file read
  checked_at?: number
  saved_at?: string
}

export type SetupDeps = {
  home: string
  platform: NodeJS.Platform
  configDir: string // ~/.waku-memory: config.json (url and key) and setup.json
  computerName: string // real: os.hostname()
  fetchImpl: typeof fetch
  writeJsonFile: (path: string, data: unknown) => void
  now: () => number
  log: (line: string) => void
  error: (line: string) => void
}

export type SetupPayload = {
  source_kind: 'computer'
  source_label: string
  raw: string
  items: SetupItem[]
}

export function readSetupState(configDir: string): SetupState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, SETUP_STATE_FILE), 'utf8'))
    return isObject(parsed) ? (parsed as SetupState) : undefined
  } catch {
    return undefined
  }
}

export function readConfig(configDir: string): { url: string; key: string } | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, CONFIG_FILE_NAME), 'utf8'))
    if (!isObject(parsed)) return null
    const { url, key } = parsed
    return typeof url === 'string' && url !== '' && typeof key === 'string' && key !== '' ? { url, key } : null
  } catch {
    return null
  }
}

// "Ians-MacBook-Pro.local" reads as "Ians-MacBook-Pro".
export function computerLabel(hostname: string): string {
  return hostname.replace(/\.(local|lan|home)$/i, '').slice(0, LABEL_CHARS) || 'This computer'
}

// What the SessionStart check compares: each file's size and time, and each
// folder's, which moves when a file is added or removed.
export function stampsOf(paths: string[]): Record<string, string> {
  const stamps: Record<string, string> = {}
  for (const path of paths) {
    try {
      const s = statSync(path)
      stamps[path] = `${s.size}:${Math.round(s.mtimeMs)}`
    } catch {
      // Gone since it was read: no stamp, which differs from the last one.
    }
  }
  return stamps
}

function sameStamps(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false
  const keys = Object.keys(b)
  return keys.length === Object.keys(a).length && keys.every((k) => a[k] === b[k])
}

export function payloadFor(reading: SetupReading, label: string): SetupPayload {
  let raw = JSON.stringify({ saved_by: `waku-memory ${SHIM_VERSION}`, files: reading.sections })
  if (Buffer.byteLength(raw) > MAX_RAW_BYTES) {
    // Every item is still sent whole; only the copy of the files is cut.
    raw = JSON.stringify({ saved_by: `waku-memory ${SHIM_VERSION}`, files: 'left out: over 1 MB' })
  }
  return { source_kind: 'computer', source_label: label, raw, items: reading.items }
}

function digestOf(payload: SetupPayload): string {
  return createHash('sha256').update(JSON.stringify([payload.source_label, payload.items, payload.raw])).digest('hex')
}

export const APP_WORD: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  claude_desktop: 'Claude Desktop',
  cowork: 'Cowork',
  gemini_cli: 'Gemini CLI',
  windsurf: 'Windsurf',
  // An account's apps (spec 073 D6), which `setup list` prints too.
  claude_ai: 'claude.ai',
  chatgpt: 'ChatGPT',
}

export function summarize(reading: SetupReading): string[] {
  const byApp = new Map<string, Map<string, number>>()
  for (const item of reading.items) {
    const counts = byApp.get(item.app) ?? new Map<string, number>()
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
    byApp.set(item.app, counts)
  }
  const lines: string[] = []
  for (const [app, counts] of byApp) {
    const parts = [...counts].map(([type, count]) => {
      const word = TYPE_WORD[type] ?? type
      if (type === 'permissions' || type === 'settings') return word
      return `${count} ${word}${count === 1 ? '' : 's'}`
    })
    lines.push(`  ${APP_WORD[app] ?? app}: ${parts.join(', ')}`)
  }
  if (reading.removed > 0) {
    lines.push(
      `${reading.removed} secret value${reading.removed === 1 ? '' : 's'} stayed on this computer. The list shows each as <secret:NAME>.`,
    )
  }
  for (const why of reading.leftOut) lines.push(`Left out ${why}.`)
  for (const path of reading.unreadable) lines.push(`Could not read ${path}.`)
  return lines
}

export const SETUP_AUTO_OFF = 'npx waku-memory setup auto off'

// `setup save`. `auto` is the background save the SessionStart hook starts:
// it prints nothing, skips a save that would send what the last one sent,
// and skips one while a file could not be read, so a file caught mid-write
// never marks its items gone.
export async function setupSave(
  deps: SetupDeps,
  opts: { label?: string; dryRun?: boolean; auto?: boolean } = {},
): Promise<boolean> {
  const state = readSetupState(deps.configDir)
  if (opts.auto && (state?.auto === false || !state?.digest)) return true
  // A background save that fails waits out REFRESH_EVERY_MS like one that
  // succeeds, instead of starting again with the next session.
  if (opts.auto) deps.writeJsonFile(join(deps.configDir, SETUP_STATE_FILE), { ...state, checked_at: deps.now() })
  const label = (opts.label ?? state?.label ?? computerLabel(deps.computerName)).slice(0, LABEL_CHARS)
  const { reading, files } = read({ home: deps.home, platform: deps.platform })
  const payload = payloadFor(reading, label)
  const digest = digestOf(payload)
  const next: SetupState = { ...state, label, stamps: stampsOf(files), checked_at: deps.now() }

  if (opts.dryRun) {
    deps.log(`Found ${reading.items.length} item${reading.items.length === 1 ? '' : 's'} on this computer ("${label}"):`)
    for (const line of summarize(reading)) deps.log(line)
    deps.log('')
    deps.log('Nothing was sent. This is what "setup save" would send:')
    deps.log(JSON.stringify({ ...payload, raw: JSON.parse(payload.raw) as unknown }, null, 2))
    return true
  }
  if (opts.auto && (digest === state?.digest || reading.unreadable.length > 0)) {
    deps.writeJsonFile(join(deps.configDir, SETUP_STATE_FILE), next)
    return true
  }
  if (reading.items.length === 0 && !state?.digest) {
    deps.log('Found nothing to save on this computer.')
    return true
  }
  const config = readConfig(deps.configDir)
  if (!config) {
    deps.error(
      'No Waku key is saved on this computer, so nothing was saved. Run "npx -y waku-memory login" first, then try again.',
    )
    return false
  }

  let res: Response
  try {
    res = await deps.fetchImpl(`${config.url.replace(/\/+$/, '')}/setup/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    deps.error(`The setup was not saved: the request failed (${err instanceof Error ? err.message : String(err)}).`)
    return false
  }
  if (res.status === 401) {
    deps.error('Waku did not accept the saved key. Run "npx -y waku-memory login", then try again.')
    return false
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { detail?: unknown }
      if (typeof body.detail === 'string') detail = `: ${body.detail}`
    } catch {
      // No JSON body; the status alone is said.
    }
    deps.error(`The setup was not saved. Waku answered ${res.status}${detail}.`)
    return false
  }

  const first = !state?.digest
  deps.writeJsonFile(join(deps.configDir, SETUP_STATE_FILE), {
    ...next,
    auto: state?.auto ?? true,
    digest,
    saved_at: new Date(deps.now()).toISOString(),
  })
  if (opts.auto) return true
  const saved = (await res.json().catch(() => ({}))) as { added?: unknown; gone?: unknown }
  deps.log(`Saved the setup of "${label}": ${reading.items.length} item${reading.items.length === 1 ? '' : 's'}.`)
  for (const line of summarize(reading)) deps.log(line)
  if (!first && typeof saved.added === 'number' && typeof saved.gone === 'number') {
    deps.log(`Since the last save: ${saved.added} new, ${saved.gone} no longer on this computer.`)
  }
  if (first && state?.auto !== false) {
    deps.log(`From now on, a new session saves it again when these files change. "${SETUP_AUTO_OFF}" stops that.`)
  }
  return true
}

export function setupAuto(deps: Pick<SetupDeps, 'configDir' | 'writeJsonFile' | 'log'>, on: boolean): boolean {
  const state = readSetupState(deps.configDir) ?? {}
  deps.writeJsonFile(join(deps.configDir, SETUP_STATE_FILE), { ...state, auto: on })
  if (!on) deps.log('A new session no longer saves this computer\'s setup. "npx waku-memory setup save" still does.')
  else if (state.digest) deps.log('A new session saves this computer\'s setup again when its files change.')
  else deps.log('Run "npx waku-memory setup save" once; after that, a new session saves it when its files change.')
  return true
}

// T12's check, run by the SessionStart hook: true when a save has happened,
// auto is on, the last check is older than REFRESH_EVERY_MS, and a file
// read last time changed or a new one appeared. Only stats and folder
// listings: it reads no file.
export function setupNeedsRefresh(deps: Pick<SetupDeps, 'home' | 'platform' | 'configDir'>, now: number): boolean {
  const state = readSetupState(deps.configDir)
  if (!state?.digest || state.auto === false) return false
  if (typeof state.checked_at === 'number' && now - state.checked_at < REFRESH_EVERY_MS) return false
  return !sameStamps(state.stamps, stampsOf(watchedPaths({ home: deps.home, platform: deps.platform })))
}

// The paths `read` would stamp, found without reading any file.
export function watchedPaths(place: SetupPlace): string[] {
  const { home } = place
  const paths = [
    join(home, '.claude.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    join(home, '.codex', 'config.toml'),
    join(home, '.cursor', 'mcp.json'),
  ]
  if (place.platform === 'darwin') {
    paths.push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
  }
  const ctx: Ctx = {
    place,
    reading: { items: [], sections: {}, removed: 0, leftOut: [], unreadable: [] },
    mark: (_n, v) => v,
    files: [],
  }
  for (const [dir, nested] of [
    [join(home, '.claude', 'agents'), true],
    [join(home, '.claude', 'commands'), true],
    [join(home, '.claude', 'output-styles'), false],
    [join(home, '.codex', 'prompts'), false],
  ] as const) {
    paths.push(...markdownFiles(ctx, dir, nested).map((f) => f.path))
  }
  if (place.platform === 'darwin') {
    const scheduled = join(home, 'Documents', 'Claude', 'Scheduled')
    if (existsSync(scheduled)) {
      ctx.files.push(scheduled)
      try {
        for (const e of readdirSync(scheduled, { withFileTypes: true })) {
          if (e.isDirectory()) paths.push(join(scheduled, e.name, 'SKILL.md'))
        }
      } catch {
        // Unlistable: the folder's own stamp still counts.
      }
    }
  }
  return [...paths, ...ctx.files].filter((p) => existsSync(p))
}
