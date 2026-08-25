# Text-backed cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Continuously mirror every deck, the collection and the wishlist to plain text files on disk, in all seven export formats with every optional field on, written by Rust as a background consequence of data changing.

**Architecture:** Rust gains its own copy of the export writer (`src-tauri/src/transfer/`), fenced against the TypeScript one by a shared golden corpus both test suites assert against. A second module (`src-tauri/src/mirror/`) turns the database into a directory tree: a SQLite `update_hook` on the one write connection marks dirty surfaces, a debounced background thread renders them, hashes each file against what is already on disk, and writes only what differs. Nothing reads the mirror back; the TypeScript side is untouched.

**Tech Stack:** Rust 2021, rusqlite 0.40.1 (adding its dependency-free `hooks` feature), Tauri 2, React 19 + TypeScript 6, Vitest, Storybook.

**Spec:** [`docs/superpowers/specs/2026-08-25-text-backed-cards-design.md`](../specs/2026-08-25-text-backed-cards-design.md)

## Global Constraints

- **Never install `@types/node`.** It leaks Node types into the app program and retypes `setTimeout`.
- **Adding a dependency with permissions means adding its narrowest permission, never its `:default`.** This feature needs **no new permission**: `dialog:allow-open` is already granted in `src-tauri/capabilities/default.json` and covers directory selection.
- **`data/` is the user's and is never committed.** No test may write into `data/`. Every filesystem test uses a `tempfile` root.
- **Do not seed `cards` or `sync_meta` in tests** except where a Rust test already does so with an in-memory connection torn down at the end.
- **`npm run verify` before every commit.** It does **not** run `cargo fmt` or `cargo clippy`; CI does, and clippy caps function arguments at 7. Run `cargo fmt` and `cargo clippy -- -D warnings` in `src-tauri/` before pushing.
- **Never run two verifies at once** — concurrent runs fake ~18 Rust schema failures.
- **LF and a trailing newline, always**, in every file the writer produces. An empty list is `""` in every format, CSV header included.
- **Commit small**, with `feat:`/`fix:`/`chore:`/`test:`/`docs:` prefixes.
- The mirror thread may **only** use `state.db_read`. Taking the write connection is a defect: it can make a button answer `db::BUSY`.

## File Structure

**New Rust — the writer (`src-tauri/src/transfer/`):**

| File | Responsibility |
| --- | --- |
| `mod.rs` | Module doc, `pub use` re-exports, the `Surface` and `Format` enums |
| `card.rs` | `Card` — the one row shape, mirroring `TransferCard.ts` field for field |
| `fields.rs` | `FieldId`, the field table, `FORMAT_FIELDS`, `SURFACE_FIELDS`, `available_fields`, `default_fields` |
| `fold.rs` | `fold_for_fields` — rows the chosen fields cannot tell apart become one row |
| `csv.rs` | `csv_field`, `csv_row` — RFC 4180 writing only (no reader; nothing reads the mirror) |
| `write.rs` | `format_export`, `omitted_count` — the whole file, per format |

**New Rust — the mirror (`src-tauri/src/mirror/`):**

| File | Responsibility |
| --- | --- |
| `mod.rs` | Module doc, re-exports |
| `paths.rs` | `sanitise`, `disambiguate`, `is_ours` — names on disk, and what pruning may delete |
| `layout.rs` | `plan_files` — database shape in, relative paths + render requests out. Pure. |
| `read.rs` | `deck_cards`, `collection_cards`, `wishlist_cards` — rows into `Card`s |
| `run.rs` | `run_pass` — render, hash, write, prune, and `README.txt` |
| `settings.rs` | `enabled`, `root`, their `app_meta` keys, and the four commands |
| `watch.rs` | The `update_hook`, the dirty mask, the debounce thread |

**New TypeScript:**

| File | Responsibility |
| --- | --- |
| `src/features/transfer/__golden__/corpus.json` | The shared fixture corpus both suites read |
| `src/features/transfer/__golden__/*.txt` | 70 generated golden files (committed) |
| `scripts/golden.mjs` | Regenerates them from the TypeScript writer |
| `src/features/transfer/golden.test.ts` | Byte equality + the round trip through `parse.ts` |
| `src/features/settings/BackupPanel.tsx` (+`.test.tsx`, `.stories.tsx`) | The Settings panel |

**Modified:** `src-tauri/Cargo.toml` (rusqlite `hooks`), `src-tauri/src/lib.rs` (module declarations, four commands, the setup hook and thread), `src-tauri/src/sync.rs` (`AppState` gains the dirty mask and the mirror handle), `package.json` (the `golden` script), `src/lib/ipc.ts`, `src/features/settings/SettingsPage.tsx`, `.storybook/fake/db.ts`, five `CLAUDE.md`s and `docs/reference/import-export.md`.

## Dependency graph and dispatch waves

```
Wave 1 (parallel, disjoint files)
  T1 golden corpus + TS fence        T2 Rust Card        T5 Rust csv
  T7 mirror paths                    T11 settings storage

Wave 2 (parallel)
  T3 Rust fields  (needs T2)         T9 mirror read  (needs T2)
  T8 mirror layout (needs T7)        T13 frontend panel (needs T11)

Wave 3 (parallel)
  T4 Rust fold    (needs T2, T3)     T10 mirror run  (needs T7, T8, T9 — stub the writer)

Wave 4 (sequential)
  T6 Rust writer + golden conformance (needs T1, T3, T4, T5)
  T12 change detection + wiring       (needs T10, T11 — TOUCHES lib.rs)
  T14 live verification pass
  T15 documentation
```

**Two subagents must never edit one file.** `lib.rs`, `sync.rs` and `Cargo.toml` are touched **only** by T12; every earlier task that needs a module declared writes its module and says so in its report, and T12 declares them all in one edit. Tasks must **not** commit — the git index is shared across agents in one worktree; the controller commits after each wave's fan-in and `npm run verify`.

---

### Task 1: The shared corpus and the golden fence

**Files:**
- Create: `src/features/transfer/__golden__/corpus.json`
- Create: `scripts/golden.mjs`
- Create: `src/features/transfer/golden.test.ts`
- Modify: `package.json` (add the `golden` script)
- Generated: `src/features/transfer/__golden__/*.txt` (70 files, committed)

**Interfaces:**
- Produces: `corpus.json` — `{ scenarios: Record<string, { surface: "deck"|"collection"|"wishlist", cards: TransferCard[] }> }`, where every card names **all 28 `TransferCard` fields explicitly** (no omissions, no `undefined`). Task 2's Rust struct deserialises this file with `deny_unknown_fields`, so an added TypeScript field that Rust lacks is a red cargo test.
- Produces: golden filenames — `__golden__/<scenario>.<format>.<fieldset>.txt`, where `<fieldset>` is `all` (`availableFields(format, surface)`) or `default` (`defaultFields(format, surface)`). Task 6 reads these exact names.

**Scenarios (five, and every one earns its place):**

| Scenario | Surface | Holds |
| --- | --- | --- |
| `deck` | `deck` | The section and folding cases — see below |
| `collection` | `collection` | Every collection-only field populated, plus the CSV quoting cases |
| `wishlist` | `wishlist` | The narrow surface: a null `setCode`, a null `collectorNumber` |
| `empty` | `deck` | `cards: []` — every format must answer `""` |
| `allMaybeboard` | `deck` | Every row `categoryActive: false` — Arena and MTGO must answer `""` |

The `deck` scenario must contain, at minimum: a Commander row; a Companion row; two Main-deck rows of the same printing differing only in `finish` (folding); a Sideboard row of the same printing as a Main row (the discriminator — these must **not** fold); a row with `categoryActive: false` (`{noDeck}` and the maybeboard); a row named `Branchloft Pathway // Boulderloft Pathway` (a `//` name nothing may cut); a row with `tagName: "Cut candidate"` and `tagColor: "#4aab08"`; a row with a `tagName` and `tagColor: null`; a row named `Æther Vial` (non-ASCII).

The `collection` scenario must contain: a row whose `name` is `"Ach! Hans, Run!"` (an embedded double quote); a row whose `notes` contain a comma; a row whose `notes` contain a `\n`; two rows identical except `condition` (they fold when Condition is off and separate when it is on); rows exercising every one of `altered`/`signed`/`proxy`/`misprint` as `true` and as `false`.

- [ ] **Step 1: Write `corpus.json`**

Hand-write it. Every card object lists all 28 fields. Use this shape (one card shown; write the rest to the table above):

```json
{
  "scenarios": {
    "deck": {
      "surface": "deck",
      "cards": [
        {
          "name": "Bruna, Light of Alabaster",
          "quantity": 1,
          "setCode": "AVR",
          "collectorNumber": "5",
          "finish": null,
          "lang": "en",
          "categoryName": "Commander",
          "categoryKind": "commander",
          "categoryActive": true,
          "condition": null,
          "tradelistQuantity": null,
          "purchasePrice": null,
          "purchaseCurrency": null,
          "acquiredAt": null,
          "acquisitionSource": null,
          "serialNumber": null,
          "grading": null,
          "altered": null,
          "signed": null,
          "proxy": null,
          "misprint": null,
          "tags": null,
          "notes": null,
          "setName": "Avacyn Restored",
          "rarity": "mythic",
          "typeLine": "Legendary Creature — Angel",
          "unitPrice": 4.31,
          "tagName": null,
          "tagColor": null,
          "legalities": null
        }
      ]
    }
  }
}
```

