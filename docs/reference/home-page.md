# The home page

The app's landing view, [issue #448](https://github.com/Msgaihede/mtg-grimoire/issues/448). The
design is
[2026-09-10-home-page-design.md](../superpowers/specs/2026-09-10-home-page-design.md); this page
is the record of what shipped, with the reason at each site. Every figure keeps the date and the
build it was taken on, and every count below names the command that answers it.

> **Redesigned on 2026-09-15 onto a square-cell grid** — the Claude Design canvas
> `Widget Home.dc.html`. Widgets are placed at `x, y` with a `w × h` footprint, dragged anywhere
> in Customize, resized from a corner, configured in a per-card settings popover, removed only after
> a question on the card, and added from a **Widget catalogue** of live previews. Three kinds
> joined — **Recently viewed**, **Set completion**, **Price movers** — and each needed a fact the
> app did not store: `app_meta.recent_cards`, `sets.printed_size` (corpus schema 4) and the
> `price_snapshots` table (user schema 45). §1, §3, §4 and §6 describe the grid; §11 is the record
> of the redesign itself. The design's `Sync` widget was sketched and deliberately not built.

The short version of the original page: **`ViewId` gains one member, `app_meta` gains two keys,
the schema gains one table, and nothing else about the app changes.** The home page is a document the reader owns and
six widgets that read commands the rest of the app already had, plus one it did not — a global
activity feed. The single load-bearing rule is that the *vocabulary* of widgets lives in
TypeScript and only the *shape* of the document lives in Rust, which is what lets two builds of a
portable app share one database without either quietly emptying the other's page.

---

## 1. The layout document

One `app_meta` row, `home_layout`, per device. `app_meta` has been the application's key/value
table since user schema v6, so **there is no migration** — this is a key in it, and
`src-tauri/src/home.rs` is the module that owns the key.

```ts
interface HomeWidget { id: string; kind: string; x: number; y: number; w: number; h: number; span?: number; config: unknown }
interface HomeLayout { version: 2; widgets: HomeWidget[] }
```

`home.rs` refuses, in this order and **all of it before `app_meta` is touched**: a `version` that
is not `2`; an `id` or a `kind` that is blank after `trim`; a `w` outside `1..=MAX_W` (24) or an
`h` outside `1..=MAX_H` (40); an `x` past `MAX_X` (1 000) or a `y` past `MAX_Y` (10 000); a `span`
that is present and outside `1..=2`; and a serialized document over `MAX_BYTES`, 64 KiB. **Rust
knows nothing about how many columns a window has** — `layout.ts`'s `normalise` is what brings a
stored document inside the grid it is drawn on, and it does so on every draw **without writing the
result back**, so narrowing the window never rewrites the reader's arrangement until they change
something.

**Version 1 still reads.** A version-1 row carries `span` and no geometry; Rust answers `0` for
the four cells, and `parseLayout` reads `w === 0` as *never placed* and lays each widget out at its
kind's default footprint (a `span: 2` widget the whole of the narrowest grid) in the reader's own
order. Placed widgets claim their cells before any unplaced one is flowed in.

**`span` is still written, on every version-2 document, for an *older* build.** That build's
`home.rs` requires the field, so a document without it would read as the default layout there and
the reader's next Customize in the old build would overwrite this build's page. With it, the old
build draws the widgets in its row and refuses to save a version it does not write — the round
trip this document has always promised. `toStored` in `layout.ts` derives it (`w > 4` is the whole
row) on every write. On the read side there is nothing to
refuse: a missing row, a row that is not JSON, a row holding an array or a bare string, a document
whose `widgets` is a number — every one reads as the default layout, and `stored` is **infallible
by signature** for `nav::nav_collapsed`'s reason.

64 KiB is not a limit the table needs. `app_meta` already carries `update_release_history` at
201 550 bytes (measured 2026-09-10 out of the live debug `user.db`, spec §1). The cap is about
what a *layout* can honestly be: anything over it is a `config` being used as a document store or
a bug minting widgets in a loop, and neither should be discovered as a database that will not fit
in memory.

### The vocabulary is TypeScript's, and the round trip is the feature

`kind` is a free `String` and `config` is an opaque `serde_json::Value`. Nothing in `home.rs`
compares a stored kind against anything — the eight spellings in its `DEFAULT_LAYOUT` table are the
*seed a first launch gets* and are used for nothing else. That is `markcolors.rs`'s split at its
widest, and its rule verbatim: **a write preserves entries this build does not understand.**

The promise is that **a widget kind a newer build wrote survives a round trip through an older
one**, and three files each keep a third of it. Break any one and the other two are decoration:

| Where | What it does | What it must not do |
| --- | --- | --- |
| `src-tauri/src/home.rs` | stores and returns `kind` and `config` untouched; validates shape only | grow an enum, an allow-list, or a `kind` check |
| `layout.ts`'s `parseLayout` | keeps an entry whose `kind` this build cannot draw, drops only an entry that is not a widget at all | filter on `isWidgetKind` |
| `HomePage.tsx`'s body switch `default` arm | draws the unknown-widget body — a sentence saying where the widget came from — inside the ordinary card, tray and all | throw, or return `null` |

`widgets.ts` says the same thing from the other side: **`isWidgetKind` is a renderer's question and
never a parser's.** The placeholder keeps its remove, size and grip on purpose — a widget this
build cannot draw is the one a reader is most likely to want to move or take off the page.

What follows from `config` being opaque is the rule for extending a widget: **a new per-widget
setting goes in `config`, never in a fifth field beside it.** `config` survives every build; a new
field on `HomeWidget` is dropped by every build that predates it.

Reading and writing answer the version question the **other way round**, deliberately.
`stored` hands back whatever parses, `version` included, because the widgets in a newer document
are exactly what an older build must not lose. `store` refuses a version it does not write, **in
words**, because rewriting a document by rules that do not apply to it is how a newer build's page
comes back wrong with nothing logged anywhere.

**The document is this device's.** `app_meta` is not in `schema::SYNCED_TABLES`, which is
`markcolors.rs`'s stated rule for every stored preference in this app: a home page is a fact about
the screen in front of the reader, not about the collection.

### The landing view is the second key

`src-tauri/src/startview.rs`, key `start_view`, is `nav.rs`'s module with a word instead of a bit
and the same two rules — reading can never fail, writing validates only what Rust can validate.
Rust stores a non-empty trimmed word and checks nothing else, because the vocabulary of *views* is
TypeScript's for `listview.rs`'s reason. `useStartView` (`src/lib/useStartView.ts`) checks the
stored word against `ViewId` and falls back to `"home"`, so a downgrade to a build without some
view does not strand a reader on a page that no longer exists. A Rust-side allow-list would have
made every new view a Rust change *and* refused the downgraded reader's row on read with nowhere
to say so.

## 2. An empty widget list is a layout, not a missing row

This is the read rule's one edge and the one a `unwrap_or_default` gets wrong. "No widgets" and
"no row" are the same value to a defaulting parse, so a reader who cleared their home page would
be handed the six defaults back on every launch, for ever, with nothing on screen to show they had
ever chosen. **Only an absent row and an unparseable one are the default**;
`{"version":1,"widgets":[]}` is an answer and is kept.

`home::tests::an_empty_widget_list_is_a_layout_and_not_a_missing_row` pins the Rust half and
`layout.test.ts`'s *"keeps an empty widget list rather than restoring the default"* pins the
webview's, because both sides have a fallback and either alone would undo the reader's choice.

## 3. The ten widgets

⚠️ **The catalogue and the default layout are two different lists, and the heading above counts
the first.** `WIDGET_META` is what the Add-widget catalogue offers; `DEFAULT_LAYOUT` is what a
first launch is handed. A kind may be in the catalogue and not in the layout, and three now are:
`wishlistValue`, which has never been on a first launch, and `newPrintings` and `stickyNotes`,
which landed within a day of each other and joined the catalogue alone because either one would
break the rectangle. So the sentence below still names **eight** widgets in an eight-by-seven
rectangle and is correct as written, and `DEFAULT_LAYOUT`'s three copies — `widgets.ts`,
`home.rs` and the Storybook fake — did not move. Counting the table above and editing that literal
to match is the mistake this note exists to stop.

The default layout fills an eight-by-seven rectangle exactly, so a first launch shows no hole:
`summary` 0,0 4×2 · `recentCards` 4,0 4×2 · `decks` 0,2 3×3 · `activity` 3,2 3×3 ·
`collectionValue` 6,2 2×3 · `folders` 0,5 4×2 · `priceMovers` 4,5 2×2 · `setCompletion` 6,5 2×2.
**A kind may appear more than once** — the `id` identifies a widget, so two `decks` widgets pinning
two sets of decks is a layout to build rather than a case to refuse, and `newWidgetId` mints an id
that does not collide.

**Every kind declares what a reader can change about it in `widgets.ts`**: a default, minimum and
maximum footprint, `picks` (one of several) and `toggles` (on/off, **storing nothing at their own default**, which
is on unless the row names `dflt: false`), and the
`chip` — which pick's label is drawn beside a wide card's title. The settings popover is built from
that row, so a kind grows a setting by adding a row rather than by the panel learning a special
case. Three settings belong to every kind and are not rows: the footprint (two size steppers), the
density, and the title (a rename in the card's own title field; a blank or the kind's own name
stores nothing). All of it lives in `config` — the extension rule below.

