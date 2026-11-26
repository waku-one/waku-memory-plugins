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
  agent at https://www.waku.one/integrations. Each call also sends the
  plugin's version number, so Waku can tell you when your plugin is out of
  date.
- One skill that tells the agent when to search and when to remember.

The plugin installs no package. The hooks and tools reach the server through
the sign-in you open.

**In Claude Code the plugin also runs one small program, a mod.** Claude Code
runs the mod inside itself (Claude Code 2.1.326 or later). The mod does two
things. It shows a row above the prompt while you are not signed in to Waku.
It adds `/waku-memories`, which opens a pane with up to 80 of your memories.
In the pane you can search your memories, keep one category, and switch
between the folder's project and every memory.

The mod calls Waku only when you run `/waku-memories`, press Refresh or
"Show more", search, choose a category or a project, or open a memory. It sends the folder your session runs in, and
the pane lists that folder's project. A read costs no credit, adds no row to
Matches, and adds one row to Usage. Claude Code passes the mod no prompt, no
reply and no tool call. When you press "Use in prompt", Claude Code tells the
mod whether it took the text, and the mod reads nothing else of that answer.
The mod reads no file, starts no program and makes no network request of its
own. It keeps nothing on your machine. Hide removes the sign-in row for the
session; the next session shows it again until you sign in.

In Codex and Waku Agent nothing runs on your machine.

### New in 0.14.7

The plugin now carries the mod described above. Earlier versions held
configuration only. After you update, Claude Code shows the row when you are
not signed in to Waku, and `/waku-memories` opens the pane. If you do not
want the program on your machine, turn the plugin off with `/plugin`.

### New in 0.15.6

The program for Claude Code works as it did in 0.15.5. One line of it held
invisible characters, in the rule that removes such characters from a
memory's text. That line now names each character by its code, so the file
reads the same as it runs.

### New in 0.15.5

The sign-in row shows in every session until you sign in to Waku. Hide
removes it for that session only, and the plugin no longer keeps your Hide
on your machine.

### New in 0.15.4

A list row shows a skill file by its name and description also when the
file's description is long. Knowledge badges are blue and Profile badges
violet on the Desktop app too.

### New in 0.15.3

A list row shows a skill file by its name and description, and shows a
memory's first line without Markdown's marks. Knowledge badges are blue on
the Desktop app, where they were red.

### New in 0.15.2

The pane gains a search field, a category list and a project list. Each
memory shows as a card with its category and the date it was saved, and an
opened memory links to its page on www.waku.one. The hooks send the
plugin's version number with each call. Claude Code updates this plugin by
itself only after you turn auto-update on: run `claude` in a terminal, type
`/plugin`, open Marketplaces, choose waku-memory and turn auto-update on.
The Desktop app has no such setting.

### New in 0.15.0

The files that Claude Code, Codex and Waku Agent read change in their
version number only. The folder gains the manifest and the skill that Muse
reads. The npm package `waku-memory` no longer carries a copy of the
plugin's files, so install the plugin with the commands below.

## Install and sign in

In Claude Code, install the plugin with one command:

```
/plugin install waku --marketplace waku-one/waku-memory-plugins
```

Then run `/mcp`, choose `waku` and finish in the browser. In Codex, run
`codex plugin marketplace add waku-one/waku-memory-plugins` and then
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

Each prompt is also sent, whether or not auto-save from conversations is on, so the memories that
bear on it can be added beside it. Its first 2,000 characters are kept for 30
days in a match record that only you can read, on the Matches page.

This is an alpha, and its data can be lost.
