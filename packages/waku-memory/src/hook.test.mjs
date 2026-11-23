// The `hook` subcommand's decision logic: given one already-parsed Claude
// Code hook event and a deps bag (configDir + fetchImpl, both injected --
// see cli.ts's runHookCommand for the real ones), what gets posted where,
// and what gets written to the watermark file. Argv dispatch and stdin
// reading are cli.ts's job (cli.test.mjs), not this file's -- see the
// "wired by cli.ts" note on hook.ts's exported shape.
//
// Every test here uses a temp directory as configDir, and an injected
// fetchImpl that never touches the network -- this file must never create
// or depend on a real ~/.waku-memory, and must never make a real HTTP
// request. That is what makes it safe to assert "exactly one POST" instead
// of just "did not crash".
//
// This module is the one place in the shim that sees real conversation
// content (transcript bytes), which is exactly why so many of these tests
// are about the *failure* paths: a hook that raises or hangs degrades the
// user's actual Claude Code session, so "never throws" is load-bearing, not
// a nicety. See hook.ts's own comment on handleHookEvent for the same
// point from the implementation side.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'

import { handleHookEvent, readDelta } from './hook.ts'
import { locationOf } from './project.ts'
// Namespace import for the constants added on 2026-09-04 -- see
// capture.test.mjs for why a namespace rather than a named import.
import * as hookModule from './hook.ts'

// cc-dialogue-v1 records (spec 011 §1), one line each -- the shape
// formatLine actually parses. A bare line like the pre-spec-011 fixtures
// used ('abc\n') is not JSON with a `type` field, so it now formats to
// nothing; every transcript fixture below that needs to actually produce a
// piece uses one of these instead.
const userLine = (text) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n'
const assistantLine = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n'

// codex-dialogue-v1 records (spec 012 §5) -- Codex's rollout shape, the one
// formatCodexLine (dialogue-codex.ts) actually parses: a response_item
// envelope around a message payload with input_text/output_text content.
const codexUserLine = (text) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n'
const codexAssistantLine = (text) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n'

// Async sibling of cli.test.mjs's withDir: every operation under test here
// is a Promise (handleHookEvent posts over injected fetch), so the temp dir
// must not be torn down until that promise settles -- a synchronous
// `fn(dir)` without an await would rmSync the directory out from under a
// still-pending handleHookEvent call.
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waku-hook-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// console.error only -- hook.ts has no reason to ever call console.log, and
// asserting that here would catch a regression that leaked something to the
// wrong stream (stdout is not the promise stderr is: Claude Code's hooks
// reference documents separate handling per stream).
async function captureStderr(fn) {
  const lines = []
  const realError = console.error
  console.error = (...args) => lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.error = realError
  }
  return lines.join('\n')
}

// Stands in for HookDeps.stdout: captures each write as one array entry
// instead of touching the real process.stdout, the same way captureStderr
// stands in for console.error -- see A9's tests below, the only ones that
// exercise this (SessionStart's postBrief is the sole caller of stdout).
function captureStdout() {
  const lines = []
  const stdout = (t) => lines.push(t)
  stdout.lines = lines
  return stdout
}

function writeConfig(configDir, url = 'https://example.test', key = 'sekret') {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ url, key }), 'utf8')
}

// jsonBody (optional): what a .json() call on the fake response resolves
// to -- callers that only care about what was sent (most of this file)
// leave it out; A7's SessionStart test passes the /brief response shape.
// Each recorded call carries `body`, the parsed JSON.parse(init.body), so
// assertions read the request shape directly rather than re-parsing
// call.init.body themselves.
function fakeFetch(status, jsonBody) {
  const calls = []
  const impl = async (url, init) => {
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ url, init, body })
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    }
  }
  impl.calls = calls
  return impl
}

// Mirrors real fetch's own cancellation contract: the returned promise only
// settles when the caller's AbortSignal fires, exactly like a server that
// never responds. Used to prove the SessionEnd path bails out on its own
// timeout rather than waiting on a fetchImpl that -- like a real hung
// connection -- would otherwise never resolve on its own.
function hangingFetch() {
  const impl = (url, init) =>
    new Promise((resolve, reject) => {
      const signal = init && init.signal
      if (!signal) return // no signal wired up -- would hang forever, same as a real stuck request
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
  return impl
}

// ---- handleHookEvent: Stop -----------------------------------------------

test('stop event posts the transcript delta and advances the watermark', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)

    const line1 = userLine('hello')
    const line2 = assistantLine('world')
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, line1 + line2, 'utf8')

    const stateDir = join(configDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 's1'), String(Buffer.byteLength(line1, 'utf8')), 'utf8')

    const fetchImpl = fakeFetch(202)

    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, cwd: '/home/u/proj' },
      { configDir, fetchImpl },
    )

    assert.equal(fetchImpl.calls.length, 1)
    const call = fetchImpl.calls[0]
    assert.equal(call.url, 'https://example.test/ingest/session')
    assert.equal(call.init.method, 'POST')
    assert.equal(call.init.headers.Authorization, 'Bearer sekret')

    const body = JSON.parse(call.init.body)
    assert.equal(body.content, 'assistant: world')
    assert.equal(body.project, 'proj')
    assert.equal(body.harness, 'claude_code')
    assert.equal(body.session_id, 's1')
    assert.equal(body.source, 'stop')

    const newWatermark = readFileSync(join(stateDir, 's1'), 'utf8')
    assert.equal(Number(newWatermark), Buffer.byteLength(line1 + line2, 'utf8'))
  })
})

test('the posted body is the formatted dialogue with content_format, not the transcript bytes', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    writeFileSync(
      transcriptPath,
      userLine('remember: tables') +
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET' }] } }) +
        '\n',
      'utf8',
    )
    const fetchImpl = fakeFetch(202)
    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, cwd: '/x/waku' },
      { configDir, fetchImpl },
    )
    const body = JSON.parse(fetchImpl.calls[0].init.body)
    assert.equal(body.content, 'user: remember: tables')
    assert.equal(body.content_format, 'cc-dialogue-v1')
    assert.doesNotMatch(fetchImpl.calls[0].init.body, /SECRET/)
  })
})

test('A3: a delta whose last line has no newline advances the watermark only to the previous newline', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    const complete = userLine('done')
    writeFileSync(transcriptPath, complete + '{"type":"user","message":{"content":"half', 'utf8')
    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
      { configDir, fetchImpl: fakeFetch(202) },
    )
    assert.equal(readFileSync(join(configDir, 'state', 's1'), 'utf8'), String(Buffer.byteLength(complete)))
  })
})

test('session-end event uses source "session-end"', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('line'), 'utf8')
    const fetchImpl = fakeFetch(202)

    await handleHookEvent(
      { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath, reason: 'other' },
      { configDir, fetchImpl },
    )

    assert.equal(fetchImpl.calls.length, 1)
    const body = JSON.parse(fetchImpl.calls[0].init.body)
    assert.equal(body.source, 'session-end')
    // No cwd on this event -- project must be omitted, not sent as null/"".
    assert.equal('project' in body, false)
  })
})

