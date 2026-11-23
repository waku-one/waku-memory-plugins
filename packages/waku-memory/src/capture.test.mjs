// The `capture enable` / `capture disable` decision logic: the disclosure
// gate, the hook-entry merge/remove pair, and the enable/disable
// orchestration that writes ~/.waku-memory/config.json and merges into
// ~/.claude/settings.json. Argv dispatch lives in cli.ts (cli.test.mjs);
// this file is everything downstream of "here is a parsed action and a
// deps bag" -- the same split hook.ts/hook.test.mjs already established.
//
// This is the command the whole disclosure obligation (status.md item 9)
// runs through the moment a worker exists to act on captured content, so
// the tests below are written to fail loudly if the gate ever becomes
// skippable: a non-'y' answer must abort before the key is even asked for,
// and before anything is written.
//
// Every test uses a temp directory for claudeDir/settingsPath/configDir --
// never the real ~/.claude or ~/.waku-memory -- and an injected `prompt`
// that never touches real stdin. atomicWriteJson is imported from cli.ts
// (already proven safe to import directly -- cli.ts has no top-level side
// effects, per its own header comment and cli.test.mjs's identical import)
// so the settings-write tests exercise the real writer, not a stand-in.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DISCLOSURE,
  disable,
  enable,
  mergeHookSettings,
  removeHookSettings,
  status,
  writeConfigJson,
} from './capture.ts'
// Namespace imports for the exports added on 2026-09-04: a missing named
// export is a link-time SyntaxError that takes the whole file down, while a
// missing property on a namespace fails only the test that reads it -- which
// is what lets the RED half of TDD show a failure instead of an error.
import * as captureModule from './capture.ts'
import * as hookModule from './hook.ts'
import { atomicWriteJson, writeCodexText, writeJsonFile as atomicWriteJsonAny } from './cli.ts'
// Change 1/2 (duplicate-waku-server fix): mergeCodexToml builds the fixture
// tables below the exact way a real "capture enable" on a plugin-less
// machine would have (rather than a hand-typed literal that could drift
// from codexTomlBlock's own format), and removeCodexToml gives the expected
// post-removal text to compare enable()'s own write against -- both already
// pinned by codex-config.test.mjs in their own right; this file only proves
// enable()/status() wire them in correctly.
import { mergeCodexToml, removeCodexToml, mergeCodexHooks } from './codex-config.ts'

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waku-capture-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function captureLog(fn) {
  const lines = []
  const realLog = console.log
  const realError = console.error
  console.log = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = realLog
    console.error = realError
  }
  return lines.join('\n')
}

// Records every question asked, in order, and answers from a fixed queue --
// throwing if enable()/disable() ever asks more questions than the test
// expected, rather than silently returning undefined. That is what makes
// "the key was never asked for" provable: a wrong implementation that asks
// anyway fails loudly instead of the assertion just reading undefined.
function fakePrompt(answers) {
  const questions = []
  const impl = async (question) => {
    questions.push(question)
    if (questions.length > answers.length) {
      throw new Error(`fakePrompt: no answer queued for question #${questions.length}: "${question}"`)
    }
    return answers[questions.length - 1]
  }
  impl.questions = questions
  return impl
}

// Records every call as {url, body} (body already JSON.parsed) and answers
// 202 by default -- the same shape bootstrap.test.mjs's own fakeFetch uses,
// duplicated rather than shared: the two test files never import from each
// other, the same way the two production files (capture.ts, bootstrap.ts)
// keep their sending logic in bootstrap.ts alone (this file only exercises
// it through enable()).
// B1: byPath lets a test answer one path differently from every other call
// this same fetchImpl serves (e.g. a consent post that fails while every
// other call -- installHookCopy's verify, bootstrap's sends -- still
// succeeds), keeping the default shape every pre-existing test already
// depends on.
function fakeFetch(defaultStatus = 202, byPath = {}) {
  const calls = []
  const impl = async (url, init) => {
    const path = new URL(url).pathname
    const status = byPath[path] ?? defaultStatus
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: status >= 200 && status < 300, status, json: async () => ({ detail: `status ${status}` }) }
  }
  impl.calls = calls
  return impl
}

// The wire value spec 012 §4.6/§4.2 pins: what "capture enable" actually
// writes into [mcp_servers.waku]'s url line on a real machine (the same
// literal codex-config.test.mjs's own OUR_URL uses) -- makeDeps's default
// deps.mcpUrl below, kept distinct from OUR_INGEST_URL (the ingest base
// enable()'s own `url` parameter carries in real use, per cli.ts's
// realCaptureDeps/dispatch). Declared ahead of makeDeps so both defaults
// below read as "the real pair", not two unrelated literals.
const OUR_URL = 'https://api.waku.one/mcp'
const OUR_INGEST_URL = 'https://api.waku.one'

function makeDeps(dir, overrides = {}) {
  const claudeDir = join(dir, '.claude')
  // hookSourceDir defaults to a temp "dist" holding nothing but an empty
  // index.js -- enough for installHookCopy to copy and, combined with the
  // default verifyHook below (always true), enough for enable() to reach
  // 'enabled' without spawning anything real. Only created when the caller
  // does not supply its own -- a test that passes hookSourceDir already
  // owns that directory's setup (e.g. the A10 tests below, which write a
  // real index.js there to run installHookCopy against directly).
  const hookSourceDir = overrides.hookSourceDir ?? join(dir, 'dist')
  if (overrides.hookSourceDir === undefined) {
    mkdirSync(hookSourceDir, { recursive: true })
    writeFileSync(join(hookSourceDir, 'index.js'), '')
  }
  return {
    claudeDir,
    settingsPath: join(claudeDir, 'settings.json'),
    configDir: join(dir, '.waku-memory'),
    hookSourceDir,
    version: '0.2.0',
    execPath: 'C:/Program Files/nodejs/node.exe',
    verifyHook: () => true,
    // Third answer is the bootstrap question (task 13). Every test below
    // that uses this default builds claudeDir with nothing under it but
    // settings.json (no projects/, no CLAUDE.md), so scanClaudeCode's scan
    // is empty and enable() never actually asks a third question -- this
    // 'n' sits unused, queued only so a test that unexpectedly did reach it
    // would fail loudly (fakePrompt throws on an unqueued question) rather
    // than silently reading undefined.
    prompt: fakePrompt(['y', 'pasted-test-key', 'n']),
    // A person at a terminal, the case every test above this field was
    // written for. The no-terminal tests override it.
    answerable: () => true,
    writeSettingsJson: atomicWriteJson,
    fetchImpl: fakeFetch(202),
    bootstrap: { windowDays: 180, enabled: true },
    // Codex (task 10, spec 012 §4.6): mirrors claudeDir's own shape -- a
    // path under the same temp `dir`, non-existent by default (every
    // pre-existing test above never created it, so codexConfigExists stays
    // false for all of them and enable()/disable()/status() take exactly
    // the Claude-only path they took before this task). The default
    // codexConfigPath matches buildCodexFixture(dir)'s own configPath below,
    // so a test only has to call buildCodexFixture(dir) to make Codex
    // "detected" without also overriding this path.
    codexConfigPath: join(dir, '.codex', 'config.toml'),
    codexHooksPath: join(dir, '.codex', 'hooks.json'),
    codexPluginsCacheDir: join(dir, '.codex', 'plugins', 'cache'),
    marketplacePath: join(dir, '.agents', 'plugins', 'marketplace.json'),
    claudePluginsCacheDir: join(claudeDir, 'plugins', 'cache'),
    // Fix round 1 (spec 012 §4.2): the MCP endpoint the Codex TOML (and
    // Claude Code's own ~/.claude.json) must carry -- OUR_URL, the "/mcp"
    // literal, deliberately distinct from whatever `url` an individual
    // enable()/disable() call is made with (real use: the ingest base).
    mcpUrl: OUR_URL,
    // Real atomic writers (cli.ts) by default, same reasoning as
    // writeSettingsJson above: the Codex-file tests exercise the real
    // writers, not a stand-in.
    writeText: writeCodexText,
    writeJsonFile: atomicWriteJsonAny,
    // Task 13 (spec 012 §7): thrown by default, the same "fails loudly
    // instead of reading undefined" discipline fakePrompt's own overrun
    // guard uses above -- every pre-existing test here calls enable() with
    // no third argument at all, which never reaches deps.login (see
    // resolveCredential's own comment, capture.ts), so this default is
    // never exercised by any of them; only the credential tests below
    // override it, with fakeLogin.
    login: async () => {
      throw new Error('makeDeps: unexpectedly called deps.login() -- override login in this test.')
    },
    ...overrides,
  }
}

// A stand-in for login.ts's own login(): resolves to `result`, and, only on
// 'signed-in', writes config.json itself first -- exactly what the real
// login() does (writeConfigJson, before ever returning) and what
// resolveCredential/runLogin (capture.ts) depend on to read the key back.
// `.calls` counts invocations, the same "prove it was actually called, not
// just assumed" discipline fakePrompt.questions gives the prompt tests.
function fakeLogin(result, configDir, key = 'mem_sk_from_login') {
  const impl = async () => {
    impl.calls++
    if (result === 'signed-in') writeConfigJson(configDir, { url: 'https://ingest.test', key })
    return result
  }
  impl.calls = 0
  return impl
}

// A 30-line fixture in the shape a real ~/.codex/config.toml actually has --
// the exact string codex-config.test.mjs's own FIXTURE uses (task 9), kept
// identical here rather than imported so this file's Codex tests do not
// depend on codex-config.test.mjs's internals: a top-level notify array and
// model keys, a [desktop] table, an [mcp_servers.node_repl] table with its
// own nested [mcp_servers.node_repl.env] table, and a trailing [windows]
// table.
const CODEX_FIXTURE_TOML = [
  'notify = [ "C:\\\\fake\\\\notify.exe", "turn-ended" ]',
  'model = "gpt-5.6-fake"',
  'model_reasoning_effort = "medium"',
  '',
  '[desktop]',
  'followUpQueueMode = "steer"',
  'conversationDetailMode = "STEPS_COMMANDS"',
  'ambient-suggestions-enabled = true',
  '',
  '[mcp_servers.node_repl]',
  'command = "C:\\\\fake\\\\node_repl.exe"',
  'startup_timeout_sec = 120.0',
  '',
  '[mcp_servers.node_repl.env]',
  'CODEX_HOME = "C:\\\\Users\\\\fake\\\\.codex"',
  'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"',
  '',
  '[windows]',
  'wslDistro = "Ubuntu"',
  '',
].join('\n')

// Writes ~/.codex/config.toml (CODEX_FIXTURE_TOML) under `home`, matching
// makeDeps's own default codexConfigPath -- a test that wants a Codex-only
// or Codex-plus-Claude-Code HOME calls this instead of overriding
// codexConfigPath by hand.
function buildCodexFixture(home) {
  const codexDir = join(home, '.codex')
  mkdirSync(codexDir, { recursive: true })
  const configPath = join(codexDir, 'config.toml')
  writeFileSync(configPath, CODEX_FIXTURE_TOML, 'utf8')
  return { codexDir, configPath }
}

// A minimal but real ~/.claude/projects/<slug>/<session>.jsonl -- the shape
// scanClaudeCode (bootstrap.ts, task 12) actually reads: two cwd-less
// records first (a transcript's real opening lines), then a `user` record
// carrying `cwd`, which is what lets the session resolve to a named project
// rather than falling back to "(memory only)". Building this against a real
// claudeDir is what makes the tests below exercise enable()'s *real*
// scanClaudeCode call, not a hand-built Scan (bootstrap.test.mjs's own A13
// tests already cover runBootstrap's sending logic against hand-built
// Scans; this file only has to prove enable() wires the question in).
function buildClaudeCodeFixture(claudeDir) {
  const slugDir = join(claudeDir, 'projects', 'slug-demo')
  mkdirSync(slugDir, { recursive: true })
  const cwd = join(claudeDir, 'demo-project')
  mkdirSync(cwd, { recursive: true })
  const lines =
    JSON.stringify({ type: 'queue-operation' }) +
    '\n' +
    JSON.stringify({ type: 'last-prompt' }) +
    '\n' +
    JSON.stringify({ type: 'user', cwd, message: { content: 'Remember I like tests.' } }) +
    '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Noted.' }] } }) +
    '\n'
  const sessionPath = join(slugDir, 'sess-demo.jsonl')
  writeFileSync(sessionPath, lines, 'utf8')
  // scanClaudeCode treats a transcript modified in the last ten minutes as
  // still live -- its own Stop hook is capturing it -- and excludes it
  // entirely (spec 011 §8's "Which sessions" paragraph). A freshly-written
  // file's mtime is "now", which would otherwise make this whole fixture
  // invisible to the scan; backdating it a day keeps it inside the default
  // 180-day window and safely outside the ten-minute live one.
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  utimesSync(sessionPath, oneDayAgo, oneDayAgo)
  return { slugDir, sessionPath, cwd }
}

// ---- mergeHookSettings / removeHookSettings (pure) ------------------------
// The three tests below are the brief's literal spec, verbatim.

test('mergeHookSettings adds our three events and preserves foreign hooks', () => {
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-tool' }] }] } }
  const merged = mergeHookSettings(existing, { command: 'npx -y waku-memory hook' })
  const stop = merged.hooks.Stop
  assert.equal(stop.length, 2) // theirs untouched, ours appended
  const ours = stop[1].hooks[0]
  assert.ok(ours.command.includes('waku-memory hook'))
  assert.equal(ours.async, true) // Stop must not block the turn
  assert.ok(merged.hooks.SessionStart && merged.hooks.SessionEnd)
  const sessionEnd = merged.hooks.SessionEnd.at(-1).hooks[0]
  assert.equal(sessionEnd.timeout, 10) // inside the raisable budget
  assert.equal(sessionEnd.async, undefined) // async is ignored there anyway
})

test('mergeHookSettings is idempotent', () => {
  const once = mergeHookSettings({}, { command: 'npx -y waku-memory hook' })
  assert.deepEqual(mergeHookSettings(once, { command: 'npx -y waku-memory hook' }), once)
})

test('removeHookSettings removes exactly what merge added', () => {
  const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-tool' }] }] } }
  assert.deepEqual(removeHookSettings(mergeHookSettings(existing, { command: 'npx -y waku-memory hook' })), existing)
})

// ---- UserPromptSubmit registration (spec 023 §2) --------------------------

test('enable registers UserPromptSubmit alongside the other three events', () => {
  const merged = captureModule.mergeHookSettings({}, { command: 'node', args: ['/x/.waku-memory/hook/index.js', 'hook'] })
  assert.deepEqual(
    Object.keys(merged.hooks).sort(),
    ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'],
  )
  const entry = merged.hooks.UserPromptSubmit[0].hooks[0]
  // Synchronous with a real budget, like SessionStart: a marker that lands
  // after the turn's first tool call stamps that call with the previous turn.
  assert.equal(entry.async, undefined)
  assert.equal(entry.timeout, 5)
})

test('disable takes the UserPromptSubmit entry back out', () => {
  const run = { command: 'node', args: ['/x/.waku-memory/hook/index.js', 'hook'] }
  const merged = captureModule.mergeHookSettings({}, run)
  assert.deepEqual(captureModule.removeHookSettings(merged), {})
})

// ---- pure functions: coverage beyond the literal spec ---------------------

test('mergeHookSettings: an explicit npx invocation (the 0.1.x shell form) still merges verbatim', () => {
  // 0.1.x wrote this exact command; isOwnEntry still has to recognise it
  // (spec 011 A10) even though enable() itself never writes it anymore --
  // see the installed-copy exec-form tests below.
  const merged = mergeHookSettings({}, { command: 'npx -y waku-memory hook' })
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'npx -y waku-memory hook')
})

test('mergeHookSettings: a foreign hook on SessionStart (not just Stop) survives too', () => {
  const existing = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool' }] }] } }
  const merged = mergeHookSettings(existing, { command: 'npx -y waku-memory hook' })
  assert.equal(merged.hooks.SessionStart.length, 2)
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, 'other-tool')
})

