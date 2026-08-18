# All Printings Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace both destinations of the card menu's `View all printings` with one centred, filterable, scrollable modal — and make a press inside it set the deck's printing.

**Architecture:** A new `AllPrintingsDialog`, mounted once in `App.tsx` and driven by one store field, on the existing `DeckDialog` shell. It draws the printings through `CardGrid` — the same virtualised wall the search page uses — filtered client-side by a new pure module, and pressing a tile either swaps the deck slot (`deck_swap_printing`, via the hook the card pane already presses) or opens the card pane on that printing.

**Tech Stack:** React 19, TypeScript 6, Zustand, TanStack Query + Virtual, Tailwind, motion@13.1.0, Vitest + Testing Library, Storybook; Rust/Tauri 2.11 + rusqlite for the one backend change.

**Spec:** `docs/superpowers/specs/2026-08-18-all-printings-modal-design.md` — read it first; every task below argues from it.

## Global Constraints

- **`npm run verify` before every commit** (build + lint + Vitest + cargo test). It does **not** run `cargo fmt` or `cargo clippy`; CI does, and they are the only reds a green verify can still produce. Clippy caps function arguments at 7.
- **Never run two verifies at once** — concurrent runs fake ~18 Rust schema failures.
- **Never install `@types/node`.**
- **Card art is drawn with `components/CardArt` / `components/CardImage`, never a bare `<img>`.**
- **Z-indexes come from `LAYER` in `src/lib/layers.ts` and nowhere else**; `layers.test.ts` sweeps `src/` to enforce it.
- **Escape closes one layer per press**: an inner dismissible layer registers on `window` in the **capture** phase via `useDismissOnEscape`, and the rung is registered on the **open flag**, not on the panel's mount.
- **`src/lib/ipc.ts` is a hand-written mirror of the Rust structs** — nothing type-checks it against the crate. Change both ends in the same task.
- **TS owns domain logic, Rust supplies facts.** Filtering, ordering and captions are TypeScript's.
- **Adding a dependency with permissions means adding its narrowest permission, never its `:default`.** (No new dependencies are expected here.)
- Commit small, with `feat:` / `fix:` / `chore:` / `test:` prefixes.
- **If these tasks are fanned out to parallel subagents in one worktree:** each subagent writes its tests but does **not** run the suite — a slice compiles against a tree its siblings are still changing. The controller runs `npm run verify` once at fan-in. Sequential (subagent-driven) execution runs the tests per task as written below.

---

## File Structure

**Created**

| File                                               | Responsibility                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/features/card/printingFilters.ts`             | Pure: the filter shape, the predicate, and the option lists with their counts. No React.              |
| `src/features/card/printingFilters.test.ts`        | Its tests.                                                                                            |
| `src/features/card/PrintingsFilterBar.tsx`         | The modal's controls: text box, set picker, language picker, treatment chips, sort select, Clear all. |
| `src/features/card/AllPrintingsDialog.tsx`         | The modal: the query, the count line, the wall, and what a press means.                               |
| `src/features/card/AllPrintingsDialog.test.tsx`    | Its tests.                                                                                            |
| `src/features/card/AllPrintingsDialog.stories.tsx` | Its stories.                                                                                          |

**Modified**

| File                                   | Change                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src-tauri/src/card.rs`                | `list_printings` / `card_printings` take an optional limit, clamped to `MAX_PRINTINGS_HARD`.        |
| `src/lib/ipc.ts`                       | `cardPrintings` mirrors the argument.                                                               |
| `src/lib/cardZoom.ts`                  | New `"printings"` zoom section.                                                                     |
| `src/lib/store.ts`                     | `printingsRequest` / `openAllPrintings` / `closeAllPrintings` replace the `pendingCardSearch` trio. |
| `src/features/card/printings.ts`       | Gains `printingTarget`, moved out of the pane.                                                      |
| `src/features/card/cardMenu.tsx`       | Three deps become one; `printingsItem` re-points.                                                   |
| `src/features/card/useCardMenuDeps.ts` | Supplies `openAllPrintings` with `deck: null`.                                                      |
| `src/features/card/CardDetailPane.tsx` | Drops its `viewPrintingsInPane` / `paneCardId` override; imports `printingTarget`.                  |
| `src/features/decks/DeckEditor.tsx`    | Supplies the deck slot to `openAllPrintings`.                                                       |
| `src/features/search/useCardSearch.ts` | The oracle-card filter and its seed go.                                                             |
| `src/features/search/FilterBar.tsx`    | Its chip goes.                                                                                      |
| `src/App.tsx`                          | Mounts the dialog.                                                                                  |

---

### Task 1: The backend limit

**Files:**

- Modify: `src-tauri/src/card.rs` (`MAX_PRINTINGS` at :48, `list_printings` at :296, `card_printings` at :371)
- Test: `src-tauri/src/card.rs` — the inline `#[cfg(test)]` module

**Interfaces:**

- Consumes: nothing.
- Produces: `pub fn list_printings(conn: &Connection, oracle_id: &str, market: Marketplace, limit: Option<i64>) -> Result<PrintingsResponse, String>` and the command `card_printings(state, oracle_id: String, marketplace: Option<String>, limit: Option<i64>)`. Absent limit = 400; any limit is clamped into `1..=MAX_PRINTINGS_HARD` (1000).

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)]` module in `src-tauri/src/card.rs`, beside the current `MAX_PRINTINGS` truncation test. Follow that test's fixture helper for inserting rows.

```rust
/// A caller that asks for more than the default gets it — this is what the modal's filters
/// stand on. Filtering a truncated list draws an empty wall that looks like an answer.
#[test]
fn an_explicit_limit_widens_the_page() {
    let conn = test_db();
    for n in 0..MAX_PRINTINGS + 20 {
        insert_printing(&conn, "oracle-1", n);
    }
    let r = list_printings(&conn, "oracle-1", Marketplace::default(), Some(1000)).unwrap();
    assert_eq!(r.items.len(), MAX_PRINTINGS + 20, "the wider page is honoured");
    assert_eq!(r.total, MAX_PRINTINGS as i64 + 20, "the count is unchanged");
}

/// The ceiling is the fence, not the caller. A limit past it is clamped rather than obeyed,
/// so no caller can ask this query to walk the whole table.
#[test]
fn a_limit_past_the_ceiling_is_clamped() {
    let conn = test_db();
    for n in 0..MAX_PRINTINGS_HARD + 5 {
        insert_printing(&conn, "oracle-1", n);
    }
    let r = list_printings(&conn, "oracle-1", Marketplace::default(), Some(99_999)).unwrap();
    assert_eq!(r.items.len(), MAX_PRINTINGS_HARD, "clamped to the ceiling");
    assert_eq!(r.total, MAX_PRINTINGS_HARD as i64 + 5, "the count is still uncapped");
}

/// Absent is the pane's page, byte for byte. The pane must not change because the modal
/// arrived.
#[test]
fn no_limit_is_still_the_default_page() {
    let conn = test_db();
    for n in 0..MAX_PRINTINGS + 5 {
        insert_printing(&conn, "oracle-1", n);
    }
    let r = list_printings(&conn, "oracle-1", Marketplace::default(), None).unwrap();
    assert_eq!(r.items.len(), MAX_PRINTINGS);
}

/// Zero and negatives are a caller bug, not a request for an empty list — an empty page here
/// would read as "this card has no printings", which is the one thing it must never say.
#[test]
fn a_nonsense_limit_falls_back_to_the_default() {
    let conn = test_db();
    for n in 0..MAX_PRINTINGS + 5 {
        insert_printing(&conn, "oracle-1", n);
    }
    for bad in [Some(0), Some(-1)] {
        let r = list_printings(&conn, "oracle-1", Marketplace::default(), bad).unwrap();
        assert_eq!(r.items.len(), MAX_PRINTINGS, "{bad:?} falls back");
    }
}
```

If `test_db` / `insert_printing` are named differently in that module, use the existing helpers — do not add new ones.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml card::`
Expected: FAIL — `this function takes 3 arguments but 4 were supplied`, and `MAX_PRINTINGS_HARD` not found.

- [ ] **Step 3: Implement**

Beside `MAX_PRINTINGS` at `src-tauri/src/card.rs:48`:

```rust
/// The ceiling an explicit page size is clamped to — the modal's page, and the fence around it.
///
/// **Chosen against the measurement [`MAX_PRINTINGS`] already carries**: counting paper only,
/// exactly five oracle cards exceed 400, and they are the five basic lands — Forest at 862, then
/// Mountain 840, Swamp 832, Island 827, Plains 818. So 1000 clears the largest list in the corpus
/// with room to spare, and no card reaches it.
///
/// The modal needs the wider page for a reason the pane does not have: it **filters**, and a
/// filter over a truncated list lies. Narrowing to a set that fell outside the newest 400 would
/// draw an empty wall that reads as an answer rather than as a truncation.
const MAX_PRINTINGS_HARD: usize = 1000;

/// The page size for a request, from what the caller asked for.
///
/// Absent is [`MAX_PRINTINGS`] — the card pane's page, unchanged — and anything else is clamped
/// into `1..=MAX_PRINTINGS_HARD`. A zero or a negative is a caller bug rather than a request for
/// an empty list, and is answered with the default: an empty page here would be indistinguishable
/// from "this card has no printings", which is the one thing this list must never say by
/// accident.
fn page_size(limit: Option<i64>) -> i64 {
    match limit {
        Some(n) if n > 0 => n.min(MAX_PRINTINGS_HARD as i64),
        _ => MAX_PRINTINGS as i64,
    }
}
```

