// `login`'s flow (spec 012 §7) against a fake authorization server and a
// fake API, both real node:http servers on 127.0.0.1:0 -- never a real
// browser, never real waku.one. The injected `openBrowser` stands in for
// the person: it parses `state` (and, in the happy path, `code_challenge`
// and `redirect_uri`) out of the URL login() would otherwise open, and
// drives the loopback callback itself via `fetch`, exactly the shape
// login.ts's own header comment describes as the thing under test.
//
// Every test uses a temp directory for configDir (never a real
// ~/.waku-memory) and closes both fake servers in a `finally`, the same
// discipline hook.test.mjs's withDir uses -- a server left listening would
// hang `node --test` on exit.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import { login } from './login.ts'

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// An unsigned JWT: header.payload.signature, base64url, no signature check
// on either end -- login.ts's emailFromIdToken decodes the middle segment
// only, exactly matching what a real id_token's payload looks like.
function fakeIdToken(email) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url')
  return `${header}.${payload}.`
}

// Supabase's own answer, verbatim, when a redirect_uri does not exact-match
// what was registered -- measured against the deployed service, 2026-09-08.
// This is the shape login.ts's bug (a bare '/callback' registered ahead of
// the listener's ephemeral port ever being known) actually triggered there;
// reproducing it here is what makes a regression in login.ts's registration
// ordering fail loudly in this test file too, instead of only in production.
function invalidRedirectUriResponse(res) {
  jsonResponse(res, 400, { code: 400, error_code: 'validation_failed', msg: 'invalid redirect_uri' })
}