test('mergeHookSettings: unrelated top-level settings keys pass through untouched', () => {
  const existing = { model: 'opus', permissions: { allow: ['Bash'] } }
  const merged = mergeHookSettings(existing, { command: 'npx -y waku-memory hook' })
  assert.equal(merged.model, 'opus')
  assert.deepEqual(merged.permissions, { allow: ['Bash'] })
})

test('removeHookSettings: a foreign hook sharing an event with ours is kept, ours is dropped', () => {
  const withForeignAndOurs = mergeHookSettings(
    { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'their-flush' }] }] } },
    { command: 'npx -y waku-memory hook' },
  )
  const removed = removeHookSettings(withForeignAndOurs)
  assert.equal(removed.hooks.SessionEnd.length, 1)
  assert.equal(removed.hooks.SessionEnd[0].hooks[0].command, 'their-flush')
})

test('removeHookSettings: unrelated top-level settings keys pass through untouched', () => {
  const merged = mergeHookSettings({ model: 'opus' }, { command: 'npx -y waku-memory hook' })
  const removed = removeHookSettings(merged)
  assert.equal(removed.model, 'opus')
  assert.equal('hooks' in removed, false) // nothing foreign was left under any event
})

test('removeHookSettings: settings with no hooks key at all is returned as-is', () => {
  const existing = { model: 'opus' }
  assert.deepEqual(removeHookSettings(existing), existing)
})

// ---- A10 (spec 011 §6): installs a local copy, writes exec-form entries ---

const NODE = 'C:/Program Files/nodejs/node.exe'
const INDEX = 'C:/Users/y/.waku-memory/hook/0.2.0/index.js'

test('A10: mergeHookSettings writes exec-form entries, SessionStart synchronous with the five-value matcher, and replaces an older entry of ours', () => {
  const old = mergeHookSettings({}, { command: 'npx -y waku-memory hook' }) // 0.1.x shell form
  const merged = mergeHookSettings(old, { command: NODE, args: [INDEX, 'hook'] })
  assert.equal(merged.hooks.SessionStart.length, 1)
  assert.equal(merged.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact|fork')
  assert.deepEqual(merged.hooks.SessionStart[0].hooks[0], { type: 'command', command: NODE, args: [INDEX, 'hook'], timeout: 5 })
  assert.deepEqual(merged.hooks.Stop[0].hooks[0], { type: 'command', command: NODE, args: [INDEX, 'hook'], async: true })
  assert.equal(merged.hooks.SessionEnd[0].hooks[0].timeout, hookModule.SESSION_END_HOOK_TIMEOUT_S)
  // a second enable over a 0.2.0 entry replaces it too, and is idempotent
  const newer = mergeHookSettings(merged, { command: NODE, args: [INDEX.replace('0.2.0', '0.3.0'), 'hook'] })
  assert.equal(newer.hooks.Stop.length, 1)
  assert.equal(newer.hooks.Stop[0].hooks[0].args[0], INDEX.replace('0.2.0', '0.3.0'))
  assert.deepEqual(mergeHookSettings(newer, { command: NODE, args: [INDEX.replace('0.2.0', '0.3.0'), 'hook'] }), newer)
})

test('A10: enable refuses, and writes no settings, when the entry it wrote does not run', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const src = join(dir, 'dist'); mkdirSync(src); writeFileSync(join(src, 'index.js'), '')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc']), hookSourceDir: src, version: '0.2.0', verifyHook: () => false })
    const out = await captureLog(async () => { assert.equal(await enable('https://ingest.test', deps), 'refused') })
    assert.match(out, /did not run|could not run/i)
    assert.equal(existsSync(deps.settingsPath), false)
    // installHookCopy ran before the failed verify -- a refusal must undo
    // that copy too, not just skip the settings write (task 11 review).
    assert.equal(existsSync(join(deps.configDir, 'hook')), false)
  })
})

test('A10: a refusal leaves a pre-existing hook copy alone when installHookCopy was a no-op (enable re-run from inside the installed copy)', async () => {
  // Re-review of the fix above: that cleanup fired on any verify failure,
  // with no check that this call had actually made a copy. installHookCopy
  // no-ops when hookSourceDir already *is* configDir/hook/<version> -- the
  // shape of a second `enable` run from inside the copy it installed last
  // time, since hookSourceDir derives from the running cli.js's own
  // import.meta.url. Seed exactly that: a version directory that predates
  // this call, with a marker file nothing in this call could have written.
  // A refusal must not delete it -- it may be the very copy settings.json
  // still points at from an earlier, successful enable.
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    const installedDir = join(configDir, 'hook', '0.2.0')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'index.js'), '')
    writeFileSync(join(installedDir, 'marker.txt'), 'predates this call')
    const deps = makeDeps(dir, {
      prompt: fakePrompt(['y', 'mem_sk_abc']),
      configDir,
      hookSourceDir: installedDir, // enable re-run from inside the installed copy itself
      version: '0.2.0',
      verifyHook: () => false,
    })

    const out = await captureLog(async () => { assert.equal(await enable('https://ingest.test', deps), 'refused') })

    assert.match(out, /did not run|could not run/i)
    assert.equal(existsSync(join(installedDir, 'marker.txt')), true) // predates this call -- not this call's to delete
    assert.equal(existsSync(join(installedDir, 'index.js')), true)
    assert.equal(existsSync(join(deps.configDir, 'config.json')), false)
    assert.equal(existsSync(deps.settingsPath), false)
  })
})

test('A10: removeHookSettings drops the npx form and the exec form and nothing else', () => {
  const settings = { hooks: { Stop: [
    { hooks: [{ type: 'command', command: 'npx -y waku-memory hook', async: true }] },
    { hooks: [{ type: 'command', command: 'node', args: ['/h/.waku-memory/hook/0.2.0/index.js', 'hook'] }] },
    { hooks: [{ type: 'command', command: 'echo waku-memory is not ours' }] },
    { hooks: [{ type: 'command', command: 'node', args: ['/h/other/hook.js', 'hook'] }] },
  ] } }
  assert.deepEqual(removeHookSettings(settings).hooks.Stop.map((g) => g.hooks[0].command + ' ' + (g.hooks[0].args ?? []).join(' ')), ['echo waku-memory is not ours ', 'node /h/other/hook.js hook'])
})

test('A10: hookInvocation normalizes a backslash execPath to forward slashes too', () => {
  // installHookCopy's own forward-slash normalization is exercised above
  // (its return value is compared against a normalized expectation); this
  // pins the other half the "facts and decisions" call out explicitly --
  // Claude Code's exec form spawns command/args directly with no shell, so
  // a raw Windows execPath (backslashes, as process.execPath returns there)
  // must be normalized the same way the index path already is.
  const run = captureModule.hookInvocation('C:\\Program Files\\nodejs\\node.exe', 'C:/h/.waku-memory/hook/0.2.0/index.js')
  assert.deepEqual(run, { command: 'C:/Program Files/nodejs/node.exe', args: ['C:/h/.waku-memory/hook/0.2.0/index.js', 'hook'] })
})

test('A10: installHookCopy copies the running dist into configDir/hook/<version> with a module package.json', async () => {
  await withDir(async (dir) => {
    const src = join(dir, 'dist'); mkdirSync(src); writeFileSync(join(src, 'index.js'), 'console.log(1)'); writeFileSync(join(src, 'hook.js'), '')
    const index = captureModule.installHookCopy(src, join(dir, '.waku-memory'), '0.2.0')
    assert.equal(index, join(dir, '.waku-memory', 'hook', '0.2.0', 'index.js').replace(/\\/g, '/'))
    assert.equal(readFileSync(join(dir, '.waku-memory', 'hook', '0.2.0', 'hook.js'), 'utf8'), '')
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.waku-memory', 'hook', '0.2.0', 'package.json'), 'utf8')), { type: 'module' })
  })
})

test('A10: enable writes entries that run the copy with node', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const src = join(dir, 'dist'); mkdirSync(src); writeFileSync(join(src, 'index.js'), '')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']), hookSourceDir: src, version: '0.2.0' })
    assert.equal(await enable('https://ingest.test', deps), 'enabled')
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    const entry = settings.hooks.Stop[0].hooks[0]
    assert.equal(entry.command, deps.execPath) // the Node that ran enable, never the bare word `node`
    assert.match(entry.args[0], /\/\.waku-memory\/hook\/0\.2\.0\/index\.js$/)
    assert.equal(entry.args[1], 'hook')
  })
})

test('A10: enable really runs the installed copy -- a live spawnSync verify, not the stub', async () => {
  // Every other 'enabled' test above drives verifyHook with a stub
  // (`() => true`) and an execPath that is never actually spawned. Neither
  // proves the copy installHookCopy just wrote is runnable ESM, and
  // cli.ts's real verifyHook wiring (spawnSync + a throwaway stdin event)
  // gets no coverage from any of them. This test drives that real wiring
  // against a real temp hookSourceDir and a real Node process.
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const src = join(dir, 'dist')
    mkdirSync(src)
    // ESM-safe with no imports at all -- installHookCopy writes the
    // {"type":"module"} package.json next to it, which is what makes that
    // safe rather than accidental.
    writeFileSync(join(src, 'index.js'), "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));")
    const deps = makeDeps(dir, {
      prompt: fakePrompt(['y', 'mem_sk_abc']),
      hookSourceDir: src,
      version: '0.2.0',
      execPath: process.execPath,
      verifyHook: (run) =>
        spawnSync(run.command, run.args ?? [], { input: '{"hook_event_name":"Nope"}\n', timeout: 10_000 }).status === 0,
    })

    assert.equal(await enable('https://ingest.test', deps), 'enabled')

    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.equal(settings.hooks.Stop[0].hooks[0].command, process.execPath.replace(/\\/g, '/'))
    assert.equal(existsSync(join(dir, '.waku-memory', 'hook', '0.2.0', 'index.js')), true)
  })
})

test('A10: a second enable with a newer version removes the older hook directory', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const src = join(dir, 'dist'); mkdirSync(src); writeFileSync(join(src, 'index.js'), '')
    await enable('https://ingest.test', makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc']), hookSourceDir: src, version: '0.2.0' }))
    await enable('https://ingest.test', makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc']), hookSourceDir: src, version: '0.3.0' }))
    assert.deepEqual(readdirSync(join(dir, '.waku-memory', 'hook')), ['0.3.0'])
  })
})

// ---- final review M1: isOwnEntry must not throw on an entry it cannot
// prove is a string -------------------------------------------------------
// readClaudeSettings only validates settings.json as a top-level plain
// object (its own comment); anything inside `hooks` is whatever some other
// tool wrote. Before this fix, a foreign exec-form entry whose last argument
// was literally 'hook' but which also carried a non-string argument (a
// number, null, ...) made `args.some((a) => a.replace(...))` throw a
// TypeError out of isOwnEntry -- which mergeHookSettings calls once per
// existing group, which enable() calls *after* config.json is already
// written (enable()'s own step-6 comment above). The result was a real
// credential on disk with no hook installed. Such an entry is never ours:
// typeof-guard it and return false, same as a non-string `command`.

test('isOwnEntry: an exec-form entry with a non-string element in args is never ours, and does not throw', () => {
  assert.equal(captureModule.isOwnEntry({ type: 'command', command: 'their-tool', args: [42, 'hook'] }), false)
  assert.equal(captureModule.isOwnEntry({ type: 'command', command: 'their-tool', args: [null, 'hook'] }), false)
})

test('isOwnEntry: a non-string command is never ours, and does not throw', () => {
  assert.equal(captureModule.isOwnEntry({ type: 'command', command: 42 }), false)
})

test('mergeHookSettings: a foreign exec-form entry with a non-string arg does not throw, is left untouched, and ours is still added', () => {
  const foreignEntry = { type: 'command', command: 'their-tool', args: [42, 'hook'] }
  const existing = { hooks: { Stop: [{ hooks: [foreignEntry] }] } }
  const merged = mergeHookSettings(existing, { command: 'npx -y waku-memory hook' })
  assert.equal(merged.hooks.Stop.length, 2) // foreign untouched, ours appended
  assert.deepEqual(merged.hooks.Stop[0].hooks[0], foreignEntry)
  assert.ok(merged.hooks.Stop[1].hooks[0].command.includes('waku-memory hook'))
})

test('enable: a settings.json with a foreign entry whose args are not all strings does not throw, keeps the foreign entry untouched, and still adds ours', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc']) })
    const foreignEntry = { type: 'command', command: 'their-tool', args: [42, 'hook'] }
    writeFileSync(deps.settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [foreignEntry] }] } }))

    const result = await enable('https://ingest.test', deps)

    assert.equal(result, 'enabled') // must not throw out of mergeHookSettings
    assert.equal(existsSync(join(deps.configDir, 'config.json')), true)
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.deepEqual(settings.hooks.Stop[0].hooks[0], foreignEntry) // untouched
    assert.equal(settings.hooks.Stop[1].hooks[0].command, deps.execPath) // ours still added
  })
})

// ---- DISCLOSURE -------------------------------------------------------

test('DISCLOSURE names both the model-provider send and the alpha data-loss risk', () => {
  // The two sentences spec 005's "Disclosure" section requires -- see
  // status.md item 9's "no later than the day a worker is deployed" trigger.
  // This used to read /sent to our servers and to Anthropic for extraction/.
  // Spec 025 removed the processor's name, not the disclosure: the send is
  // still stated here and the processors are listed at www.waku.one/privacy,
  // which the clause below pins and plugin.test.mjs enforces across every
  // product string at once.
  assert.match(DISCLOSURE, /sent to our servers and on to the AI providers/)
  assert.match(DISCLOSURE, /www\.waku\.one\/privacy names them/)
  assert.match(DISCLOSURE, /alpha/i)
  assert.match(DISCLOSURE, /data can be lost/)
  // The three clauses spec 011 §9 (A15) adds: what is actually sent (typed
  // text, replies, tool names), the carve-out that makes "files read and
  // commands run are not sent" true even though a reply can quote them, and
  // the bootstrap preview pointing at the next question's own list.
  assert.match(DISCLOSURE, /What you type, what the agent replies, and the names of the tools it uses are sent/)
  assert.match(DISCLOSURE, /except where the agent quotes them in its reply/)
  assert.match(DISCLOSURE, /the next question lists exactly what/)
})

test('DISCLOSURE names Codex too (spec 012 §9, task 14) -- the earlier sentences read as Claude-Code-only otherwise', () => {
  // Verbatim -- this exact sentence, appended after everything spec
  // 005/spec 011 already established, is the acceptance criterion (spec 012
  // §9, Acceptance 15), not a paraphrase of it.
  assert.match(
    DISCLOSURE,
    /On Codex the same three hooks read ~\/\.codex\/sessions, or the Waku plugin sends each turn as you go\.$/,
  )

  // Sentence count, counted the way a reader would: a period that ends a
  // sentence is followed by whitespace or by nothing at all (end of
  // string). This has to be robust to "~/.codex/sessions" in the sentence
  // just pinned above -- that period sits between "." and "codex", with no
  // following space, so the naive DISCLOSURE.split('. ') would not (and
  // must not) see it as a sentence boundary either; the lookahead regex
  // below never matches it for the same reason.
  const sentenceEndings = DISCLOSURE.match(/\.(?=\s|$)/g) ?? []
  assert.equal(
    sentenceEndings.length,
    6,
    'six sentence-ending periods: the two of spec 005, the one carrying spec 011 §9\'s three ' +
      'clauses (joined by semicolons, not periods, so it counts once here), the bootstrap preview, ' +
      'and the Codex sentence spec 012 task 14 appends. Spec 025 added a processor and did not ' +
      'add a sentence: naming each one would have grown this prompt with every vendor, so the ' +
      'first sentence points at www.waku.one/privacy instead and the count is unchanged. The ' +
      'periods inside that URL are followed by letters, so the lookahead below never counts them, ' +
      'the same way it does not count the one in ~/.codex/sessions. Spec 063 added the sixth: ' +
      'the folder and the git remote are sent so memories are filed by project',
  )
})

