# Deck Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a pasted or file-loaded decklist into a new deck from the Decks gallery, or into the open deck's live/theory variant, with cards filed into categories automatically — and move deck creation from a docked popup to a modal.

**Architecture:** TypeScript parses the text and makes every decision (which category, which commander); Rust answers two questions (`deck_import_resolve` — name → printing; `deck_import_read_file` — path → text) and performs one write (`deck_import_commit` — one transaction, one allocator run). Nothing new is persisted, so there is **no schema migration**.

**Tech Stack:** Rust (rusqlite, serde, Tauri 2.11 commands), TypeScript 6 / React 19, TanStack Query, Vitest 4 + Testing Library, Storybook 9, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-08-12-deck-import-design.md` — read it before Task 1.

## Global Constraints

> **Revised 2026-08-12 after merging `origin/main` (26 commits).** Main restructured the docs and
> added a motion vocabulary. Both change what every task below must obey; the changes are folded
> into the constraints and into Tasks 7, 10, 11, 13 and 14.

- **The binding rules live in per-directory `CLAUDE.md` files now, not one root page.** The root
  `CLAUDE.md` is a short index. Read the one that governs what you are touching:

  | Working on | Read |
  |---|---|
  | Anything Rust | `src-tauri/CLAUDE.md` |
  | Any UI | `src/CLAUDE.md` |
  | Deck domain, categories, the editor | `src/features/decks/CLAUDE.md` |
  | Stories, the fake, seeds and faults | `.storybook/CLAUDE.md` |

  Long-form measurements sit in `docs/reference/` — `decks-storage.md`, `motion.md`,
  `frontend-design.md`, `storybook.md`, `live-ui-verification.md`, `data-and-sync.md`.
- **Motion is a shared vocabulary and every animated surface uses it** (`src/lib/motion.ts`,
  `motion@13.1.0`). Import a **preset** — `scrim`, `dialog`, `popup`, `press` — never a duration.
  **Two APIs are forbidden and fail silently:** `AnimatePresence mode="popLayout"` and
  `animateView()` both inject a `<style>` element, which the shipped `style-src 'self'` blocks
  while dev, Storybook and jsdom all stay green. `mode="sync"` and `"wait"` are fine.
  `src/lib/tokens.test.ts` sweeps for both.
- **A `motion` element's first painted frame carries its `initial`, so `toBeVisible` is false for
  anything inside a newly opened overlay until the next frame.** Assertions about content inside
  a surface that just opened need `waitFor` — in component tests and in story `play`s alike.
- **The `mtg-grimoire-sb-mcp` MCP server that `src/CLAUDE.md` mandates is NOT connected in this
  session.** Substitute the discipline, not the tool: before using any prop on an existing
  component, read that component's source and its `.stories.tsx`. Never infer a prop from its
  name or from another library.
- **Read `CLAUDE.md` before every task.** Its hard rules are binding, especially "Hard rules — decks".
- **`npm run verify`** (build + lint + Vitest + cargo test) must pass before every commit. Run it from the worktree root.
- **`.storybook/fake/db.ts` cannot be grepped** — ripgrep classifies it as binary and reports "no matches" for text that is there. **Read it** with the Read tool instead. (Same for any `Grep` over `.storybook/fake/`.)
- **Never add an npm or cargo dependency.** Name folding is a hand-written table, not `unicode-normalization`.
- **No new `AUDIT_KINDS` value, no schema change, no migration.** An import records `add` (and `remove` for Replace) rows.
- **No new `LAYER` rung.** Both modals use `LAYER.overlay`, the rung every full-window surface shares. Writing a z-index anywhere but `src/lib/layers.ts` fails `src/lib/layers.test.ts`.
- **Dim text is `text-dim`, never `text-muted`** (`src/lib/tokens.test.ts` guards it).
- **Tailwind classes must be whole literal strings** — a class built by interpolation emits no rule.
- Rust structs crossing IPC carry `#[serde(rename_all = "camelCase")]`; `src/lib/ipc.ts` is the hand-written mirror and must be updated in the same task as the struct.
- Every `#[tauri::command]` returns `Result<_, String>` and is registered in `src-tauri/src/lib.rs`'s `invoke_handler` list.
- Commit style: `feat:` / `fix:` / `test:` / `chore:` / `docs:`, small, one per task. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Branch: `feat/deck-import`. Do not merge to `main`; the last task opens a PR.

---

### Task 1: The decklist parser

Pure text → structure. No IPC, no card knowledge, no React.

**Files:**
- Create: `src/features/decks/import/parse.ts`
- Create: `src/features/decks/import/parse.test.ts`
- Create: `src/features/decks/import/fixtures.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type Section = "deck" | "commander" | "sideboard" | "companion" | "maybeboard";
export interface ParsedLine {
  lineNumber: number;              // 1-based
  raw: string;                     // the line exactly as it arrived, untrimmed
  quantity: number;                // >= 1
  name: string;
  setCode: string | null;          // uppercased
  collectorNumber: string | null;  // verbatim, TEXT
  section: Section;
}
export interface ParseIssue { lineNumber: number; raw: string; reason: string }
export interface ParsedList {
  lines: ParsedLine[];
  issues: ParseIssue[];
  totalCards: number;              // sum of quantity
  suggestedName: string | null;    // Arena's `Name <x>` under `About`
}
export function parseDecklist(text: string): ParsedList;
```
`fixtures.ts` exports `REFERENCE_LIST`, `MOXFIELD_LIST`, `ARENA_LIST`, `MTGO_LIST` as string constants.

- [ ] **Step 1: Create the fixtures file**

Create `src/features/decks/import/fixtures.ts`. `REFERENCE_LIST` is **the list in spec §12, copied verbatim** — 105 lines, do not retype or reorder it. Copy it out of `docs/superpowers/specs/2026-08-12-deck-import-design.md`.

```ts
/**
 * Decklists in the shapes people actually paste, shared by the parser's tests and by the
 * import dialog's stories.
 *
 * `REFERENCE_LIST` is the list this feature was designed against, copied out of
 * `docs/superpowers/specs/2026-08-12-deck-import-design.md` **verbatim** — 105 lines, 117
 * cards, seven `//` split names, no section headers. Every one of those numbers is asserted
 * in `parse.test.ts` rather than remembered here.
 */
export const REFERENCE_LIST = `1 Aerith Gainsborough
1 Aerith, Last Ancient
… (all 105 lines) …
1 Yoshimaru, Ever Faithful`;

/** Moxfield's export: a Commander header, a blank line, then the deck. */
export const MOXFIELD_LIST = `1 Captain Sisay (BRC) 132

Commander
1 Captain Sisay (BRC) 132

Deck
1 Sol Ring (LTC) 285
1 Arcane Signet (ELD) 331
6 Forest (UNF) 235

Sideboard
1 Path to Exile (2X2) 21`;

/** Arena's export: an About block with the deck's name, then Deck and Sideboard. */
export const ARENA_LIST = `About
Name Bant Ramp
Deck
4 Llanowar Elves (M19) 314
2 Lightning Bolt (M10) 146

Sideboard
2 Duress (M20) 94`;

/** MTGO's text export: no headers, `SB:` prefixes on the sideboard. */
export const MTGO_LIST = `4 Lightning Bolt
2 Sol Ring
SB: 2 Duress
SB: 1 Path to Exile`;
```

- [ ] **Step 2: Write the failing tests**

Create `src/features/decks/import/parse.test.ts`. These are the tests — write them all now, they all fail:

```ts
import { describe, expect, it } from "vitest";
import { parseDecklist } from "./parse";
import { ARENA_LIST, MOXFIELD_LIST, MTGO_LIST, REFERENCE_LIST } from "./fixtures";

