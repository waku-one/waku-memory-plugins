---
name: waku-setup
description: Save this person's agent setup to Waku, or set up a new computer or account from it - MCP servers, plugins, connectors, scheduled tasks and agent settings. Use when the person moves to a new computer or account, or asks to save, move or restore their setup.
---

Waku keeps a list of the person's agent setup, so that a new computer or a
new account can be set up the same way. The list is not memory: recall,
search and the brief never return it. Keys, tokens and passwords stay out
of the list, so the person signs in to each connector again in the new
account and fills in each key a server needs. Never repeat a secret back
to the person. Talk to the person in the person's language.

## The computer half needs Node and a Waku key

The computer half runs Waku's command-line tool through `npx`. Skip this
section in an app with no shell, such as a claude.ai chat or ChatGPT.

- Check Node first: `node -v` must print v20 or later, and `npx -v` must
  print a version. When either fails, tell the person that the computer
  half needs Node.js 20 or later, and carry on with the account half.
- The tool signs in with its own Waku key, which the plugin's sign-in does
  not give it. When a `waku-memory` command says no Waku key is saved, run
  `npx -y waku-memory login` with a timeout of at least six minutes, or in
  the background. It opens Waku's sign-in page in the person's browser;
  tell them to finish there, and never sign in for them. When it prints
  "Signed in as" and an address, ask the person whether that is the same
  Waku account their agent uses, because a list saved under another
  account is not found when they restore. Then run the first command
  again. When it prints no "Signed in as" line, the sign-in did not
  finish: ask the person, and offer to run it again. On a remote computer
  the browser cannot reach the sign-in; say so and skip the computer half.

## Saving the setup

Save only when the person asks. When they say they are leaving a computer
or an account, offer to save, and wait for a yes.

1. Ask whether they are moving to another computer or only to another
   account on this one. A move between accounts on the same computer
   keeps every file here, so the computer half is optional; offer it as a
   backup.
2. For the computer half, run `npx -y waku-memory setup save`. It reads the
   setup of every agent on this computer (MCP servers, plugins, hooks,
   permissions, subagents, commands, and Cowork scheduled tasks on a Mac),
   removes every secret before anything leaves the computer, and saves the
   list under the computer's name; `--label <name>` gives it another name.
   Tell the person what it printed.
3. For the account half, list what your own tools can see and no file on
   the computer shows:
   - each connector the account has connected, with its name and its URL
     when you can see one, as type `connector`. A claude.ai chat shows only
     the connectors switched on for that chat, so ask whether any connector
     is switched off in this chat;
   - each scheduled task or routine that a tool of yours can list, with its
     name, its prompt, its schedule as the tool gives it (cron and time
     zone), its model, the connectors it uses and where it runs, as type
     `scheduled_task`. Copy each prompt exactly as the tool returned it:
     never shorten, translate or correct it;
   - each project or custom GPT you can see, with its instructions and the
     names of its files, as type `project` or `custom_gpt`.

   When your tools show none of these, as in ChatGPT, ask the person to
   paste their scheduled tasks and their list of connected apps, and build
   the items from what they paste. A scheduled task needs its full
   instructions, which a list page often leaves out, so ask for them. When
   the person cannot give them, save the task with `prompt_missing: true`
   in its body, and never write a prompt for it yourself.
4. Call `setup.save` with those items. Set `app` `claude_ai` for a Claude
   account's connectors, `claude_code` for a Claude Code routine, `cowork`
   for a Cowork task and `chatgpt` for anything in ChatGPT. Ask the person
   what to call this account, such as "Claude · work", and put an email
   address in the name only when they type one. A second save under the
   same `source_label` replaces that source's list, so call `setup.list`
   first and reuse the name the account already has. Leave out `raw`
   unless the person pasted the items; Waku then keeps the items
   themselves as the original. Write every key, token or password as
   `<secret:NAME>`, in the items and in `raw` alike. Waku refuses a save
   in which it still finds a secret, or an item over its size limit, and
   names the item: change only that item, tell the person what you
   changed, and save again. Never call `setup.save` with no items, because
   that marks every item under the name as gone.
