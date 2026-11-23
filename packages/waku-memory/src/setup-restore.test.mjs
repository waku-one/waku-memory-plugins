// spec 073 D9 (task T16): `setup restore` re-creates the picked items on
// this computer. Acceptance 8: on an empty home it re-creates the MCP
// entries and the files, overwrites no existing file, and writes no hook,
// permission rule or stdio server without its own yes. Temp directories, an
// injected fetchImpl and a fake `claude` only: nothing here touches a real
// home directory, the network or a real Claude Code.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { dispatch, writeCodexText } from './cli.ts'
import { parseToml, readSetup } from './setup-list.ts'
import { filledIn, listSetup, setupRestore } from './setup-restore.ts'

const GHP = 'ghp_' + 'a'.repeat(36)

function put(home, path, content) {
  const full = join(home, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}

function json(home, path) {
  return JSON.parse(readFileSync(join(home, path), 'utf8'))
}

// The old computer: what `setup save` reads becomes the list restore gets.
function oldComputer() {
  const home = mkdtempSync(join(tmpdir(), 'waku-old-'))
  put(home, '.claude.json', {
    mcpServers: {
      sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer abcdefghijkl12345' } },
      docs: { type: 'http', url: 'https://docs.example.test/mcp' },
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: GHP } },
    },
    projects: { '/Users/ian/code/app': { mcpServers: { db: { command: 'pg-mcp' } } } },
  })
  put(home, '.claude/settings.json', {
    model: 'opus',
    enabledPlugins: { 'waku@waku-memory': true, 'old@somewhere': false },
    extraKnownMarketplaces: { 'waku-memory': { source: { source: 'github', repo: 'waku-one/waku-memory-plugins' } } },
    permissions: { allow: ['Bash(npm run test)'] },
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] },
  })
  put(home, '.claude/agents/reviewer.md', '---\nname: reviewer\n---\nReview the diff.\n')
  put(home, '.claude/commands/frontend/component.md', 'Make a component.\n')
  put(home, '.claude/output-styles/terse.md', 'Be terse.\n')
  put(home, '.codex/config.toml', '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n\n[mcp_servers.local]\ncommand = "local-mcp"\n')
  put(home, '.codex/prompts/fix.md', 'Fix the failing test.\n')
  put(home, '.cursor/mcp.json', { mcpServers: { figma: { url: 'https://mcp.figma.com/mcp?token=figd_abcdef' } } })
  put(home, 'Documents/Claude/Scheduled/daily-picks/SKILL.md', 'Every weekday at 8:00, list three articles.\n')
  return home
}

function listFrom(home, platform = 'darwin') {
  const items = readSetup({ home, platform }).items.map((item, n) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    snapshot_id: 'snap',
    ...item,
  }))
  return { sources: [{ label: 'Old Mac', kind: 'computer', snapshot_id: 'snap', saved_at: '2026-11-09T10:00:00.123456Z', items }] }
}

function idOf(list, type, name) {
  const found = list.sources.flatMap((s) => s.items).find((i) => i.type === type && i.name === name)
  assert.ok(found, `${type} ${name} is in the list`)
  return found.id
}

// A new computer: the apps are installed, nothing is set up.
function newComputer() {
  const home = mkdtempSync(join(tmpdir(), 'waku-new-'))
  for (const dir of ['.claude', '.codex', '.cursor', 'Library/Application Support/Claude']) mkdirSync(join(home, dir), { recursive: true })
  put(home, '.claude.json', { numStartups: 1 })
  const configDir = join(home, '.waku-memory')
  put(home, '.waku-memory/config.json', { url: 'https://api.waku.test', key: 'wk_test' })
  return { home, configDir }
}

function harness(home, configDir, list, { claude = 'ok' } = {}) {
  const requests = []
  const claudeRuns = []
  const lines = []
  const errors = []
  const deps = {
    home,
    platform: 'darwin',
    configDir,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization })
      if (url.endsWith('/setup')) return new Response(JSON.stringify(list), { status: 200 })
      const marks = JSON.parse(init.body).marks
      return new Response(JSON.stringify({ marked: marks.length, unknown: [] }), { status: 200 })
    },
    writeText: writeCodexText,
    runClaude: (args) => {
      claudeRuns.push(args.join(' '))
      if (claude === 'missing') return { ok: false, missing: true, output: '' }
      if (claude === 'fails') return { ok: false, missing: false, output: 'Error: marketplace not found\n' }
      return { ok: true, missing: false, output: '' }
    },
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  }
  return { deps, requests, claudeRuns, lines, errors }
}

