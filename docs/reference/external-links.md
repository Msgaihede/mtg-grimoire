# Opening a card somewhere else — and the one marketplace that stopped being a search

Every card surface in this app offers the same ladder: **Scryfall, EDHREC, and the one marketplace
Settings selects**. It is the card modal's last three rail rows and the context menu's `Open on →`
submenu, and the two are one row a reader has learnt the position of, drawn twice.

Until 2026-09-09 **every marketplace row opened a name search**, and `src/lib/externalLinks.ts`
said why: no priced site publishes a per-card URL this app could derive from what is in `cards`.
That was wrong about TCGplayer, and this page is the record of the fix — what was measured, what
the code concludes from it, and the ingest that was measured on the same day and deliberately not
built.

**Where the figures come from.** Every corpus count below was taken on **2026-09-09** against the
live dev corpus (`src-tauri/target/debug/data/corpus.db`, **117 738 rows**) with Node 24.16.0's
built-in `node:sqlite` opened read-only, inflating each row's `raw` with `node:zlib` exactly as
`card_row::raw_json` does. They are counts over a database rather than timings of a binary, so
the debug/release distinction does not apply to them — where a *duration* is quoted below it names
its build. The browser figures under **The printing parameter** were driven in Chrome over the
DevTools protocol, and say so at their own table because they settle TCGplayer's behaviour and not
this app's press.

## The finding: Scryfall has been storing the product id all along

`cards.raw` has held Scryfall's card JSON verbatim since schema v3, and two of its fields are
TCGplayer's own catalogue ids:

- **`tcgplayer_id`** — the printing's ordinary product, under which TCGplayer sells whichever of
  nonfoil and foil it carries.
- **`tcgplayer_etched_id`** — the **etched** product, which TCGplayer lists as a separate item.

So the exact link needs **no new network dependency, no new table, no schema rung and no name
matching**. It is one row inflated on the press, which is `card::meld_parts`' shape one question
over — that function reads `all_parts` out of the same blob for the same reason.

### Coverage

| bucket | rows | have `tcgplayer_id ?? tcgplayer_etched_id` |
| --- | --- | --- |
| paper, English, non-token | 99 885 | **98.38 %** |
| all paper | 108 382 | 93.90 % |
| whole corpus | 117 738 | 86.44 % |
| digital-only (Arena / MTGO) | 9 356 | **0.04 %** |

*Non-token* is `layout NOT IN ('token','double_faced_token','emblem','art_series')`; *paper* is
`is_paper = 1`, which the corpus keeps as a column.

**Paper, English, non-token is the population a card pane is opened on**, and it is the figure this
feature should be judged by. The other three are in the table so that nobody reads 98.38 % as a
claim about the whole file: the same measurement over the whole corpus is 86.44 %, and quoting the
wrong one of those two is how a working fallback comes to look like a defect. **The digital row is
not a gap in the data** — those cards are not sold on TCGplayer at all, so *no id* is the correct
answer for them.

**A fallback is therefore a normal path and not an error path.** 1.62 % of the population the card
pane draws — 1 622 printings — has neither id, and the name search is what those open. Any reading
of this feature that treats two nulls as a failure is reading it wrong.

### The two ids are unrelated numbers, and that is why they are two fields

The etched id is **not** a refinement, an offset or a sibling of the ordinary one. Four printings
from the corpus, read on 2026-09-09:

| printing | `finishes` | `tcgplayer_id` | `tcgplayer_etched_id` |
| --- | --- | --- | --- |
| Weather the Storm, STA 58 | nonfoil, foil, etched | 235270 | **235269** |
| Weather the Storm, STA 121 | nonfoil, foil, etched | 235266 | **235267** |
| Imperial Recruiter, MH2 281 | nonfoil, foil, etched | 239769 | **240826** |
| Miara, Thorn of the Glade, CMR 566 | etched | *(absent)* | 227069 |

Two printings of one card in one set disagree about whether the etched id is above or below the
ordinary one, and MH2 281's pair is a thousand apart. Nothing can be derived from either about the
other, which is why `card::TcgplayerIds` carries both, unread, and why folding them into a single
`tcgplayer_id ?? tcgplayer_etched_id` in Rust would decide the question once — and wrongly for the
**333 printings that carry both**, whose etched copies would all then link to the ordinary product.

The counts across the whole corpus:

- **1 225** printings carry an etched id at all.
- **892** of those carry **no** ordinary id — a card printed only in etched foil, like Miara above.
  A caller that reads only `tcgplayer_id` answers *no product* for 892 real printings that have
  one.
- **333** carry both.

