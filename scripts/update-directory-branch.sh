#!/bin/sh
# Write the hook-less plugin to a branch that holds nothing else.
#
#   sh scripts/update-directory-branch.sh <remote> <branch>
#
# Anthropic's plugin directory reads plugins/waku-directory/ on the
# `directory` branch. This script builds that folder from the working tree
# with scripts/directory-plugin.mjs, and makes the branch's tree hold that
# folder and no other file. The branch has no marketplace file, so nobody
# can add it as a marketplace and install the hook-less plugin over the full
# one.
#
# The script fetches the branch fresh, or starts it with no history when the
# remote has none. When the build equals the branch, the script prints
# "directory build unchanged for main <sha12>" and stops. Otherwise it adds
# one commit, "Directory build of main <sha12>, waku <version>", and pushes
# it. The push is not forced, so a second run that started from an older
# branch fails and changes nothing.
#
# The script works in a temporary index and never switches the caller's
# checkout. .github/workflows/directory.yml runs it after each push to main.
# Nobody pushes to the branch by hand: the next run overwrites a hand edit.
set -eu

if [ $# -ne 2 ]; then
  echo "Usage: sh scripts/update-directory-branch.sh <remote> <branch>" >&2
  exit 2
fi
remote=$1
branch=$2
folder=plugins/waku-directory

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
sha12=$(git rev-parse --short=12 HEAD)
version=$(node -p "require('./packages/waku-memory/package.json').version")

work=$(mktemp -d)
trap 'rm -rf "$work"; git update-ref -d refs/directory-build/remote 2>/dev/null || true' EXIT
node scripts/directory-plugin.mjs "$work/tree/$folder" >/dev/null

# The branch as the remote holds it now, if it exists.
parent=
if git fetch --quiet "$remote" "+refs/heads/$branch:refs/directory-build/remote" 2>/dev/null; then
  parent=$(git rev-parse refs/directory-build/remote)
fi

# A tree that holds the build and nothing else, made in an index of its own.
GIT_INDEX_FILE="$work/index"
export GIT_INDEX_FILE
git --work-tree="$work/tree" add --all .
tree=$(git write-tree)
unset GIT_INDEX_FILE

if [ -n "$parent" ] && [ "$(git rev-parse "$parent^{tree}")" = "$tree" ]; then
  echo "directory build unchanged for main $sha12"
  exit 0
fi

message="Directory build of main $sha12, waku $version"
if [ -n "$parent" ]; then
  commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
else
  commit=$(git commit-tree "$tree" -m "$message")
fi
git push --quiet "$remote" "$commit:refs/heads/$branch"
echo "$message"
