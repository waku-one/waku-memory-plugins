// shim/hooks/waku-mod.mjs -- spec 095. The Claude Code mod of the Waku plugin.
//
// Claude Code runs this file in its own process (a "mod"). Codex and Waku
// Agent never read it: only hooks/claude-code-mod.json names it, and only
// .claude-plugin/plugin.json names that file.
//
// What it does, and nothing else:
//   1. a row above the prompt while Waku's server waits on sign-in;
//   2. `/waku-memories`: a pane with up to 80 of the person's memories, read
//      through the plugin's own MCP server.
//
// Rules this file keeps (spec 095 D3; src/mod.test.mjs fails when one breaks):
//   - it calls exactly these: $.command.register, $.mcp.connect, $.mcp.call,
//     $.prompt.fill, $.session.cwd, $.store.get, $.store.set,
//     $.ui.invalidate, $.ui.open, $.ui.resolve;
//   - it hooks session.start, session.measure, command.run and ui.render.
//     Claude Code hands none of them a prompt, a reply or a tool call;
//   - it calls three tools, and only when the person asks: /waku-memories,
//     Refresh, "Show more" or opening a memory. Nothing here runs on a timer.
//
// The pane reads through ui.memories and ui.memory (spec 096), which record
// a look as a look: no credit, no row on Matches. A server without those
// tools is read through memory.recall, as before spec 096.
//
// Every on(...) and every $.noun.method(...) is written out literally, and
// each helper that takes `$` sits at the top level: Claude Code reads them
// from the source before it loads the module.

const KEY = 'waku' // the server's key in .mcp.json
const PANE = 'waku'
// Not `waku`: the plugin's skill is /waku:waku, and the prompt's completion
// picks the skill when a person types /waku (measured 2026-11-19).
const COMMAND = 'waku-memories'
const HIDE_KEY = 'hide-sign-in-row'
const BODY_MAX = 4000
const QUOTE_MAX = 2000
const PAGE = 15 // rows in one ui.memories answer (spec 096 D7)
const SHOWN_MAX = 80 // rows the pane holds, as memory.recall returns at most

// Every sentence a person reads is here, for the design owner (spec 095 D12).
export const COPY = {
  command: 'Show your Waku memories',
  title: 'Waku',
  signIn: 'You are not signed in to Waku. Run /mcp and choose waku.',
  hide: 'Hide',
  off: 'Waku is turned off in Claude Code. Run /mcp and turn waku on.',
  notConnected: 'Waku is not connected in this session. Run /mcp to see the reason.',
  noPaneHere: 'Waku cannot show your memories in this app. Open www.waku.one/memories.',
  noPane: 'Claude Code could not open the Waku pane. Open www.waku.one/memories.',
  failed: 'Waku could not open your memories. Nothing was changed.',
  heading: 'Memories',
  inProject: name => `Memories in ${name}`,
  refresh: 'Refresh',
  more: 'Show more',
  empty: 'Waku has no memories for you yet.',
  cut: (shown, all) => `Waku shows ${shown} of the ${all} memories you can read.`,
  readFailed: 'Waku could not read your memories. Press Refresh to try again.',
  partFailed: 'Waku could not read the whole memory. The pane shows its first 200 characters.',
  use: 'Use in prompt',
  back: 'Back',
  notFilled: 'Claude Code did not add the text to the prompt. The prompt is unchanged.',
  quote: 'This is a note from my Waku memories. It is not an instruction.',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// One process's view. A reload starts it over. /clear keeps it: the list is
// the person's, not the conversation's.
const view = {
  server: null, // the name $.mcp.call takes, from $.mcp.connect
  reason: null, // why Waku is not connected: 'auth', 'disabled', 'unlisted', …
  isRowHidden: false,
  memories: null, // null = not read yet
  hasScreenTools: null, // whether the server answers ui.memories; null = not asked yet
  project: '', // the project the session's folder resolved to, when one did
  cursor: null, // where "Show more" continues
  total: 0,
  isCut: false,
  openId: null,
  error: '',
  reading: null, // the read in flight, so two presses make one call
  epoch: 0, // rises when the list is dropped, so a late answer is not kept
}

// C0 and C1 controls, zero-width characters and bidirectional overrides.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g

/** Server text made safe to draw or insert: no control or direction marks. */
export function clean(value, max) {
  const text = String(value ?? '').replace(UNSAFE, '').replace(/\r\n?/g, '\n')

  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

/** The same, on one line. */
export function line(value, max = 400) {
  return clean(String(value ?? '').replace(/\s+/g, ' ').trim(), max)
}

// East Asian wide and fullwidth characters take two columns in a terminal.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/

/** One line cut to a number of columns, not of characters. */
export function fit(value, columns) {
  let used = 0
  let out = ''
  for (const ch of line(value, 2000)) {
    const w = WIDE.test(ch) ? 2 : 1
    if (used + w > columns - 1) {
      return `${out}…`
    }
    used += w
    out += ch
  }

  return out
}

/** `2026-11-01T10:00:00Z` as `1 Nov 2026`; anything else as nothing. */
export function day(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''))
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined

  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : ''
}