### What has no id, and why

The **1 622** paper English non-token printings with neither id are spread over **103 sets**, and
they are dominated by things TCGplayer does not sell as an individual product:

| what | rows |
| --- | --- |
| The List (`plst`) | **504** |
| Front-card sets (14 of them: `fmsc` 61, `jtla` 46, `fj22` 46, `fj25` 46, `fjmp` 33, and nine more) | **302** |
| Sets not yet released (`trk` 79, `trc` 31, `fra` 12 — Star Trek and Reality Fracture) | **122** |
| Unknown Event (`unk`) | 94 |
| Oversized League Prizes (`olep`) | 83 |
| Rivals Quick Start Set (`rqs`) | 65 |
| Hachette UK (`phuk`) | 60 |
| Black Lotus Unknown Planechase (`punk`) | 52 |
| Secret Lair Drop (`sld`) | 50 |
| Vintage and Legacy Championship promos (`ovnt` 35, `olgc` 27) | 62 |
| 77 further sets, none over 11 | 228 |

**The unreleased row is the one that heals itself.** Star Trek and Reality Fracture both release
after this measurement was taken, and the weekly card sync fills their ids in as TCGplayer stocks
them — so a coverage figure re-taken in December will be higher for a reason that has nothing to do
with this code. Every other row is the durable shape: a Jumpstart front card and an oversized
league prize are not products anybody buys singly.

**A trap in the digital row, and it is the reason that row is 0.04 % rather than 0 %.** Four
Arena-only printings carry an ordinary id — `Void Beckoner` (IKO 373A) and three Alchemy cards in
`mbc`. *Digital implies no id* is 99.96 % true and is **not a rule**; a fence written on it would
be a refusal that fires on four real cards. The code branches on the ids being absent, never on
the card being digital, and it must stay that way.

## The printing parameter

TCGplayer's product page takes a `Printing` query parameter, and **its Magic vocabulary is exactly
`Normal` and `Foil`**. That was read off the catalogue's own price rows for Commander Masters,
where `subTypeName` takes those two values and nothing else.

**Etched foil is a separate product rather than a third printing**, which is the whole reason
Scryfall carries a second id: `484936 The Ur-Dragon (Foil Etched)` is its own product, and *its*
subtype is `Foil`. The same is true of every other special treatment — raised, surge, chocobo
track — each its own product sold as `Printing=Foil`. **So the app's three finishes collapse to
TCGplayer's two words and there is no third value to model.** That is not a lossy mapping; it is
the way the site is built.

### Verified in a real browser, 2026-09-09

**A 200 does not prove a parameter selects the right row.** TCGplayer's listing grid is a
client-rendered module-federation SPA, so an automated fetch sees only the shell — the caveat
`SEARCH_URL.tcgplayer` has carried since 2026-08-14, reached one step further. `?Printing=Foil`
and `?page=1&Printing=Normal` both answering 200 settles the *shape* of the URL and says nothing
about its effect.

So it was driven in Chrome over the DevTools protocol — **not the app's WebView2**, so what
follows settles TCGplayer's behaviour and not the app's press, which is verified separately.
Product `484935` (The Ur-Dragon, Commander Masters), three states of one page:

| URL | Normal | Foil | listings |
| --- | --- | --- | --- |
| `?Printing=Normal` | **checked** | unchecked | **4** |
| `?Printing=Foil` | unchecked | **checked** | **4** |
| no parameter | unchecked | unchecked | **8** |

**4 + 4 = 8 is the part worth writing down.** The parameter genuinely *partitions* the listings
rather than decorating the URL, and the bare page is a real neutral rather than a hidden default.
That neutrality was first read as a *licence to omit* the parameter when nothing named a finish;
**the same measurement is what retired that reading a few hours later** (see the decision table
below). A page showing every listing in both finishes is one the reader has to filter by hand to
get back to the version they were already looking at, so "8 listings" is the cost of omitting
rather than the safety of it.

