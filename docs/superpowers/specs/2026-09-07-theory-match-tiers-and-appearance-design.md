# Two theory marks, per-deck switches, and an Appearance tab

**Date:** 2026-09-07
**Status:** approved, not yet implemented
**Issue:** the reader's request, 2026-09-07

## What this changes, in one paragraph

The deckbuilder's theory mark answers one question today — *is the card in front of me the one I
planned* — and draws one azure tick for yes. It will answer two: **green** where the live row is
the planned printing, **blue** where it is the same card in a printing the plan did not name. Each
tier can be switched off per deck, and both colours are the reader's to choose in a new
**Appearance** group in Settings, which also becomes the home of the app-wide label list.

Nothing about the shopping list (`theory_diff`) changes. Nothing about which cards are *in* a plan
changes. This is the mark, its colour, and where a reader goes to configure both.

---

## 1. The rule

### 1.1 Two tiers, one mark per row

Every row of the **Live** list of a deck that keeps a plan resolves to exactly one mark, or to
none:

| The row | Tier | Colour | The number it carries |
| --- | --- | --- | --- |
| Its `(cardId, finish)` is a slot in the plan | **exact** | green | `live − planned` summed at the `(cardId, finish)` grain — today's number, unchanged |
| Its name is in the plan, but this `(cardId, finish)` is not | **name** | blue | `live − planned` with **every** printing and finish of that name summed on both sides |
| Neither | — | none | — |

`0` draws the tick; any other value draws the signed number in place of it, exactly as today.

**The grain of the number follows the tier, and that is the whole rule.** A green mark is a
statement about the printing the plan named; a blue mark is a statement about the card. The reader
answered this deliberately on 2026-09-07 when shown the case it costs the most in:

> Plan asks for 8 Forest of one printing; the list holds 8 Forests over four printings, 2 of each.
> The two rows of the planned printing read **green −6**; the other six rows read **blue 0**.

Both numbers are true at their own grain. The alternative — one name-grain number on both tiers —
was offered and declined.

### 1.2 The name key is `cards.name`, lowercased

Not `oracle_id`. Scryfall omits `oracle_id` on reversible cards, and it is NULL on both sides of
this comparison when it is missing, so an identity built on it needs a fallback chain that both
sides would have to spell identically.

`cards.name` needs none. Rust reads the column; the webview reads `DeckCard.name`, which **is**
that column arriving through `deck_get`'s join. The two sides are not two conventions that agree —
they are one string, copied. Lowercasing is the only transform, and it is applied on both sides.

Consequence worth stating: two distinct oracle cards that share a printed name would collapse into
one name tier. The cost is a blue tick that should not be there, on a pair of cards no
constructed deck holds both of.

### 1.3 The two switches, and the fallback

Two per-deck booleans, both defaulting **on**:

* **green off** — an exact row is re-resolved *as a name row*. It draws blue, with **blue's
  name-grain number**. One rule: the tier decides the colour and the number together, so the
  fallback needs no arithmetic of its own.
* **blue off** — a name-only row draws nothing. An exact row still draws green.
* **both off** — the deck draws no theory marks at all, which is a state no deck can be in today.

The switches are meaningless on a deck with no plan and are drawn only when `theoryEnabled` is on.

### 1.4 What does not change

* `DIFFERENCE_FLOOR` — `max(live, planned) > 1`, or the delta is reported as `0`. It applies **per
  tier**, at that tier's own sums, so a Commander singleton meets no number on either.
* Inactive categories are excluded from **both** sides of **both** tiers, on `diff_select`'s
  stated rule.
* The category a card is filed in is not part of any key, at either grain.
* Nothing is consumed during lookup. Both maps are built once and every live row reads them, so
  **every** row of a matching name draws a mark — all eight Forests, not the last one. This is
  already true of the exact tier and is the property the land case is a test for.

---

## 2. Frontend domain — `src/features/decks/theoryMatch.ts`

