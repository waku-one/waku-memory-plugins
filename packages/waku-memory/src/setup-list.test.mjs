// spec 073 C, D6-D8 (tasks T11, T12): `setup save` reads a fixture home,
// removes every secret value, and sends what is left; `setup auto` and the
// SessionStart check decide when a background save runs. Temp directories
// and an injected fetchImpl only: nothing here touches a real home
// directory or the network.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { dispatch } from './cli.ts'
import { handleHookEvent } from './hook.ts'
import {
  REFRESH_EVERY_MS,
  SETUP_STATE_FILE,
  computerLabel,
  holdsSecret,
  parseToml,
  readSetup,
  scrubArgs,
  scrubUrl,
  setupAuto,
  setupNeedsRefresh,
  setupSave,
  valueHoldsSecret,
} from './setup-list.ts'

const GHP = 'ghp_' + 'a'.repeat(36)
const ANT = 'sk-ant-' + 'b'.repeat(40)

function put(home, path, content) {
  const full = join(home, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}

// A home with a little of everything D8 reads, and a secret in each place
// D7 names.
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'waku-setup-'))
  put(home, '.claude.json', {
    numStartups: 412,
    oauthAccount: { emailAddress: 'ian@example.test' },
    mcpServers: {
      sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer abcdefghijkl12345' } },
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github', '--token', GHP],
        env: { GITHUB_TOKEN: GHP, LOG_LEVEL: 'debug', FROM_SHELL: '${GH_TOKEN}' },
      },
      waku: { type: 'http', url: 'https://api.waku.one/mcp' },
    },
    projects: {
      '/Users/ian/code/app': {
        history: [{ display: 'my private prompt' }],
        mcpServers: { db: { command: 'pg-mcp', args: ['postgres://ian:hunter22@localhost:5432/app'] } },
      },
      '/Users/ian/code/empty': { mcpServers: {} },
    },
  })
  put(home, '.claude/settings.json', {
    env: { ANTHROPIC_API_KEY: ANT },
    model: 'opus',
    outputStyle: 'Explanatory',
    enabledPlugins: { 'waku@waku-memory': true, 'old@somewhere': false },
    extraKnownMarketplaces: { 'waku-memory': { source: { source: 'github', repo: 'waku-one/waku-memory-plugins' } } },
    permissions: { allow: ['Bash(npm run test)'], defaultMode: 'acceptEdits' },
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: '/usr/bin/node', args: ['/Users/ian/.waku-memory/hook/0.13.0/index.js', 'hook'] }] },
        { hooks: [{ type: 'command', command: 'curl -H "Authorization: Bearer zyxwvutsrq987654" https://x.test' }] },
      ],
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npm run lint' }] }],
    },
  })
  put(home, '.claude/plugins/known_marketplaces.json', {
    'waku-memory': { source: { source: 'github', repo: 'waku-one/waku-memory-plugins' }, installLocation: '/x', lastUpdated: 'y' },
    tools: { source: { source: 'git', url: 'https://ian:pat123456@git.example.test/tools.git' }, installLocation: '/z' },
  })
  put(home, '.claude/agents/reviewer.md', '---\nname: reviewer\n---\nReview the diff.\n')
  put(home, '.claude/commands/frontend/component.md', `Make a component.\nANTHROPIC_API_KEY=${ANT}\n`)
  put(home, '.claude/commands/deploy.md', 'Deploy with DB_PASSWORD=ab\nthen run migrations.\n')
  put(home, '.claude/output-styles/terse.md', 'Be terse.\n')
  put(
    home,
    '.codex/config.toml',
    [
      'model = "gpt-5.5"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write" # trailing comment',
      'history = { persistence = "none" }',
      '',
      '[mcp_servers.waku]',
      'url = "https://api.waku.one/mcp"',
      '',
      '[mcp_servers.linear]',
      'command = "npx"',
      'args = [',
      '  "-y",',
      '  "mcp-remote", # comment in an array',
      '  "https://mcp.linear.app/sse?api_key=lin_123456",',
      ']',
      'env_http_headers = { "X-Team" = "LINEAR_TEAM" }',
      '',
      '[mcp_servers.linear.env]',
      `LINEAR_API_KEY = "${GHP}"`,
      '',
      '[profiles.deep]',
      'model = "gpt-5.5-pro"',
      "model_reasoning_effort = 'high'",
      '',
    ].join('\n'),
  )
  put(home, '.codex/prompts/fix.md', 'Fix the failing test.\n')
  put(home, '.cursor/mcp.json', { mcpServers: { figma: { url: 'https://mcp.figma.com/mcp?token=figd_abcdef' } } })
  put(home, 'Library/Application Support/Claude/claude_desktop_config.json', {
    mcpServers: { files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/ian/Documents'] } },
  })
  put(home, 'Documents/Claude/Scheduled/daily-picks/SKILL.md', '---\nname: daily-picks\n---\nEvery weekday at 8:00, list three articles.\n')
  return home
}

