# Scryfall Art Tags, and the Tagger site — live-verified

**Measured 2026-08-20** from Windows, against `api.scryfall.com`, `data.scryfall.io`,
`tagger.scryfall.com` and the **2026-08-19T11:01:25+02:00 art-tags build**. Structural figures
came from parsing that build directly; corpus figures came from joining it against the local
card database (`src-tauri/target/debug/data/mtg.db`, 609 MB, synced 2026-08-18) with a
`node:sqlite` script. **None of it was read out of the shipped app** — the app has no art tags.

This is the companion to [the Oracle Tags research](2026-08-14-scryfall-oracle-tags.md). Read
that one for the oracle taxonomy, the anchor list and the deck-categorisation rule. This one
covers the **second** Tagger dataset and the Tagger site itself.

> ⚠️ **`scryfall.com/docs/*` and `tagger.scryfall.com` return HTTP 403 to a non-browser
> User-Agent** — the 2026-08-14 note said this of the docs site and it is true of Tagger too.
> The block is on the UA, not on authentication: `curl.exe` sending an ordinary Chrome UA gets
> HTTP 200 from both. `api.scryfall.com` wants `MTGGrimoire/0.1 (+…)` and answers normally.
> WebFetch cannot reach either HTML site; it is not a tooling bug to re-investigate.

## The bulk-data entry

`GET https://api.scryfall.com/bulk-data/art_tags`:

| field | value |
| --- | --- |
| `type` | `art_tags` |
| `id` | `48da5752-eeb6-4126-bf97-8829e20ad14f` |
| `name` | Art Tags |
| `description` | "A JSON file containing all art (illustration) tags sourced from Tagger, the Scryfall community tagging project." |
| `jsonl_download_uri` | `https://data.scryfall.io/art-tags/art-tags-20260819090125.jsonl.gz` |
| `compressed_size` | **12,544,874** bytes |
| `updated_at` | `2026-08-19T11:01:25.803+02:00` |

Post-2026-07-20 shape exactly as `oracle_tags` and `default_cards` are: **`jsonl_download_uri`
and `compressed_size` only**, with no `download_uri` and no `size`. There is no legacy
fallback on either the index endpoint or the per-type one.

**Cadence is daily, not weekly.** The root `CLAUDE.md` says of oracle tags "Weekly, ~5.85 MB";
the size is right and the cadence is the *app's refresh interval*, not the file's. Scryfall's
own `docs/api/tags` says "Tags are available as bulk data files and are updated **daily**", and
both files' `updated_at` were from the previous day when checked.

## Format and structure

Gzipped JSONL, one Tag object per line — the same envelope oracle tags use, and the **same 11
top-level keys**, present on 100% of records in both files:

```
object, id, label, slug, type, uri, description, parent_ids, child_ids, aliases, taggings
```

`type` is `"illustration"` on all 11,531 art lines and `"oracle"` on all 4,526 oracle lines.
A file never mixes the two. `uri` is `https://tagger.scryfall.com/tags/artwork/<slug>` for art
and `.../tags/card/<slug>` for oracle.

| | oracle_tags | art_tags |
| --- | ---: | ---: |
| compressed | 5,852,962 B | **12,544,874 B** |
| tags (lines) | 4,526 | **11,531** |
| roots (no parent) | 926 | **3,219** |
| tags with children | 676 | **1,738** |
| **tags with >1 parent** | 684 (15%) | **4,970 (43%)** |
| max depth | 5 | **10** |
| direct taggings | 229,856 | **475,163** |
| distinct subjects | 35,969 `oracle_id` | **52,349 `illustration_id`** |
| tags with a description | 1,340 (30%) | 1,847 (16%) |
| tags with aliases | 728 | 1,028 |

This build has **no cycles and no dangling parent ids**. Neither is guaranteed by the format;
the walk needs a visited set and a missing-id guard regardless — the 2026-08-14 rule, and it
matters more here, where 43% of tags are multi-parent and the graph runs to depth 10.

### `taggings[]` keys on `illustration_id`

**This is the structural fact that separates the two datasets, and the one an implementation
built from the oracle path will get wrong.**

```json
{"illustration_id": "baa61cf8-613e-49d3-bfd8-246824b1536e", "weight": "very_strong"}
```

