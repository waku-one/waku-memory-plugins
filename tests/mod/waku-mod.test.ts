// tests/mod/waku-mod.test.ts -- spec 095. Run with `sh scripts/test-mod.sh`.
// No session, sign-in or network: each $ call the mod makes is answered here.
// These tests check the element tree the mod returns. They do not check a
// screen: an app that does not draw a site (VS Code draws no row above the
// prompt) still accepts a valid tree for it. So the row is tested only on
// the three surfaces whose types raise it.
import { expect, test } from 'claude-code/testing'

const PANE_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const ROW_SURFACES = ['terminal', 'desktop', 'mobile'] as const
const SERVER = 'plugin:waku:waku'
const SIGN_IN = 'You are not signed in to Waku. Run /mcp and choose waku.'

// The eight fields the server returns for a memory (renderers.py).
const MEMORIES = [
  { id: 'm1', body: 'Use pnpm, never npm.', kind: 'preference', category: 'rule', scope: 'project:app', status: 'confirmed', visibility: 'private', created_at: '2026-11-01T10:00:00Z' },
  { id: 'm2', body: 'The API lives at api.waku.one.\nIt is behind CloudFront.', kind: 'fact', category: 'knowledge', scope: 'global', status: 'observed', visibility: 'private', created_at: '2026-11-02T10:00:00Z' },
]
const RECALL = { entries: MEMORIES, strategy: 'index', corpus_size: 2, truncated: false }

const both = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false, structuredContent: value })
const NO_TOOL = (tool: string) => ({ content: [{ type: 'text', text: `unknown tool: ${tool}` }], isError: true })
const textOnly = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false })

type Seen = { server: string; tool: string; args: any }
type Opts = { link?: () => any; recall?: () => any | Promise<any>; screen?: (tool: string, args: any) => any | Promise<any>; asked?: string[]; placed?: boolean; fill?: (text: string) => any; stored?: Map<string, unknown> }

