# Commander brackets, brought current — and where combo data comes from

Live-verified 2026-08-27. Everything below was fetched on the day, and the parts that are
measurements say what they were measured against.

The app's bracket estimator (`src/features/decks/validation/bracket.ts`) was written against the
**February 2025 beta announcement** and has been wrong since **21 October 2025**. This document is
the replacement source.

## 1. The bracket system as it stands today

Governance is the WotC Commander Format Panel; `magic.wizards.com/en/formats/commander` is the
page, and `mtgcommander.net` is stale (the 2026-08-04 domain-rules research already said so).

Three announcements matter, in order:

| Date | What it did |
| --- | --- |
| [2025-02, Introducing Commander Brackets Beta](https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta) | The five brackets, with hard prohibitions per bracket. **What this app implements.** |
| [2025-10-21 update](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025) | Re-based every bracket on an **expected earliest game-ending turn**, and **removed the tutor limits from every bracket**. |
| [2026-02-09 update](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026) | Game Changers only — `Farewell` and `Biorhythm` added. Explicitly *"we really want to cool it on bracket-level changes for the time being"*, so October 2025 is the live wording. |

### The current table

| Bracket | Earliest game end | Game Changers | Mass land denial | Extra turns | Tutors | Two-card infinite combos |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Exhibition | turn 9+ | none | no | **no** | unrestricted | no |
| 2 Core | turn 8+ | none | no | low quantities, not chained | unrestricted | no |
| 3 Upgraded | turn 6+ | **up to 3** | no | low quantities, not chained | unrestricted | no *early-game* ones |
| 4 Optimized | turn 4+ | unlimited | yes | yes | unrestricted | yes |
| 5 cEDH | any turn | unlimited | yes | yes | unrestricted | yes |

Three consequences the app has to act on:

* **Tutors are no longer a signal at any bracket.** `bracket.ts`'s `isTutor` is the *only* thing
  separating its bracket 1 from its bracket 2, and that separation no longer exists in the rules.
* **Mass land denial is a bracket-4 signal, not a bracket-5 one.** The app maps
  `massLandDenial > 0 → 5` today. One Armageddon does not make a cEDH deck.
* **Brackets 4 and 5 have identical *deck* restrictions.** The only thing separating them is
  whether the deck is built for the cEDH metagame, which is an intent no card list can show. An
  estimator reading card contents can therefore never honestly return 5.

Extra turns split 1 from 2 now that tutors do not: bracket 1 forbids them outright, bracket 2
allows them "in low quantities … not intended to be chained in succession or looped".

## 2. Two-card infinite combos need a data source

The three restrictions above that this app can already see come from a column
(`cards.game_changer`) and two oracle-text greps. The fourth — combos — cannot be read out of a
card's own text at all: it is a fact about an *interaction*.

[Commander Spellbook](https://commanderspellbook.com) is the community database of them, and it
publishes a public, unauthenticated bulk file.

### The bulk file, measured

```
GET https://json.commanderspellbook.com/variants.json.gz
```

| | |
| --- | --- |
| Compressed | **27 542 314 bytes** (range request, `Content-Range: bytes 0-1023/27542314`) |
| Uncompressed | **639 585 506 bytes** (`Content-Length` on `variants.json`) |
| Rotation | continuous — the `timestamp` in the file read `2026-08-27T03:12:44Z` when fetched at 03:32Z |
| Shape | one object: `{ timestamp, version, variants: [ … ] }` |
| Auth | none. `HEAD` on the `.gz` answers 200; every other filename tried (`.zip`, `variants_lite.json`, `combos.json`, `properties.json`, `.br`) answers 403. |

**The 23× expansion is almost entirely Scryfall image URLs.** Every `uses[].card` carries ten
`imageUri*` fields plus `typeLine`, and every combo carries `description`, `notes` and `prices`.
None of it is wanted here. A streaming parse that keeps `oracleId`, `name`, `quantity` and
`mustBeCommander` per card, plus a handful of scalars per variant, discards the great majority of
the bytes without ever holding them.

### The fields worth keeping

Confirmed against the OpenAPI schema at `https://backend.commanderspellbook.com/schema/` and
against the first variant of the live file.

* `id` — string, e.g. `"1957-4050-7918--204"`.
* `status` — `N` New · `D` Draft · `NR` Needs Review · `OK` Ok · `E` Example · `R` Restore ·
  `NW` Not Working. **Only `OK` is a published combo.**
* `legalities.commander` — boolean. The only format this feature is about.
* `uses[]` — `{ card: { name, oracleId, … }, quantity, mustBeCommander, … }`.
* `requires[]` — *templates*, e.g. "a creature with flying". Not resolvable to card ids.
* `produces[]` — `{ feature: { name, … }, quantity }`, e.g. `Infinite lifegain`.
* `identity` — colour identity of the combo.
* `popularity` — integer or null; how many decks Spellbook has seen it in.
* **`bracketTag`** — the field this whole feature turns on. See below.

### `bracketTag` — Spellbook has already done the classification

`BracketTagEnum` in the schema, with the descriptions from the
[syntax guide](https://commanderspellbook.com/syntax-guide/):

| Code | Name | Spellbook's own words | Bracket floor this implies |
| --- | --- | --- | --- |
| `E` | Exhibition | "For any deck" | 1 |
| `C` | Core | "For unoptimized decks in bracket 2+" | 2 |
| `O` | Oddball | "Probably 2 or 3, but hard to classify" | 2 |
| `P` | Powerful | "For strong decks in bracket 3+" | 3 |
| `S` | Spicy | "Probably 3 or 4, but hard to classify" | 3 |
| `R` | Ruthless | "For competitive decks at brackets 4+" | 4 |
| `B` | Banned | "Not legal in Commander" | none — a legality finding, which the app's own engine already reports from the banned list |

That table is why this app does not have to decide what "an intentional early-game two-card
infinite combo" is. Spellbook's editors decided it per combo; the ingest carries their letter
through, and the estimator turns it into a floor.

### The endpoints deliberately not used

* `POST /find-my-combos` — works (tested: a four-card probe found Thassa's Oracle + Demonic
  Consultation, 200, 66 030 bytes). Rejected because it sends the reader's decklist to a third
  party on every check, which is a shape no other feed in this app has.
* `POST /estimate-bracket` — Spellbook will estimate a whole deck's bracket. Same objection, and
  it would move a domain conclusion off this machine.

Its response shape is worth recording anyway, because it confirms the four signals are the right
four: `EstimateBracketResult` is `{ bracketTag, cards[], templates[], combos[] }`, where a
`ClassifiedCard` is `{ card, quantity, banned, gameChanger, massLandDenial, extraTurn }` and a
`ClassifiedVariant` carries `arguablyTwoCard`, `definitelyTwoCard`, `speed`, `massLandDenial`,
`extraTurn` and `lock`. Game Changers, mass land denial, extra turns, combos — the same four this
app reads, three of them from data it already has.

## Sources

- [Introducing Commander Brackets Beta](https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta)
- [Commander Brackets Beta Update – October 21, 2025](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025)
- [Commander Brackets Beta Update – February 9, 2026](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-february-9-2026)
- [MTG Commander Format](https://magic.wizards.com/en/formats/commander)
- [Commander Spellbook syntax guide](https://commanderspellbook.com/syntax-guide/)
- [Commander Spellbook API schema](https://backend.commanderspellbook.com/schema/redoc/)