| `kind` | draws | `config` |
| --- | --- | --- |
| `summary` | Collection, Decks, Wishlist and Value figures; each a press that opens that view | `{ hide }` |
| `decks` | deck shortcuts — cover, format, card count, value | `{ scope: recent·pinned·archived, deckIds, art }` |
| `folders` | collection and wishlist folder shortcuts with counts and value | `{ cabinets: both·collection·wishlist, collectionFolderIds, wishlistFolderIds, captions }` |
| `collectionValue` | the collection's total and its split along one dimension, as bars or a list | `{ dimension, chart: bars·list, figures }` |
| `wishlistValue` | the same over the wishlist — a separate component, because the two lists' empty states and notes differ | `{ dimension, chart, figures }` |
| `activity` | recent actions grouped by local calendar day, each day headed by its `+7 / −6` roll-up | `{ limit: 25·50·100, times }` |
| `recentCards` | the cards this device opened last, as a strip of card faces that open the card | `{ count: 4·6·8, names }` |
| `setCompletion` | every set the reader holds a card from, and how much of it | `{ sort: complete·cards·name, bars }` |
| `priceMovers` | owned printings whose price moved most over a window | `{ window: 7d·30d·all, direction: both·up·down }` |
| `stickyNotes` | the reader's own notes, as a board of tinted tiles or a pad of stacked sheets | `{ layout: board·pad, dates, strip, pinned }` |
| `newPrintings` | reprints of cards the watched decks hold, in release-day groups | `{ scope: all·chosen, deckIds, window: 30·90·365, langs: en·all·chosen, langIds, virtual, theory, basics }` |

**A config written before the grid keeps its meaning.** `dimension` and `limit` kept their keys
rather than taking the design's `scope`, and a `decks` config holding pins but no `scope` reads as
`pinned` — defaulting it to `recent` would have dropped every reader's pinned set on upgrade. A
stored word no option carries reads as the pick's default, which is the vocabulary check
`widgetConfig` cannot make; `activity`'s old `200` therefore reads as `50`.

`DEFAULT_LAYOUT` exists in `home.rs` and in `widgets.ts`, **one fact in two places**, and the Rust
one is what a first launch actually gets: `home::stored` answers it for a missing row long before
the webview is loaded. The TypeScript copy is what `parseLayout` falls back to and what **Reset**
writes. `widgets.test.ts` pins its half against a literal and `home.rs`'s tests pin theirs against
the same JSON, so the two cannot drift silently.

Two smaller rulings, each written at its site so it is a decision rather than an oversight:

* **`FoldersWidget` offers the app's own folders and labels them.** A `deck`-kind folder is a
  deck's group and `removed` is the single `Recently removed` holding area; every folder *picker*
  in this app offers `user` and only `user`, because a picker chooses somewhere to write and those
  two refuse every write in words. A shortcut is not a destination, so both are worth pinning —
  but the tile says which it is in words as well as with a glyph.
* **Neither value widget uses `BarChart`.** Both draw with `Track` and `percent` from
  `features/decks/stats/StatsCard.tsx`, because `BarChart` prints an integer count on each bar and
  hardcodes its spoken noun to *"n cards"* — and these bars are money. Two agents reached that
  conclusion independently and landed on the same import, which is the outcome shared primitives
  exist to produce.

### The query keys sit under the roots the data already lives under

`src/features/home/keys.ts` is the whole list, and the rule is that a key sits under
`["collection"]`, `["wishlist"]` or `["decks"]` — the roots every write in this app already
invalidates. The dashboard therefore refreshes after an add, a move, a rename or a removal with
**no mutation anywhere learning a new key**, where a `["home", …]` root would have needed every one
of those writes to grow a line and a `staleTime` would have hidden whichever was forgotten.

**The exceptions are the keys whose table no other query in this app reads**, and there is no
number to write down here: `keys.ts`'s own doc comments are the list, and each one says at its
declaration why the rule had nothing to point at. `activityKey` is the interesting one and the
rest are not.

**`activityKey`**, under `["activity"]`, is a root nothing invalidates, because there is no
activity mutation: the feed is a record of every *other* table's writes. `ActivityWidget` bridges
it itself, and **both halves are load-bearing**: it subscribes to the query cache and turns an
`invalidate` action under any of the three write roots into an invalidation of its own key, *and*
it holds a marker query under each root so the signal exists at all — `invalidateQueries`
dispatches nothing when it matches no cached query.

**`recentCardsKey` and `stickyNotesKey` need none of that machinery**, and the difference is worth
having: every writer of either table is in one file, so the mutation that changes the data
invalidates the key beside it. `stickyNotesKey` is `["stickyNotes"]`, the exact value
`crossWindow.ts` maps `sticky_notes` to, so a note written in the other window lands here as
well — and filing it under `["collection"]` to obey the rule would have re-read every note after
each add to the binder while leaving it stale after the four presses that actually change one.

## 4. The grid is measured in JavaScript, and still not a container query