function marksOf(requests) {
  const post = requests.find((r) => r.method === 'POST')
  return Object.fromEntries((post?.body.marks ?? []).map((m) => [m.id, m]))
}

test('acceptance 8: an empty computer gets the servers and files, and nothing that needs a yes', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  const all = list.sources[0].items.map((i) => i.id)
  const h = harness(home, configDir, list)

  assert.equal(await setupRestore(h.deps, { ids: all, yes: [] }), true)

  // Remote servers in each app's own file; a stdio server waits for a yes.
  const claude = json(home, '.claude.json')
  assert.equal(claude.numStartups, 1, 'the rest of ~/.claude.json is kept')
  assert.deepEqual(Object.keys(claude.mcpServers).sort(), ['docs', 'sentry'])
  assert.deepEqual(claude.mcpServers.sentry.headers, { Authorization: '<secret:Authorization>' })
  assert.equal(claude.projects, undefined, 'the local-scope server waits for a yes')
  assert.deepEqual(json(home, '.cursor/mcp.json').mcpServers.figma, { url: 'https://mcp.figma.com/mcp?token=<secret:token>' })
  const codex = parseToml(readFileSync(join(home, '.codex/config.toml'), 'utf8'))
  assert.deepEqual(codex.mcp_servers, { linear: { url: 'https://mcp.linear.app/mcp' } })

  // Files where none was.
  assert.equal(readFileSync(join(home, '.claude/agents/reviewer.md'), 'utf8'), '---\nname: reviewer\n---\nReview the diff.\n')
  assert.equal(readFileSync(join(home, '.claude/commands/frontend/component.md'), 'utf8'), 'Make a component.\n')
  assert.equal(readFileSync(join(home, '.claude/output-styles/terse.md'), 'utf8'), 'Be terse.\n')
  assert.equal(readFileSync(join(home, '.codex/prompts/fix.md'), 'utf8'), 'Fix the failing test.\n')

  // Settings without a yes; no hook and no permission rule.
  const settings = json(home, '.claude/settings.json')
  assert.deepEqual(settings, { model: 'opus' })
  assert.ok(!existsSync(join(home, 'Documents/Claude/Scheduled')), 'a scheduled task is the agent\'s')

  // A marketplace and a plugin install code, so each waits for its own yes;
  // a plugin turned off stays off without asking.
  assert.deepEqual(h.claudeRuns, [])

  const marks = marksOf(h.requests)
  assert.equal(h.requests[0].auth, 'Bearer wk_test')
  assert.equal(marks[idOf(list, 'mcp_server', 'docs')].state, 'done')
  assert.equal(marks[idOf(list, 'mcp_server', 'sentry')].state, 'manual')
  assert.match(marks[idOf(list, 'mcp_server', 'sentry')].note, /needs Authorization: .* in ~\/\.claude\.json/)
  assert.equal(marks[idOf(list, 'plugin', 'old@somewhere')].state, 'skipped')
  for (const [type, name] of [['mcp_server', 'github'], ['mcp_server', 'db · app'], ['mcp_server', 'local'], ['hook', 'PostToolUse Edit'], ['permissions', 'permissions'], ['scheduled_task', 'daily-picks'], ['marketplace', 'waku-memory'], ['plugin', 'waku@waku-memory']]) {
    assert.equal(marks[idOf(list, type, name)], undefined, `${type} ${name} is not marked by the shim`)
  }
  const out = h.lines.join('\n')
  assert.match(out, /Waiting for a yes \(7\)/)
  assert.match(out, new RegExp(`${idOf(list, 'hook', 'PostToolUse Edit')} Claude Code hook "PostToolUse Edit": .*npm run lint`))
  assert.match(out, /For the agent to re-create \(1\):\n.*Cowork scheduled task "daily-picks"/)
})

