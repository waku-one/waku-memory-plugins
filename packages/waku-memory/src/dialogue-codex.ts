// The codex-dialogue-v1 rule (spec 012 §5): the same three kinds of entry
// as cc-dialogue-v1, read out of Codex's rollout records.
import { formatDelta, type DialogueEntry, type Piece } from './dialogue.ts'

export const CODEX_CONTENT_FORMAT = 'codex-dialogue-v1'
export const CODEX_HARNESS_TAGS = ['<environment_context>', '<recommended_plugins>']
const LEADING_BLANKS = /^[ \t\r\n\f\v]+/
const TOOL_MENTION = /tools\.([A-Za-z0-9_]+)\(/g

function isHarnessTag(text: string): boolean {
  const t = text.replace(LEADING_BLANKS, '')
  return CODEX_HARNESS_TAGS.some((tag) => t.startsWith(tag))
}

function texts(content: unknown, partType: string): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: unknown }).type === partType) {
      const t = (c as { text?: unknown }).text
      if (typeof t === 'string' && t.length > 0) out.push(t)
    }
  }
  return out
}

export function formatCodexLine(line: string): DialogueEntry[] {
  let record: unknown
  try { record = JSON.parse(line) } catch { return [] }
  if (!record || typeof record !== 'object') return []
  const r = record as { type?: unknown; payload?: unknown }
  if (r.type !== 'response_item' || !r.payload || typeof r.payload !== 'object') return []
  const p = r.payload as { type?: unknown; role?: unknown; content?: unknown; name?: unknown; input?: unknown }
  if (p.type === 'message') {
    if (p.role === 'user') return texts(p.content, 'input_text').filter((t) => !isHarnessTag(t)).map((text) => ({ role: 'user', text }))
    if (p.role === 'assistant') return texts(p.content, 'output_text').map((text) => ({ role: 'assistant', text }))
    return []
  }
  if (p.type === 'function_call') return typeof p.name === 'string' ? [{ role: 'tool', text: p.name }] : []
  if (p.type === 'custom_tool_call') {
    const names: string[] = []
    if (typeof p.input === 'string') {
      for (const m of p.input.matchAll(TOOL_MENTION)) if (!names.includes(m[1])) names.push(m[1])
    }
    if (names.length === 0) names.push(typeof p.name === 'string' ? p.name : 'exec')
    return names.map((text) => ({ role: 'tool', text }))
  }
  return []
}

export function formatCodexDelta(buf: Buffer, maxPieceBytes?: number): { pieces: Piece[]; end: number } {
  return formatDelta(buf, maxPieceBytes, formatCodexLine)
}
