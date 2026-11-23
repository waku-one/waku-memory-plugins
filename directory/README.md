# Waku Memory

Waku Memory keeps what you tell your agents and what they learn, and brings it
back into later sessions. One store serves Claude Code, Codex and any other
agent that speaks MCP, so a preference you state in one session reaches the
next one, on any computer.

This version of the plugin runs no hooks. Nothing is sent to Waku until the
agent calls one of its tools, or until you ask it to save your setup.

## What the plugin contains

- One remote MCP server, `https://api.waku.one/mcp`, with the memory tools
  (`memory.remember`, `memory.search`, `memory.recall`, `memory.get`,
  `memory.explain`, `memory.forget` and `memory.import`) and the setup tools
  (`setup.save`, `setup.list` and `setup.mark`).
- The `waku` skill, which tells the agent when to search and when to
  remember.
- The `waku-setup` skill, which saves your agent setup and sets up a new
  computer or account from it. Keys, tokens and passwords stay out of the
  list, and each item that runs something waits for your yes.

The plugin holds no program and installs no package. The tools reach the
server through the sign-in you open with `/mcp`.

## The full plugin

The full plugin adds hooks: each session opens with a short brief of the
project's memories, and each turn can be sent to be remembered. It installs
from Waku's own marketplace:

```
/plugin marketplace add waku-one/waku-memory-plugins
/plugin install waku@waku-memory
```

If you choose to have your sessions recorded without the full plugin, you can
run `npx -y waku-memory full-record on` in a terminal. It is optional, and
nothing in this plugin runs it. It shows what it sends and waits for a typed
"y" before it installs its hook on your computer.

## What it sends

What the agent passes to a Waku tool is sent to Waku's servers at
api.waku.one, and on to the AI providers that make memories searchable, named
at https://www.waku.one/privacy.

One path does not go through the plugin's MCP server. When you ask the
`waku-setup` skill to save or restore your setup, the agent runs Waku's
command-line tool, `npx -y waku-memory setup save` or
`npx -y waku-memory setup restore`, which `npx` downloads from the npm
registry (the `waku-memory` package). On save, the tool reads your agents'
settings files on your computer, removes every key, token and password, and
sends the list to Waku's API at https://api.waku.one/setup with the key that
`npx -y waku-memory login` saved. On restore, it reads the list back from the
same API. It sends the list nowhere else.

This is an alpha, and its data can be lost.