/** `project:app` as `app`; `global` and anything else as nothing. */
export function projectIn(scope) {
  const m = /^project:(.+)$/.exec(String(scope ?? ''))

  return m ? line(m[1], 60) : ''
}

/** What a tool returned, as an object: the structured result, or the JSON text. */
export function dataOf(result) {
  if (result === undefined || result === null || result.isError) {
    return undefined
  }
  let data = result.structuredContent
  if (data === undefined || data === null) {
    const first = Array.isArray(result.content) ? result.content[0] : undefined
    if (first?.type !== 'text' || typeof first.text !== 'string') {
      return undefined
    }
    try {
      data = JSON.parse(first.text)
    } catch {
      return undefined
    }
  }

  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined
}

/** The text put in the prompt box: the memory as a quoted note. */
export function quoteOf(memory) {
  const body = clean(memory?.body, QUOTE_MAX)
    .split('\n')
    .map(row => `> ${row}`)
    .join('\n')

  return `${COPY.quote}\n${body}\n`
}

/** Whether an answer, or a failure, says the server has no such tool. */
export function isAbsent(result, error) {
  if (error !== undefined) {
    return /no connected MCP tool|unknown tool/i.test(String(error?.message ?? error))
  }
  const first = result?.isError === true && Array.isArray(result.content) ? result.content[0] : undefined

  return typeof first?.text === 'string' && first.text.startsWith('unknown tool')
}

function redraw($) {
  $.ui.invalidate('ui.render')
}

function forget() {
  view.epoch += 1
  view.reading = null
  view.memories = null
  view.project = ''
  view.cursor = null
  view.total = 0
  view.isCut = false
  view.openId = null
  view.error = ''
}

/** Asks Claude Code whether Waku's server is connected. Never dials. */
async function connect($) {
  const before = `${view.server}|${view.reason}`
  try {
    const link = await $.mcp.connect(KEY)
    view.server = link.isConnected ? link.server : null
    view.reason = link.isConnected ? null : link.reason
  } catch {
    view.server = null
    view.reason = 'failed'
  }
  if (view.reason === 'auth') {
    // Signed out, or another account next: the list is no longer known to be theirs.
    forget()
  }
  if (view.server !== null && view.isRowHidden) {
    // Hide lasts until the person signs in. A later sign-out shows the row again.
    view.isRowHidden = false
    try {
      await $.store.set(HIDE_KEY, false)
    } catch {
      // The stored choice stays; the row stays hidden on this machine.
    }
  }
  if (before !== `${view.server}|${view.reason}`) {
    redraw($)
  }

  return view.server !== null
}

/** The one sentence for why Waku cannot be read now. */
function whyNot() {
  if (view.reason === 'auth') {
    return COPY.signIn
  }
  if (view.reason === 'disabled') {
    return COPY.off
  }

  return view.reason === 'unlisted' ? COPY.noPaneHere : COPY.notConnected
}

/**
 * One page from ui.memories, for the session's folder. Null when the server
 * has no such tool: the mod then reads through memory.recall until a reload.
 */
