// tests/marketplace.test.mjs -- spec 083. The two marketplace files, and
// what the folder they name may hold.
//
// Claude Code and Codex copy plugins/waku/ into each person's plugin cache.
// A marketplace entry for the hook-less directory plugin would let a person
// install it over the full one (gotchas, 2026-11-10). A package.json, a
// TypeScript file or a test in plugins/waku/ would land in every cache.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MARKETPLACES = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']
const marketplace = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))
// Claude Code writes the source as a path. Codex writes { source, path }.
const sourceOf = (entry) => (typeof entry.source === 'string' ? entry.source : entry.source.path)

test('each marketplace lists one plugin, and its source is ./plugins/waku', () => {
  for (const file of MARKETPLACES) {
    const { plugins } = marketplace(file)
    assert.equal(plugins.length, 1, file)
    assert.equal(plugins[0].name, 'waku', file)
    assert.equal(sourceOf(plugins[0]), './plugins/waku', file)
  }
})

test('no marketplace names the hook-less directory plugin', () => {
  for (const file of MARKETPLACES) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /waku-directory/, file)
  }
})

test('plugins/waku holds plugin files only', () => {
  const plugin = join(root, 'plugins', 'waku')
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [`${entry.name}/`, ...walk(join(dir, entry.name))] : [join(dir, entry.name)],
    )
  const found = walk(plugin).map((p) => (p.endsWith('/') ? p : relative(plugin, p).split('\\').join('/')))
  assert.ok(found.includes('hooks/waku-mod.mjs'))
  for (const p of found) {
    assert.notEqual(p, 'node_modules/', 'plugins/waku holds a node_modules folder')
    assert.doesNotMatch(p, /(^|\/)package(-lock)?\.json$/, p)
    assert.doesNotMatch(p, /\.tsx?$/, p)
    assert.doesNotMatch(p, /\.test\.[a-z]+$/, p)
    // The Claude Code mod is the one program in the plugin (spec 095).
    if (p !== 'hooks/waku-mod.mjs') assert.doesNotMatch(p, /\.[cm]?js$/, p)
  }
})
