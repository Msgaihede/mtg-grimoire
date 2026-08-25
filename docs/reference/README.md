# Reference docs

The long-form record behind the rules in the repo's `CLAUDE.md` files: measurements, the traps
that produced each rule, and the sessions that found them. Every figure keeps the date it was
taken and the build (debug or release) it was taken on.

These pages are **reference, not instruction** — the binding rules live in the `CLAUDE.md` for
each area, which links here for the _why_. Read a page when you need the reasoning behind a rule
or a number to compare a new measurement against.

| Doc | Holds | Governed by |
| --- | --- | --- |
| [data-and-sync.md](data-and-sync.md) | Data dir, sync timings, the schema ladder, every search-performance measurement | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [scryfall.md](scryfall.md) | Rate limits, the penalty, bulk data, `error_log`, pre-warm keys | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [image-cache.md](image-cache.md) | Cache layout, concurrency, placeholders, the `/cover/` route | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [search-faceting.md](search-faceting.md) | The in-memory index, and why faceting fails open | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [in-app-updates.md](in-app-updates.md) | Why the portable swap is hand-written | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [decks-storage.md](decks-storage.md) | Deck tables, the card commands, how owned/missing is answered, the audit log, the decklist import | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [wishlist-folders.md](wishlist-folders.md) | The wishlist's cabinet (v23) — the two folder tables, the four-term grain, the merge rule, the root-add duplicate and the `elsewhere` mark | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [collection-folders.md](collection-folders.md) | The collection's cabinet (v24–v25) — the eleventh grain term, the deck groups and `Recently removed` that made it the ledger of where every card sits, the conversion that filled them, and what a zero quantity now costs | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [import-export.md](import-export.md) | The seven formats, the field registry, the fold rule, the four import destinations | [`src/features/transfer/CLAUDE.md`](../../src/features/transfer/CLAUDE.md) |
| [text-mirror.md](text-mirror.md) | The plain-text mirror — the layout, the dirty map, why the pruner reads a manifest instead of guessing, the measured cost of a pass, **and the bugs still open** | [`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) |
| [decks-live-findings.md](decks-live-findings.md) | What driving the shipped window found — **including the bugs still open** | [`src/features/decks/CLAUDE.md`](../../src/features/decks/CLAUDE.md) |
| [tags-live-findings.md](tags-live-findings.md) | The Tags page in the shipped window — the art ingest timed, both performance gates settled, **and what is still open** | [`src/CLAUDE.md`](../../src/CLAUDE.md) |
| [tag-search-syntax.md](tag-search-syntax.md) | Scryfall tagger syntax in the search box — the keywords, why resolution is exact, and the two failures that fail closed | [`src/CLAUDE.md`](../../src/CLAUDE.md) |
| [frontend-design.md](frontend-design.md) | The ribbon, card images, foil, layers, tables | [`src/CLAUDE.md`](../../src/CLAUDE.md) |
| [motion.md](motion.md) | `motion@13.1.0` — the timing scale, reduced motion, and **two forbidden APIs** | [`src/CLAUDE.md`](../../src/CLAUDE.md) |
| [storybook.md](storybook.md) | The workbench and its fake, in full | [`.storybook/CLAUDE.md`](../../.storybook/CLAUDE.md) |
| [live-ui-verification.md](live-ui-verification.md) | The CDP harness contract — `scripts/cdp.mjs` and its traps | [`src/CLAUDE.md`](../../src/CLAUDE.md) |
| [tauri-mcp-bridge.md](tauri-mcp-bridge.md) | The other way to drive the window — its four pieces, three permissions, and the one tool that cannot reach an app command | [`CLAUDE.md`](../../CLAUDE.md) |
| [ci-and-releases.md](ci-and-releases.md) | Both workflows, in full | [`.github/CLAUDE.md`](../../.github/CLAUDE.md) |
| [test-coverage.md](test-coverage.md) | What both suites reach, and why the Rust figure needs a correction | [`CLAUDE.md`](../../CLAUDE.md) |

`docs/superpowers/` is a different thing and stays where it is: the brainstorm → spec → plan
flow, plus the research notes those plans were built on.