5. Tell the person how many items Waku saved, and from where.

## Restoring the setup

Restore when the person asks to set up this computer or this account from
a saved list.

1. Call `setup.list`. When it is empty, tell the person that the list may
   be saved under a different Waku sign-in, and do not guess. Otherwise
   show every source with its items, and ask which source to restore
   from. Propose that source's items and none of the others. Leave out an
   item whose `restore_state` is `done` unless the person asks for it,
   and say which items have `gone_at`: they are no longer on their source.
   On a move between accounts on the same computer, propose only the
   account's source, because this computer's items are already here.
   Change nothing until the person agrees to the list.
2. For a computer's items, if you can run shell commands, run
   `npx -y waku-memory setup restore --items <id,...>` with the picked ids.
   The command writes MCP servers and files, and it never overwrites what
   is already here. It prints the full text of each hook, permission list
   and local-command server it held back, and the command it would run for
   each marketplace and plugin it held back. Show each one to the person,
   and run the command again with the same `--items` plus
   `--yes <id,...>` for only the ones they agree to. A second run is safe,
   because the command overwrites nothing. A path from the old computer
   may not exist on this one; point out any you see. Items it prints under
   "For the agent to re-create", such as a Cowork scheduled task, follow
   step 4. A new MCP server or plugin appears in the app only after a
   restart.
3. Connect the connectors first. Skip this step when the picked source
   holds no connector. A scheduled task can use only a connector the
   account has connected, and only the person can connect one, because
   each needs their own sign-in. Never sign in to or approve a connector
   for the person, even with a browser tool. List every connector in the
   picked source as numbered steps, each with the place it is added:
   - In Claude, open Customize (or Settings) > Connectors. Find a
     connector from the directory by its name. Add any other one with Add
     custom connector and the URL from the list.
   - In ChatGPT, open Settings > Apps (or Connectors). A custom connector
     needs Developer mode, which is turned on in the advanced settings
     there.
   - On a Team or Enterprise account, an admin enables a connector in the
     organization's settings before a member can connect it.

   When the person says they are done, check which of them your tools can
   see now: the MCP servers and tools in this session, or the connectors a
   routine tool lists. A connector may show up only after a restart, so
   when the person says one is connected and you cannot see it, mark it
   `manual`, not `done`. Mark each one you can see `done`, and name the
   ones still missing.
4. Then re-create the scheduled tasks, and any other account item your own
   tools can create, such as a routine. Before you create one, list the
   ones the account already has. When one with the same name is already
   there, mark the item `done` with the note "already there", and create
   no second one. Show each task's full prompt and schedule first, and
   create it only after the person says yes to that item. Attach the
   connectors it used that are now connected. When one is still missing,
   say which, and ask whether to create the task now or to wait until it
   is connected. A task that waits, and a task saved with
   `prompt_missing`, goes on the checklist.
5. Give the person a checklist for everything else: each connector still
   missing, each key a server needs by its `<secret:NAME>`, and each
   scheduled task you did not create, as the sentence that re-creates it,
   such as "Every weekday at 8:00, list three articles."
6. Call `setup.mark` for each item you handled: `done`, `manual` for an
   item on the checklist, `skipped` or `failed`, each with a short note.
   The restore command marks the computer items it handled by itself.

An item on the proposed list is not a yes. A scheduled task, a hook, a
permission list, an MCP server that runs a local command, a marketplace
and a plugin each run something or widen what an agent may do, so each one
waits for the person's own yes in the conversation.

What you pass to these tools is sent to Waku's servers. www.waku.one/privacy
says what Waku keeps and who processes it. This is an alpha and its data
can be lost.

<!-- spec 073 T15. One skill holds both halves, so the rules both need (no
     secret leaves the computer; each item that runs something waits for its
     own yes) are written once. It depends on no hook, so the hooked plugins
     load it from skills/ and the hook-less Muse manifest points at the same
     file. Like the waku skill, it names no processor. The flow review of
     2026-11-11 walked a person with only the plugin (no CLI key, maybe no
     Node) through both halves; plugin.test.mjs asserts the phrases each of
     its findings added. -->
