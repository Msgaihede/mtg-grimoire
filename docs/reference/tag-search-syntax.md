# Scryfall tagger syntax in the card search box

`o:ramp`, `otag:"spot removal"`, `-a:dragon` — typed into the search box on the search page and
into the deck editor's docked panel, which are one control: both draw `FilterBar` over
`useCardSearch`, so the whole feature is one wiring rather than two.

Every figure and every Scryfall behaviour quoted here was measured live on **2026-08-20** against
`api.scryfall.com/cards/search` and is recorded in full in
[the art-tags research](../superpowers/research/2026-08-20-scryfall-art-tags.md). Nothing in this
document is a guess about what Scryfall does.

## The keywords

| taxonomy | keywords | what it means |
| --- | --- | --- |
| art | `art:` `atag:` `arttag:` `art_tag:` `art-tag:` **`a:`** | what the illustration *shows* |
| oracle | `otag:` `oracletag:` `oracle_tag:` `oracle-tag:` `function:` **`o:`** | what the card *does* |

Everything but the two in bold is Scryfall's, and every one of those answers a byte-identical
total there: `art:` `atag:` `arttag:` `art_tag:` all return 1,145 for `dragon`, and `otag:`
`oracletag:` `function:` `oracle_tag:` `oracle-tag:` all return 6,428 for `removal`. `itag:`,
`ftag:`, `otags:` and `ptag:` are HTTP 400 there and are free text here.