function names(reading) {
  return reading.items.map((i) => `${i.app} ${i.type} ${i.name}`)
}

test('reads every row of D8 on a Mac, and only the parts it names', () => {
  const home = fixtureHome()
  const reading = readSetup({ home, platform: 'darwin' })
  assert.deepEqual(names(reading).sort(), [
    'claude_code command deploy',
    'claude_code command frontend/component',
    'claude_code hook PostToolUse Edit',
    'claude_code hook SessionStart',
    'claude_code marketplace tools',
    'claude_code marketplace waku-memory',
    'claude_code mcp_server db · app',
    'claude_code mcp_server github',
    'claude_code mcp_server sentry',
    'claude_code mcp_server waku',
    'claude_code output_style terse',
    'claude_code permissions permissions',
    'claude_code plugin old@somewhere',
    'claude_code plugin waku@waku-memory',
    'claude_code settings settings',
    'claude_code subagent reviewer',
    'claude_desktop mcp_server files',
    'codex command fix',
    'codex mcp_server linear',
    'codex mcp_server waku',
    'codex settings profile deep',
    'codex settings settings',
    'cowork scheduled_task daily-picks',
    'cursor mcp_server figma',
  ])
  assert.deepEqual(reading.unreadable, [])
  assert.deepEqual(reading.leftOut, [])
  const all = JSON.stringify(reading)
  for (const secret of [GHP, ANT, 'abcdefghijkl12345', 'zyxwvutsrq987654', 'hunter22', 'pat123456', 'lin_123456', 'figd_abcdef']) {
    assert.ok(!all.includes(secret), `${secret} was sent`)
  }
  // The rest of ~/.claude.json, and settings.json's env, stay on the computer.
  for (const kept of ['ian@example.test', 'my private prompt', 'numStartups', '/Users/ian/code/empty']) {
    assert.ok(!all.includes(kept), `${kept} was sent`)
  }
  assert.ok(!JSON.stringify(reading.sections['~/.claude/settings.json']).includes('ANTHROPIC_API_KEY'))
  for (const item of reading.items) assert.equal(valueHoldsSecret(item.body), false, item.name)
  assert.equal(valueHoldsSecret(reading.sections), false)
})