| field | oracle_tags | art_tags |
| --- | ---: | ---: |
| `oracle_id` | 229,856 (always) | — |
| `illustration_id` | — | 475,163 (always) |
| `weight` | 229,856 (always) | 475,163 (always) |
| `annotation` | 3,292 (1.4%) | 4,587 (1.0%) |

`annotation` is **omitted entirely when absent** — it is not `null`. `description` *is* `null`
when absent. Two different absences in one object.

Scryfall's own joining guidance agrees: art taggings join on `illustration_id` against Unique
Artwork; oracle taggings join on `oracle_id` against Oracle Cards.

**And this is semantically right rather than an inconvenience.** An art tag is a fact about an
*illustration*, so it belongs to the printings that carry that art and to no others. A card
with five arts has five illustrations and the dog is in one of them. Rolling an art tag up to
the oracle card would file four printings under a motif they do not depict.

### `weight` carries real signal here, where it carries none for oracle tags

| weight | oracle_tags | art_tags |
| --- | ---: | ---: |
| `median` | 229,248 | 462,008 |
| `very_strong` | 607 | **2,680** |
| `strong` | **1** | **5,980** |
| `weak` | **0 — never appears** | **4,495** |

Scryfall's definitions, from `docs/api/tags`:

> `very_strong` — The subject is exemplary for the image or card text.
> `strong` — The subject is a primary focus of the image or card text.
> `median` — A normal tagging with no special weight applied.
> `weak` — The subject is a minor detail or background element.

The 2026-08-14 conclusion — "the app cannot rank a card's tags by confidence" — is a statement
about **oracle** tags and does not carry over. `strong` occurs exactly once in the entire
oracle file; art tags use the full four-value scale, and `weak` distinguishes "a castle is the
subject" from "a castle is a speck on the horizon". That is a distinction an art-theme search
can act on.

**Casing trap:** bulk data is lowercase snake (`very_strong`); Tagger's GraphQL API returns the
same values uppercase (`VERY_STRONG`).

## The hierarchy is load-bearing, and the bulk file stores direct taggings only

**A category tag has no taggings of its own.** `removal` has **zero** direct taggings and 25
children; `otag:removal` nonetheless returns thousands of cards. Scryfall states the rule:

> **The bulk data only includes direct taggings.** A parent tag such as `animal` will have no
> direct taggings of its own — to find all illustrations tagged `animal`, traverse its
> `child_ids`, find those tags in the bulk data, and collect their `taggings`.

Verified two independent ways. **Set subtraction against the live API** — every child-minus-parent
query returns zero:

```
otag:removal-creature -otag:removal   -> 0
otag:"spot removal"   -otag:removal   -> 0
otag:sweeper          -otag:removal   -> 0
atag:"red dragon"     -atag:dragon    -> 0
atag:dragonborn       -atag:dragon    -> 0
otag:removal -otag:removal-creature   -> 934   (the parent is a strict superset)
```

**And the arithmetic closes exactly.** A local transitive rollup of `removal` over the bulk file
gives 55 descendant tags and 6,686 distinct oracle ids:

```
otag:removal                  -> 6428   (a default search hides "extras")
otag:removal include:extras   -> 6686   <- the local rollup, to the card
```

Art tags behave the same way, and the hierarchy is worth far more there than the raw counts
suggest. Reach, following every parent edge, over the 2026-08-19 build:

| motif | direct taggings | reach via hierarchy |
| --- | ---: | ---: |
| `dragon` | 416 | **1,660** |
| `cat` | 150 | **1,248** |
| `forest` | 1,507 | **1,996** |
| `skeleton` | 537 | **710** |
| `knight` | 461 | **473** |
| `dog` | 137 | **439** |
| `castle` | 233 | **239** |

`dog` is the shape of the whole argument: a direct-taggings-only implementation returns 31% of
the dogs and looks like it is working.

⚠️ **One art figure did not reconcile and is recorded as unverified.** A local rollup of
`dragon` gave 1,660 illustration ids; `atag:dragon include:extras unique=art` reported 1,770.
The gap is 110. Plausible causes are the art file's older stamp (11:01 against the oracle
file's 21:00) and `unique:art` counting semantics, neither confirmed. The oracle side closed to
the card, so this is not a defect in the rollup method itself.

### The closure doubles the row count

