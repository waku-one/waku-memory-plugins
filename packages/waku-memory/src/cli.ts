// The argument dispatch and per-harness logic behind `npx waku-memory
// setup` (see index.ts for the shim's overall job and the credential
// story -- this file is everything downstream of "here is argv").
//
// Split out of index.ts on review: everything exported here is a plain
// function with no top-level side effects, so cli.test.mjs can import and
// call it directly against temp files. index.ts, by contrast, calls run()
// the instant it's loaded -- which is exactly why nothing imports
// index.ts itself in a test. Decision logic (dispatch, runSetup,
// summarize) is also kept separate from the imperative shell that prints
// and sets process.exitCode (run, setup), so the two things that were
// actually wrong during manual testing -- argument dispatch dropping
// --help, and the found/wrote/error tri-state collapsing into one boolean
// -- are pinned by plain assertions on return values, not by mocking
// console.log.

import { type SpawnOptions, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { type ActDeps, actOff, actOn, actStatus } from './act.ts'
import { DEFAULT_WINDOW_DAYS } from './bootstrap.ts'
import {
  type Harness,
  type HarnessId,
  type McpConfig,
  getHarnesses,
  harnessConfigExists,
  mergeMcpConfig,
  profileFor,
} from './harnesses.ts'
import { type HookEvent, SHIM_VERSION, handleHookEvent } from './hook.ts'
import {
  DISCLOSURE,
  KEYS_PAGE_URL,
  type CaptureDeps,
  type Credential,
  type HookInvocation,
  type HookMode,
  disable,
  enable,
  fullRecordStatus,
  importHistory,
  status,
  urlPair,
} from './capture.ts'
import { type LoginDeps, login } from './login.ts'
import { type SetupDeps, setupAuto, setupNeedsRefresh, setupSave } from './setup-list.ts'
import { type ClaudeRun, type RestoreDeps, listSetup, setupRestore } from './setup-restore.ts'

export const DEFAULT_URL = 'https://api.waku.one/mcp'
export const DEFAULT_NAME = 'waku'

// The ingest base capture.ts writes into config.json -- deliberately not
// DEFAULT_URL: that one carries setup's "/mcp" suffix, which is the wrong
// shape for hook.ts's endpointUrl() to append "/ingest/session" etc. onto.
export const DEFAULT_INGEST_URL = 'https://api.waku.one'

// The step after the server is configured, and the one the whole product
// claim rests on: nothing has been imported yet, so there is nothing in
// another harness to find.
//
// spec.md's "The shim" section said this shim "triggers the import". It
// never could: the same sentence says it obtains no credential, and
// memory.import is an authenticated MCP call, so triggering it would need
// exactly the credential ops-design §5 forbids this to hold. The spec is
// amended (2026-08-25); this is the achievable half of what it wanted --
// the user is told what to ask for, in words they can paste, by the one
// thing on this machine that already knows the server is now configured.
//
// Names the two files by convention rather than reading the directory:
// `npx waku-memory setup` is not necessarily run from a project root, and
// listing files that are not there would be worse than naming the ones
// people actually have.
//
// The last two lines are item 9's other half (spec 005 "Disclosure",
// corrected 2026-08-28 during that spec's execution): this function was
// once documented as already carrying that disclosure, and it never did --
// memory.import has been reachable since spec 004, so a person could send a
// file's contents to Anthropic having been told nothing. Matches
// capture.ts's DISCLOSURE in voice and content, worded for import rather
// than capture.
export function importNote(): string {
  return (
    `Then, to put this project's conventions into Waku, ask the agent:\n` +
    `\n` +
    `    Run memory.import with this project's CLAUDE.md and AGENTS.md.\n` +
    `\n` +
    `The agent reads the files and makes the call -- this installer cannot,\n` +
    `because it holds no credential, by design. Extraction is asynchronous,\n` +
    `so the memories appear shortly rather than in that call. After that they\n` +
    `are available in your other projects and other harnesses, which is the\n` +
    `point of importing them at all.\n` +
    `\n` +
    `Imported content is sent to our servers and on to the AI providers that\n` +
    `turn it into memories and make them searchable; www.waku.one/privacy\n` +
    `names them. This is an alpha whose data can be lost.`
  )
}

export function parseArgs(argv: string[]): {
  command: string | undefined
  subcommand: string | undefined
  name: string
  url: string
  // The three flags below only mean anything to dispatch()'s "capture
  // enable" branch (task 14, spec 011 §9/§8) and, since spec 068 D3, its
  // "import" branch (--since/--all) -- recognized here, the same
  // way --name/--url already are, so their value tokens (--since's) or
  // their own literal text (--all, --no-bootstrap) are consumed as flags
  // and never fall through to the generic "not a flag" branch below and get
  // pushed onto positional. since is left as the raw string; dispatch()
  // parses and validates it (bare integer or "<N>d"), because parseArgs's
  // job -- same as it already is for --name/--url -- is tokenizing, not
  // deciding what a value means.
  since: string | undefined
  all: boolean
  noBootstrap: boolean
  // Raw --harness value, if any -- dispatch()'s 'hook' branch is the only
  // reader; it defaults to 'claude_code' and validates against
  // harnesses.ts's PROFILES, the same division of labor as --since/parseSinceDays
  // above (this function tokenizes, dispatch() decides what the value means).
  harness: string | undefined
  // --login / --key <key> (task 13, spec 012 §7): only meaningful to
  // dispatch()'s "capture enable", "import" and "full-record on" branches
  // (spec 068 D3), same division of labor as every
  // other flag above -- this function tokenizes, dispatch() decides what
  // login/key mean (bad-flag on a missing/invalid --key value, or the two
  // used together) and builds the Credential dispatch() attaches.
  login: boolean
  // A raw --key value token, if one was actually consumed; undefined both
  // when --key was never given and when it was given with no usable value
  // (see the --key branch below) -- dispatch() tells the two apart with
  // argv.includes('--key'), the same pattern --harness already uses.
  key: string | undefined
  // spec 073 D8: "setup save" and "setup auto". `third` is the positional
  // after the subcommand ("on" in "setup auto on"); --label takes a value,
  // --dry-run and --auto are bare.
  third: string | undefined
  label: string | undefined
  dryRun: boolean
  auto: boolean
  // spec 073 D9: "setup restore --items <ids> [--yes <ids>]". Each takes a
  // comma-separated list and may be given more than once.
  items: string[]
  yes: string[]
  // --answer <text>: the answer to import's "> " question, for a caller with
  // no terminal (2026-11-20). Unquoted numbers after it are joined on, so
  // `--answer 1 3` reads the same as `--answer "1 3"` and never leaves "3"
  // behind as a positional. dispatch() decides what an empty value means.
  answer: string | undefined
  // --list <id>: the list id an earlier import printed, given with --answer
  // so the answer is used only on that same list (capture.ts's listId).
  list: string | undefined
} {
  let name = DEFAULT_NAME
  let url = DEFAULT_URL
  let since: string | undefined
  let all = false
  let noBootstrap = false
  let harness: string | undefined
  let login = false
  let key: string | undefined
  let label: string | undefined
  let dryRun = false
  let auto = false
  const items: string[] = []
  const yes: string[] = []
  let answer: string | undefined
  let list: string | undefined
  const ids = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean)
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--name' && i + 1 < argv.length) {
      name = argv[++i]
    } else if (arg === '--url' && i + 1 < argv.length) {
      url = argv[++i]
    } else if (arg === '--since' && i + 1 < argv.length) {
      since = argv[++i]
    } else if (arg === '--harness' && i + 1 < argv.length) {
      harness = argv[++i]
    } else if (arg === '--label' && i + 1 < argv.length) {
      label = argv[++i]
    } else if (arg === '--items' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      items.push(...ids(argv[++i]))
    } else if (arg === '--yes' && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      yes.push(...ids(argv[++i]))
    } else if (arg === '--list') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) list = argv[++i]
    } else if (arg === '--answer') {
      // Like --key, a value starting with "--" is not consumed.
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        answer = argv[++i]
        while (i + 1 < argv.length && /^\d+$/.test(argv[i + 1])) answer += ` ${argv[++i]}`
      }
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--auto') {
      auto = true
    } else if (arg === '--all') {
      all = true
    } else if (arg === '--no-bootstrap') {
      noBootstrap = true
    } else if (arg === '--login') {
      login = true
    } else if (arg === '--key') {
      // Unlike --name/--url/--since/--harness above, a value starting with
      // "--" is deliberately NOT consumed here -- "--key --url x" must
      // leave --url for its own branch to see, not swallow it as the key's
      // literal value. Left undefined (with the token itself still in argv,
      // for dispatch()'s argv.includes('--key') check) either way: no next
      // token at all, or the next token is itself a flag.
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) key = argv[++i]
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    }
  }
  // subcommand is only meaningful to the caller for "capture enable" /
  // "capture disable" -- setup and hook both ignore it, same as they always
  // ignored any positional beyond the first.
  return {
    command: positional[0],
    subcommand: positional[1],
    name,
    url,
    since,
    all,
    noBootstrap,
    harness,
    login,
    key,
    third: positional[2],
    label,
    dryRun,
    auto,
    items,
    yes,
    answer,
    list,
  }
}