// ---- enable(): the disclosure gate -----------------------------------

test('enable: refuses when neither Claude Code nor Codex is installed, before asking anything', async () => {
  // Widened (task 10, spec 012 §4.6): a machine missing Claude Code alone is
  // no longer a refusal -- makeDeps's default codexConfigPath is also
  // nonexistent here, so this is genuinely "neither harness", the one case
  // that still refuses, naming both paths.
  await withDir(async (dir) => {
    const prompt = fakePrompt([])
    const deps = makeDeps(dir, { claudeDir: join(dir, 'no-such-claude-dir'), prompt })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps)
      assert.equal(result, 'refused')
    })

    assert.match(out, /Neither Claude Code .* nor Codex/)
    assert.equal(prompt.questions.length, 0) // never got to the disclosure prompt
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('enable: a Claude-Code-missing, Codex-present machine is not refused -- the widened check only refuses when neither exists', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, {
      claudeDir: join(dir, 'no-such-claude-dir'),
      prompt: fakePrompt(['y', 'mem_sk_abc', 'n']),
    })

    const result = await enable(OUR_INGEST_URL, deps)

    assert.equal(result, 'enabled')
  })
})

test('enable: prints the disclosure before asking for confirmation', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y', 'k'])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(() => enable('https://ingest.test', deps))

    assert.match(out, /sent to our servers and on to the AI providers/)
    assert.equal(prompt.questions.length, 2)
    // The confirmation question must be asked first -- the key is only
    // asked once the disclosure has been typed through, not before.
    assert.doesNotMatch(prompt.questions[0], /key/i)
  })
})

test('enable: a non-y answer aborts without asking for a key or writing anything', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    for (const answer of ['n', 'N', 'no', '', 'yes']) {
      const prompt = fakePrompt([answer])
      const deps = makeDeps(dir, { prompt })

      const result = await enable('https://ingest.test', deps)

      assert.equal(result, 'declined', `expected "${answer}" to decline`)
      assert.equal(prompt.questions.length, 1, `expected "${answer}" to stop after one question`)
      assert.equal(existsSync(deps.configDir), false, `expected "${answer}" to write nothing`)
      assert.equal(existsSync(deps.settingsPath), false, `expected "${answer}" to write nothing`)
    }
  })
})

test('enable: "y" plus a pasted key writes config.json and merges settings.json', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'sekret-key-123']) })

    const result = await enable('https://ingest.test', deps)

    assert.equal(result, 'enabled')
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.deepEqual(config, { url: 'https://ingest.test', key: 'sekret-key-123' })

    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.equal(settings.hooks.Stop[0].hooks[0].command, deps.execPath) // exec form now, never the 0.1.x npx string
    assert.ok(settings.hooks.SessionStart)
    assert.ok(settings.hooks.SessionEnd)
  })
})

// ---- enable: what the pasted key may contain ------------------------------
// Measured 2026-09-04 (spec 005 task 16, status.md item 24a): a Windows
// console delivered Ctrl+V's own control code (0x16) ahead of the pasted
// key, `.trim()` left it in place, and every hook call then failed with an
// opaque "fetch failed" (undici refusing the Authorization header). The key
// is a bearer token, so only printable ASCII can ever be part of it;
// anything else in the answer came from the terminal, not the person.

// Review of 0.1.1 (2026-09-05): stripping *inside* the string glued two
// tokens into one valid-looking key -- "Bearer mem_sk_abc" was saved as
// "Bearermem_sk_abc" under a message blaming the terminal, and the next
// hook got a 401 nobody sees. Junk at the ends is the terminal's; junk
// inside means the paste held more than the key, and the only honest
// answer is to say so and ask again.
test('sanitizeKey strips non-printable characters at the ends and counts what is left inside', () => {
  assert.deepEqual(captureModule.sanitizeKey('\x16mem_sk_abc\r\n'), { key: 'mem_sk_abc', removed: 3, interior: 0 })
  assert.deepEqual(captureModule.sanitizeKey('  mem_sk_abc '), { key: 'mem_sk_abc', removed: 3, interior: 0 })
  assert.deepEqual(captureModule.sanitizeKey('Bearer mem_sk_abc'), { key: 'Bearer mem_sk_abc', removed: 0, interior: 1 })
  assert.deepEqual(captureModule.sanitizeKey('mem_sk_　abc'), { key: 'mem_sk_　abc', removed: 0, interior: 1 })
  assert.deepEqual(captureModule.sanitizeKey('mem_sk_abc'), { key: 'mem_sk_abc', removed: 0, interior: 0 })
})

test('enable: a paste with something other than the key inside it is refused and asked again, never glued', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y', 'Bearer mem_sk_abc', 'mem_sk_abc'])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(() => enable('https://ingest.test', deps))

    assert.equal(prompt.questions.length, 3)
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_abc')
    assert.match(out, /1 character[^\n]*inside/i)
    // The key itself, glued or not, is never printed.
    assert.doesNotMatch(out, /mem_sk_abc/)
  })
})

test('enable: a key that does not start with mem_sk_ is saved with a warning, not refused', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'sekret-key-123']) })

    const out = await captureLog(() => enable('https://ingest.test', deps))

    assert.match(out, /does not start with mem_sk_/i)
    assert.doesNotMatch(out, /sekret-key-123/)
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'sekret-key-123')
  })
})

test("enable: a pasted key carrying Ctrl+V's control code is saved without it", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', '\x16sekret-key-123']) })

    const result = await enable('https://ingest.test', deps)

    assert.equal(result, 'enabled')
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'sekret-key-123')
  })
})

test('enable: says how many characters it removed from the pasted key', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', '\x16sekret-key-123']) })

    const out = await captureLog(() => enable('https://ingest.test', deps))

    assert.match(out, /removed 1 non-printable character/i)
    assert.doesNotMatch(out, /sekret-key-123/) // the key is never printed, repaired or not
  })
})

test('enable: an answer with no usable key in it is asked again, and the second answer is saved', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y', '\x16\r\n', 'sekret-key-123'])
    const deps = makeDeps(dir, { prompt })

    const result = await enable('https://ingest.test', deps)

    assert.equal(result, 'enabled')
    assert.equal(prompt.questions.length, 3)
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'sekret-key-123')
  })
})

test('enable: three unusable keys in a row end the run with nothing written', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y', '', ' ', '\x16'])
    const deps = makeDeps(dir, { prompt })

    let result
    const out = await captureLog(async () => {
      result = await enable('https://ingest.test', deps)
    })

    assert.equal(result, 'declined')
    assert.equal(prompt.questions.length, 4)
    assert.equal(existsSync(deps.configDir), false)
    assert.equal(existsSync(deps.settingsPath), false)
    assert.match(out, /no usable key/i)
  })
})

// The SessionEnd entry's `timeout` is the whole process budget hook.ts's
// network budget has to fit under; the two numbers live in hook.ts side by
// side so they cannot drift apart again (item 24c: 800 ms was derived from
// a 1.5 s default this entry had already raised to 10 s).
test('mergeHookSettings installs SessionEnd with the timeout hook.ts budgets against', () => {
  const merged = mergeHookSettings({}, { command: 'npx -y waku-memory hook' })
  assert.equal(merged.hooks.SessionEnd[0].hooks[0].timeout, hookModule.SESSION_END_HOOK_TIMEOUT_S)
})

test('enable: preserves an existing settings.json\'s foreign hooks and other keys', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'k']) })
    writeFileSync(
      deps.settingsPath,
      JSON.stringify({
        model: 'opus',
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-tool' }] }] },
      }),
    )

    await enable('https://ingest.test', deps)

    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.equal(settings.model, 'opus')
    assert.equal(settings.hooks.Stop.length, 2)
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'their-tool')
  })
})

test('enable: running twice leaves exactly one set of our entries', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'k1']) })
    await enable('https://ingest.test', deps)

    const deps2 = { ...deps, prompt: fakePrompt(['y', 'k2']) }
    const result2 = await enable('https://ingest.test', deps2)

    assert.equal(result2, 'enabled')
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.equal(settings.hooks.Stop.length, 1)
    assert.equal(settings.hooks.SessionStart.length, 1)
    assert.equal(settings.hooks.SessionEnd.length, 1)
    // The second run's pasted key wins -- config.json is a plain overwrite,
    // not a merge (there is nothing to merge: it is one credential).
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'k2')
  })
})

test('enable: a settings.json that fails to parse is refused before the disclosure is even shown', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt([]) // must not be called at all -- fails fast, before any prompt
    const deps = makeDeps(dir, { prompt })
    writeFileSync(deps.settingsPath, '{ not valid json')

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps)
      assert.equal(result, 'refused')
    })

    assert.equal(prompt.questions.length, 0)
    assert.equal(readFileSync(deps.settingsPath, 'utf8'), '{ not valid json') // untouched
    assert.equal(existsSync(join(deps.configDir, 'config.json')), false) // no partial state
    assert.ok(out.trim().length > 0)
  })
})

test('enable: "Y" (uppercase) is accepted -- the gate checks intent, not exact case', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['Y', 'k']) })

    const result = await enable('https://ingest.test', deps)

    assert.equal(result, 'enabled')
  })
})

// ---- enable(): the third question -- bootstrap (task 13, spec 011 §8) ----
//
// bootstrap.test.mjs's own A13 tests already cover runBootstrap's sending
// logic in full against hand-built Scans; everything here only has to prove
// that enable() wires the question in correctly: asked (or not) at the
// right time, in the right order relative to sending, and that an answer
// resolves to the selection the brief describes.

test('bootstrap: an empty ~/.claude asks no third question and reports nothing to import', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y', 'mem_sk_abc'])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(() => enable('https://ingest.test', deps))

    assert.equal(prompt.questions.length, 2) // no third question was asked
    assert.match(out, /Nothing from Claude Code to import on this machine\./)
  })
})

test('bootstrap: a fixture project prints the list and asks "> " as the third question; nothing is sent before it answers', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    let callsWhenAsked = null
    const basePrompt = fakePrompt(['y', 'mem_sk_abc', ''])
    const prompt = async (question) => {
      // B1: enable() now posts one consent call (spec 024 §2) before it ever
      // gets this far, so "nothing sent before the third answer" is about
      // bootstrap's own sends, not the door's consent PUT -- filtered out.
      if (question === '> ') callsWhenAsked = fetchImpl.calls.filter((c) => !c.url.includes('/capture/')).length
      return basePrompt(question)
    }
    const deps = makeDeps(dir, { prompt, fetchImpl })

    const out = await captureLog(() => enable('https://ingest.test', deps))

    assert.equal(basePrompt.questions.length, 3)
    assert.equal(basePrompt.questions[2], '> ')
    assert.match(out, /Found memory and history from Claude Code on this machine/)
    assert.equal(callsWhenAsked, 0) // nothing bootstrap-related sent before the third answer
    assert.ok(fetchImpl.calls.length > 0) // Enter (blank) sends everything found
    assert.match(out, /\d+ memory files? queued, \d+ sessions? queued in \d+ pieces?/)
  })
})

test('bootstrap: "n" as the third answer sends nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']), fetchImpl })

    await enable('https://ingest.test', deps)

    // B1: filtered past enable()'s own consent PUT (spec 024 §2) -- this
    // test is about bootstrap sending nothing, not about the door's call.
    assert.equal(fetchImpl.calls.filter((c) => !c.url.includes('/capture/')).length, 0)
  })
})

test('bootstrap: excluding the only project by number sends nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', '1']), fetchImpl })

    await enable('https://ingest.test', deps)

    assert.equal(fetchImpl.calls.filter((c) => !c.url.includes('/capture/')).length, 0)
  })
})

test('bootstrap: an invalid third answer is asked again once; a second invalid means skip', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt(['y', 'mem_sk_abc', 'bogus', 'also-bogus'])
    const deps = makeDeps(dir, { prompt, fetchImpl })

    const out = await captureLog(() => enable('https://ingest.test', deps))

    assert.equal(prompt.questions.length, 4) // disclosure, key, first "> ", the retry
    assert.match(out, /Enter, numbers, or n\./)
    // B1: filtered past enable()'s own consent PUT -- the second invalid
    // answer was treated as skip, so bootstrap itself sent nothing.
    assert.equal(fetchImpl.calls.filter((c) => !c.url.includes('/capture/')).length, 0)
  })
})

test('bootstrap: one invalid answer, then a valid one, sends', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt(['y', 'mem_sk_abc', 'bogus', ''])
    const deps = makeDeps(dir, { prompt, fetchImpl })

    await enable('https://ingest.test', deps)

    assert.equal(prompt.questions.length, 4)
    assert.ok(fetchImpl.calls.length > 0)
  })
})

test('bootstrap: bootstrap.enabled false asks two questions only, even with a real fixture on disk', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt(['y', 'mem_sk_abc'])
    const deps = makeDeps(dir, { prompt, fetchImpl, bootstrap: { windowDays: 180, enabled: false } })

    await enable('https://ingest.test', deps)

    assert.equal(prompt.questions.length, 2)
    // B1: filtered past enable()'s own consent PUT -- bootstrap itself is
    // disabled here, so it is bootstrap's own sends that must be zero.
    assert.equal(fetchImpl.calls.filter((c) => !c.url.includes('/capture/')).length, 0)
  })
})

// ---- enable(): the credential decision (task 13, spec 012 §7) -------------
//
// Every test above this section calls enable(url, deps) with no third
// argument at all -- the legacy shape resolveCredential (capture.ts) keeps
// byte-for-byte identical to what askForKey alone did before this task, so
// none of them needed to change. Everything below passes `credential`
// explicitly and is new.

test('enable: credential ask with no stored key asks the Sign-in question; "1" calls login and never asks for a key', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    const prompt = fakePrompt(['y', '1'])
    const login = fakeLogin('signed-in', configDir)
    const deps = makeDeps(dir, { prompt, login, configDir })

    const result = await enable('https://ingest.test', deps, { kind: 'ask' })

    assert.equal(result, 'enabled')
    assert.equal(prompt.questions.length, 2)
    assert.equal(prompt.questions[1], 'Sign in [1] in the browser (recommended) [2] by pasting a key: ')
    assert.equal(login.calls, 1)
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_from_login')
  })
})

test('enable: credential ask, "2" asks for the key exactly like before', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y', '2', 'mem_sk_pasted'])
    const deps = makeDeps(dir, { prompt })

    const result = await enable('https://ingest.test', deps, { kind: 'ask' })

    assert.equal(result, 'enabled')
    assert.equal(prompt.questions.length, 3)
    assert.match(prompt.questions[2], /Paste an API key/)
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_pasted')
  })
})

test('enable: credential ask, three invalid answers to the Sign-in question decline, writing nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y', 'x', 'q', ''])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'ask' })
      assert.equal(result, 'declined')
    })

    assert.equal(prompt.questions.length, 4) // disclosure + three Sign-in attempts
    assert.match(out, /not enabled/)
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('enable: credential login skips the Sign-in question entirely', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    const prompt = fakePrompt(['y'])
    const login = fakeLogin('signed-in', configDir, 'mem_sk_login2')
    const deps = makeDeps(dir, { prompt, login, configDir })

    const result = await enable('https://ingest.test', deps, { kind: 'login' })

    assert.equal(result, 'enabled')
    assert.equal(prompt.questions.length, 1) // only the disclosure
    assert.equal(login.calls, 1)
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_login2')
  })
})

test('enable: credential key stores the given key, asking nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt })

    const result = await enable('https://ingest.test', deps, { kind: 'key', key: 'mem_sk_direct' })

    assert.equal(result, 'enabled')
    assert.equal(prompt.questions.length, 1) // only the disclosure
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_direct')
  })
})

test('enable: credential login, a timeout declines with one sentence and writes nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    const prompt = fakePrompt(['y'])
    const login = fakeLogin('timeout', configDir)
    const deps = makeDeps(dir, { prompt, login, configDir })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'login' })
      assert.equal(result, 'declined')
    })

    assert.match(out, /Capture not enabled -- sign-in did not complete; nothing was written\./)
    assert.equal(existsSync(configDir), false)
  })
})

