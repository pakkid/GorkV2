#!/usr/bin/env bash
# Rewrites commit messages, oldest first, with lines from commit-messages.txt.
# By default only touches commits that aren't pushed yet (origin/main..HEAD).
# usage: scripts/reword-history.sh [base]   e.g. base=--root to rewrite everything
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cd "$root"
file="$root/commit-messages.txt"
counter="$(git rev-parse --git-dir)/commit-message-index"
[[ -f $file ]] || { echo "missing $file" >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "commit or stash your changes first" >&2; exit 1; }

base=${1:-origin/main}
if [[ $base == --root ]]; then range=HEAD; else range="$base..HEAD"; fi

lines=$(mktemp)
grep -v '^[[:space:]]*$' "$file" > "$lines"
total=$(git rev-list --count "$range")
(( total <= $(wc -l < "$lines") )) || { echo "need $total lines, file has $(wc -l < "$lines")" >&2; exit 1; }

# filter-branch walks oldest -> newest; a temp counter hands out lines in that order
tmp=$(mktemp); echo 0 > "$tmp"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter "
  n=\$((\$(cat '$tmp') + 1)); echo \$n > '$tmp'
  sed -n \"\${n}p\" '$lines'
" -- "$range" >/dev/null

# future commits from next-message.sh continue after the ones used here
cp "$tmp" "$counter"
rm -f "$lines" "$tmp"
rm -rf "$(git rev-parse --git-dir)/refs/original"
echo "reworded $total commits"