test('acceptance 8: nothing already here is overwritten, and a second run changes nothing', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  put(home, '.claude.json', { mcpServers: { docs: { type: 'http', url: 'https://other.test/mcp' } } })
  put(home, '.claude/agents/reviewer.md', 'My own reviewer.\n')
  put(home, '.claude/settings.json', { model: 'sonnet', enabledPlugins: { 'waku@waku-memory': true } })
  put(home, '.claude/plugins/known_marketplaces.json', { 'waku-memory': { source: { source: 'github', repo: 'x/y' } } })
  const ids = ['docs', 'reviewer', 'settings', 'waku@waku-memory', 'waku-memory'].map((name) =>
    list.sources[0].items.find((i) => i.name === name).id,
  )

  const first = harness(home, configDir, list)
  await setupRestore(first.deps, { ids, yes: [] })
  assert.deepEqual(json(home, '.claude.json').mcpServers.docs, { type: 'http', url: 'https://other.test/mcp' })
  assert.equal(readFileSync(join(home, '.claude/agents/reviewer.md'), 'utf8'), 'My own reviewer.\n')
  assert.equal(json(home, '.claude/settings.json').model, 'sonnet')
  assert.deepEqual(first.claudeRuns, [], 'an added marketplace and an installed plugin are not run again')
  const marks = marksOf(first.requests)
  assert.deepEqual(ids.map((id) => marks[id].state), ['skipped', 'skipped', 'skipped', 'done', 'done'])
  assert.match(marks[ids[0]].note, /a server named "docs" is already in ~\/\.claude\.json; left as it is/)

  // An empty home restored twice: the second run finds everything in place.
  const fresh = newComputer()
  const once = list.sources[0].items.filter((i) => ['docs', 'reviewer', 'linear', 'fix'].includes(i.name)).map((i) => i.id)
  await setupRestore(harness(fresh.home, fresh.configDir, list).deps, { ids: once, yes: [] })
  const before = readFileSync(join(fresh.home, '.codex/config.toml'), 'utf8')
  const again = harness(fresh.home, fresh.configDir, list)
  await setupRestore(again.deps, { ids: once, yes: [] })
  assert.equal(readFileSync(join(fresh.home, '.codex/config.toml'), 'utf8'), before)
  assert.deepEqual(Object.values(marksOf(again.requests)).map((m) => m.state), ['done', 'done', 'done', 'done'])
})

test('a yes writes the hook, the permissions and the stdio servers', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  mkdirSync(join(home, 'code', 'app'), { recursive: true })
  // The project the local-scope server was set for, at the same path here.
  const item = list.sources[0].items.find((i) => i.name === 'db · app')
  item.body = { ...item.body, project: join(home, 'code', 'app') }
  const yes = [
    idOf(list, 'hook', 'PostToolUse Edit'),
    idOf(list, 'permissions', 'permissions'),
    idOf(list, 'mcp_server', 'github'),
    idOf(list, 'mcp_server', 'db · app'),
    idOf(list, 'mcp_server', 'local'),
  ]
  const h = harness(home, configDir, list)
  assert.equal(await setupRestore(h.deps, { ids: yes, yes }), true)

  const settings = json(home, '.claude/settings.json')
  assert.deepEqual(settings.hooks, { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }] })
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm run test)'] })
  const claude = json(home, '.claude.json')
  assert.deepEqual(claude.mcpServers.github.env, { GITHUB_TOKEN: '<secret:GITHUB_TOKEN>' })
  assert.deepEqual(claude.projects[join(home, 'code', 'app')].mcpServers, { db: { command: 'pg-mcp' } })
  const codex = parseToml(readFileSync(join(home, '.codex/config.toml'), 'utf8'))
  assert.deepEqual(codex.mcp_servers.local, { command: 'local-mcp' })
  const marks = marksOf(h.requests)
  assert.equal(marks[idOf(list, 'mcp_server', 'github')].state, 'manual', 'it still needs its token')

  // The permission list again adds nothing.
  const again = harness(home, configDir, list)
  await setupRestore(again.deps, { ids: [yes[1]], yes })
  assert.deepEqual(json(home, '.claude/settings.json').permissions, { allow: ['Bash(npm run test)'] })
  assert.equal(marksOf(again.requests)[yes[1]].state, 'done')
})