- [ ] **Step 2: Write `scripts/golden.mjs`**

```js
// Regenerates the golden files from the TypeScript writer, which is the behaviour of record.
// Run with `npm run golden`. Both suites then assert byte equality against what this wrote.
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatExport } from "../src/features/transfer/export/format.ts";
import { availableFields, defaultFields } from "../src/features/transfer/fields.ts";
import { EXPORT_FORMATS } from "../src/features/transfer/formats.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src/features/transfer/__golden__");
const corpus = JSON.parse(readFileSync(join(DIR, "corpus.json"), "utf8"));

for (const name of readdirSync(DIR)) if (name.endsWith(".txt")) unlinkSync(join(DIR, name));

let written = 0;
for (const [scenario, { surface, cards }] of Object.entries(corpus.scenarios)) {
  for (const format of EXPORT_FORMATS) {
    for (const [setName, fields] of [
      ["all", availableFields(format, surface)],
      ["default", defaultFields(format, surface)],
    ]) {
      writeFileSync(
        join(DIR, `${scenario}.${format}.${setName}.txt`),
        formatExport(cards, format, fields),
        "utf8",
      );
      written += 1;
    }
  }
}
console.log(`wrote ${written} golden files`);
```

`.ts` imports run under `node --experimental-strip-types`; if that fails on the installed Node, run it through `vite-node` instead — decide by running it, and record which in the file's header comment.

- [ ] **Step 3: Add the npm script**

In `package.json` `"scripts"`: `"golden": "node --experimental-strip-types scripts/golden.mjs"`.

- [ ] **Step 4: Generate and eyeball the output**

Run: `npm run golden`
Expected: `wrote 70 golden files`. Open `deck.archidekt.all.txt` and confirm it has category headings, `1x` quantities, lowercase set codes, a `{noDeck}` bracket and a `^Cut candidate,#4aab08^` group. Open `collection.csv.all.txt` and confirm the quoted cells. Open `empty.plain.all.txt` and confirm it is **zero bytes**.

- [ ] **Step 5: Write the golden test**

Create `src/features/transfer/golden.test.ts`:

```ts
/**
 * The fence between this writer and the one in `src-tauri/src/transfer/`.
 *
 * These files are generated by `npm run golden` and committed. This suite asserts the
 * TypeScript writer still reproduces them; `src-tauri/src/transfer/write.rs`'s own suite
 * asserts the Rust writer reproduces the same bytes. A change to either writer is a red
 * suite, which is the whole point.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatExport } from "./export/format";
import { availableFields, defaultFields } from "./fields";
import { EXPORT_FORMATS, type ExportFormat } from "./formats";
import { parseDecklist } from "./import/parse";
import type { TransferCard } from "./TransferCard";
import type { TransferSurface } from "./fields";

const DIR = join(__dirname, "__golden__");
const corpus: { scenarios: Record<string, { surface: TransferSurface; cards: TransferCard[] }> } =
  JSON.parse(readFileSync(join(DIR, "corpus.json"), "utf8"));

const CASES = Object.entries(corpus.scenarios).flatMap(([scenario, { surface, cards }]) =>
  EXPORT_FORMATS.flatMap((format) =>
    (["all", "default"] as const).map((setName) => ({
      file: `${scenario}.${format}.${setName}.txt`,
      cards,
      format,
      fields: setName === "all" ? availableFields(format, surface) : defaultFields(format, surface),
    })),
  ),
);

describe("the golden corpus", () => {
  it("has a file for every scenario, format and field set, and no others", () => {
    const onDisk = readdirSync(DIR).filter((n) => n.endsWith(".txt")).sort();
    expect(onDisk).toEqual(CASES.map((c) => c.file).sort());
  });

  it.each(CASES)("reproduces $file", ({ file, cards, format, fields }) => {
    expect(formatExport(cards, format, fields)).toBe(readFileSync(join(DIR, file), "utf8"));
  });
});

/** TCGplayer is the one write-only format — `parse.ts`'s bracket group is anchored to the end
 *  of the line, so `2 Bolt [2X2] 117` reads back as one long card name. */
const READABLE = EXPORT_FORMATS.filter((f): f is ExportFormat => f !== "tcgplayer" && f !== "csv");

describe("what the mirror writes, the app can read", () => {
  it.each(READABLE)("parses the deck scenario back out of %s", (format) => {
    const text = readFileSync(join(DIR, `deck.${format}.all.txt`), "utf8");
    const parsed = parseDecklist(text);
    expect(parsed.issues.filter((i) => i.kind !== "info")).toEqual([]);
    expect(parsed.lines.length).toBeGreaterThan(0);
    for (const line of parsed.lines) expect(line.name).not.toBe("");
  });
});
```

Adjust the two `parsed.*` property names to whatever `ParsedList` actually declares (`parse.ts:178`) — read it, do not guess. If `issues` has no `kind` discriminator, assert `parsed.issues` is empty instead.

- [ ] **Step 6: Run the suite**

Run: `npx vitest run src/features/transfer/golden.test.ts`
Expected: PASS, 71+ assertions.

- [ ] **Step 7: Mutation-test the fence**

Change `LINE_SPEC.archidekt.quantitySuffix` in `format.ts` from `"x"` to `""`, re-run the suite, and confirm the `deck.archidekt.*` cases go **red**. Put it back. Report the result — if the fence stayed green, it is not a fence and the task is not done.

- [ ] **Step 8: Report** (do not commit — the controller commits after `npm run verify`)

---

### Task 2: `transfer::Card` in Rust

**Files:**
- Create: `src-tauri/src/transfer/mod.rs`
- Create: `src-tauri/src/transfer/card.rs`
- Test: inline `#[cfg(test)]` in `card.rs`

**Interfaces:**
- Consumes: `src/features/transfer/__golden__/corpus.json` from Task 1.
- Produces: `pub struct Card` with all 28 fields, `#[derive(Debug, Clone, Deserialize)]`, `#[serde(rename_all = "camelCase", deny_unknown_fields)]`. Field names and types are the Rust spelling of `TransferCard.ts`: `String` for `name`, `i64` for `quantity`, `Option<String>` for every nullable string, `Option<i64>` for `tradelistQuantity`, `Option<f64>` for `purchasePrice`/`unitPrice`, `Option<bool>` for `altered`/`signed`/`proxy`/`misprint`/`categoryActive`.
- Produces: `pub enum Surface { Deck, Collection, Wishlist }` and `pub enum Format { Plain, Mtgo, Arena, Moxfield, Archidekt, Tcgplayer, Csv }` in `mod.rs`, both `Copy`, both with `pub const ALL: [Self; N]`, and `Format::extension(self) -> &'static str` returning `"csv"` for `Csv` and `"txt"` for the rest.
- Produces: `pub fn load_corpus(path: &Path) -> Scenarios` for tests, where `pub type Scenarios = BTreeMap<String, Scenario>` and `pub struct Scenario { pub surface: Surface, pub cards: Vec<Card> }`.

`finish` is `Option<String>` and not an enum: `TransferCard.finish` is `DeckFinish`, which is `"foil" | "etched" | null`, and the writer only ever compares it to those two words.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// The corpus is TypeScript's, and this is the one place the two card shapes meet.
    /// `deny_unknown_fields` is what makes a field added on that side a red build here
    /// rather than a column silently missing from every mirrored CSV.
    fn corpus_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/features/transfer/__golden__/corpus.json")
    }

    #[test]
    fn every_scenario_in_the_shared_corpus_deserialises() {
        let scenarios = load_corpus(&corpus_path());
        assert!(
            scenarios.contains_key("deck") && scenarios.contains_key("collection"),
            "the corpus lost a scenario this suite depends on"
        );
        assert!(scenarios["empty"].cards.is_empty());
        let deck = &scenarios["deck"];
        assert_eq!(deck.surface, Surface::Deck);
        assert!(
            deck.cards.iter().any(|c| c.name.contains("//")),
            "the corpus must keep a split card name"
        );
    }

    #[test]
    fn a_field_typescript_has_and_rust_does_not_is_an_error() {
        let json = r#"{"scenarios":{"x":{"surface":"deck","cards":[
            {"name":"Bolt","quantity":1,"aFieldRustDoesNotKnow":true}]}}}"#;
        assert!(serde_json::from_str::<CorpusFile>(json).is_err());
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && cargo test transfer::card`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `card.rs` and `mod.rs`**

Port `src/features/transfer/TransferCard.ts`'s interface field for field. Carry over its two load-bearing doc comments: `null` means *this surface does not have this fact*, never "empty"; and `tags` (the collection's free text) is not `tag_name` (a `deck_tags` row).

- [ ] **Step 4: Declare the module**

Add `mod transfer;` to `src-tauri/src/lib.rs` **only if `lib.rs` is not already claimed by another running task** — if it is, note it in your report and let Task 12 do it. Check first: `grep -n "^mod \|^pub mod " src-tauri/src/lib.rs`.

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri && cargo test transfer::card`
Expected: PASS, 2 tests. Report the **selected test count** — a filter that matched nothing also exits 0.

