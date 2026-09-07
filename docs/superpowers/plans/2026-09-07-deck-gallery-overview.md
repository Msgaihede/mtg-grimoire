# Deck gallery overview — issue #387

The gallery tells a reader four things about a deck (art, name, format, size) and one thing about
its illustrator. This adds what a reader actually browses by — **what colours it is**, **what
bracket it is**, and **a way to order and narrow the wall** — and takes the illustrator line off
the tile.

Issue: https://github.com/Msgaihede/mtg-grimoire/issues/387

## The five changes

1. **The `Art by` line leaves the deck tile and the folder card.** It becomes a tooltip on the
   picture instead. See _The artist credit_ below — this is a policy question and the answer is
   not "delete it".
2. **A colour bar under the art**, on every deck, drawn from the **printed mana costs** of the
   cards in it.
3. **The Commander bracket in the tile's caption** — the reader's own answer if they gave one,
   the estimate otherwise, in the editor's exact vocabulary (`Bracket 3` / `Bracket ~3`).
4. **A filter row**: a name box, format chips, an `Archived` chip that replaces the disclosure's
   own button, a `Sort decks` picker and a direction toggle.
5. **The sort is remembered across restarts**, in `app_meta`, the way the list layouts are.

## The artist credit — what the policy actually says

`docs/reference/frontend-design.md:198` is where four surfaces send a reader for this rule. It
quotes the guideline as binding — **right** — and derives from it that _a cover whose artist is
unknown is not drawn at all_ — **also right, and unchanged by any of this**. What it got wrong
was the guideline itself: it paraphrased **one arm of a two-armed rule** and dropped the other,
which is how a design decision came to read as a fixed requirement.

**Corrected in the same pass** (this paragraph was itself wrong on first writing and is left
corrected rather than deleted): that line never named a URL at all — it pointed at
`docs/superpowers/plans/2026-08-04-02-images-card-browsing.md:55`, which has quoted **both** arms
since the beginning. Nothing in `src/` cited `docs/api/images` for an artist rule either — before
this change, **no file in the repo named a URL for it at all**, which was checked by sweeping for
the string. So the `docs/api/images` misattribution was a live-fetch finding about where the rule
is *not*, worth recording because it is the obvious page to go looking on and it is the wrong
one; the repo's actual defect was the lossy paraphrase, one page downstream of a correct
quotation.

**One thing shipped carrying the mistaken version of this**: `DeckTile.tsx`'s `Cover` doc says
*"two doc comments in this file used to cite it as `docs/api/images`"*. They did not — the
pre-change file named no URL. The sentence around it (where the rule really is, and that the Card
Imagery page carries no artist rule) is correct and is the part worth keeping; only that clause
about the file's own history is wrong.

Fetched live 2026-09-07:

- `https://scryfall.com/docs/api/images` — the Card Imagery page — carries **no** artist rule at
  all. The word "artist" does not appear on it. It is now a table of image variants and their
  statuses; the `art_crop` row reads `A rectangular crop of the card's art only. Replaces
  art_crop` (the variant this app stores is `art`, 626 × 457, WEBP).
- The rule is on **`https://scryfall.com/docs/api`**, under _"When using images from Scryfall,
  you must adhere to the following guidelines"_, and reads, verbatim:

  > When using the art_crop, list the artist name and copyright elsewhere in the same interface
  > presenting the art crop, or use the full card image elsewhere in the same interface.
  >
  > Users should be able to identify the artist and source of the image somehow.

- Wizards' Fan Content Policy (`https://company.wizards.com/en/legal/fancontentpolicy`) requires
  **no** artist credit. What it requires is the disclaimer notice, and that Wizards' own logos and
  trademarks inside artwork are not removed.

So the guideline is real, current, and a **must** — but it is satisfied two ways, and neither of
them is "a permanent line under every tile". The gallery draws `art` crops and shows no full card
image, so it has to take the first arm: **the artist name has to be reachable in the gallery.**

**The tooltip is that.** The name moves onto the picture it belongs to, where a reader who wants
to know who painted it looks, and `Users should be able to identify the artist … somehow` is met
more directly than by a line under a different element. The tile loses a row of chrome, which is
what the issue asked for.

What does **not** change: `DeckCoverPicker`'s `CoverPreview` keeps its visible credit (it is one
large crop with nothing else on screen), and `coverUrl`'s refusal to draw a cover whose artist is
unknown stays — the artist is still shown, so the condition still means what it said.

