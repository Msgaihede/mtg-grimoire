# Deck undo and redo

**Status**: approved 2026-08-15. Supersedes the "not undoable" sentence on `deck_audit`.

The deck editor gets `Ctrl+Z` and `Ctrl+Shift+Z`. Undo reaches as far back as the deck's own
recorded history; redo lives for the length of the session and no longer.

## 1. Why the audit log is not enough on its own

The premise this began from was that `deck_audit` can be replayed backwards. It cannot. That
table records facts **for a reader**, and five kinds are lossy in the one direction undo needs:

| kind | payload | what is missing |
| --- | --- | --- |
| `swap` | `{fromSet, toSet, folded}` | the **from-printing id**. `card_id` is the printing the deck plays *now*, and a set code does not name a printing |
| `category` delete | `{name, cards: 7}` | the cards went with the CASCADE; nothing says which they were |
| `category` reorder | `{action: "reorder"}` | no order, before or after |
| `remove` (clear) / `add` (import replace) | `{cards: N}` / `{cleared: N}` | a count, not the rows |
| `deck` `theory` on | `{field, from: false, to: true}` | the write **moved the whole live list** into theory; the row says nothing of it |

Two softer ones: every payload names categories and tags **by name, not id** — resolvable, but
ambiguous the moment one is renamed — and `folder` records the destination path with no `from`.

Adding this data to `payload` was rejected. `deck_audit` is append-only, never pruned, and read
whole every time the history drawer opens; a category delete's snapshot is orders of magnitude
larger than the sentence it is stored beside. `auditText.ts` is the only reader of that column
and must stay so.

## 2. Storage: a sibling table

Schema **v17**.

```sql
CREATE TABLE deck_undo (
  audit_id  INTEGER PRIMARY KEY REFERENCES deck_audit(id) ON DELETE CASCADE,
  deck_id   INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  step      TEXT NOT NULL CHECK (json_valid(step)),
  undone_at INTEGER
);
CREATE INDEX idx_deck_undo_deck ON deck_undo (deck_id, audit_id DESC);
```

- `audit_id` is the primary key, so the journal is 1:1 with a history row by construction and
  a step cannot be recorded twice.
- `deck_id` is denormalised from `deck_audit` because it is what the index needs; the join would
  be on the hottest query in the feature.
- **Both CASCADEs are load-bearing.** A deleted deck takes its history *and* its journal, which
  is what keeps `deleting_a_deck_takes_its_history_with_it` true of the new table for free.
- `undone_at` is `NULL` while the change is applied. It **persists**, so undo survives a restart
  and continues below where it stopped.
- `deck_audit_list`'s SELECT is unchanged. Nothing in the drawer's read path grows.

## 3. One press is one step

Three commands write more than one audit row for one press:

- `deck_update` — one row per changed field
- `deck_import_commit` in `replace` mode — a `remove` and an `add`
- `deck_folder_delete` — one `folder` row per deck it un-filed

Each gets **one** `deck_undo` row, keyed to the **newest** audit row of the group. The others get
no entry, so the cursor can never land mid-press and a two-field patch is one Ctrl+Z.

## 4. A step is four restore primitives

Undo does not re-run a command backwards. It restores rows. `step` is
`{ "undo": [Op, ...], "redo": [Op, ...] }`, each list applied in order inside one transaction.

| op | restores |
| --- | --- |
| `cards` | an exact set of `deck_cards` rows over an explicit **scope** — a list of `(variant, categoryId, cardId)` cells, or a whole variant of the deck |
| `categories` | `deck_categories` rows verbatim, **including `id` and `sort_order`**, plus the `decks.default_category_id` fixup |
| `tags` | `deck_tags` rows verbatim, plus the `deck_cards.tag_id`s a delete's `SET NULL` cleared |
| `deck` | named `decks` columns back to their previous values |

`cards` alone covers add, remove, quantity, move, swap (**including the fold** — it restores both
original rows), clear-stack, import merge and replace, and the theory move. Its scope is explicit
rather than derived: the op deletes exactly the cells it names and inserts exactly the rows it
carries, so a step is idempotent and cannot reach a row the press did not touch.

A `deck_cards` row is snapshotted whole: `category_id, variant, card_id, set_code,
collector_number, lang, name, tag_id, quantity, needs_review`. `id`, `created_at` and `updated_at`
are deliberately **not** restored — a restored row is a new row, and `deck_allocations` holds
`collection_entry_id`s rather than `deck_cards.id`s, so nothing points at the old one.

### Ids come back

`deck_categories.id` and `deck_tags.id` are plain `INTEGER PRIMARY KEY` with no `AUTOINCREMENT`,
so a deleted row can be re-inserted **with its own id** and every `deck_cards.category_id` /
`.tag_id` still resolves. If that id has been taken since, the step inserts under a new id and
**remaps the referencing rows in the same transaction**. Both paths are in the transaction that
also runs `allocate_deck`, so no reader ever sees the intermediate state.

### The boundary holds

Restoring the exact rows that were there is data plumbing. Nothing in `deck_undo.rs` decides what
a card is, which pile it belongs in, or what a change should be called — `autoCategoryFor` is not
consulted and `auditText.ts` is still the only thing that words a sentence.

## 5. The cursor is a query; redo is memory

- **Undo** — the newest `deck_undo` row for this deck with `undone_at IS NULL`. Apply `step.undo`,
  stamp `undone_at`, write an audit row for it.
- **Redo** — an in-memory list of just-undone `audit_id`s in a TS store, per deck. Apply
  `step.redo`, clear `undone_at`, write an audit row. **Any other write clears it.**