Then `list_printings` takes `limit: Option<i64>` as its fourth parameter and binds `page_size(limit)` in place of `MAX_PRINTINGS as i64` in its `query_map` params. Update its doc comment: the `LIMIT` is now the caller's, within the ceiling.

`card_printings` takes `limit: Option<i64>` after `marketplace` and passes it through. Its doc gains a line: absent is the card pane's 400; the printings modal asks for the ceiling because it filters.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml card::`
Expected: PASS, including the pre-existing truncation test.

- [ ] **Step 5: Format and lint**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml` then `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: clean. `card_printings` now takes 4 arguments, under clippy's cap of 7.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/card.rs
git commit -m "feat(card): let a printings request name its page size"
```

---

### Task 2: The TS mirror

**Files:**

- Modify: `src/lib/ipc.ts:2479-2480`
- Test: `src/lib/ipc.test.ts`

**Interfaces:**

- Consumes: Task 1's command signature.
- Produces: `ipc.cardPrintings(oracleId: string, marketplace: MarketplaceId, limit?: number): Promise<PrintingsResponse>`.

- [ ] **Step 1: Write the failing test**

In `src/lib/ipc.test.ts`, beside the existing `cardPrintings` test:

```ts
it("passes a page size through when one is asked for", async () => {
  await ipc.cardPrintings("oracle-1", "cardkingdom", 1000);
  expect(invoke).toHaveBeenCalledWith("card_printings", {
    oracleId: "oracle-1",
    marketplace: "cardkingdom",
    limit: 1000,
  });
});

it("sends no page size when none is asked for, so the pane's page is unchanged", async () => {
  await ipc.cardPrintings("oracle-1", "cardkingdom");
  expect(invoke).toHaveBeenCalledWith("card_printings", {
    oracleId: "oracle-1",
    marketplace: "cardkingdom",
    limit: undefined,
  });
});
```

Match the existing test's marketplace literal — read the neighbouring case rather than assuming `"cardkingdom"`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ipc.test.ts -t "page size"`
Expected: FAIL — the call is made without `limit`.

- [ ] **Step 3: Implement**

```ts
  /**
   * Every paper printing of one oracle card.
   *
   * `limit` is the page size, and **absent is the card pane's 400** — its query and its cache key
   * are unchanged by this argument existing. The printings modal names the backend's ceiling
   * instead, because it filters client-side and a filter over a truncated list lies: a set that
   * fell outside the newest 400 would draw an empty wall that reads as an answer. Clamped in
   * Rust (`MAX_PRINTINGS_HARD`), so a number here is a request rather than a promise.
   */
  cardPrintings: (oracleId: string, marketplace: MarketplaceId, limit?: number) =>
    invoke<PrintingsResponse>("card_printings", { oracleId, marketplace, limit }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(ipc): mirror the printings page size"
```

---

### Task 3: The filter module

**Files:**

- Create: `src/features/card/printingFilters.ts`
- Test: `src/features/card/printingFilters.test.ts`

**Interfaces:**

- Consumes: `Printing` from `@/lib/ipc`.
- Produces: `EMPTY_PRINTING_FILTER`, `PrintingFilter`, `Treatment`, `TREATMENTS`, `filterPrintings`, `setOptions`, `langOptions`, `treatmentOptions`, `isFilterActive`. Task 4/7 use all of them.

- [ ] **Step 1: Write the failing tests**

Create `src/features/card/printingFilters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Printing } from "@/lib/ipc";
import {
  EMPTY_PRINTING_FILTER,
  filterPrintings,
  isFilterActive,
  langOptions,
  setOptions,
  treatmentOptions,
  type PrintingFilter,
} from "./printingFilters";

/** One printing, with every field the filters read and sane defaults for the rest. */
function printing(over: Partial<Printing> = {}): Printing {
  return {
    id: "p1",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "233",
    releasedAt: "1993-08-05",
    rarity: "common",
    illustrationId: "i1",
    artist: "Christopher Rush",
    lang: "en",
    finishes: '["nonfoil"]',
    finishPrices: { nonfoil: null, foil: null, etched: null },
    promo: false,
    fullArt: false,
    frameEffects: null,
    borderColor: "black",
    layout: "normal",
    ...over,
  };
}

const all = (over: Partial<PrintingFilter> = {}) => ({ ...EMPTY_PRINTING_FILTER, ...over });

describe("filterPrintings", () => {
  it("passes everything through an empty filter", () => {
    const rows = [printing(), printing({ id: "p2", setCode: "leb" })];
    expect(filterPrintings(rows, EMPTY_PRINTING_FILTER)).toEqual(rows);
  });

  it("matches text against the set name, the set code, the number and the artist", () => {
    const rows = [
      printing({ id: "name", setName: "Ravnica: City of Guilds" }),
      printing({ id: "code", setName: null, setCode: "rav" }),
      printing({ id: "number", setName: null, setCode: "xxx", collectorNumber: "rav-7" }),
      printing({ id: "artist", setName: null, setCode: "xxx", artist: "Ravi Kumar" }),
      printing({ id: "miss", setName: "Alpha", setCode: "lea", artist: "Someone" }),
    ];
    const kept = filterPrintings(rows, all({ text: "rav" })).map((p) => p.id);
    expect(kept).toEqual(["name", "code", "number", "artist"]);
  });

  it("ignores case and surrounding whitespace in the text", () => {
    const rows = [printing({ setName: "Modern Horizons" })];
    expect(filterPrintings(rows, all({ text: "  MODERN  " }))).toHaveLength(1);
  });

  it("keeps only the chosen sets", () => {
    const rows = [printing({ id: "a", setCode: "lea" }), printing({ id: "b", setCode: "leb" })];
    expect(filterPrintings(rows, all({ sets: ["leb"] })).map((p) => p.id)).toEqual(["b"]);
  });

  it("keeps only the chosen languages", () => {
    const rows = [printing({ id: "en" }), printing({ id: "ja", lang: "ja" })];
    expect(filterPrintings(rows, all({ langs: ["ja"] })).map((p) => p.id)).toEqual(["ja"]);
  });

  it("reads a treatment off the field that carries it", () => {
    const rows = [
      printing({ id: "foil", finishes: '["nonfoil","foil"]' }),
      printing({ id: "etched", finishes: '["etched"]' }),
      printing({ id: "promo", promo: true }),
      printing({ id: "fullart", fullArt: true }),
      printing({ id: "borderless", borderColor: "borderless" }),
      printing({ id: "showcase", frameEffects: '["showcase"]' }),
      printing({ id: "extended", frameEffects: '["extendedart"]' }),
      printing({ id: "plain" }),
    ];
    const only = (t: string) =>
      filterPrintings(rows, all({ treatments: [t as never] })).map((p) => p.id);
    expect(only("foil")).toEqual(["foil"]);
    expect(only("etched")).toEqual(["etched"]);
    expect(only("promo")).toEqual(["promo"]);
    expect(only("fullart")).toEqual(["fullart"]);
    expect(only("borderless")).toEqual(["borderless"]);
    expect(only("showcase")).toEqual(["showcase"]);
    expect(only("extendedart")).toEqual(["extended"]);
  });

  it("ORs the treatments with each other and ANDs them with the rest", () => {
    const rows = [
      printing({ id: "promo-lea", promo: true, setCode: "lea" }),
      printing({ id: "fullart-leb", fullArt: true, setCode: "leb" }),
      printing({ id: "plain-lea", setCode: "lea" }),
    ];
    // Two treatments: either one qualifies a row.
    expect(
      filterPrintings(rows, all({ treatments: ["promo", "fullart"] })).map((p) => p.id),
    ).toEqual(["promo-lea", "fullart-leb"]);
    // A set narrows the same list further.
    expect(
      filterPrintings(rows, all({ treatments: ["promo", "fullart"], sets: ["lea"] })).map(
        (p) => p.id,
      ),
    ).toEqual(["promo-lea"]);
  });

  it("preserves the order it was given", () => {
    const rows = [printing({ id: "c" }), printing({ id: "a" }), printing({ id: "b" })];
    expect(filterPrintings(rows, all({ text: "alpha" })).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("narrows nothing on a malformed finishes or frameEffects string", () => {
    const rows = [printing({ id: "junk", finishes: "not json", frameEffects: "{" })];
    expect(filterPrintings(rows, all({ treatments: ["foil"] }))).toHaveLength(0);
    expect(filterPrintings(rows, EMPTY_PRINTING_FILTER)).toHaveLength(1);
  });
});

describe("the option lists", () => {
  it("counts sets and orders them by the printings' own order", () => {
    const rows = [
      printing({ setCode: "leb", setName: "Beta" }),
      printing({ setCode: "lea", setName: "Alpha" }),
      printing({ setCode: "leb", setName: "Beta" }),
    ];
    expect(setOptions(rows)).toEqual([
      { code: "leb", name: "Beta", count: 2 },
      { code: "lea", name: "Alpha", count: 1 },
    ]);
  });

  it("names a set by its code when no row carries its name", () => {
    expect(setOptions([printing({ setCode: "pmei", setName: null })])).toEqual([
      { code: "pmei", name: "PMEI", count: 1 },
    ]);
  });

  it("puts English first and the rest by count", () => {
    const rows = [
      printing({ lang: "ja" }),
      printing({ lang: "de" }),
      printing({ lang: "ja" }),
      printing({ lang: "en" }),
    ];
    expect(langOptions(rows).map((o) => o.lang)).toEqual(["en", "ja", "de"]);
  });

  it("counts every treatment, including the ones with none", () => {
    const rows = [printing({ promo: true }), printing({ fullArt: true }), printing()];
    const counts = Object.fromEntries(treatmentOptions(rows).map((o) => [o.id, o.count]));
    expect(counts.promo).toBe(1);
    expect(counts.fullart).toBe(1);
    expect(counts.showcase).toBe(0);
  });
});

describe("isFilterActive", () => {
  it("is false for the empty filter and true for any narrowed one", () => {
    expect(isFilterActive(EMPTY_PRINTING_FILTER)).toBe(false);
    expect(isFilterActive(all({ text: " " }))).toBe(false);
    expect(isFilterActive(all({ text: "a" }))).toBe(true);
    expect(isFilterActive(all({ sets: ["lea"] }))).toBe(true);
    expect(isFilterActive(all({ langs: ["ja"] }))).toBe(true);
    expect(isFilterActive(all({ treatments: ["promo"] }))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/card/printingFilters.test.ts`