**What shipped, beyond what this section asked for.** `FolderCard`'s strip got a tooltip **per
crop** rather than one on the card: its old line comma-joined up to three artists with no way to
tell which crop belonged to whom, and that file's own comment had rejected the alternative for
exactly that reason — so the per-crop form is the arrangement that objection was really asking
for, and is strictly better than what it replaced. The correction itself has landed in
`docs/reference/frontend-design.md` (the verbatim quotation, the neighbouring guidelines, the
enforcement sentence and the Wizards finding), in `src/CLAUDE.md`, and in
`src/features/decks/CLAUDE.md` — where the deck editor's own uncredited tiles turned out to have
a **better** justification than the one recorded: `CardStack` and `views/GridView` draw
`DECK_CARD_VARIANT`, which is `display`, a whole printed card. That is the rule's *second* arm,
satisfied outright. The bullet claiming all four of those surfaces drew a bare crop had gone
stale when those two changed.

## What has to exist that does not

Three new reads. `deck_list` answers no colour and nothing to estimate a bracket from, and the
only card-shaped read is `deck_get`, which is the heaviest read in the feature and is per deck.

### `deck_pip_costs` — the colour bar's facts

```
DeckPipCosts { deckId: number; costs: { cost: string; copies: number }[] }
ipc.deckPipCosts(): DeckPipCosts[]
```

Every deck at once. Per deck, the **printed mana costs** of its live cards in active
`main|commander|maybe` categories — the same pile `DeckRow.cardCount` counts — folded by cost
string with the copies summed, and costs that are null or empty dropped (a land contributes no
pip and there is no reason to ship one row per basic).

Rust supplies the cost strings; **TypeScript counts the pips**, through `mana.ts`'s existing
`{…}` tokeniser. Measured on the dev database (4 decks, 611 `deck_cards` rows): **90 rows** for
the whole gallery.

### `deck_bracket_reads` — the estimate's facts

```
BracketCardRow  { name: string; gameChanger: boolean; oracleText: string | null;
                  faces: string | null; categoryActive: boolean }
DeckBracketRead { deckId: number; cards: BracketCardRow[]; combos: DeckCombo[] }
ipc.deckBracketReads(deckIds: number[]): DeckBracketRead[]
```

`estimateBracket` reads exactly five card fields and takes the combos as an argument, so this is
the whole of its input and nothing else needs to cross. **The caller passes the deck ids**, so
which decks have a command zone stays a TypeScript decision (`useFormatSpecs`' `commanderRule`)
rather than a SQL one.

The pile is `variant = 'live'` and `cat.is_active = 1`, in every category kind — which is what
`DeckBracket` hands the estimator today, filtered the same way, and the same ids it hands
`combos_for_cards`. `categoryActive` is therefore always `true` on these rows; it is carried
because the estimator's filter reads it and a row that omitted it would be a different type.

**One caveat, and it is worth a sentence in the docs**: the editor estimates over the variant the
reader is standing on, so a deck left on **Theory** reads its plan there and its live list here.
The tile is a fact about the deck; the editor is a fact about what is on screen.

Measured on the dev database: 397 distinct cards across 4 decks, **59 KB** of oracle text.

### `deck_sort` / `set_deck_sort` — the remembered order

One `app_meta` row holding `"<key>:<direction>"`, e.g. `"updated:desc"`. Follow
`src-tauri/src/listview.rs` whole: a tiny module, an infallible read that answers the default for
a missing or unparseable row, and a write whose only failure is the `BUSY` every write can
answer.

**Corrected by what shipped, and the difference is where "unparseable" is decided.**
`src-tauri/src/decksort.rs` checks **nothing but emptiness**. `listview.rs` can check its word
against `LAYOUTS` because a wall is drawn one of two ways and Rust knows both; here the
vocabulary is `deckSort.ts`'s — three of the six keys are computed on the TypeScript side and
have no SQL counterpart at all — so a key this build does not recognise is **stored and answered
verbatim**, and `parseDeckSort` is what degrades it to the default. A database outlives the app,
and a word refused at the *write* end would be a reader whose sort silently would not save on a
build that had every reason to think it had. The read still falls back on a missing, unreadable
or **blank** row and is infallible by signature; the write has **two** failures rather than one —
`BUSY`, and a refusal of the blank, which is `listview::store`'s own blank-section rule (a blank
would look saved and read back as nothing forever).

