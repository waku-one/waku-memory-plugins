import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_INGEST_URL,
  DEFAULT_NAME,
  DEFAULT_URL,
  IMPORT_QUESTION,
  applyToHarness,
  atomicWriteJson,
  buildBrowserOpener,
  dispatch,
  importNote,
  parseArgs,
  printUsage,
  runSetup,
  setup,
  summarize,
} from './cli.ts'
import { DEFAULT_WINDOW_DAYS } from './bootstrap.ts'

// Every test here uses a temp directory under the OS temp dir, never the
// real ~/.claude.json -- applyToHarness/runSetup/setup all take a
// configPath or a Harness[] explicitly, which is what makes that possible.
function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waku-shim-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- parseArgs -------------------------------------------------------

test('parseArgs: defaults when nothing is passed', () => {
  const { command, name, url } = parseArgs([])
  assert.equal(command, undefined)
  assert.equal(name, DEFAULT_NAME)
  assert.equal(url, DEFAULT_URL)
})

test('parseArgs: --name and --url override the defaults', () => {
  const { command, name, url } = parseArgs(['setup', '--name', 'custom', '--url', 'https://x.test/mcp'])
  assert.equal(command, 'setup')
  assert.equal(name, 'custom')
  assert.equal(url, 'https://x.test/mcp')
})

test('parseArgs: a trailing --name with no value is ignored, not consumed as the value', () => {
  const { name } = parseArgs(['setup', '--name'])
  assert.equal(name, DEFAULT_NAME)
})

test('parseArgs: a second positional becomes subcommand, for "capture enable"/"capture disable"', () => {
  const { command, subcommand } = parseArgs(['capture', 'enable'])
  assert.equal(command, 'capture')
  assert.equal(subcommand, 'enable')
})

test('parseArgs: an unrecognized --flag is dropped, not treated as a positional command', () => {
  // This is the exact shape of the bug --help hit: parseArgs only ever
  // special-cased --name/--url, so any other --flag vanished silently
  // instead of becoming `command`. dispatch() below no longer depends on
  // parseArgs for --help specifically (see the next block), but this is
  // the underlying behavior that made that bug possible in the first
  // place, so it gets its own pin.
  const { command } = parseArgs(['--verbose'])
  assert.equal(command, undefined)
})

test('parseArgs: --since consumes its value, not left as a stray positional', () => {
  // Same shape as --name/--url above: without this, "90d" would fall
  // through to the generic "not a flag" branch and be pushed onto
  // positional -- task 14's flags must never do that (dispatch below
  // relies on it).
  const { since, command, subcommand } = parseArgs(['capture', 'enable', '--since', '90d'])
  assert.equal(since, '90d')
  assert.equal(command, 'capture')
  assert.equal(subcommand, 'enable')
})

test('parseArgs: a trailing --since with no value is ignored, not consumed as the value', () => {
  const { since } = parseArgs(['capture', 'enable', '--since'])
  assert.equal(since, undefined)
})

test('parseArgs: --all and --no-bootstrap are recognized as boolean flags', () => {
  const { all, noBootstrap } = parseArgs(['capture', 'enable', '--all', '--no-bootstrap'])
  assert.equal(all, true)
  assert.equal(noBootstrap, true)
})

test('parseArgs: --all and --no-bootstrap default to false when absent', () => {
  const { all, noBootstrap } = parseArgs(['capture', 'enable'])
  assert.equal(all, false)
  assert.equal(noBootstrap, false)
})

// ---- parseArgs: --login / --key (task 13, spec 012 §7) --------------------

test('parseArgs: --login is a boolean flag, false by default', () => {
  assert.equal(parseArgs(['capture', 'enable']).login, false)
  assert.equal(parseArgs(['capture', 'enable', '--login']).login, true)
})

test('parseArgs: --key <key> consumes its value', () => {
  const { key } = parseArgs(['capture', 'enable', '--key', 'mem_sk_x'])
  assert.equal(key, 'mem_sk_x')
})

test('parseArgs: --key with no value at all is left undefined, not consuming the next flag', () => {
  const { key, login } = parseArgs(['capture', 'enable', '--key'])
  assert.equal(key, undefined)
  assert.equal(login, false)
})

test('parseArgs: --key followed by another flag is left undefined -- the flag is not swallowed as the value', () => {
  const { key, login } = parseArgs(['capture', 'enable', '--key', '--login'])
  assert.equal(key, undefined)
  // --login itself must still be recognized on its own iteration, not eaten
  // as --key's value.
  assert.equal(login, true)
})

// ---- dispatch ----------------------------------------------------------

test('dispatch: --help and -h', () => {
  assert.deepEqual(dispatch(['--help']), { kind: 'help' })
  assert.deepEqual(dispatch(['-h']), { kind: 'help' })
})

test('dispatch: --help wins even alongside a valid command', () => {
  // The actual bug found by hand: --help fell through to "no command"
  // because parseArgs silently dropped it, so main() never saw it. Checked
  // here with "setup" present too, so a regression that moves the --help
  // check to the wrong place (e.g. after parseArgs, or delegated back to
  // it) would still be caught, not just the argv-only-has---help case.
  assert.deepEqual(dispatch(['setup', '--help']), { kind: 'help' })
})

test('dispatch: no arguments at all', () => {
  assert.deepEqual(dispatch([]), { kind: 'no-command' })
})

test('dispatch: an unknown command', () => {
  assert.deepEqual(dispatch(['frobnicate']), { kind: 'unknown', command: 'frobnicate' })
})

test('dispatch: setup with defaults', () => {
  assert.deepEqual(dispatch(['setup']), { kind: 'setup', name: DEFAULT_NAME, url: DEFAULT_URL })
})

