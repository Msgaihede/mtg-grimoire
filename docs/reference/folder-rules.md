# Folder rules — criteria a folder's cards are expected to meet (issue #980)

A collection or wishlist folder can carry any number of **folder rules** — "cards under $1",
"blue cards", "printed 2001–2005". The design is
[2026-10-14-folder-rules-design.md](../superpowers/specs/2026-10-14-folder-rules-design.md); this
page is what shipped and where it lives. Vocabulary: a folder rule is neither a deck validation
rule nor the folder lock — see [DOMAIN_VOCABULARY.md](../agent/DOMAIN_VOCABULARY.md#rule-a-folders-a-decks-and-the-games).

## Advisory, never a fence

**A rule never refuses a card.** Filing, importing, scanning and moving all work exactly as they
did; what a rule changes is what is *drawn*: the card that does not match is outlined in red on
the wall (and marked in the table), and the folder's heading wears a `ListChecks` badge whose
tooltip lists the rules in words and, in red, how many cards in the folder (its sub-tree
included) do not match. That is the issue's own motivation — a rule shows, it does not prevent.

## What a rule is

Ten kinds, the table in the design's §1: `price`, `manaValue`, `colors`, `types`, `sets`,
`rarities`, `finishes`, `conditions` (collection only), `borders`, `released`. A card must satisfy
**every** rule (AND); a rule with several values is satisfied by **any** of them (OR). Ranges
(`price`, `manaValue`, `released`) may be open at either end — `released { from: null, to: "2000" }`
is "through the end of 2000", because a partial date compares the same-length prefix of
`cards.released_at`.

**A rule only breaks on a fact the app knows.** An unpriced card passes a price rule; an orphaned
entry with no card row passes everything; a wish with no preferred finish passes a finish rule.
In SQL the conflict test is `NOT coalesce((predicate), 1)`.

**An any-printing wish is judged against its oracle card**: it breaks the card-level rules only
when no printing of the card satisfies all of them together — a wish for "any Lightning Bolt" in a
folder ruled to `M10` is fine, because one exists.

## Inheritance is walked, never stored

A folder's effective rules are its own followed by each ancestor's, nearest first. Nothing copies
a parent's rules down: the tree is walked on every read — in Rust for the conflicts
(`folder_rules`), in TypeScript for the badge's explanation (`packages/ui/lib/folderRules.ts`'s
`effectiveRules`). So moving a folder under a ruled parent changes what it is held to, at once,
and a parent's edit reaches every subfolder without a write to any of them — the lock's rule
(collection-folders.md, *The lock inherits down the tree*) for the lock's reason.

## Storage and sync — user schema v64

`collection_folders.rules` and `wishlist_folders.rules`, `TEXT CHECK (rules IS NULL OR
json_valid(rules))`. `NULL` is "no rules" and is what every folder reads after the upgrade; a
write of an empty list stores `NULL`, never `'[]'`. The column is on both tables' capture specs, so
rules travel with the folder as one field — whole-list last-writer-wins, `decks.tags`' price.
**Reading is lenient**: an element of an unknown `kind` (a newer peer's) or a malformed one is
skipped, never an error. Writing is strict: `folder_rules::tidy` normalises the values against the
app's own vocabularies and refuses an empty values rule, a range with no end or with its ends
reversed, and a malformed date, each in one sentence.

## Commands

| Command | Kind | Answers |
| --- | --- | --- |
| `collection_folder_set_rules { id, rules }` | write | the re-read `CollectionFolder`; user folders only (`FOLDER_NOT_YOURS`) |
| `wishlist_folder_set_rules { id, rules }` | write | the re-read `WishlistFolder` |
| `collection_rule_conflicts { marketplace }` | read | `RuleConflicts` — per-folder counts (that folder alone) and every conflicting entry id |
| `wishlist_rule_conflicts { marketplace }` | read | the same over wishes |

The marketplace is the page's, because a price rule judges the price the wall shows. The page
sums the per-folder counts over a sub-tree (`subtreeConflicts`) for a heading, and reads `ids` to
outline tiles. The conflict queries sit under `["collection", …]` / `["wishlist", …]`, so every
write that already invalidates those roots refreshes them.

## Where the code is

| File | What |
| --- | --- |
| `crates/grimoire-core/src/folder_rules.rs` | `FolderRule`, `tidy`, `read_rules`/`write_rules`, the SQL predicates and the two conflict reads |
| `crates/grimoire-core/src/collection_folders.rs`, `wishlist_folders.rs` | `rules` on the folder DTOs and `set_folder_rules` |
| `crates/grimoire-core/src/schema.rs` | rung v64 and `UNDO_V64` |
| `crates/grimoire-core/src/sync_engine/capture.rs` | `"rules"` on both folder specs |
| `packages/ui/lib/folderRules.ts` | kinds, labels, `describeRule`, `validateRule`, `effectiveRules`, `subtreeConflicts` |
| `packages/ui/features/folders/FolderRulesDialog.tsx` | the editor the folder menu's `Rules…` opens |
| `packages/ui/features/folders/FolderRulesBadge.tsx` | the heading's icon, tooltip and red count |
| `packages/ui/features/collection/useCollectionFolders.ts`, `packages/ui/features/wishlist/useWishlistFolders.ts` | `setRules`, `useCollectionRuleConflicts`, `useWishlistRuleConflicts` |
| `packages/ui/features/search/CardGrid.tsx` | the `ruleBreak` slot — the red outline on a tile |
| `packages/fake/db.ts` | the fake's rules and its own evaluation of them, for Storybook and the page tests |