**Only the sort is remembered.** A filter is a thing a reader is doing right now; a
gallery that opened already narrowed, with no memory of having asked for it, is a gallery that
looks like it has lost decks.

## The sort keys

| key | order | ties |
| --- | --- | --- |
| `updated` | `updatedAt`, newest first — **today's order, and the default** | `id` desc |
| `name` | the app collator (`compareLabels`) | `id` |
| `colors` | mono W→U→B→R→G, then multicolour by count then by WUBRG mask, then colourless, then **no pips at all** | name |
| `bracket` | the effective bracket — set if set, estimate otherwise; **decks with neither last** | name |
| `cards` | `cardCount` | name |
| `format` | `formatName ?? formatKey`, collated | name |

Each key has its own natural direction (`updated` and `cards` descend, the rest ascend) and the
toggle reverses whatever that is — the half-turned arrow `FilterBar.tsx:975` already draws, never
a swapped glyph. **Every comparator is total and stable**: a deck whose pips or bracket have not
arrived yet sorts last rather than throwing, and two decks the sort cannot separate keep the
order `deck_list` returned them in.

**Three corrections the implementation made to this table, each of which a test forced.**

1. **`colors` has _three_ ranks and not two.** The row above reads "then colourless" and stops. A
   deck with real `{C}` pips is a deck with something to say — it draws a bar — so it sorts after
   every coloured deck and **before** the third group: a deck with no pips at all, which is an
   all-lands pile, a deck of nothing but generic costs, and a read still in flight, three states
   that are indistinguishable from the comparator.
2. **The comparators are written in their own natural direction**, and `sortDecks` negates only
   when `sort.desc !== NATURAL_DESC[key]`. Writing them all ascending and negating on `desc`
   turns the *tiebreak* round with the primary term: `cards` reads biggest-first by default, so
   its name tiebreak would have run Z→A. A test caught exactly that.
3. **"Unknowns last" holds in the key's natural direction, not in both** — which is where this
   differs from `sorting.ts`' `nullsLast`. That helper pins nulls at the foot whichever way it
   runs, and it *can*, because the card sorts have no direction toggle. This one does, and a block
   of tiles that visibly refused to move through a reversal reads as a toggle that did not take.
   So the rule holds where it is claimed — last the moment the reader picks the key — and
   reversing puts them first, on purpose.

## Counting a pip

`countPips(cost)` in `src/lib/mana.ts`, over the one `SYMBOL` tokeniser that is already there.

- A coloured symbol is one pip of its colour: `{W}` → W.
- **A hybrid is one pip of each half**: `{W/U}` → W and U. It is a cost the reader may pay either
  way, and the bar answers "what does this deck want", not "what will be spent".
- A twobrid is its colour: `{2/W}` → W. Phyrexian likewise: `{W/P}` → W, `{W/U/P}` → W and U.
- `{C}` is a pip and gets its own segment. **Generic is not** — `{2}`, `{X}`, `{S}`, `{T}` and
  everything else contribute nothing, which is the issue's own instruction ("ignore general mana
  cost").
- A split or double-faced cost is one string (`"{1}{R} // {1}{U}"`) and every symbol in it counts.

Each cost is weighted by the copies in the deck.

## The bar

Under the art, above the name. Segments in `MANA_KEYS` order (WUBRG then colourless), each as
wide as its share, filled from `--color-pie-*` — the deeps `DeckStats`' identity pips already
use, never a new colour. A colour with no pips draws no segment. **A deck with no pips at all
draws no bar**, rather than an empty rule: an all-lands pile has nothing to say and a 1px grey
line saying it is worse than silence.

`role="img"`, and the accessible name is the colours present in printed order and nothing else —
`White, Green`. The counts go in the tooltip, where a reader who wants them can ask.

## Buckets

Files are owned. Nothing outside your list.

| # | Owns | Delivers |
| --- | --- | --- |
| 1 | `src-tauri/**` | the three commands, their routes, their tests |
| 2 | `src/lib/{ipc,mana,store}.ts` + tests, `.storybook/fake/**` | the mirror, `countPips`, the fake |
| 3 | `src/features/decks/{deckPips,deckSort,deckFilter,useDeckPips,useDeckBrackets}.ts`, `validation/{types,bracket}.ts` + tests | the domain logic |
| 4 | `src/features/decks/{DeckTile,FolderCard,DeckColorBar}.tsx` + the bar's test and story | the tile |
| 5 | `src/features/decks/DecksPage.{tsx,test.tsx,stories.tsx}` | the filter row |
| 6 | `docs/**`, `src/CLAUDE.md`, `src/features/decks/CLAUDE.md` | the record |