test('dispatch: setup with --name and --url', () => {
  assert.deepEqual(dispatch(['setup', '--name', 'custom', '--url', 'https://x.test/mcp']), {
    kind: 'setup',
    name: 'custom',
    url: 'https://x.test/mcp',
  })
})

test('dispatch: hook defaults to the claude_code harness', () => {
  // Everything else hook needs arrives on stdin, read and parsed by run()
  // itself (see hook.test.mjs for the decision logic this dispatches into).
  assert.deepEqual(dispatch(['hook']), { kind: 'hook', harness: 'claude_code' })
})

test('dispatch: --help wins over hook too', () => {
  assert.deepEqual(dispatch(['hook', '--help']), { kind: 'help' })
})

// ---- dispatch: hook --harness (spec 012 §4, task 8) ---------------------

test('dispatch: hook --harness codex', () => {
  assert.deepEqual(dispatch(['hook', '--harness', 'codex']), { kind: 'hook', harness: 'codex' })
})

test('dispatch: hook --harness with an unknown id is a bad-flag mentioning harness', () => {
  const d = dispatch(['hook', '--harness', 'vim'])
  assert.equal(d.kind, 'bad-flag')
  assert.match(d.message, /harness/)
})

test('dispatch: hook --harness with no value is a bad-flag mentioning harness', () => {
  const d = dispatch(['hook', '--harness'])
  assert.equal(d.kind, 'bad-flag')
  assert.match(d.message, /harness/)
})

test('dispatch: capture enable with the default ingest URL', () => {
  // DEFAULT_INGEST_URL, not DEFAULT_URL -- the ingest base has no "/mcp"
  // suffix. Catches a regression where dispatch trusted parseArgs's own
  // (setup-shaped) default instead of substituting this one.
  // bootstrap defaults to "on, full DEFAULT_WINDOW_DAYS window" (task 14,
  // spec 011 §9/§8) when no --since/--all/--no-bootstrap were passed.
  // mcpUrl (fix round 1, spec 012 §4.2) is the sibling value the Codex TOML
  // (and Claude Code's own ~/.claude.json) must carry -- DEFAULT_URL,
  // "/mcp" suffix and all, as distinct from url's ingest base.
  assert.deepEqual(dispatch(['capture', 'enable']), {
    kind: 'capture',
    action: 'enable',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
    bootstrap: { windowDays: DEFAULT_WINDOW_DAYS, enabled: true },
    credential: { kind: 'ask' },
  })
})

test('dispatch: capture disable with the default ingest URL', () => {
  // disable() never reads deps.bootstrap (see its own comment) -- dispatch
  // still fills in the same default here rather than parsing
  // --since/--all/--no-bootstrap for an action that would ignore them.
  assert.deepEqual(dispatch(['capture', 'disable']), {
    kind: 'capture',
    action: 'disable',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
    bootstrap: { windowDays: DEFAULT_WINDOW_DAYS, enabled: true },
  })
})

test('dispatch: capture enable --url overrides the default -- and the pair is always derived from it, never just echoed back', () => {
  // Fix round 2 (re-review finding #1, spec 012 §4.2): the usage text
  // documents "--url <ingest-base>", so an ingest-shaped value (no "/mcp"
  // suffix) has to produce a *different* mcpUrl ("/mcp" appended), not the
  // same string copied into both fields -- that was the round-1 regression:
  // dispatch trusted "no /mcp suffix to strip" as proof mcpUrl already
  // matched, when the real defect was that no --url shape ever computed
  // mcpUrl from url; it only ever stripped url from a caller-supplied mcpUrl.
  assert.deepEqual(dispatch(['capture', 'enable', '--url', 'https://ingest.example.test']), {
    kind: 'capture',
    action: 'enable',
    url: 'https://ingest.example.test',
    mcpUrl: 'https://ingest.example.test/mcp',
    bootstrap: { windowDays: DEFAULT_WINDOW_DAYS, enabled: true },
    credential: { kind: 'ask' },
  })
})

test('dispatch: capture enable --url with an MCP-shaped value strips "/mcp" for the ingest base and keeps mcpUrl the same shape', () => {
  // Fix round 1 (spec 012 §4.2) regression pin, still true under round 2's
  // urlPair(): a person's own --url flows to both places consistently, the
  // same rule DEFAULT_URL/DEFAULT_INGEST_URL already follow (DEFAULT_INGEST_URL
  // is DEFAULT_URL with "/mcp" stripped).
  assert.deepEqual(dispatch(['capture', 'enable', '--url', 'https://example.test/mcp']), {
    kind: 'capture',
    action: 'enable',
    url: 'https://example.test',
    mcpUrl: 'https://example.test/mcp',
    bootstrap: { windowDays: DEFAULT_WINDOW_DAYS, enabled: true },
    credential: { kind: 'ask' },
  })
})

test('dispatch: capture enable --url with a trailing slash strips it before deriving the pair', () => {
  // The third of urlPair's three named shapes (controller ruling R9): a
  // bare ingest base typed with a trailing slash must not become
  // "https://example.test//mcp".
  assert.deepEqual(dispatch(['capture', 'enable', '--url', 'https://example.test/']), {
    kind: 'capture',
    action: 'enable',
    url: 'https://example.test',
    mcpUrl: 'https://example.test/mcp',
    bootstrap: { windowDays: DEFAULT_WINDOW_DAYS, enabled: true },
    credential: { kind: 'ask' },
  })
})

// ---- dispatch: capture enable's --since/--all/--no-bootstrap (task 14) --

test('dispatch: capture enable --since <N>d sets the bootstrap window in days', () => {
  assert.deepEqual(dispatch(['capture', 'enable', '--since', '90d']), {
    kind: 'capture',
    action: 'enable',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
    bootstrap: { windowDays: 90, enabled: true },
    credential: { kind: 'ask' },
  })
})