The keyword is matched with separators dropped and case folded (`tagQuery.ts`'s `keywordKey`),
which is why the table lists two names rather than six spellings of them, and why `OTAG:` works.

### `a:` and `o:` are a deliberate departure, and this is the paragraph about it

**On Scryfall `a:` is `artist:` and `o:` is `oracle:`** — the card's rules text. Here they are the
two taxonomies, asked for on 2026-08-22 on the grounds that `atag:`/`otag:` are the spellings
nobody mistypes and also the ones nobody reaches for twice a minute.

Nothing in this app collides: the box had no keyword syntax at all before this, so the cost is
paid only by a reader carrying Scryfall muscle memory, and it is paid in a search that returns the
wrong thing rather than an error. **If artist or oracle-text keywords are ever added here they
cannot have these two spellings.** That is the standing consequence, and it is written at
`tagQuery.ts`'s module head as well as here.

## The grammar, and what is deliberately not in it

- `keyword:value`, with `"…"` or `'…'` around a value with a space in it.
- A leading `-` excludes: `-a:dragon`.
- Tags **AND** together, which is both Scryfall's rule and `filters::picked_tags`'.
- Everything unrecognised is free text for FTS. `bolt a:dragon` searches the index for `bolt`
  alone and filters by the motif beside it.

**No `or`, no parentheses.** The backend filter cannot express them: every included tag becomes
its own `EXISTS` and they are ANDed, so boolean grouping would need new SQL in `filters.rs` *and*
a matching change in `index/facets.rs` — more work than the rest of this feature combined. A
reader who types `or` gets it as a word to search for.

**A keyword with nothing after it is neither a term nor free text.** `o:` is a keystroke on the
way to a tag, and every one of them passes through that state. As a term it would sit there
reporting `""` as an unknown tag through the whole of the next word; as free text it would search
the corpus for `o`. `tagQuery.ts`'s scanner answers `"partial"` for it and the query is whatever
the rest of the box says.

## Resolution: exact, through `slug_norm`

`filters::picked_tags` matches `slug` byte for byte and case-sensitively, and its doc says why —
a slug arrives there from the tag search's own results rather than from a keyboard. Typed syntax
breaks that assumption, and there were two ways to mend it:

1. teach the filter SQL to normalise, or
2. normalise at the edge and go on handing the filter real slugs.

**This is the second**, `tags::query::run_tag_resolve` (command `tag_resolve`). Three things
follow, and they are why it was the cheaper of the two:

- `slug` keeps one meaning throughout the crate.
- `index/facets.rs` goes on narrowing by exactly the list the search does, with no second copy
  of a normalisation to drift from it.
- The caller learns **which** name was unknown — which SQL that quietly matched nothing could
  never tell it, and which is the whole of the UI below.

Matching is on `slug_norm`, the column the ingest wrote with `tags::normalize`. That is Scryfall's
own rule: `otag:"spot removal"`, `otag:spot-removal`, `otag:spotremoval` and `otag:SPOT-REMOVAL`
all return exactly **4,907** cards, while `otag:remov` 404s and `otag:*spot*` answers nothing —
`*` is stripped as punctuation rather than expanded, which is the decisive measurement.

### Why not substring, when the Tags page is substring

`tags::query::run_tag_search` matches a substring and ranks the exact hit first, deliberately: the
Tags page is a type-ahead, and a reader who types `dog` and is told "no such tag" until they spell
`dogs-of-war` is not using a search box.

A **filter** cannot borrow that. A substring resolves one typed name to many tags, which would
have to be ORed — while every tag filter in this app intersects, so `a:dragon` would silently also
answer `dragonborn`. The box offers the near misses instead, from the command that is built to
find them.

### A muted tag still resolves

`muted_tags` is absent from `run_tag_resolve`'s statement, and it is the one read in
`tags/query.rs` that leaves it out. Muting hides a *tag* — from the search box, the rail and a
parent's `childCount` — and is documented never to hide a *card*; nothing in `crate::filters`
consults that table. A reader who spells a tag out in the query box has named it rather than
browsed onto it, and refusing them the cards would be muting doing the one thing it is documented
never to do.

### A blank needle is `None`, never a query

`o:` on its own, `o:"---"`, and every keystroke on the way to a real tag normalise to `""`. Bound
into the statement that is `slug_norm = ''`, which is **not** "no rows": schema v20 added the
column with `DEFAULT ''` and v22's `backfill_oracle_slug_norm` is what repairs it, so a database
between those two rungs has a whole taxonomy sitting at `''` and a half-typed keyword would
resolve onto an arbitrary one of them. See [issue #180](https://github.com/Msgaihede/mtg-grimoire/issues/180) —
that column has been wrong before, and the guard is why it cannot be wrong in this direction.

### The cap

`MAX_LOOKUPS = 64`. `picked_tags` deliberately has none and argues why: a chip arrives one press
at a time from a rail, so that list cannot grow by accident. This one is built from a string a
reader can **paste**, so the assumption that paragraph rests on does not hold. Asks past the cap
are answered `None` rather than dropped, so the answer still lines up index-for-index with them
and the box reports those names as unknown instead of silently applying nothing.

## The two ways this fails, and both fail closed

Everywhere else in this file's neighbourhood the rule is to fail **open** — an unrecognised weight
floor is no floor, an absent facet count leaves a chip live. `useCardSearch`'s `tagQueryBlocked` is
the exception, and both of its arms are deliberate:

- **Pending.** A search fired before its names have resolved goes out with **no tag filter at
  all** and caches the whole corpus under the key that afterwards means "filtered" — the wall
  wrong, served instantly from cache, with nothing on screen to notice. The query is `enabled:
  false` until the resolve settles.
- **Unknown.** A name that resolves to nothing empties the wall. Answering it as though the term
  were not there would show the unfiltered corpus in reply to a narrowing the reader asked for,
  which is the one direction a search must never fail in.

`rows` and `total` are emptied **in the hook** rather than at each of the three call sites, because
`placeholderData: keepPreviousData` is doing its job: a wall left to itself goes on showing the
*previous* search's cards, which reads as "these are your results".

## What the reader sees

`TagQueryRow`, drawn under the filter row and **only when there is something to say** — a
permanent strip would spend the deck panel's scarcest axis on a feature most searches never use.

- **Chips**, through the Tags page's own `TagChips`, so a tag picked two ways looks the same
  both times. Labelled `Tags from the search box` rather than `Picked tags`, because the Tags
  page draws both rows at once and two groups sharing a name are two controls a screen reader
  cannot tell apart.
- The ✕ and the include/exclude press **rewrite the box**. The text stays the one source of truth
  for the query; a chip driven from a hidden list beside it would be a second thing to disagree
  with what the reader can see. Both flush the debounce, because a press is already the reader's
  final answer.
- Chips are deduplicated by tag, so `a:dog a:dog` is one chip — and the ✕ then removes **both**
  terms, because a chip that vanished and left the wall still narrowed would be worse than no chip
  at all.
- **No weight floor control.** The syntax has no keyword for one — Scryfall has none to borrow —
  and a control here the query language cannot express would be a setting the reader could not
  write down.
- **An unknown name is named**, with the closest tags from `tag_search` offered beside it.
  Pressing one rewrites that term and keeps the keyword the reader typed, so `o:remov` becomes
  `o:removal` rather than `oracletag:removal`. This is the part Scryfall has nothing to teach us:
  it 404s and says no more, and a reader who mistypes `o:remov` and is shown a silent empty wall
  concludes their collection has no removal in it.

## Where it lives

| file | what it owns |
| --- | --- |
| `src/features/search/tagQuery.ts` | The grammar. Parse, the source spans, and the three rewrites (`removeToken`, `setTokenNegated`, `setTokenValue`) |
| `src-tauri/src/tags/query.rs` | `run_tag_resolve` / `tag_resolve` — names to slugs, exact, through `slug_norm` |
| `src/features/tags/tagFilters.ts` | `mergeTagTerms` — the caller's chips ANDed with the typed ones |
| `src/features/search/useCardSearch.ts` | The wiring: parse, resolve, merge, gate, and the two chip rewrites |
| `src/features/search/TagQueryRow.tsx` | The chip row and the unknown-tag note |

The merge is a union rather than one side winning: a Tags page reader who has chipped `dog` and
then types `o:ramp` is asking for a dog that ramps. Each list is deduplicated and sorted, which
changes no answer (`picked_tags` sorts and dedups anyway) and is what keeps chipping `dog` *and*
typing `a:dog` one **query key** rather than two.

## Driven in the shipped window

`npm run tauri dev` from the `tag-search` worktree, **debug build**, 2026-08-22, window
1920×1080, first-run sync: **116,700 cards**, **4,525 oracle tags** / 230,243 taggings, **11,530
art tags**. Both surfaces were driven — the search page and the deck editor's docked panel — and
they answered identically, which is the claim "one wiring reaches both" made good.

| what was typed | what the window did |
| --- | --- |
| `o:ramp` | one chip (`ORACLE ramp`), wall narrows to **2,149 cards** |
| `bolt a:dragon -o:removal` | two chips, one of them `not removal`; wall answers **1 card / 3 printings** |
| ✕ on the `dragon` chip | box becomes `bolt -o:removal`, wall widens to **6 cards** |
| `o:remov` | wall reads *No cards match these filters*, note reads **No oracle tag called "remov". Did you mean removal · removal-creature · removal-burn** |
| pressing `removal` | box becomes **`o:removal`** — the reader's `o:` kept, not normalised to `oracletag:` — note gone, chip in its place |

`tag_resolve` over the real oracle taxonomy: **4 ms for six lookups**, debug build. All three
spellings of `spot removal` (`spot removal`, `spot-removal`, `SPOTREMOVAL`) folded onto
`spot-removal`; `remov` and `""` both answered `null`. That is Scryfall's measured behaviour
reproduced against a local 4,525-tag file.

**One thing found and deliberately not fixed here.** Dragged to its floor
(`MIN_PANEL_WIDTH_PX`, 206), the deck editor's docked panel overflows its own content box —
`scrollWidth` **258** against `clientWidth` **205**. It is **not this feature's**: the same
measurement with the tag row absent reads 258 as well, and the two culprits are the search
`<input>` (`min-w-56`, a hard 224px floor a flex item cannot shrink below) and the `Color
identity` group, `flex gap-1.5` with **no `flex-wrap`** — six 36px chips plus five 6px gaps =
**246**. That is exactly the failure `src/CLAUDE.md` warns about under "a row of fixed-width
controls is sized by the narrowest surface that draws it", live on `main`. The tag chip row
itself wraps and fits: 193px wide over two lines at that width, **0px overhang**, and at the
panel's normal 384 it is 290px wide with `scrollWidth === clientWidth`.
