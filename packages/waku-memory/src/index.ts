#!/usr/bin/env node
// npx waku-memory setup -- writes the waku MCP server's URL into every
// harness config this shim knows how to edit safely, without disturbing
// anything already there (harnesses.ts:mergeMcpConfig).
//
// This obtains no credential and stores none. The harness itself hits the
// server, gets a 401 naming a protected-resource document, runs discovery,
// opens a browser, and holds the resulting token -- ops-design §5 and spec
// 003's real client both settled that a URL is all an install step needs to
// write. The import itself is not this shim's job either: the agent does
// that afterwards, through memory.import, because by then it already has
// both the file access and the token.
//
// The actual argument dispatch and per-harness logic lives in cli.ts,
// which has no top-level side effects on import -- cli.test.mjs imports it
// directly, without this file (or its shebang, or process.argv) coming
// along for the ride.

import { run } from './cli.ts'

run(process.argv.slice(2))