Square cells with a 12px gap: at least **eight columns**, one more for every ~116px of canvas past
that (`fit.ts`'s `columnsFor`, `TARGET_CELL` 104). The canvas is measured with a `ResizeObserver`
and every computed size is an inline style — a column template, a row height, a grid line — because
Tailwind scans source *text* and an interpolated class emits no rule at all. Resting, the grid is
as tall as the arrangement; in Customize it gains four spare rows (at least eight) so a widget has
somewhere to be dragged, with dashed guides down the middle of the gaps and a ghost rectangle that
turns destructive over an occupied cell.

**The design canvas drew its cells in `cqw` units off a `container-type: inline-size` canvas and a
`container-type: size` box per widget. The app does neither, and that refusal is the original
page's, kept.** Layout containment makes the box the containing block for every `fixed`
descendant — and these widgets open anchored popovers, context menus and, through them, dialogs
whose scrim is a bare `fixed inset-0` that corrects for nothing. The design reached for container
units because its runtime could not measure; this page can, so it measures. The precedent is
`src/features/decks/DeckStats.tsx`, which refuses a container over its own two columns in the same
words.

**What fits in a card is a question about pixels, decided by the body.** `makeFit` hands each body
its box and whole-row arithmetic (`fitCount` floors at zero, `linesFit` at one) and each body cuts
its list to whole rows — half a row drawn into a clipped card reads as a broken card. **The tier is
the one thing decided by cells**: two cells is a tile, three a panel, four or five a band, six or
more the whole row. It decides *which* content a card carries (a caption, the chip, a footer), and
content that changed as the window was dragged a few pixels would read as a card that could not
make up its mind. The body still scrolls, in the app's slim bar with the gold thumb, so an estimate
a few pixels out costs a scrollbar rather than a sentence.

**Two stacking rules keep the popovers visible, and nothing in jsdom can see either.** A card is
not `overflow-hidden` — the settings and remove popovers anchor inside its title row and open past
its edge, so clipping lives on the body scroller alone; and a grid box has **no z-index and no
transform at rest**, so a card's `LAYER.popup` panel paints over the cards after it. Only the box
being dragged is transformed and raised, and no popover is open while it is.

### Ctrl+scroll zooms it, and it is the app's only CSS `zoom` (2026-09-20, issue #480)

`home` is a `ZOOM_SECTIONS` entry like any other — same sixteen-stop ladder, same badge, same
`app_meta` row, same trailing 400ms write — and the **only** one that is not a multiplier on a
tile's width. It could not be. Every other section draws pictures, where `scaled(170, zoom)` *is*
the question; a widget is a box of type, and a bigger box at the same type size is not a zoomed
dashboard but the same dashboard showing **more** small rows. That is the reverse of the gesture: a
reader rolling the wheel forward is asking for less on screen, more legibly.

So the number is spent as a CSS `zoom` on the grid box. Chromium implements it as a **layout**
scale rather than a paint one — measured in a browser on 2026-09-20, a 900px canvas holding a
`zoom: 1.5` child lays that child out at **600** local px, paints it at **900**, and a 12px rule
inside it paints at **18px**. Cells, cards, titles, figures, rows and chips all move together, and
nothing in `fit.ts` had to learn the word.

**What the page owes it is one division and one multiplication.**

* The canvas is measured **outside** the zoom — the box carrying `HOME_CANVAS_ATTR` is never scaled
  — and `columnsFor`/`cellFor` are asked about `width / zoom`, the width the grid actually lays out
  in. **Fewer columns fall straight out of that**, which is the whole of "zooming takes tiles away".
  Measuring *inside* the zoom would have worked too (`clientWidth` on a zoomed box answers in local
  units — measured, 600 against a 900px parent), and is refused because it makes the arithmetic
  depend on a browser behaviour **no test in this repo can see**: jsdom parses `zoom` into the style
  object and lays nothing out with it. The division is the half that stays testable, and three
  mutations of it are caught by `HomePage.test.tsx`.
* A pointer event's `clientX` is in **viewport** pixels while `cell` and `GAP` are in the grid's own,
  so a drag divides its travel by `step * zoom` and the dragged box's `transform` divides by `zoom`.
  Without either, a widget dragged at 150% travels half again as many cells as the pointer did —
  out from under the hand holding it. This is the one thing here that fails *silently*, so it has a
  case of its own, a mutation behind it, and a live drag below.

**The stack is reachable from both directions, and that is the honest reading of `CELL_MIN`.** The
floor is not about painted pixels — a reader who zooms out has *asked* for small cells, and refusing
them would make the gesture's one direction do nothing. It is about whether the grid has room to be
a grid **in its own units**. The column count bottoms out at `GRID_MIN_COLUMNS`, so past that point
zooming in cannot take a column away and takes local pixels off every cell instead: eight columns of
a 900px window are 64px each at 150%, which is a widget body about ten characters wide however large
the characters are. One widget per row at full width, type at the size asked for, is the right answer
to that gesture. It runs the other way too — zooming *out* of a window narrow enough to stack at 100%
widens the local canvas past the floor and lays the grid back out.

**The gesture is caught on the whole page section, not on the canvas**, which is where this departs
from `DecksPage`. That page puts its listener on the scrolling tiles and deliberately not on the
view, because a ctrl+wheel over its folder tree is a gesture about navigation chrome. This page has
no such chrome — a header row of three buttons, and empty desk under the last widget — and a wheel
that misses the canvas does not do nothing: **it falls through to WebView2's own page zoom**, scaling
the sidebar, the ribbon and the title bar. Covering the section makes "ctrl+wheel on the dashboard"
one answer instead of two. (The same `preventDefault` is why this is `useCardZoomGesture` and not an
`onWheel` prop: React registers `wheel` passively, and a passive listener's `preventDefault` does
nothing at all.)

**Rust needed no change.** `zoom.rs` stores section name to multiplier and says outright that the
words are TypeScript's vocabulary; a new section is a new key in a row it already round-trips.

#### Driven in the shipped window, 2026-09-20 (dev build, 1920x1080, 1672px canvas)

| zoom | local canvas | painted canvas | columns | first widget, painted |
| --- | --- | --- | --- | --- |
| 0.5 | 3344 | 1672 | **28** | 234x114 |
| 1 | 1657 | 1657 | **14** | 465x226 |
| 1.5 | 1105 | 1657 | **9** | 726x354 |
| 2 | 829 | 1657 | **8** | 817x396 |

Five synthetic ctrl+wheel events on the section stepped 100% to 150% and every one came back
`defaultPrevented`. `devicePixelRatio` and `visualViewport.scale` both stayed **1** across the
ladder, which is the measurement that says the *app* did not zoom — the sidebar, the ribbon and the
title bar are the same size in the 100% and 150% screenshots. A real `Input.dispatchMouseEvent`
drag of **186px** at 150% — one painted cell, where a local cell is 124px — moved a widget exactly
**one** row. Undivided it would have moved two, which is the defect the multiplication above exists
to prevent.

**The trap, and it would read as a bug in this feature.** `getComputedStyle(el).fontSize` on
anything inside the zoom answers in **local** units — the Summary heading reports `15px` at every
stop — so a probe that measures type that way concludes the words did not scale. They did: the same
heading's `getBoundingClientRect().height` went **24 to 36** from 100% to 150%, exactly 1.5x.
Measure a painted rect, never a computed length.

**The two things that cross the zoom boundary were measured and both are correct.** A widget's
settings popover is `absolute` inside its own trigger, so it scales with the card and stays put: at
150% the panel's right edge landed on **896px** against a trigger right edge of **896px**. The
tooltip is the harder one — `TooltipPanel` is `fixed` at the *app root*, outside the zoom, reading a
zoomed anchor's `getBoundingClientRect()`. That rect is in painted viewport pixels, so it lines up
by construction, and it does: hovering the `$3,869.83` figure at 150% put the tip **0px** off the
anchor's horizontal centre with the standard **8px** gap. The tip itself stays at app scale, which
is right — a tooltip is chrome, not dashboard content.

**A widget shows the same content at a larger size, not more of it**, and that is the whole point:
`tier`, `listColumns` and `fitCount` are all decided in local units, which the zoom holds roughly
constant. Activity drew five rows and two at both stops. (`listColumns` is `round(widthPx / 240)`
and can still flip at its own boundary — the Decks widget went 1 column to 2 across 348 to 360 local
px — but that is the existing heuristic being knife-edged, which a 12px window drag does too.)

**The page does no layout arithmetic of its own beyond cells.** A drop is `moveWidget(x, y)` and a
corner release `resizeWidget(w, h)`, both refusing an occupied or out-of-grid rectangle by
answering the document unchanged; the grip's arrow keys are a one-cell move, the corner's a
one-cell resize, and the settings steppers the same resize with `aria-disabled` at a bound.
**While Customize is on the body is `inert`**, so a press on a deck tile picks the card up instead
of opening the deck — and a press on anything carrying `data-no-drag` (the title field, the tray,
the corner) is still a press. Below a readable cell (`CELL_MIN`, 68px) the page **stacks**: one
widget per row in reading order, full width, no grip and no corner, while the steppers still work.

## 5. The activity log

Schema **v44** (§9 is why it is not v43), one table and one index, in `main`:

```sql
CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('collection','wishlist')),
  kind TEXT NOT NULL CHECK (kind IN ('add','remove','quantity','move','edit','folder','import','clear')),
  card_id TEXT,
  card_name TEXT,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  delta INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_activity_recent ON activity (at DESC, id DESC);
```

**`deck_audit`'s design, copied deliberately.** Rust records *what happened* — a kind, a card, a
JSON payload of facts and a signed copy delta — and TypeScript writes the sentence, because a
sentence is domain logic: it changes with the wording and with the reader's language, and a table
that stored one would be a table full of the phrasing of whichever release wrote each row.
`src/features/home/activityText.ts` is the **only** reader of `payload`; `activity.rs` stores it
verbatim, hands it back byte for byte, and never parses, branches on or knows what a key in one
means. Rewording a line is therefore not a migration, and a second language stays possible.

`activity_recent(limit)` is one `SELECT` over a `UNION ALL` of `activity` and `deck_audit`, ordered
`at DESC, id DESC` and clamped to `1..=500`. Two things about it are written down at the site
because a later reader would otherwise "fix" them:

* **The `id`s collide across the two tables, and that is fine.** Nothing joins on them and the
  frontend keys a feed row on `scope` **plus** `id`, which is unique because the scope says which
  table the row came from. Offsetting, hashing or adding a synthetic key each makes the id stop
  being the row's own id, which is the only thing it is good for.
* **`id DESC` after `at DESC` is not decoration.** `unixepoch()` has one-second resolution and a
  single press can write two rows inside it; without the tiebreaker the order inside a second is
  whatever the planner felt like, which is the one ordering a reader would notice and could not
  explain.

The clamp's **low** end is the load-bearing one: SQLite reads a negative `LIMIT` as no limit at
all, so a `0` arriving from a page that had not finished loading its config would otherwise be a
full read of every change the reader has ever made.

Day grouping is `auditDays`, **reused and not re-derived** — days are *local* calendar days, and
slicing them off an ISO string files a change made at 23:30 under tomorrow, which this repo has
already got wrong once. A `scope === "deck"` entry delegates to `auditLine`, so a deck line reads
identically here and in the deck history dialog.

### The three rules, because each is a way to get this wrong

* **A change that already writes a `deck_audit` row writes no `activity` row.** One event, one
  line — which is what keeps `collection_alloc`'s deck-boundary writes out of the feed twice. The
  table's own `CHECK (scope IN ('collection','wishlist'))` makes it unbreakable: there is no
  `'deck'` scope to write, because a deck line **is** a `deck_audit` row and `recent` reads it from
  there under a scope the query stamps.
* **A bulk operation records one row carrying its count in the payload.** An import of 5 000 cards
  must not write 5 000 lines — that is a feed nobody can read and a table that grows by a megabyte
  a session. `collection::commit_import`, `wishlist::commit_import`, both `missing to wishlist`
  paths and `reset::clear_collection`/`clear_wishlist` each record exactly one. The bulk pair is a
  **quiet door and a recording door** over one write: `wishlist::add_wish_silent` performs the
  change and `wishlist::record_wishes_added` writes the single line for the run, and a run of
  nothing records nothing.
* **It is pruned at launch.** `activity::prune` runs from `maintenance.rs` and keeps the newest
  `KEEP = 5 000` rows. `deck_audit` has never needed a pruner because a deck a person has actually
  built is hundreds of rows; a collection log is not bounded that way. The `NOT IN` in the pruner
  is safe *here* — `activity.id` is `INTEGER PRIMARY KEY`, so it is the rowid and never NULL — and
  the site says so, because `NOT IN` over a set containing NULL is true for nothing and is a real
  footgun elsewhere in this crate.

`record` takes `&Connection` and **never opens a transaction of its own**, so every caller records
inside the transaction of the change it describes; `Transaction` derefs to `Connection`, so
`record(&tx, …)` is the call at every site. An activity row that committed while its change rolled
back is a history that lies in the one direction a reader cannot check — the row it names is not
there to disagree with it. `collection::tests::a_rolled_back_change_leaves_no_activity_row` and
`wishlist::tests::a_rolled_back_wish_leaves_no_activity_row` are the fences.

### The write-site census

**A missed write site is a silent gap in the feed, not a red build**, so the census is a
deliverable rather than a hope. Every statement in the crate that writes `collection_entries`,
`wishlist_entries`, `collection_folders` or `wishlist_folders` is accounted for as exactly one of
three things.

Counted 2026-09-10 on the merged tree at `64d9d709`: **61 production statements across 34
functions in 10 files** (`python` sweep over `src-tauri/src/**.rs`, matching
`(INSERT [OR …] INTO|REPLACE INTO|UPDATE [OR …]|DELETE FROM)\s+<table>` and excluding every
`#[cfg(test)] mod` and every `tests.rs`). **22 record, 6 are already logged, 33 are a
consequence** — with `add_entry_filed` counted under *records* and appearing in the table under
both, because one statement genuinely has two doors and the class is a property of the press, not
of the SQL.

⚠️ **The sweep as the plan wrote it reported 57, and the four it missed are why the pattern above
carries the `OR` arms.** `grep "UPDATE collection_entries"` does not match `UPDATE OR IGNORE
collection_entries`, which is `collection::PATCH_SQL` — the statement behind `update_entry`, a
recording site — and `reconcile::merge`'s two repoints. The feed was not wrong; the *count* was,
and a grep that cannot see a conflict clause is a census that silently under-reports.

| File · statement site | stmts | class | note |
| --- | --- | --- | --- |
| `collection.rs` · `add_entry_filed` | 1 | records **and** already logged | one write, two doors: `add_entry` records `collection/add`; `deck_quick_add::quick_add` reaches past it and writes `deck_audit` instead |
| `collection.rs` · `set_entry` | 1 | a consequence | `commit_import`'s per-line write; the file records one row |
| `collection.rs` · `set_quantity` | 2 | records | `quantity`, or `remove` when the step lands on zero and the row goes |
| `collection.rs` · `PATCH_SQL` (`update_entry`, both paths) | 1 | records | `edit`, through `record_edit`; `delta` is `0` even when the patch names a quantity — an edit form is not a stepper |
| `collection.rs` · `delete_entry` | 1 | a consequence | `remove_entry` without the feed row; the import's zero arm reaches it so a file does not write a line per zeroed row |
| `collection.rs` · `fold_entry` | 2 | a consequence | the grain collapsing two rows into one; all three callers record their own event |
| `collection_folders.rs` · `create_folder` / `rename_folder` / `delete_folder` | 3 | records | one `collection/folder` line each, through `record_folder` |
| `collection_folders.rs` · `set_folder_locked` | 1 | a consequence | a lock changes what the app offers from a drawer, not what drawers exist or what is in them |
| `collection_folders.rs` · `move_folder` | 1 | a consequence | re-parenting a drawer changes no card and no folder's existence |
| `collection_folders.rs` · `reorder_folders` | 1 | a consequence | a line per folder moved would be the whole day's page |
| `collection_folders.rs` · `refile_entry` | 1 | a consequence | the shared move; `set_entry_folder` is the recording door and writes `collection/move` |
| `collection_folders.rs` · `take_copies` | 2 | already logged | both callers are deck-boundary writes that record a `deck_audit` row for the same press |
| `deck.rs` · `create_deck_group` | 1 | a consequence | a deck's group folder follows the deck existing |
| `deck.rs` · `update_deck` | 2 | a consequence | the group wears the deck's name, and going Virtual takes it away |
| `deck_missing.rs` · `take_lone_wish` | 2 | already logged | filling a deck's hole from the wishlist is a deck press |
| `deck_quick_add.rs` · `take_wish` | 2 | already logged | as above |
| `reconcile.rs` · `merge` | 2 | a consequence | Scryfall's migration log applied against the reader's rows — derived from the corpus, and the whole pass runs under `capture::Suppressed` |
| `reconcile.rs` · `fold_wish_into_existing` | 2 | a consequence | the wishlist half of the same pass |
| `reset.rs` · `clear_collection` | 4 | records | **one** `collection/clear` for the wipe, and it does not clear the feed: history outlives the rows |
| `reset.rs` · `clear_wishlist` | 2 | records | one `wishlist/clear`, same rule |
| `schema.rs` · `migrate_single_file` | 6 | a consequence | a migration; nobody pressed anything |
| `schema.rs` · `migrate_user` | 7 | a consequence | as above, including v29's `sync_uid` backfills |
| `wishlist.rs` · `insert_wish` | 1 | records | `add_wish` records `wishlist/add`; `add_wish_silent` and `commit_import` reach the same write and record once for the run |
| `wishlist.rs` · `write_wish_quantity` | 1 | records | through `set_wish_quantity` — `quantity`, or `remove` at zero, because `quantity > 0` is a table CHECK |
| `wishlist.rs` · `delete_wish` | 1 | records | through `remove_wish` |
| `wishlist.rs` · `set_printing_inner` | 3 | records | `set_wish_printing` is the wrapper and where the `edit` line is written |
| `wishlist_folders.rs` · `create_folder` / `rename_folder` / `delete_folder` | 3 | records | one `wishlist/folder` line each |
| `wishlist_folders.rs` · `move_folder` | 1 | a consequence | the collection's rule, mirrored |
| `wishlist_folders.rs` · `reorder_folders` | 1 | a consequence | as above |
| `wishlist_folders.rs` · `refile_wish` | 3 | a consequence | `set_wish_folder` is the recording door and writes `wishlist/move` |

The payload shapes are the contract between each recording site and `activityText.ts`, and nothing
in Rust is a party to them: `add` carries `{ folder, finish }`, `quantity` carries `{ from, to }`,
`move` carries `{ from, to }`, `edit` carries `{ fields }`, `folder` carries
`{ action, name, from }`, `import` carries `{ cards, rows }` and `clear` carries `{ cards }`.
`delta` is signed copies and is `0` wherever the change is not about copies.

### It is not synced, and that is an asymmetry rather than an oversight

`activity` is **not** in `schema::SYNCED_TABLES` and carries no `sync_uid`. `deck_audit` **is** —
so in a paired group the deck lines in the feed arrive from every device and the collection lines
are this one's. Teaching the sync capture layer a new table means a `sync_uid`, a capture trigger
and a place in [sync.md](sync.md) §7.3's five rules, and an append-only log is the shape those
rules have the least to say about. Recorded as a known consequence and a follow-up.

The rung's own DDL carries that sentence as a comment, so the next reader of `schema.rs` meets the
decision at the table rather than in this file.

**Since user schema v46 the asymmetry sits inside one page, which makes it sharper rather than
softer.** `sticky_notes` — the other user-authored table this page now reads — **is** synced, and
the argument that put it there is the argument that keeps `activity` out: a sticky note is
*typing*, and prose a reader wrote on the desktop that never reaches the laptop is lost work,
where the feed is a machine-written record of presses that each already sync on their own. So one
dashboard now shows a paired reader every note from every device and only this device's collection
lines, and the reason is what the two tables hold rather than any difference in effort. What that
costs is only that the follow-up above can no longer be read as "the sync layer has not learned a
new table lately" — it has, and this one was not it.

## 6. The commands, on both targets

Each goes **in the module its data lives in, with the gate on the wrapper** — `search.rs` is the
pattern — and **each is routed on the web target as well**, because every one is a synchronous,
connection-only query, which is exactly what `web::route` answers.

| Command | Module | Answers |
| --- | --- | --- |
| `home_layout` / `set_home_layout` | `home.rs` | the layout document |
| `start_view` / `set_start_view` | `startview.rs` | the landing view |
| `wishlist_summary` | `wishlist.rs` | `{ wishes, copies, cost, unpriced }` |
| `collection_breakdown` | `collection.rs` | `[{ key, name, cards, value }]` |
| `wishlist_breakdown` | `wishlist.rs` | the same shape |
| `deck_values` | `deck.rs` | `[{ deckId, value, unpriced }]` — every deck, one query |
| `activity_recent` | `activity.rs` | the union feed |
| `recent_cards` / `record_recent_card` | `recent_cards.rs` | the cards this device opened, newest first (added with the grid, §11) |
| `set_completion` | `set_completion.rs` | `[{ setCode, name, releasedAt, owned, size }]` (§11) |
| `price_movers` | `price_history.rs` | `{ movers, since, days }` (§11) |
| `price_history` | `price_history.rs` | `{ points, now, today }` — one copy's kept snapshots, for the mover popup (§11) |
| `sticky_notes` and its four writes | `sticky_notes.rs` | every note by `sort_order`, then create, update, delete and reorder (§12) |

Registration is three places, and a command missing from one of them answers `unknown command` at
runtime with nothing red: `lib.rs`'s module map, `desktop.rs`'s `generate_handler!` list, and
`web::route`'s `COMMANDS` **plus** a `match` arm.

**The notes module is the first entry in this table that writes**, and the three things it does
*not* write are each a decision rather than an omission. There is no `touch_deck`, no
`deck_audit::record` and no `deck_undo::record_step`, because a sticky note belongs to no deck
and none of those tables has a row shape for one. **And no `activity` row either** — not a
judgement call: `activity.scope` is `CHECK (scope IN ('collection','wishlist'))`, so there is no
word to write, and widening a `CHECK` is a table rebuild. The feed is about the collection; a
sticky note is not in it.

Four rules the money commands keep, each of which exists because breaking it produces a number
that is wrong and looks right:

* **`wishlist_summary` is `wishlist_folders`' `folder_summary` SQL with the `GROUP BY` and the
  `WHERE w.folder_id IS NOT NULL` removed** — the second is what keeps root-level wishes out of a
  folder tile, and a list total that inherited it would be wrong by exactly the root. One
  expression, not two: a folder's subtotal and the page header's total have to be one piece of
  arithmetic.
* **Both breakdowns group over `sorting::price_expr`**, the same fragment `collection_summary`
  uses, so a breakdown can never disagree with the total printed above it. `cards.price_usd` and
  `price_eur` are a display fallback chain and are never summed.
* **`color_identity` is a string of letters and not a JSON array.** `card_row.rs` writes `["W","U"]`
  as `"WU"` and `filters.rs` reads it with `instr`, so the colour bucket is a `length()`: one
  letter keys on that colour, more than one keys `multi`, empty keys `c`. A `json_array_length`
  there answers NULL on every row, files the whole collection into one bucket — **and the sums
  still add up**, which is exactly why it is written down rather than left to be rediscovered.
* **`deck_values` filters to the same cards `cardCount` counts** (`variant = 'live'`, active
  categories, `kind IN ('main','commander','maybe')`) so a deck's count and its value describe the
  same pile, and a deck with nothing priced answers `null` rather than `0` — a tile has no room for
  the header's "n unpriced" note, so a deck of cards the feed has never heard of would otherwise
  read as a deck worth nothing.

## 7. The chord renumbering

`NAV` gains `{ id: "home", label: "Home", Icon: House }` **as its first entry**, and `CHORD_NAV` is
built exactly as before — `NAV` minus `shared` — so inserting at the head shifts every digit:

| chord | before | after |
| --- | --- | --- |
| `Ctrl+1` | Search | **Home** |
| `Ctrl+2` | Tagger | Search |
| `Ctrl+3` | Decks | Tagger |
| `Ctrl+4` | Collection | Decks |
| `Ctrl+5` | Wishlist | Collection |
| `Ctrl+6` | Scanner | Wishlist |
| `Ctrl+7` | Trade | Scanner |
| `Ctrl+8` | Playtesting | Trade |
| `Ctrl+9` | **Settings** | Playtesting |
| — | Shared | Shared, **Settings** |

**Two destinations now go without a chord, for two different reasons**, and reading them as one
rule is how a later edit puts the wrong one back:

* **`shared` goes without because its row is conditional.** It appears only once a reader has
  opened a link, and a digit bound to a row that appears and disappears would mean two things to
  two readers. That is a reason no amount of room would change — a twelfth digit would not buy this
  entry a chord.
* **`settings` goes without because the run ends before it.** Eleven rows against nine digits, and
  Home belongs at the top: it is the page the app opens on, and a reader reads a column downward,
  so a landing page anywhere but the first row is a page the reader is standing on and cannot find.
  Settings is the row that costs least — it is drawn on every screen at a fixed place, where
  `shared` can be absent altogether. **Give this run a tenth digit and Settings takes it back.**

`Ctrl+9` no longer opens Settings. That is a deliberate, breaking change to a binding readers have
in their fingers, and it belongs in the release note as one. `nav.test.ts` pins the ninth entry and
the absence of `settings` from the run, so a merge cannot quietly put the old numbering back.
[keyboard-shortcuts.md](keyboard-shortcuts.md) carries the record of both renumberings.

## 8. What this does not do

From the design's §9, plus two the build itself turned up:

* ~~**No free-form placement.**~~ **Built, on 2026-09-15** — the grid of §4. It was refused here
  because the only way the original design saw to draw one was a container query, which would have
  reparented every popover; measuring the canvas in JavaScript is what made it possible without one.
* **No cross-device activity for the collection.** §5.
* **No deck-folder shortcuts.** There is no `deck_folder_summary` command and deck folders carry no
  counts; the `decks` widget pins decks, which is what the issue asks for.
* **`StatsCard` has not moved to `src/components/`.** The widgets import `StatsCard`, `Track` and
  `percent` from `src/features/decks/stats/StatsCard.tsx`. A cross-feature import is idiomatic here
  — `CollectionPage.tsx` already imports three things from `features/decks` — and it was the
  cheaper half of a trade: the honest home for these primitives is `src/components/`, and moving
  the file while four other branches were editing the deck stats band would have been a
  delete-plus-add conflict against live work. **Still a follow-up, recorded so it stays a decision.**
* **The deck cover rule is a third copy and stays one.** `hasCover(deck)` is
  `deck.coverCardId !== null && deck.coverArtist !== null`; `DeckTile.tsx` already carries a note
  asking for a shared home, and the `decks` widget makes it three. Two lines and a comment rather
  than a figure, so the cost is style drift and not a number that can disagree with itself.
* ~~**A folder shortcut opens the view, not the folder.**~~ **Built.** This was written while it
  was still true and is kept because the *reason* it was hard is worth having: which drawer a
  reader is standing in is `useCollection`'s and `useWishlist`'s own `useState`, deliberately, so
  that a folder restored at launch cannot open the app somewhere nobody navigated to — which means
  the fix could not be "persist the open folder". It is a **one-shot hand-off** instead:
  `AppState.pendingFolder` (`{ scope, id }`), written by `FoldersWidget`'s one `openFolder`, and
  consumed *and cleared* by whichever page answers it.

  Two things about it are load-bearing. It sits **inside `setActiveView`'s clear block**, so a
  hand-off lives for exactly one view change — outside it, an unread one outlives every navigation
  and fires the next time the reader happens to open that page, opening a drawer they asked for an
  afternoon ago. The price of that is an ordering trap paid at the single call site:
  **`setActiveView` first, `setPendingFolder` second.** The inverse type-checks, reads correctly,
  and leaves the store holding nothing — the reader lands on the right page, at the root, silently.
  `store.test.ts` pins both directions, because only one of them is distinguishable from a bug.

  And the page reads it in a **render-phase adjustment rather than a mount effect** — `setFolderId`
  inside a `useEffect` body is the cascading-renders lint failure this repo has paid for twice,
  which passes `tsc` and vitest and dies only at `verify`. It also means each page reads the field
  as it *renders*, so the widget's two store writes are safe whether React batches them into one
  commit or two.
* **Whether a CSS `zoom` traps a `fixed` descendant in general is still open.** The two elements
  that actually cross the boundary on this page were measured at 150% and both are correct (§4),
  but neither is a `fixed inset-0` scrim *inside* the zoom, and that case was not reachable: the
  browser used for the 2026-09-20 property probe reported a 0×0 viewport, so a `fixed` rect came
  back all zeros. ⚠️ **This said nothing on the dashboard was on that path, and one widget is now**:
  `StickyNotesWidget` mounts `StickyNoteDialog` inside the zoomed grid, so it is the widget that has
  to be checked in a real window. The tooltip panel is `fixed` at the app root outside the zoom,
  `AnchoredPopup` says in its own doc that it is anchored and not portalled, and the Price movers
  popup (§11) is mounted at `App` level precisely so it stays off this path.
* **Six refusal sentences are unreachable from Storybook**, and this is a gap in the workbench
  rather than in the feature — each is covered by its widget's own unit test. Measured while
  writing the stories: `.storybook/fake/db.ts`'s `gone` fault is checked in exactly one place
  (`deck_get`), which the home page never calls, so a `gone` world renders byte-for-byte as
  `starter`; and `refuseIfBusy` is wired into every **write** handler and no read, which
  `activity_recent`'s own doc says outright. So every one of the six widgets' *"could not be read"*
  branches has no world that produces it. A `readGone`-style fault landing on `collection_summary`,
  both breakdowns, `wishlist_summary`, `deck_values` and `activity_recent` would make all six
  storyable at a line apiece. **What `busy` does reach is the one refusal this page can show** —
  a refused `set_home_layout`, which `WhileTheDatabaseIsBusy` presses Remove under, asserting the
  widget still leaves the page and nothing is said: the optimistic, deliberately-unrolled-back
  write `useHomeLayout` documents.
* ~~**`sticky_note_reorder` is built and reaches no press.**~~ **Wired the same day**, and the
  entry is kept because the reason it was ever true is the useful part. The command shipped end to
  end — the function and its tests in `sticky_notes.rs`, the registration in `lib.rs`,
  `desktop.rs` and `web/route.rs`, the handler in the Storybook fake, `ipc.stickyNoteReorder` and
  `reorder` on `useStickyNotes`' API — with **nothing in the UI calling it**, because the
  affordance it was written for belonged to a third layout: an *Index* list with drag handles,
  drawn against the design canvas and then rejected. Board and Pad both shipped without a drag and
  the command outlived the layout that would have pressed it. `stickyNoteDrag.ts` is the press it
  was missing — a pointer drag onto another tile, and **Ctrl/⌘ with an arrow** for a reader
  without one, since `dndManager` ships no `KeyboardSensor` and a drag-only reorder would have
  been half an interaction. **The lesson is the ordering, not the outcome**: plumbing built for a
  design that is then cut is not dead code and is not a mistake, but it is unreachable until
  something presses it, and a grep for its callers is the only thing that says which of the two it
  currently is.

## 9. The live pass

Driven over CDP in the shipped window on **2026-09-10**, debug build, against a **copy of the real
debug database** (277 collection entries, 89 wishes, 5 decks) rather than a fresh sync — a fresh one
gives cards and an empty collection, so every widget would have drawn its empty state and the pass
would have proved nothing. Viewport 1920×1080 unless a line says otherwise.

**The v44 migration ran on a real database, which no fixture can prove.** The copied file arrived at
v43 and came back `user_version = 44` with `activity`, `deck_notes` and `deck_note_cards` all
present and the 277 entries and 5 decks intact.

**Two invariants the design rests on, confirmed on screen rather than in a test:**

| | |
| --- | --- |
| The breakdown agrees with the total | Summary read `$3,869.83 / 340 cards`; the collection value widget read `$3,869.83 / 340 cards`. Two commands, one `price_expr`. |
| The feed's union works | `activity` held **0** rows, and the widget still drew *"Changed Valakut Awakening // Valakut Stoneforge from 2 to 1 in Drawpower"* — a `deck_audit` row, worded by the deck history's own sentence builder. |

`Test Deck · Commander · 0 cards · —` drew the em dash for a deck the marketplace priced nothing in,
which is the `null`-is-not-zero rule reaching the screen.

**The popover.** Opened the `Collection value by` picker: panel at `1405,372`, 71×112, wholly inside
the viewport, **and the hit test at its centre returns the panel's own `LI[option]`** — a rect
inside the viewport proves nothing on its own. Rows came back `Color, Finish, Rarity, Set`, which is
`sortOptions` in effect. This is the check the flex-wrap grid exists to pass; a container query here
would have reparented that panel to the widget box.

> ⚠️ **A first attempt at this read the wrong thing, and the failure is worth keeping.** The hit at
> the panel's centre came back as a large `DIV` the panel did not contain, which looks exactly like
> a clipped or reparented popover. Reading the whole stack rather than the top element found a
> `fixed inset-0` element at `z=50` over everything: **`SyncProgress`'s first-run gate**, because
> that first launch had no corpus. Nothing about the popover was wrong. `elementsFromPoint` — the
> plural — is what tells "my thing is broken" from "something else is in front of it".

**Phone width.** At **390 px** (`PHONE_PX`, so the rail is replaced by the bottom tab bar): widgets
stack one per row at `x=20`, span-1 cards 352 px against `main`'s 375 px content box, and
`main.scrollWidth === main.clientWidth === 375` — **no horizontal scroll**, in edit mode as well as
at rest, with all six drag grips drawn and inside the box. The 352 px `min-w-[22rem]` clears 375 px
by 23 px, which is the whole of the margin this layout has at the fold.

> ⚠️ **A first attempt measured at 400 px and read as a bug.** The rail was still drawn and `main`
> was 192 px, so the 352 px cards overflowed it — but `PHONE_PX` is **390**, so 400 is *above* the
> fold and the rail was correct to stay. The lesson is the ordinary one: a layout finding at a width
> nobody ships is not a finding. The app's own `DESKTOP_FLOOR_PX` is 1024, so the band between them
> is not a window a reader can make.

**The launch flash — measured, fixed, and the fix backed out.** Sampled per `requestAnimationFrame`
across a reload with `start_view` set to `search`: the ribbon read **Home at 224 ms** and **Search at
317 ms**. So a reader who moved off the default watches ~**93 ms** of a page they did not choose,
every launch. §4 of `src/lib/useStartView.ts` carries the whole reasoning; the short version is that
gating the view area on that read trades a bounded flicker for an unbounded blank — `lib/query.ts`
sets `retry: 1`, and a view that is waiting looks exactly like a view that is broken. Nine
`App.test.tsx` cases went red the moment the gate landed, each one a read that had not settled in
time, which is the failure arriving as a warning rather than as a bug report. **The swap stays.**

## 10. The schema rung collision, and what it cost

This branch and `deck_notes` ([issue #447](https://github.com/Msgaihede/mtg-grimoire/issues/447))
each wrote a **v43** on 2026-09-10. Main landed first, so `activity` renumbered to **v44** — the
ladder's ordinary rule, taken before the merge rather than after it, because fixture names collide
as well as rung numbers.

Three things happened in that merge and they are not the same shape:

* **`web::route`'s command count went red, and both sides were right.** The notebook branch routed
  eight commands and this one routed nine, each writing its own number against a shared **149** —
  **both correct on their own branch and wrong in the merge.** The merged answer is **166**,
  `awk`'d off the merged array literal rather than added: the arithmetic happens to agree this
  time and would not have if either branch had also *removed* a route. That test's own comment now
  carries the sixth iteration of the same instruction, which is why it is repeated here.
* **Several tests assert *head* rather than their own rung**, so they went red on a renumbering that
  did not change anything they were about. That is the cheap failure — it is loud, and the fix is
  mechanical.
* **`decks.notes` was removed by main**, silently breaking every fixture on this branch that set
  it. Nothing went red until `tsc`, because a fixture that sets a field the type no longer has is a
  type error and not a runtime one — which is the good outcome, and the one that would not have
  happened had the field been typed loosely.

The counts this branch moved, and the command that answers each, so the next reader re-derives
rather than trusts (a rule the grid redesign below followed for its own two rungs): `USER_SCHEMA_VERSION` is `grep USER_SCHEMA_VERSION src-tauri/src/schema.rs`;
the user-table count is the `Side::User` entries in `schema::TABLES`; the routed-command count is
`COMMANDS.len()` as the build computes it, which is why no document here writes it down twice.

## 11. The grid redesign (2026-09-15)

Imported from the Claude Design canvas `Widget Home.dc.html` (with its card component
`Widget.dc.html`). The canvas's script is the spec — `KINDS`, `body()` and `view()` — and three of
its workarounds were deliberately **not** copied, each because the runtime it was written for could
not do what the app can: `cqw`/`cqh` sizing off `container-type` boxes (§4), laying content out
against a 68px floor because it could not measure (the app measures), and `localStorage` for the
document (the app has `app_meta`).

**The page draws the chrome and a widget draws its body.** `WidgetCard` owns the title and its
rename field, the chip, the settings popover (`WidgetSettingsPanel`, built from the kind's registry
row), the remove question and the resize corner, identically for every kind; each of the ten
`widgets/*Widget.tsx` renders content only, from `WidgetParts.tsx`'s figures, bars and bordered
rows, and a body can be tested knowing nothing about Customize. `AnchoredPopup` grew one
backwards-compatible shape for it — children may be a function of `close` — so Keep, Remove and the
settings ✕ close through the same path as Escape. **The settings component is
`WidgetSettingsPanel.tsx` and not `WidgetSettings.tsx`**: on Windows `./WidgetSettings` resolved to
`widgetSettings.ts` (the registry reader) because `.ts` is tried before `.tsx`, and the panel
rendered as `undefined`.

**The catalogue's previews are the real card around the real body**, `still` — inert, clipped
rather than scrolling, writing and opening nothing — at the kind's default footprint, so the
catalogue cannot show a second idea of what a widget looks like.

### Recently viewed — `app_meta.recent_cards`

A JSON list of `{ cardId, at }`, newest first, deduplicated and capped at 24, **this device's** like
every other `app_meta` row. `CardDetailModal` records the card it opens, once per distinct card
(a ref that survives StrictMode's double mount), and ignores a refusal: a missed entry costs one
tile. The read joins `cards` in one statement through `json_each`, keeping list order and skipping
an id the corpus no longer holds without dropping it from the row. The clock is `unixepoch()`,
because `SystemTime::now()` panics on the web target. Tiles draw a whole card (`grid` variant) so
the printed artist credit is on screen — the design's `art` crop would have owed a credit line.

### Set completion — corpus schema 4, `sets.printed_size`

Scryfall's `/sets` publishes `printed_size` and the fetch used to drop it. The column is corpus
schema **4**, added only when `PRAGMA corpus.table_info(sets)` lacks it — the shape gate
`produced_mana` uses, for its reason — and `sync::sets_need_fetch` asks for `/sets` again on a
table that holds rows and not one size, so an existing database fills the column at its next sync
rather than at the next bulk rotation. **`owned` counts slots, not printings**: a collector number
counts by its leading digits when it starts with one (`123a` fills 123) and not at all when it does
not (`★12`), inside `1..=size`, so a set can never read more than complete; with no size known every
distinct number counts and the widget draws a count with no percentage. The browser build never
fills `sets`, so `size` is always `null` there.

### Price movers — user schema 45, `price_snapshots`

No price history existed: `cards` is dropped on every sync and `marketplace_prices` is replaced
wholesale. `price_snapshots (day, marketplace, card_id, finish, price)` records one owned printing's
price per marketplace per day, through `sorting::price_expr`, after every card ingest, after every
feed store, and once at launch — so the first launch after upgrading already holds a baseline. It
is **not synced**, for `activity`'s reason, and a soft reference to `cards.id` like every user table.

**It is thinned, not only pruned**, and the reason is a measurement: 1 000 printings × 2
marketplaces × 400 daily days is 800 000 rows and **114.7 MB** of `user.db`. Rows older than 35
days keep one per printing per 7-day bucket (**25.3 MB** at the same shape), and anything past 400
days goes. The 7-day and 30-day windows still read daily rows. Thinning runs only on a day's first
snapshot and only over rows that crossed the 35-day line since the previous one.

`price_movers` answers `since` — the baseline day actually compared against — and `days` — how many
days of snapshots the marketplace holds — **so the widget can say two different sentences**: *no
history yet* and *nothing moved*. `since` is taken before zero moves and the direction are filtered
out, because computed over the returned movers a quiet week would also answer `null` and read as a
database that had never remembered a price.

**A mover is a press, and it opens the Price history popup**
([issue #515](https://github.com/Msgaihede/mtg-grimoire/issues/515)). `price_history(card_id,
finish, marketplace)` answers every kept snapshot of that one copy **before today**, oldest first,
plus `now` — the live price the widget already calls `now` — and `today` as SQLite's own UTC
midnight, so the page reads no clock. The figures are TypeScript's
(`features/home/priceHistory/priceAnalytics.ts`), and **the change it draws for a range is the
widget's number to the cent**: the same baseline (the latest snapshot at least 7 or 30 days old,
the oldest one for `all`) and the same refusal to fall back to a younger one, so a row reading
`+$3.00` never opens a popup reading something else.

**The picture is the card modal's own `CardModalArt`, not a copy of it.** That column is
presentational — every fact a prop, every write a callback — so the popup mounts it with no deck
row and no meld, inside a `Dialog` with `container` and the modal's own art-column widths per
rung, and the frame, the chin, the flip and turn controls and the per-finish cells are one
component on two surfaces. **The picture is the same size as the modal's, and two things had to
give for that** — measured in the shipped window on 2026-09-24 (debug build, one card in both
dialogs): 258×361 at 1024×768, 276×387 at 1280×800 and 374×524 at 1920×1080, identical in each. The
popup gained the modal's 23.5rem art rung, keyed on its *own* panel (`@min-[960px]/card`, because
its widest panel is 62rem and a container query reads the 990px content box, so the modal's
`1200px` never fires); and it lost a header subtitle, which the fit-to-height sizer had been paying
for out of the card (264×370 against 276×387). The chart sits directly under *Now* and the change
for the same measured reason: listed last, it started below the column's fold at 1280×800. The footer carries the modal's two footnotes for the modal's reason:
the artist and the source have to be identifiable wherever the art is shown. The popup is mounted
at `App` level beside the card modal, never inside the widget: the grid spends the reader's zoom as
a CSS `zoom` on its box and `zoom` is inherited whatever a descendant's `position`, so a dialog
drawn in a row would be drawn at the dashboard's scale where a dialog is chrome — and whether a
`zoom` also traps a `fixed` scrim is still open (§8), which an `App`-level mount never has to
find out. A `still` body (the catalogue's previews) draws no press at all.

---

## 12. Sticky notes — user schema v46, `sticky_notes`

The eleventh kind and the first one that is nothing but the reader's own typing
([issue #479](https://github.com/Msgaihede/mtg-grimoire/issues/479), 2026-09-20). Its design is
[the spec](../superpowers/specs/2026-09-20-sticky-notes-widget-design.md); what follows is only
what a reader of *this* page needs.

`sticky_notes (id, title, body, color, pinned, sort_order, created_at, updated_at, sync_uid)`,
`user.db`, one unique index on the uid and no other. The body is CommonMark in the narrowed
dialect `noteMarkdown.ts` pins for deck notes — never HTML and never ProseMirror JSON, so Rust can
hand it to anything as text and no renderer has to live in the crate. **A title may be empty, and
the widget prints the body's first line in its place — computed at render and never stored**, for
`deck_notes`' reason: a stored derivation goes stale the moment the body is edited and no writer
could notice.

**It is the first table this page brought with it that syncs.** The other three the home page
introduced are all this device's — `app_meta`'s `home_layout` and `recent_cards` keys, `activity`
and `price_snapshots` — and §5's subsection above is where that difference is argued out. (Every
*other* table the page reads it reads through somebody else's command, and most of those sync
already.)

**`color` carries no CHECK, and that is a sync decision rather than laxity.** The page's own
enumerated columns each have one — `activity.kind`, `activity.scope`, `price_snapshots.finish` —
and neither of those tables syncs. ⚠️ **The rule is not that a synced column may not carry a
CHECK**: `collection_entries.condition`, `deck_cards.variant`, `collection_folders.kind` and five
more enumerated columns on synced tables do. It is that those
vocabularies are Magic's or this app's model, where a note's colour is **a palette the page owns
and expects to grow** — so a `CHECK (color IN (…))` here would make a build that adds a sixth
colour emit rows an older build refuses **at apply**, and a refused row is a failed apply rather
than a note that arrives looking wrong. Rust therefore stores the string it is handed and
`stickyNotes.ts`'s `noteColor` decides what it means, mapping a word it has never heard of to
`slate` — which is §3's existing rule for a stored value no option carries, one table over.

⚠️ **`sort_order` is monotonic and never dense, deliberately.** A delete leaves a hole and nothing
repairs it; `reorder_notes` renumbers from zero over the ids it is handed and **an id that is not
a note still consumes a position**, because `enumerate()` counts it — so a stranger in the middle
leaves the notes either side at 0 and 2. The column answers *before or after* and nothing more,
which is all the `SELECT` asks of it, and both `sticky_notes.rs` and the Storybook fake pin that
behaviour on purpose. A reader of the column who counts gaps is reading it wrong.

**Dim text on a note is `--color-note-dim` and never `text-dim`.** Measured against the L 26%
note fills the ordinary dim token lands at about 4.3:1, under the 4.5:1 floor for body text, so it
is a contrast bug no test in this repo catches. `text-dim` stays correct everywhere on the page
background.

---

## 13. The tenth kind — New printings (2026-09-20)

[Issue #462](https://github.com/Msgaihede/mtg-grimoire/issues/462), raised from the Luminia Discord
on 2026-09-14. Reverse-chronological reprints, grouped by release day, of cards the decks a reader
watches already hold; a row opens the printing, drawn large, beside the decks holding that card, and
a deck there opens the card in that deck. (The row opened a popover of the decks alone until
[issue #514](https://github.com/Msgaihede/mtg-grimoire/issues/514) — see the last subsection.) The
design is
[`2026-09-20-new-printings-widget-design.md`](../superpowers/specs/2026-09-20-new-printings-widget-design.md)
with five artboards beside it, and **three of its decisions were superseded on the way in** — each
is recorded below rather than left for a reader to discover by diffing.

### It reaches Rust's vocabulary not at all, and there is a test that says so

`home.rs` gained **nothing**. `kind` is a free `String` there and `config` an opaque `Value`, which
is §1's whole promise, and a kind this build *draws* has to be as invisible to that module as one
from the future. `home::tests::a_kind_this_build_can_draw_reaches_no_vocabulary_in_this_module`
round-trips a `newPrintings` widget whose config carries keys the module has no name for, and
`the_default_layout_holds_no_new_printings_widget` pins the other half — **`DEFAULT_LAYOUT` is
untouched on both sides**, because a tenth widget in the seed would rearrange the page of every
reader who never asked for one. It arrives from the catalogue.

**What the registry fence does and does not buy.** `WIDGET_META` being a `Record<WidgetKind, …>`
makes a missing meta row a compile error, and that is the whole of the compile-time help. It does
**not** catch a missing `case`: both of `HomePage.tsx`'s switches are over `widget.kind`, which is
`string`, and both have a `default` arm — so a forgotten arm renders `UnknownWidgetBody`, the *this
came from a newer build* placeholder, on a kind this build draws perfectly well, with nothing red
anywhere. `HomePage.test.tsx` asserts both arms by hand because the type system will not.

### Two statements over one `WHERE`, and what one statement would have cost

`src-tauri/src/new_printings.rs`, `list_printings`' shape: the page, then the decks holding the
cards on it. A single join to `deck_cards` multiplies a printing by the decks holding it, which is
how the issue's *each printing appears only once* gets quietly broken — and the count beside it
would be wrong in the same breath. Statement 2 groups on `(oracle_id, deck_id)` and **not** on the
variant, so a deck holding a card in both a live and a theory pile is one entry with the total; the
variant it reports is the lower of the two, `live` before `theory`, because a deck that has sleeved
the card up is holding it whatever else it plans.

No schema change: every column already existed. `cards` is named **unqualified** — the corpus is
`ATTACH`ed — where the design's SQL wrote `corpus.cards`.

**The basics filter is `type_line LIKE 'Basic %Land%'`, not the design's `'Basic Land%'`.** Measured
against the live 936 MB corpus on 2026-09-20: the narrow form matches 4 651 printings and the wide
one 4 721, and every one of the **70** in the difference is a snow basic (`Basic Snow Land —
Forest`). The narrow form leaks those through *hide basic lands*.

**`decks.archived` is deliberately not filtered.** `Ask` carries no flag for it, nothing in the
issue or the design mentions one, and an archived deck's cards therefore still feed the list. It
belongs on `Ask` the day somebody wants it; it is recorded here so the absence is a decision.

### Languages are a setting, not a constant — §2 superseded

`cards.id` is one printing **in one language**, so an unfiltered feed answers a ten-language set as
ten rows of one reprint. §2 proposed a hard `lang = 'en'`; what shipped is a `Languages` pick —
**English** (the default, `options[0]`, so a reader who changes nothing gets one row per reprint),
**Every language**, and **Chosen…** with a checklist built from `src/lib/languages.ts`'s nineteen
codes. That module gained `LANGUAGE_CODES` and `isKnownLanguage` and a fourth reader.

Three rules carry it:

* **One field on the wire.** `langs: string[]`, where **empty means every language** — TypeScript
  resolves the three modes into one list, because a mode *and* a list would be two fields that can
  disagree. Rust narrows again (two-to-four lowercase letters, capped at 24), and a list the
  narrowing empties is every language rather than a fallback to English, which would be the crate
  making a claim the caller did not.
* **`Chosen…` with nothing ticked reads as English and gets no sentence**, where `DecksWidget` says
  *no decks pinned yet* rather than falling back. An empty deck set is a real statement (*compare
  against nothing*); an empty language set would mean *show no printings at all*, which nobody
  means by unticking the last box.
* **A row carries its language code whenever the resolved set is not exactly English.** Without it
  *Every language* draws ten rows reading `Sol Ring · SLD · 3 decks` and the list looks broken
  rather than complete. The code is titled with `languageName`, so `PH` says *Phyrexian* as it does
  everywhere else (issue #161) — and the **picker's** rows are labelled with the language name and
  hinted with the code, not the reverse: `DropdownOption.label` *is* the accessible name, so a code
  there would announce `PH` and re-create exactly that issue. `PrintingsFilterBar` can do it the
  other way round only because its `CheckList` carries a separate `name`.

### `scope` has two options, not three — §3 superseded

§3 gave `scope` three options (`all`/`pinned`/`chosen`) and then described `Chosen…` as opening the
checklist *"the seam `Pinned` uses on the Decks widget"* — which is the defect: on `DecksWidget`,
`Pinned` **is** the checklist. There is no `decks.pinned` column; pinning in this app is a widget's
own `config.deckIds`. The only other reading — *the decks the Decks widget has pinned* — would make
one card's face depend on another card's config, and has no referent at all on a page holding two
`decks` widgets, which §3 above explicitly allows. So: `All decks` and `Chosen…`, `chosen` carries
the ids, and Rust reads any unknown word as `all`.

### An off-by-default switch — `WidgetToggle.dflt`

The issue requires virtual decks and basic lands **excluded** by default, and `toggleOn` was
`stored(widget)[key] !== false` — absent means on, deliberately. Spelling the keys negatively
(`hideBasics`) makes the panel read *Hide basic lands ☑*, a double negative at the one place the
design is being plain. So `WidgetToggle` gained `dflt?: boolean` and `toggleOn` a third parameter.

**No existing toggle moved**, and that is checkable rather than asserted: there is exactly one
reader and one writer, every shipped toggle omits `dflt`, and at `dflt = true` the old `v !== false`
and the new `typeof v === "boolean" ? v : true` agree on every input — a stored `true`, a stored
`false`, absent, and junk. The panel's writer is `next === dflt ? undefined : next`, which is
byte-identical to the old `on ? false : undefined` at that call site. `toggleOnOf(widget, key)` sits
beside `toggleOn` and looks the default up off the kind's row, `pickOf`'s shape for toggles, so a
body never restates a default the registry carries.

⚠️ **`widgets.test.ts`'s vocabulary snapshot had to widen with it**, and the obvious widening is
weaker than what it replaced: the projection recorded `toggles.map((t) => t.key)`, and moving to
`[t.key, t.dflt]` would put `undefined` values in an object that `toEqual` cannot tell from an
absent key — so deleting a toggle would have gone **green** where the array form went red. It
records `t.dflt ?? true`, the *effective* default, which is also what `toggleOnOf` answers.

### The row is 54px and its thumb is 33, not the artboards' 34

Row height is a 46px thumb, 3px of padding each side and the card's 1px border. **The artboards'
thumb is a hand-drawn `<span>` at 34 × 46, which is not 5:7 at all** — `CardArt` is `w-full` with
`aspectRatio: 5 / 7` (`CARD_ASPECT`), so 34px wide is 47.6px tall and the row would be 56. 33px is
46.2, and **54 is the number the design's whole size matrix was computed against**, so the pixel
went rather than the matrix. The 0.2px of drift per row is the case `fit.ts` already permits: an
estimate a few pixels out costs a scrollbar, not a sentence.

The row is drawn by the body rather than by `WidgetRow` — it needs a rarity gem *inside* a caption,
a bordered deck-count chip and a 5px unseen dot, and widening the shared row for one kind would put
three optional slots on the row every other widget draws. `WidgetParts.tsx`'s module doc permits
exactly this; the activity feed's day sections and the recent cards' strip are the precedents.

**§4's `· borderless` is not buildable and was replaced.** Borderless is a *frame effect*;
`NewPrinting` carries `promo_types`, a different column. The caption draws the printing's treatment
instead (*Serialized*, *Surge Foil*). **§7's `Choose decks…` press does not exist either** — the
settings popover is `WidgetCard`'s own state and a body cannot open it, so the sentence points at
the control in words, which is what `DecksWidget.NOTHING_PINNED` already does.

### The size matrix reproduces exactly; its row counts do not generalise

Every pixel and column of §8 was recomputed from `fit.ts` on 2026-09-20 and **all twelve rows
match** — `spanPx(n, 104) = 116n − 12`, `listColumns = max(1, round(widthPx / 240))`, and
`bodyHeightPx = heightPx − 52` at every `h ≥ 2` and comfortable density. `bodyHeightPx` at twelve
cells is **1 328**, which is the figure §8's own closing paragraph quotes.

**Its `Printings` column is fixture-bound and is asserted nowhere.** Those counts were taken over
the artboards' sample of 45 printings across 18 release days, and how many rows fit depends on how
the days clump: a day header costs 16px over a 6px gap with 8px between groups. Worked, a 2 × 2 is
`floor((168 − 22 + 6) / (54 + 6)) = 2` whatever the grouping, which is the one entry that
generalises and the one the suite pins. A 2 × 3 is 4 for a single group where §8 says 3 — the
difference is a second header, i.e. the fixture.

⚠️ **§8's footprint-scaled window default was cut, and it had already shipped as dead code.** The
design wanted `w * h >= 24` to open on *a year*, "a one-line default in the component". It is not
one: `widgets.ts` gives the `window` pick `dflt: 90`, `pickValue` falls back to that, so `pickOf`
always answers a number and the `defaultWindow` arm never ran. Making it run is easy — read the raw
config — but the title chip is `chipLabel(widget)`, which takes no `fit`, so a fresh 6 × 4 card
would have **read a year while its own chip said 90 days**. Threading `fit` through `chipLabel`
touches shared chrome all ten kinds draw, for one kind's nicety. Every card opens on 90 days and
the chip never lies; the reader changes it in one press.

### What height adds, and the cursor that makes the dots mean something

`h ≥ 5` adds a `Seen already` rule after the last group newer than the reader's last visit,
`h ≥ 6` month rules where the month turns, and `h ≥ 8` a closing line once the window is exhausted.
All three are budgeted **before** rows are laid in, so a card one pixel short of a rule drops a row
rather than clipping the rule; the body resolves them in two passes and the second list is a prefix
of the first, so nothing is ever drawn into unbudgeted space.

*Last visit* is **`app_meta.new_printings_seen`**, `recent_cards`' shape and its reason: `config`
round-trips through older builds, and a cursor an older build rewrites is a cursor that lies. The
clock is the **caller's** — `SystemTime::now()` panics on wasm.

⚠️ **The cursor is read once per mount and held**, which the design does not say and which is the
difference between a mark that works and one that does not: the widget writes the cursor when it
renders a non-empty list, so a body that re-read it would watch every gold dot vanish a frame after
it appeared. The write is fire-once per mount, never while `still`, and its failure is silent.

### Three empty sentences, and the count is read first

*No decks are being watched* / *nothing has been reprinted in this window* / *reading* / a refusal —
`PriceMovers`' device, because a count of zero printings cannot tell the first two apart, which is
why `decksWatched`, `since` and `oldest` travel beside the list. **The refusal is read before the
emptiness** (`ActivityWidget`'s rule: a failed read has no rows either, and calling that *nothing
has been reprinted* is a claim about a comparison nobody made), and **`decksWatched` is read before
the list**, because a reader watching nothing has an empty list for a reason that has nothing to do
with reprints.

### Both commands are routed on both targets

`new_printings` and `mark_new_printings_seen` are registered in `desktop.rs`'s `invoke_handler`
**and** named in `web/route.rs`'s `COMMANDS` with a match arm each — a command missing there is
dead on the web and Android builds, as `price_movers` and `set_completion` already are not.
`COMMANDS.len()` is **174**, counted off the merged array with that comment's own `awk` rather than
by adding two to 172.

`src/lib/ipc.test.ts` carries three mirror rows (`NewPrintingDeck`, `NewPrinting`, `NewPrintings` —
nested two deep, `PriceMovers`' reason: a field renamed inside the deck entry leaves both structs
above it agreeing while every deck row in the dialog reads `undefined`) and two `declares` cases. The fence was
checked rather than trusted: renaming `seen_at` to `seen_when` in the crate turns the `NewPrintings`
row red.

### Limitations worth writing down

**A row's thumb was blank on the web and Android targets, and for this kind that is closed**
(issue #514, 2026-09-24). `NewPrinting` carried no `imageUris`, so `cardArtSrc` — which on those
targets answers the *supplied* URL and ignores the `mtgimg://` one — had nothing to draw. It
carries `image_uri::front_face_map`'s answer now, and the thumb passes its `display` entry, because
`LIST_VARIANTS` is `display` and `art` and no `thumb` travels. **`recentCards` still has the gap**:
its `RecentCard` carries none, and its tiles are entirely card art, so closing it there is the same
field on that command.

**The Storybook corpus cannot exercise the language rule, and one story is deliberately absent.**
The fake's only two-language card is Lightning Bolt's Japanese `sta 105`, released 2021-04-23 —
outside the longest window the command answers (365 days from `CLOCK_BASE`, 2026-08-09) — so
`langs: []` and `langs: ["en"]` return identical rows and an `EveryLanguage` story could not fail.
The rule is proven in `.storybook/fake/db.test.ts` and in the widget's own suite instead. The fix is
a `scripts/gen-storybook-cards.mjs` selection change, deliberately not made mid-branch: that corpus
is generated wholesale and adding rows moves counts across `db.test.ts` and other files' plays.
The same corpus yields at most **two** rows — one at 90 days, two at 365 — which is why the story
set is `Default`, `Band`, `Tall`, `NoDecks`, `NothingReprinted` and `Chosen` rather than the
design's table — with `PrintingOpen` beside them since issue #514, the one story that presses a
row.

### A row opens the printing, drawn by the card modal (issue #514, 2026-09-24)

[Issue #514](https://github.com/Msgaihede/mtg-grimoire/issues/514), from the same Discord, asked for
a popup with a large preview of the card and the reader's decks that include it — and was filed as
a *possible regression of #462*, which had shipped a popup already. It had, and the report was fair
anyway: the row opened a 248px `AnchoredPopup` of decks alone, `absolute` inside the row, and the
row is inside the widget body's scroller (`overflow-x-hidden`, `overflow-y-auto`). A 2 × 2 tile is
**220px** wide at the grid's target cell (`spanPx(2, 104)`), so a 248px panel pinned by its right
edge (`align="end"`) reaches past the scroller's left edge, which clips it — read off the code and
the arithmetic, not driven, since the popover was gone by the live pass. §6 of the design (*"the
popover is the reason `WidgetCard` does not clip and this body must not either"*) was right about
the card and wrong about the body: the body **is** the scroller.

**It is a `components/Dialog` now** — `NewPrintingDialog.tsx`, mounted by the body on
`StickyNoteDialog`'s precedent — and it is drawn from the card modal's own parts, because the reader
asked for the preview to look like the card details popup and the way two surfaces stay alike is by
being one drawing: `CardModalTitle` (moved out of `CardDetailModal` for it — and, since the merge
with #515's price history dialog, which exported the same heading in place on the same day, the
one heading all three dialogs draw), `CardModalArt` whole —
the bordered frame, the chin, *View as foil*, one price cell per finish — the rail's left rule,
accented heading and `RAIL_ENTRY` rows for the decks, and the modal's footer row with its credit,
its `pricesAsOf` line and an `ACTION` button, *Open card details*. The card is read at
`cardDetailKey`, so that press paints the modal from the entry the dialog filled.

Driven in the shipped window (dev build, 1920×1080, the main checkout's data copied in):

| Case | Measured |
| --- | --- |
| A row pressed at 100% | panel **704 × 743** at `608,168`, footer row included; picture **298 × 417** (the `display` variant, `naturalWidth` 672); caret on the panel |
| Beside the card modal on the same printing | the left columns are one drawing — frame, chin `TRK · 278 · Star Trek`, *View as foil*, the two price cells, the title with its type line |
| *Open card details*, then Escape out of the modal | the caret lands on the **row**: the press hands it back to the row in the same handler that selects the card, and the modal remembers what held the caret when it mounted — the order of those two lines is not what does it, since React commits after the handler |
| A deck pressed | `activeView: decks`, the deck's id, the printing selected — the modal opens over the deck, which is #462's second half |
| 1024 × 700, the app's floor | panel 704 × 630 just under the title bar; the body scrolls **598 over 485** with the footer pinned; `scrollWidth` 1024 |
| 390 wide | full bleed, picture **338 × 473** over the decks and the footer, no horizontal scroll |
| The dashboard at **150%** | before `AppScale`, the panel drew **1056** wide — 1.5 × 704 — beside a card modal that never scales; after it, **704** and **298 × 417** again |

**Two traps, both found on this pass.** ⚠️ **The row carries `aria-haspopup="dialog"` and never
`aria-expanded`**: `WidgetCard`'s `LAYER.raisedWhenPopupOpen` lifts the card to `z-10` whenever
anything inside it says `aria-expanded="true"`, and a card with a z-index is a stacking context that
would cap this dialog's scrim at the card's layer. The suite pins the attribute's absence, because
jsdom has no opinion about a z-index. **And the grid's Ctrl+scroll `zoom` reaches a `fixed`
descendant**: §4 measured the two things that cross the zoom boundary and ruled that the tooltip
"stays at app scale, which is right — a tooltip is chrome", and a window-wide modal is chrome in the
same sense. `features/home/AppScale.tsx` is a `display: contents` wrapper carrying `zoom: 1 / home`;
`zoom` compounds by multiplication and is resolved through the element tree rather than the box
tree, so the wrapper cancels the grid's without taking a flex slot — checked in the window, since
jsdom lays out neither. **`StickyNoteDialog` has the same inheritance and was left alone** — it is
another kind's surface, and it was not driven on this pass — so by the same mechanism a note opened
at 150% should still be drawn at 150%. Wrapping its mount in `AppScale` is the whole of the fix.

**A review before the PR found three more, and the first had been shipping since #462.**
`new_printings::feed` attached the decks with `by_oracle.remove(&oracle_id)`, so the **first**
printing of a card on the page took them and every later one — a showcase variant, a second set, a
second language under *Every language* — read `decks: []`: a `0 decks` row, and now a dialog
opening on an empty *In 0 watched decks* under a card the reader's decks plainly hold. Neither
suite could see it: the fake reads `holders.get`, so every printing got its decks there, and no
Rust case put two printings of one card on the page and looked at the second's decks. It clones now,
and `two_reprints_of_one_card_both_carry_its_decks` fails under the old `remove`. The other two were
the dialog's own. **A failed background refetch took it down** — mounted only in the list's branch,
it unmounted with no fade when `isError` flipped and reopened by itself on the next good read,
because `open` was still true; the body is now `content` then `dialog` in every branch, so it is one
instance whatever the list is doing. **And a row pressed during the 180ms close fade revived the
fading panel** rather than mounting one, leaving the caret on the row outside an `aria-modal`
dialog; the dialog is keyed on a per-press `opening`. Each has a case that goes red when the fix is
taken out, checked by taking it out.