describe("parseDecklist", () => {
  it("reads the reference list whole", () => {
    const out = parseDecklist(REFERENCE_LIST);
    expect(out.issues).toEqual([]);
    expect(out.lines).toHaveLength(105);
    expect(out.totalCards).toBe(117);
    expect(out.lines.every((l) => l.section === "deck")).toBe(true);
  });

  it("keeps a `//` split name whole", () => {
    const out = parseDecklist(REFERENCE_LIST);
    const split = out.lines.filter((l) => l.name.includes(" // "));
    expect(split).toHaveLength(7);
    expect(split.map((l) => l.name)).toContain("Branchloft Pathway // Boulderloft Pathway");
    expect(split.map((l) => l.name)).toContain("Kolvori, God of Kinship // The Ringhart Crest");
  });

  it("reads a comment only when the slashes open the line", () => {
    const out = parseDecklist("// my deck\n#notes\n1 Fire // Ice");
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0].name).toBe("Fire // Ice");
  });

  it("takes a count with or without an x, and defaults to one", () => {
    const out = parseDecklist("4 Bolt\n4x Shock\n2 X Marks the Spot\nSol Ring");
    expect(out.lines.map((l) => [l.quantity, l.name])).toEqual([
      [4, "Bolt"],
      [4, "Shock"],
      [2, "X Marks the Spot"],
      [1, "Sol Ring"],
    ]);
  });

  it("takes a printing hint and uppercases the set", () => {
    const out = parseDecklist("1 Sol Ring (ltc) 285\n1 Arcane Signet (eld)");
    expect(out.lines[0]).toMatchObject({ setCode: "LTC", collectorNumber: "285" });
    expect(out.lines[1]).toMatchObject({ setCode: "ELD", collectorNumber: null });
  });

  it("keeps a collector number that is not a number", () => {
    const out = parseDecklist("1 Sol Ring (SLD) 123★\n1 Shock (PLST) A-45");
    expect(out.lines.map((l) => l.collectorNumber)).toEqual(["123★", "A-45"]);
  });

  it("does not mistake parentheses inside a name for a hint", () => {
    const out = parseDecklist("1 Erase (Not the Urza's Legacy One)");
    expect(out.lines[0].name).toBe("Erase (Not the Urza's Legacy One)");
    expect(out.lines[0].setCode).toBeNull();
  });

  it("switches section on a header, however it is spelled", () => {
    const out = parseDecklist(MOXFIELD_LIST);
    const bySection = (s: string) => out.lines.filter((l) => l.section === s).map((l) => l.name);
    expect(bySection("commander")).toEqual(["Captain Sisay"]);
    expect(bySection("sideboard")).toEqual(["Path to Exile"]);
    expect(bySection("deck")).toEqual(["Captain Sisay", "Sol Ring", "Arcane Signet", "Forest"]);
  });

  it("reads every header spelling", () => {
    for (const [header, section] of [
      ["Deck", "deck"], ["Deck (99)", "deck"], ["Mainboard", "deck"], ["Main Deck", "deck"],
      ["Commander", "commander"], ["Commander (1)", "commander"], ["COMMANDERS", "commander"],
      ["Sideboard", "sideboard"], ["Sideboard: ", "sideboard"], ["SB", "sideboard"],
      ["Companion", "companion"], ["Maybeboard", "maybeboard"], ["Considering", "maybeboard"],
    ] as const) {
      const out = parseDecklist(`${header}\n1 Sol Ring`);
      expect(out.lines[0].section, header).toBe(section);
    }
  });

  it("takes an SB: prefix as a one-line override", () => {
    const out = parseDecklist(MTGO_LIST);
    expect(out.lines.filter((l) => l.section === "sideboard").map((l) => l.name)).toEqual([
      "Duress",
      "Path to Exile",
    ]);
    expect(out.lines.filter((l) => l.section === "deck")).toHaveLength(2);
  });

  it("does not end a section on a blank line", () => {
    const out = parseDecklist("Sideboard\n\n1 Duress");
    expect(out.lines[0].section).toBe("sideboard");
  });

  it("reads Arena's About block for a name and imports nothing from it", () => {
    const out = parseDecklist(ARENA_LIST);
    expect(out.suggestedName).toBe("Bant Ramp");
    expect(out.lines.map((l) => l.name)).toEqual([
      "Llanowar Elves",
      "Lightning Bolt",
      "Duress",
    ]);
  });

  it("strips a foil marker and a trailing tag off the name", () => {
    const out = parseDecklist("1 Sol Ring *F*\n1 Shock [Foil]\n1 Bolt #Removal");
    expect(out.lines.map((l) => l.name)).toEqual(["Sol Ring", "Shock", "Bolt"]);
  });

  it("survives CRLF and a byte-order mark", () => {
    const out = parseDecklist("﻿1 Sol Ring\r\n2 Shock\r\n");
    expect(out.lines.map((l) => l.name)).toEqual(["Sol Ring", "Shock"]);
  });

  it("quotes a line it cannot read instead of dropping it", () => {
    const out = parseDecklist("1 Sol Ring\n???\n2 Shock");
    expect(out.lines).toHaveLength(3); // "???" is a nameable card as far as this parser knows
    const junk = parseDecklist("1 Sol Ring\n0 Shock");
    expect(junk.issues).toEqual([
      { lineNumber: 2, raw: "0 Shock", reason: "A count of zero is not an import." },
    ]);
    expect(junk.lines).toHaveLength(1);
  });

  it("is empty for empty input", () => {
    expect(parseDecklist("")).toEqual({
      lines: [], issues: [], totalCards: 0, suggestedName: null,
    });
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run src/features/decks/import/parse.test.ts`
Expected: FAIL — `Failed to resolve import "./parse"`.

- [ ] **Step 4: Write the parser**

Create `src/features/decks/import/parse.ts`. The shape, with the rules that matter written into it:

```ts
/**
 * A decklist as text, read into lines this app can act on.
 *
 * One parser for every shape people paste — plain lists, Moxfield, Archidekt, Arena, MTGO —
 * because they overlap almost entirely and a format *detector* would be a second thing to be
 * wrong. It knows nothing about cards: a name here is a string, and whether any card bears it
 * is `deck_import_resolve`'s question.
 */
const SECTIONS: Record<string, Section> = {
  deck: "deck", main: "deck", maindeck: "deck", mainboard: "deck", "main deck": "deck",
  commander: "commander", commanders: "commander",
  sideboard: "sideboard", sb: "sideboard",
  companion: "companion",
  maybeboard: "maybeboard", maybe: "maybeboard", considering: "maybeboard",
};

/**
 * A count, a name, and an optional printing.
 *
 * `name` is **lazy** and the hint group is anchored to the end, which is the whole reason
 * `Erase (Not the Urza's Legacy One)` keeps its parentheses: a set code is 1–10 word
 * characters and a real one is followed by the end of the line or a collector number, so a
 * parenthesised phrase with spaces in it can never match.
 */
const LINE =
  /^(?:(?<qty>\d{1,4})\s*[xX]?\s+)?(?<name>.+?)(?:\s+\((?<set>\w{1,10})\)(?:\s+(?<cn>\S+))?)?$/;
```

Behaviour, in order, per line:

1. Strip a leading `﻿` from the **first** line only; split on `/\r?\n/`.
2. `trim()`. Empty → skipped entirely (no line, no issue).
3. Starts with `//` or `#` → a comment, skipped.
4. **The `About` block**: a line that is exactly `about` (case-insensitive) starts an ignored block. Inside it, a line matching `/^name\s+(.+)$/i` sets `suggestedName`; every other line is ignored. The block ends at the next recognised section header.
5. **Section header**: strip a trailing `:` and a trailing `\s*\(\d+\)`, lowercase, look up in `SECTIONS`. A hit switches the current section and produces no line.
6. **`SB:` prefix** (`/^sb:\s*/i`): strip it and force this line's section to `sideboard`.
7. Strip trailing markers from the tail: `/\s+\*[A-Z]\*$/`, `/\s+\[[^\]]+\]$/`, `/\s+#\S+$/` — repeatedly, until none matches.
8. Match `LINE`. `qty` absent → 1. `qty` of `0` → a `ParseIssue` with reason `"A count of zero is not an import."` and no line.
9. `setCode` uppercased; `collectorNumber` verbatim.
10. An empty name after all that → a `ParseIssue` with reason `"No card name on this line."`.

`totalCards` is the sum of `quantity`. The starting section is `"deck"`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/features/decks/import/parse.test.ts`
Expected: PASS, 16 tests.

If the `REFERENCE_LIST` counts do not come out at 105/117/7, **the fixture was mistyped** — re-copy it from the spec rather than adjusting the assertion.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/features/decks/import/
git commit -m "feat: parse decklists into lines, sections and issues

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `CardIdentity` — asking about a card that is not in a deck

Types only. No behaviour changes, and the type-check is the whole proof.

**Files:**
- Modify: `src/features/decks/validation/types.ts` (append after `CardFacts`)
- Modify: `src/features/decks/validation/commanders.ts:72` (`frontFace`), `:178` (`identityOf`), `:399` (`commanderIneligibility`)

**Interfaces:**
- Consumes: nothing.
- Produces: `CardIdentity` from `@/features/decks/validation/types`, and three functions that accept it.

- [ ] **Step 1: Add the type**

In `src/features/decks/validation/types.ts`, after `CardFacts`:

```ts
/**
 * The **card-level** half of {@link CardFacts} — everything true of a printing, and nothing
 * true only of a row in a deck.
 *
 * It exists so the importer can ask "could this be a commander?" about a card that is not in
 * a deck yet, and therefore has no `id`, no `categoryKind` and no honest `quantity` to invent.
 * `CardFacts` is deliberately **not** narrowed to this: the engine really does read
 * `categoryKind` (eight times), `categoryActive` and `quantity`, so a card in a deck is more
 * than a card.
 *
 * Every existing caller passes a whole {@link DeckCard}, which satisfies a `Pick` of itself —
 * so widening a parameter to this type changes no call site and no behaviour.
 */
export type CardIdentity = Pick<
  CardFacts,
  | "cardId" | "name" | "oracleId" | "manaCost" | "cmc" | "typeLine" | "oracleText"
  | "colors" | "colorIdentity" | "legalities" | "power" | "toughness" | "layout"
  | "rarity" | "faces" | "gameChanger" | "everUncommon"
>;
```

- [ ] **Step 2: Widen the three parameters**

In `commanders.ts`, change the `card` parameter type from `CardFacts` to `CardIdentity` on `frontFace`, `identityOf` and `commanderIneligibility`. Import `CardIdentity` alongside `CardFacts`. **Change nothing else** — no bodies, no other signatures. `validateCommanderZone` keeps `CardFacts[]`; it reads `quantity`.

- [ ] **Step 3: Prove nothing broke**

Run: `npm run verify`
Expected: PASS. If `tsc` complains that a body reads a field not in the `Pick`, **add that field to `CardIdentity`** — the sweep that produced this list is a description, and the compiler is the specification.

- [ ] **Step 4: Commit**

```bash
git add src/features/decks/validation/
git commit -m "refactor: name the card-level half of CardFacts as CardIdentity

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Rust — name folding and `deck_import_resolve`

**Files:**
- Create: `src-tauri/src/deck_import.rs`
- Modify: `src-tauri/src/lib.rs:1-24` (add `pub mod deck_import;`)

**Interfaces:**
- Consumes: nothing.
- Produces:
```rust
pub const MAX_IMPORT_BYTES: u64 = 1024 * 1024;
pub const IMPORT_MODES: [&str; 2] = ["merge", "replace"];
pub fn fold_name(raw: &str) -> String;
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ResolveLine { pub name: String, pub set_code: Option<String>, pub collector_number: Option<String> }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct ImportMatch { /* fields below */ }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct ImportResolveRow { pub index: usize, pub matched: Option<ImportMatch>, pub hint_missed: bool }
pub fn resolve_lines(conn: &Connection, lines: &[ResolveLine]) -> Result<Vec<ImportResolveRow>, String>;
#[tauri::command] pub async fn deck_import_resolve(state, lines: Vec<ResolveLine>) -> Result<Vec<ImportResolveRow>, String>;
```

`ImportMatch` fields, in this order: `card_id: String`, `name: String`, `set_code: String`, `collector_number: String`, `lang: String`, `oracle_id: Option<String>`, `mana_cost: Option<String>`, `cmc: Option<f64>`, `type_line: Option<String>`, `oracle_text: Option<String>`, `colors: Option<String>`, `color_identity: Option<String>`, `legalities: Option<String>`, `power: Option<String>`, `toughness: Option<String>`, `layout: Option<String>`, `rarity: Option<String>`, `faces: Option<String>`, `game_changer: bool`, `ever_uncommon: bool`, `unit_price_usd: Option<f64>`, `owned_quantity: i64`, `printing_count: i64`.

- [ ] **Step 1: Write the failing tests**

At the bottom of the new `src-tauri/src/deck_import.rs`, in `#[cfg(test)] mod tests`. Follow the fixture style already in `src-tauri/src/deck.rs`'s tests — **read that module's test setup first** and reuse its helpers for building an in-memory database with `cards` rows.

```rust
#[test]
fn a_name_folds_to_something_a_reader_could_have_typed() {
    assert_eq!(fold_name("Jötun Grunt"), "jotun grunt");
    assert_eq!(fold_name("Márton Stromgald"), "marton stromgald");
    assert_eq!(fold_name("Ach! Hans, Run!"), "ach! hans, run!");
    assert_eq!(fold_name("Yawgmoth’s Will"), "yawgmoth's will");
    assert_eq!(fold_name("  Sol   Ring "), "sol ring");
    assert_eq!(fold_name("Æther Vial"), "aether vial");
}

#[test]
fn an_exact_name_resolves_to_one_printing() { /* one card row, one line, matched.is_some() */ }

#[test]
fn a_front_face_name_matches_a_double_faced_card() {
    // cards.name = "Kolvori, God of Kinship // The Ringhart Crest"
    // a line naming only "Kolvori, God of Kinship" matches it
}

#[test]
fn a_printing_you_own_beats_a_newer_one_you_do_not() {
    // two printings of one name: the newer unowned, the older with a collection_entries row.
    // the owned one comes back.
}

#[test]
fn with_nothing_owned_the_newest_paper_printing_wins() {}

#[test]
fn a_digital_only_printing_is_never_returned() {
    // is_paper = 0 on the only printing of a name -> matched is None
}

#[test]
fn a_set_and_collector_hint_wins_over_both_rules() {}

#[test]
fn a_hint_that_names_nothing_falls_through_and_says_so() {
    // hint_missed == true, matched.is_some() via the name rule
}

#[test]
fn a_folded_name_matches_when_the_exact_one_does_not() {
    // cards.name = "Jötun Grunt", line names "Jotun Grunt"
}

#[test]
fn an_unmatched_name_is_a_row_with_no_match_and_not_an_error() {}

#[test]
fn the_same_list_twice_resolves_to_the_same_ids() {}

#[test]
fn printing_count_is_the_number_of_paper_printings_of_that_name() {}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test deck_import`
Expected: FAIL to compile — the module does not exist.

- [ ] **Step 3: Write `fold_name`**

A hand-written table. **No new crate.**

```rust
/// A card name reduced to what two people typing it would agree on: lowercase, no diacritics,
/// one kind of apostrophe, single spaces.
///
/// Hand-written rather than `unicode-normalization`, because the alphabet a Magic card name
/// can be printed in is small and known, and a dependency added for one function is a
/// dependency to keep. Anything not on the table passes through, so a name in a script this
/// table has never heard of folds to itself and still matches itself exactly.
pub fn fold_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => out.push('a'),
            'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => out.push('e'),
            'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => out.push('i'),
            'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ø' => out.push('o'),
            'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => out.push('u'),
            'ñ' | 'Ñ' => out.push('n'),
            'ç' | 'Ç' => out.push('c'),
            'ý' | 'ÿ' | 'Ý' => out.push('y'),
            'æ' | 'Æ' => out.push_str("ae"),
            'œ' | 'Œ' => out.push_str("oe"),
            'ß' => out.push_str("ss"),
            '\u{2019}' | '\u{02BC}' | '`' => out.push('\''),
            '\u{2013}' | '\u{2014}' => out.push('-'),
            _ => out.extend(ch.to_lowercase()),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}
