---
name: shipping-a-branch
description: Use when work in this repo is finished and needs to reach main - running npm run verify, committing, pushing, opening a pull request with gh, and clearing conflicts against main. Also use when a PR shows conflicts, when a check is red, or when unsure which CI check actually gates a merge or who is allowed to press Merge.
---

# Shipping a branch

Take the branch to a green pull request. **You do not merge it.**

## Before you start

- Locks released and the app stopped — `lock.ps1 status` must not name your worktree.
  See the `running-the-app` skill.
- `git status` clean of anything you did not mean to commit. Never `git add -A` from a
  worktree parent directory.

## 1. Verify, and read the output

```powershell
npm run verify
```

Build, lint, Vitest and `cargo test`. **Read what it printed.** "It should pass" is not
evidence; a green run in this session is. If it fails, fix it — do not push and hope CI
disagrees with your machine.

## 2. Commit small, with a conventional prefix

`feat:` `fix:` `chore:` `docs:` `test:`. release-please parses these to decide the next
version, so the prefix is a release decision rather than a style choice. While the app is
on `0.x`, a `!` bumps the **minor**.

## 3. Push and open the pull request

```powershell
git push -u origin (git branch --show-current)
gh pr create --fill
```

## 4. Merge main in. Never rebase.

```powershell
git fetch origin main
git merge origin/main
```

**Merge, never rebase and never reset.** Other agents' worktrees may track this branch,
and rewriting its history strands their work. Every conflict resolution in this
repository's history is a merge — `d4f7281`, `39e1132`.

Resolve conflicts in the working tree, then:

- **If the merge brought a new dependency, `npm install` again** — otherwise `tsc` fails
  TS2307 on the new import and it reads as a real failure.
- Re-run `npm run verify`.
- Push.

## 5. Wait for `ci-ok`

```powershell
gh pr checks --watch
```

**`ci-ok` is the one protected check.** Branch protection pins check names as strings and
a matrix job's name embeds its matrix values, so the aggregator is what has teeth — a
green `rust (windows-latest)` says nothing about the gate.

A change only builds the half it touched, so a **skipped** `frontend` or `rust` job is
the path router working, not a failure.

## 6. Report, and stop

Give the user the pull request URL and the `ci-ok` state. **Do not merge.** Do not enable
auto-merge, do not delete the branch, do not remove the worktree. The user presses Merge.

## Two things that look broken and are not

- **A release-please PR opens in `action_required` with zero jobs.** That is GitHub's
  recursion guard on a `GITHUB_TOKEN`-authored pull request, not a broken workflow. It
  needs approving before CI runs — and it is not your PR.
- **`ci-ok` treats a skipped build job as a pass.** Deliberate, and the reason the
  `changes` router job itself must succeed.

## Red flags — stop

- About to run `git rebase`, `git reset --hard`, or `git push --force`.
- About to run `gh pr merge`, or `gh pr merge --auto`.
- About to say "tests pass" without having run them in this session.
- About to open a PR with a lock still held by your worktree.
