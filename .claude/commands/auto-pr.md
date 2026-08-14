---
description: Open a self-merging PR for this branch and watch it to merged, resolving conflicts as main moves
argument-hint: "[PR number to adopt, or blank for the current branch]"
---

Use the `auto-pr` skill. Read `.claude/skills/auto-pr/SKILL.md` and follow it.

Target: $ARGUMENTS (blank means the current branch).

Do this now:

1. If no PR number was given, run `npm run verify` and read the output before anything
   else. Commit with a conventional prefix if there is uncommitted work.
2. Run `.claude/skills/auto-pr/pr-auto.ps1 open` (or `status -Pr <n>` if adopting an
   existing PR).
3. Arm the watch with the `Monitor` tool, `persistent: true`, so it notifies on state
   changes instead of you polling:
   `pwsh -File .claude/skills/auto-pr/pr-auto.ps1 watch` — add `-Pr <n>` when adopting.
4. Report the PR URL and its current state, then carry on with other work. When the
   monitor reports `CONFLICT` or `RED`, handle it per the skill.

Do not press Merge yourself and do not hand-merge a `BEHIND` PR — auto-merge lands it.
