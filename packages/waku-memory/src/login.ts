// `login` -- the browser OAuth flow that mints an API key without the
// person ever seeing one (spec 012 §7). Wired by cli.ts's `login` command
// and, since task 13, `capture enable`'s third path (a person who has no
// key yet is offered this instead of the paste prompt); this file only
// orchestrates the flow itself against an injected deps bag, the same
// split hook.ts/capture.ts already established, so login.test.mjs can
// drive it against a fake authorization server and a fake API on
// 127.0.0.1 and never touch a real browser or a real waku.one.
//
// The shape, in order: discover the authorization server from the API's
// protected-resource metadata, dynamically register a public client,
// listen on a loopback port, send the person to the authorization
// endpoint (PKCE S256, a random state, printed and opened), wait for the
// redirect back, exchange the code for a token, mint a key with it, and
// write that key exactly where a pasted one goes (writeConfigJson,
// sanitizeKey -- both capture.ts's, not reimplemented here).
//
// Zero new runtime dependency, per the shim's package.json: node:http,
// node:crypto, node:os and capture.ts (itself dependency-free) only.

import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { hostname } from 'node:os'

import { sanitizeKey, writeConfigJson } from './capture.ts'

export type LoginDeps = {
  apiBase: string // e.g. 'https://api.waku.one' -- no trailing slash required, this file strips one
  configDir: string // e.g. ~/.waku-memory -- writeConfigJson's target
  fetchImpl: typeof fetch
  openBrowser: (url: string) => void // real: spawn the platform opener, detached
  stdout: (text: string) => void
  timeoutMs?: number // default LOGIN_TIMEOUT_MS
  version: string // SHIM_VERSION (hook.ts), for client_name and the registration request
}

// §7: five minutes to complete a browser round trip is generous without
// being indefinite -- a person who wanders off leaves nothing running past
// that, and the loopback server closes either way (see login()'s finish).
export const LOGIN_TIMEOUT_MS = 300_000

export const LOGIN_SCOPES = 'openid profile email offline_access'

// The `resource` parameter (RFC 8707) login sends in the authorize URL and
// the token request is always derived at runtime from deps.apiBase --
// `${apiBase}/mcp` with a trailing slash stripped first -- never this
// constant. LOGIN_RESOURCE exists only as the documented value for the
// default apiBase, so a reader (or a test asserting against the default)
// has something to compare the runtime value to without recomputing it.
export const LOGIN_RESOURCE = 'https://api.waku.one/mcp'

// The loopback server's four responses, each a complete, self-contained
// HTML document -- this page is served from 127.0.0.1 mid-sign-in, when
// the person's network state is unknown, so nothing here may reach outside
// the response itself: no stylesheet link, no webfont, no image, no
// script, no external URL of any kind. A system font stack only. Values
// below are restated from ../../../waku-memory-context/visual-design/
// visual-design-system.md rather than invented -- the ground/ink/accent/
// ok/warn/bad pair per theme, the 2px radius (unused here -- nothing on
// this page has a rectangle worth rounding), and the two allowed weights
// (400 for the two lines of prose, 500 for the mark and the heading,
// which read as labels). `prefers-color-scheme` picks the theme; there is
// no toggle to wire up.
//
// Never embed `code` or `state` here on any branch -- reportCallbackPage's
// four callers each pass a state name only, never the request itself.
type CallbackPageState = 'signed-in' | 'already-signed-in' | 'could-not-complete' | 'not-found'

const CALLBACK_PAGE_COPY: Record<
  CallbackPageState,
  { title: string; mark: string; markColor: string; heading: string; body: string }
> = {
  // The real success. Only this one gets the ok/accent treatment -- the
  // system's own message vocabulary (§14 of the design doc) marks a
  // level with an uppercase mono word before the sentence, not with a
  // filled surface or an icon.
  'signed-in': {
    title: 'Signed in',
    mark: 'OK',
    markColor: 'var(--ok)',
    heading: 'Signed in.',
    body: 'This tab can be closed now.',
  },
  // The duplicate callback (`accepted` already true): the flow already
  // finished, so this is not an error and carries no color.
  'already-signed-in': {
    title: 'Already signed in',
    mark: '·',
    markColor: 'var(--text-faint)',
    heading: 'Already signed in.',
    body: 'Nothing else to do here.',
  },
  // The `state` mismatch or missing `code` (400). Neither an ok nor a
  // plain neutral: a mismatched state can mean the link was tampered
  // with, so this reads as the doc's `warn` level -- worth noticing,
  // not a failure to panic over -- and says the one thing that is a
  // different action from reloading this tab: go back to the terminal.
  'could-not-complete': {
    title: 'Sign-in could not complete',
    mark: 'WARN',
    markColor: 'var(--warn)',
    heading: 'Sign-in did not complete.',
    body: 'The command is still running. Try again from the terminal.',
  },
  // Any path but /callback (404). Nothing to explain beyond the one fact.
  'not-found': {
    title: 'Not found',
    mark: '·',
    markColor: 'var(--text-faint)',
    heading: 'Not found.',
    body: 'This address is not part of sign-in.',
  },
}

