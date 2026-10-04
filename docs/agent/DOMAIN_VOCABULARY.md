# Domain vocabulary

Words in this app that are easy to swap for each other — and where swapping them gives you a
sentence that reads fine and points at the wrong thing. Moved out of the root
[`CLAUDE.md`](../../CLAUDE.md) without changing the wording. The short version is in the root
file. This page is the full rule.

## Tag, label, keyword

**A _tag_ in this app is one of Scryfall's two Tagger datasets and nothing else.** **Oracle Tags**
say what a card _does_ (`removal`, `ramp`, `recursion`), which is what a deck add is filed by; a
database that has never fetched them files by card type instead, and that fallback is the floor
rather than an error. **Art Tags** say what an illustration _shows_ (`forest`, `dragon`, `dog`),
which is what the Tags page browses by; a database that has never fetched them has a Tags page
that says so and still answers from the oracle side. (How and when they are fetched is in
[EXTERNAL_SERVICES.md](EXTERNAL_SERVICES.md#scryfalls-tagger-datasets).)

- The deckbuilder's own coloured per-card mark is a **label** — `deck_labels`,
  `deck_cards.label_id`, the `Labels` dialog.
- The collection's free-text `tags` column is a third thing again.
- **A _keyword_ is a fourth, and it is the one most likely to be miscalled a tag**:
  `cards.keywords` at corpus schema 5 holds the card's own **keyword abilities** — `flying`,
  `vigilance` — which is what the search box's `kw:` asks about, and it is a fact Scryfall ships
  on the card rather than a taxonomy anyone tagged it with. The measurement that separates it
  from the rules text it is written in is in
  [search-syntax.md](../reference/search-syntax.md): `kw:flying` answers 3,318 cards and
  `o:flying` 4,617, while `kw:flying -o:flying` is 0.

Never let the words trade places.

## Note (and the to-do list that is not one)

**_Note_ is the same trap one word over, and it is worse because all four spellings are the
reader's own prose rather than three of one thing and one of another.**

- A **deck note** is what they wrote about one deck and is the only one that attaches cards —
  `deck_notes` and `deck_note_cards`, the band `NoteEditor` opens in the deck editor, many to a
  deck since user schema v43 replaced the single `decks.notes` column.
- A **card note** is not a table at all: it is those same rows read from the card's side, across
  every deck at once, which is what the `card_notes` command and the `CardNote` shape answer —
  and why the two questions, _what has this deck written_ against _what has anyone written about
  this card_, must stay two commands and never collapse into one.
- An **entry note** is neither: a free-text column on one row of the binder or the wishlist
  (`collection_entries.notes`, `wishlist_entries.notes`), which travels with that row through a
  fold, a move and an export field of its own.
- A **sticky note** is the reader's prose about nothing in particular, on the home page —
  `sticky_notes` at user schema v46, filed against no deck, no card and no row, which is the
  whole of what separates it from the first three.
- A **deck to-do list** is a fifth thing and is **not a note at all** — `deck_todo_lists`, many
  titled lists to a deck at user schema v59, each body a document of headings, text and to-dos,
  whose to-dos are still lines with no row of their own. **It is now shaped exactly like a deck
  note** — a title, a body, a card in a band beside the Notes band, the notes' editor and their
  inline dialect — which is what makes it easy to miscall, and why the difference has to be said:
  no card attachments, no row in `deck_notes`, no Save and no history. v58 had one checklist to a
  deck in `decks.todos`, every line a to-do; v59 converted it and dropped the column.

**The overlap is not cosmetic**: `deck_notes` and `sticky_notes` share a title-and-body shape, a
CommonMark dialect and a renderer, so a sentence that says "notes" and means one of them reads
perfectly as the other. Say which.
