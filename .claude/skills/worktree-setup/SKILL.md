---
name: worktree-setup
description: Use when starting work in an mtg-grimoire git worktree under .claude/worktrees/, before running pnpm verify, the test suite, the app, or Storybook. Symptoms it prevents - "Denied ID .../node_modules/mana-font/css/mana.css?raw", failing mana/keyrune/iconFont suites, 403s on @fontsource woff2 files, TS2307 after a merge, and files that should exist but do not.
---

# Worktree setup

A worktree is a full second checkout. It shares the git object store with the main
checkout and **almost nothing else** — not `node_modules`, not `target`, not
the database.

**Dependencies and the branch are a hook now** — `.claude/hooks/worktree-deps.sh` at
SessionStart. It reports both and installs when `node_modules` is missing or older than
`pnpm-lock.yaml`, and deletes it first when it is npm's. **If you did not see that report,
run `pnpm install` yourself before any test, build or app command**, or nothing resolves
and `pnpm verify` never reaches `cargo test` — failures that are not yours.

**pnpm refuses to run on a tree a manifest has moved past.** With a `package.json` edited and not installed, `pnpm exec <anything>` and `pnpm <script>` exit 1 with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` and `Run "pnpm install"`, and change nothing (`verifyDepsBeforeRun: error` in `pnpm-workspace.yaml`; pnpm's own default would install and rewrite `pnpm-lock.yaml`). Put back an edit that was not meant to stay, or run `pnpm install` for one that was. It does **not** see a lockfile that moved by itself: after a merge that brings only `pnpm-lock.yaml`, commands run against the old tree until `pnpm install`.

**A worktree resolves more than it declares.** Node looks for a package in every folder above
a file, and a worktree sits under the main checkout: an import no manifest here declares can
resolve from `D:\Code\mtg-grimoire\node_modules` and fail in CI. `scripts/workspace.test.mjs`
is what holds "a package declares what it imports"; nothing that runs the code can.

## When the branch is wrong

A worktree-isolated dispatch is created from `main`, not the session's branch — nine of
ten agents in one plan hit this, several after long stretches on files that should have
existed and did not. Fast-forward to the branch your task belongs to, with the
**PowerShell tool**: Bash refuses `git reset --hard`, `git merge --ff-only` and
`git switch -c` here. Never rebase, and never `git reset` a branch another agent tracks.

## When cargo says the package "believes it's in a workspace when it's not"

The branch predates the cargo workspace (2026-10-02) and the main checkout has it. Cargo looks
for a workspace by walking up parent directories; a worktree sits under the main checkout, so
with no root `Cargo.toml` of its own the walk reaches the main checkout's, which does not list
this worktree's packages. **Merge `main`** — that brings the worktree its own root manifest and
every cargo command works again. If `src-tauri/Cargo.lock` conflicts in that merge, take the
root `Cargo.lock` and let cargo re-resolve.

For a worktree parked on an older commit on purpose (a release tag, a bisect), add an empty
`[workspace]` table to its `src-tauri/Cargo.toml` (`apps/desktop/src-tauri/Cargo.toml` from 2026-10-08 on) and do not commit it. **Never "fix" it by
adding `.claude` to the root manifest's `exclude`**: the worktree then builds into the main
checkout's `target` and its app opens the main checkout's dev database.

## What is and is not shared

| Per worktree | Shared with every worktree |
| --- | --- |
| `node_modules` | the git object store |
| `target` (gigabytes) | **the stash stack** |
| `target/debug/data/` — db **and** image cache | the lock dir, `<git common dir>/locks` |

pnpm's store (`D:\.pnpm-store`) is shared by every checkout on the drive: a worktree's
`node_modules` is links into it, and an install is seconds.

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
PowerShell tool has no such check. Plain `pnpm` and `git` still work in Bash.

## Finish

`pnpm verify` green means the workspace is real: build, lint, Vitest and `cargo test`.

Then, in order:

- **Running the app, Storybook or a CDP pass** → the `running-the-app` skill first. Both
  locks are shared across every worktree and both collisions are silent.
- **Running against real data** rather than an empty wall → `live-data.md`, beside this
  file. Copying `target/debug/data` beats a 93-second sync, but only the whole
  folder works and only with the app stopped.
- **Work finished** → verify, commit the feature, push branch, and open PR.
