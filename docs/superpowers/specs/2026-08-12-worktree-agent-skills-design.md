# Project skills for working in a worktree

**Date:** 2026-08-12
**Status:** approved design, not yet implemented

Three project skills under `.claude/skills/`, so that an agent dropped into a fresh
worktree can set the workspace up, run the real app without silently destroying another
agent's session, and get its work onto `main` through a pull request.

## Why this exists

The repository has 24 worktrees. Agents work in them in parallel, and three things go
wrong today that nothing written down prevents:

1. A fresh worktree has no `node_modules`, and the resulting failure reads like a
   regression the agent just caused.
2. Two agents that both launch the app do not both get an app. The second gets **exit
   code 0, no window and no stderr**, because `tauri-plugin-single-instance` is registered
   before every other plugin (`src-tauri/src/lib.rs:203`) and both worktrees build the same
   `com.mtggrimoire.app` identifier. CLAUDE.md records this measured on 2026-08-09, and
   notes that a debug build from `target/debug` counts.
3. There is no written contract for finishing: verify, PR, conflicts, which check to wait
   on, and who presses Merge.

## What was decided, and what was rejected

**Ports are not remapped.** The first design derived a port block per worktree. It was
rejected: two app copies cannot run regardless of ports, and remapping is worse than
useless because the numbers are baked into tracked files. `tauri.conf.json`'s `devCsp`
hardcodes `ws://localhost:1420` and `http://localhost:1420`; `.mcp.json` hardcodes
`http://localhost:6006/mcp`. Both are tracked, so a per-worktree port is a dirty tracked
file that rides into a pull request. **1420, 6006 and 9222 stay as they are**, and
contention is resolved by serialising rather than by separating.

**Two locks, not one.** Storybook (6006, plus the `mtg-grimoire-sb-mcp` server pointed at
it) collides independently of the app (1420, CDP 9222, and the single-instance guard). One
lock would serialise an agent doing component work against an agent doing a live CDP pass,
which never actually conflict. Locking only the app was rejected because the Storybook
failure is the quiet one: if agent B's Storybook lands on another port, B's MCP queries
answer from **A's** Storybook, and nothing on either side says so.

**The agent does not merge its own PR.** It takes the branch to green and stops.

**Merge, never rebase.** Every conflict resolution in this repository's history merges
`origin/main` into the branch (`d4f7281`, `39e1132`). A rebase strands any other agent
whose worktree tracks the branch.

## The lock home

`git rev-parse --path-format=absolute --git-common-dir` resolves to
`D:/Code/mtg-grimoire/.git` from the main checkout and from every worktree — verified
2026-08-12 from `.claude/worktrees/project-skills`. Locks live in `<that>/locks/`.

Two properties make it the right home: it is shared by every worktree by construction, and
it sits outside every worktree's working tree, so a lock file can never be committed by
accident.

### Lock file

`app.lock` and `storybook.lock`, each a JSON object:

```json
{
  "worktree": "D:\\Code\\mtg-grimoire\\.claude\\worktrees\\project-skills",
  "pid": 12345,
  "process": "mtg-grimoire",
  "what": "tauri dev",
  "since": "2026-08-12T10:31:00Z"
}
```

`pid` is the process the holder launched — the app, or the Storybook dev server — not the
agent. That is what makes staleness answerable: an agent that died leaving a live app has
correctly still got the lock, and an app that died leaving a lock file has not.

**Claiming is create-if-absent, atomically**:
`[System.IO.File]::Open($path, 'CreateNew', 'Write')` throws if the file exists. `New-Item
-ItemType File` without `-Force` is the shell-level equivalent. `-Force` must never be used
here — on a file it truncates, which would silently steal a live lock.

**Stale means the PID is dead, _or_ it is alive but is a different process.** The second
arm is there because Windows reuses PIDs: `Get-Process -Id <pid>` succeeding is not enough
on its own, which is what the `process` field is for. A lock is live only when both hold.
A stale lock is taken, and the agent says out loud that it took one.

**Held and alive means wait**, polling every 15 s for up to 5 minutes, then report to the
user. Never kill another agent's app.

**Release is two steps and both are mandatory: stop the process, then delete the lock.** On
success, on failure, and on abandonment. This is the step the design most needs agents to
actually perform, so it is stated in the skill as a precondition of being finished — an
agent that has not released is not done.

## Skill 1 — `worktree-setup`

Once per worktree, before tests, the app, Storybook or `npm run verify`.