test('enable: credential login, a refusal declines the same way as a timeout', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    const prompt = fakePrompt(['y'])
    const login = fakeLogin('refused', configDir)
    const deps = makeDeps(dir, { prompt, login, configDir })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'login' })
      assert.equal(result, 'declined')
    })

    assert.match(out, /Capture not enabled -- sign-in did not complete; nothing was written\./)
    assert.equal(existsSync(configDir), false)
  })
})

// ---- Fix round 1, finding 2: 'signed-in' with an unreadable config.json
// must refuse, not continue with an empty key ------------------------------

test('enable: credential login, signed-in but config.json was never written back refuses, not enabling with an empty key', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    const prompt = fakePrompt(['y'])
    // Unlike fakeLogin(), this never calls writeConfigJson -- reproduces a
    // deps.login() that reports 'signed-in' but leaves config.json missing
    // (the bug: the old code read that back as `null` and folded it into
    // `key: key ?? ''`, then proceeded to install the hook with an empty
    // key and no error).
    const login = async () => 'signed-in'
    const deps = makeDeps(dir, { prompt, login, configDir })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'login' })
      assert.equal(result, 'refused')
    })

    assert.match(out, /Signed in, but the key could not be read back from/)
    assert.match(out, /nothing else was written\./)
    assert.equal(existsSync(configDir), false)
    assert.equal(existsSync(deps.settingsPath), false) // never reached installHookCopy/writeSettingsJson
  })
})

// ---- Fix round 1, finding 3: --key goes through the same sanitizeKey
// checks a pasted key does -------------------------------------------------

test('enable: credential key strips leading/trailing non-printable characters, exactly like a pasted key', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'key', key: '\x16mem_sk_direct\r\n' })
      assert.equal(result, 'enabled')
    })

    assert.match(out, /Removed 3 non-printable character\(s\)/)
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_direct')
  })
})

test('enable: credential key "" declines outright -- no re-ask, nothing written', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'key', key: '' })
      assert.equal(result, 'declined')
    })

    assert.equal(prompt.questions.length, 1) // only the disclosure -- no re-ask
    assert.match(out, /Capture not enabled -- no usable key was entered; nothing was written\./)
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('enable: credential key with interior garbage declines outright -- no re-ask, nothing written', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'key', key: 'Bearer mem_sk_abc' })
      assert.equal(result, 'declined')
    })

    assert.equal(prompt.questions.length, 1) // only the disclosure -- no re-ask
    assert.match(out, /cannot be part of a key/)
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('enable: credential key without the KEY_PREFIX still stores it, with the same note a paste gets', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'key', key: 'not-the-right-shape' })
      assert.equal(result, 'enabled')
    })

    assert.match(out, /Note: the key does not start with mem_sk_/)
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'not-the-right-shape')
  })
})

// ---- R13: a stored key is kept -------------------------------------------

test('enable: credential ask with a stored key skips the question entirely and keeps it', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    writeConfigJson(configDir, { url: 'https://old.test', key: 'mem_sk_stored' })
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt, configDir })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'ask' })
      assert.equal(result, 'enabled')
    })

    assert.equal(prompt.questions.length, 1) // only the disclosure -- no credential question
    assert.match(out, /Using the key already stored in/)
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_stored')
    assert.equal(config.url, 'https://ingest.test') // this run's url, not the stored one
  })
})

test('enable: credential login overrides a stored key', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    writeConfigJson(configDir, { url: 'https://old.test', key: 'mem_sk_stored' })
    const prompt = fakePrompt(['y'])
    const login = fakeLogin('signed-in', configDir, 'mem_sk_new_from_login')
    const deps = makeDeps(dir, { prompt, login, configDir })

    const result = await enable('https://ingest.test', deps, { kind: 'login' })

    assert.equal(result, 'enabled')
    assert.equal(login.calls, 1)
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_new_from_login')
  })
})

test('enable: credential key overrides a stored key', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    writeConfigJson(configDir, { url: 'https://old.test', key: 'mem_sk_stored' })
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt, configDir })

    const result = await enable('https://ingest.test', deps, { kind: 'key', key: 'mem_sk_direct_override' })

    assert.equal(result, 'enabled')
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_direct_override')
  })
})

// ---- R14: a later refusal after login must not claim "nothing was
// written" -- the key is already on disk by then ---------------------------

test('enable: credential login, a verify failure after sign-in reports the key as still saved, not "nothing was written"', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const configDir = join(dir, '.waku-memory')
    const src = join(dir, 'dist')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'index.js'), '')
    const prompt = fakePrompt(['y'])
    const login = fakeLogin('signed-in', configDir, 'mem_sk_from_login')
    const deps = makeDeps(dir, { prompt, login, configDir, hookSourceDir: src, verifyHook: () => false })

    const out = await captureLog(async () => {
      const result = await enable('https://ingest.test', deps, { kind: 'login' })
      assert.equal(result, 'refused')
    })

    assert.doesNotMatch(out, /nothing was written/)
    assert.match(out, /Your API key is still saved at/)
    assert.match(out, /account\/keys/)
    // login() already wrote it -- a failed verify must not pretend it didn't,
    // and must not delete it either.
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    assert.equal(config.key, 'mem_sk_from_login')
    assert.equal(existsSync(deps.settingsPath), false) // settings.json still never written
  })
})

// ---- disable() ----------------------------------------------------------

test('disable: removes exactly our entries and preserves a foreign hook', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir)
    const withForeign = mergeHookSettings(
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-tool' }] }] } },
      { command: 'npx -y waku-memory hook' },
    )
    writeFileSync(deps.settingsPath, JSON.stringify(withForeign))

    const result = await disable(deps)

    assert.equal(result, 'disabled')
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.deepEqual(settings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-tool' }] }] } })
  })
})

test('disable: leaves config.json in place -- the key is the user\'s to revoke', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir)
    mkdirSync(deps.configDir, { recursive: true })
    const configPath = join(deps.configDir, 'config.json')
    const configContent = JSON.stringify({ url: 'https://ingest.test', key: 'still-here' })
    writeFileSync(configPath, configContent)
    writeFileSync(deps.settingsPath, JSON.stringify(mergeHookSettings({}, { command: 'npx -y waku-memory hook' })))

    const out = await captureLog(() => disable(deps))

    assert.equal(readFileSync(configPath, 'utf8'), configContent)
    assert.match(out, /account\/keys/) // points them at where to revoke it
  })
})

test('disable: capture never enabled reports nothing to disable and writes nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir) // settingsPath never created

    const result = await disable(deps)

    assert.equal(result, 'nothing-to-disable')
    assert.equal(existsSync(deps.settingsPath), false)
  })
})

test('disable: a settings.json that fails to parse is refused, not clobbered', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir)
    writeFileSync(deps.settingsPath, '{ not valid json')

    const result = await disable(deps)

    assert.equal(result, 'refused')
    assert.equal(readFileSync(deps.settingsPath, 'utf8'), '{ not valid json')
  })
})

test('disable: idempotent -- disabling twice does not error the second time', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir)
    writeFileSync(deps.settingsPath, JSON.stringify(mergeHookSettings({}, { command: 'npx -y waku-memory hook' })))

    const first = await disable(deps)
    const second = await disable(deps)

    assert.equal(first, 'disabled')
    assert.equal(second, 'nothing-to-disable')
  })
})

// ---- enable()/disable()/status() on a Codex machine (task 10, spec 012 §4.6)

test('enable: a Codex-only HOME writes the MCP url into the TOML table (not the ingest base) and hooks.json with four entries, writes no marketplace file, and prints the trust line', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const out = await captureLog(async () => {
      // Fix round 1 regression pin (spec 012 §4.2): url (the parameter) is
      // the ingest base -- exactly what real usage passes (cli.ts's
      // runCaptureCommand) -- while deps.mcpUrl (OUR_URL, makeDeps's
      // default) is the "/mcp"-suffixed value. Before the fix, enable()
      // forwarded this same `url` argument into mergeCodexToml unchanged,
      // so the TOML assertion below would have seen OUR_INGEST_URL (no
      // "/mcp") instead of OUR_URL and failed.
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'enabled')
    })

    // Never touches settings.json -- there is no ~/.claude on this machine.
    assert.equal(existsSync(deps.claudeDir), false)
    assert.equal(existsSync(deps.settingsPath), false)

    // config.json keeps the ingest base -- hook.ts's endpointUrl() appends
    // its own path segments onto it, and would double up on a "/mcp" suffix.
    const config = JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.url, OUR_INGEST_URL)

    const toml = readFileSync(deps.codexConfigPath, 'utf8')
    assert.match(toml, /\[mcp_servers\.waku\]/)
    assert.match(toml, new RegExp(`url = "${OUR_URL}"`)) // the MCP url, not the ingest base
    assert.match(toml, /default_tools_approval_mode = "approve"/)

    const hooks = JSON.parse(readFileSync(deps.codexHooksPath, 'utf8'))
    // spec 023 §2: UserPromptSubmit joins the original three.
    assert.deepEqual(Object.keys(hooks.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    const stop = hooks.hooks.Stop[0].hooks[0]
    assert.ok(stop.command.includes(' hook --harness codex'))
    assert.ok(stop.command_windows.includes(' hook --harness codex'))
    assert.ok(stop.command_windows.includes('\\'))

    // spec 083: the npm package holds no plugin since 0.15.0, so the CLI
    // writes no entry that would install the plugin from npm.
    assert.equal(existsSync(deps.marketplacePath), false)

    assert.match(out, /Codex runs new hooks only after you trust them: open \/hooks in Codex and trust Waku's four entries\./)
  })
})

test('enable: a second enable on a Codex-only HOME leaves the TOML byte-identical and replaces the hooks entries, not duplicates them', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps1 = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']), version: '0.2.0' })
    await enable(OUR_INGEST_URL, deps1)
    const tomlAfterFirst = readFileSync(deps1.codexConfigPath, 'utf8')

    const deps2 = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_def', 'n']), version: '0.3.0' })
    const result = await enable(OUR_INGEST_URL, deps2)

    assert.equal(result, 'enabled')
    assert.equal(readFileSync(deps1.codexConfigPath, 'utf8'), tomlAfterFirst) // byte-identical -- unchanged, not rewritten

    const hooks = JSON.parse(readFileSync(deps1.codexHooksPath, 'utf8'))
    assert.equal(hooks.hooks.Stop.length, 1) // ours replaced, never duplicated
    assert.equal(hooks.hooks.SessionStart.length, 1)
    assert.equal(hooks.hooks.SessionEnd.length, 1)
  })
})

test('enable: a foreign [mcp_servers.waku] table (a different url) refuses before config.json is written', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withOther = `${CODEX_FIXTURE_TOML}\n[mcp_servers.waku]\nurl = "https://other/mcp"\n`
    writeFileSync(configPath, withOther, 'utf8')
    const prompt = fakePrompt([]) // must never be asked -- refuses before the disclosure

    const out = await captureLog(async () => {
      const deps = makeDeps(dir, { prompt })
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'refused')
    })

    assert.equal(prompt.questions.length, 0)
    assert.match(out, /already configured with a different URL/)
    assert.equal(existsSync(join(dir, '.waku-memory', 'config.json')), false)
    assert.equal(existsSync(join(dir, '.waku-memory', 'hook')), false)
    assert.equal(readFileSync(configPath, 'utf8'), withOther) // untouched
  })
})

test('enable: a hooks.json that fails to parse is refused before config.json is written', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt([]) })
    writeFileSync(deps.codexHooksPath, '{ not valid json')

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'refused')
    })

    assert.equal(deps.prompt.questions.length, 0)
    assert.match(out, /not something this tool can safely merge/i)
    assert.equal(existsSync(join(deps.configDir, 'config.json')), false)
    assert.equal(existsSync(join(deps.configDir, 'hook')), false) // installHookCopy never ran either
  })
})

test('enable: a marketplace.json that fails to parse is left as it is, and enable goes on', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    mkdirSync(join(dir, '.agents', 'plugins'), { recursive: true })
    writeFileSync(deps.marketplacePath, '{ not valid json')

    const result = await enable(OUR_INGEST_URL, deps)

    assert.equal(result, 'enabled')
    assert.equal(readFileSync(deps.marketplacePath, 'utf8'), '{ not valid json')
    assert.ok(JSON.parse(readFileSync(deps.codexHooksPath, 'utf8')).hooks.Stop)
  })
})

// spec 083: until 0.14.7 enable wrote this entry, which installed the plugin
// from npm. The npm package holds no plugin since 0.15.0.
const OLD_NPM_ENTRY = {
  name: 'waku',
  source: { source: 'npm', package: 'waku-memory' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Developer Tools',
}

test('enable: on a Codex machine without the plugin, the npm entry of an earlier version is removed and the install commands are printed', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    mkdirSync(join(dir, '.agents', 'plugins'), { recursive: true })
    writeFileSync(
      deps.marketplacePath,
      JSON.stringify({ name: 'personal', interface: { displayName: 'Personal' }, plugins: [{ name: 'someone-elses-plugin' }, OLD_NPM_ENTRY] }),
    )

    const out = await captureLog(async () => {
      assert.equal(await enable(OUR_INGEST_URL, deps), 'enabled')
    })

    assert.deepEqual(JSON.parse(readFileSync(deps.marketplacePath, 'utf8')), {
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: [{ name: 'someone-elses-plugin' }],
    })
    assert.match(out, /Removed the Waku entry from .*marketplace\.json\. It installed the plugin from npm, and the npm package no longer holds the plugin\./)
    assert.match(out, /codex plugin marketplace add waku-one\/waku-memory-plugins\n {2}codex plugin add waku@waku-memory/)
  })
})

test('enable: on a Codex machine with the plugin, the npm entry stays and the person is told how to install again', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'config.toml'), `${CODEX_FIXTURE_TOML}\n[plugins."waku@personal"]\nenabled = true\n`, 'utf8')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    mkdirSync(join(dir, '.agents', 'plugins'), { recursive: true })
    const before = JSON.stringify({ name: 'personal', plugins: [OLD_NPM_ENTRY] })
    writeFileSync(deps.marketplacePath, before)

    const out = await captureLog(async () => {
      assert.equal(await enable(OUR_INGEST_URL, deps), 'enabled')
    })

    assert.equal(readFileSync(deps.marketplacePath, 'utf8'), before)
    assert.match(out, /lists the Waku plugin from npm, and the npm package no longer holds the plugin\. If Codex installed the plugin from that entry, install it again:/)
    assert.match(out, /codex plugin add waku@waku-memory/)
    assert.doesNotMatch(out, /Removed the Waku entry/)
  })
})

test('enable: a HOME with both Claude Code and Codex writes both harnesses\' files', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const result = await enable(OUR_INGEST_URL, deps)

    assert.equal(result, 'enabled')
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.ok(settings.hooks.Stop)
    const toml = readFileSync(deps.codexConfigPath, 'utf8')
    assert.match(toml, /\[mcp_servers\.waku\]/)
    const hooks = JSON.parse(readFileSync(deps.codexHooksPath, 'utf8'))
    assert.ok(hooks.hooks.Stop)
    assert.equal(existsSync(deps.marketplacePath), false)
  })
})

test('enable: the Waku plugin present writes neither Codex file, prints the plugin sentence, and still runs the bootstrap', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withPlugin = `${CODEX_FIXTURE_TOML}\n[plugins."waku@personal"]\nenabled = true\n`
    writeFileSync(configPath, withPlugin, 'utf8')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'enabled')
    })

    assert.match(
      out,
      /The Waku plugin carries the hooks and the MCP server for Codex; enable adds login and the history import/,
    )
    assert.equal(existsSync(deps.codexHooksPath), false)
    assert.equal(existsSync(deps.marketplacePath), false)
    assert.equal(readFileSync(configPath, 'utf8'), withPlugin) // untouched -- the plugin wins
    assert.doesNotMatch(out, /trust them/) // no trust line -- no hooks.json was written this run
    // Bootstrap still ran (ruling R7): its printed output is observable. With
    // only Codex configured and nothing found to import, it correctly names Codex.
    assert.match(out, /Nothing from Codex to import on this machine\./)
  })
})

