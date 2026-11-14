# Waku Memory

Waku Memory keeps what you tell your agents and what they learn, and brings it
back into later sessions. One store serves Claude Code, Codex, Waku Agent and
any other agent that speaks MCP, so a preference you state in one session reaches the
next one, on any machine.

## What the plugin contains

- One remote MCP server, `https://api.waku.one/mcp`, with the memory tools:
  `memory.remember`, `memory.search`, `memory.recall`, `memory.get`,
  `memory.explain`, `memory.forget` and `memory.import`.
- Three hooks that call that server's `session.hook` tool. The first prompt of
  a session brings a short brief of the project's memories, a compaction
  brings it again, and each turn's reply is sent for extraction. "Remember
  from conversations" is on by default, and you can turn it off for each
  agent at https://www.waku.one/integrations.
- One skill that tells the agent when to search and when to remember.

Nothing runs on your machine. The plugin holds no program and installs no
package; the hooks and tools reach the server through the sign-in you open.

## Install and sign in

In Claude Code, install the plugin with one command:

```
/plugin install waku --marketplace ShenSeanChen/waku-memory-plugins
```

Then run `/mcp`, choose `waku` and finish in the browser. In Codex, run
`codex plugin marketplace add ShenSeanChen/waku-memory-plugins` and then
`codex plugin add waku@waku-memory`. The install opens the browser sign-in, and Codex then asks you to trust the
plugin's hooks once in `/hooks`.

In Waku Agent, run `pip install waku-agent` and then
`waku plugin install waku@waku-memory`. Run `waku mcp login waku_memory` to
sign in, or start `waku` and sign in in the browser it opens.

## What it sends

What you type and what the agent replies is sent to Waku's servers at
api.waku.one, and on to the AI providers that turn a session into memories and
make them searchable, named at https://www.waku.one/privacy. Tool output, the
files the agent reads and the commands it runs are not sent, except where the
agent quotes them in its own reply. The agent's reasoning is never sent.

Each prompt is also sent, whether or not remembering from conversations is on, so the memories that
bear on it can be added beside it. Its first 2,000 characters are kept for 30
days in a match record that only you can read, on the Matches page.

This is an alpha, and its data can be lost.