test('dispatch: capture enable --since also accepts a bare integer (no "d" suffix)', () => {
  assert.deepEqual(dispatch(['capture', 'enable', '--since', '30']).bootstrap, {
    windowDays: 30,
    enabled: true,
  })
})

test('dispatch: capture enable --all scans everything -- windowDays: null', () => {
  assert.deepEqual(dispatch(['capture', 'enable', '--all']), {
    kind: 'capture',
    action: 'enable',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
    bootstrap: { windowDays: null, enabled: true },
    credential: { kind: 'ask' },
  })
})

test('dispatch: capture enable --no-bootstrap turns off the third question', () => {
  assert.deepEqual(dispatch(['capture', 'enable', '--no-bootstrap']), {
    kind: 'capture',
    action: 'enable',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
    bootstrap: { windowDays: DEFAULT_WINDOW_DAYS, enabled: false },
    credential: { kind: 'ask' },
  })
})

test('dispatch: capture enable --since and --all together -- --all wins', () => {
  // Not specified by name in the brief; --all winning (rather than a
  // conflict error) is the least surprising reading of "scan everything"
  // stacked on top of a narrower window.
  assert.deepEqual(dispatch(['capture', 'enable', '--since', '30d', '--all']).bootstrap, {
    windowDays: null,
    enabled: true,
  })
})

test('dispatch: capture enable --since and --url together -- neither flag swallows the other', () => {
  // Regression pin for the exact bug the brief calls out: before parseArgs
  // learned --since, its value token ("45d") fell through to the generic
  // "not a flag" branch and was pushed onto positional. Asserting the full
  // shape (not just .bootstrap) also catches --url being dropped by a
  // --since implementation that consumes one token too many.
  assert.deepEqual(dispatch(['capture', 'enable', '--since', '45d', '--url', 'https://ingest.example.test']), {
    kind: 'capture',
    action: 'enable',
    url: 'https://ingest.example.test',
    mcpUrl: 'https://ingest.example.test/mcp',
    bootstrap: { windowDays: 45, enabled: true },
    credential: { kind: 'ask' },
  })
})

test('dispatch: capture enable --since with an unparsable value is a bad-flag naming it', () => {
  const d = dispatch(['capture', 'enable', '--since', 'abc'])
  assert.equal(d.kind, 'bad-flag')
  assert.match(d.message, /--since/)
  assert.match(d.message, /abc/)
})

test('dispatch: capture enable --since with no value falls back to the default', () => {
  // Mirrors parseArgs's own "trailing --name with no value" behavior: a
  // trailing --since is dropped, not treated as an (impossible) empty value
  // to reject.
  assert.deepEqual(dispatch(['capture', 'enable', '--since']).bootstrap, {
    windowDays: DEFAULT_WINDOW_DAYS,
    enabled: true,
  })
})

// ---- dispatch: capture enable's --login/--key (task 13, spec 012 §7) ----

test('dispatch: capture enable with no flag defaults to credential ask', () => {
  assert.deepEqual(dispatch(['capture', 'enable']).credential, { kind: 'ask' })
})

test('dispatch: capture enable --login sets credential login', () => {
  assert.deepEqual(dispatch(['capture', 'enable', '--login']).credential, { kind: 'login' })
})

test('dispatch: capture enable --key <key> sets credential key', () => {
  assert.deepEqual(dispatch(['capture', 'enable', '--key', 'mem_sk_x']).credential, {
    kind: 'key',
    key: 'mem_sk_x',
  })
})

test('dispatch: capture enable --key with no value is a bad-flag mentioning --key', () => {
  const d = dispatch(['capture', 'enable', '--key'])
  assert.equal(d.kind, 'bad-flag')
  assert.match(d.message, /--key/)
})

test('dispatch: capture enable --key followed by another flag (no value) is a bad-flag mentioning --key', () => {
  const d = dispatch(['capture', 'enable', '--key', '--login'])
  assert.equal(d.kind, 'bad-flag')
  assert.match(d.message, /--key/)
})

test('dispatch: capture enable --login and --key together is a bad-flag', () => {
  const d = dispatch(['capture', 'enable', '--login', '--key', 'mem_sk_x'])
  assert.equal(d.kind, 'bad-flag')
  assert.match(d.message, /--login/)
  assert.match(d.message, /--key/)
})

// ---- dispatch: login (task 13, spec 012 §7) -------------------------------

test('dispatch: login with the default ingest URL', () => {
  assert.deepEqual(dispatch(['login']), { kind: 'login', url: DEFAULT_INGEST_URL })
})

test('dispatch: login --url overrides the default, deriving the ingest base the same way capture enable does', () => {
  assert.deepEqual(dispatch(['login', '--url', 'https://example.test/mcp']), {
    kind: 'login',
    url: 'https://example.test',
  })
})

test('dispatch: --help wins over login too', () => {
  assert.deepEqual(dispatch(['login', '--help']), { kind: 'help' })
})

// ---- buildBrowserOpener (fix round 1, finding 1) ---------------------------
//
// Reviewer repro (verified again directly, adapted to this shape, from Bash
// on this machine): `spawn('cmd', ['/c', 'echo', '""', url])` with no
// `windowsVerbatimArguments` and the URL not itself quoted echoes only
// `https://example.test/authorize?client_id=abc` and fails on `redirect_uri`
// and `state` as unrecognized commands -- cmd.exe splits the unquoted `&`.
// The shape below (spawn('cmd', ['/c', 'echo', '""', '"' + url + '"'], {
// windowsVerbatimArguments: true })) was run the same way and printed the
// whole URL, `&` and all: `"" "https://x/a?b=1&c=2"`.