// ---- enable(): removing our own [mcp_servers.waku] table on a plugin
// machine (bug fix -- spec 012 §4.6 only covered plugin-then-enable; this
// covers the other order, enable-then-plugin, where nothing used to remove
// the table `enable` already wrote) -----------------------------------------

test('enable: on a machine carrying both our [mcp_servers.waku] table and the Waku plugin, enable removes the table and explains why', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    // The table exactly as a real "capture enable" would have written it
    // before the plugin ever arrived (mergeCodexToml against the plugin-less
    // fixture, matching makeDeps's default deps.mcpUrl below), then the
    // plugin table appended right after -- the enable-then-plugin order this
    // fix covers. withOurTable already ends in one trailing newline
    // (codexTomlBlock's own format), so the plugin header is appended
    // directly onto it, not preceded by a second, blank one -- removeCodexToml
    // only recognises our table's body as exactly its two lines (url,
    // approval), and an extra blank line inside that boundary would make it
    // (correctly) refuse, the same as any other line it did not write itself.
    const withOurTable = mergeCodexToml(CODEX_FIXTURE_TOML, OUR_URL).text
    const withBoth = `${withOurTable}[plugins."waku@personal"]\nenabled = true\n`
    writeFileSync(configPath, withBoth, 'utf8')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'enabled')
    })

    const after = readFileSync(configPath, 'utf8')
    assert.doesNotMatch(after, /\[mcp_servers\.waku\]/) // the table is gone
    // Every other byte identical: what remains is exactly removeCodexToml's
    // own answer for this input -- codex-config.test.mjs pins that function's
    // own byte-exactness; this only proves enable() writes what it computed.
    assert.equal(after, removeCodexToml(withBoth, OUR_URL).text)
    assert.match(
      out,
      /Removed the \[mcp_servers\.waku\] table enable wrote earlier: the Waku plugin already provides that server, and two waku servers sharing one sign-in can make Codex's sign-in fail\./,
    )
    assert.match(
      out,
      /The Waku plugin carries the hooks and the MCP server for Codex; enable adds login and the history import/,
    )
  })
})

test('enable: a plugin table with enabled = false is not "present" -- the table stays, and it is the only waku server', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withOurTable = mergeCodexToml(CODEX_FIXTURE_TOML, OUR_URL).text
    const withDisabledPlugin = `${withOurTable}\n[plugins."waku@personal"]\nenabled = false\n`
    writeFileSync(configPath, withDisabledPlugin, 'utf8')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'enabled')
    })

    assert.match(readFileSync(configPath, 'utf8'), /\[mcp_servers\.waku\]/) // the table stays
    assert.doesNotMatch(out, /Removed the \[mcp_servers\.waku\] table/)
    // codexPluginPresent says false -- enable() takes the ordinary non-plugin
    // path, which writes hooks.json the same as any plugin-less Codex machine.
    assert.equal(existsSync(deps.codexHooksPath), true)
  })
})

test('enable: a plugin machine whose [mcp_servers.waku] table carries a url that is not ours leaves the table untouched and prints nothing about removal', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const foreignTable = `${CODEX_FIXTURE_TOML}\n[mcp_servers.waku]\nurl = "https://someone-else.example/mcp"\ndefault_tools_approval_mode = "approve"\n\n[plugins."waku@personal"]\nenabled = true\n`
    writeFileSync(configPath, foreignTable, 'utf8')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'enabled')
    })

    assert.equal(readFileSync(configPath, 'utf8'), foreignTable) // untouched, byte for byte
    assert.doesNotMatch(out, /Removed the \[mcp_servers\.waku\] table/)
    assert.doesNotMatch(out, /removal/i)
    assert.match(
      out,
      /The Waku plugin carries the hooks and the MCP server for Codex; enable adds login and the history import/,
    )
  })
})

test('enable: a plugin machine with no TOML table at all is unchanged -- no removal sentence', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withPlugin = `${CODEX_FIXTURE_TOML}\n[plugins."waku@personal"]\nenabled = true\n`
    writeFileSync(configPath, withPlugin, 'utf8')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'enabled')
    })

    assert.equal(readFileSync(configPath, 'utf8'), withPlugin) // untouched
    assert.doesNotMatch(out, /Removed the \[mcp_servers\.waku\] table/)
  })
})

// The mid-file table shape measured on a real machine (2026-09-17,
// codex-config.test.mjs's own REAL_SHAPE_LF): our table sitting between two
// OTHER tables, not appended last -- the shape every pre-existing Codex test
// above never exercised, since they all build our table with mergeCodexToml
// at the very end of the fixture (or with the plugin table immediately
// after it, no blank separator). Built here by hand, inserted between
// CODEX_FIXTURE_TOML's own [desktop] and [mcp_servers.node_repl] tables, so
// our table's body ends with the blank line that already separated those
// two tables before ours ever existed -- exactly the boundary
// removeCodexToml's old `body.length === 2` check miscounted as a third
// body line and refused on, every time, on a real machine.
const withOurTableMidFile = [
  'notify = [ "C:\\\\fake\\\\notify.exe", "turn-ended" ]',
  'model = "gpt-5.6-fake"',
  'model_reasoning_effort = "medium"',
  '',
  '[desktop]',
  'followUpQueueMode = "steer"',
  'conversationDetailMode = "STEPS_COMMANDS"',
  'ambient-suggestions-enabled = true',
  '',
  '[mcp_servers.waku]',
  `url = "${OUR_URL}"`,
  'default_tools_approval_mode = "approve"',
  '',
  '[mcp_servers.node_repl]',
  'command = "C:\\\\fake\\\\node_repl.exe"',
  'startup_timeout_sec = 120.0',
  '',
  '[mcp_servers.node_repl.env]',
  'CODEX_HOME = "C:\\\\Users\\\\fake\\\\.codex"',
  'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS = "1000"',
  '',
  '[windows]',
  'wslDistro = "Ubuntu"',
  '',
].join('\n')

test('enable: on a plugin machine, removes our [mcp_servers.waku] table when it sits mid-file, between two other tables (the real shape measured on a real machine) -- these two integration tests are what 0.4.3 missed', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withPluginMidFile = `${withOurTableMidFile}\n[plugins."waku@personal"]\nenabled = true\n`
    writeFileSync(configPath, withPluginMidFile, 'utf8')
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps)
      assert.equal(result, 'enabled')
    })

    const after = readFileSync(configPath, 'utf8')
    assert.doesNotMatch(after, /\[mcp_servers\.waku\]/) // the table is gone
    // Every other byte identical, including the [windows] table that used to
    // sit right after ours and the blank line that separated them -- exactly
    // removeCodexToml's own answer for this input.
    assert.equal(after, removeCodexToml(withPluginMidFile, OUR_URL).text)
    assert.match(
      out,
      /Removed the \[mcp_servers\.waku\] table enable wrote earlier: the Waku plugin already provides that server, and two waku servers sharing one sign-in can make Codex's sign-in fail\./,
    )
  })
})

test('disable: removes our [mcp_servers.waku] table when it sits mid-file, between two other tables (the real shape measured on a real machine)', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    writeFileSync(configPath, withOurTableMidFile, 'utf8')
    const deps = makeDeps(dir)

    const result = await disable(deps)

    assert.equal(result, 'disabled')
    const after = readFileSync(configPath, 'utf8')
    assert.doesNotMatch(after, /\[mcp_servers\.waku\]/) // the table is gone
    assert.equal(after, removeCodexToml(withOurTableMidFile, OUR_URL).text)
  })
})

// ---- status(): warns about both duplicate-capture routes on a plugin
// machine, without ever writing anything (Change 2) -------------------------

test('status: plugin present and our [mcp_servers.waku] table also there -- the duplicate-server line, not the double-capture line', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withOurTable = mergeCodexToml(CODEX_FIXTURE_TOML, OUR_URL).text
    writeFileSync(configPath, `${withOurTable}\n[plugins."waku@personal"]\nenabled = true\n`, 'utf8')
    const deps = makeDeps(dir)

    const out = await captureLog(() => status(deps))

    assert.match(out, /Codex: plugin route/)
    assert.match(
      out,
      /Codex: two waku MCP servers \(the plugin's and \[mcp_servers\.waku\]\) -- run capture enable to remove the table/,
    )
    assert.doesNotMatch(out, /both routes are installed/)
  })
})

test('status: plugin present and our hooks.json entries also there -- the double-capture line, not the duplicate-server line', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      join(codexDir, 'config.toml'),
      `${CODEX_FIXTURE_TOML}\n[plugins."waku@personal"]\nenabled = true\n`,
      'utf8',
    )
    const deps = makeDeps(dir)
    writeFileSync(deps.codexHooksPath, JSON.stringify(mergeCodexHooks({}, '/fake/index.js')))

    const out = await captureLog(() => status(deps))

    assert.match(out, /Codex: plugin route/)
    assert.match(out, /Codex: both routes are installed -- a turn can be captured twice until the session is claimed, and capture disable removes ours/)
    assert.doesNotMatch(out, /two waku MCP servers/)
  })
})

test('status: plugin present and neither duplicate -- no warning lines', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      join(codexDir, 'config.toml'),
      `${CODEX_FIXTURE_TOML}\n[plugins."waku@personal"]\nenabled = true\n`,
      'utf8',
    )
    const deps = makeDeps(dir)

    const out = await captureLog(() => status(deps))

    assert.match(out, /Codex: plugin route/)
    assert.doesNotMatch(out, /two waku MCP servers/)
    assert.doesNotMatch(out, /both routes are installed/)
  })
})

test('status: the two duplicate-route warnings never write anything -- config.toml and hooks.json are untouched', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withOurTable = mergeCodexToml(CODEX_FIXTURE_TOML, OUR_URL).text
    const tomlText = `${withOurTable}\n[plugins."waku@personal"]\nenabled = true\n`
    writeFileSync(configPath, tomlText, 'utf8')
    const deps = makeDeps(dir)
    const hooksText = JSON.stringify(mergeCodexHooks({}, '/fake/index.js'))
    writeFileSync(deps.codexHooksPath, hooksText)

    await status(deps)

    assert.equal(readFileSync(configPath, 'utf8'), tomlText) // byte-identical
    assert.equal(readFileSync(deps.codexHooksPath, 'utf8'), hooksText) // byte-identical
    assert.equal(existsSync(join(deps.configDir, 'config.json')), false) // nothing else written either
  })
})

test('disable: removes ours from both Claude Code and Codex, leaving each harness\'s foreign entry untouched', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    writeFileSync(
      deps.settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-tool' }] }] } }),
    )
    writeFileSync(
      deps.codexHooksPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'their-codex-tool' }] }] } }),
    )

    await enable(OUR_INGEST_URL, deps)
    const result = await disable(deps)

    assert.equal(result, 'disabled')
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.equal(settings.hooks.Stop.length, 1)
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'their-tool')

    const hooks = JSON.parse(readFileSync(deps.codexHooksPath, 'utf8'))
    assert.equal(hooks.hooks.Stop.length, 1)
    assert.equal(hooks.hooks.Stop[0].hooks[0].command, 'their-codex-tool')
    assert.equal('SessionStart' in hooks.hooks, false)
    assert.equal('SessionEnd' in hooks.hooks, false)

    const toml = readFileSync(deps.codexConfigPath, 'utf8')
    assert.doesNotMatch(toml, /\[mcp_servers\.waku\]/) // our table removed
  })
})

test('disable: a Codex hooks.json that fails to parse is refused, and settings.json is left untouched', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildCodexFixture(dir)
    const deps = makeDeps(dir)
    const withOurs = mergeHookSettings({}, { command: 'npx -y waku-memory hook' })
    writeFileSync(deps.settingsPath, JSON.stringify(withOurs))
    writeFileSync(deps.codexHooksPath, '{ not valid json')

    const result = await disable(deps)

    assert.equal(result, 'refused')
    assert.deepEqual(JSON.parse(readFileSync(deps.settingsPath, 'utf8')), withOurs) // untouched
  })
})

// ---- disable(): the Codex MCP url comes from config.json, not deps.mcpUrl
// (fix round 2, re-review finding #2, controller ruling R9) -------------

test('disable: derives the Codex MCP url from config.json (the ingest base enable wrote), not deps.mcpUrl -- a non-default --url enable is still fully removed', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const customIngest = 'https://ingest.example.test'
    const customMcp = 'https://ingest.example.test/mcp'
    // deps.mcpUrl at enable time is the custom value dispatch() would have
    // computed from a real "--url https://ingest.example.test" (or its
    // "/mcp"-suffixed twin) -- see urlPair() in cli.ts.
    const enableDeps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']), mcpUrl: customMcp })
    await enable(customIngest, enableDeps)

    const config = JSON.parse(readFileSync(join(enableDeps.configDir, 'config.json'), 'utf8'))
    assert.equal(config.url, customIngest)
    assert.match(readFileSync(enableDeps.codexConfigPath, 'utf8'), new RegExp(`url = "${customMcp}"`))

    // "capture disable" takes no --url flag, so cli.ts's dispatch() always
    // builds deps.mcpUrl from DEFAULT_URL regardless of what enable() used --
    // reproduced here by handing disable() the same deps but mcpUrl reset to
    // the default. Before this fix, removeCodexToml compared the TOML's url
    // against this wrong default, never matched, and left the table in place
    // while still reporting success.
    const disableDeps = { ...enableDeps, mcpUrl: OUR_URL }
    const result = await disable(disableDeps)

    assert.equal(result, 'disabled')
    const toml = readFileSync(enableDeps.codexConfigPath, 'utf8')
    assert.doesNotMatch(toml, /\[mcp_servers\.waku\]/) // the table enable() wrote is actually gone
    const hooks = JSON.parse(readFileSync(enableDeps.codexHooksPath, 'utf8'))
    assert.equal('hooks' in hooks, false) // every group was ours -- the key itself is dropped
  })
})

test('disable: falls back to deps.mcpUrl when config.json is missing', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    await enable(OUR_INGEST_URL, deps)
    // config.json is the record disable() reads to recover the url enable()
    // actually used (see resolveDisableMcpUrl's comment in capture.ts) --
    // remove it to exercise the fallback path directly, rather than only
    // ever hitting it by accident whenever the default happens to match.
    rmSync(join(deps.configDir, 'config.json'))

    const result = await disable(deps)

    assert.equal(result, 'disabled')
    assert.doesNotMatch(readFileSync(deps.codexConfigPath, 'utf8'), /\[mcp_servers\.waku\]/)
  })
})

test('disable: prints one honest sentence per Codex file actually changed -- never claims the table was removed when it was not', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    await enable(OUR_INGEST_URL, deps)
    // Simulate the exact re-review scenario: the TOML's url no longer
    // matches anything disable() can derive (hand-edited, or a stale
    // config.json/deps.mcpUrl mismatch) -- removeCodexToml then leaves the
    // table in place, so the summary must not say it was removed.
    const toml = readFileSync(deps.codexConfigPath, 'utf8')
    writeFileSync(deps.codexConfigPath, toml.replace(OUR_URL, 'https://someone-else.example/mcp'))

    const out = await captureLog(() => disable(deps))

    assert.match(out, /removed the Codex hook entries from/)
    assert.doesNotMatch(out, /removed the Codex .*(table|MCP server entry|config\.toml)/)
    assert.match(readFileSync(deps.codexConfigPath, 'utf8'), /\[mcp_servers\.waku\]/) // still there
  })
})

// ---- status() (task 10, spec 012 §4.6, ruling R5) -------------------------

test('status: nothing configured anywhere prints "not configured" for the one detected harness, and "Key: none"', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true }) // detected, but never enabled
    const deps = makeDeps(dir)

    const out = await captureLog(() => status(deps))

    assert.match(out, /Claude Code: not configured/)
    assert.doesNotMatch(out, /Codex:/) // codexConfigPath does not exist -- not detected at all
    assert.match(out, /Key: none/)
  })
})

