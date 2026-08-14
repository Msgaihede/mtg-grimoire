#!/usr/bin/env bash
# Keep a Claude worktree close to origin/main, so a PR never ends in a 300-commit merge.
#
# Wired to two events in .claude/settings.json:
#   PostToolUse / Bash    - fires after `git commit`, the one moment the tree is clean
#   SessionStart          - catches a worktree that has sat idle for days
#
# On a conflict the merge is left IN PROGRESS, with markers in the tree, and Claude is told
# to resolve it before carrying on - resolving while the conflict is still small is the whole
# point. Merging is only ever started from a clean tree, so `git merge --abort` stays a
# lossless escape hatch for a human at any point.
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
gitdir="$(git rev-parse --path-format=absolute --git-dir 2>/dev/null)"

# An unfinished merge from a previous round. Never stack a second one on top of it.
if [ -f "$gitdir/MERGE_HEAD" ]; then
  stuck="$(git diff --name-only --diff-filter=U 2>/dev/null | grep -c . || true)"
  if [ "${stuck:-0}" -gt 0 ]; then
    emit "$wt has an unfinished merge of main - $stuck files still conflicted." \
         "A merge of origin/main into this worktree is still in progress, with $stuck files still conflicted. Finish it before anything else: resolve each one, 'git add' it, then 'git commit --no-edit'. Do not 'git add -A' - that stages the conflict markers verbatim."
  else
    # Nothing unmerged, but MERGE_HEAD is still set: everything has been staged without
    # being committed. This is exactly the state a blanket `git add -A` produces, so the
    # markers may well still be in there.
    emit "$wt has a staged but uncommitted merge of main - close it out." \
         "A merge of origin/main into this worktree is fully staged but not committed. Nothing reports as conflicted, which is also what a blanket 'git add -A' looks like - so first check the staged files for surviving '<<<<<<<' or '>>>>>>>' markers ('git diff --cached | grep -n \"^+<<<<<<< \"'), fix any you find, then 'git commit --no-edit' to close the merge before doing anything else."
  fi
  exit 0
fi

# Merging is only ever started from a clean tree - and right after a commit, it is one.
# That is what keeps `git merge --abort` a lossless escape hatch at any later point.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  if [ "$behind" -ge 50 ]; then
    emit "main is $behind commits ahead of $wt - merge skipped, uncommitted changes present." \
         "This worktree is $behind commits behind origin/main and the working tree is dirty, so the automatic merge was skipped. Commit the work in progress; the merge runs on the next commit."
  fi
  exit 0
fi

before="$(git rev-parse HEAD 2>/dev/null)"

if git merge --no-edit --quiet origin/main >/dev/null 2>&1; then
  changed="$(git diff --name-only "$before" HEAD 2>/dev/null | grep -c . || true)"
  note=""
  if git diff --name-only "$before" HEAD 2>/dev/null | grep -q 'package-lock\.json\|package\.json'; then
    note=" Dependencies changed - run 'npm install' in this worktree."
  fi
  emit "Merged main into $wt cleanly: $behind commits, $changed files.$note" \
       "origin/main was merged into this worktree automatically ($behind commits, $changed files changed), with no conflicts.$note Your own commits are untouched. If the suite now fails in files you did not write, it is the merge - not your change."
  exit 0
fi

files="$(git diff --name-only --diff-filter=U 2>/dev/null)"
count="$(printf '%s\n' "$files" | grep -c . || true)"

if [ "$count" -eq 0 ]; then
  # Failed before producing any conflict - typically an untracked file the merge would
  # clobber. Nothing is half-applied, so roll back rather than leave a stalled merge.
  git merge --abort >/dev/null 2>&1 || true
  emit "Merge of main into $wt could not start - rolled back, worktree untouched." \
       "An automatic merge of origin/main into this worktree failed without producing conflicts - usually an untracked file it would overwrite - and was rolled back with 'git merge --abort'. The tree was verified clean beforehand, so nothing was lost. Run 'git merge origin/main' by hand to see the actual error."
  exit 0
fi

# Conflicts. The merge stays IN PROGRESS on purpose: resolving now, while the conflict is
# this small, is the entire point. The tree was clean before, so a human can always bail
# out losslessly with `git merge --abort`.
head_list="$(printf '%s\n' "$files" | grep . | head -n 8 |
               awk 'NR>1{printf ", "}{printf "%s", $0}')"
more=""
[ "$count" -gt 8 ] && more=" (+$((count - 8)) more)"

emit "Merging main into $wt ($behind commits) conflicts in $count files - resolving now." \
     "origin/main was merged into this worktree automatically and the merge is IN PROGRESS with $count conflicted files: ${head_list}${more}. Resolve them before continuing with anything else - stopping here leaves the worktree unbuildable, and the conflict only grows. Resolve each file, 'git add' it, then 'git commit --no-edit'. Never 'git add -A' or 'git checkout --ours/--theirs' wholesale here: main's side is other agents' shipped work and your side is yours, so both have to be reconciled by reading them. If package-lock.json conflicted, re-run 'npm install' after resolving. Then 'npm run verify' before going back to what you were doing. To bail out instead, 'git merge --abort' restores the pre-merge state exactly."