- **Check the base branch first.** A worktree-isolated dispatch arrives on `main`, not on
  the session's branch. Confirm by naming a file that must exist, and fast-forward through
  **PowerShell** — Bash refuses `git reset --hard`, `git merge --ff-only` and
  `git switch -c` in an isolated session.
- **`npm install` inside the worktree, before anything else.** Without it `node_modules`
  resolves to the main checkout, outside the worktree root, where Vite's `server.fs.allow`
  denies it: `mana.test.ts`, `keyrune.test.ts` and `iconFont.test.ts` fail with
  `Denied ID …/node_modules/mana-font/css/mana.css?raw`, and `tauri dev` 403s the
  `@fontsource`/`mana-font`/`keyrune` woff2 files. `npm run verify` stops at the frontend
  tests, so the `cargo` half never runs and the whole thing reads as a regression the agent
  just caused. Verified still true 2026-08-12: this worktree had no `node_modules`.
- **Per-worktree:** `node_modules`, `src-tauri/target`, and its own
  `src-tauri/target/debug/data/mtg.db`. **Shared:** the git object store and the **stash
  stack** — never bare `git stash`/`git stash pop`.
- Skip the sync by copying `mtg.db` from the main checkout (~547 MB, seconds, against ~93 s
  and a 77 MB download). The copy carries no collection or wishlist rows.
- The Bash tool refuses commands it cannot verify stay inside the worktree — anything with a
  redirect, an `eval`, or several chained parts. PowerShell has no such check.
- Finish with `npm run verify`.

## Skill 2 — `running-the-app`

Launching the app, Storybook, or a CDP pass. Named so the built-in `run` skill, which looks
for a project skill covering app launch before falling back to its own patterns, finds it.

- The ports and why they are not to be changed (above).
- Acquire the right lock, or wait. `app.lock` for `tauri dev`, the built exe, Vite 1420 and
  CDP 9222; `storybook.lock` for 6006 and the MCP server.
- **Launch**, with the traps already measured and recorded in CLAUDE.md:
  `npm run tauri build -- --debug --no-bundle`; `touch src-tauri/src/main.rs` first or a
  frontend-only edit does not reach the binary and the build still exits 0; `Stop-Process`
  before rebuilding or the link fails with `Access is denied. (os error 5)`; launch under
  `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"`.
- Drive `scripts/cdp.mjs` through **PowerShell**; wrap the JS in double quotes with single
  quotes inside, and avoid `$`.
- **Release: stop the process, then delete the lock.** Both, always.

The skill points at CLAUDE.md's "Verifying UI in the real app" for the harness vocabulary
rather than restating it. What it adds is the worktree and lock story.

## Skill 3 — `shipping-a-branch`

Work is complete and needs to reach `main`.

1. **Preconditions:** locks released, app stopped.
2. `npm run verify` green — the output, not an assertion that it passed.
3. Commit small, conventional prefixes (`feat:`/`fix:`/`chore:`/`test:`), because
   release-please reads them.
4. Push the branch; `gh pr create`.
5. `git fetch origin main` then `git merge origin/main` **into the branch**. Never rebase,
   never reset.
6. If the merge brought a new dependency, `npm install` again — otherwise `tsc` fails
   TS2307 on the new import and it reads as a real failure.
7. Re-run `npm run verify`, push.
8. Wait on **`ci-ok`** by name — it is the one protected check, and a green matrix leg
   proves nothing about the gate. `gh pr checks --watch`.
9. Report the PR URL and the `ci-ok` state, and **stop**. The user presses Merge.

One note carried so an agent does not misdiagnose it: a release-please PR opens in
`action_required` with **zero jobs** and needs approving before CI runs. That is GitHub's
recursion guard, not a broken workflow, and it is not this skill's PR.

## Testing

These are prose skills; there is nothing to unit-test. What is verifiable, and will be
checked before the PR:

- `git rev-parse --path-format=absolute --git-common-dir` returns the same absolute path
  from the main checkout and from a worktree. (Verified from a worktree 2026-08-12; the
  main-checkout half is still to be confirmed.)
- The lock claim is genuinely exclusive: a second `CreateNew` open against an existing lock
  throws.
- `npm run verify` is green in this worktree after `npm install`, which is also the first
  claim skill 1 makes.
- The three skills appear in the skill listing of a session started in this worktree.

## Out of scope

- Automating worktree creation or teardown.
- Any change to `vite.config.ts`, `tauri.conf.json` or `.mcp.json`. The design's whole
  point is that those files stay untouched.
- Merging pull requests.
