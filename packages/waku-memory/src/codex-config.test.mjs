// The Codex config writers (spec 012 §4.2, §4.3, §4.6): the `[mcp_servers.waku]`
// TOML table appended to ~/.codex/config.toml with a line scan (no TOML
// parser, no dependency -- `codex mcp add` was measured to clobber and
// reserialise the whole file, per the task brief), the three `command`/
// `command_windows` hook entries merged into ~/.codex/hooks.json the same
// replace-ours-keep-foreign way capture.ts's mergeHookSettings does for
// Claude Code's settings.json, the personal marketplace entry, and plugin
// detection. Pure functions over strings and objects, injected I/O where a
// real filesystem read is unavoidable (codexPluginPresent) -- Task 10 wires
// the real paths and atomic writes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CODEX_TOML_TABLE,
  mergeCodexToml,
  removeCodexToml,
  codexHookEntries,
  isOwnCodexEntry,
  mergeCodexHooks,
  removeCodexHooks,
  WAKU_MARKETPLACE_ENTRY,
  mergeMarketplaceEntry,
  codexPluginPresent,
} from './codex-config.ts'
// Namespace import for the same reason hook.test.mjs and capture.test.mjs
// use one: a missing named export fails only the test that reads it,
// rather than taking the whole file down with a link-time SyntaxError.
import * as codexModule from './codex-config.ts'

const OUR_URL = 'https://api.waku.one/mcp'

