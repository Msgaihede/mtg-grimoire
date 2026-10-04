# Workflow: subagents, worktrees, skills and docs

How work is organised in this repo: the user's preferences for agent workflows, the project
skills that own the worktree and shipping flow, the language-server rules, and how to keep the
docs honest. Moved out of the root [`CLAUDE.md`](../../CLAUDE.md) without changing the wording.
The root file keeps the one-line versions.

## Working style (user preferences)

- Ultracode/dynamic workflows for large parallelizable work; subagents use Opus 5.
- Superpowers flow: brainstorm → spec → plan → subagent-driven implementation.
- **Fan a feature out to parallel subagents rather than working it one step at a time.** Split it
  at the seams this repo already has — Rust command, TS domain logic, UI, stories, docs — and
  dispatch the independent pieces in a single message so they run at once. Serialize only what
  genuinely needs an earlier task's result. See `superpowers:dispatching-parallel-agents` and
  `superpowers:subagent-driven-development`.
- **Two subagents editing the same files in the same tree clobber each other.** Give each one
  files no sibling touches, or its own worktree (`superpowers:using-git-worktrees`) — and note
  that a worktree needs its own `npm install` before its suites pass.
- **Tests run once, at the end of a feature, to verify that it works — not after each change or inside subagents.**
  Running test suites after every intermediate edit causes high churn and wastes time repeatedly
  re-fixing transient states. Similarly, running tests inside subagents mid-fan-out tests against a tree
  its siblings are still modifying, and `npm run verify` is too slow to pay for N times.
  Instead: implement all changes for the feature first, have subagents report what they changed, and run
  `npm run verify` once centrally at the end to prove the completed feature works.
- **Commits match the size of a feature (one commit per feature).** Bundle all work for a feature
  (code, tests, and documentation) into a single atomic commit. Do not split a feature into multiple
  commits (such as a code commit followed by a docs or fix commit). Multiple commits per feature
  mess up our `release-please` changelog by producing duplicate or fragmented changelog items.
- **Ask through the `AskUserQuestion` tool, not in prose.** When you need more information or a
  decision between approaches, put it in the tool — the option cards are how he wants to answer.
  Keep the evidence with it: lead the question or an option's description with what was measured,
  and put your recommendation first, labelled. He can still write his own answer through "Other",
  and an answer that is not on the list is the point rather than scope creep.

## Project skills (`.claude/skills/`)

These skills carry the worktree and shipping workflow and are the authority on it — this
file does not repeat them:

- **`worktree-setup`** — the working rules for a second checkout: the base-branch check,
  what is not shared with the main checkout, and the shared stash stack. `npm install` is
  no longer a step here — `.claude/hooks/worktree-deps.sh` runs it at SessionStart, along
  with reporting the branch.
- **`running-the-app`** — **only one app and one Storybook can run across every worktree**,
  and both collisions are silent. Two locks in `locks/` under the git **common** dir
  (`D:/Code/mtg-grimoire/.git/locks` — a worktree's own `.git` is a file, not a
  directory), claimed and released through
  `.claude/skills/running-the-app/lock.ps1`. Ports stay 1420/6006/9222; they are hardcoded
  in tracked files and must not be remapped.
- **`shipping-a-branch`** — `npm run verify` → PR → merge `main` in (never rebase) →
  wait for `ci-ok`. The agent does not press Merge.
- **`auto-pr`** — the same trip when eight to ten agents are shipping at once and every
  merge into main knocks the other PRs to `BEHIND`. Arms auto-merge, then watches for the
  only two states GitHub abandons: a real conflict and a red `ci-ok`. Carries
  `pr-auto.ps1`.

## Language-server rules (`.claude/rules/`)

**Two rules load by file *extension* rather than by directory, and sit in `.claude/rules/`.**
They cover the language servers, which are active for every `.rs` and `.ts`/`.tsx` file with no
setup — [`rust-lsp.md`](../../.claude/rules/rust-lsp.md) and
[`typescript-lsp.md`](../../.claude/rules/typescript-lsp.md). Read them for when to prefer the `LSP`
tool over grep, and for the traps each server has: **TypeScript's `findReferences` silently
under-reports until a file is loaded** — one measured call said a live symbol had a single
reference — and rust-analyzer's cold start reports "not on a symbol" when it means "not indexed
yet". Both are answers that look right and are not.

## Keeping the docs honest

- **A prose-only edit routes to neither CI job, so nothing goes red when a document rots.** Counts
  and lists in these files (fault lists, test-case counts) have each drifted at least once —
  re-count in the same commit that changes one. **Better still, do not write down a number a build
  already answers**: the Storybook story and plays totals were deleted on 2026-08-14 after
  conflicting on five consecutive merges of `main`, because a count is a fact about a *tree* and
  every open branch has a different one.
- **New reference doc?** Add its row to [`docs/reference/README.md`](../reference/README.md), the
  reference index. It used to be a table in the root `CLAUDE.md` (older plans still say so).
- **New agent doc?** Put it in `docs/agent/` and link it from the root `CLAUDE.md`'s contents.