test('status: Claude Code hooks installed and a key stored', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    await enable('https://ingest.test', deps)

    const out = await captureLog(() => status(deps))

    assert.match(out, /Claude Code: hooks installed/)
    assert.ok(out.includes(deps.settingsPath))
    assert.match(out, /Key: stored/)
  })
})

test('status: Codex hooks installed (file) when the plugin is absent, and no Claude Code line when claudeDir does not exist', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y', 'mem_sk_abc', 'n']) })
    await enable(OUR_INGEST_URL, deps)

    const out = await captureLog(() => status(deps))

    assert.match(out, /Codex: hooks installed/)
    assert.ok(out.includes(deps.codexHooksPath))
    assert.doesNotMatch(out, /Claude Code:/)
    assert.match(out, /Key: stored/)
  })
})

test('status: Codex plugin route when the plugin is present', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(join(codexDir, 'config.toml'), `${CODEX_FIXTURE_TOML}\n[plugins."waku@personal"]\nenabled = true\n`, 'utf8')
    const deps = makeDeps(dir)

    const out = await captureLog(() => status(deps))

    assert.match(out, /Codex: plugin route/)
    assert.match(out, /Key: none/)
  })
})

test('status: reads only, writes nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildCodexFixture(dir)
    const deps = makeDeps(dir)

    await status(deps)

    assert.equal(existsSync(deps.settingsPath), false)
    assert.equal(existsSync(deps.codexHooksPath), false)
    assert.equal(existsSync(deps.marketplacePath), false)
    assert.equal(existsSync(join(deps.configDir, 'config.json')), false)
  })
})

// ---- enable(): the real node:readline wiring, not the injected fake -----
//
// Every test above drives capture.ts directly with an injected `prompt` --
// deliberately, so none of it ever touches real stdin. That is exactly why
// a real bug in cli.ts's *real* prompt wiring shipped past this whole file
// and was only caught by hand, against the compiled binary, with piped
// stdin: a fresh readline.Interface per question -- and, it turned out,
// even one shared interface driven by two sequential .question() calls --
// can lose the second answer when both lines arrive in the same piped
// stdin chunk. readline's 'line' event fires the instant a full line is
// parsed out of whatever is currently buffered, with no listener to catch
// it unless a .question() call is already pending at that exact moment; a
// piped writer that has already closed by the time either question is
// asked can easily deliver both lines in one chunk, and the second one is
// simply gone. The fix (cli.ts's runCaptureCommand) grabs the interface's
// async iterator once, up front, so a consumer is already waiting before
// either question is asked and no line can be dropped between one answer
// and the next question being issued.
//
// These two tests spawn the real entry point (src/index.ts -- Node runs it
// directly, no separate build step needed, confirmed by hand before this
// was written) with genuine piped stdin, so they exercise the actual
// readline path the rest of this file cannot reach. Slow relative to the
// rest of the suite (real process spawn) and deliberately only two: enough
// to prove the multi-line race is closed (task 13, spec 012 §7, added a
// third piped line -- the Sign-in choice -- ahead of the key, so this is no
// longer only a two-line race, but the same race all the same: every answer
// arrives in one piped chunk, before any question has been asked) and that
// declining still works end to end, not a parallel copy of every case
// above.
//
// Task 11 (spec 011 A10) changed what a successful `enable` does: it now
// copies the shim's own dist/*.js into configDir/hook/<version> and runs
// that copy once (verifyHook) before trusting it. Spawned straight from
// source with no build step, cli.ts's real hookSourceDir -- its own
// directory, which is src/ here -- holds no compiled .js to copy, so the
// installed copy is empty and the real verifyHook correctly refuses to
// trust it. The first test below asserts a refusal rather than 'enabled',
// and proves the readline race is still closed a different way: the key
// prompt appears exactly once (a dropped second line would retry it) and
// the run visibly gets far enough to sanitize "spawned-real-key" itself
// (the mem_sk_ warning names it indirectly), which a lost or glued second
// line could not produce.
//
// B1 (spec 024 §2) moved the refusal earlier: enable() now posts consent
// before it ever reaches installHookCopy, so the empty hookSourceDir above
// is no longer what this run actually refuses on -- the consent POST is.
// Real fetchImpl, real network stack here (this is the genuine spawned CLI,
// not a test double), so an unreachable --url (a loopback port nothing
// listens on) is what keeps this hermetic: the connection is refused
// immediately, with no DNS lookup and no dependency on a real server's
// live behaviour, and enable() still refuses for the same reason a person
// offline would -- "nothing was installed" either way.

const ENTRY_POINT = fileURLToPath(new URL('./index.ts', import.meta.url))

// HOME covers os.homedir() on POSIX, USERPROFILE on Windows (this repo's
// own machine) -- setting both makes the spawned process pick up `home`
// regardless of which platform the suite runs on, same as the real
// realCaptureDeps() in cli.ts would resolve it.
function runCliSpawn(args, input, home, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY_POINT, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    // A broken future implementation could hang (rather than the actual
    // bug's silent exit-0) -- e.g. a readline interface waiting on a
    // listener that never attaches. Without this, that would hang the
    // whole suite rather than failing this one test with a clear reason,
    // and would leave an orphaned node process behind.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`runCliSpawn: "${args.join(' ')}" did not exit within ${timeoutMs}ms -- killed.`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

test(
  'enable (spawned, real readline): every piped answer is read -- the exact race the fix closed',
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      mkdirSync(join(dir, '.claude'), { recursive: true })

      // Three lines now, not two (task 13, spec 012 §7): the real CLI's
      // default credential is { kind: 'ask' }, which inserts the Sign-in
      // choice between the disclosure and the key prompt -- "2" picks
      // "paste a key" so the rest of this test (unchanged from before that
      // question existed) still exercises askForKey end to end. All three
      // are written in one chunk, same as the original two-line race this
      // test pins. --url points at a loopback port nothing listens on (B1,
      // see this block's header comment) so the consent POST enable() now
      // makes first fails fast and locally, never touching a real server.
      const { code, stdout, stderr } = await runCliSpawn(
        ['capture', 'enable', '--url', 'http://127.0.0.1:1'],
        'y\n2\nspawned-real-key\n',
        dir,
      )

      // The key prompt printed exactly once -- a lost or glued second line
      // would have askForKey retry it -- and the run got far enough to
      // sanitize "spawned-real-key" itself (the mem_sk_ warning names it
      // indirectly; the key is never printed). Both together are only
      // possible if the second piped line reached askForKey intact.
      const keyPromptCount = stdout.split('Paste an API key from').length - 1
      assert.equal(keyPromptCount, 1, `expected the key prompt exactly once -- stdout:\n${stdout}`)
      assert.match(stdout, /does not start with mem_sk_/i)
      // What happens next is a real, correct refusal, not a bug: see this
      // block's header comment -- B1 moved it to the consent POST, refused
      // by the unreachable --url above rather than by hookSourceDir being
      // empty. This is not proof a copy can ever succeed -- the A10
      // "really runs" unit test above (a live spawnSync verify) is what
      // proves that.
      assert.equal(code, 1, `expected a refusal, not a hang or silent exit -- stdout:\n${stdout}\nstderr:\n${stderr}`)
      assert.match(stderr, /capture not enabled/i)
      assert.match(stderr, /nothing was installed/i)
      assert.equal(existsSync(join(dir, '.waku-memory', 'config.json')), false)
      assert.equal(existsSync(join(dir, '.claude', 'settings.json')), false)
      // installHookCopy never even ran -- the consent POST refused first.
      assert.equal(existsSync(join(dir, '.waku-memory', 'hook')), false)
    })
  },
)

test(
  'enable (spawned, real readline): declining at the first prompt writes nothing',
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      mkdirSync(join(dir, '.claude'), { recursive: true })

      const { code } = await runCliSpawn(['capture', 'enable'], 'n\n', dir)

      assert.equal(code, 0)
      assert.equal(existsSync(join(dir, '.waku-memory')), false)
      assert.equal(existsSync(join(dir, '.claude', 'settings.json')), false)
    })
  },
)

// ---- B1: capture enable/disable post consent to the door ------------------

test('B1: enable posts consent for Claude Code, with the key, before settings.json is written', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, '{}')
    const fetchImpl = fakeFetch(202)
    let settingsWrittenAtCall = -1
    const result = await enable(OUR_INGEST_URL, {
      ...deps,
      fetchImpl,
      writeSettingsJson: (path, data) => {
        settingsWrittenAtCall = fetchImpl.calls.length
        atomicWriteJson(path, data)
      },
    })
    assert.equal(result, 'enabled')
    const consent = fetchImpl.calls.filter((c) => c.url.endsWith('/capture/claude_code'))
    assert.equal(consent.length, 1)
    assert.equal(consent[0].method, 'PUT')
    assert.deepEqual(consent[0].body, { enabled: true })
    assert.equal(consent[0].headers.Authorization, 'Bearer pasted-test-key')
    assert.ok(settingsWrittenAtCall >= 1, 'the consent post happened before settings.json was written')
  })
})

test('B1: a failed consent post stops enable before anything is installed', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, '{}')
    const fetchImpl = fakeFetch(202, { '/capture/claude_code': 500 })
    const output = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, { ...deps, fetchImpl })
      assert.equal(result, 'refused')
    })
    assert.match(output, /\/capture\/claude_code responded 500/)
    assert.deepEqual(JSON.parse(readFileSync(deps.settingsPath, 'utf8')), {})
    assert.equal(existsSync(join(deps.configDir, 'hook')), false)
  })
})

test('B1: enable posts consent for Codex too on a machine that wires it', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, '{}')
    buildCodexFixture(dir)
    const fetchImpl = fakeFetch(202)
    await enable(OUR_INGEST_URL, { ...deps, fetchImpl, prompt: fakePrompt(['y', 'pasted-test-key', 'n']) })
    const paths = fetchImpl.calls.map((c) => new URL(c.url).pathname).filter((p) => p.startsWith('/capture/'))
    assert.deepEqual(paths.sort(), ['/capture/claude_code', '/capture/codex'])
  })
})

test('B1: disable posts enabled:false for each detected harness when a key is stored', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, '{}')
    const fetchImpl = fakeFetch(202)
    await enable(OUR_INGEST_URL, { ...deps, fetchImpl })
    const before = fetchImpl.calls.length
    await disable({ ...deps, fetchImpl })
    const posts = fetchImpl.calls.slice(before).filter((c) => c.url.endsWith('/capture/claude_code'))
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body, { enabled: false })
  })
})

test('final: disable posts enabled:false on a plugin machine where nothing local was installed', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, JSON.stringify({ enabledPlugins: { 'waku@waku-memory': true } }))
    const fetchImpl = fakeFetch(202)
    await enable(OUR_INGEST_URL, { ...deps, fetchImpl })
    const before = fetchImpl.calls.length
    const output = await captureLog(async () => {
      const result = await disable({ ...deps, fetchImpl })
      assert.equal(result, 'nothing-to-disable')
    })
    const posts = fetchImpl.calls.slice(before).filter((c) => c.url.endsWith('/capture/claude_code'))
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0].body, { enabled: false })
    assert.match(output, /Capture turned off on the server for Claude Code/)
  })
})

// ---- B2: the shim yields to the Claude Code plugin -------------------------

test('B2: claudePluginPresent reads enabledPlugins, then the plugin cache', () => {
  const { claudePluginPresent } = captureModule
  const io = { existsSync: () => false }
  assert.equal(claudePluginPresent({}, '/nowhere', io), false)
  assert.equal(claudePluginPresent({ enabledPlugins: { 'waku@waku-memory': true } }, '/nowhere', io), true)
  assert.equal(claudePluginPresent({ enabledPlugins: { 'waku@waku-memory': false } }, '/nowhere', io), false)
  assert.equal(claudePluginPresent({ enabledPlugins: { 'other@x': true } }, '/nowhere', io), false)
  const cached = { existsSync: (p) => p.replace(/\\/g, '/').endsWith('/cache/waku-memory/waku') }
  assert.equal(claudePluginPresent({}, '/home/.claude/plugins/cache', cached), true)
})

test('B2: enable writes no hook entries for Claude Code when the plugin is installed, and says so', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, JSON.stringify({ enabledPlugins: { 'waku@waku-memory': true } }))
    const fetchImpl = fakeFetch(202)
    const output = await captureLog(async () => {
      assert.equal(await enable(OUR_INGEST_URL, { ...deps, fetchImpl }), 'enabled')
    })
    assert.match(output, /The Waku plugin carries the hooks and the MCP server for Claude Code; enable adds login and the history import/)
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.equal(settings.hooks, undefined)
    assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith('/capture/claude_code')).length, 1)
    assert.equal(existsSync(join(deps.configDir, 'config.json')), true)
  })
})

test('B2: status names the Claude Code plugin route', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, JSON.stringify({ enabledPlugins: { 'waku@waku-memory': true } }))
    const output = await captureLog(() => status(deps))
    assert.match(output, /Claude Code: the Waku plugin is installed/)
    // final review, minor: "not configured" reads as nothing capturing here,
    // which is wrong on a plugin-route machine -- the plugin's own hooks are
    // installed, just not by this tool.
    assert.match(output, /Claude Code: no CLI hook entries installed \(the plugin carries them\)\./)
    assert.doesNotMatch(output, /Claude Code: not configured/)
  })
})

// ---- spec 068 D3: import and full record ----------------------------------
//
// `import` is enable()'s step 10 alone; `full-record on|off|status` is
// capture enable/disable/status without the switch and without the import.
// The tests below pin the two promises D3 makes: import never installs a
// hook, and full-record on never runs the import and never writes the
// "Auto-save from conversations" switch (no PUT /capture/<harness>). The
// alias tests above stay as they were: capture enable still does both.

// Answers GET /capture with the given rows and everything else with 202,
// recording each call the way fakeFetch does.
function fakeFetchWithSwitches(rows) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    if (new URL(url).pathname === '/capture' && init.method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ harnesses: rows, disclosure: '' }) }
    }
    return { ok: true, status: 202, json: async () => ({}) }
  }
  impl.calls = calls
  return impl
}

const putsTo = (fetchImpl) => fetchImpl.calls.filter((c) => c.method === 'PUT')

test('import: sends what the scan found and installs no hook, writing no settings.json and no hook copy', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt(['']) // Enter at "> " imports all of it
    const deps = makeDeps(dir, { prompt, fetchImpl })

    let result
    const out = await captureLog(async () => {
      result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_import' })
    })

    assert.equal(result, 'imported')
    assert.deepEqual(prompt.questions, ['> '])
    assert.match(out, /Found memory and history from Claude Code on this machine/)
    assert.match(out, /www\.waku\.one\/privacy names them/) // the list carries the import's disclosure
    assert.match(out, /\d+ memory files? queued, \d+ sessions? queued in \d+ pieces?/)
    assert.ok(fetchImpl.calls.length > 0)
    assert.equal(putsTo(fetchImpl).length, 0) // never touches the switch
    assert.equal(fetchImpl.calls.filter((c) => new URL(c.url).pathname.startsWith('/capture')).length, 0)
    assert.equal(existsSync(deps.settingsPath), false) // no hook entry
    assert.equal(existsSync(join(deps.configDir, 'hook')), false) // no hook copy
    assert.equal(JSON.parse(readFileSync(join(deps.configDir, 'config.json'), 'utf8')).key, 'mem_sk_import')
  })
})

test('import: a Codex machine without the plugin gets no hooks.json, no TOML table and no marketplace entry', async () => {
  await withDir(async (dir) => {
    const { configPath } = buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt([]) })
    const result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_import' })
    assert.equal(result, 'nothing')
    assert.equal(readFileSync(configPath, 'utf8'), CODEX_FIXTURE_TOML)
    assert.equal(existsSync(deps.codexHooksPath), false)
    assert.equal(existsSync(deps.marketplacePath), false)
  })
})

