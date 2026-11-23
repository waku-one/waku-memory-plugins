import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeMcpConfig } from './harnesses.ts'

test('adds our server without disturbing what is already there', () => {
  const existing = { mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } } }
  const merged = mergeMcpConfig(existing, 'waku', 'https://example.test/mcp')
  assert.equal(merged.mcpServers.sentry.url, 'https://mcp.sentry.dev/mcp')
  assert.equal(merged.mcpServers.waku.url, 'https://example.test/mcp')
})

test('is idempotent', () => {
  const once = mergeMcpConfig({}, 'waku', 'https://example.test/mcp')
  const twice = mergeMcpConfig(once, 'waku', 'https://example.test/mcp')
  assert.deepEqual(once, twice)
})

test('does not clobber a hand-edited entry of the same name', () => {
  // Someone may have added it manually with a different URL or extra
  // headers. Overwriting silently would undo a deliberate choice, and the
  // person would have no way to know which run did it.
  const existing = { mcpServers: { waku: { type: 'http', url: 'https://old.test/mcp' } } }
  assert.throws(() => mergeMcpConfig(existing, 'waku', 'https://example.test/mcp'), /already configured/)
})