test('names each removed value, keeps a reference, and keeps what is not secret', () => {
  const home = fixtureHome()
  const reading = readSetup({ home, platform: 'darwin' })
  const item = (app, name) => reading.items.find((i) => i.app === app && i.name === name).body
  assert.deepEqual(item('claude_code', 'github').env, {
    GITHUB_TOKEN: '<secret:GITHUB_TOKEN>',
    LOG_LEVEL: '<secret:LOG_LEVEL>',
    FROM_SHELL: '${GH_TOKEN}',
  })
  assert.deepEqual(item('claude_code', 'github').args, ['-y', '@modelcontextprotocol/server-github', '--token', '<secret:token>'])
  assert.deepEqual(item('claude_code', 'sentry').headers, { Authorization: '<secret:Authorization>' })
  assert.deepEqual(item('claude_code', 'db · app'), {
    command: 'pg-mcp',
    args: ['postgres://<secret:url-user>@localhost:5432/app'],
    scope: 'local',
    project: '/Users/ian/code/app',
    server: 'db',
  })
  assert.equal(item('claude_code', 'sentry').scope, 'user')
  assert.equal(item('cursor', 'figma').url, 'https://mcp.figma.com/mcp?token=<secret:token>')
  assert.deepEqual(item('codex', 'linear').env, { LINEAR_API_KEY: '<secret:LINEAR_API_KEY>' })
  assert.deepEqual(item('codex', 'linear').env_http_headers, { 'X-Team': 'LINEAR_TEAM' })
  assert.equal(item('codex', 'linear').args[2], 'https://mcp.linear.app/sse?api_key=<secret:api_key>')
  assert.deepEqual(item('codex', 'settings'), { model: 'gpt-5.5', approval_policy: 'on-request', sandbox_mode: 'workspace-write' })
  assert.deepEqual(item('codex', 'profile deep'), { model: 'gpt-5.5-pro', model_reasoning_effort: 'high' })
  assert.match(item('claude_code', 'frontend/component').text, /ANTHROPIC_API_KEY=<secret:key>/)
  assert.equal(item('claude_code', 'deploy').text, 'Deploy with DB_PASSWORD=ab\nthen run migrations.\n')
  assert.deepEqual(item('claude_code', 'SessionStart').hooks, [
    { type: 'command', command: 'curl -H "Authorization: Bearer <secret:bearer>" https://x.test' },
  ])
  assert.deepEqual(item('claude_code', 'tools'), { source: { source: 'git', url: 'https://<secret:url-user>@git.example.test/tools.git' } })
  assert.deepEqual(item('cowork', 'daily-picks'), {
    file: '~/Documents/Claude/Scheduled/daily-picks/SKILL.md',
    text: '---\nname: daily-picks\n---\nEvery weekday at 8:00, list three articles.\n',
  })
  assert.equal(reading.removed, 11)
})

test('reads no Mac-only file on Linux or Windows', () => {
  const home = fixtureHome()
  for (const platform of ['linux', 'win32']) {
    const apps = new Set(readSetup({ home, platform }).items.map((i) => i.app))
    assert.deepEqual([...apps].sort(), ['claude_code', 'codex', 'cursor'])
  }
})

test('an unreadable file is named and the others are still read', () => {
  const home = fixtureHome()
  put(home, '.cursor/mcp.json', '{ not json')
  put(home, '.codex/config.toml', 'model = \n')
  const reading = readSetup({ home, platform: 'linux' })
  assert.deepEqual(reading.unreadable, ['~/.codex/config.toml', '~/.cursor/mcp.json'])
  assert.ok(reading.items.some((i) => i.name === 'github'))
})

test('the secret check matches the server: placeholders pass, values do not', () => {
  assert.equal(valueHoldsSecret({ env: { SENTRY_TOKEN: '<secret:SENTRY_TOKEN>' }, headers: { api_key: '<secret:api_key>' } }), false)
  assert.equal(holdsSecret('API_KEY=<secret:API_KEY>\nNEXT_LINE=a-longer-value'), false)
  assert.equal(valueHoldsSecret({ env: { ANTHROPIC_API_KEY: ANT } }), true)
  assert.equal(valueHoldsSecret({ headers: { Authorization: 'Bearer abcdefghijklmnop' } }), true)
  assert.equal(valueHoldsSecret({ url: 'https://user:hunter22@example.com/mcp' }), true)
  assert.equal(valueHoldsSecret({ args: ['--token', GHP] }), true)
  assert.equal(valueHoldsSecret({ api_key: 'abcd1234' }), true)
  assert.equal(valueHoldsSecret({ env: { MY_SERVICE_TOKEN: 'short' } }), true)
  assert.equal(valueHoldsSecret({ headers: { 'X-Api-Key': 'k' } }), true)
  assert.equal(valueHoldsSecret({ env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }), false)
  assert.equal(valueHoldsSecret({ env: { LOG_LEVEL: 'debug' }, apiKeyHelper: '~/bin/key.sh' }), false)
  assert.equal(valueHoldsSecret({ text: 'Set DB_PASSWORD=<secret:DB_PASSWORD>\nthen run migrations' }), false)
  assert.equal(valueHoldsSecret({ prompt: 'Every weekday at 8:00, read my GitHub notifications.' }), false)
})