`theoryMatchDelta` (`number | null`) is replaced by a mark:

```ts
export type TheoryTier = "exact" | "name";
export interface TheoryMark {
  tier: TheoryTier;
  /** live − planned at the tier's own grain; `0` is the tick. */
  delta: number;
}
export interface TheoryPlan {
  /** `` `${cardId}|${finish ?? ""}` `` → live − planned. `deck_theory.rs`'s `group_key`. */
  exact: ReadonlyMap<string, number>;
  /** lowercased card name → live − planned, every printing and finish summed. */
  byName: ReadonlyMap<string, number>;
  /** The deck's two switches. */
  marks: { exact: boolean; name: boolean };
}

export function theoryMatchPlan(
  slots: readonly TheorySlot[] | undefined,
  live: readonly Pick<
    DeckCard,
    "cardId" | "finish" | "name" | "quantity" | "categoryActive"
  >[],
  marks: { exact: boolean; name: boolean },
): TheoryPlan | undefined;

export function theoryMatchMark(
  plan: TheoryPlan | undefined,
  card: Pick<DeckCard, "cardId" | "finish" | "name">,
): TheoryMark | null;
```

`undefined` still means *there is no question here* — a deck with no plan, or the Theory tab
itself — and is distinct from a plan that asks for nothing.

`theorySlot` is unchanged. A second key builder, `theoryNameKey(name)`, is one `trim().toLowerCase()`
and is the only place that transform is written on this side.

**The switch logic lives in `theoryMatchMark`, not in the views.** TS draws the conclusions; a view
asks for a mark and draws what it gets. This is what keeps the fallback in §1.3 from being
re-derived in four components.

---

## 3. Rust — `src-tauri/src/deck_theory.rs`

`TheorySlot` gains one field:

```rust
pub struct TheorySlot {
    pub key: String,       // group_key(card_id, finish) — unchanged
    pub name_key: Option<String>,  // lowercased cards.name, or None for an orphan
    pub quantity: i64,
}
```

`theory_slots` grows a **`LEFT JOIN cards c ON c.id = dc.card_id`** and selects `c.name`
**verbatim** — see §3.1 for why it is not lowered here.

* `LEFT`, so a row whose printing has left the corpus keeps its exact key and simply has no name
  tier. An inner join would silently drop the orphan from the plan entirely and take its green
  tick with it.
* The grouping stays `GROUP BY dc.card_id, dc.finish`, which is `group_key`'s grain. The name is
  functionally dependent on `card_id`, so it needs no grouping term of its own.
* Still no marketplace, still no price, still one indexed scan plus a primary-key join. The
  command's founding argument — *this is a mark, not a priced read, and must not become
  `deck_get`* — is unchanged.

### 3.1 The fold happens on one side, and it is the webview's

SQLite's `lower()` is **ASCII-only**; JavaScript's `toLowerCase()` is Unicode-aware. Card names are
Latin-script with diacritics — `Lim-Dûl's Vault`, `Æther Vial`, `Márton Stromgald` — and the two
functions disagree on exactly those characters. A plan lowered by SQLite and a live row lowered by
JS would spell two different keys for one card, and the mark would go dark on the cards hardest to
notice it missing from.

So `name_key` is `Option<String>` holding `c.name` **unchanged**, and §2's `theoryNameKey` is the
one and only place the fold is written — applied to both sides, in one language. This is the same
argument `group_key` makes about the exact key, arriving at the opposite arrangement for a good
reason: a `card_id` and a `finish` are ASCII by construction and a card name is not.

Rejected alternatives:

* **A second command** (`deck_theory_name_slots`) — an extra IPC round trip for one column, and a
  second place for the plan's grain to be spelled.
* **Resolving the tier in Rust** — needs the whole live list over the wire and puts a conclusion
  on the facts side of the boundary this repo keeps.

Both `deck_theory.rs`'s tests and `theoryMatch.test.ts` write the same name-key literals, the way
the two sides already pin `group_key` literals, so a change to the rule fails one of them.