// A fetch that answers 202 only after `delayMs`, honouring the caller's
// AbortSignal the way real fetch does -- a slow server rather than a hung
// one. Shared by the SessionEnd-budget tests below and the Stop test.
function slowFetch(delayMs) {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const signal = init && init.signal
      const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
      if (signal) signal.addEventListener('abort', onAbort)
      setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve({ ok: true, status: 202 })
      }, delayMs)
    })
}

test('SessionEnd is bounded by its network budget so it cannot hang past the installed hook timeout', async () => {
  // research doc §2: SessionEnd hooks cannot block Claude Code's own exit
  // and must be fire-and-forget; the entry capture.ts installs gives the
  // process SESSION_END_HOOK_TIMEOUT_S, after which it is killed
  // mid-request with no chance to log why. hangingFetch() stands in for a
  // connection that never responds -- if this path is not internally
  // bounded, this test would hang until the suite's own runner timeout,
  // not settle on its own. The budget is injected small here so the test
  // proves "bounded at the budget" without waiting out the real one.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('abc'), 'utf8')

    const fetchImpl = hangingFetch()
    const start = Date.now()

    await assert.doesNotReject(
      handleHookEvent(
        { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath },
        { configDir, fetchImpl, sessionEndTimeoutMs: 100 },
      ),
    )

    const elapsed = Date.now() - start
    // Loose on purpose: the wall clock only has to exclude the 5000 ms
    // default. Which budget the abort landed on is the next test's job,
    // proven by ordering rather than by timing, so a slow CI box cannot
    // fail it.
    assert.ok(elapsed < 3000, `expected the SessionEnd path to bail out well under the default budget, took ${elapsed}ms`)
    // The send never completed -- no watermark should have been written.
    assert.equal(existsSync(join(configDir, 'state', 's1')), false)
  })
})

test('the SessionEnd bound is the budget it was given, proven by ordering rather than by the clock', async () => {
  // Review of 0.1.1: an `elapsed < 500` assertion cannot tell "aborted at
  // the 100 ms budget" from "aborted immediately, whatever the budget".
  // Two runs that differ only in which side of the budget the server
  // lands on can: a reply slower than the budget must be abandoned, and a
  // reply faster than it must be accepted.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('abc'), 'utf8')
    const event = { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath }

    await handleHookEvent(event, { configDir, fetchImpl: slowFetch(400), sessionEndTimeoutMs: 100 })
    assert.equal(existsSync(join(configDir, 'state', 's1')), false, 'a reply slower than the budget was accepted')

    await handleHookEvent(event, { configDir, fetchImpl: slowFetch(100), sessionEndTimeoutMs: 400 })
    assert.equal(existsSync(join(configDir, 'state', 's1')), true, 'a reply faster than the budget was abandoned')
  })
})

test('a SessionEnd post slower than the old 800 ms budget still completes and advances the watermark', async () => {
  // Measured 2026-09-04 from Yang's machine against api.waku.one: three
  // real POST /ingest/session calls took 822, 644 and 1174 ms, so the
  // 800 ms budget (derived from a 1.5 s default the installed entry had
  // already raised to 10 s) aborted two of every three flushes -- the last
  // turn of every session, and all of a single-turn one. This uses the
  // production default on purpose: it is the real constant being proven
  // large enough for a real round trip, not an injected one.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    const line = userLine('abc')
    writeFileSync(transcriptPath, line, 'utf8')

    await handleHookEvent(
      { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath },
      { configDir, fetchImpl: slowFetch(1200) },
    )

    assert.equal(readFileSync(join(configDir, 'state', 's1'), 'utf8'), String(Buffer.byteLength(line)))
  })
})

test('the SessionEnd budget is one deadline across pieces, not one per piece', async () => {
  // Review of task 8: every SessionEnd budget fixture above is a one-line
  // transcript, so all of them are single-piece and would stay green even
  // if `deadline` were computed fresh inside the per-piece loop (or each
  // piece's timer used a plain `budgetMs`) instead of once before the loop.
  // A two-piece transcript closes that gap -- reusing A5's construction:
  // four ~51 KB userLine records, three of which fit one piece under
  // MAX_PIECE_BYTES, so the fourth starts a second piece. With one shared
  // deadline, the first piece's 80 ms leaves the second only ~20 ms of the
  // 100 ms budget, so it is aborted; with a fresh budget per piece, both
  // would land and the watermark would reach the end of the file.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    const lines = [1, 2, 3, 4].map((i) => userLine(`m${i} ` + 'x'.repeat(50 * 1024)))
    writeFileSync(transcriptPath, lines.join(''), 'utf8')

    let calls = 0
    const slow = slowFetch(80)
    const fetchImpl = (url, init) => {
      calls++
      return slow(url, init)
    }

    await assert.doesNotReject(
      handleHookEvent(
        { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath },
        { configDir, fetchImpl, sessionEndTimeoutMs: 100 },
      ),
    )

    const firstPieceEnd = Buffer.byteLength(lines.slice(0, 3).join(''))
    const fileEnd = Buffer.byteLength(lines.join(''))
    const watermark = readFileSync(join(configDir, 'state', 's1'), 'utf8')
    // The first piece landed inside the shared budget...
    assert.equal(watermark, String(firstPieceEnd))
    // ...and the second was abandoned on what was left of it, not sent on a
    // fresh budget of its own.
    assert.ok(calls <= 2, `expected at most 2 fetch calls, got ${calls}`)
    assert.notEqual(Number(watermark), fileEnd)
  })
})

test('the SessionEnd network budget fits under the installed hook timeout with room for npx to start', () => {
  // The process budget is SESSION_END_HOOK_TIMEOUT_S (what capture.ts
  // writes into settings.json); `npx -y waku-memory hook` took 2.8 s to
  // reach our code cold on 2026-09-04, and a real round trip took up to
  // 1.2 s. Both bounds are pinned: shrink the budget under a real round
  // trip and the flush is lost again; grow it past the process budget and
  // Claude Code kills the hook before it can log the outcome.
  assert.ok(
    hookModule.SESSION_END_TIMEOUT_MS >= 2000,
    `network budget ${hookModule.SESSION_END_TIMEOUT_MS}ms is under a measured real round trip`,
  )
  assert.ok(
    hookModule.SESSION_END_TIMEOUT_MS + 2800 <= hookModule.SESSION_END_HOOK_TIMEOUT_S * 1000,
    `network budget ${hookModule.SESSION_END_TIMEOUT_MS}ms + 2800ms npx start exceeds the ${hookModule.SESSION_END_HOOK_TIMEOUT_S}s process budget`,
  )
})