**The etched branch is confirmed on its own product.** `484936`'s `h1` reads `The Ur-Dragon (Foil
Etched) - Commander Masters (CMM)`, and the page offers **only a Foil checkbox — no Normal row at
all**, which `?Printing=Foil` checks (3 listings). An etched product is its own product whose only
printing is Foil, exactly as the design assumes. The corpus agrees from its side: CMM 594 is
`finishes: ["etched"]` with `tcgplayer_etched_id: 484936` and no ordinary id, while CMM 361 is
`tcgplayer_id: 484935`.

**One incidental fact.** TCGplayer appends `&Language=English` itself — every URL above normalised
to `?Printing=…&Language=English`, and the bare one to `?Language=English`. So the app does not
need to send it, and the applied-filter chip count reads 2 rather than 1 for that reason and not
because the app asked for anything.

## The decision table

**The governing rule, stated once: name the printing the id actually chosen is sold in.** Every
row asserts one — a link exists to land on the version in front of the reader — and what varies is
only *which* word. The word follows the **product**, not the finish the reader named, which is the
whole subtlety: `etched` is not a `Printing` value, so an etched copy is `Foil`, and an etched
product has no `Normal` row at all.

| finish the surface named | id used | `Printing` |
| --- | --- | --- |
| `etched`, etched id present | `etchedProductId` | `Foil` |
| `etched`, no etched id | `productId` | `Foil` |
| `foil` | `productId` ?? `etchedProductId` | `Foil` |
| `nonfoil`, ordinary id present | `productId` | `Normal` |
| `nonfoil`, only an etched id | `etchedProductId` | `Foil` |
| neither id | — | the name search, unchanged |

**This reverses an earlier reading, and the reversal is the reader's own correction** (2026-09-09).
The table first carried three *omit the parameter* rows — etched without an etched id, nonfoil with
only an etched id, and an unknown finish — each argued from "the site's own default is a better
answer than a guess". The first press in the shipped window went to a printing sold in three
finishes, opened from the search wall, which names none: `product/235270` with no filter, which is
the unknown row working exactly as designed and which read as the feature not working. **A link
whose whole purpose is the exact version must not hand back a page mixing versions**, so the
unknown row is gone — `linkFinish` now always answers a finish — and the two remaining omissions
became `Foil`, the nearer of the two words in both cases.

The four rows that need an argument of their own:

- **Etched with an etched id** is the exact product, and `Foil` is that product's own subtype.
  Etched is not a third `Printing` word and there is no third word to reach for.
- **Etched with no etched id** lands on the ordinary product, which is the closest page for the
  card. The etched copy is not sold under it, so this is the nearest listing rather than the exact
  one — and `Foil` is the nearer word, since an etched card is a premium foil treatment and never
  a plain one.
- **Foil** takes either id, because both products have a `Foil` row: the ordinary one's is the
  foil printing, the etched one's is the etched card itself. `productId` first, because a plain
  foil is what "foil" means on a printing that has both — and 333 do.
- **Nonfoil with only an etched id** is a contradiction in the data rather than in the reader, and
  it is the sharpest illustration that the printing follows the *product*: that product has no
  `Normal` listing, so asking for one would filter the page down to nothing. `linkFinish` makes it
  nearly unreachable anyway — such a printing lists `etched` and so never defaults to `nonfoil` —
  but 892 printings carry only the etched id, so the row is not hypothetical.

### The finish itself: what the surface said, then the most ordinary finish it is sold in

`linkFinish` takes the finish the surface named — a collection row's own, a deck row's, a
wishlist's `preferred_finish` — and otherwise reads the printing's own `finishes` column. That
order is `playedFinish`'s one file over, and for the same reason: the reader's own statement
outranks the object's, because each of those columns says *this copy is the shiny one* about the
very copy the reader is going shopping for.

**It always answers a finish**, which is what makes the decision table above total. The floor is
**the most ordinary finish the printing is _actually sold in_** — the preference runs `nonfoil` →
`foil` → `etched` over the finishes listed, whatever order Scryfall wrote them in — and a printing
whose column is empty or unreadable falls to `nonfoil` as the ordinary case.

**Not a flat `nonfoil` default, and that distinction is the whole of what keeps it honest.** 12 366
paper printings exist only in foil and 892 only in etched; asserting `Normal` on one of those would
ask TCGplayer for a listing that cannot exist, and a filtered page with nothing in it is worse than
the unfiltered page this replaced. Reading the floor off the column instead means a foil-only
printing gets `Foil` and an etched-only printing gets `Foil` on its own product.

**This subsumes the sole-finish step it replaced rather than dropping it.** A printing sold in
exactly one finish has that finish as its most ordinary one, so a one-element list answers exactly
as it did before — one rule where there were two.

**It therefore no longer resembles `soleFinish` from `@/lib/finish`, and that is worth stating
because the two were deliberately near-duplicates for one afternoon.** `soleFinish` answers `null`
for a nonfoil-only printing **on purpose** — it drives the foil marking on card art, where the
honest statement about a plain card is *no mark* rather than a mark meaning "plain", and that
`null` is load-bearing for every paper printing sold in both finishes, the majority of any wall.
Nothing on this page should ever be routed through it.

## Nothing is resolved until the press

**`externalLinks.ts`'s first doctrine survives this change intact: nothing is fetched, resolved or
opened until the reader presses the item.** A menu that merely *offers* to open a marketplace has
not visited one — and, since 2026-09-09, has not read the blob either.

That is why the ids are a **command** rather than a field on `CardDetail`. A card is opened far
more often than its `Open on` row is used, and carrying two integers through every printing of
every wall to serve a press most readers never make is the wrong trade; one id lookup on the
primary key, made on the press, is the right one. For scale, `card.rs` records **4.8 s** to inflate
and parse the *whole* corpus (117 738 rows, 2026-09-09), so one row is microseconds against a link
the reader has just clicked. **Its own site does not name the build** — read it as debug, which is
what `cargo test` produces, and re-take it before quoting it as anything else.

**A press must never do nothing**, which is why this is one function rather than a builder each
call site drives. There are three ways the exact page cannot be had and every one opens the name
search instead:

1. **The marketplace is not TCGplayer.** This path makes **no ipc call at all** — a Cardmarket
   press has no business asking for a TCGplayer id.
2. **Both ids are null.** The 1.62 % above, every digital-only card, and every printing the corpus
   has never held ids for.
3. **The command rejected.** It is built not to — an unknown id, an unreadable blob, an
   unparseable blob and absent fields all answer two nulls — so this arm covers the ways a command
   fails that are not about the card: a locked database, a webview that lost the bridge.

**Every way the Rust read can fail answers two `None`s and never an `Err`**, which is
`meld_parts`' rule and `card_detail`'s about the marketplace, for the third time and the same
reason: a card the reader has open must not fail over a link. Two nulls and a name search is a
slightly worse link; an `Err` is a card that will not open.

**There is no gate in front of the inflate, and the contrast with `meld_parts` is worth being
explicit about.** That function asks `layout = 'meld'` first and so inflates 0.06 % of the rows it
is called on; *this* question can be asked of any card, because any card might be for sale, and no
column rules a row out. The gate is absent because there is nothing to gate on, not because it was
forgotten.

## Where the pieces live

| file | what it owns |
| --- | --- |
| `src-tauri/src/card.rs` | `TcgplayerIds`, `tcgplayer_ids`, and the `card_tcgplayer_ids` command — both ids out of `cards.raw`, unread |
| `src-tauri/src/web/route.rs` | The same command on the browser build, over the same function |
| `src/lib/externalLinks.ts` | The *shapes*: `tcgplayerProductUrl`, `TcgplayerPrinting`, and `marketplaceSearchUrl` for the other four |
| `src/features/card/openMarketplace.ts` | The decision table, `linkFinish`, and the fallback for both call sites |
| `src/features/card/CardModalRail.tsx` | The modal's last rail row |
| `src/features/card/cardMenu.tsx` | The context menu's `Open on →` submenu |
| `.storybook/fake/` | The workbench's answer — both ids as **fields on the fake row** |

**The split between `externalLinks.ts` and `openMarketplace.ts` is the one to hold on to.** The
first builds strings and the second draws a conclusion; a helper in the former that asked Rust for
a product id would break that file's own stated doctrine. And the decision lives in
`features/card/` rather than in Rust because every judgement in it is about which product a
*reader* meant, drawn from a finish that only the surface knows — Rust supplies facts, TypeScript
draws conclusions, which is the root `CLAUDE.md`'s boundary applied to a link.

**It is written once because two surfaces press it and they must open the same page.** A second
copy of that table is how the menu comes to open a foil listing where the rail opens a plain one
for the card sitting under both of them. All either call site supplies is four facts only a
surface knows: which printing, its name, the finish the surface named, and the finishes the
printing is sold in.

**Nothing about `CardMenuTarget` had to change**, which is the dividend of resolving on the press:
the surfaces that build a menu target already carry both facts.

**The fake's shape is the one row in that table that does not mirror the database, and it is right
not to.** `.storybook/fake` stores `tcgplayerId` / `tcgplayerEtchedId` as plain fields because it
has no gzipped `raw` blob to inflate. The real `cards` table has no such columns and never will —
the whole argument of this feature is that the ids were already in the blob — so do not read the
fake's row as the schema.

## Why tcgcsv.com was measured and not built

The feature was originally specified as an **ingest of tcgcsv.com**, a third-party mirror of
TCGplayer's catalogue (`/tcgplayer/1/groups`, `/tcgplayer/1/<group>/products`). It was measured on
**2026-09-09 and not built.** This section exists because it is the obvious thing for the next
person to propose.

**Set coverage is the first refusal.** 1 049 sets in the corpus against **454** tcgcsv groups: 249
match by set name, 80 more by abbreviation, and **720 sets have no group at all.** TCGplayer folds
promo sets, art series and World Championship decks into other groups or does not carry them, and
The List — the single largest gap in the corpus at 504 printings — has no group.

**The marginal gain is the second, and it is the decisive one.** On the four biggest sets where a
group *does* match — `cmm`, `2x2`, `clb`, `mul` — the corpus holds **485 printings with no ordinary
`tcgplayer_id`**. Name matching resolved all 485, and **`genuinelyNew = 0`**: every one was an
**etched** printing, and every match handed back a productId another printing in that set already
owned. They were not new coverage; they were **wrong links**.

The corpus says exactly why, re-measured here on 2026-09-09 over those four sets (2 843 rows):
**486** carry no ordinary id, **485 of them `finishes: ["etched"]`** and the 486th an ordinary
`mul` printing with no id at all — and **not one** of the 485 etched ids collides with any
ordinary id in those sets. So the correct link was already in `tcgplayer_etched_id` all along, and
a name match, which finds `The Ur-Dragon` and not `The Ur-Dragon (Foil Etched)`, would have
overwritten it with the ordinary product's id. An ingest built on that match would have taken a
column that was **right** and made it wrong, silently, on 485 printings in four sets.

`extendedData.Number` — the catalogue's own collector number — matched **0** of those 485, so
number-matching does not rescue it either.

**What it would have cost**: 454 HTTP requests and roughly **250 MB of JSON** (10 sampled group
files averaged 558 KB), a sixth network dependency, a corpus table and a weekly refresh — for a
measured marginal gain of zero on the sets tested.

**One live operational fact worth keeping even though nothing depends on it: tcgcsv blocks any
request without an identifying `User-Agent`.** Node's default UA got back
`Ahoy! CptSpaceToaster here! Your User-Agent has been blocked.` — **a 200 with a non-JSON body**,
so a naive ingest would have failed at the parse rather than at the request, and the error in
`error_log` would have named JSON rather than the wall it actually hit.

The set counts and the network figures in this section were measured by the spec pass on
2026-09-09 and cannot be re-taken from this tree; the corpus figures beside them were re-taken
here and agree.

## What did not change

**The other four marketplace rows are still name searches** — Cardmarket, Card Kingdom, Mana Pool
and Card trader — and for the reason that used to cover all five: none of them publishes a
per-card URL derivable from what is in `cards`. That is not a fallback there; it is the only shape
those rows have ever had.

**The ladder itself is untouched** in both surfaces: still Scryfall, EDHREC, then the one selected
marketplace, still last, still deliberately not alphabetical. What moved is only what the press
*opens*.

### The deliberate non-goal: Cardmarket

**Scryfall carries `cardmarket_id` too, and the identical trick would work.** Lightning Bolt (LEA)
is `cardmarket_id: 5395`, and Scryfall's own `purchase_uris.cardmarket` for that printing is
`https://www.cardmarket.com/en/Magic/Products?idProduct=5395&referrer=scryfall&…` — a per-card URL
built from a stored integer, exactly as TCGplayer's is.

