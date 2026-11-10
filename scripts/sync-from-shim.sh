#!/bin/sh
# Copy the plugin's files from the npm package's source into plugins/waku.
#
# The plugin is configuration only: a manifest per harness, the MCP server's
# address, the hooks and the skill. Its source of truth is shim/ in
# waku-memory-backend, which also builds the npm package. Run this after any
# change there, then commit plugins/waku and plugins/waku-directory here.
# Pass the shim's path if the backend repository is not beside this one.
#
# plugins/waku-directory is the plugin Anthropic's plugin directory reads.
# Since about 2026-11-05 the directory refuses hooks, files outside its list
# of types and config fields outside its list from organizations it has not
# Verified, so the shim builds a second plugin from the same files without
# them. Waku's own marketplace keeps serving the full one in plugins/waku.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
shim=${1:-"$here/../waku-memory-backend/shim"}
dest="$here/plugins/waku"
for f in .claude-plugin .codex-plugin .mcp.json hooks skills LICENSE; do
  rm -rf "$dest/$f"
  cp -R "$shim/$f" "$dest/$f"
done
echo "Copied from $shim, version $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$dest/.claude-plugin/plugin.json")"
node "$shim/scripts/directory-plugin.mjs" "$here/plugins/waku-directory"