test('Stop is not subject to the SessionEnd timeout', async () => {
  // Confirms the bound above is scoped to SessionEnd only, per the review:
  // Stop has a 600s budget and can run "async": true, so it keeps its
  // unbounded wait. Proven by resolving deliberately *after* the SessionEnd
  // budget this test injects and checking Stop still accepted it, rather
  // than by absence-of-abort (which an unrelated bug could fake).
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('abc'), 'utf8')

    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
      { configDir, fetchImpl: slowFetch(300), sessionEndTimeoutMs: 100 },
    )

    // If Stop were bounded the same way SessionEnd is, this would have been
    // aborted at 100ms, before the 300ms resolve, and the watermark would
    // not exist.
    assert.equal(existsSync(join(configDir, 'state', 's1')), true)
  })
})

test('a rejected fetch names its cause on stderr, not only "fetch failed"', async () => {
  // Measured 2026-09-04 (status.md item 24b): undici wraps every failure as
  // TypeError("fetch failed") and puts the reason on `cause` -- here the
  // real one, an Authorization header carrying a control character. The
  // hook printed only the wrapper and the cause was found by re-running the
  // request by hand. Content and the key are still never printed: a cause
  // names an error class and a code, not what was sent.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('abc'), 'utf8')

    const cause = Object.assign(new Error('invalid Authorization header'), {
      name: 'InvalidArgumentError',
      code: 'UND_ERR_INVALID_ARG',
    })
    const fetchImpl = async () => {
      throw new TypeError('fetch failed', { cause })
    }

    const stderr = await captureStderr(() =>
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.match(stderr, /fetch failed/)
    assert.match(stderr, /UND_ERR_INVALID_ARG/)
    assert.match(stderr, /invalid Authorization header/)
    // Rule 2 of hook.ts's module comment, pinned: neither the key nor a
    // transcript byte reaches stderr, cause or no cause.
    assert.doesNotMatch(stderr, /sekret/)
    assert.doesNotMatch(stderr, /\babc\b/)
  })
})

test('a failed post leaves the watermark unchanged so the delta is re-sent', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)

    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('one') + userLine('two'), 'utf8')

    const stateDir = join(configDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 's1'), '0', 'utf8')

    const fetchImpl = fakeFetch(500)

    await assert.doesNotReject(
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, cwd: '/x/proj' },
        { configDir, fetchImpl },
      ),
    )

    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(readFileSync(join(stateDir, 's1'), 'utf8'), '0')
  })
})

test('A6 (shim half): a 422 on the first piece leaves the watermark unset', async () => {
  // spec 011 §4's deployment order: an API that does not yet know
  // content_format answers 422 to a 0.2.0 shim's request. Handled by the
  // same branch as any other non-2xx (413 excepted) -- the watermark stays
  // put so the whole growing delta is retried once the API deploys.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    writeFileSync(transcriptPath, userLine('hello'), 'utf8')
    const fetchImpl = fakeFetch(422)

    const stderr = await captureStderr(() =>
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.equal(fetchImpl.calls.length, 1)
    assert.match(stderr, /422/)
    assert.equal(existsSync(join(configDir, 'state', 's1')), false)
  })
})

test('a network error from fetch is swallowed, not thrown, and leaves the watermark unchanged', async () => {
  // Stands in for a DNS failure, a connection refused, or a timeout: all
  // three surface the same way from fetch's point of view -- the returned
  // promise rejects rather than resolving with a non-2xx response.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)

    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('abc'), 'utf8')
    const stateDir = join(configDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 's1'), '0', 'utf8')

    const fetchImpl = async () => {
      throw new Error('ENOTFOUND example.test (simulated)')
    }

    await assert.doesNotReject(
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.equal(readFileSync(join(stateDir, 's1'), 'utf8'), '0')
  })
})

test('a 402 (capture paused) prints the server sentence and keeps the watermark', async () => {
  // spec 013 §6: past the trial the door refuses capture. The watermark
  // must stay put -- after an upgrade, the next Stop sends the gap.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('prefer uv over pip'), 'utf8')
    const sentence = 'Capture is paused: the 14-day trial has ended. Upgrade at https://dev.waku.one/account/billing'
    const fetchImpl = fakeFetch(402, { detail: sentence })

    const stderr = await captureStderr(() =>
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's402', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.equal(fetchImpl.calls.length, 1)
    assert.ok(stderr.includes(sentence))
    assert.equal(stderr.trim().split('\n').length, 1)
    assert.equal(existsSync(join(configDir, 'state', 's402')), false)
  })
})

test('a 403 (capture off) prints the server sentence and advances the watermark past the piece', async () => {
  // spec 024 §2: a turn typed while the switch was off is never sent after
  // it is turned on -- the opposite of the 402's "send the gap later".
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    const content = userLine('prefer uv over pip')
    writeFileSync(transcriptPath, content, 'utf8')
    const sentence = 'Capture is off for Claude Code. Turn it on at https://www.waku.one/integrations.'
    const fetchImpl = fakeFetch(403, { detail: { code: 'capture_off', message: sentence } })

    const stderr = await captureStderr(() =>
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's403', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.equal(fetchImpl.calls.length, 1)
    assert.ok(stderr.includes(sentence))
    const watermark = readFileSync(join(configDir, 'state', 's403'), 'utf8').trim()
    assert.equal(Number(watermark), Buffer.byteLength(content))
  })
})

test('a 403 with no usable JSON body (not capture_off) leaves the watermark unchanged', async () => {
  // final review, Important 2: only a 403 whose detail carries
  // code === 'capture_off' takes the capture-off path; anything else --
  // including a 403 whose body is not even JSON, e.g. a proxy's own
  // forbidden page -- falls to the same non-2xx handling as any other
  // refusal (5xx, 401, ...): the watermark is left where it is.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('prefer uv over pip'), 'utf8')
    const fetchImpl = async () => ({
      ok: false,
      status: 403,
      json: async () => { throw new SyntaxError('Unexpected token <') },
      text: async () => '<html>forbidden</html>',
    })

    const stderr = await captureStderr(() =>
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's403b', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.match(stderr, /responded 403 -- watermark left unchanged/)
    assert.equal(existsSync(join(configDir, 'state', 's403b')), false)
  })
})

test('a 413 (content too large) advances the watermark instead of wedging the session forever', async () => {
  // ingest.py's MAX_INGEST_CONTENT_BYTES (262,144) is checked before any
  // repository call, with no server-side chunking -- this exact span can
  // never succeed as-is. Since the watermark only advances on success and
  // the transcript only grows, leaving it unchanged on a 413 would make
  // every later Stop resend an even bigger span that 413s again,
  // permanently losing the rest of the session. Advancing past the refused
  // span is the fix: this one delta is dropped, but later turns are not.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    // One record whose own text is over the 256 KiB ingest cap -- the one
    // shape that can still 413 after formatting (spec 011 §3: this is a
    // single record, so it lands in its own piece regardless of size).
    const content = userLine('x'.repeat(300_000))
    writeFileSync(transcriptPath, content, 'utf8')

    const fetchImpl = fakeFetch(413)

    const stderr = await captureStderr(() =>
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.equal(fetchImpl.calls.length, 1)
    assert.match(stderr, /413/)
    const watermark = readFileSync(join(configDir, 'state', 's1'), 'utf8')
    assert.equal(Number(watermark), Buffer.byteLength(content, 'utf8'))
    // spec 011 §3: the drop is also recorded as a span beside the
    // watermark, so bootstrap (§8) can see this session has a hole.
    assert.match(readFileSync(join(configDir, 'state', 's1.dropped'), 'utf8'), /^0-\d+\n$/)
  })
})