test('buildBrowserOpener: win32 wraps the URL in literal quotes and sets windowsVerbatimArguments, so an OAuth URL survives cmd.exe whole', () => {
  const url = 'https://example.test/authorize?client_id=abc&redirect_uri=xyz&state=123'

  const opener = buildBrowserOpener('win32', url)

  assert.equal(opener.command, 'cmd')
  assert.deepEqual(opener.args, ['/c', 'start', '""', `"${url}"`])
  assert.equal(opener.options.windowsVerbatimArguments, true)
  assert.equal(opener.options.detached, true)
  assert.equal(opener.options.stdio, 'ignore')
})

test('buildBrowserOpener: darwin uses "open" with the bare URL, no shell quoting involved', () => {
  const url = 'https://example.test/authorize?client_id=abc&redirect_uri=xyz&state=123'

  const opener = buildBrowserOpener('darwin', url)

  assert.equal(opener.command, 'open')
  assert.deepEqual(opener.args, [url])
  assert.equal(opener.options.windowsVerbatimArguments, undefined)
})

test('buildBrowserOpener: linux (and everything else) uses "xdg-open" with the bare URL', () => {
  const url = 'https://example.test/authorize?client_id=abc&redirect_uri=xyz&state=123'

  const opener = buildBrowserOpener('linux', url)

  assert.equal(opener.command, 'xdg-open')
  assert.deepEqual(opener.args, [url])
  assert.equal(opener.options.windowsVerbatimArguments, undefined)
})

test('dispatch: capture disable ignores --since/--all/--no-bootstrap -- always the default', () => {
  assert.deepEqual(dispatch(['capture', 'disable', '--since', '30d', '--all', '--no-bootstrap']), {
    kind: 'capture',
    action: 'disable',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
    bootstrap: { windowDays: DEFAULT_WINDOW_DAYS, enabled: true },
  })
})

test('dispatch: capture with no subcommand, or an unrecognized one, is unknown', () => {
  assert.deepEqual(dispatch(['capture']), { kind: 'unknown', command: 'capture' })
  assert.deepEqual(dispatch(['capture', 'frobnicate']), { kind: 'unknown', command: 'capture' })
})

// ---- dispatch: capture status (task 10, spec 012 §4.6) -------------------

test('dispatch: capture status', () => {
  assert.deepEqual(dispatch(['capture', 'status']), { kind: 'capture', action: 'status' })
})

test('dispatch: --help wins over capture status too', () => {
  assert.deepEqual(dispatch(['capture', 'status', '--help']), { kind: 'help' })
})

test('dispatch: --help wins over capture too', () => {
  assert.deepEqual(dispatch(['capture', 'enable', '--help']), { kind: 'help' })
})

// ---- applyToHarness ------------------------------------------------------

test('applyToHarness: adds the entry and preserves everything else in the file', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        numStartups: 12,
        mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } },
      }),
    )

    const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

    assert.equal(result.status, 'wrote')
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.numStartups, 12)
    assert.equal(written.mcpServers.sentry.url, 'https://mcp.sentry.dev/mcp')
    assert.equal(written.mcpServers.waku.url, 'https://example.test/mcp')
  })
})

test('applyToHarness: a second call with the same name/url is unchanged, not rewritten', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))

    const first = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')
    const second = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

    assert.equal(first.status, 'wrote')
    assert.equal(second.status, 'unchanged')
  })
})

test('applyToHarness: refuses a conflicting entry and leaves the file untouched', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    const original = JSON.stringify({ mcpServers: { waku: { type: 'http', url: 'https://old.test/mcp' } } })
    writeFileSync(configPath, original)

    const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

    assert.equal(result.status, 'error')
    assert.match(result.message, /already configured/)
    assert.equal(readFileSync(configPath, 'utf8'), original)
  })
})

test('applyToHarness: malformed JSON is reported as an error, not thrown', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, '{ not valid json')

    const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

    assert.equal(result.status, 'error')
    assert.match(result.message, /could not read or parse/)
  })
})

test('applyToHarness: an empty file is a blank slate, not corruption', () => {
  // Found 2026-08-26 on a real machine: ~/.cursor/mcp.json was zero bytes
  // with Cursor installed and no MCP server ever added. JSON.parse('')
  // throws, so this used to land in the malformed-JSON branch above and
  // report "could not read or parse" -- failing setup for someone whose
  // config was in its shipped initial state. Only bites once a harness
  // with that default is in getHarnesses(), which is why it is a test and
  // not a bug report: it must not be reintroduced when the list grows.
  withDir((dir) => {
    for (const blank of ['', '\n', '  \r\n\t ']) {
      const configPath = join(dir, 'config.json')
      writeFileSync(configPath, blank)

      const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

      assert.equal(result.status, 'wrote', `expected a write for content: ${JSON.stringify(blank)}`)
      const written = JSON.parse(readFileSync(configPath, 'utf8'))
      assert.equal(written.mcpServers.waku.url, 'https://example.test/mcp')
      assert.equal(written.mcpServers.waku.type, 'http')
    }
  })
})

test('applyToHarness: a file of only-whitespace-plus-garbage is still refused', () => {
  // The empty-file branch is deliberately narrow. Anything with non-blank
  // content that fails to parse is real corruption, and overwriting a file
  // we could not read is the one thing this function must never do.
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    const original = '  \n {"mcpServers": '
    writeFileSync(configPath, original)

    const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

    assert.equal(result.status, 'error')
    assert.match(result.message, /could not read or parse/)
    assert.equal(readFileSync(configPath, 'utf8'), original)
  })
})

