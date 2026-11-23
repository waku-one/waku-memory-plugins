// The plugin Anthropic's plugin directory gets, built from the shim's own
// files (Ian, 2026-11-10).
//
// Since about 2026-11-05 the directory refuses three things from an
// organization it has not Verified: every hook, whatever its type (our
// `mcp_tool` hooks included); every file that is not Markdown, text, JSON,
// YAML or an allowed image; and every config field outside its lists.
// Anthropic picks the Verified organizations and takes no requests yet. So
// the full plugin, hooks and all, stays in waku-one/waku-memory-plugins
// under plugins/waku, and this module builds the one the directory reads:
// the same MCP server, the hook-less waku skill (the one the OpenAI
// directory already gets, since it forbids hooks too), the waku-setup skill
// and the icon. Codex's manifest and its SVG logo stay out; Codex installs
// from our marketplace.
//
//   node scripts/directory-plugin.mjs <output folder>
//
// replaces that folder with exactly these files. The plugins repo's
// scripts/sync-from-shim.sh runs it into plugins/waku-directory.
// src/directory-plugin.test.mjs holds one test per directory rule.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The fields the directory accepts on a remote MCP server's entry.
export const DIRECTORY_SERVER_FIELDS = [
  'type',
  'url',
  'headers',
  'timeout',
  'alwaysLoad',
  'oauth',
  'name',
  'title',
  'displayName',
  'description',
]

export const DIRECTORY_DESCRIPTION =
  'Waku Memory: durable memory that follows you across sessions, agents and computers. ' +
  'memory.search finds what is known about a task; memory.remember keeps what matters. ' +
  'When you ask, it also saves your agent setup (MCP servers, plugins, connectors and scheduled tasks, ' +
  'with every secret removed first), so that a new computer or account can be set up the same way. ' +
  'This version of the plugin runs no hooks, so nothing is sent until the agent calls a tool or you ask it to save your setup. ' +
  "What the agent passes to a tool is sent to Waku's servers and on to the AI providers that make it " +
  'searchable, named at www.waku.one/privacy. This is an alpha and its data can be lost.'

function json(value) {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8')
}

function pick(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => keys.includes(key)))
}

// Every file of the directory plugin, by its path inside the plugin.
export function directoryPlugin(root) {
  const read = (p) => readFileSync(join(root, p))
  const { hooks: _hooks, ...manifest } = JSON.parse(read('.claude-plugin/plugin.json').toString('utf8'))
  const { mcpServers } = JSON.parse(read('.mcp.json').toString('utf8'))
  const servers = Object.fromEntries(
    Object.entries(mcpServers).map(([name, server]) => [name, pick(server, DIRECTORY_SERVER_FIELDS)]),
  )
  return new Map([
    ['.claude-plugin/plugin.json', json({ ...manifest, description: DIRECTORY_DESCRIPTION })],
    ['.claude-plugin/icon.png', read('.claude-plugin/icon.png')],
    ['.mcp.json', json({ mcpServers: servers })],
    ['LICENSE', read('LICENSE')],
    ['README.md', read('directory/README.md')],
    ['skills/waku/SKILL.md', read('skills-without-hooks/waku/SKILL.md')],
    ['skills/waku-setup/SKILL.md', read('skills/waku-setup/SKILL.md')],
  ])
}

// Replace `out` with exactly the directory plugin's files.
export function writeDirectoryPlugin(root, out) {
  rmSync(out, { recursive: true, force: true })
  for (const [path, body] of directoryPlugin(root)) {
    const target = join(out, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out) {
    console.error('Usage: node scripts/directory-plugin.mjs <output folder>')
    process.exit(1)
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  writeDirectoryPlugin(root, resolve(out))
  console.log(`Wrote the directory plugin to ${resolve(out)}`)
}