// A restore writes a server with <secret:NAME> where its key goes; the
// person then fills the key in. A second restore used to call that server
// "skipped", because the file no longer matched the saved list.
test('a server whose keys the person filled in reads as done on a second restore', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  const github = idOf(list, 'mcp_server', 'github')
  const sentry = idOf(list, 'mcp_server', 'sentry')
  const figma = idOf(list, 'mcp_server', 'figma')
  await setupRestore(harness(home, configDir, list).deps, { ids: [github, sentry, figma], yes: [github] })

  const claude = json(home, '.claude.json')
  claude.mcpServers.github.env.GITHUB_TOKEN = 'ghp_' + 'b'.repeat(36)
  claude.mcpServers.sentry.headers.Authorization = 'Bearer abcdefghijkl12345'
  put(home, '.claude.json', claude)
  const cursor = json(home, '.cursor/mcp.json')
  cursor.mcpServers.figma.url = 'https://mcp.figma.com/mcp?token=figd_filled'
  put(home, '.cursor/mcp.json', cursor)

  const again = harness(home, configDir, list)
  await setupRestore(again.deps, { ids: [github, sentry, figma], yes: [github] })
  for (const id of [github, sentry, figma]) {
    assert.equal(marksOf(again.requests)[id].state, 'done', id)
    assert.match(marksOf(again.requests)[id].note, /with its keys filled in/)
  }

  // A server that differs anywhere a key does not go is still left alone.
  claude.mcpServers.sentry.url = 'https://other.test/mcp'
  put(home, '.claude.json', claude)
  const third = harness(home, configDir, list)
  await setupRestore(third.deps, { ids: [sentry], yes: [] })
  assert.equal(marksOf(third.requests)[sentry].state, 'skipped')
})

// Review of 2026-11-12: with two keys and one filled in, the server is not
// done; the restore says which key is still missing.
test('a server with one of its two keys filled in still needs the other', async () => {
  const { home, configDir } = newComputer()
  const item = {
    id: 'two', type: 'mcp_server', app: 'claude_code', name: 'api',
    body: { type: 'http', url: 'https://api.example.test/mcp', headers: { A: '<secret:A>', B: 'Bearer <secret:B>' } },
  }
  const list = { sources: [{ label: 'Mac', kind: 'computer', items: [item] }] }
  await setupRestore(harness(home, configDir, list).deps, { ids: ['two'], yes: [] })
  const claude = json(home, '.claude.json')
  claude.mcpServers.api.headers.A = 'filled-a'
  put(home, '.claude.json', claude)
  const again = harness(home, configDir, list)
  await setupRestore(again.deps, { ids: ['two'], yes: [] })
  assert.equal(marksOf(again.requests).two.state, 'manual')
  assert.match(marksOf(again.requests).two.note, /still needs B/)
})