test('applyToHarness: a missing file is reported as an error, not thrown', () => {
  withDir((dir) => {
    const configPath = join(dir, 'does-not-exist.json')

    const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

    assert.equal(result.status, 'error')
  })
})

test('applyToHarness: a config that does not parse to a plain object is an error, not thrown', () => {
  // "null" reproduces the exact crash the review found against the
  // compiled binary: existing.mcpServers throws on a null base, past the
  // read/parse catch, because optional chaining only guards the
  // "?.[name]" lookup, not "existing" itself being null. Arrays and other
  // primitives don't throw the same way -- spreading them into the merged
  // object would silently corrupt the file instead -- so they're refused
  // for the same reason, not because they also crash.
  withDir((dir) => {
    for (const badContent of ['null', '[]', '"a string"', '42', 'true']) {
      const configPath = join(dir, 'config.json')
      writeFileSync(configPath, badContent)

      const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp')

      assert.equal(result.status, 'error', `expected an error for content: ${badContent}`)
    }
  })
})

test('applyToHarness: a write failure is caught and reported, not thrown', () => {
  // The review's Important finding #1: writeFileSync sat outside any
  // try/catch, contradicting this function's own "never throws" doc
  // comment. A permission error, a full disk, and a read-only filesystem
  // all surface the same way -- the writer throwing -- so an injected
  // failing writer stands in for all three without needing a real broken
  // filesystem, which isn't portable to test against anyway.
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const failingWrite = () => {
      throw new Error('EACCES: permission denied (simulated)')
    }

    const result = applyToHarness(configPath, 'Fake', 'waku', 'https://example.test/mcp', failingWrite)

    // If applyToHarness had rethrown instead of catching, this call above
    // would have blown up the test with an uncaught exception before ever
    // reaching these assertions -- reaching them at all is half the proof.
    assert.equal(result.status, 'error')
    assert.match(result.message, /permission denied/)
  })
})

// ---- atomicWriteJson (the real implementation, not injected) --------------

test('atomicWriteJson: writes correct content and leaves no temp file behind', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    atomicWriteJson(configPath, { mcpServers: { waku: { type: 'http', url: 'https://example.test/mcp' } } })

    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.mcpServers.waku.url, 'https://example.test/mcp')
    assert.deepEqual(readdirSync(dir), ['config.json'])
  })
})

test('atomicWriteJson: replaces existing content completely', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { old: { type: 'http', url: 'https://old.test/mcp' } } }),
    )

    atomicWriteJson(configPath, { mcpServers: { waku: { type: 'http', url: 'https://example.test/mcp' } } })

    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.mcpServers.old, undefined)
    assert.equal(written.mcpServers.waku.url, 'https://example.test/mcp')
  })
})

// ---- runSetup / summarize -----------------------------------------------

test('runSetup + summarize: found-but-unchanged is not the same as not-found', () => {
  // Bug #2 from manual testing: re-running setup on an already-configured
  // harness reported "no supported harness config was found", because
  // "found" and "wrote" were collapsed into one boolean. foundAny has to
  // be true here even though nothing was written.
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { waku: { type: 'http', url: 'https://example.test/mcp' } } }),
    )

    const results = runSetup([{ name: 'Fake', configPath }], 'waku', 'https://example.test/mcp')
    const summary = summarize(results)

    assert.equal(results[0].status, 'unchanged')
    assert.equal(summary.foundAny, true)
    assert.equal(summary.wroteAny, false)
    assert.equal(summary.hadError, false)
  })
})

test('runSetup + summarize: a harness whose config file does not exist is not-found', () => {
  withDir((dir) => {
    const configPath = join(dir, 'does-not-exist.json')
    const results = runSetup([{ name: 'Fake', configPath }], 'waku', 'https://example.test/mcp')
    const summary = summarize(results)

    assert.equal(results[0].status, 'not-found')
    assert.equal(summary.foundAny, false)
    assert.equal(summary.wroteAny, false)
    assert.equal(summary.hadError, false)
  })
})

test('runSetup + summarize: a fresh write is found and wrote', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))

    const results = runSetup([{ name: 'Fake', configPath }], 'waku', 'https://example.test/mcp')
    const summary = summarize(results)

    assert.equal(summary.foundAny, true)
    assert.equal(summary.wroteAny, true)
    assert.equal(summary.hadError, false)
  })
})

test('runSetup + summarize: a conflict is found and an error, and does not count as written', () => {
  withDir((dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { waku: { type: 'http', url: 'https://old.test/mcp' } } }),
    )

    const results = runSetup([{ name: 'Fake', configPath }], 'waku', 'https://example.test/mcp')
    const summary = summarize(results)

    assert.equal(summary.foundAny, true)
    assert.equal(summary.wroteAny, false)
    assert.equal(summary.hadError, true)
  })
})

test('runSetup + summarize: aggregates correctly across multiple harnesses', () => {
  withDir((dir) => {
    const missingPath = join(dir, 'missing.json')
    const unchangedPath = join(dir, 'unchanged.json')
    writeFileSync(
      unchangedPath,
      JSON.stringify({ mcpServers: { waku: { type: 'http', url: 'https://example.test/mcp' } } }),
    )

    const results = runSetup(
      [
        { name: 'Missing', configPath: missingPath },
        { name: 'Unchanged', configPath: unchangedPath },
      ],
      'waku',
      'https://example.test/mcp',
    )
    const summary = summarize(results)

    assert.deepEqual(
      results.map((r) => r.status),
      ['not-found', 'unchanged'],
    )
    // foundAny has to be true because of the second harness alone, even
    // though the first was not-found -- this is exactly the aggregation a
    // single shared boolean got wrong.
    assert.equal(summary.foundAny, true)
    assert.equal(summary.wroteAny, false)
    assert.equal(summary.hadError, false)
  })
})