test('import: nothing found asks nothing and needs no credential', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const fetchImpl = fakeFetch(202)
    // fakePrompt([]) throws on any question; makeDeps's default login throws too.
    const deps = makeDeps(dir, { prompt: fakePrompt([]), fetchImpl })

    let result
    const out = await captureLog(async () => {
      result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'ask' })
    })

    assert.equal(result, 'nothing')
    assert.match(out, /Nothing from Claude Code to import on this machine\./)
    assert.equal(fetchImpl.calls.length, 0)
    assert.equal(existsSync(join(deps.configDir, 'config.json')), false)
  })
})

test('import: "n" skips before any credential is asked for, and sends nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt(['n'])
    const deps = makeDeps(dir, { prompt, fetchImpl })

    let result
    const out = await captureLog(async () => {
      result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'ask' })
    })

    assert.equal(result, 'skipped')
    assert.deepEqual(prompt.questions, ['> '])
    assert.match(out, /Nothing was imported\./)
    assert.equal(fetchImpl.calls.length, 0)
    assert.equal(existsSync(join(deps.configDir, 'config.json')), false)
  })
})

test('import: credential ask with a stored key asks no sign-in question and leaves config.json as it was', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const configDir = join(dir, '.waku-memory')
    writeConfigJson(configDir, { url: 'https://stored.test', key: 'mem_sk_stored' })
    const before = readFileSync(join(configDir, 'config.json'), 'utf8')
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt([''])
    const deps = makeDeps(dir, { prompt, fetchImpl })

    const result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'ask' })

    assert.equal(result, 'imported')
    assert.deepEqual(prompt.questions, ['> '])
    assert.equal(readFileSync(join(configDir, 'config.json'), 'utf8'), before)
    assert.ok(fetchImpl.calls.every((c) => c.headers.Authorization === 'Bearer mem_sk_stored'))
  })
})

test('import: a declined sign-in says nothing was imported, without the word "capture"', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const configDir = join(dir, '.waku-memory')
    const deps = makeDeps(dir, { prompt: fakePrompt(['']), fetchImpl, login: fakeLogin('timeout', configDir) })

    let result
    const out = await captureLog(async () => {
      result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'login' })
    })

    assert.equal(result, 'declined')
    assert.match(out, /Nothing was imported -- sign-in did not complete; nothing was written\./)
    assert.doesNotMatch(out, /[Cc]apture/)
    assert.equal(fetchImpl.calls.length, 0)
  })
})

// ---- 2026-11-20: nobody answering imports nothing --------------------------
//
// An agent runs `npx -y waku-memory import` with no terminal. Until this
// date its empty read counted as Enter and imported everything. Now nothing
// is sent until the person's choice comes back through --answer, with the
// list id of the list the person saw (--list).

const importSends = (fetchImpl) => fetchImpl.calls.filter((c) => !new URL(c.url).pathname.startsWith('/capture'))
const sessionIdsSent = (fetchImpl) =>
  [...new Set(fetchImpl.calls.filter((c) => new URL(c.url).pathname === '/ingest/session').map((c) => c.body.session_id))].sort()
const printedListId = (out) => {
  const match = /^List id: (L[0-9a-f]{8}-[0-9a-z]+)$/m.exec(out)
  assert.ok(match, `no list id in:\n${out}`)
  return match[1]
}

// One session in a Claude Code project, a day old so the scan lists it. A
// second call with the same slug adds a session to the same project. A
// longer `text` makes a bigger project, which the list puts first.
function addProject(claudeDir, slug, sessionId, text) {
  const slugDir = join(claudeDir, 'projects', slug)
  mkdirSync(slugDir, { recursive: true })
  const cwd = join(claudeDir, `${slug}-cwd`)
  mkdirSync(cwd, { recursive: true })
  const lines =
    JSON.stringify({ type: 'user', cwd, message: { content: text } }) +
    '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Noted.' }] } }) +
    '\n'
  const path = join(slugDir, `${sessionId}.jsonl`)
  writeFileSync(path, lines, 'utf8')
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  utimesSync(path, oneDayAgo, oneDayAgo)
}

// Runs import the way an agent does: no terminal, and the given flags.
async function agentImport(dir, { answer, list, windowDays = 180 } = {}) {
  const fetchImpl = fakeFetch(202)
  const deps = makeDeps(dir, {
    prompt: fakePrompt([]),
    fetchImpl,
    answerable: () => false,
    bootstrap: { windowDays, enabled: true, ...(answer !== undefined && { answer }), ...(list !== undefined && { list }) },
  })
  let result
  const out = await captureLog(async () => {
    result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_import' })
  })
  return { result, out, fetchImpl, deps }
}

test('import: with no terminal, it prints the list, its id and what to run, writes nothing and sends nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const { result, out, fetchImpl, deps } = await agentImport(dir)
    const id = printedListId(out)

    assert.equal(result, 'unanswered')
    assert.match(out, /Found memory and history from Claude Code on this machine/)
    assert.match(out, /^Nothing was imported, because nobody typed an answer\.$/m)
    assert.match(out, /^Show the person the list above\.$/m)
    assert.match(out, /^Ask them whether to import all of it, none of it, or all except some of the numbered projects\.$/m)
    assert.ok(out.includes(`\nThen run the same command again with --list ${id} and one of these answers:\n`), out)
    assert.match(out, /^ {2}--answer all {2}imports everything on the list\.$/m)
    assert.match(out, /^ {2}--answer n {4}imports nothing\.$/m)
    assert.match(out, /^ {2}--answer 1 {4}imports everything except project 1\.$/m)
    assert.equal(fetchImpl.calls.length, 0)
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('import: input that closes at "> " is nobody answering, not Enter, and sends nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    // A terminal whose input closes (Ctrl-D): the read returns '' and the
    // terminal can no longer answer -- what withTerminalPrompt reports.
    let closed = false
    const prompt = async (question) => {
      assert.equal(question, '> ')
      closed = true
      return ''
    }
    const deps = makeDeps(dir, { prompt, fetchImpl, answerable: () => !closed })

    let result
    const out = await captureLog(async () => {
      result = await captureModule.importHistory(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_import' })
    })

    assert.equal(result, 'unanswered')
    assert.match(out, /Nothing was imported, because nobody typed an answer\./)
    assert.equal(fetchImpl.calls.length, 0)
  })
})

test('import: an unchanged list with its id -- --answer all sends everything', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const list = printedListId((await agentImport(dir)).out)
    const { result, out, fetchImpl } = await agentImport(dir, { answer: 'all', list })

    assert.equal(result, 'imported')
    assert.match(out, /1 sessions? queued in \d+ pieces?/)
    assert.deepEqual(sessionIdsSent(fetchImpl), ['sess-demo'])
  })
})

test('import: an unchanged list with its id -- a number leaves out exactly that project', async () => {
  await withDir(async (dir) => {
    const claudeDir = join(dir, '.claude')
    addProject(claudeDir, 'slug-big', 'sess-big', 'Remember this. '.repeat(50))
    addProject(claudeDir, 'slug-small', 'sess-small', 'Short.')
    const first = await agentImport(dir)
    assert.match(first.out, /^ {2}1\. slug-big-cwd/m)
    assert.match(first.out, /^ {2}2\. slug-small-cwd/m)

    const { result, fetchImpl } = await agentImport(dir, { answer: '1', list: printedListId(first.out) })
    assert.equal(result, 'imported')
    assert.deepEqual(sessionIdsSent(fetchImpl), ['sess-small'])
  })
})

test('import: another run in between, on a different list, does not change what an answer with a matching id sends', async () => {
  await withDir(async (dir) => {
    const claudeDir = join(dir, '.claude')
    addProject(claudeDir, 'slug-big', 'sess-big', 'Remember this. '.repeat(50))
    addProject(claudeDir, 'slug-small', 'sess-small', 'Short.')
    const list = printedListId((await agentImport(dir)).out)
    // A second agent lists a different window, so a different list.
    const other = printedListId((await agentImport(dir, { windowDays: null })).out)
    assert.notEqual(other, list)

    const { result, fetchImpl } = await agentImport(dir, { answer: '1', list })
    assert.equal(result, 'imported')
    assert.deepEqual(sessionIdsSent(fetchImpl), ['sess-small'])
  })
})

test('import: a new session inside a listed project changes the id, and the answer is refused', async () => {
  await withDir(async (dir) => {
    const claudeDir = join(dir, '.claude')
    addProject(claudeDir, 'slug-a', 'sess-a1', 'One.')
    const list = printedListId((await agentImport(dir)).out)
    addProject(claudeDir, 'slug-a', 'sess-a2', 'Two.')

    const refused = await agentImport(dir, { answer: 'all', list })
    assert.equal(refused.result, 'list-changed')
    assert.equal(refused.fetchImpl.calls.length, 0)
    assert.notEqual(printedListId(refused.out), list)
    assert.match(refused.out, /^Nothing was imported, because the list changed since the person saw it\.$/m)
  })
})

test('import: a bigger project added between the runs is refused as a changed list, even for a number out of range', async () => {
  await withDir(async (dir) => {
    const claudeDir = join(dir, '.claude')
    addProject(claudeDir, 'slug-small', 'sess-small', 'Short.')
    const list = printedListId((await agentImport(dir)).out)
    addProject(claudeDir, 'slug-big', 'sess-big', 'Remember this. '.repeat(50))

    for (const answer of ['1', '5']) {
      const refused = await agentImport(dir, { answer, list })
      assert.equal(refused.result, 'list-changed', answer)
      assert.equal(refused.fetchImpl.calls.length, 0, answer)
      const id = printedListId(refused.out)
      assert.match(refused.out, /^ {2}1\. slug-big-cwd/m)
      assert.match(refused.out, /^Nothing was imported, because the list changed since the person saw it\.$/m)
      assert.match(refused.out, /^Show the person the new list above\.$/m)
      assert.match(refused.out, /^Ask them again whether to import all of it, none of it, or all except some of the numbered projects\.$/m)
      assert.ok(refused.out.includes(`Then run the same command again with --list ${id} and one of these answers:`), answer)
      assert.match(refused.out, /^ {2}--answer "1 2" {2}imports everything except projects 1 and 2\.$/m)
    }
  })
})

test('import: an --answer without --list is refused, all included, and sends nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const { result, out, fetchImpl, deps } = await agentImport(dir, { answer: 'all' })

    assert.equal(result, 'list-changed')
    assert.equal(fetchImpl.calls.length, 0)
    assert.match(out, /^Nothing was imported, because the command has no --list\.$/m)
    assert.match(out, /^Ask them whether to import all of it, none of it, or all except some of the numbered projects\.$/m)
    assert.ok(out.includes(`--list ${printedListId(out)} and one of these answers:`))
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('import: --answer n needs no --list and sends nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    for (const answer of ['n', 'N']) {
      const { result, fetchImpl } = await agentImport(dir, { answer })
      assert.equal(result, 'skipped', answer)
      assert.equal(fetchImpl.calls.length, 0, answer)
    }
  })
})

test('import: an --answer that does not fit the list it names sends nothing and says what fits', async () => {
  for (const answer of ['9', 'yes', '   ']) {
    await withDir(async (dir) => {
      mkdirSync(join(dir, '.claude'), { recursive: true })
      buildClaudeCodeFixture(join(dir, '.claude'))
      const list = printedListId((await agentImport(dir)).out)
      const { result, out, fetchImpl } = await agentImport(dir, { answer, list })
      assert.equal(result, 'bad-answer', answer)
      assert.ok(out.includes(`Nothing was imported, because --answer "${answer}" is not all, n, or 1.`), out)
      assert.equal(fetchImpl.calls.length, 0, answer)
    })
  }
})

// Runs fn with Date.now() fixed at `ms`, the clock importScan reads.
async function atTime(ms, fn) {
  const realNow = Date.now
  Date.now = () => ms
  try {
    return await fn()
  } finally {
    Date.now = realNow
  }
}

test('import: a session that crosses the ten-minute live mark between the runs does not change the list id', async () => {
  await withDir(async (dir) => {
    const claudeDir = join(dir, '.claude')
    addProject(claudeDir, 'slug-old', 'sess-old', 'Old.')
    const t0 = Math.floor(Date.now() / 60_000) * 60_000 + 5_000
    // Nine minutes old at the first run: still live, so not listed.
    addProject(claudeDir, 'slug-recent', 'sess-recent', 'Recent.')
    const recent = join(claudeDir, 'projects', 'slug-recent', 'sess-recent.jsonl')
    utimesSync(recent, new Date(t0 - 9 * 60_000), new Date(t0 - 9 * 60_000))

    const first = await atTime(t0, () => agentImport(dir))
    assert.doesNotMatch(first.out, /slug-recent-cwd/)
    const list = printedListId(first.out)

    // Three minutes later the session is twelve minutes old. A fresh scan lists it.
    const later = t0 + 3 * 60_000
    const fresh = await atTime(later, () => agentImport(dir))
    assert.match(fresh.out, /slug-recent-cwd/)
    assert.notEqual(printedListId(fresh.out), list)

    // The answer with the first run's id still fits, and sends what that list showed.
    const { result, fetchImpl } = await atTime(later, () => agentImport(dir, { answer: 'all', list }))
    assert.equal(result, 'imported')
    assert.deepEqual(sessionIdsSent(fetchImpl), ['sess-old'])
  })
})

test('import: a list id from the future, older than a day, or malformed is a changed list', async () => {
  const now = Math.floor(Date.now() / 60_000) * 60_000
  const id = (ms) => `L0123abcd-${(ms / 60_000).toString(36)}`
  assert.equal(captureModule.anchorFromListId(id(now - 5 * 60_000), now), now - 5 * 60_000)
  assert.equal(captureModule.anchorFromListId(id(now - 5 * 60_000).toLowerCase(), now), now - 5 * 60_000)
  assert.equal(captureModule.anchorFromListId(id(now + 60_000), now), null)
  assert.equal(captureModule.anchorFromListId(id(now - 25 * 60 * 60_000), now), null)
  for (const bad of ['0123abcd', 'L0123abcd', 'L0123abc-x1', 'Lzzzzzzzz-x1', '']) {
    assert.equal(captureModule.anchorFromListId(bad, now), null, bad)
  }

  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const list = printedListId((await agentImport(dir)).out)
    // The same hash with a minute ten minutes ahead.
    const [hash, minute] = list.split('-')
    const forged = `${hash}-${(Number.parseInt(minute, 36) + 10).toString(36)}`
    const refused = await agentImport(dir, { answer: 'all', list: forged })
    assert.equal(refused.result, 'list-changed')
    assert.equal(refused.fetchImpl.calls.length, 0)
  })
})

test('import: the list id starts with a letter, so no shell reads it as a number', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    assert.match(printedListId((await agentImport(dir)).out), /^L[0-9a-f]{8}-[0-9a-z]+$/)
  })
})

test('import: a machine with only skills asks, prints a list id, and sends the skills on --answer all', async () => {
  await withDir(async (dir) => {
    const claudeDir = join(dir, '.claude')
    mkdirSync(join(claudeDir, 'skills', 'my-skill'), { recursive: true })
    writeFileSync(join(claudeDir, 'skills', 'my-skill', 'SKILL.md'), '# mine\n')

    const first = await agentImport(dir)
    assert.equal(first.result, 'unanswered')
    assert.match(first.out, /1 skill \(1 Claude Code\)/)
    assert.match(first.out, /^Ask them whether to import all of it or none of it\.$/m)

    const { result, fetchImpl } = await agentImport(dir, { answer: 'all', list: printedListId(first.out) })
    assert.equal(result, 'imported')
    const sources = fetchImpl.calls
      .filter((c) => new URL(c.url).pathname === '/imports')
      .flatMap((c) => c.body.files.map((f) => f.source))
    assert.deepEqual(sources, ['skill:claude_code/my-skill'])
  })
})

