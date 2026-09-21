# Deck notes redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the deck editor's notes band from a list of expanding rows into a masonry of
note cards, and move every act that used to unfold inside a row — write, edit, name cards — into
two dialogs.

**Architecture:** Four changes, and only one reaches Rust. The band's `<ul>` becomes a masonry
grid of fixed-width, natural-height cards (the repo's own `StackView` technique, extracted to a
shared module). `NoteEditForm`, `NoteCards` and the add row are deleted; a `New note` button in
the band header and an `Edit` on each card open one editor dialog, and `Cards` opens a picker
dialog built on `PullFromCollectionDialog`'s grammar. The three single-tenant `useState` flags
collapse to one nullable union. Rust's `attachments_by_note` widens to name a representative
**printing** per attachment, so a note card can draw art crops of the cards it names.

**Tech Stack:** React 19 + TypeScript 6 (`strict`), Tailwind v4, Tiptap v3 behind `React.lazy`,
TanStack Query, Vitest + Testing Library, Storybook 9, Rust + rusqlite (SQLite).

**Spec:** [`docs/superpowers/specs/2026-09-20-deck-notes-redesign.md`](../specs/2026-09-20-deck-notes-redesign.md),
with its four Design-canvas artboards in
[`docs/superpowers/specs/deck-notes-redesign/`](../specs/deck-notes-redesign/). Both were copied
into this branch alongside this plan; read the spec **and** this document's
"Decisions that override the spec" before starting Task 1.

---

## Global Constraints

Copied verbatim from the spec and from the `CLAUDE.md` files that govern the areas this touches.
Every task's requirements implicitly include this section.

- **A _tag_ in this app is a Scryfall Oracle or Art tag and nothing else.** The deckbuilder's
  coloured per-card mark is a **label**. Nothing in this plan is a tag or a label; the words must
  not trade places.
- **Rust supplies facts; TS draws conclusions.** `deck_notes.rs` widens a `SELECT`. Which cards a
  picker offers, what a blank title reads as, and which type bucket a card falls in are all
  TypeScript's.
- **The Tiptap chunk rule.** `@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/markdown` measured
  **141.5 kB gzip** against the app's own 481.45 kB (`esbuild --bundle --minify`, React external,
  `gzip -9`, 2026-09-10). `NoteEditor` is reachable **only** through `React.lazy` over a dynamic
  import. `DeckNotesPanel.test.tsx`'s `is reached by nothing but a dynamic import` sweeps every
  `/src/**/*.{ts,tsx}` for a static one; it must stay green and its exemption list must keep
  naming only `NoteEditor.*` and `.test.` files.
- **Never install `@types/node`.** Tests that need a file's text read it through Vite's `?raw`,
  never `node:fs`.
- **`<section>`, never `<aside>`.** A second complementary landmark broke five `App.test.tsx`
  pane assertions. `shrink-0` on the band's root is mandatory. The band stays below Deck stats.
- **The disclosure is a control even at zero notes**, and the notes read runs while the band is
  shut so the header can count.