// ---- setup(): the exit code the review traced end-to-end ------------------
//
// setup() is async as of this task (Change 2, spec 012 Task 17 follow-up):
// once a harness was found, it asks a follow-up question, and a "y" answer
// runs the real "import" flow (spec 068 D3; it ran "capture enable" before).
// Every test below injects both `prompt` and `runImport` explicitly (passing `undefined` for
// the `codexConfigPath` argument ahead of them where a test does not care
// about it, so it keeps using its own real default the way these tests
// always have) -- never the real readline-backed prompt or the real
// capture-enable runner, so no test here opens real stdin or performs a
// real enable. `decliningPrompt` stands in for pressing Enter (today's
// default behaviour); `refusingRunEnable`/`refusingPrompt` are hard
// guarantees, not just stand-ins -- either one being called where it
// should not be fails the test it is used in.

async function withDirAsync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waku-shim-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const decliningPrompt = async () => ''

function refusingPrompt() {
  return async () => {
    throw new Error('prompt must not be called when no harness was found')
  }
}

function refusingRunEnable() {
  return async () => {
    throw new Error('runImport must not be called unless the answer was "y"')
  }
}

test('setup: sets process.exitCode = 1 when a harness errors', async () => {
  const savedExitCode = process.exitCode
  await withDirAsync(async (dir) => {
    process.exitCode = undefined
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { waku: { type: 'http', url: 'https://old.test/mcp' } } }),
    )
    try {
      await setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath }],
        undefined,
        decliningPrompt,
        refusingRunEnable(),
      )
      assert.equal(process.exitCode, 1)
    } finally {
      process.exitCode = savedExitCode
    }
  })
})

test('setup: does not touch process.exitCode on a clean run', async () => {
  const savedExitCode = process.exitCode
  await withDirAsync(async (dir) => {
    process.exitCode = undefined
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    try {
      await setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath }],
        undefined,
        decliningPrompt,
        refusingRunEnable(),
      )
      assert.equal(process.exitCode, undefined)
    } finally {
      process.exitCode = savedExitCode
    }
  })
})

// ---- the import next step -------------------------------------------------
//
// Whole-branch review C1: spec.md said the shim "triggers the import", and
// it never could -- the same sentence says it obtains no credential, and
// memory.import is an authenticated MCP call. The spec is amended; the
// achievable half is that setup() tells the user what to ask for, so the
// path from `npx` to imported memories is complete for a human. Acceptance
// 11 previously had no step that produced any imported memories at all.

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

test('importNote: names the tool and the files, and says why the shim cannot do it', () => {
  const note = importNote()
  assert.match(note, /memory\.import/)
  assert.match(note, /CLAUDE\.md/)
  assert.match(note, /AGENTS\.md/)
  // The "why" matters as much as the "what": without it the reader's next
  // question is why the installer did not just do this.
  assert.match(note, /no credential/)
})

test('importNote: discloses the two facts capture.ts also discloses', () => {
  // Spec 005 "Disclosure", corrected 2026-08-28: this function was once
  // documented as already saying this and never did. Both facts, asserted
  // separately so either one going missing fails on its own.
  //
  // Spec 025 replaced "and to Anthropic for extraction" with the general
  // phrase plus a pointer, here and in every other product string, so that
  // one processor list is maintained instead of ten. plugin.test.mjs owns
  // that rule; this test just keeps the send and the alpha warning present.
  const note = importNote()
  assert.match(note, /sent to our servers and on to the AI providers/)
  assert.match(note, /alpha whose data can be lost/)
})

// Task 14 (spec 012 §9): the "manual harnesses: detected, never written"
// block that used to live here (a fakeManual() helper and four tests
// against setup()'s now-removed 4th parameter) is gone along with
// harnesses.ts's own manual-harness list, note function and type -- Codex
// was its only member, and Codex now has a real, automatic route of its
// own ("capture enable", task 10), so there is nothing left for setup() to
// detect-but-not-write. The "no harness found" test below is what a
// Codex-only machine now falls through to.

test('setup: a fresh write tells the user how to sign in AND how to import', async () => {
  await withDirAsync(async (dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const out = await captureLog(() =>
      setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath }],
        undefined,
        decliningPrompt,
        refusingRunEnable(),
      ),
    )
    assert.match(out, /browser popup is expected/)
    assert.match(out, /memory\.import/)
  })
})

test('setup: an already-configured re-run still points at the import step', async () => {
  await withDirAsync(async (dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { waku: { type: 'http', url: 'https://example.test/mcp' } },
      }),
    )
    const out = await captureLog(() =>
      setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath }],
        undefined,
        decliningPrompt,
        refusingRunEnable(),
      ),
    )
    assert.match(out, /Already configured correctly/)
    // A configured server with nothing imported is exactly the state a
    // re-runner is most likely to be in, so this is the run that most
    // needs the pointer.
    assert.match(out, /memory\.import/)
  })
})

test('setup: no harness found means no import advice -- install one first, and no capture question either', async () => {
  await withDirAsync(async (dir) => {
    const out = await captureLog(() =>
      setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath: join(dir, 'does-not-exist.json') }],
        // A non-existent Codex path -- this is a real machine, and the
        // point of this test is "nothing at all was found", which must
        // hold regardless of whether the machine running it happens to
        // have Codex installed. See the R20 test below for the found case.
        join(dir, 'no-codex-here.toml'),
        // Nothing was found, so setup() must never even ask the new
        // capture question -- refusingPrompt turns a regression there into
        // a hard test failure instead of a silently-wrong real prompt.
        refusingPrompt(),
        refusingRunEnable(),
      ),
    )
    assert.match(out, /no supported harness config was found/)
    assert.doesNotMatch(out, /memory\.import/)
    assert.doesNotMatch(out, /Codex was found/)
  })
})