- [ ] **Step 6: Mutation-test**

Remove `deny_unknown_fields` and confirm the second test fails. Put it back.

- [ ] **Step 7: Report** (do not commit)

---

### Task 3: The Rust field registry

**Files:**
- Create: `src-tauri/src/transfer/fields.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `Card`, `Surface`, `Format` from Task 2.
- Produces: `pub enum FieldId` with one variant per entry of `TRANSFER_FIELD_IDS` **in that array's order** — the order is CSV's column order and is load-bearing. `pub const FIELD_IDS: [FieldId; N]` in the same order.
- Produces: `pub fn csv_header(id: FieldId) -> &'static str` and `pub fn read(id: FieldId, card: &Card) -> String`.
- Produces: `pub fn available_fields(format: Format, surface: Surface) -> Vec<FieldId>` and `pub fn default_fields(format: Format, surface: Surface) -> Vec<FieldId>`, both filtered back into `FIELD_IDS` order.

**Port `src/features/transfer/fields.ts` exactly.** Three rules from that file must survive the port and each gets a test:
1. `read` answers `""` when the card has nothing to say — that is what an empty cell means.
2. `flag` answers `"yes"`/`"no"`/`""` for `Some(true)`/`Some(false)`/`None`. `num` answers `""` for `None`.
3. `available_fields` is the **intersection** of what the format offers (plus the two `ALWAYS` fields) and what the surface holds, in `FIELD_IDS` order.

There is no `label` in Rust: labels are the export dialog's, and the dialog stays TypeScript. Porting them would create a second place for a word to drift with nothing reading it.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_intersection_is_the_registry_order_not_the_declaration_order() {
    let got = available_fields(Format::Csv, Surface::Collection);
    let mut sorted = got.clone();
    sorted.sort_by_key(|f| FIELD_IDS.iter().position(|x| x == f).unwrap());
    assert_eq!(got, sorted, "a CSV's columns must come out in registry order");
}

#[test]
fn a_deck_offers_no_condition_and_a_wishlist_offers_no_category() {
    assert!(!available_fields(Format::Csv, Surface::Deck).contains(&FieldId::Condition));
    assert!(!available_fields(Format::Csv, Surface::Wishlist).contains(&FieldId::Category));
    assert!(available_fields(Format::Csv, Surface::Collection).contains(&FieldId::Condition));
}

#[test]
fn archidekt_offers_the_label_and_not_its_colour() {
    let f = available_fields(Format::Archidekt, Surface::Deck);
    assert!(f.contains(&FieldId::Tag), "the caret group is Archidekt's own");
    assert!(!f.contains(&FieldId::TagColor), "the colour rides inside the group");
}

#[test]
fn mtgo_offers_nothing_optional_at_all() {
    assert_eq!(
        available_fields(Format::Mtgo, Surface::Deck),
        vec![FieldId::Quantity, FieldId::Name]
    );
}

#[test]
fn absence_reads_as_an_empty_cell_and_a_false_flag_reads_as_no() {
    let card = Card { altered: Some(false), proxy: None, notes: None, ..sample() };
    assert_eq!(read(FieldId::Altered, &card), "no");
    assert_eq!(read(FieldId::Proxy, &card), "");
    assert_eq!(read(FieldId::Notes, &card), "");
}
```

Write `fn sample() -> Card` beside them, returning a card with every field `None` but `name`/`quantity`.

- [ ] **Step 2: Run and watch them fail.** `cd src-tauri && cargo test transfer::fields` — FAIL, module missing.
- [ ] **Step 3: Port `fields.ts`.**
- [ ] **Step 4: Run.** Expected PASS, 5 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — move `tag` ahead of `finish` in `FIELD_IDS` and confirm the order test fails. Put it back.
- [ ] **Step 6: Report** (do not commit)

---

### Task 4: The Rust fold

**Files:**
- Create: `src-tauri/src/transfer/fold.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `Card` (T2), `FieldId`/`read` (T3).
- Produces: `pub fn fold_for_fields(cards: &[Card], fields: &[FieldId], discriminator: Option<&dyn Fn(&Card) -> String>) -> Vec<Card>`.

**Port `src/features/transfer/export/fold.ts`.** Its rules, each of which gets a test:
- `quantity` and `tradelist_quantity` are **summed, never keyed on**.
- Insertion order is preserved — the caller's order is the file's order. Rust has no ordered `HashMap`, and adding `indexmap` for this is not worth a dependency: keep a `Vec<Card>` for the output and a `HashMap<Vec<String>, usize>` from key to its index in that vector.
- The key is the read value of each keyed field **plus the discriminator's answer**, as a `Vec<String>`. TypeScript uses `JSON.stringify` to escape; a `Vec<String>` needs no escaping at all, which is the same guarantee reached more cheaply. Do **not** join with a separator.
- `tradelist_quantity`: `None` is absence, not poison. A group where every row is `None` stays `None`; one known value anywhere in the group survives.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn two_rows_the_chosen_fields_cannot_tell_apart_become_one() {
    let cards = vec![nm_bolt(), lp_bolt()];               // differ only in condition
    let folded = fold_for_fields(&cards, &[FieldId::Quantity, FieldId::Name], None);
    assert_eq!(folded.len(), 1);
    assert_eq!(folded[0].quantity, 3);                     // 2 + 1
}

#[test]
fn and_separate_again_the_moment_condition_is_on() {
    let cards = vec![nm_bolt(), lp_bolt()];
    let folded = fold_for_fields(
        &cards,
        &[FieldId::Quantity, FieldId::Name, FieldId::Condition],
        None,
    );
    assert_eq!(folded.len(), 2);
}

#[test]
fn a_discriminator_stops_a_sideboard_row_folding_into_a_main_deck_one() {
    let cards = vec![main_bolt(), side_bolt()];            // same printing, different pile
    let section = |c: &Card| c.category_kind.clone().unwrap_or_default();
    let folded = fold_for_fields(&cards, &[FieldId::Quantity, FieldId::Name], Some(&section));
    assert_eq!(folded.len(), 2, "a fold may never cross a line the file itself draws");
}

#[test]
fn the_callers_order_is_the_files_order() {
    let cards = vec![shock(), nm_bolt(), lp_bolt()];
    let folded = fold_for_fields(&cards, &[FieldId::Quantity, FieldId::Name], None);
    assert_eq!(folded[0].name, "Shock", "insertion order must survive the fold");
}

#[test]
fn a_tradelist_quantity_is_summed_and_absence_never_suppresses_a_known_value() {
    let a = Card { tradelist_quantity: None, ..nm_bolt() };
    let b = Card { tradelist_quantity: Some(2), ..nm_bolt() };
    let folded = fold_for_fields(&[a, b], &[FieldId::Quantity, FieldId::Name], None);
    assert_eq!(folded[0].tradelist_quantity, Some(2));

    let both_none = vec![Card { tradelist_quantity: None, ..nm_bolt() }; 2];
    let folded = fold_for_fields(&both_none, &[FieldId::Quantity, FieldId::Name], None);
    assert_eq!(folded[0].tradelist_quantity, None, "a surface without the fact keeps None");
}
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Port `fold.ts`.**
- [ ] **Step 4: Run.** Expected PASS, 5 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — make the key include `quantity` and confirm the first test fails. Put it back.
- [ ] **Step 6: Report** (do not commit)

---

### Task 5: The Rust CSV writer

**Files:**
- Create: `src-tauri/src/transfer/csv.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces: `pub fn csv_field(value: &str) -> String` and `pub fn csv_row(values: &[String]) -> String`.

**Port the writer half of `src/features/transfer/csv.ts` and nothing else.** `parseCsv` does not move — the mirror never reads a file, and a reader here would exist only to be tested.

The rule, verbatim from that file: a field is quoted when it carries a comma, a quote, a newline or a carriage return, and **never otherwise** — so `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row. An inner quote doubles.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_plain_value_is_not_quoted() {
    assert_eq!(csv_field("Lightning Bolt"), "Lightning Bolt");
}

#[test]
fn a_comma_a_quote_a_newline_and_a_carriage_return_each_force_quoting() {
    assert_eq!(csv_field("Borrowing 100,000 Arrows"), "\"Borrowing 100,000 Arrows\"");
    assert_eq!(csv_field("Ach! Hans, Run!"), "\"Ach! Hans, Run!\"");
    assert_eq!(csv_field("a\nb"), "\"a\nb\"");
    assert_eq!(csv_field("a\rb"), "\"a\rb\"");
}

#[test]
fn an_inner_quote_doubles() {
    assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
}

#[test]
fn a_row_joins_with_commas_and_quotes_only_what_needs_it() {
    let row = csv_row(&["1".into(), "Bolt".into(), "a,b".into()]);
    assert_eq!(row, "1,Bolt,\"a,b\"");
}
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Write `csv.rs`.**
- [ ] **Step 4: Run.** Expected PASS, 4 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — quote unconditionally and confirm the first test fails. Put it back.
- [ ] **Step 6: Report** (do not commit)

---

### Task 6: The Rust writer, and the golden conformance suite