test('a 413 writes the dropped marker beside the watermark and advances past the piece', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    const line = userLine('big')
    writeFileSync(transcriptPath, line, 'utf8')
    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
      { configDir, fetchImpl: fakeFetch(413) },
    )
    assert.equal(readFileSync(join(configDir, 'state', 's1'), 'utf8'), String(Buffer.byteLength(line)))
    assert.match(readFileSync(join(configDir, 'state', 's1.dropped'), 'utf8'), /^0-\d+\n$/)
  })
})

test('an empty delta sends nothing', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)

    const transcriptPath = join(dir, 'transcript.jsonl')
    const content = 'one\ntwo\n'
    writeFileSync(transcriptPath, content, 'utf8')

    const stateDir = join(configDir, 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 's1'), String(Buffer.byteLength(content, 'utf8')), 'utf8')

    const fetchImpl = fakeFetch(202)

    const stderr = await captureStderr(() =>
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )

    assert.equal(fetchImpl.calls.length, 0)
    assert.match(stderr, /nothing new/i)
  })
})

test('a Stop event with no transcript_path is a logged no-op, not a throw', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const fetchImpl = fakeFetch(202)

    const stderr = await captureStderr(() =>
      handleHookEvent({ hook_event_name: 'Stop', session_id: 's1' }, { configDir, fetchImpl }),
    )

    assert.equal(fetchImpl.calls.length, 0)
    assert.ok(stderr.trim().length > 0)
  })
})

// ---- handleHookEvent: Stop, last_assistant_message (spec 011 §2) --------

test('A4: last_assistant_message is appended when the file lacks it, and not when the file has it', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    writeFileSync(transcriptPath, userLine('what is a B-tree?'), 'utf8')
    const f1 = fakeFetch(202)
    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, last_assistant_message: 'A balanced tree.' },
      { configDir, fetchImpl: f1 },
    )
    assert.equal(JSON.parse(f1.calls[0].init.body).content, 'user: what is a B-tree?\n\nassistant: A balanced tree.')

    // The transcript now genuinely holds the reply -- the trailing run
    // (everything after the last user: entry, which is the whole delta
    // here since there is no new user: entry) already reads it, so it must
    // not be appended a second time.
    appendFileSync(transcriptPath, assistantLine('A balanced tree.'), 'utf8')
    const f2 = fakeFetch(202)
    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, last_assistant_message: 'A balanced tree.' },
      { configDir, fetchImpl: f2 },
    )
    assert.equal(JSON.parse(f2.calls[0].init.body).content, 'assistant: A balanced tree.')
  })
})

test('A4: a two-block final assistant turn matching last_assistant_message is sent once, not appended again', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    const twoBlockTurn =
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'A balanced tree.' }, { type: 'text', text: 'It keeps keys sorted.' }] },
      }) + '\n'
    writeFileSync(transcriptPath, userLine('what is a B-tree?') + twoBlockTurn, 'utf8')
    const fetchImpl = fakeFetch(202)

    await handleHookEvent(
      {
        hook_event_name: 'Stop',
        session_id: 's1',
        transcript_path: transcriptPath,
        last_assistant_message: 'A balanced tree.\n\nIt keeps keys sorted.',
      },
      { configDir, fetchImpl },
    )

    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(
      JSON.parse(fetchImpl.calls[0].init.body).content,
      'user: what is a B-tree?\n\nassistant: A balanced tree.\n\nassistant: It keeps keys sorted.',
    )
  })
})

test('A4: an assistant block that itself holds a blank line, matching last_assistant_message, is sent once', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    const message = 'First paragraph.\n\nSecond paragraph.'
    writeFileSync(transcriptPath, userLine('tell me a story') + assistantLine(message), 'utf8')
    const fetchImpl = fakeFetch(202)

    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, last_assistant_message: message },
      { configDir, fetchImpl },
    )

    const body = JSON.parse(fetchImpl.calls[0].init.body)
    assert.equal(body.content, `user: tell me a story\n\nassistant: ${message}`)
    assert.equal((body.content.match(/First paragraph/g) ?? []).length, 1)
  })
})

test('A4: a last_assistant_message matching an earlier turn, with a trailing user: entry, is appended', async () => {
  // "Done." occurred before, but the trailing run (after the last user:
  // entry) is empty -- only the trailing run is searched (spec 011 §2), so
  // this is not mistaken for already present.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    writeFileSync(transcriptPath, assistantLine('Done.') + userLine('one more thing'), 'utf8')
    const fetchImpl = fakeFetch(202)

    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, last_assistant_message: 'Done.' },
      { configDir, fetchImpl },
    )

    assert.equal(
      JSON.parse(fetchImpl.calls[0].init.body).content,
      'assistant: Done.\n\nuser: one more thing\n\nassistant: Done.',
    )
  })
})

test('A5: a 450 KiB delta goes as three pieces; a failure on the second leaves the watermark at the first piece\'s end', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 't.jsonl')
    const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => userLine(`m${i} ` + 'x'.repeat(50 * 1024)))
    writeFileSync(transcriptPath, lines.join(''), 'utf8')
    const ok = fakeFetch(202)
    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 'all', transcript_path: transcriptPath },
      { configDir, fetchImpl: ok },
    )
    assert.equal(ok.calls.length, 3)
    for (const c of ok.calls) assert.ok(Buffer.byteLength(JSON.parse(c.init.body).content) < 200 * 1024)
    assert.equal(readFileSync(join(configDir, 'state', 'all'), 'utf8'), String(Buffer.byteLength(lines.join(''))))

    let n = 0
    const failSecond = async (_url, _init) => {
      n++
      return { ok: n !== 2, status: n === 2 ? 500 : 202 }
    }
    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 'partial', transcript_path: transcriptPath },
      { configDir, fetchImpl: failSecond },
    )
    assert.equal(n, 2) // the third piece is never sent
    const firstPieceEnd = Buffer.byteLength(lines.slice(0, 3).join(''))
    assert.equal(readFileSync(join(configDir, 'state', 'partial'), 'utf8'), String(firstPieceEnd))
  })
})

// ---- handleHookEvent: SessionStart ---------------------------------------

test('SHIM_VERSION matches package.json version', () => {
  // hook.ts's SHIM_VERSION is a hand-maintained constant, not read from
  // package.json at runtime (by design -- see its comment) -- but this
  // checks the two have not drifted apart. Reading package.json here, in
  // the test, is fine; hook.ts itself must not.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(hookModule.SHIM_VERSION, pkg.version)
})