// R20 (final review, spec 012): Task 14 deleted the manual-harness note
// along with codexNote/getManualHarnesses, which left a Codex-only machine
// -- ~/.codex/config.toml present, no ~/.claude -- with the flatly false
// "no supported harness config was found on this machine". setup() still
// writes nothing for Codex (getHarnesses() does not carry it, and R20 does
// not ask it to), but it can at least tell the truth and point at the real
// route: "capture enable" (task 10).
test('setup: a Codex config on the machine is pointed at the plugin and full-record on', async () => {
  await withDirAsync(async (dir) => {
    const codexConfigPath = join(dir, 'config.toml')
    writeFileSync(codexConfigPath, '[mcp_servers.other]\n')
    const out = await captureLog(() =>
      setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath: join(dir, 'does-not-exist.json') }],
        codexConfigPath,
        // getHarnesses() carries no Codex entry (harnesses.ts's own
        // comment), so this machine's setup() writes nothing at all --
        // foundAny is still false here, same as the plain "no harness
        // found" test above, so the capture question must stay silent.
        refusingPrompt(),
        refusingRunEnable(),
      ),
    )
    assert.match(out, /no supported harness config was found/)
    // spec 068 D3: plugin first, then full-record on -- never the hidden
    // capture enable alias.
    assert.match(
      out,
      /Codex was found\. Install the Waku plugin in Codex, or run "npx waku-memory full-record on" to wire it in from here\./,
    )
  })
})

// ---- setup(): the follow-up question (Change 2; spec 068 D3 made it the import)

test('setup: once a harness was found, asks the exact import question and defaults to no', async () => {
  await withDirAsync(async (dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const questions = []
    let ranEnable = false
    const out = await captureLog(() =>
      setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath }],
        undefined,
        async (question) => {
          questions.push(question)
          return '' // pressing Enter
        },
        async () => {
          ranEnable = true
        },
      ),
    )
    assert.deepEqual(questions, [IMPORT_QUESTION])
    assert.equal(ranEnable, false)
    // Nothing about the existing output is disturbed by the new question.
    assert.match(out, /memory\.import/)
  })
})

test('setup: anything other than "y" keeps today\'s behaviour and never runs the import', async () => {
  for (const answer of ['n', 'N', 'no', 'yes', 'Yep', '']) {
    await withDirAsync(async (dir) => {
      const configPath = join(dir, 'config.json')
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
      // refusingRunEnable() makes any of these answers being mistaken for
      // "y" a hard failure, not a quiet behavioural change.
      await setup(
        'waku',
        'https://example.test/mcp',
        [{ name: 'Fake', configPath }],
        undefined,
        async () => answer,
        refusingRunEnable(),
      )
    })
  }
})

test('setup: a "y" answer runs the full import flow', async () => {
  await withDirAsync(async (dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    let ranEnable = false
    await setup(
      'waku',
      'https://example.test/mcp',
      [{ name: 'Fake', configPath }],
      undefined,
      async () => 'y',
      async () => {
        ranEnable = true
      },
    )
    assert.equal(ranEnable, true)
  })
})

test('setup: "Y" (case-insensitive) and an answer with surrounding whitespace also run the import', async () => {
  await withDirAsync(async (dir) => {
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    let calls = 0
    await setup(
      'waku',
      'https://example.test/mcp',
      [{ name: 'Fake', configPath }],
      undefined,
      async () => '  Y  ',
      async () => {
        calls++
      },
    )
    assert.equal(calls, 1)
  })
})

// The real default `runImport` (setup()'s own comment has the reasoning) is
// deliberately never driven here: it calls runImportCommand, which -- like
// every other real interactive command -- opens a readline interface on the
// *real* process.stdin, exactly the thing every test in this file exists to
// avoid. That the default is literally `runImportCommand(..., { kind: 'ask'
// })`, the same call dispatch()'s own 'import' case makes for the standalone
// command, is what keeps the "unchanged" contract true by construction --
// see the tests above, which cover setup()'s own question in full and only
// ever exercise a fake runImport.

// ---- spec 068 D3: import, full-record, and the capture alias ---------------

test('dispatch: import with no flags -- default window, credential ask, ingest base', () => {
  assert.deepEqual(dispatch(['import']), {
    kind: 'import',
    url: DEFAULT_INGEST_URL,
    windowDays: DEFAULT_WINDOW_DAYS,
    credential: { kind: 'ask' },
  })
})

test('dispatch: import --url --since --key -- the ingest base is derived, the window parsed, the key passed', () => {
  assert.deepEqual(dispatch(['import', '--url', 'https://x.test/mcp', '--since', '30d', '--key', 'mem_sk_x']), {
    kind: 'import',
    url: 'https://x.test',
    windowDays: 30,
    credential: { kind: 'key', key: 'mem_sk_x' },
  })
})

test('dispatch: import --all --login -- every transcript, browser sign-in', () => {
  const d = dispatch(['import', '--all', '--login'])
  assert.equal(d.kind, 'import')
  assert.equal(d.windowDays, null)
  assert.deepEqual(d.credential, { kind: 'login' })
})

test('dispatch: import bad flags are bad-flags naming import', () => {
  for (const argv of [
    ['import', '--since', 'soon'],
    ['import', '--key'],
    ['import', '--key', '--all'],
    ['import', '--login', '--key', 'mem_sk_x'],
  ]) {
    const d = dispatch(argv)
    assert.equal(d.kind, 'bad-flag', argv.join(' '))
    assert.match(d.message, /^waku-memory import: /, argv.join(' '))
  }
})

