#!/usr/bin/env node
// Census of Codex rollout record shapes (spec 012 §5): the drift alarm for
// the codex-dialogue-v1 rule (packages/waku-memory/src/dialogue-codex.ts). When argv[2] is
// a directory: walks recursively and censuses every rollout-*.jsonl file
// under it (real rollouts are named rollout-<timestamp>-<uuid>.jsonl).
// When argv[2] is a file: censuses that one file regardless of its name
// (use this for manual testing against fixtures like
// tests/fixtures/codex-dialogue-v1/transcript.jsonl). Defaults to
// ~/.codex/sessions if argv[2] is absent. Counts `type/payload.type:role`
// combinations, then flags the combinations that formatCodexLine would drop
// but that spec §5's table does not name -- evidence the rule needs a new
// case, not just proof it runs. Reads files only: it counts shapes, never
// prints message text, so it is safe to run against a real transcript.
// No dependencies.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The record shapes codex-dialogue-v1 (packages/waku-memory/src/dialogue-codex.ts) already
// accounts for -- kept, or knowingly dropped -- per spec 012 §5's table.
// A `type` in this set is known regardless of its payload; for
// `response_item`, only these `payload.type` values (and anything ending
// `_output`, for the *_output family) are known. Keep this list in sync
// with dialogue-codex.ts by hand -- this script cannot import the .ts rule
// without a build step, so it re-states the same table instead.
const KNOWN_BARE_TYPES = new Set(['session_meta', 'turn_context', 'world_state', 'event_msg', 'token_usage_record'])
const KNOWN_RESPONSE_ITEM_PAYLOAD_TYPES = new Set(['message', 'function_call', 'custom_tool_call', 'reasoning'])

function isKnown(type, payloadType) {
  if (KNOWN_BARE_TYPES.has(type)) return true
  if (type !== 'response_item') return false
  if (payloadType === undefined) return false
  if (KNOWN_RESPONSE_ITEM_PAYLOAD_TYPES.has(payloadType)) return true
  return typeof payloadType === 'string' && payloadType.endsWith('_output')
}

function findJsonlFiles(root) {
  const out = []
  let stat
  try {
    stat = statSync(root)
  } catch {
    return out // cannot stat root -- return empty list, let caller handle it
  }
  if (stat.isFile()) {
    // argv[2] names a file: census it regardless of its name (fixture testing)
    return [root]
  }
  // argv[2] names a directory: walk it and match only rollout-*.jsonl
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // unreadable or missing directory -- skip it, don't crash the census
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  return out
}

function keyFor(record) {
  const type = typeof record.type === 'string' ? record.type : String(record.type)
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : undefined
  const payloadType = payload && typeof payload.type === 'string' ? payload.type : undefined
  const role = payload && typeof payload.role === 'string' ? payload.role : undefined
  let key = type
  if (payloadType !== undefined) key += '/' + payloadType
  if (role !== undefined) key += ':' + role
  return { key, type, payloadType }
}

function census(root) {
  const counts = new Map() // key -> count
  const unknown = new Map() // "type/payload.type" -> count
  let files = 0
  let lines = 0
  let invalid = 0

  for (const file of findJsonlFiles(root)) {
    files += 1
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      lines += 1
      let record
      try {
        record = JSON.parse(line)
      } catch {
        invalid += 1
        continue
      }
      if (!record || typeof record !== 'object') {
        invalid += 1
        continue
      }
      const { key, type, payloadType } = keyFor(record)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (!isKnown(type, payloadType)) {
        const unknownKey = payloadType !== undefined ? `${type}/${payloadType}` : type
        unknown.set(unknownKey, (unknown.get(unknownKey) ?? 0) + 1)
      }
    }
  }

  return { counts, unknown, files, lines, invalid }
}

function main() {
  const root = process.argv[2] ?? join(homedir(), '.codex', 'sessions')
  const { counts, unknown, files, lines, invalid } = census(root)

  console.log(`root: ${root}`)
  console.log(`files: ${files}  records: ${lines}  invalid JSON lines: ${invalid}`)
  console.log('')
  console.log('type/payload.type:role counts:')
  for (const key of [...counts.keys()].sort()) {
    console.log(`  ${counts.get(key)}\t${key}`)
  }
  console.log('')
  console.log('unknown to codex-dialogue-v1:')
  if (unknown.size === 0) {
    console.log('  (none)')
  } else {
    for (const key of [...unknown.keys()].sort()) {
      console.log(`  ${unknown.get(key)}\t${key}`)
    }
  }
}

main()
