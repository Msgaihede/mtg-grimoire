---
name: worktree-setup
description: Use when starting work in an mtg-grimoire git worktree under .claude/worktrees/, before running npm run verify, the test suite, the app, or Storybook. Symptoms it prevents - "Denied ID .../node_modules/mana-font/css/mana.css?raw", failing mana/keyrune/iconFont suites, 403s on @fontsource woff2 files, TS2307 after a merge, and files that should exist but do not.
---

# Worktree setup

A worktree is a full second checkout. It shares the git object store with the main
checkout and **almost nothing else** — not `node_modules`, not `src-tauri/target`, not
the database.

**Dependencies and the branch are a hook now** — `.claude/hooks/worktree-deps.sh` at
SessionStart. It reports both and installs when `node_modules` is missing or older than
`package-lock.json`. **If you did not see that report, run `npm install` yourself before
any test, build or app command**, or three suites fail on Vite's `server.fs.allow` and
`npm run verify` never reaches `cargo test` — failures that are not yours.

## When the branch is wrong

A worktree-isolated dispatch is created from `main`, not the session's branch — nine of
ten agents in one plan hit this, several after long stretches on files that should have
existed and did not. Fast-forward to the branch your task belongs to, with the
**PowerShell tool**: Bash refuses `git reset --hard`, `git merge --ff-only` and
`git switch -c` here. Never rebase, and never `git reset` a branch another agent tracks.

## What is and is not shared

| Per worktree | Shared with every worktree |
| --- | --- |
| `node_modules` | the git object store |
| `src-tauri/target` (gigabytes) | **the stash stack** |
| `src-tauri/target/debug/data/` — db **and** image cache | the lock dir, `<git common dir>/locks` |

A worktree's `.git` is a **file**, not a directory, so `ls .git/locks` fails here. The
common dir is what every worktree shares:
`git rev-parse --path-format=absolute --git-common-dir` answers it from anywhere, and on
this machine that is `D:/Code/mtg-grimoire/.git`.

**Never use bare `git stash` or `git stash pop`.** The stack is shared and another
agent's work may be on it. Prefer a temporary WIP commit. If you must stash, use
`git stash push -u -m "<unique-tag>"`, capture the SHA, and restore with
`git stash apply <sha>`.

## The Bash tool refuses things here

In a worktree-isolated session, Bash rejects commands it cannot prove stay inside the
worktree: redirects, `eval`, several chained parts, git commands aimed elsewhere. The
PowerShell tool has no such check. Plain `npm` and `git` still work in Bash.

## Finish

`npm run verify` green means the workspace is real: build, lint, Vitest and `cargo test`.

Then, in order:

- **Running the app, Storybook or a CDP pass** → the `running-the-app` skill first. Both
  locks are shared across every worktree and both collisions are silent.
- **Running against real data** rather than an empty wall → `live-data.md`, beside this
  file. Copying `src-tauri/target/debug/data` beats a 93-second sync, but only the whole
  folder works and only with the app stopped.
- **Work finished** → the `shipping-a-branch` skill.