It was **left out of scope on 2026-09-09, not overlooked.** Two things a future pass would have to
settle that TCGplayer's did not: Cardmarket answers every automated request with a Cloudflare
challenge (HTTP 403, per `SEARCH_URL.cardmarket`'s own comment), so the browser verification that
settled the `Printing` parameter above has no equivalent there; and Cardmarket's finish and
language vocabulary is its own, so the decision table would need measuring rather than reusing.

## What is not fenced

**`card.rs` is not among the files `src/lib/ipc.test.ts` reads with `?raw`**, so `TcgplayerIds` is
not on the mirror's named struct list — it sits with `MeldRelation`, `CardHoldings` and every
other shape in that module, outside the fence. `src/CLAUDE.md` states the general rule and it
applies here in full: *a struct on that table cannot drift; every struct that is on neither still
can, silently.*

Concretely, **the Rust `TcgplayerIds` and the TypeScript one agree by hand.** Renaming
`etched_product_id`, or the `card_tcgplayer_ids` command, or its `id` argument, compiles green on
both sides and fails at runtime — where the failure is a link that opens a name search, which is
also what a *correct* build does for 1.62 % of printings. That is the worst shape a silent failure
can take: indistinguishable from the designed fallback.

Adding `card.rs` to that test's imports and `TcgplayerIds` to its list is the whole of the fix and
it costs one line each. It has not been done, and this paragraph is the record of that rather than
a plan.