- **`select-text` stays on the band's body** — the editor refuses text selection at its root
  (issue #473).
- **No `setState` inside an effect.** `react-hooks/set-state-in-effect` refuses it outright; `tsc`
  and vitest are both green on the pattern it refuses, so it only goes red at `npm run verify`.
  Use React's *adjusting state when a prop changes* (setState during render) as the existing file
  already does.
- **A note names a card by `oracle_id`, never by `card_id`.** Nothing in this plan changes that.
  The printing added in Task 2 is a **representative for drawing a picture**, and is never matched
  on, never written, and never synced.
- **No migration.** `deck_note_cards` is unchanged, so the fifteen synced tables, the grain index
  and `deck_undo`'s attachment snapshot are all untouched. Task 2 is a read widening and nothing
  else.
- **Commit after every task** with `feat:` / `fix:` / `chore:` / `test:`.
- **Tests run once, at the end, after fan-in.** `npm run verify` before the commit that closes the
  branch — never N times inside N subagents.
- **`npm run verify` does not run `cargo fmt --check` or `cargo clippy`.** CI runs both. After any
  Rust edit, run `cargo fmt` and `cargo clippy --all-targets -- -D warnings` in `src-tauri/`
  yourself.
- **Never run two `npm run verify` at once** — concurrent runs fake ~18 Rust schema failures.
- **`npm run verify`'s exit code lies through a pipe.** Never `| tail`; read the whole output or
  redirect to a file and read the file.

---

## Decisions that override the spec

The spec closes with five open questions and says *decide these before building*. All five were
settled on 2026-09-20. Two of the answers **contradict the spec's own body**; where they do, this
plan wins and the spec is wrong.

### 1. Cards grow to fit their text. ⚠️ This replaces §1's fixed height and its clamp table.

The spec's §1 fixes a card at **184px** and pays for the thumbnail strip with a
`-webkit-line-clamp` of 3 (6 without a strip), arguing that *a grid whose tiles disagree about
their height reads as a failed masonry*. The decision reverses that argument rather than the
layout: **do the masonry properly.** A card is as tall as its note, `min-height: 184px` is the
floor so a one-line note is still a card, and what stays uniform is the **gap**, never the height.

Three consequences, all of which shrink the work:

- **The clamp table is deleted.** There is no `-webkit-line-clamp`, no 3-vs-6 branch, and the
  thumbnail strip no longer costs body lines.
- **Spec open question 1 dissolves.** *"Three clamped lines is a preview and there is now no way
  to read the rest"* stops being true — the whole body is on the card. There is **no read dialog**
  and the card's body is **not** a control.
- **184px stops being a height and becomes `min-h-[11.5rem]`.**

The technique is not new to this repo. `src/features/decks/views/StackView.tsx` has shipped a
masonry since 2026-08-15: a grid of **one-pixel rows** (`gridAutoRows: 1px`, `rowGap: 0`) in which
each item spans its own measured height plus one gutter, so CSS Grid's row-major placement puts a
wrapped item at the foot of the shortest column rather than under the tallest item of a shared
line. `align-items: start` is what forbids a measure → span → measure feedback loop, because a
content-sized item's height cannot depend on the span it was given. Task 1 extracts that pair.

**Why not CSS multi-column** (`columns: 280px`), which also gives uniform gaps for free: it lays
items out **column-major**, so notes in `sort_order` would read 1-2-3 down the left column instead
of left to right. The band is a strip at the foot of a page, usually one or two rows tall, where
that is plainly wrong. **Why not `grid-template-rows: masonry`:** still behind a flag in Chromium,
and this app ships against whatever WebView2 the reader's machine has.

**No ceiling on a card's height.** The decision specified a minimum and no maximum, and that is
`StackView`'s own standing for a forty-card pile. A very long note therefore makes one very tall
card in one column. If a live pass finds that ugly, a `max-h` with the rest behind `Edit` is the
change — but do not add one speculatively.

### 2. The empty state — decided in this plan, not asked

With the add row gone, "no notes yet" is a sentence plus the header button. Keep it **one line in
the place the current sentence already occupies** (`text-xs text-dim`, inside the open band),
reworded to point at the control that replaced the field it used to point at:

> No notes on this deck yet — press **New note** to write one.

Not the `mx-auto max-w-md px-2 py-6 text-center` box: that is the house shape for an empty
**dialog body**, and this is the foot of a page a reader has scrolled to deliberately.

### 3. `Add note…` creates on **Save**. This replaces §2's create-first behaviour.

The card menu's `Add note…` writes nothing on the press. It opens the editor dialog seeded with
the card; **Save** is the create, carrying `oracleIds: [card.oracleId]` in the same transaction it
always did. Cancel leaves nothing behind. This also deletes `DeckEditor.tsx`'s `title: card.name`
special case, which §2 contradicts anyway — the dialog writes `title: ""` and `noteTitle()` reads
the first line.

What it costs: the card's `Notes ▸` submenu gains its row on the invalidate after Save rather than
on the press. One round trip.

### 4. The picker's chips are keyed on **card type**, not on deck pile. This replaces §4.

The spec drew `All 34` · `Named 2` · `Lands 37` · `Creatures 28` from the deck's **categories**.
The decision is *use the card types*: the rungs are `All` · `Named` · then one per
`deckBuckets.ts` **type bucket** present in the deck, in `TYPE_BUCKETS` order
(`Creature, Planeswalker, Instant, Sorcery, Artifact, Enchantment, Battle, Land`, then `Other`).

A type is a fact about the card; a pile is the reader's own filing, and two piles may legally
share a name. `typeBucket()` already exists, is already tested, and already reads the **front**
face of a `//` type line — the rule a modal DFC needs.

**Consequence for the row:** §4's row draws `SET · number` and *"the pile it sits in"* on its
second line. That becomes `SET · number` and the **type bucket**, so the word on the row is the
word on the chip that selected it. A reader filtering to `Land` and seeing a row captioned
`Ramp` could not tell why it matched.

### 5. Three thumbnails, fixed. §5 stands unchanged.

Three 44×32 crops then a `+N more` chip. No measurement, no observer; the number is a constant a
test can name.

---

## File Structure

`DeckNotesPanel.tsx` is 1154 lines today and is about to lose three components and gain two
dialogs. It splits. Every new file is a sibling in `src/features/decks/`, which is where
`PullFromCollectionDialog.tsx`, `TheoryDiffDialog.tsx` and `LabelsDialog.tsx` already live —
one dialog, one file, one test, one story.

| File | Responsibility |
| --- | --- |
| `src/features/decks/masonry.ts` | **new** — `masonryRowSpan(height, gapY)` and `useMasonryRowSpan(gapY, enabled)`, lifted out of `StackView.tsx` so two surfaces share one set of traps |
| `src/features/decks/views/StackView.tsx` | **modified** — deletes its private copy of the pair, keeps its one-arg `flowRowSpan` export as a wrapper so `views.test.tsx` is untouched |
| `src-tauri/src/deck_notes.rs` | **modified** — `attachments_by_note` names a representative printing per attachment; `DeckNoteCard` gains `card_id` and `image_uris` |
| `src/lib/ipc.ts` | **modified** — `DeckNoteCard.cardId` and `.imageUris`; `DeckNoteRequest`'s add arm narrows to the two fields it actually carries |
| `src/features/decks/deckNotes.ts` | **modified** — gains `NoteCardChoice`, `attachableCards` (moved here from the panel) and `typeChipCounts`. `noteTitle` is untouched but promoted to the primary naming path |
| `src/features/decks/NoteCard.tsx` | **new** — one note as a grid item: name, body, thumbnail strip, three actions, and its own masonry span |
| `src/features/decks/NoteEditorDialog.tsx` | **new** — §2/§3's one dialog, in three modes (new / new-from-card / edit). Holds the only `React.lazy` reference to `NoteEditor` |
| `src/features/decks/NoteCardsDialog.tsx` | **new** — §4's picker |
| `src/features/decks/NoteEditor.tsx` | **modified** — a placeholder on the empty surface. Nothing else |
| `src/features/decks/DeckNotesPanel.tsx` | **modified** — the band: header + `New note`, the masonry `<ul>`, the one-panel union. `NoteRow`, `NoteEditForm`, `NoteCards`, `DeleteNote` and the add row leave |
| `src/features/decks/DeckEditor.tsx` | **modified** — `addNote` stops carrying a title |
| `package.json` | **modified** — `@tiptap/extensions` promoted from transitive to declared |

Test and story files follow their component. `DeckNotesPanel.test.tsx` keeps the band's own
assertions and the lazy-import fence; each new component gets its own test file.

---

## Task order and what may run in parallel

Tasks 1, 2 and 3 are independent of each other and may be dispatched together. Task 4 needs 3.
Tasks 5, 6 and 7 each need 4 (and 7 needs 1 and 2 as well) but not each other — dispatch the three
together. Task 8 needs 5, 6 and 7. Tasks 9 and 10 need 8.

**Two subagents editing the same file clobber each other.** The buckets above are disjoint by
file; do not let a subagent touch `DeckNotesPanel.tsx` before Task 8.

---

### Task 1: One masonry, shared

**Files:**
- Create: `src/features/decks/masonry.ts`
- Create: `src/features/decks/masonry.test.ts`
- Modify: `src/features/decks/views/StackView.tsx:126-194` (delete `flowRowSpan`'s body and the
  whole of `useFlowRowSpan`, import them instead)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `masonryRowSpan(height: number, gapY: number): number`
  - `useMasonryRowSpan(gapY: number, enabled?: boolean): { elementRef: RefObject<HTMLElement | null>; span: number | null }`
  - `StackView.tsx` keeps exporting `flowRowSpan(height: number): number` unchanged in arity and
    in value, so `views/views.test.tsx:1441-1444` needs no edit.

- [ ] **Step 1: Write the failing test**

Create `src/features/decks/masonry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { masonryRowSpan } from "./masonry";

/**
 * The arithmetic `StackView` has shipped since 2026-08-15, now taking its gutter as an argument.
 * The four rows below are `views.test.tsx`'s own, re-stated against a 20px gutter so that a
 * change here that broke the deck's stack view would fail in both files rather than in one.
 */
describe("a masonry row span", () => {
  it("is the height plus one gutter, rounded up", () => {
    expect(masonryRowSpan(300, 20)).toBe(320);
    expect(masonryRowSpan(300.2, 20)).toBe(321);
  });

  it("is the gutter alone for a box nothing has laid out — which is every box in jsdom", () => {
    expect(masonryRowSpan(0, 20)).toBe(20);
    expect(masonryRowSpan(0, 8)).toBe(8);
  });

  it("never answers a span a grid would throw away", () => {
    // `grid-row: span 0` is invalid and is dropped, which would stack every card at row 1.
    expect(masonryRowSpan(-40, 20)).toBe(1);
    expect(masonryRowSpan(0, 0)).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
npm run test:run -- src/features/decks/masonry.test.ts
```

Expected: FAIL — `Failed to resolve import "./masonry"`.

- [ ] **Step 3: Write `src/features/decks/masonry.ts`**

```ts
/**
 * A masonry over CSS Grid: one-pixel rows, and an item that spans its own measured height.
 *
 * **Lifted out of `views/StackView.tsx`, which has shipped this since 2026-08-15** and which
 * still holds the argument for it in full. The short version: a grid of `auto-fill` tracks whose
 * rows are one pixel each turns CSS Grid's ordinary row-major placement into a masonry, because
 * "the next free cell at or after the cursor" becomes "the foot of the shortest column that is
 * not in the way". A wrapping flex box cannot do it — a flex line is as tall as its tallest item,
 * which is the whole defect both surfaces exist to avoid.
 *
 * **The gutter is an argument and not a constant**, which is the only difference from the
 * original: the deck's stack view spaces its piles by 20px and the notes band spaces its cards by
 * 8, and one module that took a side would make one of them wrong.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * How many one-pixel rows a box of this height claims — its height, plus the one gutter under it.
 *
 * `Math.ceil` because a measured height is fractional and a span is an integer: rounding **up** is
 * the only safe direction, since a span a pixel short would let the box below start a pixel inside
 * this one. `Math.max(1, …)` because `grid-row: span 0` is invalid and would be dropped — and
 * because **jsdom measures every box as 0**, so a suite that never sees a layout still has to
 * produce a legal span.
 */
export function masonryRowSpan(height: number, gapY: number): number {
  return Math.max(1, Math.ceil(height) + gapY);
}

/**
 * A box's own height, measured, as a row span — `null` until it has been.
 *
 * **The measurement is of the item, never of the box the items are in.** How many columns fit is
 * CSS's answer (`repeat(auto-fill, …)`, which needs no number from us), and what an item measures
 * cannot be derived from it: a heading wraps or it does not, and only the browser knows.
 *
 * **There is no feedback loop, and `align-items: start` is what forbids one.** A grid item aligned
 * to the start of its area is sized by its content, so its height does not depend on the span it
 * is given; the span depends on the height and never the other way round. Stretch it — the
 * default — and this oscillates.
 *
 * The read is a `useLayoutEffect` on **every** render rather than a dependency list, so a span is
 * never a frame behind the thing that changed it. It runs before paint, so the first frame an item
 * is drawn in already has its right span. The `ResizeObserver` beside it is for the changes no
 * render of the host causes — a panel dragged narrower until a line wraps, a font arriving late.
 */
export function useMasonryRowSpan(gapY: number, enabled = true) {
  // The name has to end in `Ref` — `react-hooks/immutability` refuses a write to anything else a
  // hook returned.
  const elementRef = useRef<HTMLElement | null>(null);
  const [span, setSpan] = useState<number | null>(null);

  const read = useCallback(() => {
    const node = elementRef.current;
    if (!node || !enabled) return;
    // Setting the value it already holds is a bail-out in React, so the every-render read costs
    // one extra pass only when the box has actually changed height.
    setSpan(masonryRowSpan(node.getBoundingClientRect().height, gapY));
  }, [enabled, gapY]);

  useLayoutEffect(read);

  useEffect(() => {
    const node = elementRef.current;
    if (!node || !enabled) return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, read]);

  return { elementRef, span };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:run -- src/features/decks/masonry.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Point `StackView` at it**

In `src/features/decks/views/StackView.tsx`, add to the import block:

```ts
import { masonryRowSpan, useMasonryRowSpan } from "../masonry";
```

Replace the body of `flowRowSpan` (keep the export, the name and the one-argument signature — and
keep its existing doc comment, adding the pointer line):

```ts
/**
 * How many rows of the flowing grid a pile of this pixel height claims — its height, plus the one
 * gutter under it.
 *
 * **The arithmetic is `masonry.ts`'s now**, shared with the notes band, which spaces its cards by
 * 8 where this spaces its piles by {@link FLOW_GAP_Y}'s 20. The one-argument signature stays
 * because this view's gutter is a constant and `views.test.tsx` pins the four values it answers.
 */
export function flowRowSpan(height: number): number {
  return masonryRowSpan(height, FLOW_GAP_Y);
}
```

Delete the whole of `function useFlowRowSpan(enabled: boolean) { … }` (the ~30 lines ending in
`return { elementRef, span };`) and its doc comment, replacing it with a one-line pointer:

```ts
/** A pile's own height as a row span — `masonry.ts`'s hook at this view's gutter. `enabled` is
 *  false in the rail, which is a `flex-col` box where a grid row means nothing. */
const useFlowRowSpan = (enabled: boolean) => useMasonryRowSpan(FLOW_GAP_Y, enabled);
```

Leave `FLOW_ROW`, `FLOW_GAP_Y`, `ROOT_GUTTER` and every call site alone.

- [ ] **Step 6: Prove the stack view did not move**

```bash
npm run test:run -- src/features/decks/views/views.test.tsx
```

Expected: PASS, with no edit to `views.test.tsx`. If `flowRowSpan(300)` no longer answers 320, the
wrapper lost its constant.

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/masonry.ts src/features/decks/masonry.test.ts src/features/decks/views/StackView.tsx
git commit -m "refactor(decks): share the masonry row-span between StackView and the notes band"
```

---

### Task 2: A representative printing per attachment (Rust)

**Files:**
- Modify: `src-tauri/src/deck_notes.rs` — `DeckNoteCard` (around line 140), `attachments_by_note`
  (line 239), and the two call sites' row readers
- Test: `src-tauri/src/deck_notes.rs`'s own `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: nothing.
- Produces: `DeckNoteCard { oracle_id: String, name: String, card_id: Option<String>,
  image_uris: Option<BTreeMap<String, String>> }`, serialised camelCase as `oracleId`, `name`,
  `cardId`, `imageUris`. Task 3 mirrors it into `ipc.ts`; Task 7 draws it.

⚠️ **The spec's §5 SQL has a defect. Do not type it in.** It picks the name and the card id with
two *independent* aggregates — `coalesce(min(c.name), …)` and
`min(CASE WHEN dc.card_id IS NOT NULL THEN c.id END)` — which is harmless for the name (every
printing of one oracle card shares it) and is a real bug the moment a third column joins them:
`min(json_extract(c.image_uris, '$.art'))` would answer a **different printing's** picture from
the one `min(c.id)` named. The form below picks one printing **as a row** and takes every column
off it, which also lets the `GROUP BY` go away entirely.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/deck_notes.rs`'s `mod tests`. Find the existing helpers it uses to make a
deck, a note and a card (`attachments_by_note`'s own tests are already there — reuse their fixture
functions rather than writing new ones; the test named around line 984 already builds an orphan
attachment out of the fallback).

```rust
/// A note names one card the deck holds and one it does not, and each answers a printing that
/// can be drawn.
///
/// **The deck's own printing wins, and the tie-break below it is `c.id`.** Two printings of one
/// oracle card are the same card to a note — it attaches by oracle id on purpose — but only one
/// of them is the picture the reader is looking at in the deck, and a thumbnail of the other is a
/// note that appears to name a card the deck does not hold.
#[test]
fn an_attachment_names_the_printing_this_deck_holds() {
    let conn = crate::schema::memory_pair();
    // Two printings of one oracle card: `aaa` sorts first by id, `zzz` is the one in the deck.
    conn.execute(
        "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, oracle_id, image_uris, raw)
         VALUES ('aaa','Bolt','lea','161','en','normal','o-bolt',
                 json_object('art','https://cards.scryfall.io/art/front/a/a/a.webp?1'), '{}'),
                ('zzz','Bolt','m10','146','en','normal','o-bolt',
                 json_object('art','https://cards.scryfall.io/art/front/z/z/z.webp?1'), '{}')",
        [],
    )
    .unwrap();
    let deck = crate::deck::create_deck(&conn, "Burn", "modern").unwrap().id;
    let category = crate::deck_meta::list_categories(&conn, deck).unwrap()[0].id;
    crate::deck::add_card(&conn, deck, "zzz", category, 1, "live", "nonfoil").unwrap();

    let note = create_note(&conn, deck, "", "Body", &["o-bolt".into()]).unwrap();
    let card = &note.cards[0];

    assert_eq!(card.card_id.as_deref(), Some("zzz"));
    assert_eq!(
        card.image_uris.as_ref().and_then(|m| m.get("art")).map(String::as_str),
        Some("https://cards.scryfall.io/art/front/z/z/z.webp?1"),
    );
}

/// A card the deck no longer holds still answers a printing — the note keeps the card it names
/// after the card is cut, which is the whole standing this module is built on.
#[test]
fn an_attachment_the_deck_no_longer_holds_still_answers_a_printing() {
    let conn = crate::schema::memory_pair();
    conn.execute(
        "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, oracle_id, raw)
         VALUES ('aaa','Bolt','lea','161','en','normal','o-bolt','{}')",
        [],
    )
    .unwrap();
    let deck = crate::deck::create_deck(&conn, "Burn", "modern").unwrap().id;

    let note = create_note(&conn, deck, "", "Body", &["o-bolt".into()]).unwrap();
    let card = &note.cards[0];

    assert_eq!(card.card_id.as_deref(), Some("aaa"));
    // No fetchable picture anywhere on the row is `None`, never an empty map.
    assert!(card.image_uris.is_none());
}

/// An oracle id the corpus has never heard of keeps naming itself, and draws no frame.
#[test]
fn an_orphan_attachment_carries_no_printing() {
    let conn = crate::schema::memory_pair();
    let deck = crate::deck::create_deck(&conn, "Burn", "modern").unwrap().id;

    let note = create_note(&conn, deck, "", "Body", &["o-unknown".into()]).unwrap();
    let card = &note.cards[0];

    assert_eq!(card.name, "o-unknown");
    assert_eq!(card.card_id, None);
    assert!(card.image_uris.is_none());
}

/// The printing multiplication the old `GROUP BY` collapsed is still collapsed — one row per
/// attachment, whatever the corpus holds.
#[test]
fn many_printings_of_one_card_are_still_one_attachment() {
    let conn = crate::schema::memory_pair();
    for id in ["a1", "a2", "a3", "a4"] {
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, oracle_id, raw)
             VALUES (?1,'Bolt','lea','161','en','normal','o-bolt','{}')",
            params![id],
        )
        .unwrap();
    }
    let deck = crate::deck::create_deck(&conn, "Burn", "modern").unwrap().id;

    let note = create_note(&conn, deck, "", "Body", &["o-bolt".into()]).unwrap();

    assert_eq!(note.cards.len(), 1);
    assert_eq!(note.cards[0].card_id.as_deref(), Some("a1"));
}
```

> If the helper names above (`crate::deck::create_deck`, `crate::deck::add_card`,
> `crate::deck_meta::list_categories`, `crate::schema::memory_pair`) do not match what the
> existing tests in this module call, **use whatever those tests call**. Read the module's
> `mod tests` header first; it is the authority on this file's fixtures, not this plan.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd src-tauri && cargo test deck_notes:: 2>&1 | tail -40
```

Expected: FAIL — `no field 'card_id' on type 'DeckNoteCard'`.

⚠️ **Check that the module is actually declared in `lib.rs` before trusting a green run.** An
undeclared module makes every `cargo test` over it vacuous; `deck_notes` is declared today, but
confirm it rather than assume it.

- [ ] **Step 3: Widen the DTO**

In `src-tauri/src/deck_notes.rs`, replace the `DeckNoteCard` struct (keeping its existing doc
comment and appending the two paragraphs):

```rust
/// One card a note names.
///
/// `name` is a **convenience and not a key**: it is resolved from the corpus at read time, and an
/// oracle id the corpus has never heard of is named by the id itself rather than by nothing. Two
/// devices that synced on different days can honestly disagree about it, which is why nothing is
/// ever matched on it.
///
/// `card_id` and `image_uris` are the same kind of thing one step further: a **representative
/// printing**, chosen at read time so a note card can draw a picture of what it names. A note
/// attaches by oracle id and by nothing else — this printing is never written, never matched on
/// and never synced, and the next reader of the same row may honestly get a different one.
///
/// **The deck's own printing is preferred**, falling back to any printing the corpus holds. A note
/// about Lightning Bolt in a deck sleeving the M10 art must not draw the Alpha art: the picture is
/// how a reader recognises the row, and the wrong one reads as a note naming a card that is not in
/// the deck. `None` is the orphan — the `name` fallback already covers it, and the card draws an
/// empty frame rather than a broken image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckNoteCard {
    pub oracle_id: String,
    pub name: String,
    pub card_id: Option<String>,
    pub image_uris: Option<BTreeMap<String, String>>,
}
```

Add `use std::collections::BTreeMap;` to the file's imports if it is not already there (it already
imports `HashMap`; put `BTreeMap` beside it).

- [ ] **Step 4: Rewrite the statement**

Replace `attachments_by_note`'s body. The doc comment's three bullets change to four:

```rust
/// Every attachment matching one filter, grouped by note.
///
/// **This is the second of [`list_notes`]' two statements, and it is why there is no N+1.** One
/// query answers every attachment of every note in the deck; the caller zips them onto the notes
/// it already read.
///
/// Four things about the SQL:
///
/// * **One printing is chosen as a *row*, by a correlated subquery, and every column is taken off
///   that row.** This replaces the `GROUP BY` + `min()` the statement used to carry, and the
///   reason is [`DeckNoteCard::image_uris`]: two independent aggregates over a joined `cards` can
///   answer one printing's id and a different printing's picture, which is a wrong card's art with
///   no way for any caller to notice. A subquery that answers one `id` makes that unrepresentable.
/// * **`ORDER BY (dc.card_id IS NULL), c.id` inside it is the preference.** SQLite sorts `0`
///   before `1`, so a printing this deck holds comes first and `c.id` breaks the tie — which is
///   the same printing the old `min(c.id)` chose whenever the deck held none.
/// * **The `GROUP BY` is gone and no row count moved.** `deck_note_cards` carries
///   [`DECK_NOTE_CARD_GRAIN`](crate::schema::DECK_NOTE_CARD_GRAIN) on `(note_id, oracle_id)`, so
///   there is one row per attachment to begin with, and a `LEFT JOIN` on `p.id = (scalar)` matches
///   at most one. The printing multiplication the old comment warned about is collapsed by the
///   subquery instead.
/// * **`LEFT JOIN`, so a card the corpus has never heard of is still an attachment**, named by its
///   own oracle id. The reference is soft like every other card reference in a user table, and a
///   note that refused to load because a printing has not been synced yet would be a note the
///   reader cannot reach.
///
/// `cards(oracle_id)` is indexed (`idx_cards_oracle`), which is what keeps the subquery from being
/// a scan per attachment.
fn attachments_by_note(
    conn: &Connection,
    filter: &str,
    id: i64,
) -> Result<HashMap<i64, Vec<DeckNoteCard>>, String> {
    let images = crate::image_uri::front_face_selects("p").join(", ");
    let sql = format!(
        "SELECT nc.note_id,
                nc.oracle_id,
                coalesce(p.name, nc.oracle_id),
                p.id,
                {images}
           FROM deck_note_cards nc
           JOIN deck_notes n ON n.id = nc.note_id
           LEFT JOIN cards p ON p.id = (
                SELECT c.id
                  FROM cards c
                  LEFT JOIN deck_cards dc ON dc.card_id = c.id AND dc.deck_id = n.deck_id
                 WHERE c.oracle_id = nc.oracle_id
                 ORDER BY (dc.card_id IS NULL), c.id
                 LIMIT 1
           )
          WHERE {filter}
          ORDER BY nc.note_id, coalesce(p.name, nc.oracle_id), nc.oracle_id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                DeckNoteCard {
                    oracle_id: r.get(1)?,
                    name: r.get(2)?,
                    card_id: r.get(3)?,
                    // **From 4** — the `crate::image_uri::FRONT_FACE_COLUMNS` expressions
                    // `front_face_selects` appended, in the (top-level, face) pairs
                    // `front_face_map` folds back up, one pair per variant. The offset moves with
                    // every column added to the named list above it.
                    image_uris: crate::image_uri::front_face_map(|i| r.get(4 + i))?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out: HashMap<i64, Vec<DeckNoteCard>> = HashMap::new();
    for row in rows {
        let (note_id, card) = row.map_err(|e| e.to_string())?;
        out.entry(note_id).or_default().push(card);
    }
    Ok(out)
}
```

- [ ] **Step 5: Fix every other construction of a `DeckNoteCard`**

```bash
cd src-tauri && cargo build 2>&1 | grep -n "missing field" -A 3
```

Add `card_id: None, image_uris: None` to each construction the compiler names (test fixtures
elsewhere in the crate, and any `web/route.rs` shape if one exists). Do **not** add a `Default`
impl — the fields being spelled at every site is what makes a new reader think about which
printing they mean.

- [ ] **Step 6: Run the tests**

```bash
cd src-tauri && cargo test deck_notes:: 2>&1 | tail -20
cd src-tauri && cargo test 2>&1 | tail -20
```

Expected: PASS. Then:

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings 2>&1 | tail -20
```

Expected: no output from clippy. **`npm run verify` runs neither of these** — CI does, and they
are the only reds a green verify allows.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/deck_notes.rs
git commit -m "feat(notes): name a representative printing for each card a note names"
```

---

### Task 3: The wire type

**Files:**
- Modify: `src/lib/ipc.ts` — `DeckNoteCard` (line 4385) and `DeckNoteRequest`'s consumer type
- Test: `src/lib/ipc.test.ts` (the parity fence already exists — this task proves it bites)

**Interfaces:**
- Consumes: Task 2's Rust struct.
- Produces: `DeckNoteCard { oracleId: string; name: string; cardId: string | null;
  imageUris?: Partial<Record<ImageVariant, string>> | null }`.

- [ ] **Step 1: Run the fence and watch it go red on its own**

`src/lib/ipc.test.ts:4558` already carries the row `["DeckNoteCard", deckNotesRs, "DeckNoteCard"]`
— a field-by-field parity check that reads `deck_notes.rs` through `?raw`. Task 2 widened the Rust
side, so it is already failing:

```bash
npm run test:run -- src/lib/ipc.test.ts
```

Expected: FAIL, naming `cardId` and `imageUris` as declared in Rust and missing in `ipc.ts`. **If
it passes, stop and find out why** — a `vi.fn()` mock erasing the ipc mirror makes this fence
vacuous, and a new field then fails at runtime rather than at `tsc`.

- [ ] **Step 2: Widen the TypeScript side**

In `src/lib/ipc.ts`, replace the `DeckNoteCard` interface (keeping its existing doc comment and
appending):

```ts
/**
 * One card a note names: the identity, and the word to print for it.
 *
 * `oracleId` is the card **across every printing of it**, which is what a note attaches by —
 * see {@link DeckNote}. `name` is a convenience the backend joins from `cards`, and **it falls
 * back to the oracle id itself** where the corpus has no row for one.
 *
 * `cardId` and `imageUris` are a **representative printing**, resolved at read time so a note card
 * can draw a picture of what it names — the deck's own printing where the deck holds one, and any
 * printing the corpus has otherwise. Neither is ever matched on, written, or synced, and the same
 * row read twice may honestly name two different printings. `cardId: null` is the orphan, and it
 * draws the empty frame rather than a broken image.
 */
export interface DeckNoteCard {
  oracleId: string;
  name: string;
  cardId: string | null;
  imageUris?: Partial<Record<ImageVariant, string>> | null;
}
```

- [ ] **Step 3: Narrow what the card menu's request carries**

`DeckNoteRequest`'s `add` arm aliases `DeckNoteCard` today, which would now oblige `DeckEditor` to
invent a printing for a note that does not exist yet. In `src/features/decks/DeckNotesPanel.tsx`,
change the arm (one word):

```ts
export type DeckNoteRequest =
  | { kind: "add"; card: Pick<DeckNoteCard, "oracleId" | "name"> }
  | { kind: "open"; noteId: number };
```

Keep the whole of that type's existing doc comment, appending:

```ts
 * **A `Pick` since the printing landed**, and the two fields are still the whole of what a note
 * needs to be born: the identity it attaches by, and the word to print. A representative printing
 * is a fact the *read* resolves, so a request that carried one would be the menu guessing at an
 * answer the database is about to give.
```

- [ ] **Step 4: Run the fence and the type check**

```bash
npm run test:run -- src/lib/ipc.test.ts
npx tsc --noEmit
```

Expected: PASS and no diagnostics. **`tsc --noEmit` is the authority** — the IDE's diagnostics are
stale mid-write and will name symbols that no longer exist.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ipc.ts src/features/decks/DeckNotesPanel.tsx
git commit -m "feat(notes): carry a representative printing on DeckNoteCard"
```

---

### Task 4: What the picker offers

**Files:**
- Modify: `src/features/decks/deckNotes.ts` — gains `NoteCardChoice`, `attachableCards`,
  `NOTE_TYPE_CHIPS` and `typeChipCounts`
- Modify: `src/features/decks/DeckNotesPanel.tsx` — `attachableCards` and `NoteCardChoice` leave
  this file; import them instead
- Test: `src/features/decks/deckNotes.test.ts` (exists)

**Interfaces:**
- Consumes: Task 3's `DeckNoteCard`.
- Produces:
  - `interface NoteCardChoice { oracleId: string; name: string; cardId: string; imageUris?: Partial<Record<ImageVariant, string>> | null; setCode: string; collectorNumber: string; typeBucket: string; copies: number }`
  - `attachableCards(cards: readonly DeckCard[]): NoteCardChoice[]`
  - `const ALL_CHIP = "All"`, `const NAMED_CHIP = "Named"`
  - `typeChipCounts(choices: readonly NoteCardChoice[], namedCount: number): { key: string; label: string; count: number }[]`

⚠️ **This moves `attachableCards` out of `DeckNotesPanel.tsx`, which the spec's file table does not
mention.** The reason is that it stops being a dedupe and becomes real arithmetic — fold copies,
bucket a type line, pick a printing per oracle id — and `deckNotes.ts` is the file whose whole
stated job is *"Rust supplies the facts and this file draws every conclusion"*. Its existing test
file comes with it.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/decks/deckNotes.test.ts`. Use whatever `DeckCard` factory that file (or
`src/features/decks/__fixtures__`) already provides; if there is none, write a local
`function card(over: Partial<DeckCard> & { cardId: string }): DeckCard` that fills every required
field once.

```ts
describe("what the card picker offers", () => {
  it("folds every copy of one oracle card into one row", () => {
    const [row, ...rest] = attachableCards([
      card({ cardId: "m10", oracleId: "o-bolt", name: "Lightning Bolt", quantity: 3 }),
      card({ cardId: "lea", oracleId: "o-bolt", name: "Lightning Bolt", quantity: 1 }),
    ]);

    expect(rest).toEqual([]);
    expect(row?.copies).toBe(4);
  });

  it("takes the printing off the first row the deck lists, which is the deck's own order", () => {
    const [row] = attachableCards([
      card({ cardId: "m10", oracleId: "o-bolt", name: "Lightning Bolt", setCode: "m10", collectorNumber: "146" }),
      card({ cardId: "lea", oracleId: "o-bolt", name: "Lightning Bolt", setCode: "lea", collectorNumber: "161" }),
    ]);

    expect(row?.cardId).toBe("m10");
    expect(row?.setCode).toBe("m10");
    expect(row?.collectorNumber).toBe("146");
  });

  it("buckets a card by the front face of its type line", () => {
    const [mdfc] = attachableCards([
      card({
        cardId: "agadeem",
        oracleId: "o-agadeem",
        name: "Agadeem's Awakening",
        typeLine: "Sorcery // Land",
      }),
    ]);

    // The back of a modal DFC is routinely a land while the front is a spell; a deck is cast
    // from the front, and `typeBucket` is the rule that already says so.
    expect(mdfc?.typeBucket).toBe("Sorcery");
  });

  it("drops a row with no oracle id rather than offering a press that can only be refused", () => {
    expect(attachableCards([card({ cardId: "orphan", oracleId: null, name: "Gone" })])).toEqual([]);
  });

  it("sorts by name, so the list reads the way a reader scans it", () => {
    const names = attachableCards([
      card({ cardId: "b", oracleId: "o-b", name: "Mountain" }),
      card({ cardId: "a", oracleId: "o-a", name: "Goblin Guide" }),
    ]).map((c) => c.name);

    expect(names).toEqual(["Goblin Guide", "Mountain"]);
  });
});

describe("the picker's chips", () => {
  const CHOICES = attachableCards([
    card({ cardId: "1", oracleId: "o-1", name: "Goblin Guide", typeLine: "Creature — Goblin Scout", quantity: 4 }),
    card({ cardId: "2", oracleId: "o-2", name: "Mountain", typeLine: "Basic Land — Mountain", quantity: 20 }),
    card({ cardId: "3", oracleId: "o-3", name: "Lightning Bolt", typeLine: "Instant", quantity: 4 }),
  ]);

  it("counts cards and never copies, because a note names a card once", () => {
    const chips = typeChipCounts(CHOICES, 1);

    // 20 Mountains are one row in this list and one thing a note can name.
    expect(chips.find((c) => c.key === "all")?.count).toBe(3);
    expect(chips.find((c) => c.key === "land")?.count).toBe(1);
  });

  it("puts All and Named first, then the types in TYPE_BUCKETS' order", () => {
    expect(typeChipCounts(CHOICES, 1).map((c) => c.label)).toEqual([
      "All",
      "Named",
      "Creature",
      "Instant",
      "Land",
    ]);
  });

  it("draws no chip for a type the deck does not hold", () => {
    expect(typeChipCounts(CHOICES, 0).map((c) => c.label)).not.toContain("Planeswalker");
  });

  it("keeps Named even at zero, because it is how a reader checks their own work", () => {
    expect(typeChipCounts(CHOICES, 0).find((c) => c.key === "named")).toEqual({
      key: "named",
      label: "Named",
      count: 0,
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npm run test:run -- src/features/decks/deckNotes.test.ts
```

Expected: FAIL — `attachableCards is not exported` / `typeChipCounts is not defined`.

- [ ] **Step 3: Implement**

Append to `src/features/decks/deckNotes.ts` (and add the imports it needs:
`import type { DeckCard, DeckNote, ImageVariant } from "@/lib/ipc";` and
`import { OTHER, TYPE_BUCKETS, typeBucket } from "./deckBuckets";`):

