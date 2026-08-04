# Research: scryfall-api (2026-08-04)

## Summary

Scryfall's bulk API changed in a breaking way on 2026-07-20 (announced 2026-07-01), after most existing documentation and tutorials were written: the `download_uri`, `size`, `content_type`, and `content_encoding` fields are GONE from bulk_data objects, replaced by `jsonl_download_uri` and `compressed_size`. Files are now gzipped JSONL (newline-delimited, no wrapping array), and legacy `.json` URLs return HTTP 404 — I verified this live. For a collection tracker that must cover every printing with prices, legalities and images, **default_cards** is the correct file: 77,332,681 bytes compressed / 622,983,470 bytes (594 MiB) uncompressed / 116,568 cards, versus all_cards at 390,063,293 compressed / 2.68 GiB uncompressed / 538,675 cards (all_cards only adds non-English translations of the same physical printings — same Scryfall IDs are NOT shared; each language is a separate object). Change detection is cheap and layered: the `/bulk-data` listing supports conditional GET (verified 304 with `If-None-Match` on a weak ETag), `updated_at` changes per file, and the new `/cards/manifest` endpoint (15,000 rows/page, 8 pages, 10/min limit) returns per-card `data_updated_at` and `image_updated_at` for true incremental sync without re-downloading 77 MB. Rate limits are now per-endpoint (10/sec general, 2/sec for card search endpoints, 10/MINUTE for manifest), `*.scryfall.io` file origins are explicitly unlimited, and User-Agent plus Accept headers are mandatory — WebFetch was 403'd until I set a real UA. Scryfall explicitly encourages local caching "at least for 24 hours" and mandates bulk files for bulk lookups. Major card-object gotchas: `reversible_card` has NO top-level `oracle_id`, `cmc`, or `type_line` (they move into card_faces), five layouts carry `image_uris` only on faces, `image_uris` now has 11 keys (5 new WEBP formats), legalities has 23 keys and grows over time, and the documented `eur_etched` price key does NOT exist in actual bulk data (0 occurrences in 4,513 cards).

## Details

> All figures below were fetched **live on 2026-08-04 ~04:10 UTC**. Doc pages and `api.scryfall.com` both reject requests without a real `User-Agent` (WebFetch got HTTP 403 on every URL); all data here was obtained via `curl` with an explicit UA.

---

# 0. BREAKING CHANGE — read this first