// A 30-line fixture in the shape this machine's real ~/.codex/config.toml
// actually has (read once, read-only, to get the table names right --
// values below are invented, not copied): a top-level notify array and
// model keys, a [desktop] table, an [mcp_servers.node_repl] table with its
// own nested [mcp_servers.node_repl.env] table, and a trailing [windows]
// table. Ends with a trailing newline, like a real file saved by an editor.
const FIXTURE = [
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

const APPENDED_BLOCK = `\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\ndefault_tools_approval_mode = "approve"\n`

test('mergeCodexToml appends exactly the table block and leaves every earlier byte identical', () => {
  const out = mergeCodexToml(FIXTURE, OUR_URL)
  assert.equal(out.result, 'wrote')
  assert.equal(out.text.slice(0, FIXTURE.length), FIXTURE)
  assert.equal(out.text.slice(FIXTURE.length), APPENDED_BLOCK)
})

test('mergeCodexToml on a fixture with no trailing newline adds one before the table', () => {
  const noTrailingNewline = FIXTURE.slice(0, -1) // drop the fixture's own trailing "\n"
  const out = mergeCodexToml(noTrailingNewline, OUR_URL)
  assert.equal(out.result, 'wrote')
  // The header still starts its own line -- a newline was inserted first --
  // and exactly one blank line separates it from the fixture's last line,
  // same as when the fixture already ended in a newline (the appended
  // block always opens with its own blank-line newline).
  assert.equal(out.text, noTrailingNewline + '\n' + APPENDED_BLOCK)
})

test('mergeCodexToml is unchanged on a second merge, with identical text', () => {
  const once = mergeCodexToml(FIXTURE, OUR_URL)
  const twice = mergeCodexToml(once.text, OUR_URL)
  assert.equal(twice.result, 'unchanged')
  assert.equal(twice.text, once.text)
})

test('mergeCodexToml refuses a table with a different url, and leaves the text identical', () => {
  const withOther = `${FIXTURE}\n[mcp_servers.waku]\nurl = "https://other/mcp"\n`
  const out = mergeCodexToml(withOther, OUR_URL)
  assert.equal(out.result, 'refused')
  assert.equal(out.text, withOther)
})

test('mergeCodexToml treats single-quoted urls the same as double-quoted for the comparison', () => {
  // The approval line is included here (also single-quoted) so this test
  // isolates what it means to test -- the url-unquoting comparison -- from
  // the separate missing-approval-line behavior covered below. A url-only
  // single-quoted table taking the insert path is covered separately by
  // 'mergeCodexToml inserts the double-quoted approval line after a
  // single-quoted url-only url line', below.
  const withSingleQuoted = `${FIXTURE}\n[mcp_servers.waku]\nurl = '${OUR_URL}'\ndefault_tools_approval_mode = 'approve'\n`
  const out = mergeCodexToml(withSingleQuoted, OUR_URL)
  assert.equal(out.result, 'unchanged')
  assert.equal(out.text, withSingleQuoted)
})

// ---- missing default_tools_approval_mode line (2026-09-08 measurement) ----
//
// A table with our url but no `default_tools_approval_mode` line is what
// the old codexNote told people to write by hand, and exactly what was
// measured left on a real machine on 2026-09-08 (still unfixed 2026-09-17):
// `mergeCodexToml` used to compare only the url and call this 'unchanged',
// so the approval line -- the one thing that keeps `codex exec` from
// hanging on a tool-call approval prompt -- was never added. It must now be
// inserted immediately after the `url` line and reported as 'wrote'.

const DEFAULT_APPROVAL_LINE = 'default_tools_approval_mode = "approve"'

test('mergeCodexToml adds the missing approval line right after url when the table has our url but no approval line', () => {
  const urlOnly = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n`
  const out = mergeCodexToml(urlOnly, OUR_URL)
  assert.equal(out.result, 'wrote')
  const expected = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n${DEFAULT_APPROVAL_LINE}\n`
  assert.equal(out.text, expected)
  // Every byte up to and including the url line is untouched -- only the
  // inserted line is new.
  const urlLineEnd = urlOnly.length
  assert.equal(out.text.slice(0, urlLineEnd), urlOnly)
})

test('mergeCodexToml adds the missing approval line using the file\'s own CRLF line ending', () => {
  const urlOnlyCRLF = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n`.replace(/\n/g, '\r\n')
  const out = mergeCodexToml(urlOnlyCRLF, OUR_URL)
  assert.equal(out.result, 'wrote')
  const expected = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n${DEFAULT_APPROVAL_LINE}\n`.replace(/\n/g, '\r\n')
  assert.equal(out.text, expected)
  assert.equal(out.text.slice(0, urlOnlyCRLF.length), urlOnlyCRLF)
})

test('mergeCodexToml is unchanged when the table already has default_tools_approval_mode with a different value -- a deliberate choice is not overwritten', () => {
  const withPrompt = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\ndefault_tools_approval_mode = "prompt"\n`
  const out = mergeCodexToml(withPrompt, OUR_URL)
  assert.equal(out.result, 'unchanged')
  assert.equal(out.text, withPrompt)
})

test('mergeCodexToml adds the line to a url-only waku table even when a later table already has its own approval line, and leaves that later table untouched', () => {
  const existing =
    `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n\n` +
    `[mcp_servers.other]\ndefault_tools_approval_mode = "prompt"\n`
  const out = mergeCodexToml(existing, OUR_URL)
  assert.equal(out.result, 'wrote')
  const expected =
    `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n${DEFAULT_APPROVAL_LINE}\n\n` +
    `[mcp_servers.other]\ndefault_tools_approval_mode = "prompt"\n`
  assert.equal(out.text, expected)
})

test('removeCodexToml removes the block after mergeCodexToml adds the missing approval line to a url-only table (round trip)', () => {
  const urlOnly = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n`
  const merged = mergeCodexToml(urlOnly, OUR_URL)
  assert.equal(merged.result, 'wrote')
  const removed = removeCodexToml(merged.text, OUR_URL)
  assert.equal(removed.result, 'removed')
  assert.equal(removed.text, FIXTURE)
})

test('removeCodexToml removes exactly the block mergeCodexToml wrote, round-tripping to the original bytes', () => {
  const merged = mergeCodexToml(FIXTURE, OUR_URL)
  const removed = removeCodexToml(merged.text, OUR_URL)
  assert.equal(removed.result, 'removed')
  assert.equal(removed.text, FIXTURE)
})

test('removeCodexToml is nothing when the table\'s url differs from ours', () => {
  const withOther = `${FIXTURE}\n[mcp_servers.waku]\nurl = "https://other/mcp"\n`
  const out = removeCodexToml(withOther, OUR_URL)
  assert.equal(out.result, 'nothing')
  assert.equal(out.text, withOther)
})

test('removeCodexToml is nothing when a person added another line inside our table', () => {
  const withExtraLine = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\ndefault_tools_approval_mode = "approve"\n# do not remove\n`
  const out = removeCodexToml(withExtraLine, OUR_URL)
  assert.equal(out.result, 'nothing')
  assert.equal(out.text, withExtraLine)
})

test('removeCodexToml is nothing when the table is not there at all', () => {
  const out = removeCodexToml(FIXTURE, OUR_URL)
  assert.equal(out.result, 'nothing')
  assert.equal(out.text, FIXTURE)
})

// R22 (final review, spec 012): a `[mcp_servers.waku.env]` table right
// after ours is a TOML sub-table of [mcp_servers.waku], not a sibling --
// findWakuTable's endIdx stops there like it would at any other header, so
// the old code saw exactly our two lines as the whole body and happily
// removed our header/url/approval lines, leaving the sub-table in the file.
// TOML then implicitly recreates mcp_servers.waku, empty, the moment that
// sub-table is parsed -- silently orphaning it with no url. Refuse instead.
test('removeCodexToml refuses when a [mcp_servers.waku.*] sub-table follows ours, leaving the file untouched', () => {
  const withSubTable = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\ndefault_tools_approval_mode = "approve"\n[mcp_servers.waku.env]\nSOME_VAR = "1"\n`
  const out = removeCodexToml(withSubTable, OUR_URL)
  assert.equal(out.result, 'nothing')
  assert.equal(out.text, withSubTable)
})

// ---- mid-file table (bug measured on a real machine, 2026-09-17) ----------
//
// Codex itself commonly appends tables after ours (e.g. `[projects.'...']`
// when a directory is trusted), so the body [headerIdx, endIdx) almost
// always carries a trailing blank line -- the separator before the next
// header -- that is not content of ours. The old `body.length === 2` check
// counted that separator as a third body line and refused every time,
// silently defeating 0.4.3's "enable removes the duplicate table" and, since
// spec 012, `capture disable` as well, on every real machine where anything
// follows our table. Trailing blanks in the body must be ignored for the
// length check, and must be *kept* (not removed) since they are the
// separator that already existed before our next-header boundary.

const REAL_SHAPE_LF = [
  'enabled = false',
  '',
  CODEX_TOML_TABLE,
  `url = "${OUR_URL}"`,
  DEFAULT_APPROVAL_LINE,
  '',
  '[windows]',
  'sandbox = "elevated"',
  '',
].join('\n')

test('removeCodexToml removes our table when it sits between another table\'s "enabled = false" and [windows] (the real shape measured on a real machine, LF)', () => {
  const out = removeCodexToml(REAL_SHAPE_LF, OUR_URL)
  assert.equal(out.result, 'removed')
  const expected = ['enabled = false', '', '[windows]', 'sandbox = "elevated"', ''].join('\n')
  assert.equal(out.text, expected)
})

test('removeCodexToml removes the same mid-file table on a CRLF file', () => {
  const realShapeCRLF = REAL_SHAPE_LF.replace(/\n/g, '\r\n')
  const out = removeCodexToml(realShapeCRLF, OUR_URL)
  assert.equal(out.result, 'removed')
  const expected = ['enabled = false', '', '[windows]', 'sandbox = "elevated"', ''].join('\r\n')
  assert.equal(out.text, expected)
})

test('removeCodexToml on a merge-then-remove round trip: a [projects.\'...\'] table appended after our block survives untouched, byte-for-byte', () => {
  const merged = mergeCodexToml(FIXTURE, OUR_URL)
  assert.equal(merged.result, 'wrote')
  const projectsTable = "[projects.'c:\\work']\ntrust_level = \"trusted\"\n"
  const withProjects = merged.text + projectsTable
  const out = removeCodexToml(withProjects, OUR_URL)
  assert.equal(out.result, 'removed')
  assert.equal(out.text, FIXTURE + projectsTable)
})

test('removeCodexToml is nothing when an extra non-blank line sits inside our table mid-file, text identical', () => {
  const withExtraMidFile = [
    'enabled = false',
    '',
    CODEX_TOML_TABLE,
    `url = "${OUR_URL}"`,
    DEFAULT_APPROVAL_LINE,
    '# do not remove',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ].join('\n')
  const out = removeCodexToml(withExtraMidFile, OUR_URL)
  assert.equal(out.result, 'nothing')
  assert.equal(out.text, withExtraMidFile)
})

test('removeCodexToml mid-file, followed by two blank lines then a header -- removed, the two blank lines left as they were', () => {
  const withTwoBlanks = [
    'enabled = false',
    '',
    CODEX_TOML_TABLE,
    `url = "${OUR_URL}"`,
    DEFAULT_APPROVAL_LINE,
    '',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ].join('\n')
  const out = removeCodexToml(withTwoBlanks, OUR_URL)
  assert.equal(out.result, 'removed')
  const expected = ['enabled = false', '', '', '[windows]', 'sandbox = "elevated"', ''].join('\n')
  assert.equal(out.text, expected)
})

test('mergeCodexToml on a mid-file url-only table inserts the approval line right after url, before the separator blank, and a second merge is unchanged', () => {
  const urlOnlyMidFile = [
    'enabled = false',
    '',
    CODEX_TOML_TABLE,
    `url = "${OUR_URL}"`,
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ].join('\n')
  const once = mergeCodexToml(urlOnlyMidFile, OUR_URL)
  assert.equal(once.result, 'wrote')
  const expected = [
    'enabled = false',
    '',
    CODEX_TOML_TABLE,
    `url = "${OUR_URL}"`,
    DEFAULT_APPROVAL_LINE,
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ].join('\n')
  assert.equal(once.text, expected)
  const twice = mergeCodexToml(once.text, OUR_URL)
  assert.equal(twice.result, 'unchanged')
  assert.equal(twice.text, once.text)
})

// ---- CRLF line ending preservation ------------------------------------------

test('mergeCodexToml preserves CRLF line endings: appends with CRLF and every byte before the table is identical', () => {
  const fixtureCRLF = FIXTURE.replace(/\n/g, '\r\n')
  const out = mergeCodexToml(fixtureCRLF, OUR_URL)
  assert.equal(out.result, 'wrote')
  // The original fixture (converted to CRLF) should be byte-for-byte identical in the output.
  assert.equal(out.text.slice(0, fixtureCRLF.length), fixtureCRLF)
  // The appended block should use CRLF, not LF.
  const expectedBlockCRLF = `\r\n${CODEX_TOML_TABLE}\r\nurl = "${OUR_URL}"\r\ndefault_tools_approval_mode = "approve"\r\n`
  assert.equal(out.text.slice(fixtureCRLF.length), expectedBlockCRLF)
  // Verify no bare \n that is not preceded by \r.
  const lines = out.text.split('\r\n')
  for (const line of lines.slice(0, -1)) {
    assert.ok(!line.includes('\n'), `Line should not contain bare \\n: ${JSON.stringify(line)}`)
  }
})

test('mergeCodexToml on a CRLF file: a second merge is unchanged', () => {
  const fixtureCRLF = FIXTURE.replace(/\n/g, '\r\n')
  const once = mergeCodexToml(fixtureCRLF, OUR_URL)
  const twice = mergeCodexToml(once.text, OUR_URL)
  assert.equal(twice.result, 'unchanged')
  assert.equal(twice.text, once.text)
})

test('removeCodexToml on a CRLF file: removes the block and returns the original bytes', () => {
  const fixtureCRLF = FIXTURE.replace(/\n/g, '\r\n')
  const merged = mergeCodexToml(fixtureCRLF, OUR_URL)
  const removed = removeCodexToml(merged.text, OUR_URL)
  assert.equal(removed.result, 'removed')
  assert.equal(removed.text, fixtureCRLF)
})

test('mergeCodexToml on a CRLF file with an existing table with our URL is unchanged', () => {
  const withOurTable = `${FIXTURE}\n[mcp_servers.waku]\nurl = "${OUR_URL}"\ndefault_tools_approval_mode = "approve"\n`
  const withOurTableCRLF = withOurTable.replace(/\n/g, '\r\n')
  const out = mergeCodexToml(withOurTableCRLF, OUR_URL)
  assert.equal(out.result, 'unchanged')
  assert.equal(out.text, withOurTableCRLF)
})

test('mergeCodexToml on a CRLF file with an existing table with a different URL is refused', () => {
  const withOtherTable = `${FIXTURE}\n[mcp_servers.waku]\nurl = "https://other/mcp"\ndefault_tools_approval_mode = "approve"\n`
  const withOtherTableCRLF = withOtherTable.replace(/\n/g, '\r\n')
  const out = mergeCodexToml(withOtherTableCRLF, OUR_URL)
  assert.equal(out.result, 'refused')
  assert.equal(out.text, withOtherTableCRLF)
})

test('mergeCodexToml inserts the double-quoted approval line after a single-quoted url-only url line', () => {
  // Both quoting styles count as "our url" (unquoteTomlValue), but the
  // insert path itself -- finding the url line and splicing the (always
  // double-quoted) DEFAULT_APPROVAL_LINE in right after it -- was never
  // exercised with a single-quoted url line taking that path. It must work
  // the same as the double-quoted case: 'wrote', the new line inserted
  // right after the (still single-quoted, untouched) url line.
  const urlOnlySingleQuoted = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = '${OUR_URL}'\n`
  const out = mergeCodexToml(urlOnlySingleQuoted, OUR_URL)
  assert.equal(out.result, 'wrote')
  const expected = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = '${OUR_URL}'\n${DEFAULT_APPROVAL_LINE}\n`
  assert.equal(out.text, expected)
})

test('mergeCodexToml inserts the approval line inside our table, before a [mcp_servers.waku.env] sub-table that follows a url-only table', () => {
  // findWakuTable's endIdx (shared by the insert path) stops at the first
  // following `[...]` header, whether that is an unrelated table or, as
  // here, a genuine TOML sub-table of ours. The insertion must still land
  // right after `url` and strictly before that header, and the sub-table's
  // own body must come through byte-for-byte untouched.
  const withSubTable = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n[mcp_servers.waku.env]\nSOME_VAR = "1"\n`
  const out = mergeCodexToml(withSubTable, OUR_URL)
  assert.equal(out.result, 'wrote')
  const expected = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n${DEFAULT_APPROVAL_LINE}\n[mcp_servers.waku.env]\nSOME_VAR = "1"\n`
  assert.equal(out.text, expected)
})

test('mergeCodexToml on a url-only table: merging twice is idempotent', () => {
  // The existing "unchanged on a second merge" tests above (FIXTURE and its
  // CRLF variant) only exercise the append-a-new-table path -- the first
  // merge appends the whole block including the approval line, so the
  // second merge sees an already-complete table. This pins the insert path
  // itself running twice: first merge inserts the missing approval line and
  // reports 'wrote', second merge on that same result finds it already
  // there and reports 'unchanged' with byte-identical text.
  const urlOnly = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n`
  const once = mergeCodexToml(urlOnly, OUR_URL)
  assert.equal(once.result, 'wrote')
  const twice = mergeCodexToml(once.text, OUR_URL)
  assert.equal(twice.result, 'unchanged')
  assert.equal(twice.text, once.text)
})

test('mergeCodexToml inserts the approval line with no trailing newline when the url-only table is the last thing in the file', () => {
  // Same no-trailing-newline fixture convention as "mergeCodexToml on a
  // fixture with no trailing newline adds one before the table" above
  // (slice off the fixture's own trailing "\n") -- but that test exercises
  // the append-a-new-table path, whose base-plus-lineEnding branch always
  // adds a newline back before the new block. This is the insert path
  // instead: joinLines is handed the same hadTrailingNewline it read going
  // in, so a file with no trailing newline stays that way -- the approval
  // line is inserted, but no newline is added after it.
  const urlOnlyNoTrailingNewline = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"`
  const out = mergeCodexToml(urlOnlyNoTrailingNewline, OUR_URL)
  assert.equal(out.result, 'wrote')
  const expected = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n${DEFAULT_APPROVAL_LINE}`
  assert.equal(out.text, expected)
  assert.equal(out.text.endsWith('\n'), false)
})

test('mergeCodexToml still inserts the approval line when a comment that only looks like the key is inside our table', () => {
  // APPROVAL_LINE_RE requires the line to start (modulo leading whitespace)
  // with `default_tools_approval_mode =` -- a `#`-prefixed comment does not
  // match, so it must not be mistaken for an existing approval line. The
  // real line is still inserted (right after `url`, before the comment),
  // result 'wrote', and the comment itself is left in place untouched.
  const withComment = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n# default_tools_approval_mode was removed\n`
  const out = mergeCodexToml(withComment, OUR_URL)
  assert.equal(out.result, 'wrote')
  const expected = `${FIXTURE}\n${CODEX_TOML_TABLE}\nurl = "${OUR_URL}"\n${DEFAULT_APPROVAL_LINE}\n# default_tools_approval_mode was removed\n`
  assert.equal(out.text, expected)
})

// ---- hook entries -----------------------------------------------------

const INDEX_PATH = '/c/Users/fake/.codex/hook/0.2.0/index.js'

test('codexHookEntries has four keys with command, command_windows and the right timeouts', () => {
  // spec 023 §2 added UserPromptSubmit alongside the original three -- this
  // test otherwise unchanged from before that task.
  const entries = codexHookEntries(INDEX_PATH)
  assert.deepEqual(Object.keys(entries).sort(), ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])

  const sessionStart = entries.SessionStart[0].hooks[0]
  assert.ok(sessionStart.command.includes(' hook --harness codex'))
  assert.ok(sessionStart.command_windows.includes(' hook --harness codex'))
  assert.ok(sessionStart.command_windows.includes('\\'))
  assert.equal(sessionStart.timeout, 5)
  assert.equal(sessionStart.statusMessage, 'Waku memory')
  assert.equal(entries.SessionStart[0].matcher, 'startup|resume|clear|compact')

  const stop = entries.Stop[0].hooks[0]
  assert.equal(stop.timeout, 600)
  assert.equal(stop.async, true)
  assert.equal(stop.statusMessage, undefined)

  const sessionEnd = entries.SessionEnd[0].hooks[0]
  assert.equal(sessionEnd.timeout, 3) // PROFILES.codex.sessionEndHookTimeoutS
  assert.equal(sessionEnd.async, undefined)
  assert.equal(sessionEnd.statusMessage, undefined)
})