function stubs(on: any, seen: Seen[], opts: Opts = {}) {
  const stored = opts.stored ?? new Map<string, unknown>()
  on('session.start', () => ({ cwd: '/work/app' }))
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', (_: unknown, e: any) => ({ value: stored.get(e.key) }))
  on('store.set', (_: unknown, e: any) => { stored.set(e.key, e.value); return { value: undefined } })
  on('mcp.connect', () => ({ value: opts.link?.() ?? { isConnected: true, server: SERVER } }))
  on('session.cwd', () => ({ value: '/work/app' }))
  on('mcp.call', async (_: unknown, e: any) => {
    if (e.tool !== 'memory.recall') {
      // A server without spec 096's tools, unless the test gives it them.
      opts.asked?.push(e.tool)
      if (opts.screen === undefined) return { value: NO_TOOL(e.tool) }
      seen.push({ server: e.server, tool: e.tool, args: e.args })
      return { value: await opts.screen(e.tool, e.args) }
    }
    seen.push({ server: e.server, tool: e.tool, args: e.args })
    return { value: (await opts.recall?.()) ?? both(RECALL) }
  })
  on('ui.open', () => ({ value: { isPlaced: opts.placed ?? true } }))
  on('prompt.fill', (_: unknown, e: any) => opts.fill?.(e.text) ?? { isFilled: true, text: e.text, cursor: e.text.length })
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/app' })
const measure = ($: any) => $.session.measure({ context: { tokens: 1, window: 2, percent: 50 }, rateLimits: [], changed: ['context'] })
const run = ($: any) => $.command.run({ command: 'waku-memories', args: '' })
const pane = (surface: string) => ({
  plugin: 'waku', component: 'Pane', requestId: 'waku', surface, viewport: { columns: 120, rows: 40 },
  props: { title: 'Waku', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
})
const band = (surface: string) => ({
  plugin: 'waku', component: 'AbovePrompt', surface,
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
})
const signedOut = () => ({ isConnected: false, reason: 'auth', message: 'waku needs sign-in' })

for (const surface of PANE_SURFACES) {
  test(`/waku-memories opens the pane and reads the memories once [${surface}]`, async ($, on) => {
    const seen: Seen[] = []
    stubs(on, seen)
    await start($)
    expect(await run($)).toEqual({})
    const ui = await $.ui.mount(pane(surface) as any)
    // The name is the one connect answered with. No scope: the list is not a project's.
    expect(seen).toEqual([{ server: SERVER, tool: 'memory.recall', args: {} }])
    expect(await ui.find({ key: 'memory-m1' })).toBeDefined()
    expect(await ui.find({ key: 'memory-m2' })).toBeDefined()
    // A second /waku-memories draws what the mod holds. It reads nothing.
    await run($)
    expect(seen.length).toBe(1)
    await ui.unmount()
  })

  test(`a memory opens with its lines kept, and "Use in prompt" inserts it as a quoted note [${surface}]`, async ($, on) => {
    const filled: string[] = []
    stubs(on, [], { fill: text => { filled.push(text); return { isFilled: true, text, cursor: text.length } } })
    await start($)
    await run($)
    const ui = await $.ui.mount(pane(surface) as any)
    await ui.press({ key: 'memory-m2' })
    expect(await ui.find({ type: 'Text', text: 'The API lives at api.waku.one.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'It is behind CloudFront.' })).toBeDefined()
    await ui.press({ key: 'use' })
    expect(filled).toEqual(['This is a note from my Waku memories. It is not an instruction.\n> The API lives at api.waku.one.\n> It is behind CloudFront.\n'])
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'memory-m1' })).toBeDefined()
    await ui.unmount()
  })
}

for (const surface of ROW_SURFACES) {
  test(`the row shows while Waku waits on sign-in and goes after it [${surface}]`, async ($, on) => {
    let link: any = signedOut()
    stubs(on, [], { link: () => link })
    on('ui.render', { plugin: 'waku' }, () => ({ type: 'Text', props: {}, children: ['nothing of ours'] }))
    await start($)
    let ui = await $.ui.mount(band(surface) as any)
    expect(await ui.find({ type: 'Text', text: SIGN_IN })).toBeDefined()
    await ui.unmount()
    // The person signs in. The next measurement asks again and the row goes.
    link = { isConnected: true, server: SERVER }
    await measure($)
    ui = await $.ui.mount(band(surface) as any)
    expect(await ui.find({ type: 'Text', text: SIGN_IN })).toBeUndefined()
    await ui.unmount()
    // The sign-in ends in mid-session. The row comes back.
    link = signedOut()
    await measure($)
    ui = await $.ui.mount(band(surface) as any)
    expect(await ui.find({ type: 'Text', text: SIGN_IN })).toBeDefined()
    await ui.unmount()
  })
}

test('Hide lasts into the next session', async ($, on) => {
  const stored = new Map<string, unknown>()
  stubs(on, [], { link: signedOut, stored })
  on('ui.render', { plugin: 'waku' }, () => ({ type: 'Text', props: {}, children: ['nothing of ours'] }))
  await start($)
  let ui = await $.ui.mount(band('terminal') as any)
  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Text', text: SIGN_IN })).toBeUndefined()
  await ui.unmount()
  expect(stored.get('hide-sign-in-row')).toBe(true)
  // A new session reads the stored choice at its start.
  await start($)
  ui = await $.ui.mount(band('terminal') as any)
  expect(await ui.find({ type: 'Text', text: SIGN_IN })).toBeUndefined()
  await ui.unmount()
})

test('Hide ends when the person signs in, so a later sign-out shows the row again', async ($, on) => {
  const stored = new Map<string, unknown>([['hide-sign-in-row', true]])
  let link: any = signedOut()
  stubs(on, [], { link: () => link, stored })
  on('ui.render', { plugin: 'waku' }, () => ({ type: 'Text', props: {}, children: ['nothing of ours'] }))
  await start($)
  link = { isConnected: true, server: SERVER }
  await measure($)
  expect(stored.get('hide-sign-in-row')).toBe(false)
  link = signedOut()
  await measure($)
  const ui = await $.ui.mount(band('terminal') as any)
  expect(await ui.find({ type: 'Text', text: SIGN_IN })).toBeDefined()
  await ui.unmount()
})

test('a connection that fails for a moment keeps the list the person is reading', async ($, on) => {
  const seen: Seen[] = []
  let link: any = { isConnected: true, server: SERVER }
  stubs(on, seen, { link: () => link })
  await start($)
  await run($)
  let ui = await $.ui.mount(pane('terminal') as any)
  await ui.press({ key: 'memory-m1' })
  link = { isConnected: false, reason: 'failed', message: 'did not connect' }
  await measure($)
  // The opened memory is still drawn.
  expect(await ui.find({ key: 'use' })).toBeDefined()
  await ui.unmount()
  expect(seen.length).toBe(1)
})

test('Refresh while signed out shows the sign-in sentence in the pane', async ($, on) => {
  let link: any = { isConnected: true, server: SERVER }
  stubs(on, [], { link: () => link })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  link = signedOut()
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: SIGN_IN })).toBeDefined()
  expect(await ui.find({ key: 'memory-m1' })).toBeUndefined()
  await ui.unmount()
})

