// tests/plugin.test.mjs -- spec 012 §2, Acceptance 2: the plugin files are exact.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The three product strings that are built by code rather than stored in a
// file, imported so the disclosure tests below check what a person is
// actually shown rather than a copy of it. Node strips the types itself;
// capture.test.mjs imports these same modules the same way.
import { DISCLOSURE, FULL_RECORD_DISCLOSURE } from '../packages/waku-memory/src/capture.ts'
import { importNote } from '../packages/waku-memory/src/cli.ts'
import { DEFAULT_WINDOW_DAYS, renderBootstrapList } from '../packages/waku-memory/src/bootstrap.ts'

// `read` and `src` take a path inside the plugin, plugins/waku/. `readJson`
// takes a path from the repository root.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = join(root, 'plugins', 'waku')
const read = (p) => JSON.parse(readFileSync(join(plugin, p), 'utf8'))
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))

// Enough of a scan for renderBootstrapList to reach its closing lines --
// on an empty one it returns a single "nothing to import" sentence and
// discloses nothing, which would pass the tests below without testing them.
const SAMPLE_SCAN = {
  projects: [],
  userClaudeMd: { path: '/home/u/.claude/CLAUDE.md', content: 'Be terse.\n' },
  harnesses: ['claude_code'],
}

const ALLOWED = {
  SessionStart: ['hook_event_name', 'session_id', 'cwd', 'source', 'transcript_path', 'model', 'permission_mode'],
  UserPromptSubmit: ['hook_event_name', 'session_id', 'cwd', 'turn_id', 'prompt', 'transcript_path', 'model', 'permission_mode'],
  Stop: ['hook_event_name', 'session_id', 'cwd', 'turn_id', 'last_assistant_message', 'stop_hook_active', 'transcript_path', 'model', 'permission_mode'],
}

test('plugin.json names the package, its version, its skills and its hooks', () => {
  const manifest = read('.codex-plugin/plugin.json')
  const pkg = readJson('packages/waku-memory/package.json')
  assert.equal(manifest.name, 'waku')
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.skills, './skills/')
  assert.equal(manifest.hooks, './hooks/codex.json')
  // The npm package holds the CLI and no plugin file (spec 083).
  assert.deepEqual(pkg.files, ['dist'])
})

test('.mcp.json declares the server both harnesses read, with approval on', () => {
  const mcp = read('.mcp.json')
  assert.deepEqual(mcp, { mcpServers: { waku: { type: 'http', url: 'https://api.waku.one/mcp', default_tools_approval_mode: 'approve' } } })
})

test('codex.json: three events, one tool, only documented placeholders', () => {
  const { hooks } = read('hooks/codex.json')
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|clear|compact')
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) for (const h of group.hooks) {
      assert.equal(h.type, 'mcp_tool'); assert.equal(h.server, 'waku'); assert.equal(h.tool, 'session.hook'); assert.equal(h.timeout, 10)
      assert.equal(h.input.harness, 'codex')
      assert.equal(h.input.event, '${hook_event_name}')
      for (const v of Object.values(h.input)) {
        const m = /^\$\{([a-z_]+)\}$/.exec(v)
        if (m) assert.ok(ALLOWED[event].includes(m[1]), `${event}: ${m[1]} is not a documented field`)
      }
    }
  }
})

