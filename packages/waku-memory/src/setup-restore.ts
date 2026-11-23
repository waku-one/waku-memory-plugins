// `setup restore` (spec 073 D9, task T16): re-creates on this computer the
// items a person picked from their setup list. The agent runs it after
// showing the list (`setup.list`), with the ids of the items they kept:
//
//   npx -y waku-memory setup restore --items <id,id,...> [--yes <id,...>]
//
// It writes an MCP server into the app's own file the way `setup` writes
// Waku's, adds marketplaces and installs plugins through `claude` when it is
// on the path, and writes a subagent, command or output-style file only
// where no file of that name exists. Nothing already here is overwritten: a
// server or file of the same name is left as it is and said.
//
// Some items need a yes each (D9): a hook, a permission list and an MCP
// server that runs a local command each run something or widen what an
// agent may do, and a marketplace or a plugin installs code (added after the
// flow review of 2026-11-11). They are written or installed only when their
// id is also in `--yes`,
// which the agent passes after the person said yes to that item; without it
// the item's full text is printed for the agent to show. A scheduled task
// and an account's items are the agent's own to re-create, and are printed
// for it. Every other item is reported back with POST /setup/marks as done,
// manual, skipped or failed, so the Setup page shows how the restore went.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { APP_WORD, TYPE_WORD, display, parseToml, readConfig } from './setup-list.ts'

export type ListedItem = {
  id: string
  type: string
  app: string
  name: string
  body: Record<string, unknown>
  gone_at?: string | null
  restore_state?: string | null
}

type ListedSource = { label: string; kind: string; saved_at?: string; items: ListedItem[] }

export type Mark = 'done' | 'manual' | 'skipped' | 'failed'

// `ask`: waits for its own yes. `agent`: the agent re-creates it. Neither is
// marked here; the agent marks them once it has.
export type Outcome = { item: ListedItem; state: Mark | 'ask' | 'agent'; note: string }

export type ClaudeRun = { ok: boolean; missing: boolean; output: string }

export type RestoreDeps = {
  home: string
  platform: NodeJS.Platform
  configDir: string // ~/.waku-memory: config.json holds the url and key
  fetchImpl: typeof fetch
  writeText: (path: string, text: string) => void // atomic, makes the folder
  runClaude: (args: string[]) => ClaudeRun // real: spawnSync('claude', args)
  log: (line: string) => void
  error: (line: string) => void
}

const NOTE_CHARS = 500 // waku_api.setup's cap on a mark's note
const PLACEHOLDER = /<secret:([A-Za-z0-9_.-]{1,100})>/g

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// The same value whatever order its keys were written in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function secretsIn(value: unknown): string[] {
  return [...new Set([...JSON.stringify(value).matchAll(PLACEHOLDER)].map((m) => m[1]))]
}

const ONE_PLACEHOLDER = /<secret:[A-Za-z0-9_.-]{1,100}>/

// Whether `current` is `saved` with each <secret:NAME> replaced by at least
// one character of text, and nothing else changed. A key the person has not
// filled in yet still matches, as its own placeholder text; alreadyHere then
// names it. The match walks the literal parts left to right with indexOf, so
// it takes linear time: a regex with several `.+` backtracked for minutes on
// a long value (review of 2026-11-12).
export function filledIn(saved: unknown, current: unknown): boolean {
  if (typeof saved === 'string') {
    if (typeof current !== 'string') return false
    const parts = saved.split(new RegExp(ONE_PLACEHOLDER.source))
    if (parts.length === 1) return saved === current
    const first = parts[0]
    const last = parts[parts.length - 1]
    if (!current.startsWith(first)) return false
    let at = first.length
    for (const middle of parts.slice(1, -1)) {
      const found = current.indexOf(middle, at + 1)
      if (found === -1) return false
      at = found + middle.length
    }
    return current.length - last.length >= at + 1 && current.endsWith(last)
  }
  if (Array.isArray(saved)) {
    return Array.isArray(current) && saved.length === current.length && saved.every((v, i) => filledIn(v, current[i]))
  }
  if (isObject(saved)) {
    if (!isObject(current)) return false
    const keys = Object.keys(saved)
    return (
      keys.length === Object.keys(current).length &&
      keys.every((k) => Object.hasOwn(current, k) && filledIn(saved[k], current[k]))
    )
  }
  return canonical(saved) === canonical(current)
}

