# MTG Grimoire

Portable Windows desktop app for tracking a Magic: The Gathering collection.
Tauri 2.11 (Rust core) + React 19 + TypeScript 6. Single local user, SQLite storage.

**Scryfall is the card data and the only dependency the app needs to work.** Two price feeds
join it — Card Kingdom's and Mana Pool's public bulk pricelists — and both are optional by
construction: nothing downloads until a reader selects that marketplace, and a feed that never
answers costs em dashes rather than a broken app. Card trader is deliberately absent; its API
needs a per-user JWT and publishes no bulk download.

**Scryfall's two Tagger datasets are further bulk downloads from the same source, and optional
the same way.** **Oracle Tags** say what a card _does_ (`removal`, `ramp`, `recursion`), which is
what a deck add is filed by; a database that has never fetched them files by card type instead,
and that fallback is the floor rather than an error. **Art Tags** say what an illustration
_shows_ (`forest`, `dragon`, `dog`), which is what the Tags page browses by; a database that
has never fetched them has a Tags page that says so and still answers from the oracle side.
~5.85 MB and ~12.5 MB — [the oracle research](docs/superpowers/research/2026-08-14-scryfall-oracle-tags.md)
and [the art one](docs/superpowers/research/2026-08-20-scryfall-art-tags.md).

**Both files regenerate _daily_; _weekly_ is this app's refresh interval, and the two must not be
blurred.** Scryfall's `docs/api/tags` says the bulk files are updated daily, and both `updated_at`
stamps were the previous day when checked on 2026-08-20. The week is
`tags::{oracle,art}::REFRESH_INTERVAL_SECS`, a choice this app made about how often to ask — so a
taxonomy up to seven days behind Scryfall is the design working, not a stale download.

## Commands

- `npm run tauri dev` — run the app (Vite HMR + Rust rebuild). Takes the `app` lock: only
  one app runs across every worktree. See the `running-the-app` skill.
- `npm run verify` — build + lint + Vitest + cargo test. **Run before every commit.**
- `npm run test` / `test:run` — frontend tests; `cargo test` in `src-tauri/` — Rust tests
- `npm run test:coverage` / `test:coverage:rust` — coverage. **The Rust one's number is not
  `cargo llvm-cov`'s**: that counts the inline `#[cfg(test)]` modules, where every line is
  covered by definition, and reads ~14 points high. See
  [test-coverage.md](docs/reference/test-coverage.md) before quoting either figure.
- `npm run storybook` / `build-storybook` — the component workbench

## Architecture

- **Rust owns data plumbing** (SQLite/FTS5, Scryfall sync, image cache). **TS owns domain
  logic** (deck validation, import/export parsing). Rust supplies _facts_; TS draws
  _conclusions_. Keep that boundary.
- Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md`
- Research (live-verified facts, incl. Scryfall breaking changes): `docs/superpowers/research/`
- Plans: `docs/superpowers/plans/` — execute in order, check off steps as you go.

## Where the rules live

This file is deliberately short. **The binding rules for an area sit in that area's own
`CLAUDE.md`**, which loads when you touch a file there. Read the one for what you are working
on — do not work from this page alone.

| File | Read it when you are working on |
| --- | --- |
| [`src-tauri/CLAUDE.md`](src-tauri/CLAUDE.md) | Anything Rust: schema and migrations, sync, Scryfall, images, deck storage, capabilities |
| [`src/CLAUDE.md`](src/CLAUDE.md) | Any UI. Carries the Storybook-MCP rule, the `frontend-design` skill, layers, card images |
| [`src/features/decks/CLAUDE.md`](src/features/decks/CLAUDE.md) | Deck validation, categories, the editor's views and drags |
| [`src/features/transfer/CLAUDE.md`](src/features/transfer/CLAUDE.md) | Decklist import and export — parsing, planning, the two dialogs |
| [`.storybook/CLAUDE.md`](.storybook/CLAUDE.md) | Stories, the fake, seeds and faults |
| [`.github/CLAUDE.md`](.github/CLAUDE.md) | Workflows, the `changes` router, release-please |

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

## Reference docs

The long-form record — every measurement, with the date and the build it was taken on. Linked
from the `CLAUDE.md` that governs each area; read one when you need the _why_ behind a rule or a
number to compare against.

| Doc | Holds |
| --- | --- |
| [data-and-sync.md](docs/reference/data-and-sync.md) | Data dir, sync timings, the schema ladder, every search-performance measurement |
| [scryfall.md](docs/reference/scryfall.md) | Rate limits, the penalty, bulk data, `error_log`, pre-warm keys |
| [the price-feed research](docs/superpowers/research/2026-08-12-card-kingdom-mana-pool-price-feeds.md) | Both feeds measured live — sizes, key collisions, the NM-vs-cheapest trap |
| [image-cache.md](docs/reference/image-cache.md) | Cache layout, concurrency, placeholders, the `/cover/` route |
| [search-faceting.md](docs/reference/search-faceting.md) | The in-memory index, and why faceting fails open |
| [tag-search-syntax.md](docs/reference/tag-search-syntax.md) | Scryfall tagger syntax in the search box — the keywords, why resolution is exact, and the two failures that fail closed |
| [in-app-updates.md](docs/reference/in-app-updates.md) | Why the portable swap is hand-written |
| [decks-storage.md](docs/reference/decks-storage.md) | Deck tables, the card commands, the allocator, the audit log, the decklist import |
| [import-export.md](docs/reference/import-export.md) | The seven formats, the field registry, the fold rule, the four import destinations |
| [decks-live-findings.md](docs/reference/decks-live-findings.md) | What driving the shipped window found — **including the bugs still open** |
| [tags-live-findings.md](docs/reference/tags-live-findings.md) | The Tags page in the shipped window — the art ingest timed, both performance gates settled, and the bugs still open |
| [frontend-design.md](docs/reference/frontend-design.md) | The ribbon, card images, foil, layers, tables |
| [motion.md](docs/reference/motion.md) | `motion@13.1.0` — the timing scale, reduced motion, and **two forbidden APIs** |
| [storybook.md](docs/reference/storybook.md) | The workbench and its fake, in full |
| [live-ui-verification.md](docs/reference/live-ui-verification.md) | The CDP harness contract — `scripts/cdp.mjs` and its traps |
| [tauri-mcp-bridge.md](docs/reference/tauri-mcp-bridge.md) | The other way to drive the window — its four pieces, three permissions, and the one tool that cannot reach an app command |
| [ci-and-releases.md](docs/reference/ci-and-releases.md) | Both workflows, in full |
| [test-coverage.md](docs/reference/test-coverage.md) | What both suites reach, and why the Rust figure needs a correction |

## Running and verifying

- **Verify UI in the real app, not just in tests.** Every UI task in Plans 2–3 found something
  the suite could not. Drive the real window over CDP —
  [live-ui-verification.md](docs/reference/live-ui-verification.md) is the contract, and it
  documents traps that have each cost a session.
- **Under `tauri dev` the database is `src-tauri/target/debug/data/mtg.db`** — not
  `src-tauri/data/`. Delete that `data/` folder to force a clean first-run sync.
- **A built app embeds `dist/` at compile time, so a frontend-only edit does not reach a
  `tauri build` binary.** Vite writes a new bundle, cargo then sees no Rust source change and
  leaves the old bundle inside the old exe — exiting 0. `touch src-tauri/src/main.rs` first, and
  stop the app before rebuilding or the link fails with `Access is denied. (os error 5)`.
  `npm run tauri dev` does not have this problem, which is why it is the command above.
- **A portable copy exits silently if any other instance is running** —
  `tauri-plugin-single-instance` gives it exit code 0, no window and no stderr, and a dev build
  counts.
- **Every measured claim in this repo was measured on Windows. Nobody has run a Linux build.**
  Name the build (debug or release) in any figure you add; the same measurement can differ by ~8×.

## Global rules

- Work on `main`, commit small after each task/step with `feat:`/`fix:`/`chore:`/`test:`.
- Tests: cover logic that can break (parsers, validation, sync). No ceremony tests.
- **Never install `@types/node`** — it leaks Node types into the app program and retypes
  `setTimeout`. Its absence is the only fence; see [`.storybook/CLAUDE.md`](.storybook/CLAUDE.md).
- npm `xlsx` is banned (CVEs). TypeScript stays on 6.0.x until TS 7.1.
- **Adding a dependency with permissions means adding its narrowest permission, never its
  `:default`.**
- **`data/` is the user's and is never committed.** When seeding fixtures, seed **user tables
  only** — `cards` and `sync_meta` belong to the sync, and a hand-written row in either makes
  every later measurement a fiction. Delete every seeded row afterwards.
- **A prose-only edit routes to neither CI job, so nothing goes red when a document rots.** Counts
  and lists in these files (fault lists, test-case counts) have each drifted at least once —
  re-count in the same commit that changes one. **Better still, do not write down a number a build
  already answers**: the Storybook story and plays totals were deleted on 2026-08-14 after
  conflicting on five consecutive merges of `main`, because a count is a fact about a *tree* and
  every open branch has a different one.

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
- **Tests run once, at the end, after fan-in — not inside each subagent.** A subagent's slice
  compiles against a tree its siblings are still changing, so a suite run mid-fan-out fails for
  reasons that are not its own, and `npm run verify` is too slow to pay for N times. Have each
  one report what it changed, then run `npm run verify` yourself before the commit.
- **Ask through the `AskUserQuestion` tool, not in prose.** When you need more information or a
  decision between approaches, put it in the tool — the option cards are how he wants to answer.
  Keep the evidence with it: lead the question or an option's description with what was measured,
  and put your recommendation first, labelled. He can still write his own answer through "Other",
  and an answer that is not on the list is the point rather than scope creep.
