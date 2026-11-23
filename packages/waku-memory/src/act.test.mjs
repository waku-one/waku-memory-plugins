// spec 071 F1: the act channel on this side. The PreToolUse hook sends the
// tool's name, the command's first word and the file path, never the
// command, and prints the answer as the hook JSON both harnesses read.
// `act on|off|status` adds and removes the hook beside full record's and
// turns the server's switch on and off. Temp directories and an injected
// fetchImpl only: nothing here touches a real home directory or the network.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { actOff, actOn, actStatus, answersAct, copyVersion } from './act.ts'
import {
  ACT_MATCHER,
  addActSettings,
  hasActSettings,
  hookInvocation,
  mergeHookSettings,
  ownInvocation,
  removeActSettings,
  removeHookSettings,
} from './capture.ts'
import { CODEX_ACT_MATCHER, addCodexAct, hasCodexAct, mergeCodexHooks, ownCodexIndexPath, removeCodexAct } from './codex-config.ts'
import { dispatch } from './cli.ts'
import { firstWord, handleHookEvent } from './hook.ts'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'waku-act-'))
}

function withConfig(dir) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ url: 'https://api.example.test', key: 'mem_sk_test' }))
  return dir
}

function recorder(answer) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined })
    return typeof answer === 'function' ? answer(url, init) : answer
  }
  return { calls, fetchImpl }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const RULES = 'Waku rules and how-tos saved for this step.\n- [rule] Run every test before git push.'

test('the first word drops its directory and keeps nothing after it', () => {
  assert.equal(firstWord('git push origin main'), 'git')
  assert.equal(firstWord('  /usr/bin/git status'), 'git')
  assert.equal(firstWord('C:\\tools\\alembic.exe upgrade head'), 'alembic.exe')
  assert.equal(firstWord(''), undefined)
  assert.equal(firstWord(undefined), undefined)
})