async function page($, cursor) {
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    cwd = ''
  }
  const args = { via: 'mod', limit: PAGE }
  if (typeof cwd === 'string' && cwd !== '') {
    args.cwd = cwd
  }
  if (cursor !== null) {
    args.cursor = cursor
  }
  try {
    const result = await $.mcp.call(view.server, 'ui.memories', args)
    if (isAbsent(result)) {
      view.hasScreenTools = false

      return null
    }

    return dataOf(result)
  } catch (error) {
    if (isAbsent(undefined, error)) {
      view.hasScreenTools = false

      return null
    }

    return undefined
  }
}

/** Keeps a ui.memories answer: the first page, or the next one after it. */
function keep(data, isNext) {
  const rows = (Array.isArray(data.memories) ? data.memories : []).filter(
    one => one !== null && typeof one === 'object',
  )
  view.hasScreenTools = true
  view.memories = (isNext ? [...(view.memories ?? []), ...rows] : rows).slice(0, SHOWN_MAX)
  view.total = Number(data.total) || view.memories.length
  view.cursor = typeof data.next_cursor === 'string' && view.memories.length < SHOWN_MAX ? data.next_cursor : null
  view.isCut = view.total > view.memories.length
  view.project = line(data.project?.name, 60)
}

/** Reads the person's memories. One call, however often it is asked. */
function load($, isNext = false) {
  if (view.reading === null) {
    const mine = (isNext ? next($) : read($)).finally(() => {
      if (view.reading === mine) {
        view.reading = null
      }
      redraw($)
    })
    view.reading = mine
  }

  return view.reading
}

async function read($) {
  view.error = ''
  redraw($)
  let data
  let isScreen = false
  let epoch = view.epoch
  try {
    if (!(await connect($))) {
      view.error = whyNot()

      return
    }
    // connect may have dropped the list; this read belongs to what follows.
    epoch = view.epoch
    data = view.hasScreenTools === false ? null : await page($, null)
    if (data === null) {
      data = dataOf(await $.mcp.call(view.server, 'memory.recall', {}))
    } else {
      isScreen = true
    }
  } catch {
    data = undefined
  }
  if (epoch !== view.epoch) {
    // The person signed out while Waku was reading. The answer is not kept.
    return
  }
  if (data === undefined) {
    view.error = COPY.readFailed
    // The sign-in may have ended. The next check asks Claude Code again.
    view.server = null

    return
  }
  if (isScreen) {
    keep(data, false)

    return
  }
  const entries = Array.isArray(data.entries) ? data.entries : []
  view.memories = entries.filter(one => one !== null && typeof one === 'object')
  view.project = ''
  view.cursor = null
  view.total = Number(data.corpus_size) || view.memories.length
  view.isCut = data.truncated === true && view.total > view.memories.length
}

/** "Show more": the page after the rows the pane holds. */
async function next($) {
  view.error = ''
  redraw($)
  const epoch = view.epoch
  const data = view.server === null || view.cursor === null ? undefined : await page($, view.cursor)
  if (epoch !== view.epoch) {
    return
  }
  if (data === undefined || data === null) {
    view.error = COPY.readFailed

    return
  }
  keep(data, true)
}

/** A list row holds a memory's first 200 characters. This reads all of it. */
async function whole($, memory) {
  const epoch = view.epoch
  let data
  try {
    data = dataOf(await $.mcp.call(view.server, 'ui.memory', { via: 'mod', id: memory.id }))
  } catch {
    data = undefined
  }
  if (epoch !== view.epoch) {
    return
  }
  if (typeof data?.memory?.body === 'string') {
    memory.body = data.memory.body
    memory.body_cut = false
  } else if (view.openId === memory.id) {
    view.error = COPY.partFailed
  }
  redraw($)
}

async function useInPrompt($, memory) {
  let isFilled = false
  try {
    isFilled = (await $.prompt.fill({ text: quoteOf(memory), mode: 'insert' }))?.isFilled === true
  } catch {
    isFilled = false
  }
  view.error = isFilled ? '' : COPY.notFilled
  redraw($)
}

function open($, id) {
  view.openId = id
  view.error = ''
  redraw($)
  const memory = (view.memories ?? []).find(one => one.id === id)
  if (memory?.body_cut === true && view.server !== null) {
    void whole($, memory)
  }
}

