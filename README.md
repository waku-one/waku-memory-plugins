# Waku Memory — the plugin and the npm package

This repository holds two things that are released together under one
version number.

- **The plugin**, in `plugins/waku`. Claude Code, Codex and Waku Agent read
  it straight from this repository, so installing it needs neither Node nor
  npm. Two files list it: `.claude-plugin/marketplace.json` for Claude Code
  and `.agents/plugins/marketplace.json` for Codex.
- **The npm package** [`waku-memory`](https://www.npmjs.com/package/waku-memory),
  in `packages/waku-memory`. It is the command line behind
  `npx waku-memory`. It holds no plugin file.

The rest of the repository serves those two. `tests/` holds the tests of the
plugin's files and of the two marketplace files. `scripts/` and `directory/`
build a second plugin with no hooks, which Anthropic's plugin directory
reads.

## Install in Claude Code

```
/plugin install waku --marketplace waku-one/waku-memory-plugins
```

then `/mcp` and choose `waku` to sign in. From a shell, the same install is
`claude plugin install waku --marketplace waku-one/waku-memory-plugins`
(Claude Code 2.1.292 or later). On Claude Code before 2.1.275 the
install is two commands: `/plugin marketplace add
waku-one/waku-memory-plugins`, then `/plugin install waku@waku-memory`.
Claude Code asks for no hook-trust step. The first prompt of a session brings
the brief, and each turn's reply is sent for extraction. "Remember from
conversations" is on by default. You can turn it off for each agent at
https://www.waku.one/integrations.

## Install in Codex

```
codex plugin marketplace add waku-one/waku-memory-plugins
codex plugin add waku@waku-memory
```

Installing runs a browser sign-in against Waku's authorization server and
stores the credential where Codex keeps it. Codex then asks you to review and
trust the plugin's three hooks. Until you trust them, the session brief and the
capture do not run — open `/hooks` in Codex to do it.

## Install in Waku Agent

```
pip install waku-agent
waku plugin install waku@waku-memory
```

Waku Agent knows this marketplace by name, so no `marketplace add` step is
needed. Run `waku mcp login waku_memory` to sign in, or start `waku` and sign
in in the browser it opens. Waku Agent asks for no hook-trust step.

## What it does

Waku Memory keeps what you tell your agents and what they learn, and brings it
back into later sessions. `memory.recall` returns what is known about a
project; `memory.remember` keeps something worth keeping. The plugin's hooks
open each session with a short brief and send each turn to be remembered.

## What it sends — read this before installing

What you type and what the agent replies is sent to Waku's servers and on to
Anthropic, which is what turns a session into memories. Tool output, the files
the agent reads and the commands it runs are not sent, except where the agent
quotes them in its own reply; its reasoning is never sent.

Each prompt you give your agent is also sent, whether or not capture is on, so
the memories that bear on it can be shown beside it. Its first 2,000
characters are kept for 30 days in a match record that only you can read, on
the Matches page.

**This is an alpha, and its data can be lost.** Do not put anything here you
cannot afford to lose.

## Without the plugin

`npx waku-memory capture enable` does the same thing from the command line, on
Codex and on Claude Code alike, and can also import the history those harnesses
already keep. It needs Node 20 or newer.

## How a release works

1. A pull request changes `plugins/waku`, `packages/waku-memory` or both, and
   sets the new version. One version number covers the package, the four
   plugin manifests and `SHIM_VERSION` in `packages/waku-memory/src/hook.ts`,
   and a test fails when they differ. `ci.yml` runs the tests and the build
   on the pull request.
2. The pull request merges to `main`. Both marketplaces read `main`, so the
   plugin is released at the merge.
3. A person starts `publish.yml` on `main`, first with `dry_run` on and then
   with it off. The workflow publishes the package to npm by trusted
   publishing, with a provenance attestation. It holds no npm token.

Run `npm ci`, `npm test` and `npm run build` from the repository root.
`npm run test:mod` runs the tests of the Claude Code program in the plugin,
and it needs the `claude` command.

## The `directory` branch

Anthropic's plugin directory reads a plugin with no hooks from the folder
`plugins/waku-directory/`. `directory.yml` builds that folder from
`plugins/waku` after each push to `main` that changes the plugin, and
commits it to the branch `directory` when the build changed. The same
folder also sits on `main` until the directory's submission tracks the
`directory` branch. Nobody pushes to
`directory` by hand, because the next build overwrites a hand edit. The
branch holds no marketplace file, so it cannot be added as a marketplace.

<https://www.waku.one/>