```

- [ ] **Step 4: Write the resolution SQL**

Three prepared statements, reused across the whole list. The card-fact column list is **exactly** `deck.rs`'s `DECK_CARD_SELECT` card half — read it at `src-tauri/src/deck.rs:1820` and copy the column expressions so the two cannot drift.

```rust
/// The card half of `DECK_CARD_SELECT`, plus the two facts only an import asks for.
///
/// `count(*) OVER ()` is computed before `LIMIT`, so it counts every printing that matched
/// rather than the one that won — which is what the preview needs to say "12 printings".
const MATCH_SELECT: &str = "SELECT c.id, c.name, c.set_code, c.collector_number, c.lang,
        c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
        c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
        c.faces, c.game_changer,
        EXISTS(SELECT 1 FROM cards u
                WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon,
        CAST(json_extract(c.prices, '$.usd') AS REAL) AS unit_price_usd,
        coalesce((SELECT sum(e.quantity) FROM collection_entries e
                   WHERE e.card_id = c.id), 0) AS owned_quantity,
        count(*) OVER () AS printing_count
   FROM cards c";

/// The order every arm below shares: a printing you own, then the newest, then the id.
///
/// The `id` tie-break is not decoration — it is what makes an import **deterministic**, so
/// the same list pasted twice puts the same printings in the deck.
const MATCH_ORDER: &str =
    " ORDER BY owned_quantity DESC, coalesce(c.released_at, '0000-00-00') DESC, c.id DESC LIMIT 1";

/// The name arm. **Both halves of a double-faced name match**: `cards.name` carries
/// `"A // B"`, and a list naming only the front is the commonest way a DFC is written down.
/// `instr` answers 0 for a single-faced name, so `substr(name, 1, -1)` is `''` and never
/// equals a real name.
const BY_NAME: &str = " WHERE c.is_paper = 1
      AND (c.name = ?1 COLLATE NOCASE
           OR substr(c.name, 1, instr(c.name, ' // ') - 1) = ?1 COLLATE NOCASE)";
```

`resolve_lines` walks the list and, per line:

1. If `set_code` **and** `collector_number` are present: `MATCH_SELECT` + `WHERE c.is_paper = 1 AND c.set_code = ?1 COLLATE NOCASE AND c.collector_number = ?2 COLLATE NOCASE` + `MATCH_ORDER`. A hit returns with `hint_missed: false`.
2. If only `set_code`: the same with `AND (name arm)` on `?2`. A hit returns.
3. A hint that was present and missed sets `hint_missed = true` and **falls through**.
4. `MATCH_SELECT` + `BY_NAME` + `MATCH_ORDER` with the raw name.
5. Still nothing: fold the name, then read candidates through FTS and compare folded names in Rust:
   ```rust
   // `cards_fts` narrows the candidate set so the fold never scans the corpus. The MATCH
   // argument is a quoted phrase with its own quotes doubled — an unescaped name containing
   // a quote is an FTS syntax error, not a miss.
   let phrase = format!("\"{}\"", raw_name.replace('"', "\"\""));
   ```
   `SELECT` the same columns `FROM cards_fts f JOIN cards c ON c.rowid = f.rowid WHERE cards_fts MATCH ?1 AND c.is_paper = 1 LIMIT 200`, keep the rows whose `fold_name(name)` or folded front face equals the folded query, and pick by the same ordering **in Rust** (owned desc, released_at desc, id desc).
   An FTS error here is **not** an error for the line — catch it and treat it as no match.
6. Nothing at all: `matched: None`.

Wrap the whole walk so one bad line cannot fail the request: a per-line SQL error becomes `matched: None`, and the function returns `Err` only if a statement cannot be **prepared**.

- [ ] **Step 5: Write the command**

```rust
/// Every name in a pasted decklist, resolved to a printing this app has. **Read-only.**
#[tauri::command]
pub async fn deck_import_resolve(
    state: tauri::State<'_, Arc<AppState>>,
    lines: Vec<ResolveLine>,
) -> Result<Vec<ImportResolveRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        resolve_lines(&crate::sync::lock_db_read(&state), &lines)
    })
    .await
    .map_err(|e| format!("the decklist could not be resolved: {e}"))?
}
```

Add `pub mod deck_import;` to `src-tauri/src/lib.rs` (alphabetical, after `pub mod deck_audit;`) and `deck_import::deck_import_resolve,` to the `invoke_handler` list after `deck::deck_missing_to_wishlist,`.

- [ ] **Step 6: Run the tests**

Run: `cd src-tauri && cargo test deck_import`
Expected: PASS, 12 tests.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src-tauri/src/deck_import.rs src-tauri/src/lib.rs
git commit -m "feat: resolve decklist names to printings, preferring ones you own

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Rust — `deck_import_commit`

One transaction, one allocator run, one or two audit rows.

**Files:**
- Modify: `src-tauri/src/deck_import.rs`
- Modify: `src-tauri/src/deck.rs:242` — change `fn printing_of` to `pub(crate) fn printing_of`, and its return type `Printing` to `pub(crate) struct Printing` if it is not already visible
- Modify: `src-tauri/src/lib.rs` (register the command)

**Interfaces:**
- Consumes: `IMPORT_MODES` from Task 3; `crate::deck::{printing_of, touch_deck, allocate_deck}`; `crate::deck_meta::{valid_variant, category_for_name}`; `crate::deck_audit::record`.
- Produces:
```rust
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ImportItem { pub card_id: String, pub quantity: i64, pub category_name: String }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct ImportOutcome { pub added: i64, pub removed: i64, pub categories_created: i64 }
pub fn commit_import(conn: &Connection, deck_id: i64, variant: &str, mode: &str, items: &[ImportItem]) -> Result<ImportOutcome, String>;
#[tauri::command] pub async fn deck_import_commit(state, deck_id: i64, variant: String, mode: String, items: Vec<ImportItem>) -> Result<ImportOutcome, String>;
```

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_merge_folds_onto_the_grain() {
    // add 2 of a card, then import 3 of the same card into the same category -> one row of 5
}

#[test]
fn a_list_naming_one_card_twice_lands_as_one_row() {
    // two ImportItems, same card_id and category_name -> one row with the sum
}

#[test]
fn a_replace_clears_only_the_variant_it_was_given() {
    // live has 3 cards, theory has 2; replace live -> live is the import, theory untouched
}

#[test]
fn a_replace_leaves_the_categories_alone() {
    // a category the reader made stays, empty, after a replace that does not name it
}

#[test]
fn a_category_the_deck_does_not_have_is_created_once() {
    // two items naming "Ramp" -> categories_created == 1
}

#[test]
fn a_section_name_lands_on_the_predefined_category() {
    // category_name "Sideboard" -> the seeded row, kind = 'side', nothing new created
}

#[test]
fn the_allocator_runs_once_for_the_whole_import() {
    // seed a collection entry, import 20 cards, assert deck_allocations is right — and that
    // the allocation rows are consistent with one rebuild rather than twenty
}

#[test]
fn a_merge_records_one_audit_row_and_a_replace_records_two() {}

#[test]
fn a_refused_import_leaves_no_history_and_no_cards() {
    // an item naming a card that is not in `cards` -> Err, deck_cards and deck_audit unchanged
}

#[test]
fn an_unknown_variant_and_an_unknown_mode_are_both_refused_in_words() {}

#[test]
fn an_empty_item_list_is_refused() {
    // "There is nothing to import." — a write that writes nothing is not a write
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test deck_import`
Expected: FAIL — `commit_import` not found.