test('A9: SessionStart posts to /brief and gives its text to the session', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config'); writeConfig(configDir, 'https://example.test')
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ text: 'Waku memory for project waku (1 of 1):\n- [preference] tables', memory_ids: [], shown: 1, visible: 1 }) } }
    const stdout = captureStdout()
    await handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku' }, { configDir, fetchImpl, stdout })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://example.test/brief')
    assert.equal(calls[0].init.method, 'POST')
    // session_id travels in every /brief request now (spec 012 §4, task 8
    // ruling R4's neighbor) -- not just Codex's.
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      harness: 'claude_code',
      version: hookModule.SHIM_VERSION,
      project: 'waku',
      session_id: 's1',
      // spec 063: the session's location, for the server to resolve its project.
      ...locationOf('/x/waku'),
    })
    // The text is the session's context; the line beside it is what the
    // person sees (2026-10-11).
    assert.deepEqual(stdout.lines.map((l) => JSON.parse(l)), [
      {
        systemMessage: 'Waku added 1 standing preference to this session, out of 1 saved memory',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'Waku memory for project waku (1 of 1):\n- [preference] tables',
        },
      },
    ])
  })
})

test('spec 071 D8: SessionStart sends its source, so a compaction resets what was shown', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config'); writeConfig(configDir, 'https://example.test')
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ text: 'Waku memory for project waku.', memory_ids: [], shown: 0, visible: 0 }) } }
    await handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku', source: 'compact' }, { configDir, fetchImpl, stdout: captureStdout() })
    assert.equal(JSON.parse(calls[0].init.body).source, 'compact')
    // A value no harness sends is left out rather than refused by the server.
    await handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku', source: 'x'.repeat(51) }, { configDir, fetchImpl, stdout: captureStdout() })
    assert.equal('source' in JSON.parse(calls[1].init.body), false)
  })
})

test('SessionStart stays plain text for Claude Code when /brief answers no counts', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config'); writeConfig(configDir, 'https://example.test')
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ text: 'Waku memory for project waku.' }) })
    const stdout = captureStdout()
    await handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku' }, { configDir, fetchImpl, stdout })
    assert.deepEqual(stdout.lines, ['Waku memory for project waku.'])
  })
})

test('A9: nothing reaches stdout on 401, on timeout, or with no config -- stdout is context', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    for (const [label, deps] of [
      ['no config', { configDir, fetchImpl: fakeFetch(200) }],
    ]) {
      const stdout = captureStdout()
      await captureStderr(() => handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x' }, { ...deps, stdout }))
      assert.deepEqual(stdout.lines, [], label)
    }
    writeConfig(configDir)
    for (const [label, fetchImpl] of [['401', fakeFetch(401)], ['hang', hangingFetch()]]) {
      const stdout = captureStdout()
      const stderr = await captureStderr(() => handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x' }, { configDir, fetchImpl, stdout, briefTimeoutMs: 50 }))
      assert.deepEqual(stdout.lines, [], label)
      assert.ok(stderr.trim().length > 0, label)
    }
  })
})

test('A9: a SessionStart with no cwd sends no request at all', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config'); writeConfig(configDir)
    const fetchImpl = fakeFetch(200)
    const stdout = captureStdout()
    const stderr = await captureStderr(() => handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1' }, { configDir, fetchImpl, stdout }))
    assert.equal(fetchImpl.calls.length, 0)
    assert.deepEqual(stdout.lines, [])
    assert.match(stderr, /no cwd/)
  })
})

test('a 200 from /brief with no usable text prints nothing to stdout and one line to stderr', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config'); writeConfig(configDir, 'https://example.test')
    const testBodies = [
      { body: {}, label: 'missing text' },
      { body: { text: 42 }, label: 'non-string text' }
    ]
    for (const { body, label } of testBodies) {
      const fetchImpl = async (url, init) => ({ ok: true, status: 200, json: async () => body })
      const stdout = captureStdout()
      const stderr = await captureStderr(() => handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku' }, { configDir, fetchImpl, stdout }))
      assert.deepEqual(stdout.lines, [], label)
      const stderrLines = stderr.split('\n').filter(l => l.trim().length > 0)
      assert.equal(stderrLines.length, 1, label)
      assert.match(stderr, /no usable text/, label)
    }
  })
})

test('a 200 from /brief with empty text, a brief withheld for an experiment, prints nothing anywhere', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config'); writeConfig(configDir, 'https://example.test')
    const body = { text: '', memory_ids: [], shown: 0, visible: 0 }
    const fetchImpl = async (url, init) => ({ ok: true, status: 200, json: async () => body })
    const stdout = captureStdout()
    const stderr = await captureStderr(() => handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku' }, { configDir, fetchImpl, stdout }))
    assert.deepEqual(stdout.lines, [])
    assert.equal(stderr.trim(), '')
  })
})

test('a 200 from /brief whose body is not JSON prints nothing to stdout and one line to stderr', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config'); writeConfig(configDir, 'https://example.test')
    const fetchImpl = async (url, init) => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } })
    const stdout = captureStdout()
    const stderr = await captureStderr(() => handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku' }, { configDir, fetchImpl, stdout }))
    assert.deepEqual(stdout.lines, [])
    const stderrLines = stderr.split('\n').filter(l => l.trim().length > 0)
    assert.equal(stderrLines.length, 1)
    assert.match(stderr, /POST \/brief failed/)
  })
})

// ---- handleHookEvent: UserPromptSubmit (spec 023 §2) ----------------------

test('UserPromptSubmit posts the marker with the prompt, and a 204 prints nothing', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const fetchImpl = fakeFetch(204)
    const stdout = captureStdout()
    await hookModule.handleHookEvent(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
        cwd: dir,
        prompt: '怎么部署到生产',
      },
      { configDir: dir, fetchImpl, stdout },
    )
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(fetchImpl.calls[0].url, 'https://example.test/ingest/turn')
    // spec 029: the prompt travels for one injection search, which the
    // server stores nowhere; the marker is still ids and a timestamp.
    assert.deepEqual(fetchImpl.calls[0].body, {
      harness: 'claude_code',
      session_id: 'sess-1',
      project: basename(dir),
      ...locationOf(dir),
      prompt: '怎么部署到生产',
    })
    // A server from before spec 029 answers 204: nothing to say to the model.
    assert.deepEqual(stdout.lines, [])
  })
})

test('UserPromptSubmit gives Claude Code the context and shows the person what was added', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const context = 'Waku memories that may bear on this prompt.\n- [decision, 2026-09-12] deploy.yml'
    const fetchImpl = fakeFetch(200, { context })
    const stdout = captureStdout()
    await hookModule.handleHookEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-9', cwd: dir, prompt: 'deploy' },
      { configDir: dir, fetchImpl, stdout },
    )
    assert.deepEqual(stdout.lines.map((l) => JSON.parse(l)), [
      {
        systemMessage: 'Waku added 1 memory to this prompt: "deploy.yml"',
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      },
    ])
  })
})