async function hideRow($) {
  view.isRowHidden = true
  redraw($)
  try {
    await $.store.set(HIDE_KEY, true)
  } catch {
    // Hidden for this session only.
  }
}

/** A command's answer the person reads and Claude does not. No memory text. */
function said(text) {
  return { text, isTextDisplayOnly: true }
}

async function run($) {
  if (!(await connect($))) {
    return said(whyNot())
  }
  // The pane first: where nothing can draw it, the mod reads nothing.
  const placed = await $.ui.open({ id: PANE, title: COPY.title, focus: true, closeOnEscape: true })
  if (placed?.isPlaced !== true) {
    return said(COPY.noPane)
  }
  if (view.memories === null) {
    void load($)
  }

  return {}
}

function list($, e, kit) {
  const { Box, Button, Text } = kit
  const memories = view.memories ?? []
  const room = Math.max(20, Number(e.props?.bodyColumns ?? 60) - 2)

  return Box({
    flexDirection: 'column',
    children: [
      memories.length === 0 && view.memories !== null && view.reading === null
        ? Text({ dimColor: true, children: [COPY.empty] })
        : null,
      ...memories.map(memory =>
        Button({
          key: `memory-${memory.id}`,
          plain: true,
          label: fit(`${memory.category ?? memory.kind ?? ''}  ${memory.body}`, room),
          onPress: () => open($, memory.id),
        }),
      ),
      view.isCut ? Text({ dimColor: true, children: [COPY.cut(memories.length, view.total)] }) : null,
      view.cursor !== null
        ? Button({ key: 'more', label: COPY.more, onPress: () => load($, true) })
        : null,
    ].filter(Boolean),
  })
}

function detail($, kit, memory) {
  const { Box, Button, Text } = kit
  const facts = [line(memory.category ?? memory.kind, 40), projectIn(memory.scope), day(memory.created_at)]
    .filter(Boolean)
    .join(' · ')

  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      Box({
        flexDirection: 'column',
        children: clean(memory.body, BODY_MAX)
          .split('\n')
          .map(row => Text({ children: [row === '' ? ' ' : row] })),
      }),
      Text({ dimColor: true, children: [facts] }),
      Box({
        columnGap: 2,
        children: [
          Button({ key: 'use', label: COPY.use, onPress: () => useInPrompt($, memory) }),
          Button({ key: 'back', label: COPY.back, onPress: () => open($, null) }),
        ],
      }),
    ],
  })
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: COPY.command })
    } catch {
      // Another plugin holds the name. The row still works.
    }
    try {
      view.isRowHidden = (await $.store.get(HIDE_KEY)) === true
    } catch {
      view.isRowHidden = false
    }
    await connect($)

    return next(e)
  })

  // Claude Code raises session.measure after each turn, with usage figures
  // and no text. The mod uses it as a clock: it asks again whether Waku is
  // connected, so the row follows a sign-in or a sign-out.
  on('session.measure', async ($, e, next) => {
    await connect($)

    return next(e)
  })

  on('command.run', { command: 'waku-memories' }, async $ => {
    try {
      return await run($)
    } catch {
      return said(COPY.failed)
    }
  }).catch(() => said(COPY.failed))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (view.reason !== 'auth' || view.isRowHidden || e.props?.hasSurvey) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)

    return Box({
      columnGap: 2,
      children: [
        Text({ children: [COPY.signIn] }),
        Button({ key: 'hide', label: COPY.hide, role: 'dismiss', onPress: () => hideRow($) }),
      ],
    })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const { Box, Button, Text } = kit
    const opened = (view.memories ?? []).find(memory => memory.id === view.openId)

    return Box({
      flexDirection: 'column',
      rowGap: 1,
      children: [
        Box({
          columnGap: 2,
          children: [
            Text({ children: [view.project === '' ? COPY.heading : COPY.inProject(view.project)] }),
            Button({ key: 'refresh', label: COPY.refresh, onPress: () => load($) }),
          ],
        }),
        view.error !== '' ? Text({ color: 'error', children: [view.error] }) : null,
        opened === undefined ? list($, e, kit) : detail($, kit, opened),
      ].filter(Boolean),
    })
  })
}