Expected: FAIL — cannot resolve `./printingFilters`.

- [ ] **Step 3: Implement**

Create `src/features/card/printingFilters.ts`:

```ts
/**
 * How the printings modal narrows one card's list, and what its controls are built from.
 *
 * Here rather than in Rust because every rule below is a judgement about meaning — is a
 * `borderless` border colour a treatment? is an unnamed set its code? does English come first? —
 * and CLAUDE.md puts those in TypeScript. Rust hands over one row per paper printing, newest
 * first; every conclusion drawn from them is on this page.
 *
 * **Nothing here throws on a string it has never seen.** `finishes` and `frameEffects` are JSON
 * columns copied from Scryfall, and Scryfall adds frame effects without asking. An unknown value
 * simply matches no treatment, exactly as `DeckHistoryDialog`'s `auditBand` files an unknown audit
 * kind under "other" rather than dropping it: a filter that threw would take the whole wall down
 * over a cosmetic field.
 */
import type { Printing } from "@/lib/ipc";

/**
 * The seven treatments worth a chip.
 *
 * Each is a *different field*, which is why this is a hand-written list rather than a derivation:
 * `foil` and `etched` come out of the `finishes` array, `promo` and `fullArt` are booleans,
 * `borderless` is a border colour, and `showcase`/`extendedart` are members of `frameEffects`.
 * The chip's label is what a Magic player calls the thing, not what the column does.
 */
export const TREATMENTS = [
  { id: "foil", label: "Foil" },
  { id: "etched", label: "Etched" },
  { id: "promo", label: "Promo" },
  { id: "fullart", label: "Full art" },
  { id: "borderless", label: "Borderless" },
  { id: "showcase", label: "Showcase" },
  { id: "extendedart", label: "Extended art" },
] as const;

export type Treatment = (typeof TREATMENTS)[number]["id"];

/** What the modal's controls are, as one value. */
export interface PrintingFilter {
  /** Matched against the set name, the set code, the collector number and the artist. */
  text: string;
  /** Set codes, as `cards.set_code` stores them — lowercase. */
  sets: string[];
  /** Scryfall two-letter language codes. */
  langs: string[];
  /** ORed with each other, ANDed with everything else — see {@link filterPrintings}. */
  treatments: Treatment[];
}

/** Nothing narrowed. What the modal opens on, and what "Clear all" restores. */
export const EMPTY_PRINTING_FILTER: PrintingFilter = {
  text: "",
  sets: [],
  langs: [],
  treatments: [],
};

/** Whether anything is narrowed — what decides the count line's wording and the Clear control. */
export function isFilterActive(filter: PrintingFilter): boolean {
  return (
    filter.text.trim() !== "" ||
    filter.sets.length > 0 ||
    filter.langs.length > 0 ||
    filter.treatments.length > 0
  );
}

/**
 * The printings that survive every control, in the order they were given.
 *
 * **The order is the caller's and is never touched.** The modal hands over a list that has already
 * been through `buildPrintingGroups` for the reader's chosen sort, so a sort here would silently
 * override a decision made one component up.
 *
 * The four controls are ANDed; the treatments are ORed *among themselves*, which is the one
 * asymmetry and the one a reader expects: pressing Foil and Promo asks for the premium printings,
 * not for the printings that are both.
 */
export function filterPrintings(
  printings: readonly Printing[],
  filter: PrintingFilter,
): Printing[] {
  const needle = filter.text.trim().toLowerCase();
  const sets = new Set(filter.sets);
  const langs = new Set(filter.langs);
  return printings.filter((p) => {
    if (needle !== "" && !matchesText(p, needle)) return false;
    if (sets.size > 0 && !sets.has(p.setCode)) return false;
    if (langs.size > 0 && !langs.has(p.lang)) return false;
    if (filter.treatments.length > 0 && !filter.treatments.some((t) => hasTreatment(p, t))) {
      return false;
    }
    return true;
  });
}

/**
 * The four fields that differ between two printings of one card.
 *
 * The card's own `name` is deliberately absent: it is identical on every row of this list, so
 * matching it would either pass everything or nothing. The modal's placeholder says which four
 * these are, because a search box that silently ignores what you typed is worse than no box.
 */
function matchesText(p: Printing, needle: string): boolean {
  return (
    (p.setName?.toLowerCase().includes(needle) ?? false) ||
    p.setCode.toLowerCase().includes(needle) ||
    p.collectorNumber.toLowerCase().includes(needle) ||
    (p.artist?.toLowerCase().includes(needle) ?? false)
  );
}

/** Whether one printing carries one treatment. Total over every field it reads. */
function hasTreatment(p: Printing, treatment: Treatment): boolean {
  switch (treatment) {
    case "foil":
      return jsonList(p.finishes).includes("foil");
    case "etched":
      return jsonList(p.finishes).includes("etched");
    case "promo":
      return p.promo;
    case "fullart":
      return p.fullArt;
    // The border colour rather than a frame effect: Scryfall models a borderless card as
    // `border_color: "borderless"`, and `frame_effects` says nothing about it.
    case "borderless":
      return p.borderColor === "borderless";
    case "showcase":
      return jsonList(p.frameEffects).includes("showcase");
    case "extendedart":
      return jsonList(p.frameEffects).includes("extendedart");
  }
}

/**
 * A JSON string array as a list of strings — `[]` for null, for junk, and for a payload that
 * parsed into something that is not an array of strings.
 *
 * The columns are copied verbatim from Scryfall and are nullable; nothing between the bulk file
 * and here validates them. Answering `[]` is what makes an unreadable row simply match no
 * treatment instead of taking the wall down.
 */
function jsonList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** One row of the set picker: the code the filter sends, the word the reader reads, the count. */
export interface SetOption {
  code: string;
  name: string;
  count: number;
}

/**
 * The sets these printings are in, most-printings first, ties in first-seen order.
 *
 * Built from the rows rather than from `ipc.setsList`, which answers with ~1050 sets — roughly
 * 1040 of which hold no printing of this card. A picker whose options are mostly empty is a
 * picker a reader has to search to use.
 *
 * A set with no `setName` on any of its rows is named by its **upper-cased code**, which is
 * `groupBySet`'s fallback in `printings.ts` and for its reason: the column is nullable per row,
 * and a three-letter code is what a Magic player calls a set anyway. The first *non-null* name
 * wins, so one nameless row does not rename a fully named set.
 */
export function setOptions(printings: readonly Printing[]): SetOption[] {
  const byCode = new Map<string, { name: string | null; count: number }>();
  for (const p of printings) {
    const seen = byCode.get(p.setCode);
    if (seen) {
      seen.count += 1;
      seen.name ??= p.setName;
    } else {
      byCode.set(p.setCode, { name: p.setName, count: 1 });
    }
  }
  return [...byCode.entries()]
    .map(([code, { name, count }]) => ({ code, name: name ?? code.toUpperCase(), count }))
    .sort((a, b) => b.count - a.count);
}

/** One row of the language picker. */
export interface LangOption {
  lang: string;
  count: number;
}

/**
 * The languages these printings are in — **English first**, then the rest by count.
 *
 * English is pinned rather than counted into its place because it is the language the rest of the
 * app is in and the one a reader narrowing to "just the normal ones" is reaching for. On a heavily
 * reprinted card it is also not the largest group, so leaving it to the count would bury it.
 */
export function langOptions(printings: readonly Printing[]): LangOption[] {
  const counts = new Map<string, number>();
  for (const p of printings) counts.set(p.lang, (counts.get(p.lang) ?? 0) + 1);
  return [...counts.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => (a.lang === "en" ? -1 : b.lang === "en" ? 1 : b.count - a.count));
}

/** One treatment chip: what it is, what it says, and how many rows it would leave. */
export interface TreatmentOption {
  id: Treatment;
  label: string;
  count: number;
}

/**
 * Every treatment with its count, **including the ones at zero**.
 *
 * Zero-count options are kept and drawn disabled rather than dropped, which is `facets.ts`' rule:
 * an option that vanishes reads as a control that broke, where a greyed one reads as a fact about
 * this card. The row of chips is also a fixed shape that way, so it does not reflow as the reader
 * narrows.
 */
export function treatmentOptions(printings: readonly Printing[]): TreatmentOption[] {
  return TREATMENTS.map(({ id, label }) => ({
    id,
    label,
    count: printings.reduce((n, p) => n + (hasTreatment(p, id) ? 1 : 0), 0),
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/card/printingFilters.test.ts`
Expected: PASS. (Count the `it` blocks in the file above rather than trusting a number written beside them — a count is a fact about a tree, and this plan is not the tree.)