test('UserPromptSubmit stays plain text for Claude Code when the context names no memory', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const fetchImpl = fakeFetch(200, { context: 'notes' })
    const stdout = captureStdout()
    await hookModule.handleHookEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-9b', cwd: dir, prompt: 'deploy' },
      { configDir: dir, fetchImpl, stdout },
    )
    assert.deepEqual(stdout.lines, ['notes'])
  })
})

test('UserPromptSubmit prints the injected context for Codex in the hook contract', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const fetchImpl = fakeFetch(200, { context: 'notes' })
    const stdout = captureStdout()
    await hookModule.handleHookEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'thr-9', cwd: dir, prompt: 'deploy' },
      { configDir: dir, harness: 'codex', fetchImpl, stdout },
    )
    assert.deepEqual(stdout.lines.map((l) => JSON.parse(l)), [
      { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'notes' } },
    ])
  })
})

test('UserPromptSubmit shows a Codex person what was added', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const context = 'Waku memories that may bear on this prompt.\n- [fact, 2026-10-01] 端口改成 8080'
    const fetchImpl = fakeFetch(200, { context })
    const stdout = captureStdout()
    await hookModule.handleHookEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'thr-9b', cwd: dir, prompt: '端口' },
      { configDir: dir, harness: 'codex', fetchImpl, stdout },
    )
    assert.deepEqual(stdout.lines.map((l) => JSON.parse(l)), [
      {
        systemMessage: 'Waku added 1 memory to this prompt: "端口改成 8080"',
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
      },
    ])
  })
})

test('UserPromptSubmit prints nothing for a null context or an unreadable body', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    for (const fetchImpl of [
      fakeFetch(200, { context: null }),
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad') } }),
    ]) {
      const stdout = captureStdout()
      await captureStderr(() =>
        hookModule.handleHookEvent(
          { hook_event_name: 'UserPromptSubmit', session_id: 'sess-10', cwd: dir, prompt: 'hi' },
          { configDir: dir, fetchImpl, stdout },
        ),
      )
      assert.deepEqual(stdout.lines, [])
    }
  })
})

test('UserPromptSubmit sends the harness profile it was given', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const fetchImpl = fakeFetch(204)
    await hookModule.handleHookEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'thr-1', cwd: dir },
      { configDir: dir, harness: 'codex', fetchImpl },
    )
    assert.equal(fetchImpl.calls[0].body.harness, 'codex')
  })
})

test('UserPromptSubmit with the server never answering exits inside its budget', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const started = Date.now()
    const stderr = await captureStderr(() =>
      hookModule.handleHookEvent(
        { hook_event_name: 'UserPromptSubmit', session_id: 'sess-2', cwd: dir },
        { configDir: dir, briefTimeoutMs: 120, fetchImpl: hangingFetch() },
      ),
    )
    // Acceptance 9: the hook exits inside its budget with the server
    // unreachable. A marker must never hold a turn open.
    assert.ok(Date.now() - started < 2000, 'the hook outlived its own budget')
    assert.match(stderr, /ingest\/turn/)
  })
})

test('R4: the next turn reports the previous hook\'s time and its timeouts, then clears the count', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const event = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-t', cwd: dir, prompt: 'deploy' }
    const ok = fakeFetch(204)
    // The first hook has nothing to report yet; it records its own time.
    await hookModule.handleHookEvent(event, { configDir: dir, fetchImpl: ok, elapsedMs: () => 412.4 })
    assert.equal('hook_ms' in ok.calls[0].body, false)
    // The next one times out, so it reports nothing and counts itself.
    await captureStderr(() => hookModule.handleHookEvent(event, {
      configDir: dir, briefTimeoutMs: 50, fetchImpl: hangingFetch(), elapsedMs: () => 3051,
    }))
    // The third carries the second's time and the one timeout.
    await hookModule.handleHookEvent(event, { configDir: dir, fetchImpl: ok, elapsedMs: () => 380 })
    assert.equal(ok.calls[1].body.hook_ms, 3051)
    assert.equal(ok.calls[1].body.hook_timeouts, 1)
    // A 2xx delivered the count, so the fourth reports none.
    await hookModule.handleHookEvent(event, { configDir: dir, fetchImpl: ok, elapsedMs: () => 390 })
    assert.equal(ok.calls[2].body.hook_ms, 380)
    assert.equal(ok.calls[2].body.hook_timeouts, 0)
  })
})

test('R4: a /brief that times out is counted for the next turn to report', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const ok = fakeFetch(204)
    const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-b', cwd: dir, prompt: 'x' }
    await hookModule.handleHookEvent(prompt, { configDir: dir, fetchImpl: ok, elapsedMs: () => 200 })
    await captureStderr(() => hookModule.handleHookEvent(
      { hook_event_name: 'SessionStart', session_id: 'sess-b', cwd: dir, source: 'compact' },
      { configDir: dir, briefTimeoutMs: 50, fetchImpl: hangingFetch() },
    ))
    await hookModule.handleHookEvent(prompt, { configDir: dir, fetchImpl: ok, elapsedMs: () => 210 })
    assert.equal(ok.calls[1].body.hook_ms, 200)
    assert.equal(ok.calls[1].body.hook_timeouts, 1)
  })
})

test('UserPromptSubmit with no config sends nothing and never throws', async () => {
  await withDir(async (dir) => {
    const fetchImpl = fakeFetch(204)
    const stderr = await captureStderr(() =>
      hookModule.handleHookEvent(
        { hook_event_name: 'UserPromptSubmit', session_id: 'sess-3', cwd: dir },
        { configDir: dir, fetchImpl },
      ),
    )
    assert.equal(fetchImpl.calls.length, 0)
    assert.match(stderr, /no usable config/)
  })
})

test('UserPromptSubmit on Codex stays silent without a credential (ruling R4)', async () => {
  await withDir(async (dir) => {
    const fetchImpl = fakeFetch(204)
    const stdout = captureStdout()
    const stderr = await captureStderr(() =>
      hookModule.handleHookEvent(
        { hook_event_name: 'UserPromptSubmit', session_id: 'thr-2', cwd: dir },
        { configDir: dir, harness: 'codex', fetchImpl, stdout },
      ),
    )
    assert.equal(fetchImpl.calls.length, 0)
    assert.equal(stderr, '')
    assert.deepEqual(stdout.lines, [])
  })
})

test('UserPromptSubmit logs a non-2xx and lets the prompt proceed', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const stderr = await captureStderr(() =>
      hookModule.handleHookEvent(
        { hook_event_name: 'UserPromptSubmit', session_id: 'sess-4', cwd: dir },
        { configDir: dir, fetchImpl: fakeFetch(500) },
      ),
    )
    // No throw, and one line naming the status. A missing marker costs
    // attribution for one turn and nothing else.
    assert.match(stderr, /500/)
  })
})

// ---- handleHookEvent: harness profiles (spec 012 §4) ---------------------