Expanding every tagging to the tag **and every ancestor of that tag**, following every parent
edge:

| | rows |
| --- | ---: |
| direct art taggings | 475,163 |
| **art closure** | **951,499** |
| expansion factor | **2.0×** |

For comparison the oracle side expands 229,856 direct taggings into the `oracle_tag_cards`
table the app already carries.

## Coverage over the app's own corpus

Against the local database, 2026-08-20:

| | |
| --- | ---: |
| printings in `cards` | 116,712 |
| printings with an `illustration_id` | **111,735 (95.7%)** |
| distinct local illustration ids | 50,536 |
| **…that the art file tags** | **50,435 (99.8%)** |
| tagged illustration ids in the file | 52,349 |
| …that exist in the local corpus | 50,435 (96.3%) |
| paper printings | 107,355 |
| paper printings with an `illustration_id` | 102,522 |

**Art-tag coverage of this corpus is effectively total** — 99.8%, against oracle tags' 93.1%.
Unlike the oracle side there is no meaningful "untagged" population to design a fallback for.

> ⚠️ **`cards.illustration_id` has no index.** The four indexes on `cards` are
> `idx_cards_oracle`, `idx_cards_set_cn`, `idx_cards_name` and `idx_cards_collapse`, plus the
> primary key. A loop of 50 k point lookups on `illustration_id` against the 609 MB database
> did not finish in five minutes and had to be killed — which is the measurement. Any art-tag
> join needs `idx_cards_illustration`, and it belongs in `CARDS_INDEXES`, because
> `swap_staging` drops and recreates `cards` on every sync.

## The Tagger site

A Vue SPA; every route returns the same ~30 KB shell and renders client-side. The router table,
extracted from `https://tagger.scryfall.com/vite/assets/application-DDoaq1k-.js`:

```
/  /random  /search  /card/:set/:number/:back?  /tags/:type/:slug
/users/:username  /change-requests  /forbidden
/history/:type(tag|tagging|relationship)/:id      /admin/…
```

**`:type` is `card` or `artwork` — not `oracle`:**

```
200  https://tagger.scryfall.com/tags/card/removal      <- an oracle tag
200  https://tagger.scryfall.com/tags/artwork/dragon    <- an art tag
200  https://tagger.scryfall.com/card/mh1/1
404  https://tagger.scryfall.com/tags/oracle/removal
404  https://tagger.scryfall.com/tags                   <- there is no index route
```

Each file's own `uri` field agrees, on every line of both.

### The three screens

- **Landing (`/`)** — a search box placeheld *"search tags or scryfall"*, nav of Guide / Tags /
  sign-in, the tagline *"A crowdsourced tag catalog for Magic: The Gathering cards &
  illustrations"*, buttons for Search Syntax and Random Card, and a card of **12 randomly
  sampled tags**, each with an icon marking its namespace (brush = artwork, card = oracle).
  **There is no browsable A–Z index anywhere on Tagger.**
- **Tag page (`/tags/card/removal`)** — the tag name with a category crown and an outbound link
  to Scryfall search; a **"6,686 taggings"** line; the description in italics; a collapsed
  **"child tags +"** disclosure; pagination to 90 pages; then a grid of card images, **75 per
  page**. A gold star under a card marks a `very_strong` weight.
- **Card page (`/card/mh1/1`)** — the card image and **two separately-headed tag sections,
  "Artwork" and "Card"**, each a two-column list. Weight and annotation render as glyphs: gold
  star `very_strong`, red down-triangle `weak`, speech bubble = has an annotation. Below each
  section an italic **"Inherits — animal, character, elephant, …"** row lists the *ancestor*
  tags separately from the directly-applied ones. Reading is public; a banner notes that
  submitting tags needs a Scryfall supporter account.

**The real browsable index is the docs page**, `scryfall.com/docs/tagger-tags` — an A–Z listing
with paired `<h2>` sections per letter (`A` for art tags, `A (functional)` for oracle), 18,200
links in total.

### What Tagger's GraphQL exposes that the bulk file does not

`POST https://tagger.scryfall.com/graphql`, needing a `_scryfall_tagger_session` cookie and the
`X-CSRF-Token` from the home page's `<meta name="csrf-token">`; without both it answers **422**.
Anonymous access otherwise works.