- [ ] **Step 5: Commit**

```bash
git add src/features/card/printingFilters.ts src/features/card/printingFilters.test.ts
git commit -m "feat(card): the printings filter rules"
```

---

### Task 4: The store channel

**Files:**

- Modify: `src/lib/store.ts:200-216` (the interface) and `:305-321` (the implementation)
- Modify: `src/lib/cardZoom.ts:68` and `:80-85`
- Test: wherever the store's coverage lives — `npx vitest run src/lib -t "printings"` after writing, and `src/lib/cardZoom.test.ts` for the new section

**Interfaces:**

- Consumes: `PaneDeckContext` (already in `store.ts`).
- Produces:
  - `printingsRequest: PrintingsRequest | null` where `interface PrintingsRequest { oracleId: string; name: string; deck: PaneDeckContext | null }`
  - `openAllPrintings: (request: PrintingsRequest) => void`
  - `closeAllPrintings: () => void`
  - `ZOOM_SECTIONS` gains `"printings"`.
- Removes: `pendingCardSearch`, `requestAllPrintings`, `consumePendingCardSearch`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/cardZoom.test.ts` — nothing new needed if `DEFAULT_SECTION_ZOOMS` is already swept against `ZOOM_SECTIONS` (it is, at `:171`); that sweep becomes the test. Add a store test file `src/lib/store.test.ts` if none exists, otherwise extend it:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./store";

const slot = {
  deckId: 4,
  categoryId: 9,
  categoryName: "Ramp",
  cardId: "card-1",
  variant: "live" as const,
  finish: null,
};

describe("openAllPrintings", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  it("records the request and the deck slot it was asked from", () => {
    useAppStore.getState().openAllPrintings({ oracleId: "o1", name: "Sol Ring", deck: slot });
    expect(useAppStore.getState().printingsRequest).toEqual({
      oracleId: "o1",
      name: "Sol Ring",
      deck: slot,
    });
  });

  /**
   * The whole of the change. `requestAllPrintings` used to write `activeView`,
   * `selectedCardId`, `paneDeckContext`, `openDeckId` and `returnToDeckId` in the same `set` —
   * so asking which printings a card had closed the deck you were building it into.
   */
  it("moves nothing else", () => {
    useAppStore.setState({ activeView: "decks", openDeckId: 4, selectedCardId: "card-1" });
    useAppStore.getState().openAllPrintings({ oracleId: "o1", name: "Sol Ring", deck: null });
    const s = useAppStore.getState();
    expect(s.activeView).toBe("decks");
    expect(s.openDeckId).toBe(4);
    expect(s.selectedCardId).toBe("card-1");
  });

  it("closes to null", () => {
    useAppStore.getState().openAllPrintings({ oracleId: "o1", name: "Sol Ring", deck: null });
    useAppStore.getState().closeAllPrintings();
    expect(useAppStore.getState().printingsRequest).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/store.test.ts`
Expected: FAIL — `openAllPrintings is not a function`.

- [ ] **Step 3: Implement**

In `src/lib/cardZoom.ts`, add the section and its default:

```ts
export const ZOOM_SECTIONS = ["search", "collection", "deckSearch", "deck", "printings"] as const;
```

```ts
export const DEFAULT_SECTION_ZOOMS: Readonly<Record<ZoomSection, number>> = {
  search: DEFAULT_ZOOM,
  collection: DEFAULT_ZOOM,
  deckSearch: DEFAULT_ZOOM,
  deck: DEFAULT_ZOOM,
  // The modal's wall. Its own key rather than the search's, for `ZOOM_SECTIONS`' own reason: the
  // modal opens *over* a wall the reader has already sized, and a ctrl+wheel inside it must not
  // resize the page underneath.
  printings: DEFAULT_ZOOM,
};
```

Extend `ZOOM_SECTIONS`' doc: it says "Four surfaces draw walls of cards" — make it five and name the modal.

In `src/lib/store.ts`, replace the `pendingCardSearch` block in the interface with:

```ts
  /**
   * The card a reader asked to see every printing of, and the deck slot they asked from.
   *
   * **One field, written by one action that touches nothing else.** What this replaced —
   * `pendingCardSearch` plus `requestAllPrintings` — moved the reader to the Search view and
   * cleared the open card and the open deck in the same `set`, so asking a question about a card
   * closed the deck it was being asked about. The modal is drawn over whatever is on screen, so
   * there is nothing to navigate and nothing to clear.
   *
   * `deck` is the slot a press writes to: non-null only where the surface that opened the menu is
   * a row of an open deck, and it is the same `PaneDeckContext` the card pane's swap is addressed
   * by — every one of the five parts of `DECK_CARD_GRAIN`, for the reason that type's own doc
   * gives. Null is "there is no deck to write to", and a press then opens the card pane instead.
   */
  printingsRequest: { oracleId: string; name: string; deck: PaneDeckContext | null } | null;
  /** Open the printings modal. Writes one field. */
  openAllPrintings: (request: {
    oracleId: string;
    name: string;
    deck: PaneDeckContext | null;
  }) => void;
  /** Close it. */
  closeAllPrintings: () => void;
```

and the implementation block with:

```ts
  printingsRequest: null,
  // One field. See the interface for why that is the whole point.
  openAllPrintings: (printingsRequest) => set({ printingsRequest }),
  closeAllPrintings: () => set({ printingsRequest: null }),
```

Delete `pendingCardSearch`, `requestAllPrintings` and `consumePendingCardSearch` from both blocks. Leave `returnToDeckId` and everything else untouched.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/store.test.ts src/lib/cardZoom.test.ts`
Expected: PASS. Other suites will now fail to compile — Tasks 5, 7, 8 and 9 fix them.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.ts src/lib/cardZoom.ts src/lib/store.test.ts
git commit -m "feat(store): one channel for the printings modal"
```

---

### Task 5: The menu deps collapse

**Files:**

- Modify: `src/features/card/printings.ts` (gains `printingTarget`)
- Modify: `src/features/card/cardMenu.tsx:91-111` (deps), `:207-273` (`printingsItem`)
- Modify: `src/features/card/useCardMenuDeps.ts:57`, `:126-145`
- Modify: `src/features/card/CardDetailPane.tsx:245-255` (delete the local `printingTarget`), `:278-310` (delete the override)
- Test: `src/features/card/cardMenu.test.tsx`

**Interfaces:**

- Consumes: Task 4's `openAllPrintings`.
- Produces: `CardMenuDeps.openAllPrintings: (t: { oracleId: string; name: string; deck: PaneDeckContext | null }) => void` — the only printings dep. `printingTarget(printing: Printing, card: { id: string; name: string; oracleId: string | null; typeLine: string | null }): CardMenuTarget` exported from `printings.ts`. `CardMenuDeps.printingsOracleId?: string | null` — the oracle id a surface is already listing, which greys the row.

- [ ] **Step 1: Write the failing tests**

Rewrite the four printings cases in `src/features/card/cardMenu.test.tsx`. Read the file's existing `deps()` helper and `find()` first; keep them.