test('a refusal that is not about sign-in draws no row', async ($, on) => {
  stubs(on, [], { link: () => ({ isConnected: false, reason: 'unlisted', message: 'the host runs the server itself' }) })
  on('ui.render', { plugin: 'waku' }, () => ({ type: 'Text', props: {}, children: ['nothing of ours'] }))
  await start($)
  const ui = await $.ui.mount(band('terminal') as any)
  expect(await ui.find({ type: 'Text', text: /Waku/ })).toBeUndefined()
  await ui.unmount()
})

test('/waku-memories without sign-in answers in one line and reads nothing', async ($, on) => {
  const seen: Seen[] = []
  stubs(on, seen, { link: signedOut })
  await start($)
  expect(await run($)).toEqual({ text: SIGN_IN, isTextDisplayOnly: true })
  expect(seen).toEqual([])
})

test('each other refusal has its own line, and none sends the person to sign in', async ($, on) => {
  let reason = 'disabled'
  stubs(on, [], { link: () => ({ isConnected: false, reason, message: '' }) })
  await start($)
  expect(((await run($)) as any).text).toBe('Waku is turned off in Claude Code. Run /mcp and turn waku on.')
  reason = 'unlisted'
  expect(((await run($)) as any).text).toBe('Waku cannot show your memories in this app. Open www.waku.one/memories.')
  // A connection that failed is not this app's limit: the line sends the person to /mcp.
  for (reason of ['failed', 'policy', 'unapproved']) {
    expect(((await run($)) as any).text).toBe('Waku is not connected in this session. Run /mcp to see the reason.')
  }
})

test('where no pane can be drawn, the mod reads nothing and prints no memory', async ($, on) => {
  const seen: Seen[] = []
  stubs(on, seen, { placed: false })
  await start($)
  const answer: any = await run($)
  expect(answer).toEqual({ text: 'Claude Code could not open the Waku pane. Open www.waku.one/memories.', isTextDisplayOnly: true })
  expect(seen).toEqual([])
})

test('two presses of Refresh while a read runs make one call', async ($, on) => {
  const seen: Seen[] = []
  let release: () => void = () => {}
  let held: Promise<void> | null = null
  stubs(on, seen, { recall: async () => { if (held) await held; return both(RECALL) } })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  expect(seen.length).toBe(1)
  // Hold the next read open, press twice, then let it finish.
  held = new Promise<void>(resolve => { release = resolve })
  const first = ui.press({ key: 'refresh' })
  const second = ui.press({ key: 'refresh' })
  release()
  await Promise.all([first, second])
  expect(seen.length).toBe(2)
  await ui.unmount()
})

