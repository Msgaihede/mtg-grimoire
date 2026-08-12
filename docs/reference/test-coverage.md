# Test coverage

What the suite actually reaches, how each figure is produced, and the three things that make a
naive reading of either number wrong.

**Measured 2026-08-12** on Windows 11, **debug builds both sides** — `vitest@4.1.10` with
`@vitest/coverage-v8@4.1.10`, `cargo-llvm-cov 0.8.7` on `rustc 1.96.0`. Nobody has measured
either side on Linux.

## The headline

| Side                    | Lines covered          | Over             | Tests            |
| ----------------------- | ---------------------- | ---------------- | ---------------- |
| Frontend — Vitest + v8  | **97.34%** (3777/3880) | 107 source files | 1769 in 91 files |
| Rust — `cargo llvm-cov` | **77.45%** (5811/7503) | 29 source files  | 549              |

Lines only, and deliberately: it is the one metric both sides report over a denominator this
document can describe exactly. The frontend's other three are 96.06% statements (4374/4553),
91.91% branches and 95.98% functions. The Rust side's are quoted further down, from a different
source that must not be mixed with this row.

**The two figures are not comparable to each other.** Different instrumenters, differently drawn
denominators, and the Rust one has had a correction applied that the frontend one does not need.

## Reproducing it

```
npm run test:coverage        # frontend; writes coverage/ and prints the table
npm run test:coverage:rust   # Rust; writes src-tauri/target/llvm-cov/coverage.lcov
```

The Rust side needs a one-time `cargo install cargo-llvm-cov` plus
`rustup component add llvm-tools-preview`. It is not part of `npm run verify` and not part of CI:
the instrumented rebuild is a full cold `cargo build` of the crate and its dependency tree, which
is minutes, against `cargo test`'s seconds on a warm target directory.

`node scripts/coverage-rust.mjs --report-only` re-prints the table from the last LCOV without
re-running anything.

## Frontend — what is in the denominator

`vite.config.ts` sets `coverage.include` to `src/**/*.{ts,tsx}` explicitly. **In Vitest 4 that
line is what makes an untested file count as 0% rather than disappear.** Vitest 4 removed
`coverage.all`, and with no `include` the report covers only the modules some test happened to
import — which flatters the figure by exactly the files nobody tested. With the line in place the
report holds **107 files, which is every source file under `src/`**, and none of them is at 0%.

Excluded, and why: `*.test.{ts,tsx}` and the two test-only helpers (`test-setup.ts`,
`test-drag.ts`); `*.stories.tsx`, because the Storybook workbench is not the product and counting
its coverage of itself would be circular; `vite-env.d.ts` (no statements) and `main.tsx` (a
`createRoot` call that only ever runs in a browser).

Stories still _run_ — `src/stories.test.tsx` composes every one of them and drives its `play` —
so the components they exercise are covered by them. Only the story files themselves are out.

**`--testTimeout=30000` is in the script for a reason.** v8 instrumentation slows the story plays
enough to cross the 5 s default: measured on the first run here,
`DeckEditor.stories.tsx > NeverTwoLayers` took **5898 ms** and failed, and a failed test aborts
report generation entirely — no `coverage/` directory is written at all. The uninstrumented
suite passes at the default timeout, so this is a coverage-run flag rather than a change to
`test:run`.

## Rust — the correction, and why it is needed

`cargo llvm-cov` runs `cargo test`, and `cargo test` compiles the crate with `--cfg test`. So
every `#[cfg(test)] mod tests` body is instrumented, and **every line of it is covered by
definition** — a test body that did not execute is a failing test, not a coverage gap. On this
crate those modules are the majority of the instrumented lines:

|                                  | Lines  | Covered    |
| -------------------------------- | ------ | ---------- |
| Everything llvm-cov instrumented | 20,716 | **91.43%** |
| Shipped code only                | 7,503  | **77.45%** |

**A 14-point gap, and the larger number is the one the tool prints by default.** llvm-cov cannot
drop the test modules on its own: `--ignore-filename-regex` is per _file_, and this crate's tests
live in the same files as the code they test. Nothing on stable Rust turns instrumentation off
for one module — `#[coverage(off)]` is nightly.

Both rows above are counted off the **LCOV export**, so they are the same denominator and the
subtraction between them is meaningful. `cargo llvm-cov --summary-only` prints a _third_ number
for the same run — **89.33% lines over 22,036**, alongside 88.25% regions and 72.01% functions —
because its table and the LCOV writer do not agree on what a countable line is. Nothing is wrong
with either; they are different metrics with the same name. **Quote one source or the other, and
never subtract across them.**

So `scripts/coverage-rust.mjs` reads the LCOV export back and splits each file at its first
column-0 `#[cfg(test)]`, counting only `DA:` records above it. That cut is safe here because in
all 28 files that carry the attribute it is the last item in the file (`main.rs`, the 29th, has
none and is left whole), and the single file with two of them — `index/mod.rs`, a
`pub(crate) mod fixtures` and then `mod tests` — has nothing but test code between them.