test('SKILL.md has front matter naming the skill', () => {
  const skill = readFileSync(join(plugin, 'skills/waku/SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: waku\ndescription: .+\n---\n/)
})

// ---- description: the disclosure gap (2026-09-10, status.md item 9) ----
//
// plugin.json's description is what a person installing from Codex's
// Plugins directory sees before anything else -- packages/waku-memory/src/capture.test.mjs
// pins the same two facts in DISCLOSURE this way, matching load-bearing
// phrases rather than the whole string, and these mirror that shape.
//
// plugin.json cannot hold a code comment (it is JSON), so the cross-
// reference lives here instead: this text also lives in capture.ts's
// DISCLOSURE (which names the other five), skills/waku/SKILL.md's "sent
// to Waku" bullet, and, in waku-memory-frontend, the OAuth consent page's
// CONSENT_DISCLOSURE (lib/auth/consent-disclosure.ts) and the privacy
// policy's processor list (public/waku/privacy.html section 4). No
// mechanism shares the string; a change to either fact here has to be
// carried to the other five by hand.
//
// Spec 025 added a third vendor and proved the hazard: the facts were
// pinned in two of the six files, so four could have shipped stale. The
// vendor test below now walks every file in this repo that states where
// content goes, which turns a missed one into a failure here. The two
// frontend files are out of its reach; consent-disclosure.test.mjs pins
// those, and the privacy policy is cross-referenced from it.

test('plugin.json description says where captured content goes and that this is an alpha', () => {
  const manifest = read('.codex-plugin/plugin.json')
  assert.match(manifest.description, /sent to Waku's servers and on to the AI providers/)
  assert.match(manifest.description, /turn a session into memories and make them searchable/)
  assert.match(manifest.description, /your files, the commands the agent runs and its reasoning are not/)
  assert.match(manifest.description, /alpha/i)
  assert.match(manifest.description, /data can be lost/)
})

const CC_ALLOWED = {
  SessionStart: ['hook_event_name', 'session_id', 'cwd', 'source'],
  UserPromptSubmit: ['hook_event_name', 'session_id', 'cwd', 'prompt'],
  Stop: ['hook_event_name', 'session_id', 'cwd', 'last_assistant_message'],
}

test('claude-code.json: three events, the scoped server, the harness literal, only documented placeholders', () => {
  const { hooks } = read('hooks/claude-code.json')
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
  // Only `compact`: the server clears the session's brief on that source
  // and serves it again, so a compacted session gets its memories back
  // without calling memory.recall (measured 2026-10-10: after a compaction
  // nothing else brought them back). Not `startup`: Claude Code skips an
  // mcp_tool hook at launch, before its MCP servers are up, and the first
  // prompt brings the brief there anyway.
  assert.equal(hooks.SessionStart[0].matcher, 'compact')
  assert.equal(hooks.SessionStart[0].hooks[0].input.source, '${source}')
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) for (const h of group.hooks) {
      assert.equal(h.type, 'mcp_tool'); assert.equal(h.server, 'plugin:waku:waku'); assert.equal(h.tool, 'session.hook'); assert.equal(h.timeout, 10)
      assert.equal(h.input.harness, 'claude_code')
      assert.equal(h.input.event, '${hook_event_name}')
      for (const v of Object.values(h.input)) {
        const m = /^\$\{([a-z_]+)\}$/.exec(v)
        if (m) assert.ok(CC_ALLOWED[event].includes(m[1]), `${event}: ${m[1]} is not a documented field`)
      }
    }
  }
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].input.prompt, '${prompt}')
  assert.equal(hooks.Stop[0].hooks[0].input.last_assistant_message, '${last_assistant_message}')
})

// spec 086: Waku Agent's own manifest. Waku Agent reads .waku-plugin first,
// declares its server inline under the id its model already knows
// (`waku_memory`, so tool names stay `waku_memory_memory_*`), and sends the
// harness literal `waku`, the value the server's Harness set holds for it.
const WAKU_ALLOWED = {
  SessionStart: ['hook_event_name', 'session_id', 'cwd', 'source'],
  UserPromptSubmit: ['hook_event_name', 'session_id', 'cwd', 'turn_id', 'prompt'],
  Stop: ['hook_event_name', 'session_id', 'cwd', 'turn_id', 'last_assistant_message'],
}

test('.waku-plugin/plugin.json names the package, its hooks file, the skills and the waku_memory server', () => {
  const manifest = read('.waku-plugin/plugin.json')
  const pkg = readJson('packages/waku-memory/package.json')
  assert.equal(manifest.name, 'waku')
  assert.equal(manifest.version, pkg.version)
  assert.equal(manifest.hooks, './hooks/waku-agent.json')
  assert.equal(manifest.skills, './skills/')
  assert.deepEqual(Object.keys(manifest.mcpServers), ['waku_memory'])
  assert.equal(manifest.mcpServers.waku_memory.url, read('.mcp.json').mcpServers.waku.url)
})