```ts
it("opens the printings modal with no deck slot from a plain surface", () => {
  const openAllPrintings = vi.fn();
  const items = buildCardMenu(target(), { ...deps(), openAllPrintings });
  (find(items, "View all printings") as MenuAction).onSelect();
  expect(openAllPrintings).toHaveBeenCalledWith({
    oracleId: "oracle-1",
    name: "Sol Ring",
    deck: null,
  });
});

it("carries the deck slot the surface named", () => {
  const openAllPrintings = vi.fn();
  const slot = {
    deckId: 4,
    categoryId: 9,
    categoryName: "Ramp",
    cardId: "card-1",
    variant: "live" as const,
    finish: null,
  };
  const items = buildCardMenu(target(), { ...deps(), openAllPrintings, printingsDeck: slot });
  (find(items, "View all printings") as MenuAction).onSelect();
  expect(openAllPrintings).toHaveBeenCalledWith({
    oracleId: "oracle-1",
    name: "Sol Ring",
    deck: slot,
  });
});

it("disables View all printings for an orphan with no oracle id", () => {
  const items = buildCardMenu({ ...target(), oracleId: null }, deps());
  const item = find(items, "View all printings") as MenuAction;
  expect(item.disabled).toBe(true);
  expect(item.reason).toBe("this printing has left the card database");
});

/** Inside the modal itself the row would re-ask a question already on screen. */
it("greys the row on the surface that is already listing that card", () => {
  const items = buildCardMenu(target(), { ...deps(), printingsOracleId: "oracle-1" });
  const item = find(items, "View all printings") as MenuAction;
  expect(item.disabled).toBe(true);
  expect(item.reason).toBe("you are already looking at them");
});

/** A different oracle card in the same modal — a menu on some other card — still routes. */
it("stays live for a different card than the one being listed", () => {
  const openAllPrintings = vi.fn();
  const items = buildCardMenu(target(), {
    ...deps(),
    openAllPrintings,
    printingsOracleId: "oracle-2",
  });
  const item = find(items, "View all printings") as MenuAction;
  expect(item.disabled).toBeUndefined();
  item.onSelect();
  expect(openAllPrintings).toHaveBeenCalled();
});
```

Update the file's `deps()` helper: drop `viewPrintingsInPane`, `requestAllPrintings` and `paneCardId`; add `openAllPrintings: vi.fn()`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/card/cardMenu.test.tsx`
Expected: FAIL — the old deps no longer type-check and `printingsDeck` is unknown.

- [ ] **Step 3: Implement**

Move `printingTarget` out of `CardDetailPane.tsx` into `src/features/card/printings.ts`, widening its second parameter so both callers fit:

```ts
/**
 * One printings row as a card menu's target.
 *
 * **The card supplies what a printing cannot.** A `Printing` says what a piece of cardboard is —
 * set, number, finishes — and carries no name, no oracle id and no type line, because those are
 * facts about the *card*. Taking them off the card is the stronger answer rather than a
 * workaround; the type line in particular is what `autoCategoryFor` files a menu add by, and
 * omitting it would take the filing rule off a menu add that a drag of the same row still gets.
 *
 * Lives here rather than in either surface because two now build it — the card pane's list and
 * the printings modal — and a second copy is a second chance to drop a field silently.
 */
export function printingTarget(
  printing: Printing,
  card: { name: string; oracleId: string | null; typeLine: string | null },
): CardMenuTarget {
  return {
    cardId: printing.id,
    name: card.name,
    setCode: printing.setCode,
    collectorNumber: printing.collectorNumber,
    oracleId: card.oracleId,
    finishes: printing.finishes,
    typeLine: card.typeLine,
  };
}
```

`printings.ts` imports `type CardMenuTarget` from `./cardMenu`. In `CardDetailPane.tsx`, delete the local copy and import this one; its call site already passes a `CardDetail`, which is structurally compatible.

In `cardMenu.tsx`, replace the three deps with:

```ts
  /**
   * Open the printings modal for a card.
   *
   * One field where there were three (`viewPrintingsInPane`, `paneCardId`, `requestAllPrintings`).
   * The row used to route two ways — the Search view outside the deck editor, the docked card
   * pane inside it — and both were the same wish answered by moving the reader somewhere. The
   * modal is drawn over wherever they are, so there is one destination and no surface has to say
   * which one it wants.
   */
  openAllPrintings: (t: {
    oracleId: string;
    name: string;
    deck: PaneDeckContext | null;
  }) => void;
  /**
   * The deck slot this surface's rows belong to, or absent.
   *
   * Set only by a surface whose rows really are rows of an open deck — the deck editor's four
   * views. It is what makes a press in the modal a *swap* rather than a look. A search tile in the
   * editor's docked panel is not one of these, and says so by leaving this out.
   */
  printingsDeck?: PaneDeckContext | null;
  /**
   * The oracle card this surface is **already** listing every printing of, if it is.
   *
   * `paneCardId`'s replacement, one level up: the old field named a *printing* because the pane
   * showed one card at a time, and the modal shows the whole oracle card, so a different printing
   * of it is the same list. Only the modal sets it. Absent means "this surface is not a printings
   * list", which is true of every other one.
   */
  printingsOracleId?: string | null;
```

Import `type PaneDeckContext` from `@/lib/store`. Rewrite `printingsItem`:

```ts
/**
 * "View all printings" — one destination, and the two facts that can refuse it.
 *
 * **The first refusal is a fact about the card.** `oracleId` is nullable on `CardSummary`, which
 * is a fence around the type rather than a card anyone can find (0 of 116 590 live rows are null,
 * reversible printings included, because `card_row` falls back to `card_faces[0]`). With no oracle
 * id there is no list to open.
 *
 * **The second is a fact about the surface.** Inside the printings modal the row would ask for the
 * list the reader is looking at. This used to be `paneCardId` and used to be a *printing*
 * comparison; it is an oracle one now, because the modal lists the whole card and every tile in it
 * would otherwise offer to re-open the same modal.
 *
 * Both are greyed with a reason rather than hidden, which is this row's standing judgement: it is
 * on every card surface and on every other card of the surface it greys on, so an absent row would
 * read as a bug in the menu rather than as a fact about the card.
 */
function printingsItem(target: CardMenuTarget, deps: CardMenuDeps): MenuAction {
  const { oracleId } = target;
  const row = {
    kind: "action",
    id: "printings",
    label: "View all printings",
    Icon: Images,
  } as const;

  if (oracleId === null) {
    return {
      ...row,
      disabled: true,
      reason: "this printing has left the card database",
      onSelect: () => {},
    };
  }
  if (deps.printingsOracleId != null && deps.printingsOracleId === oracleId) {
    return {
      ...row,
      disabled: true,
      reason: "you are already looking at them",
      onSelect: () => {},
    };
  }
  return {
    ...row,
    onSelect: () =>
      deps.openAllPrintings({ oracleId, name: target.name, deck: deps.printingsDeck ?? null }),
  };
}
```

In `useCardMenuDeps.ts`, replace the `requestAllPrintings` selector and the two dep fields:

```ts
const openAllPrintings = useAppStore((s) => s.openAllPrintings);
```

```ts
      // No `printingsDeck` and no `printingsOracleId`: this is the object every *plain* card
      // surface uses — the search walls, the collection, the wishlist — and none of them is a
      // deck row or a printings list. The deck editor spreads its slot over this per card.
      openAllPrintings,
```

with `openAllPrintings` in the `useMemo` dependency array in place of `requestAllPrintings`.