The bulk API migrated to **gzipped JSONL** on **2026-07-20**. Announced in the blog post "Two New Ways to Sync Scryfall Data" (Wed July 1 2026, https://scryfall.com/blog/category/api):

> "The old JSON with gzip streaming is being deprecated. Instead, we will begin serving gzipped JSONL files… Each JSON object in the file is on its own line. The objects are separated by newlines (`\n`), there is no parent JSON array wrapped around the objects, and no commas between the objects."

> "The new files will be served as `.jsonl.gz`. That specifically means you will be downloading a gzipped file, **not** transmitting the file via gzip compression. You will need to un-gzip the file on disk once you have it. It is a single file, not a tarball (it's just `.gz` not `.tar.gz`)."

> "Bulk file objects will provide both formats until **July 20th, 2026, when JSONL will be the only file type offered**… After July 20th, the only property will be `jsonl_download_uri` and the old files will be retired."

**Verified consequences:**
- `bulk_data` objects **no longer have** `download_uri`, `size`, `content_type`, or `content_encoding`. Any code or doc referencing those is dead.
- Legacy URL `https://data.scryfall.io/default-cards/default-cards-20260803211627.json` → **HTTP 404 Not Found** (confirmed).
- The `.gz` is served with `Content-Type: application/gzip` and `Content-Disposition: attachment`. It is a **real gzip file on the wire** — do NOT let your HTTP client transparently decode it as `Content-Encoding: gzip` (it isn't sent that way), and do not double-decompress.
- Verified single-member gzip stream (`zlib.decompressobj(31).unused_data == 0` after 3 MB), so a single streaming decompressor handles the whole file.

---

# 1. Bulk file comparison — LIVE `GET https://api.scryfall.com/bulk-data`

Exact live values. `compressed_size` is verbatim from the API; uncompressed is read from the gzip ISIZE trailer via HTTP Range request on the last 4 bytes; card counts cross-verified against `/cards/search` `total_cards` and `/cards/manifest` `total_cards`.

| type | id | updated_at | compressed_size (bytes) | uncompressed (bytes) | ratio | cards | bytes/card |
|---|---|---|---|---|---|---|---|
| `oracle_cards` | `27bf3214-1271-490b-bdfe-c0be6c23d02e` | `2026-08-03T21:03:39.498+00:00` | **24,443,680** (23.31 MiB) | 202,368,407 (193.0 MiB) | 8.28× | **38,542** | 5,251 |
| `unique_artwork` | `6bbcf976-6369-4401-88fc-3a9e4984c305` | `2026-08-03T21:06:11.353+00:00` | **37,275,399** (35.55 MiB) | 296,250,560 (282.5 MiB) | 7.95× | **53,863** | 5,500 |
| `default_cards` | `e2ef41e3-5778-4bc2-af3f-78eca4dd9c23` | `2026-08-03T21:16:27.869+00:00` | **77,332,681** (73.75 MiB) | 622,983,470 (594.1 MiB) | 8.06× | **116,568** | 5,344 |
| `all_cards` | `922288cb-4bef-45e1-bb30-0c2bd3d3534f` | `2026-08-03T21:45:37.341+00:00` | **390,063,293** (372.0 MiB) | 2,876,381,888 (2.679 GiB) | 7.37× | **538,675** | 5,340 |
| `rulings` | `06f54c0b-ab9c-452d-b35a-8297db5eb940` | `2026-08-03T21:00:39.892+00:00` | **5,300,458** (5.06 MiB) | — | — | — | — |
| `art_tags` | `48da5752-eeb6-4126-bf97-8829e20ad14f` | `2026-08-03T21:01:26.728+00:00` | **12,395,021** (11.82 MiB) | — | — | — | — |
| `oracle_tags` | `bd8df61e-5d0a-47a2-9086-40137a645b98` | `2026-08-03T21:00:39.518+00:00` | **5,896,524** (5.62 MiB) | — | — | — | — |

Card counts derived from live `/cards/search?q=*` queries:
- `unique=cards&include_extras=true` → **38,542** (≈ oracle_cards)
- `unique=art&include_extras=true` → **53,863** (≈ unique_artwork)
- `unique=prints&include_extras=true&include_variations=true` → **116,568** (= default_cards, and = `/cards/manifest` `total_cards`)
- same **+ `include_multilingual=true`** → **538,675** (= all_cards)

### What each contains

- **`oracle_cards`** — "one Scryfall card object for each Oracle ID". **One row per distinct game card**, arbitrary representative printing. ✗ Unusable: no alternate arts, no per-printing prices, only one set/collector_number per card.
- **`unique_artwork`** — "all unique artworks. The chosen cards promote the best image scans." One row per distinct `illustration_id`. ✗ Unusable: collapses different printings that reuse the same art (e.g. the same art in a base set and a Masters reprint at different prices), so prices and set/collector_number are wrong for the collapsed printings.
- **`default_cards`** — ✅ **"every card object on Scryfall in English or the printed language if the card is only available in one language."** One row per **physical printing** — every alternate art, showcase, borderless, promo, prerelease stamp, serialized variant, token, and Secret Lair. Confirmed in sample: `lang` distribution was `en` 4,414, `es` 47, `ja` 22, `fr` 15, `it` 8, `ph` 4, `zhs` 3 — i.e. non-English rows DO appear, but only where no English printing exists.
- **`all_cards`** — "every card object on Scryfall in every language." **Adds only translations**: 538,675 − 116,568 = **422,107 extra rows** that are localized reprints of the same physical printings. Each language gets its **own distinct Scryfall `id`** (they are separate objects, not a nested field), plus `printed_name` / `printed_text` / `printed_type_line`. 5.05× the compressed bytes and 4.6× the uncompressed bytes of default_cards for zero additional distinct printings.

**→ Choose `default_cards`.** It is the minimum file that contains every printing with correct per-printing `prices`, `legalities`, and `image_uris`. Only move to `all_cards` if users must catalog which *language* copy they own.

---

# 2. Update cadence + cheapest change detection

### Cadence (verbatim from https://scryfall.com/docs/api/bulk-data)
> "Bulk data is only collected **once every 12-24 hours**."

> "Card objects in bulk data include price information, but **prices should be considered dangerously stale after 24 hours**. Only use bulk price information to track trends or provide a general estimate of card value. **Prices are not updated frequently enough to power a storefront or sales system.** You consume price information at your own risk."

> "Updates to gameplay data (such as card names, Oracle text, mana costs, etc) are much less frequent. If you only need gameplay information, **downloading card data once per week or right after set releases** would most likely be sufficient."

From https://scryfall.com/docs/api/rate-limits:
> "We only update prices for cards **once per day**. Fetching card data more frequently than 24 hours will not yield new prices."

Observed `updated_at` times cluster at **21:00–21:45 UTC** (rulings 21:00 → oracle 21:03 → unique_artwork 21:06 → default 21:16 → all_cards 21:45). Files are generated sequentially; `all_cards` lands ~45 min after the window opens. **Poll after ~22:00 UTC** to get a consistent daily set.

### Change detection, cheapest → most expensive (all verified live)

**Tier 1 — conditional GET on the listing (~0 bytes, best).** Both the collection and single-item endpoints emit weak ETags and honor `If-None-Match`:
```
GET https://api.scryfall.com/bulk-data          → etag: W/"c15ab6b660133bf7bd19ca09dd19f87f"
  + If-None-Match: W/"c15ab6b660133bf7bd19ca09dd19f87f"  → HTTP 304, 0 bytes  ✅
GET https://api.scryfall.com/bulk-data/default_cards → etag: W/"a3cc806ec3e7b4014950afa5a61e34d9"
  + If-None-Match: W/"a3cc806ec3e7b4014950afa5a61e34d9"  → HTTP 304, 0 bytes  ✅
```
Prefer `/bulk-data/default_cards` — its ETag only changes when *that* file changes, whereas the collection ETag flips when any of the 7 files rotate.

**Tier 2 — compare `updated_at`.** If you get a 200, parse the ~470-byte single-item JSON and compare `updated_at` (ISO-8601 with ms and offset) against your stored value. This is the authoritative signal. `compressed_size` is a poor signal — it can coincidentally match; do not use size-change alone.

**Tier 3 — conditional GET on the .gz itself.** The file origin serves a strong ETag and honors it:
```
HEAD https://data.scryfall.io/default-cards/default-cards-20260803211627.jsonl.gz
  ETag: "a4da49f25ac9bc05cad5ee1f36745717"
  Last-Modified: Mon, 03 Aug 2026 21:16:32 GMT
  Content-Length: 77332681
  Cache-Control: public, max-age=31556952   ← 1 year, immutable (URL is timestamped)
  Accept-Ranges: bytes                       ← resumable downloads supported
  + If-None-Match: "a4da…" → HTTP 304, 0 bytes  ✅
```
Mostly redundant since the URL embeds a timestamp (`…-20260803211627.jsonl.gz`) and is immutable for a year.

**Tier 4 — `/cards/manifest` for true incremental sync (NEW, the big win).**
```
GET https://api.scryfall.com/cards/manifest?lang=en&page=1
```
Live response: `total_cards: 116568`, `has_more: true`, **15,000 rows/page → 8 pages**. Row shape:
```json
{"id":"1750e98f-…","oracle_id":null,"name":"Munitions Enthusiast","set_code":"pw26",
 "collector_number":"18","lang":"en","created_at":null,
 "data_updated_at":null,"image_updated_at":"2026-07-21T16:44:09Z"}
```
Docs: *"Returns a List describing Scryfall's current Card offerings… so that you can compare it with your downstream system or sync process… You must hydrate any Card objects you are further interested in using other methods."* Params: `lang` (2–3 char code; omit for default mix), `order` = `released` (default) or `imageupdated`, always descending. Does not support the `pretty` option.

At **10 requests/minute**, 8 pages = **~48 seconds** for a full manifest sweep — vs. 77 MB for a bulk re-download. Use `order=imageupdated` to find images needing re-cache. Caveat: `created_at` and `data_updated_at` were **`null` on every row I sampled** — only `image_updated_at` is currently populated, so manifest is reliable today for *image* invalidation and for detecting *added/removed* card IDs, but not yet for data-change detection.

**Tier 5 — `/migrations` for deletions.** `GET https://api.scryfall.com/migrations?page=1`. Fields: `object`, `uri`, `id`, `performed_at`, `migration_strategy`, `old_scryfall_id`, `new_scryfall_id` (nullable), `note` (nullable), `metadata` (nullable). Two strategies:
- `merge` — "update your records to replace the given old Scryfall ID with the new ID."
- `delete` — "The given UUID is being discarded, and no replacement data is being provided."

**Critical for a collection tracker:** a user's owned-card rows key on Scryfall `id`. Because bulk files are additive snapshots, a deleted card silently vanishes from the file and you'd orphan the user's collection entry. Poll `/migrations` and apply merges/deletes to user data.

**Bonus — stable bookmarkable redirect:**
```
GET https://api.scryfall.com/bulk-data/default_cards?format=file
→ HTTP 302, location: https://data.scryfall.io/default-cards/default-cards-20260803211627.jsonl.gz
```
Lets you download in one hop without parsing JSON first.

---

# 3. Rate limits, required headers, caching policy

### Rate limits (https://scryfall.com/docs/api/rate-limits) — now PER-ENDPOINT
> "The Scryfall API (api.scryfall.com) has the following hard rate limits:
> - `/cards/search` — **2/second (500ms)**
> - `/cards/named` — **2/second (500ms)**
> - `/cards/random` — **2/second (500ms)**
> - `/cards/collection` — **2/second (500ms)**
> - `/cards/manifest` — **10/minute (10,000ms)**
> - All other methods — **10/second (100ms)**"

> "**The direct file origins located at `*.scryfall.io` do not have rate limits.**"

> "Submitting excessive requests to API server may result in an HTTP **429 Too Many Requests** status code. Recieving an HTTP 429 response will result in your access being **limited for 30 seconds**. Continuing to overload the API after this point may result in a **temporary or permanent ban of your application**. Applications that receive constant rate limit warnings over a longer period may also be blocked. **It is not acceptable to ignore HTTP 429 responses.** You must act to reduce your application's overages."

This is the single most important operational number for a desktop app: **image downloads from `cards.scryfall.io` and bulk downloads from `data.scryfall.io` are UNLIMITED.** Only `api.scryfall.com` is throttled. So a desktop tracker should do essentially all its work against the file origins.

### Required headers (https://scryfall.com/docs/api)
> "**All HTTP requests to api.scryfall.com must include a `User-Agent` header and an `Accept` header.**"

> "Your User-Agent header must be accurate to your usage context. If you are running a script or app, the header should be the name of your application, such as `MTGExampleApp/1.0` or the current relevant version. **Do not allow HTTP libraries to choose the header for you.**"

> "The Accept header must be present, but you can provide a generic preference. For example, both of these are okay: `Accept: */*` and `Accept: application/json;q=0.9,*/*;q=0.8`."

Also: *"The API is available at `https://api.scryfall.com`. API requests are only served over **HTTPS, using TLS 1.2 or better**. Requests will not be honored over plaintext HTTP. The API uses **UTF-8** character encoding for all responses."*

Empirically: the docs site behind Cloudflare **403s** unrecognized/absent UAs. Ship a real one, e.g. `MTGCollectionTracker/1.0 (+https://your.site; contact@you)`.

CORS headers observed on the API (relevant only if you embed a webview): `access-control-allow-origin: *`, `access-control-allow-methods: GET, POST, DELETE, OPTIONS`, `access-control-max-age: 300`, `vary: Accept, Accept-Encoding`.

### Caching policy — they explicitly encourage it
From https://scryfall.com/docs/api/rate-limits:
> "**We encourage you to cache the data you download from Scryfall or process it locally in your own system, at least for 24 hours.** Scryfall provides our entire database compressed for download in daily bulk data files. **If you need to rapidly look up card names, prices, or resolve a large number of card images, you must use the bulk data files.**"

Note "**must**", not "should" — bulk files are mandatory for bulk workloads. A desktop tracker is squarely the intended use case.

### Data & image usage rules (https://scryfall.com/docs/api) — verbatim, affects UI design
Data:
> "You may not use Scryfall logos or use the Scryfall name in a way that implies Scryfall has endorsed you, your work, or your product."
> "**You may not 'paywall' access to Scryfall data.** You may not require anyone to make payments, take surveys, agree to subscriptions, rate your content, join chat servers, or follow channels in exchange for access to Scryfall data. If you have an account system, end-users should be able to access card data anonymously or with free accounts."
> "You may not use Scryfall data to create new games, or to imply the information and images are from any other game besides Magic: The Gathering."
> "**You may not simply repackage, republish, or proxy Scryfall data. Your software must create additional value for end-users.**"

Images:
> "Do not cover, crop, or clip off the copyright or artist name on card images."
> "Do not distort, skew, or stretch card images."
> "Do not blur, sharpen, desaturate, or color-shift card images."
> "Do not add your own watermarks, stamps, or logos to card images."
> "Do not place card images in a way that implies someone other than Wizards of the Coast created the card or that it is from another game besides Magic: The Gathering."
> "**When using the `art_crop`, list the artist name and copyright elsewhere in the same interface presenting the art crop, or use the full card image elsewhere in the same interface.** Users should be able to identify the artist and source of the image somehow."

> "Repeated mishandling or misrepresentation of data or images in your project may result in Scryfall restricting or blocking your API access."

Practical: if the collection grid uses `art_crop`/`art` tiles, you **must** show `artist` somewhere in that same view. A paid "pro" tier must not gate card data itself.

### Image CDN caching (measured)
```
GET https://cards.scryfall.io/normal/front/0/0/0000419b-….jpg?1783910776
  Content-Type: image/jpeg
  Cache-Control: public, max-age=31556952    ← 1 year
  ETag: "29d824046b8332c7e4fd703fcffd4743"
  Last-Modified: Mon, 29 Jun 2026 03:46:52 GMT
  Age: 165116
```
URLs are **deterministic and versioned**:
```
https://cards.scryfall.io/{format}/{face}/{id[0]}/{id[1]}/{id}.{ext}?{version}
                          ^^^^^^^^ ^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^
                          e.g.     front/ first two hex chars of    epoch, matches
                          normal   back   the card UUID, then UUID  image_updated_at
```
The `?{version}` query param is a cache-buster equal to the image's update epoch. **`image_updated_at` on the card object is the correct trigger to re-download a locally cached image.** Scryfall's own guidance (blog): *"We don't recommend that you ever try to manually construct a link to a file… Instead you should fetch card data using our API or bulk file offerings, those objects always include the correct and up-to-date URI."* — so read `image_uris`, don't build the URL.

---

# 4. Card object gotchas

### 4a. Layouts — full list (https://scryfall.com/docs/api/layouts), 23 values
`normal`, `split`, `flip`, `transform`, `modal_dfc`, `meld`, `leveler`, `class`, `case`, `saga`, `adventure`, `prepare`, `mutate`, `prototype`, `battle`, `planar`, `scheme`, `vanguard`, `token`, `double_faced_token`, `emblem`, `augment`, `host`, `art_series`, `reversible_card`

Observed distribution in a 4,513-card slice of default_cards: `normal` 4085, `token` 155, `art_series` 105, `transform` 40, `split` 19, `planar` 16, `adventure` 15, `modal_dfc` 12, `saga` 12, `mutate` 11, `emblem` 8, `double_faced_token` 6, `reversible_card` 6, `vanguard` 6, `meld` 5, `prepare` 4, `class` 3, `scheme` 2, `case` 2, `augment` 1.

Docs: *"Cards with the layouts `split`, `flip`, `transform`, and `double_faced_token` will always have a `card_faces` property… Cards with the layout `meld` will always have an `all_parts` property."*

### 4b. WHERE `image_uris` LIVES — measured empirically, this is the #1 gotcha

| layout | top-level `image_uris`? | `card_faces[].image_uris`? | n_faces | note |
|---|---|---|---|---|
| `normal`, `token`, `saga`, `mutate`, `planar`, `scheme`, `vanguard`, `emblem`, `class`, `case`, `augment` | ✅ YES | — | 0 | single face |
| **`meld`** | ✅ YES | — | **0** | ⚠️ NO `card_faces` at all; uses `all_parts` |
| `split` | ✅ YES | ❌ NO | 2 (rarely 3) | one physical face |
| `adventure` | ✅ YES | ❌ NO | 2 | one physical face |
| `prepare` | ✅ YES | ❌ NO | 2 | one physical face |
| `flip` | ✅ YES | ❌ NO | 2 | one physical face (back is normal Magic back) |
| **`transform`** | ❌ **NO** | ✅ YES | 2 | two physical sides |
| **`modal_dfc`** | ❌ **NO** | ✅ YES | 2 | two physical sides |
| **`double_faced_token`** | ❌ **NO** | ✅ YES | 2 | two physical sides |
| **`art_series`** | ❌ **NO** | ✅ YES (mostly) | 2 | ⚠️ 6 of 105 had image_uris on NEITHER |
| **`reversible_card`** | ❌ **NO** | ✅ YES | 2 | two unrelated cards |

Measured: **169 of 4,513 cards (3.7%) have no top-level `image_uris`.** A naive `card["image_uris"]["normal"]` crashes or silently blanks on every DFC in the database.

**Resolution rule:** `image_uris` if present, else `card_faces[0].image_uris` for the front and `card_faces[1].image_uris` for the back. Store images per *face index*, not per card. The URL path segment is `front`/`back` accordingly.

`meld` special case — verified example `Ragnarok, Divine Deliverance` (`fin` #99b): top-level `image_uris` present, **no `card_faces`**, and:
```
all_parts: [("meld_part","Fang, Fearless l'Cie"), ("meld_result","Ragnarok, Divine Deliverance"), ("meld_part","Vanille, Cheerful l'Cie")]
```
Meld parts are three **separate card objects** with separate IDs, linked only through `all_parts` (`component` ∈ `meld_part` / `meld_result` / `combo_piece` / `token`).

### 4c. `reversible_card` — the schema-breaking layout

Verified on `Jinnie Fay, Jetmir's Second // Jinnie Fay, Jetmir's Second` (`sld` #1556):
```
top-level oracle_id : ABSENT       ← !!
top-level cmc       : ABSENT       ← !!
top-level type_line : ABSENT       ← !!
top-level mana_cost : ABSENT
top-level image_uris: ABSENT
card_faces[0]: name, mana_cost {R/G}{G}{G/W}, type_line, image_uris, oracle_id 61fbaaf2-…, layout, cmc
card_faces[1]: same fields, own oracle_id
```
**All 6 reversible_cards in the sample were the ONLY cards missing `oracle_id`, `cmc`, and `type_line`.** Docs confirm: *"the individual card_face objects will have their own `layout` fields… **Many other fields for a reversible card move into the card_face objects**."*

→ Any DB schema with `oracle_id NOT NULL`, `cmc NOT NULL`, or `type_line NOT NULL` will **fail ingest** on these. Make them nullable and fall back to `card_faces[0]`.

### 4d. `card_faces[]` — observed key frequencies (415 faces in sample)
`object` 415, `name` 415, `mana_cost` 415, `oracle_text` 415, `type_line` 414, `artist` 402, `artist_id` 402, `illustration_id` 359, `colors` 338, **`image_uris` 326**, `power` 92, `toughness` 92, `flavor_text` 54, `color_indicator` 30, `watermark` 13, **`oracle_id` 12**, **`layout` 12**, **`cmc` 12**, `loyalty` 6, `defense` 2, `flavor_name` 2.

Note `type_line` is missing on one face (art_series). `mana_cost` is present but empty string `""` on transform backs.

### 4e. `prices` — 6 keys, NOT 7 (documentation bug)

Actual keys in bulk data, present on **100% of cards (4,513/4,513)**, always all 6, values are **strings or `null`** (never numbers):
```json
"prices": {"usd":"0.32","usd_foil":"0.53","usd_etched":null,"eur":"0.26","eur_foil":"0.48","tix":"0.03"}
```
| key | non-null count / 4,513 | % |
|---|---|---|
| `eur` | 3,312 | 73.4% |
| `usd` | 3,248 | 72.0% |
| `tix` | 2,310 | 51.2% |
| `usd_foil` | 2,267 | 50.2% |
| `eur_foil` | 2,262 | 50.1% |
| `usd_etched` | 41 | 0.9% |

⚠️ **The docs at https://scryfall.com/docs/api/cards state prices include `usd`, `usd_foil`, `usd_etched`, `eur`, `eur_foil`, `eur_etched`, and `tix` — but `eur_etched` appears ZERO times in 4,513 real card objects.** Don't create a column for it, or create it nullable and expect it to always be null. Etched example (`Miara, Thorn of the Glade`, `cmr` #566): `{"usd":null,"usd_foil":null,"usd_etched":"0.71","eur":null,"eur_foil":null,"tix":null}` — no `eur_etched` key at all.

Parse as decimal strings; **never float** (money). `tix` is MTGO event tickets, not fiat.

### 4f. `legalities` — FULL list, 23 keys, in emission order
```
standard, future, historic, timeless, gladiator, pioneer, modern, legacy,
pauper, vintage, penny, commander, oathbreaker, standardbrawl, brawl,
competitivebrawl, alchemy, paupercommander, duel, oldschool, premodern,
predh, tlr
```
Values (all four observed live): `legal`, `not_legal`, `restricted`, `banned`. Object is always present with all 23 keys populated.

⚠️ **This set GROWS.** `tlr` is newer than most published field lists, and `competitivebrawl`, `oathbreaker`, `standardbrawl`, `predh`, `timeless` were all added over time. **Do not hardcode 23 columns** — store as a JSON blob or a `(card_id, format, legality)` key-value table so a new format doesn't require a migration.

### 4g. `finishes` / deprecated foil flags
`finishes` is a non-null array over `{"nonfoil","foil","etched"}`. Observed: `nonfoil` 3,956, `foil` 2,771, `etched` 41.

⚠️ Top-level `foil` and `nonfoil` booleans **still appear in the data** (present in the 88-key union) but are **deprecated**: *"The `foil` and `nonfoil` top level properties on API card objects are now deprecated. Use the new `finishes` field instead. These old fields will be removed on Nov 1, 2021."* (They never actually removed them.) Use `finishes`; it's the only way to detect `etched`.

**Collection modeling consequence:** a user owns a *finish* of a *printing*. The natural key for an inventory row is `(scryfall_id, finish)`, and price lookup is `finish → prices.usd | prices.usd_foil | prices.usd_etched`.

### 4h. `games` — paper/arena/mtgo filtering
Non-null array. Docs: *"paper, arena, mtgo, **astral**, and/or **sega**."* Observed: `paper` 4,124, `mtgo` 2,580, `arena` 862, **`sega` 1**.

For a **paper** collection tracker, filter `"paper" in games`. In the sample that excludes 389 rows (8.6%) where `digital == true`. Note `digital` and `games` are related but not identical — filter on `games` containing `paper`, and cross-check `digital == false`.

### 4i. Fields that distinguish alternate arts / printings

Identity & grouping:
- `id` (UUID) — **unique per printing per language**; the primary key for a collection row.
- `oracle_id` (UUID, **nullable** — absent on `reversible_card`) — groups all printings of the same game card.
- `illustration_id` (UUID, nullable) — *"remains consistent across reprints. Newly spoiled cards may not have this field yet."* Groups printings sharing artwork; the key to detecting "different art" vs "same art reprint".
- `set` (set code), `set_id` (UUID), `set_name`, `set_type`, `collector_number`.
  ⚠️ **`collector_number` is a STRING, not an integer**: *"collector numbers can contain non-numeric characters, such as letters or ★."* Observed values like `99b`, `1556`, `566`. Sorting requires natural/numeric-aware sort, not lexical.
- `lang` — 2–3 char code. `(set, collector_number, lang)` is the human-facing composite identity.

Variant flags:
- `promo` (bool, non-null) — 473/4,513 true (10.5%)
- `promo_types` (array, nullable) — top values: `universesbeyond` 423, `boosterfun` 350, `datestamped` 154, `prerelease` 150, `stamped` 136, `promopack` 108, `surgefoil` 101, `setpromo` 82, `mediainsert` 42, `playtest` 36, `alchemy` 23, `poster` 20, `sldbonus` 20, `startercollection` 16, `ripplefoil` 15, `serialized` 13, `doublerainbow` 13, `instore` 13, `rebalanced` 12, `ffxiv` 12
- `variation` (bool, non-null) — only 4/4,513 true; **much rarer than you'd expect — do NOT rely on it to find alternate arts**
- `variation_of` (UUID, nullable) — the printing this varies from
- `frame` (string) — observed `2015` 3140, `2003` 700, `1997` 453, `1993` 207, `future` 13
- `frame_effects` (array, nullable) — observed: `legendary` 473, `inverted` 290, `extendedart` 157, `showcase` 110, `enchantment` 65, `etched` 31, `sunmoondfc` 13, `tombstone` 11, `devoid` 9, `snow` 8, `lesson` 5, `fullart` 4, `compasslanddfc` 4, `miracle` 4, `draft` 2, `originpwdfc` 2, `mooneldrazidfc` 2, `spree` 1, `fandfc` 1, `colorshifted` 1, `companion` 1
- `border_color` — docs: `black`, `white`, `borderless`, `yellow`, `silver`, `gold`. Observed: `black` 3885, `borderless` 343, `white` 207, `gold` 50, `silver` 25, `yellow` 3
- `full_art` (bool) — 253/4,513 true (5.6%)
- `textless` (bool) — 9/4,513
- `oversized` (bool) — 31/4,513
- `reprint` (bool) — 2,642 true / 1,871 false
- `booster` (bool), `digital` (bool, 389 true), `story_spotlight`, `content_warning` (nullable — *"True if you should consider avoiding use of this print downstream"*)
- `security_stamp` (nullable) — docs: `oval`, `triangle`, `acorn`, `circle`, `arena`, or `heart`. Observed: `null` 2887, `oval` 1322, `triangle` 253, `arena` 40, `acorn` 10, `circle` 1
- `card_back_id` (UUID), `rarity` (`common`|`uncommon`|`rare`|`special`|`mythic`|`bonus`; observed `rare` 1625, `common` 1458, `uncommon` 1015, `mythic` 399, `special` 16)

**Practical rule for "alternate art":** two printings differ in art iff `illustration_id` differs. Two printings are *cosmetically* distinct (showcase/borderless/extended) even at the same `illustration_id` via `frame_effects` + `border_color` + `full_art` + `promo_types`. `variation` alone is nearly useless (0.09% true).

### 4j. `image_uris` — 11 keys now (5 new WEBP formats)

Live keys, all 11 present together on every card that has the object (4,344/4,344 in sample):
```
small, normal, large, png, art_crop, border_crop,   ← legacy JPG/PNG
thumb, grid, display, art, crop                      ← NEW WEBP
```
From https://scryfall.com/docs/api/images:

| key | dimensions | format | docs description | measured avg (n=12) |
|---|---|---|---|---|
| `png` | 744 × 1040 | PNG | "A transparent, rounded full card PNG. This is the best image to use for videos or other high-quality content." | 1,355 KB |
| `large` | 672 × 936 | JPG | "A large full card image" | 181 KB |
| `normal` | 488 × 680 | JPG | "A medium-sized full card image" | 111 KB |
| `small` | 146 × 204 | JPG | "A small full card image. Designed for use as thumbnail or list icon." | 15 KB |
| `border_crop` | 480 × 680 | JPG | "rounded corners and the majority of the border cropped off" | 100 KB |
| `art_crop` | Varies | JPG | "A rectangular crop of the card's art only. Not guaranteed to be perfect for cards with outlier designs" | 79 KB |
| **`thumb`** | 146 × 204 | **WEBP** | "A small thumbnail of the card image, **replaces `small`**" | **9 KB** |
| **`grid`** | 488 × 680 | **WEBP** | "A medium-sized full card image, **replaces `normal`**" | **62 KB** |
| **`display`** | 672 × 936 | **WEBP** | "A large full card image, **replaces `large`**" | **93 KB** |
| **`crop`** | 480 × 680 | **WEBP** | "**Replaces `border_crop`**" | **63 KB** |
| **`art`** | 626 × 457 | **WEBP** | "A rectangular crop of the card's art only. **Replaces `art_crop`**" | **58 KB** |

WEBP saves **39% on thumbnails, 44% on normal-size, 48% on large**. The docs word this as "replaces", signaling the JPG variants are on a deprecation path.

Local cache size for all 116,568 default_cards printings (extrapolated from 12-card average):

| format | full-library cache |
|---|---|
| `thumb` (webp) | **1.09 GB** |
| `small` (jpg) | 1.78 GB |
| `art` (webp) | 6.90 GB |
| `grid` (webp) | **7.36 GB** |
| `crop` (webp) | 7.49 GB |
| `art_crop` (jpg) | 9.37 GB |
| `display` (webp) | 11.14 GB |
| `border_crop` (jpg) | 11.96 GB |
| `normal` (jpg) | 13.27 GB |
| `large` (jpg) | 21.56 GB |
| `png` | **161.75 GB** |

→ **Never bulk-prefetch images.** Cache `thumb` lazily (~1 GB worst case if a user browses everything) and fetch `display`/`grid` on demand. `png` is out of the question at scale.

### 4k. `image_status` (4 values, https://scryfall.com/docs/api/images)
| value | meaning | observed |
|---|---|---|
| `missing` | "The card has no image, or the image is being processed. This value should only be temporary for very new cards." | 7 |
| `placeholder` | "Scryfall doesn't have an image of this card, but we know it exists and we have uploaded a placeholder in the meantime. This value is most common on localized cards." | 25 |
| `lowres` | "The card's image is low-quality, either because it was just spoiled or we don't have better photography for it yet." | 260 |
| `highres_scan` | "This card has a full-resolution scanner image. Crisp and glossy!" | 4,221 |

Paired with `highres_image` (bool) and **`image_updated_at`** (new top-level ISO timestamp, e.g. `"2026-07-13T02:46:16Z"`) — the correct cache-invalidation key for locally stored images. Re-fetch when `image_updated_at` advances or when `image_status` improves from `lowres`/`placeholder` → `highres_scan`.

### 4l. Full top-level key set — 88 keys observed in real default_cards data
```
all_parts, arena_id, artist, artist_ids, attraction_lights, booster, border_color,
card_back_id, card_faces, cardmarket_id, cmc, collector_number, color_identity,
color_indicator, colors, content_warning, digital, edhrec_rank, finishes, flavor_name,
flavor_text, foil*, frame, frame_effects, full_art, game_changer, games, hand_modifier,
highres_image, id, illustration_id, image_status, image_updated_at, image_uris, keywords,
lang, layout, legalities, life_modifier, loyalty, mana_cost, mtgo_foil_id, mtgo_id,
multiverse_ids, name, nonfoil*, object, oracle_id, oracle_text, oversized, penny_rank,
power, preview, prices, printed_name, printed_text, printed_type_line, prints_search_uri,
produced_mana, promo, promo_types, purchase_uris, rarity, related_uris, released_at,
reprint, reserved, resource_id, rulings_uri, scryfall_set_uri, scryfall_uri, security_stamp,
set, set_id, set_name, set_search_uri, set_type, set_uri, story_spotlight,
tcgplayer_etched_id, tcgplayer_id, textless, toughness, type_line, uri, variation,
variation_of, watermark
```
`*` = deprecated. Newer/less-documented fields worth noting: `image_updated_at`, `resource_id` ("This card's Resource ID on Gatherer"), `game_changer` (bool, nullable — "on the Commander Game Changer list"), `attraction_lights` (array, nullable — Unfinity), `defense` (string, nullable — Battles), `penny_rank`, `edhrec_rank`.

Marketplace IDs (all nullable ints): `tcgplayer_id`, `tcgplayer_etched_id`, `cardmarket_id`, `mtgo_id`, `mtgo_foil_id`, `arena_id`, plus `multiverse_ids` (array).

⚠️ **English cards can now have `printed_name` / `printed_text` / `printed_type_line`** (Sept 2025 change for Through the Omenpaths / Universes Within reflavors): *"You are now going to see English cards possibly have a printed_name, printed_type_line, and printed_text. Previously this would only happen for localized prints."* Don't assume `printed_*` implies non-English.

### 4m. Non-obvious types
- `cmc` is **Decimal, not Integer** — *"Note that some funny cards have fractional mana costs."* Use a float/decimal column.
- `power` / `toughness` / `loyalty` / `defense` are **strings** (`"*"`, `"1+*"`, `"∞"`), never numbers.
- `colors` is **nullable** — *"if the overall card has colors defined by the rules. Otherwise the colors will be on the card_faces objects."*
- `released_at` is a date string `YYYY-MM-DD`.
- Text fields are UTF-8 with non-ASCII: `—` em-dashes in type lines, `★` in collector numbers, `∞`, accented names.

---

# 5. Ingest strategy for `default_cards` (594 MiB uncompressed, 116,568 lines)

### Format facts
- Single-member gzip stream (verified `unused_data == 0`, so one `GzipStream`/`zlib` inflater covers the file).
- JSONL: one complete JSON object per line, `\n`-separated, **no outer array, no commas**.
- Measured compression **8.05×** (3,000,001 compressed bytes → 24,150,945 bytes = 4,513 objects).
- Mean object **5,344 bytes**; a 3 MB compressed read yields ~4,500 cards.
- `Accept-Ranges: bytes` on the file origin → **resumable downloads** via HTTP Range.

### Strategy: stream, never load whole
**Do NOT** `JSON.parse(entireFile)` / `json.load(f)`. A 594 MiB JSON text expands to roughly **1.5–3 GB** of live objects in a managed runtime (Node/.NET/Python) once every string, dict, and nested `prices`/`legalities`/`image_uris` object is materialized — 116,568 cards × ~10 nested objects each. That risks OOM on a 4 GB desktop and will definitely cause multi-second GC pauses.

**Do:** chain three streams and never materialize more than one card:
```
HTTP response stream → gzip decompressor → line splitter → per-line JSON parse → DB batch insert
```
Peak memory = one decompressed line (avg 5.3 KB, worst case ~50 KB for a Secret Lair reversible with long oracle text) + the gzip window (32 KB) + your insert batch. **Well under 50 MB total.**

Per-language primitives:
- **.NET**: `new GZipStream(httpStream, CompressionMode.Decompress)` → `StreamReader.ReadLineAsync()` → `JsonSerializer.Deserialize<Card>(line)`. Use `System.Text.Json` source generators to avoid reflection cost.
- **Node**: `zlib.createGunzip()` → `readline.createInterface({input})` or a `split2` transform → `JSON.parse(line)`.
- **Python**: `gzip.open(path, 'rt', encoding='utf-8')` and iterate lines directly, or `zlib.decompressobj(31)` on chunks for a pure-stream approach.
- **Rust**: `flate2::read::GzDecoder` → `BufReader::lines()` → `serde_json::from_str`.
- Scryfall's own docs cite Ruby's `Zlib::GzipReader#each_line` and note *"On POSIX systems you can use `gunzip` from the shell."*

### Disk & DB
- **Download to a temp file first** (77 MB), verify `Content-Length` matches `compressed_size`, then stream-parse from disk. This makes the download resumable and lets you retry parsing without re-downloading. Do **not** parse directly off the socket on first pass — a mid-stream network failure would abort the whole ingest.
- Peak disk during update ≈ 77 MB (temp .gz) + your DB delta. You never need the 594 MB plaintext on disk — decompress on the fly.
- SQLite target: batch inserts in transactions of **1,000–5,000 rows**; expect ~250–500 MB for the card table with `legalities`/`prices`/`image_uris` stored as JSON columns, plus indexes. Set `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, and drop/rebuild secondary indexes around the bulk load.
- Ingest into a **staging table, then swap** (or `INSERT … ON CONFLICT(id) DO UPDATE`) so a failed update never leaves a half-populated card table. The user's collection table references `scryfall_id` and must survive the swap.
- Expected wall time on a modern desktop: download ~10–30 s on a fast link, parse+insert ~60–120 s for 116,568 rows. Run off the UI thread with progress reported by line count against an expected ~116.5k.

### Startup flow
1. First run: no local DB → download `default_cards`, full ingest. Show progress; app is usable read-only after.
2. Subsequent runs: `GET /bulk-data/default_cards` with `If-None-Match` → 304 (0 bytes) → done, use local DB immediately. Do this **in the background**; never block app launch on network.
3. On 200: compare `updated_at`; if newer, download + ingest in the background while the old data stays queryable.
4. Throttle to at most once per 24 h (prices don't change faster; docs say so explicitly). Poll after ~22:00 UTC.
5. Periodically call `/migrations` to reconcile deleted/merged IDs against the user's collection.
6. Use `/cards/manifest?order=imageupdated` to find images whose `image_updated_at` advanced past your cached copy.
7. Images: lazy, on-demand, from `cards.scryfall.io` (no rate limit), prefer `thumb`/`grid` WEBP, key the cache on `image_updated_at`.

## Recommendations

- Use `default_cards` as the primary bulk file: 77,332,681 bytes compressed / 622,983,470 bytes (594 MiB) uncompressed / 116,568 printings. It is the minimum file containing every alternate art with correct per-printing prices, legalities, and image_uris. `all_cards` (390 MB compressed, 2.68 GiB uncompressed, 538,675 rows) adds ONLY non-English translations of the same physical printings — 5x the bytes for zero additional distinct printings. Offer it as an opt-in setting only if users must track which language copy they own.
- CRITICAL — do not write code against `download_uri`, `size`, `content_type`, or `content_encoding`. These fields were REMOVED from bulk_data objects on 2026-07-20. The live object has only: id, object, type, updated_at, uri, name, description, `jsonl_download_uri`, `compressed_size`. Legacy `.json` download URLs now return HTTP 404. Most existing tutorials, blog posts, and LLM training data predate this change and will be wrong.
- Parse as JSONL, not JSON. Files are `.jsonl.gz`: one object per line, `\n`-separated, NO outer array and NO commas. It is a plain single-member gzip file (not `.tar.gz`, and not `Content-Encoding: gzip`) — configure your HTTP client so it does NOT transparently decode it, or you will double-decompress.
- Stream the ingest; never load the whole file. Chain `HTTP stream -> gzip decompressor -> line reader -> per-line JSON parse -> batched DB insert`. Peak memory stays under ~50 MB. A full `JSON.parse` of the 594 MiB payload would materialize roughly 1.5-3 GB of live objects and risk OOM plus severe GC pauses on a 4 GB desktop.
- Download the 77 MB `.gz` to a temp file first, verify its byte count against `compressed_size`, then stream-parse from disk. The file origin sends `Accept-Ranges: bytes`, so downloads are resumable. Parsing directly off the socket makes a mid-stream network failure abort the entire ingest.
- Detect updates with a conditional GET on `https://api.scryfall.com/bulk-data/default_cards` using `If-None-Match` with the stored weak ETag — verified to return HTTP 304 with 0 bytes. Prefer the per-type endpoint over the collection endpoint, whose ETag flips whenever ANY of the 7 files rotate. On a 200, compare the `updated_at` timestamp; never use `compressed_size` change alone as the signal.
- Poll at most once per 24 hours, after roughly 22:00 UTC. Scryfall regenerates files once every 12-24 h in a 21:00-21:45 UTC window (default_cards at 21:16, all_cards at 21:45) and states plainly that 'fetching card data more frequently than 24 hours will not yield new prices.'
- Adopt `/cards/manifest` for incremental sync: 15,000 rows/page, 8 pages for 116,568 cards, at a 10/MINUTE rate limit means a full sweep takes about 48 seconds versus a 77 MB re-download. It returns per-card `image_updated_at` (use `order=imageupdated`) for image cache invalidation and reveals added/removed card IDs. Caveat: `data_updated_at` and `created_at` were null on every row sampled, so it is not yet usable for data-change detection.
- Poll `https://api.scryfall.com/migrations` and apply it to the user's collection. Bulk files are additive snapshots, so a deleted card silently disappears and would orphan the user's owned-card rows. Handle `migration_strategy: "merge"` by repointing `old_scryfall_id` to `new_scryfall_id`, and `"delete"` by flagging the row for user review rather than dropping it silently.
- Make `oracle_id`, `cmc`, and `type_line` NULLABLE in your schema. All 6 `reversible_card` rows in the sample lacked these top-level fields entirely (they move into `card_faces`). A `NOT NULL` constraint on any of them will hard-fail the ingest.
- Resolve images with the rule `image_uris ?? card_faces[i].image_uris`. 169 of 4,513 sampled cards (3.7%) have NO top-level `image_uris`: layouts `transform`, `modal_dfc`, `double_faced_token`, `reversible_card`, and `art_series`. Conversely `split`, `adventure`, `flip`, and `prepare` have card_faces but images ONLY at top level, and `meld` has top-level images and NO card_faces at all. Store images per face index, not per card.
- Store `legalities` as a JSON blob or a `(card_id, format, legality)` key-value table — never as 23 fixed columns. The key set currently has 23 entries (standard, future, historic, timeless, gladiator, pioneer, modern, legacy, pauper, vintage, penny, commander, oathbreaker, standardbrawl, brawl, competitivebrawl, alchemy, paupercommander, duel, oldschool, premodern, predh, tlr) and demonstrably grows over time; `tlr` is a recent addition.
- Model `prices` with exactly 6 keys — usd, usd_foil, usd_etched, eur, eur_foil, tix. The documentation claims a 7th key `eur_etched`, but it appears ZERO times across 4,513 real card objects. Parse all values as decimal STRINGS (or null), never as floats.
- Key inventory rows on `(scryfall_id, finish)` where finish comes from the `finishes` array (`nonfoil`/`foil`/`etched`), and map finish to the matching price field. Use `finishes` rather than the deprecated top-level `foil`/`nonfoil` booleans — those are the only way to detect `etched`, which has its own separate price and its own `tcgplayer_etched_id`.
- Treat `collector_number` as a STRING and sort it with a natural/numeric-aware comparator. Real values include `99b`, `1556`, and numbers containing the star character. A lexical sort puts card 10 before card 2.
- Filter for paper collecting with `"paper" in games` rather than `digital == false`. The `games` array spans paper, arena, mtgo, astral, and sega; digital-only rows were 8.6% of the sample.
- Detect alternate arts via `illustration_id` (stable across reprints of the same art), NOT via the `variation` boolean — `variation` was true on only 4 of 4,513 cards (0.09%). Layer `frame_effects`, `border_color`, `full_art`, and `promo_types` on top to distinguish showcase/borderless/extended-art treatments that share one illustration.
- Never bulk-prefetch images; fetch lazily and cache on disk. Extrapolated full-library caches: `thumb` webp 1.09 GB, `grid` webp 7.36 GB, `normal` jpg 13.27 GB, `large` jpg 21.56 GB, `png` 161.75 GB. Prefer the new WEBP formats — `thumb` (replaces small), `grid` (replaces normal), `display` (replaces large), `crop` (replaces border_crop), `art` (replaces art_crop) — which cut 39-48% off the JPG equivalents and which the docs describe as replacements, signaling JPG deprecation.
- Invalidate cached images on the `image_updated_at` field (new top-level ISO timestamp), and re-fetch when `image_status` improves from `lowres`/`placeholder` to `highres_scan`. Image URLs carry a `?<epoch>` cache-buster matching that timestamp and are served with `Cache-Control: public, max-age=31556952` (1 year), so a stale cache would otherwise persist indefinitely. Always read the URL from `image_uris` rather than constructing it, per Scryfall's explicit guidance.
- Send `User-Agent: YourAppName/1.0 (+url; contact)` and an `Accept` header on EVERY request — both are mandatory and Cloudflare returns HTTP 403 without a real UA (this blocked automated fetching during research). Scryfall states explicitly: 'Do not allow HTTP libraries to choose the header for you.'
- Rate-limit per endpoint, not globally: 10/sec for general methods, 2/sec for /cards/search, /cards/named, /cards/random, /cards/collection, and 10/MINUTE for /cards/manifest. Crucially, `*.scryfall.io` file origins (bulk downloads and card images) have NO rate limit — so route all image and bulk traffic there and reserve api.scryfall.com for metadata. Implement 429 backoff: a 429 locks you out for 30 seconds and repeat offenders face permanent bans.
- Ingest into a staging table then atomically swap (or use `INSERT ... ON CONFLICT(id) DO UPDATE`) so a failed or interrupted update never leaves a half-populated card table while the user's collection table still references it. Keep the old data queryable throughout the background refresh.
- Tune SQLite for the bulk load: `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, insert in transactions of 1,000-5,000 rows, and drop/rebuild secondary indexes around the load. Budget roughly 60-120 s for 116,568 rows plus 10-30 s download, all off the UI thread with progress reported against an expected ~116.5k line count.
- Never block app launch on the network. Start from the local DB immediately and run the ETag check and any refresh in the background. On first run only, show a progress UI for the initial ingest.
- Honor the usage policy in the UI: display the `artist` name in any view built on `art_crop`/`art` tiles (explicitly required), do not apply filters, watermarks, or distortion to card images, and do not paywall card data — a paid tier may gate app features but not access to Scryfall data itself.
- Surface prices as estimates with an explicit as-of date drawn from the bulk file's `updated_at`. Scryfall warns prices are 'dangerously stale after 24 hours' and 'not updated frequently enough to power a storefront or sales system.' Also note `tix` is MTGO event tickets, not a fiat currency, and should not be summed with usd/eur.
- Handle these type traps in the schema: `cmc` is Decimal (funny cards have fractional mana values), `power`/`toughness`/`loyalty`/`defense` are strings (`*`, `1+*`, `∞`), `colors` is nullable (moves to card_faces), and text is UTF-8 with em-dashes, stars, and accents throughout. Also note English cards can now carry `printed_name`/`printed_text`/`printed_type_line` since the Sept 2025 Omenpaths change, so those fields no longer imply a non-English printing.