// spec 068 D3: the plugin is the product, and these commands are extras.
// `capture enable|disable|status` still dispatch (a hidden alias for one
// release, because docs and agents in the wild type it), but this text no
// longer lists them: `import` and `full-record` are their names now.
export function printUsage(): void {
  console.log('Most people need only the Waku plugin. These commands are extras.')
  console.log('')
  console.log('Usage: npx waku-memory import [--url <ingest-base>] [--since <N>d] [--all] [--login] [--key <key>] [--list <id> --answer <answer>]')
  console.log('')
  console.log('  Imports, once, what your agents already keep on this machine: CLAUDE.md,')
  console.log('  memory files, skills and past sessions. It lists what it found and asks')
  console.log('  before it sends anything. It installs no hook. Without a terminal to')
  console.log('  answer in, it sends nothing unless --answer is given.')
  console.log('')
  console.log(`  --since <N>d       only scan sessions from the last N days (default: ${DEFAULT_WINDOW_DAYS}d)`)
  console.log('  --all              scan full history instead, ignoring --since')
  console.log('  --login            sign in in the browser without asking')
  console.log('  --key <key>        use this key without asking')
  console.log('  --answer <answer>  answer the list without asking: all, n, or numbers to leave out ("1 2")')
  console.log('  --list <id>        the list id the answer is for; every answer but n needs it')
  console.log('')
  console.log('Usage: npx waku-memory full-record on [--url <ingest-base>] [--login] [--key <key>]')
  console.log('')
  console.log('  Installs a hook that sends the full record of each session: what you')
  console.log('  type, all the text the agent writes, and the names of the tools it uses.')
  console.log('  Without it, the plugin sends each prompt and final reply. It shows what')
  console.log('  is sent and waits for a typed "y" first. It works for Claude Code and')
  console.log('  for Codex. Sign-in works as in "import". To paste a key, mint one at')
  console.log(`  ${KEYS_PAGE_URL}.`)
  console.log('')
  console.log('Usage: npx waku-memory full-record off')
  console.log('')
  console.log('  Removes exactly the hook entries "full-record on" added. Your saved key')
  console.log('  stays. Revoke it on the keys page if you want it gone too.')
  console.log('')
  console.log('Usage: npx waku-memory full-record status')
  console.log('')
  console.log('  Prints whether full record is on for Claude Code and for Codex, and')
  console.log('  whether a key is saved. It only reads.')
  console.log('')
  console.log('Usage: npx waku-memory act on|off|status')
  console.log('')
  console.log('  An experiment. "act on" adds a hook that runs before each shell command')
  console.log('  and file edit. Waku then adds your saved rules for that step. It needs')
  console.log('  full record on, and each step waits for Waku for up to 1.5 seconds.')
  console.log('  "act off" removes the hook. "act status" prints whether it is on.')
  console.log('')
  console.log('Usage: npx waku-memory login [--url <ingest-base>]')
  console.log('')
  console.log('  Signs in through the browser and mints an API key, without you ever')
  console.log('  seeing it. It is the same sign-in "import" and "full-record on" offer.')
  console.log('  It shows the disclosure first, prints "Signed in as <email>" on success,')
  console.log('  and stores the key in ~/.waku-memory/config.json.')
  console.log('')
  console.log('Usage: npx waku-memory setup [--name <name>] [--url <url>]')
  console.log('')
  console.log(`  --name  key to add under mcpServers (default: "${DEFAULT_NAME}")`)
  console.log(`  --url   server URL to write (default: ${DEFAULT_URL})`)
  console.log('')
  console.log('  If a harness was found, setup then offers the same one-time import as')
  console.log('  "import". Default is no; press Enter to skip it.')
  console.log('')
  console.log('Usage: npx waku-memory setup save [--label <name>] [--dry-run]')
  console.log('')
  console.log("  Saves a list of this computer's agent setup to Waku, so a new computer or")
  console.log('  a new account can be set up the same way: MCP servers, plugins, hooks,')
  console.log('  permissions, subagents and commands for Claude Code, Codex and Cursor, and')
  console.log('  on a Mac, Claude Desktop servers and Cowork scheduled tasks. Secret values')
  console.log('  stay on this computer; the list shows each as <secret:NAME>. After the')
  console.log('  first save, a new session saves it again when those files change.')
  console.log('')
  console.log('  --label <name>  what to call this computer (default: its name)')
  console.log('  --dry-run       print what would be sent, and send nothing')
  console.log('')
  console.log('Usage: npx waku-memory setup list')
  console.log('')
  console.log('  Prints the saved setup list, grouped by the computer or account it came')
  console.log('  from, with the id "setup restore --items" takes for each item. It says')
  console.log('  which items need a yes or a secret, and which are gone from where they')
  console.log('  were saved.')
  console.log('')
  console.log('Usage: npx waku-memory setup restore --items <id,...> [--yes <id,...>]')
  console.log('')
  console.log('  Re-creates the picked items from the setup list on this computer: MCP')
  console.log('  servers, marketplaces and plugins (through "claude"), subagents, commands')
  console.log('  and output styles. Nothing already here is overwritten. A hook, a')
  console.log('  permission list, a server that runs a local command, a marketplace and a')
  console.log('  plugin are written or installed only when their id is in --yes too, after')
  console.log('  the person said yes to that item.')
  console.log('')
  console.log('Usage: npx waku-memory setup auto on|off')
  console.log('')
  console.log('  Turns the save at the start of a new session on or off for this computer.')
  console.log('')
  console.log('Usage: waku-memory hook [--harness <claude_code|codex>]')
  console.log('')
  console.log('  Reads one hook event as JSON on stdin and reports it to the server named')
  console.log('  in ~/.waku-memory/config.json. The harness runs it (see "full-record on");')
  console.log('  it is not meant to be run by hand.')
  console.log('')
  console.log('  --harness  which harness sent the event (default: "claude_code")')
}

export type CaptureBootstrap = { windowDays: number | null; enabled: boolean; answer?: string; list?: string }

// The default third question: on, with the full DEFAULT_WINDOW_DAYS window
// (spec 011 §8/§9, task 14). Used both as dispatch()'s no-flags-given result
// and, for "capture disable", unconditionally -- disable() never reads
// deps.bootstrap (see its own comment), so there is nothing to gain and a
// real footgun to avoid in parsing --since/--all/--no-bootstrap for an
// action that would silently ignore them.
const DEFAULT_BOOTSTRAP: CaptureBootstrap = { windowDays: DEFAULT_WINDOW_DAYS, enabled: true }

