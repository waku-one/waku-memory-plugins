#!/bin/sh
# Run the Claude Code mod's tests (spec 095).
#
# `claude plugin test <dir>` loads the mod from <dir> and runs only the test
# files under <dir>. The test file must not sit in plugins/waku/, because
# Claude Code and Codex copy that folder into each person's plugin cache.
# So this script copies the plugin and the tests into one temporary folder
# and runs the command there. The mod under test is the file in
# plugins/waku/hooks/, byte for byte.
#
#   sh scripts/test-mod.sh
#
# It needs the `claude` command. CI installs a pinned version.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$here/plugins/waku/." "$work/"
mkdir "$work/mod-tests"
cp "$here"/tests/mod/*.test.ts "$work/mod-tests/"
claude plugin test "$work"
