# Folder rules — design

Issue [#980](https://github.com/Msgaihede/mtg-grimoire/issues/980). A collection or wishlist
folder can carry **rules**: criteria a card filed there is expected to meet ("cards under $1",
"blue cards", "printed 2001–2005"). Rules **never stop a card being filed** — they only show which
cards do not match, with the red outline a rule-breaking card already wears in the deck editor,
and how many such cards a folder holds.

**Not to be confused with** deck validation rules (`features/decks/validation/`), Scryfall tags,
deck labels, deck tags or the folder *lock*. See `docs/agent/DOMAIN_VOCABULARY.md`.

## 1. What a rule is

A folder holds an ordered list of rules. **A card must satisfy every rule** that applies to its
folder (AND across rules); a rule with several values is satisfied by any one of them (OR inside
a rule). Two rules of the same kind are both enforced.

| `kind` | Payload | A card satisfies it when… | Collection | Wishlist |
| --- | --- | --- | --- | --- |
| `price` | `min`, `max` (either may be `null`) | its unit price at the page's marketplace is `>= min` and `<= max` | entry price (`sorting::price_expr`, `ENTRY_FINISH`) | row price (`sorting::row_price_expr`, `WISH_PREFERRED_FINISH`) |
| `manaValue` | `min`, `max` (either may be `null`) | `cards.cmc` is in the range | ✓ | ✓ |
| `colors` | `values` ⊆ `W U B R G C` | every colour in `cards.colors` is among `values`; a colourless card passes only when `C` is among them | ✓ | ✓ |
| `types` | `values` ⊆ `cardtypes::TYPE_KEYS` | `cards.type_line` contains one of the words (as `filters` does for the type chips) | ✓ | ✓ |
| `sets` | `values`: set codes, lower-case | `cards.set_code` is one of them | ✓ | ✓ |
| `rarities` | `values` ⊆ `common uncommon rare mythic special bonus` | `cards.rarity` is one of them | ✓ | ✓ |
| `finishes` | `values` ⊆ `schema::FINISHES` | collection: the entry's `finish`; wishlist: `preferred_finish` | ✓ | ✓ (a wish with no preferred finish passes) |
| `conditions` | `values` ⊆ `collection::CONDITIONS` | the entry's `condition` | ✓ | — (ignored; the editor does not offer it) |
| `borders` | `values` ⊆ `filters::BORDER_KEYS` | the border chips' own meaning (`regular` / `borderless` / `fullart`) | ✓ | ✓ |
| `released` | `from`, `to` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`; either may be `null`) | `substr(released_at, 1, len(from)) >= from` and `substr(released_at, 1, len(to)) <= to` — so `to: "2000"` is *through the end of 2000* | ✓ | ✓ |

**A rule only breaks on a fact the app knows.** An unpriced card does not break a price rule, an
orphaned entry with no card row breaks nothing, and a predicate that evaluates to SQL `NULL` is a
pass (`NOT coalesce(pred, 1)` is the conflict test).

**An any-printing wish** (`card_id IS NULL`) is judged against its oracle card: it breaks the
card-level rules (`manaValue`, `colors`, `types`, `sets`, `rarities`, `borders`, `released`) only
when **no printing** of that oracle card satisfies all of them together
(`NOT EXISTS (SELECT 1 FROM cards c2 WHERE c2.oracle_id = w.oracle_id AND …)`); its price rule is
judged on the row price the wall shows.

## 2. Inheritance

A folder's **effective rules** are its own followed by each ancestor's, nearest first — a
subfolder adopts its parent's rules (and the parent's parent's). Stored nowhere: the tree is walked
on read, in Rust for the conflict count and in TypeScript (`lib/folderRules.ts`'s
`effectiveRules`) for the badge's explanation. Moving a folder changes which rules it inherits;
that is the point.

## 3. Storage and sync (user schema v64)

- `collection_folders.rules TEXT` and `wishlist_folders.rules TEXT`, both
  `CHECK (rules IS NULL OR json_valid(rules))`. `NULL` (never `'[]'`) means no rules; every
  existing folder reads `NULL`, so the upgrade is invisible.
- The value is a JSON array of rule objects (§1). Unknown `kind`s and malformed entries are
  **skipped on read**, never an error — a newer peer may send a kind this build does not know.
- Both columns are on their tables' capture `Spec` `fields`, so rules travel with the folder
  (whole-list last-writer-wins, `decks.tags`' price).
- `UNDO_V64` drops the triggers that name the column, then both columns, and is prepended to every
  rewind chain like `UNDO_V62`.

## 4. The wire

```rust
// crates/grimoire-core/src/folder_rules.rs
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FolderRule {
    Price { min: Option<f64>, max: Option<f64> },
    ManaValue { min: Option<f64>, max: Option<f64> },
    Colors { values: Vec<String> },
    Types { values: Vec<String> },
    Sets { values: Vec<String> },
    Rarities { values: Vec<String> },
    Finishes { values: Vec<String> },
    Conditions { values: Vec<String> },
    Borders { values: Vec<String> },
    Released { from: Option<String>, to: Option<String> },
}

#[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
pub struct FolderConflicts { pub folder_id: i64, pub entries: i64, pub copies: i64 }

#[derive(Debug, Serialize)] #[serde(rename_all = "camelCase")]
pub struct RuleConflicts { pub folders: Vec<FolderConflicts>, pub ids: Vec<i64> }
```

- `CollectionFolder.rules: Vec<FolderRule>` and `WishlistFolder.rules: Vec<FolderRule>` — the
  folder's **own** rules, `[]` for none.
- `collection_folder_set_rules { id, rules: FolderRule[] }` → the re-read `CollectionFolder`.
  User folders only (`FOLDER_NOT_YOURS` for a deck's or the removed folder). An empty list stores
  `NULL`.
- `wishlist_folder_set_rules { id, rules: FolderRule[] }` → the re-read `WishlistFolder`.
- `collection_rule_conflicts { marketplace }` → `RuleConflicts`: one `FolderConflicts` per folder
  holding at least one conflicting entry (`entries` rows, `copies` = `sum(quantity)`, counted in
  **that folder alone**, not its sub-tree), and `ids`, every conflicting `collection_entries.id`.
- `wishlist_rule_conflicts { marketplace }` → `RuleConflicts` over `wishlist_entries`
  (`copies` = `sum(quantity)`).
- Both conflict commands are reads, registered on the desktop and in `commands.rs`'s table.

**Tidying on write** (`folder_rules::tidy`), refusals in one sentence each:
- at most `MAX_RULES = 20` rules — "A folder can hold at most 20 rules.";
- a values rule keeps only words of its vocabulary (sets: trimmed, lower-cased, non-blank,
  at most `filters::MAX_SET_FILTER`), deduplicated and sorted; left empty it is refused —
  "Pick at least one value for each rule.";
- a range with neither end, or `min > max`, is refused — "Give each range at least one end, with
  the lower end first."; negative prices and mana values are refused the same way;
- a date that is not `YYYY`, `YYYY-MM` or `YYYY-MM-DD` is refused — "Write dates as YYYY,
  YYYY-MM or YYYY-MM-DD.".

TypeScript mirrors `FolderRule` as a discriminated union `type` (not an interface), and
`FolderConflicts` / `RuleConflicts` as interfaces held to the Rust structs by `ipc.test.ts`.

## 5. The UI

- **Folder options → `Rules…`** on every user collection folder and every wishlist folder opens
  `FolderRulesDialog` (`packages/ui/features/folders/`): the folder's own rules as rows, each
  with a kind-specific editor (range boxes, chip toggles, set codes, dates) and a remove button;
  `Add rule` picks a kind; inherited rules are listed read-only under "From “Parent”". Save writes
  the whole list; an emptied list clears the rules.
- **A folder with effective rules wears a `ListChecks` icon** on its heading/card, whose tooltip
  lists the rules in words (`describeRule`), inherited ones named by folder — and, when it holds
  conflicting cards, a red count: "3 cards don't match this folder's rules".
- **A conflicting card is outlined in destructive red** on the wall (`CardGrid`'s `ruleBreak`
  slot: the tile's `ring-2 ring-destructive` and `CardChin`'s `tone="destructive"`), with the
  reason in its accessible name. The table views mark the row with the same red edge.
- The counts shown are the folder's **sub-tree** (`lib/folderRules.ts`'s `subtreeConflicts`
  sums `RuleConflicts.folders` over descendants), since a folder card stands for everything in it.
- Conflicts are a query under `["collection", "ruleConflicts", marketplace]` /
  `["wishlist", "ruleConflicts", marketplace]`, so every existing collection/wishlist write's
  root invalidation refreshes them.