test('the Codex file route registers UserPromptSubmit too', () => {
  const entries = codexModule.codexHookEntries('/x/.waku-memory/hook/index.js')
  assert.deepEqual(
    Object.keys(entries).sort(),
    ['SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'],
  )
  assert.equal(entries.UserPromptSubmit[0].hooks[0].timeout, 5)
})

test('isOwnCodexEntry is true for a command containing " hook --harness codex" in either field', () => {
  assert.equal(isOwnCodexEntry({ type: 'command', command: 'node "x/index.js" hook --harness codex' }), true)
  assert.equal(
    isOwnCodexEntry({ type: 'command', command: 'something-else', command_windows: 'node "x\\index.js" hook --harness codex' }),
    true,
  )
})

test('isOwnCodexEntry is false for a non-string command, and does not throw', () => {
  assert.equal(isOwnCodexEntry({ command: 42 }), false)
})

test('isOwnCodexEntry is false for Claude Code\'s exec-form entry', () => {
  assert.equal(isOwnCodexEntry({ type: 'command', command: 'C:/Program Files/nodejs/node.exe', args: ['x/index.js', 'hook'] }), false)
})

test('isOwnCodexEntry is false for a command that merely contains "waku"', () => {
  assert.equal(isOwnCodexEntry({ type: 'command', command: 'echo waku' }), false)
})