function what(item: ListedItem): string {
  return `${APP_WORD[item.app] ?? item.app} ${TYPE_WORD[item.type] ?? item.type} "${item.name}"`
}

// Items that run something or widen what an agent may do (D9).
function needsYes(item: ListedItem): boolean {
  if (item.type === 'hook' || item.type === 'permissions') return true
  return item.type === 'mcp_server' && typeof item.body.command === 'string'
}

// `yes`: the person said yes to this item (--yes). A marketplace or a
// plugin installs code, so it waits for one too, but only when it would be
// installed: one already here, or one turned off, needs no yes.
type Ctx = { deps: RestoreDeps; item: ListedItem; yes: boolean }
type Result = { state: Mark | 'ask'; note: string }

const done = (note: string): Result => ({ state: 'done', note })
const manual = (note: string): Result => ({ state: 'manual', note })
const skipped = (note: string): Result => ({ state: 'skipped', note })
const failed = (note: string): Result => ({ state: 'failed', note })

// A JSON file as an object: {} when it is absent or blank, undefined when
// it is something this must not write over.
function readDoc(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return {}
  try {
    const text = readFileSync(path, 'utf8')
    if (text.trim() === '') return {}
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function child(parent: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (parent[key] === undefined) parent[key] = {}
  const value = parent[key]
  return isObject(value) ? value : undefined
}

// Done, unless what is now in `path` still holds a placeholder for the
// person to fill in.
function inPlace(ctx: Ctx, path: string, note: string): Result {
  const secrets = secretsIn(ctx.item.body)
  if (secrets.length === 0) return done(note)
  const where = display(ctx.deps.home, path)
  return manual(`${note}. It needs ${secrets.join(', ')}: put each in place of its <secret:NAME> in ${where}`)
}

function written(ctx: Ctx, path: string, text: string, note: string): Result {
  try {
    ctx.deps.writeText(path, text)
  } catch (err) {
    return failed(`could not write ${display(ctx.deps.home, path)}: ${err instanceof Error ? err.message : String(err)}`)
  }
  return inPlace(ctx, path, note)
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

function serverConfig(item: ListedItem): { name: string; config: Record<string, unknown> } {
  // `scope`, `project` and `server` were added by the save (setup-list.ts's
  // addServers); they say where the server goes, not what it is.
  const { scope: _scope, project: _project, server, ...config } = item.body
  return { name: typeof server === 'string' ? server : item.name, config }
}

// A server of this name is already here: the saved one (perhaps with keys
// still to fill in), the saved one with its keys filled in, or another one,
// which is left as it is.
function alreadyHere(ctx: Ctx, path: string, name: string, current: unknown, config: Record<string, unknown>): Result {
  const where = display(ctx.deps.home, path)
  if (canonical(current) === canonical(config)) return inPlace(ctx, path, `already in ${where}`)
  if (secretsIn(config).length > 0 && filledIn(config, current)) {
    const missing = secretsIn(current)
    if (missing.length > 0) {
      return manual(`already in ${where}; it still needs ${missing.join(', ')}: put each in place of its <secret:NAME> there`)
    }
    return done(`already in ${where}, with its keys filled in`)
  }
  return skipped(`a server named "${name}" is already in ${where}; left as it is`)
}

function putServer(
  ctx: Ctx,
  path: string,
  doc: Record<string, unknown>,
  servers: Record<string, unknown>,
  name: string,
  config: Record<string, unknown>,
): Result {
  const where = display(ctx.deps.home, path)
  const current = servers[name]
  if (current !== undefined) return alreadyHere(ctx, path, name, current, config)
  servers[name] = config
  return written(ctx, path, JSON.stringify(doc, null, 2) + '\n', `added to ${where}`)
}

function jsonServer(ctx: Ctx, path: string, appDir: string, appName: string): Result {
  if (!existsSync(appDir)) return skipped(`${appName} is not set up on this computer`)
  const doc = readDoc(path)
  const servers = doc && child(doc, 'mcpServers')
  if (!doc || !servers) return unreadable(ctx, path)
  const { name, config } = serverConfig(ctx.item)
  return putServer(ctx, path, doc, servers, name, config)
}

function claudeCodeServer(ctx: Ctx): Result {
  const { home } = ctx.deps
  const path = join(home, '.claude.json')
  if (!existsSync(path) && !existsSync(join(home, '.claude'))) return skipped('Claude Code is not set up on this computer')
  const { body } = ctx.item
  if (body.scope !== 'local') return jsonServer(ctx, path, home, 'Claude Code')
  const project = typeof body.project === 'string' ? body.project : ''
  const { name, config } = serverConfig(ctx.item)
  if (!project || !existsSync(project)) {
    return manual(`it was set for the project ${project || '(unnamed)'}, which is not on this computer. Add it in that project with "claude mcp add"`)
  }
  const doc = readDoc(path)
  const projects = doc && child(doc, 'projects')
  const entry = projects && child(projects, project)
  const servers = entry && child(entry, 'mcpServers')
  if (!doc || !servers) return unreadable(ctx, path)
  return putServer(ctx, path, doc, servers, name, config)
}

const TOML_BARE = /^[A-Za-z0-9_-]+$/

function tomlKey(key: string): string {
  return TOML_BARE.test(key) ? key : JSON.stringify(key)
}

// JSON's string escapes are all TOML basic-string escapes.
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`
  if (isObject(value)) {
    const pairs = Object.entries(value).filter(([, v]) => v !== null && v !== undefined)
    return `{ ${pairs.map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`).join(', ')} }`
  }
  throw new Error(`a value TOML cannot hold: ${String(value)}`)
}

function codexServer(ctx: Ctx): Result {
  const { home } = ctx.deps
  if (!existsSync(join(home, '.codex'))) return skipped('Codex is not set up on this computer')
  const path = join(home, '.codex', 'config.toml')
  const where = display(home, path)
  let text = ''
  let doc: Record<string, unknown>
  try {
    if (existsSync(path)) text = readFileSync(path, 'utf8')
    doc = parseToml(text)
  } catch {
    return unreadable(ctx, path)
  }
  const { name, config } = serverConfig(ctx.item)
  const current = isObject(doc.mcp_servers) ? doc.mcp_servers[name] : undefined
  if (current !== undefined) return alreadyHere(ctx, path, name, current, config)
  let next: string
  try {
    const lines = Object.entries(config)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
    const lead = text === '' || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    next = `${text}${lead}[mcp_servers.${tomlKey(name)}]\n${lines.join('\n')}\n`
    // Read back before writing: a file that holds `mcp_servers` as an inline
    // table cannot take a new table, and must not be broken trying.
    const back = parseToml(next).mcp_servers
    if (!isObject(back) || canonical(back[name]) !== canonical(config)) throw new Error('read back differs')
  } catch {
    return failed(`could not add it to ${where} without changing what is there; add it by hand`)
  }
  return written(ctx, path, next, `added to ${where}`)
}

function server(ctx: Ctx): Result {
  const { home, platform } = ctx.deps
  switch (ctx.item.app) {
    case 'claude_code':
      return claudeCodeServer(ctx)
    case 'codex':
      return codexServer(ctx)
    case 'cursor':
      return jsonServer(ctx, join(home, '.cursor', 'mcp.json'), join(home, '.cursor'), 'Cursor')
    case 'claude_desktop': {
      if (platform !== 'darwin') return skipped("Claude Desktop's servers are restored on a Mac")
      const dir = join(home, 'Library', 'Application Support', 'Claude')
      return jsonServer(ctx, join(dir, 'claude_desktop_config.json'), dir, 'Claude Desktop')
    }
    default:
      return manual(`${APP_WORD[ctx.item.app] ?? ctx.item.app} servers are added by hand`)
  }
}

// ---------------------------------------------------------------------------
// Claude Code: marketplaces and plugins, through `claude`
// ---------------------------------------------------------------------------

function lastLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1].slice(0, 200) : 'no output'
}

// On Windows `claude` is a .cmd file that only a shell finds, so its
// arguments pass through cmd.exe unquoted. A plugin name or a marketplace
// source from the saved list is only passed when it holds characters no
// shell gives a meaning to (flow review, 2026-11-11), and that does not
// start with a dash, which `claude` would read as an option of its own.
const SHELL_SAFE = /^(?!-)[A-Za-z0-9@._/:+=-]+$/

function runClaude(ctx: Ctx, args: string[], ok: string): Result {
  const command = `claude ${args.join(' ')}`
  if (!args.every((arg) => SHELL_SAFE.test(arg))) {
    return manual(`its name or source cannot be passed to "claude" safely; add it by hand with "/plugin" in Claude Code`)
  }
  if (!ctx.yes) return { state: 'ask', note: `would run "${command}"` }
  const run = ctx.deps.runClaude(args)
  if (run.missing) return manual(`"claude" is not on this computer's path. Run "${command}" once Claude Code is installed`)
  return run.ok ? done(ok) : failed(`"${command}" failed: ${lastLine(run.output)}`)
}

// Where a marketplace comes from, as `claude plugin marketplace add` takes it.
function marketplaceSource(body: Record<string, unknown>): string | undefined {
  const source = body.source
  if (!isObject(source)) return undefined
  for (const key of ['repo', 'url', 'path']) {
    if (typeof source[key] === 'string' && source[key] !== '') return source[key] as string
  }
  return undefined
}

function marketplace(ctx: Ctx): Result {
  const known = readDoc(join(ctx.deps.home, '.claude', 'plugins', 'known_marketplaces.json'))
  if (known && known[ctx.item.name] !== undefined) return done('already added')
  const source = marketplaceSource(ctx.item.body)
  if (!source) return manual('its source could not be read; add it with "/plugin marketplace add" in Claude Code')
  const secrets = secretsIn(source)
  if (secrets.length > 0) {
    return manual(`its address needs ${secrets.join(', ')}. Run "claude plugin marketplace add <address>" with them in place`)
  }
  return runClaude(ctx, ['plugin', 'marketplace', 'add', source], `added from ${source}`)
}

function plugin(ctx: Ctx): Result {
  if (ctx.item.body.enabled === false) return skipped('it was turned off on that computer')
  const settings = readDoc(join(ctx.deps.home, '.claude', 'settings.json'))
  const enabled = settings && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}
  if (enabled[ctx.item.name] === true) return done('already installed')
  return runClaude(ctx, ['plugin', 'install', ctx.item.name], 'installed')
}