**Re-check that assumption if a `#[cfg(test)]` block ever appears mid-file**, with real code
below it: the script would silently drop that code from the denominator and the number would go
up for no reason.

### Per file, shipped code only

| File                 | All lines | Non-test    | Non-test lines |
| -------------------- | --------- | ----------- | -------------- |
| `index/bitset.rs`    | 100.00%   | **100.00%** | 42             |
| `ingest.rs`          | 99.78%    | **100.00%** | 103            |
| `legalities.rs`      | 99.08%    | **100.00%** | 27             |
| `sorting.rs`         | 100.00%   | **100.00%** | 23             |
| `schema.rs`          | 99.77%    | 99.35%      | 618            |
| `card_row.rs`        | 99.73%    | 99.24%      | 132            |
| `filters.rs`         | 99.16%    | 99.07%      | 108            |
| `index/mod.rs`       | 95.16%    | 97.73%      | 88             |
| `scryfall.rs`        | 98.17%    | 96.18%      | 340            |
| `db.rs`              | 97.77%    | 95.74%      | 47             |
| `index/facets.rs`    | 85.94%    | 93.81%      | 210            |
| `maintenance.rs`     | 97.91%    | 91.25%      | 80             |
| `reconcile.rs`       | 97.10%    | 91.01%      | 367            |
| `errors.rs`          | 96.79%    | 91.00%      | 100            |
| `search.rs`          | 98.83%    | 90.56%      | 180            |
| `index/lifecycle.rs` | 95.96%    | 89.87%      | 79             |
| `images.rs`          | 94.37%    | 85.12%      | 598            |
| `card.rs`            | 94.35%    | 81.98%      | 111            |
| `collection.rs`      | 94.52%    | 80.95%      | 399            |
| `deck.rs`            | 91.67%    | 80.91%      | 1278           |
| `deck_audit.rs`      | 98.13%    | 80.60%      | 67             |
| `wishlist.rs`        | 94.27%    | 75.32%      | 231            |
| `deck_theory.rs`     | 89.71%    | 73.80%      | 187            |
| `deck_meta.rs`       | 84.08%    | 71.96%      | 856            |
| `paths.rs`           | 85.71%    | 66.67%      | 30             |
| `update.rs`          | 74.07%    | **54.29%**  | 501            |
| `sync.rs`            | 55.57%    | **28.37%**  | 490            |
| `lib.rs`             | 19.92%    | **3.37%**   | 208            |
| `main.rs`            | 0.00%     | **0.00%**   | 3              |

Two files score _higher_ on shipped code than overall (`index/facets.rs`, `index/mod.rs`) — their
test modules contain lines no test reaches, which is what the correction is supposed to expose.

### Where the thin spots are, and which of them matter

- **`lib.rs` at 3.37%** and **`main.rs` at 0%** are the Tauri wiring: `run()`, the builder, the
  command registrations, the setup hook. None of it executes without a real window, so a unit
  test cannot reach it. This is the one gap that is _structural_ rather than owed — it is also
  the reason [live-ui-verification.md](live-ui-verification.md) exists and why CLAUDE.md insists
  UI work be driven through the shipped window.
- **`sync.rs` at 28.37%** and **`update.rs` at 54.29%** are the two real gaps. Both are dominated
  by network and filesystem paths — the bulk download, the ~80 s ingest, the portable
  self-replace — that the tests stub around rather than through. `update.rs` in particular is
  hand-written binary swapping (see [in-app-updates.md](in-app-updates.md)) whose failure mode is
  a user left with no exe.
- `deck_meta.rs` at 71.96% is the largest _ordinary_ gap by line count (856 lines).

## The frontend's thin spots

| File                                  | Lines  | Missed |
| ------------------------------------- | ------ | ------ |
| `src/lib/useUpdate.ts`                | 65.62% | 22     |
| `src/lib/useErrorLog.ts`              | 70.00% | 3      |
| `src/lib/trapTab.ts`                  | 83.33% | 3      |
| `src/features/decks/FolderTree.tsx`   | 87.21% | 17     |
| `src/features/search/SetCombobox.tsx` | 88.60% | 9      |

`useUpdate.ts` is the frontend half of the same updater that is thin on the Rust side, so the
in-app update path is the least-covered feature in the repo end to end.

## These numbers are hand-maintained

Nothing recomputes them. A prose-only edit routes to neither CI job, so **the figures in
[README.md](../../README.md) and in this file rot silently** — they are the exact shape of drift
the root `CLAUDE.md` warns about. Re-run both commands and update both files in the same commit
whenever the claim is being restated. Deliberately not wired into CI: the Rust run's cold
instrumented build is minutes, and a coverage _threshold_ on a repo this size buys a broken
build far more often than it buys a test.