- [ ] **Step 3: Implement `commit_import`**

```rust
/// A whole decklist into one deck, in one transaction.
///
/// **This command exists for the allocator.** Looping `deck::add_card` from the frontend would
/// be correct in every other respect and would run `allocate_deck` once per line — a hundred
/// rebuilds of a deck's claims for one import. Here it runs once, at the end, over the
/// finished deck.
pub fn commit_import(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    mode: &str,
    items: &[ImportItem],
) -> Result<ImportOutcome, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    if !IMPORT_MODES.contains(&mode) {
        return Err(format!(
            "`{mode}` is not an import mode. Use one of: {}.",
            IMPORT_MODES.join(", ")
        ));
    }
    if items.is_empty() {
        return Err(NOTHING_TO_IMPORT.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;

    let removed: i64 = if mode == "replace" {
        // The cards go; the categories stay. A category is the reader's filing, not the
        // list's — and a replace that swept them would delete the piles a reader named,
        // reordered and switched off, to import a list that mentions none of that.
        let cleared: i64 = tx.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2",
            params![deck_id, variant],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2",
            params![deck_id, variant],
        ).map_err(|e| e.to_string())?;
        cleared
    } else {
        0
    };

    // Find-or-create each distinct name once, counting what was made. `category_for_name`
    // creates a `kind = 'main'` category, and matches the four predefined ones by name — so
    // a `Sideboard` item lands on the seeded row with `kind = 'side'` and nothing is made.
    let mut categories: HashMap<&str, i64> = HashMap::new();
    let mut categories_created = 0i64;
    let mut added = 0i64;
    for item in items {
        let category_id = match categories.get(item.category_name.as_str()) {
            Some(id) => *id,
            None => {
                // Asked *before* the find-or-create, because afterwards there is no way to
                // tell a category that was made from one that was already there — and
                // "9 categories, 3 new" is the sentence the preview promised.
                let existed: Option<i64> = tx
                    .query_row(
                        "SELECT id FROM deck_categories WHERE deck_id = ?1 AND name = ?2",
                        params![deck_id, item.category_name.trim()],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let id = crate::deck_meta::category_for_name(&tx, deck_id, &item.category_name)?;
                if existed.is_none() {
                    categories_created += 1;
                }
                categories.insert(item.category_name.as_str(), id);
                id
            }
        };
        if item.quantity <= 0 {
            return Err(crate::deck::ZERO_ADD.to_owned());
        }
        let printing = crate::deck::printing_of(&tx, &item.card_id)?;
        tx.execute(
            "INSERT INTO deck_cards
                (deck_id, variant, category_id, card_id, set_code, collector_number, lang,
                 name, quantity, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, unixepoch(), unixepoch())
             ON CONFLICT (deck_id, variant, category_id, card_id)
             DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = unixepoch()",
            params![deck_id, variant, category_id, item.card_id, printing.set_code,
                    printing.collector_number, printing.lang, printing.name, item.quantity],
        ).map_err(|e| e.to_string())?;
        added += item.quantity;
    }

    crate::deck::allocate_deck(&tx, deck_id)?;
    // History: one row per effect this command had. Facts only — `auditText.ts` words it.
    if removed > 0 {
        crate::deck_audit::record(&tx, deck_id, variant, "remove", None,
            &json!({ "import": { "mode": mode, "cleared": removed } }), -removed)?;
    }
    crate::deck_audit::record(&tx, deck_id, variant, "add", None,
        &json!({ "import": { "mode": mode, "cards": added, "categories": categories.len() } }),
        added)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ImportOutcome { added, removed, categories_created })
}
```

Add the constant beside it:

```rust
/// A write that writes nothing is not a write — the same refusal `deck::add_card` gives a
/// quantity of zero, one sentence in one place.
pub const NOTHING_TO_IMPORT: &str = "There is nothing to import.";
```

Check the real column list of `deck_cards` before writing the INSERT — read `schema.rs`'s v8 DDL and match it exactly. If `deck_cards` has no `created_at`/`updated_at`, drop them from both the column list and the `DO UPDATE`.

- [ ] **Step 4: Write the command**

The write connection, through the lock, answering `BUSY` — copy the shape from `deck::deck_add_card` (read it at `src-tauri/src/deck.rs:2478` and the surrounding wrappers).

```rust
#[tauri::command]
pub async fn deck_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
    mode: String,
    items: Vec<ImportItem>,
) -> Result<ImportOutcome, String> { /* db::lock_for(…, WRITE_LOCK_WAIT), spawn_blocking */ }
```

Register `deck_import::deck_import_commit,` in `lib.rs`.

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test deck_import`
Expected: PASS.

- [ ] **Step 6: Extend the audit invariant test**

`src-tauri/src/deck_audit.rs` has `every_deck_write_leaves_exactly_one_audit_row` driving a list of cases. Add two: a **merge** import asserting **one** row, and a **replace** import over a non-empty variant asserting **two**. The test's doc comment names a case count — **re-count the list and update the number in the same commit**; it has been written down wrong twice.

Run: `cd src-tauri && cargo test deck_audit`
Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src-tauri/src/
git commit -m "feat: commit a whole decklist in one transaction and one allocation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Rust — `deck_import_read_file`

**Files:**
- Modify: `src-tauri/src/deck_import.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `MAX_IMPORT_BYTES` from Task 3.
- Produces: `#[tauri::command] pub async fn deck_import_read_file(path: String) -> Result<String, String>`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_file_over_the_cap_is_refused_by_size_and_not_read() {}

#[test]
fn a_missing_file_is_refused_in_words() {}

#[test]
fn invalid_utf8_becomes_a_replacement_character_and_not_a_failure() {
    // a Windows-1252 apostrophe in one name must not lose the other 104 lines
}
```

Test the inner `read_import_file(path: &Path) -> Result<String, String>`; the command is a thin async wrapper. **There is no `tempfile` dev-dependency and you may not add one** — build the temp path with `std::env::temp_dir()` and a unique name, and clean up after. Read `maintenance.rs`'s tests for the pattern already in use, and note that one of them has a known temp-dir race: give your files names that cannot collide with a parallel test.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test deck_import`
Expected: FAIL — `read_import_file` not found.