export type Dispatch =
  | { kind: 'help' }
  | { kind: 'no-command' }
  | { kind: 'unknown'; command: string }
  // A flag that parsed as present but whose value makes no sense --
  // currently only an unparsable --since. Deliberately its own kind rather
  // than folded into 'unknown' (whose `command` field means something
  // different -- an unrecognized command name, not a bad value for a
  // recognized flag) -- run() below gives it the same treatment (one error
  // line, then usage, then exit 1) without overloading what 'unknown' means.
  | { kind: 'bad-flag'; message: string }
  | { kind: 'setup'; name: string; url: string }
  | { kind: 'setup-save'; label: string | undefined; dryRun: boolean; auto: boolean }
  | { kind: 'setup-auto'; on: boolean }
  | { kind: 'setup-restore'; items: string[]; yes: string[] }
  | { kind: 'setup-list' }
  | { kind: 'hook'; harness: HarnessId }
  // mcpUrl (fix round 1, spec 012 §4.2) rides alongside url rather than
  // replacing it: url is the ingest base config.json/hook.ts need (as it
  // always was), mcpUrl is the "/mcp"-suffixed value the Codex TOML (and
  // Claude Code's own ~/.claude.json) must carry. Adding a field here --
  // rather than teaching realCaptureDeps to re-derive one from the other,
  // or capture.ts to know both shapes exist -- is the least invasive fix:
  // dispatch() already computes both from the one parsed --url token, and
  // this is the one place that value crosses from cli.ts's argv parsing
  // into the capture.ts-facing shape.
  | { kind: 'capture'; action: 'disable'; url: string; mcpUrl: string; bootstrap: CaptureBootstrap }
  // credential (task 13, spec 012 §7): built from --login/--key (or their
  // absence) by dispatch()'s own capture-enable branch below, and the one
  // new field this variant carries that 'disable' does not -- disable()
  // never asks for a credential at all (see its own comment), so there is
  // nothing here for it to ignore, unlike bootstrap, which it ignores on
  // purpose (see CaptureBootstrap's DEFAULT_BOOTSTRAP comment).
  | {
      kind: 'capture'
      action: 'enable'
      url: string
      mcpUrl: string
      bootstrap: CaptureBootstrap
      credential: Credential
    }
  // 'status' (task 10, spec 012 §4.6) carries neither -- it never prompts,
  // never sends a bootstrap request, and never merges a URL into anything;
  // it only reads.
  | { kind: 'capture'; action: 'status' }
  // 'login' (task 13, spec 012 §7): `login` on its own, not nested under
  // 'capture' -- it is not a capture action (it never touches settings.json
  // or the hook), just the credential mechanism capture enable's own
  // 'login' Credential also calls. `url` is the ingest base (urlPair's
  // ingestUrl), the same value the capture-enable variant's own `url`
  // carries -- realLoginDeps(d.url) in run() below needs exactly that, not
  // the "/mcp"-suffixed mcpUrl.
  | { kind: 'login'; url: string }
  // spec 068 D3: `import` is capture enable's bootstrap step on its own --
  // the window (--since/--all) and the credential (--login/--key), parsed by
  // the same helpers capture enable uses, and no hook, so no mcpUrl.
  // `answer` and `list` are --answer's and --list's text, present only when given.
  | { kind: 'import'; url: string; windowDays: number | null; credential: Credential; answer?: string; list?: string }
  // spec 068 D3: `full-record on|off|status` -- capture enable/disable/status
  // without the switch and without the import. 'on' carries a credential and
  // no window; 'off' carries the URL pair disable() needs; 'status' carries
  // nothing, the same as capture status.
  | { kind: 'full-record'; action: 'on'; url: string; mcpUrl: string; credential: Credential }
  | { kind: 'full-record'; action: 'off'; url: string; mcpUrl: string }
  | { kind: 'full-record'; action: 'status' }
  // spec 071 F1: `act on|off|status`. It reads the key and the URL that
  // "full-record on" saved, so it takes no flags.
  | { kind: 'act'; action: 'on' | 'off' | 'status' }

// Accepts a bare integer ("90") or an integer with a trailing "d" ("90d") --
// the brief's two named shapes, spec 011 §9. Anything else (empty, signed,
// fractional, trailing garbage after the "d") is null, which dispatch()
// turns into a 'bad-flag' rather than a silent fallback to the default: a
// person who typed --since clearly meant to change the window, so getting
// no error and the default anyway would be the more confusing wrong answer.
export function parseSinceDays(raw: string): number | null {
  const match = /^(\d+)d?$/.exec(raw)
  return match ? Number(match[1]) : null
}

// --since/--all, decided once for capture enable and import (spec 068 D3).
// --since is validated unconditionally (even alongside --all) so a typo is
// never silently swallowed by an --all that happened to be present too;
// --all is then applied on top, since "scan everything" is the least
// surprising way to read the two stacked together (untested by the brief --
// there is no one obviously-right answer here, but this at least never hides
// a bad --since value). `command` names the command in the error.
function windowFromFlags(
  since: string | undefined,
  all: boolean,
  command: string,
): { windowDays: number | null } | { kind: 'bad-flag'; message: string } {
  let windowDays: number | null = DEFAULT_WINDOW_DAYS
  if (since !== undefined) {
    const parsed = parseSinceDays(since)
    if (parsed === null) {
      return {
        kind: 'bad-flag',
        message: `waku-memory ${command}: invalid --since value "${since}" -- expected a number of days, e.g. "90d" or "90".`,
      }
    }
    windowDays = parsed
  }
  if (all) windowDays = null
  return { windowDays }
}

// --login / --key <key> (task 13, spec 012 §7), decided once for capture
// enable, import and full-record on (spec 068 D3): the credential decision
// capture.ts's enable()/importHistory() take as their own parameter -- see
// Credential's own comment (capture.ts) for why it lives there and not on
// CaptureDeps. Both bad-flag checks run unconditionally, the same way
// --since's does, so a scripted caller gets a loud, specific error instead
// of the question silently being asked anyway.
function credentialFromFlags(
  loginFlag: boolean,
  key: string | undefined,
  argv: string[],
  command: string,
): Credential | { kind: 'bad-flag'; message: string } {
  if (loginFlag && key !== undefined) {
    return {
      kind: 'bad-flag',
      message: `waku-memory ${command}: --login and --key cannot be used together -- pick one.`,
    }
  }
  if (argv.includes('--key') && key === undefined) {
    return {
      kind: 'bad-flag',
      message: `waku-memory ${command}: --key requires a value -- got none.`,
    }
  }
  return key !== undefined ? { kind: 'key', key } : loginFlag ? { kind: 'login' } : { kind: 'ask' }
}

// --answer and --list for capture enable and import: absent is undefined, and
// an empty value is a bad flag. An empty --answer is not Enter, because
// "import everything" must be said in words (--answer all). Whether --list
// matches is decided against the scan (capture.ts's resolveGivenAnswer).
function answerFromFlags(
  answer: string | undefined,
  list: string | undefined,
  argv: string[],
  command: string,
): { answer?: string; list?: string } | { kind: 'bad-flag'; message: string } {
  if (argv.includes('--answer') && (answer === undefined || answer.trim() === '')) {
    return {
      kind: 'bad-flag',
      message: `waku-memory ${command}: --answer requires a value -- all, n, or project numbers such as "1 2".`,
    }
  }
  if (argv.includes('--list') && (list === undefined || list.trim() === '')) {
    return { kind: 'bad-flag', message: `waku-memory ${command}: --list requires the list id the import printed -- got none.` }
  }
  return { ...(answer !== undefined && { answer }), ...(list !== undefined && { list }) }
}