test('A7: codex SessionStart posts the heartbeat and the brief with session_id and prints the contract', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const fetchImpl = fakeFetch(200, {
      text: 'Waku memory for project waku (1 of 1; memory_search finds the rest):\n- [fact] x',
      memory_ids: [],
      shown: 1,
      visible: 1,
    })
    const stdout = captureStdout()
    await handleHookEvent(
      { hook_event_name: 'SessionStart', session_id: 'thr-1', cwd: dir, source: 'startup' },
      { configDir: dir, fetchImpl, stdout, harness: 'codex' },
    )
    const brief = fetchImpl.calls.find((c) => c.url.endsWith('/brief'))
    assert.deepEqual(brief.body, { harness: 'codex', version: hookModule.SHIM_VERSION, project: basename(dir), session_id: 'thr-1', ...locationOf(dir), source: 'startup' })
    assert.equal(stdout.lines.length, 1)
    const printed = JSON.parse(stdout.lines[0])
    assert.equal(printed.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(printed.hookSpecificOutput.additionalContext, /^Waku memory for project/)
  })
})

test('A7: codex Stop sends codex-dialogue-v1 pieces with harness codex and session_id', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'rollout.jsonl')
    writeFileSync(transcriptPath, codexUserLine('hi') + codexAssistantLine('hello'), 'utf8')
    const fetchImpl = fakeFetch(202)

    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, cwd: '/x/proj' },
      { configDir, fetchImpl, harness: 'codex' },
    )

    assert.equal(fetchImpl.calls.length, 1)
    const body = fetchImpl.calls[0].body
    assert.equal(body.content_format, 'codex-dialogue-v1')
    assert.equal(body.harness, 'codex')
    assert.equal(body.session_id, 's1')
    assert.equal(body.content, 'user: hi\n\nassistant: hello')
  })
})

test('A7: codex SessionEnd shares one 2000 ms deadline across pieces', async () => {
  // Mirrors the claude_code shared-deadline tests above, with no
  // sessionEndTimeoutMs override -- proving the *profile's* 2000 ms default
  // is what bounds Codex's SessionEnd, not claude_code's 5000 ms one. A
  // reply slower than the budget (2500 ms) must be abandoned: if this used
  // the claude_code default instead, the reply would land inside 5000 ms and
  // the watermark would exist.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'rollout.jsonl')
    writeFileSync(transcriptPath, codexUserLine('abc'), 'utf8')

    const start = Date.now()
    await handleHookEvent(
      { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath },
      { configDir, fetchImpl: slowFetch(2500), harness: 'codex' },
    )
    const elapsed = Date.now() - start

    assert.ok(elapsed < 2500, `expected the codex SessionEnd path to abort before the 2500ms reply, took ${elapsed}ms`)
    assert.equal(existsSync(join(configDir, 'state', 's1')), false)
  })
})

test('A7: claude_code output is unchanged (plain text)', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir, 'https://example.test')
    const text = 'Waku memory for project waku (1 of 1):\n- [preference] tables'
    const fetchImpl = fakeFetch(200, { text })
    const stdout = captureStdout()

    await handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/x/waku' }, { configDir, fetchImpl, stdout })

    assert.deepEqual(stdout.lines, [text])
    // The A9 test above already pins the exact text; this pins that it is
    // NOT the Codex hook JSON contract -- plain text does not parse as JSON.
    assert.throws(() => JSON.parse(stdout.lines[0]))
  })
})

test('A7: without a key, every codex event exits quietly', async () => {
  // Ruling R4 (spec 012 §4.1): Codex-only, quiet without a credential -- no
  // fetch call, no stdout, no stderr, for every event kind.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config') // never created -- config.json absent
    const transcriptPath = join(dir, 'rollout.jsonl')
    writeFileSync(transcriptPath, codexUserLine('abc'), 'utf8')
    const events = [
      { hook_event_name: 'SessionStart', session_id: 's1', cwd: dir },
      { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath },
      { hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: transcriptPath },
    ]

    for (const event of events) {
      const fetchImpl = fakeFetch(200, {})
      const stdout = captureStdout()
      const stderr = await captureStderr(() =>
        handleHookEvent(event, { configDir, fetchImpl, stdout, harness: 'codex' }),
      )
      assert.equal(fetchImpl.calls.length, 0, event.hook_event_name)
      assert.deepEqual(stdout.lines, [], event.hook_event_name)
      assert.equal(stderr, '', event.hook_event_name)
    }
  })
})

// ---- handleHookEvent: config and dispatch edge cases ---------------------

test('missing config is a logged no-op, exit not thrown', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config') // never created -- config.json absent
    const fetchImpl = fakeFetch(202)

    const stderr = await captureStderr(() =>
      handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1' }, { configDir, fetchImpl }),
    )

    assert.equal(fetchImpl.calls.length, 0)
    const nonBlank = stderr.split('\n').filter((l) => l.trim().length > 0)
    assert.equal(nonBlank.length, 1)
  })
})

test('a config.json that fails to parse is treated the same as a missing one', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), '{ not valid json', 'utf8')
    const fetchImpl = fakeFetch(202)

    const stderr = await captureStderr(() =>
      handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1' }, { configDir, fetchImpl }),
    )

    assert.equal(fetchImpl.calls.length, 0)
    assert.ok(stderr.trim().length > 0)
  })
})

test('a config.json missing the key field is treated the same as a missing one', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ url: 'https://example.test' }), 'utf8')
    const fetchImpl = fakeFetch(202)

    await handleHookEvent({ hook_event_name: 'SessionStart', session_id: 's1' }, { configDir, fetchImpl })

    assert.equal(fetchImpl.calls.length, 0)
  })
})

test('an unhandled event kind is one stderr line and no fetch calls', async () => {
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const fetchImpl = fakeFetch(202)

    const stderr = await captureStderr(() =>
      handleHookEvent({ hook_event_name: 'PostToolUse', session_id: 's1' }, { configDir, fetchImpl }),
    )

    assert.equal(fetchImpl.calls.length, 0)
    const nonBlank = stderr.split('\n').filter((l) => l.trim().length > 0)
    assert.equal(nonBlank.length, 1)
  })
})

test('malformed events (null, a bare number) never throw out of handleHookEvent', async () => {
  // Stands in for the shape JSON.parse can hand back for degenerate but
  // still-valid JSON on stdin (e.g. the literal text "null" or "42") --
  // cli.ts's run() parses stdin and passes the result straight through
  // without a runtime shape check, so handleHookEvent is the last line of
  // defense before this would otherwise throw on `event.hook_event_name`.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config') // absent -- must not matter, these
    // events are rejected before any config read is attempted
    const fetchImpl = fakeFetch(202)

    await assert.doesNotReject(handleHookEvent(null, { configDir, fetchImpl }))
    await assert.doesNotReject(handleHookEvent(42, { configDir, fetchImpl }))
    assert.equal(fetchImpl.calls.length, 0)
  })
})

test('a Stop event with a non-string session_id does not throw', async () => {
  // HookEvent's type says session_id is a string, but nothing enforces that
  // at runtime against whatever cli.ts's JSON.parse handed back -- a
  // non-string here would make path.join throw inside postDelta's watermark
  // path if handleHookEvent's catch-all were not there to back it up.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('abc'), 'utf8')
    const fetchImpl = fakeFetch(202)

    await assert.doesNotReject(
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 12345, transcript_path: transcriptPath },
        { configDir, fetchImpl },
      ),
    )
  })
})

