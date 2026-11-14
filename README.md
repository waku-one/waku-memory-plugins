# Waku Memory — plugin marketplace

This repository holds the Waku Memory plugin, in `plugins/waku`, and the two
files that list it: `.claude-plugin/marketplace.json` for Claude Code and
`.agents/plugins/marketplace.json` for Codex. Claude Code, Codex and Waku
Agent read the plugin straight from this repository, so installing it needs
neither Node nor npm.

The plugin's source of truth is `shim/` in the private backend repository,
which also builds the npm package
[`waku-memory`](https://www.npmjs.com/package/waku-memory). After a change
there, run `scripts/sync-from-shim.sh` and commit `plugins/waku`.

## Install in Claude Code

```
/plugin install waku --marketplace ShenSeanChen/waku-memory-plugins
```

then `/mcp` and choose `waku` to sign in. From a shell, the same install is
`claude plugin install waku --marketplace ShenSeanChen/waku-memory-plugins`
(Claude Code 2.1.292 or later). On Claude Code before 2.1.275 the
install is two commands: `/plugin marketplace add
ShenSeanChen/waku-memory-plugins`, then `/plugin install waku@waku-memory`.
Claude Code asks for no hook-trust step. The first prompt of a session brings
the brief, and each turn's reply is sent for extraction. "Remember from
conversations" is on by default. You can turn it off for each agent at
https://www.waku.one/integrations.

## Install in Codex

```
codex plugin marketplace add ShenSeanChen/waku-memory-plugins
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

<https://www.waku.one/>