export function dispatch(argv: string[]): Dispatch {
  // Checked ahead of parseArgs deliberately: --help/-h are flags, so
  // parseArgs (which only special-cases --name/--url) would otherwise drop
  // them silently and this would fall through to "no command" with the
  // wrong exit code -- that was a real bug, caught by hand before any test
  // existed to pin it. See cli.test.mjs's dispatch block.
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' }

  const { command, subcommand, name, url, since, all, noBootstrap, harness, login: loginFlag, key, third, label, dryRun, auto, items, yes, answer, list } =
    parseArgs(argv)
  if (command === undefined) return { kind: 'no-command' }
  if (command === 'login') {
    // Same urlPair() rule "capture enable" uses -- see its own comment
    // below: whatever shape --url was typed in, the ingest base is what
    // realLoginDeps(d.url) (run()) and login.ts's own apiBase param need,
    // never the "/mcp"-suffixed mcpUrl.
    return { kind: 'login', url: urlPair(url).ingestUrl }
  }
  if (command === 'hook') {
    // --harness with no value: parseArgs only consumes it when a next token
    // exists, so a trailing "--harness" leaves `harness` undefined the same
    // way a trailing "--since" does -- but unlike --since (which falls back
    // to a default), a bare --harness is treated the same as an unknown id,
    // per the brief: both are the caller trying to say something this shim
    // does not understand.
    if (argv.includes('--harness') && harness === undefined) {
      return {
        kind: 'bad-flag',
        message: 'waku-memory hook: --harness requires a value (e.g. "codex") -- got none.',
      }
    }
    const harnessId = harness ?? 'claude_code'
    if (!profileFor(harnessId)) {
      return {
        kind: 'bad-flag',
        message: `waku-memory hook: unknown harness "${harnessId}" -- expected one of: claude_code, codex.`,
      }
    }
    return { kind: 'hook', harness: harnessId as HarnessId }
  }
  if (command === 'capture') {
    if (subcommand !== 'enable' && subcommand !== 'disable' && subcommand !== 'status') {
      return { kind: 'unknown', command: 'capture' }
    }
    if (subcommand === 'status') return { kind: 'capture', action: 'status' }
    // parseArgs's `url` already defaults to DEFAULT_URL (the "/mcp" literal)
    // whenever --url is absent, so no argv.includes('--url') check is needed
    // here any more (fix round 1 had one, to avoid trusting parseArgs's
    // setup-shaped default -- round 2 replaces the whole thing with
    // urlPair(), which produces the right pair from DEFAULT_URL exactly the
    // same way it does from any --url a person types).
    //
    // Fix round 2 (re-review finding #1, spec 012 §4.2): urlPair() (capture.ts)
    // is the one place that decides "given this one URL, what is the ingest
    // base and what is the MCP endpoint" -- round 1's own rule (strip a
    // trailing "/mcp" from mcpUrl to get ingestUrl) only worked when the
    // input was already MCP-shaped; an ingest-shaped --url (no "/mcp" to
    // strip, exactly the shape cli.ts's own usage text documents:
    // "capture enable [--url <ingest-base>]") left mcpUrl === ingestUrl,
    // reproducing the original defect. urlPair always derives the ingest
    // base first and always appends "/mcp" to build mcpUrl, so every shape
    // (bare, trailing slash, "/mcp"-suffixed) converges on the same pair.
    const { ingestUrl, mcpUrl } = urlPair(url)

    if (subcommand === 'disable') {
      return { kind: 'capture', action: 'disable', url: ingestUrl, mcpUrl, bootstrap: DEFAULT_BOOTSTRAP }
    }

    const window = windowFromFlags(since, all, 'capture enable')
    if ('kind' in window) return window
    const credential = credentialFromFlags(loginFlag, key, argv, 'capture enable')
    if (credential.kind === 'bad-flag') return credential
    const given = answerFromFlags(answer, list, argv, 'capture enable')
    if ('kind' in given) return given

    return {
      kind: 'capture',
      action: 'enable',
      url: ingestUrl,
      mcpUrl,
      bootstrap: { windowDays: window.windowDays, enabled: !noBootstrap, ...given },
      credential,
    }
  }
  if (command === 'import') {
    const window = windowFromFlags(since, all, 'import')
    if ('kind' in window) return window
    const credential = credentialFromFlags(loginFlag, key, argv, 'import')
    if (credential.kind === 'bad-flag') return credential
    const given = answerFromFlags(answer, list, argv, 'import')
    if ('kind' in given) return given
    return { kind: 'import', url: urlPair(url).ingestUrl, windowDays: window.windowDays, credential, ...given }
  }
  if (command === 'full-record') {
    if (subcommand === 'status') return { kind: 'full-record', action: 'status' }
    if (subcommand !== 'on' && subcommand !== 'off') {
      return {
        kind: 'bad-flag',
        message: `waku-memory full-record: expected "on", "off" or "status"${subcommand === undefined ? '' : ` -- got "${subcommand}"`}.`,
      }
    }
    const { ingestUrl, mcpUrl } = urlPair(url)
    if (subcommand === 'off') return { kind: 'full-record', action: 'off', url: ingestUrl, mcpUrl }
    const credential = credentialFromFlags(loginFlag, key, argv, 'full-record on')
    if (credential.kind === 'bad-flag') return credential
    return { kind: 'full-record', action: 'on', url: ingestUrl, mcpUrl, credential }
  }
  if (command === 'act') {
    if (subcommand !== 'on' && subcommand !== 'off' && subcommand !== 'status') {
      return {
        kind: 'bad-flag',
        message: `waku-memory act: expected "on", "off" or "status"${subcommand === undefined ? '' : ` -- got "${subcommand}"`}.`,
      }
    }
    return { kind: 'act', action: subcommand }
  }
  if (command !== 'setup') return { kind: 'unknown', command }
  // spec 073 D8. Plain "setup" still writes the MCP server's URL.
  if (subcommand === 'save') {
    if (argv.includes('--label') && (label === undefined || label.trim() === '')) {
      return { kind: 'bad-flag', message: 'waku-memory setup save: --label requires a value -- got none.' }
    }
    return { kind: 'setup-save', label: label?.trim(), dryRun, auto }
  }
  if (subcommand === 'restore') {
    if (items.length === 0) {
      return { kind: 'bad-flag', message: 'waku-memory setup restore: --items requires the ids to restore -- got none.' }
    }
    if (argv.includes('--yes') && yes.length === 0) {
      return { kind: 'bad-flag', message: 'waku-memory setup restore: --yes requires ids -- got none.' }
    }
    return { kind: 'setup-restore', items, yes }
  }
  if (subcommand === 'list') return { kind: 'setup-list' }
  if (subcommand === 'auto') {
    if (third !== 'on' && third !== 'off') {
      return {
        kind: 'bad-flag',
        message: `waku-memory setup auto: expected "on" or "off"${third === undefined ? '' : ` -- got "${third}"`}.`,
      }
    }
    return { kind: 'setup-auto', on: third === 'on' }
  }
  return { kind: 'setup', name, url }
}

export type WriteJson = (configPath: string, data: McpConfig) => void

// Same-directory temp file + rename: rename is only atomic within one
// filesystem, so the temp file has to live next to the real one -- a
// different directory (or /tmp on another device) would make the rename
// itself non-atomic, which defeats the point. Without this,
// writeFileSync(configPath, ...) truncates the real file before it writes
// a single byte back; a crash, a kill, or a full disk in that window
// leaves a real, in-use config -- ~78 KB and ~80 keys, by measurement --
// truncated or corrupted.
//
// Shared by every writer below it (task 10, spec 012 §4.6): atomicWriteJson
// (settings.json, config files), writeJsonFile (Codex's hooks.json and the
// personal marketplace file) and writeCodexText (Codex's config.toml, whose
// content is already a complete file, not a value to serialise). The
// mkdirSync up front is new with those two Codex JSON writers -- neither
// ~/.codex nor ~/.agents/plugins is guaranteed to exist yet the first time
// capture enable runs on a Codex machine, unlike ~/.claude (whose presence
// is what enable() already checked before writing anything under it).
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  )
  try {
    writeFileSync(tmpPath, content, 'utf8')
    renameSync(tmpPath, path)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // Best-effort cleanup only -- the error below is the one that matters,
      // and a failed cleanup must not hide it. Also fires harmlessly
      // (ENOENT, swallowed the same way) if writeFileSync itself never got
      // far enough to create tmpPath at all.
    }
    throw err
  }
}

export const atomicWriteJson: WriteJson = (configPath, data) => atomicWrite(configPath, JSON.stringify(data, null, 2) + '\n')

// capture.ts's CaptureDeps.writeJsonFile (task 10): the same atomic write as
// atomicWriteJson above, generalised to `unknown` -- capture.ts has no more
// opinion about CodexHooksFile vs MarketplaceFile than atomicWriteJson has
// about McpConfig beyond JSON.stringify, which is exactly why a function
// typed `(data: unknown) => void` is assignable wherever `WriteJson` is
// expected (parameter types are contravariant) and the reverse is not worth
// forcing through a cast.
export const writeJsonFile = (path: string, data: unknown): void => atomicWrite(path, JSON.stringify(data, null, 2) + '\n')

// capture.ts's CaptureDeps.writeText (task 10): writes `text` exactly as
// given, no JSON.stringify and no added newline -- mergeCodexToml
// (codex-config.ts) already returns the complete file text, trailing
// newline included when the original file had one.
export const writeCodexText = (path: string, text: string): void => atomicWrite(path, text)

export type ApplyResult = 'wrote' | 'unchanged' | 'error'