**Files:**
- Create: `src-tauri/src/transfer/write.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `Card`/`Surface`/`Format` (T2), `fields` (T3), `fold_for_fields` (T4), `csv_row` (T5), the golden files (T1).
- Produces: `pub fn format_export(cards: &[Card], format: Format, fields: &[FieldId]) -> String` and `pub fn omitted_count(cards: &[Card], format: Format) -> i64`.

**Port `src/features/transfer/export/format.ts`.** Every rule in that file's doc comments is a rule here; these are the ones that have a test each, because each is a way the port can be subtly wrong:

- **Filter first, fold second.** Folding first can merge a switched-off row into a switched-on one — the folded row inherits the *first* card's `category_active` — so an Arena export would carry copies `omitted_count` reports as omitted in the same breath.
- `ACTIVE_ONLY` is `{Arena, Mtgo}` and the test is `category_active == Some(false)`, **never the kind**. A reader's own switched-off `Ramp` behaves exactly like the Maybeboard.
- `KIND_SECTION` maps `maybe` to `"Deck"`, not to `"Maybeboard"`. A switched-**on** pile whose kind is `maybe` counts toward the deck. `section_of` is where a switched-*off* pile becomes the maybeboard, and it asks `category_active`.
- `SECTION_ORDER` is `Commander, Companion, Deck, Sideboard, Maybeboard` — the order a decklist is read in, deliberately not alphabetical.
- MTGO writes `SB: ` as a one-line prefix on a Sideboard or Companion card, not a heading, and names no printing at all.
- Archidekt groups by the reader's own category name in **first-appearance order** and is the only format that can say `{noDeck}`; its set code is lowercase and its quantity carries `x`.
- TCGplayer wraps the set in `[…]`, is flat, and **keeps** a switched-off pile.
- `DISCRIMINATOR` is total over `Format`: Arena/Moxfield/MTGO key on `section_of`, Archidekt on the pair `(category_name, category_active)`, and Plain/TCGplayer/CSV key on nothing. Model it as a `match` returning `Option<Box<dyn Fn…>>` — a `match` with no wildcard arm, so a format added later fails to compile rather than folding with no discriminator.
- An empty result is `""` in every format, CSV header included, and every non-empty result ends in exactly one `\n`.

- [ ] **Step 1: Write the failing conformance test**

```rust
/// The fence. `npm run golden` writes these files from the TypeScript writer; this asserts
/// the Rust one reproduces them byte for byte. A drift in either is red here.
#[test]
fn every_golden_file_is_reproduced_byte_for_byte() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/features/transfer/__golden__");
    let scenarios = crate::transfer::card::load_corpus(&dir.join("corpus.json"));

    let mut checked = 0usize;
    for (name, scenario) in &scenarios {
        for format in Format::ALL {
            for (set_name, fields) in [
                ("all", available_fields(format, scenario.surface)),
                ("default", default_fields(format, scenario.surface)),
            ] {
                let file = dir.join(format!("{name}.{}.{set_name}.txt", format.key()));
                let expected = std::fs::read_to_string(&file)
                    .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
                assert_eq!(
                    format_export(&scenario.cards, format, &fields),
                    expected,
                    "{} disagrees with the TypeScript writer",
                    file.display()
                );
                checked += 1;
            }
        }
    }
    assert_eq!(checked, 70, "the golden matrix changed size without this test noticing");
}
```

`Format::key()` returns the format's wire word (`"plain"`, `"mtgo"`, …) matching `EXPORT_FORMATS` in `src/features/transfer/formats.ts`. Add it in this task if Task 2 did not.

- [ ] **Step 2: Run and watch it fail.** `cd src-tauri && cargo test transfer::write` — FAIL, module missing.

- [ ] **Step 3: Write the targeted tests too**, before implementing. These are what tell you *which* rule broke when the golden test says only that a file disagrees:

```rust
#[test]
fn arena_filters_before_it_folds() {
    // One printing, two rows: one in a switched-on pile, one switched off. Folding first
    // would merge them and carry the omitted copy into the file.
    let cards = vec![active_bolt(2), inactive_bolt(3)];
    let text = format_export(&cards, Format::Arena, &[FieldId::Quantity, FieldId::Name]);
    assert!(text.contains("2 Lightning Bolt"), "got: {text}");
    assert!(!text.contains("5 Lightning Bolt"), "the maybeboard copies leaked in: {text}");
    assert_eq!(omitted_count(&cards, Format::Arena), 3);
}

#[test]
fn a_switched_on_maybe_pile_writes_under_deck_and_a_switched_off_ramp_does_not() {
    let on = Card { category_kind: Some("maybe".into()), category_active: Some(true), ..bolt() };
    let off = Card {
        category_name: Some("Ramp".into()),
        category_kind: Some("main".into()),
        category_active: Some(false),
        ..shock()
    };
    let text = format_export(&[on, off], Format::Moxfield, &[FieldId::Quantity, FieldId::Name]);
    let deck = text.find("Deck").unwrap();
    let maybe = text.find("Maybeboard").unwrap();
    assert!(deck < maybe);
    assert!(text[deck..maybe].contains("Lightning Bolt"));
    assert!(text[maybe..].contains("Shock"));
}

#[test]
fn mtgo_prefixes_a_sideboard_card_and_names_no_printing() {
    let text = format_export(&[side_bolt()], Format::Mtgo, &[FieldId::Quantity, FieldId::Name]);
    assert_eq!(text, "SB: 1 Lightning Bolt\n");
}

#[test]
fn an_empty_list_is_an_empty_string_in_every_format_csv_included() {
    for format in Format::ALL {
        assert_eq!(format_export(&[], format, &FIELD_IDS), "", "{format:?}");
    }
}

#[test]
fn a_deck_that_is_entirely_maybeboard_is_empty_in_arena_rather_than_a_heading_over_nothing() {
    let text = format_export(&[inactive_bolt(1)], Format::Arena, &[FieldId::Quantity, FieldId::Name]);
    assert_eq!(text, "");
}

#[test]
fn every_non_empty_file_ends_in_exactly_one_newline() {
    for format in Format::ALL {
        let text = format_export(&[bolt()], format, &FIELD_IDS);
        assert!(text.ends_with('\n') && !text.ends_with("\n\n"), "{format:?}: {text:?}");
    }
}
```

- [ ] **Step 4: Port `format.ts`.**

- [ ] **Step 5: Run everything.**

Run: `cd src-tauri && cargo test transfer::`
Expected: PASS. Report the selected test count and confirm the golden test says `checked == 70`.

- [ ] **Step 6: Mutation-test the port** — swap `SECTION_ORDER`'s `Sideboard` and `Deck`, confirm the golden test goes red, put it back. Then change `KIND_SECTION`'s `maybe` arm to `"Maybeboard"` and confirm the switched-on-maybe test goes red. Put it back. **Report both. If either survived, say so — a green suite over a broken port is the failure mode this whole fence exists to prevent.**

- [ ] **Step 7: Report** (do not commit)

---

### Task 7: Names on disk — sanitise, disambiguate, prune

**Files:**
- Create: `src-tauri/src/mirror/mod.rs`, `src-tauri/src/mirror/paths.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces: `pub fn sanitise(name: &str) -> String`
- Produces: `pub fn disambiguate(named: &[(i64, String)]) -> Vec<String>` — takes `(id, raw name)` pairs **already in id order** and returns the on-disk name for each, sanitising and then suffixing collisions.
- Produces: `pub fn is_ours(file_name: &str) -> bool` — the prune predicate.

