// The plugin Anthropic's plugin directory gets (2026-11-10). Since about
// 2026-11-05 the directory refuses, from an organization it has not
// Verified, every hook (an `mcp_tool` hook included), every file outside a
// short list of types, and every config field outside a short list. The
// full plugin keeps its hooks in plugins/waku/; this one is built from the
// same files without them. Each test below is one of the
// directory's rules, so a change that would be refused fails here first.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { directoryPlugin, writeDirectoryPlugin } from '../scripts/directory-plugin.mjs'

// The directory's own list for a remote MCP server's entry, written here and
// not imported, so a generator that let a field through would fail.
const SERVER_FIELDS = ['type', 'url', 'headers', 'timeout', 'alwaysLoad', 'oauth', 'name', 'title', 'displayName', 'description']
const OAUTH_FIELDS = ['clientId', 'callbackPort', 'authServerMetadataUrl', 'scopes']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// A file of the full plugin, plugins/waku/.
const full = (p) => readFileSync(join(root, 'plugins', 'waku', p))
const files = directoryPlugin(root)
const text = (p) => files.get(p).toString('utf8')
const json = (p) => JSON.parse(text(p))

const PROCESSORS = [/Anthropic/, /Voyage/, /Supabase/, /Amazon Web Services/, /Stripe/]

test('the directory plugin carries no hook of any type', () => {
  assert.deepEqual([...files.keys()].filter((p) => /hook/i.test(p)), [])
  assert.equal('hooks' in json('.claude-plugin/plugin.json'), false)
  assert.equal('hooks' in json('.mcp.json'), false)
  for (const [path, body] of files) {
    if (path.endsWith('.json')) assert.doesNotMatch(body.toString('utf8'), /mcp_tool/, path)
    if (path.endsWith('SKILL.md')) {
      const frontmatter = body.toString('utf8').split(/\r?\n---\r?\n/)[0]
      assert.doesNotMatch(frontmatter, /^hooks\s*:/m, path)
    }
  }
})

test('every file is a type the directory accepts from any organization', () => {
  const allowed = /\.(md|txt|json|ya?ml|png|jpe?g|gif|webp|ico)$/
  for (const [path, body] of files) {
    assert.ok(allowed.test(path) || path === 'LICENSE', `${path} is not an allowed type`)
    assert.notEqual(body.subarray(0, 2).toString('latin1'), '#!', `${path} starts with #!`)
    if (!/\.(png|jpe?g|gif|webp|ico)$/.test(path)) {
      assert.equal(body.includes(0), false, `${path} holds a NUL byte`)
      assert.equal(Buffer.from(body.toString('utf8'), 'utf8').equals(body), true, `${path} is not UTF-8`)
    }
  }
})

test('the MCP server entry holds only fields the directory allows', () => {
  assert.deepEqual(Object.keys(json('.mcp.json')), ['mcpServers'])
  const servers = json('.mcp.json').mcpServers
  const fullServers = JSON.parse(full('.mcp.json').toString('utf8')).mcpServers
  assert.deepEqual(Object.keys(servers), Object.keys(fullServers))
  for (const [name, server] of Object.entries(servers)) {
    for (const key of Object.keys(server)) assert.ok(SERVER_FIELDS.includes(key), `${name}.${key} is not a field the directory allows`)
    for (const key of Object.keys(server.oauth ?? {})) assert.ok(OAUTH_FIELDS.includes(key), `${name}.oauth.${key}`)
    assert.equal(server.type, fullServers[name].type)
    assert.equal(server.url, fullServers[name].url)
  }
})

test('the manifest matches the package, and the skills are the hook-less ones', () => {
  const manifest = json('.claude-plugin/plugin.json')
  const pkg = JSON.parse(readFileSync(join(root, 'packages/waku-memory/package.json'), 'utf8'))
  assert.equal(manifest.name, 'waku')
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.skills, './skills/')
  assert.deepEqual([...files.keys()].filter((p) => p.startsWith('skills/')).sort(), [
    'skills/waku-setup/SKILL.md',
    'skills/waku/SKILL.md',
  ])
  assert.ok(files.get('skills/waku/SKILL.md').equals(full('skills-without-hooks/waku/SKILL.md')))
  assert.ok(files.get('skills/waku-setup/SKILL.md').equals(full('skills/waku-setup/SKILL.md')))
  assert.ok(files.get('.claude-plugin/icon.png').equals(full('.claude-plugin/icon.png')))
  assert.deepEqual([...files.keys()].filter((p) => p.startsWith('.codex-plugin/')), [])
})

// The directory fills the listing's name from plugin.json: `displayName`
// when it is set, otherwise `name` ("Waku"). `name` stays `waku`, because
// install commands, skill and tool names and the hooks depend on it
// (Ian, 2026-11-11). Keywords also come from plugin.json.
test('the listing is titled "Waku Memory" and carries keywords', () => {
  const manifest = json('.claude-plugin/plugin.json')
  assert.equal(manifest.name, 'waku')
  assert.equal(manifest.displayName, 'Waku Memory')
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0)
  for (const word of manifest.keywords) assert.match(word, /^[a-z0-9-]+$/)
  assert.ok(manifest.keywords.includes('memory'))
})

test('the description and README say no hook runs, name no processor, and point at the privacy list', () => {
  for (const [what, body] of [
    ['description', json('.claude-plugin/plugin.json').description],
    ['README.md', text('README.md')],
  ]) {
    const flat = body.replace(/\s+/g, ' ')
    assert.match(flat, /runs no hooks/, what)
    assert.match(flat, /www\.waku\.one\/privacy/, what)
    for (const name of PROCESSORS) assert.doesNotMatch(flat, name, `${what} must not name ${name.source}`)
  }
  const readme = text('README.md').replace(/\s+/g, ' ')
  assert.match(readme, /waku-one\/waku-memory-plugins/)
  assert.match(readme, /npx -y waku-memory full-record on/)
  // The submission form asks whether a skill sends data to a service other
  // than the declared connector. The answer is "No" (Ian, 2026-11-11): in
  // Claude Code the waku-setup skill runs the npm CLI, which calls Waku's
  // REST API directly rather than through the MCP server, but that API is
  // the same Waku service at api.waku.one. The README names the path anyway.
  assert.match(readme, /npx -y waku-memory setup save/)
  assert.match(readme, /npm registry/)
  assert.match(readme, /https:\/\/api\.waku\.one\/setup/)
})

test('writing the plugin replaces the folder with exactly these files', () => {
  const out = mkdtempSync(join(tmpdir(), 'waku-directory-'))
  mkdirSync(join(out, 'hooks'), { recursive: true })
  writeFileSync(join(out, 'hooks', 'claude-code.json'), '{}')
  writeDirectoryPlugin(root, out)
  const written = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else written.push(relative(out, full).split('\\').join('/'))
    }
  }
  walk(out)
  assert.deepEqual(written.sort(), [...files.keys()].sort())
  assert.equal(existsSync(join(out, 'hooks')), false)
  assert.ok(readFileSync(join(out, '.mcp.json')).equals(files.get('.mcp.json')))
})

// spec 083: the directory's submission reads a fixed folder, and the
// `directory` branch holds these files and nothing else.
test('the directory plugin is exactly these 7 files', () => {
  assert.deepEqual([...directoryPlugin(root).keys()].sort(), [
    '.claude-plugin/icon.png', '.claude-plugin/plugin.json', '.mcp.json',
    'LICENSE', 'README.md', 'skills/waku-setup/SKILL.md', 'skills/waku/SKILL.md',
  ])
})
