# waku-memory

Waku Memory gives your coding agent a memory that lasts across sessions and
projects. The Waku plugin is all most people need. This package is the
command line beside the plugin. Its `npx waku-memory` commands are extras
for people who want more.

Since 0.15.0 this package holds the commands only. The plugin's files are in
the plugin's own folder, and Claude Code, Codex and Waku Agent read them from
there.

## The plugin

The plugin is in this package's repository, at
[`plugins/waku`](https://github.com/waku-one/waku-memory-plugins/tree/main/plugins/waku).
Its README says how to install the plugin in Claude Code, Codex and Waku
Agent, what the plugin sends, and what the one program in it does.

In Claude Code, run

```
/plugin install waku --marketplace waku-one/waku-memory-plugins
```

then run `/mcp` and choose `waku` to sign in.

### Codex keeps asking you to sign in

If Codex keeps asking you to sign in to Waku again, give it a key instead of
the OAuth sign-in. Codex sometimes sends a refresh token it has already used
([openai/codex#17265](https://github.com/openai/codex/issues/17265)), and
Waku's sign-in server then ends that session. A key does not rotate, so there
is nothing to replay. Make one at https://www.waku.one/account/keys, export it
as `WAKU_API_KEY`, and put this in `~/.codex/config.toml`:

```toml
[mcp_servers.waku]
url = "https://api.waku.one/mcp"
bearer_token_env_var = "WAKU_API_KEY"
```

Revoke the key on the same page when you want it gone.

## Commands

Each command is named for what it does. None of them changes
"Remember from conversations".

### Import your history

```
npx waku-memory import [--url <ingest-base>] [--since <N>d] [--all] [--login] [--key <key>] [--list <id> --answer <answer>]
```

`import` runs once. It finds what your agents already keep on this machine:
`CLAUDE.md` files, memory files, skills and past sessions. It lists them and
asks before it sends anything. It installs no hook.

An agent that runs `import` has no terminal to answer in. `import` then
prints the list and a list id, sends nothing, and says how to run it again.
The agent shows the person the list. The agent runs `import` again with
`--list` and that id, plus the person's answer. The id covers every project,
session, memory file and skill on the list. When the list on the computer no
longer has that id, `import` sends nothing, prints the new list and its id,
and exits 1. `--answer n` needs no `--list`, because it sends nothing.

- `--since <N>d` limits the session scan to the last N days (default 180).
- `--all` scans full history instead of `--since`.
- `--login` signs in through the browser without asking first.
- `--key <key>` uses this key without asking first.
- `--url <ingest-base>` points at a server other than the default.
- `--answer <answer>` answers the list without asking. `all` imports
  everything on the list, `n` imports nothing, and numbers such as `"1 2"`
  import everything except those projects.
- `--list <id>` names the list id the answer is for. Every answer except `n`
  needs it.

Without `--login` or `--key`, `import` uses the key saved in
`~/.waku-memory/config.json`, or asks how you want to sign in.

### Full record

```
npx waku-memory full-record on [--url <ingest-base>] [--login] [--key <key>]
npx waku-memory full-record off
npx waku-memory full-record status
```

The plugin sends each prompt and its final reply. Full record sends the whole
session: what you type, all the text the agent writes, and the names of the
tools it uses. The files the agent reads and the commands it runs are not
sent, except where the agent quotes them in its reply. The agent's reasoning
is never sent.

`full-record on` shows that disclosure and waits for a typed "y". It then
installs a hook that runs this package's compiled code, so it needs Node 20
or newer.
The hook goes into `~/.claude/settings.json` for Claude Code and into
`~/.codex/hooks.json` for Codex. With the plugin installed too, the server
uses the full record once the hook has claimed a session, and the plugin
stops sending its own copy of that session. On Codex without the plugin,
`full-record on` also writes the `[mcp_servers.waku]` table into
`~/.codex/config.toml`. Codex asks for the same trust step: open `/hooks` and
trust Waku's four entries once. If "Remember from conversations" is off for
an agent, `full-record on` says so, and full record sends nothing for that
agent until you turn it on.

`full-record off` removes exactly the entries `full-record on` added. Your
saved key stays; revoke it at https://www.waku.one/account/keys if you want
it gone too. `full-record status` prints whether full record is on for each
agent and whether a key is saved. It only reads.

### Rules at each step (an experiment)

```
npx waku-memory act on
npx waku-memory act off
npx waku-memory act status
```

`act on` adds one more hook beside full record's. The hook runs before each
shell command and each file edit. It sends Waku the tool's name, the
command's first word and the file path. The rest of the command is not
sent. Waku answers with the rules and how-tos you saved for that step, three
at most, and each one once a session. The agent reads them before it runs
the step. Each step waits for Waku for up to 1.5 seconds.

`act on` needs full record on with this version, and it turns your act
channel on at Waku with the saved key. `act off` removes the hook and turns
the channel off. `full-record off` removes this hook too. In Codex, trust the
new entry once in `/hooks`.

### Other commands

- `npx waku-memory login [--url <ingest-base>]` signs in through the browser
  and mints an API key, without you ever seeing it. It stores the key in
  `~/.waku-memory/config.json` and touches no agent's config.
- `npx waku-memory setup [--name <name>] [--url <url>]` adds the Waku MCP
  server to Claude Code's config, for a machine without the plugin. It then
  offers the same one-time import as `import`. The default answer is no.

### Older command names

`npx waku-memory capture enable`, `capture disable` and `capture status`
still work for now, and they behave as they did in 0.12. `capture enable`
also turns "Remember from conversations" on and offers the import, and
`capture disable` turns it off. They will be removed in a later release, so
use `import` and `full-record` instead.