**Sanitising:** `<`, `>`, `:`, `"`, `/`, `\`, `|`, `?`, `*` and every control character (`c.is_control()`) become `-`. Trailing dots and spaces are trimmed (Windows silently drops them, so a folder created with one is not the folder you later look for). An empty result becomes `Untitled`. A result whose stem case-insensitively equals a Windows device name — `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9` — gets a trailing `_`. Nothing else is touched: NTFS takes Unicode and a deck called `Æther Vial` is a folder called `Æther Vial`.

**Disambiguating:** sort is the caller's (id order). The first claimant of a sanitised name keeps it; the *n*th gets ` (n)`. Sanitising can create a collision that did not exist (`A/B` and `A-B` both become `A-B`), which is why suffixing runs after it and over the sanitised names.

**`is_ours`:** true for a name ending `.txt` or `.csv`. This is the whole prune fence and it is deliberately crude — the root is user-choosable, so a file the reader dropped in must survive, and every file this app writes ends in one of those two.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_nine_illegal_characters_and_every_control_character_become_dashes() {
    assert_eq!(sanitise("Red/Blue: Aggro?"), "Red-Blue- Aggro-");
    assert_eq!(sanitise("a\u{0}b\tc"), "a-b-c");
}

#[test]
fn unicode_survives_untouched() {
    assert_eq!(sanitise("Æther Vial"), "Æther Vial");
    assert_eq!(sanitise("Théoden"), "Théoden");
}

#[test]
fn a_trailing_dot_or_space_is_trimmed_because_windows_drops_it_silently() {
    assert_eq!(sanitise("Aggro."), "Aggro");
    assert_eq!(sanitise("Aggro "), "Aggro");
    assert_eq!(sanitise("Aggro. . "), "Aggro");
}

#[test]
fn a_name_that_sanitises_to_nothing_becomes_untitled() {
    assert_eq!(sanitise(""), "Untitled");
    assert_eq!(sanitise("..."), "Untitled");
}

#[test]
fn every_windows_device_name_gets_a_suffix_case_insensitively() {
    for name in ["CON", "con", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"] {
        assert_eq!(sanitise(name), format!("{name}_"), "{name} is a reserved device name");
    }
    assert_eq!(sanitise("CONTROL"), "CONTROL", "only the exact names are reserved");
}

#[test]
fn the_first_claimant_keeps_the_name_and_the_rest_are_numbered_by_id() {
    let got = disambiguate(&[(1, "Aggro".into()), (7, "Aggro".into()), (9, "Aggro".into())]);
    assert_eq!(got, vec!["Aggro", "Aggro (2)", "Aggro (3)"]);
}

#[test]
fn adding_a_deck_never_renames_the_ones_already_on_disk() {
    let before = disambiguate(&[(1, "Aggro".into()), (7, "Aggro".into())]);
    let after = disambiguate(&[(1, "Aggro".into()), (7, "Aggro".into()), (9, "Aggro".into())]);
    assert_eq!(after[..2], before[..], "a reader's shortcut into that folder must keep working");
}

#[test]
fn a_collision_that_only_sanitising_creates_is_still_disambiguated() {
    let got = disambiguate(&[(1, "A/B".into()), (2, "A-B".into())]);
    assert_eq!(got, vec!["A-B", "A-B (2)"]);
}

#[test]
fn pruning_claims_only_the_two_extensions_this_app_writes() {
    assert!(is_ours("Azula.archidekt.txt"));
    assert!(is_ours("Collection.csv"));
    assert!(!is_ours("my notes.md"));
    assert!(!is_ours("Azula.png"));
    assert!(!is_ours("README"));
}
```

- [ ] **Step 2: Run and watch them fail.** `cd src-tauri && cargo test mirror::paths`
- [ ] **Step 3: Implement `paths.rs`.**
- [ ] **Step 4: Run.** Expected PASS, 9 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — make `disambiguate` suffix the *first* claimant too and confirm the stability test fails. Put it back.
- [ ] **Step 6: Report** (do not commit)

---

### Task 8: The layout — what files exist, and where

**Files:**
- Create: `src-tauri/src/mirror/layout.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `sanitise`/`disambiguate` (T7), `Format`/`Surface` (T2).
- Produces:

```rust
/// One file the mirror intends to exist, and where its cards come from.
pub struct PlannedFile {
    /// Relative to the mirror root, using `/` separators. Joined with `Path::join` at write time.
    pub path: String,
    pub format: Format,
    pub surface: Surface,
    pub source: Source,
}

/// Where a planned file's cards come from — resolved against the database by `read.rs`.
#[derive(Clone, PartialEq, Debug)]
pub enum Source {
    Deck { id: i64, variant: &'static str },
    WholeCollection,
    CollectionFolder { id: i64 },
    WholeWishlist,
    WishlistFolder { id: i64 },
}

pub struct Shape<'a> {
    pub decks: &'a [crate::deck::DeckRow],
    pub deck_folders: &'a [crate::deck_meta::DeckFolderRow],
    pub collection_folders: &'a [crate::collection_folders::CollectionFolder],
    pub wishlist_folders: &'a [crate::wishlist_folders::WishlistFolder],
}

pub fn plan_files(shape: &Shape) -> Vec<PlannedFile>;
```

**Pure — no `Connection`, no filesystem.** That is what makes the tree testable without a database, and it is why the shape is passed in.

**The rules:**
- A deck lives at `Decks/<its folder path>/<Deck name>/<Deck name>.<format>.txt`, with `plain` written as `<Deck name>.txt` (no format segment) since it is the format a reader opens first. An archived deck's path starts `Decks/Archived/` instead of `Decks/`, keeping its folder tree beneath that.
- A deck whose `theory_enabled` is true gets a second set under `<Deck name>/Theory/`, with `variant: "theory"`; the live set is always written, whatever the flag says.
- The collection's whole list is `Collection/Collection.<format>.txt`, source `WholeCollection`. Every collection folder is `Collection/<folder path>/<Folder name>.<format>.txt`, source `CollectionFolder { id }` — **including** the `deck`- and `removed`-kind folders, which are folders like any other.
- The wishlist mirrors the collection's shape with `Wishlist/`, `WholeWishlist` and `WishlistFolder { id }`.
- Folder paths nest by `parent_id`. Siblings are disambiguated **within their parent** — two folders called `Draft` under different parents are both `Draft`.
- A folder whose `parent_id` names a folder that is not in the slice is skipped, along with everything beneath it. A cycle (which the schema's `ON DELETE CASCADE` should make impossible) must terminate rather than recurse forever: track visited ids and stop.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_deck_gets_seven_files_and_the_plain_one_carries_no_format_segment() {
    let plan = plan_files(&shape_with_one_deck("Azula"));
    let paths: Vec<&str> = plan.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"Decks/Azula/Azula.txt"));
    assert!(paths.contains(&"Decks/Azula/Azula.archidekt.txt"));
    assert!(paths.contains(&"Decks/Azula/Azula.csv"));
    assert_eq!(plan.len(), 7);
}

#[test]
fn a_theory_list_is_a_second_set_beneath_the_deck_and_the_live_one_stays() {
    let plan = plan_files(&shape_with_theory_deck("Azula"));
    assert_eq!(plan.len(), 14);
    assert!(plan.iter().any(|f| f.path == "Decks/Azula/Theory/Azula.txt"
        && f.source == Source::Deck { id: 1, variant: "theory" }));
    assert!(plan.iter().any(|f| f.path == "Decks/Azula/Azula.txt"
        && f.source == Source::Deck { id: 1, variant: "live" }));
}

#[test]
fn an_archived_deck_keeps_its_folder_tree_beneath_archived() {
    let plan = plan_files(&shape_with_archived_deck_in_folder("Old", "Azula"));
    assert!(plan.iter().any(|f| f.path == "Decks/Archived/Old/Azula/Azula.txt"));
}

#[test]
fn the_collections_own_list_and_one_file_per_folder_including_the_automatic_ones() {
    let plan = plan_files(&shape_with_collection_folders());
    assert!(plan.iter().any(|f| f.path == "Collection/Collection.csv"
        && f.source == Source::WholeCollection));
    assert!(plan.iter().any(|f| f.path == "Collection/Recently removed/Recently removed.txt"));
    assert!(plan.iter().any(|f| f.path.starts_with("Collection/Azula/")),
        "a deck group is a folder like any other");
}

#[test]
fn two_folders_of_one_name_under_different_parents_are_both_themselves() {
    let plan = plan_files(&shape_with_two_draft_folders());
    assert!(plan.iter().any(|f| f.path == "Collection/Red/Draft/Draft.txt"));
    assert!(plan.iter().any(|f| f.path == "Collection/Blue/Draft/Draft.txt"));
}

#[test]
fn a_folder_whose_parent_is_missing_is_skipped_rather_than_planted_at_the_root() {
    let plan = plan_files(&shape_with_orphan_folder());
    assert!(!plan.iter().any(|f| f.path.contains("Orphan")));
}

#[test]
fn a_parent_cycle_terminates() {
    let plan = plan_files(&shape_with_folder_cycle());   // 1 -> 2 -> 1
    assert!(plan.len() < 1000, "a cycle must terminate rather than recurse");
}
```

Write the `shape_*` builders beside them, constructing the real row structs.

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement `layout.rs`.**
- [ ] **Step 4: Run.** Expected PASS, 7 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — drop the visited-id guard and confirm the cycle test fails (it will hang or blow the stack; treat a hang as a failure and put it back).
- [ ] **Step 6: Report** (do not commit)

---

### Task 9: Reading rows into `Card`s

**Files:**
- Create: `src-tauri/src/mirror/read.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `Card` (T2), `Source` (T8).
- Produces: `pub fn cards_for(conn: &Connection, source: &Source, marketplace: Marketplace) -> Result<Vec<Card>, String>`.

**Compose the existing readers; write no SQL.** Every command in this crate is a thin wrapper over a plain function:

| Source | Call |
| --- | --- |
| `Deck { id, variant }` | `crate::deck::get_deck(conn, id, variant, marketplace)?` → `DeckDetail.cards` |
| `WholeCollection` | `crate::collection::list_entries(conn, &q)` with `folder_id: None` |
| `CollectionFolder { id }` | the same with `folder_id: Some(id)` |
| `WholeWishlist` | `crate::wishlist::list_wishes(conn, &q)` with `flatten: true` |
| `WishlistFolder { id }` | the same with `folder_id: Some(id)`, `flatten: false` |

**The two surfaces mean opposite things by an absent `folder_id`, and getting this backwards is a silently wrong file.** `CollectionQuery::folder_id: None` means *every folder there is* — which is exactly what the whole-collection list wants. `WishlistQuery::folder_id: None` means *the root, and only the root* — so the whole-wishlist list must say `flatten: true` instead. Both are documented at their definitions; read them.

**Paging.** `list_entries` and `list_wishes` take `limit`/`offset`. Read in pages of `PAGE = 2_000` and stop on a **short page**, never on the reported total: a write landing mid-pass moves the total, and believing it either drops the tail or loops forever. This is the rule `src/features/transfer/export/scope.ts` already documents about its own sweep.

`allocation` stays absent (`None` → `Allocation::All`), so the mirror sees the copies a deck holds — a backup that hid them would be missing cards the reader owns.

The three row→`Card` conversions are the Rust twins of `fromDeckCard`, `fromCollectionRow` and `fromWishRow`. Carry the two traps: `finish_of` maps the collection's `"nonfoil"` to `None` (two spellings of one finish fold as two rows and write two lines naming the same card), and a `WishRow`'s finish comes from `preferred_finish`.

- [ ] **Step 1: Write the failing tests**

Build an in-memory database with `schema::migrate`, seed **user tables plus the two `cards` rows they need** (this is the exception the constraints allow: an in-memory connection dropped at the end of the test), then:

```rust
#[test]
fn a_deck_source_answers_the_variant_it_names() {
    let conn = db_with_deck_holding_live_and_theory_rows();
    let live = cards_for(&conn, &Source::Deck { id: 1, variant: "live" }, Marketplace::default()).unwrap();
    let theory = cards_for(&conn, &Source::Deck { id: 1, variant: "theory" }, Marketplace::default()).unwrap();
    assert_eq!(live.len(), 1);
    assert_eq!(theory.len(), 2);
}