- **An undo's or redo's own audit row gets no `deck_undo` entry.** It is not itself a step, so the
  stack stays linear and `Ctrl+Z` twice never toggles.
- The cursor falls out of `deck_id`, so every deck keeps its own position with no state stored
  anywhere and no cross-deck ordering to invent.

### The two new audit kinds

`undo` and `redo` join `schema::AUDIT_KINDS`, making eleven. The CHECK on `deck_audit.kind` is
rebuilt in the v17 step. Payload is `{ "of": <audit_id>, "kind": "<the kind undone>" }`; `delta`
is the negation of the undone row's delta on an undo and the original delta on a redo, so the day
header's roll-up still adds up. `auditText.ts` gains two arms that render the undone row's own
sentence inside the verb — "Undid: Removed 2 × Lightning Bolt" — by recursion into
`auditSentence`, which is why the id is in the payload.

## 6. What every write site owes

Every site that calls `deck_audit::record` also calls `deck_undo::record_step`, in the same
transaction, with the same rollback guarantee — the rule `a_recorded_change_that_rolls_back_
leaves_no_history` already pins, extended to the journal.

| site | step |
| --- | --- |
| `deck::add_card` | `cards` over the one cell |
| `deck::set_card_quantity` (both arms) | `cards` over the one cell |
| `deck::move_card` | `cards` over two cells |
| `deck::swap_printing` | `cards` over both cells, carrying both pre-fold rows |
| `deck::clear_category` | `cards` over the whole (variant, category) |
| `deck::update_deck` | `deck` with the changed columns; **plus** a whole-variant `cards` op when the theory move ran |
| `deck::set_folder`, `deck::set_cover_image` | `deck` |
| `deck_meta::create_category` / `rename_category` / `set_category_active` | `categories` |
| `deck_meta::reorder_categories` | `categories` carrying every id's `sort_order` |
| `deck_meta::delete_category` | `categories` + `cards` over both variants + the `default_category_id` fixup |
| `deck_meta::create_tag` / `update_tag` | `tags` |
| `deck_meta::delete_tag` | `tags` + the `deck_cards.tag_id`s it cleared |
| `deck_meta::set_card_tag` | `cards` over the one cell |
| `deck_meta::delete_folder` | `deck` per re-filed deck (the folder row itself is not a deck write and is out of reach — see §8) |
| `deck_import::commit_import` | whole-variant `cards`, both modes |
| `deck_theory::copy_from_live` | whole-variant `cards` on `theory` |

## 7. The commands

Two, plus one read:

- `deck_undo_state(deckId)` → `{ undo: DeckUndoStep | null, redo: DeckUndoStep | null }`, where a
  step carries its `auditId` and the `DeckAuditEntry` it belongs to, so the button can name what
  it would do without a second query.
- `deck_undo_apply(deckId, auditId)` — undo the named step. The id is passed rather than implied
  so a stale window cannot undo something it was not looking at; a mismatch with the current
  cursor is refused in words.
- `deck_redo_apply(deckId, auditId)` — the mirror.

All three take the write lock through `db::lock_for` like every other deck write, and both apply
commands end with one `allocate_deck` run over the deck.

## 8. What is out of reach, and why

1. **`deck_create`, `deck_duplicate`, `deck_delete`** record no step. They are gallery writes with
   no editor open, and undoing "this deck was born" means deleting the deck the reader is standing
   in. The stack stops at the deck's first row.
2. **Rows already on disk** carry no step and none can be invented. The drawer marks them, and
   this is the honest floor of "as far as the audit log allows".
3. **A folder's own row.** `deck_folder_delete` writes one audit row **per deck it un-filed** and
   none for the folder, because `deck_audit.deck_id` is `NOT NULL`. Undo puts the decks back where
   they were; it does not resurrect the folder. Stated rather than hidden: the reader gets their
   filing back and re-makes the folder by name.
4. **`deck_set_view_state`** and both `missing_to_wishlist` commands were never on the stack —
   the first records no audit row by design, and the second two write the wishlist, which has no
   history of its own.

## 9. The UI

- Two toolbar buttons, `Undo` and `Redo`, each naming what it would do by reusing
  `auditText.auditSentence` on the entry the state command handed back.
- `Ctrl+Z`, `Ctrl+Shift+Z` and `Ctrl+Y`. The handler **yields inside text fields** — the quick-add
  field's `Ctrl+Z` stays the browser's — reusing `isTextField` from `useContextMenu.ts`, which the
  native-context-menu carve-out already relies on.
- `aria-disabled`, never the `disabled` attribute, so a greyed button keeps its tab stop.
- Refusals report through `DeckEditor`'s existing `newestWrite` banner; both mutations join that
  family.
- `DeckHistoryDialog` greys a row whose step is undone.

## 10. Testing

- **Rust**: a `deck_undo.rs` test per write site driving the command, undoing it, and asserting
  the deck reads **identically** to before — row for row over `deck_cards`, `deck_categories`,
  `deck_tags` and the `decks` columns. The list is the shape
  `every_deck_write_leaves_exactly_one_audit_row` already uses, so the two lists sit beside each
  other and a new write missing from either is one line to add.
- A round-trip test: undo then redo leaves the deck as it was after the original write.
- The rollback rule: a refused apply leaves no history and no `undone_at`.
- The id-collision path: delete a category, create another that takes its id, undo, assert the
  cards resolve.
- **TS**: `auditText` for the two new kinds, the redo-queue store (cleared by any other write),
  and the keyboard handler's text-field yield.
- **Live**: drive the shipped window — the suite cannot see the allocator, and jsdom cannot see a
  keyboard shortcut competing with WebView2.
