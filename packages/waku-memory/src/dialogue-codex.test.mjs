// The codex-dialogue-v1 rule (spec 012 §5) and its byte-for-byte fixture.
// tests/fixtures/codex-dialogue-v1 pins formatCodexDelta's output; a rule
// change is a fixture/expected.txt change, not an edit made in isolation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODEX_CONTENT_FORMAT, formatCodexDelta, formatCodexLine } from './dialogue-codex.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'codex-dialogue-v1')
const transcript = readFileSync(join(FIXTURES, 'transcript.jsonl'))
const expected = readFileSync(join(FIXTURES, 'expected.txt'), 'utf8')

test('(a) the fixture formats to expected.txt byte for byte, in one piece; end stops after the last complete line', () => {
  const { pieces, end } = formatCodexDelta(transcript)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].text + '\n', expected)
  const lastNewline = transcript.lastIndexOf(0x0a)
  assert.equal(end, lastNewline + 1)
  assert.equal(pieces[0].end, lastNewline + 1)
  assert.ok(end < transcript.length, 'the trailing partial line must not be consumed')
})

test('(b) a user text starting with a harness tag after leading blanks is dropped; a different tag is not', () => {
  const tagged = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '\t<recommended_plugins>\nlist' }] },
  })
  assert.deepEqual(formatCodexLine(tagged), [])

  const untagged = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins_v2>\nlist' }] },
  })
  assert.deepEqual(formatCodexLine(untagged), [{ role: 'user', text: '<recommended_plugins_v2>\nlist' }])
})

test('(c) a developer message is dropped', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>x' }] },
  })
  assert.deepEqual(formatCodexLine(line), [])
})

test('(d) a custom_tool_call whose script mentions two tools twice yields two tool entries, first-appearance order', () => {
  const line = JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: "await tools.mcp__waku__memory_recall({});\nawait tools.mcp__waku__memory_search({});\nawait tools.mcp__waku__memory_recall({});",
    },
  })
  assert.deepEqual(formatCodexLine(line), [
    { role: 'tool', text: 'mcp__waku__memory_recall' },
    { role: 'tool', text: 'mcp__waku__memory_search' },
  ])
})

test('(e) an unknown record type is dropped', () => {
  assert.deepEqual(formatCodexLine(JSON.stringify({ type: 'future_thing', payload: {} })), [])
})

test('(f) invalid JSON is dropped, not thrown', () => {
  assert.deepEqual(formatCodexLine('{nope'), [])
  assert.deepEqual(formatCodexLine(''), [])
})

test('(g) CODEX_CONTENT_FORMAT is codex-dialogue-v1', () => {
  assert.equal(CODEX_CONTENT_FORMAT, 'codex-dialogue-v1')
})