- **`ancestry { path tag {…} }`** — root-to-node paths. **Not in the bulk file**; reconstruct it
  locally from `parent_ids`.
- **Relationships** — a whole taxonomy declared in the home page's `<script type="config">`:
  `BETTER_THAN`/`WORSE_THAN`, `COLORSHIFTED`, `COMES_BEFORE`/`COMES_AFTER`,
  `DEPICTS`/`DEPICTED_IN`, `MIRRORS`, `REFERENCES_TO`/`REFERENCED_BY`, `RELATED_TO`,
  `SIMILAR_TO`, `WITH_BODY`/`WITHOUT_BODY`. These hang off **cards**, not tags, and **none of
  them are exported to bulk data.** Recreating them would mean scraping.
- `taggings` takes a `descendants: Boolean = false` argument, and reports `total` and
  `perPage: 75`.

## Search syntax

Verbatim from `scryfall.com/docs/syntax`:

> **Tagger Tags** — You can use `art:`, `atag:`, or `arttag:` to find things in a card's
> illustration. You can use `function:`, `otag:`, or `oracletag:` to find "Oracle" tags which
> describe the function of the card.

Every documented spelling returns byte-identical totals against `api.scryfall.com/cards/search`:

| oracle | `…:removal` | art | `…:dragon` |
| --- | ---: | --- | ---: |
| `otag:` `oracletag:` `function:` | 6,428 | `atag:` `arttag:` `art:` | 1,145 |
| `oracle_tag:` `oracle-tag:` | 6,428 | `art_tag:` | 1,145 |
| `functions:` `ftag:` `otags:` | HTTP 400 | `itag:` `illustration_tag:` | HTTP 400 |

Separators are normalised out of the keyword too, which is why the `_` and `-` variants work.

**A third namespace exists and is unreachable.** Tagger's config declares `PRINTING_TAG`
("print tag", keyed on `printingId`) beside `ILLUSTRATION_TAG` and `ORACLE_CARD_TAG`. It has no
bulk export and no search keyword — `ptag:`, `printtag:` and `print:` all return HTTP 400.

### No substring, no prefix, no wildcard

```
otag:remov     -> 404      atag:drag    -> 404
otag:remova    -> 404      atag:drago*  -> 404
otag:/remov/   -> 400 (terms ignored)
otag:*spot*    -> 404      <- decisive: 4,907 if `*` expanded
otag:*removal* -> 6428     otag:removal* -> 6428     otag:remov*al -> 6428
```

Wildcards **look** like they work and do not: `*` is stripped as punctuation rather than
expanded, proven by `otag:*spot*` returning nothing while `otag:"spot removal"` returns 4,907.
Exact tag identity is required. Anything offering type-ahead over these tags has to build its
own index.

### Matching is aggressively normalised

Every one of these returns exactly 4,907:

```
otag:"spot removal"  otag:spot-removal  otag:spotremoval  otag:SPOT-REMOVAL
otag:Spot-Removal    otag:spot_removal  otag:spot.removal otag:"SPOT  REMOVAL"
```

The matcher lowercases and strips every non-alphanumeric. **Normalising `[^a-z0-9]` → `""` on
both sides of a lookup reproduces Scryfall's behaviour exactly**, and it is also what
reconciles the bulk file's spaced aliases (`ability counter`) with the docs index's hyphenated
slugs (`ability-counter`). A naive slug-to-slug comparison of the two appears to show ~250
missing oracle tags; that is entirely this artifact.

Normalised, the bulk files are effectively complete against the docs index:

```
ART     docs=12,810  bulk=12,880  docs-not-in-bulk=5   bulk-not-in-docs=75
ORACLE  docs=5,339   bulk=5,346   docs-not-in-bulk=0   bulk-not-in-docs=7
```

## Rate limits and terms

From `docs/api/rate-limits`:

> `/cards/search`, `/cards/named`, `/cards/random`, `/cards/collection` — 2/second ·
> `/cards/manifest` — 10/minute · **All other methods — 10/second**
>
> **The direct file origins located at `*.scryfall.io` do not have rate limits.**
>
> Receiving an HTTP 429 will result in your access being limited for 30 seconds. […] It is not
> acceptable to ignore HTTP 429 responses.
>
> We encourage you to cache the data you download from Scryfall […] **at least for 24 hours.**