test('a PreToolUse hook sends the first word, never the command, and prints the hook JSON', async () => {
  const dir = withConfig(tempDir())
  try {
    const { calls, fetchImpl } = recorder(json(200, { context: RULES, notice: 'Waku added 1 memory to this step: "Run every test"' }))
    const out = []
    await handleHookEvent(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        cwd: '/home/me/waku',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main --force-with-lease', description: 'push' },
      },
      { configDir: dir, fetchImpl, stdout: (t) => out.push(t) },
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.example.test/ingest/act')
    assert.equal(calls[0].body.tool_name, 'Bash')
    assert.equal(calls[0].body.word, 'git')
    assert.equal(calls[0].body.harness, 'claude_code')
    assert.equal(calls[0].body.project, 'waku')
    assert.ok(!JSON.stringify(calls[0].body).includes('origin'), 'the rest of the command stays here')
    assert.equal(out.length, 1)
    const printed = JSON.parse(out[0])
    assert.equal(printed.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(printed.hookSpecificOutput.additionalContext, RULES)
    assert.equal(printed.systemMessage, 'Waku added 1 memory to this step: "Run every test"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an edit sends its file path, and a NotebookEdit its notebook path', async () => {
  const dir = withConfig(tempDir())
  try {
    const { calls, fetchImpl } = recorder(json(200, { context: null }))
    const out = []
    const deps = { configDir: dir, fetchImpl, stdout: (t) => out.push(t), harness: 'codex' }
    await handleHookEvent(
      { hook_event_name: 'PreToolUse', session_id: 's2', tool_name: 'Edit', tool_input: { file_path: '/w/infra/main.tf', old_string: 'a' } },
      deps,
    )
    await handleHookEvent(
      { hook_event_name: 'PreToolUse', session_id: 's2', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/w/a.ipynb' } },
      deps,
    )
    assert.deepEqual(
      calls.map((c) => [c.body.harness, c.body.tool_name, c.body.file_path, 'word' in c.body]),
      [
        ['codex', 'Edit', '/w/infra/main.tf', false],
        ['codex', 'NotebookEdit', '/w/a.ipynb', false],
      ],
    )
    assert.ok(!JSON.stringify(calls[0].body).includes('old_string'))
    assert.deepEqual(out, [], 'nothing to add prints nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no key, no tool name or a failed request sends or prints nothing and never throws', async () => {
  const empty = tempDir()
  const dir = withConfig(tempDir())
  try {
    const { calls, fetchImpl } = recorder(json(200, { context: RULES }))
    const out = []
    await handleHookEvent({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }, { configDir: empty, fetchImpl, stdout: (t) => out.push(t) })
    await handleHookEvent({ hook_event_name: 'PreToolUse', session_id: 's' }, { configDir: dir, fetchImpl, stdout: (t) => out.push(t) })
    assert.equal(calls.length, 0)
    const failing = recorder(json(404, { detail: 'Not Found' }))
    await handleHookEvent({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }, { configDir: dir, fetchImpl: failing.fetchImpl, stdout: (t) => out.push(t) })
    const thrown = { fetchImpl: async () => { throw new TypeError('fetch failed') } }
    await handleHookEvent({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }, { configDir: dir, ...thrown, stdout: (t) => out.push(t) })
    assert.deepEqual(out, [])
  } finally {
    rmSync(empty, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a server that never answers costs the step at most the act timeout', async () => {
  const dir = withConfig(tempDir())
  try {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const started = Date.now()
    await handleHookEvent(
      { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { configDir: dir, fetchImpl, actTimeoutMs: 50, stdout: () => assert.fail('nothing to print') },
    )
    assert.ok(Date.now() - started < 1000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const RUN = hookInvocation('/usr/bin/node', '/home/me/.waku-memory/hook/0.13.0/index.js')
const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-linter' }] }

test('the act group sits beside full record and comes out alone', () => {
  const recorded = mergeHookSettings({ model: 'opus', hooks: { PreToolUse: [FOREIGN] } }, RUN)
  assert.equal(hasActSettings(recorded), false, 'full-record on adds no act group')
  assert.deepEqual(ownInvocation(recorded), RUN)
  const on = addActSettings(recorded, RUN)
  assert.equal(hasActSettings(on), true)
  const ours = on.hooks.PreToolUse.at(-1)
  assert.equal(ours.matcher, ACT_MATCHER)
  assert.equal(ours.hooks[0].timeout, 3)
  assert.deepEqual(ours.hooks[0].args, RUN.args)
  assert.deepEqual(addActSettings(on, RUN), on, 'adding twice changes nothing')
  const off = removeActSettings(on)
  assert.deepEqual(off, recorded)
  assert.deepEqual(removeHookSettings(on).hooks, { PreToolUse: [FOREIGN] }, 'full-record off removes it too')
})

test('full-record on points an act group at the new copy', () => {
  const old = addActSettings(mergeHookSettings({}, hookInvocation('/usr/bin/node', '/h/.waku-memory/hook/0.12.0/index.js')), RUN)
  const next = hookInvocation('/usr/bin/node', '/h/.waku-memory/hook/0.13.1/index.js')
  const merged = mergeHookSettings(old, next)
  assert.equal(merged.hooks.PreToolUse.length, 1)
  assert.deepEqual(merged.hooks.PreToolUse[0].hooks[0].args, next.args)
})

test('a 0.1.x shell entry is never reused before every tool call', () => {
  const shell = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'npx -y waku-memory hook' }] }] } }
  assert.equal(ownInvocation(shell), undefined)
})

test('Codex gets the same group, with its own matcher', () => {
  const index = '/home/me/.waku-memory/hook/0.13.0/index.js'
  const recorded = mergeCodexHooks({ description: 'mine' }, index)
  assert.equal(ownCodexIndexPath(recorded), index)
  assert.equal(hasCodexAct(recorded), false)
  const on = addCodexAct(recorded, index)
  assert.equal(on.hooks.PreToolUse[0].matcher, CODEX_ACT_MATCHER)
  assert.equal(on.hooks.PreToolUse[0].hooks[0].command, `node "${index}" hook --harness codex`)
  assert.deepEqual(removeCodexAct(on), recorded)
  const moved = mergeCodexHooks(on, '/home/me/.waku-memory/hook/0.13.1/index.js')
  assert.ok(moved.hooks.PreToolUse[0].hooks[0].command.includes('0.13.1'))
})

test('a hook copy answers PreToolUse from 0.13.0 on', () => {
  assert.equal(copyVersion('/h/.waku-memory/hook/0.13.0/index.js'), '0.13.0')
  assert.equal(copyVersion('C:\\Users\\me\\.waku-memory\\hook\\0.12.1\\index.js'), '0.12.1')
  assert.equal(answersAct('0.13.0'), true)
  assert.equal(answersAct('0.13.2'), true)
  assert.equal(answersAct('1.0.0'), true)
  assert.equal(answersAct('0.12.9'), false)
  assert.equal(answersAct('next'), false)
  assert.equal(answersAct(undefined), false)
})

function actDeps(dir, fetchImpl) {
  const lines = []
  const errors = []
  return {
    lines,
    errors,
    deps: {
      configDir: join(dir, '.waku-memory'),
      settingsPath: join(dir, '.claude', 'settings.json'),
      codexHooksPath: join(dir, '.codex', 'hooks.json'),
      writeSettingsJson: (path, data) => writeFileSync(path, JSON.stringify(data)),
      writeJsonFile: (path, data) => writeFileSync(path, JSON.stringify(data)),
      fetchImpl,
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
    },
  }
}

function machine({ version = '0.13.0', key = true } = {}) {
  const dir = tempDir()
  mkdirSync(join(dir, '.waku-memory'), { recursive: true })
  mkdirSync(join(dir, '.claude'), { recursive: true })
  if (key) withConfig(join(dir, '.waku-memory'))
  const run = hookInvocation('/usr/bin/node', join(dir, '.waku-memory', 'hook', version, 'index.js'))
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(mergeHookSettings({}, run)))
  return dir
}

test('act on turns the switch on, then adds the hook', async () => {
  const dir = machine()
  try {
    const { calls, fetchImpl } = recorder(json(200, { on: true }))
    const { deps, lines } = actDeps(dir, fetchImpl)
    assert.equal(await actOn(deps), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.example.test/settings/act-channel')
    assert.equal(calls[0].init.method, 'PUT')
    assert.deepEqual(calls[0].body, { on: true })
    assert.equal(calls[0].init.headers.Authorization, 'Bearer mem_sk_test')
    assert.equal(hasActSettings(JSON.parse(readFileSync(deps.settingsPath, 'utf8'))), true)
    assert.equal(lines[0], 'The act channel is on for Claude Code.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('act on changes nothing when the switch cannot be turned on', async () => {
  const dir = machine()
  try {
    const { fetchImpl } = recorder(json(500, {}))
    const { deps, errors } = actDeps(dir, fetchImpl)
    const before = readFileSync(deps.settingsPath, 'utf8')
    assert.equal(await actOn(deps), false)
    assert.equal(readFileSync(deps.settingsPath, 'utf8'), before)
    assert.match(errors[0], /Nothing was changed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('act on asks for full record first, and for a newer one over an old copy', async () => {
  const off = tempDir()
  const old = machine({ version: '0.12.1' })
  const keyless = machine({ key: false })
  try {
    const { calls, fetchImpl } = recorder(json(200, { on: true }))
    const a = actDeps(off, fetchImpl)
    mkdirSync(join(off, '.waku-memory'), { recursive: true })
    withConfig(join(off, '.waku-memory'))
    assert.equal(await actOn(a.deps), false)
    assert.match(a.errors[0], /Full record is off on this computer/)
    const b = actDeps(old, fetchImpl)
    assert.equal(await actOn(b.deps), false)
    assert.match(b.errors[0], /Claude Code runs an older Waku hook/)
    const c = actDeps(keyless, fetchImpl)
    assert.equal(await actOn(c.deps), false)
    assert.match(c.errors[0], /No Waku key is saved/)
    assert.equal(calls.length, 0, 'no switch turned on for a machine that cannot run the hook')
  } finally {
    for (const d of [off, old, keyless]) rmSync(d, { recursive: true, force: true })
  }
})

test('act off removes the hook, keeps full record and turns the switch off', async () => {
  const dir = machine()
  try {
    const { calls, fetchImpl } = recorder(json(200, { on: false }))
    const { deps, lines } = actDeps(dir, fetchImpl)
    await actOn(deps)
    assert.equal(await actOff(deps), true)
    const settings = JSON.parse(readFileSync(deps.settingsPath, 'utf8'))
    assert.equal(hasActSettings(settings), false)
    assert.ok(ownInvocation(settings), 'full record stays')
    assert.deepEqual(calls.at(-1).body, { on: false })
    assert.equal(lines.at(-1), 'The act channel is off. Your rules still reach each session at its start.')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('act status reads the hooks and the switch', async () => {
  const dir = machine()
  try {
    const { fetchImpl } = recorder(json(200, { on: true }))
    const { deps, lines } = actDeps(dir, fetchImpl)
    await actOn(deps)
    lines.length = 0
    await actStatus(deps)
    assert.deepEqual(lines, ['Claude Code hook: on', 'Codex hook: off', 'Switch on Waku: on'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dispatch reads act on, off and status', () => {
  assert.deepEqual(dispatch(['act', 'on']), { kind: 'act', action: 'on' })
  assert.deepEqual(dispatch(['act', 'status']), { kind: 'act', action: 'status' })
  assert.equal(dispatch(['act']).kind, 'bad-flag')
  assert.equal(dispatch(['act', 'maybe']).kind, 'bad-flag')
})