#[test]
fn the_whole_collection_means_every_folder_and_a_folder_means_its_direct_members() {
    let conn = db_with_two_entries_one_filed();
    let all = cards_for(&conn, &Source::WholeCollection, Marketplace::default()).unwrap();
    let filed = cards_for(&conn, &Source::CollectionFolder { id: 1 }, Marketplace::default()).unwrap();
    assert_eq!(all.len(), 2, "an absent collection folder_id is every folder");
    assert_eq!(filed.len(), 1);
}

#[test]
fn the_whole_wishlist_means_every_folder_which_on_this_surface_takes_flatten() {
    let conn = db_with_two_wishes_one_filed();
    let all = cards_for(&conn, &Source::WholeWishlist, Marketplace::default()).unwrap();
    assert_eq!(all.len(), 2, "an absent wishlist folder_id is the ROOT — flatten is what says every folder");
}

#[test]
fn nonfoil_is_the_regular_copy_and_not_a_third_finish() {
    let conn = db_with_a_nonfoil_entry();
    let cards = cards_for(&conn, &Source::WholeCollection, Marketplace::default()).unwrap();
    assert_eq!(cards[0].finish, None, "two spellings of one finish would write two lines");
}

#[test]
fn a_collection_larger_than_one_page_is_read_whole() {
    let conn = db_with_n_entries(PAGE + 7);
    let cards = cards_for(&conn, &Source::WholeCollection, Marketplace::default()).unwrap();
    assert_eq!(cards.len() as u32, PAGE + 7);
}
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement `read.rs`.**
- [ ] **Step 4: Run.** Expected PASS, 5 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — set `flatten: false` on `WholeWishlist` and confirm the third test fails. Put it back. This is the exact mistake the asymmetry invites.
- [ ] **Step 6: Report** (do not commit)

---

### Task 10: The pass — render, hash, write, prune

**Files:**
- Create: `src-tauri/src/mirror/run.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `plan_files`/`Shape`/`PlannedFile` (T8), `cards_for` (T9), `format_export`/`available_fields` (T3, T6).
- Produces:

```rust
/// What one pass did. Every field is a number the Settings panel and the tests both read.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct PassReport {
    pub written: usize,
    pub unchanged: usize,
    pub pruned: usize,
    pub failed: usize,
}

/// Which surfaces this pass is responsible for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dirty { pub decks: bool, pub collection: bool, pub wishlist: bool }
impl Dirty { pub const ALL: Self = Self { decks: true, collection: true, wishlist: true }; }

pub fn run_pass(conn: &Connection, root: &Path, dirty: Dirty) -> Result<PassReport, String>;
```

**The shape of a pass:**
1. Read the four folder/deck listings (`deck::list_decks`, `deck_meta::list_folders`, `collection_folders::list_folders`, `wishlist_folders::list_folders`) and the stored marketplace (`marketplace::stored`).
2. `plan_files`, then keep only the planned files whose surface is dirty.
3. For each: `cards_for` → `format_export(cards, format, &available_fields(format, surface))` — **every optional field on, which is what `available_fields` already answers**.
4. Hash the rendered bytes and compare against the file on disk. Read the existing file and hash it rather than trusting an in-memory map: a session that started with an empty map would rewrite the whole mirror at every launch. Cache the digest per path in a `HashMap<String, u64>` passed in by the caller so later passes in the same session skip the read too.
5. Write only what differs, creating parent directories as needed.
6. Write `README.txt` at the root (below).
7. Prune: walk the root, and delete any file where `is_ours(name)` and the path is not in **the full plan** — not merely in the dirty subset, or a pass over one surface would delete the other two. Then remove directories that are now empty, deepest first. Never delete the root itself, and never delete `README.txt`.
8. A single file that fails to render or write increments `failed` and does not abort the pass. One unwritable file is not a reason to abandon the other 349.

**`README.txt`** is a `const` in this file. It must say: what the folder is; that it is generated and rewritten; that edits are overwritten; that the app never reads it back; that `*.arena.txt` and `*.mtgo.txt` leave out switched-off piles because those formats have no maybeboard; that `*.arena.txt` lists every card and so is not a valid Arena import for a paper collection; and that deleting the whole folder is safe and it will rebuild.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_pass_writes_the_files_the_plan_names() {
    let (conn, dir) = seeded_db_and_temp_root();
    let report = run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    assert!(dir.path().join("Decks/Azula/Azula.txt").is_file());
    assert!(dir.path().join("Collection/Collection.csv").is_file());
    assert!(dir.path().join("README.txt").is_file());
    assert!(report.written > 0 && report.failed == 0);
}

#[test]
fn a_second_pass_over_unchanged_data_opens_nothing_for_writing() {
    let (conn, dir) = seeded_db_and_temp_root();
    run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    let before = mtime(&dir.path().join("Decks/Azula/Azula.txt"));
    let report = run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    assert_eq!(report.written, 0, "hash-comparison must skip identical files");
    assert!(report.unchanged > 0);
    assert_eq!(mtime(&dir.path().join("Decks/Azula/Azula.txt")), before);
}

#[test]
fn a_renamed_deck_leaves_nothing_behind() {
    let (conn, dir) = seeded_db_and_temp_root();
    run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    conn.execute("UPDATE decks SET name = 'Katara' WHERE id = 1", []).unwrap();
    run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    assert!(dir.path().join("Decks/Katara/Katara.txt").is_file());
    assert!(!dir.path().join("Decks/Azula").exists(), "the old directory must go");
}

#[test]
fn a_file_the_reader_dropped_in_survives_a_prune() {
    let (conn, dir) = seeded_db_and_temp_root();
    run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    let theirs = dir.path().join("Decks/my notes.md");
    std::fs::write(&theirs, b"mine").unwrap();
    run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    assert!(theirs.is_file(), "the root is user-choosable; pruning claims only what we write");
}

#[test]
fn a_pass_over_one_surface_does_not_prune_the_others() {
    let (conn, dir) = seeded_db_and_temp_root();
    run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    let decks = Dirty { decks: true, collection: false, wishlist: false };
    run_pass(&conn, dir.path(), decks).unwrap();
    assert!(dir.path().join("Collection/Collection.csv").is_file(),
        "pruning compares against the FULL plan, never the dirty subset");
}

#[test]
fn an_unwritable_root_is_an_error_and_not_a_panic() {
    let conn = seeded_db();
    let missing = std::path::Path::new("Z:/no/such/place/at/all");
    assert!(run_pass(&conn, missing, Dirty::ALL).is_err());
}

#[test]
fn the_readme_names_both_omissions() {
    let (conn, dir) = seeded_db_and_temp_root();
    run_pass(&conn, dir.path(), Dirty::ALL).unwrap();
    let readme = std::fs::read_to_string(dir.path().join("README.txt")).unwrap();
    assert!(readme.contains("maybeboard"), "the Arena/MTGO omission must be stated");
    assert!(readme.to_lowercase().contains("not a valid arena import")
        || readme.to_lowercase().contains("every card"));
}
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement `run.rs`.** Hash with `std::collections::hash_map::DefaultHasher` over the bytes — this is a change detector, not a security boundary, and `sha2` is in the tree for release integrity rather than for this.
- [ ] **Step 4: Run.** Expected PASS, 7 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — make step 7 prune against the *dirty* subset instead of the full plan and confirm `a_pass_over_one_surface_does_not_prune_the_others` fails. Put it back. Then make step 4 trust the in-memory map on a cold start and confirm `a_second_pass...` still passes but a **new** test — start a fresh digest map over an already-written directory, assert `written == 0` — fails. Add that test permanently.
- [ ] **Step 6: Report** (do not commit)

---

### Task 11: The setting, and its four commands

**Files:**
- Create: `src-tauri/src/mirror/settings.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Produces: `pub const K_ENABLED: &str = "mirror_enabled";` and `pub const K_ROOT: &str = "mirror_root";` — keys in `app_meta`, schema v6's key/value table. **No migration**, exactly as `marketplace.rs` needed none.
- Produces: `pub fn enabled(conn: &Connection) -> bool` (default **true**), `pub fn root(conn: &Connection, data_dir: &Path) -> PathBuf` (default `data_dir.join("export")`), `pub fn set_enabled`, `pub fn set_root`.
- Produces four commands: `mirror_status`, `mirror_set_enabled`, `mirror_set_root`, `mirror_rebuild`, and

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub enabled: bool,
    pub root: String,
    /// Unix seconds as a string, `None` if no pass has finished this session.
    pub last_run_at: Option<String>,
    pub last_report: Option<crate::mirror::run::PassReport>,
    /// The sentence to show when the last pass could not write. `None` when it went fine.
    pub last_error: Option<String>,
}
```

**Follow `marketplace.rs`'s two rules literally:** reading can never fail (a missing row, an unparseable row, a row a newer build wrote all read as the default), and writing validates. For the root, validating means: the path is absolute, and its parent exists. A relative root would resolve against the process's working directory, which for a portable app is wherever the shortcut pointed.

`mirror_rebuild` runs a full pass and returns the `PassReport`, on the blocking pool against `db_read`, exactly as every other read-shaped command does.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_mirror_is_on_and_beside_the_database_until_somebody_says_otherwise() {
    let conn = migrated_memory_db();
    assert!(enabled(&conn));
    assert_eq!(root(&conn, Path::new("D:/app/data")), Path::new("D:/app/data/export"));
}

#[test]
fn an_unreadable_setting_reads_as_the_default_rather_than_failing() {
    let conn = migrated_memory_db();
    crate::update::set_app_meta(&conn, K_ENABLED, "perhaps").unwrap();
    assert!(enabled(&conn), "an unparseable setting is a fact about storage, not a refusal");
}

#[test]
fn a_relative_root_is_refused_in_words() {
    let conn = migrated_memory_db();
    let err = set_root(&conn, Path::new("export")).unwrap_err();
    assert!(err.contains("absolute"), "got: {err}");
}

#[test]
fn a_root_whose_parent_does_not_exist_is_refused() {
    let conn = migrated_memory_db();
    assert!(set_root(&conn, Path::new("Z:/nope/nope/export")).is_err());
}

#[test]
fn switching_it_off_and_on_round_trips() {
    let conn = migrated_memory_db();
    set_enabled(&conn, false).unwrap();
    assert!(!enabled(&conn));
    set_enabled(&conn, true).unwrap();
    assert!(enabled(&conn));
}
```

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement `settings.rs`.** Do **not** register the commands in `lib.rs`; Task 12 owns that file. List the four names in your report.
- [ ] **Step 4: Run.** Expected PASS, 5 tests; report the selected count.
- [ ] **Step 5: Mutation-test** — make `enabled` return `false` on an unparseable row and confirm the second test fails. Put it back.
- [ ] **Step 6: Report** (do not commit)