// ---------------------------------------------------------------------------
// Files: subagents, commands, output styles
// ---------------------------------------------------------------------------

const FILE_PLACES: Record<string, { dir: string[]; nested: boolean }> = {
  'claude_code subagent': { dir: ['.claude', 'agents'], nested: true },
  'claude_code command': { dir: ['.claude', 'commands'], nested: true },
  'claude_code output_style': { dir: ['.claude', 'output-styles'], nested: false },
  'codex command': { dir: ['.codex', 'prompts'], nested: false },
}

// The name decides the path, so it may not climb out of its folder.
function safeParts(name: string, nested: boolean): string[] | undefined {
  const parts = name.split('/')
  if (!nested && parts.length > 1) return undefined
  if (parts.length > 5) return undefined
  const ok = parts.every((p) => p !== '' && p !== '.' && p !== '..' && !/[\\\0]/.test(p))
  return ok ? parts : undefined
}

function file(ctx: Ctx): Result {
  const { home } = ctx.deps
  const { item } = ctx
  const place = FILE_PLACES[`${item.app} ${item.type}`]
  if (!place) return manual(`${what(item)} is re-created by hand`)
  const appDir = item.app === 'codex' ? join(home, '.codex') : join(home, '.claude')
  if (!existsSync(appDir)) return skipped(`${APP_WORD[item.app] ?? item.app} is not set up on this computer`)
  const parts = safeParts(item.name, place.nested)
  if (!parts || typeof item.body.text !== 'string') return failed('its name or text cannot be written as a file')
  parts[parts.length - 1] += '.md'
  const path = join(home, ...place.dir, ...parts)
  const where = display(home, path)
  if (existsSync(path)) {
    let same = false
    try {
      same = readFileSync(path, 'utf8') === item.body.text
    } catch {
      // Unreadable: it is still a file of that name, and stays.
    }
    return same ? inPlace(ctx, path, `already at ${where}`) : skipped(`a file named ${where} is already here; left as it is`)
  }
  return written(ctx, path, item.body.text, `written to ${where}`)
}

