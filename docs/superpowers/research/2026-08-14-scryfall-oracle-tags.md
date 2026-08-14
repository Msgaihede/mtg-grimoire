# Scryfall Oracle Tags — live-verified

**Measured 2026-08-14** from Windows, against `api.scryfall.com` and the
**2026-08-13T23:00:41+02:00 oracle-tags build**. Every structural figure here came from parsing
that build directly; every corpus figure came from joining it against the local card database
(`src-tauri/target/debug/data/mtg.db`) with a script. **None of it was read out of the shipped
app** — the app did not have this feature when these numbers were taken.

Oracle Tags is a community dataset from [Tagger](https://tagger.scryfall.com) that says what a
card *does* — `removal`, `ramp`, `counterspell` — as opposed to what it *is*. It is the only
Scryfall source of functional classification; nothing in `default_cards` carries it.

> ⚠️ `https://scryfall.com/docs/api/*` returns **HTTP 403** to a plain fetch (Cloudflare) even
> with a real User-Agent. `api.scryfall.com` answers normally. Anyone re-verifying this must
> query the API, not the docs site.

## The bulk-data entry

`GET https://api.scryfall.com/bulk-data` lists **seven** types — unchanged from the
[2026-08-04 survey](2026-08-04-scryfall-api.md): `oracle_cards`, `unique_artwork`,
`default_cards`, `all_cards`, `rulings`, `art_tags`, `oracle_tags`.

| field | value |
| --- | --- |
| `type` | `oracle_tags` |
| `id` | `bd8df61e-5d0a-47a2-9086-40137a645b98` |
| `name` | Oracle Tags |
| `description` | "A JSON file containing all Oracle tags sourced from Tagger, the Scryfall community tagging project." |
| `jsonl_download_uri` | `https://data.scryfall.io/oracle-tags/oracle-tags-20260813210041.jsonl.gz` |
| `compressed_size` | **5,846,422** bytes |

It follows the post-2026-07-20 shape exactly as `default_cards` does: **`jsonl_download_uri`
and `compressed_size` only** — there is no `download_uri` and no `size`. Code written against
the pre-migration fields is dead here too.

The file regenerates daily like the rest. The 2026-08-04 build measured 5,896,524 bytes against
this one's 5,846,422 — same id, ~50 KB smaller a week and a half later.

**The sibling `art_tags` dataset (`48da5752-eeb6-4126-bf97-8829e20ad14f`, 12,497,984 bytes) is
not used by this app.** Art tags describe the *illustration* — what is depicted — not the card's
function. It is more than twice the size for a question the app does not ask.

## Format

Gzipped JSONL, same as the card files: one Tag object per line, `\n`-separated, no outer array,
no commas. **4,521 lines.**

A line carries:

```
object, id, label, slug, type, uri, description, parent_ids, child_ids, aliases, taggings
```

`description` is often `null`. `taggings` is an array of `{oracle_id, weight}` with an optional
`annotation`.

**`taggings[].oracle_id` joins straight to `cards.oracle_id`** — the app's existing column, which
is nullable (`reversible_card` printings have no top-level oracle id; see the
[2026-08-04 survey](2026-08-04-scryfall-api.md) §4c). There is no fuzzy matching anywhere in
this join.

**229,633 taggings covering 35,969 distinct oracle_ids.**

## The hierarchy is a DAG, not a tree

This is the single most important structural fact in the file, and the one that most naive
implementations get wrong.

| | count |
| --- | --- |
| tags | 4,521 |
| tags with no parent (roots) | 926 |
| tags with at least one child | 676 |
| tags that are both a root and a parent | 225 |
| roots with no children at all | 701 |
| **tags with MORE THAN ONE parent** | **684** |
| maximum depth | 5 |

(225 + 701 = 926 — every root either has children or does not.)

**684 of 4,521 tags have more than one parent.** A `parent_ids` array is not a "the parent,
plus some noise" field; it is a real multi-edge. Any code that reads `parent_ids[0]` is
discarding 15% of the graph's edges.

This build has **no cycles and no dangling parent ids**. Neither is guaranteed by the format and
neither should be assumed to hold forever — the walk needs a visited set and a missing-id guard
regardless.

## `weight` carries no usable signal

Each tagging has a `weight`, which reads like a confidence score. It is not one:

| weight | taggings | share |
| --- | --- | --- |
| `median` | 229,027 | 99.74% |
| `very_strong` | 605 | 0.26% |
| `strong` | 1 | ~0.00% |

The 605 `very_strong` taggings are spread across **605 distinct tags** — roughly one card each.
There is no cluster to rank against.

**Consequence: the app cannot rank a card's tags by confidence.** Whatever picks a card's
primary category has to come from the tag *graph* — which anchor a tag descends from — not from
the data's own weighting, because 99.74% of the corpus is tied.

## A card cannot be identified by one tag

A card carries a **median of 5 root tags** (p90 9, p99 13, max 39). And the biggest roots are
cataloguing or jokey rather than functional — using them as categories would swallow the corpus:

| root tag | cards |
| --- | --- |
| `triggered-ability` | 17,217 |
| `activated-ability` | 10,320 |
| `card-names` | 8,630 |
| `cycle` | 8,374 |
| `flavors-of-vanilla` | 4,532 |

plus `meme`, `bible-reference`, `type-errata` and `unique-type-line` in the same tier. A "most
common root tag" heuristic files half the game under *Triggered ability*.

### Walking only `parent_ids[0]` is wrong

`mana-rock-with-set-s-mechanic` has parents `[staple-with-set-s-mechanic, mana-rock]`. The first
is a cataloguing parent; the second is the functional one. Following only the first misses Ramp
for Arcane Signet, Fellwar Stone and the whole Talisman cycle. Likewise the `regrowth` tag lists
`recursion` **second**, so a first-parent walk misses Recursion for Eternal Witness and Regrowth
themselves.

Both walks, measured against the settled 13 anchors with the Land pin, over the full
38,618-card corpus:

| | first parent only | every parent |
| --- | ---: | ---: |
| categorised by oracle tag | 23,065 (**59.7%**) | 23,889 (**61.9%**) |
| Land, pinned by type | 1,196 (3.1%) | 1,196 (3.1%) |
| fell back to card type | 14,357 (37.2%) | 13,533 (**35.0%**) |

**Walking every parent earns +824 cards, +2.1 points.**

This reconciles with the corpus table below: the **38.1% "by type"** figure there is Land
**3.1%** plus fallback **35.0%** — 1,196 + 13,533 = 14,729 cards. The two tables count the same
corpus the same way.

**The qualitative win is the real argument, not the 2.1 points.** The cards the first-parent
walk drops are Signets, Talismans, Fellwar Stone, Eternal Witness, Regrowth — staples a deck
builder notices are in the wrong pile immediately. Two points is what that looks like averaged
over a corpus with a long tail of cards no anchor should ever claim.

### Six piles get smaller under the better walk — this is correct

Following every parent does **not** grow every pile, because the extra ancestry reaches a
*higher-precedence* anchor for some cards and they are correctly claimed there.

| pile | first parent | every parent | Δ |
| --- | ---: | ---: | ---: |
| Removal | 6,895 | 7,139 | +244 |
| Draw | 3,677 | 4,359 | +682 |
| Recursion | 1,748 | 1,913 | +165 |
| Anthem | 1,097 | 1,219 | +122 |
| Protection | 1,399 | 1,461 | +62 |
| Ramp | 2,076 | 2,124 | +48 |
| Stax | 2,204 | 2,155 | −49 |
| Tutor | 651 | 637 | −14 |
| Sacrifice | 612 | 570 | −42 |
| Lifegain | 1,016 | 958 | −58 |
| Mill | 476 | 411 | −65 |
| **Burn** | **291** | **106** | **−185** |
| Tokens | 923 | 837 | −86 |

(+1,323 gained, −499 lost, net +824.)

**Burn 291 → 106 and Mill 476 → 411 are the loud ones, and both are right.** The extra ancestry
reaches `removal` for cards the first-parent walk had left in the narrower pile, and Removal
outranks both. Lightning Bolt is Removal. Do not read a shrinking pile here as lost coverage —
every card in that −499 landed in a *higher*-precedence pile, not in the fallback.

### The top-most root is the wrong stopping point

Climbing all the way up lands on tags that are true but useless as a pile:

| tag | chain | root you would land on |
| --- | --- | --- |
| `counterspell` | `counterspell -> blue-effect` | *Blue effect* |
| `sweeper` | under `removal` | — |
| `spot-removal` | under `removal` | — |
| `ward` | under `triggered-ability` | *Triggered ability* |

Climbing to the root files **every counterspell in the game under "Blue effect"**.

**So the app stops the walk at the first _recognised_ anchor tag, at whatever depth that anchor
sits.** Not the root, not a fixed depth — the first known anchor reached while following *every*
parent edge.

## The anchor tags, and their reach

*Reach* = the number of distinct oracle_ids holding that tag **or any descendant of it**,
following every parent edge. The table is in the app's **precedence order** (see below), and
each row lists the anchors feeding that pile.

| # | pile | anchor tags (reach) |
| ---: | --- | --- |
| 1 | Removal | `removal` 6,686 · `counterspell` 556 |
| 2 | Ramp | `ramp` 2,422 · `mana-producer` 978 · `adds-multiple-mana` 528 |
| 3 | Recursion | `recursion` 2,330 |
| 4 | Draw | `card-advantage` 6,690 · `force-draw` 323 |
| 5 | Tutor | `tutor` 1,175 |
| 6 | Protection | `protection` 1,243 · `damage-prevention` 601 · `ward` 218 |
| 7 | Anthem | `anthem` 544 · `keyword-anthem` 512 · `power-boost-to-all` 1,024 · `toughness-boost-to-all` 777 |
| 8 | Stax | `tax` 451 · `group-slug` 735 · `hate` 4,644 · `pillowfort` 61 · `mass-land-denial` 114 · `stasis` 38 |
| 9 | Tokens | `repeatable-token-generator` 1,938 |
| 10 | Sacrifice | `sacrifice-outlet` 1,509 · `sacrifice-self` 1,419 |
| 11 | Lifegain | `lifegain` 2,759 |
| 12 | Mill | `mill` 1,298 |
| 13 | Burn | `burn` 3,177 |

Note `mana-producer` is **not a root** — its parent is `ramp`. It is listed as an anchor because
the walk stops at the first *recognised* anchor, and a tag whose only route to `ramp` runs
through it must still resolve.

**The three smallest anchors are load-bearing, not droppable.** `pillowfort` 61,
`mass-land-denial` 114 and `stasis` 38 are the only reason Ghostly Prison, Propaganda and Winter
Orb reach Stax at all. Their size makes them look like rounding error; removing one silently
drops a whole archetype.

### Precedence

Piles are resolved in the numbered order above. **Land is pinned by the type line before any of
them run**, and the card-type rule is the fallback after all of them.

Recursion sits above Draw deliberately: `regrowth` has both `recursion` and `card-advantage` as
parents, and Regrowth is a Recursion card.

**Reach is not pile size.** These sets overlap heavily — a card reachable from four anchors is
ordinary — and a card lands in exactly one pile, so precedence decides. `burn` reaches 3,177
cards but the Burn pile holds 106; see below.

## There is no `land` tag

Lands are a card *type*, not a *function*, and Tagger tags function. The dataset offers nothing
to file a land under.

Worse, lands are actively mis-sorted by tags: **618 of 1,196 land cards (51.7%) carry a
functional anchor and would leave the Land pile without the type pin.**

| pile it would go to | lands | example |
| --- | ---: | --- |
| Draw | 146 | Savai Triome |
| Ramp | 122 | Selesnya Sanctuary, Lotus Vale |
| Tutor | 50 | Escape Tunnel |
| Lifegain | 49 | Illegitimate Business |
| Sacrifice | 47 | |
| Removal | 45 | |
| Mill | 34 | |
| Recursion | 30 | |
| Stax | 27 | |
| Tokens | 25 | |
| Protection | 20 | |
| Anthem | 13 | |
| Burn | 10 | |

**So the app pins anything whose front face contains Land to "Land" before consulting tags at
all.** That is a type-line decision, not a tag decision, and it has to run first.

> ⚠️ **The land rule is "front face *contains* Land", not `type_line LIKE 'Land%'`.** The prefix
> match gives **1,059** cards against the correct rule's **1,196** — it silently drops
> `Basic Land — Forest`, `Artifact Land`, `Legendary Land`, `Enchantment Land` and
> `Legendary Snow Land`. This is the easiest trap for anyone re-deriving these figures, and it
> fails in the direction that looks plausible.

## Result over the app's own corpus

Over the **38,618 distinct oracle cards** in the local database, measured 2026-08-14:

- **61.9%** categorised by oracle tag (23,889 cards)
- **38.1%** decided by card type (14,729 cards) — which splits into the **3.1%** pinned as Land
  by the type line (1,196) and the **35.0%** that reached no anchor and fell back (13,533)

Those are the same numbers as the every-parent column in
[Walking only `parent_ids[0]` is wrong](#walking-only-parent_ids0-is-wrong) above, counted the
same way.

| tag piles | cards | | type fallback | cards |
| --- | ---: | --- | --- | ---: |
| Removal | 7,139 | | Creature | 7,974 |
| Draw | 4,359 | | Uncategorised | 2,882 |
| Stax | 2,155 | | **Land** (pinned) | **1,196** |
| Ramp | 2,124 | | Enchantment | 740 |
| Recursion | 1,913 | | Artifact | 694 |
| Protection | 1,461 | | Sorcery | 645 |
| Anthem | 1,219 | | Instant | 591 |
| Lifegain | 958 | | Battle | 4 |
| Tokens | 837 | | Planeswalker | 3 |
| Tutor | 637 | | | |
| Sacrifice | 570 | | | |
| Mill | 411 | | | |
| Burn | 106 | | | |
| **total** | **23,889** | | **total** | **14,729** |

Land counts on the **type** side because the pin runs before tags — it is a type-line decision,
not a tag one. All twenty-two piles sum to exactly 38,618.

⚠️ The corpus query must be **one row per oracle card**. Counting
`SELECT DISTINCT oracle_id, name, type_line` double-counts any oracle card whose printings
disagree on name or type line, and inflates every figure in this section (it gave 38,689 on the
first pass). Group by `oracle_id` — see [Reproducing](#reproducing-the-numbers).

### The type fallback is not missing data

**35,961 of the 38,618 corpus cards (93.1%) carry at least one oracle tag.** Coverage is close
to total. (Cross-check: the file holds 35,969 distinct tagged oracle_ids, so all but 8 of them
match a card in this corpus.)

So the **35.0%** that reached no anchor is **not** cards Tagger has yet to reach — at most 6.9%
of the corpus is untagged at all. It is dominated by cards whose tags are all *structural* —
`triggered-ability`, `flavors-of-vanilla`, `card-names` — with nothing functional among them,
exactly the roots listed above that would swallow the corpus if used as categories.

**The fallback rate will therefore not fall as Tagger coverage grows.** It is a property of
which tags the app treats as anchors, not of how much of the game is tagged. The only lever that
moves it is adding anchors.

**Burn is small because Removal takes burn spells first, and that is intended.**
`burn-creature`'s parents are `removal-burn` and `removal-creature` — both under `removal` — so
Lightning Bolt is Removal, not Burn. Burn keeps the 106 cards that burn something other than a
creature. Do not "fix" this.

## Reproducing the numbers

Headers are mandatory on `api.scryfall.com`; the file origin `data.scryfall.io` is
unauthenticated and has no rate limit.

```sh
UA='MTGGrimoire/0.1 (+https://github.com/Msgaihede/mtg-grimoire)'

# The bulk entry
curl -sS -H "User-Agent: $UA" -H 'Accept: application/json' \
  https://api.scryfall.com/bulk-data/oracle_tags

# The file itself
URI=$(curl -sS -H "User-Agent: $UA" -H 'Accept: application/json' \
  https://api.scryfall.com/bulk-data/oracle_tags | jq -r .jsonl_download_uri)
curl -sS -o oracle-tags.jsonl.gz "$URI"

gzip -dc oracle-tags.jsonl.gz | wc -l        # 4521
```

Structure and weights:

```python
import gzip, json
from collections import Counter

tags = [json.loads(l) for l in gzip.open('oracle-tags.jsonl.gz', 'rt', encoding='utf-8')]

len(tags)                                                 # 4521
sum(1 for t in tags if not t['parent_ids'])               # 926   roots
sum(1 for t in tags if t['child_ids'])                    # 676   have children
sum(1 for t in tags if len(t['parent_ids']) > 1)          # 684   multi-parent
sum(len(t['taggings']) for t in tags)                     # 229633
len({g['oracle_id'] for t in tags for g in t['taggings']})  # 35969

Counter(g['weight'] for t in tags for g in t['taggings'])
# {'median': 229027, 'very_strong': 605, 'strong': 1}
```

Reach of an anchor — build the child map from `parent_ids` (every edge, not `child_ids`) and
walk down:

```python
by_id   = {t['id']: t for t in tags}
by_slug = {t['slug']: t for t in tags}

children = {}
for t in tags:
    for p in t['parent_ids']:
        children.setdefault(p, []).append(t['id'])

def reach(slug):
    seen, stack, cards = set(), [by_slug[slug]['id']], set()
    while stack:
        tid = stack.pop()
        if tid in seen or tid not in by_id:   # visited set + dangling-id guard
            continue
        seen.add(tid)
        cards |= {g['oracle_id'] for g in by_id[tid]['taggings']}
        stack.extend(children.get(tid, ()))
    return len(cards)

reach('removal')   # 6686
reach('burn')      # 3177
```

Corpus, against the dev database (`src-tauri/target/debug/data/mtg.db` under
`npm run tauri dev` — **not** `src-tauri/data/`). **One row per oracle card** — group, do not
`SELECT DISTINCT` over columns that vary between printings:

```sql
-- the corpus itself: 38,618 rows
SELECT oracle_id, type_line FROM cards
WHERE lang='en' AND oracle_id IS NOT NULL
GROUP BY oracle_id;

-- 38618
SELECT COUNT(*) FROM (
  SELECT oracle_id FROM cards
  WHERE lang='en' AND oracle_id IS NOT NULL
  GROUP BY oracle_id);
```

**The first-parent / every-parent knob.** The two columns in the walk comparison come from the
same script, changing one expression in the ancestry walk:

```python
for p in tag['parent_ids']:        # every parent   -> 23,889 (61.9%)
for p in tag['parent_ids'][:1]:    # first only     -> 23,065 (59.7%)
```

This is the one knob the implementation documents as flippable, so it is worth re-running both
sides after any anchor-set change rather than assuming the delta holds.

The pile counts come from running the anchor walk over that set, in the precedence order above,
with the Land type-line pin applied first. They are figures for the **2026-08-13 tag build
against a 38,618-card corpus**; both move as Tagger and the Scryfall sync move, so re-measure
before quoting them against a later build.