test('url and argument rules of D7', () => {
  const marked = []
  const mark = (name, value) => {
    marked.push(value)
    return `<secret:${name}>`
  }
  assert.equal(scrubUrl('https://a:b@x.test/p?auth=1&page=2&SIG=&client_secret=zz', mark), 'https://<secret:url-user>@x.test/p?auth=<secret:auth>&page=2&SIG=&client_secret=<secret:client_secret>')
  assert.deepEqual(scrubArgs(['--api-key', 'k1', '--port', '80', '--password=p2', '-t', 'x', '--token', '--next'], mark), [
    '--api-key',
    '<secret:api-key>',
    '--port',
    '80',
    '--password=<secret:password>',
    '-t',
    'x',
    '--token',
    '--next',
  ])
  assert.deepEqual(marked, ['a:b', '1', 'zz', 'k1', 'p2'])
})

test('the TOML reader', () => {
  const doc = parseToml(
    [
      '# top',
      'a = "x\\ty \\u00e9"',
      "b = 'C:\\\\path'",
      'c = """',
      'line one',
      'line two"""',
      "d = '''raw\\n'''",
      'e = [1, 2_000, -3.5, true, false, 1979-05-27T07:32:00Z]',
      'f.g = { h = "i", j = [ { k = 1 } ] }',
      '"quoted key" = 1',
      '[t."x.y"]',
      'z = 0x1F',
      '[[arr]]',
      'n = 1',
      '[[arr]]',
      'n = 2',
      '[arr.sub]',
      'm = 3',
    ].join('\r\n'),
  )
  assert.deepEqual(doc, {
    a: 'x\ty é',
    b: 'C:\\\\path',
    c: 'line one\r\nline two',
    d: 'raw\\n',
    e: [1, 2000, -3.5, true, false, '1979-05-27T07:32:00Z'],
    f: { g: { h: 'i', j: [{ k: 1 }] } },
    'quoted key': 1,
    t: { 'x.y': { z: 31 } },
    arr: [{ n: 1 }, { n: 2, sub: { m: 3 } }],
  })
  assert.throws(() => parseToml('a = "unterminated\n'))
  assert.throws(() => parseToml('a = what\n'))
  assert.throws(() => parseToml('a = 1 b = 2\n'))
  assert.throws(() => parseToml('__proto__ = 1\n'))
})

test('computerLabel drops the network suffix', () => {
  assert.equal(computerLabel('Ians-MacBook-Pro.local'), 'Ians-MacBook-Pro')
  assert.equal(computerLabel(''), 'This computer')
})

// --- saving ------------------------------------------------------------------

function deps(home, configDir, answer = { status: 201, body: { snapshot_id: 'x', items: 1, added: 1, gone: 0 } }) {
  const calls = []
  const out = []
  const err = []
  let clock = 1_800_000_000_000
  return {
    calls,
    out,
    err,
    tick: (ms) => {
      clock += ms
    },
    deps: {
      home,
      platform: 'linux',
      configDir,
      computerName: 'Ians-MacBook-Pro.local',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return new Response(JSON.stringify(answer.body), { status: answer.status })
      },
      writeJsonFile: (path, data) => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(data))
      },
      now: () => clock,
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    },
  }
}

function withKey(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ url: 'https://api.example.test/', key: 'mem_sk_test' }))
  return dir
}

function state(configDir) {
  return JSON.parse(readFileSync(join(configDir, SETUP_STATE_FILE), 'utf8'))
}

