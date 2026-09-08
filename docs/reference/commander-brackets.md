# Commander brackets: the floor, the four signals, and the combo feed

What the bracket readout on a Commander deck's header says, what it is allowed to conclude, and
where the one signal that is not in a card's own text comes from. **Since 2026-09-07 the same
answer is drawn on the deck _tile_ as well**, over a read of its own — the tile section is what
is different about asking a whole gallery at once.

**Since 2026-09-08 the feed has a second reader that is not a deck at all**
([#359](https://github.com/Msgaihede/mtg-grimoire/issues/359)): a `Combos` row on the card
modal's rail, asking *which combos name this card* where every other reader here asks *which
combos does this pile of cards hold*. **The card side has its own section at the end**, and the
two questions never share a statement, a query key or a sentence.

The rules are the Commander Format Panel's and the combo classifications are Commander
Spellbook's editors'. Both were verified live on **2026-08-27** and are recorded in
[the research](../superpowers/research/2026-08-27-commander-brackets-and-combos.md), which is
the source; this document is the reference the shipped code is held to and does not restate it.

**Every duration in the feed sections below was taken on Windows against a _debug_ build**, by
`combos::tests::live_ingest` — an `#[ignore]`d test in `src-tauri/src/combos.rs` that exists so
these can be re-taken rather than trusted. A release build can differ by ~8×, which is the root
`CLAUDE.md`'s standing rule, so no timing here appears without the build it was taken on.

**The card-side timings at the end were taken a different way and are not comparable to those**,
which is stated at their own table too because a figure that is quoted away from its method is a
figure that will be compared with the wrong thing: they are **Node 24.16.0's built-in
`node:sqlite`** driving the statements' own SQL text against the live dev pair opened read-only,
not rusqlite inside a debug build. What they measure is **the query plan**, and the difference
between two plans over one corpus; they do not measure the binary, the IPC hop or the
serialisation, and nothing in them can be added to a figure that does.

## The table as it stands

| Bracket | Earliest game end | Game Changers | Mass land denial | Extra turns | Tutors | Two-card infinite combos |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Exhibition | turn 9+ | none | no | **no** | unrestricted | no |
| 2 Core | turn 8+ | none | no | low quantities, not chained | unrestricted | no |
| 3 Upgraded | turn 6+ | **up to 3** | no | low quantities, not chained | unrestricted | no *early-game* ones |
| 4 Optimized | turn 4+ | unlimited | yes | yes | unrestricted | yes |
| 5 cEDH | any turn | unlimited | yes | yes | unrestricted | yes |

Three announcements made it, in order: the
[February 2025 beta](https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta)
introduced the five brackets and their prohibitions; the
[21 October 2025 update](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025)
re-based every bracket on an **expected earliest game-ending turn** and **removed the tutor
limits from every one of them**; the
[9 February 2026 update](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026)
touched Game Changers only (`Farewell` and `Biorhythm`) and said in as many words that the panel
wants to "cool it on bracket-level changes for the time being" — so October 2025 is the live
wording and the table above is it.

**`bracket.ts` implemented the February 2025 beta until 2026-08-27**, which means it was wrong
for ten months. Three things had to move when it was brought current:

- **Tutors stopped being a signal.** `isTutor` was the *only* thing separating this app's
  bracket 1 from its bracket 2, and the separation no longer exists in the rules. The grep and
  everything that fed it were deleted. **Extra turns took the job**: bracket 1 forbids them
  outright and bracket 2 allows them "in low quantities … not intended to be chained in
  succession or looped". That line survives the 2026-09-01 change that stopped the floor reaching
  1 at all: extra turns no longer lift a deck off the bottom, because the bottom is 2 — what they
  do instead is give `bracketWarning` its one sentence for a deck the reader has set to 1 by hand.
- **Mass land denial became a bracket-4 signal.** It mapped to **5** here, on the argument that
  a deck playing it "has decided something about the table" — an over-read the file made on
  purpose and which the current text simply contradicts. One Armageddon does not make a cEDH
  deck.
- **The number stopped being a bracket and became a floor**, and stopped being able to reach 5
  at all — and, from 2026-09-01, 1 either. Both have sections of their own below.

The clauses the bracket picker draws beside each rung (`BRACKETS` in `DeckBracket.tsx`) are that
table paraphrased, and 1's and 5's clauses both say out loud what no card list can show — see
**Why the floor is never 5, and never 1**.

## The estimate is a floor

**Every bracket restriction is written as a prohibition.** Bracket 2 may not play mass land
denial; bracket 3 may play at most three Game Changers. What a card list can honestly answer is
therefore always "not allowed below N", never "is N" — so `BracketEstimate.floor` is the lowest
bracket the deck is allowed in, and it is the only reading that makes a *set* bracket checkable
against it at all.

The rungs, as shipped in `rulesThatFired` (`src/features/decks/validation/bracket.ts`):

```
4  ≥ 4 Game Changers · any mass land denial · ≥ 3 extra-turn cards · a combo tagged R
3  1–3 Game Changers · a combo tagged P or S
2  any extra-turn card · a combo tagged C or O
2  none of the above — BASE_FLOOR, and not a rule, so it fires no reason
```

Highest wins, and the seed of that `Math.max` is `BASE_FLOOR` rather than 1. Three things about
the shape rather than the numbers:

- **The bottom two rows read the same number and are not the same thing.** `BASE_FLOOR` is where
  the fold *starts*; the extra-turn and combo rules above it are rules that **fired**, so they land
  in `BracketEstimate.reasons` and the base does not. Both give a floor of 2 and only one of them
  can say why — which is exactly the distinction `bracketWarning` needs when the bracket set by
  hand is 1.
- **A rule that fired below the floor is a signal, not a reason.** Every entry in
  `BracketEstimate.reasons` forces the floor the estimate reports; the rest are still listed by
  name on the estimate's own fields (`gameChangerNames`, `massLandDenial`, `extraTurns`), which
  is what the advisory's *What this read* disclosure draws. `reasons` is empty exactly when no rule
  fired at all — a floor of `BASE_FLOOR` reached by nothing.
- **A reason carries the cards it read**, and `describeReason` is the one place a reason becomes
  a phrase — exported so the button and the panel cannot word the same fact two different ways.
  It lists at most three card names before it starts counting (`NAMES_IN_A_SENTENCE`), because a
  sentence that ran to nine names is one nobody finishes.

`bracketWarning(set, estimate)` is the mismatch sentence, and it will not do three things, each
on purpose: it **never fires upward** (a deck set to 4 that reads as 2 is an ordinary deck
playing under the ceiling its table agreed on); it **never says illegal, invalid or must** (the
floor is two oracle-text greps and a third party's classification, and the reader is the one who
knows whether their playgroup cares); and it **names one reason, not all of them** (every entry
in `reasons` forces the same floor, so there is no strongest one to find).

## Why the floor is never 5, and never 1

**Both ends of the scale are an intent; only the middle three are a card list.**

**Brackets 4 and 5 have identical _deck_ restrictions.** Both allow unlimited Game Changers,
mass land denial, extra turns and two-card combos. What separates them is whether the deck is
built for the cEDH metagame — an intent, not a card. An estimator that reads card contents can
therefore never honestly return 5, so this one does not, and `bracket.ts`'s module header says
where the old `bracket: 5` went for the reader who remembers it.

**Bracket 1 went the same way on 2026-09-01**
([#342](https://github.com/Msgaihede/mtg-grimoire/issues/342)), and it is the same argument
upside down. The October 2025 update words Exhibition entirely in terms of what the deck is
*for* — players expect "decks to prioritize a goal, theme, or idea over power", "win conditions
to be highly thematic or substandard", "gameplay to be an opportunity to show off your
creations" (read live from the announcement, 2026-09-01). Its only *card* prohibition that
bracket 2 does not also carry is extra turns, so a pile of Grizzly Bears, Rampant Growth and
sixty Islands satisfies every printed restriction bracket 1 names and is still not an Exhibition
deck unless its builder says it is. Answering `~1` off a card list was this module claiming to
see the one thing it cannot see.

**Bracket 2 Core is what a deck that flags nothing honestly reads as** — "decks to be
unoptimized and straightforward", which is a description of a deck with no Game Changers, no
denial, no chained turns and no combo in it. `BASE_FLOOR` in `bracket.ts` is that number, and
nothing else moved with it: every rung in `rulesThatFired` fires exactly where it did, so a deck
that read 3 or 4 reads the same today.

**What the two rules that fire *at* 2 kept is their whole job**, which used to be a side effect
of raising the number and is now the point of them. A deck the reader has set to bracket 1 that
plays one Time Warp is told so, because the extra-turn rule fired and 2 is above the 1 they set;
a deck set to 1 that fires nothing is told nothing, because there is no reason to name and
Exhibition is a claim no card in it contradicts. That is `bracketWarning`'s empty-`reasons`
guard, which was unreachable before this change and is now the case that matters most.

A reader who is playing cEDH sets 5 by hand, and a reader building an Exhibition deck sets 1.
That is the whole reason the picker exists, and it is why `decks.bracket` accepts numbers the
estimate cannot produce.

## Three judgements that are this app's rather than the document's

The document is silent on all three, so each is a decision that could reasonably have gone the
other way. They are stated here and at their own definitions so that a reader who disagrees is
disagreeing with something written down.

1. **`>= 3 extra-turn cards → 4.`** Brackets 2 and 3 both allow extra turns "in low quantities …
   not intended to be chained in succession or looped", and nothing says what a low quantity is.
   Three is where this app draws chaining. Below it they still fire, at **2**, which is the line
   bracket 1 draws by forbidding them outright. `rulesThatFired` labels this one in as many
   words; it is the only cell in that table that does.
2. **`S` and `O` take the _lower_ of the two brackets Spellbook hedges between, and `B` raises
   nothing at all.** "Probably 3 or 4" is not evidence a deck is barred from 3, which is the only
   reading a floor can honestly give a hedge. `B` (Banned) is a *legality* finding rather than a
   power one — `engine.ts` already reports those cards off the banned list — and a bracket
   estimate that quietly re-reported it as power level would be answering a different question
   with the same words. Both still appear in the combo list the reader sees. `COMBO_FLOOR` is
   where this lives.
3. **A combo that also needs a template raises nothing, and is shown anyway.** Its named cards
   are all in the deck, but it needs something no card list can answer for — "a creature with
   flying", "a way to sacrifice a creature" — so it lands in `possibleCombos`, out of the
   arithmetic and on the screen. Both halves matter: counting it would invent a restriction the
   deck may not have, and dropping it silently would hide a real interaction from the one person
   who *can* tell whether the template is there. That is why the split is a field rather than a
   filter.

## What the app can see, and how well

Four signals. Three come from data the app always has; the fourth is a bulk feed a launch goes
and gets on its own. It can still be absent — a first run that has not finished it yet, or one
that failed — so each reader of it below says what the estimate does then.

### Game Changers — a column

`cards.game_changer`, maintained by the panel and delivered by the ordinary card sync. Nothing in
`bracket.ts` hardcodes the list, which is the whole reason the count is trustworthy: the February
2026 additions arrived without a code change. `gameChanger` is `boolean | null` and a `null` — an
orphaned row that knows nothing about itself — is counted in **neither** direction.

### Mass land denial — an oracle-text grep, read one sentence at a time

`isMassLandDenial` reads every face's text, lowercased, split into rough sentences, and asks for
**`lands` as a whole word** plus either `destroy all` or a table-facing (`each player`,
`each opponent`, `all lands`) sacrifice — with a final clause that drops a sentence where every
mention of lands falls after an `except`.

Measured on the live corpus on **2026-08-05**, as the function reads it, the clauses come off
**cumulatively and in this order**:

```
105  the naive test  →  85  word boundary  →  42  table-facing  →  39  except
```

**Those four numbers are a chain, not four independent contributions**, and reading them as
independent overstates the first: the word-boundary clause's 20 overlaps the table-facing clause
that follows it. Re-measured on **2026-08-27** against the shipped function, each of the two
clauses that had never been tested is independently load-bearing for this much:

- **The word boundary keeps out exactly four cards**: `Apocalypse Chime` (whose `destroy all` is
  aimed at the *Homelands* expansion), and `Boil`, `Boiling Seas` and `Tsunami`, whose
  `Destroy all Islands.` is a colour hoser this app has decided not to read as denial. Without
  it, `Islands` and `Highlands` are `lands`, and a single hit pins the whole estimate at bracket
  4. `does not read a set name that ends in lands as the word` is the test.
- **The sentence-at-a-time split keeps out nine**, and lets **none** back in — so it costs no
  true positive: `Bontu's Last Reckoning`, `Bolas's Citadel`, `Cold Snap`, `Mana Vortex`,
  `Mistbind Clique`, `Rite of Ruin`, `Solar Tide`, `Urza's Sylex` and `Wrath of Leknif`. Each
  says `destroy all` about one thing and `lands` about another, in two sentences with nothing to
  do with each other. `does not join a destroy-all in one sentence to lands in another` is the
  test.

Every well-known piece survives the cut: Armageddon, Ravages of War, Ruination,
Jokulhaups, Obliterate, Decree of Annihilation, Wildfire, Death Cloud, Pox, Catastrophe,
Devastation, Global Ruin, Tectonic Break, Fall of the Thran, From the Ashes.

**None of this changed in the October 2025 rewrite, deliberately.** What moved is what the
*mapping* does with a hit — bracket 4 now, not bracket 5 — and not one word of what counts as one.

### Extra turns — the same grep discipline, for a different reason

`isExtraTurn` looks for `extra turn` in a sentence that is not a denial (`TURN_DENIAL`).
Stranglehold, Trouble in Pairs and Gerrard's Hourglass Pendant say `"If a player would begin an
extra turn, that player skips that turn instead."` and nothing else about turns — the only three
of the 68 cards in the corpus that mention an extra turn which take none (`TURN_DENIAL`'s count,
which carries no date of its own; re-take it before quoting it as current).

The sentence split is load-bearing here too, for one card: **Ugin's Nexus** denies the table's
extra turns in its first sentence and takes one in its second, and it is the only card the
whole-text and per-sentence readings disagree about (65 against 64). A card that says one denial
sentence anywhere must not be able to hide every turn it grants.

### Two-card infinite combos — a joined database

A combo is a fact about an *interaction* and cannot be read out of either card's text. It arrives
from the feed below, already carrying Commander Spellbook's editors' own classification, which is
why this app never has to decide what "an intentional early-game two-card infinite combo" is.

**An empty combo list is a real answer and not a missing one.** `estimateBracket`'s second
argument defaults to `[]`, and a database that has never fetched the file gets an estimate that
reads three signals instead of four. Only the *caller* knows which of the two an empty list is —
`combosStatus()` reports whether anything was ever ingested — which is why the advisory panel
carries four states (`never` · `reading` · `failed` · `read`) rather than a count of zero.

**`never` kept its arm when the download became automatic, and only its sentence changed.** It no
longer tells the reader where to press — the list arrives on its own — but it is not reliably
transient either: the launch refresh is silent and best-effort, so an install with no network, or
one whose download was refused, sits in `never` for the whole session with nothing on its way.
Folding it into `reading` would promise an arrival the panel cannot see coming, and folding it
into `read` is the one sentence this panel may never write — *no combos matched* is a claim about
a list that was consulted, and a database that has never fetched has consulted nothing.

**The combos handed to `estimateBracket` are not re-checked there.** They were matched by oracle
id against a set of card ids the caller chose, so the ids passed to `combosForCards` must come
from the same active-category filter `estimateBracket` applies to the cards — `DeckBracket`'s
`cardIds` memo is where the two are kept in step.

### What it deliberately does not try to see

The **expected earliest game-ending turn** that October 2025 re-based every bracket on. That is a
claim about how a deck plays, and no list of cards answers it.

## The combo feed

`src-tauri/src/combos.rs`. Modelled on `marketplace_feed.rs` and not on `tags/`: it is not
Scryfall, so it gets its own `reqwest` client, its own timeouts, no share of Scryfall's
rate-limit budget and no place in its 429 penalty state.

### The file

```
GET https://json.commanderspellbook.com/variants.json.gz
```

Public, unauthenticated, one object: `{ timestamp, version, variants: [ … ] }`. Every other
filename tried on that host answers 403, so there is exactly one file and no lighter variant of
it to prefer.

**The 23× expansion is almost entirely Scryfall image URLs** — every `uses[].card` carries ten
`imageUri*` fields plus a type line, and every variant carries notes and prices. Most of it is
unwanted, so the ingest is streaming end to end: byte stream → a temp file under `tmp/` → 64 KB
chunks → `feed::frame::Decoder`, which sniffs the gzip magic and decompresses →
`feed::frame::Elements`, which frames one `variants[]` element at a time by brace depth →
`serde_json::from_slice` on that one element. Exactly one variant is live at a time and every
image URL is dropped with the raw variant that carried it. `from_str` on 639 MB is not available
and neither is `serde_json::Value`. `MAX_FEED_BYTES` (128 MiB) is checked against the declared
`Content-Length` *and* against the running total, because a chunked response declares nothing.

**The framing is push-shaped, and that is a change from what first shipped.** The module drove
`serde_json::Deserializer::from_reader` with a `DeserializeSeed` over the array, which is a
*pull* parser: it calls `read()` when it wants more and blocks until it gets it. A browser stream
is push and async with no thread to block, so the web target could not drive it at all.
`read_file` and the seed are still there — they are the file-shaped entry point the tests use —
but `ingest_gz` goes through `read_stream`.

### What survives the reduction

Per variant: the id, `bracketTag`, colour identity, popularity, how many `requires[]` templates
it also needs, its `produces[]` feature names `\n`-joined, and — **since corpus schema 2** — four
prose fields: `description`, `easyPrerequisites`, `notablePrerequisites` and `manaNeeded`. Per
`uses[]` entry: an oracle id, a name, a quantity, and whether the card must be the commander.
Everything else is stepped over.

**The four prose fields are stored for the card side and for nothing else.** The bracket estimate
never reads them and `match_combos` does not select them — they are what a reader looking at *one
card's* combos needs in order to be told how the combo is actually played, and they were parsed
past for ten days before there was a reader for them. **All four are commonly `""` in the file
itself** — Spellbook writes an empty string rather than a null — so `""` is a *value* here, never
a reason to skip a variant, and the columns are `NOT NULL DEFAULT ''` to match the wire rather
than inventing a third state.

**What is deliberately not stored, though the wire carries it:** `notes` (Spellbook's editorial
remarks to itself), `manaValueNeeded` (derivable from `manaNeeded` and read by nothing), `of` /
`includes` / `variantCount` (the feed's own graph of which variants generalise which, which this
app draws no conclusion from), `spoiler`, `prices` (this app has two price feeds of its own and
neither is Spellbook's), and the per-`uses` `zoneLocations` and `*CardState` strings — "on the
battlefield, tapped" is a fact about *playing* the combo that the description already spells out
in prose. **`requires[]` is still a count and nothing more**: resolving "a creature with flying"
is not something this app can do, which is the same sentence `template_count` has always carried.

A variant is **kept** only when `status == "OK"` — the rest of that enum (`N` New, `D` Draft,
`NR` Needs Review, `E` Example, `R` Restore, `NW` Not Working) is Spellbook's editorial pipeline
showing through the file — and `legalities.commander == true`. It is **skipped**, and counted
into `combo_meta.skipped`, when it fails either of those, has no id, wears a `bracketTag` this
app has never heard of, or names not one card the app can identify.

Two fields are wider than their names suggest, and both are documented at their definitions:

- **`combos.card_count` counts DISTINCT oracle ids**, not `uses[]` rows. A combo naming the same
  card twice — one copy in the command zone, one in the library — is a one-card requirement as
  far as a decklist is concerned, and counting rows would make it permanently unmatchable.
- **`combos.template_count` is `requires[]` _plus_ any `uses[]` entry with no `oracleId`.** A
  card the file named but did not identify is exactly as uncheckable as "a creature with flying".
  Nothing in the file measured so far has one; this is the direction to be wrong in if one
  appears.

### Corpus schema 2 — four columns, and the two traps in landing them

`CORPUS_SCHEMA_VERSION` 1 → **2** (2026-09-08). `combos` grows `mana_needed`,
`easy_prerequisites`, `notable_prerequisites` and `description`, all `TEXT NOT NULL DEFAULT ''`
and all in the feed's own spelling. `schema::rebuild_combo_tables` **drops and rebuilds the
feed's three tables** and touches nothing else — not `cards`, not `cards_fts`, not either tag
taxonomy, not `image_cache`, not `marketplace_prices`, and `user.db` is never opened. The whole
cost is one silent background re-download of a 27.5 MB file `refresh_if_due` already fetches
uninvited at every launch, where a rung that took the corpus with it would have charged the
better part of a gigabyte of Scryfall resync for four columns on one table. That licence is the
whole difference between the two ladders: **a corpus rung is allowed to give up and rebuild,
because what is behind it is a download.** `combo_meta` is deleted rather than emptied, which is
`clear_combos`' rule for `clear_combos`' reason, and a v1-shaped staging pair an interrupted
ingest left goes with it.

**Trap one: the rung is gated on the table's SHAPE, not on the version number, and it has to
be.** `split::finish` stamps whatever `CORPUS_SCHEMA_VERSION` currently is onto the file it
renames into `corpus.db` — and what is *in* that file is whatever `migrate_single_file`'s frozen
v26 rung built, which is the shape of version **1**. A fresh install goes through the same
conversion. So **every converted database and every fresh install reaches `migrate_corpus`
already wearing head while carrying a v1-shaped `combos`**, and an `if v < CORPUS_SCHEMA_VERSION`
gate skips exactly the population that needs the rung. Nothing goes red: the symptom lands much
later, as an ingest raising `table combos has no column named description` on a machine nobody
can reproduce from a fresh worktree. `migrate_corpus` therefore asks
`schema::combos_are_at_head`, which reads `PRAGMA {schema}.table_info(combos)` for
`COMBO_V2_COLUMNS`; the version is still stamped, because it is the record of what the shape is
and the thing the next rung will want to have moved. **Asking the catalog is right for every
population at once, where a rung fires once and in one direction** — which is `TAG_INDEXES_SQL`'s
own argument, one line down in the same function.

*The probe reads column names and deliberately not the stored `CREATE TABLE` text.* After the
first ingest the live `combos` **is** the table `swap_combo_staging` renamed over it, so
`sqlite_master` holds `COMBO_STAGING_SQL`'s declaration rather than `COMBO_TABLES_SQL`'s — the
two agree column for column and differ as strings. A probe on the text would call every database
that has ever refreshed out of date, drop the reader's combos on every launch and re-download
27.5 MB each time.

**And a related weakness worth knowing before you trust that suite**: `split.rs`'s own test
asserts the stamped version against the constant it is stamped *from*, so it is green over
exactly this mismatch and always will be. What catches the gate is a fixture built at the shape
below head, in `schema.rs`.

**Trap two: `create_corpus_schema` is bare `CREATE TABLE`, not `IF NOT EXISTS`.** So bumping the
version and letting the builder run again does not silently no-op — it raises `table cards
already exists` and **stops the launch**. That is why the combo DDL was split out of
`CORPUS_SCHEMA_SQL` into `COMBO_TABLES_SQL` and why corpus schema 2 is `rebuild_combo_tables`
rather than a second call to the builder. `create_combo_tables` is the one literal both paths go
through, so a corpus that was *built* and a corpus that was *climbed* cannot end up shaped
differently — and it replays `COMBO_INDEXES_SQL`, because the drop took the indexes with the
tables and a `combo_cards` that comes back unindexed turns every bracket check into a full scan
with nothing going red and nothing in the log.

**Pointing a corpus rung at a head constant is legal and would be a bug on the user ladder.**
There every step spells its DDL out literally (`CARDS_COLUMNS`' rule) because a user rung is
*history* and a constant that moved under it would rewrite what a fresh install created
yesterday. A corpus rung is not history. The v26 rung's own copy of this DDL stays frozen at the
v1 shape for exactly that reason, and corpus schema 2 is what brings the file it built up to
date.

### `bracketTag`, and the floor each letter implies

The letter is Spellbook's, carried through verbatim by the ingest and stored unread; the floor is
this app's, and `COMBO_FLOOR` in `bracket.ts` is the only place the two meet.

| Code | Name | Spellbook's own words | Floor here | Count on 2026-08-27 |
| --- | --- | --- | --- | --- |
| `E` | Exhibition | "For any deck" | none | 82 629 |
| `S` | Spicy | "Probably 3 or 4, but hard to classify" | 3 | 10 755 |
| `R` | Ruthless | "For competitive decks at brackets 4+" | 4 | 6 265 |
| `O` | Oddball | "Probably 2 or 3, but hard to classify" | 2 | 3 047 |
| `P` | Powerful | "For strong decks in bracket 3+" | 3 | 2 521 |
| `C` | Core | "For unoptimized decks in bracket 2+" | 2 | 261 |
| `B` | Banned | "Not legal in Commander" | none | **0** |

Two of those rows change how the whole feature reads:

- **78 % of the combos in the file are `E`, and `E` raises no floor.** So the ordinary case of a
  deck matching combos is a list that changes nothing about the number — a reader who sees five
  combos and an unchanged bracket is looking at the system working, not at a bug. The advisory
  draws the list regardless, because what the deck *does* is worth knowing whether or not it
  moves a digit.
- **`B` does not occur in the live file at all.** The ingest accepts the letter, the schema
  stores it and `COMBO_FLOOR` maps it to no floor, so the whole `B` path is a branch that is
  currently unreachable from real data. It is tested (`raises nothing for a combo tagged B, and
  still reports it`) and it is not exercised.

The vocabulary is the *feed's*, so `combos.bracket_tag` carries **no CHECK**: the day Spellbook
adds an eighth letter should be an ingest that skips those variants and a jump in
`combo_meta.skipped`, not a migration that fails. TypeScript spells the seven as a closed union
(`ComboBracketTag`), which is why an unknown letter is skipped at the reduce step rather than
stored — a letter a total map has never heard of reaches the panel as `undefined`. `COMBO_FLOOR`
still reads `?? null` on top of that, so a letter that somehow got through raises nothing rather
than poisoning the `Math.max`.

**The card side draws the same letters and reads no floor at all**, because it is not looking at
a deck. What it needs is the *name* and Spellbook's own words, which is `COMBO_TAG` — exported
from `DeckBracket.tsx` since 2026-09-08 rather than copied, for the reason the first paragraph of
this section gives: the classification is the **feed's**, so there is one right answer to what
`S` means and it is not per-panel. Two tables spelling seven letters are two things that can come
to disagree, in two surfaces a reader moves between inside one session.

### One ingest, measured

All figures 2026-08-27, Windows, **debug** build, by `combos::tests::live_ingest`:

| | |
| --- | --- |
| Download | 27 542 314 bytes gzipped, in **1.7 s** |
| Uncompressed | 639 585 506 bytes (23×) |
| Parse + store | **44.3 s**, debug build |
| Kept | **105 478** combos over **373 877** `combo_cards` rows |
| Skipped | **1 510** of **106 988** variants seen |
| Distinct cards named | **7 310** |
| Two-card combos | 5 031 |
| Combos needing a template | 4 726 |
| `combos_for_cards`, 100 cards | **21–38 ms**, debug build, at that corpus size |
| Cost on disk | **81 604 608 bytes** (~78 MB) |

**About 10 % growth on a real install**: 81.6 MB against a live card database of 788 406 272
bytes.

`live_ingest` pins **none** of those numbers. The file rotates through the day, so a test
asserting today's count would go red on a morning when nothing was wrong; what it asserts is that
the *shape* survived contact — a real corpus, more than one bracket letter, and both of the kinds
of combo the estimator sorts on.

**Twelve days later the same table read 107 016 combos over 378 197 `combo_cards` rows** — the
card side's census, taken a different way and recorded with its method under *The card side*
below. The two are not a before-and-after of anything and must not be read as a growth rate: they
are two days of a file Spellbook rebuilds continuously, measured by two tools.

### The match, and why it starts from the deck

`combos_for_cards` runs on every deck edit, so the number that matters is the 21–38 ms above and
not the 44.3 s ingest. `idx_combo_cards_oracle` is the index it turns on: the deck's distinct
oracle ids are a hundred-odd values, each a point lookup, so `hit` is built out of the few hundred
combo rows those cards appear in rather than out of the whole catalogue. Reversing it — scanning
`combos` and asking whether the deck holds each — is a scan of every combo Spellbook has ever
published, per deck, per keystroke.

The statement is **not chunked**, and that makes the list length a real bound rather than a
formality: `have` is counted per combo across the whole deck, so two halves of a split list would
each report a two-card combo as half-matched and neither would answer. `MAX_CARD_IDS` is **1 000**
— ten Commander decks' worth of distinct printings, and far under every
`SQLITE_MAX_VARIABLE_NUMBER` SQLite has shipped — and a caller over it gets a sentence
(`TOO_MANY_CARDS`) rather than a silent truncation. Ids are trimmed and deduplicated **before**
the cap, because a caller sending one card twice has not asked about two cards.

Results are ordered `template_count, popularity DESC, id`: fully checkable combos first, then
most-played, then the id so two runs over one deck cannot answer in two different orders. SQLite
sorts NULLs first, so `popularity DESC` puts an unranked combo last.

**The card side starts from the same index and for the same reason**, with one oracle id where
this one has a hundred, and it orders on `card_count` first rather than `template_count` — a
different question wanting a different first term. *The card side* has the whole of it.

### Weekly and uninvited, against a file that rotates continuously

`combos::REFRESH_INTERVAL_SECS` is **7 × 86 400**, and the file's own `timestamp` was twenty
minutes old when it was fetched — Spellbook rebuilds through the day. **The two must not be
blurred**, exactly as they must not be for the tagger datasets: the week is *this app's* answer to
how often to ask. The catalogue is hand-curated and moves in increments, while a deck's bracket
readout quietly changing between two sessions on one afternoon, for a reason the reader cannot
see, is the failure worth avoiding. 27.5 MB an ask is the other half of the argument.

Staleness is measured on `checked_at`, never `fetched_at`: a 304 means the rows are current, and
asking again tomorrow because they were *built* a week ago would spend a request per launch to
learn nothing. The ETag makes a check that finds nothing cost zero bytes, and `combos_refresh`'s
`force` skips the weekly throttle but **not** the ETag check.

**A launch goes and gets it uninvited, and that is a reversal (2026-09-08).** `refresh_if_due`
used to return immediately on a database whose `fetched_at` was NULL — the deliberate difference
between it and `tags::refresh_if_due`, on the grounds that the tag files are what a deck add is
filed by while combos are only the *fourth* bracket signal and a database without them simply
reads three. That
argument does not survive contact with the reader. A readout drawn from three signals looks
exactly like one drawn from four: no error, no empty state, just a number a little too low, for
as long as it takes somebody to find a Refresh button they have no reason to go looking for. An
answer that is wrong in a way nobody can see the cause of is the worse failure — worse than
27.5 MB spent on a schedule this app already spends ~18 MB on for the two tagger files. So combos
join `tags::{oracle,art}::refresh_if_due` rather than
`marketplace_feed::refresh_selected_if_due`, where a marketplace nobody picked is still never
downloaded because nobody has asked to be shown its prices.

`due_at_startup` is now **staleness and nothing else**, asked of `checked_at`. `is_stale` already
reads a missing `checked_at` as stale, so a database that has never asked is due by definition
and the never-ingested case needs no arm of its own — it had two, one for no `combo_meta` row and
one for a row with no `fetched_at`, both answering `false`, and together they meant a database
that had never fetched the file never would. The function survives the collapse to a single
expression because the rule is worth asserting on its own, with no network and no database.

**`REFRESH_INTERVAL_SECS` is untouched by any of that.** The week is a statement about how often
to *ask*, and the paragraph above it is the whole of its reasoning; it reads the same whether the
first ask was a launch's or a press's.

**The launch task is its own, and that is the argument the two tag refreshes already make against
each other, now covering three files rather than two.** They are the same shape of job, which is
exactly why they must not share one: whichever went first would be the reason the others were
late — 27.5 MB gzipped here against the art file's 12.5 MB and the oracle file's 5.85 MB — and
*late* is a deck add still filing by card type, or a bracket still reading three signals, minutes
after launch. They contend for the write connection a batch at a time, which is the engine's job
and not the launch's. `desktop.rs` spawns it at setup, after the two tagger refreshes and chained
onto neither, silent and best-effort like every sibling.

**The ribbon says it is happening, and takes the quietest rung to say it.** `comboActivity` takes
`RANK.combos`, which sits *below* the Oracle-tag refresh at the bottom of a ladder whose top is
the sync. Two readings agree on that. What a combo failure costs is the fourth signal of
one advisory on Commander decks alone, where a taxonomy failure changes where every card a reader
adds to any deck is filed. And this is the longest job in the app, so a rank above the tags would
have one job hold the row for the whole of a launch and the two short refreshes running beside it
would never get a sentence at all. `useComboProgress` is the single subscription, mounted once in
`AppShell`; the `downloading` phase reports real bytes and gets a bar, and `ingesting` is emitted
**exactly once** over the 639 MB parse, so that phase gets a sentence and an indeterminate bar
rather than a number parked for minutes — a bar that does not move reads as a job that has
stalled, where the honest one reads as a job that is running.

**A run this window never heard start is a missing sentence rather than a wrong one.** The flag is
derived from the last `combos:progress` phase, because `ComboStatus` carries no `refreshing` field
at all — `combos::is_refreshing` is `#[cfg(test)]`. Since `refresh_if_due` is spawned before there
is a window, a launch's run can begin before the listener exists, and attaching mid-`ingesting`
catches nothing until `done`. Guessing from the status instead was rejected and would be worse:
`stale` says a refresh is *due*, not that one is running, and a failed fetch never moves
`checked_at` — so a machine that cannot reach Spellbook would carry that line in the ribbon for
ever. Both edges coming off one channel is also why nothing here polls, which is the one line
where it parts company with `useOracleTagProgress`.

**A finished download invalidates two roots, because two surfaces answer this question through
two reads.** The editor's advisory comes off `["combos", …]`; the gallery's tiles come off
`["decks", "brackets", …]`, where the combos arrive on `deck_bracket_reads` alongside the cards
they are estimated against. The two share no prefix, so `invalidateQueries` on the combo root
reaches no tile — and a download landing while the wall is on screen would refill whichever deck
the reader had open and leave every caption estimating from three signals until some unrelated
deck write fired `["decks"]`. That is the failure the automatic download exists to remove,
reproduced one surface over: correct data in the database, an old answer on the screen, nothing
visible to explain the difference. `useComboProgress` fires both on the same terminal phase, and
its test builds the gallery key with `deckBracketsKey` itself rather than typing it out, so a
renamed segment turns the prefix match off and turns the test red.

### What a failure does

**It leaves the previous combos exactly where they were.** The parse finishes before the write
begins; the write fills `combos_staging` / `combo_cards_staging`, which no reader can see, and is
promoted by one rename transaction that carries the `combo_meta` row with it — a watermark without
its rows would 304 past an empty database forever, and rows without their watermark would
re-download a file the database already holds.

**A file that yields zero storable combos is refused outright** (`ComboError::Empty`) rather than
swapped in, and the refusal happens before a single staging table is created. A swap there would
promote an empty table *and* stamp the ETag in the same transaction, so the next weekly check
would replay that ETag, be told 304, and keep an empty database forever with nothing in
`error_log` to say why. Refusing is what self-heals.

Every failure is written to `error_log` through `errors::record`. The source is
`Source::Database`, which is **not a good fit** — these are HTTP failures against
`json.commanderspellbook.com` — and it is borrowed for `marketplace_feed`'s reason: a source of
its own would need a CHECK rebuild on `error_log`, a new variant, and an arm in the frontend's
total `SOURCE_LABEL` map. The `operation` carries `combos` instead, that field being free text
precisely so a new call site can report a failure without a migration first.

**Nothing here may break a launch.** A database that has never fetched the file answers **every**
command — the card side's included, which answers an empty page for its own reason and is where
`NEVER_FETCHED` comes from — and `combos_status` is safe before the first refresh has ever run:
two zeros, three
nulls and `stale: true` rather than a rejection, so no caller needs a guard. That guarantee is
**more** load-bearing since the launch fetches on its own, not less: the refresh task is spawned
before there is a window, so the first thing a reader opens is asking a table that is mid-ingest,
never-ingested, or both in the same second.

**A first fetch that fails is retried at the next launch rather than throttled out for a week.**
`mark_checked` deliberately writes nothing when there is no `combo_meta` row — a watermark with no
rows behind it is what would make the next run 304 past an empty database — so a launch that could
not reach Spellbook leaves the database exactly as due as it was.

### Throwing the whole thing away

`combos_clear` empties `combo_cards`, `combos` and `combo_meta`, and it is a **debugging
affordance** — the answer to a combo table that looks wrong, and the only thing in the app that
can be done about one. It lives with the other local caches rather than with the deck — a second
button in **Local cache**, under Storage and data, beside the one that empties the image cache —
because that panel's subject is exactly what these tables are: bytes on disk this app can fetch
again.

**The `combo_meta` row is deleted rather than blanked.** No row is the never-ingested state the
whole module is already written against, and it is the state every reader of that table already
handles: `read_status` answers it with two zeros, three nulls and `stale: true`, `due_at_startup`
reads it as due, and `mark_checked` deliberately writes nothing over it. A row with its columns
nulled would be a **fourth** state, indistinguishable at a glance from the three and handled by
none of them.

**Two surfaces go into their never-fetched arm on that press, not one.** The deck advisory's
`never` and the card dialog's `NEVER_FETCHED` are both derived from `fetchedAt` being null, which
is why the row has to be *deleted* for either of them to be right — and it is the one place in
the app where a reader can reach that state on purpose, which is also what makes it storyable.
`schema::rebuild_combo_tables` deletes it for the same reason, one ladder over.

**`combo_cards` is emptied by its own statement even though `combo_id` CASCADEs**, and the child
goes first. `PRAGMA foreign_keys` is per-connection, and nothing about `clear_combos`' signature
says who set it on the connection handed in — so leaning on the cascade would be a clear that
works or leaves a table of orphans depending on a setting made somewhere else entirely. One
transaction, for the reason the swap is one: a clear that emptied `combos` and then failed would
leave a watermark describing rows that are gone.

**What makes the clear honest is `conditional_etag`, not the delete.** The stored ETag goes with
the row — but even if it did not, that helper asks whether there are *rows* behind an ETag before
replaying one, so a cleared database really re-downloads instead of being told 304 into staying
empty. That is the same guard the empty-file refusal above depends on, read from the other end.

**The press is two calls in one mutation, and that is the whole design.** `combos_clear`
downloads nothing, so a press that stopped there would leave a reader who came here *because* the
data looked wrong with no data at all, on a weekly schedule they cannot see. `useLocalCache`
awaits the clear and then a forced refresh inside one `mutationFn`: one `isPending` across both,
one refusal reaching the banner whichever of the two produced it, and no window in which the
button is idle over an empty table. The invalidation is `onSettled` rather than `onSuccess`,
because the clear lands **first** — a refresh that then fails has still emptied the tables, and
invalidating only on success would leave an open deck's advisory quoting a combo list that no
longer exists for `lib/query.ts`'s 30 s, which is exactly long enough to look deliberate.

## The manual override

**`decks.bracket INTEGER NOT NULL DEFAULT 0`, schema v26.** `0` is **Auto** — `AUTO_BRACKET`, in
both `src-tauri/src/deck.rs` and `@/lib/ipc` — and `1`–`5` are the reader's own answer.

**The sentinel is not a nullable column, and that is the decision worth knowing.**
`DeckPatch`'s convention is that an absent field means "leave it", written as
`coalesce(?n, column)`, which reads a bound NULL the same way — so a nullable column could not
express "put it back to Auto" without a command of its own or a double-`Option` across the whole
struct. It mirrors `decks.default_category_id`'s `AUTO_CATEGORY` deliberately, and the two are one
vocabulary.

**`0` is not "bracket 0", and the estimate's refusal to reach 5 is a different absence
altogether.** The sentinel says the reader has not answered; the missing 5 is a fact about the
rules. A deck can still be *set* to 5, which is exactly why the column takes it and the estimate
does not produce it.

The rest of the column's mechanics — where it rides, its `?` hole, its audit word, and what
`duplicate_deck` does with it — are in
[decks-storage.md](decks-storage.md) alongside every other `decks` column.

### The warning

A set bracket **below** the floor is the one mismatch worth a sentence, and `bracketWarning` is
the only place it is decided: the button's treatment and the panel's first line are both "that
function returned something", so the two cannot end up disagreeing about whether there is a
mismatch. The sentence names both numbers and one reason and stops:

> Set to bracket 2, but this deck reads as bracket 4 or higher (mass land denial: Armageddon) —
> worth a word with the table before the game.

On the button the same fact is drawn as `Bracket 2 · ~4` in a tinted accent surface —
deliberately neither of the format check's two colours, because a bracket 2 deck holding a
bracket 4 combo is not *broken* and is not *clean* either. It is two answers about one deck that
do not agree, and the honest way to draw that is to show both of them.

## The gallery asks the same question about forty decks at once (2026-09-07, issue #387)

The bracket left the deck header and joined the deck **tile**: every Commander deck on the wall
now carries `Bracket 3` or `Bracket ~3` in its caption. Nothing about the estimate changed — it
is literally the same `estimateBracket`, over the same rules and the same combo table — so this
section is only about the three things that are different when the question is asked of a
gallery instead of of the deck that is open.

### The vocabulary is `DeckBracket.tsx`'s and may not diverge

`bracketLabel` in `useDeckBrackets.ts` is written against `DeckBracket.tsx:223-224`. **`Bracket
3` is the reader's own answer; `Bracket ~3` is a reading.** The `~` is the whole of the visible
difference between the two and it means the same thing on a tile as on the editor's button — one
glyph a reader learns once. A tile that spelled a reading differently would be teaching a second
dialect of a distinction the app has already made.

**The editor's third form is deliberately not copied.** That button also draws `Bracket 2 · ~4`
when a set bracket sits below the floor, because it is a *control*: pressing it opens the
advisory that names the card responsible, so the second number is a question the reader can
immediately ask. A tile is not a control and has no room to explain a mismatch, and **a number a
reader cannot interrogate is worse than the one they chose** — it says "something disagrees with
you" and gives them nowhere to go. So a deck with a set bracket shows that bracket on the wall,
full stop, and the mismatch stays where `bracketWarning` can be acted on.

`null` is drawn as no bracket segment at all, and it covers both halves of "there is nothing to
say": a format with no command zone, and a deck on Auto whose estimate has not arrived or whose
read failed. **Never a placeholder** — no `Bracket ?`, no skeleton, no dash — because a tile that
flickered a placeholder into a real number on every gallery load would be drawing attention to a
query rather than to a deck.

### The tile reads the **live** list; the editor reads the tab you are standing on

This is the one way the two surfaces can honestly print different numbers about one deck, and it
is by design. `deck_bracket_reads` is `variant = 'live'`, always. The editor estimates over the
variant the reader is looking at, so **a deck left on the Theory tab reads its _plan_ in the
editor and its live list on the tile.** The tile is a fact about the deck; the editor is a fact
about what is on screen. A reader who has half-built a plan and sees the wall disagree with the
window they just closed is seeing that, and not a bug.

### `BracketCardFacts` — the narrowing `CardFacts` was refused, earning its way in

`estimateBracket` now takes `readonly BracketCardFacts[]`, which is
`Pick<CardFacts, "categoryActive" | "name" | "gameChanger" | "oracleText" | "faces">`. Those five
are exactly what it reads and there is no sixth: `categoryActive` is the filter, `name` is what
it dedupes and *names* by, `gameChanger` is the synced column, and `oracleText` plus `faces` are
the two greps' whole input. It never looks at a legality, a colour identity, a quantity or a
category kind — which is why a bracket can be read from a card list that has none of them.

`CardIdentity`'s own doc comment in `types.ts` already explains why `CardFacts` **itself** was
deliberately not narrowed to *it*, and
nothing about that has changed: the validation engine really does read `categoryKind`,
`categoryActive` and `quantity`, so narrowing the type every rule shares would be claiming a card
in a deck is no more than a card. What changed is that a **second surface** now asks the bracket
question, and a parameter typed `CardFacts` would have made `deck_bracket_reads`' five-field row
illegal at the type level while being perfectly sufficient at the value level. So the narrowing
is the shape of *one function's appetite*, not a claim about what a deck card is. A `DeckCard[]`
still satisfies it, so the deck editor's call site is untouched.

### What the whole-gallery read costs, and where it refuses

Measured on the dev database under `tauri dev` (a **debug** build), 2026-09-07 — 4 decks, 611
`deck_cards` rows: **397 distinct cards, 59 KB of oracle text** for one gallery. The SQL, the
pile it reads and the request-order contract are in
[decks-storage.md](decks-storage.md); two consequences belong here because they are about the
estimate rather than about the query:

- **A deck listing more than `combos::MAX_CARD_IDS` (1 000) distinct printings fails the whole
  call**, with `combos::TOO_MANY_CARDS`. That is `combos_for_cards`' behaviour propagated rather
  than caught, and it is the right refusal: a silently truncated id list would answer a *wrong*
  combo set, and `estimateBracket`'s own doc says the combos handed to it are **not re-checked**,
  so nothing downstream could tell. Against a Commander deck's hundred cards the bound is not
  close.
- **Which decks are asked about is a TypeScript decision.** `useDeckBrackets` takes the ids, and
  which formats have a command zone is `useFormatSpecs`' `commanderRule` — so a gallery of Modern
  decks asks for nothing and the query is `enabled: false`, costing no IPC call at all rather
  than a round trip that answers `[]`.

The query key is `["decks", "brackets", <ids, deduped and numerically sorted>]`, **under the
`["decks"]` root every deck write already invalidates** — so adding a card, moving one between
piles or switching a category off refreshes every tile's estimate for free, and no mutation has
to learn the key exists. Sorting the ids before they enter the key is `combosForCardsKey`'s rule
one feature over: the answer does not depend on the order, so two renders that arrived at the
same set of decks by different routes must ask one question and pay for one round trip. Only
`BracketEstimate.floor` is kept per deck — the Game Changer names, the denial, the extra turns
and both halves of the combo split have no room on a tile, and holding them would be a per-deck
object nothing reads for as long as the gallery is on screen.

**The gallery's `bracket` sort key ranks the set bracket and the estimate together**, through
`effectiveBracket` — the set number where the reader gave one, the floor otherwise, `null` where
there is neither. The two are one ladder on purpose: a reader ordering a wall by bracket is
asking *which of these are my heavier decks*, and answering with two separate ladders, the
declared ones and the estimated ones, would split the wall on a distinction they did not ask
about. The `~` in the caption is where that distinction is drawn, and it costs one glyph. A deck
with neither number sorts **last in the key's natural direction** and first when the direction is
reversed — `deckSort.ts` carries that rule and why it differs from `sorting.ts`' `nullsLast`.

## The card side: every combo that *names* one card (2026-09-08, issue #359)

**The opposite question, and a second statement rather than a parameter on the first.**
`match_combos` asks *which combos does this deck completely hold* and answers only the ones it
does. `card_combos` asks *which combos name this card at all*, makes no claim about the other
pieces, and is the only question a reader looking at a single card can be asking. Folding them
into one query would mean a `have = card_count` clause that is sometimes applied and sometimes
not — two queries wearing one name.

A `Combos` row on the card modal's rail opens `CombosDialog`. Each row draws the combo's pieces
as card art with the reader's own copy count under each, the bracket letter and what it means,
what the combo produces, both halves of the prerequisites, the numbered steps, the mana it needs
and a link to Spellbook's own page for the variant. Above them, a chip per combo size and an
**I own every piece** toggle. Paged 25 at a time behind **Show more**.

**The card is named by `oracle_id` and never by a printing id.** A combo is a fact about a
*card*, `combo_cards` is keyed on the oracle id, and asking about a printing would mean resolving
it first only to answer identically for all of them. `cardCombosKey` keys on the same thing, so
all four Lightning Bolts share one cached answer and stepping between two printings of the card
you are already reading about is not a refetch. **Both filters are in the key** rather than
applied to a cached superset, because neither is a subset operation: `cardCount` and `ownedOnly`
narrow in SQL *before* the page is cut, and filtering on the TypeScript side would filter page 1
of a match set that can run to thousands — a card with forty two-card combos reading *no two-card
combos*, confidently and with nothing on screen suggesting there was more to fetch.

### Three statements, in this order

1. **`counts_sql`** — one pass over every combo the card is in, answering three of the page's
   four numbers at once: `by_card_count` is the rows, `total` their sum, `owned_total` the sum of
   the third column, and `matching` the same sums over the buckets the filters keep. Four
   statements would be four scans to answer questions one scan already has in hand and — worse —
   four chances for the panel's chrome to disagree with itself about a set that has not changed.
2. **`page_sql`** — the rows, narrowed and ordered and `LIMIT`ed in SQL. `ORDER BY c.card_count,
   c.popularity DESC, c.id`: **`match_combos`' order with one term changed**, because a deck
   asking *what have I got* wants the combos it can be sure of (`template_count` first) while a
   reader asking *what does this card do* wants the two-card combos before the five-card ones.
3. **`pieces_sql`** — every card of every combo on that page, in **one** statement over the
   page's ids, folded back per combo **by id**. A statement per combo is 68 µs each; matching
   back by *position* would quietly mis-file every piece the moment a combo on the page turned
   out to have no rows at all.

The third is skipped when the page is empty, because `IN ()` is not SQL. The first two run
unconditionally — an unknown oracle id costs one index probe that finds nothing, and deciding to
skip the page from a count derived by the statement before it is exactly the shape that hides the
bug where those two disagree.

`MAX_PAGE` is **100**, and it is a ceiling on one *answer* rather than on the question — `total`
says how many there really are. It is **clamped and never refused**, unlike `MAX_CARD_IDS`: that
bound is a fact about a deck the reader assembled, this one is a number the page composed, and a
refusal a reader cannot act on is worse than a shorter list.

Two reads join the corpus to a piece and neither is spelled twice here. The **default printing**
is `deck_tokens`' `newest_printing` verbatim (`released_at DESC, set_code ASC, collector_number
ASC, id ASC`) — verbatim on purpose, because the art in this panel and the art of a token derived
from the same oracle card must not disagree about which printing *is* that card. The **owned
count** is `collection_source::copies_of_oracle` under `Availability::Everything` — `Everything`
and not `ForDeck`, because a locked folder is a drawer the app stops *offering* from and this
panel is stating a fact about the collection rather than offering to move anything out of it.

### The corpus these run against, measured

**2026-09-08**, against the live dev databases (`user.db` with `corpus.db` `ATTACH`ed,
read-only), through **Node 24.16.0's `node:sqlite`** driving each statement's own SQL text,
median of 9 runs. **This is not rusqlite in a debug build**: it measures the query plan, not the
binary, and none of it is comparable with the ingest figures above or with `combos_for_cards`'
21–38 ms.

| | |
| --- | --- |
| Feed version | 6.3.3, file stamp `2026-09-08T07:09:47Z` |
| Compressed | 27 785 378 bytes |
| Stored | **107 016** combos over **378 197** `combo_cards` rows |
| Distinct oracle ids appearing in a combo | **7 330** |
| Skipped | 1 519 variants |

**The distribution is the whole reason the dialog pages.** Combos by size, over the whole table:

```
1 → 7     2 → 5 104   3 → 47 967   4 → 45 670   5 → 8 231
6 → 25    7 → 6       8 → 1        9 → 4       10 → 1
```

…and per card it is far less flat than that. **Ashnod's Altar** (oracle
`4d18bcba-a346-445e-a182-6cc30b7e066d`) is in **6 044** combos — 2 → 61, 3 → 1 999, 4 → 3 016,
5 → 968 — and only **114** cards are in more than 500. So the one card a reader is most likely to
open this on is the one that would ask for six thousand rows, each carrying two to five pictures
and five prose sections. A page of 25 is nearer a screen of reading than the search wall's screen
of tiles, which is why it is 25 and not 60.

Every timing below is against that worst card unless it says otherwise:

| Query | Median |
| --- | --- |
| First page of 25, no filters | **85.9 ms** (min 84.3, max 92.0) |
| …with `ownedOnly` | 107.2 ms |
| …with a size filter | 101.7 ms |
| A page of 100 at offset 6 000 | 138.8 ms |
| A card at the **median** of the 7 330 | 7.5 ms |
| A card in no combo at all | 0.2 ms |

**Upper bound once the four prose columns carry data**, measured against a TEMP table with 301
bytes of prose on **every** row — deliberately an over-estimate, since most rows in the real feed
carry `""`: **~123 ms** first page, **~185 ms** at offset 6 000.

### What the real migrated corpus then measured — 2026-09-08, and it beat the estimate

The figures above were taken **before** corpus schema 2 existed, so the prose bound was a
projection. It has since been taken on the real thing: a copy of the dev pair at corpus
`user_version` **1** with the seven-column `combos`, migrated by launching the app, which dropped
the combo tables, re-downloaded the feed and re-ingested it. Same method as above — Node's
`node:sqlite` over each statement's own SQL, median of 9.

| | |
| --- | --- |
| Counts pass (the histogram) | **28.3 ms** (min 27.0, max 29.2) |
| Page of 25, no filters | **28.0 ms** (min 27.2, max 29.3) |
| The two together | **56.3 ms** |

So the populated columns cost **less** than the 301-byte-per-row projection, because the feed
really is mostly empty in three of the four: of 107 016 rows, **all** carry `description`, 47 612
carry `notable_prerequisites`, 43 484 a `mana_needed` and 21 694 an `easy_prerequisites`.

**One figure on that run was 552.9 ms and it is not a result.** It was the first read after the
re-ingest, against a database SQLite had just rewritten end to end — a cold page cache and a
full WAL, not a query plan. It is written down because it is the number a careless pass would
have reported: taken once, immediately after the thing that made it meaningless. Warm it up
before believing it.

### `CROSS JOIN` is worth 65 ms, and two other shapes were rejected

All three were measured against the same 6 044 rows on the same day:

- **A correlated `NOT EXISTS` per candidate combo** — 111–207 ms for `owned_total` alone,
  ~21 000 correlated probes.
- **`copies_of_oracle` over the hit set's distinct pieces** — 1.3–2.5 s.
- **The owned-oracle CTE written as a plain `JOIN`** — 72.7 ms. SQLite drove it from `cards`: a
  117 606-row scan of `idx_cards_collapse`, probing `collection_entries` for each.

**`CROSS JOIN` is SQLite's documented way to pin the outer loop**, and pinning it to the 276-row
collection takes the same answer to **7.1 ms**. One word, 65 ms.

### Two correctness fences in `OWNED_CTE`

```sql
owned(oracle_id) AS (
  SELECT DISTINCT k.oracle_id
    FROM collection_entries e CROSS JOIN cards k ON k.id = e.card_id
   WHERE k.oracle_id IS NOT NULL AND e.quantity > 0)
```

**`k.oracle_id IS NOT NULL` is correctness and not tidiness.** The column is nullable; one NULL
in this set makes `p.oracle_id IN (SELECT …)` return NULL for every *unowned* piece, and SQLite's
`min()` **skips NULLs** — so a combo with one owned piece and one unowned would answer
`all_owned = 1`. Every combo would report as fully owned and **I own every piece** would be a
silent no-op. It is the empty-set trap this repo has already paid for once, one operator over.

**`e.quantity > 0` is redundant against a healthy database and is here anyway**, which makes it
the one guard in that statement that is not load-bearing today. A collection row cannot hold zero
copies: `set_quantity(id, 0)` deletes the row, the user ladder's v24 rung deleted every stored
zero, and the importer's `set` mode does the same — which is exactly why
`collection_source::owns_printing` is allowed to be an `EXISTS` at all
([collection-folders.md](collection-folders.md), *Zero quantity deletes the row*).

It is here because of what the *disagreement* looks like if that invariant is ever broken
somewhere else. `ComboPiece.owned` sums quantity; `all_owned` tests presence. Without the clause
those two answer differently for a zero row, and the panel prints **Not owned** on a piece line
inside a combo it is simultaneously offering under **I own every piece** — one screen
contradicting itself about one card, with no error anywhere. **The Storybook fake reached that
state on the first try**, off a seed written before the zero-row rule changed. A guard that costs
nothing on 276 rows is cheaper than an invariant two modules have to keep agreeing about.

### Ownership is presence, never copies

`all_owned` asks whether the reader owns **any** copies of each card the combo names, and never
`owned >= quantity`. **A combo needing two Ashnod's Altars is fully owned by a reader holding
one.** That is `match_combos`' rule read one surface over — it asks whether a deck *lists* each
named card and never how many copies — and the alternative is a filter that hides an interaction
from the reader who is one copy away from it. `ComboPiece.owned` carries the count, so the piece
line can say *1 of 2 owned* and let the reader judge for themselves. The two numbers disagreeing
on purpose is the point; the two numbers disagreeing by accident is what `e.quantity > 0` above
is for.

### Four empty states, and the one that may never be collapsed

An empty box would read as *this card is in no combos*, which is a claim the dialog is very often
not entitled to make. So an empty answer always says **which** empty it is, and there are four:

| State | What it means | When it can be drawn |
| --- | --- | --- |
| `NO_ORACLE_CARD` | The printing is not linked to an oracle card | `CardDetail.oracleId` is null — a real state, a handful of rows are — and the one case where nothing is asked at all |
| `NEVER_FETCHED` | Spellbook's list has not been downloaded | `total === 0` **and** `ComboStatus.fetchedAt` is null |
| `NO_COMBOS` | Spellbook has none on record naming this card | `total === 0` and the feed *is* here |
| `NO_MATCH` | The reader's own filter left nothing | `total > 0` and `matching === 0` — so it can never stand in for the row above it, because a database with no rows has no chips to have narrowed with |

**`NEVER_FETCHED` may never be folded into `NO_COMBOS`, and that is the whole reason this dialog
reads `combos_status` at all.** `combos_for_card` cannot tell a card with no combos from a
database with no combo table, because both are zero rows — and the two answers are not close: one
is a fact about the reader's card, the other a fact about the reader's database. This is
`DeckBracket`'s `never` arm one surface over, and the advisory's argument holds here word for
word: a never-ingested table is where every install is **before its first launch fetch lands**,
where a machine that cannot reach Spellbook **stays for the whole session**, and — since
`combos_clear` — where a reader can deliberately put one back. Telling any of those three readers
"Commander Spellbook has no combo naming this card" is telling them something false about a list
that was never consulted.

Its *sentence* differs from the advisory's in one way and for the same reason the advisory's
changed: the download is automatic and there is no button for it anywhere in the app, so the
honest instruction is that **nothing here needs a press**.

**An unanswered status reads as never-fetched**, which is the safe way round. `combos_status`
reads one small table and makes no network call, so that branch is all but unreachable — and of
the two claims, "the file has not been downloaded" is the one that stays true of a database
nobody can read the status of. Both reads are awaited before anything is drawn, because the
sentence an empty answer gets is *decided* by the status row, and drawing early would flash
whichever of the two the default happened to be.

Three states above and beside those four are not empties at all and are drawn as themselves: the
card detail still loading, a printing the corpus has since dropped (`card_detail` answers `null`,
which a collection or deck holding a retired printing reaches honestly), and a failed read, which
says so and names the error rather than reading as an absence.

### Driven in the shipped window — 2026-09-08, debug build

Not the suite and not Storybook: a `tauri dev` window over a **copy of the real dev pair**, taken
at corpus `user_version` 1 with the seven-column `combos`, 107 016 combo rows and 117 628 cards.
The whole rung ran on launch, unattended.

**The migration, end to end.** `user_version` 1 → **2**; the four columns present and in the
feed's order between `produces` and `popularity`; `cards` still holding all **117 628** rows,
which is the assertion that the drop stayed narrow and did not take the corpus with it; and
`combo_meta.fetched_at` moved, so the launch refresh really did re-download 27.5 MB and re-ingest
it uninvited, arriving back at **107 016** rows. The prose is genuinely stored rather than
defaulted — the census in the timing section above is that check, and it is the one the widened
`combos_staging` INSERT would have failed silently.

**The dialog, on Ashnod's Altar.** The chips read `All · 6 044`, `2 cards · 61`, `3 cards · 1 999`,
`4 cards · 3 016`, `5 cards · 968` — the same census this document measured off SQL, arrived at
independently through the command, the IPC mirror and the component. Pressing `2 cards` gave
`SHOWING 25 OF 61` **with every chip's count unmoved**, which is the census-versus-`matching`
distinction working where a reader can see it; `Show more` went to `SHOWING 50 OF 61`; and
`I own every piece · 0` on top of it drew **"No combo matches that filter."** rather than the
never-fetched or the nothing-on-record sentence, which is the fourth empty state doing the one
job it exists for.

**What could not be driven.** The never-downloaded state, because this corpus has the feed and
the launch refresh fetches it uninvited — it is reachable only through Settings' *Clear combos*
without a relaunch, and it is covered in the suite and in Storybook instead.

## Where each piece lives

| File | Holds |
| --- | --- |
| `src-tauri/src/combos.rs` | The feed: client, streaming parse, staged write, `due_at_startup`, `clear_combos`, the commands, `combos:progress` — **and both match queries**: `match_combos`/`combos_for_cards` (*which combos does this pile of printings hold*, the deck advisory's and the gallery's fourth signal) and `card_combos`/`combos_for_card` (*which combos name this one oracle card* — `HIT_CTE`, `OWNED_CTE`, `GRP_CTE`, `counts_sql`, `page_sql`, `pieces_sql`, `MAX_PAGE`) |
| `src-tauri/src/schema.rs` | The v26 rung — `decks.bracket`, `combos`, `combo_cards`, `combo_meta`, the two indexes, and the staging twins — **and corpus schema 2**: `COMBO_TABLES_SQL`, `create_combo_tables`, `combos_are_at_head`, `COMBO_V2_COLUMNS`, `rebuild_combo_tables` |
| `src-tauri/src/deck.rs` | `AUTO_BRACKET`, `valid_bracket`, `BAD_BRACKET`, the column on `DeckRow`/`DeckPatch`/`DeckBefore` and the audit line — **and `deck_bracket_reads`**, with `BRACKET_CARDS_SQL` and `BRACKET_IDS_SQL` behind it |
| `src/lib/ipc.ts` | `AUTO_BRACKET`, `ComboBracketTag`, `DeckCombo`, `ComboStatus`, `ComboProgress` and the calls — plus `BracketCardRow`/`DeckBracketRead`/`deckBracketReads`, and the card side's `ComboPiece`/`CardCombo`/`ComboCountBucket`/`CardCombosPage`, plus `CardCombosQuery`, which mirrors no Rust struct and exists so the call site and `cardCombosKey` cannot disagree about what was asked |
| `src/lib/query.ts` | `COMBOS_KEY`, `COMBOS_STATUS_KEY`, `combosForCardsKey`, `cardCombosKey` — one root, so an ingest landing under an open deck or an open card refills it. The last two are **deliberately not both `"forCards"`**: every prefix-scoped TanStack operation matches by prefix, so one spelling would let a targeted invalidation of the cheap read throw away the expensive one |
| `src/features/decks/validation/types.ts` | `BracketCardFacts` — the five fields, and why the narrowing lives there and not on `CardFacts` |
| `src/features/decks/validation/bracket.ts` | The floor, the two greps, `COMBO_FLOOR`, `describeReason`, `bracketWarning` |
| `src/features/decks/DeckBracket.tsx` | The readout, the picker, the combo list, and the four states of the combo read — **and `COMBO_TAG`**, exported since the card side became its second reader, because two tables spelling Spellbook's seven letters are two things that can come to disagree about what `S` means |
| `src/features/card/CombosDialog.tsx` | The card side's whole surface: `PAGE_SIZE`, the two filters, the piece art and its owned mark, the four empty sentences, `AS_OF`, and the Spellbook permalink |
| `src/features/card/CardModalRail.tsx` | The `Combos` row — a noun in the first block, at the end of it, because nothing a reader has learnt the position of moves |
| `src/features/card/cardDetailKey.ts` | The one `card_detail` key the modal and all four of its overlays share, so opening this dialog is a cache read rather than a round trip |
| `src/features/decks/useDeckBrackets.ts` | The gallery's read, `deckBracketsKey`, `bracketLabel` and `effectiveBracket` — the wall's whole share of this document |
| `src-tauri/src/desktop.rs` | The launch task — its own, spawned after the two tagger refreshes and chained onto neither |
| `src/lib/useComboProgress.ts` | `COMBO_PHASE_LABEL`, the one `combos:progress` subscription, and the two roots a terminal phase invalidates — why the flag is derived from the event here and polled for the tags |
| `src/lib/activity.ts` | `comboActivity` and `RANK.combos` — the ribbon's sentence, and why the longest job takes the quietest rung |
| `src/features/settings/CachePanel.tsx` | The `Clear combos` button and its confirm — the only combo surface left in Settings |
| `src/features/settings/useDataReset.ts` | `useLocalCache` — the clear and the forced refresh as one mutation |
| `src/features/settings/clearOutcome.ts` | `combosOutcome` — what the press reports, counted off the *refilled* table |

## Sources

- [Introducing Commander Brackets Beta](https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta)
- [Commander Brackets Beta Update – October 21, 2025](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025)
- [Commander Brackets Beta Update – February 9, 2026](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026)
- [Commander Spellbook syntax guide](https://commanderspellbook.com/syntax-guide/)
- [The 2026-08-27 research](../superpowers/research/2026-08-27-commander-brackets-and-combos.md) — every rule and every pre-build measurement, verified live