In `CardDetailPane.tsx`, delete the `menuDeps` `useMemo` that overrides `viewPrintingsInPane` and `paneCardId` (`:302-310`) along with its doc comment, and use `deps` directly wherever `menuDeps` was passed. The `openDeckId` and `viewPrinting` selectors above it become unused — delete them too if nothing else in the file reads them (check: `viewPrinting` is also used by the swap's follow-through; keep whatever is still referenced).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/card/cardMenu.test.tsx src/features/card/printings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/card/cardMenu.tsx src/features/card/cardMenu.test.tsx src/features/card/useCardMenuDeps.ts src/features/card/printings.ts src/features/card/CardDetailPane.tsx
git commit -m "refactor(card): one menu dep for View all printings"
```

---

### Task 6: The filter bar

**Files:**

- Create: `src/features/card/PrintingsFilterBar.tsx`
- Test: covered by Task 7's `AllPrintingsDialog.test.tsx` — this component is drawn only there and has no state of its own

**Interfaces:**

- Consumes: Task 3's `PrintingFilter`, `SetOption`, `LangOption`, `TreatmentOption`, `isFilterActive`; `PRINTING_GROUP_BY_OPTIONS` / `PrintingGroupBy` from `./printings`; `ToggleChip` and `filterChipState` / `FILTER_UNAVAILABLE` from `@/components/FilterChips`; `FOCUS` from `@/lib/focus`.
- Produces: `<PrintingsFilterBar filter setOptions langOptions treatmentOptions sort onFilterChange onSortChange />`, a controlled component that owns no state.

- [ ] **Step 1: Write the component**

Create `src/features/card/PrintingsFilterBar.tsx`. It is presentational and fully controlled — every change is `onFilterChange(next)`.

```tsx
/**
 * The printings modal's controls: what to show, and in what order.
 *
 * **Fully controlled and stateless.** The modal owns the filter, because the filter is also what
 * the count line and the empty state are worded from and what `listKey` is built out of; a control
 * row holding its own copy would be a second truth about the same question.
 *
 * **Which controls are here is the spec's judgement rather than a survey of the fields.** Mana
 * value, colour, type and legality are identical on every printing of one card — a filter for them
 * would either pass everything or nothing. What differs is the set, the language, the treatment
 * and the collector number, and those are exactly the four below.
 */
import { useId } from "react";
import { X } from "lucide-react";
import { filterChipState, ToggleChip } from "@/components/FilterChips";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import {
  EMPTY_PRINTING_FILTER,
  isFilterActive,
  type LangOption,
  type PrintingFilter,
  type SetOption,
  type Treatment,
  type TreatmentOption,
} from "./printingFilters";
import { isPrintingGroupBy, PRINTING_GROUP_BY_OPTIONS, type PrintingGroupBy } from "./printings";
```

The body draws, in one wrapping row:

1. **The text box.** `type="search"`, `aria-label="Filter printings"`, placeholder `"Set, number or artist"` — which names the fields it matches, because a box that silently ignores what you typed is worse than no box. Changing it calls `onFilterChange({ ...filter, text: e.target.value })`.
2. **The set picker.** A `<details>`-free disclosure is not needed here: draw the sets as `ToggleChip`s when there are **eight or fewer** (the overwhelming case — seven cards in the library have more than 100 paper printings, and most have a handful of sets), and a `<select multiple>` is wrong for a mouse. Past eight, draw a scrollable `<ul>` of checkbox rows inside a bordered, `max-h-40 overflow-y-auto` box, each row `<label><input type="checkbox" …/> {name} <span className="font-mono">{count}</span></label>`. Label the box `aria-label="Sets"`. A zero-count set cannot occur here — the options are built from the rows — so no disabled state is needed.
3. **The language picker.** Same shape as the sets, always the checkbox-list form, `aria-label="Languages"`, each row reading `EN · 41`.
4. **The treatment chips.** One `ToggleChip` per `treatmentOptions` entry, `pressed={filter.treatments.includes(o.id)}`, `title={`${o.label} — ${o.count} printing${o.count === 1 ? "" : "s"}`}`. A zero-count chip is drawn with `filterChipState(false, true)` and its `onClick` is a no-op — the greyed-but-present rule from `facets.ts`.
5. **The sort select.** `aria-label="Sort printings by"`, options from `PRINTING_GROUP_BY_OPTIONS`, narrowed on change with `isPrintingGroupBy` — never a cast. The visible label is **Sort by**, not Group by: this wall draws no headings.
6. **Clear all.** Rendered only when `isFilterActive(filter)`, an `X` icon plus the words, calling `onFilterChange(EMPTY_PRINTING_FILTER)`. It does **not** touch the sort — clearing what you are looking at must not change the order you chose to read it in, which is `useCardSearch`'s own rule for its sort.

Every focusable control takes `FOCUS`. Use `useId()` for the label/box associations.

- [ ] **Step 2: Check it compiles and lints**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src/features/card/PrintingsFilterBar.tsx`
Expected: clean. (It has no test of its own; Task 7 drives it.)

- [ ] **Step 3: Commit**

```bash
git add src/features/card/PrintingsFilterBar.tsx
git commit -m "feat(card): the printings modal's controls"
```

---

### Task 7: The modal

**Files:**

- Create: `src/features/card/AllPrintingsDialog.tsx`
- Test: `src/features/card/AllPrintingsDialog.test.tsx`

**Interfaces:**

- Consumes: Tasks 2, 3, 4, 5, 6. `DeckDialog` from `@/features/decks/DeckDialog`; `CardGrid` from `@/features/search/CardGrid`; `useSwapFromPane` from `@/features/decks/useDeck`; `usePrintingGroupBy` from `./usePrintingGroupBy`; `buildPrintingGroups`, `cheapestPrice`, `printingTarget` from `./printings`; `useCardMenuDeps` from `./useCardMenuDeps`; `useContextMenu` / `buildCardMenu`; `useMarketplace`; `ipcError`.
- Produces: `export function AllPrintingsDialog()` — takes no props, reads the store, renders nothing when `printingsRequest` is null.

- [ ] **Step 1: Write the failing tests**

Create `src/features/card/AllPrintingsDialog.test.tsx`. Mock `@/lib/ipc` the way `CardDetailPane.test.tsx` does — read that file's mock factory and reuse its shape rather than inventing one. Render inside a `QueryClientProvider` and `CardToDeckProvider`, and open the dialog by writing the store.

```tsx
it("draws nothing until a card is asked for", () => {
  render(<Harness />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("names the card and counts its printings", async () => {
  cardPrintings.mockResolvedValue({ items: [p("a", "lea"), p("b", "leb")], total: 2 });
  render(<Harness />);
  open({ oracleId: "o1", name: "Sol Ring", deck: null });
  expect(await screen.findByRole("dialog", { name: /Sol Ring/ })).toBeVisible();
  expect(await screen.findByText("2 printings")).toBeVisible();
});

it("says what it is a truncation of when the page is capped", async () => {
  cardPrintings.mockResolvedValue({ items: [p("a", "lea")], total: 862 });
  render(<Harness />);
  open({ oracleId: "o1", name: "Forest", deck: null });
  expect(await screen.findByText("1 of 862 printings")).toBeVisible();
});

it("narrows the wall and says how much of it is showing", async () => {
  cardPrintings.mockResolvedValue({
    items: [p("a", "lea", "Alpha"), p("b", "leb", "Beta")],
    total: 2,
  });
  const user = userEvent.setup();
  render(<Harness />);
  open({ oracleId: "o1", name: "Sol Ring", deck: null });
  await user.type(await screen.findByRole("searchbox", { name: "Filter printings" }), "beta");
  expect(await screen.findByText("showing 1 of 2 printings")).toBeVisible();
});

it("says why an over-narrowed wall is empty, and offers the way out", async () => {
  cardPrintings.mockResolvedValue({ items: [p("a", "lea", "Alpha")], total: 1 });
  const user = userEvent.setup();
  render(<Harness />);
  open({ oracleId: "o1", name: "Sol Ring", deck: null });
  await user.type(await screen.findByRole("searchbox", { name: "Filter printings" }), "zzz");
  expect(await screen.findByText(/No printings match/)).toBeVisible();
  // **`Clear all` is the filter bar's, and it is the only one.** The empty state says why the
  // wall is empty and points at that control rather than drawing a second one — two buttons
  // whose names both match /Clear/ would make this line throw on an ambiguous match.
  await user.click(screen.getByRole("button", { name: "Clear all" }));
  expect(await screen.findByText("1 printing")).toBeVisible();
});

it("swaps the deck slot and closes when the modal was opened from a deck row", async () => {
  cardPrintings.mockResolvedValue({ items: [p("a", "lea"), p("b", "leb")], total: 2 });
  const user = userEvent.setup();
  render(<Harness />);
  open({ oracleId: "o1", name: "Sol Ring", deck: slot });
  await user.click(await screen.findByRole("button", { name: /LEB/ }));
  // `ipc.deckSwapPrinting` is **positional** — (deckId, fromCardId, toCardId, categoryId,
  // variant, finish) — even though the mutation that calls it takes an object.
  await waitFor(() =>
    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "card-1", "b", 9, "live", null),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps the modal open and says why when a swap is refused", async () => {
  cardPrintings.mockResolvedValue({ items: [p("a", "lea"), p("b", "leb")], total: 2 });
  deckSwapPrinting.mockRejectedValue(new Error("that deck is gone"));
  const user = userEvent.setup();
  render(<Harness />);
  open({ oracleId: "o1", name: "Sol Ring", deck: slot });
  await user.click(await screen.findByRole("button", { name: /LEB/ }));
  expect(await screen.findByText(/that deck is gone/)).toBeVisible();
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("opens the card pane on the printing when there is no deck to write to", async () => {
  cardPrintings.mockResolvedValue({ items: [p("a", "lea"), p("b", "leb")], total: 2 });
  const user = userEvent.setup();
  render(<Harness />);
  open({ oracleId: "o1", name: "Sol Ring", deck: null });
  await user.click(await screen.findByRole("button", { name: /LEB/ }));
  await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("b"));
  expect(deckSwapPrinting).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("asks the backend for the wide page, because it filters", async () => {
  cardPrintings.mockResolvedValue({ items: [], total: 0 });
  render(<Harness />);
  open({ oracleId: "o1", name: "Sol Ring", deck: null });
  await waitFor(() => expect(cardPrintings).toHaveBeenCalledWith("o1", expect.anything(), 1000));
});
```

`p(id, setCode, setName?)` is a local fixture builder over `Printing`, the same shape as Task 3's. `slot` is the `PaneDeckContext` from Task 4's tests. `open(request)` is `act(() => useAppStore.getState().openAllPrintings(request))`.

**Two traps this suite must respect** (both are recorded repo lessons): a controlled `<select>` needs the native value setter to be changed programmatically, and `user.type` focuses what it is handed — assert focus with `user.keyboard` rather than relying on it.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/card/AllPrintingsDialog.test.tsx`
Expected: FAIL — cannot resolve `./AllPrintingsDialog`.

- [ ] **Step 3: Implement**

Create `src/features/card/AllPrintingsDialog.tsx`. The component:

```tsx
export function AllPrintingsDialog() {
  const request = useAppStore((s) => s.printingsRequest);
  const close = useAppStore((s) => s.closeAllPrintings);
  return (
    <DeckDialog
      open={request !== null}
      title={request?.name ?? ""}
      closeLabel="Close printings"
      width="w-[72rem]"
      onDismiss={close}
      onClose={close}
    >
      {request && <Body request={request} onDone={close} />}
    </DeckDialog>
  );
}
```

`DeckDialog` renders `children` only while `open`, so `Body` mounts fresh on every open — which is what makes the filter reset itself with no effect to write, and what keeps a closed modal free of a query.

`Body` holds:

- `const [filter, setFilter] = useState(EMPTY_PRINTING_FILTER)`
- `const { mode, setMode } = usePrintingGroupBy()` — the pane's persisted preference, shared. Read its actual return shape before wiring; the pane calls it one component up from its list.
- `const { marketplace } = useMarketplace()`
- `const query = useQuery({ queryKey: ["card", "printings", request.oracleId, marketplace.id, PRINTINGS_PAGE], queryFn: () => ipc.cardPrintings(request.oracleId, marketplace.id, PRINTINGS_PAGE) })` with `const PRINTINGS_PAGE = 1000` and a comment: this is the backend's `MAX_PRINTINGS_HARD`, named here because the modal filters and a filter over a truncated list lies. The key differs from the pane's by the page size, so the two coexist instead of evicting each other.
- `const items = query.data?.items ?? []`, `const total = query.data?.total ?? 0`
- `const sorted = useMemo(() => buildPrintingGroups(items, mode).flatMap((g) => g.printings), [items, mode])` — the pane's own ordering, flattened. A comment says why the headings are dropped: `CardGrid` positions rows absolutely inside a virtualiser, so a heading cannot be interleaved without owning the virtualisation, and one ordering rule shared with the pane is worth more than the headings.
- `const shown = useMemo(() => filterPrintings(sorted, filter), [sorted, filter])`
- the option lists, each `useMemo`'d on `items`
- `const { swap, deckGone } = useSwapFromPane(request.deck, request.deck?.variant)` — read `useSwapFromPane`'s signature at `useDeck.ts:773`; it defaults the variant.
- `const rows = useMemo(() => shown.map((p) => ({ ...p, name: request.name })), [shown, request.name])` — `CardGrid`'s `GridCard` needs a name and a `Printing` has none, because a name is a fact about the card.

The press:

```tsx
const onSelect = useCallback(
  (cardId: string) => {
    if (swapping) return; // one write at a time; the tiles are inert too
    if (!request.deck || deckGone) {
      viewPrinting(cardId);
      onDone();
      return;
    }
    swap.mutate(
      {
        fromCardId: request.deck.cardId,
        toCardId: cardId,
        categoryId: request.deck.categoryId,
        finish: request.deck.finish,
      },
      { onSuccess: () => onDone() },
    );
  },
  [/* … */],
);
```

**No `deckId` in that object, and that is not an omission.** `useSwapFromPane(request.deck, request.deck?.variant)` mounts `useDeck(context.deckId, variant)`, so the mutation closes over both the deck and the variant; its `mutationFn` takes exactly `{ fromCardId, toCardId, categoryId, finish }` (`useDeck.ts:648-664`). Passing a `deckId` would not type-check.

`const swapping = swap.isPending` gates the early return above and also goes to `CardGrid` — every tile is inert while one write is in flight, which is the pane's own rule (`src/CLAUDE.md`: the handler refuses the press as well as the attribute saying so).

The chrome:

- `subtitle` on `DeckDialog`: the count line, in `font-mono tabular-nums text-dim`. Three wordings, exactly as the spec's §6 lists them — `862 printings` / `1000 of 1204 printings` / `showing 37 of 862 printings` — chosen by `isFilterActive(filter)` and `items.length < total`.
- `<PrintingsFilterBar …/>` under the header.
- The wall: `<div className="min-h-0 flex-1">` wrapping `CardGrid`, since `CardGrid` owns its own scroller and virtualiser and needs a bounded parent.
- `CardGrid` props: `rows`, `onSelect`, `onNeedNextPage={noop}` (module-level constant so it is stable), `listKey={`${request.oracleId}:${mode}:${JSON.stringify(filter)}`}`, `zoomSection="printings"`, `selectedId={request.deck?.cardId ?? null}`, `label={`Printings of ${request.name}`}`, `cardMenu`, `cardMenuKey`, `finish`, `topLeft`, `action`.
  - `finish` — `parseFinishes(p.finishes)` from `@/lib/finish`; return the single premium finish only when the printing is sold in exactly one and it is not nonfoil, else `null`. A printing available in both is not a foil card and marking it as one would be a claim.
  - `topLeft` — the language code, upper-cased, **only when it is not `en`**. A wall where every tile says EN says nothing.
  - `action` — the cheapest price across finishes at the current marketplace: `cheapestPrice(p.finishPrices)` from `./printings`, drawn with `formatPrice(value, marketplace.currency)` from `@/lib/prices`. A `null` price draws an **em dash**, never `$0.00` — `formatPrice` never invents a zero, and a marketplace that has not answered costs an em dash rather than a number. Wrapped in `font-mono tabular-nums`.
  - `cardMenu` / `cardMenuKey` — `useContextMenu()`'s `menu`/`menuKey` over a thunk `() => buildCardMenu(printingTarget(p, cardFacts), { ...deps, printingsOracleId: request.oracleId, printingsDeck: request.deck })`. `cardFacts` is `{ name: request.name, oracleId: request.oracleId, typeLine: null }` — the request carries no type line, and `null` is the honest value: `cardMenu.tsx`'s doc says `null` still runs `autoCategoryFor`, where **absent** would skip the filing rule entirely.
- Loading: `query.isPending` draws `Loading printings…`. Error: `query.isError` draws `Could not read the printings — {ipcError(query.error)}`.
- Empty: `shown.length === 0 && items.length > 0` draws `No printings match these filters.` and **no button of its own** — `PrintingsFilterBar` already renders `Clear all` whenever the filter is active, which is exactly when this sentence is on screen, and a second control with the same job is a second thing to keep in step (and an ambiguous match for any test addressing it by name). `items.length === 0 && !query.isPending && !query.isError` draws `This card has no paper printings.` — a different sentence, because it is a different fact.
- A refused swap draws `ipcError(swap.error)` in `text-destructive` above the wall, and the modal stays open.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/card/AllPrintingsDialog.test.tsx`
Expected: PASS. (Count the `it` blocks above rather than trusting a number beside them.)

- [ ] **Step 5: Commit**

```bash
git add src/features/card/AllPrintingsDialog.tsx src/features/card/AllPrintingsDialog.test.tsx
git commit -m "feat(card): a modal for every printing of a card"
```

---

### Task 8: Mount it, and give the deck editor its slot

**Files:**

- Modify: `src/App.tsx:111-150`
- Modify: `src/features/decks/DeckEditor.tsx:1748-1759` (`openCard`), `:1806-1816` (the deck row menu), `:1984-1994` (the panel tile menu)
- Test: `src/features/decks/DeckEditor.test.tsx`

**Interfaces:**

- Consumes: Tasks 5 and 7.
- Produces: a `deckSlotOf(card: DeckCard): PaneDeckContext` callback in `DeckEditor`, used by both `openCard` and the menu's `printingsDeck`.

- [ ] **Step 1: Write the failing test**

In `src/features/decks/DeckEditor.test.tsx`:

```tsx
it("hands the printings modal the slot the card was right-clicked in", async () => {
  const user = userEvent.setup();
  renderEditor();
  await user.pointer({ target: await screen.findByText("Sol Ring"), keys: "[MouseRight]" });
  await user.click(await screen.findByRole("menuitem", { name: "View all printings" }));
  const request = useAppStore.getState().printingsRequest;
  expect(request?.deck).toMatchObject({ deckId: 4, cardId: "card-1", variant: "live" });
});

/** A docked search tile is not a row of this deck, so a press there must not offer a swap. */
it("hands it no slot from the docked search panel's tiles", async () => {
  const user = userEvent.setup();
  renderEditor();
  await user.pointer({
    target: await screen.findByRole("button", { name: /Lightning Bolt/ }),
    keys: "[MouseRight]",
  });
  await user.click(await screen.findByRole("menuitem", { name: "View all printings" }));
  expect(useAppStore.getState().printingsRequest?.deck).toBeNull();
});

/** The editor stays open behind the modal — the whole point of the change. */
it("leaves the deck open when printings are asked for", async () => {
  const user = userEvent.setup();
  renderEditor();
  await user.pointer({ target: await screen.findByText("Sol Ring"), keys: "[MouseRight]" });
  await user.click(await screen.findByRole("menuitem", { name: "View all printings" }));
  expect(useAppStore.getState().openDeckId).toBe(4);
  expect(useAppStore.getState().activeView).toBe("decks");
});
```

Match the file's existing `renderEditor` helper and its fixture names — read them rather than assuming `Sol Ring` / `card-1` / deck 4.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/decks/DeckEditor.test.tsx -t "printings"`
Expected: FAIL — `printingsRequest` is null; the menu still calls the removed dep.

- [ ] **Step 3: Implement**

In `DeckEditor.tsx`, extract the slot so both callers share one definition:

```tsx
/**
 * One deck row as the slot every write to it is addressed by.
 *
 * Extracted because two things need it now: `openCard`, which anchors the card pane, and the
 * card menu's `printingsDeck`, which is what makes a press in the printings modal a *swap*. Two
 * hand-written copies of a five-part address is how one of them comes to name four parts — which
 * `PaneDeckContext`'s own doc records happening twice, each time rewriting the wrong row.
 */
const deckSlotOf = useCallback(
  (card: DeckCard): PaneDeckContext => ({
    deckId,
    categoryId: card.categoryId,
    categoryName: card.categoryName,
    cardId: card.cardId,
    variant,
    finish: card.finish,
  }),
  [deckId, variant],
);

const openCard = useCallback(
  (card: DeckCard) => openCardFromDeck(deckSlotOf(card)),
  [deckSlotOf, openCardFromDeck],
);
```

In the deck row menu (`:1806-1816`), replace the `viewPrintingsInPane` override:

```tsx
          // **The slot, not a destination.** The row used to re-anchor the card pane onto this
          // deck row so its printings list could offer a swap; the modal takes the slot directly,
          // so the pane is no longer in the path at all and the deck stays on screen behind it.
          card: { ...cardMenuDeps, printingsDeck: deckSlotOf(card) },
```

with `deckSlotOf` added to the `useCallback`'s dependency array.

In the panel tile build (`:1984-1994`), delete the `viewPrintingsInPane: setSelectedCardId` override and its comment entirely — a search tile is not a row of this deck, and the default deps already carry `deck: null`. `buildCardMenu(searchCardTarget(card), cardMenuDeps)` is the whole call now; drop `setSelectedCardId` from that `useCallback`'s dependencies if nothing else in it reads it.

In `App.tsx`, mount the dialog as a sibling of `AppShell`, beside `CardZoomIndicator`:

```tsx
{
  /* **A sibling of the shell, like the zoom badge above it and for the same reason.**
                The dialog is `fixed` at `LAYER.overlay`, and a z-index only competes inside its own
                stacking context — mounted inside a view it would be capped by whatever that view's
                transformed ancestors allow. Nothing between here and the root transforms.

                One instance for the whole app: the menu row that opens it is on twelve card
                surfaces, and a dialog per host would be twelve copies of one decision. Inside
                `CardToDeckProvider` and `ContextMenuProvider` because its tiles carry the same card
                menu every other wall does. */
}
<AllPrintingsDialog />;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/decks/DeckEditor.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/features/decks/DeckEditor.tsx src/features/decks/DeckEditor.test.tsx
git commit -m "feat(decks): open the printings modal on the deck's own slot"
```

---

### Task 9: Retire the search page's oracle filter

**Files:**

- Modify: `src/features/search/useCardSearch.ts:315`, `:334`, `:391-413`, `:457-470`, `:513`, `:555`, `:593-600`, `:720-725`, `:767`, `:862`
- Modify: `src/features/search/FilterBar.tsx:145-150`
- Test: `src/features/search/useCardSearch.test.ts`, `src/features/search/FilterBar.test.tsx`, `src/features/search/SearchPage.test.tsx`

**Interfaces:**

- Consumes: Task 4 (the store fields are already gone).
- Produces: `useCardSearch`'s returned object no longer carries `oracleId` or `oracleName`.

- [ ] **Step 1: Delete the tests that assert the old behaviour, and add the one that fixes the meaning**

Remove the cases in `useCardSearch.test.ts` and `FilterBar.test.tsx` that seed `pendingCardSearch` or assert the oracle chip. Add to `useCardSearch.test.ts`:

```ts
/**
 * The search page is no longer a printings viewer. `View all printings` opens a modal over
 * whatever the reader is on, so nothing seeds a filter here and nothing consumes one.
 */
it("sends no oracle id", async () => {
  const { result } = renderHook(() => useCardSearch(), { wrapper });
  await waitFor(() => expect(cardsSearch).toHaveBeenCalled());
  expect(cardsSearch.mock.calls[0][0]).not.toHaveProperty("oracleId");
});
```

Match the file's existing wrapper and mock names.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/search/useCardSearch.test.ts`
Expected: FAIL — the request still carries `oracleId`, and the file will not compile against the removed store fields.

- [ ] **Step 3: Implement**

In `useCardSearch.ts`, delete: the `pendingCardSearch` selector; the `oracleId` and `oracleName` `useState`s and their doc comments; the whole `if (pendingCardSearch !== null) { … }` render-phase block; `oracleId` from the request builder, from the returned object and from the "is anything filtered" predicate at `:191`; and the `oracleId` clause of the `resetAll`/active-filter arithmetic at `:862`.

Two things **stay**:

- `allPrintings` — the collapse toggle is an independent search feature. Only its seed changes: `useState(false)`. Rewrite the comment that explains the seed; it currently argues from `pendingCardSearch`.
- the `format` default. Its seed at `:334` reads `pendingCardSearch !== null ? ANY_CARD : defaultFormatValue`; it becomes `defaultFormatValue` alone. `ANY_CARD` keeps its other callers.

Delete the `oracleId`-shaped `FacetRequest` note at `:593-600` only if it becomes false — read it and keep whatever still holds of the fence it describes.

In `FilterBar.tsx`, delete the `search.oracleId !== ""` chip block at `:145-150`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/search`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/search/useCardSearch.ts src/features/search/useCardSearch.test.ts src/features/search/FilterBar.tsx src/features/search/FilterBar.test.tsx src/features/search/SearchPage.test.tsx
git commit -m "refactor(search): the search page is no longer a printings viewer"
```

---

### Task 10: Stories

**Files:**

- Create: `src/features/card/AllPrintingsDialog.stories.tsx`
- Modify: `src/features/card/CardDetailPane.stories.tsx` — its "View all printings" narrative is now wrong

**Interfaces:**

- Consumes: Task 7.
- Produces: nothing other tasks read.

- [ ] **Step 1: Read the conventions**

Read `.storybook/CLAUDE.md` and an existing dialog's stories (`src/features/decks/DeckHistoryDialog.stories.tsx`) before writing. Seed the fake's printings through its own seams — never a hand-written `cards` row, which `CLAUDE.md` forbids because it makes every later measurement a fiction.

- [ ] **Step 2: Write the stories**

Six, each with a docblock saying what it is for:

1. **Default** — a card with a dozen printings across four sets, no deck slot.
2. **Filtered** — a play that types into the box and asserts the count line reads `showing N of M`.
3. **Truncated** — `items.length < total`, so the caption's middle wording is on screen.
4. **FromADeckRow** — a deck slot present, the current printing ringed; a play that clicks another tile and asserts the swap was requested.
5. **RefusedSwap** — the fake's fault seam makes `deck_swap_printing` fail; the sentence is drawn and the dialog is still open.
6. **NoMatches** — filters that leave nothing, showing the empty sentence and its Clear control.

- [ ] **Step 3: Run the story tests**

Run: `npx vitest run src/stories.test.tsx`
Expected: PASS.

Note: story plays cannot be run reliably during a parallel fan-out — `stories.test.tsx` collects the whole tree, so a sibling's half-finished slice fails them. If this task runs in a fan-out, write the stories and leave the run to the fan-in.

- [ ] **Step 4: Commit**

```bash
git add src/features/card/AllPrintingsDialog.stories.tsx src/features/card/CardDetailPane.stories.tsx
git commit -m "test(card): stories for the printings modal"
```

---

### Task 11: Verify, document, and drive the real window

**Files:**

- Modify: `docs/reference/frontend-design.md` — the modal, its filters, and the measured page-size cost
- Modify: `docs/reference/decks-storage.md` — the swap now has a second presser
- Modify: `src/features/decks/CLAUDE.md` if the editor's rules named the pane as the printings destination

- [ ] **Step 1: Run the full suite**

Run: `npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error|failed" verify.log`
Expected: green. **Do not pipe to `tail`** — a pipe reports the pipe's exit code, so a red suite reads as a pass. Do not start a second verify while one is running.

- [ ] **Step 2: Run the two checks verify does not**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 3: Measure the wider page**

With the app running, time `card_printings` for Forest at `limit: 1000` against the same call at 400, in the same session, and record both figures with the build (debug or release) they were taken on. A figure without its build is not a measurement.

- [ ] **Step 4: Drive the shipped window**

Per `docs/reference/live-ui-verification.md`, over CDP from PowerShell (Bash refuses `cdp.mjs` eval in a worktree), wrapping every binding in an IIFE and splitting click-then-read across two evals — a click and a count in one eval answers about the frame before React re-rendered:

1. From the **Collection**, right-click a card → View all printings. Assert the modal is up and the collection is still behind it (`activeView` unchanged, the collection's rows still in the DOM).
2. Type in the filter box; assert the count line changes and the wall narrows.
3. Press Escape **once**; assert the modal closed and nothing else did.
4. Open a **deck**, right-click a card → View all printings, click a different printing. Assert the deck row now names the new set and the modal is gone.
5. Ctrl+wheel inside the modal; assert the page's own wall behind it did not resize.

- [ ] **Step 5: Write the docs**

Add the modal to `docs/reference/frontend-design.md` with the page-size measurement from Step 3 and the CDP findings from Step 4. Do not write down a count a build already answers — no story totals, no test-case counts.

- [ ] **Step 6: Commit and ship**

```bash
git add docs src
git commit -m "docs: record the printings modal and its measurements"
```

Then follow the **`auto-pr`** skill: `npm run verify`, push, open the PR, arm auto-merge, and watch for the only two states GitHub abandons — a real conflict and a red `ci-ok`. The agent does not press Merge.
