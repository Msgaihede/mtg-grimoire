# Deck import/export format support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the Archidekt, Moxfield, Arena and MTGO decklist exports people actually hold — their categories included — and write all four back, from a whole deck as well as from one pile.

**Architecture:** `parse.ts` stays one per-line reader with no format detector; it learns four new decorations and one heading rule. A file's categories become a new field on `ParsedLine`, which `plan.ts` puts one rung above `autoCategoryFor` in a precedence chain. `format.ts` stays pure and gains three grouped writers. One field crosses the IPC boundary — `ImportItem.inactive`, so Archidekt's `{noDeck}` reaches `is_active = 0`.

**Tech Stack:** TypeScript 6 / React 19 / Vitest, Rust (rusqlite) for the one backend field, Storybook for the fake.

**Spec:** `docs/superpowers/specs/2026-08-15-deck-format-support-design.md` — read it first; every decision below argues from it.

## Global Constraints

- **No format detector, ever.** Every parser rule is a per-line rule. The one exception this plan introduces (heading lookahead) is fenced in Task 3 and reads exactly one following line.
- **`//` is part of a card name** and is a comment only at the start of a line. Nothing may cut one out of the middle.
- **Nothing is ever silently dropped.** A line the parser cannot read becomes a `ParseIssue` with its number and raw text; one bad line never aborts a parse.
- **`autoCategoryFor` is the app's one filing rule** and is not touched by this plan. A plain add, a drag and an imported line must agree.
- **Nothing anywhere may branch on a category's kind being `maybe`.** `is_active = 0` is the whole of what it means. (`src/features/decks/CLAUDE.md`.)
- **A deck names a printing, not a finish.** `*F*`/`*E*` stay stripped on import and are never written on export.
- **Do not run `npm run verify` inside a subagent** (CLAUDE.md: tests run once, after fan-in). Running one test file with `npx vitest run <path>` is expected and cheap. Rust tasks run `cargo test` from `src-tauri/` only for their own module.
- **`.storybook/fake/db.ts` is invisible to ripgrep** (it is treated as binary). Read it, or use `Select-String -Encoding utf8`.
- Commit style: `feat:`/`fix:`/`test:`/`docs:`/`chore:`, small, one per task.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/features/decks/import/fixtures.ts` | The three real exports, verbatim | 1 |
| `src-tauri/src/deck_import.rs` | `ImportItem.inactive`, applied only to a pile the import creates | 2 |
| `src/lib/ipc.ts` | The mirror of that field | 2 |
| `.storybook/fake/db.ts` | The fake's `deck_import_commit` | 2 |
| `src/features/decks/import/parse.ts` | Decorations: empty `()`, `^tag^`, the `[Category]` bracket | 3 |
| `src/features/decks/import/parse.ts` | Headings that are category names, and the `SectionKind` split | 4 |
| `src/features/decks/import/plan.ts` | The precedence chain, and `inactive` on the item | 5 |
| `src/features/decks/export/format.ts` | Six writers, the section ladder, `omittedCount` | 6 |
| `src/features/decks/export/ExportDialog.tsx` | Six formats and the omitted-cards line | 7 |
| `src/features/decks/DeckEditor.tsx` | `Export deck`, and the export layer's two scopes | 8 |
| Docs | `src/features/decks/CLAUDE.md`, `src-tauri/CLAUDE.md`, `docs/reference/decks-storage.md` | 9 |

**Wave order for a fan-out.** A: 1 and 2 (different trees). B: 3, then 4 (both edit `parse.ts`, so they are sequential). C: 5 and 6 in parallel. D: 7 and 8 in parallel. E: 9. F: 10.

---

### Task 1: The three fixtures

**Files:**
- Modify: `src/features/decks/import/fixtures.ts` (append; the four existing exports are untouched)
- Test: `src/features/decks/import/parse.test.ts` (one new test, counting the fixtures)

**Interfaces:**
- Consumes: nothing.
- Produces: `ARCHIDEKT_SECTIONED: string`, `ARCHIDEKT_FLAT: string`, `EMPTY_HINT_LIST: string` from `./fixtures`.

The three lists are held verbatim at these absolute paths and **must be copied byte for byte** — a fixture is only evidence while nobody has tidied it. Do not sort, dedupe, reflow or "fix" a name that looks odd.

```
C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire\e2357a2c-a1c9-4867-bcc6-5878818deb63\scratchpad\archidekt-sectioned.txt
C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire\e2357a2c-a1c9-4867-bcc6-5878818deb63\scratchpad\archidekt-flat.txt
C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire\e2357a2c-a1c9-4867-bcc6-5878818deb63\scratchpad\empty-set-hint.txt
```

None of the three contains a backtick or a `${`, so each goes into a plain template literal with no escaping.

- [ ] **Step 1: Append the fixtures**

Append to `src/features/decks/import/fixtures.ts`. Paste each file's contents where marked, **with the trailing newline removed** (the template literal's closing backtick sits immediately after the last card line, exactly as `REFERENCE_LIST`'s does).

```ts
/**
 * Archidekt's full text export: a heading per category, and every line carrying its category in
 * brackets, its printing, and often a `^Tag,#colour^`.
 *
 * **This is `REFERENCE_LIST`'s deck**, with printings, categories and tags added — same 105 card
 * lines, same 117 copies — which is what makes the two fixtures check each other. 14 headings,
 * 44 tagged lines, 3 `*F*` markers, 7 `//` split names, and **17 lines whose first bracket entry
 * carries `{noDeck}`**: Archidekt's word for a pile that counts toward nothing, which is this
 * app's `is_active = 0`.
 *
 * Every one of those numbers is asserted in `parse.test.ts` rather than remembered here. If they
 * stop matching, the fixture was mistyped — re-copy it rather than adjust the assertion.
 */
export const ARCHIDEKT_SECTIONED = `<<< contents of archidekt-sectioned.txt >>>`;

/**
 * The same deck out of Archidekt with no headings at all: one flat alphabetical list, every line
 * carrying its `[Category]`. **88 lines and 100 copies** — `ARCHIDEKT_SECTIONED` less its 17
 * `{noDeck}` cards, which is the arithmetic that ties the two together.
 *
 * Four lines carry `{noDeck}` on a *later* bracket entry (`[Land,Maybe (New){noDeck}{noPrice}]`).
 * Those cards are in the deck: only the **first** entry decides.
 */
export const ARCHIDEKT_FLAT = `<<< contents of archidekt-flat.txt >>>`;

/**
 * The same deck again, in the shape that defeats today's parser hardest: uppercase set codes,
 * **empty parentheses** where the exporter had no set (33 of 88 lines), and **front faces only**
 * — `Branchloft Pathway`, never `Branchloft Pathway // Boulderloft Pathway`.
 *
 * Both halves resolve on the Rust side already: `BY_SET_AND_NUMBER` answers the hinted lines and
 * `hint_names_the_card` accepts a front face through `fold_rank`, and `BY_FRONT_FACE` answers the
 * rest. What fails today is the *parse* — `LINE`'s set group is `\w{1,10}`, so `()` leaves the
 * whole tail inside the name.
 *
 * 88 lines, 100 copies, no headings, no tags, no brackets, no `//`.
 */
export const EMPTY_HINT_LIST = `<<< contents of empty-set-hint.txt >>>`;
```

- [ ] **Step 2: Write the counting test**

Append to `src/features/decks/import/parse.test.ts`, and extend its import line to
`import { ARCHIDEKT_FLAT, ARCHIDEKT_SECTIONED, ARENA_LIST, EMPTY_HINT_LIST, MOXFIELD_LIST, MTGO_LIST, REFERENCE_LIST } from "./fixtures";`

This test asserts the **raw shape of the text**, not the parser's reading of it, so it stays true through Tasks 3 and 4 and fails the moment somebody tidies a fixture.

```ts
describe("the format fixtures", () => {
  const rowsOf = (text: string) => text.split("\n");
  const cardish = (text: string) => rowsOf(text).filter((r) => /^\d{1,4}x?\s/.test(r.trim()));
  const copies = (text: string) =>
    cardish(text).reduce((n, r) => n + Number(/^(\d{1,4})/.exec(r.trim())![1]), 0);

  it("holds three exports of one deck, counted", () => {
    expect(rowsOf(ARCHIDEKT_SECTIONED).length).toBe(132);
    expect(cardish(ARCHIDEKT_SECTIONED).length).toBe(105);
    expect(copies(ARCHIDEKT_SECTIONED)).toBe(117);

    expect(cardish(ARCHIDEKT_FLAT).length).toBe(88);
    expect(copies(ARCHIDEKT_FLAT)).toBe(100);

    expect(cardish(EMPTY_HINT_LIST).length).toBe(88);
    expect(copies(EMPTY_HINT_LIST)).toBe(100);
  });

  it("is the reference list's deck, so the two fixtures check each other", () => {
    // 105 lines and 117 copies in both, which is what makes a mistyped fixture visible.
    expect(cardish(REFERENCE_LIST).length).toBe(cardish(ARCHIDEKT_SECTIONED).length);
    expect(copies(REFERENCE_LIST)).toBe(copies(ARCHIDEKT_SECTIONED));
  });

  it("is the sectioned list less its 17 {noDeck} cards", () => {
    const noDeckFirst = cardish(ARCHIDEKT_SECTIONED).filter((r) => {
      const bracket = /\[([^\]]+)\]/.exec(r);
      return bracket !== null && bracket[1].split(",")[0].includes("{noDeck}");
    });
    expect(noDeckFirst.length).toBe(17);
    expect(cardish(ARCHIDEKT_SECTIONED).length - noDeckFirst.length).toBe(88);
    expect(copies(ARCHIDEKT_SECTIONED) - noDeckFirst.length).toBe(100);
  });

  it("counts the decorations each fixture exists to exercise", () => {
    const count = (text: string, re: RegExp) => cardish(text).filter((r) => re.test(r)).length;
    expect(count(ARCHIDEKT_SECTIONED, /\^[^^]*\^\s*$/)).toBe(44);
    expect(count(ARCHIDEKT_SECTIONED, /\s\*[A-Z]\*[\s]/)).toBe(3);
    expect(count(ARCHIDEKT_SECTIONED, / \/\/ /)).toBe(7);
    expect(count(ARCHIDEKT_FLAT, /\^[^^]*\^\s*$/)).toBe(43);
    expect(count(EMPTY_HINT_LIST, /\(\)\s/)).toBe(33);
    expect(count(EMPTY_HINT_LIST, / \/\/ /)).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run src/features/decks/import/parse.test.ts`
Expected: PASS, all four new tests. A failure here means a fixture was not copied byte for byte — re-copy it from the path above rather than changing a number.

- [ ] **Step 4: Commit**

```bash
git add src/features/decks/import/fixtures.ts src/features/decks/import/parse.test.ts
git commit -m "test(decks): hold three real deck exports as fixtures"
```

---

### Task 2: `ImportItem.inactive` — the one field that crosses IPC

**Files:**
- Modify: `src-tauri/src/deck_import.rs` (the `ImportItem` struct, and `commit_import`'s category arm)
- Modify: `src/lib/ipc.ts` (the `ImportItem` interface)
- Modify: `.storybook/fake/db.ts` (`deck_import_commit`)
- Test: `src-tauri/src/deck_import.rs`'s `mod tests`, and `.storybook/fake/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ImportItem` gains `inactive?: boolean` in TS and `pub inactive: bool` (with `#[serde(default)]`) in Rust. Task 5 sets it.

- [ ] **Step 1: Write the failing Rust test**

Append inside `mod tests` in `src-tauri/src/deck_import.rs`. Follow the existing helpers there (`seeded()`, and whatever the file's other `commit_import` tests use to make a deck — read two neighbouring tests before writing these so the deck-creation helper matches).

```rust
/// A pile the import **creates** for a `{noDeck}` line arrives switched off.
///
/// Archidekt's `{noDeck}` is "counts toward nothing", which is this schema's `is_active = 0`.
/// Without this the reference deck's 17 maybeboard cards land in a counted pile and a 100-card
/// commander deck reports 117.
#[test]
fn an_import_creates_a_no_deck_pile_switched_off() {
    let conn = seeded();
    let deck_id = /* the file's existing deck-creation helper */;
    commit_import(
        &conn,
        deck_id,
        "live",
        "merge",
        &[ImportItem {
            card_id: "sol-c21".to_owned(),
            quantity: 1,
            category_name: "(New) Maybeboard".to_owned(),
            inactive: true,
        }],
    )
    .unwrap();
    let active: bool = conn
        .query_row(
            "SELECT is_active FROM deck_categories WHERE deck_id = ?1 AND name = ?2",
            params![deck_id, "(New) Maybeboard"],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!active, "a pile the import made for a {{noDeck}} line is switched off");
}

/// A pile the reader already has is **left alone**, however the file describes it.
///
/// An import must not reach into filing somebody did by hand: `category_for_name` finds before
/// it creates, and the `existed` lookup `categories_created` already makes is the same fact.
#[test]
fn an_import_never_switches_off_a_pile_the_reader_already_had() {
    let conn = seeded();
    let deck_id = /* the file's existing deck-creation helper */;
    let id = crate::deck_meta::create_category(&conn, deck_id, "Keepers").unwrap().id;
    commit_import(
        &conn,
        deck_id,
        "live",
        "merge",
        &[ImportItem {
            card_id: "sol-c21".to_owned(),
            quantity: 1,
            category_name: "Keepers".to_owned(),
            inactive: true,
        }],
    )
    .unwrap();
    let active: bool = conn
        .query_row("SELECT is_active FROM deck_categories WHERE id = ?1", params![id], |r| r.get(0))
        .unwrap();
    assert!(active, "an import may not switch off a pile the reader made");
}
```

If `create_category`'s signature differs, read it in `src-tauri/src/deck_meta.rs` and adapt — do not change that function.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test deck_import`
Expected: FAIL — `ImportItem` has no field `inactive`.

- [ ] **Step 3: Add the field**

In `src-tauri/src/deck_import.rs`, in `struct ImportItem`:

```rust
    /// The file said this pile counts toward nothing — Archidekt's `{noDeck}`, which is exactly
    /// what `is_active = 0` means here.
    ///
    /// **Applied only to a pile this import creates.** A name the reader already has keeps
    /// whatever they set: an import may not reach into filing somebody did by hand, which is the
    /// same reasoning that makes `replace` clear the cards and leave the categories. The
    /// `existed` lookup [`commit_import`] already makes for `categories_created` is that fact, so
    /// this costs no second query.
    ///
    /// **The first item naming a pile decides**, because the name is memoised for the list. Every
    /// export in scope is consistent about it — Archidekt writes the same bracket on every card
    /// of a category — and a list that disagreed with itself has no better answer available.
    ///
    /// `#[serde(default)]` so every caller written before this field still deserialises: absent
    /// means an ordinary, counted pile, which is what an import has always made.
    #[serde(default)]
    pub inactive: bool,
```

In `commit_import`, inside the `None =>` arm, immediately after `let id = crate::deck_meta::category_for_name(&tx, deck_id, category_name)?;` and **before** `if existed.is_none() { categories_created += 1; }`:

```rust
                    if existed.is_none() && item.inactive {
                        // Straight to the column rather than through `deck_meta::set_category_active`:
                        // that one opens a transaction of its own, writes a history row and
                        // reallocates, and all three are already this function's — the allocator
                        // runs once at the end, over the finished deck.
                        tx.execute(
                            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
                            params![id],
                        )
                        .map_err(|e| e.to_string())?;
                    }
```

- [ ] **Step 4: Run the Rust tests**

Run: `cd src-tauri && cargo test deck_import && cargo clippy -- -D warnings && cargo fmt --check`
Expected: PASS. (`npm run verify` does **not** run `cargo fmt`; CI does, and it is the only red you can get with both suites green.)

- [ ] **Step 5: Mirror it in `src/lib/ipc.ts`**

In `interface ImportItem`, after `categoryName`:

```ts
  /**
   * The file said this pile counts toward nothing — Archidekt's `{noDeck}`, which is this app's
   * `is_active = 0`.
   *
   * **Applied only to a pile the import creates.** A name the reader already has keeps whatever
   * they set; an import must not reach into filing somebody did by hand.
   *
   * Optional because absent has always meant "an ordinary, counted pile" and the backend reads it
   * that way (`#[serde(default)]`) — so every caller written before Archidekt's maybeboard existed
   * is unchanged, the Storybook fake's literals included.
   */
  inactive?: boolean;
```

- [ ] **Step 6: Write the fake's failing test**

In `.storybook/fake/db.test.ts`, beside the other `deck_import_commit` tests (around line 2596):

```ts
  it("switches off a pile it creates for a {noDeck} item, and leaves an existing one alone", () => {
    const db = seed("starter");
    const w = writeHandlers(db);
    const mine = w.deck_category_create({ deckId: 1, name: "Keepers" });
    w.deck_import_commit({
      deckId: 1,
      variant: "live",
      mode: "merge",
      items: [
        { cardId: BOLT.id, quantity: 1, categoryName: "(New) Maybeboard", inactive: true },
        { cardId: BOLT.id, quantity: 1, categoryName: "Keepers", inactive: true },
      ],
    });
    const made = db.deckCategories.find((c) => c.deckId === 1 && c.name === "(New) Maybeboard");
    expect(made?.isActive).toBe(false);
    expect(db.deckCategories.find((c) => c.id === mine.id)?.isActive).toBe(true);
  });
```

Read the neighbouring tests first: `seed`, `writeHandlers`, `BOLT` and `deck_category_create`'s argument shape are all established there, and this test must use them as they are.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run .storybook/fake/db.test.ts -t "noDeck"`
Expected: FAIL — the fake ignores `inactive`.

- [ ] **Step 8: Teach the fake**

In `.storybook/fake/db.ts`'s `deck_import_commit`, replace

```ts
          const existed = db.deckCategories.some((c) => c.deckId === deck.id && c.name === name);
          category = categoryForName(db, deck.id, name);
          if (!existed) categoriesCreated += 1;
```

with

```ts
          const existed = db.deckCategories.some((c) => c.deckId === deck.id && c.name === name);
          category = categoryForName(db, deck.id, name);
          if (!existed) {
            categoriesCreated += 1;
            // Archidekt's `{noDeck}`: the file says this pile counts toward nothing, which is
            // what `isActive: false` means. **Only a pile this import made** — a name the reader
            // already has keeps whatever they set, exactly as `commit_import` does it.
            if (item.inactive === true) category.isActive = false;
          }
```

- [ ] **Step 9: Run it to verify it passes**

Run: `npx vitest run .storybook/fake/db.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/deck_import.rs src/lib/ipc.ts .storybook/fake/db.ts .storybook/fake/db.test.ts
git commit -m "feat(decks): let an import switch off a pile it creates"
```

---

### Task 3: The parser reads the decorations

**Files:**
- Modify: `src/features/decks/import/parse.ts`
- Test: `src/features/decks/import/parse.test.ts`

**Interfaces:**
- Consumes: Task 1's fixtures.
- Produces: `ParsedLine.categoryName: string | null` and `ParsedLine.excluded: boolean`. `setCode` is `null` for an empty `()`.

This task does **not** touch section headings — that is Task 4. `ARCHIDEKT_SECTIONED` still mis-files here; its per-line decorations are what this task fixes.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/decks/import/parse.test.ts`, inside the existing `describe("parseDecklist")`:

```ts
  it("reads an empty printing hint as no set and keeps the collector number", () => {
    const { lines } = parseDecklist("1 Aerith, Last Ancient () 76");
    expect(lines[0]).toMatchObject({
      name: "Aerith, Last Ancient",
      setCode: null,
      collectorNumber: "76",
      quantity: 1,
    });
  });

  it("still refuses to read a parenthesised phrase as a set", () => {
    // The hint is anchored to the end and a set code holds no spaces, so widening the count to
    // zero cannot make this one match.
    const { lines } = parseDecklist("1 Erase (Not the Urza's Legacy One)");
    expect(lines[0]).toMatchObject({ name: "Erase (Not the Urza's Legacy One)", setCode: null });
  });

  it("strips an Archidekt tag whose hash follows a comma", () => {
    // `MARKERS`' `#` arm needs whitespace in front of the hash; this one has a comma, which is
    // why the whole tail used to stay inside the name.
    const { lines } = parseDecklist("1x Sol Ring (fic) 358 [Ramp] ^Keeper,#4aab08^");
    expect(lines[0]).toMatchObject({ name: "Sol Ring", setCode: "FIC", collectorNumber: "358" });
  });

  it("strips a tag whose own text has spaces and parentheses", () => {
    const { lines } = parseDecklist("1x Mona Lisa, Science Geek (tmt) 123 ^Fence (flavor),#fa890d^");
    expect(lines[0]!.name).toBe("Mona Lisa, Science Geek");
  });

  it("reads a bracket as the line's category", () => {
    const { lines } = parseDecklist("1x Gandalf the White (ltr) 305 [Flash Enabler]");
    expect(lines[0]).toMatchObject({ name: "Gandalf the White", categoryName: "Flash Enabler" });
  });

  it("takes the first bracket entry and drops its flags", () => {
    const { lines } = parseDecklist("1x Lush Portico (mkm) 263 [Land,Maybe (New){noDeck}{noPrice}]");
    // The first entry is the pile the card is in; a `{noDeck}` on a *later* entry says only that
    // the card is also filed in some maybeboard.
    expect(lines[0]).toMatchObject({ categoryName: "Land", excluded: false });
  });

  it("marks a line excluded when its first bracket entry says noDeck", () => {
    const { lines } = parseDecklist("1x Aerith Gainsborough (fin) 4 [(New) Maybeboard{noDeck}{noPrice},Creature]");
    expect(lines[0]).toMatchObject({ categoryName: "(New) Maybeboard", excluded: true });
  });

  it("reads a bracket naming a known section as that section, not as a category", () => {
    // `[Commander{top}]` has to reach the command zone through the one mechanism the four seeded
    // piles already use, not through a second one.
    const commander = parseDecklist("1x Serah Farron // Crystallized Serah (fin) 506 [Commander{top}]");
    expect(commander.lines[0]).toMatchObject({
      name: "Serah Farron // Crystallized Serah",
      section: "commander",
      categoryName: null,
    });
    const maybe = parseDecklist("1x Tataru Taru (fic) 30 [Maybeboard{noDeck}{noPrice},Creature]");
    expect(maybe.lines[0]).toMatchObject({ section: "maybeboard", categoryName: null, excluded: true });
  });

  it("treats a finish word in a bracket as decoration and never as a pile", () => {
    const { lines } = parseDecklist("1 Sol Ring [Foil]");
    expect(lines[0]).toMatchObject({ name: "Sol Ring", categoryName: null });
  });

  it("peels a bracket, a foil marker and a tag off one line", () => {
    const { lines } = parseDecklist("1x Skrelv, Defector Mite (one) 33 *F* [Protection] ^Keeper,#4aab08^");
    expect(lines[0]).toMatchObject({
      name: "Skrelv, Defector Mite",
      setCode: "ONE",
      collectorNumber: "33",
      categoryName: "Protection",
    });
  });

  it("reads the flat Archidekt export whole", () => {
    const { lines, issues, totalCards } = parseDecklist(ARCHIDEKT_FLAT);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(88);
    expect(totalCards).toBe(100);
    expect(new Set(lines.map((l) => l.categoryName)).size).toBe(11);
    // Every line but the commander's names a category; the commander's names a section.
    expect(lines.filter((l) => l.section === "commander")).toHaveLength(1);
    expect(lines.filter((l) => l.excluded)).toHaveLength(0);
  });

  it("reads the empty-hint export whole", () => {
    const { lines, issues, totalCards } = parseDecklist(EMPTY_HINT_LIST);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(88);
    expect(totalCards).toBe(100);
    expect(lines.filter((l) => l.setCode === null)).toHaveLength(33);
    expect(lines.every((l) => l.collectorNumber !== null)).toBe(true);
  });
```

Note on the 11: `ARCHIDEKT_FLAT` has 12 distinct first-bracket names, one of which is `Commander` — a known section word, so it becomes a section rather than a `categoryName`, leaving 11 distinct names plus `null` for that one line. Verify this against the fixture while implementing; if the fixture says otherwise, the fixture is right and the number here is wrong.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/decks/import/parse.test.ts`
Expected: FAIL — `categoryName`/`excluded` do not exist and the empty hint is unread.

- [ ] **Step 3: Widen `LINE` and the set read**

In `src/features/decks/import/parse.ts`, change the regex and extend its doc comment with the new paragraph:

```ts
const LINE =
  /^(?:(?<qty>\d{1,4})[xX]?\s+)?(?<name>.+?)(?:\s+\((?<set>\w{0,10})\)(?:\s+(?<cn>\S+))?)?$/;
```

Add to that comment:

```
 * **The set may be empty, and that is a real export rather than a tolerance.** `1 Aerith, Last
 * Ancient () 76` is 33 of one reference export's 88 lines: the exporter had a collector number
 * and no set, and wrote the parentheses anyway. `\w{0,10}` reads it, and an empty match is
 * `setCode: null` below. Widening the count to zero cannot cost `Erase (Not the Urza's Legacy
 * One)` its parentheses — the hint is still anchored to the end and a set code still holds no
 * spaces, so a parenthesised *phrase* can never satisfy it.
 *
 * What it costs is honest and worth stating: `resolve_lines` reads a collector number with no
 * set as a hint it cannot use (a number is not unique across sets) and sets `hint_missed`. So
 * such a list previews 33 missed hints where it used to preview 33 unresolved cards.
```

And in the line-building block at the bottom of `parseDecklist`:

```ts
      // `""` is what an empty `()` matches and it is not a set code. `?? null` alone would put
      // an empty string in the field, which `resolve_lines` trims to absent anyway — but a DTO
      // that says `""` where it means "none" is a field two readers will disagree about.
      setCode: groups.set ? groups.set.toUpperCase() : null,
```

- [ ] **Step 4: Replace `MARKERS`/`stripMarkers` with `stripDecorations`**

```ts
/**
 * Trailing decoration that belongs to the exporter rather than to the card: the `*F*`/`*E*`
 * finish markers, an Archidekt `^Tag,#colour^`, and a trailing `#tag`.
 *
 * Every one is anchored to the **end** and requires whitespace in front of it. Both halves of
 * that matter: a `#` in the middle of a line is part of a name, and a marker regex that matched
 * anywhere would cut one out of the middle of one.
 *
 * **The `^…^` arm is not the `#` arm widened.** Archidekt writes `^Keeper,#4aab08^`, where the
 * hash follows a comma rather than whitespace, so the `#` arm never saw it and the whole tail
 * stayed inside the card's name. `[^^]*` rather than `\S*` because a tag's text has spaces and
 * parentheses in it — `^Fence (flavor),#fa890d^` is one of them.
 *
 * **The bracket is no longer here**, because it is read rather than discarded: see
 * {@link stripDecorations}.
 */
const MARKERS = [/\s+\*[A-Z]\*$/, /\s+\^[^^]*\^$/, /\s+#\S+$/];

/** A trailing `[…]`, anchored like every {@link MARKERS} pattern. */
const BRACKET = /\s+\[([^\]]+)\]$/;

/**
 * Bracket contents that are a *finish* rather than a pile.
 *
 * `[Foil]` is decoration in the same way `*F*` is, and a deck named a printing rather than a
 * finish, so reading it as a category would put a pile called "Foil" in somebody's deck. Matched
 * whole and case-insensitively; anything else in a bracket is a category, because guessing which
 * words are "really" categories is the format detector this file exists without.
 */
const FINISH_WORDS = /^(?:foil|etched|non-?foil)$/i;

/** What a line carries besides its card: the text with every decoration peeled off, and the
 *  bracket if it had one. */
interface Decorations {
  body: string;
  /** Verbatim, flags and all — {@link bracketCategory} is what reads it. */
  bracket: string | null;
}

/**
 * The line with its trailing decoration removed, and its bracket kept.
 *
 * Repeatedly, to a fixed point, because each pattern is anchored to the end and a line can carry
 * three. `1x Skrelv, Defector Mite (one) 33 *F* [Protection] ^Keeper,#4aab08^` is the case: the
 * tag comes off first, which is the only thing that puts the bracket at the end, which is the
 * only thing that puts `*F*` there.
 *
 * **The first bracket peeled wins**, which is the rightmost one on the line. No export in scope
 * writes two; a line that did would be naming a pile twice and the nearer one is the later word.
 */
function stripDecorations(line: string): Decorations {
  let body = line;
  let bracket: string | null = null;
  for (;;) {
    const before = body;
    const found = BRACKET.exec(body);
    if (found !== null) {
      bracket ??= found[1];
      body = body.slice(0, found.index);
    }
    for (const marker of MARKERS) body = body.replace(marker, "");
    if (body === before) return { body, bracket };
  }
}

/**
 * A bracket's first entry, as a pile name and a flag.
 *
 * **The first entry is the pile.** Verified against a real Archidekt export: in all 105 of its
 * lines the first entry is the heading the line is printed under. The rest are the card's other
 * categories, which this app's grain could hold but an import item cannot name.
 *
 * `{flag}` suffixes come off every entry — `{top}`, `{noDeck}`, `{noPrice}` are Archidekt's, and
 * anything in braces is a flag rather than part of a name. **`{noDeck}` on the first entry is the
 * only one that means anything here**: it says this pile counts toward nothing, which is this
 * app's `is_active = 0`. On a later entry it says only that the card is *also* filed in some
 * maybeboard, and the card is still in the deck.
 */
function bracketCategory(bracket: string): { name: string; excluded: boolean } {
  const first = bracket.split(",")[0] ?? "";
  return {
    name: first.replace(/\{[^}]*\}/g, "").trim(),
    excluded: /\{noDeck\}/i.test(first),
  };
}
```

- [ ] **Step 5: Add the two fields and read the bracket**

In `interface ParsedLine`, after `section`:

```ts
  /**
   * The pile the **file** named for this line, or `null` when it named none.
   *
   * A bracket's first entry, else the name of an unknown section heading (Task 4). It is `null`
   * whenever `section` is not `"deck"`, and that invariant is the whole of what keeps
   * `plan.ts`'s precedence chain three rungs rather than four: a heading or a bracket naming one
   * of the four seeded zones sets the *section*, and only a name the section vocabulary has
   * never heard of lands here.
   */
  categoryName: string | null;
  /** The file said this card counts toward nothing — Archidekt's `{noDeck}`, which is this app's
   *  `is_active = 0`. */
  excluded: boolean;
```

In `parseDecklist`'s per-line block, replace `body = stripMarkers(body);` with:

```ts
    const decorated = stripDecorations(body);
    body = decorated.body;

    // The pile the file named for this line. A bracket naming one of the section words is the
    // *section* — `[Commander{top}]` has to reach the command zone through the one mechanism the
    // seeded piles already use — and only an unknown name is a category.
    let categoryName: string | null = null;
    let excluded = false;
    if (decorated.bracket !== null && !FINISH_WORDS.test(decorated.bracket.trim())) {
      const read = bracketCategory(decorated.bracket);
      excluded = read.excluded;
      const known = read.name === "" ? undefined : SECTIONS.get(read.name.toLowerCase());
      if (known !== undefined) lineSection = known;
      else if (read.name !== "") categoryName = read.name;
    }
    // The invariant `ParsedLine.categoryName` documents: a card in one of the four zones is
    // filed by that zone, so a free-form name only ever applies inside the deck proper.
    if (lineSection !== "deck") categoryName = null;
```

and add `categoryName` and `excluded` to the `lines.push({ … })` literal.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/features/decks/import/parse.test.ts`
Expected: PASS. `ARCHIDEKT_SECTIONED` is **not** asserted yet — Task 4 owns it.

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/import/parse.ts src/features/decks/import/parse.test.ts
git commit -m "feat(decks): read an empty set hint, an Archidekt tag and a category bracket"
```

---

### Task 4: Headings that are category names

**Files:**
- Modify: `src/features/decks/import/parse.ts`
- Modify: `src/features/decks/import/plan.ts` (the `Section` → `SectionKind` rename only — one import and one `Exclude<>`)
- Test: `src/features/decks/import/parse.test.ts`

**Interfaces:**
- Consumes: Task 3's `ParsedLine`.
- Produces: `export type SectionKind` replacing `export type Section`. `ARCHIDEKT_SECTIONED` parses to 105 lines, 117 copies, 0 issues.

- [ ] **Step 1: Write the failing tests**

```ts
  it("reads an unknown heading as the pile its cards are in", () => {
    const { lines, issues } = parseDecklist("Flash Enabler\n\n\nRamp\n1x Sol Ring (fic) 358");
    expect(issues).toEqual([]);
    // Only the second is a heading: the first is followed by a blank and then a line with no
    // quantity, so the lookahead refuses it.
    expect(lines.map((l) => l.name)).toEqual(["Flash Enabler", "Sol Ring"]);
  });

  it("opens a section on an unknown heading and closes it on the next", () => {
    const { lines } = parseDecklist(
      "Deck\n1 Sol Ring\n\nRamp\n1 Arcane Signet\n\nRemoval\n1 Path to Exile",
    );
    expect(lines.map((l) => [l.name, l.categoryName])).toEqual([
      ["Sol Ring", null],
      ["Arcane Signet", "Ramp"],
      ["Path to Exile", "Removal"],
    ]);
  });

  it("leaves a list of bare names alone", () => {
    // The lookahead is what does this: `Sol Ring` is followed by a line with no quantity, so it
    // is a card and not a heading.
    const { lines } = parseDecklist("Sol Ring\nArcane Signet\nPath to Exile");
    expect(lines.map((l) => l.name)).toEqual(["Sol Ring", "Arcane Signet", "Path to Exile"]);
  });

  it("does not eat the first card of a hand-written list that mixes counts in", () => {
    const { lines } = parseDecklist("Sol Ring\n4 Shock\n2 Duress");
    expect(lines.map((l) => l.name)).toEqual(["Sol Ring", "Shock", "Duress"]);
  });

  it("reads an unknown heading on the first line only when the cards carry brackets", () => {
    // An Archidekt deck with no commander opens on a category heading with nothing above it, and
    // Archidekt writes a bracket on every line — which is what tells it from the list above.
    const archidekt = parseDecklist("Anthem\n1x Day of Destiny (dmc) 99 [Anthem]");
    expect(archidekt.lines.map((l) => l.name)).toEqual(["Day of Destiny"]);
    const handwritten = parseDecklist("Anthem\n4 Shock");
    expect(handwritten.lines.map((l) => l.name)).toEqual(["Anthem", "Shock"]);
  });

  it("never lets a heading open a section with no cards in it", () => {
    // The lookahead requires a counted line, so a trailing heading stays a card line and is
    // quoted or resolved rather than silently swallowed.
    const { lines } = parseDecklist("Ramp\n1 Sol Ring\n\nRemoval");
    expect(lines.map((l) => l.name)).toEqual(["Sol Ring", "Removal"]);
  });

  it("reads the sectioned Archidekt export whole", () => {
    const { lines, issues, totalCards } = parseDecklist(ARCHIDEKT_SECTIONED);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(105);
    expect(totalCards).toBe(117);
    expect(lines.filter((l) => l.excluded)).toHaveLength(17);
    expect(lines.filter((l) => l.section === "commander")).toHaveLength(1);
    // The 10 cards under the `Maybeboard` heading reach the seeded pile through the section, so
    // they carry no free-form name; the 7 under `(New) Maybeboard` do.
    expect(lines.filter((l) => l.section === "maybeboard")).toHaveLength(10);
    expect(lines.filter((l) => l.categoryName === "(New) Maybeboard")).toHaveLength(7);
  });

  it("agrees with the flat export about the same deck", () => {
    const sectioned = parseDecklist(ARCHIDEKT_SECTIONED);
    const flat = parseDecklist(ARCHIDEKT_FLAT);
    const counted = (l: { excluded: boolean }) => !l.excluded;
    expect(sectioned.lines.filter(counted)).toHaveLength(flat.lines.length);
    expect(
      sectioned.lines.filter(counted).reduce((n, l) => n + l.quantity, 0),
    ).toBe(flat.totalCards);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/decks/import/parse.test.ts`
Expected: FAIL — every unknown heading is still read as a card, so `ARCHIDEKT_SECTIONED` gives 119 lines.

- [ ] **Step 3: Rename the type**

In `parse.ts`, `export type Section` becomes:

```ts
/**
 * Which of the deck's four zones a line is in — **the fixed word the rules read**, beside
 * {@link ParsedLine.categoryName}, which is the name the user (or their exporter) gave a pile.
 *
 * That is `deck_categories`' own distinction — the name is the reader's and the kind is what the
 * engine sizes a deck by — applied to a parsed line, and the rename from `Section` is what says
 * so. The starting value is `deck`, which is what makes a list with no headings at all read as a
 * deck rather than as nothing.
 */
export type SectionKind = "deck" | "commander" | "sideboard" | "companion" | "maybeboard";
```

Update `SECTIONS`'s type parameter, `sectionFor`'s return type, `ParsedLine.section`, and the two locals in `parseDecklist`. In `plan.ts`, change the type-only import and `SECTION_CATEGORY`'s `satisfies Record<Exclude<Section, "deck">, string>` to `SectionKind`. **No other file imports it** — check with a grep before and after.

- [ ] **Step 4: Add the heading rule**

Add above `parseDecklist`:

```ts
/** A count at the head of a line — the strongest signal that a line is a card and not a
 *  heading, and the same shape {@link LINE}'s `qty` group reads. */
const QUANTITY = /^\d{1,4}[xX]?\s/;

/** A trailing `(SET) 123`, `(SET)` or `() 123` — {@link LINE}'s hint, on its own, so a heading
 *  candidate can be refused for carrying one. */
const HINT_TAIL = /\s+\(\w{0,10}\)(?:\s+\S+)?$/;

/**
 * The first row after `index` that makes a claim — not blank, not a comment.
 *
 * `null` at the end of the text, which is one of the things that stops a trailing word being
 * read as a heading over nothing.
 */
function nextClaim(rows: readonly string[], index: number): string | null {
  for (let at = index + 1; at < rows.length; at += 1) {
    const trimmed = rows[at].trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return null;
}

/**
 * Is this line a section heading whose name is a pile?
 *
 * `Anthem`, `Creature` and `Land` are indistinguishable from card lines to a per-line reader, and
 * a custom category name can be a real card (`Fog`, `Wrath`, `Duress`). This is the one rule in
 * the file that reads past the line in front of it, and each clause pays for itself:
 *
 * * **No quantity, no printing hint, no bracket.** A heading is a bare word; every card line in
 *   an export that writes headings carries at least one of the three.
 * * **The next line that makes a claim carries a count.** This is what leaves a list of bare
 *   names alone — `Sol Ring` followed by `Arcane Signet` fails it — and it is *also* what makes
 *   a heading over an empty section impossible, which is how "nothing is ever silently dropped"
 *   stays true: a line consumed as a heading always opened at least one card.
 * * **Preceded by a blank line.** Without it `Sol Ring` / `4 Shock` — a hand-written list mixing
 *   bare names with counted ones — loses its first card.
 * * **Or the first line of the file, when that next line carries a bracket.** An Archidekt deck
 *   with no commander opens on a category heading with nothing above it, and Archidekt writes a
 *   bracket on every one of its lines while a hand-written list writes none.
 *
 * **The failure it keeps**, named rather than hidden: a hand-written list with a blank line, then
 * a bare card name, then a counted line, loses that name. No exporter in scope emits that shape.
 */
function namesASection(rows: readonly string[], index: number, trimmed: string): boolean {
  if (QUANTITY.test(trimmed) || HINT_TAIL.test(trimmed) || trimmed.includes("[")) return false;
  const next = nextClaim(rows, index);
  if (next === null || !QUANTITY.test(next)) return false;
  return index === 0 ? next.includes("[") : rows[index - 1].trim() === "";
}
```

- [ ] **Step 5: Use it in the loop**

`parseDecklist` needs the row index, so change `for (const [index, raw] of rows.entries())` to `for (let index = 0; index < rows.length; index += 1) { const raw = rows[index]; …`, keeping `lineNumber = index + 1`.

Add a `let sectionCategory: string | null = null;` beside `let section`. Replace the header block:

```ts
    // Checked before the `About` block below, because a header is how that block ends.
    const header = sectionFor(trimmed);
    if (header !== null) {
      section = header;
      sectionCategory = null;
      inAbout = false;
      continue;
    }

    // A heading whose name is not one of the section words is a **pile**, and it puts the reader
    // back in the deck proper: after `Commander`, a `Ramp` heading is not still the command zone.
    if (namesASection(rows, index, trimmed)) {
      section = "deck";
      sectionCategory = trimmed;
      inAbout = false;
      continue;
    }
```

Seed the per-line category from the open heading, so Task 3's bracket block overrides it rather than replacing it — change `let categoryName: string | null = null;` to `let categoryName: string | null = sectionCategory;`. The `if (lineSection !== "deck") categoryName = null;` line already there keeps the invariant true when an `SB:` prefix or a bracket moves the line into a zone.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/features/decks/import/parse.test.ts`
Expected: PASS, the whole file — the pre-existing tests included, since every one of them describes a list with no unknown headings in it.

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/import/parse.ts src/features/decks/import/plan.ts src/features/decks/import/parse.test.ts
git commit -m "feat(decks): read a decklist's own category headings"
```

---

### Task 5: The planner files by what the file said

**Files:**
- Modify: `src/features/decks/import/plan.ts`
- Test: `src/features/decks/import/plan.test.ts`

**Interfaces:**
- Consumes: `ParsedLine.categoryName`/`.excluded` (Tasks 3–4), `ImportItem.inactive` (Task 2).
- Produces: `PlannedCard.excluded: boolean`; `toImportItems` sets `inactive`.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/decks/import/plan.test.ts`, using that file's existing helpers for building a `ParsedList` and `ImportResolveRow[]` (read two neighbouring tests first — do not invent new builders).

```ts
  it("files a line by the pile the file named, over the auto rule", () => {
    // An add that names a category is untouched; a file naming one is the same statement.
    const plan = planOf([line({ name: "Sol Ring", categoryName: "Flash Enabler" })], [matchFor("Sol Ring", { typeLine: "Artifact" })]);
    expect(plan.cards[0]!.categoryName).toBe("Flash Enabler");
  });

  it("still files by the auto rule when the file named no pile", () => {
    const plan = planOf([line({ name: "Sol Ring" })], [matchFor("Sol Ring", { typeLine: "Artifact" })]);
    expect(plan.cards[0]!.categoryName).toBe("Artifact");
  });

  it("lets a section outrank a name, and a forced pile outrank both", () => {
    const sideboard = planOf([line({ name: "Sol Ring", section: "sideboard" })], [matchFor("Sol Ring")]);
    expect(sideboard.cards[0]!.categoryName).toBe("Sideboard");
    const forced = planOf(
      [line({ name: "Sol Ring", categoryName: "Flash Enabler" })],
      [matchFor("Sol Ring")],
      { forcedCategoryName: "Removal" },
    );
    expect(forced.cards[0]!.categoryName).toBe("Removal");
  });

  it("carries the excluded flag onto the item it sends", () => {
    const plan = planOf(
      [line({ name: "Sol Ring", categoryName: "(New) Maybeboard", excluded: true })],
      [matchFor("Sol Ring")],
    );
    expect(toImportItems(plan, [])).toEqual([
      { cardId: expect.any(String), quantity: 1, categoryName: "(New) Maybeboard", inactive: true },
    ]);
  });

  it("never sends an excluded commander", () => {
    // The command zone outranks the pile, so the flag that came with the pile goes with it.
    const plan = planOf(
      [line({ name: "Captain Sisay", categoryName: "(New) Maybeboard", excluded: true })],
      [matchFor("Captain Sisay")],
    );
    const [item] = toImportItems(plan, [plan.cards[0]!.match.cardId]);
    expect(item).toMatchObject({ categoryName: "Commander", inactive: false });
  });

  it("counts an excluded pile as inactive in the tally", () => {
    const items = [
      { cardId: "a", quantity: 3, categoryName: "(New) Maybeboard", inactive: true },
      { cardId: "b", quantity: 2, categoryName: "Ramp" },
    ];
    expect(tallyOf(items)).toEqual([
      { name: "Ramp", cards: 2, inactive: false },
      { name: "(New) Maybeboard", cards: 3, inactive: true },
    ]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/decks/import/plan.test.ts`
Expected: FAIL — `categoryFor` ignores the field and `toImportItems` writes no `inactive`.

- [ ] **Step 3: Rewrite `categoryFor`**

```ts
/**
 * The pile one line lands in — one chain, in the order the reader's own intent narrows.
 *
 * ```
 * forcedCategoryName        the right-click aimed this import at a pile
 *   > SECTION_CATEGORY[…]   the line is in one of the four zones
 *   > line.categoryName     the file named a pile of its own
 *   > autoCategoryFor(…)    nobody named one: file it by what the card does
 * ```
 *
 * **The zone is above the name and not below it**, which is not the order the two *arrived* in:
 * a section is a rules fact — the command zone, a sideboard — and a category name is filing. The
 * parser keeps `categoryName` `null` whenever `section` is not `"deck"`, so the two can never
 * both answer and this reads as three rungs rather than four.
 *
 * **A file naming a pile is the reader naming one.** The app's rule has always been that an add
 * naming a category is untouched and only an add naming none is filed by what the card does;
 * an Archidekt export naming `Flash Enabler` is that statement, made by the reader weeks ago in
 * somebody else's deck builder. {@link autoCategoryFor} is untouched and is still the app's one
 * filing rule for everything that names nothing.
 *
 * `forcedCategoryName` still outranks all of it, and the command zone still outranks
 * `forcedCategoryName` — applied in {@link toImportItems}, after the pile is chosen.
 */
function categoryFor(
  line: ParsedLine,
  match: ImportMatch,
  slugs: ReadonlyMap<string, readonly string[]>,
  forcedCategoryName: string | undefined,
): string {
  if (forcedCategoryName !== undefined) return forcedCategoryName;
  if (line.section !== "deck") return SECTION_CATEGORY[line.section];
  return (
    line.categoryName ??
    autoCategoryFor({ typeLine: match.typeLine, oracleTags: slugs.get(match.cardId) })
  );
}
```

- [ ] **Step 4: Carry the flag**

Add to `interface PlannedCard`:

```ts
  /** The file said this pile counts toward nothing — Archidekt's `{noDeck}`. It rides to
   *  `ImportItem.inactive`, where it switches off **only a pile the import creates**. */
  excluded: boolean;
```

Set it in `buildImportPlan`'s `cards.push({ … })` as `excluded: line.excluded`, and rewrite `toImportItems`'s body:

```ts
  const chosen = new Set(commanderIds);
  return plan.cards.map((card) => {
    const isCommander = chosen.has(card.match.cardId);
    return {
      cardId: card.match.cardId,
      quantity: card.quantity,
      categoryName: isCommander ? SECTION_CATEGORY.commander : card.categoryName,
      // The command zone outranks the pile, so the flag that came with the pile goes with it —
      // a commander in a switched-off category is a deck with no commander.
      inactive: isCommander ? false : card.excluded,
    };
  });
```

And in `tallyOf`, replace the map/`inactive` computation so an item's own flag counts:

```ts
  const copies = new Map<string, number>();
  const inactive = new Set<string>();
  for (const item of items) {
    copies.set(item.categoryName, (copies.get(item.categoryName) ?? 0) + item.quantity);
    // The seeded Maybeboard arrives switched off; a `{noDeck}` pile the import is about to make
    // will be. Either way the sentence the preview owes the reader is the same one.
    if (item.inactive === true || item.categoryName === SEEDED_INACTIVE) {
      inactive.add(item.categoryName);
    }
  }
  return [...copies]
    .map(([name, count]) => ({ name, cards: count, inactive: inactive.has(name) }))
    .sort((a, b) => tallyOrder(a.name) - tallyOrder(b.name));
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/features/decks/import/plan.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/import/plan.ts src/features/decks/import/plan.test.ts
git commit -m "feat(decks): file an imported line by the pile its file named"
```

---

### Task 6: Six export writers

**Files:**
- Modify: `src/features/decks/export/format.ts`
- Test: `src/features/decks/export/format.test.ts`

**Interfaces:**
- Consumes: `parseDecklist` (Tasks 3–4) for the round-trip test.
- Produces: `EXPORT_FORMATS` = `["plain", "mtgo", "arena", "moxfield", "archidekt", "csv"]`; `ExportCard` widened; `omittedCount(cards, format): number`.

- [ ] **Step 1: Write the failing tests**

Extend `src/features/decks/export/format.test.ts`. Its existing `card()` helper (or equivalent) needs the three new fields — give it defaults `categoryName: "Main deck"`, `categoryKind: "main"`, `categoryActive: true` so the existing tests are unchanged.

```ts
  it("writes MTGO's sideboard with an SB: prefix", () => {
    const cards = [
      card({ name: "Sol Ring" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    expect(formatExport(cards, "mtgo")).toBe("1 Sol Ring\nSB: 1 Duress\n");
  });

  it("writes Arena's and Moxfield's sections in a fixed ladder", () => {
    const cards = [
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
      card({ name: "Sol Ring" }),
      card({ name: "Captain Sisay", categoryName: "Commander", categoryKind: "commander" }),
    ];
    expect(formatExport(cards, "arena")).toBe(
      "Commander\n1 Captain Sisay (LTC) 285\n\nDeck\n1 Sol Ring (LTC) 285\n\nSideboard\n1 Duress (LTC) 285\n",
    );
  });

  it("puts a switched-off pile in Moxfield's maybeboard and leaves it out of Arena's", () => {
    const cards = [
      card({ name: "Sol Ring" }),
      card({ name: "Mox Amber", categoryName: "Ramp", categoryActive: false }),
    ];
    expect(formatExport(cards, "moxfield")).toContain("Maybeboard\n1 Mox Amber");
    expect(formatExport(cards, "arena")).not.toContain("Mox Amber");
    expect(omittedCount(cards, "arena")).toBe(1);
    expect(omittedCount(cards, "moxfield")).toBe(0);
  });

  it("counts omitted copies, not rows", () => {
    const cards = [card({ name: "Forest", quantity: 6, categoryActive: false })];
    expect(omittedCount(cards, "mtgo")).toBe(6);
  });

  it("writes Archidekt's headings, brackets and noDeck flag", () => {
    const cards = [
      card({ name: "Sol Ring", categoryName: "Ramp", setCode: "FIC", collectorNumber: "358" }),
      card({ name: "Mox Amber", categoryName: "Maybe", categoryActive: false, setCode: "DOM", collectorNumber: "224" }),
    ];
    expect(formatExport(cards, "archidekt")).toBe(
      "Ramp\n1x Sol Ring (fic) 358 [Ramp]\n\nMaybe\n1x Mox Amber (dom) 224 [Maybe{noDeck}]\n",
    );
  });

  it("gives the CSV a category column", () => {
    expect(formatExport([card({ name: "Sol Ring", categoryName: "Ramp" })], "csv")).toBe(
      "Quantity,Name,Set,Collector number,Category\n1,Sol Ring,LTC,285,Ramp\n",
    );
  });

  it("answers an empty list with an empty string in all six formats", () => {
    for (const f of EXPORT_FORMATS) expect(formatExport([], f)).toBe("");
  });

  it("round-trips every format this app can also read", () => {
    const cards = [
      card({ name: "Captain Sisay", categoryName: "Commander", categoryKind: "commander" }),
      card({ name: "Branchloft Pathway // Boulderloft Pathway", categoryName: "Land" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    // CSV is **write-only and stays so** — nothing in `parse.ts` reads a comma-separated
    // decklist, and adding one would be a second grammar rather than a rule inside the one
    // there is. Asserted by name so the gap cannot read as an oversight.
    const readable = EXPORT_FORMATS.filter((f) => f !== "csv");
    expect(readable).toEqual(["plain", "mtgo", "arena", "moxfield", "archidekt"]);
    for (const f of readable) {
      const back = parseDecklist(formatExport(cards, f));
      expect(back.issues, f).toEqual([]);
      expect(back.lines.map((l) => l.name).sort(), f).toEqual(cards.map((c) => c.name).sort());
      expect(back.totalCards, f).toBe(3);
    }
  });

  it("round-trips the piles through the formats that carry them", () => {
    const cards = [
      card({ name: "Sol Ring", categoryName: "Ramp" }),
      card({ name: "Duress", categoryName: "Sideboard", categoryKind: "side" }),
    ];
    const archidekt = parseDecklist(formatExport(cards, "archidekt"));
    expect(archidekt.lines.map((l) => l.categoryName)).toEqual(["Ramp", null]);
    expect(archidekt.lines.map((l) => l.section)).toEqual(["deck", "sideboard"]);
    const moxfield = parseDecklist(formatExport(cards, "moxfield"));
    expect(moxfield.lines.map((l) => l.section)).toEqual(["deck", "sideboard"]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/decks/export/format.test.ts`
Expected: FAIL — the format list has four entries and `omittedCount` does not exist.

- [ ] **Step 3: Widen the card and the format list**

```ts
import type { CategoryKind, DeckCard } from "@/lib/ipc";

export const EXPORT_FORMATS = ["plain", "mtgo", "arena", "moxfield", "archidekt", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  plain: "Plain text",
  mtgo: "MTGO",
  arena: "Arena",
  moxfield: "Moxfield",
  archidekt: "Archidekt",
  csv: "CSV",
};

export const EXPORT_FORMAT_EXTENSION: Record<ExportFormat, string> = {
  plain: "txt",
  mtgo: "txt",
  arena: "txt",
  moxfield: "txt",
  archidekt: "txt",
  csv: "csv",
};

/**
 * What a card needs to be exported — a `Pick` of `DeckCard`, so a whole one satisfies it.
 *
 * The three category fields are what a *deck* export needs and a category export never did: a
 * pile has one name, one kind and one switch, so a single-pile caller passes rows that all agree
 * and every grouped format writes it as one section.
 */
export type ExportCard = Pick<
  DeckCard,
  "name" | "quantity" | "setCode" | "collectorNumber" | "categoryName" | "categoryKind" | "categoryActive"
>;
```

- [ ] **Step 4: Add the section ladder and the writers**

```ts
/** The maybeboard's heading, spelled once — it is `SECTION_CATEGORY.maybeboard`'s word read
 *  backwards, and the importer's `SECTIONS` map is what reads it. */
const MAYBEBOARD = "Maybeboard";

/**
 * What a kind is called in a format whose section vocabulary is fixed.
 *
 * **Total over `CategoryKind`, with no arm for `maybe` in the sense the word suggests** — nothing
 * anywhere may branch on a kind being `maybe`, and this does not: a pile whose kind is `maybe`
 * but which the reader has switched **on** counts toward the deck like any other, so it writes
 * under `Deck`. {@link sectionOf} is where a switched-*off* pile becomes a maybeboard, and it
 * asks `categoryActive` rather than the kind, which is the whole of what `is_active = 0` means.
 */
const KIND_SECTION: Record<CategoryKind, string> = {
  commander: "Commander",
  companion: "Companion",
  main: "Deck",
  side: "Sideboard",
  maybe: "Deck",
};

/**
 * The order sections come out in — a ladder rather than an alphabet, and deliberately not
 * `sortOptions`: it is the order a decklist is read in, from the zone the game starts with down
 * to the cards that are not in the deck at all. `lib/options.ts` exempts exactly this shape.
 */
const SECTION_ORDER: readonly string[] = ["Commander", "Companion", "Deck", "Sideboard", MAYBEBOARD];

/** The section a card writes under in a fixed-vocabulary format. */
function sectionOf(card: ExportCard): string {
  return card.categoryActive ? KIND_SECTION[card.categoryKind] : MAYBEBOARD;
}

/** `quantity name`, with nothing about the printing — the shape a plain paste and MTGO share. */
function plainLine(card: ExportCard): string {
  return `${card.quantity} ${card.name}`;
}

/**
 * `quantity name (SET) collectorNumber` — the shape Moxfield and Arena share, and the one that
 * names a printing rather than just a card. Uppercased for the reason the importer uppercases
 * what it reads: `(ltc)` and `(LTC)` are the same set and a file this app wrote should pick one.
 */
function printedLine(card: ExportCard): string {
  return `${card.quantity} ${card.name} (${card.setCode.toUpperCase()}) ${card.collectorNumber}`;
}

/**
 * Archidekt's line: `1x`, a **lowercase** set code, and the pile in brackets.
 *
 * Lowercase against every other writer here on purpose — it is what Archidekt itself emits, and
 * the point of a format named for a site is that the site reads it back. Our own parser
 * uppercases what it reads, so the round trip is unaffected either way.
 *
 * `{noDeck}` on a switched-off pile is what makes an export and a re-import keep a maybeboard.
 * It is the only format here that can say it.
 */
function archidektLine(card: ExportCard): string {
  const flag = card.categoryActive ? "" : "{noDeck}";
  return `${card.quantity}x ${card.name} (${card.setCode.toLowerCase()}) ${card.collectorNumber} [${card.categoryName}${flag}]`;
}
```

Keep `csvField` as it is and extend the CSV row and header:

```ts
const CSV_HEADER = "Quantity,Name,Set,Collector number,Category";
```

with `csvField(card.categoryName)` appended to that row's array.

- [ ] **Step 5: Assemble, and answer what a format leaves out**

```ts
/**
 * The cards a format will not write, in **copies**.
 *
 * Only `arena` and `mtgo` leave anything out, and only a pile the reader has switched off:
 * neither format has a maybeboard, and writing one into an Arena deck produces an illegal import
 * at the other end. The dialog draws this number, so the omission is never silent.
 */
export function omittedCount(cards: readonly ExportCard[], format: ExportFormat): number {
  if (format !== "arena" && format !== "mtgo") return 0;
  return cards.reduce((n, card) => (card.categoryActive ? n : n + card.quantity), 0);
}

/** The cards a format writes, in the caller's own order. */
function written(cards: readonly ExportCard[], format: ExportFormat): readonly ExportCard[] {
  if (format !== "arena" && format !== "mtgo") return cards;
  return cards.filter((card) => card.categoryActive);
}

/**
 * Cards under headings: one group per key, **in first-appearance order** unless an order is
 * given.
 *
 * First appearance is what keeps this file pure — the caller's array order is the file's order,
 * so a deck's own category order needs no second argument and no `DeckCategory` here.
 */
function grouped(
  cards: readonly ExportCard[],
  keyOf: (card: ExportCard) => string,
  order?: readonly string[],
): [string, ExportCard[]][] {
  const groups = new Map<string, ExportCard[]>();
  for (const card of cards) {
    const key = keyOf(card);
    const existing = groups.get(key);
    if (existing) existing.push(card);
    else groups.set(key, [card]);
  }
  const entries = [...groups];
  if (order === undefined) return entries;
  return entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

/** Sections joined the way every export in scope writes them: a heading, its lines, a blank. */
function sections(groups: [string, ExportCard[]][], write: (card: ExportCard) => string): string {
  return groups.map(([name, cards]) => [name, ...cards.map(write)].join("\n")).join("\n\n");
}

export function formatExport(cards: readonly ExportCard[], format: ExportFormat): string {
  const rows = written(cards, format);
  if (rows.length === 0) return "";

  let text: string;
  switch (format) {
    case "plain":
      text = rows.map(plainLine).join("\n");
      break;
    case "mtgo":
      // MTGO's own export omits the printing entirely — it resolves a name against whatever
      // copies a player owns rather than pinning one. `SB:` is a one-line override rather than a
      // heading, which is exactly how the importer reads it back.
      text = rows
        .map((card) => {
          const section = sectionOf(card);
          const prefix = section === "Sideboard" || section === "Companion" ? "SB: " : "";
          return prefix + plainLine(card);
        })
        .join("\n");
      break;
    case "arena":
    case "moxfield":
      text = sections(grouped(rows, sectionOf, SECTION_ORDER), printedLine);
      break;
    case "archidekt":
      text = sections(grouped(rows, (card) => card.categoryName), archidektLine);
      break;
    case "csv":
      text = [
        CSV_HEADER,
        ...rows.map((card) =>
          [
            String(card.quantity),
            csvField(card.name),
            csvField(card.setCode),
            csvField(card.collectorNumber),
            csvField(card.categoryName),
          ].join(","),
        ),
      ].join("\n");
      break;
  }
  return text + "\n";
}
```

Update the module's own doc comment: the `LINE_WRITERS` record is gone (a grouped format writes headings as well as lines, so one function per line no longer describes it), and the empty-list rule now also covers a format that filters every card out.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/features/decks/export/format.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/export/format.ts src/features/decks/export/format.test.ts
git commit -m "feat(decks): write Arena, Archidekt and a sectioned Moxfield export"
```

---

### Task 7: The export dialog

**Files:**
- Modify: `src/features/decks/export/ExportDialog.tsx`
- Modify: `src/features/decks/export/ExportDialog.test.tsx`
- Modify: `src/features/decks/export/ExportDialog.stories.tsx`

**Interfaces:**
- Consumes: `EXPORT_FORMATS`, `omittedCount`, the widened `ExportCard` (Task 6).
- Produces: nothing new; `ExportDialogProps` is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
  it("offers all six formats", async () => {
    render(<ExportDialog {...props()} />);
    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(screen.getByRole("radio", { name: "Archidekt" })).toBeInTheDocument();
  });

  it("says how many cards a format leaves out, and stops saying it when one does not", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        {...props()}
        cards={[
          exportCard({ name: "Sol Ring" }),
          exportCard({ name: "Forest", quantity: 6, categoryActive: false }),
        ]}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "Arena" }));
    expect(screen.getByText(/6 cards in switched-off piles are not written/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Moxfield" }));
    expect(screen.queryByText(/not written in this format/)).not.toBeInTheDocument();
  });
```

Use the file's own `props()`/render helpers; add an `exportCard()` builder beside them defaulting `categoryName: "Main deck"`, `categoryKind: "main"`, `categoryActive: true`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/decks/export/ExportDialog.test.tsx`
Expected: FAIL — four radios, no omission line.

- [ ] **Step 3: Draw the line**

In `Body`, beside the `text` memo:

```ts
  /** Copies this format will not write — see `omittedCount`. Recomputed with the format, because
   *  it is a claim about the text on screen and goes stale the moment that changes. */
  const omitted = useMemo(() => omittedCount(cards, format), [cards, format]);
```

and between the radio group and the `<pre>`:

```tsx
      {/* Not a `role="alert"`: nothing failed. It is a fact about the format the reader just
          chose, and it has to be on screen before they press Copy rather than after — a
          maybeboard silently missing from an Arena export is the failure this line prevents. */}
      {omitted > 0 && (
        <p className="text-sm text-dim">
          {omitted === 1
            ? "1 card in a switched-off pile is"
            : `${omitted} cards in switched-off piles are`}{" "}
          not written in this format.
        </p>
      )}
```

Import `omittedCount` from `./format`. Update the radio group's comment: it says "the four named formats" and there are six.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/decks/export/ExportDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Fix the stories**

`ExportDialog.stories.tsx` builds `ExportCard`s and will not compile without the three new fields. Give its cards real categories — at least one story with a switched-off pile, so the omission line is visible in the workbench — and follow `.storybook/CLAUDE.md`'s conventions.

Run: `npx tsc -p .storybook --noEmit` (or `npm run build`'s type step) and `npx vitest run src/stories.test.tsx -t Export`.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/export/
git commit -m "feat(decks): offer six export formats and say what one leaves out"
```

---

### Task 8: `Export deck`

**Files:**
- Modify: `src/features/decks/DeckEditor.tsx`
- Modify: `src/features/decks/DeckEditor.test.tsx`

**Interfaces:**
- Consumes: the widened `ExportCard` (Task 6).
- Produces: `export type ExportScope`, `export function exportSubject(...)` replacing `categoryExport`, `export function layerMatches(...)`.

- [ ] **Step 1: Write the failing test**

```ts
  it("exports the whole deck from the header", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole("button", { name: "Export deck" }));
    // The dialog is titled for the deck, not for a pile — `Export "<deck>"`.
    expect(await screen.findByRole("dialog", { name: /Export "/ })).toBeInTheDocument();
  });
```

and, beside the existing `categoryExport` unit tests:

```ts
describe("exportSubject", () => {
  it("answers the whole deck for a deck scope", () => {
    const out = exportSubject({ kind: "deck" }, CATEGORIES, CARDS, "Atraxa");
    expect(out.subject).toBe("Atraxa");
    expect(out.cards).toBe(CARDS);
    expect(out.fileName).toBe("Atraxa");
  });

  it("answers one pile for a category scope, and nothing at all for a closed dialog", () => {
    expect(exportSubject({ kind: "category", categoryId: 1 }, CATEGORIES, CARDS, "Atraxa").cards)
      .toHaveLength(CARDS.filter((c) => c.categoryId === 1).length);
    expect(exportSubject(null, CATEGORIES, CARDS, "Atraxa").cards).toHaveLength(0);
  });
});

describe("layerMatches", () => {
  it("tells the header's export from a category's", () => {
    const deckScope = { kind: "export", categoryId: null } as const;
    expect(layerMatches(deckScope, deckScope)).toBe(true);
    expect(layerMatches({ kind: "export", categoryId: 3 }, deckScope)).toBe(false);
    expect(layerMatches({ kind: "tags" }, { kind: "tags" })).toBe(true);
  });
});
```

Reuse the file's existing `CATEGORIES`/`CARDS`/`renderEditor` helpers; read the neighbouring `categoryExport` tests first and rename their references.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/decks/DeckEditor.test.tsx`
Expected: FAIL — there is no `Export deck` button and no `exportSubject`.

- [ ] **Step 3: Give the export layer two scopes**

In the `Layer` union, replace the `export` arm:

```ts
  /**
   * What is being exported. **The id and not the cards**: the deck is re-read after every write
   * and this editor already holds the answer, so the dialog is fed from the live list rather than
   * from an array frozen at the moment a control was pressed.
   *
   * **`null` is the whole deck**, which is the header's `Export deck`; a number is one pile,
   * which is a category heading's right-click. Two controls, one layer — so this is the one kind
   * whose *kind* is not enough to say which button is open, and {@link layerMatches} is what
   * asks the rest.
   */
  | { kind: "export"; categoryId: number | null }
```

Rename `categoryExport` to `exportSubject` and give it the scope:

```ts
/** What the export dialog is titled when the deck has no name of its own. `DELETED_CATEGORY`'s
 *  argument applied to the other scope: `Export ""` is not an accessible name. */
const UNNAMED_DECK = "this deck";

/**
 * What is being exported: the whole deck, one pile, or — for a closed dialog — nothing.
 *
 * Three states rather than a nullable id, because `null` already means "the whole deck" here and
 * a sentinel doing two jobs is the shape this file spent a comment warning about.
 */
export type ExportScope = { kind: "deck" } | { kind: "category"; categoryId: number };

export function exportSubject(
  scope: ExportScope | null,
  categories: readonly DeckCategory[],
  cards: readonly DeckCard[],
  deckName: string,
): { subject: string; cards: readonly DeckCard[]; fileName: string } {
  if (scope === null) {
    return { subject: "", cards: NO_EXPORT_CARDS, fileName: exportFileName(deckName, "") };
  }
  if (scope.kind === "deck") {
    // Every row of the variant on screen, the switched-off piles included: what a format does
    // with a maybeboard is the *format's* decision, and `omittedCount` is what says so.
    return {
      subject: deckName === "" ? UNNAMED_DECK : deckName,
      cards,
      fileName: exportFileName(deckName, ""),
    };
  }
  const name = categories.find((c) => c.id === scope.categoryId)?.name ?? null;
  return {
    subject: name ?? DELETED_CATEGORY,
    cards: cards.filter((c) => c.categoryId === scope.categoryId),
    fileName: exportFileName(deckName, name ?? ""),
  };
}

/**
 * Is the open layer the one this control opens?
 *
 * `export` is the only kind two controls reach — the header's `Export deck` and a category
 * heading's `Export cards…` — so it is the only one where the kind alone is not the answer, and
 * a header button that read `aria-expanded` off the kind would claim to be open while a pile's
 * dialog was up.
 */
export function layerMatches(open: Layer | null, target: Layer): boolean {
  if (open === null || open.kind !== target.kind) return false;
  if (open.kind === "export" && target.kind === "export") {
    return open.categoryId === target.categoryId;
  }
  return true;
}
```

- [ ] **Step 4: Wire the editor**

Replace the `exportedId`/`exported` memo:

```ts
  const exportScope: ExportScope | null =
    layer?.kind !== "export"
      ? null
      : layer.categoryId === null
        ? { kind: "deck" }
        : { kind: "category", categoryId: layer.categoryId };
  const exported = useMemo(
    () => exportSubject(exportScope, categories, deck.cards, row?.name ?? ""),
    // `exportScope` is rebuilt every render, so the id is what the memo actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer?.kind === "export" ? layer.categoryId : undefined, categories, deck.cards, row?.name],
  );
```

If that dependency shape trips the lint rule in a way the disable does not cover cleanly, hoist the id to a `const exportedId = layer?.kind === "export" ? layer.categoryId : undefined;` and build the scope inside the memo instead — the goal is that the memo keys on the id, not on a fresh object.

Replace the header's action array and its `.map` with the layer-carrying form:

```tsx
              {ACTIONS.map(({ layer: target, label }) => (
                <button
                  key={label}
                  type="button"
                  onClick={(e) => {
                    const trigger = e.currentTarget;
                    openLayer(target, () => trigger.focus());
                  }}
                  aria-expanded={layerMatches(layer, target)}
                  aria-haspopup="dialog"
                  className={cn(CONTROL, FILTER_FOCUS, "hover:text-text")}
                >
                  {label}
                </button>
              ))}
```

with, at module scope:

```tsx
/**
 * The header's dialog buttons, each carrying the layer it opens.
 *
 * It used to carry a `kind` per row, which stopped being enough when `export` grew a payload:
 * the header exports the **whole deck** (`categoryId: null`) and a category heading exports one
 * pile, and both are the same layer kind.
 *
 * **"Import cards" and not "Import"**, which is what it said for one test run: the dialog it
 * opens carries a control called `Import`, and two buttons with one name on screen at once is a
 * pair a screen reader can only tell apart by position. **"Export deck" and not "Export cards"**
 * for the mirror of that reason — the category menu's row is already called `Export cards…`, so
 * this one names its scope, the way the gallery's `Import deck` names what it makes.
 */
const ACTIONS: readonly { layer: Layer; label: string }[] = [
  { layer: { kind: "import" }, label: "Import cards" },
  { layer: { kind: "export", categoryId: null }, label: "Export deck" },
  { layer: { kind: "categories" }, label: "Categories" },
  { layer: { kind: "tags" }, label: "Tags" },
  { layer: { kind: "history" }, label: "History" },
  { layer: { kind: "settings" }, label: "Deck settings" },
];
```

Keep the existing `openExport` wiring at the category menu — it passes a number, which the widened arm accepts unchanged.

Update the `<ExportDialog>`'s surrounding comment: it is no longer "an overlay with no control in this view", because the header now has one; the *category* scope still has none.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/features/decks/DeckEditor.test.tsx`
Expected: PASS. Grep for `categoryExport` across `src/` and fix any remaining reference.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/DeckEditor.tsx src/features/decks/DeckEditor.test.tsx
git commit -m "feat(decks): export a whole deck from the editor header"
```

---

### Task 9: The documentation

**Files:**
- Modify: `src/features/decks/CLAUDE.md` (the `## Import` and `## Export` sections)
- Modify: `src-tauri/CLAUDE.md` (the `deck_import.rs` bullets)
- Modify: `docs/reference/decks-storage.md` (the decklist-import section)

- [ ] **Step 1: Write the rules down**

In `src/features/decks/CLAUDE.md`'s Import section, add bullets covering, each in the file's existing voice (a rule, then the failure behind it):

- The parser reads four decorations and one heading rule; **the heading rule is the only lookahead in the file** and its four clauses, with the hand-written list each protects and the one failure it keeps.
- **The first bracket entry is the pile**, `{flag}`s come off, `{noDeck}` on the first entry is `is_active = 0`, on a later one it means nothing here. Verified 105/105 against a real export.
- **A bracket naming a section word sets the section, not a category** — one mechanism for the four seeded piles, not two.
- **`categoryName` is `null` whenever the section is not `deck`**, and that invariant is what makes `categoryFor` three rungs.
- The precedence chain, written out.
- **`()` is a real hint shape**, 33 of 88 lines in one export, and it costs 33 `hintMissed` rows — say the number.
- `[Foil]` is decoration, never a pile.

In the Export section:

- **Import is permissive, export is canonical**: the parser reads every variation, each writer emits one spelling.
- The six formats, and the three decisions: `mtgo` is no longer `plain`; `arena`/`mtgo` write only active piles and the dialog says how many copies that left out; `archidekt` writes `{noDeck}` and a lowercase set code, and why.
- **`KIND_SECTION` maps `maybe` to `Deck` and the switch is what makes a maybeboard** — the "nothing may branch on `maybe`" rule, held.
- **CSV is write-only** and the round-trip test names it.
- `Export deck` in the header, `Export cards…` on a heading, one `Layer` arm with two scopes, and `layerMatches`.

In `src-tauri/CLAUDE.md`, extend the `deck_import.rs` bullets with `ImportItem.inactive`: applied only to a pile the import creates, first item naming a pile decides, straight to the column rather than through `set_category_active` because that one opens its own transaction, writes history and reallocates.

In `docs/reference/decks-storage.md`, the same fact in the long-form voice, plus the corpus table from the spec.

- [ ] **Step 2: Re-count anything you wrote as a number**

CLAUDE.md's rule: a prose-only edit routes to neither CI job, so nothing goes red when a document rots. Every count in what you just wrote (105, 117, 88, 100, 17, 33, 44, six formats) must be re-derived from the fixtures or the code in this same commit — or not written down at all.

- [ ] **Step 3: Commit**

```bash
git add src/features/decks/CLAUDE.md src-tauri/CLAUDE.md docs/reference/decks-storage.md
git commit -m "docs(decks): record the import formats and the six export writers"
```

---

### Task 10: Verify, then drive the real window

**Files:** none — this task changes nothing but the plan's checkboxes and, if something is wrong, whatever it found.

- [ ] **Step 1: The whole suite, once**

Run from the worktree root: `npm run verify > verify.log 2>&1; Select-String -Path verify.log -Pattern "Test Files|test result|error"`

**Redirect to a file and grep it** — `npm run verify | tail` reports `tail`'s exit code, so a piped run reads green while tests fail. Never run two verifies at once anywhere on this machine: concurrent runs fake ~18 Rust schema failures.

Then `cd src-tauri && cargo fmt --check` — `npm run verify` does not run it and CI does.

- [ ] **Step 2: Drive the shipped window**

Follow the `running-the-app` skill (take the `app` lock first — one app across every worktree, and the collision is silent) and `docs/reference/live-ui-verification.md`. Copy the whole `data` folder in first, per `worktree-setup`.

What to establish, and what to write into `docs/reference/decks-live-findings.md` afterwards, each with the build (debug) and the window size:

1. **Import `ARCHIDEKT_SECTIONED` into a new deck.** Expect: 105 lines, 117 copies, 0 parse issues; the preview's tally naming `Flash Enabler`, `Counters`, `Stax` and both maybeboards; `(New) Maybeboard` and `Maybeboard` marked as counting toward nothing.
2. **After the import, `deck_get` reads a deck of 100** — not 117 — with the 17 in switched-off piles, and the `(New) Maybeboard` pile really is `isActive: false` while a pile the reader made by hand is not.
3. **Import the other two fixtures** into their own decks: 88 lines and 100 copies each, and `EMPTY_HINT_LIST` reporting 33 hint misses rather than 33 unmatched names.
4. **`Export deck`** from the header at 1280×800: the button is there, the row's wrap is measured (the actions block was 825px against 729px before this branch — say what it is now), all six radios draw, and the Arena format's omission line reads the right number.
5. **Round-trip in the app**: export the imported deck as Archidekt, paste it back into a second deck, and compare the two decks' piles and counts.

- [ ] **Step 3: Ship it**

Follow the `auto-pr` skill: `npm run verify`, push, open the PR, arm auto-merge, watch for the only two states GitHub abandons (a real conflict and a red `ci-ok`). The agent does not press Merge.

---

## Self-review

**Spec coverage.** §1.1 → Task 3 step 3. §1.2 → Task 3 step 4. §1.3 → Task 3 steps 4–5. §1.4–1.5 → Task 4. §1.6 → Tasks 3 and 4. §2 → Task 5. §3 → Task 2. §4 → Task 6. §5 → Tasks 7–8. §6 → the test steps in each task, plus Task 10. §7 (what this does not do) is carried as Global Constraints and as the round-trip test's named CSV exclusion.

**Type consistency.** `SectionKind` is introduced in Task 4 and used in Tasks 4–5 only. `ParsedLine.categoryName`/`.excluded` are created in Task 3 and read in Tasks 4–5. `ImportItem.inactive` is created in Task 2 (optional in TS, `#[serde(default)]` in Rust) and set in Task 5. `ExportCard`'s three new fields are added in Task 6 and consumed in Tasks 7–8. `omittedCount` is Task 6's, used in Task 7. `exportSubject`/`ExportScope`/`layerMatches` are Task 8's and used nowhere else.

**Known soft spots, called out rather than hidden.** Three test snippets say "read the neighbouring tests first" instead of quoting a helper: the Rust deck-creation helper in `deck_import.rs`'s `mod tests`, `plan.test.ts`'s `planOf`/`line`/`matchFor` builders, and `DeckEditor.test.tsx`'s `renderEditor`/`CATEGORIES`/`CARDS`. Those helpers exist and are stable, but their exact signatures were not read while writing this plan, and inventing one would be worse than saying so.