```ts
/**
 * One card a note can be told to name, as the picker draws it.
 *
 * **One entry per oracle id, because a note names a card and not a printing.** One note naming
 * Lightning Bolt names it once, however many copies, printings or finishes the deck holds — and a
 * picker offering the same card four times would be four presses that all did the same thing.
 *
 * It is no longer an alias of {@link DeckNoteCard}, which it was until the redesign: the picker's
 * row draws a picture, a printing and a type beside the name, and an attached card carries none of
 * those. The two are still built from one list and read side by side, which is why `oracleId` and
 * `name` are spelled the same way in both.
 */
export interface NoteCardChoice {
  oracleId: string;
  name: string;
  /** The printing this row draws — the **first** row the deck lists for this oracle id, which is
   *  the deck's own order and therefore the copy the reader is looking at. */
  cardId: string;
  imageUris?: Partial<Record<ImageVariant, string>> | null;
  setCode: string;
  collectorNumber: string;
  /** `deckBuckets.ts`' bucket for the **front** face — what the chips filter on. */
  typeBucket: string;
  /** Every copy of this card in the list handed in, folded. Drawn as `4×`; it names nothing and
   *  is never written — a note names a card, not a quantity of one. */
  copies: number;
}

/**
 * The deck's own cards, as the picker offers them.
 *
 * **A row with no oracle id is dropped rather than offered.** That is an orphan printing — a card
 * the corpus has since stopped carrying — and there is no id to attach; offering it would be a
 * press that could only be refused.
 *
 * **Both variants of a deck arrive here as one list**, which is the panel's own arrangement: the
 * band holds no `variant`, because `deck_notes` has no variant column and a note written against
 * the plan shows on the actual list too.
 */
export function attachableCards(cards: readonly DeckCard[]): NoteCardChoice[] {
  const byOracle = new Map<string, NoteCardChoice>();
  for (const card of cards) {
    if (card.oracleId === null) continue;
    const seen = byOracle.get(card.oracleId);
    if (seen) {
      seen.copies += card.quantity;
      continue;
    }
    byOracle.set(card.oracleId, {
      oracleId: card.oracleId,
      name: card.name,
      cardId: card.cardId,
      imageUris: card.imageUris,
      setCode: card.setCode,
      collectorNumber: card.collectorNumber,
      typeBucket: typeBucket(card.typeLine),
      copies: card.quantity,
    });
  }
  return [...byOracle.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** The two rungs of the picker's radiogroup that are not a card type. Keys rather than labels at
 *  every call site, because the label is English and the key is the state. */
export const ALL_CHIP = "all";
export const NAMED_CHIP = "named";

/**
 * The picker's rungs, with a count on each: `All`, `Named`, then one per type the deck holds.
 *
 * **Cards and never copies.** Twenty Mountains are one row in this list and one thing a note can
 * name, so a chip reading `Land 20` beside a list showing one Land row would be two numbers for
 * one fact.
 *
 * **Types rather than piles**, which is where this parts company with the spec it was drawn from:
 * a type is a fact about the card and a pile is the reader's own filing, and `deck_categories` has
 * no unique index on the word, so two piles may legally share a name and fold into one chip that
 * stood for both. `typeBucket` reads the **front** face of a `//` line, which is the rule a modal
 * DFC needs.
 *
 * **`Named` is drawn at zero and the type chips are not.** Named is how a reader checks their own
 * work — *have I named anything yet* is a question a `0` answers — where a `Planeswalker 0` on a
 * burn deck is a rung that filters to an empty list nobody asked about.
 */
export function typeChipCounts(
  choices: readonly NoteCardChoice[],
  namedCount: number,
): { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const choice of choices) {
    counts.set(choice.typeBucket, (counts.get(choice.typeBucket) ?? 0) + 1);
  }
  const order = [...TYPE_BUCKETS, OTHER];
  return [
    { key: ALL_CHIP, label: "All", count: choices.length },
    { key: NAMED_CHIP, label: "Named", count: namedCount },
    ...order
      .filter((label) => counts.has(label))
      .map((label) => ({ key: label.toLowerCase(), label, count: counts.get(label) ?? 0 })),
  ];
}
```

- [ ] **Step 4: Delete the old copy and re-point the band**

In `src/features/decks/DeckNotesPanel.tsx`, delete `export type NoteCardChoice = DeckNoteCard;`
and the whole of `export function attachableCards(...)`, and import them instead:

```ts
import { attachableCards, noteTitle, type NoteCardChoice } from "./deckNotes";
```

Then sweep for every other importer — a `git grep` **skips untracked files**, so use ripgrep:

```bash
npx rg -n "attachableCards|NoteCardChoice" src .storybook
```

Re-point every hit at `./deckNotes`. `DeckNotesPanel.test.tsx` imports `attachableCards` for the
dedupe test at line 436; that test moves to `deckNotes.test.ts` in Step 1's block above, so delete
it from the panel's file.

- [ ] **Step 5: Run the tests**

```bash
npm run test:run -- src/features/decks/deckNotes.test.ts
npx tsc --noEmit
```

Expected: PASS, no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/deckNotes.ts src/features/decks/deckNotes.test.ts src/features/decks/DeckNotesPanel.tsx src/features/decks/DeckNotesPanel.test.tsx
git commit -m "feat(notes): widen what the card picker offers to a drawable row"
```

---

### Task 5: The card picker dialog

**Files:**
- Create: `src/features/decks/NoteCardsDialog.tsx`
- Create: `src/features/decks/NoteCardsDialog.test.tsx`
- Create: `src/features/decks/NoteCardsDialog.stories.tsx`

**Interfaces:**
- Consumes: Task 4's `NoteCardChoice`, `attachableCards`, `typeChipCounts`, `ALL_CHIP`,
  `NAMED_CHIP`; `Dialog` from `@/components/Dialog`; `CardImage` from `@/components/CardImage`;
  `cardArtSrc`/`cardImageUrl` from `@/lib/images`; `FILTER_FIELD` from `@/components/FilterChips`.
- Produces:

```ts
export interface NoteCardsDialogProps {
  open: boolean;
  /** The note's name — `noteTitle(note)`, computed by the host so the dialog and the card agree. */
  title: string;
  /** Every card this note names, as the read answered. */
  named: readonly DeckNoteCard[];
  /** Every card the deck holds, as the picker offers them. */
  attachable: readonly NoteCardChoice[];
  onAttach: (oracleId: string) => void;
  onDetach: (oracleId: string) => void;
  onClose: () => void;
}
export function NoteCardsDialog(props: NoteCardsDialogProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `src/features/decks/NoteCardsDialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { attachableCards } from "./deckNotes";
import { NoteCardsDialog } from "./NoteCardsDialog";

/** Use whichever `DeckCard` factory `deckNotes.test.ts` settled on in Task 4. */
const DECK = attachableCards([
  card({ cardId: "1", oracleId: "o-guide", name: "Goblin Guide", typeLine: "Creature — Goblin Scout", quantity: 4 }),
  card({ cardId: "2", oracleId: "o-mountain", name: "Mountain", typeLine: "Basic Land — Mountain", quantity: 20 }),
  card({ cardId: "3", oracleId: "o-bolt", name: "Lightning Bolt", typeLine: "Instant", quantity: 4 }),
]);

function open(over: Partial<React.ComponentProps<typeof NoteCardsDialog>> = {}) {
  const onAttach = vi.fn();
  const onDetach = vi.fn();
  render(
    <NoteCardsDialog
      open
      title="Mana base"
      named={[]}
      attachable={DECK}
      onAttach={onAttach}
      onDetach={onDetach}
      onClose={vi.fn()}
      {...over}
    />,
  );
  return { onAttach, onDetach };
}

describe("naming cards in a note", () => {
  it("names the note in its heading and says what the dialog is for", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "Mana base" })).toBeInTheDocument();
    expect(screen.getByText("Which cards this note is about")).toBeInTheDocument();
  });

  it("gives every checkbox the card's own name, never a bare Select", async () => {
    open();
    // A column of checkboxes sharing one name is a column a screen reader cannot tell apart.
    expect(screen.getByRole("checkbox", { name: /Goblin Guide/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Mountain/ })).toBeInTheDocument();
  });

  it("ticks a card the note already names", async () => {
    open({ named: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "3" }] });
    expect(screen.getByRole("checkbox", { name: /Lightning Bolt/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Mountain/ })).not.toBeChecked();
  });

  it("attaches on the tick rather than on a Save that does not exist", async () => {
    const { onAttach } = open();
    await userEvent.click(screen.getByRole("checkbox", { name: /Mountain/ }));
    expect(onAttach).toHaveBeenCalledWith("o-mountain");
  });

  it("detaches on the untick, and the note stays where it is", async () => {
    const { onDetach } = open({ named: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "3" }] });
    await userEvent.click(screen.getByRole("checkbox", { name: /Lightning Bolt/ }));
    expect(onDetach).toHaveBeenCalledWith("o-bolt");
  });

  it("narrows to a type on a chip, counting cards and not copies", async () => {
    open();
    // 20 Mountains are one row and one thing a note can name.
    await userEvent.click(screen.getByRole("radio", { name: /^Land, 1 card$/ }));
    expect(screen.getByRole("checkbox", { name: /Mountain/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Goblin Guide/ })).not.toBeInTheDocument();
  });

  it("narrows to what the note already names", async () => {
    open({ named: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "3" }] });
    await userEvent.click(screen.getByRole("radio", { name: /^Named, 1 card$/ }));
    expect(screen.getByRole("checkbox", { name: /Lightning Bolt/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Mountain/ })).not.toBeInTheDocument();
  });

  it("finds a card by typing, and says so when nothing matches", async () => {
    open();
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/No card in this deck matches/)).toBeInTheDocument();
  });

  it("says a deck with nothing in it has nothing to name, which is not a no-match", async () => {
    open({ attachable: [] });
    expect(screen.getByText("This deck has no cards to name yet.")).toBeInTheDocument();
  });

  it("keeps a card the note names even when the deck no longer holds it", async () => {
    // The standing sentence: cutting a card never takes the note with it.
    open({ named: [{ oracleId: "o-cut", name: "Goblin Piledriver", cardId: null }] });
    expect(screen.getByRole("checkbox", { name: /Goblin Piledriver/ })).toBeChecked();
  });
});
```

⚠️ **A CSS `gap` breaks an accessible name.** The chips draw a label and a count as two elements
separated by a `gap`, which is CSS and not a text node — the name computes to `Land1`. So each
chip carries an explicit `aria-label` spelling the count as a sentence, which is what the `^Land,
1 card$` matchers above are asserting. `TheoryDiffDialog.tsx:962` is the recipe and its comment is
the measurement.

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:run -- src/features/decks/NoteCardsDialog.test.tsx
```

Expected: FAIL — `Failed to resolve import "./NoteCardsDialog"`.

- [ ] **Step 3: Write the component**

Create `src/features/decks/NoteCardsDialog.tsx`. The shape, section by section:

```tsx
/**
 * Which cards a note is about — `PullFromCollectionDialog`'s grammar, over the deck's own cards.
 *
 * **A fourth spelling of "pick some cards in a dialog" is a fourth thing to keep in step**, so the
 * row below is that dialog's row character for character: a `size-4 accent-accent` checkbox named
 * for its card, the 44×32 art frame, a `min-w-0 flex-1` column with the name over a `text-[0.7rem]`
 * line, and the count right-aligned in mono.
 *
 * **No Save, because ticking is the write.** Each tick calls `note_card_attach` or
 * `note_card_detach` the moment it lands, which is what the row actions did before this dialog
 * existed — so a `Cancel` here would be a lie about what the last ten presses did. The footer
 * carries one `Done`.
 *
 * **The picker offers the deck's cards and nothing wider**, which is the spec's line: a note is
 * about a card *in this deck*. A card that later leaves the deck keeps its note — deliberately,
 * because a note about a card you cut is the note most worth keeping — so this list narrows what
 * can be *added* and never what is already named. A named card the deck no longer holds is drawn
 * at the head of the list, ticked, with an empty frame.
 */
```

Then:

- **Shell.** `<Dialog open title={title} subtitle="Which cards this note is about"
  closeLabel="Close the card picker" size="w-[47.5rem]" onDismiss={onClose} onClose={onClose}>`.
  `w-[47.5rem]` and not the pull dialog's `w-[52rem]`: the row here carries no source dropdown.
- **Controls band.** `<div className="flex flex-col gap-3 border-b border-border px-5 py-3.5">`,
  holding an `sr-only` `<label>` + `<input type="search" className={FILTER_FIELD}>` with
  placeholder `Find a card in this deck…`, then a
  `<div role="radiogroup" aria-label="Which cards to show" className="flex flex-wrap gap-2">` of
  `typeChipCounts(...)` chips (each `role="radio"`, `aria-checked`, and the explicit `aria-label`
  above), with `{plural(namedCount, "named")}`-style text at `ml-auto` in
  `font-mono text-xs tabular-nums text-dim` — spell it `{named.length} named`, not through
  `plural`, since "named" does not pluralise.
- **The list.** `<div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">` around a `<ul>`. Rows
  are `<li className={cn("rounded-md px-2 py-2", "transition-colors duration-150 hover:bg-surface",
  "motion-reduce:transition-none", ticked && "bg-surface")}>`.