// ---------------------------------------------------------------------------
// Claude Code settings, hooks and permissions; Codex settings
// ---------------------------------------------------------------------------

// ~/.claude/settings.json as an object, or why it cannot be written.
function settingsDoc(ctx: Ctx): { path: string; doc: Record<string, unknown> } | Result {
  const { home } = ctx.deps
  if (!existsSync(join(home, '.claude'))) return skipped('Claude Code is not set up on this computer')
  const path = join(home, '.claude', 'settings.json')
  const doc = readDoc(path)
  return doc ? { path, doc } : unreadable(ctx, path)
}

function unreadable(ctx: Ctx, path: string): Result {
  return failed(`could not read ${display(ctx.deps.home, path)}; left it untouched`)
}

function claudeSettings(ctx: Ctx): Result {
  const at = settingsDoc(ctx)
  if ('state' in at) return at
  const { path, doc } = at
  const set: string[] = []
  const kept: string[] = []
  for (const [key, value] of Object.entries(ctx.item.body)) {
    if (doc[key] === undefined) {
      doc[key] = value
      set.push(`${key} ${JSON.stringify(value)}`)
    } else if (canonical(doc[key]) !== canonical(value)) {
      kept.push(`${key} stays ${JSON.stringify(doc[key])}`)
    }
  }
  const keptNote = kept.length > 0 ? `; ${kept.join(', ')}` : ''
  if (set.length > 0) return written(ctx, path, JSON.stringify(doc, null, 2) + '\n', `set ${set.join(', ')}${keptNote}`)
  return kept.length > 0 ? skipped(`already set here: ${kept.join(', ')}`) : done('already set')
}

