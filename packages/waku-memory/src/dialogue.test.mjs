// The cc-dialogue-v1 rule (spec 011 §1) and the piece cut (§3). The
// fixture under tests/fixtures/ is shared with the worker's Python
// implementation: the two are pinned to the same expected output byte for
// byte, so a rule change is a two-file change or a test failure.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONTENT_FORMAT, MAX_PIECE_BYTES, formatDelta, formatRecord } from './dialogue.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'cc-dialogue-v1')
const transcript = readFileSync(join(FIXTURES, 'transcript.jsonl'))
const expected = readFileSync(join(FIXTURES, 'expected.txt'), 'utf8')

test('the fixture formats to expected.txt byte for byte, in one piece', () => {
  const { pieces, end } = formatDelta(transcript)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].text + '\n', expected)
  assert.equal(end, transcript.length)
  assert.equal(pieces[0].end, transcript.length)
  assert.deepEqual(pieces[0].entries.slice(0, 3), [
    { role: 'user', text: 'Say hello in one sentence. No tools.' },
    { role: 'assistant', text: 'Hello — ready when you are.' },
    { role: 'tool', text: 'Bash' },
  ])
})

test('nothing from a tool result, a thinking block, a tagged text or a meta record survives', () => {
  const { pieces } = formatDelta(transcript)
  for (const leak of ['hunter2', 'the person wants brevity', 'Set model to opus', 'injected by the harness', 'secret.py', 'Waku memory for project', 'Subagent report', '7e3deee']) {
    assert.doesNotMatch(pieces[0].text, new RegExp(leak))
  }
})

test('formatRecord: a user record whose only text is tagged is dropped whole', () => {
  const line = JSON.stringify({ type: 'user', message: { content: '  <command-name>/model</command-name>' } })
  assert.equal(formatRecord(line), null)
})

test('formatRecord: a line that is not JSON is dropped, not thrown', () => {
  assert.equal(formatRecord('{nope'), null)
  assert.equal(formatRecord(''), null)
})

test('formatRecord: leading blanks before the tag test are exactly ASCII whitespace, matching the Python twin', () => {
  assert.equal(formatRecord(JSON.stringify({ type: 'user', message: { content: '\t<system-reminder>x' } })), null)
  assert.equal(
    formatRecord(JSON.stringify({ type: 'user', message: { content: '\u0085<system-reminder>x' } })),
    'user: \u0085<system-reminder>x',
  )
})

test('formatDelta: the trailing partial line is not consumed and end stops at the last newline', () => {
  const whole = Buffer.from(
    JSON.stringify({ type: 'user', message: { content: 'first' } }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: 'second, still being written' } }).slice(0, 20),
  )
  const { pieces, end } = formatDelta(whole)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].text, 'user: first')
  assert.equal(end, whole.indexOf(0x0a) + 1)
})

test('formatDelta: records are packed into pieces under the cap at record boundaries, each piece knowing its end offset', () => {
  const rec = (i) => JSON.stringify({ type: 'user', message: { content: `m${i} ` + 'x'.repeat(60 * 1024) } }) + '\n'
  const buf = Buffer.from(rec(1) + rec(2) + rec(3) + rec(4))
  const { pieces, end } = formatDelta(buf, 130 * 1024)
  assert.equal(pieces.length, 2)
  assert.ok(Buffer.byteLength(pieces[0].text) < 130 * 1024)
  assert.match(pieces[0].text, /^user: m1 /)
  assert.match(pieces[0].text, /user: m2 /)
  assert.equal(pieces[0].end, Buffer.byteLength(rec(1) + rec(2)))
  assert.equal(pieces[1].end, buf.length)
  assert.equal(end, buf.length)
})

test('formatDelta: a delta of only dropped records yields no piece but still consumes to the last newline', () => {
  const buf = Buffer.from(JSON.stringify({ type: 'system', content: 'x' }) + '\n' + JSON.stringify({ type: 'queue-operation' }) + '\n')
  const { pieces, end } = formatDelta(buf)
  assert.deepEqual(pieces, [])
  assert.equal(end, buf.length)
})

test('constants are what the spec says', () => {
  assert.equal(CONTENT_FORMAT, 'cc-dialogue-v1')
  assert.equal(MAX_PIECE_BYTES, 200 * 1024)
})
