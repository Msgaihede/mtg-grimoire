# Strict colour matching and a card-type filter

Design for [issue #493](https://github.com/Msgaihede/mtg-grimoire/issues/493). Two filters that
travel together because they land in the same six files, and are otherwise unrelated.

## 1. What the issue asks for

> Setting X colors should return only cards with those X colors. Cards with fewer than X colors
> should not match. Cards must include all X colors.

and

> Add a type filter, such as creature or land, to most filter settings, especially expanded
> filters.

## 2. Strict colour matching

### 2.1 What it changes

Today every colour filter in the app is **subset semantics on `color_identity`** — "RW" answers
mono-R, mono-W, RW **and every colourless card**, because a colourless card fits in any deck.
`filters.rs:274-291` expresses it as exclusions: one `instr(…, '{ch}') = 0` per *unpicked* letter,
so the clause count is fixed and every clause is a plain `instr`.

Strict adds the other half rather than replacing it:

| picked | loose answers | strict answers |
| --- | --- | --- |
| `RW` | mono-R, mono-W, RW, colourless | RW and nothing else |
| `W` | mono-W, colourless | mono-W only |
| `C` | colourless only | colourless only — **identical** |

`C` is degenerate on purpose and needs no special case: `toggleColor` (`useCardSearch.ts:321`)
makes `C` exclusive both ways, and the existing `colors == "C"` arm already means
`color_identity = ''`, which is exactly the strict reading of it.

**The axis stays `color_identity`.** The chip group is already named `Color identity`
(`FilterBar.tsx:875`), both `SearchRequest.colors` and `CardFilters.colors` document that axis,
and one chip row reading two different columns depending on a toggle is a control that lies. The
consequence worth stating out loud: a basic Forest has `colors: []` and `color_identity: [G]`, so
strict `G` includes it.

### 2.2 The SQL

The loose arm keeps its exclusions; strict adds an inclusion per *picked* letter:

```rust
for ch in COLORS {
    if colors.contains(ch) {
        // strict only
        p.wheres.push(format!("instr(coalesce({alias}.color_identity,''), '{ch}') > 0"));
    } else {
        p.wheres.push(format!("instr(coalesce({alias}.color_identity,''), '{ch}') = 0"));
    }
}
```

Five clauses, all `instr`, no parameters — the arm's existing shape, which is what keeps it
inside `idx_cards_collapse`'s trailing `color_identity`.

### 2.3 The facet mirror, which is the part that breaks silently

`index/facets.rs` holds a second implementation of this predicate and the two are one contract
(module doc, `facets.rs:14`). `apply_colors` (`facets.rs:225-240`) gains a `strict: bool` and
mirrors §2.2.

**It has two call sites and the second is the one that gets missed** — `base` (`facets.rs:192`),
which filters the result set, and `compute` (`facets.rs:469`), which answers "how big is the
result set after pressing this chip". Pass the flag at `base` only and the search runs strict
while every chip's count is still computed loose.

`toggle_colors` (`facets.rs:490-505`) needs **no** change: it mirrors the frontend's
`toggleColor`, which produces the picked-colour *string*, and strict is a sibling boolean that no
colour press alters.

`FacetResponse.colors` is documented as the size of the result set **after toggling that chip**,
and `colorDisabled` (`facets.ts:70`) greys a chip when that number is `0` **or equals `total`**.
That second arm exists because loose colours *broaden*. The rule itself is semantics-agnostic —
"pressing this would not change the result set" is true under either mode — so `facets.ts` needs
no change, but the counts feeding it must be computed under the active mode or every chip greys
by a rule that no longer describes what the press does.

### 2.4 The control

A sixth chip appended to the colour group, labelled **`Exactly`**, rendered only once at least one
colour is picked. Pressed, the row reads "exactly these colours".

- No dead control on an unfiltered search, and no sixth chip competing for the deck panel's 206px
  floor (the width the group's `flex-wrap` exists for, `FilterBar.tsx:872`).
- Pressing it with nothing picked is unreachable rather than a no-op.
- Clearing the last colour turns it off, so the flag can never survive as invisible state.

It rides the stated-filter strip too: the existing `Colour: White, Blue` chip
(`FilterBar.tsx:367-376`) gains an `exactly` prefix when set, and its `remove` clears the flag
alongside the colours.

### 2.5 Wiring

`colors`/`toggleColor` are **required** members of `FilterSurface` (`FilterBar.tsx:182-183`), so
`colorsStrict`/`toggleColorsStrict` join them as required members and all eight mounted surfaces
get the control at once. Four hooks own the state — `useCardSearch:507`, `useCollection:168`,
`useWishlist:129`, `useCollectionSearch:338` — and each owes four things: the `useState`, the
exposure, the `resetAll`, and **the React Query cache key** (`useCardSearch:737`,
`useCollection:320`, `useWishlist:243`, `useCollectionSearch:447`). A key that omits the flag
serves a stale page on the first press, which is the failure that looks like "the toggle does
nothing".

Wire format: a sibling boolean `colorsStrict`, not a sentinel inside the `colors` string. The
string is parsed by `to_ascii_uppercase` + `contains` in two languages; a marker character in it
would have to be stripped in both.

## 3. The type filter

### 3.1 Semantics

Eight types, **OR within the group, AND with every other filter** — the rarity chips' shape
exactly. A card matches a chip if that type word appears on its type line as a **whole word**,
so Dryad Arbor (`Land Creature — Forest Dryad`) matches both `Land` and `Creature`, and an
artifact land matches both `Land` and `Artifact`.

**This is deliberately not `autoCategory.ts`'s or `deckBuckets.ts`'s rule.** Those two file a card
into exactly one bucket and disagree with each other about Land on purpose
(`deckBuckets.ts:39-47`). A filter answers a different question — *does this card have this type*
— and a reader who presses `Creature` and cannot find an artifact creature has been told a
falsehood. The repo already holds two lists that must not be folded together; this is a third
constant for a third question, and the spec says so where all three can be found.

**Both faces count.** `cards.type_line` on a DFC holds `Sorcery // Land`, and an MDFC land is a
land to anyone filtering for lands. This is the consistent extension of "matches every type it
has", and it is the one place this filter diverges from the front-face-only rule the two deck
constants share.

### 3.2 Storage — `type_mask`, and why not `LIKE`

`type_line` is not in `idx_cards_collapse`, and `schema.rs:181-185` records that putting it there
"was built and measured, and is a straight loss". A `type_line LIKE` predicate therefore knocks
the collapsed browse off its covering index, which the same file measures at **455–505 ms against
22–47 ms** for exactly that class of change.

So: an integer column, indexed, exactly as `legalities` became `legal_mask` — the precedent
`schema.rs:196` states outright ("a JSON path is not indexable, which is the whole reason
`crate::legalities` exists").

New module `src-tauri/src/cardtypes.rs`, mirroring `legalities.rs`:

```rust
/// Bit *k* of a mask is `TYPE_KEYS[k]`. **Append only** — bit positions are stored data.
pub const TYPE_KEYS: [&str; 8] = [
    "Artifact", "Battle", "Creature", "Enchantment",
    "Instant", "Land", "Planeswalker", "Sorcery",
];

pub fn type_mask(type_line: &str) -> u32;
```

Alphabetical and frozen for `LEGALITY_KEYS`' reason: the order carries no meaning, and the
append-only rule outranks any wish to re-sort. A `NULL` type line masks to 0.

**Whole-word matching, and the append-only rule is why it is not a substring test.** Substring is
safe for these eight words today and stops being safe the moment anyone appends `Plane` — every
Planeswalker contains it. Both implementations pad and compare:

- Rust: split on `//`, split each face on `—`, tokenise the type half on whitespace.
- SQL (the backfill only): `' ' || replace(replace(type_line,'—',' '),'//',' ') || ' ' LIKE '% Creature %'`.

A test pins the two against the same corpus fixture, the way
`legalities.rs:264-293` pins its SQL backfill against `legal_mask`.

### 3.3 Corpus schema 5

`CORPUS_SCHEMA_VERSION` 4 → 5. One rung in `migrate_corpus`, **shape-gated and not version-gated**
— the trap that function's doc already spells out twice: every converted database and every fresh
install arrives already stamped at head, so a version gate skips exactly the two largest
populations and the next ingest dies on `table cards_staging has no column named type_mask`
(`create_staging` derives its layout from `PRAGMA table_info`).

```rust
if type_mask_is_owed(conn, CORPUS)? {
    add_type_mask(conn, CORPUS)?;
}
```

**Unlike corpus schema 3 and 4, this rung backfills, and it must.** `produced_mana` and
`printed_size` read NULL until the next fetch because their data is not in the database. A type
line *is*, and the column is `NOT NULL DEFAULT 0` — so without a backfill every card masks to "no
type" and the new filter answers an empty wall until the next sync. That is the fail-closed
failure this repo refuses everywhere else.

The rung is three statements: the `ALTER`, the `UPDATE` backfill, and the widened index. **The
index must `DROP` first** — a `CREATE INDEX IF NOT EXISTS` over an existing name is a silent
no-op, which `src-tauri/CLAUDE.md` names as its own hazard. `idx_cards_collapse` gains `type_mask`
beside `legal_mask` in `CARDS_INDEXES` (`schema.rs:198-200`), the literal at `schema.rs:4556`, and
`CORPUS_SCHEMA_SQL`'s `cards` CREATE (`schema.rs:4344`).

No FTS rebuild is owed: the rung adds an unindexed column and rewrites none of
`name`/`type_line`/`search_text`, and renumbers no rowids — schema v2's stated precedent.

`ingest.rs` writes the column per row — beside `legal_mask` in both the bind list (`:332`) and the
`INSERT` column list (`:374`) — so a synced corpus is correct without the backfill ever running
again. The fixture column table at `ingest.rs:673-674` gains a row for the same reason.

### 3.4 The predicate

In `push_card_filters`, shaped like the `rarities` arm:

```rust
if let Some(picked) = f.types.as_deref() {
    let mask = mask_of(picked);          // OR of each named bit; unknown words dropped
    if mask != 0 {
        p.push(format!("({alias}.type_mask & ?) != 0"), Box::new(mask as i64));
    }
}
```

One parameter, one clause, inside the covering index — the `format` arm's shape. A blank or
unrecognised list adds no SQL at all, which is `picked_rarities`/`picked_sets`' rule.

### 3.5 Facets

The type chips get counts, so they grey like the rarity chips rather than staying live over an
empty answer. `CardIndex` gains `types: [BitSet; 8]`, filled from a ninth column on the build's
one scan (`index/mod.rs:204-208`) — reading `type_mask` directly, not `type_line`, so the index
and the SQL cannot disagree about what a type is. `Skip` gains a `Types` variant,
`Prepared` a `types` field, and `compute` a `union_types` counting loop, all mirroring `rarities`.

Like `rarity`, the eight bitsets **do not partition** — a card can be Artifact and Creature — so
the counts do not sum to `total`, the caveat `index/mod.rs:90-94` already carries.

### 3.6 Where it appears

A new `TrayCell` named `"type"`, drawn as eight `ToggleChip`s in a captioned cell — the `rarity`
cell's markup (`FilterBar.tsx:1747-1760`), including its `optionDisabled` "a selected option is
never greyed" arm.

Added to all four tray lists, since the issue asks for "most filter settings, especially expanded
filters":

| Tray | Where |
| --- | --- |
| `SEARCH_TRAY` | `FilterBar.tsx:117` — covers the search page, Tags, and the three docked panels |
| `COLLECTION_TRAY` | `CollectionPage.tsx:664` |
| `COLLECTION_TRAY` | `CollectionSearchTab.tsx:55` (deck editor) |
| `WISHLIST_TRAY` | `WishlistPage.tsx:324` |

Chip order is `TYPE_BUCKETS`' (`deckBuckets.ts:49-58`) — Creature first, Land last, because that
is how every decklist reads — and **not** `TYPE_KEYS`' alphabetical bit order. A matching order
and a display order are two constants here for the reason `autoCategory.ts:162-166` gives.

`PrintingsFilterBar` gets nothing: every printing of one card shares a type line.

### 3.7 Wiring

`types: readonly string[]` / `toggleType` join `FilterSurface` as **optional** members, so the
cell draws only where a surface answers it — the rule `FilterTray`'s `drawn` record already
enforces. The same four hooks, the same four obligations as §2.5 (state, exposure, `resetAll`,
cache key), plus `activeFilterCount` (`useCardSearch.ts:256`) and the two sibling predicates in
`useCollection.ts:107` / `useWishlist.ts:101`. One kind, however many chips are pressed — the
`colors` and `rarities` rule.

## 4. The IPC contract, and the fence that is missing

Two fields on each of two interfaces:

- `SearchRequest` (`ipc.ts:276`, Rust `search.rs`) — `colorsStrict?: boolean`, `types?: string[]`.
  `SearchRequest::card_filters()` (`search.rs:192-210`) projects both across.
- `CardFilters` (`ipc.ts:960`, Rust `filters.rs:75-149`) — the same two. Collection and wishlist
  inherit them through `#[serde(default)]` on their nested `cards` object, and `web/route.rs`
  needs no change at all because it deserializes whole structs.

Both comments on `colors` currently end **"Subset semantics"**; both must now say which mode that
describes.

**None of `SearchRequest`, `CardFilters` or `FacetResponse` is on `ipc.test.ts`'s mirror tables**,
so all three drift silently between Rust and TS today. Adding the three rows is one line each and
belongs in this change — it is the fence that would catch a `types` that reached TS and never
reached Rust, which is precisely the bug this feature can produce.

`wishlist_optimize_plan` (`ipc.ts:7503`) takes a `WishlistQuery` and so inherits both fields; it
is fed the list's own query, so it needs no call-site change but does need checking that Rust
honours them there.

## 5. Testing

| Layer | What |
| --- | --- |
| `cardtypes.rs` | `type_mask` over real type lines — Dryad Arbor, an artifact land, an MDFC, a NULL line, and the `Plane`/`Planeswalker` whole-word case |
| `schema.rs` | the rung is shape-gated (a head-stamped v26-shaped `cards` is still repaired); the backfill and `type_mask` agree; the widened index is really widened |
| `filters.rs` | strict vs loose over the existing `search_ids` harness — `RW` strict excludes mono-R and colourless; `C` is identical in both modes; the type predicate matches every type a card has |
| `index/facets.rs` | `apply_colors` and `toggle_colors` agree with the SQL under **both** modes; type counts do not sum to `total` |
| `ipc.test.ts` | the three new mirror rows |
| `useCardSearch.test.ts` etc. | cache keys change when either new filter changes |
| `FilterBar.test.tsx` | `Exactly` is absent with no colour picked, appears on the first pick, and clears with the last |
| Storybook | the type cell and the strict chip |
| Live | the shipped window over CDP — the tray cell at the 206px panel floor, and a strict search actually narrowing |

## 6. Out of scope

- Persisting either filter. No filter in this app persists today — no URL state, no zustand, no
  `app_meta` — and adding it for two filters alone would be the first.
- A strict mode for the **printed** `colors` column. One axis, stated in §2.1.
- Types beyond the eight. `TYPE_KEYS` is append-only precisely so `Kindred`, `Plane` and the rest
  can arrive later without reinterpreting a single stored row.
- Tag-side or deck-side type grouping. `autoCategory.ts` and `deckBuckets.ts` are untouched.
