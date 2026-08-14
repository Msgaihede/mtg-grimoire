#!/usr/bin/env bash
# Keep a Claude worktree close to origin/main, so a PR never ends in a 300-commit merge.
#
# Wired to two events in .claude/settings.json:
#   PostToolUse / Bash    - fires after `git commit`, the one moment the tree is clean
#   SessionStart          - catches a worktree that has sat idle for days
#
# It never starts a merge it cannot finish. `git merge-tree` performs the whole merge in
# memory first (git 2.38+); the working tree is only touched when that dry run comes back
# clean. On a conflict nothing is modified at all - Claude is told to merge deliberately.
#
# Only ever touches a checkout under .claude/worktrees/. The main checkout only fetches.

set -uo pipefail

trigger="${1:-session}"
FETCH_THROTTLE_SECONDS=120

payload=""
if [ ! -t 0 ]; then payload="$(cat 2>/dev/null || true)"; fi

# PostToolUse fires on every Bash call. A commit is the only one that leaves a clean tree,
# and grepping the raw payload catches `cd x && git commit` and `git -C path commit` too.
if [ "$trigger" = "commit" ]; then
  case "$payload" in
    *"git commit"*) ;;
    *) exit 0 ;;
  esac
  event="PostToolUse"
else
  event="SessionStart"
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
root="$(git rev-parse --path-format=absolute --show-toplevel 2>/dev/null)" || exit 0
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || exit 0

# JSON escaping without jq. Messages are kept to a single line so only \ and " need care.
jstr() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

emit() { # emit <systemMessage> [additionalContext]
  printf '{"systemMessage":"%s","suppressOutput":true' "$(jstr "$1")"
  if [ -n "${2:-}" ]; then
    printf ',"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}' \
      "$event" "$(jstr "$2")"
  fi
  printf '}\n'
}

# One fetch refreshes origin/main for every worktree at once - it writes to the shared
# common dir - so throttle it. Many worktrees committing must not mean many fetches.
stamp="$common/claude-main-fetch.stamp"
now="$(date +%s)"
last="0"
[ -f "$stamp" ] && last="$(cat "$stamp" 2>/dev/null || printf 0)"
case "$last" in ''|*[!0-9]*) last=0 ;; esac
if [ "$((now - last))" -ge "$FETCH_THROTTLE_SECONDS" ]; then
  if git fetch --quiet origin main >/dev/null 2>&1; then printf '%s' "$now" >"$stamp"; fi
fi

case "$root" in
  */.claude/worktrees/*) ;;
  *) exit 0 ;;                      # main checkout, or some other repo - fetch only
esac

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || exit 0
[ "$branch" = "main" ] && exit 0
[ "$branch" = "HEAD" ] && exit 0     # detached; nothing to merge into
git rev-parse --verify --quiet origin/main >/dev/null 2>&1 || exit 0

behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || printf 0)"
case "$behind" in ''|*[!0-9]*) exit 0 ;; esac
[ "$behind" -eq 0 ] && exit 0

wt="${root##*/}"

# A merge is lossless only from a clean tree - and right after a commit, it is one.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  if [ "$behind" -ge 50 ]; then
    emit "main is $behind commits ahead of $wt - merge skipped, uncommitted changes present." \
         "This worktree is $behind commits behind origin/main and the working tree is dirty, so the automatic merge was skipped. Commit the work in progress; the merge runs on the next commit."
  fi
  exit 0
fi

# Dry run: the whole merge, in memory. Nothing on disk is touched, whatever the outcome.
dry="$(git merge-tree --write-tree --name-only HEAD origin/main 2>/dev/null)"
dry_rc=$?

if [ "$dry_rc" -ne 0 ]; then
  # Conflicts. Do not start a merge we would have to abort - report and let Claude own it.
  files="$(printf '%s\n' "$dry" | tail -n +2 | sed -n '/^$/q;p')"
  count="$(printf '%s\n' "$files" | grep -c . || printf 0)"
  head_list="$(printf '%s\n' "$files" | grep . | head -n 8 |
                 awk 'NR>1{printf ", "}{printf "%s", $0}')"
  more=""
  [ "$count" -gt 8 ] && more=" (+$((count - 8)) more)"
  emit "$wt is $behind commits behind main and would conflict in $count files - not merged." \
       "This worktree is $behind commits behind origin/main. A dry-run merge (git merge-tree) conflicts in $count files: ${head_list}${more}. Nothing was modified. Merge it now rather than at PR time - the conflict only grows: run 'git merge origin/main', resolve those files, then 'npm run verify'. If package-lock.json is among them, re-run 'npm install' in this worktree afterwards."
  exit 0
fi

before="$(git rev-parse HEAD 2>/dev/null)"
if git merge --no-edit --quiet origin/main >/dev/null 2>&1; then
  changed="$(git diff --name-only "$before" HEAD 2>/dev/null | grep -c . || printf 0)"
  note=""
  if git diff --name-only "$before" HEAD 2>/dev/null | grep -q 'package-lock\.json\|package\.json'; then
    note=" Dependencies changed - run 'npm install' in this worktree."
  fi
  emit "Merged main into $wt: $behind commits, $changed files.$note" \
       "origin/main was merged into this worktree automatically ($behind commits, $changed files changed) because the dry run was conflict-free.$note Your own commits are untouched. If the suite now fails in files you did not write, it is the merge - not your change."
else
  # Race: the tree changed between the dry run and the merge. A clean tree was verified
  # above, so --abort restores it exactly.
  git merge --abort >/dev/null 2>&1 || true
  emit "Merge of main into $wt failed unexpectedly and was rolled back." \
       "An automatic merge of origin/main into this worktree failed after a clean dry run and was rolled back with 'git merge --abort' (the tree was verified clean first, so nothing was lost). Run 'git merge origin/main' by hand to see why."
fi