test('setup save sends the list with the saved key and remembers the save', async () => {
  const home = fixtureHome()
  const configDir = withKey(join(home, '.waku-memory'))
  const t = deps(home, configDir)
  assert.equal(await setupSave(t.deps), true)
  assert.equal(t.calls.length, 1)
  const { url, init } = t.calls[0]
  assert.equal(url, 'https://api.example.test/setup/snapshots')
  assert.equal(init.headers.Authorization, 'Bearer mem_sk_test')
  const payload = JSON.parse(init.body)
  assert.equal(payload.source_kind, 'computer')
  assert.equal(payload.source_label, 'Ians-MacBook-Pro')
  assert.equal(payload.items.length, 22)
  assert.deepEqual(Object.keys(JSON.parse(payload.raw).files).sort(), [
    '~/.claude.json',
    '~/.claude/plugins/known_marketplaces.json',
    '~/.claude/settings.json',
    '~/.codex/config.toml',
    '~/.cursor/mcp.json',
  ])
  assert.ok(!init.body.includes(GHP))
  const saved = state(configDir)
  assert.equal(saved.label, 'Ians-MacBook-Pro')
  assert.equal(saved.auto, true)
  assert.match(saved.digest, /^[0-9a-f]{64}$/)
  assert.ok(Object.keys(saved.stamps).some((p) => p.endsWith('.claude.json')))
  assert.match(t.out[0], /^Saved the setup of "Ians-MacBook-Pro": 22 items\.$/)
  assert.deepEqual(t.out.slice(1), [
    '  Claude Code: 4 MCP servers, 2 marketplaces, 2 plugins, 2 hooks, permissions, settings, 1 subagent, 2 commands, 1 output style',
    '  Codex: 2 MCP servers, settings, 1 command',
    '  Cursor: 1 MCP server',
    '11 secret values stayed on this computer. The list shows each as <secret:NAME>.',
    'From now on, a new session saves it again when these files change. "npx waku-memory setup auto off" stops that.',
  ])
})

test('--dry-run prints the payload and sends nothing, with no key needed', async () => {
  const home = fixtureHome()
  const configDir = join(home, '.waku-memory')
  const t = deps(home, configDir)
  assert.equal(await setupSave(t.deps, { dryRun: true, label: 'Work laptop' }), true)
  assert.equal(t.calls.length, 0)
  assert.match(t.out[0], /^Found 22 items on this computer \("Work laptop"\):$/)
  const printed = JSON.parse(t.out[t.out.length - 1])
  assert.equal(printed.source_label, 'Work laptop')
  assert.ok(printed.raw.files['~/.claude.json'])
})

test('no saved key: says how to sign in and sends nothing', async () => {
  const home = fixtureHome()
  const t = deps(home, join(home, '.waku-memory'))
  assert.equal(await setupSave(t.deps), false)
  assert.equal(t.calls.length, 0)
  assert.match(t.err[0], /so nothing was saved/)
  assert.match(t.err[0], /npx -y waku-memory login/)
})

test("the server's refusal is said with its reason, and nothing is remembered", async () => {
  const home = fixtureHome()
  const configDir = withKey(join(home, '.waku-memory'))
  const t = deps(home, configDir, { status: 422, body: { detail: "item 3 (mcp_server 'x') still holds a secret" } })
  assert.equal(await setupSave(t.deps), false)
  assert.equal(t.err[0], "The setup was not saved. Waku answered 422: item 3 (mcp_server 'x') still holds a secret.")
  assert.throws(() => state(configDir))
})

test('a background save skips what it already sent, and sends a change', async () => {
  const home = fixtureHome()
  const configDir = withKey(join(home, '.waku-memory'))
  const t = deps(home, configDir)
  await setupSave(t.deps, { label: 'Work laptop' })
  const printed = t.out.length
  t.tick(REFRESH_EVERY_MS + 1)
  assert.equal(await setupSave(t.deps, { auto: true }), true)
  assert.equal(t.calls.length, 1, 'same digest: nothing sent')
  put(home, '.claude/agents/planner.md', 'Plan first.\n')
  assert.equal(await setupSave(t.deps, { auto: true }), true)
  assert.equal(t.calls.length, 2)
  assert.equal(JSON.parse(t.calls[1].init.body).source_label, 'Work laptop', 'the label is kept')
  assert.equal(t.out.length, printed, 'a background save prints nothing')
})

