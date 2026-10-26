#!/usr/bin/env bash
# Prints the next unused line from commit-messages.txt and marks it used.
# usage: git commit -m "$(scripts/next-message.sh)"
set -euo pipefail
root=$(git rev-parse --show-toplevel)
file="$root/commit-messages.txt"
counter="$(git rev-parse --git-dir)/commit-message-index"

[[ -f $file ]] || { echo "missing $file" >&2; exit 1; }
n=$(( $(cat "$counter" 2>/dev/null || echo 0) + 1 ))
line=$(grep -v '^[[:space:]]*$' "$file" | sed -n "${n}p")
[[ -n $line ]] || { echo "out of lines in commit-messages.txt" >&2; exit 1; }
echo "$n" > "$counter"
printf '%s\n' "$line"
