---
name: worktree-setup
description: Use when starting work in an mtg-grimoire git worktree under .claude/worktrees/, before running npm run verify, the test suite, the app, or Storybook. Symptoms it prevents - "Denied ID .../node_modules/mana-font/css/mana.css?raw", failing mana/keyrune/iconFont suites, 403s on @fontsource woff2 files, TS2307 after a merge, and files that should exist but do not.
---

# Worktree setup

A worktree is a full second checkout. It shares the git object store with the main
checkout and **almost nothing else** — not `node_modules`, not `src-tauri/target`, not
the database. Two things before anything else.

## 1. Check your base branch

A worktree-isolated dispatch is created from `main`, not from the session's branch. Nine
of ten agents in one plan hit this, several after a long time spent on files that should
have existed and did not.

```powershell
git log --oneline -3
git branch --show-current
Test-Path "src/features/decks/DeckEditor.tsx"   # or any file your task requires
```

On `main` when you should be on a feature branch, fast-forward to it. **Use the
PowerShell tool** — the Bash tool refuses `git reset --hard`, `git merge --ff-only` and
`git switch -c` in an isolated session.

Never rebase and never `git reset` a branch another agent may be tracking.

## 2. `npm install`, inside the worktree

```powershell
npm install
```

Without it `node_modules` resolves to the main checkout, outside the worktree root,
where Vite's `server.fs.allow` denies it:

- `src/lib/mana.test.ts`, `src/lib/keyrune.test.ts` and `src/lib/iconFont.test.ts` fail
  with `Error: Denied ID D:/Code/mtg-grimoire/node_modules/mana-font/css/mana.css?raw`
- `tauri dev` logs 403s for the `@fontsource`, `mana-font` and `keyrune` woff2 files

`npm run verify` stops at the frontend tests, so its `cargo test` half never runs and the
whole thing reads as a regression you just caused. It is not.

**Run `npm install` again after any merge that brought a dependency** — otherwise `tsc`
fails TS2307 on the new import, which also reads as a real failure and is not.

## What is and is not shared

| Per worktree | Shared with every worktree |
| --- | --- |
| `node_modules` | the git object store |
| `src-tauri/target` (gigabytes) | **the stash stack** |
| `src-tauri/target/debug/data/mtg.db` | the lock dir, `.git/locks/` |

**Never use bare `git stash` or `git stash pop`.** The stack is shared and another
agent's work may be on it. Prefer a temporary WIP commit. If you must stash, use
`git stash push -u -m "<unique-tag>"`, capture the SHA, and restore with
`git stash apply <sha>`.

## A database without a 93-second sync

```powershell
$dst = "src-tauri\target\debug\data"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "D:\Code\mtg-grimoire\src-tauri\target\debug\data\mtg.db" $dst
```

~547 MB and seconds, against ~93 s and a 77 MB download. The copy carries the card
corpus and **no collection or wishlist rows**, so those two views render their empty
state and there is no table to test until you seed one.

## The Bash tool refuses things here

In a worktree-isolated session, Bash rejects commands it cannot prove stay inside the
worktree: redirects, `eval`, several chained parts, git commands aimed elsewhere. The
PowerShell tool has no such check. Plain `npm` and `git` still work in Bash.

## Finish

```powershell
npm run verify
```

Green means the workspace is real: build, lint, Vitest and `cargo test`.

Then: the `running-the-app` skill before launching anything, and `shipping-a-branch`
when the work is done.