test('waku-agent.json: three events, the waku_memory server, the harness literal, no PreToolUse', () => {
  const { hooks } = read('hooks/waku-agent.json')
  assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      assert.equal('matcher' in group, false, `${event}: Waku Agent ignores matchers`)
      for (const h of group.hooks) {
        assert.equal(h.type, 'mcp_tool'); assert.equal(h.server, 'waku_memory'); assert.equal(h.tool, 'session.hook'); assert.equal(h.timeout, 10)
        assert.equal(h.input.harness, 'waku')
        assert.equal(h.input.event, '${hook_event_name}')
        for (const v of Object.values(h.input)) {
          const m = /^\$\{([a-z_]+)\}$/.exec(v)
          if (m) assert.ok(WAKU_ALLOWED[event].includes(m[1]), `${event}: ${m[1]} is not a field Waku Agent sends`)
        }
      }
    }
  }
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].input.turn_id, '${turn_id}')
  assert.equal(hooks.Stop[0].hooks[0].input.turn_id, '${turn_id}')
  assert.equal(hooks.Stop[0].hooks[0].input.last_assistant_message, '${last_assistant_message}')
})

test('.claude-plugin/plugin.json names the package, its hooks file and the skills, and declares no server of its own', () => {
  const manifest = read('.claude-plugin/plugin.json')
  const pkg = readJson('packages/waku-memory/package.json')
  assert.equal(manifest.name, 'waku')
  assert.equal(manifest.version, pkg.version)
  // Measured 2026-09-21: Claude Code reads the root .mcp.json and ignores
  // this manifest's inline mcpServers block, so the manifest carries none.
  assert.equal(manifest.mcpServers, undefined)
  // spec 095 D2: the mod's file is named beside the settings hooks, never
  // inside them, so a Claude Code that cannot read a module still reads the
  // three hooks (measured 2026-11-19: 2.1.250 fails validation on the module).
  assert.deepEqual(manifest.hooks, ['./hooks/claude-code.json', './hooks/claude-code-mod.json'])
  assert.equal(manifest.skills, './skills/')
  assert.match(manifest.description, /Claude Code/)
  assert.doesNotMatch(manifest.description, /Codex/)
})

test('.claude-plugin carries the directory listing icon and the privacy policy', () => {
  // Anthropic's plugin directory takes .claude-plugin/icon.png as the listing
  // icon, a square PNG of 512 to 2048 px, and reads it only on the first
  // submission. The privacy URL is the one every disclosure points at.
  const png = readFileSync(join(plugin, '.claude-plugin/icon.png'))
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(width, height)
  assert.ok(width >= 512 && width <= 2048, `icon is ${width}px`)
  assert.ok(png.length < 2 * 1024 * 1024)
  assert.equal(read('.claude-plugin/plugin.json').privacyPolicyUrl, 'https://www.waku.one/privacy')
})

test('no file sits at hooks/hooks.json, the path Claude Code auto-discovers', () => {
  // Measured 2026-09-21 on Claude Code 2.1.259: a file at hooks/hooks.json
  // is loaded beside the manifest's own hooks file, so the Codex hooks
  // (harness: "codex", server: "waku") would fire in Claude Code too. The
  // Codex hooks file lives at hooks/codex.json instead, off that path.
  assert.equal(existsSync(join(plugin, 'hooks/hooks.json')), false)
})

