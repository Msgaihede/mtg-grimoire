# Commander brackets: the floor, the four signals, and the combo feed

What the bracket readout on a Commander deck's header says, what it is allowed to conclude, and
where the one signal that is not in a card's own text comes from.

The rules are the Commander Format Panel's and the combo classifications are Commander
Spellbook's editors'. Both were verified live on **2026-08-27** and are recorded in
[the research](../superpowers/research/2026-08-27-commander-brackets-and-combos.md), which is
the source; this document is the reference the shipped code is held to and does not restate it.

**Every duration below was taken on Windows against a _debug_ build**, by
`combos::tests::live_ingest` — an `#[ignore]`d test in `src-tauri/src/combos.rs` that exists so
these can be re-taken rather than trusted. A release build can differ by ~8×, which is the root
`CLAUDE.md`'s standing rule, so no timing here appears without the build it was taken on.

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
  succession or looped", so one Time Warp is now what lifts a deck off the bottom.
- **Mass land denial became a bracket-4 signal.** It mapped to **5** here, on the argument that
  a deck playing it "has decided something about the table" — an over-read the file made on
  purpose and which the current text simply contradicts. One Armageddon does not make a cEDH
  deck.
- **The number stopped being a bracket and became a floor**, and stopped being able to reach 5
  at all. Both have sections of their own below.

The clauses the bracket picker draws beside each rung (`BRACKETS` in `DeckBracket.tsx`) are that
table paraphrased, and 5's clause says out loud what no card list can show — see **Why the floor
is never 5**.

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
1  none of the above
```

Highest wins. Two things about the shape rather than the numbers:

- **A rule that fired below the floor is a signal, not a reason.** Every entry in
  `BracketEstimate.reasons` forces the floor the estimate reports; the rest are still listed by
  name on the estimate's own fields (`gameChangerNames`, `massLandDenial`, `extraTurns`), which
  is what the advisory's *What this read* disclosure draws. `reasons` is empty exactly when the
  floor is 1.
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

## Why the floor is never 5

**Brackets 4 and 5 have identical _deck_ restrictions.** Both allow unlimited Game Changers,
mass land denial, extra turns and two-card combos. What separates them is whether the deck is
built for the cEDH metagame — an intent, not a card. An estimator that reads card contents can
therefore never honestly return 5, so this one does not, and `bracket.ts`'s module header says
where the old `bracket: 5` went for the reader who remembers it.

A reader who is playing cEDH sets 5 by hand. That is the whole reason the picker exists, and it
is why `decks.bracket` accepts a number the estimate cannot produce.

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

Four signals. Three come from data the app always has; the fourth is a feed that may never have
been fetched.

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
`imageUri*` fields plus a type line, and every variant carries a description, notes and prices.
None of it is wanted, so the ingest is streaming end to end: byte stream → a temp file under
`tmp/` → `flate2::read::GzDecoder` → `serde_json` with a `DeserializeSeed` over the `variants`
array, one variant live at a time. `from_str` on 639 MB is not available and neither is
`serde_json::Value`. `MAX_FEED_BYTES` (128 MiB) is checked against the declared `Content-Length`
*and* against the running total, because a chunked response declares nothing.

### What survives the reduction

Per variant: the id, `bracketTag`, colour identity, popularity, how many `requires[]` templates
it also needs, and its `produces[]` feature names `\n`-joined. Per `uses[]` entry: an oracle id,
a name, a quantity, and whether the card must be the commander. Everything else is stepped over.

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

### Weekly, against a file that rotates continuously

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

**Nothing downloads until a reader asks.** `refresh_if_due` returns immediately on a database
whose `fetched_at` is NULL — the difference between it and `tags::refresh_if_due`, and the
deliberate one: the tag files are what a deck add is filed by, so a first run fetches them
uninvited, while combos are the fourth signal and a database without them simply reads three.
Once a reader has pressed Refresh in Settings, launches keep it current. That is also what lets
the Settings panel say "never fetched" and mean it.

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

**Nothing here may break a launch.** A database that has never fetched the file answers all three
commands, and `combos_status` is safe before the first refresh has ever run: two zeros, three
nulls and `stale: true` rather than a rejection, so no caller needs a guard.

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

## Where each piece lives

| File | Holds |
| --- | --- |
| `src-tauri/src/combos.rs` | The feed: client, streaming parse, staged write, the match query, three commands, `combos:progress` |
| `src-tauri/src/schema.rs` | The v26 rung — `decks.bracket`, `combos`, `combo_cards`, `combo_meta`, the two indexes, and the staging twins |
| `src-tauri/src/deck.rs` | `AUTO_BRACKET`, `valid_bracket`, `BAD_BRACKET`, the column on `DeckRow`/`DeckPatch`/`DeckBefore` and the audit line |
| `src/lib/ipc.ts` | `AUTO_BRACKET`, `ComboBracketTag`, `DeckCombo`, `ComboStatus`, `ComboProgress`, and the three calls |
| `src/lib/query.ts` | `COMBOS_KEY`, `COMBOS_STATUS_KEY`, `combosForCardsKey` — one root, so a refresh in Settings refills an open deck's advisory |
| `src/features/decks/validation/bracket.ts` | The floor, the two greps, `COMBO_FLOOR`, `describeReason`, `bracketWarning` |
| `src/features/decks/DeckBracket.tsx` | The readout, the picker, the combo list, and the four states of the combo read |
| `src/features/settings/CombosPanel.tsx` | What is ingested, how old, the Refresh and its progress line |

## Sources

- [Introducing Commander Brackets Beta](https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta)
- [Commander Brackets Beta Update – October 21, 2025](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025)
- [Commander Brackets Beta Update – February 9, 2026](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026)
- [Commander Spellbook syntax guide](https://commanderspellbook.com/syntax-guide/)
- [The 2026-08-27 research](../superpowers/research/2026-08-27-commander-brackets-and-combos.md) — every rule and every pre-build measurement, verified live