- **Row contents**, in a `flex items-start gap-3`:
  - `<input type="checkbox" checked={ticked} onChange={…} aria-label={`Name ${row.name} in ${title}`}
    className={cn("mt-1 size-4 shrink-0 accent-accent", FOCUS)} />`. The name does **not** move
    with the tick — it says what the row is, not what it is doing.
  - the art frame: `<span aria-hidden="true" className="mt-0.5 h-8 w-11 shrink-0 overflow-hidden
    rounded border border-border bg-surface">` wrapping `{art !== null && <CardImage src={art}
    alt="" draggable={false} loading="lazy" className="size-full object-cover" />}`, where
    `const art = row.cardId === null ? null : cardArtSrc(cardImageUrl(row.cardId, 0, "art"), row.imageUris?.art)`.
    **Through `CardImage`, never a bare `<img>`**: this is a slot, and a browser paints an `<img>`'s
    last decoded frame until the new src decodes.
  - `<span className="flex min-w-0 flex-1 flex-col gap-1">` with the name at
    `min-w-0 truncate text-sm`, then
    `<span className="flex flex-wrap items-baseline gap-x-2 text-[0.7rem] text-dim">` carrying
    `<span className="font-mono tabular-nums">{row.setCode.toUpperCase()} · {row.collectorNumber}</span>`
    and `<span>{row.typeBucket}</span>`.
  - copies: `<span className="w-11 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums text-dim">`
    with an `aria-hidden` `{row.copies}×` and an `sr-only` `{plural(row.copies, "copy", "copies")} in this deck`.
    A `<span>` cannot carry an `aria-label` — the role is name-prohibited — so the twin is the only
    way to say it.
- **Empty states**, in the house `<div className="mx-auto max-w-md px-2 py-6 text-center">`:
  `attachable.length === 0` → *"This deck has no cards to name yet."*; otherwise
  *"No card in this deck matches — try a different word, or a different chip."*
- **Footer.** `<footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border
  px-5 py-3.5">` with `<p className="min-w-[14rem] flex-1 text-[0.7rem] leading-snug text-dim">`
  carrying the standing sentence — *"A note keeps the cards it names even after they leave the deck
  — cutting a card never takes the note with it."* — and one `Done` button on `CONFIRM` (the recipe
  `PullFromCollectionDialog` imports; reuse the same constant rather than respelling it).

**Two rules from this repo that this component must not break:**

- **`relative` on any scroll container**, and `FOCUS_INSET` rather than `FOCUS` on anything inside
  it. An outline standing 2px off a row that fills a clipped box is painted entirely in the clipped
  region and is never seen at all. jsdom lays nothing out, so neither can go red in the suite.
- **The caret starts in the search field.** `useEffect(() => { ref.current?.focus(); }, [])` on the
  `<input>` — without it the caret is parked on the `Cards` trigger the card has just disabled and
  the first keystroke goes to the page.

The filter is the search needle **and** the chip, folded once:

```tsx
const needle = find.trim().toLowerCase();
const namedIds = useMemo(() => new Set(named.map((c) => c.oracleId)), [named]);

/** The named cards the deck no longer holds, drawn at the head so an unticking press is always
 *  reachable. `attachable` cannot contain them by construction — it is built from the deck. */
const strays: NoteCardChoice[] = useMemo(
  () =>
    named
      .filter((c) => !attachable.some((a) => a.oracleId === c.oracleId))
      .map((c) => ({
        oracleId: c.oracleId,
        name: c.name,
        cardId: c.cardId ?? "",
        imageUris: c.imageUris,
        setCode: "",
        collectorNumber: "",
        typeBucket: OTHER,
        copies: 0,
      })),
  [named, attachable],
);

const rows = [...strays, ...attachable].filter(
  (row) =>
    (needle === "" || row.name.toLowerCase().includes(needle)) &&
    (chip === ALL_CHIP ||
      (chip === NAMED_CHIP ? namedIds.has(row.oracleId) : row.typeBucket.toLowerCase() === chip)),
);
```

A stray row draws no `SET · number` (both strings are empty) and no copies count; guard the two
spans on `row.setCode !== ""` and `row.copies > 0`.

- [ ] **Step 4: Run the tests**

```bash
npm run test:run -- src/features/decks/NoteCardsDialog.test.tsx
```

Expected: PASS, 10 tests.

⚠️ If a `toBeVisible` assertion flakes under load, it is motion's `initial` surviving a frame —
assert `toBeInTheDocument` instead, as the matchers above do.

- [ ] **Step 5: Write the stories**

Create `src/features/decks/NoteCardsDialog.stories.tsx`, over plain props like
`DeckNotesPanel.stories.tsx` (which states the argument for it: three of its states cannot be
reached from a seed at all). Five stories, each with a doc paragraph saying what it is for:

`Empty` (a deck with no cards), `NothingNamed`, `SomeNamed`, `NarrowedToALand` (a `play` that
presses the `Land` chip), and `NamesACardTheDeckCut` (one stray at the head of the list).

**Story plays cannot be run during a fan-out** — `stories.test.tsx` collects the whole tree, so a
sibling's half-finished file fails the run for reasons that are not yours. Write the plays; run
them in Task 10 after fan-in.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/NoteCardsDialog.tsx src/features/decks/NoteCardsDialog.test.tsx src/features/decks/NoteCardsDialog.stories.tsx
git commit -m "feat(notes): pick a note's cards in a dialog"
```

---

### Task 6: The editor dialog, and the placeholder

**Files:**
- Modify: `package.json` — declare `@tiptap/extensions`
- Modify: `src/features/decks/NoteEditor.tsx` — the placeholder, and nothing else
- Create: `src/features/decks/NoteEditorDialog.tsx`
- Create: `src/features/decks/NoteEditorDialog.test.tsx`
- Create: `src/features/decks/NoteEditorDialog.stories.tsx`
- Modify: `src/features/decks/NoteEditor.test.tsx` — one test for the placeholder

**Interfaces:**
- Consumes: Task 3's `DeckNoteRequest` narrowing.
- Produces:

```ts
/** What the dialog was opened to do. `note` is an edit; `card` is a create the card menu asked
 *  for; `null` is a plain New note. */
export type NoteDraft =
  | { kind: "new" }
  | { kind: "newFromCard"; card: Pick<DeckNoteCard, "oracleId" | "name"> }
  | { kind: "edit"; note: DeckNote };

export interface NoteEditorDialogProps {
  open: boolean;
  draft: NoteDraft;
  pending: boolean;
  /** `{ title, body, oracleIds }` for a create; `{ id, patch }` for an edit. The host decides
   *  which mutation that is — this dialog only knows what the reader typed. */
  onSave: (body: string) => void;
  onClose: () => void;
}
export function NoteEditorDialog(props: NoteEditorDialogProps): JSX.Element;
```

- [ ] **Step 1: Declare the extensions package**

`Placeholder` lives in `@tiptap/extensions`, which is **already installed** — `@tiptap/starter-kit`
pins it at exactly `3.31.3` and already pulls `UndoRedo`, `ListKeymap`, `Gapcursor`, `Dropcursor`
and `TrailingNode` out of it. Declaring it adds **no bytes**; it makes an import this app relies on
a dependency this app names. In `package.json`, beside the other five `@tiptap/*` entries:

```json
    "@tiptap/extensions": "^3.31.3",
```

Then:

```bash
npm install
```

- [ ] **Step 2: Write the failing placeholder test**

Append to `src/features/decks/NoteEditor.test.tsx` (use whatever render helper that file already
has):

```tsx
it("teaches the naming rule on an empty surface, because there is no title field to do it", async () => {
  render(<NoteEditor value="" onChange={vi.fn()} ariaLabel="Body of a new note" />);

  // ProseMirror writes the sentence onto the empty paragraph as `data-placeholder`, and the CSS
  // in `SURFACE` is what paints it. The attribute is the half jsdom can referee.
  const empty = await screen.findByRole("textbox");
  expect(empty.querySelector("[data-placeholder]")).toHaveAttribute(
    "data-placeholder",
    "Start typing — the first line becomes the note's name.",
  );
});

it("says nothing on a surface that already has a body", async () => {
  render(<NoteEditor value="Fourteen sources." onChange={vi.fn()} ariaLabel="Body of Mana base" />);
  const surface = await screen.findByRole("textbox");
  expect(surface.querySelector("[data-placeholder]")).toBeNull();
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
npm run test:run -- src/features/decks/NoteEditor.test.tsx
```

Expected: FAIL — the attribute is absent.

- [ ] **Step 4: Add the placeholder**

In `src/features/decks/NoteEditor.tsx`:

```ts
import { Placeholder } from "@tiptap/extensions";
```

Add the constant beside `NOTE_EXTENSIONS`:

```ts
/**
 * What an empty surface says, and **the only teaching left in the create flow**.
 *
 * The redesign deleted the title field: a note is written with `title: ""` and `noteTitle()`
 * answers the body's first line. That rule is invisible unless something says it, and the one
 * place a reader is looking when it matters is the empty box they are about to type in.
 */
export const NOTE_PLACEHOLDER = "Start typing — the first line becomes the note's name.";
```

Append to `NOTE_EXTENSIONS`, after `NoteHeading.configure(...)` and before `Markdown`:

```ts
  /**
   * **Behaviour, not schema** — the third kind of extension this list holds, and it can put no
   * node and no mark into a body, so the pinned dialect and `noteMarkdown.test.ts`' round trip are
   * untouched. It writes `data-placeholder` onto an empty node and adds `is-empty` /
   * `is-editor-empty`; {@link SURFACE} is what paints it.
   *
   * `showOnlyWhenEditable` is the default and is right: a read-only surface with a prompt on it is
   * a box inviting a press it will refuse. `showOnlyCurrent` keeps the sentence on the one empty
   * paragraph the caret is in rather than on every empty paragraph in a long note.
   */
  Placeholder.configure({ placeholder: NOTE_PLACEHOLDER }),
```

Paint it by appending to `SURFACE`:

```ts
const SURFACE = cn(
  "min-h-32 w-full px-2.5 py-2 text-sm text-text",
  "focus:outline-none",
  // The prompt, painted on the empty paragraph the extension marked. `float-left h-0` is
  // ProseMirror's own recipe: a `::before` in flow would push the caret down a line, and a
  // floated zero-height box leaves the caret exactly where an empty paragraph puts it.
  "[&_.is-editor-empty:first-child]:before:pointer-events-none",
  "[&_.is-editor-empty:first-child]:before:float-left",
  "[&_.is-editor-empty:first-child]:before:h-0",
  "[&_.is-editor-empty:first-child]:before:text-dim",
  "[&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
  PRESS_STILL,
  PROSE,
);
```

⚠️ **A Tailwind arbitrary value can emit nothing at all**, silently — a mistyped `content-[…]`
produces no rule and no warning, and the surface simply has no prompt. Prove the five utilities
compile rather than eyeballing them. Add to `src/features/decks/NoteEditor.test.tsx`, modelled on
`src/lib/keyboardModality.test.ts`'s `selectorFor` (copy that helper — it compiles through Vite's
`?raw`, never `node:fs`, because this project has no `@types/node`):

```ts
it("really compiles the prompt's content rule", async () => {
  const built = await compiled("[&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]");
  expect(built).toContain("content:");
  expect(built).toContain("attr(data-placeholder)");
});
```

- [ ] **Step 5: Run the editor's tests**

```bash
npm run test:run -- src/features/decks/NoteEditor.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Write the dialog's failing test**

Create `src/features/decks/NoteEditorDialog.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoteEditorDialog } from "./NoteEditorDialog";

describe("writing a note in a dialog", () => {
  it("has no title field anywhere in the create flow", async () => {
    render(<NoteEditorDialog open draft={{ kind: "new" }} pending={false} onSave={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole("heading", { name: "New note" });
    // One box, and it is the body. A title field here is the thing this redesign deleted.
    expect(screen.queryByRole("textbox", { name: /title/i })).not.toBeInTheDocument();
  });

  it("refuses to save a note with nothing in it", async () => {
    render(<NoteEditorDialog open draft={{ kind: "new" }} pending={false} onSave={vi.fn()} onClose={vi.fn()} />);
    // The old add row refused a blank title for this exact reason: written blank it would make a
    // note with nothing in it at all, named `Untitled note`, that the reader then has to delete.
    expect(await screen.findByRole("button", { name: "Save note" })).toBeDisabled();
  });

  it("sends the body the reader typed", async () => {
    const onSave = vi.fn();
    render(<NoteEditorDialog open draft={{ kind: "new" }} pending={false} onSave={onSave} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByRole("textbox"), "Fourteen sources.");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(onSave).toHaveBeenCalledWith(expect.stringContaining("Fourteen sources."));
  });

  it("names an edit by the note it opened on, and seeds the body", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "edit", note: note({ id: 1, title: "Mana base", body: "Fourteen sources." }) }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Mana base" })).toBeInTheDocument();
    expect(await screen.findByRole("textbox")).toHaveTextContent("Fourteen sources.");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("names a blank-titled note by its body's first line", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "edit", note: note({ id: 1, title: "", body: "Ask Supreme about the Bolt count" }) }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Ask Supreme about the Bolt count" }),
    ).toBeInTheDocument();
  });

  it("says which card a note born from the card menu will name", async () => {
    render(
      <NoteEditorDialog
        open
        draft={{ kind: "newFromCard", card: { oracleId: "o-bolt", name: "Lightning Bolt" } }}
        pending={false}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText(/will name Lightning Bolt/)).toBeInTheDocument();
  });

  it("writes nothing when the reader backs out", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<NoteEditorDialog open draft={{ kind: "new" }} pending={false} onSave={onSave} onClose={onClose} />);
    await userEvent.type(await screen.findByRole("textbox"), "Half a thought");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Write the dialog**

Create `src/features/decks/NoteEditorDialog.tsx`:

```tsx
/**
 * Where a note is written — **the one editor in this feature, and the only door to Tiptap**.
 *
 * `NoteEditor` arrives through `React.lazy` over a dynamic import, which is the whole of why a
 * band showing twenty notes costs the main chunk nothing: 141.5 kB gzip against the app's own
 * 481.45 kB. That rule got *stronger* with the redesign rather than weaker — the editor used to
 * unfold inside a row and is now behind a press that opens a dialog, so a band that is merely read
 * loads none of it. **Nothing in this app may import `NoteEditor` statically**;
 * `DeckNotesPanel.test.tsx` sweeps every source file for one.
 *
 * **Three modes, one dialog, and the only differences are three strings.** A create, a create the
 * card menu asked for, and an edit differ in the heading, the button's verb and whether a card
 * comes along; the surface, the footer and the draft state are one thing. Two dialogs would be two
 * places to keep the naming rule.
 *
 * **There is no title field, and that is the redesign's own sentence.** Every note this dialog
 * writes is written with `title: ""`, and `noteTitle()` answers the first line — which is what it
 * already did for a blank title. The rule is taught by the surface's placeholder
 * ({@link NOTE_PLACEHOLDER}), because a rule with nothing saying it is a rule the reader breaks.
 *
 * **Save is refused on an empty body**, which is the add row's old rule arriving at the new door:
 * with no title to stand in, a blank save makes a note called `Untitled note` with nothing in it,
 * and the reader's only recourse is to delete it. `noteToPlainText` and not the markdown string —
 * an empty ProseMirror document is not an empty string.
 */