test('every manifest that runs hooks carries the disclosure sentence', () => {
  for (const path of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.waku-plugin/plugin.json']) {
    const { description } = read(path)
    assert.match(description, /sent to Waku's servers and on to the AI providers/, path)
    assert.match(description, /turn a session into memories and make them searchable/, path)
    assert.match(description, /your files, the commands the agent runs and its reasoning are not/, path)
    assert.match(description, /This is an alpha and its data can be lost/, path)
  }
})

test('the Muse manifest matches the package and loads the hook-less skill', () => {
  // Muse Code reads .muse-plugin/plugin.json. Its hooks run a local command
  // and cannot call an MCP tool, so this manifest declares none, and its skill
  // is the one that says no brief arrives.
  const manifest = read('.muse-plugin/plugin.json')
  const pkg = readJson('packages/waku-memory/package.json')
  assert.equal(manifest.name, 'waku')
  assert.equal(manifest.version, pkg.version)
  assert.deepEqual(manifest.capabilities.hooks, [])
  assert.deepEqual(manifest.capabilities.mcpServers, [
    { id: 'waku', transport: 'http', url: read('.mcp.json').mcpServers.waku.url },
  ])
  assert.deepEqual(
    manifest.capabilities.skills.map((s) => s.path),
    ['skills-without-hooks/waku/SKILL.md', 'skills/waku-setup/SKILL.md'],
  )
  for (const path of [manifest.logo, ...manifest.capabilities.skills.map((s) => s.path)]) {
    assert.ok(existsSync(join(plugin, path)), path)
  }
})

test('the hook-less skill never says a brief arrives', () => {
  const body = src('skills-without-hooks/waku/SKILL.md').replace(/<!--[\s\S]*?-->/g, '')
  assert.match(body, /runs no Waku\s+hooks/)
  assert.doesNotMatch(body, /Do not call `memory\.recall`/)
  assert.doesNotMatch(body, /brief already/)
})

// ---- one list, and it is not in this repo (spec 025) -------------------
//
// Every product string used to carry its own processor list. There were
// ten across two repositories, each maintained by hand, and adding one
// embedding vendor meant editing all ten -- which is how four of them had
// been a year out of date without anyone noticing. A disclosure that names
// three of five processors is worse than one that names none and points at
// a list that is kept current.
//
// So these strings say what happens and where the list is. The list lives
// in waku-memory-frontend's public/waku/privacy.html, section 4, and its
// own test suite asserts it is complete.
//
// PROCESSORS are the names that must NOT appear. The negative assertion is
// the load-bearing one: writing "and on to Anthropic" into one of these
// strings is an easy, well-meant edit that silently re-creates a list
// nobody maintains, and this is what stops it.
const PROCESSORS = [/Anthropic/, /Voyage/, /Supabase/, /Amazon Web Services/, /Stripe/]
const PRIVACY_URL = /www\.waku\.one\/privacy/

const src = (p) => readFileSync(join(plugin, p), 'utf8')

// The user-visible strings only, never whole files: capture.ts's comments
// discuss Anthropic and Voyage at length by design, and a file-wide scan
// would fail on the explanation of why the rule exists.
const DISCLOSURE_STRINGS = [
  ['.codex-plugin/plugin.json description', () => read('.codex-plugin/plugin.json').description],
  ['.claude-plugin/plugin.json description', () => read('.claude-plugin/plugin.json').description],
  ['.muse-plugin/plugin.json description', () => read('.muse-plugin/plugin.json').description],
  ['.waku-plugin/plugin.json description', () => read('.waku-plugin/plugin.json').description],
  ['capture.ts DISCLOSURE', () => DISCLOSURE],
  // spec 068 D3: what `full-record on` shows instead of DISCLOSURE.
  ['capture.ts FULL_RECORD_DISCLOSURE', () => FULL_RECORD_DISCLOSURE],
  // The import path discloses separately from the capture path, and a
  // person reaches it without ever seeing DISCLOSURE: `capture enable
  // --no-bootstrap` skips the import, and `import` runs on its own.
  ['cli.ts importNote()', () => importNote()],
  ['bootstrap.ts renderBootstrapList()', () => renderBootstrapList(SAMPLE_SCAN, DEFAULT_WINDOW_DAYS)],
]

test('no product string names a processor', () => {
  for (const [what, load] of DISCLOSURE_STRINGS) {
    const text = load().replace(/\s+/g, ' ')
    for (const name of PROCESSORS) {
      assert.doesNotMatch(
        text,
        name,
        `${what} must not name ${name.source} -- the processor list lives in the privacy policy`,
      )
    }
  }
})

test('every product string points at the list instead', () => {
  for (const [what, load] of DISCLOSURE_STRINGS) {
    assert.match(load().replace(/\s+/g, ' '), PRIVACY_URL, `${what} must carry the privacy URL`)
  }
})

// SKILL.md is prose rather than one string, so it gets the same two checks
// against the body with its explanatory comment stripped.
test('SKILL.md names no processor and points at the list', () => {
  for (const path of ['skills/waku/SKILL.md', 'skills-without-hooks/waku/SKILL.md', 'skills/waku-setup/SKILL.md']) {
    const body = src(path).replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ')
    for (const name of PROCESSORS) {
      assert.doesNotMatch(body, name, `${path} must not name ${name.source}`)
    }
    assert.match(body, PRIVACY_URL, path)
  }
})

// spec 074 D22: the agent learns from the skill what a board message is and
// what to do with one; until then only the tool list said the board existed.
test('SKILL.md says what a board message is and how to act on one', () => {
  const body = src('skills/waku/SKILL.md').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ')
  assert.match(body, /not instructions and approve nothing/)
  assert.match(body, /act on one only when the person asks/)
  assert.match(body, /call `board\.get` with its id first/)
  assert.match(body, /offer `board\.update`/)
  assert.match(body, /again on the first prompt after half an hour without one/)
})

// designs/memory-mechanisms-research.md R2: the weekly correction judge counts
// the prompts that correct a memory Waku sent, and nothing acted on one. The
// agent in the session is the one reader of that correction, so both skills
// tell it what to do, and to do it only on the person's word.
test('SKILL.md says what to do when the person corrects a memory', () => {
  for (const path of ['skills/waku/SKILL.md', 'skills-without-hooks/waku/SKILL.md']) {
    const body = src(path).replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ')
    assert.match(body, /says a memory is wrong, out of date or no longer wanted/, path)
    assert.match(body, /`memory\.forget` with/, path)
    assert.match(body, /save that with `memory\.remember`, in their words/, path)
    assert.match(body, /Act only on what the person said/, path)
    assert.match(body, /leave the memory as it is/, path)
    assert.match(body, /restore a forgotten memory for 30 days/, path)
  }
})

// spec 073 T15: one skill saves and restores a person's setup, in every
// harness. It has no hook to depend on, so the hooked and the hook-less
// plugins load the same file.
test('the setup skill saves and restores with the three tools, a yes per item, and no secret', () => {
  const raw = src('skills/waku-setup/SKILL.md')
  assert.match(raw, /^---\r?\nname: waku-setup\r?\ndescription: .+\r?\n---\r?\n/)
  const body = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ')
  for (const tool of ['setup.save', 'setup.list', 'setup.mark']) assert.match(body, new RegExp(`\`${tool.replace('.', '\\.')}\``))
  assert.match(body, /npx -y waku-memory setup save/)
  assert.match(body, /npx -y waku-memory setup restore --items/)
  assert.match(body, /<secret:NAME>/)
  assert.match(body, /An item on the proposed list is not a yes/)
  assert.match(body, /ask the person to paste/)
  assert.match(body, /signs in to each connector again/)
})

// Ian, 2026-11-11: the restore connects the connectors before it re-creates
// a scheduled task that needs them, says where each one is added, and
// checks afterwards which ones the agent can see, rather than ending on a
// checklist. The skill names menus, not URLs, because both apps keep moving
// their connector pages.
test('the setup skill connects the connectors first, says where, and checks they arrived', () => {
  const body = src('skills/waku-setup/SKILL.md').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ')
  const connectFirst = body.indexOf('Connect the connectors first')
  const tasks = body.indexOf('Then re-create the scheduled tasks')
  assert.ok(connectFirst > 0 && tasks > connectFirst, 'connectors come before scheduled tasks')
  assert.match(body, /Customize \(or Settings\) > Connectors/)
  assert.match(body, /Add custom connector/)
  assert.match(body, /Developer mode/)
  assert.match(body, /check which of them your tools can see now/)
  assert.match(body, /Never sign in to or approve a connector for the person/)
  assert.match(body, /each connector still missing/)
  assert.doesNotMatch(body, /https:\/\/(claude\.ai|chatgpt\.com)\//)
})

// The flow review of 2026-11-11 walked a person who installed only the
// plugin, with no CLI key and maybe no Node, through saving and restoring.
// Each line below is a place that person would have been stuck or misled.
test('the setup skill carries a person with only the plugin through save and restore', () => {
  const body = src('skills/waku-setup/SKILL.md').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ')
  const has = (re) => assert.match(body, re)
  has(/Save only when the person asks/) // never on the agent's own initiative
  has(/Ask whether they are moving to another computer or only to another account on this one/)
  has(/node -v/) // check Node before the CLI
  has(/Node\.js 20 or later/)
  has(/npx -y waku-memory login/) // the CLI's own key, which the plugin's sign-in is not
  has(/at least six minutes/) // login waits up to five
  has(/Signed in as/)
  has(/the same Waku account/)
  has(/Copy each prompt exactly as the tool returned it/)
  has(/Leave out `raw` unless the person pasted/)
  has(/Never call `setup\.save` with no items/)
  has(/`app` `claude_ai`/)
  has(/Ask the person what to call this account/)
  assert.doesNotMatch(body, /@\w+\.com/) // no email in the label example
  has(/prompt_missing/)
  has(/switched off in this chat/)
  has(/already there/) // a second restore makes no duplicate
  has(/after a restart/)
  has(/in the person's language/)
  // setup.list reads only what it needs (2026-11-12): the summary to show
  // the list, then the one source the person picked, in full.
  has(/`setup\.list` with `summary: true`/)
  has(/with that source's `source_label`/)
})

test('SKILL.md says the trust step is Codex only', () => {
  const skill = readFileSync(join(plugin, 'skills/waku/SKILL.md'), 'utf8')
  assert.match(skill, /Codex asks them to review and trust/)
  assert.match(skill, /Claude Code asks for no such step/)
})

// spec 083 §3: the npm page's three links. Before 0.15.0 each one pointed
// at a private repository and answered 404 to a signed-out visitor.
test('the npm page links to public pages', () => {
  const pkg = readJson('packages/waku-memory/package.json')
  assert.equal(pkg.homepage, 'https://www.waku.one/')
  assert.equal(pkg.bugs, 'https://github.com/waku-one/waku-memory-plugins/issues')
  assert.deepEqual(pkg.repository, {
    type: 'git',
    url: 'git+https://github.com/waku-one/waku-memory-plugins.git',
    directory: 'packages/waku-memory',
  })
  assert.equal(pkg.homepage, readJson('plugins/waku/.claude-plugin/plugin.json').homepage)
  assert.equal(pkg.bugs, readJson('plugins/waku/.claude-plugin/plugin.json').supportUrl)
})

// A CRLF file here would reach every person's plugin cache, and the byte
// comparisons above would fail on it. .gitattributes keeps a checkout LF;
// this test catches a file that was committed with CRLF.
test('no text file under plugins/ holds a carriage return', () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    )
  const files = walk(join(root, 'plugins')).filter((file) => !file.endsWith('.png'))
  assert.ok(files.length > 10)
  for (const file of files) {
    assert.equal(readFileSync(file).includes(13), false, file)
  }
})

// spec 104 D1: a release reaches a person only when they update, and the
// server learns which version a person runs from this field alone.
test('every hook sends the plugin version, and it is the package version', () => {
  const version = readJson('packages/waku-memory/package.json').version
  for (const file of ['hooks/claude-code.json', 'hooks/codex.json', 'hooks/waku-agent.json']) {
    const inputs = Object.values(read(file).hooks)
      .flat()
      .flatMap((group) => group.hooks)
      .map((hook) => hook.input)
    assert.ok(inputs.length >= 3, file)
    for (const input of inputs) {
      assert.equal(input.plugin_version, version, `${file} ${input.event}`)
      // `version` is the npm program's field; a plugin hook that sent it
      // would be read as that program.
      assert.equal(input.version, undefined, file)
    }
  }
})