---

### Task 12: Change detection, the thread, and all the wiring

**Files:**
- Create: `src-tauri/src/mirror/watch.rs`
- Modify: `src-tauri/Cargo.toml` (rusqlite features)
- Modify: `src-tauri/src/sync.rs` (`AppState`)
- Modify: `src-tauri/src/lib.rs` (module declarations, four commands, setup)
- Test: inline `#[cfg(test)]` in `watch.rs`

**This is the only task that touches `Cargo.toml`, `sync.rs` or `lib.rs`.** It runs alone.

**Interfaces:**
- Consumes: `run_pass`/`Dirty` (T10), `settings` (T11), and every module the earlier tasks created.
- Produces: `pub fn surface_of(table: &str) -> Option<Dirty>` — the table-to-surface map.
- Produces: `pub struct Mask` wrapping an `AtomicU8` with `pub fn mark(&self, d: Dirty)`, `pub fn take(&self) -> Option<Dirty>` (clearing as it reads), and `pub fn mark_all(&self)`.
- Produces: `pub fn install_hook(conn: &Connection, mask: Arc<Mask>)` and `pub fn spawn(app: tauri::AppHandle, state: Arc<AppState>)`.

**The map, and the row that carries the argument:**

| Tables | Marks |
| --- | --- |
| `deck_cards`, `deck_categories`, `deck_tags`, `deck_folders` | decks |
| `decks` | decks **and** collection — a deck's name titles its group folder in the cabinet |
| `collection_entries`, `collection_folders` | collection |
| `wishlist_entries`, `wishlist_folders` | wishlist |
| anything else | **nothing** |

The last row is load-bearing and gets its own test. A sync rewrites 116,700 `cards` rows and a feed refresh rewrites the price table; mapping either to a surface would fire the hook a hundred thousand times per sync. What those two change enters through a **full pass after the sync or refresh completes** instead.

**`Cargo.toml`:** `rusqlite = { version = "0.40", features = ["bundled", "hooks"] }`. Verified 2026-08-25 in the vendored manifest: `hooks = []` pulls in no additional crates.

**`AppState` gains** `pub mirror: Arc<crate::mirror::watch::Mask>` and `pub mirror_status: Mutex<crate::mirror::watch::LastPass>`, where `LastPass` holds the `Option<String>` timestamp, `Option<PassReport>` and `Option<String>` error that `mirror_status` reports.

**`lib.rs` setup, in this order:**
1. After `app.manage(state.clone())`, call `watch::install_hook(&db::lock_blocking(&state.db), state.mirror.clone())`. The hook must be installed on `state.db` — the **write** connection — and nowhere else.
2. `watch::spawn(app.handle().clone(), state.clone())`, which starts the detached thread. It is not fatal: drop the handle, exactly as the facet index warm-up does.
3. Register `mirror::settings::mirror_status`, `mirror_set_enabled`, `mirror_set_root`, `mirror_rebuild` in `generate_handler!`.
4. Declare `mod transfer;` and `mod mirror;`.

**The thread:**
- Sleeps in 250 ms ticks. When the mask has been dirty for **2,000 ms with no further marking**, it takes the mask and runs a pass. `DEBOUNCE` and `TICK` are `const`s so a test can reason about them.
- Runs one full pass at startup (`Dirty::ALL`) **before** entering the loop, which is what makes a mirror correct after a crash. It waits for the database to be ready first — the same `try_state` race `paths::covers_dir` documents.
- Skips everything when `settings::enabled` is false, but keeps ticking so switching it back on takes effect without a restart.
- On a failure, records the sentence in `state.mirror_status`, writes **one** `error_log` row (not one per file), and marks the mask fully dirty again so the next successful pass is a full rebuild rather than a partial one.
- Never takes `state.db`. Only `db_read`.

**Sync and feed completion** call `state.mirror.mark_all()` — one line each at the end of `sync::run`'s success path and `marketplace_feed`'s refresh. Find them by grepping for where each emits its final progress event.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_tables_a_sync_rewrites_map_to_nothing() {
    for table in ["cards", "sets", "marketplace_prices", "image_cache",
                  "deck_audit", "deck_undo", "error_log", "app_meta", "sync_meta"] {
        assert_eq!(surface_of(table), None, "{table} must never trigger a mirror pass");
    }
}

#[test]
fn every_user_table_maps_to_the_surface_it_belongs_to() {
    assert_eq!(surface_of("deck_cards").unwrap().decks, true);
    assert_eq!(surface_of("deck_cards").unwrap().collection, false);
    assert_eq!(surface_of("wishlist_entries").unwrap().wishlist, true);
    let decks = surface_of("decks").unwrap();
    assert!(decks.decks && decks.collection, "a deck's name titles its group folder");
}

#[test]
fn the_mask_accumulates_and_take_clears_it() {
    let mask = Mask::default();
    assert_eq!(mask.take(), None);
    mask.mark(Dirty { decks: true, collection: false, wishlist: false });
    mask.mark(Dirty { decks: false, collection: false, wishlist: true });
    let taken = mask.take().unwrap();
    assert!(taken.decks && taken.wishlist && !taken.collection);
    assert_eq!(mask.take(), None, "taking must clear");
}