---

## 4. Schema — user v35

Two columns on `decks`:

```sql
ALTER TABLE decks ADD COLUMN theory_mark_exact INTEGER NOT NULL DEFAULT 1;
ALTER TABLE decks ADD COLUMN theory_mark_name  INTEGER NOT NULL DEFAULT 1;
```

* `DEFAULT 1` on both, so **every existing deck gets both marks with no backfill**, and no deck
  ever sits in a state a reader has to discover.
* `USER_SCHEMA_VERSION` 34 → 35; `USER_SCHEMA_SQL`'s frozen shape updated to match.
* An `UNDO_V35` owed for `UNDO_V13`'s **loud** reason — `ALTER TABLE … ADD COLUMN` is not
  idempotent, so a fixture that kept the columns dies on the rung's second run. Two
  `DROP COLUMN`s; no index names either column, so `UNDO_V20`'s rule applies and neither needs a
  line of its own. It runs before `UNDO_V34`.
* `decks` is in `SYNCED_TABLES` and `sync_engine/capture.rs` enumerates columns through
  `PRAGMA table_info`, so the switches should travel to paired devices with no sync change.
  **This is to be verified against the capture path, not assumed.**

`DeckRow`, `DeckPatch`, `deck_create` and `deck_update` carry both, following `theory_enabled`'s
existing shape exactly — `Option<bool>` on the patch, `coalesce(?n, column)` in the UPDATE.

---

## 5. The colours

### 5.1 How a colour reaches a mark

Four custom properties in `src/index.css`:

```css
--color-theory-exact:    #56bd78;
--color-theory-exact-fg: var(--color-text);
--color-theory-name:     #0e68ab;
--color-theory-name-fg:  var(--color-text);
```

`TheoryMatchMark` and `TheoryMatchBadge` take a `tier` and draw
`style={{ backgroundColor: "var(--color-theory-exact)", color: "var(--color-theory-exact-fg)" }}`
(and `color:` alone for the badge). They read no store and take no colour prop.

An effect at the app root writes all four onto `document.documentElement` when the reader has
chosen something, computing each `-fg` with the existing `labelFgCss` luminance formula so a pale
custom green does not swallow the tick.

Why this shape:

* **No Tailwind arbitrary value.** A mistyped `bg-[…]` silently emits nothing, and a mark that
  quietly loses its fill is exactly the failure the suites cannot see.
* **No colour threaded through four surfaces.** `StackView → CardStack → row`, `GridView`,
  `TableView` and the text columns would each need a prop, for a value none of them decides.
* **Storybook and vitest get the defaults from the stylesheet for free**, with no store seeding,
  and a story that wants a custom colour sets one variable.

### 5.2 Storage

An eighth `app_meta` setting, shaped as a map, copying `listView` / `flattenState` whole:

* `markColors()` → `Record<string, string>`; `setMarkColor(key, hex)`.
* Keys are `"theoryExact"` and `"theoryName"`, narrowed on the TS side — the vocabulary of *which*
  marks are customizable is the webview's.
* The backend refuses anything that is not a `#rrggbb`, so the row cannot collect junk a later
  read would discard.
* **An absent key is not defaulted by the backend.** It means the reader has never chosen, and the
  stylesheet's own value stands.
* `app_meta` is not in `SYNCED_TABLES`, so **the colours are per-device**, while the per-deck
  switches (§4) and the labels (§6) sync. This is consistent with all seven existing preferences
  and is stated on the panel.

### 5.3 The defaults, and the finding they reverse

Default green is `--color-ok`'s `oklch(0.72 0.14 152)` converted to sRGB hex, pinned by a test the
way `LABEL_COLORS` already mirrors `index.css`. Default blue is `#0e68ab`, today's azure,
unchanged.

`CardMarks.tsx` currently records, from the 2026-08-20 pass, that green was **ruled out**:

> `--color-ok`, the green the format check draws its `CircleCheck` in, is legible and says exactly
> the wrong sentence: it is this app's "nothing is wrong here" colour, which is the one reading a
> tick must not have.

That finding was about a mark meaning *this card is in the plan*. It no longer applies to a mark
that means *this is exactly the printing you planned*, which **is** a "nothing is wrong here"
verdict. The passage in `CardMarks.tsx` and the corresponding pass in
`docs/reference/frontend-design.md` are to be rewritten to say so, with the date of the reversal.
A document left contradicting the build is the failure this repo's prose-only-edits rule exists to
prevent.

The four separations that made a tick drawable at all — place, colour, shape, and the card's own
edge — still hold: green and blue are both distant from `RuleBreakMark`'s destructive hairline box
in the opposite corner. A reader who sets a custom colour can defeat that, which is their
prerogative and is not the app's to prevent.

---

## 6. Settings — the Appearance group

A seventh `GroupId` in `src/features/settings/nav.ts`, positioned after `tags`, holding two
panels:

### `theory-marks` — "Theory marks"

Two colour controls reusing `LabelColorPicker`'s wheel and hex field, each above a live preview of
the mark it paints, and a **Reset to default** per colour that clears the stored key rather than
writing the default hex — so a reader who has never chosen and a reader who has reset are the same
state. One line saying the colours are this device's.

Keywords for the rail's search: `colour color green blue tick checkmark match plan deck mark
customise`.

### `labels` — "Labels"

The app-wide label list: add, rename, recolour, delete. It calls the existing `deckLabelAll`,
`deckLabelCreate`, `deckLabelUpdate` and `deckLabelDelete` commands and says how far a delete
reaches — `GlobalLabel.deckCount` — before it goes.

`deckLabelCreate` and `deckLabelDelete` take a `deckId` today because they are called from the
editor. From Settings there is no deck. The plan is to check whether that argument is used for
anything but the audit trail; if it is not, the commands take an optional deck and the panel sends
none. **If it is load-bearing, this panel gets read-only-plus-recolour and the gap is reported
rather than worked around.**

The deck editor's `LabelsDialog` is untouched: its two-section split ("worn by this list" vs
"every other label") is a fact about a deck, and this panel has no deck.

**It sits under Appearance and not under Tags on purpose.** A *tag* in this app is one of
Scryfall's two tagger datasets and nothing else; a *label* is the deckbuilder's coloured per-card
mark. The rail must not blur the two words.

---

## 7. Testing

| Suite | What it pins |
| --- | --- |
| `theoryMatch.test.ts` | the §1.1 table; the eight-Forest land case (**all** rows marked); the green-off fallback taking blue's number; both switches off; `DIFFERENCE_FLOOR` per tier; the singleton deck meeting no number on either tier |
| `deck_theory.rs` | `name_key` for a normal row, for an orphan (`None`), for two printings folding to one name; the same literals `theoryMatch.test.ts` writes |
| `schema.rs` | both columns exist at v35 with default 1; `UNDO_V35` re-enterable; an upgraded file keeps its decks' marks on |
| store / effect | the four variables written from a stored map; an absent key leaving the stylesheet's value; `labelFgCss` picking the legible foreground |
| `nav.test.ts` | the new group and its two panels; the keyword search reaching both |
| stories | a mark in each tier at both sizes; both new panels; a deck with each switch off |
| CDP | the real window: both marks over real art, the switches, the pickers, the label panel |

A green suite and a green Storybook prove nothing about the shipped window — the live pass is part
of the work, not a follow-up.

---

## 8. Not in scope

* No general theme editor. Two colours, because two marks asked for them.
* No colour customization for any other mark (`RuleBreakMark`, `GameChangerBanner`, the label
  dot's own palette).
* No global label reordering or sort.
* No change to `theory_diff`, the shopping list, or `TheoryDiffDialog`.
* No change to what a plan *contains* or to how a card is added to one.