test('mergeCodexHooks replaces ours and keeps a foreign entry under Stop', () => {
  const foreign = { type: 'command', command: 'their-tool' }
  const existing = { hooks: { Stop: [{ hooks: [foreign] }] } }
  const merged = mergeCodexHooks(existing, INDEX_PATH)
  assert.equal(merged.hooks.Stop.length, 2)
  assert.deepEqual(merged.hooks.Stop[0].hooks[0], foreign)
  assert.ok(isOwnCodexEntry(merged.hooks.Stop[1].hooks[0]))

  const mergedAgain = mergeCodexHooks(merged, INDEX_PATH)
  assert.deepEqual(mergedAgain, merged) // idempotent: no second copy of ours
})

test('removeCodexHooks removes only ours and deletes the emptied event key', () => {
  const foreign = { type: 'command', command: 'their-tool' }
  const withForeignAndOurs = mergeCodexHooks({ hooks: { Stop: [{ hooks: [foreign] }] } }, INDEX_PATH)
  const removed = removeCodexHooks(withForeignAndOurs)
  assert.equal(removed.hooks.Stop.length, 1)
  assert.deepEqual(removed.hooks.Stop[0].hooks[0], foreign)
  // SessionStart and SessionEnd had nothing foreign -- once ours is gone,
  // the key itself must go too, not survive as an empty array.
  assert.equal('SessionStart' in removed.hooks, false)
  assert.equal('SessionEnd' in removed.hooks, false)
})