function hook(ctx: Ctx): Result {
  const { event, ...group } = ctx.item.body
  if (typeof event !== 'string' || !Array.isArray(group.hooks)) return failed('it is not a hook Claude Code can read')
  const secrets = secretsIn(group)
  if (secrets.length > 0) {
    // A hook runs at every event; one that would run with a placeholder in
    // it is not written.
    return manual(`it needs ${secrets.join(', ')}. Add it to ~/.claude/settings.json by hand with them in place`)
  }
  const at = settingsDoc(ctx)
  if ('state' in at) return at
  const { path, doc } = at
  const hooks = child(doc, 'hooks')
  if (!hooks) return unreadable(ctx, path)
  if (hooks[event] === undefined) hooks[event] = []
  const groups = hooks[event]
  if (!Array.isArray(groups)) return unreadable(ctx, path)
  if (groups.some((g) => canonical(g) === canonical(group))) return done('already there')
  groups.push(group)
  return written(ctx, path, JSON.stringify(doc, null, 2) + '\n', `added to ${display(ctx.deps.home, path)}`)
}

function permissions(ctx: Ctx): Result {
  const at = settingsDoc(ctx)
  if ('state' in at) return at
  const { path, doc } = at
  const current = child(doc, 'permissions')
  if (!current) return unreadable(ctx, path)
  let added = 0
  const kept: string[] = []
  for (const [key, value] of Object.entries(ctx.item.body)) {
    if (Array.isArray(value)) {
      if (current[key] === undefined) current[key] = []
      const list = current[key]
      if (!Array.isArray(list)) {
        kept.push(key)
        continue
      }
      for (const rule of value) {
        if (!list.some((r) => canonical(r) === canonical(rule))) {
          list.push(rule)
          added++
        }
      }
    } else if (current[key] === undefined) {
      current[key] = value
      added++
    } else if (canonical(current[key]) !== canonical(value)) {
      kept.push(`${key} stays ${JSON.stringify(current[key])}`)
    }
  }
  const keptNote = kept.length > 0 ? `; ${kept.join(', ')}` : ''
  if (added === 0) return kept.length > 0 ? skipped(`already set here: ${kept.join(', ')}`) : done('already there')
  return written(ctx, path, JSON.stringify(doc, null, 2) + '\n', `added ${added} to ${display(ctx.deps.home, path)}${keptNote}`)
}

// Codex's model, approvals and sandbox: shown, not written. They change how
// every Codex session runs, and the file is the person's to edit.
function codexSettings(ctx: Ctx): Result {
  const table = ctx.item.name.startsWith('profile ') ? `[profiles.${tomlKey(ctx.item.name.slice(8))}] ` : ''
  let lines: string
  try {
    lines = Object.entries(ctx.item.body)
      .map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
      .join(', ')
  } catch {
    lines = JSON.stringify(ctx.item.body)
  }
  return manual(`set it in ~/.codex/config.toml by hand: ${table}${lines}`)
}