function renderCallbackPage(state: CallbackPageState): string {
  const copy = CALLBACK_PAGE_COPY[state]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${copy.title}</title>
<style>
  :root {
    --ground: #E1E1D9;
    --ink: #161614;
    --accent-ink: #161614;
    --ok: #2B7754;
    --warn: #8C5617;
    --text-muted: color-mix(in srgb, var(--ink) 82%, var(--ground));
    --text-faint: color-mix(in srgb, var(--ink) 62%, var(--ground));
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #202020;
      --ink: #C9CDD1;
      --ok: #4FBF8B;
      --warn: #E78B23;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--ground);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-weight: 400;
    text-align: center;
  }
  main { max-width: 40ch; }
  .mark {
    display: block;
    margin: 0 0 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-weight: 500;
    font-size: 12px;
    letter-spacing: .16em;
    text-transform: uppercase;
    color: ${copy.markColor};
  }
  h1 {
    margin: 0 0 12px;
    font-size: 20px;
    font-weight: 500;
    line-height: 1.3;
  }
  p {
    margin: 0;
    font-size: 15px;
    line-height: 1.5;
    color: var(--text-muted);
  }
</style>
</head>
<body>
<main>
<span class="mark">${copy.mark}</span>
<h1>${copy.heading}</h1>
<p>${copy.body}</p>
</main>
</body>
</html>
`
}

export type LoginResult = 'signed-in' | 'timeout' | 'refused'

type Step = 'discovery' | 'listener' | 'registration' | 'token' | 'keys'

// Carries which of the four network steps failed and the HTTP status that
// said so -- login()'s refusal branches read both off this and print
// neither a response body nor anything from the request (never the token,
// never the key): "Sign-in failed at <step> (HTTP <status>)." is the whole
// line.
class StepError extends Error {
  readonly step: Step
  readonly status: number
  constructor(step: Step, status: number) {
    super(`${step} step failed with HTTP ${status}`)
    this.step = step
    this.status = status
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

// GET <apiBase>/.well-known/oauth-protected-resource for the resource's
// authorization server, then that server's own
// /.well-known/oauth-authorization-server for the three endpoints login
// needs. Throws StepError('discovery', status) on anything short of a
// clean pair of 2xx JSON responses carrying the fields this reads --
// login() is the only caller and turns that into the one printed line.
export async function discover(
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<{ issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string }> {
  const base = stripSlash(apiBase)
  const resourceRes = await fetchImpl(`${base}/.well-known/oauth-protected-resource`)
  if (!resourceRes.ok) throw new StepError('discovery', resourceRes.status)
  const resourceBody = (await resourceRes.json()) as { authorization_servers?: unknown }
  const issuer = Array.isArray(resourceBody.authorization_servers) ? resourceBody.authorization_servers[0] : undefined
  if (typeof issuer !== 'string' || issuer === '') throw new StepError('discovery', resourceRes.status)

  const asRes = await fetchImpl(`${stripSlash(issuer)}/.well-known/oauth-authorization-server`)
  if (!asRes.ok) throw new StepError('discovery', asRes.status)
  const asBody = (await asRes.json()) as {
    authorization_endpoint?: unknown
    token_endpoint?: unknown
    registration_endpoint?: unknown
  }
  const { authorization_endpoint, token_endpoint, registration_endpoint } = asBody
  if (
    typeof authorization_endpoint !== 'string' ||
    typeof token_endpoint !== 'string' ||
    typeof registration_endpoint !== 'string'
  ) {
    throw new StepError('discovery', asRes.status)
  }
  return {
    issuer,
    authorizationEndpoint: authorization_endpoint,
    tokenEndpoint: token_endpoint,
    registrationEndpoint: registration_endpoint,
  }
}

// Dynamic client registration (RFC 7591): a public client, registered with
// the exact redirect URI login() will use for the authorize request and the
// token exchange -- including the ephemeral port the loopback listener is
// actually on. RFC 8252 §7.3 lets a client register the bare loopback
// address and redirect to any port at request time, but our authorization
// server (Supabase) exact-matches redirect_uri against what was registered
// and does not implement that exception (measured against the deployed
// service, 2026-09-08: registering the bare address and then authorizing
// against the real port got back `{"error_code":"validation_failed","msg":
// "invalid redirect_uri"}`). So the caller must start the listener first and
// pass its real redirect URI in here -- see login()'s own ordering. Returns
// client_id; throws StepError('registration', status) otherwise.
export async function registerClient(
  registrationEndpoint: string,
  fetchImpl: typeof fetch,
  version: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `waku-memory ${version}`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  if (!res.ok) throw new StepError('registration', res.status)
  const body = (await res.json()) as { client_id?: unknown }
  if (typeof body.client_id !== 'string' || body.client_id === '') throw new StepError('registration', res.status)
  return body.client_id
}

// PKCE (RFC 7636), S256 only: a 32-byte random verifier, base64url; the
// challenge is its SHA-256 digest, also base64url. Buffer's own
// 'base64url' encoding already omits padding, so neither value needs the
// usual base64 cleanup.
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authorizeUrl(p: {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  state: string
  challenge: string
  resource: string
}): string {
  const url = new URL(p.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', p.clientId)
  url.searchParams.set('redirect_uri', p.redirectUri)
  url.searchParams.set('state', p.state)
  url.searchParams.set('code_challenge', p.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('scope', LOGIN_SCOPES)
  url.searchParams.set('resource', p.resource)
  return url.toString()
}

async function exchangeToken(
  tokenEndpoint: string,
  fetchImpl: typeof fetch,
  p: { code: string; redirectUri: string; clientId: string; verifier: string; resource: string },
): Promise<{ accessToken: string; idToken?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
    resource: p.resource,
  })
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) throw new StepError('token', res.status)
  const json = (await res.json()) as { access_token?: unknown; id_token?: unknown }
  if (typeof json.access_token !== 'string' || json.access_token === '') throw new StepError('token', res.status)
  return { accessToken: json.access_token, idToken: typeof json.id_token === 'string' ? json.id_token : undefined }
}

// The email printed in the final "Signed in as <email>" line -- read from
// the token response's id_token, an unsigned decode of its middle segment
// (base64url JSON), never signature-checked: it arrived over TLS from the
// issuer discover() itself found, and the only use is one word in a
// stdout line, not an authorization decision. Anything short of a clean
// {email: string} there (no id_token, unparseable, wrong shape) falls back
// to the literal word "you" -- login() never blocks on this.
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' && payload.email !== '' ? payload.email : null
  } catch {
    return null
  }
}

