---
name: waku-setup
description: Save this person's agent setup to Waku, or set up a new computer or account from it - MCP servers, plugins, connectors, scheduled tasks and agent settings. Use when the person moves to a new computer or account, or asks to save, move or restore their setup.
---

Waku keeps a list of the person's agent setup, so that a new computer or a
new account can be set up the same way. The list is not memory: recall,
search and the brief never return it. Keys, tokens and passwords stay out
of the list, so the person signs in to each connector again in the new
account and fills in each key a server needs. Never repeat a secret back
to the person.

## Saving the setup

Save when the person asks to save or move their setup, or before they
leave a computer or an account.

1. If you can run shell commands, run `npx -y waku-memory setup save`. It
   reads the setup of every agent on this computer (MCP servers, plugins,
   hooks, permissions, subagents, commands, and Cowork scheduled tasks on
   a Mac), removes every secret before anything leaves the computer, and
   saves the list. Tell the person what it printed.
2. Save what the account holds and no file on the computer shows. List
   what your own tools can see:
   - each connector the account has connected, with its name and its URL
     when you can see one, as type `connector`;
   - each scheduled task or routine that a tool of yours can list, with
     its name, its full prompt, its schedule as the tool gives it (cron and
     time zone), its model, the connectors it uses and where it runs, as
     type `scheduled_task`;
   - each project or custom GPT you can see, with its instructions and the
     names of its files, as type `project` or `custom_gpt`.

   When your tools show none of these, as in ChatGPT, ask the person to
   paste their scheduled tasks page and their list of connected apps, and
   build the items from what they paste.
3. Call `setup.save` with those items, a `source_label` that names the app
   and the account, such as "Claude · ian@work.com", and a `raw` that holds
   what you read the items from. Write every key, token or password as
   `<secret:NAME>`, in the items and in `raw` alike. Waku refuses a save in
   which it still finds a secret and names the item. A second save under the same `source_label` replaces that
   source's list.
4. Tell the person how many items Waku saved, and from where.

## Restoring the setup

Restore when the person asks to set up this computer or this account from
a saved list.

1. Call `setup.list`. Show the person every source with its items, and ask
   which source to restore from. Start with that source's items ticked and
   every other item unticked. Change nothing until the person agrees to
   the list.
2. For a computer's items, if you can run shell commands, run
   `npx -y waku-memory setup restore --items <id,...>` with the picked ids.
   The command writes MCP servers, installs plugins and writes files, and
   it never overwrites what is already here. It prints the full text of
   each hook, permission list and local-command server it held back. Show
   each one to the person, and run the command again with the same
   `--items` plus `--yes <id,...>` for only the ones they agree to. A second
   run is safe, because the command overwrites nothing. Items it prints
   under "For the agent to re-create", such as a Cowork scheduled task,
   follow step 4.
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
   routine tool lists. Mark each one that arrived `done`, and name the ones
   still missing.
4. Then re-create the scheduled tasks, and any other account item your own
   tools can create, such as a routine. Show each one's full prompt and
   schedule first, and create it only after the person says yes to that
   item. Attach the connectors it used that are now connected. When one is
   still missing, say which, and ask whether to create the task now or to
   wait until it is connected. A task that waits goes on the checklist.
5. Give the person a checklist for everything else: each connector still
   missing, each key a server needs by its `<secret:NAME>`, and each
   scheduled task you did not create, as the sentence that re-creates it,
   such as "Every weekday at 8:00, list three articles."
6. Call `setup.mark` for each item you handled: `done`, `manual` for an
   item on the checklist, `skipped` or `failed`, each with a short note.
   The restore command marks the computer items it handled by itself.

A ticked item is not a yes. A scheduled task, a hook, a permission list
and an MCP server that runs a local command each run something or widen
what an agent may do, so each one waits for the person's own yes in the
conversation.

What you pass to these tools is sent to Waku's servers. www.waku.one/privacy
says what Waku keeps and who processes it. This is an alpha and its data
can be lost.

<!-- spec 073 T15. One skill holds both halves, so the two rules that both
     need (no secret leaves the computer; each item that runs something
     waits for its own yes) are written once. It depends on no hook, so the
     hooked plugins load it from skills/ and the hook-less Muse manifest
     points at the same file. Like the waku skill, it names no processor;
     plugin.test.mjs asserts that and the phrases above. -->