test('a background save does nothing before a first save or with auto off, and skips while a file is unreadable', async () => {
  const home = fixtureHome()
  const configDir = withKey(join(home, '.waku-memory'))
  const t = deps(home, configDir)
  assert.equal(await setupSave(t.deps, { auto: true }), true)
  assert.equal(t.calls.length, 0)
  await setupSave(t.deps)
  put(home, '.cursor/mcp.json', '{ half written')
  t.tick(REFRESH_EVERY_MS + 1)
  await setupSave(t.deps, { auto: true })
  assert.equal(t.calls.length, 1)
  setupAuto({ ...t.deps }, false)
  put(home, '.cursor/mcp.json', { mcpServers: {} })
  await setupSave(t.deps, { auto: true })
  assert.equal(t.calls.length, 1)
  assert.equal(state(configDir).auto, false)
})

test('setupNeedsRefresh: only after a save, with auto on, past the wait, when a file changed', async () => {
  const home = fixtureHome()
  const configDir = withKey(join(home, '.waku-memory'))
  const t = deps(home, configDir)
  const place = { home, platform: 'linux', configDir }
  assert.equal(setupNeedsRefresh(place, t.deps.now()), false, 'no save yet')
  await setupSave(t.deps)
  assert.equal(setupNeedsRefresh(place, t.deps.now() + REFRESH_EVERY_MS + 1), false, 'nothing changed')
  put(home, '.codex/prompts/review.md', 'Review.\n')
  assert.equal(setupNeedsRefresh(place, t.deps.now() + 1000), false, 'inside the wait')
  assert.equal(setupNeedsRefresh(place, t.deps.now() + REFRESH_EVERY_MS + 1), true, 'a new file')
  await setupSave(t.deps)
  const later = new Date(t.deps.now() + 5000)
  utimesSync(join(home, '.claude', 'settings.json'), later, later)
  assert.equal(setupNeedsRefresh(place, t.deps.now() + REFRESH_EVERY_MS + 1), true, 'a touched file')
  setupAuto({ ...t.deps }, false)
  assert.equal(setupNeedsRefresh(place, t.deps.now() + REFRESH_EVERY_MS + 1), false, 'auto off')
})

test('dispatch: setup save, setup auto, and plain setup', () => {
  assert.deepEqual(dispatch(['setup', 'save']), { kind: 'setup-save', label: undefined, dryRun: false, auto: false })
  assert.deepEqual(dispatch(['setup', 'save', '--label', 'Work laptop', '--dry-run']), {
    kind: 'setup-save',
    label: 'Work laptop',
    dryRun: true,
    auto: false,
  })
  assert.deepEqual(dispatch(['setup', 'save', '--auto']), { kind: 'setup-save', label: undefined, dryRun: false, auto: true })
  assert.equal(dispatch(['setup', 'save', '--label']).kind, 'bad-flag')
  assert.deepEqual(dispatch(['setup', 'auto', 'off']), { kind: 'setup-auto', on: false })
  assert.deepEqual(dispatch(['setup', 'auto', 'on']), { kind: 'setup-auto', on: true })
  assert.equal(dispatch(['setup', 'auto']).kind, 'bad-flag')
  assert.equal(dispatch(['setup']).kind, 'setup')
})

test('SessionStart runs the setup refresh after the brief, and a throw in it is contained', async () => {
  const order = []
  const configDir = withKey(mkdtempSync(join(tmpdir(), 'waku-setup-hook-')))
  const fetchImpl = async () => {
    order.push('brief')
    return new Response(JSON.stringify({ text: '' }), { status: 200 })
  }
  const event = { hook_event_name: 'SessionStart', session_id: 's', cwd: '/tmp', source: 'startup' }
  await handleHookEvent(event, { configDir, fetchImpl, stdout: () => {}, refreshSetup: () => order.push('refresh') })
  assert.deepEqual(order, ['brief', 'refresh'])
  await handleHookEvent(event, {
    configDir,
    fetchImpl,
    stdout: () => {},
    refreshSetup: () => {
      throw new Error('boom')
    },
  })
})
