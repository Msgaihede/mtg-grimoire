---
name: auto-pr
description: Use when asked to "make an auto-pr", to open a PR that merges itself, or to watch, babysit or drive a pull request to merged while other agents are pushing to main. Also use when a PR sits at BEHIND, DIRTY, CONFLICT or "This branch has conflicts", when auto-merge is armed but nothing is happening, or when several open PRs keep knocking each other out of date.
---

# Auto-PR

Open the pull request, arm auto-merge, and then **only touch the two things GitHub gives up
on.** Auto-merge does the rest.

`main` is protected with `strict: true`, and the only required context is `ci-ok`. So every
merge into main knocks every other open PR to `BEHIND`, and each one has to merge main in
and re-run the whole gate before it can land. With eight to ten agents pushing, that queue
is the normal state of this repo, not an incident.

**GitHub already clears the easy half.** Measured 2026-08-14: main's tip moved at
11:29:27Z and PR #57's `Merge branch 'main' into ...` commit landed at 11:32:55Z — about
three and a half minutes, unattended. Do not sit and hand-merge PRs that auto-merge is
about to fix.

**What it never fixes:**

| It stalls on | Because | Who clears it |
| --- | --- | --- |
| `CONFLICT` (`DIRTY`) | GitHub tries the update, hits a real conflict, gives up silently. The PR then sits with auto-merge still armed and nothing happening. | Claude |
| `RED` `ci-ok` | A failing gate is never retried on its own. | Claude |
| the race | Ten PRs, main moving every few minutes: one wins each round, the rest go `BEHIND` again. Three minutes per round makes a queue that never drains. | `sync`, immediately |

## The script

`.claude/skills/auto-pr/pr-auto.ps1` — run it from the worktree that owns the branch.
Exit codes: **0** fine, **1** error, **3** needs Claude.

| Command | Does |
| --- | --- |
| `pr-auto.ps1 open` | push, `gh pr create --fill`, arm auto-merge. Idempotent. |
| `pr-auto.ps1 status` | one line of state for this branch's PR |
| `pr-auto.ps1 sync` | clear `BEHIND` now instead of in three minutes. `-All` for every open PR |
| `pr-auto.ps1 resolve` | start the local merge so a real conflict can be worked by hand |
| `pr-auto.ps1 watch` | event stream for `Monitor` — one line per state change, exits on merge |
| `pr-auto.ps1 fleet` | read-only board of every open PR |

## The workflow

1. **`npm run verify`, and read what it printed.** A green run in this session is the
   evidence; "it should pass" is not. Commit with a conventional prefix.
2. **`pr-auto.ps1 open`.** Refuses on `main` and on a dirty tree.
3. **Arm the watch** — this is the part that replaces polling by hand:

   ```
   Monitor(command: "pwsh -File .claude/skills/auto-pr/pr-auto.ps1 watch",
           description: "PR #<n> to merged", persistent: true)
   ```

   It stays quiet while CI runs, clears `BEHIND` itself, and notifies **only** on a state
   change. Go do other work. It exits on its own when the PR merges.
4. **When it reports `CONFLICT` or `RED`, that notification is the job.** Handle it, then
   the watch carries on.

## Handling a CONFLICT

```powershell
.claude\skills\auto-pr\pr-auto.ps1 resolve
```

Fetches, merges `origin/main`, and leaves the merge **in progress** with markers in the
tree — resolving while the conflict is still small is the point, and the tree was verified
clean first so `git merge --abort` stays a lossless way out.

**Read both sides.** main's side is another agent's shipped work and yours is yours, so
neither can be discarded wholesale. Never `git add -A` your way past it, and never
`git checkout --ours/--theirs` across the merge. Then `git add` each file,
`git commit --no-edit`, `npm run verify`, push.

If `package-lock.json` conflicted, `npm install` before verifying, or `tsc` fails TS2307 on
an import that is genuinely there.

## Handling a RED gate

```powershell
gh pr checks <n> --required
```

`--required` is the correct question, not a convenience: `ci-ok` is the only context branch
protection pins, so a green `rust (windows-latest)` says nothing about the gate. A
**skipped** `frontend` or `rust` job is the path router working, not a failure.

## Traps

- **`UNKNOWN` is not a state.** It is GitHub admitting it has not computed mergeability
  yet — asking is what starts the computation. Measured: PRs #58 and #51 read `UNKNOWN`,
  then `BEHIND` about a minute later. Re-poll; never act on it.
- **`sync` merges on GitHub, so your local branch ends up behind its own remote.** The
  `merge-main.sh` hook will not fix that — it merges `origin/main`, not `origin/<branch>`.
  `sync` fast-forwards the local branch when this worktree is on it and clean; otherwise
  `git pull` before your next push.
- **Never rebase.** Other agents' worktrees may track this branch and rewriting its history
  strands their work. `gh pr update-branch` defaults to a merge commit — keep it that way.
- **The release-please PR is not yours.** It opens in `action_required` with zero jobs —
  GitHub's recursion guard on a `GITHUB_TOKEN`-authored PR, not a broken workflow. `sync`
  and `fleet` skip it.
- **A watch on a PR with auto-merge off never ends.** It goes green and then just sits
  there. `watch` warns; believe the warning.

## Red flags — stop

- About to `git rebase`, `git reset --hard`, or `git push --force`.
- About to `git add -A` during a conflict resolution.
- About to hand-merge a `BEHIND` PR that auto-merge would have cleared — run `sync` or wait.
- About to say the PR is green without having run `npm run verify` in this session.
- About to leave a `CONFLICT` from `fleet` for later. It will not clear itself.