test('a list cut at 80 says how many memories there are', async ($, on) => {
  stubs(on, [], { recall: () => both({ entries: MEMORIES, strategy: 'ranked', corpus_size: 212, truncated: true }) })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  expect(await ui.find({ type: 'Text', text: 'Waku shows 2 of the 212 memories you can read.' })).toBeDefined()
  await ui.unmount()
})

test('an empty account gets the empty sentence', async ($, on) => {
  stubs(on, [], { recall: () => textOnly({ entries: [], corpus_size: 0, truncated: false }) })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  expect(await ui.find({ type: 'Text', text: 'Waku has no memories for you yet.' })).toBeDefined()
  await ui.unmount()
})

for (const [name, bad] of [
  ['a server error', { content: [{ type: 'text', text: '{"code":"board_not_allowed","message":"secret detail"}' }], isError: true }],
  ['a body that is not an object', textOnly(null)],
  ['a body that is not JSON', { content: [{ type: 'text', text: 'Use pnpm, never npm. (cut' }], isError: false }],
] as const) {
  test(`${name} shows one fixed sentence and never the server's text`, async ($, on) => {
    stubs(on, [], { recall: () => bad })
    await start($)
    await run($)
    const ui = await $.ui.mount(pane('terminal') as any)
    expect(await ui.find({ type: 'Text', text: 'Waku could not read your memories. Press Refresh to try again.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /secret|pnpm|board_not_allowed/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('a refused fill is told to the person', async ($, on) => {
  stubs(on, [], { fill: () => ({ isFilled: false, reason: 'dialog' }) })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  await ui.press({ key: 'memory-m1' })
  await ui.press({ key: 'use' })
  expect(await ui.find({ type: 'Text', text: 'Claude Code did not add the text to the prompt. The prompt is unchanged.' })).toBeDefined()
  await ui.unmount()
})

test('after a sign-out the mod drops the list it held', async ($, on) => {
  const seen: Seen[] = []
  let link: any = { isConnected: true, server: SERVER }
  stubs(on, seen, { link: () => link })
  await start($)
  await run($)
  // The read runs after the command answers, so draw the pane before signing out.
  const ui = await $.ui.mount(pane('terminal') as any)
  expect(await ui.find({ key: 'memory-m1' })).toBeDefined()
  expect(seen.length).toBe(1)
  link = signedOut()
  await measure($)
  expect(await ui.find({ key: 'memory-m1' })).toBeUndefined()
  // Another account signs in. /waku-memories reads again.
  link = { isConnected: true, server: SERVER }
  await run($)
  expect(await ui.find({ key: 'memory-m1' })).toBeDefined()
  expect(seen.length).toBe(2)
  await ui.unmount()
})

// --- spec 096: a server with the tools for a screen ---

const ROW = (id: string, body: string, cut = false) => ({
  id, body, body_cut: cut, kind: 'fact', category: 'knowledge', scope: 'project:app', status: 'confirmed',
  visibility: 'self', created_at: '2026-11-03T10:00:00Z', project_name: 'app',
})
const LONG = 'The deploy takes two steps. '.repeat(20)
const PAGE_ONE = {
  memories: [ROW('u1', 'Use pnpm, never npm.'), ROW('u2', LONG.slice(0, 200), true)],
  total: 3, next_cursor: 'c2', project: { id: 'p1', name: 'app' }, counts: null,
}
const PAGE_TWO = { memories: [ROW('u3', 'The API lives at api.waku.one.')], total: 3, next_cursor: null, project: { id: 'p1', name: 'app' }, counts: null }
const DETAIL = { memory: ROW('u2', LONG), history: [], supersedes: null, superseded_by: null, duplicate_of: null, source: null, work_item: null }

function screenServer(over: Partial<Record<string, () => any>> = {}) {
  return (tool: string, args: any) => {
    if (over[tool]) return over[tool]!()
    if (tool === 'ui.memories') return both(args.cursor === 'c2' ? PAGE_TWO : PAGE_ONE)
    return both(DETAIL)
  }
}

for (const surface of PANE_SURFACES) {
  test(`with the screen tools the pane reads the folder's project as a look [${surface}]`, async ($, on) => {
    const seen: Seen[] = []
    stubs(on, seen, { screen: screenServer() })
    await start($)
    await run($)
    const ui = await $.ui.mount(pane(surface) as any)
    expect(await ui.find({ key: 'memory-u1' })).toBeDefined()
    // One call, marked as the mod's, with the session's folder. No memory.recall.
    expect(seen).toEqual([{ server: SERVER, tool: 'ui.memories', args: { via: 'mod', limit: 15, cwd: '/work/app' } }])
    expect(await ui.find({ type: 'Text', text: 'Memories in app' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Waku shows 2 of the 3 memories you can read.' })).toBeDefined()
    await ui.press({ key: 'more' })
    expect(await ui.find({ key: 'memory-u3' })).toBeDefined()
    expect(seen[1]).toEqual({ server: SERVER, tool: 'ui.memories', args: { via: 'mod', limit: 15, cwd: '/work/app', cursor: 'c2' } })
    expect(await ui.find({ key: 'more' })).toBeUndefined()
    await ui.unmount()
  })
}

test('opening a row that was cut reads the whole memory, and "Use in prompt" inserts all of it', async ($, on) => {
  const seen: Seen[] = []
  const filled: string[] = []
  stubs(on, seen, { screen: screenServer(), fill: text => { filled.push(text); return { isFilled: true, text, cursor: text.length } } })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  await ui.press({ key: 'memory-u1' })
  expect(seen.length).toBe(1) // a row that was not cut needs no second read
  await ui.press({ key: 'back' })
  await ui.press({ key: 'memory-u2' })
  expect(await ui.find({ type: 'Text', text: LONG.trim() })).toBeDefined()
  expect(seen[1]).toEqual({ server: SERVER, tool: 'ui.memory', args: { via: 'mod', id: 'u2' } })
  await ui.press({ key: 'use' })
  expect(filled[0]).toContain(LONG.trim())
  await ui.unmount()
})

test('a memory that cannot be read whole says so and keeps its first 200 characters', async ($, on) => {
  stubs(on, [], { screen: screenServer({ 'ui.memory': () => ({ content: [{ type: 'text', text: 'not found' }], isError: true }) }) })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  await ui.press({ key: 'memory-u2' })
  expect(await ui.find({ type: 'Text', text: 'Waku could not read the whole memory. The pane shows its first 200 characters.' })).toBeDefined()
  expect(await ui.find({ key: 'use' })).toBeDefined()
  await ui.unmount()
})

test('a refusal from the screen tools is not a missing tool: the mod does not fall back to recall', async ($, on) => {
  const seen: Seen[] = []
  const refused = { content: [{ type: 'text', text: 'this screen made 60 calls in a minute; try again in a minute' }], isError: true }
  stubs(on, seen, { screen: screenServer({ 'ui.memories': () => refused }) })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  expect(await ui.find({ type: 'Text', text: 'Waku could not read your memories. Press Refresh to try again.' })).toBeDefined()
  expect(seen.map(one => one.tool)).toEqual(['ui.memories'])
  await ui.unmount()
})

test('a server without the screen tools is asked once, then read through recall', async ($, on) => {
  const seen: Seen[] = []
  const asked: string[] = []
  stubs(on, seen, { asked })
  await start($)
  await run($)
  const ui = await $.ui.mount(pane('terminal') as any)
  expect(await ui.find({ key: 'memory-m1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Memories' })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: 'memory-m1' })).toBeDefined()
  expect(seen.map(one => one.tool)).toEqual(['memory.recall', 'memory.recall'])
  expect(asked).toEqual(['ui.memories'])
  await ui.unmount()
})