- [ ] **Step 3: Implement it**

```rust
/// A decklist file the reader picked, as text.
///
/// **It takes a path, not bytes** — the page asks the OS for a name and Rust opens the file,
/// which is the same contract `deck::set_cover_image` uses and the whole reason
/// `dialog:allow-open` is sufficient and no `fs:` permission is granted anywhere.
///
/// Lossy UTF-8 deliberately: a Windows-1252 apostrophe in one card name should cost that one
/// name, not the other hundred lines. The line it damages comes back as an unmatched name in
/// the preview, quoted, which is a thing the reader can act on.
fn read_import_file(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("That file could not be opened — {e}"))?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "That file is {} MB. A decklist is text; this reads at most 1 MB.",
            meta.len() / 1_000_000
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("That file could not be read — {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
```

The command wraps it in `spawn_blocking`. It takes **no state** — it touches no database.

Register `deck_import::deck_import_read_file,` in `lib.rs`.

- [ ] **Step 4: Run the tests, verify, commit**

```bash
cd src-tauri && cargo test deck_import && cd ..
npm run verify
git add src-tauri/src/
git commit -m "feat: read a decklist file by path, capped and lossy

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The `ipc.ts` mirror

**Files:**
- Modify: `src/lib/ipc.ts` (types near the other deck types ~line 1100; the three commands in the `ipc` object near `deckMissingToWishlist` ~line 1885)
- Modify: `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: the Rust structs from Tasks 3–5.
- Produces:
```ts
export interface ImportResolveLine { name: string; setCode: string | null; collectorNumber: string | null }
export interface ImportMatch {
  cardId: string; name: string; setCode: string; collectorNumber: string; lang: string;
  oracleId: string | null; manaCost: string | null; cmc: number | null;
  typeLine: string | null; oracleText: string | null; colors: string | null;
  colorIdentity: string | null; legalities: string | null;
  power: string | null; toughness: string | null; layout: string | null;
  rarity: string | null; faces: string | null;
  gameChanger: boolean; everUncommon: boolean; unitPriceUsd: number | null;
  ownedQuantity: number; printingCount: number;
}
export interface ImportResolveRow { index: number; matched: ImportMatch | null; hintMissed: boolean }
export type ImportMode = "merge" | "replace";
export interface ImportItem { cardId: string; quantity: number; categoryName: string }
export interface ImportOutcome { added: number; removed: number; categoriesCreated: number }
// on `ipc`:
deckImportResolve(lines: ImportResolveLine[]): Promise<ImportResolveRow[]>
deckImportCommit(deckId: number, variant: DeckVariant, mode: ImportMode, items: ImportItem[]): Promise<ImportOutcome>
deckImportReadFile(path: string): Promise<string>
```

- [ ] **Step 1: Add the types and the three calls**

Doc every type the way the file's neighbours are documented. Two notes that must be written down, because they are exactly what the mirror is for:

```ts
/**
 * One resolved line. `matched` is `null` for a name no printing bears — **not an error**: the
 * preview quotes it and the import proceeds without it.
 *
 * `hintMissed` says the line carried a `(SET) 123` this app has no printing for, and that the
 * name rule answered instead. Both can be true at once: a missed hint whose name also matched
 * nothing comes back `matched: null, hintMissed: true`.
 */
export interface ImportResolveRow { … }
```

```ts
  /** Every name in a decklist, resolved to a printing. Read-only, ~100 names in one call. */
  deckImportResolve: (lines: ImportResolveLine[]) =>
    invoke<ImportResolveRow[]>("deck_import_resolve", { lines }),
  /** A whole decklist into one deck: one transaction, one allocation, one history row. */
  deckImportCommit: (deckId: number, variant: DeckVariant, mode: ImportMode, items: ImportItem[]) =>
    invoke<ImportOutcome>("deck_import_commit", { deckId, variant, mode, items }),
  /** A decklist file the reader picked, as text. Takes a **path** — Rust opens the file. */
  deckImportReadFile: (path: string) =>
    invoke<string>("deck_import_read_file", { path }),
```

- [ ] **Step 2: Add the argument-name tests**

`src/lib/ipc.test.ts` already asserts command names and argument keys for the existing commands — **read it and follow its exact pattern**. Add three cases asserting `deck_import_resolve` / `{ lines }`, `deck_import_commit` / `{ deckId, variant, mode, items }`, `deck_import_read_file` / `{ path }`.

- [ ] **Step 3: Run, verify, commit**

```bash
npx vitest run src/lib/ipc.test.ts
npm run verify
git add src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat: mirror the three deck-import commands in ipc.ts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `plan.ts` — categories and the commander

Pure. Parsed lines + resolved rows + the format spec → what the preview draws and what the commit sends.

**Files:**
- Create: `src/features/decks/import/plan.ts`
- Create: `src/features/decks/import/plan.test.ts`

**Interfaces:**
- Consumes: `ParsedList`, `ParsedLine`, `ParseIssue`, `Section` (Task 1); `ImportResolveRow`, `ImportMatch`, `ImportItem` (Task 6); `CardIdentity` (Task 2); `autoCategoryFor`, `AUTO_CATEGORY_DISPLAY_ORDER`, `PREDEFINED_CATEGORY_NAMES`, `UNCATEGORISED` from `@/features/decks/autoCategory`; `commanderIneligibility` from `@/features/decks/validation/commanders`; `FormatSpec` from `@/lib/ipc`.
- Produces:
```ts
export interface PlannedCard { lineNumber: number; match: ImportMatch; quantity: number; categoryName: string }
export interface UnmatchedLine { lineNumber: number; raw: string; name: string }
export interface HintMiss { lineNumber: number; name: string; used: string }
export interface CategoryTally { name: string; cards: number; inactive: boolean }
export type CommanderChoice =
  | { kind: "fromFile" }
  | { kind: "notApplicable" }
  | { kind: "automatic"; cardIds: string[] }
  | { kind: "ask"; candidates: ImportMatch[] };