```

Structure:

- `const NoteEditor = lazy(() => import("./NoteEditor"));` — **this file's only reference to it.**
- `const [body, setBody] = useState(draft.kind === "edit" ? draft.note.body : "");`
  `Dialog` mounts and unmounts its children, so a fresh open is a fresh draft with no reset to
  write. Do **not** add an effect that syncs `body` to `draft`.
- `const heading = draft.kind === "edit" ? noteTitle(draft.note) : "New note";`
- `const verb = draft.kind === "edit" ? "Save" : "Save note";`
- `const blank = noteToPlainText(body).trim() === "";`
- Shell: `<Dialog open title={heading} closeLabel="Close the note editor" size="w-[40rem]"
  onDismiss={onClose} onClose={onClose}>`. For `newFromCard`, pass
  `subtitle={`This note will name ${draft.card.name}`}`.
- Body: `<div className="min-h-60 px-5 py-4">` wrapping
  `<Suspense fallback={<p className="text-[0.6875rem] text-dim">Opening the editor…</p>}>
   <NoteEditor value={body} onChange={setBody} ariaLabel={`Body of ${heading}`} /></Suspense>`.
  The fallback is a sentence rather than a spinner: the chunk arrives off local disk, so what a
  reader sees is one frame of type.
- Footer: `<footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">`
  with `Cancel` on `CONFIRM_CANCEL` and the save on `META_SUBMIT`, `disabled={pending}`,
  `aria-disabled={blank || undefined}` and an `onClick` that returns early when `blank`.
  **`aria-disabled` and not `disabled` for the blank case**: the button greys and un-greys as the
  reader types, and a real `disabled` control leaves the tab order — so a reader who cleared their
  last word would find the caret thrown out of the footer by their own press. `pending` is the
  other kind of no and *is* the attribute: it is the half-second the write is in flight.
  (`PullFromCollectionDialog`'s pull button is this exact pairing.)

  ⚠️ The test in Step 6 asserts `toBeDisabled()`. `toBeDisabled` does **not** match
  `aria-disabled` — change that assertion to
  `expect(save).toHaveAttribute("aria-disabled", "true")` when you write the component this way,
  and add a second assertion that pressing it calls neither callback.

- [ ] **Step 8: Run the dialog's tests**

```bash
npm run test:run -- src/features/decks/NoteEditorDialog.test.tsx
```

Expected: PASS, 7 tests.

- [ ] **Step 9: Write the stories**

Create `src/features/decks/NoteEditorDialog.stories.tsx`: `NewNote`, `NewNoteFromACard`,
`EditingANote`, `EditingABlankTitledNote`. **No `play` that presses Save on `NewNote`** — a
Storybook run is not the place to fetch 141.5 kB per story; the stories mount the surface, which
is the point.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/features/decks/NoteEditor.tsx src/features/decks/NoteEditor.test.tsx src/features/decks/NoteEditorDialog.tsx src/features/decks/NoteEditorDialog.test.tsx src/features/decks/NoteEditorDialog.stories.tsx
git commit -m "feat(notes): write a note in a dialog, with no title field"
```

---

### Task 7: The note card

**Files:**
- Create: `src/features/decks/NoteCard.tsx`
- Create: `src/features/decks/NoteCard.test.tsx`

**Interfaces:**
- Consumes: Task 1's `useMasonryRowSpan`, Task 3's `DeckNoteCard.cardId`/`imageUris`.
- Produces:

```ts
/** The gutter between two cards in the masonry, in pixels — see {@link NOTE_GRID}. */
export const NOTE_GAP = 8;
/** How many art crops a card draws before the `+N more` chip. */
export const NOTE_THUMBS = 3;

export interface NoteCardProps {
  note: DeckNote;
  /** Non-null while this is the card the band was sent to — brings it into view. */
  focused: NoteFocus | null;
  onEdit: () => void;
  onCards: () => void;
  onDelete: () => void;
  /** A press on one thumbnail — the card it names. `undefined` draws the strip as plain frames
   *  rather than as controls, which is what the workbench does. */
  onOpenCard?: (card: DeckNoteCard) => void;
}
export function NoteCard(props: NoteCardProps): JSX.Element;
```

- [ ] **Step 1: Write the failing test**

Create `src/features/decks/NoteCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteCard, NOTE_THUMBS } from "./NoteCard";

function draw(note: DeckNote, over: Partial<React.ComponentProps<typeof NoteCard>> = {}) {
  render(
    <ul>
      <NoteCard note={note} focused={null} onEdit={vi.fn()} onCards={vi.fn()} onDelete={vi.fn()} {...over} />
    </ul>,
  );
}

