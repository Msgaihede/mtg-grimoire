#!/usr/bin/env bash
# Make a Claude worktree's node_modules real before the agent needs it, and hand back the
# two facts the agent would otherwise spend a tool call each discovering.
#
# Wired to SessionStart in .claude/settings.json, beside merge-main.sh.
#
# Why a hook and not prose: `pnpm install` in a worktree is a mechanical precondition, and
# the worktree-setup skill was carrying ~360 tokens of instructions for it in every single
# request of every worktree session (measured 2026-08-21: the skill loaded 1% of the way
# into a session and was re-sent ~271 times after that). A hook does the thing once and
# costs nothing per request. The skill keeps only the judgment - what to do when the branch
# is wrong, and the stash rule.
#
# Only ever touches a checkout under .claude/worktrees/. The main checkout is left alone.

set -uo pipefail

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
root="$(git rev-parse --path-format=absolute --show-toplevel 2>/dev/null)" || exit 0

case "$root" in
  */.claude/worktrees/*) ;;
  *) exit 0 ;;                      # main checkout, or some other repo
esac

# JSON escaping without jq, same as merge-main.sh. additionalContext is multi-line here, so
# newlines need escaping too - a raw one inside a JSON string is a parse error and the whole
# hook payload would be dropped silently.
jstr() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

emit() { # emit <systemMessage> <additionalContext>
  printf '{"systemMessage":"%s","suppressOutput":true' "$(jstr "$1")"
  printf ',"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "$(jstr "$2")"
}

cd "$root" || exit 0

# Is node_modules missing, or older than the lockfile? The second case is the one that reads
# as a real failure and is not: a merge brings a dependency, node_modules still exists, and
# `tsc` fails TS2307 on the new import. pnpm writes node_modules/.modules.yaml on every
# install, so its mtime is when the tree was last made to match the lock.
#
# A tree npm made has no such file, and is deleted before the install rather than installed
# over. `pnpm install` over one exits 0 and removes nothing (measured 2026-10-08: 450 entries
# at the root before, 470 after, npm's hoisted `prosemirror-view` still among them), and in
# that mixture every import no manifest declares goes on resolving - the one thing pnpm's
# layout is here to stop. Deleting it took 19 s and the install after it 10 s.
needs_install=0
replace_tree=0
reason=""
if [ ! -d node_modules ]; then
  needs_install=1
  reason="node_modules was absent"
elif [ ! -f node_modules/.modules.yaml ]; then
  needs_install=1
  replace_tree=1
  reason="node_modules was npm's and was deleted first"
elif [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  needs_install=1
  reason="pnpm-lock.yaml was newer than the last install"
fi

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf '?')"
commits="$(git log --oneline -3 2>/dev/null || true)"

install_line="node_modules already matched pnpm-lock.yaml; nothing installed."
lock_before=""
if [ "$needs_install" = "1" ]; then
  lock_before="$(git hash-object pnpm-lock.yaml 2>/dev/null || true)"
  started="$(date +%s)"
  if [ "$replace_tree" = "1" ]; then
    rm -rf node_modules
  fi
  if pnpm install >"$root/pnpm-install.local" 2>&1; then
    install_line="Ran pnpm install ($reason) in $(( $(date +%s) - started ))s. It succeeded."
  else
    # A failed install is worth more than a silent one: without it nothing resolves, and
    # `pnpm verify` stops at the first `tsc` so its cargo half never runs.
    install_line="Ran pnpm install ($reason) and IT FAILED after $(( $(date +%s) - started ))s. Read pnpm-install.local at the worktree root. Until it succeeds, imports do not resolve and pnpm verify never reaches cargo test - those failures are not yours."
  fi

if [ -n "$lock_before" ]; then
  lock_after="$(git hash-object pnpm-lock.yaml 2>/dev/null || true)"
  if [ "$lock_before" != "$lock_after" ]; then
    install_line="$install_line NOTE: the install REWROTE pnpm-lock.yaml, which is a tracked file - it is now dirty in git status and will ride into your PR unless you check it. Decide deliberately whether that change belongs in this branch."
  fi
fi
fi

ctx="Worktree setup (SessionStart hook, no action needed unless it says otherwise):
- Branch: $branch
- HEAD:
$commits
- Dependencies: $install_line

A worktree-isolated dispatch is created from main, not from the session's branch. If the branch above is not the one your task belongs to, fast-forward to it before touching anything - use the PowerShell tool, since Bash refuses git reset/merge/switch here. Never rebase, and never git reset a branch another agent may be tracking."

emit "Worktree ready: $branch" "$ctx"