export interface ImportPlan {
  cards: PlannedCard[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  parseIssues: ParseIssue[];
  categories: CategoryTally[];
  commander: CommanderChoice;
  totalCards: number;
}
export function buildImportPlan(parsed: ParsedList, rows: ImportResolveRow[], spec: FormatSpec | null): ImportPlan;
export function toImportItems(plan: ImportPlan, commanderIds: readonly string[]): ImportItem[];
export const SECTION_CATEGORY: Record<Exclude<Section, "deck">, string>;
```

- [ ] **Step 1: Write the failing tests**

`plan.test.ts`. Build `ImportMatch` values with a small local helper (`match({ name, typeLine })` filling the rest with nulls) — do **not** reach into `.storybook/`.

```ts
describe("buildImportPlan", () => {
  it("files a card by its type line when the file said nothing", () => {
    // "Sol Ring" (Artifact) -> "Artifact"; "Forest" (Basic Land — Forest) -> "Land";
    // "Llanowar Elves" (Creature — Elf Druid) -> "Creature"
  });
  it("files a land creature as a land", () => {
    // Dryad Arbor, "Land Creature — Forest Dryad" -> "Land" (autoCategoryFor's own rule)
  });
  it("files a card with no type line as Uncategorised", () => {});
  it("lets a file section name the category", () => {
    // section "sideboard" -> "Sideboard", "companion" -> "Companion",
    // "maybeboard" -> "Maybeboard", "commander" -> "Commander"
  });
  it("marks the Maybeboard tally inactive and no other", () => {});
  it("orders the tally: sections first, then the type buckets in reading order", () => {
    // Commander, Sideboard, Companion, Maybeboard, then Creature … Land, Uncategorised last
  });
  it("quotes a line that resolved to nothing and keeps it out of the cards", () => {});
  it("quotes a missed printing hint and names what was used instead", () => {});
  it("carries the parse issues through untouched", () => {});
  it("sums the quantities of a card named twice into one tally", () => {});
});

describe("the commander", () => {
  it("says nothing when the format has no commander rule", () => {
    // spec.commanderRule is null -> { kind: "notApplicable" }
  });
  it("defers to the file when a Commander section named one", () => {
    // { kind: "fromFile" }, and the card is in the Commander category
  });
  it("picks the only eligible card by itself", () => {
    // one legendary creature among ten spells -> { kind: "automatic", cardIds: [id] }
  });
  it("asks when more than one card is eligible", () => {
    // two legendary creatures -> { kind: "ask", candidates: [both] }
  });
  it("asks with no candidates when nothing is eligible", () => {
    // { kind: "ask", candidates: [] } — the reader confirms a deck with no commander
  });
});

describe("toImportItems", () => {
  it("moves the chosen commanders into Commander and leaves the rest", () => {});
  it("is empty when the plan matched nothing", () => {});
  it("emits one item per planned card, not per copy", () => {
    // 6 Forest -> one item with quantity 6
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/features/decks/import/plan.test.ts`
Expected: FAIL — `Failed to resolve import "./plan"`.

- [ ] **Step 3: Implement**

```ts
/**
 * Where every line of a decklist is going, and what the preview says about the ones that are
 * not going anywhere.
 *
 * Pure, and deliberately so: this is the domain logic the spec keeps on this side of the IPC
 * boundary. Rust answered "which printing", and answers nothing about *which pile*.
 */
export const SECTION_CATEGORY = {
  commander: "Commander",
  sideboard: "Sideboard",
  companion: "Companion",
  maybeboard: "Maybeboard",
} as const;
```

- A line's category is `SECTION_CATEGORY[line.section]` when the section is not `"deck"`, else `autoCategoryFor({ typeLine: match.typeLine })`.

**Changed under you by main, and it matters here.** `useDeck.addCard` now applies `autoCategoryFor` itself, on its single definition, taking an optional `typeLine` that travels from the call site — and `useDeck.ts` exports `DEFAULT_CATEGORY_NAME` (`"Main deck"`). The distinction that module draws is: a type line of **`null`** (an orphan, or a layout with no bucket word) is `Uncategorised`; an **absent** type line is `DEFAULT_CATEGORY_NAME`. An import always has the resolved card's `typeLine` in hand, so it is never in the "absent" case — every planned card goes through `autoCategoryFor` and an unresolvable type line lands in `Uncategorised`. **Do not route the import through `addCard`**; it writes one card per call and the whole point of `deck_import_commit` is one transaction and one allocator run. Read `src/features/decks/CLAUDE.md`'s "The category model" section before writing this file.
- The tally's order: the four `SECTION_CATEGORY` values in `PREDEFINED_CATEGORY_NAMES` order, then the type buckets in `AUTO_CATEGORY_DISPLAY_ORDER`, then `UNCATEGORISED`. `inactive` is true for `"Maybeboard"` **and nothing else** — the four predefined kinds are fixed and only that one is seeded inactive.
- Commander, in order: `spec === null || spec.commanderRule === null` → `notApplicable`. Any card in the `"Commander"` category → `fromFile`. Else gather every card `c` where `commanderIneligibility(identityOf(c.match), spec.commanderRule, spec) === null`; exactly one → `automatic`; otherwise → `ask` with the candidates.
  - The adapter from `ImportMatch` to `CardIdentity` is a plain object literal — every field of `CardIdentity` is on `ImportMatch` under the same name. Write it out once as `function identityOf(m: ImportMatch): CardIdentity`.
- `toImportItems(plan, commanderIds)` maps every `PlannedCard` to `{ cardId, quantity, categoryName }`, overriding `categoryName` to `"Commander"` for a card whose id is in `commanderIds`.

- [ ] **Step 4: Run, verify, commit**

```bash
npx vitest run src/features/decks/import/plan.test.ts
npm run verify
git add src/features/decks/import/
git commit -m "feat: plan a decklist into categories and a commander choice

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The two history sentences

**Files:**
- Modify: `src/features/decks/auditText.ts`
- Modify: `src/features/decks/auditText.test.ts`

**Interfaces:**
- Consumes: the payload shape written by Task 4 — `{ import: { mode, cards, categories } }` on an `add` row, `{ import: { mode, cleared } }` on a `remove` row.
- Produces: no new exports; the existing entry point gains two branches.

- [ ] **Step 1: Write the failing tests**

Read `auditText.test.ts` for its exact helper shape first, then add:

```ts
it("words a merge import", () => {
  // kind "add", cardName null, delta 117, payload { import: { mode: "merge", cards: 117, categories: 9 } }
  // -> "Imported 117 cards into 9 categories"
});
it("words a replace import's two rows", () => {
  // the remove row -> "Cleared 42 cards before importing"
  // the add row    -> "Imported 117 cards into 9 categories"
});
it("says one card, not 1 cards", () => {});
it("still words an ordinary add with a card name", () => {
  // the existing behaviour, unchanged — an import row is the one with no card_id
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/features/decks/auditText.test.ts`

- [ ] **Step 3: Implement**

Add the branch **before** the per-card branches, keyed on the payload carrying `import`:

```ts
// An import is the one `add` that names no card: it is a hundred of them. The payload
// carries the counts because the table records facts and this file words them — which is
// what lets the sentence change without a migration.
```

Pluralise with the file's existing helper if it has one; add one if it does not.

- [ ] **Step 4: Run, verify, commit**

```bash
npx vitest run src/features/decks/auditText.test.ts
npm run verify
git add src/features/decks/auditText.ts src/features/decks/auditText.test.ts
git commit -m "feat: word an import in the deck's history

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts`
- Modify: `.storybook/fake/db.test.ts`

**⚠ `db.ts` cannot be grepped — ripgrep calls it binary and answers "no matches" for text that is there. Read it with the Read tool.** Find `deck_add_card`'s handler and build these three beside it, in the same style.

**Interfaces:**
- Consumes: the argument names from Task 6.
- Produces: three handlers on the world — `deck_import_resolve`, `deck_import_commit`, `deck_import_read_file`.

- [ ] **Step 1: Write the failing tests**

In `db.test.ts`, beside the existing `deck_add_card` tests:

```ts
it("resolves a name to a printing it has", () => {});
it("resolves a front-face name to a double-faced card", () => {});
it("prefers a printing the collection holds", () => {});
it("answers a name it does not know with a null match", () => {});
it("commits a merge onto the grain", () => {});
it("commits a replace that clears only its own variant", () => {});
it("creates the categories the items name", () => {});
it("refuses an empty item list", () => {});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run .storybook/fake/db.test.ts`

- [ ] **Step 3: Implement the handlers**

The fake **stores table rows and derives DTOs** — follow that. `deck_import_resolve` reads the world's `cards` and `collection_entries` and applies §4's rules in the same order (hint, exact name, front face, folded name); `deck_import_commit` reuses the world's own `deck_add_card` internals for the insert-or-fold, then does whatever the world does for allocation. `deck_import_read_file` throws — no story picks a file, and a handler that invented text would be a story about a thing that cannot happen. Give it the sentence `"No file picker in Storybook."`.

Add a `fault` for a refused import if the existing fault machinery makes that cheap; if not, leave it — the dialog's refusal story can use a story-level command override (`registerCommands`), which is what that function is for.

- [ ] **Step 4: Run, verify, commit**

```bash
npx vitest run .storybook/fake/db.test.ts
npm run verify
git add .storybook/fake/
git commit -m "test: teach the Storybook fake the three import commands

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `CreateDeckDialog` — deck creation as a modal

**Files:**
- Create: `src/features/decks/CreateDeckDialog.tsx`
- Create: `src/features/decks/CreateDeckDialog.test.tsx`
- Create: `src/features/decks/CreateDeckDialog.stories.tsx`
- Modify: `src/features/decks/DecksPage.tsx:1358-1545` — `NewDeck` keeps its button and loses its anchored form; `CreateDeckForm` is deleted
- Modify: `src/features/decks/DecksPage.test.tsx` (the create-deck cases)

**Interfaces:**
- Consumes: `Decks["create"]` from `useDecks`, `useFormatSpecs`, `DEFAULT_FORMAT` (already in `DecksPage.tsx` — export it or move it to a shared module if the dialog needs it).
- Produces:
```tsx
export function CreateDeckDialog(props: {
  create: UseMutationResult</* as today */>;
  onCreated: (deck: DeckRow) => void;
  onDismiss: () => void;   // Escape and the scrim: hands focus back
}): JSX.Element
```

- [ ] **Step 1: Write the failing tests**

```tsx
it("opens with the caret in the name field", async () => {});
it("creates the deck the reader described", async () => {
  // type a name, pick a format, submit -> create.mutate called with { name, formatKey }
});
it("refuses to submit an empty or whitespace name", async () => {});
it("shows the refusal and keeps what was typed", async () => {
  // create.isError -> the sentence is on screen and the name field still holds the name
});
it("closes on Escape and hands focus back to the trigger", async () => {});
it("closes on a press on the scrim and not on a press inside the panel", async () => {});
it("keeps Tab inside the dialog", async () => {});
it("offers Casual when the format list has not arrived", async () => {});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/features/decks/CreateDeckDialog.test.tsx`

- [ ] **Step 3: Build the dialog**

**Read `src/features/decks/TheoryDiffDialog.tsx` in full and copy its shell exactly** — it is the pattern, and reinventing it is how a modal ends up with an `aria-modal` it does not honour. **It gained motion when main landed, so read the file rather than this description:**

- the whole surface is wrapped in `<AnimatePresence>`, and the panel is mounted only while open;
- scrim: `<motion.div {...scrim} className={cn("fixed inset-0 flex items-center justify-center bg-bg/70 p-4", LAYER.overlay)}>` with `onMouseDown` closing only when `e.target === e.currentTarget` (**`onMouseDown`, not `onClick`** — a click fires on the common ancestor of press and release, so a text selection dragged past the panel edge would otherwise dismiss it);
- panel: `<motion.div {...dialog}>` with `ref`, `tabIndex={-1}`, `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at its `<h2>`, `onKeyDown={trapTab}`;
- `scrim` and `dialog` are imported from `@/lib/motion` — **never a hand-written duration, and never `mode="popLayout"`**;
- `useDismissOnEscape({ layer: "inner", onDismiss })` with a `useCallback`-stable `onDismiss`;
- focus the **name input** on mount (this dialog has one obvious first field, unlike `TheoryDiffDialog` which focuses its panel).

**Every test assertion about content inside this dialog needs `waitFor`** — a `motion` element's first painted frame carries its `initial`, so `toBeVisible` is false until the next frame even with `MotionGlobalConfig.skipAnimations`. That is the single most likely way this task's tests fail for a reason that is not a bug.

The body is the two fields and the button lifted from `CreateDeckForm` — same labels, same `DEFAULT_FORMAT`, same `enabledInPicker` filter, same refusal line, same disabled rule. Do not redesign them.

- [ ] **Step 4: Swap it into `DecksPage`**

`NewDeck` keeps the button (and its `aria-haspopup="dialog"` / `aria-expanded`) and renders `<CreateDeckDialog>` instead of `<CreateDeckForm>`. **Delete the `onBlur` handler** and its long comment — a modal is not dismissed by focus leaving it, and the trap is what keeps focus in. The `Panel` union's `{ kind: "createDeck" }` is unchanged.

- [ ] **Step 5: Write the stories**

`CreateDeckDialog.stories.tsx`, `tags: ["autodocs"]`. Stories: `Default`, `Refused` (a failing create), `NoFormats` (an empty picker). Because the panel is `fixed inset-0`, give the docs stories `parameters: { docs: { story: { inline: false, height: "32rem" } } }` — `DeckSettingsDialog` carries the same parameter for the same reason, and without it the scrim covers the docs page.

Give each story a `play` that asserts one thing, so `src/stories.test.tsx` covers them.

- [ ] **Step 6: Run everything**

```bash
npx vitest run src/features/decks/CreateDeckDialog.test.tsx src/features/decks/DecksPage.test.tsx src/stories.test.tsx
npm run verify
```

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/
git commit -m "feat: create a deck in a modal

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: `ImportDeckDialog` and `useDeckImport`

**Files:**
- Create: `src/features/decks/import/useDeckImport.ts`
- Create: `src/features/decks/import/useDeckImport.test.ts`
- Create: `src/features/decks/import/ImportDeckDialog.tsx`
- Create: `src/features/decks/import/ImportDeckDialog.test.tsx`
- Create: `src/features/decks/import/ImportDeckDialog.stories.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1, 6, 7, 10. Plus `useFormatSpecs()` — **where the commander
  rule comes from, and it differs by target**: for `{ kind: "new" }` it is the spec for the
  format the reader picked *in this dialog*, which changes live as they change the select; for
  `{ kind: "deck" }` it is the open deck's own `formatKey`, read from the deck. Pass the
  resolved `FormatSpec | null` into `buildImportPlan`. Getting this backwards means a Commander
  deck that never asks for a commander, and the ask is the whole point of §6.3.
- Produces:
```tsx
export type ImportTarget =
  | { kind: "new" }
  | { kind: "deck"; deckId: number; variant: DeckVariant; cardsInVariant: number };
export function ImportDeckDialog(props: {
  target: ImportTarget;
  onDismiss: () => void;
  onImported: (deckId: number, outcome: ImportOutcome) => void;
}): JSX.Element;
// useDeckImport.ts
export function useDeckImport(): {
  resolve: UseMutationResult<ImportResolveRow[], unknown, ImportResolveLine[]>;
  commit: UseMutationResult<ImportOutcome, unknown, { deckId: number; variant: DeckVariant; mode: ImportMode; items: ImportItem[] }>;
  readFile: UseMutationResult<string, unknown, string>;
  importIntoNewDeck: UseMutationResult<{ deck: DeckRow; outcome: ImportOutcome }, unknown, { name: string; formatKey: string; items: ImportItem[] }>;
};
```

- [ ] **Step 1: Write `useDeckImport`'s failing test**

The one behaviour a hook test earns here:

```ts
it("deletes the deck it just made when the import is refused", async () => {
  // deckCreate resolves, deckImportCommit rejects -> deckDelete called with the new id,
  // and the mutation rejects with the commit's error, not the delete's
});
it("keeps the deck when the import lands", async () => {});
it("invalidates the deck and the deck list after a commit", async () => {});
```

Follow `src/features/decks/useDeck.test.ts` for the QueryClient harness.

- [ ] **Step 2: Run, fail, implement `useDeckImport`**

Run: `npx vitest run src/features/decks/import/useDeckImport.test.ts` → FAIL.

`importIntoNewDeck` is `deckCreate` then `deckImportCommit(deck.id, "live", "merge", items)`, with the create rolled back by `deckDelete` in the failure path:

```ts
// A refused import must not leave a deck behind. The reader asked for "this list as a deck";
// half of that is not a smaller version of it, it is a mess in their gallery — and the
// dialog is still open holding the text they pasted, so the retry is one press.
```

Invalidation follows `useDeck.ts`'s existing keys — read it and use the same ones (`["decks"]`, `["deck", id]`). The refusal rule lives here, on the single definition, never at a call site.

- [ ] **Step 3: Write the dialog's failing tests**

```tsx
it("will not advance from an empty box", async () => {});
it("previews what it would import without writing anything", async () => {
  // paste MTGO_LIST, press Preview -> the tally is on screen, deckImportCommit not called
});
it("quotes a line that matched no card", async () => {});
it("quotes a printing hint it could not honour", async () => {});
it("asks for a commander when more than one card is eligible", async () => {});
it("does not ask when the format has no commander rule", async () => {});
it("sends the chosen commander in the Commander category", async () => {});
it("disables Import when nothing resolved", async () => {});
it("offers Merge and Replace only when importing into a deck", async () => {});
it("names what Replace would clear", async () => {
  // "removes the 42 cards in Live first"
});
it("shows a refused commit and stays open with the pasted text", async () => {});
it("blames the sync, not the reader, when the corpus is empty", async () => {
  // every line unmatched AND the sync is still running -> "Card data is still syncing" and
  // NOT 105 lines of "no such card". Import stays disabled either way.
});
it("closes on Escape and hands focus back", async () => {});
it("reads a file the reader picked", async () => {
  // mock @tauri-apps/plugin-dialog's `open` to resolve a path; deckImportReadFile mocked
});
it("shows the file reader's refusal beside the button", async () => {});
```

- [ ] **Step 4: Run, fail, build the dialog**

Same modal shell as Task 10 — `AnimatePresence`, `motion.div {...scrim}`, `motion.div {...dialog}` from `@/lib/motion`, `trapTab`, `useDismissOnEscape({ layer: "inner" })` (**read `TheoryDiffDialog.tsx` and the `CreateDeckDialog` Task 10 just built — do not copy from memory**). Two steps in one panel, `step: "source" | "preview"`:

**Source step** — a `<textarea>` (labelled, ~14 rows), a *Choose file…* button, and for `target.kind === "new"` the name and format fields from `CreateDeckDialog` (extract them into a small shared component **only if that is a clean lift**; a second copy of two form fields is not worth a bad abstraction — decide by looking, and say which you chose in the commit message). Prefill the name from `parsed.suggestedName` when the reader has not typed one.

The file button:
```ts
// `dialog:allow-open` is the one dialog permission this app grants, and it is granted for
// deck covers. The picker answers a **path**; Rust opens the file, which is why no `fs:`
// permission is needed here either.
const path = await open({ multiple: false, filters: [{ name: "Decklist", extensions: ["txt", "dec", "dek", "csv"] }] });
```

**Preview step** — `buildImportPlan(parsed, rows, spec)`, then:
- a headline: *N cards · K categories*;
- the tally, each row `name · count`, with `(inactive)` on the Maybeboard;
- `unmatched`, each as `line 12 · "1 Lightning Bolth"` — quoted, with the line number;
- `hintMisses`, each naming what was used instead;
- the commander row: `automatic` states the choice in a sentence; `ask` draws the candidates as a listbox of buttons (multi-select for partners) with a "no commander" escape; `fromFile` and `notApplicable` draw nothing;
- for `target.kind === "deck"`, the Merge/Replace radio group, Merge checked, Replace's label naming `target.cardsInVariant`;
- **Import** — disabled when `plan.cards.length === 0`.

Both steps: a `Back` from preview to source that keeps the text.

Accessibility: the tally is a `<dl>` or a table with a caption, not a div soup; the unmatched list is a `<ul>`; the commander picker's buttons carry `aria-pressed`. Follow the app's chip pattern — **`aria-disabled`, never the `disabled` attribute**, on anything a reader might tab to.

- [ ] **Step 5: Write the stories**

`ImportDeckDialog.stories.tsx`, `tags: ["autodocs"]`, `docs: { story: { inline: false, height: "40rem" } }`. Stories: `Empty`, `PastedReferenceList` (a `play` that pastes `REFERENCE_LIST` and previews), `WithUnmatchedLines`, `AmbiguousCommander`, `IntoExistingDeck` (Merge/Replace visible), `Refused` (a `registerCommands` override making the commit throw).

- [ ] **Step 6: Run everything**

```bash
npx vitest run src/features/decks/import/ src/stories.test.tsx
npm run verify
```

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/import/
git commit -m "feat: paste or load a decklist, preview it, and import it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: The two entry points

**Files:**
- Modify: `src/features/decks/DecksPage.tsx` — `Panel` union (`~line 113`) and the heading row
- Modify: `src/features/decks/DecksPage.test.tsx`
- Modify: `src/features/decks/DeckEditor.tsx` — `Layer` union (`:163-169`), the toolbar, the layer render
- Modify: `src/features/decks/DeckEditor.test.tsx`

**Interfaces:**
- Consumes: `ImportDeckDialog`, `ImportTarget` (Task 11).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

```tsx
// DecksPage.test.tsx
it("opens the import dialog from the gallery heading", async () => {});
it("never has the create dialog and the import dialog open at once", async () => {});
it("opens the new deck in the editor after an import", async () => {});

// DeckEditor.test.tsx
it("opens the import dialog from the toolbar", async () => {});
it("imports into the variant on screen", async () => {
  // switch to Theory, open Import -> the dialog's target carries variant "theory"
});
it("closes the import dialog on Escape and leaves the card pane open", async () => {});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Wire the gallery**

Add `| { kind: "importDeck" }` to `Panel`. Add an **Import deck** button beside *New deck* in the heading row, styled as one of the "quiet controls" that row already defines (read the comment at `DecksPage.tsx:58`). `onImported` closes the panel and opens the editor on the new deck — the same thing `onCreated` already does.

- [ ] **Step 4: Wire the editor**

Add `| { kind: "import" }` to `Layer`. Add an **Import** control to the toolbar beside the existing layer triggers, opened through the existing `openLayer` so the "one layer at a time" rule holds for free. Its target is `{ kind: "deck", deckId, variant, cardsInVariant: <the count of the variant on screen> }`.

The union is one piece of state deliberately (`CLAUDE.md`: `useDismissOnEscape` orders exactly two rungs, and two `"inner"` peers are not ordered at all) — **do not add a second piece of state for this dialog.**

- [ ] **Step 5: Run, verify, commit**

```bash
npx vitest run src/features/decks/
npm run verify
git add src/features/decks/
git commit -m "feat: import a deck from the gallery or from the open deck

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: The suite-wide claims

**Files:**
- Modify: `src/App.test.tsx` (the Escape-stack test)
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-08-12-deck-import.md` (tick the boxes)

- [x] **Step 1: Extend the Escape-stack test**

`App.test.tsx` pins "Escape closes one layer per press". Add the import dialog: open the card pane, open the import dialog over it, press Escape once → the dialog closes and the pane is still open; press again → the pane closes.

- [x] **Step 2: Re-count the Storybook numbers**

Those counts moved out of the root page when main split the docs: they now live in **`docs/reference/storybook.md`**, and `.storybook/CLAUDE.md` governs the fake. The rule is unchanged and is now stated as a global one in the root `CLAUDE.md` — "a prose-only edit routes to neither CI job, so nothing goes red when a document rots; re-count in the same commit that changes one". Do it the only way that is honest:

```bash
npm run build-storybook
node -e "const i=require('./storybook-static/index.json');const e=Object.values(i.entries);console.log('entries',e.length);console.log('stories',e.filter(x=>x.type==='story').length);console.log('docs',e.filter(x=>x.type==='docs').length);console.log('files',new Set(e.map(x=>x.importPath)).size)"
```

Update the four numbers in `CLAUDE.md` from that output. Also re-count the `play` count it quotes:
```bash
grep -rE "^\s+play:" src --include=*.stories.tsx | wc -l
```

- [x] **Step 3: Write the feature into the docs**

Main split one page into five plus a reference set, so this lands in **two** places and neither is the root `CLAUDE.md`:

1. **`src/features/decks/CLAUDE.md`** — a short **`## Import`** section carrying only the binding rules, in that file's voice. This is what loads when someone touches the deck feature.
2. **`docs/reference/decks-storage.md`** — the long-form record: the Rust commands, the measurements with the build named, and anything the live pass finds. That file already holds the deck tables, the six card commands, the allocator and the audit log, and `deck_import_commit` is the seventh command.

Add a row to the root `CLAUDE.md`'s reference table **only if** you create a new reference doc; do not create one — import belongs with deck storage.

What to write, in both places scaled to their voice — the decisions and the traps, not the file list:

- The parser is one parser on purpose, and `//` is a comment only at the start of a line.
- Resolution prefers a printing you **own**, then the newest paper printing; the tie-break runs to `id` so an import is deterministic.
- `deck_import_commit` exists **for the allocator**: looping `deck_add_card` would run it once per line.
- History is one row per effect (`add`, plus `remove` for Replace), with the counts in the payload — **not** one row per card, which would bury a day's history under one import.
- `CardIdentity` is the card-level half of `CardFacts`, and `CardFacts` was deliberately *not* narrowed.
- The file picker's own half is unverified for the same reason `deck_set_cover_image`'s is.
- Whatever the live pass in Task 14 measures.

Leave Task 14's numbers as a placeholder to fill in **after** that task, not before.

- [x] **Step 4: Full verify**

```bash
npm run verify
```
Expected: PASS — build, lint, Vitest, cargo test, and `build-storybook`.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: record the deck import feature and re-count the Storybook totals

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: Drive it in the shipped window

Storybook runs in a browser and the suite runs in jsdom. **Neither ships.** Every UI task in this repo's history found something in the real WebView2 that no suite could see.

**Read `docs/reference/live-ui-verification.md` first — it is the harness contract**, and it documents traps that have each cost a session.

**Files:**
- Modify: `docs/reference/decks-storage.md` and `src/features/decks/CLAUDE.md` (fill in the measured lines Task 13 left open)

**Two worktree-specific facts, learned the hard way on this repo:**
- **Drive `scripts/cdp.mjs` from PowerShell, not Bash** — the Bash tool refuses its `eval` calls as unverifiable in a worktree-isolated session. Avoid nested quotes and `$` in the expression you pass.
- A CDP recorder dies with the window it is attached to and says nothing about it. Re-attach after any relaunch and check the line count at the end.

- [ ] **Step 1: Launch the real app with CDP**

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

**`tauri dev`, not `tauri build`** — a built app embeds `dist/` at compile time and a frontend-only edit does not reach it. If a built binary is used anyway, `touch src-tauri/src/main.rs` first and check the loaded script hash against `dist/assets/*.js`.

- [ ] **Step 2: Attach the console recorder before anything else**

```bash
node scripts/cdp.mjs console out.jsonl
```
It dies with the window it is attached to and says nothing about it. Re-attach after any relaunch and check the line count at the end.

- [ ] **Step 3: Walk the gallery path**

Using `scripts/cdp.mjs`: `click` the **Import deck** button, `eval` the reference list into the textarea (dispatch a real `input` event so React sees it), preview, and read back:

- the tally and its category names;
- that the commander step **asks** (the reference list has dozens of eligible cards);
- pick one, import, and confirm the editor opens on the new deck.

Then read the deck back through `invoke("deck_get", …)` and record: how many of the 117 cards resolved, which categories were made, and how long `deck_import_resolve` took for 105 lines (`performance.now()` either side of the `invoke`). **Name the build** — this is a debug build under `tauri dev`, and a figure with no build named is not a figure.

- [ ] **Step 4: Walk the editor path**

Open a deck, switch to **Theory**, import a short list, and confirm: it landed in `theory`, `live` is untouched, and the Replace radio names the right count. Then Replace on `live` and confirm the audit drawer reads both sentences.

- [ ] **Step 5: Check the layer behaviour**

- Escape closes the import dialog and leaves the card pane open (one layer per press).
- Tab does not leave the dialog.
- The scrim computes to the same rung the other overlays use.
- `prefers-reduced-motion: reduce` via `media` with a trailing expression **in the same session** — and probe `transitionProperty`, never `transitionDuration` (`transition-none` leaves the duration at `0.15s`, which reads exactly like a real failure).

- [ ] **Step 6: Read the console recording**

Count the lines. Zero JavaScript errors, zero React warnings, zero unhandled rejections. A `Log` entry whose `?t=` stamp is frozen at attach time is retained history, not a live fault.

- [ ] **Step 7: Clean up and record**

Delete every row seeded for the pass — `data/` is the user's. Then write what was measured into `CLAUDE.md`'s new section: the timings with the build named, anything that behaved differently from the tests, and **every bug found, whether or not it was fixed**. A bug found and not written down is a bug found twice.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record what the live pass measured for deck import

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: The pull request

- [ ] **Step 1: Final verify on a clean tree**

```bash
npm run verify
git status --short
```
Expected: PASS, and nothing uncommitted.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/deck-import
gh pr create --title "feat: import decklists into new and existing decks" --body "$(cat <<'EOF'
Imports a pasted or file-loaded decklist into a new deck from the gallery, or into the open
deck's live/theory variant. Deck creation moves from a docked popup to a modal.

## What it does
- One parser for plain, Moxfield, Archidekt, Arena and MTGO lists — printing hints, section
  headers, `SB:` prefixes, comments. `//` is a comment only at the start of a line, so a split
  card name survives.
- Names resolve against the local corpus preferring **a printing you own**, then the newest
  paper printing. An explicit `(SET) 123` wins over both.
- Preview before anything is written: the category breakdown, every unmatched line quoted, and
  the commander picker when the list is ambiguous.
- Cards file themselves — file sections first, then `autoCategoryFor`'s type buckets.
- Merge or Replace when the target deck already has cards.

## Notes
- **No schema change.** History is one `add` row per import (plus a `remove` for Replace) with
  the counts in the payload — not one row per card.
- `deck_import_commit` is one transaction and **one** `allocate_deck`; looping `deck_add_card`
  would have run the allocator once per line.
- `CardFacts` was deliberately *not* narrowed — the engine reads `categoryKind` and `quantity`.
  `CardIdentity` is the card-level half, and only three signatures widened to it.

Spec: `docs/superpowers/specs/2026-08-12-deck-import-design.md`
Plan: `docs/superpowers/plans/2026-08-12-deck-import.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill the PR body's blanks from what Tasks 13 and 14 actually measured before opening it.

---

## Task order and parallelism

Tasks **1, 2, 3** have no dependencies on each other and can run at once. **4** and **5** need 3's module. **6** needs 3–5. **7** needs 1, 2, 6. **8** needs 4's payload. **9** needs 6. **10** is independent of the import chain entirely and can run any time after Task 1. **11** needs 6, 7, 9, 10. **12** needs 11. **13**, **14**, **15** are strictly last, in that order.