describe("a note as a card", () => {
  it("names a blank-titled note by its body's first line, in its controls too", () => {
    draw(note({ id: 1, title: "", body: "Ask Supreme about the Bolt count" }));
    expect(screen.getByText("Ask Supreme about the Bolt count")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit Ask Supreme about the Bolt count" }),
    ).toBeInTheDocument();
  });

  it("renders the body rather than printing it", () => {
    draw(note({ id: 1, title: "Plan", body: "Cut the **third** land." }));
    // `parseNoteBody`'s blocks, not a string with asterisks in it.
    expect(screen.getByText("third").tagName).toBe("STRONG");
  });

  it("draws three crops and counts the rest", () => {
    draw(note({ id: 1, title: "Krenko line", body: "Haste first.", cards: five() }));
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(NOTE_THUMBS);
    expect(screen.getByRole("button", { name: "Two more cards in Krenko line" })).toBeInTheDocument();
  });

  it("draws no strip at all for a note that names nothing", () => {
    draw(note({ id: 1, title: "Table notes", body: "Two of them are on bracket 3." }));
    expect(screen.queryByRole("button", { name: /^Open / })).not.toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });

  it("draws an empty frame for a card with no printing, never a broken image", () => {
    draw(note({ id: 1, title: "Cut list", body: "Gone.", cards: [{ oracleId: "o-x", name: "Ghost", cardId: null }] }));
    expect(screen.getByRole("button", { name: "Open Ghost" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("carries no `N cards` chip — the strip is what counts them", () => {
    draw(note({ id: 1, title: "Krenko line", body: "Haste first.", cards: five() }));
    expect(screen.queryByText("5 cards")).not.toBeInTheDocument();
  });

  it("claims a row span, so the masonry can place it", () => {
    draw(note({ id: 1, title: "Plan", body: "Short." }));
    // jsdom measures every box as 0, so the span is the gutter alone — the assertion is that
    // the card claims *a* span rather than the default single row, which would stack every card
    // at row 1.
    expect(screen.getByRole("listitem").style.gridRow).toBe("span 8");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:run -- src/features/decks/NoteCard.test.tsx
```

Expected: FAIL — `Failed to resolve import "./NoteCard"`.

- [ ] **Step 3: Write the component**

Create `src/features/decks/NoteCard.tsx`. Move `actionLabel`, `NoteBody`, `NoteBlock` and
`Inlines` out of `DeckNotesPanel.tsx` into this file **unchanged** — they are the card's, and
`actionLabel`'s doc comment (the `Missing2` name-computation failure) travels with it.

```tsx
/**
 * One note, as a card in the band's masonry.
 *
 * **It is as tall as its note, and `min-h-[11.5rem]` is the floor.** The spec fixed this at 184px
 * and clamped the body to three lines; the reader's answer reverses that argument rather than the
 * layout — do the masonry properly, so what stays uniform across the grid is the **gap** and never
 * the height. A one-line note is still a card because of the floor; a long one is as long as it is,
 * and there is no clamp and no `+ more` on the prose. That is also what retired the question of how
 * a reader gets at the rest of a long note: the whole body is here.
 *
 * **The span is this card's own measured height**, `masonry.ts`'s hook at {@link NOTE_GAP}. The
 * grid is ruled in one-pixel rows with `rowGap: 0`, so a card that wraps to the next line lands at
 * the foot of the shortest column rather than under the tallest card of a shared line —
 * `views/StackView.tsx` has the full argument, and this is the same mechanism at a smaller gutter.
 *
 * **No `N cards` chip.** The strip below counts them, and two things on a 292px card saying the
 * same number is one too many. The chip stays in the picker, where there is no strip.
 */
```

Structure:

- `const { elementRef, span } = useMasonryRowSpan(NOTE_GAP);`
- Root: `<li ref={elementRef as Ref<HTMLLIElement>} tabIndex={-1}
  style={span === null ? undefined : { gridRow: `span ${span}` }}
  className="flex min-h-[11.5rem] max-w-[26.25rem] flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5">`.
  `max-w-[26.25rem]` is the spec's 420px cap; at the editor column's 1192px it never bites (four
  tracks at ~292px), and at one column it keeps a card from becoming a banner.
  ⚠️ **`min-h-*` on a grid item replaces `min-height: auto`** — that is a floor and not a ceiling
  here, because the item's `height` stays `auto` and its content is what grows it. The card must
  **not** also carry a `h-*`.
- The name: `<span className="min-w-0 truncate text-[0.8125rem] font-medium text-text">{title}</span>`,
  one line, truncate.
- The body: `<div className="min-h-0 flex-1 text-xs leading-relaxed text-dim"><NoteBody body={note.body} /></div>`.
  `flex-1` is what pushes the actions to the foot while the card sits at its floor; past the floor
  the body is simply its content.
- The strip, drawn only when `note.cards.length > 0`:
  `<div className="flex items-center gap-1.5">` holding `note.cards.slice(0, NOTE_THUMBS)` as
  buttons and, when `note.cards.length > NOTE_THUMBS`, the chip.
  - Each thumbnail: `<button type="button" onClick={() => onOpenCard?.(card)}
    aria-label={`Open ${card.name}`}
    className={cn("block h-8 w-11 shrink-0 overflow-hidden rounded border border-border bg-bg", FOCUS)}>`
    wrapping `{art !== null && <CardImage src={art} alt="" draggable={false} loading="lazy"
    className="size-full object-cover" />}`, with
    `const art = card.cardId === null ? null : cardArtSrc(cardImageUrl(card.cardId, 0, "art"), card.imageUris?.art)`.
    **The card's name is the button's accessible name and the picture is `alt=""`** — a frame with
    no bytes is still a control that goes somewhere.
  - The chip: `<button type="button" onClick={onCards}
    aria-label={`${plural(note.cards.length - NOTE_THUMBS, "more card")} in ${title}`}
    className={cn("grid h-8 shrink-0 place-items-center rounded border border-border px-2 font-mono text-[0.625rem] tabular-nums text-dim", FOCUS)}>
    +{note.cards.length - NOTE_THUMBS} more</button>`.
    ⚠️ The test asserts the name `"Two more cards in Krenko line"`. `plural` answers `2 more cards`,
    not `Two more cards` — write the assertion to match what `plural` answers (`"2 more cards in
    Krenko line"`) rather than bending the helper.
- The actions: `<div className="flex items-center justify-end gap-2.5">` holding three `RowAction`s
  — `Cards` (`actionLabel("Cards", `on ${title}`)`), `Edit` (`actionLabel("Edit", title)`) and a
  `destructive` `Delete` (`actionLabel("Delete", title)`). None is `disabled` any more: the panel
  they open is a dialog over the page, not something unfolding under this card.
- The landing-pad effect, moved from `NoteRow` unchanged: `el.focus(); el.scrollIntoView?.({ block: "nearest" })`
  when `focused !== null`. `tabIndex={-1}` and no focus class — a reader can neither Tab nor arrow
  onto this card, so a ring would mark a stop that does not exist. jsdom implements neither
  scroll-on-focus nor `scrollIntoView`, hence the `?.`.

- [ ] **Step 4: Run the tests**

```bash
npm run test:run -- src/features/decks/NoteCard.test.tsx
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/decks/NoteCard.tsx src/features/decks/NoteCard.test.tsx
git commit -m "feat(notes): draw a note as a card with the art it names"
```

---

### Task 8: The band, rewired

**Files:**
- Modify: `src/features/decks/DeckNotesPanel.tsx` — the header button, the masonry `<ul>`, the
  panel union; `NoteRow`, `NoteEditForm`, `NoteCards`, `DeleteNote`, `useDestructiveFocus`,
  `actionLabel`, `NoteBody`, `NoteBlock`, `Inlines`, `SECTION` and the add row all leave
- Modify: `src/features/decks/DeckNotesPanel.test.tsx` — every assertion naming the add row, the
  in-row editor or the old picker

**Interfaces:**
- Consumes: Tasks 5, 6 and 7.
- Produces: `NotesBandProps` unchanged **except** that `onCreate` widens from
  `(title: string) => void` to `(body: string, oracleIds: string[]) => void`.

- [ ] **Step 1: Replace the three flags with one union**

At the top of `NotesBand`, delete `draft`, `editing`, `confirming`, `picking`, `only()` and
`addId`, and write:

```tsx
/**
 * The one layer this band has open, or `null`.
 *
 * **`panels.ts`' shape, one file over**, and for its reason: three booleans that must never be two
 * at once become one value that structurally cannot be. The band used to hold `editing`,
 * `confirming` and `picking` as three `number | null`s kept exclusive by an `only()` helper — a
 * rule enforced by everybody remembering to call it.
 *
 * `newNote` and `newFromCard` carry no id because there is no row yet: the create happens on Save.
 */
type NotePanel =
  | { kind: "newNote" }
  | { kind: "newFromCard"; card: Pick<DeckNoteCard, "oracleId" | "name"> }
  | { kind: "edit"; note: DeckNote }
  | { kind: "cards"; note: DeckNote }
  | { kind: "confirm"; note: DeckNote }
  | null;

const [panel, setPanel] = useState<NotePanel>(null);
```

⚠️ A panel holds the **note object** rather than its id, so a note deleted from another window
leaves a dialog drawing a row that no longer exists. Re-read it from `notes` at draw time:

```tsx
/** The panel's note as the read currently holds it — `null` once it has gone, which shuts the
 *  dialog rather than leaving one drawing a row nothing answers for. Another window may delete a
 *  note this one has open; `multi-window.md` is why that is a live case and not a hypothesis. */
const live = useMemo(() => {
  if (panel === null || !("note" in panel)) return null;
  return notes.find((n) => n.id === panel.note.id) ?? null;
}, [panel, notes]);
```

and draw each dialog on `panel?.kind === "…" && live !== null`.

- [ ] **Step 2: The header gains one control**

After the count `<span>`, inside the header row:

```tsx
{/* **The band's one act, and it is in the header rather than over the list.** The add row it
    replaces was a field and a submit sitting above a list a reader with no notes did not have
    yet; a control in the heading is the same offer without a form standing in for one. */}
<button
  type="button"
  onClick={() => setPanel({ kind: "newNote" })}
  className={cn("ml-auto inline-flex items-center gap-1.5", META_SUBMIT)}
>
  <Plus aria-hidden="true" className="size-3.5 shrink-0" />
  New note
</button>
```

`META_SUBMIT` already carries `h-8 shrink-0 rounded-md border border-accent px-3 text-xs
text-accent` and the focus ring; `inline-flex items-center gap-1.5` is what puts the glyph beside
the word. Import `Plus` from `lucide-react` beside the existing `ChevronRight`.

- [ ] **Step 3: The list becomes a masonry**

Replace `<ul className="flex flex-col gap-1.5">` and its `NoteRow` children:

```tsx
{/* **A masonry, not a grid of equal tiles** — `masonry.ts`, and `NoteCard` for the argument.
    `repeat(auto-fill, minmax(280px, 1fr))` is CSS counting how many cards fit on a line, which is
    the one number this band refuses to work out for itself: four up at the editor column's 1192px,
    two from about 860, one below about 580.

    **`gridAutoRows: 1px` and `rowGap: 0`, and the vertical gutter lives inside each card's span.**
    A grid gap is drawn at every row boundary an item *crosses*, so a card spanning 200 one-pixel
    rows would carry 199 gutters inside itself. `NOTE_GAP` is added to each span instead, which
    puts it exactly once under each card — at the cost of one trailing gutter under the last card
    of every column.

    **`items-start` is load-bearing.** It keeps each card its own height, and that same
    content-sizing is what makes the measurement safe: a card's height cannot depend on the span it
    was given, so measure → span → measure cannot oscillate. */}
<ul
  className="grid items-start"
  style={{
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gridAutoRows: "1px",
    columnGap: NOTE_GAP,
    rowGap: 0,
  }}
>
  {notes.map((note) => (
    <NoteCard
      key={note.id}
      note={note}
      // The focus object itself and never a boolean: two presses on one note are two objects and
      // one `true`, so a boolean would bring the card into view the first time and do nothing the
      // second — which is exactly the press a reader makes when it has scrolled away again.
      focused={focus !== null && focus.noteId === note.id ? focus : null}
      onEdit={() => setPanel({ kind: "edit", note })}
      onCards={() => setPanel({ kind: "cards", note })}
      onDelete={() => setPanel({ kind: "confirm", note })}
    />
  ))}
</ul>
```

- [ ] **Step 4: The empty state**

```tsx
) : answered ? (
  <p className="text-xs text-dim">
    No notes on this deck yet — press <span className="text-text">New note</span> to write one.
  </p>
) : failure === null ? (
  <p className="text-xs text-dim">Reading this deck&rsquo;s notes…</p>
) : null}
```

The four-states-three-sentences rule is untouched: a **refused** read has no rows and is not
pending either, so it says nothing at all and the alert above has already spoken.

- [ ] **Step 5: Mount the three dialogs**

Below the `</div>` that closes the collapsible region, still inside the `<section>`:

```tsx
<NoteEditorDialog
  open={panel?.kind === "newNote" || panel?.kind === "newFromCard" || (panel?.kind === "edit" && live !== null)}
  draft={
    panel?.kind === "edit" && live !== null
      ? { kind: "edit", note: live }
      : panel?.kind === "newFromCard"
        ? { kind: "newFromCard", card: panel.card }
        : { kind: "new" }
  }
  pending={pending}
  onSave={(body) => {
    if (panel?.kind === "edit" && live !== null) onSave(live.id, { title: live.title, body });
    else onCreate(body, panel?.kind === "newFromCard" ? [panel.card.oracleId] : []);
    setPanel(null);
  }}
  onClose={() => setPanel(null)}
/>

{panel?.kind === "cards" && live !== null && (
  <NoteCardsDialog
    open
    title={noteTitle(live)}
    named={live.cards}
    attachable={attachable}
    onAttach={(oracleId) => onAttach(live.id, oracleId)}
    onDetach={(oracleId) => onDetach(live.id, oracleId)}
    onClose={() => setPanel(null)}
  />
)}

{panel?.kind === "confirm" && live !== null && (
  <DeleteNoteDialog
    open
    title={noteTitle(live)}
    cardCount={live.cards.length}
    pending={pending}
    onDelete={() => {
      onDelete(live.id);
      setPanel(null);
    }}
    onClose={() => setPanel(null)}
  />
)}
```

⚠️ **`onSave` sends the note's existing title back unchanged.** `deck_note_update` takes both
columns and the labels dialog one file over is where this app learned what happens otherwise: two
controls sending each other's field back is how a rename quietly undoes a recolour. The dialog
edits the body only, so the title travels with it untouched.

**`DeleteNoteDialog`** is the existing `DeleteNote`'s two paragraphs and two buttons, moved into a
`Dialog` at `size="w-[26rem]"` with `title={`Delete “${title}”?`}` — keep the cards clause verbatim
(*"The note goes for good, and stops naming its N cards. The cards themselves stay in the deck."*),
because `deck_note_cards` cascades and that is the half a confirmation can say before the press.
Write it at the foot of `DeckNotesPanel.tsx`. `useDestructiveFocus` and `useConfirmFocus` both go:
`Dialog` already hands focus back to whatever opened it.

- [ ] **Step 6: Widen `onCreate` and delete the dead code**

In `DeckNotesPanelProps`' consumer:

```tsx
onCreate={(body, oracleIds) => notes.create.mutate({ title: "", body, oracleIds })}
```

and in `NotesBandProps`:

```ts
  /** A new note: the body the reader typed, and the cards it is born naming.
   *  **`title` is not a parameter** — every note this band writes is written with `title: ""`, and
   *  `noteTitle()` answers the first line. See `NoteEditorDialog`. */
  onCreate: (body: string, oracleIds: string[]) => void;
```

Delete outright: `NoteRow`, `NoteEditForm`, `NoteCards`, `DeleteNote`, `useDestructiveFocus`,
`actionLabel`, `NoteBody`, `NoteBlock`, `Inlines`, `SECTION`, and the `lazy(() => import("./NoteEditor"))`
line (it lives in `NoteEditorDialog.tsx` now). Then let the compiler find the orphaned imports:

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Rewrite the band's tests**

In `src/features/decks/DeckNotesPanel.test.tsx`:

- **Delete** — `puts the add field before the list…`, `refuses to send a note with nothing but
  spaces in its title`, `dedupes the deck's cards by oracle id…` (moved to `deckNotes.test.ts` in
  Task 4), `offers the deck's own cards, minus the ones the note already names` and `takes a card
  off a note without taking the note anywhere` (both moved to `NoteCardsDialog.test.tsx` in Task
  5), `sends the title and the body together` and `writes nothing when the reader backs out` (both
  moved to `NoteEditorDialog.test.tsx` in Task 6), `hands the caret back to the control that opened
  a confirmation the reader declined` (`Dialog` owns that now), `names a blank-titled note by its
  body's first line, in its controls too`, `renders the body rather than printing it` and `keeps
  the newline a hard break leaves in a text run` (all three moved to `NoteCard.test.tsx` in Task 7).
- **Keep unchanged** — the four header/disclosure tests, `lists a note that names four cards beside
  one that names none`, the three `a refused read` tests, `reaches the card modal's cross-deck read
  as well as its own`, and the whole of `the editor's 141.5 kB`.
- **Add**:

```tsx
it("opens a dialog on New note, and writes nothing until Save", async () => {
  const onCreate = vi.fn();
  renderBand({ notes: [], onCreate });
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  expect(await screen.findByRole("dialog", { name: "New note" })).toBeInTheDocument();
  expect(onCreate).not.toHaveBeenCalled();
});

it("points an empty deck at the control that makes one", async () => {
  renderBand({ notes: [] });
  expect(screen.getByText(/No notes on this deck yet/)).toBeInTheDocument();
  // The add field this replaced is gone, not hidden.
  expect(screen.queryByPlaceholderText("New note title…")).not.toBeInTheDocument();
});

it("opens one panel at a time, because there is only one to open", async () => {
  renderBand({ notes: [note({ id: 1, title: "Mana base", body: "Fourteen." })] });
  await userEvent.click(screen.getByRole("button", { name: "Cards on Mana base" }));
  expect(await screen.findByRole("dialog", { name: "Mana base" })).toBeInTheDocument();
  // The three flags and the `only()` helper that kept them exclusive are one value now.
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

it("shuts a dialog whose note another window deleted", async () => {
  const { rerender } = renderBand({ notes: [note({ id: 1, title: "Mana base", body: "Fourteen." })] });
  await userEvent.click(screen.getByRole("button", { name: "Cards on Mana base" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  rerender(band({ notes: [] }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
```

- [ ] **Step 8: Run the band's tests**

```bash
npm run test:run -- src/features/decks/DeckNotesPanel.test.tsx
```

Expected: PASS. ⚠️ **A greyed menu row's accessible name includes its reason**, and the three card
actions are no longer disabled at all — if a `getByRole("button", { name: "Edit Mana base" })`
misses, check it is not still matching against a disabled row's longer name.

- [ ] **Step 9: Commit**

```bash
git add src/features/decks/DeckNotesPanel.tsx src/features/decks/DeckNotesPanel.test.tsx
git commit -m "feat(notes): draw the band as a masonry of cards over three dialogs"
```

---

### Task 9: `Add note…` creates on Save

**Files:**
- Modify: `src/features/decks/DeckNotesPanel.tsx` — the request effect
- Modify: `src/features/decks/DeckEditor.tsx:2932` — `addNote` stops inventing a title
- Modify: `src/features/decks/DeckNotesPanel.test.tsx` — the `a note act asked for from the card
  menu` block

**Interfaces:**
- Consumes: Task 8's `NotePanel`.
- Produces: no new exports. `DeckNoteRequest` is unchanged from Task 3.

- [ ] **Step 1: Write the failing tests**

Replace the two tests in `DeckNotesPanel.test.tsx`'s card-menu block that assert create-first:

```tsx
it("opens the editor on an add request and writes nothing yet", async () => {
  const onCreate = vi.fn();
  renderPanel({ request: { kind: "add", card: { oracleId: "o-bolt", name: "Lightning Bolt" } }, onCreate });

  // A cancelled dialog must leave nothing behind, which is the whole of why the create moved to
  // Save: an empty untitled note in the band is a row the reader has to notice and delete.
  expect(await screen.findByRole("dialog", { name: "New note" })).toBeInTheDocument();
  expect(screen.getByText("This note will name Lightning Bolt")).toBeInTheDocument();
  expect(onCreate).not.toHaveBeenCalled();
});

it("names the card in the create the Save makes", async () => {
  const onCreate = vi.fn();
  renderPanel({ request: { kind: "add", card: { oracleId: "o-bolt", name: "Lightning Bolt" } }, onCreate });

  await userEvent.type(await screen.findByRole("textbox"), "Four is too many");
  await userEvent.click(screen.getByRole("button", { name: "Save note" }));

  // Title blank, body the reader's, the card named in the same transaction it always was.
  expect(onCreate).toHaveBeenCalledWith(expect.stringContaining("Four is too many"), ["o-bolt"]);
});

it("leaves nothing behind when the reader backs out of one", async () => {
  const onCreate = vi.fn();
  renderPanel({ request: { kind: "add", card: { oracleId: "o-bolt", name: "Lightning Bolt" } }, onCreate });

  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(onCreate).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
```

**Keep unchanged**: `opens the band when it is shut, and leaves an open one alone`, `takes one
request once, even as the band opens under it`, `takes a second request as a second note`, `brings
a note into view without opening its editor`, `does nothing at all without a request`.

- [ ] **Step 2: Run them to verify they fail**

```bash
npm run test:run -- src/features/decks/DeckNotesPanel.test.tsx -t "card menu"
```

Expected: FAIL — `onCreate` is called on the request.

⚠️ **`-t` matches the file path as well as the test title**, so a filter that matches nothing still
exits 0 with "no tests found". Read the count, not the exit code.

- [ ] **Step 3: Move the create to Save**

In `DeckNotesPanel`, the request effect stops writing. Replace the `taken.kind === "add"` arm:

```tsx
if (taken.kind === "add") {
  // **The create moved to Save (2026-09-20).** It used to happen here — titled with the card's
  // name, the card attached in the same write — so the note turned up under that card's
  // `Notes ▸` submenu on the press. The redesign put the editor in a dialog, and a dialog a
  // reader dismisses would have left an empty untitled note behind every time. What the move
  // costs is that the submenu row arrives one round trip later, on the invalidate after Save.
  //
  // The card rides in the panel rather than in a `focus`, because there is no note id to point
  // at until that create answers — which is the asymmetry `NoteFocus` exists for, now reaching
  // only the `open` arm.
  setPanel({ kind: "newFromCard", card: taken.card });
}
```

⚠️ This is a `setState` of this component's own state **inside an effect**, which
`react-hooks/set-state-in-effect` refuses outright and which `tsc` and vitest are both green on —
it only goes red at `npm run verify`. `setPanel` belongs to `NotesBand`, not to `DeckNotesPanel`,
so it is not reachable from this effect at all. **Lift it as a prop instead**: add
`onAddRequested?: (card: Pick<DeckNoteCard, "oracleId" | "name">) => void` to `NotesBandProps`,
have `NotesBand` pass `setPanel`-backed callbacks up through it, and call **that prop** from the
effect. A prop callback is the callback shape the rule exists to leave alone, and it is what
`onRequestHandled` beside it already is.

The simplest shape that satisfies the rule: keep `focus` as it is, give `NotesBand` a
`pendingCard` prop carrying the card of the newest unconsumed `add`, and let `NotesBand` open its
own panel during **render** with the same identity-comparison adjustment it already uses for
`focus`:

```tsx
/** A card the card menu asked for a note about — opened during render, on the object's identity,
 *  for {@link focus}'s reason and by {@link focus}'s mechanism. */
const [seeded, setSeeded] = useState<typeof pendingCard>(null);
if (pendingCard !== seeded) {
  setSeeded(pendingCard);
  if (pendingCard !== null) setPanel({ kind: "newFromCard", card: pendingCard });
}
```

`DeckNotesPanel`'s effect then only calls `onToggle` and `onRequestHandled`, and sets its own
`pendingCard` state through the same during-render adjustment it already uses for `taken`.

- [ ] **Step 4: Drop the invented title**

`DeckEditor.tsx:2932`'s `addNote` already builds `{ oracleId, name }` and needs no change — but
its doc comment claims the band titles the note with the card's name. Replace that paragraph:

```ts
  /**
   * **Add note…** — the card menu's first note row.
   *
   * It writes nothing here and, since 2026-09-20, the band writes nothing on the press either:
   * the request opens the note editor seeded with this card, and **Save** is the create that names
   * it. `addLabel`'s split exactly, one beat later.
   *
   * ⚠️ **A card with no oracle id never reaches this**, and the fence is at the build site rather
   * than in here: `deckCardMenu` passes `addNote: undefined` for an orphan printing, and
   * `noteItems`' all-or-none guard then drops the whole block. …
   */
```

(Keep the rest of that comment — the orphan argument is unchanged and is still the reason
`DeckNoteRequest`'s `oracleId: string` is true without a cast.)

- [ ] **Step 5: Run the tests**

```bash
npm run test:run -- src/features/decks/DeckNotesPanel.test.tsx
npm run test:run -- src/features/decks/DeckEditor.test.tsx
npx tsc --noEmit
```

Expected: PASS, no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/DeckNotesPanel.tsx src/features/decks/DeckNotesPanel.test.tsx src/features/decks/DeckEditor.tsx
git commit -m "feat(notes): create a card's note on Save rather than on the press"
```

---

### Task 10: Stories, docs, and one live pass

**Files:**
- Modify: `src/features/decks/DeckNotesPanel.stories.tsx`
- Modify: `docs/reference/decks-storage.md` — the deck-notes section around line 3059
- Modify: `docs/reference/decks-live-findings.md` — whatever the live pass finds
- Modify: `src/features/decks/CLAUDE.md` — if any rule in it now names a deleted component

**Interfaces:** consumes everything above; produces nothing.

- [ ] **Step 1: Update the stories**

In `src/features/decks/DeckNotesPanel.stories.tsx`:

- The meta's doc comment says *"**Add first**, which is `LabelsDialog`'s ordering"* — that ordering
  is gone with the add row. Replace the paragraph with the header button's argument.
- The `note()` factory's `cards: []` default is fine; the `LongBody` story is now the story the
  **masonry** exists for, so rewrite its doc paragraph to say so and add a second long note beside
  a short one so the uneven heights are the thing on screen.
- Add `ManyNotesOfDifferentLengths` — six notes, two of them long — which is the only story that
  shows the layout's whole point.
- `NamingFourCards` gains `cardId` on each attached card so the strip draws frames.
- Keep `ReadFailed` and `Empty` exactly as they are; `Empty` now shows the header button plus one
  sentence, which is the state worth looking at.

- [ ] **Step 2: Run the story suite**

Now that the fan-out is over, the plays can run:

```bash
npm run test:run -- src/stories.test.tsx
```

⚠️ **`stories.test.tsx`'s `-t` matches the file path**, so a story-title filter that matches nothing
exits 0. Run the whole file.

- [ ] **Step 3: Verify**

```bash
npm run verify
```

⚠️ Never through a pipe — the exit code is the pipe's last command's. Redirect and read the file:

```bash
npm run verify > verify.log 2>&1; echo "exit=$?"; tail -60 verify.log
```

Then the two legs verify does not run:

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

- [ ] **Step 4: Drive the real window**

Every UI task in Plans 2–3 found something the suite could not.
[`docs/reference/live-ui-verification.md`](../../reference/live-ui-verification.md) is the contract
and documents traps that have each cost a session; the `running-the-app` skill is how you take the
`app` lock, and **only one app runs across every worktree**.

Five things only a live pass can settle — the suite cannot referee any of them, because jsdom lays
nothing out:

1. **The masonry actually flows.** Four cards up at the editor column's 1192px, two from ~860, one
   below ~580 — and a short card beside a tall one leaves **8px** under it, not the tall card's
   whole height. Measure the gaps; do not eyeball them.
2. **The floor holds.** A one-line note is 184px tall and a six-line note is taller, both with the
   actions row against the bottom edge.
3. **The placeholder is painted.** The Tailwind `content-[attr(data-placeholder)]` compiles
   (Task 6 proved that) — this is whether it is *visible*, in the right colour, with the caret in
   the right place and not pushed down a line.
4. **The thumbnails carry real art**, through the `mtgimg://` protocol, including the fallback for
   a card the deck no longer holds.
5. **The chunk stays out.** Open a deck with notes, read them, and confirm in the network panel
   that nothing Tiptap-shaped is fetched — then press `New note` and watch it arrive.

- [ ] **Step 5: Write down what the pass found**

Append to `docs/reference/decks-live-findings.md` — including **the bugs still open**. A live pass
that found nothing is a pass that was not run.

- [ ] **Step 6: Update the storage doc**

`docs/reference/decks-storage.md`'s deck-notes section (from line 3059) states the model. Add a
subsection under it:

> ### A note names a card by `oracle_id` — and *draws* one by `card_id`
>
> `attachments_by_note` resolves a **representative printing** per attachment, preferring one this
> deck holds and falling back to any printing the corpus has. It is a read-time convenience for
> drawing a 44×32 art crop and nothing else: never matched on, never written, never synced, and
> honestly different between two reads of one row. **No migration** — `deck_note_cards` is
> unchanged, so the fifteen synced tables, the grain index and `deck_undo`'s attachment snapshot
> are all untouched.
>
> The statement picks the printing **as a row**, with a correlated subquery ordered
> `(dc.card_id IS NULL), c.id`, rather than with two independent `min()` aggregates over a joined
> `cards`. The aggregate form is what the design document drew and it has a real defect: `min(c.id)`
> and `min(json_extract(c.image_uris, …))` can answer different printings, which is one card's name
> over another card's picture with nothing in the build able to see it.

Also correct the sentence in this file's own §5 reference if the plan's SQL differs from the spec's
— the spec is wrong and should say so rather than being quietly contradicted.

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/DeckNotesPanel.stories.tsx docs/reference/decks-storage.md docs/reference/decks-live-findings.md
git commit -m "docs(notes): record the redesign's printing read and the live pass"
```

---

## Self-review

**Spec coverage.**

| Spec section | Task |
| --- | --- |
| §1 the list becomes a grid | 1, 7, 8 — **with the fixed height and the clamp table replaced**, see *Decisions* |
| §1 the mono `N cards` chip comes off the name line | 7 (asserted absent) |
| §2 `New note` opens a dialog, no title field | 6, 8 |
| §2 the placeholder teaches the naming rule | 6 |
| §2 the Tiptap chunk rule survives and gets stronger | 6 (the only `lazy` reference), 8 (the old one deleted), 10 (live) |
| §3 `Edit` opens that same dialog, `NoteEditForm` deleted | 6, 8 |
| §3 three flags collapse to one union | 8 |
| §3 `NoteFocus` survives in a changed job | 9 |
| §4 `Cards` becomes a picker dialog | 5 |
| §4 pile chips | 4, 5 — **keyed on card type**, see *Decisions* |
| §5 thumbnails, and the SQL | 2, 3, 7 — **the SQL restructured**, see Task 2's warning |
| §5 `DeckNoteCard` gains `cardId` + `imageUris` | 2, 3 |
| §5 no migration | Global constraints; asserted by there being no schema rung |
| "What does not change" | Global constraints |
| OQ1 reading a long note | *Decisions* §1 — dissolved |
| OQ2 the empty state | *Decisions* §2; Task 8 step 4 |
| OQ3 the card menu's `Add note…` | *Decisions* §3; Task 9 |
| OQ4 pile chips | *Decisions* §4; Task 4 |
| OQ5 three thumbnails | *Decisions* §5; Task 7 |

**Gaps deliberately left:** the spec's `deckCardMenu.tsx → DeckEditor.tsx` row says *"see the open
question below"* — that is OQ3, settled in Task 9. `useDeckNotes.ts` is listed as unchanged in the
spec and stays unchanged here: the same five writes, called with different arguments.

**Type consistency:** `NoteCardChoice` is defined once (Task 4) and consumed by Task 5.
`DeckNoteCard` is defined in Rust (Task 2), mirrored in `ipc.ts` (Task 3) and consumed by Tasks 5
and 7. `NoteDraft` and `NoteEditorDialogProps` are defined in Task 6 and consumed in Task 8.
`NotePanel` is Task 8's alone. `masonryRowSpan`/`useMasonryRowSpan` are Task 1's and consumed by
Task 7. `onCreate` widens in exactly one place (Task 8 step 6) and both its call sites move with
it.

**Two things this plan asks an implementer to correct rather than copy:** Task 5's chip matchers
and Task 7's `+N more` name are written against what `plural` and the `aria-label` recipe actually
produce — if the component's real string differs, the **assertion** is what moves, and the plan
says so inline at both places. Task 6's `toBeDisabled()` is flagged the same way, because
`aria-disabled` is the right attribute there and `toBeDisabled` does not match it.

---

## Before the branch ships

Use the **`auto-pr`** skill, not `shipping-a-branch`: this repo has agents merging into `main`
continuously, and every merge knocks an open PR to `BEHIND`. `auto-pr` arms auto-merge and then
watches for the only two states GitHub abandons — a real conflict, and a red `ci-ok`.

- `npm run verify` green (read the log file, not a pipe's exit code)
- `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` green in `src-tauri/`
- the live pass done and written down in `decks-live-findings.md`
- ⚠️ **check the schema rung numbers against `main` before merging.** This plan adds none, so there
  is nothing to renumber — but confirm it rather than assume it, because a collision is silent.
