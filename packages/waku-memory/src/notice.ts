// The one line a person sees when Waku adds memories to a prompt (hook
// `systemMessage`, decided 2026-10-10). Without it injection is invisible:
// the context reaches the model and never the screen.
//
// The plugin route builds this line on the server (waku_api/injection.py
// notice()); POST /ingest/turn answers only the context, so the shim rebuilds
// the same line from it. The rules below mirror that function: count every
// memory, quote the first three, cut each to 50 terminal columns (a Chinese
// character takes two), and drop control characters.

const SHOWN = 3
const COLUMNS = 50
// injection.py render(): `- [kind, YYYY-MM-DD] body`, one memory per line.
const MEMORY_LINE = /^- \[[^\]]*\] (.*)$/

const width = (c: string): number => {
  const cp = c.codePointAt(0) ?? 0
  // East Asian Wide and Fullwidth ranges that matter here: CJK, kana, Hangul,
  // fullwidth forms, and emoji.
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1
}

export function short(body: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = body.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  const chars = [...flat]
  let used = 0
  let end = chars.length
  for (let i = 0; i < chars.length; i++) {
    used += width(chars[i])
    if (used > COLUMNS) {
      end = i
      break
    }
  }
  if (end === chars.length) return flat
  const space = chars.slice(0, end).lastIndexOf(' ')
  if (space >= Math.floor((end * 3) / 4)) end = space
  return chars.slice(0, end).join('').trimEnd() + '…'
}

export function noticeFrom(context: string): string | undefined {
  const bodies = context
    .split('\n')
    .map((line) => MEMORY_LINE.exec(line)?.[1])
    .filter((b): b is string => b !== undefined)
  if (bodies.length === 0) return undefined
  const quoted = bodies.slice(0, SHOWN).map((b) => `"${short(b)}"`).join(' · ')
  const noun = bodies.length === 1 ? 'memory' : 'memories'
  const more = bodies.length > SHOWN ? ` and ${bodies.length - SHOWN} more` : ''
  return `Waku added ${bodies.length} ${noun} to this prompt: ${quoted}${more}`
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// The line shown when a session is briefed; mirrors waku_api/brief.py
// notice(). POST /brief answers `shown` (standing preferences shown),
// `memory_ids` (those, then one id per topic) and `visible`.
export function briefNotice(project: string, shown: number, topics: number, visible: number): string {
  const parts: string[] = []
  if (shown) parts.push(count(shown, 'standing preference', 'standing preferences'))
  if (topics) parts.push(`${count(topics, 'topic', 'topics')} from project ${project}`)
  if (parts.length) {
    return `Waku added ${parts.join(' and ')} to this session, out of ${count(visible, 'saved memory', 'saved memories')}`
  }
  if (visible) {
    return `Waku added a summary of ${count(visible, 'saved memory', 'saved memories')} for project ${project} to this session`
  }
  return `Waku has no memories for project ${project} yet`
}

// The brief line from POST /brief's answer, or undefined when the answer
// lacks the numbers (a server older than spec 029).
export function briefNoticeFrom(project: string, body: { shown?: unknown; visible?: unknown; memory_ids?: unknown }): string | undefined {
  const { shown, visible, memory_ids: ids } = body
  if (typeof shown !== 'number' || typeof visible !== 'number' || !Array.isArray(ids)) return undefined
  return briefNotice(project, shown, Math.max(0, ids.length - shown), visible)
}