// ---- marketplace entry --------------------------------------------------

test('mergeMarketplaceEntry(undefined) creates the personal marketplace with just our entry', () => {
  const out = mergeMarketplaceEntry(undefined)
  assert.equal(out.result, 'wrote')
  assert.deepEqual(out.data, { name: 'personal', interface: { displayName: 'Personal' }, plugins: [WAKU_MARKETPLACE_ENTRY] })
})

test('mergeMarketplaceEntry appends ours once, keeping the file\'s own keys and other plugins', () => {
  const existing = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [{ name: 'someone-elses-plugin' }] }
  const out = mergeMarketplaceEntry(existing)
  assert.equal(out.result, 'wrote')
  assert.equal(out.data.name, 'personal')
  assert.deepEqual(out.data.plugins, [{ name: 'someone-elses-plugin' }, WAKU_MARKETPLACE_ENTRY])
})

test('mergeMarketplaceEntry is unchanged when ours is already present', () => {
  const existing = { name: 'personal', interface: { displayName: 'Personal' }, plugins: [WAKU_MARKETPLACE_ENTRY] }
  const out = mergeMarketplaceEntry(existing)
  assert.equal(out.result, 'unchanged')
  assert.deepEqual(out.data, existing)
})

// ---- plugin detection -----------------------------------------------------