// 2026-11-20: --answer answers import's "> " for a caller with no terminal.
test('dispatch: import --answer carries the text a person would type, unquoted numbers included', () => {
  assert.equal(dispatch(['import', '--answer', 'all']).answer, 'all')
  assert.equal(dispatch(['import', '--answer', 'n']).answer, 'n')
  assert.equal(dispatch(['import', '--answer', '1 3']).answer, '1 3')
  // An agent that forgets the quotes still sends both numbers, not "1" alone.
  assert.equal(dispatch(['import', '--answer', '1', '3', '--login']).answer, '1 3')
  assert.deepEqual(dispatch(['import', '--answer', '1', '3', '--login']).credential, { kind: 'login' })
  assert.equal('answer' in dispatch(['import']), false)
})

test('dispatch: --answer with no value is a bad-flag, never Enter', () => {
  for (const argv of [
    ['import', '--answer'],
    ['import', '--answer', ''],
    ['import', '--answer', '--all'],
    ['capture', 'enable', '--answer'],
  ]) {
    const d = dispatch(argv)
    assert.equal(d.kind, 'bad-flag', argv.join(' '))
    assert.match(d.message, /--answer requires a value/, argv.join(' '))
  }
})

test('dispatch: --list carries the list id beside --answer, and an empty --list is a bad-flag', () => {
  const d = dispatch(['import', '--list', '7c3e9a1f', '--answer', '1', '3'])
  assert.equal(d.list, '7c3e9a1f')
  assert.equal(d.answer, '1 3')
  assert.equal('list' in dispatch(['import', '--answer', 'n']), false)
  for (const argv of [['import', '--list'], ['import', '--list', '--answer', 'all'], ['capture', 'enable', '--list', '']]) {
    const r = dispatch(argv)
    assert.equal(r.kind, 'bad-flag', argv.join(' '))
    assert.match(r.message, /--list requires the list id/, argv.join(' '))
  }
})

test('dispatch: capture enable --answer reaches the import step', () => {
  const d = dispatch(['capture', 'enable', '--answer', 'n'])
  assert.equal(d.kind, 'capture')
  assert.deepEqual(d.bootstrap, { windowDays: DEFAULT_WINDOW_DAYS, enabled: true, answer: 'n' })
})

test('dispatch: full-record on with no flags -- credential ask, the URL pair', () => {
  assert.deepEqual(dispatch(['full-record', 'on']), {
    kind: 'full-record',
    action: 'on',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
    credential: { kind: 'ask' },
  })
})

test('dispatch: full-record on --url --login and --key', () => {
  assert.deepEqual(dispatch(['full-record', 'on', '--url', 'https://x.test/', '--login']), {
    kind: 'full-record',
    action: 'on',
    url: 'https://x.test',
    mcpUrl: 'https://x.test/mcp',
    credential: { kind: 'login' },
  })
  assert.deepEqual(dispatch(['full-record', 'on', '--key', 'mem_sk_x']).credential, { kind: 'key', key: 'mem_sk_x' })
})

test('dispatch: full-record on bad flags are bad-flags naming full-record on', () => {
  for (const argv of [
    ['full-record', 'on', '--key'],
    ['full-record', 'on', '--login', '--key', 'mem_sk_x'],
  ]) {
    const d = dispatch(argv)
    assert.equal(d.kind, 'bad-flag', argv.join(' '))
    assert.match(d.message, /^waku-memory full-record on: /, argv.join(' '))
  }
})

test('dispatch: full-record off and status', () => {
  assert.deepEqual(dispatch(['full-record', 'off']), {
    kind: 'full-record',
    action: 'off',
    url: DEFAULT_INGEST_URL,
    mcpUrl: DEFAULT_URL,
  })
  assert.deepEqual(dispatch(['full-record', 'status']), { kind: 'full-record', action: 'status' })
})

test('dispatch: full-record with no subcommand, or an unknown one, is a bad-flag listing on/off/status', () => {
  const none = dispatch(['full-record'])
  assert.equal(none.kind, 'bad-flag')
  assert.equal(none.message, 'waku-memory full-record: expected "on", "off" or "status".')
  const bogus = dispatch(['full-record', 'enable'])
  assert.equal(bogus.kind, 'bad-flag')
  assert.equal(bogus.message, 'waku-memory full-record: expected "on", "off" or "status" -- got "enable".')
})

test('dispatch: the capture alias still dispatches enable, disable and status (spec 068 D3, one more release)', () => {
  assert.equal(dispatch(['capture', 'enable']).action, 'enable')
  assert.equal(dispatch(['capture', 'disable']).action, 'disable')
  assert.deepEqual(dispatch(['capture', 'status']), { kind: 'capture', action: 'status' })
  // The shared flag helpers kept capture enable's own wording.
  assert.equal(
    dispatch(['capture', 'enable', '--key']).message,
    'waku-memory capture enable: --key requires a value -- got none.',
  )
})

test('printUsage: lists import and full-record, and no longer lists capture', async () => {
  const out = await captureLog(() => printUsage())
  assert.match(out, /^Most people need only the Waku plugin\. These commands are extras\.$/m)
  assert.match(out, /^Usage: npx waku-memory import \[--url <ingest-base>\] \[--since <N>d\] \[--all\] \[--login\] \[--key <key>\] \[--list <id> --answer <answer>\]$/m)
  assert.match(out, /^Usage: npx waku-memory full-record on \[--url <ingest-base>\] \[--login\] \[--key <key>\]$/m)
  assert.match(out, /^Usage: npx waku-memory full-record off$/m)
  assert.match(out, /^Usage: npx waku-memory full-record status$/m)
  assert.doesNotMatch(out, /capture/i)
})