function restoreOne(ctx: Ctx): Result {
  const { item } = ctx
  switch (item.type) {
    case 'mcp_server':
      return server(ctx)
    case 'marketplace':
      return item.app === 'claude_code' ? marketplace(ctx) : manual('added by hand')
    case 'plugin':
      return item.app === 'claude_code' ? plugin(ctx) : manual('installed by hand')
    case 'subagent':
    case 'command':
    case 'output_style':
      return file(ctx)
    case 'settings':
      return item.app === 'claude_code' ? claudeSettings(ctx) : codexSettings(ctx)
    case 'hook':
      return item.app === 'claude_code' ? hook(ctx) : manual('added by hand')
    case 'permissions':
      return item.app === 'claude_code' ? permissions(ctx) : manual('set by hand')
    default:
      return manual(`${TYPE_WORD[item.type] ?? item.type} is re-created by hand`)
  }
}

// Marketplaces before plugins, so a plugin's marketplace is there when it
// is installed.
const ORDER = ['marketplace', 'plugin']

function rank(item: ListedItem): number {
  const at = ORDER.indexOf(item.type)
  return at === -1 ? ORDER.length : at
}

export function planRestore(
  deps: RestoreDeps,
  sources: ListedSource[],
  ids: string[],
  yes: Set<string>,
): { outcomes: Outcome[]; unknown: string[] } {
  const byId = new Map<string, { item: ListedItem; kind: string }>()
  for (const source of sources) for (const item of source.items) byId.set(item.id, { item, kind: source.kind })
  const unknown = ids.filter((id) => !byId.has(id))
  const picked = [...new Set(ids)].flatMap((id) => {
    const found = byId.get(id)
    return found ? [found] : []
  })
  picked.sort((a, b) => rank(a.item) - rank(b.item))
  const outcomes: Outcome[] = []
  for (const { item, kind } of picked) {
    if (kind !== 'computer') {
      outcomes.push({ item, state: 'agent', note: "an account's item: re-create it with the agent's own tools" })
    } else if (item.type === 'scheduled_task') {
      outcomes.push({ item, state: 'agent', note: 'show its text, and after a yes re-create it with the app\'s own scheduled-task tool' })
    } else if (needsYes(item) && !yes.has(item.id)) {
      outcomes.push({ item, state: 'ask', note: JSON.stringify(item.body) })
    } else {
      const result = restoreOne({ deps, item, yes: yes.has(item.id) })
      outcomes.push({ item, state: result.state, note: result.note })
    }
  }
  return { outcomes, unknown }
}

const HEADINGS: [Outcome['state'], string, string][] = [
  ['done', 'Done', ''],
  ['manual', 'Needs a hand', ''],
  ['skipped', 'Left as it was', ''],
  ['failed', 'Failed', ''],
  ['ask', 'Waiting for a yes', '. Show each one to the person, and run again with --yes <id> for the ones they agree to'],
  ['agent', 'For the agent to re-create', ''],
]

export function reportLines(outcomes: Outcome[]): string[] {
  const lines: string[] = []
  for (const [state, heading, hint] of HEADINGS) {
    const these = outcomes.filter((o) => o.state === state)
    if (these.length === 0) continue
    lines.push(`${heading} (${these.length})${hint}:`)
    for (const o of these) {
      const id = state === 'ask' || state === 'agent' ? `${o.item.id} ` : ''
      lines.push(`  ${id}${what(o.item)}: ${o.note}`)
    }
  }
  return lines
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown }
    return typeof body.detail === 'string' ? `: ${body.detail}` : ''
  } catch {
    return ''
  }
}

type ListDeps = Pick<RestoreDeps, 'configDir' | 'fetchImpl' | 'log' | 'error'>
type Connection = { base: string; headers: Record<string, string> }

function connect(deps: ListDeps): Connection | null {
  const config = readConfig(deps.configDir)
  if (!config) {
    deps.error(
      'No Waku key is saved on this computer, so nothing was read or changed. Run "npx -y waku-memory login" first, then try again.',
    )
    return null
  }
  return {
    base: config.url.replace(/\/+$/, ''),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
  }
}