test('codexPluginPresent is true when config.toml has a [plugins."waku@<marketplace>"] table, even with no cache dir', () => {
  const toml = `${FIXTURE}\n[plugins."waku@personal"]\nenabled = true\n`
  const io = { existsSync: () => { throw new Error('should not be called') }, readdirSync: () => { throw new Error('should not be called') } }
  assert.equal(codexPluginPresent(toml, '/nonexistent/cache/dir', io), true)
})

test('codexPluginPresent: true when <cache>/<marketplace>/waku exists, via injected io', () => {
  const io = {
    existsSync: (p) => p.replace(/\\/g, '/') === '/cache/personal/waku',
    readdirSync: () => ['personal', 'other-marketplace'],
  }
  assert.equal(codexPluginPresent(FIXTURE, '/cache', io), true)
})

test('codexPluginPresent is false when neither the TOML table nor the cache directory says so', () => {
  const io = { existsSync: () => false, readdirSync: () => ['personal'] }
  assert.equal(codexPluginPresent(FIXTURE, '/cache', io), false)
})

test('codexPluginPresent is false (not thrown) when the plugins cache directory does not exist', () => {
  const io = {
    existsSync: () => false,
    readdirSync: () => {
      const err = new Error('ENOENT')
      err.code = 'ENOENT'
      throw err
    },
  }
  assert.equal(codexPluginPresent(FIXTURE, '/nonexistent/cache/dir', io), false)
})