// Adds `name` -> `url` to one harness's config file. Never throws: every
// fallible step -- read, parse, merge, write -- is caught right here, so a
// bad harness cannot stop the others from being tried and cannot crash the
// process with a raw stack trace. Failure is the 'error' branch of the
// return value, for runSetup()/setup() to tally and report.
export function applyToHarness(
  configPath: string,
  harnessLabel: string,
  name: string,
  url: string,
  writeJson: WriteJson = atomicWriteJson,
): { status: ApplyResult; message: string } {
  let existing: McpConfig
  try {
    const raw = readFileSync(configPath, 'utf8')
    if (raw.trim() === '') {
      // An empty file is a blank slate, not corruption -- and it is the
      // shipped initial state of a freshly installed harness. Measured
      // 2026-08-26: ~/.cursor/mcp.json on this machine is zero bytes, with
      // Cursor installed and never having had an MCP server added.
      // JSON.parse('') throws, so without this branch the single most
      // likely first-run state would be reported as "could not read or
      // parse ... leaving it untouched" and setup would fail for exactly
      // the people who had done nothing wrong -- the worst population to
      // fail on, since they have no configuration to inspect for a clue.
      // Deliberately narrow: only whitespace qualifies. Any non-blank
      // content that fails to parse is real corruption and is still
      // refused by the catch below, because overwriting a file whose
      // contents we could not understand is the one thing this function
      // must never do.
      existing = {}
    } else {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // Valid JSON, but not a shape this tool can safely merge into.
        // existing.mcpServers below would throw on a null base -- optional
        // chaining only guards the property *lookup* (the "?.[name]" part),
        // not "existing" itself being null -- reproduced against the
        // compiled binary with a config file whose entire content is the
        // JSON literal "null". Arrays and other primitives don't throw the
        // same way, but spreading them into the merged object would
        // silently corrupt the file instead, which is just as wrong.
        // Refused for the same reason mergeMcpConfig refuses a same-name
        // entry with a different URL: loud and legible beats a raw stack
        // trace or silent corruption.
        return {
          status: 'error',
          message: `${harnessLabel}: ${configPath}'s content is not a JSON object -- leaving it untouched.`,
        }
      }
      existing = parsed as McpConfig
    }
  } catch (err) {
    return {
      status: 'error',
      message:
        `${harnessLabel}: could not read or parse ${configPath} -- leaving it untouched.\n` +
        `  ${(err as Error).message}`,
    }
  }

  const alreadyPresent = existing.mcpServers?.[name] !== undefined

  let merged: McpConfig
  try {
    merged = mergeMcpConfig(existing, name, url)
  } catch (err) {
    // mergeMcpConfig's refusal: same name, different URL already there.
    return { status: 'error', message: `${harnessLabel}: ${(err as Error).message}` }
  }

  if (alreadyPresent) {
    return {
      status: 'unchanged',
      message: `${harnessLabel}: "${name}" already points at ${url} -- nothing to change.`,
    }
  }

  try {
    writeJson(configPath, merged)
  } catch (err) {
    return {
      status: 'error',
      message: `${harnessLabel}: could not write ${configPath} -- ${(err as Error).message}`,
    }
  }

  return { status: 'wrote', message: `${harnessLabel}: added "${name}" -> ${url} (${configPath}).` }
}

export type HarnessResult = {
  harness: string
  configPath: string
  status: 'not-found' | ApplyResult
  message: string
}

export function runSetup(
  harnesses: Harness[],
  name: string,
  url: string,
  writeJson: WriteJson = atomicWriteJson,
): HarnessResult[] {
  return harnesses.map((harness): HarnessResult => {
    if (!harnessConfigExists(harness)) {
      return {
        harness: harness.name,
        configPath: harness.configPath,
        status: 'not-found',
        message: `${harness.name}: not found at ${harness.configPath} -- skipping.`,
      }
    }
    const { status, message } = applyToHarness(harness.configPath, harness.name, name, url, writeJson)
    return { harness: harness.name, configPath: harness.configPath, status, message }
  })
}

// Tracked as three separate facts on purpose: "found but already correct"
// and "not found at all" collapsed into one boolean in an earlier draft,
// which made a re-run on an already-configured machine print "no
// supported harness config was found" -- false, and actively misleading
// on what is probably the most common real invocation. See
// cli.test.mjs's runSetup + summarize block.
export function summarize(results: HarnessResult[]): {
  foundAny: boolean
  wroteAny: boolean
  hadError: boolean
} {
  return {
    foundAny: results.some((r) => r.status !== 'not-found'),
    wroteAny: results.some((r) => r.status === 'wrote'),
    hadError: results.some((r) => r.status === 'error'),
  }
}

// The one-shot readline prompt setup()'s own new question needs, real
// default for SetupPrompt below -- a plain rl.question(), not the
// async-iterator dance withTerminalPrompt uses for enable()'s sequential
// questions (see that function's own comment): setup() only ever asks one
// question of its own before handing off to runImport,
// which opens (and closes) its own readline in turn, so there is no shared
// interface for two overlapping .question() calls to race over.
function realSetupPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

export type SetupPrompt = (question: string) => Promise<string>
export type RunImport = () => Promise<void>

// Verbatim -- cli.test.mjs depends on this exact string, the same contract
// capture.ts's own SIGN_IN_QUESTION carries.
//
// spec 068 D3: this used to offer capture enable. The plugin already sends
// each prompt and final reply, and the "Remember from conversations" switch
// is on by default (D1), so the hook is no longer the step a new person is
// missing. Their past sessions are: the plugin never sees those. So setup
// offers the one-time import, and full record stays a command a person
// chooses on their own.
export const IMPORT_QUESTION =
  'Also import past sessions and CLAUDE.md files from this machine? Waku lists them before it sends anything. [y/N]: '

export async function setup(
  name: string,
  url: string,
  harnesses: Harness[] = getHarnesses(),
  // R20 (final review, spec 012): the real default, injected the same way
  // realCaptureDeps below builds it -- so cli.test.mjs can point this at a
  // temp path instead of the machine's actual ~/.codex/config.toml, the
  // same reason every other real path in this file is a parameter with a
  // real default rather than a bare homedir() call inline.
  codexConfigPath: string = join(homedir(), '.codex', 'config.toml'),
  // The two additions that make setup() async (this task): the question
  // itself (realSetupPrompt, above) and what a "y" answer actually runs.
  // Both injectable, the same reason every real path/writer/fetch in this
  // file is a parameter with a real default rather than a bare call inline
  // -- so cli.test.mjs never opens real stdin and never runs a real
  // import. The real runImport below is nothing but the "import" command
  // path (runImportCommand, same as dispatch()'s own 'import' case), called
  // with no flags (spec 068 D3) -- the list and its disclosure, the "> "
  // question, and the credential step all run exactly as they do from the
  // command line. Nothing here may skip, weaken, or pre-answer any of that:
  // the only thing this buys the person is not having to type "npx
  // waku-memory import" a second time.
  prompt: SetupPrompt = realSetupPrompt,
  runImport: RunImport = () => runImportCommand(urlPair(url).ingestUrl, DEFAULT_WINDOW_DAYS, { kind: 'ask' }),
): Promise<void> {
  const results = runSetup(harnesses, name, url)
  for (const r of results) {
    if (r.status === 'error') console.error(r.message)
    else console.log(r.message)
  }
  console.log('')

  // Task 14 (spec 012 §9): setup() no longer has a manual-harness list to
  // consult here -- Codex was its only member, and Codex now has a real,
  // automatic route of its own ("capture enable", task 10), so there is
  // nothing left this function can detect but not write. getHarnesses()
  // still does not carry Codex (harnesses.ts's own comment has the fuller
  // account), so a Codex-only machine still falls through to the plain "no
  // supported harness config was found" branch below -- R20 below is what
  // stops that from being a flatly false thing to print on such a machine.
  const { foundAny, wroteAny, hadError } = summarize(results)
  if (wroteAny) {
    console.log(
      'Next: open the harness and use a waku tool. The first call will get a 401, ' +
        'the harness will open your browser to sign in, and the call will then go ' +
        'through on retry -- that browser popup is expected, not an error.',
    )
  } else if (foundAny && !hadError) {
    console.log('Already configured correctly -- nothing to change.')
  } else if (foundAny && hadError) {
    console.log('Could not update every harness found -- see the messages above.')
  } else {
    console.log('Nothing was added: no supported harness config was found on this machine.')
  }

  // R20 (final review, spec 012): the regression this whole-branch review
  // caught -- "no supported harness config was found" is false on a machine
  // that has ~/.codex/config.toml. setup() still writes nothing for Codex
  // (getHarnesses() does not carry it, above), so this is advice, not a
  // result: it fires independently of the found/wrote/error branch above,
  // including alongside a real Claude Code result on a machine with both.
  if (existsSync(codexConfigPath)) {
    console.log('')
    // spec 068 D3: pointed at the plugin first, then at full-record on (the
    // name capture enable's install goes by now), which wires Codex here
    // without the plugin.
    console.log(
      'Codex was found. Install the Waku plugin in Codex, or run "npx waku-memory full-record on" to wire it in from here.',
    )
  }

  // Printed whenever a usable server exists on this machine -- which
  // includes the already-configured re-run, since a configured server with
  // nothing imported is exactly the state a re-runner is most likely to be
  // in. Withheld only when nothing was found at all, where the next step is
  // to install a harness, not to import.
  if (foundAny) {
    console.log('')
    console.log(importNote())
  }

  if (hadError) process.exitCode = 1

  // The follow-up question: asked only once a harness was found -- a
  // machine with none has no agent to import for yet, so asking would just
  // repeat the "nothing was added" message above in question form. Default
  // is no (an empty answer, from pressing Enter, keeps today's behaviour
  // exactly) -- sending past sessions is a much bigger step than writing an
  // MCP config, so unlike enable()'s own SIGN_IN_QUESTION (whose default
  // path still requires choosing 1 or 2), this one must never be opted into
  // by accident. spec 068 D3: it offers the import now, not the hook.
  if (foundAny) {
    const answer = (await prompt(IMPORT_QUESTION)).trim().toLowerCase()
    if (answer === 'y') {
      await runImport()
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Reads all of stdin and joins it back into one string. A hook event is a
// single JSON object, normally delivered as one line -- readline is used
// for it anyway (rather than collecting raw 'data' chunks) because it is
// the built-in that already handles encoding and end-of-stream correctly,
// and it is on the shim's short allowed-built-ins list for exactly this.
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    process.stdin.on('error', reject)
    const rl = createInterface({ input: process.stdin, terminal: false })
    rl.on('line', (line) => lines.push(line))
    rl.on('close', () => resolve(lines.join('\n')))
  })
}

