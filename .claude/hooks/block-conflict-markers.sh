#!/usr/bin/env bash
# Refuse a `git commit` that would write git conflict markers into the branch.
#
# merge-main.sh deliberately leaves a conflicted merge in progress for Claude to resolve.
# The failure mode that creates is `git add -A && git commit`: that stages `<<<<<<<` as
# ordinary content, git raises no objection, the markers land on the branch, and the next
# post-commit merge sails forward on top of them. This is the backstop for that.
#
# Wired to PreToolUse/Bash in .claude/settings.json.

set -uo pipefail

payload=""
if [ ! -t 0 ]; then payload="$(cat 2>/dev/null || true)"; fi

case "$payload" in *"git commit"*) ;; *) exit 0 ;; esac

# Deliberate escape hatch, for the rare commit whose content really is a marker
# (documentation about conflicts, a test fixture).
case "$payload" in *"[skip-conflict-check]"*) exit 0 ;; esac

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# `=======` is left out on purpose: it is also a markdown setext underline, and this repo is
# full of prose. The 7-char opener and closer carry a trailing space and a ref name, so they
# do not occur by accident.
MARKER='^\+(<<<<<<< |>>>>>>> )'

staged="$(git diff --cached -U0 2>/dev/null | grep -cE "$MARKER" || true)"

# `git commit -a` stages tracked modifications at commit time, so those count too.
unstaged=0
case "$payload" in
  *"commit -a"*|*"commit --all"*|*"-am"*)
    unstaged="$(git diff -U0 2>/dev/null | grep -cE "$MARKER" || true)" ;;
esac

[ "${staged:-0}" -eq 0 ] && [ "${unstaged:-0}" -eq 0 ] && exit 0

files="$(git diff --name-only HEAD 2>/dev/null | while read -r f; do
           [ -f "$f" ] && grep -qE '^(<<<<<<< |>>>>>>> )' "$f" 2>/dev/null && printf '%s\n' "$f"
         done | head -n 8 | awk 'NR>1{printf ", "}{printf "%s", $0}')"

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

reason="This commit would write git conflict markers into the branch. Files still holding \
markers: ${files}. Finish the merge properly: open each one and reconcile both sides - main's \
side is other agents' shipped work and yours is yours, so neither can just be discarded - \
remove every <<<<<<< ======= >>>>>>> line, then 'git add' each file and commit. Do not 'git \
add -A' your way past this. If a marker really is intended file content, put \
[skip-conflict-check] in the commit message."

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' \
  "$(esc "$reason")"