// R21 (final review, spec 012): the config.toml table is now authoritative
// when present -- a lingering cache directory from an uninstalled plugin, or
// a table that explicitly says `enabled = false`, must not read as
// installed. The cache probe below is the fallback for when the table is
// absent altogether; the throwing io in the first two of these proves that
// fallback is never reached once a table exists, the same way the existing
// "even with no cache dir" test above already proves it for the no-`enabled`
// case.

test('codexPluginPresent: table with no enabled key is true, cache probe not consulted', () => {
  const toml = `${FIXTURE}\n[plugins."waku@personal"]\n`
  const io = { existsSync: () => { throw new Error('should not be called') }, readdirSync: () => { throw new Error('should not be called') } }
  assert.equal(codexPluginPresent(toml, '/nonexistent/cache/dir', io), true)
})

test('codexPluginPresent: table with enabled = false is false, even when the cache dir has waku', () => {
  const toml = `${FIXTURE}\n[plugins."waku@personal"]\nenabled = false\n`
  const io = {
    existsSync: (p) => p.replace(/\\/g, '/') === '/cache/personal/waku',
    readdirSync: () => ['personal'],
  }
  assert.equal(codexPluginPresent(toml, '/cache', io), false)
})

test('codexPluginPresent: single-quoted table key is true', () => {
  const toml = `${FIXTURE}\n[plugins.'waku@personal']\nenabled = true\n`
  const io = { existsSync: () => { throw new Error('should not be called') }, readdirSync: () => { throw new Error('should not be called') } }
  assert.equal(codexPluginPresent(toml, '/nonexistent/cache/dir', io), true)
})

test('codexPluginPresent: no table, cache dir has waku -- true (unchanged)', () => {
  const io = {
    existsSync: (p) => p.replace(/\\/g, '/') === '/cache/personal/waku',
    readdirSync: () => ['personal', 'other-marketplace'],
  }
  assert.equal(codexPluginPresent(FIXTURE, '/cache', io), true)
})

test('codexPluginPresent: no table, no cache -- false', () => {
  const io = { existsSync: () => false, readdirSync: () => ['personal'] }
  assert.equal(codexPluginPresent(FIXTURE, '/cache', io), false)
})