// GET /setup, or null after saying why it could not be read.
async function fetchList(deps: ListDeps, { base, headers }: Connection): Promise<ListedSource[] | null> {
  try {
    const res = await deps.fetchImpl(`${base}/setup`, { headers })
    if (res.status === 401) {
      deps.error('Waku did not accept the saved key. Run "npx -y waku-memory login", then try again.')
      return null
    }
    if (!res.ok) {
      deps.error(`Could not read the setup list. Waku answered ${res.status}${await errorDetail(res)}.`)
      return null
    }
    const body = (await res.json()) as { sources?: unknown }
    return Array.isArray(body.sources) ? (body.sources as ListedSource[]) : []
  } catch (err) {
    deps.error(`Could not read the setup list: the request failed (${err instanceof Error ? err.message : String(err)}).`)
    return null
  }
}

// What a restore of this item will ask for, and what happened to it before.
function flagsOf(item: ListedItem): string[] {
  const flags: string[] = []
  if (item.gone_at) flags.push(`gone from there since ${item.gone_at.slice(0, 10)}`)
  if (needsYes(item)) flags.push('needs a yes')
  const secrets = secretsIn(item.body)
  if (secrets.length > 0) flags.push(`needs ${secrets.join(', ')}`)
  if (item.restore_state) flags.push(`restored before: ${item.restore_state}`)
  return flags
}

// `setup list` (Ian, 2026-11-10): the saved list with each item's id, which
// `setup restore --items` takes. It serves a person in a terminal without an
// agent; an agent reads the same list with the setup.list tool, and the
// console's Setup page (T13) is not built.
export async function listSetup(deps: ListDeps): Promise<boolean> {
  const connection = connect(deps)
  if (!connection) return false
  const sources = await fetchList(deps, connection)
  if (!sources) return false
  if (sources.every((s) => s.items.length === 0)) {
    deps.log('The setup list is empty. Run "npx -y waku-memory setup save" on the computer you are moving from.')
    return true
  }
  for (const source of sources) {
    const n = source.items.length
    const saved = source.saved_at ? `, saved ${source.saved_at.slice(0, 10)}` : ''
    deps.log(`${source.label} (${source.kind}${saved}): ${n} item${n === 1 ? '' : 's'}`)
    for (const item of source.items) {
      const flags = flagsOf(item)
      deps.log(`  ${item.id} ${what(item)}${flags.length > 0 ? ` (${flags.join('; ')})` : ''}`)
    }
    deps.log('')
  }
  deps.log('To restore: npx -y waku-memory setup restore --items <id,id,...>')
  return true
}

export async function setupRestore(deps: RestoreDeps, opts: { ids: string[]; yes: string[] }): Promise<boolean> {
  const connection = connect(deps)
  if (!connection) return false
  const { base, headers } = connection
  const sources = await fetchList(deps, connection)
  if (!sources) return false

  const { outcomes, unknown } = planRestore(deps, sources, opts.ids, new Set(opts.yes))
  for (const id of unknown) deps.error(`Not in the setup list: ${id}`)
  if (outcomes.length === 0) {
    deps.error('Nothing to restore: none of the ids is in the setup list.')
    return false
  }
  const marked = outcomes.filter((o) => o.state !== 'ask' && o.state !== 'agent')
  deps.log(`Restored ${marked.filter((o) => o.state === 'done').length} of ${outcomes.length} item${outcomes.length === 1 ? '' : 's'}.`)
  for (const line of reportLines(outcomes)) deps.log(line)
  if (marked.length === 0) return true

  try {
    const res = await deps.fetchImpl(`${base}/setup/marks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        marks: marked.map((o) => ({ id: o.item.id, state: o.state, note: o.note.slice(0, NOTE_CHARS) })),
      }),
    })
    if (!res.ok) {
      deps.error(`The Setup page will not show this restore. Waku answered ${res.status}${await errorDetail(res)}.`)
      return false
    }
  } catch (err) {
    deps.error(`The Setup page will not show this restore: the request failed (${err instanceof Error ? err.message : String(err)}).`)
    return false
  }
  return !marked.some((o) => o.state === 'failed')
}