**There is no rate-limit argument against shipping art tags.** The 12.5 MB download comes from
`data.scryfall.io`, which is unmetered; only the `/bulk-data/art_tags` lookup that resolves the
timestamped URL is rate-limited, under the generous 10/second bucket. Both tag files together
downloaded in **0.67 s**.

The binding constraints are policy, from `docs/api`:

> You may not simply repackage, republish, or proxy Scryfall data. **Your software must create
> additional value for end-users.**

And two Tagger-specific warnings from `docs/api/tags` that are product requirements rather than
notes:

> Tag data is subject to change as the community adds, edits, and removes tags. Scryfall
> performs content moderation on Tagger data. **However, we cannot guarantee that tag data is
> 100% free from intentional errors or abuse.**
>
> **Do not treat tag slugs or labels as permanent identifiers** in your application. Use the
> `id` field (a stable UUID) to track specific tags across data updates.
>
> **Downstream applications are strongly recommended to implement a way to temporarily disable
> display of individual tags.**

The `id` warning bears directly on this app: `schema.rs` keys `oracle_tags` on the **slug**,
deliberately and with a comment saying so. That is safe for *storage*, because the taxonomy is
dropped and rebuilt wholesale on every ingest — but it is not safe for anything that *persists*
a slug across ingests, which today is the deck categoriser's hard-coded anchor list and
tomorrow is any saved tag selection. Store the `id` alongside the slug.

## Reproducing the numbers

`api.scryfall.com` requires a User-Agent; `data.scryfall.io` is unauthenticated and unmetered.
The HTML sites need a *browser* UA.

```sh
UA='MTGGrimoire/0.1 (+https://github.com/Msgaihede/mtg-grimoire)'

curl -sS -H "User-Agent: $UA" -H 'Accept: application/json' \
  https://api.scryfall.com/bulk-data/art_tags

URI=$(curl -sS -H "User-Agent: $UA" -H 'Accept: application/json' \
  https://api.scryfall.com/bulk-data/art_tags | jq -r .jsonl_download_uri)
curl -sS -o art-tags.jsonl.gz "$URI"

gzip -dc art-tags.jsonl.gz | wc -l        # 11531
```

Structure, weights and the closure — build the child map from `parent_ids` (every edge, never
`child_ids`, and never `parent_ids[0]`) and walk:

```python
import gzip, json
from collections import Counter

tags  = [json.loads(l) for l in gzip.open('art-tags.jsonl.gz', 'rt', encoding='utf-8')]
by_id = {t['id']: t for t in tags}

len(tags)                                                      # 11531
sum(1 for t in tags if len(t['parent_ids']) > 1)               # 4970
sum(len(t['taggings']) for t in tags)                          # 475163
len({g['illustration_id'] for t in tags for g in t['taggings']})  # 52349
Counter(g['weight'] for t in tags for g in t['taggings'])
# {'median': 462008, 'strong': 5980, 'weak': 4495, 'very_strong': 2680}

anc = {}
def ancestors(tid, stack=()):                 # visited set + dangling-id guard
    if tid in anc: return anc[tid]
    if tid in stack or tid not in by_id: return set()
    out = set()
    for p in by_id[tid]['parent_ids']:
        if p in by_id:
            out.add(p); out |= ancestors(p, stack + (tid,))
    anc[tid] = out
    return out

closure = {(g['illustration_id'], i)
           for t in tags
           for i in {t['id']} | ancestors(t['id'])
           for g in t['taggings']}
len(closure)                                                   # 951499
```

Corpus coverage, against the dev database (`src-tauri/target/debug/data/mtg.db` under
`npm run tauri dev` — **not** `src-tauri/data/`), read-only through Node 24's built-in
`node:sqlite`:

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(".../mtg.db", { readOnly: true });
db.prepare("SELECT count(*) n FROM cards").all();                                  // 116712
db.prepare("SELECT count(*) n FROM cards WHERE illustration_id IS NOT NULL").all(); // 111735
db.prepare("SELECT count(DISTINCT illustration_id) n FROM cards \
            WHERE illustration_id IS NOT NULL").all();                             // 50536
```

⚠️ Do **not** measure per-illustration printing counts with a loop of point lookups until
`idx_cards_illustration` exists — see the warning above; 50 k of them do not finish.