// The imperative shell around handleHookEvent: read stdin, parse it, hand
// the result to the tested decision logic with the real deps (the user's
// actual config dir, the real global fetch). Deliberately never awaited by
// run() below -- see that call site's comment for why that is safe here
// specifically, which is not the same as it being safe in general.
async function runHookCommand(harness: HarnessId): Promise<void> {
  let raw: string
  try {
    raw = await readStdin()
  } catch (err) {
    console.error(`waku-memory hook: could not read stdin -- ${errorMessage(err)}.`)
    return
  }

  let event: unknown
  try {
    event = JSON.parse(raw)
  } catch (err) {
    // Malformed input is a no-op, not a crash: some future hook event this
    // shim was not written against, or a hand test of `waku-memory hook`
    // with no stdin piped in at all.
    console.error(`waku-memory hook: stdin was not valid JSON -- ${errorMessage(err)}.`)
    return
  }

  await handleHookEvent(event as HookEvent, {
    configDir: join(homedir(), '.waku-memory'),
    fetchImpl: fetch,
    harness,
    refreshSetup: refreshSetupInBackground,
  })
}

// The platform opener login.ts's LoginDeps.openBrowser needs (spec 012 §7):
// spawned detached and unref'd so it never blocks -- or waits on -- this
// process, and never throws: a failed spawn (no browser installed, no
// `xdg-open` on a headless machine) is fine, because the authorize URL is
// always printed first (login.ts's own login(), right before this runs).
// The 'error' listener exists for the same reason as the try/catch: a spawn
// failure can surface asynchronously (an ENOENT for a missing xdg-open,
// say) rather than as a synchronous throw, and an unhandled 'error' event
// on a ChildProcess crashes the process if nothing is listening for it.
// The argv/options openBrowser (below) hands to child_process.spawn, kept
// as a pure function of (platform, url) so a unit test can assert the exact
// shape without spawning a real process or opening a real browser (fix
// round 1, finding 1). The previous win32 shape --
// `spawn('cmd', ['/c', 'start', '""', url])`, no shell, no verbatim-argument
// flag -- was Critical-broken for any real authorize URL: Node's default
// Windows argv quoting only wraps an argument in quotes when it contains
// whitespace, so an `&`-separated OAuth URL passed through untouched, and
// cmd.exe then read each `&` as its own command separator, truncating the
// URL at the first `&` and failing on every parameter after it as an
// unrecognized command.
//
// Chosen fix: shape (a) from the controller's ruling, not (b)
// (`rundll32 url.dll,FileProtocolHandler`) -- `cmd /c start` is the
// documented way to hand a URL to the OS's own default-handler resolution
// (same as double-clicking a link), while rundll32's undocumented internal
// entry point is a narrower target to keep behaving identically across
// Windows versions.
// `windowsVerbatimArguments: true` stops Node from re-quoting each argv
// entry (the exact thing that let `""` and the URL arrive at cmd.exe
// unquoted in the first place); wrapping the URL in its own literal double
// quotes (`` `"${url}"` ``) is then what makes cmd.exe treat everything
// between them -- `&` included -- as one argument instead of a command
// separator. The leading `'""'` argument is unrelated to the URL: it is
// `start`'s own window-title argument, required so `start` does not
// mistake a quoted first argument (the URL, if it came first) for a title
// instead of the command to run. Reproduced directly from Bash on this
// machine, adapted from the reviewer's own repro (see cli.test.mjs's
// nearby test and this task's report for the transcript): `cmd /c echo ""
// "https://x/a?b=1&c=2"` under `windowsVerbatimArguments: true` prints the
// URL whole, `&` and all -- `echo` standing in for `start` the same way the
// reviewer's own reproduction used it.
//
// darwin/linux are untouched: `open`/`xdg-open` never go through a shell,
// so Node's own (correct, non-Windows) argv handling was never the problem
// there.
export function buildBrowserOpener(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[]; options: SpawnOptions } {
  if (platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'start', '""', `"${url}"`],
      options: { detached: true, stdio: 'ignore', windowsVerbatimArguments: true },
    }
  }
  if (platform === 'darwin') {
    return { command: 'open', args: [url], options: { detached: true, stdio: 'ignore' } }
  }
  return { command: 'xdg-open', args: [url], options: { detached: true, stdio: 'ignore' } }
}

function openBrowser(url: string): void {
  try {
    const { command, args, options } = buildBrowserOpener(process.platform, url)
    const child = spawn(command, args, options)
    child.on('error', () => {
      // Never throws -- the URL was already printed (login.ts's login()).
    })
    child.unref()
  } catch {
    // Same reasoning as the 'error' listener above, for the rarer case
    // where spawn() itself throws synchronously.
  }
}

// login.ts's LoginDeps, built the one way this shim ever builds it -- both
// `waku-memory login` (run()'s own 'login' case) and "capture enable"'s
// login Credential (realCaptureDeps below) call this with the same
// ingest-base `apiBase` dispatch() already computed.
function realLoginDeps(apiBase: string): LoginDeps {
  return {
    apiBase,
    configDir: join(homedir(), '.waku-memory'),
    fetchImpl: fetch,
    openBrowser,
    stdout: (text: string) => console.log(text),
    version: SHIM_VERSION,
  }
}

// spec 071 F1: the same files realCaptureDeps names, and the same writers.
function realSetupDeps(): SetupDeps {
  return {
    home: homedir(),
    platform: process.platform,
    configDir: join(homedir(), '.waku-memory'),
    computerName: hostname(),
    fetchImpl: fetch,
    writeJsonFile,
    now: () => Date.now(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }
}

// spec 073 D9: `claude` as the person would type it. On Windows it is a
// .cmd shim, which only a shell finds. stdin is closed, so a prompt cannot
// hold the restore open, and the timeout bounds a slow marketplace clone.
function runClaude(args: string[]): ClaudeRun {
  const run = spawnSync('claude', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    shell: process.platform === 'win32',
    windowsHide: true,
  })
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { ok: false, missing: true, output: '' }
  return { ok: run.status === 0, missing: false, output: `${run.stdout ?? ''}\n${run.stderr ?? ''}` }
}

function realRestoreDeps(): RestoreDeps {
  const { home, platform, configDir, fetchImpl, log, error } = realSetupDeps()
  return { home, platform, configDir, fetchImpl, writeText: writeCodexText, runClaude, log, error }
}

