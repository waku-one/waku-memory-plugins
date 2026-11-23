// cc-dialogue-v1 (spec 011 §1): the fixed rule that turns a transcript
// delta into the conversation before it leaves the machine, and the piece
// cut (§3) that keeps every request under the ingest cap. No judgement
// lives here -- record types and block types only -- and the rule is
// versioned: a change is a new CONTENT_FORMAT, not an edit to this one.
//
// The same rule exists in Python (waku_worker/dialogue.py) for raw jobs
// from 0.1.x shims; tests/fixtures/cc-dialogue-v1 pins both to one output.

export const CONTENT_FORMAT = 'cc-dialogue-v1'
export const MAX_PIECE_BYTES = 200 * 1024 // under the 256 KiB ingest cap, with room for one long record

// Text Claude Code itself writes into `user` records: a subagent's
// completion report, slash-command output, reminders. A text starting
// with one of these is the harness's, not the person's. The list is a
// census over Yang's machine on 2026-09-05 (task-notification 563,
// command-name 34, local-command-stdout 34, system-reminder 12) plus the
// caveat tag the harness documents for the same shape. Part of the
// format version: a new tag is cc-dialogue-v2, here and in the Python
// twin's list (waku_domain/harness_text.py, HARNESS_TAGS).
const HARNESS_TAGS = [
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<command-name>',
  '<system-reminder>',
]

// One block of dialogue: who said it and the verbatim text (for `tool`,
// the tool's name). Kept structured until the request body is built,
// because a text can contain a blank line and the joined form cannot be
// split back (§2's trailing-run test needs the boundaries).
export type DialogueEntry = { role: 'user' | 'assistant' | 'tool'; text: string }
export type Piece = { entries: DialogueEntry[]; text: string; end: number }

type Block = { type?: unknown; text?: unknown; name?: unknown }

// Named so the Python twin (waku_domain/harness_text.py) strips the same set:
// trimStart() and str.lstrip() disagree on U+001C-U+001F and U+0085.
const LEADING_BLANKS = /^[ \t\r\n\f\v]+/

function isTagged(text: string): boolean {
  const t = text.replace(LEADING_BLANKS, '')
  return HARNESS_TAGS.some((tag) => t.startsWith(tag))
}

function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content as Block[]) {
    if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out
}

// One JSONL line -> the entries the rule keeps, or none when it drops
// the line.
export function formatLine(line: string): DialogueEntry[] {
  let rec: unknown
  try {
    rec = JSON.parse(line)
  } catch {
    return []
  }
  if (rec === null || typeof rec !== 'object') return []
  const r = rec as { type?: unknown; isMeta?: unknown; isCompactSummary?: unknown; message?: { content?: unknown } }
  const content = r.message && typeof r.message === 'object' ? r.message.content : undefined
  if (r.type === 'user') {
    if (r.isMeta === true || r.isCompactSummary === true) return []
    return textBlocks(content)
      .filter((t) => !isTagged(t))
      .map((t) => ({ role: 'user' as const, text: t }))
  }
  if (r.type === 'assistant') {
    if (!Array.isArray(content)) return []
    const entries: DialogueEntry[] = []
    for (const b of content as Block[]) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') entries.push({ role: 'assistant', text: b.text })
      else if (b.type === 'tool_use' && typeof b.name === 'string') entries.push({ role: 'tool', text: b.name })
    }
    return entries
  }
  return []
}

export function renderEntry(e: DialogueEntry): string {
  if (e.role === 'user') return `user: ${e.text}`
  if (e.role === 'assistant') return `assistant: ${e.text}`
  return `assistant used tool: ${e.text}`
}

// The wire text: entries joined by one blank line.
export function renderEntries(entries: DialogueEntry[]): string {
  return entries.map(renderEntry).join('\n\n')
}

// One line -> one string or null: the contract the fixture test and the
// Python twin (waku_worker/dialogue.py) share.
export function formatRecord(line: string): string | null {
  const entries = formatLine(line)
  return entries.length > 0 ? renderEntries(entries) : null
}

// Formats every complete line of `buf` and packs the surviving entries
// into pieces under `maxPieceBytes`, cutting only between lines (§3): a
// line's entries always travel together. A trailing partial line (no
// newline yet) is left for the next event. `end` is the offset past the
// last newline consumed, whether or not anything survived -- the
// caller's watermark moves to it either way.
export function formatDelta(
  buf: Buffer,
  maxPieceBytes: number = MAX_PIECE_BYTES,
  lineFormatter: (line: string) => DialogueEntry[] = formatLine,
): { pieces: Piece[]; end: number } {
  const pieces: Piece[] = []
  let entries: DialogueEntry[] = []
  let entriesBytes = 0
  let pieceEnd = 0
  let lineStart = 0
  let end = 0

  const flush = (): void => {
    if (entries.length > 0) {
      pieces.push({ entries, text: renderEntries(entries), end: pieceEnd })
      entries = []
      entriesBytes = 0
    }
  }

  for (;;) {
    const nl = buf.indexOf(0x0a, lineStart)
    if (nl === -1) break
    const lineEnd = nl + 1
    const lineEntries = lineFormatter(buf.subarray(lineStart, nl).toString('utf8'))
    lineStart = lineEnd
    end = lineEnd
    if (lineEntries.length === 0) {
      pieceEnd = lineEnd
      continue
    }
    const bytes = Buffer.byteLength(renderEntries(lineEntries), 'utf8') + (entries.length > 0 ? 2 : 0)
    if (entries.length > 0 && entriesBytes + bytes > maxPieceBytes) flush()
    entries.push(...lineEntries)
    entriesBytes += bytes
    pieceEnd = lineEnd
  }
  flush()
  return { pieces, end }
}