// keys.py's CreateKeyRequest.label: free text, default "unnamed", capped
// at 200 chars server-side -- truncated here too so a very long hostname
// never trips the server's own validation into a refusal this file would
// then have to explain.
function keyLabel(): string {
  const label = `waku-memory on ${hostname()}`
  return label.length > 200 ? label.slice(0, 200) : label
}

function reportRefusal(deps: LoginDeps, fallbackStep: Step, err: unknown): void {
  const step = err instanceof StepError ? err.step : fallbackStep
  const status = err instanceof StepError ? err.status : 0
  deps.stdout(`Sign-in failed at ${step} (HTTP ${status}).`)
}

// The whole flow. Never prints the token or the key on any path -- the
// only things written to deps.stdout are the authorize URL, the final
// "Signed in as <email>" line, and (on refusal) the one-line step/status
// report above. The loopback server, once opened, is closed on every path
// out of the returned promise: 'signed-in', 'timeout', and 'refused' from a
// listener failure, a bad registration, or a bad token/keys response all go
// through the same finish(). 'refused' from discovery returns before any
// server exists, so there is nothing to close on that one path.
//
// Ordering (fixed 2026-09-08, measured against the deployed service): the
// listener starts FIRST, before registration, so registerClient can be
// given the real `http://127.0.0.1:<port>/callback` -- the same string then
// used, unchanged, for the authorize URL and the token exchange. Registering
// the bare loopback address ahead of knowing the port (the previous order)
// is what RFC 8252 §7.3 expects a server to accept via its any-port
// exception, but Supabase exact-matches redirect_uri against the registered
// list and answered with `invalid redirect_uri`: see registerClient's own
// comment for the exact response.
export async function login(deps: LoginDeps): Promise<LoginResult> {
  const apiBase = stripSlash(deps.apiBase)
  const resource = `${apiBase}/mcp`
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS

  let discovered: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string }
  try {
    discovered = await discover(apiBase, deps.fetchImpl)
  } catch (err) {
    reportRefusal(deps, 'discovery', err)
    return 'refused'
  }

  const { verifier, challenge } = pkce()
  const state = randomBytes(16).toString('hex')

  return new Promise<LoginResult>((resolveLogin) => {
    let settled = false
    let accepted = false
    let clientId = ''
    let redirectUri = ''

    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/html' })
        res.end(renderCallbackPage('not-found'))
        return
      }

      const code = requestUrl.searchParams.get('code')
      const receivedState = requestUrl.searchParams.get('state')
      if (receivedState !== state || !code) {
        // Wrong or missing state: keep waiting -- a stray or forged hit on
        // this port must not end the flow the real browser is still
        // carrying.
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(renderCallbackPage('could-not-complete'))
        return
      }

      // OAuth codes are single-use and minting a credential should be
      // idempotent only by accident; the client must not rely on the
      // authorization server to defend against replay. Guard here: flag
      // the code accepted before any async work, so a concurrent request
      // sees the flag and returns 200 without re-running the exchange.
      if (accepted) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(renderCallbackPage('already-signed-in'))
        return
      }
      accepted = true

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(renderCallbackPage('signed-in'))

      void finishSignIn(code)
    })

    const finish = (result: LoginResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // server.close() alone only stops accepting *new* connections; it
      // waits for existing ones to end on their own before the server (and
      // its socket handles) actually goes away. A real browser holds the
      // callback connection open with HTTP keep-alive -- it never ends the
      // connection itself -- so that lone open socket kept the event loop
      // alive and the process never exited (measured 2026-09-08 against
      // the deployed service: a real sign-in completed, config.json was
      // written, and the process was still running 92s later). Dropping
      // every outstanding connection here, active or idle, is what lets
      // the server -- and the process -- actually finish closing, on every
      // path through finish(): signed-in, timeout, and refused alike.
      // closeAllConnections() has been available since Node 18.2; this
      // package requires Node >=20 (see package.json's engines).
      server.close()
      server.closeAllConnections()
      resolveLogin(result)
    }

    async function finishSignIn(code: string): Promise<void> {
      try {
        const tokenResult = await exchangeToken(discovered.tokenEndpoint, deps.fetchImpl, {
          code,
          redirectUri,
          clientId,
          verifier,
          resource,
        })

        const keysRes = await deps.fetchImpl(`${apiBase}/keys`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenResult.accessToken}`,
          },
          body: JSON.stringify({ label: keyLabel() }),
        })
        if (!keysRes.ok) throw new StepError('keys', keysRes.status)
        const keysBody = (await keysRes.json()) as { plaintext?: unknown }
        if (typeof keysBody.plaintext !== 'string' || keysBody.plaintext === '') {
          throw new StepError('keys', keysRes.status)
        }

        const { key } = sanitizeKey(keysBody.plaintext)
        // The timer may have fired while a request above was in flight; it
        // already said nothing was saved, so nothing is (review, 2026-11-11).
        // Everything below is synchronous, so the timer cannot fire in it.
        if (settled) return
        writeConfigJson(deps.configDir, { url: apiBase, key })

        const email = emailFromIdToken(tokenResult.idToken) ?? 'you'
        deps.stdout(`Signed in as ${email}. Key stored in ${deps.configDir}/config.json.`)
        finish('signed-in')
      } catch (err) {
        if (settled) return
        reportRefusal(deps, 'token', err)
        finish('refused')
      }
    }

    // An agent that started this sees why it ended (flow review, 2026-11-11).
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    const timer = setTimeout(() => {
      if (settled) return
      deps.stdout(
        `Sign-in timed out after ${minutes} minute${minutes === 1 ? '' : 's'}, so nothing was saved. Run "npx -y waku-memory login" again to retry.`,
      )
      finish('timeout')
    }, timeoutMs)

    // A listener that never comes up (EADDRINUSE, permissions, ...) fires
    // 'error' instead of the 'listening' callback below -- reported the same
    // way every other step is, naming 'listener' rather than falling through
    // to a confusing StepError from somewhere else.
    server.on('error', (err) => {
      reportRefusal(deps, 'listener', err)
      finish('refused')
    })

    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reportRefusal(deps, 'listener', new Error('the loopback listener did not report a port'))
        finish('refused')
        return
      }
      redirectUri = `http://127.0.0.1:${port}/callback`

      registerClient(discovered.registrationEndpoint, deps.fetchImpl, deps.version, redirectUri)
        .then((id) => {
          clientId = id
          const url = authorizeUrl({
            authorizationEndpoint: discovered.authorizationEndpoint,
            clientId,
            redirectUri,
            state,
            challenge,
            resource,
          })
          deps.stdout(`Open this URL if your browser did not: ${url}`)
          deps.openBrowser(url)
        })
        .catch((err) => {
          reportRefusal(deps, 'registration', err)
          finish('refused')
        })
    })
  })
}