## What shipped beyond this plan

Written after the fact, so this page is an account of what was built rather than of what was
proposed. The corrections above are inline; these are additions, and each one is somewhere in the
reference docs in full — [decks-storage.md](../../reference/decks-storage.md) for the reads,
[commander-brackets.md](../../reference/commander-brackets.md) for the estimate,
[frontend-design.md](../../reference/frontend-design.md) for the drawing, and
`src/features/decks/CLAUDE.md` for the rules an implementer will trip over.

- **`BracketCardFacts`.** `estimateBracket` now takes
  `readonly Pick<CardFacts, "categoryActive" | "name" | "gameChanger" | "oracleText" | "faces">[]`
  — the five fields it actually reads. This is the narrowing `CardFacts` itself was refused, and
  it earned its way in because a *second* surface now asks the question with five fields instead
  of forty. A `DeckCard[]` still assigns, so the editor's call site is untouched.
- **`deck_bracket_reads` has two contracts this plan did not name**, and both are about a caller
  holding a list: **one entry per requested id, in request order**, so a deck deleted since the
  list was taken answers empty rather than shifting the answer; and **a deck with more than
  `combos::MAX_CARD_IDS` distinct printings fails the whole call** with `combos::TOO_MANY_CARDS`,
  which is `match_combos`' refusal propagated rather than caught — a truncated id list would
  answer a *wrong* combo set, and `estimateBracket` does not re-check the combos it is handed.
  An empty request touches no database at all, and the hook is `enabled` only on a non-empty
  list, so a gallery with no Commander deck on it costs no IPC call.
- **A deck with no pips is _absent_ from `deck_pip_costs`' answer, not present and empty**, which
  is what a `GROUP BY` gives — and so a deck missing from `useDeckPips`' map is also a deck the
  read has not reached, one in flight and one that failed. All four states draw no bar and sort
  last, so nothing is lost by not distinguishing them.
- **The bar's geometry**: 5px tall at 100%, 4px above, both `calc(… * var(--mark-scale, 1))` like
  the tile's other four sizes. 4px is lost against the crop's rounded edge and 6px starts
  competing with the deck's name; the 4px above is half the 8px below, so the bar reads as
  belonging to the picture. Fills are `--color-pie-*`, the deeps `DeckStats`' identity pips
  already use, written as a `Record` of `var(…)` and never an interpolated Tailwind class — an
  interpolated class name emits no rule at all and the bar would draw six transparent segments
  with nothing going red.
- **The filter row's controls are named against collisions this app already has.**
  `Filter decks by name` and never a bare `Filter` (the editor owns *Filter this deck*);
  `Sort decks` and never `Sort` (the editor's toolbar owns one); `FILTER_FIELD` and never
  `FILTER_CONTROL` on the box, because the chips' 3% press dip breaks `<input type="search">`'s
  native clear button (issue #179). The `Archived` chip carries `aria-expanded` rather than
  `aria-pressed` — it *reveals* rather than narrows — and is gated on whether the drawer holds
  filed decks at all, so it cannot vanish out from under a reader narrowing the wall.
- **`deckFilter` pins its locale.** `"I".toLocaleLowerCase()` is `"ı"` under `tr`, so *Izzet
  Storm* would stop answering to `izzet` on a Turkish desktop, silently and only there.
- **All four commands are routed on the web build, the write included** — a read-only sort there
  would be the setting not existing rather than being read-only.
- **`ipc.test.ts`'s argument-name pin caught a real defect**, which is the cross-boundary fence
  earning its keep: the Rust parameter is `sort`, not `value`, and `invoke` fills parameters by
  name — so the wrong spelling would have been a runtime rejection with both builds green.
- **Two test traps worth expecting again.** jsdom never fires `unhandledrejection`, so a dropped
  `.catch()` on a fire-and-forget IPC write is invisible to vitest and the test passes against
  the defect (the fix is a mock returning a thenable with a spied `catch`). And a fold test that
  puts every case in **one row** cannot see per-row accumulation — `deckPips`' "folds several
  costs" stayed green when the accumulator was replaced by a fresh record per row, because the
  mutation only bites across rows.
- **Not yet done**: nothing in this feature has been driven in the shipped window. The wrapping
  filter row at the app's 1024px floor and the bar at both ends of the zoom ladder are what a
  live pass owes.