// The fake authorization server: discovery metadata, dynamic registration,
// the authorize endpoint, and the token endpoint. `opts.registerStatus` lets
// the registration test make /register fail without a second server
// implementation. `opts.tokenDelayMs` adds a delay to the token response to
// simulate a slow exchange and allow a second callback to arrive mid-flight.
//
// /register now records the `redirect_uris` it was given
// (state.registeredRedirectUris), and /authorize and /token both reject a
// `redirect_uri` that is not in that list, the way Supabase does -- this
// server never implemented RFC 8252 §7.3's loopback any-port exception, so a
// client that registered the bare address and then used the listener's real
// port (the bug this file's login() fix corrects) gets refused here exactly
// as it did against the deployed service. Before that ordering fix, this
// validation is what turns "login: happy path ..." red: the old code
// registered 'http://127.0.0.1/callback' but exchanged the code with
// 'http://127.0.0.1:<port>/callback', so the token call below would 400.
function startAuthServer(opts = {}) {
  const state = { tokenCalls: [], registeredRedirectUris: [] }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      const base = `http://127.0.0.1:${server.address().port}`
      jsonResponse(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      if (opts.registerStatus && opts.registerStatus !== 200) {
        res.writeHead(opts.registerStatus)
        res.end()
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        state.registeredRedirectUris = Array.isArray(parsed.redirect_uris) ? parsed.redirect_uris : []
        jsonResponse(res, 200, { client_id: 'c1' })
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri')
      if (!state.registeredRedirectUris.includes(redirectUri)) {
        invalidRedirectUriResponse(res)
        return
      }
      // Never actually visited by login.ts (it only opens this URL in a
      // real browser); reachable here only by a test driving it directly.
      res.writeHead(200)
      res.end()
      return
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const params = Object.fromEntries(new URLSearchParams(body))
        if (!state.registeredRedirectUris.includes(params.redirect_uri)) {
          invalidRedirectUriResponse(res)
          return
        }
        state.tokenCalls.push(params)
        const sendResponse = () => {
          jsonResponse(res, 200, { access_token: 'tok', id_token: fakeIdToken('person@example.test') })
        }
        if (opts.tokenDelayMs) {
          setTimeout(sendResponse, opts.tokenDelayMs)
        } else {
          sendResponse()
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return { server, state }
}

// The fake API: the protected-resource metadata (pointing at the
// authorization server above) and /keys, which asserts the bearer is
// exactly the access token /token minted.
function startApiServer(issuerUrl) {
  const state = { keysCalls: [] }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      const base = `http://127.0.0.1:${server.address().port}`
      jsonResponse(res, 200, { resource: `${base}/mcp`, authorization_servers: [issuerUrl] })
      return
    }
    if (req.method === 'POST' && url.pathname === '/keys') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const parsed = JSON.parse(body)
        state.keysCalls.push({ authorization: req.headers['authorization'], label: parsed.label })
        jsonResponse(res, 201, { id: 'k1', plaintext: 'mem_sk_test', label: parsed.label })
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  return { server, state }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

// Starts both fake servers, hands the test a temp configDir and apiBase,
// and tears everything down afterward regardless of outcome.
async function withServers(authOpts, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'waku-login-test-'))
  const auth = startAuthServer(authOpts)
  const api = { server: undefined, state: undefined }
  try {
    await listen(auth.server)
    const issuerUrl = `http://127.0.0.1:${auth.server.address().port}`
    const started = startApiServer(issuerUrl)
    api.server = started.server
    api.state = started.state
    await listen(api.server)
    const apiBase = `http://127.0.0.1:${api.server.address().port}`

    await fn({ dir, apiBase, authState: auth.state, apiState: api.state })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await close(auth.server)
    if (api.server) await close(api.server)
  }
}

test('login: happy path mints a key over the loopback callback and writes config.json', async () => {
  await withServers({}, async ({ dir, apiBase, authState, apiState }) => {
    const stdoutLines = []
    let captured
    let callbackResponseText

    const result = await login({
      apiBase,
      configDir: dir,
      fetchImpl: fetch,
      openBrowser: (url) => {
        const parsed = new URL(url)
        captured = {
          state: parsed.searchParams.get('state'),
          challenge: parsed.searchParams.get('code_challenge'),
          redirectUri: parsed.searchParams.get('redirect_uri'),
          scope: parsed.searchParams.get('scope'),
          resource: parsed.searchParams.get('resource'),
        }
        callbackResponseText = fetch(`${captured.redirectUri}?code=abc&state=${captured.state}`).then((r) => r.text())
      },
      stdout: (text) => stdoutLines.push(text),
      version: '0.2.0-test',
    })

    assert.equal(result, 'signed-in')

    // The callback the injected browser drives responded immediately, on
    // its own, before login() ever finished exchanging the code -- with a
    // complete HTML document (login.test.mjs's own "the callback page..."
    // test below pins its exact status codes, distinctive sentences, and
    // that no response leaks the code or state; this assertion only
    // covers the happy path's response shape).
    const successBody = await callbackResponseText
    assert.match(successBody, /^<!doctype html/i)
    assert.match(successBody, /<title>[^<]+<\/title>/i)
    assert.match(successBody, /Signed in\./)

    // config.json holds the apiBase itself (R11 -- the ingest base, not
    // "<apiBase>/mcp"), and exactly the sanitized plaintext key.
    const configPath = join(dir, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(config, { url: apiBase, key: 'mem_sk_test' })
    if (process.platform !== 'win32') {
      assert.equal(statSync(configPath).mode & 0o777, 0o600)
    }

    // The token endpoint received exactly what PKCE and the flow promise:
    // a verifier that hashes to the challenge login() put in the
    // authorize URL, the right grant type, and the same redirect_uri.
    assert.equal(authState.tokenCalls.length, 1)
    const tokenCall = authState.tokenCalls[0]
    assert.equal(tokenCall.grant_type, 'authorization_code')
    assert.equal(tokenCall.redirect_uri, captured.redirectUri)
    assert.equal(tokenCall.resource, `${apiBase}/mcp`)
    assert.equal(createHash('sha256').update(tokenCall.code_verifier).digest('base64url'), captured.challenge)
    assert.equal(captured.scope, 'openid profile email offline_access')
    assert.equal(captured.resource, `${apiBase}/mcp`)

    // /keys saw the minted access token as its bearer, and a hostname
    // label -- never a body carrying anything sensitive back out.
    assert.equal(apiState.keysCalls.length, 1)
    assert.equal(apiState.keysCalls[0].authorization, 'Bearer tok')
    assert.match(apiState.keysCalls[0].label, /^waku-memory on /)

    // Never the token or the key on stdout, and the email line is there.
    const joined = stdoutLines.join('\n')
    assert.match(joined, /Signed in as person@example\.test\. Key stored in/)
    assert.doesNotMatch(joined, /mem_sk_test/)
    assert.doesNotMatch(joined, /\btok\b/)
  })
})

// Pins the loopback server's four HTML responses (login.ts's
// renderCallbackPage): each is a complete document with its own
// distinctive sentence, the success and duplicate pages read as two
// different pages, and -- the security-relevant assertion -- neither the
// authorization code nor the state this test actually used ever appears
// in any of the four bodies. Fires all four requests from one openBrowser
// callback, in order, over the same listener login() opens for the real
// flow: an unknown path and a missing-code request first (neither sets
// the single-use `accepted` guard), then the real callback, then a
// duplicate of it -- so by the time the duplicate lands, `accepted` is
// already true. The whole sequence is captured as one promise assigned
// synchronously inside openBrowser and awaited only after login() itself
// resolves, so this does not race login()'s own resolution (which depends
// on the third of these four requests having already reached the server).
test('login: the callback page renders a distinct HTML document for each of the four states, and never leaks the code or state', async () => {
  await withServers({}, async ({ dir, apiBase }) => {
    const stdoutLines = []
    let capturedState
    let pagesPromise

    const result = await login({
      apiBase,
      configDir: dir,
      fetchImpl: fetch,
      openBrowser: (url) => {
        const parsed = new URL(url)
        capturedState = parsed.searchParams.get('state')
        const redirectUri = parsed.searchParams.get('redirect_uri')
        pagesPromise = (async () => {
          const notFoundRes = await fetch(new URL('/nope', redirectUri))
          const notFound = { status: notFoundRes.status, body: await notFoundRes.text() }

          const badRequestRes = await fetch(`${redirectUri}?state=${capturedState}`) // no code
          const badRequest = { status: badRequestRes.status, body: await badRequestRes.text() }

          const successRes = await fetch(`${redirectUri}?code=abc&state=${capturedState}`)
          const success = { status: successRes.status, body: await successRes.text() }

          const duplicateRes = await fetch(`${redirectUri}?code=abc&state=${capturedState}`)
          const duplicate = { status: duplicateRes.status, body: await duplicateRes.text() }

          return { notFound, badRequest, success, duplicate }
        })()
      },
      stdout: (text) => stdoutLines.push(text),
      version: '0.2.0-test',
    })

    assert.equal(result, 'signed-in')

    const { notFound, badRequest, success, duplicate } = await pagesPromise

    // Status codes are exactly what they were before: 404, 400, 200, 200.
    assert.equal(notFound.status, 404)
    assert.equal(badRequest.status, 400)
    assert.equal(success.status, 200)
    assert.equal(duplicate.status, 200)

    // Every response is a complete HTML document, not a bare string.
    for (const page of [notFound, badRequest, success, duplicate]) {
      assert.match(page.body, /^<!doctype html/i)
      assert.match(page.body, /<html[ >]/i)
      assert.match(page.body, /<title>[^<]+<\/title>/i)
    }

    // Each state has its own sentence.
    assert.match(notFound.body, /This address is not part of sign-in\./)
    assert.match(badRequest.body, /Sign-in did not complete\./)
    assert.match(success.body, /Signed in\./)
    assert.match(duplicate.body, /Already signed in\./)

    // The success and duplicate pages are two different pages, not the
    // same copy reused.
    assert.notEqual(success.body, duplicate.body)

    // Never the code or the state, on any of the four -- checked against
    // the real values this test used.
    for (const page of [notFound, badRequest, success, duplicate]) {
      assert.doesNotMatch(page.body, /abc/)
      assert.doesNotMatch(page.body, new RegExp(capturedState))
      // Nothing points off 127.0.0.1 -- a cheap proof nothing external is
      // referenced (no stylesheet, no webfont, no image, no script).
      assert.doesNotMatch(page.body, /https?:\/\/(?!127\.0\.0\.1)/i)
    }
  })
})

// Pins the fix (2026-09-08): login() must register the loopback listener's
// actual redirect_uri, not a fixed one -- verified two ways. First, black
// box: the fake authorization server above now rejects a /token call whose
// redirect_uri was not registered, exactly as Supabase does, so this would
// fail with result 'refused' (not 'signed-in') if the ordering regressed to
// registering before the listener's port is known. Second, direct: the
// registered value and the one actually used are asserted equal, and the
// latter is asserted to carry a real port -- so a regression to a bare,
// portless registration fails here even if the equality check above did
// not exist. Confirmed to fail against the pre-fix code (registerClient
// called before the listener had a port, and the token exchange 400ing as
// a result) before this fix landed -- that is this test's RED evidence.
test('login: the client is registered with the loopback listener\'s own redirect_uri, not a fixed one', async () => {
  await withServers({}, async ({ dir, apiBase, authState }) => {
    const stdoutLines = []
    let captured

    const result = await login({
      apiBase,
      configDir: dir,
      fetchImpl: fetch,
      openBrowser: (url) => {
        const parsed = new URL(url)
        captured = {
          state: parsed.searchParams.get('state'),
          redirectUri: parsed.searchParams.get('redirect_uri'),
        }
        void fetch(`${captured.redirectUri}?code=abc&state=${captured.state}`)
      },
      stdout: (text) => stdoutLines.push(text),
      version: '0.2.0-test',
    })

    assert.equal(result, 'signed-in')
    assert.equal(authState.tokenCalls.length, 1)
    assert.deepEqual(authState.registeredRedirectUris, [captured.redirectUri])
    assert.match(captured.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })
})

// Exercises the fake server's own new validation directly (both endpoints),
// independent of login.ts, so a future edit to startAuthServer that weakens
// this check fails on its own rather than only showing up as a mysterious
// 'refused' somewhere else.
test('login: fake authorization server rejects /authorize and /token for an unregistered redirect_uri, like Supabase does', async () => {
  await withServers({}, async ({ apiBase }) => {
    const resourceRes = await fetch(`${apiBase}/.well-known/oauth-protected-resource`)
    const { authorization_servers } = await resourceRes.json()
    const asRes = await fetch(`${authorization_servers[0]}/.well-known/oauth-authorization-server`)
    const { authorization_endpoint, token_endpoint, registration_endpoint } = await asRes.json()

    const registered = 'http://127.0.0.1:9/callback'
    const regRes = await fetch(registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test',
        redirect_uris: [registered],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    const { client_id } = await regRes.json()

    const mismatched = 'http://127.0.0.1:12345/callback'
    const authorizeUrl = new URL(authorization_endpoint)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', client_id)
    authorizeUrl.searchParams.set('redirect_uri', mismatched)
    authorizeUrl.searchParams.set('state', 's')
    const authorizeRes = await fetch(authorizeUrl)
    assert.equal(authorizeRes.status, 400)
    assert.equal((await authorizeRes.json()).error_code, 'validation_failed')

    const tokenRes = await fetch(token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'abc',
        redirect_uri: mismatched,
        client_id,
        code_verifier: 'v',
      }).toString(),
    })
    assert.equal(tokenRes.status, 400)
    assert.equal((await tokenRes.json()).error_code, 'validation_failed')
  })
})

test('login: a callback with the wrong state is ignored; the right one still signs in', async () => {
  await withServers({}, async ({ dir, apiBase }) => {
    const stdoutLines = []
    let wrongStatus

    const result = await login({
      apiBase,
      configDir: dir,
      fetchImpl: fetch,
      openBrowser: (url) => {
        const parsed = new URL(url)
        const state = parsed.searchParams.get('state')
        const redirectUri = parsed.searchParams.get('redirect_uri')
        void (async () => {
          const wrongRes = await fetch(`${redirectUri}?code=abc&state=not-the-real-state`)
          wrongStatus = wrongRes.status
          await fetch(`${redirectUri}?code=abc&state=${state}`)
        })()
      },
      stdout: (text) => stdoutLines.push(text),
      version: '0.2.0-test',
    })

    assert.equal(wrongStatus, 400)
    assert.equal(result, 'signed-in')
    assert.equal(existsSync(join(dir, 'config.json')), true)
  })
})

test('login: no callback within the timeout resolves timeout and writes nothing', async () => {
  await withServers({}, async ({ dir, apiBase }) => {
    const stdoutLines = []

    const result = await login({
      apiBase,
      configDir: dir,
      fetchImpl: fetch,
      openBrowser: () => {
        // Deliberately never calls back -- the timeout must fire on its own.
      },
      stdout: (text) => stdoutLines.push(text),
      timeoutMs: 200,
      version: '0.2.0-test',
    })

    assert.equal(result, 'timeout')
    assert.equal(existsSync(join(dir, 'config.json')), false)
    // An agent that ran login sees why it ended, rather than nothing.
    assert.ok(stdoutLines.some((l) => /timed out.*nothing was saved/i.test(l)), stdoutLines.join('\n'))
  })
})

// Review of 2026-11-11: a sign-in still minting its key when the timer fires
// must not then save the key and say "Signed in", after the line saying
// nothing was saved.
test('login: a sign-in that finishes after the timeout saves nothing and says only that it timed out', async () => {
  await withServers({}, async ({ dir, apiBase }) => {
    const stdoutLines = []
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const result = await login({
      apiBase,
      configDir: dir,
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/keys')) await sleep(600)
        return fetch(url, init)
      },
      openBrowser: (url) => {
        const parsed = new URL(url)
        fetch(`${parsed.searchParams.get('redirect_uri')}?code=abc&state=${parsed.searchParams.get('state')}`).catch(() => {})
      },
      stdout: (text) => stdoutLines.push(text),
      timeoutMs: 300,
      version: '0.2.0-test',
    })
    assert.equal(result, 'timeout')
    await sleep(900) // let the slow key request finish
    assert.equal(existsSync(join(dir, 'config.json')), false)
    assert.equal(stdoutLines.filter((l) => /timed out/i.test(l)).length, 1)
    assert.ok(!stdoutLines.some((l) => /Signed in as/.test(l)), stdoutLines.join('\n'))
    assert.ok(stdoutLines.some((l) => /after 1 minute/.test(l)), 'a sub-minute timeout still reads as a minute')
  })
})