// spec 073 D8, T12: after the brief, the SessionStart hook starts a
// background "setup save --auto" when a setup file changed since the last
// save. Only stats here; the child reads the files, and it is detached and
// unref'd, so this hook neither waits for it nor fails with it.
// process.argv[1] is the hook copy's own index.js.
export function refreshSetupInBackground(): void {
  const deps = realSetupDeps()
  if (!setupNeedsRefresh(deps, deps.now())) return
  const script = process.argv[1]
  if (!script) return
  const child = spawn(process.execPath, [script, 'setup', 'save', '--auto'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}

function realActDeps(): ActDeps {
  return {
    configDir: join(homedir(), '.waku-memory'),
    settingsPath: join(homedir(), '.claude', 'settings.json'),
    codexHooksPath: join(homedir(), '.codex', 'hooks.json'),
    writeSettingsJson: (path, data) => atomicWriteJson(path, data as unknown as McpConfig),
    writeJsonFile,
    fetchImpl: fetch,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }
}

// The real deps enable()/disable() run against outside a test: real paths
// under the user's home directory, an injected prompt (built by the two
// call sites below), and cli.ts's own atomicWriteJson as the settings
// writer -- capture.ts never imports atomicWriteJson itself (that would
// import cli.ts from capture.ts, which already imports capture.ts the
// other way around), so the cast below is the one place the two files'
// JSON-shaped types meet. Safe in practice: atomicWriteJson only ever does
// JSON.stringify(data) -- it has no opinion about McpConfig vs
// ClaudeSettings beyond the type checker's.
//
// hookSourceDir is this module's own directory, not a fixed constant: as
// published, cli.ts compiles to dist/cli.js and runs from there, so
// import.meta.url resolves to dist -- exactly the directory installHookCopy
// needs (spec 011 §6, task 11). verifyHook actually runs the entry once
// with a throwaway event before enable() trusts it, so a corrupted copy or
// a Node too old for it is caught before settings.json is ever touched.
//
// fetchImpl is task 13's addition (spec 011 §8): the real global fetch, for
// runBootstrap's own network calls. bootstrap is now a parameter rather than
// a hardcoded default (task 14): dispatch() has already turned
// --since/--all/--no-bootstrap (or their absence) into this same shape, so
// this function's only job is to place it on the deps bag unchanged, the
// same way `prompt` already arrives built by its own call site below.
function realCaptureDeps(
  prompt: (question: string) => Promise<string>,
  bootstrap: CaptureBootstrap,
  // Fix round 1 (spec 012 §4.2): the MCP-shaped url (dispatch()'s mcpUrl,
  // computed from --url BEFORE it was stripped to the ingest base) --
  // passed alongside bootstrap the same way disable()'s and status()'s call
  // sites already pass a bootstrap they never use, so every caller builds
  // deps the same way regardless of whether its own action reads the field.
  mcpUrl: string,
  // Task 13's addition (spec 012 §7): the ingest base (dispatch()'s
  // ingestUrl) realLoginDeps needs for deps.login below -- every call site
  // already has this value (it is enable()'s own `url` parameter, or
  // disable's/status's respective stand-ins), so, like bootstrap and mcpUrl
  // above, it is threaded through unconditionally rather than only for the
  // one action that can actually reach the credential question.
  ingestUrl: string,
  // withTerminalPrompt's answerable(). The commands that never prompt
  // (disable, status) keep the default: nobody can answer them.
  answerable: () => boolean = () => false,
): CaptureDeps {
  const claudeDir = join(homedir(), '.claude')
  const codexDir = join(homedir(), '.codex')
  return {
    claudeDir,
    settingsPath: join(claudeDir, 'settings.json'),
    configDir: join(homedir(), '.waku-memory'),
    hookSourceDir: dirname(fileURLToPath(import.meta.url)),
    version: SHIM_VERSION,
    execPath: process.execPath,
    verifyHook: (run: HookInvocation) =>
      spawnSync(run.command, run.args ?? [], { input: '{"hook_event_name":"Nope"}\n', timeout: 10_000 }).status === 0,
    prompt,
    answerable,
    writeSettingsJson: (path, data) => atomicWriteJson(path, data as unknown as McpConfig),
    fetchImpl: fetch,
    bootstrap,
    // Codex (task 10, spec 012 §4.6): detected the same way claudeDir is --
    // existence of the path is the evidence. codexPluginsCacheDir matches
    // codexPluginPresent's own comment (codex-config.ts) on where Codex
    // caches an installed plugin; marketplacePath is the personal
    // marketplace every machine gets one of, regardless of which harnesses
    // it has (~/.agents is not itself Codex-specific).
    codexConfigPath: join(codexDir, 'config.toml'),
    codexHooksPath: join(codexDir, 'hooks.json'),
    codexPluginsCacheDir: join(codexDir, 'plugins', 'cache'),
    marketplacePath: join(homedir(), '.agents', 'plugins', 'marketplace.json'),
    // spec 024 §4: mirrors codexPluginsCacheDir above -- claudePluginPresent's
    // own second detection route (capture.ts), on Claude Code's side.
    claudePluginsCacheDir: join(claudeDir, 'plugins', 'cache'),
    mcpUrl,
    writeText: writeCodexText,
    writeJsonFile,
    login: () => login(realLoginDeps(ingestUrl)),
  }
}

// Not awaited by run() below, for the same structural reason runHookCommand
// isn't (see run()'s 'hook' case) -- but unlike hook, which must always
// exit 0 so a capture bug can never read as the user's own session failing,
// this command is interactive and its exit code is meant to mean something:
// 'refused' (Claude Code missing, or a settings.json this tool cannot
// safely touch) is the one outcome that should make a scripted caller
// notice. 'declined' and the disable no-op are both a normal, successful
// run that did exactly what was asked -- nothing.
//
// `mode` (spec 068 D3): 'capture' for capture enable/disable, the hidden
// alias; 'full-record' for full-record on/off. Everything that differs
// between the two lives in capture.ts's enable()/disable().
async function runCaptureCommand(
  action: 'enable' | 'disable',
  url: string,
  mcpUrl: string,
  bootstrap: CaptureBootstrap,
  // undefined for 'disable' (Dispatch's disable variant carries no
  // credential at all -- see its own comment); always one of the three
  // Credential kinds for 'enable', built by dispatch()'s capture-enable
  // branch from --login/--key or their absence.
  credential: Credential | undefined,
  mode: HookMode = 'capture',
): Promise<void> {
  if (action === 'disable') {
    // disable() never prompts (see its own comment) -- no readline interface
    // is created at all, and this stub is a fail-loud guard against that
    // ever silently stopping being true. bootstrap is dispatch()'s
    // DEFAULT_BOOTSTRAP here regardless of what was on argv -- disable()
    // itself never reads deps.bootstrap either.
    const deps = realCaptureDeps(() => {
      throw new Error(`waku-memory ${mode === 'capture' ? 'capture disable' : 'full-record off'}: unexpectedly tried to prompt.`)
    }, bootstrap, mcpUrl, url)
    const result = await disable(deps, mode)
    if (result === 'refused') process.exitCode = 1
    return
  }

  await withTerminalPrompt(async (prompt, answerable) => {
    const result = await enable(url, realCaptureDeps(prompt, bootstrap, mcpUrl, url, answerable), credential, mode)
    if (result === 'refused' || result === 'bad-answer') process.exitCode = 1
  })
}

// One node:readline interface for every question a command asks, answered
// visibly on the real terminal (the frontend keys page already told the
// user their pasted key shows once, so echoing it back is not a new
// exposure). Deliberately NOT rl.question() called twice: readline's
// 'line' event fires as soon as a full line is parsed out of whatever is
// currently buffered, with no listener to catch it unless a .question()
// call happens to already be pending at that exact moment. Over a piped
// (non-TTY) stdin, both answers can arrive in the same chunk before the
// second .question() has even been called -- its one-time listener
// attaches too late, the line that already fired is gone, and the
// returned promise never resolves. An unresolved promise alone does not
// keep Node's event loop alive, so the process then exits 0 having
// written nothing, with no error and no hang to point at it. Proven by
// hand against the compiled binary with piped stdin (Node's own
// top-level-await detector reproduces the identical stuck-callback
// symptom against a two-line pipe), not by the unit tests, which inject a
// prompt function and never touch real readline.
//
// Iterating the interface as an async iterator instead -- pulling one
// line per question from the same queue -- does not have this race: the
// iterator protocol buffers whatever arrives until something actually
// asks for it, so no line can be dropped between one answer and the next
// question being asked. Confirmed against the same two-line pipe before
// landing here.
//
// Moved out of runCaptureCommand unchanged (spec 068 D3), so `import` asks
// its questions through the same interface.
//
// `answerable` (2026-11-20) is true while stdin is a terminal that has not
// closed. capture.ts's chooseImport reads it around import's "> " question
// and sends nothing when it is false: an agent running the command has no
// terminal, and an empty read from it is nobody answering, not Enter.
async function withTerminalPrompt(
  fn: (prompt: (question: string) => Promise<string>, answerable: () => boolean) => Promise<void>,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const lines = rl[Symbol.asyncIterator]()
  let closed = false
  try {
    const prompt = async (question: string): Promise<string> => {
      process.stdout.write(question)
      const { value, done } = await lines.next()
      if (done) closed = true
      // stdin closed before an answer arrived: '' here, and answerable() is
      // false from now on. The import question then sends nothing and says
      // to rerun with --answer; the yes/no and sign-in questions read '' as
      // declining.
      return done ? '' : value
    }
    await fn(prompt, () => process.stdin.isTTY === true && !closed)
  } finally {
    rl.close()
  }
}

// `npx waku-memory import` (spec 068 D3): importHistory() with the real deps.
// Exit code 1 for 'refused', the same mapping capture enable uses, for
// 'bad-answer' (an --answer that does not fit the list) and for
// 'list-changed' (--list missing, or the id of another list).
// 'unanswered' exits 0: an agent that ran the command without --answer did
// the expected first step, and the message tells it the next one.
async function runImportCommand(
  url: string,
  windowDays: number | null,
  credential: Credential,
  given: { answer?: string; list?: string } = {},
): Promise<void> {
  await withTerminalPrompt(async (prompt, answerable) => {
    const bootstrap: CaptureBootstrap = { windowDays, enabled: true, ...given }
    const deps = realCaptureDeps(prompt, bootstrap, urlPair(url).mcpUrl, url, answerable)
    const result = await importHistory(url, deps, credential)
    if (result === 'refused' || result === 'bad-answer' || result === 'list-changed') process.exitCode = 1
  })
}

// status() never prompts, never touches deps.bootstrap, and (ruling R8,
// fix round 1) needs no url at all -- same as disable() -- see
// runCaptureCommand's own stub above), so the prompt stub, DEFAULT_BOOTSTRAP
// and DEFAULT_URL here exist only to satisfy realCaptureDeps's shape, the
// same reason disable's call site needs them. spec 068 D3: `full` picks
// fullRecordStatus(), the same read worded as full record.
async function runCaptureStatusCommand(full = false): Promise<void> {
  const deps = realCaptureDeps(() => {
    throw new Error(`waku-memory ${full ? 'full-record' : 'capture'} status: unexpectedly tried to prompt.`)
  }, DEFAULT_BOOTSTRAP, DEFAULT_URL, DEFAULT_INGEST_URL)
  await (full ? fullRecordStatus(deps) : status(deps))
}

export function run(argv: string[]): void {
  const d = dispatch(argv)
  switch (d.kind) {
    case 'help':
      printUsage()
      process.exitCode = 0
      return
    case 'no-command':
      printUsage()
      process.exitCode = 1
      return
    case 'unknown':
      console.error(`Unknown command "${d.command}".`)
      printUsage()
      process.exitCode = 1
      return
    case 'bad-flag':
      console.error(d.message)
      printUsage()
      process.exitCode = 1
      return
    case 'setup':
      void setup(d.name, d.url).catch((err) => {
        console.error(`waku-memory setup: unexpected failure -- ${errorMessage(err)}.`)
        process.exitCode = 1
      })
      return
    case 'setup-save':
      void setupSave(realSetupDeps(), { label: d.label, dryRun: d.dryRun, auto: d.auto })
        .then((ok) => {
          process.exitCode = ok ? 0 : 1
        })
        .catch((err) => {
          if (!d.auto) console.error(`waku-memory setup save: unexpected failure -- ${errorMessage(err)}.`)
          process.exitCode = 1
        })
      return
    case 'setup-auto':
      process.exitCode = setupAuto(realSetupDeps(), d.on) ? 0 : 1
      return
    case 'setup-list':
      void listSetup(realRestoreDeps())
        .then((ok) => {
          process.exitCode = ok ? 0 : 1
        })
        .catch((err) => {
          console.error(`waku-memory setup list: unexpected failure -- ${errorMessage(err)}.`)
          process.exitCode = 1
        })
      return
    case 'setup-restore':
      void setupRestore(realRestoreDeps(), { ids: d.items, yes: d.yes })
        .then((ok) => {
          process.exitCode = ok ? 0 : 1
        })
        .catch((err) => {
          console.error(`waku-memory setup restore: unexpected failure -- ${errorMessage(err)}.`)
          process.exitCode = 1
        })
      return
    case 'login':
      // Ruling R15: the disclosure (and a blank line), no y/n gate -- unlike
      // "capture enable", signing in on its own asks nothing about consent
      // to *capture*, only about signing in, so there is no gate to hold it
      // behind. Exit-code mapping mirrors "capture enable"'s own (see
      // runCaptureCommand's own comment): 0 only on the fully successful
      // 'signed-in', 1 for 'timeout' or 'refused' -- the one outcome
      // distinction worth a nonzero exit for a scripted caller.
      console.log(DISCLOSURE)
      console.log('')
      void login(realLoginDeps(d.url))
        .then((result) => {
          process.exitCode = result === 'signed-in' ? 0 : 1
        })
        .catch((err) => {
          console.error(`waku-memory login: unexpected failure -- ${errorMessage(err)}.`)
          process.exitCode = 1
        })
      return
    case 'hook':
      // Exits 0 always, per the brief: set up front, not left to whatever
      // the default happens to be, and never touched again on any failure
      // path below this line. Not awaited -- index.ts does not await run()
      // either, and a floating promise is only safe because
      // runHookCommand() cannot reject: handleHookEvent already wraps its
      // own body in a catch-all, and the try/catches above cover the stdin
      // read and the JSON.parse that happen before it. The .catch() here is
      // a second backstop, not the mechanism this relies on.
      process.exitCode = 0
      void runHookCommand(d.harness).catch((err) => {
        console.error(`waku-memory hook: unexpected failure -- ${errorMessage(err)}.`)
      })
      return
    case 'capture':
      if (d.action === 'status') {
        void runCaptureStatusCommand().catch((err) => {
          console.error(`waku-memory capture: unexpected failure -- ${errorMessage(err)}.`)
          process.exitCode = 1
        })
        return
      }
      void runCaptureCommand(d.action, d.url, d.mcpUrl, d.bootstrap, d.action === 'enable' ? d.credential : undefined).catch(
        (err) => {
          console.error(`waku-memory capture: unexpected failure -- ${errorMessage(err)}.`)
          process.exitCode = 1
        },
      )
      return
    case 'import':
      void runImportCommand(d.url, d.windowDays, d.credential, { answer: d.answer, list: d.list }).catch((err) => {
        console.error(`waku-memory import: unexpected failure -- ${errorMessage(err)}.`)
        process.exitCode = 1
      })
      return
    case 'full-record': {
      const onFailure = (err: unknown) => {
        console.error(`waku-memory full-record: unexpected failure -- ${errorMessage(err)}.`)
        process.exitCode = 1
      }
      if (d.action === 'status') {
        void runCaptureStatusCommand(true).catch(onFailure)
        return
      }
      // DEFAULT_BOOTSTRAP is never read here: enable() in 'full-record' mode
      // skips the import step, and disable() never reads it at all.
      void runCaptureCommand(
        d.action === 'on' ? 'enable' : 'disable',
        d.url,
        d.mcpUrl,
        DEFAULT_BOOTSTRAP,
        d.action === 'on' ? d.credential : undefined,
        'full-record',
      ).catch(onFailure)
      return
    }
    case 'act': {
      const deps = realActDeps()
      const done =
        d.action === 'on' ? actOn(deps) : d.action === 'off' ? actOff(deps) : actStatus(deps).then(() => true)
      void done
        .then((ok) => {
          process.exitCode = ok ? 0 : 1
        })
        .catch((err) => {
          console.error(`waku-memory act: unexpected failure -- ${errorMessage(err)}.`)
          process.exitCode = 1
        })
      return
    }
    default: {
      const exhaustive: never = d
      throw new Error(`unhandled dispatch kind: ${JSON.stringify(exhaustive)}`)
    }
  }
}