test('comparing a long value with many keys finishes at once', () => {
  const saved = Array.from({ length: 12 }, (_, i) => `<secret:K${i}>`).join('x') + 'END'
  const current = 'x'.repeat(30_000)
  const started = Date.now()
  assert.equal(filledIn(saved, current), false)
  assert.equal(filledIn(saved, Array.from({ length: 12 }, () => 'v').join('x') + 'END'), true)
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`)
})

test('a yes adds the marketplace before the plugin', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  const yes = [idOf(list, 'plugin', 'waku@waku-memory'), idOf(list, 'marketplace', 'waku-memory')]
  const h = harness(home, configDir, list)
  assert.equal(await setupRestore(h.deps, { ids: yes, yes }), true)
  assert.deepEqual(h.claudeRuns, ['plugin marketplace add waku-one/waku-memory-plugins', 'plugin install waku@waku-memory'])
  assert.deepEqual(yes.map((id) => marksOf(h.requests)[id].state), ['done', 'done'])
})

// On Windows `claude` runs through a shell, so a name or a source from the
// saved list could carry a second command. Such an item is never run.
test('a name or a source a shell could misread is never passed to claude', async () => {
  const { home, configDir } = newComputer()
  const items = [
    { id: 'm1', type: 'marketplace', app: 'claude_code', name: 'evil', body: { source: { source: 'github', repo: 'x/y & calc' } } },
    { id: 'p1', type: 'plugin', app: 'claude_code', name: 'tool@m" & calc', body: { enabled: true } },
    // A leading dash would reach `claude` as an option of its own.
    { id: 'p2', type: 'plugin', app: 'claude_code', name: '--dangerously-skip-permissions', body: { enabled: true } },
  ]
  const h = harness(home, configDir, { sources: [{ label: 'Mac', kind: 'computer', items }] })
  await setupRestore(h.deps, { ids: ['m1', 'p1', 'p2'], yes: ['m1', 'p1', 'p2'] })
  assert.deepEqual(h.claudeRuns, [])
  for (const id of ['m1', 'p1', 'p2']) {
    assert.equal(marksOf(h.requests)[id].state, 'manual')
    assert.match(marksOf(h.requests)[id].note, /cannot be passed to "claude" safely/)
  }
})

test('a hook that holds a placeholder is not written, even with a yes', async () => {
  const { home, configDir } = newComputer()
  const hook = {
    id: 'h1', type: 'hook', app: 'claude_code', name: 'Stop',
    body: { event: 'Stop', hooks: [{ type: 'command', command: 'notify --token <secret:token>' }] },
  }
  const h = harness(home, configDir, { sources: [{ label: 'Mac', kind: 'computer', items: [hook] }] })
  await setupRestore(h.deps, { ids: ['h1'], yes: ['h1'] })
  assert.ok(!existsSync(join(home, '.claude/settings.json')))
  assert.equal(marksOf(h.requests).h1.state, 'manual')
  assert.match(marksOf(h.requests).h1.note, /needs token/)
})

test('a name cannot write outside its folder', async () => {
  const { home, configDir } = newComputer()
  const items = [
    { id: 'a', type: 'command', app: 'claude_code', name: '../../evil', body: { text: 'x' } },
    { id: 'b', type: 'output_style', app: 'claude_code', name: 'nested/style', body: { text: 'x' } },
    { id: 'c', type: 'subagent', app: 'claude_code', name: 'ok/..', body: { text: 'x' } },
  ]
  const h = harness(home, configDir, { sources: [{ label: 'Mac', kind: 'computer', items }] })
  assert.equal(await setupRestore(h.deps, { ids: ['a', 'b', 'c'], yes: [] }), false)
  assert.ok(!existsSync(join(home, 'evil.md')) && !existsSync(join(home, '.claude', 'evil.md')))
  assert.deepEqual(Object.values(marksOf(h.requests)).map((m) => m.state), ['failed', 'failed', 'failed'])
})

test('without claude on the path, a plugin is left for the person with its command', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  const h = harness(home, configDir, list, { claude: 'missing' })
  const plugin = idOf(list, 'plugin', 'waku@waku-memory')
  await setupRestore(h.deps, { ids: [plugin], yes: [plugin] })
  assert.equal(marksOf(h.requests)[plugin].state, 'manual')
  assert.match(marksOf(h.requests)[plugin].note, /Run "claude plugin install waku@waku-memory"/)

  const failing = harness(home, configDir, list, { claude: 'fails' })
  const market = idOf(list, 'marketplace', 'waku-memory')
  assert.equal(await setupRestore(failing.deps, { ids: [market], yes: [market] }), false)
  assert.match(marksOf(failing.requests)[market].note, /failed: Error: marketplace not found/)
})

test("an account's items and unknown ids are the agent's, and not marked", async () => {
  const { home, configDir } = newComputer()
  const items = [{ id: 'k1', type: 'mcp_server', app: 'claude_ai', name: 'Linear', body: { url: 'https://mcp.linear.app/mcp' } }]
  const h = harness(home, configDir, { sources: [{ label: 'Work account', kind: 'account', items }] })
  assert.equal(await setupRestore(h.deps, { ids: ['k1', 'nope'], yes: [] }), true)
  assert.equal(h.requests.filter((r) => r.method === 'POST').length, 0)
  assert.deepEqual(h.errors, ['Not in the setup list: nope'])
  assert.match(h.lines.join('\n'), /For the agent to re-create \(1\):\n {2}k1 /)
})

test('without a key, restore says how to get one and reads nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'waku-new-'))
  const h = harness(home, join(home, '.waku-memory'), { sources: [] })
  assert.equal(await setupRestore(h.deps, { ids: ['a'], yes: [] }), false)
  assert.deepEqual(h.requests, [])
  assert.match(h.errors[0], /so nothing was read or changed/)
  assert.match(h.errors[0], /npx -y waku-memory login/)
})

test('dispatch: setup restore takes --items and --yes as comma-separated lists', () => {
  assert.deepEqual(dispatch(['setup', 'restore', '--items', 'a,b', '--items', 'c', '--yes', 'b']), {
    kind: 'setup-restore', items: ['a', 'b', 'c'], yes: ['b'],
  })
  assert.equal(dispatch(['setup', 'restore']).kind, 'bad-flag')
  assert.equal(dispatch(['setup', 'restore', '--items', 'a', '--yes']).kind, 'bad-flag')
})

// `setup list` (Ian, 2026-11-10): restore takes ids, and the setup.list tool
// and the console's Setup page that would show them are not on yet. This
// prints the saved list with each item's id, from the same GET /setup.

test('setup list prints every item with its id, under its source, and how to restore', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  const h = harness(home, configDir, list)
  assert.equal(await listSetup(h.deps), true)
  const out = h.lines.join('\n')
  const count = list.sources[0].items.length
  assert.match(out, new RegExp(`^Old Mac \\(computer, saved 2026-11-09\\): ${count} items$`, 'm'))
  for (const item of list.sources[0].items) assert.ok(out.includes(`  ${item.id} `), `${item.type} ${item.name} is listed with its id`)
  const docs = idOf(list, 'mcp_server', 'docs')
  assert.match(out, new RegExp(`^  ${docs} Claude Code MCP server "docs"$`, 'm'))
  assert.match(out, /npx -y waku-memory setup restore --items <id,id,\.\.\.>/)
  assert.deepEqual(h.requests.map((r) => `${r.method} ${r.url}`), ['GET https://api.waku.test/setup'])
  assert.deepEqual(h.errors, [])
})

test('setup list says which items wait for a yes and which need a secret', async () => {
  const list = listFrom(oldComputer())
  const { home, configDir } = newComputer()
  const h = harness(home, configDir, list)
  await listSetup(h.deps)
  const out = h.lines.join('\n')
  const github = idOf(list, 'mcp_server', 'github')
  assert.match(out, new RegExp(`^  ${github} Claude Code MCP server "github" \\(needs a yes; needs GITHUB_TOKEN\\)$`, 'm'))
  const docs = idOf(list, 'mcp_server', 'docs')
  assert.doesNotMatch(out, new RegExp(`${docs} [^\\n]*\\(`))
})

test('setup list marks an item gone from its computer, and one restored before', async () => {
  const { home, configDir } = newComputer()
  const items = [
    { id: 'g1', type: 'mcp_server', app: 'cursor', name: 'figma', body: { url: 'https://mcp.figma.com/mcp' }, gone_at: '2026-11-01T09:00:00Z', restore_state: null },
    { id: 'r1', type: 'plugin', app: 'claude_code', name: 'waku@waku-memory', body: {}, gone_at: null, restore_state: 'done' },
  ]
  const h = harness(home, configDir, { sources: [{ label: 'Work account', kind: 'account', saved_at: '2026-11-09T10:00:00Z', items }] })
  await listSetup(h.deps)
  const out = h.lines.join('\n')
  assert.match(out, /^Work account \(account, saved 2026-11-09\): 2 items$/m)
  assert.match(out, /^ {2}g1 Cursor MCP server "figma" \(gone from there since 2026-11-01\)$/m)
  assert.match(out, /^ {2}r1 Claude Code plugin "waku@waku-memory" \(restored before: done\)$/m)
})

test("setup list names an account's apps and types in words", async () => {
  const { home, configDir } = newComputer()
  const items = [
    { id: 'c1', type: 'connector', app: 'claude_ai', name: 'Slack', body: { url: 'https://mcp.slack.com/mcp' } },
    { id: 't1', type: 'scheduled_task', app: 'chatgpt', name: 'Morning picks', body: { prompt: 'List three articles.' } },
    { id: 'g1', type: 'custom_gpt', app: 'chatgpt', name: 'Editor', body: {} },
  ]
  const h = harness(home, configDir, { sources: [{ label: 'Work account', kind: 'account', items }] })
  await listSetup(h.deps)
  const out = h.lines.join('\n')
  assert.match(out, /^ {2}c1 claude\.ai connector "Slack"$/m)
  assert.match(out, /^ {2}t1 ChatGPT scheduled task "Morning picks"$/m)
  assert.match(out, /^ {2}g1 ChatGPT custom GPT "Editor"$/m)
})

test('an empty setup list says how to fill it', async () => {
  const { home, configDir } = newComputer()
  const h = harness(home, configDir, { sources: [] })
  assert.equal(await listSetup(h.deps), true)
  assert.match(h.lines.join('\n'), /The setup list is empty\. Run "npx -y waku-memory setup save" on the computer you are moving from\./)
})

test('without a key, setup list says how to get one and reads nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'waku-new-'))
  const h = harness(home, join(home, '.waku-memory'), { sources: [] })
  assert.equal(await listSetup(h.deps), false)
  assert.deepEqual(h.requests, [])
  assert.match(h.errors[0], /npx -y waku-memory login/)
})

test('a key Waku refuses: setup list says to sign in again', async () => {
  const { home, configDir } = newComputer()
  const h = harness(home, configDir, { sources: [] })
  h.deps.fetchImpl = async () => new Response('{"detail":"invalid key"}', { status: 401 })
  assert.equal(await listSetup(h.deps), false)
  assert.match(h.errors[0], /did not accept the saved key\. Run "npx -y waku-memory login"/)
})

test('dispatch: setup list', () => {
  assert.deepEqual(dispatch(['setup', 'list']), { kind: 'setup-list' })
})