test('the import messages name the numbers only when the list has projects, and carry the list id', () => {
  assert.doesNotMatch(captureModule.unansweredMessage(0, 'abcd1234'), /except/)
  assert.match(captureModule.unansweredMessage(0, 'abcd1234'), /^Ask them whether to import all of it or none of it\.$/m)
  assert.match(captureModule.unansweredMessage(0, 'abcd1234'), /^Then run the same command again with --list abcd1234 and one of these answers:$/m)
  assert.match(captureModule.unansweredMessage(4, 'abcd1234'), /--answer "1 2" {2}imports everything except projects 1 and 2\./)
  assert.match(captureModule.listChangedMessage(0, 'abcd1234', false), /^Ask them again whether to import all of it or none of it\.$/m)
  assert.equal(captureModule.badAnswerMessage('x', 0), 'Nothing was imported, because --answer "x" is not all or n.')
  assert.equal(
    captureModule.badAnswerMessage('x', 4),
    'Nothing was imported, because --answer "x" is not all, n, or project numbers from 1 to 4.',
  )
})

test('enable: with no terminal, the import step sends nothing and capture is still enabled', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    // The first two answers stand in for a script that piped them; "> " is
    // never asked, because nobody can answer it.
    let asked = 0
    const prompt = async (question) => {
      asked++
      assert.notEqual(question, '> ')
      return ['y', 'mem_sk_abc'][asked - 1]
    }
    const deps = makeDeps(dir, { prompt, fetchImpl, answerable: () => false })

    let result
    const out = await captureLog(async () => {
      result = await enable('https://ingest.test', deps)
    })

    assert.equal(result, 'enabled')
    assert.match(out, /Nothing was imported, because nobody typed an answer\./)
    assert.equal(importSends(fetchImpl).length, 0)
  })
})

test('enable: a bad answer, a missing --list or another list\'s id ends before the disclosure and writes nothing', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const list = printedListId((await agentImport(dir)).out)
    for (const [bootstrapFlags, message] of [
      [{ answer: '9', list }, /--answer "9" is not all, n, or 1\./],
      [{ answer: 'all' }, /because the command has no --list\./],
      [{ answer: 'all', list: '00000000' }, /because the list changed since the person saw it\./],
    ]) {
      const fetchImpl = fakeFetch(202)
      const deps = makeDeps(dir, {
        prompt: fakePrompt([]), // the disclosure is never shown
        fetchImpl,
        answerable: () => false,
        bootstrap: { windowDays: 180, enabled: true, ...bootstrapFlags },
      })

      let result
      const out = await captureLog(async () => {
        result = await enable('https://ingest.test', deps)
      })

      assert.equal(result, 'bad-answer', JSON.stringify(bootstrapFlags))
      assert.match(out, /Found memory and history from Claude Code on this machine/)
      assert.match(out, message)
      assert.equal(fetchImpl.calls.length, 0) // not even the consent call
      assert.equal(existsSync(deps.settingsPath), false)
      assert.equal(existsSync(deps.configDir), false)
    }
  })
})

test('import (spawned): piped stdin is not a terminal, so even a piped Enter sends nothing', { timeout: 20_000 }, async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    // --url points at a port nothing listens on: a send would fail loudly
    // rather than reach a real server.
    const { code, stdout } = await runCliSpawn(['import', '--url', 'http://127.0.0.1:1'], '\n', dir)
    assert.equal(code, 0)
    assert.match(stdout, /Nothing was imported, because nobody typed an answer\./)
    printedListId(stdout)
    assert.doesNotMatch(stdout, /queued/)
    assert.equal(existsSync(join(dir, '.waku-memory')), false)
  })
})

test('import (spawned): no --list, or an answer that does not fit, exits 1 and sends nothing', { timeout: 20_000 }, async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const url = ['--url', 'http://127.0.0.1:1']
    const unlisted = await runCliSpawn(['import', ...url, '--answer', 'all'], '', dir)
    assert.equal(unlisted.code, 1)
    assert.match(unlisted.stdout, /because the command has no --list\./)
    const list = printedListId(unlisted.stdout)
    const bad = await runCliSpawn(['import', ...url, '--list', list, '--answer', '7'], '', dir)
    assert.equal(bad.code, 1)
    assert.match(bad.stdout, /--answer "7" is not all, n, or 1\./)
    assert.equal(existsSync(join(dir, '.waku-memory')), false)
  })
})

test('capture enable (spawned): another list\'s id exits 1 and creates no ~/.waku-memory', { timeout: 20_000 }, async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const { code, stdout } = await runCliSpawn(
      ['capture', 'enable', '--url', 'http://127.0.0.1:1', '--list', '00000000', '--answer', 'all'],
      'y\n',
      dir,
    )
    assert.equal(code, 1)
    assert.match(stdout, /because the list changed since the person saw it\./)
    assert.equal(existsSync(join(dir, '.waku-memory')), false)
    assert.equal(existsSync(join(dir, '.claude', 'settings.json')), false)
  })
})

test('full-record on: installs the hook, never asks the import question, and never PUTs the switch', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude')) // something to import, so a stray "> " would be asked
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt, fetchImpl })

    let result
    const out = await captureLog(async () => {
      result = await enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_full' }, 'full-record')
    })

    assert.equal(result, 'enabled')
    assert.deepEqual(prompt.questions, ['Type "y" to continue, anything else to cancel: ']) // no "> "
    assert.equal(putsTo(fetchImpl).length, 0)
    assert.equal(fetchImpl.calls.filter((c) => c.method !== 'GET').length, 0) // no import sends either
    assert.equal(existsSync(join(deps.configDir, 'state')), false) // the import never ran
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.ok(settings.hooks.Stop.length > 0)
    assert.match(out, /^Full record sends the whole session/m)
    assert.match(out, /Full record is on -- wrote /)
    assert.doesNotMatch(out, /Found memory and history/)
    assert.doesNotMatch(out.replaceAll(dir, '<dir>'), /[Cc]apture/) // the temp dir's own name says "capture"
  })
})

test('full-record on: deps.bootstrap.enabled is ignored -- the import never runs', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const prompt = fakePrompt(['y'])
    const deps = makeDeps(dir, { prompt, bootstrap: { windowDays: null, enabled: true } })
    await captureLog(() => enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_full' }, 'full-record'))
    assert.equal(prompt.questions.length, 1)
  })
})

test('full-record on: a non-y answer writes nothing and says full record is not on', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const deps = makeDeps(dir, { prompt: fakePrompt(['n']) })
    let result
    const out = await captureLog(async () => {
      result = await enable(OUR_INGEST_URL, deps, { kind: 'ask' }, 'full-record')
    })
    assert.equal(result, 'declined')
    assert.match(out, /Full record is not on -- nothing was written\./)
    assert.equal(existsSync(deps.settingsPath), false)
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('full-record on: installs the Claude Code hook beside the plugin instead of yielding to it (spec 068 D4)', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir, { prompt: fakePrompt(['y']) })
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, JSON.stringify({ enabledPlugins: { 'waku@waku-memory': true } }))
    const fetchImpl = fakeFetch(202)

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, { ...deps, fetchImpl }, { kind: 'key', key: 'mem_sk_full' }, 'full-record')
      assert.equal(result, 'enabled')
    })

    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.deepEqual(settings.enabledPlugins, { 'waku@waku-memory': true })
    assert.ok(settings.hooks.Stop.length > 0)
    assert.doesNotMatch(out, /The Waku plugin carries the hooks/)
    assert.match(out, /The Waku plugin stays installed\./)
    assert.equal(putsTo(fetchImpl).length, 0)
  })
})

test('full-record on: on a Codex plugin machine, writes hooks.json but no TOML table and no marketplace entry', async () => {
  await withDir(async (dir) => {
    const codexDir = join(dir, '.codex')
    mkdirSync(codexDir, { recursive: true })
    const configPath = join(codexDir, 'config.toml')
    const withPlugin = `${CODEX_FIXTURE_TOML}\n[plugins."waku@personal"]\nenabled = true\n`
    writeFileSync(configPath, withPlugin, 'utf8')
    const fetchImpl = fakeFetch(202)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y']), fetchImpl })

    const out = await captureLog(async () => {
      const result = await enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_full' }, 'full-record')
      assert.equal(result, 'enabled')
    })

    assert.equal(readFileSync(configPath, 'utf8'), withPlugin) // the plugin's MCP server still wins
    assert.equal(existsSync(deps.marketplacePath), false)
    const hooks = JSON.parse(readFileSync(deps.codexHooksPath, 'utf8'))
    assert.ok(Object.keys(hooks.hooks).length > 0)
    assert.match(out, /trust Waku's four entries/)
    assert.equal(putsTo(fetchImpl).length, 0)
  })
})

test('full-record on: says so when "Auto-save from conversations" is off for a harness it wired', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const fetchImpl = fakeFetchWithSwitches([
      { harness: 'claude_code', enabled: false },
      { harness: 'codex', enabled: false }, // not wired on this machine -- no line for it
    ])
    const deps = makeDeps(dir, { prompt: fakePrompt(['y']), fetchImpl })

    const out = await captureLog(() => enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_full' }, 'full-record'))

    const get = fetchImpl.calls.filter((c) => c.method === 'GET')
    assert.equal(get.length, 1)
    assert.equal(get[0].url, `${OUR_INGEST_URL}/capture`)
    assert.match(
      out,
      /"Auto-save from conversations" is off for Claude Code, so full record sends nothing yet\. Turn it on at https:\/\/www\.waku\.one\/integrations\./,
    )
    assert.doesNotMatch(out, /is off for Codex/)
    assert.equal(putsTo(fetchImpl).length, 0)
  })
})

test('full-record on: prints nothing about the switch when it is on, or when it cannot be read', async () => {
  for (const fetchImpl of [fakeFetchWithSwitches([{ harness: 'claude_code', enabled: true }]), fakeFetch(500)]) {
    await withDir(async (dir) => {
      mkdirSync(join(dir, '.claude'), { recursive: true })
      const deps = makeDeps(dir, { prompt: fakePrompt(['y']), fetchImpl })
      let result
      const out = await captureLog(async () => {
        result = await enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_full' }, 'full-record')
      })
      assert.equal(result, 'enabled')
      assert.doesNotMatch(out, /Auto-save from conversations/)
    })
  }
})

test('capture enable (the alias) still PUTs the switch and still asks the import question', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    buildClaudeCodeFixture(join(dir, '.claude'))
    const fetchImpl = fakeFetch(202)
    const prompt = fakePrompt(['y', 'n'])
    const deps = makeDeps(dir, { prompt, fetchImpl })
    await captureLog(() => enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_alias' }))
    assert.equal(prompt.questions[1], '> ')
    assert.equal(putsTo(fetchImpl).length, 1)
  })
})

test('full-record off: removes our entries and never PUTs the switch, even with a key stored', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir, { prompt: fakePrompt(['y']) })
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, '{}')
    const fetchImpl = fakeFetch(202)
    await captureLog(() => enable(OUR_INGEST_URL, { ...deps, fetchImpl }, { kind: 'key', key: 'mem_sk_full' }, 'full-record'))
    assert.ok(JSON.parse(readFileSync(deps.settingsPath, 'utf8')).hooks)

    let result
    const out = await captureLog(async () => {
      result = await disable({ ...deps, fetchImpl }, 'full-record')
    })

    assert.equal(result, 'disabled')
    assert.deepEqual(JSON.parse(readFileSync(deps.settingsPath, 'utf8')), {})
    assert.equal(putsTo(fetchImpl).length, 0)
    assert.match(out, /Full record is off -- removed the hook entries from /)
    assert.equal(existsSync(join(deps.configDir, 'config.json')), true) // the key stays
    assert.doesNotMatch(out.replaceAll(dir, '<dir>'), /[Cc]apture/)
  })
})

test('full-record off: nothing installed says so and never PUTs the switch, even on a plugin machine', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, JSON.stringify({ enabledPlugins: { 'waku@waku-memory': true } }))
    writeConfigJson(deps.configDir, { url: OUR_INGEST_URL, key: 'mem_sk_stored' })
    const fetchImpl = fakeFetch(202)

    let result
    const out = await captureLog(async () => {
      result = await disable({ ...deps, fetchImpl }, 'full-record')
    })

    assert.equal(result, 'nothing-to-disable')
    assert.equal(fetchImpl.calls.length, 0)
    assert.match(out, /Full record was not on here -- nothing to remove\./)
  })
})

test('full-record status: names full record on or off per harness, and the plugin when it is there', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir, { prompt: fakePrompt(['y']) })
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, JSON.stringify({ enabledPlugins: { 'waku@waku-memory': true } }))

    const off = await captureLog(() => captureModule.fullRecordStatus(deps))
    assert.match(off, /^Claude Code: full record is off\. The Waku plugin is installed and sends each prompt and final reply\.$/m)
    assert.match(off, /^Key: none$/m)

    await captureLog(() => enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_full' }, 'full-record'))
    const on = await captureLog(() => captureModule.fullRecordStatus(deps))
    assert.match(on, /^Claude Code: full record is on \(/m)
    assert.match(on, /^Key: stored$/m)
    assert.doesNotMatch((on + off).replaceAll(dir, '<dir>'), /[Cc]apture/)
  })
})

test('full-record status: Codex off, then on, without the plugin', async () => {
  await withDir(async (dir) => {
    buildCodexFixture(dir)
    const deps = makeDeps(dir, { prompt: fakePrompt(['y']) })
    assert.match(await captureLog(() => captureModule.fullRecordStatus(deps)), /^Codex: full record is off\.$/m)
    await captureLog(() => enable(OUR_INGEST_URL, deps, { kind: 'key', key: 'mem_sk_full' }, 'full-record'))
    assert.match(await captureLog(() => captureModule.fullRecordStatus(deps)), /^Codex: full record is on \(/m)
  })
})

test('full-record status: reads only, writes nothing', async () => {
  await withDir(async (dir) => {
    const deps = makeDeps(dir)
    mkdirSync(deps.claudeDir, { recursive: true })
    writeFileSync(deps.settingsPath, '{"x":1}')
    buildCodexFixture(dir)
    await captureLog(() => captureModule.fullRecordStatus(deps))
    assert.equal(readFileSync(deps.settingsPath, 'utf8'), '{"x":1}')
    assert.equal(readFileSync(deps.codexConfigPath, 'utf8'), CODEX_FIXTURE_TOML)
    assert.equal(existsSync(deps.codexHooksPath), false)
    assert.equal(existsSync(deps.configDir), false)
  })
})

test('FULL_RECORD_DISCLOSURE states what is sent, the privacy list and the alpha warning, and never says "capture"', () => {
  const text = captureModule.FULL_RECORD_DISCLOSURE
  assert.match(text, /What you type, all the text the agent writes, and the names of the tools it uses are sent/)
  assert.match(text, /except where the agent quotes them in its reply/)
  assert.match(text, /reasoning is never sent/)
  assert.match(text, /www\.waku\.one\/privacy names them/)
  assert.match(text, /alpha whose data can be lost/)
  assert.doesNotMatch(text, /[Cc]apture/)
  assert.doesNotMatch(text, /next question/) // full-record on asks no import question
})

// The new commands end to end, through the real index.ts and real readline:
// both read only (an empty HOME has nothing to import and nothing
// installed), so neither needs a network or a key.
test('import (spawned): an empty HOME has nothing to import, asks nothing and exits 0', { timeout: 20_000 }, async () => {
  await withDir(async (dir) => {
    const { code, stdout } = await runCliSpawn(['import'], '', dir)
    assert.equal(code, 0)
    assert.match(stdout, /Nothing to import on this machine\./)
    assert.equal(existsSync(join(dir, '.waku-memory')), false)
  })
})

test('full-record status and capture status (spawned): both dispatch, each in its own words', { timeout: 20_000 }, async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    const full = await runCliSpawn(['full-record', 'status'], '', dir)
    assert.equal(full.code, 0)
    assert.match(full.stdout, /Claude Code: full record is off\./)
    const alias = await runCliSpawn(['capture', 'status'], '', dir)
    assert.equal(alias.code, 0)
    assert.match(alias.stdout, /Claude Code: not configured/)
  })
})