test('a Stop event with a non-string cwd does not throw', async () => {
  // Same concern as session_id above, for the basename(event.cwd) call.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, userLine('abc'), 'utf8')
    const fetchImpl = fakeFetch(202)

    await assert.doesNotReject(
      handleHookEvent(
        { hook_event_name: 'Stop', session_id: 's1', transcript_path: transcriptPath, cwd: 12345 },
        { configDir, fetchImpl },
      ),
    )
  })
})

test('a session_id with embedded path separators cannot escape configDir/state', async () => {
  // session_id arrives parsed from stdin and is used as a path segment for
  // the watermark file -- unsanitized, "../../../evil" would walk the
  // watermark path outside configDir/state entirely. Same-user trust
  // boundary limits the blast radius, but there is no reason to rely on
  // that alone when basename() removes the footgun for free.
  await withDir(async (dir) => {
    const configDir = join(dir, 'config')
    writeConfig(configDir)
    const transcriptPath = join(dir, 'transcript.jsonl')
    const content = userLine('abc')
    writeFileSync(transcriptPath, content, 'utf8')
    const fetchImpl = fakeFetch(202)

    await handleHookEvent(
      { hook_event_name: 'Stop', session_id: '../../../evil', transcript_path: transcriptPath },
      { configDir, fetchImpl },
    )

    // Lands inside configDir/state, named by the sanitized (basename-only)
    // id -- never outside configDir.
    const written = readFileSync(join(configDir, 'state', 'evil'), 'utf8')
    assert.equal(Number(written), Buffer.byteLength(content, 'utf8'))
    assert.equal(existsSync(join(dir, 'evil')), false) // did not escape upward out of configDir
  })
})

// ---- readDelta -------------------------------------------------------

test('readDelta: no watermark file yet means offset 0 -- the whole transcript is the delta', async () => {
  await withDir(async (dir) => {
    const transcriptPath = join(dir, 'transcript.jsonl')
    const content = userLine('abc') + userLine('def')
    writeFileSync(transcriptPath, content, 'utf8')
    const watermarkPath = join(dir, 'state', 's1') // parent dir does not even exist yet

    const delta = readDelta(transcriptPath, watermarkPath)

    assert.equal(delta.offset, 0)
    assert.equal(delta.end, Buffer.byteLength(content, 'utf8'))
    assert.equal(delta.pieces.length, 1)
    assert.equal(delta.pieces[0].text, 'user: abc\n\nuser: def')
    assert.equal(delta.pieces[0].end, Buffer.byteLength(content, 'utf8'))
  })
})

test('readDelta: a missing transcript file is null, not a throw', async () => {
  await withDir(async (dir) => {
    const transcriptPath = join(dir, 'does-not-exist.jsonl')
    const watermarkPath = join(dir, 'watermark')

    assert.equal(readDelta(transcriptPath, watermarkPath), null)
  })
})

test('readDelta: a garbled watermark file falls back to offset 0 rather than throwing', async () => {
  await withDir(async (dir) => {
    const transcriptPath = join(dir, 'transcript.jsonl')
    const content = userLine('abc')
    writeFileSync(transcriptPath, content, 'utf8')
    const watermarkPath = join(dir, 'watermark')
    writeFileSync(watermarkPath, 'not-a-number', 'utf8')

    const delta = readDelta(transcriptPath, watermarkPath)

    assert.equal(delta.offset, 0)
    assert.equal(delta.end, Buffer.byteLength(content, 'utf8'))
    assert.equal(delta.pieces.length, 1)
    assert.equal(delta.pieces[0].text, 'user: abc')
  })
})

test('readDelta: a numeric-prefixed but garbled watermark falls back to 0, not the numeric prefix', async () => {
  // Number.parseInt("1200\x00junk", 10) === 1200, not NaN -- a bare
  // parseInt check trusts a corrupted file that happens to start with
  // valid digits. If that trusted offset exceeds the real transcript size,
  // readDelta reports "nothing new" while genuinely-unsent content sits
  // unsent: silent data loss, not merely an extra resend.
  await withDir(async (dir) => {
    const transcriptPath = join(dir, 'transcript.jsonl')
    const content = userLine('abc')
    writeFileSync(transcriptPath, content, 'utf8')
    const watermarkPath = join(dir, 'watermark')
    writeFileSync(watermarkPath, '1200\x00garbage', 'utf8')

    const delta = readDelta(transcriptPath, watermarkPath)

    assert.equal(delta.offset, 0)
    assert.equal(delta.end, Buffer.byteLength(content, 'utf8'))
    assert.equal(delta.pieces.length, 1)
    assert.equal(delta.pieces[0].text, 'user: abc')
  })
})

test('readDelta: offset at or past the file size is null (nothing new)', async () => {
  await withDir(async (dir) => {
    const transcriptPath = join(dir, 'transcript.jsonl')
    const content = userLine('abc')
    writeFileSync(transcriptPath, content, 'utf8')
    const watermarkPath = join(dir, 'watermark')
    writeFileSync(watermarkPath, String(Buffer.byteLength(content, 'utf8')), 'utf8')

    assert.equal(readDelta(transcriptPath, watermarkPath), null)
  })
})

test('readDelta: a delta that is only an incomplete trailing line is null, not an empty-pieces result', async () => {
  // Distinct from offset-at-file-size above: the watermark is 0 and the
  // file has bytes past it, but none of them form a complete line yet
  // (spec 011 §2 -- a read landing inside a write must not send half a
  // JSON record). formatDelta's relative `end` stays 0 in this case;
  // readDelta turns that into null so the caller's "nothing new" branch
  // fires instead of posting zero pieces and advancing the watermark to 0.
  await withDir(async (dir) => {
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(transcriptPath, '{"type":"user","message":{"content":"half', 'utf8') // no trailing newline
    const watermarkPath = join(dir, 'watermark')

    assert.equal(readDelta(transcriptPath, watermarkPath), null)
  })
})

test('spec 063: a turn inside a git checkout sends its cwd, root and remote, without credentials', async () => {
  await withDir(async (dir) => {
    writeConfig(dir)
    const repo = join(dir, 'waku-memory-backend')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'shim'), { recursive: true })
    writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://ian:tok@github.com/ShenSeanChen/waku-memory-backend.git\n')
    const fetchImpl = fakeFetch(204)
    await hookModule.handleHookEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'sess-063', cwd: join(repo, 'shim'), prompt: 'ship it' },
      { configDir: dir, fetchImpl, stdout: captureStdout() },
    )
    const body = fetchImpl.calls[0].body
    assert.equal(body.cwd, join(repo, 'shim'))
    assert.deepEqual(body.repo, { root: repo, remote: 'github.com/shenseanchen/waku-memory-backend' })
    assert.equal(JSON.stringify(body).includes('tok'), false)
  })
})