#[test]
fn a_write_through_the_hooked_connection_marks_its_surface() {
    let conn = migrated_memory_db();
    let mask = Arc::new(Mask::default());
    install_hook(&conn, mask.clone());
    conn.execute("INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
                  VALUES ('Ordered', 0, 0, 0)", []).unwrap();
    assert!(mask.take().unwrap().wishlist);
}

#[test]
fn a_write_to_a_table_the_map_ignores_marks_nothing() {
    let conn = migrated_memory_db();
    let mask = Arc::new(Mask::default());
    install_hook(&conn, mask.clone());
    crate::update::set_app_meta(&conn, "anything", "at all").unwrap();
    assert_eq!(mask.take(), None);
}
```

- [ ] **Step 2: Run and watch them fail.** `cd src-tauri && cargo test mirror::watch`
- [ ] **Step 3: Add the `hooks` feature** to `Cargo.toml` and run `cargo build` to confirm it resolves with no new crates in the lock diff. Check: `git diff src-tauri/Cargo.lock` should show only the rusqlite feature line, no added packages.
- [ ] **Step 4: Implement `watch.rs`.**
- [ ] **Step 5: Do the `lib.rs` and `sync.rs` wiring** as listed above.
- [ ] **Step 6: Run the whole Rust suite.** `cd src-tauri && cargo test` — expected PASS. Report the count.
- [ ] **Step 7: Mutation-test** — add `"cards"` to the map as the collection and confirm the first test fails. Remove it.
- [ ] **Step 8: Report** (do not commit)

---

### Task 13: The Settings panel

**Files:**
- Create: `src/features/settings/BackupPanel.tsx`, `BackupPanel.test.tsx`, `BackupPanel.stories.tsx`
- Modify: `src/lib/ipc.ts`, `src/features/settings/SettingsPage.tsx`, `.storybook/fake/db.ts`

**Interfaces:**
- Consumes: the four commands from Task 11 and their `MirrorStatus` shape.
- Produces: `ipc.mirrorStatus()`, `ipc.mirrorSetEnabled(enabled)`, `ipc.mirrorSetRoot(path)`, `ipc.mirrorRebuild()`.

**Read `src/CLAUDE.md` before writing any of this** — it carries the Storybook-MCP rule and the layers rule, and both apply. Call `mcp__mtg-grimoire-sb-mcp__get-storybook-story-instructions` before writing the story and `preview-stories` after, and put the returned URLs in your report.

Follow `MarketplacePanel.tsx` for shape and `panelChrome.tsx`'s `SettingsSection` for the frame — `id="backup"`, `title="Backup"`. The panel shows: a switch bound to `enabled`; the root path with a **Change folder…** button; the last pass's time and a one-line summary built from `PassReport` (`"142 files written, 208 unchanged"`); the error sentence when there is one, through `panelChrome`'s `problem` tone; and a **Rebuild now** button.

The folder picker is `@tauri-apps/plugin-dialog`'s `open({ directory: true })` — `dialog:allow-open` is already granted, so **add no permission**.

The fake gains all four commands over a small piece of world state. It does not simulate a filesystem: `mirror_rebuild` returns a plausible `PassReport` and stamps the time. Add a fault for the unwritable root, following `exportWriteError`'s pattern at `.storybook/fake/db.ts:743`.

- [ ] **Step 1: Write the failing test**

```tsx
it("says where the mirror writes, and offers to move it", async () => {
  render(<BackupPanel />, { wrapper });
  expect(await screen.findByText(/D:[\\/]app[\\/]data[\\/]export/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /change folder/i })).toBeEnabled();
});

it("shows the last pass rather than claiming one happened", async () => {
  // A fresh app has run no pass; the panel must not print "0 files written" as if it had.
  render(<BackupPanel />, { wrapper: wrapperWithNoPassYet });
  expect(await screen.findByText(/not run yet/i)).toBeInTheDocument();
});

it("shows the sentence when the last pass could not write", async () => {
  render(<BackupPanel />, { wrapper: wrapperWithMirrorError });
  expect(await screen.findByRole("region", { name: "Backup" })).toHaveTextContent(/could not/i);
});

it("switching it off calls through and does not ask again on its own", async () => {
  const user = userEvent.setup();
  render(<BackupPanel />, { wrapper });
  await user.click(await screen.findByRole("switch", { name: /back up/i }));
  expect(mirrorSetEnabled).toHaveBeenCalledWith(false);
});
```

A greyed row's accessible name includes its reason, so reach any disabled control with a regex rather than an exact string.

- [ ] **Step 2: Run and watch it fail.** `npx vitest run src/features/settings/BackupPanel.test.tsx`
- [ ] **Step 3: Add the four commands to `ipc.ts`** and the four handlers to the fake.
- [ ] **Step 4: Write `BackupPanel.tsx`** and mount it in `SettingsPage.tsx`.
- [ ] **Step 5: Run the test.** Expected PASS, 4 tests.
- [ ] **Step 6: Write the story**, following the MCP instructions, with a play for the off switch and variants for the error and the never-run states. Run `preview-stories` and include every URL in your report.
- [ ] **Step 7: Mutation-test** — make the panel render `0 files written` when no pass has run and confirm the second test fails. Put it back.
- [ ] **Step 8: Report** (do not commit)

---

### Task 14: The live pass

**Files:** none — this task produces findings, and a `fix:` commit if it finds something.

Read `docs/reference/live-ui-verification.md` first; it documents traps that have each cost a session. Take the app lock through `.claude/skills/running-the-app/lock.ps1`. **Drive CDP from PowerShell, not Bash** — Bash refuses `cdp.mjs eval` in a worktree — and avoid nested quotes and `$`.

- [ ] **Step 1: Launch and let the startup pass run.** Confirm `src-tauri/target/debug/data/export/` appears with `Decks/`, `Collection/`, `Wishlist/` and `README.txt`.
- [ ] **Step 2: Check a real deck's file.** Open `Decks/Azula/Azula.archidekt.txt` and compare it against what the export dialog produces for the same deck with every field ticked. **They must be byte-identical.** This is the golden fence meeting the real corpus, and it is the check most likely to find something the fixtures missed.
- [ ] **Step 3: Edit that deck** — add a card. Confirm its seven files change within ~2 s and **no other deck's files do** (compare mtimes before and after).
- [ ] **Step 4: Rename the deck.** Confirm the old directory is gone and the new one is complete.
- [ ] **Step 5: Point the root at a folder, then delete that folder while the app runs.** Confirm the app keeps working, the panel says why, and one `error_log` row appeared — not one per file.
- [ ] **Step 6: Put the folder back.** Confirm the next pass is a **full** rebuild.
- [ ] **Step 7: Time a full pass** on the real corpus and write the number down. The plan's §9 figures are a JavaScript ceiling; this is the first real one.
- [ ] **Step 8: Report every finding**, including anything that worked. Release the lock.

---

### Task 15: The documentation

**Files:**
- Modify: `CLAUDE.md`, `src-tauri/CLAUDE.md`, `src/features/transfer/CLAUDE.md`, `docs/reference/import-export.md`
- Create: `docs/reference/text-mirror.md`
- Modify: `src-tauri/Cargo.toml` (one stale comment)

- [ ] **Step 1: `CLAUDE.md`** — the architecture bullet says "TS owns domain logic (deck validation, import/export parsing)". Export *writing* now exists on both sides by design. Rewrite the bullet so it says that and names the golden fence as what makes it legal, then add `text-mirror.md` to the reference table.
- [ ] **Step 2: `src-tauri/CLAUDE.md`** — the update hook, and the rule that **a new user table must be added to `watch::surface_of`'s map** or its writes will never reach the mirror.
- [ ] **Step 3: `src/features/transfer/CLAUDE.md`** — the golden corpus: where it is, that `npm run golden` regenerates it, and that regenerating obliges a matching change in `src-tauri/src/transfer/` or `cargo test` goes red.
- [ ] **Step 4: `docs/reference/import-export.md`** — add the second writer and the two omissions. **And re-count**: that page says "25 fields total, counted from `TRANSFER_FIELD_IDS`", which was true before `tag` and `tagColor` landed and is not now. Count the array and fix the number, or delete the sentence — a count is a fact about a tree and this repo has retired counts for that reason before.
- [ ] **Step 5: `docs/reference/text-mirror.md`** — the layout, the dirty map, Task 14's **measured** costs on the real build (not §9's JavaScript ceiling), the two omissions, and a "bugs still open" section following `decks-live-findings.md`'s shape.
- [ ] **Step 6: `src-tauri/Cargo.toml`** — the comment beside `tauri-plugin-dialog` claims the save verb is not permitted. `capabilities/default.json` has granted `dialog:allow-save` since the export dialog shipped. Correct it.
- [ ] **Step 7:** `npm run verify`, then commit.

---

## Self-review

**Spec coverage.** §3 layout → T8; §3.1 all fields on → T10 step 3, and the two omissions → T10's README test and T15; §3.2 names/collisions/prune → T7, T10; §4 the port → T2–T6; §4's reuse of existing readers → T9; §5 hook, map, debounce, hash, full-pass triggers → T12, T10; §6 the fence → T1, T6; §7 Settings and failure → T11, T13, T12's error path; §8 testing → every task's mutation step plus T14; §9 cost → T14 step 7; §10 docs → T15; §11's two open questions → T12's `DEBOUNCE` const and T8/T10 (an empty folder's seven empty files fall out of `plan_files` naturally — decide it in T14 with the real tree in front of you and record the decision in `text-mirror.md`).

**Placeholders.** None. Every code step carries real code or names the exact file to port with its rules enumerated.

**Type consistency.** `Dirty` is defined in T10 and used in T12; `Source` and `PlannedFile` in T8 and used in T9 and T10; `PassReport` in T10 and used in T11 and T13; `Card`/`Surface`/`Format` in T2 and used throughout; `FieldId`/`available_fields` in T3 and used in T4, T6 and T10. `Format::key()` is named in T6 and assigned to T2 or T6, whichever gets there first — T6 says so explicitly.

**One thing deliberately not planned.** `parse.ts` does not move and no Rust parser exists. The round-trip guarantee is reached transitively in T1's second `describe` plus T6's byte-equality: if Rust reproduces the goldens exactly and TypeScript parses the goldens, the app's parser reads what the mirror writes.