test('login: a registration failure refuses and prints one line naming the step, nothing on stderr', async () => {
  await withServers({ registerStatus: 500 }, async ({ dir, apiBase }) => {
    const stdoutLines = []
    const stderrLines = []
    const realError = console.error
    console.error = (...args) => stderrLines.push(args.join(' '))

    let result
    try {
      result = await login({
        apiBase,
        configDir: dir,
        fetchImpl: fetch,
        openBrowser: () => {
          throw new Error('openBrowser must not be called when registration itself refused')
        },
        stdout: (text) => stdoutLines.push(text),
        version: '0.2.0-test',
      })
    } finally {
      console.error = realError
    }

    assert.equal(result, 'refused')
    assert.equal(stderrLines.length, 0)
    assert.equal(stdoutLines.length, 1)
    assert.match(stdoutLines[0], /registration/)
    assert.match(stdoutLines[0], /500/)
    assert.equal(existsSync(join(dir, 'config.json')), false)
  })
})

test('login: a second valid callback during the first exchange is rejected (single-use code guard)', async () => {
  await withServers({ tokenDelayMs: 200 }, async ({ dir, apiBase, authState, apiState }) => {
    const stdoutLines = []
    let firstResponse, secondResponse

    const result = await login({
      apiBase,
      configDir: dir,
      fetchImpl: fetch,
      openBrowser: (url) => {
        const parsed = new URL(url)
        const state = parsed.searchParams.get('state')
        const redirectUri = parsed.searchParams.get('redirect_uri')
        // Fire both requests concurrently without awaiting the first.
        // The second arrives while the first is still in the token exchange.
        firstResponse = fetch(`${redirectUri}?code=abc&state=${state}`).then((r) => r.status)
        secondResponse = fetch(`${redirectUri}?code=abc&state=${state}`).then((r) => r.status)
      },
      stdout: (text) => stdoutLines.push(text),
      version: '0.2.0-test',
    })

    assert.equal(result, 'signed-in')

    // Both requests got 200 (or the second could be 409), but the token/keys
    // endpoints were hit exactly once -- the second callback did not
    // re-trigger the exchange.
    assert.equal(await firstResponse, 200)
    assert.equal(await secondResponse, 200) // 409 would also be correct
    assert.equal(authState.tokenCalls.length, 1)
    assert.equal(apiState.keysCalls.length, 1)

    // config.json written once with the expected content.
    const configPath = join(dir, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(config, { url: apiBase, key: 'mem_sk_test' })
  })
})

// Reproduces the real-run defect (measured 2026-09-08): a real browser
// keeps more than one connection open to the loopback origin during the
// redirect -- HTTP/1.1 keep-alive pooling and speculative preconnects both
// leave a second socket sitting there that never completes a full
// request/response cycle against our server. (On the Node version this
// suite actually runs on, a connection that *did* complete a full
// keep-alive exchange already gets dropped by plain server.close() -- so
// driving the /callback request itself over a raw socket, and asserting on
// that same socket, would not have discriminated the fix here; a second,
// merely-connected socket is what stays open, exactly like the observed
// 92s hang.) `extraSocket` below stands in for that second connection: it
// connects to the same redirect origin and, deliberately, never sends
// anything and never ends -- login() never sees it, and neither does the
// callback handler; it is dropped only when finish() calls
// server.closeAllConnections().
//
// Against the pre-fix code (server.close() alone) this test times out
// waiting for 'close' on extraSocket -- that is its RED evidence; see
// login-exit-fix-report.md for the captured failure output.
test('login: an extra connection left open by the "browser" is dropped so the server can finish closing', async () => {
  await withServers({}, async ({ dir, apiBase }) => {
    const stdoutLines = []
    let extraSocket
    let closed = false
    let closedPromise = Promise.resolve()

    try {
      const result = await login({
        apiBase,
        configDir: dir,
        fetchImpl: fetch,
        openBrowser: (url) => {
          const parsed = new URL(url)
          const state = parsed.searchParams.get('state')
          const redirectUri = new URL(parsed.searchParams.get('redirect_uri'))

          // Drives the real callback the same way the happy-path test
          // does, so login() actually reaches 'signed-in'.
          void fetch(`${redirectUri}?code=abc&state=${state}`)

          // The second, merely-connected socket: it never sends a request
          // and never ends on its own, the way a browser's pooled or
          // preconnected socket to the same origin would sit there
          // untouched for the rest of the flow.
          closedPromise = new Promise((resolve) => {
            extraSocket = connect(Number(redirectUri.port), redirectUri.hostname)
            extraSocket.resume()
            extraSocket.once('close', () => {
              closed = true
              resolve()
            })
          })
        },
        stdout: (text) => stdoutLines.push(text),
        // Bounds the worst case: on the vanishingly rare ephemeral port
        // that undici refuses to fetch (its "bad port" list), the callback
        // above would never land and login() would otherwise sit on the
        // full 5-minute LOGIN_TIMEOUT_MS default before resolving
        // 'timeout' -- 10s keeps even that failure mode fast and visible
        // as a test failure rather than a multi-minute stall.
        timeoutMs: 10_000,
        version: '0.2.0-test',
      })

      assert.equal(result, 'signed-in')
      assert.equal(existsSync(join(dir, 'config.json')), true)

      // extraSocket must be dropped within a short, bounded window -- not
      // left open indefinitely, which is what stranded the real process
      // for 92s. 5s is generous enough to absorb scheduler jitter on a
      // loaded machine while still being nowhere near "indefinitely":
      // pre-fix code never closes this socket at all, so it always times
      // out here regardless of the bound chosen. A raced timeout turns
      // "the fix is missing" into an assertion failure instead of a hang
      // of the whole suite.
      const outcome = await Promise.race([
        closedPromise.then(() => 'closed'),
        new Promise((resolve) => setTimeout(() => resolve('timed-out'), 5000)),
      ])
      assert.equal(outcome, 'closed')
      assert.equal(closed, true)
    } finally {
      // Hermetic regardless of outcome: never leave a socket (or the test
      // run) hanging just because the assertion above already failed.
      extraSocket?.destroy()
    }
  })
})
