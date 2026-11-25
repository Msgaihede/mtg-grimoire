# MCP server: rulings (project D of the MCP improvements)

Date: 2026-11-25. Status: approved by the owner, 2026-11-25.

Project D of the five in [the card knowledge design](2026-11-24-mcp-card-knowledge-design.md) §2:
"Import Scryfall's rulings bulk file as a weekly feed; a rulings tool; rulings added to
`card_interactions`". That design's binding decisions hold here: every tool is a translation onto
`grimoire_core::commands::dispatch`, no tool writes the reader's data, every prompt is reachable
through `read_guide`, and an answer that rests on a feed says when that feed was never downloaded.

## 1. Why

An agent asked "how does Blood Moon work with Urza's Saga?" today has the oracle text and nothing
else. The `card_interactions` prompt tells it so in as many words: "The app has no rulings yet. For
how an interaction resolves, reason from the oracle text and say that is what you did." Wizards
publishes rulings for exactly these questions (the release notes Gatherer carries), and Scryfall
publishes all of them as one bulk file. Project D downloads that file as the tag and combo files
are downloaded, stores it in the corpus, and puts it in front of an agent.

## 2. The owner's decisions (2026-11-25, this session)

| Question | Decision |
| --- | --- |
| Which apps download the rulings file | **The desktop only.** It is the only app with the MCP server, and no page reads rulings. The read command is in `grimoire-core` either way, so the Android and web hosts answer it (with "never downloaded") and could fetch the file later. |
| What `get_card` says about rulings | **A count and a pointer**: `rulingCount` and `rulingData`, and its description names `card_rulings` for the text (the way it treats combos with `comboCount`). |
| Whether people see rulings in the app | **Agents only.** No TypeScript change. A rulings section on the card page can be a project of its own later. |

## 3. Goals, non-goals, anti-goals

**Goals:**

1. The desktop holds Scryfall's rulings, refreshed weekly at launch, through the app's own
   Scryfall client (its pacing gate and its 429 lockout), with no other request to Scryfall.
2. An agent can read every ruling of one or more cards, oldest first, each with its date and
   whether it is Wizards' or Scryfall's.
3. An agent is never told "no rulings" when the rulings were never downloaded.
4. `get_card` says how many rulings a card has, so an agent knows when to ask for them.
5. The `card_interactions` prompt teaches when to read rulings and how to cite them.

**Non-goals:** rulings on any page (the card modal, the phone's card sheet); a Settings button to
fetch them; fetching them on Android or the web; rulings in the read graph; searching ruling text
across cards; any change to how combos, tags or cards are fetched.

**Anti-goals, which would make this a failure even if it works:**

- An agent told a card has no rulings when the list was never downloaded (A's anti-goal, one
  feed over).
- An extra live call to Scryfall: no per-card `/cards/{id}/rulings`, from a tool or anywhere else.
  One `GET /bulk-data/rulings` a week and one file download when it changed — which, since
  Scryfall regenerates the file daily, is nearly every week (corrected in review, 2026-11-25).
- A launch or a card sync that waits on, or breaks over, the rulings file.
- An agent that presents its own reasoning as a ruling, or a ruling as current when a later one
  may have overtaken it.

## 4. The file, measured

Measured live on 2026-11-25 against that day's file (one manifest request, one download, from the
development container; the figures are what this design rests on):

| | |
| --- | --- |
| Manifest | `GET /bulk-data/rulings`: `jsonl_download_uri` and `compressed_size`, the shape `scryfall::BulkInfo` already reads for the three files the app fetches (no `download_uri`/`size`), weak ETag |
| Payload | 5 508 481 bytes gzipped JSONL (`application/gzip`), 26.8 MB of JSON, regenerated daily (`updated_at` 10:00 UTC) |
| A line | `{"object":"ruling","oracle_id":…,"source":"wotc"\|"scryfall","published_at":"YYYY-MM-DD","comment":…}`: the same five keys on every line |
| Rulings | 80 928 over 20 387 distinct oracle ids; 0 unparseable lines, 0 without an oracle id, 0 with an empty comment |
| Per card | median 3, 90th percentile 9, 99th 16, most 32 |
| Sources | `wotc` 80 859, `scryfall` 69 |
| Dates | 2004-10-04 to 2026-10-07; within one card the file is already in date order (0 steps back in date) |
| Text | median 182 characters, 99th percentile 531, longest 1 564; 16.4 M characters in all; curly quotes and mana symbols (`{E}`) as written |
| Duplicates | 43 lines repeat another line of the same card exactly (oracle id, source, date and text) |
| Stored | 80 885 rows after the duplicates, **22.4 MB** as a `WITHOUT ROWID` table keyed `(oracle_id, seq)` (26.4 MB as a rowid table with the same key), 0.7 s to insert in one Python transaction; one card's rulings by its key in 0.03 ms, a primary-key search with no sort |

The corpus holds about 37 500 cards (oracle ids), so roughly 17 000 of them have no ruling at all,
and "no rulings" is a common, true answer once the file is downloaded.

## 5. Approaches for the feed

1. **A new core module, `rulings`, on the existing parts** (chosen). Its own small ingest sink
   and refresh, on what the other feeds already share: `scryfall::Client` (`check_bulk_dataset`,
   `download`), `feed::frame` (gzip and lines), `feed::mostly_unusable`, `feed::backoff`,
   `tags::is_stale` and `tags::now_from`. Each feed in core already has its own refresh
   (`tags`, `combos`, `marketplace_feed`), so this follows the codebase.
2. **Extract the tag engine's refresh into a shared Scryfall bulk-file driver** and run tags and
   rulings through it. Less code in the end, but it rewrites a tested engine that three hosts run,
   inside a project about rulings. Not chosen; a candidate for later if a fifth Scryfall file is
   added.
3. **A third `tags::Dataset`.** The tag engine's shape is a taxonomy with parents and a closure;
   rulings would fit only by ignoring most of it. Not chosen.

## 6. The design

### 6.1 Storage: corpus schema 10

Two corpus tables, created by the v0 build (`create_corpus_schema`) and by a rung for every corpus
that lacks them:

```sql
CREATE TABLE {schema}.rulings (
    oracle_id    TEXT NOT NULL,
    seq          INTEGER NOT NULL,  -- this ruling's place among the card's, in the file's order
    source       TEXT NOT NULL,     -- 'wotc' or 'scryfall', as the file says
    published_at TEXT NOT NULL,     -- 'YYYY-MM-DD', as the file says
    comment      TEXT NOT NULL,
    PRIMARY KEY (oracle_id, seq)
) WITHOUT ROWID;

CREATE TABLE {schema}.ruling_meta (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    etag         TEXT,
    updated_at   TEXT,
    ingested_at  INTEGER NOT NULL,
    checked_at   INTEGER NOT NULL,
    ruling_count INTEGER NOT NULL,
    card_count   INTEGER NOT NULL
);
```

- **The rung is gated on the shape, never on the number** (`migrate_corpus`'s rule, and its
  reason: `split::finish` stamps head onto every converted database and every fresh install). It
  fires when `{schema}.sqlite_master` lacks either table and runs `CREATE TABLE IF NOT EXISTS` for
  both, so it is safe whichever one is missing. `CORPUS_SCHEMA_VERSION` becomes 10. Nothing is
  backfilled: only the feed has the rows, and the next launch fetches them (a new table has no
  `ruling_meta` row, so the feed is due).
- `rulings_staging` is the same table again, created and dropped by `schema` functions
  (`create_ruling_staging`, `drop_ruling_staging`) from a literal of its own, held to the live
  table column by column by a test, as the tag and combo staging twins are. The swap is a rename
  inside the caller's transaction, with the `ruling_meta` row written in the same transaction. The
  primary key travels with the rename; there is no other index to replay.
- `oracle_id` is a soft reference, like every reference to `cards`: a ruling for a card the
  corpus lacks (a digital-only card, say) is stored and simply never asked for.
- Both tables join `schema::TABLES` as `Side::Corpus`. `user.db` is not touched.
- **Corpus schema 10 is the number on today's `main`.** Projects C and E run in parallel; if
  either takes 10 first, this rung is renumbered before merging, in its own commit.

### 6.2 The feed (`crates/grimoire-core/src/rulings.rs`)

- `BULK_NAME = "rulings"` (as `scryfall::BULK_RULINGS`, beside the other three), which is also the
  `error_log` operation and the `feed::backoff` key. `REFRESH_INTERVAL_SECS` is a week; the file
  is regenerated daily, and the week is this app's choice of how often to ask, as for the tag
  files.
- **The ingest is a push sink** (`StreamRulings`: `begin`, `push(chunk)`, `finish(stamp)`,
  `abandon`), which `tags::StreamTags` is the model for: gzip through `feed::frame::Decoder`, lines
  through `feed::frame::Lines`, rows written to `rulings_staging` 2 000 to a transaction through
  `db::lock_background`, standing aside between batches. `ingest_gz` reads the downloaded file in
  64 KB chunks and pushes.
- **What a line must be**: a JSON object with `object: "ruling"`, a non-empty `oracle_id`, a
  `source`, a `published_at` and a non-empty `comment`. Anything else is counted and stepped over.
  An exact repeat of a ruling already kept for the same card is dropped (43 today). `seq` counts
  each card's kept rulings in file order.
- **Refused files swap nothing**: one with no rulings, and one more unusable than usable
  (`feed::mostly_unusable`). A refused or failed ingest drops the staging table and keeps the
  previous rulings.
- **`refresh(state, force, progress)`** is the tag engine's refresh for one file: one claim at a
  time (`any_refresh_running`, which `reset::cache_clear` also asks, since the download sits in
  `data_dir/tmp/`), the `checked_at` throttle unless forced, `check_bulk_dataset` with the stored
  ETag only when rows exist, `mark_checked` on a 304 or an unchanged `updated_at`, the download to
  `tmp/rulings.jsonl.gz` with its size check and resume, the ingest on the blocking pool, the
  temporary file removed either way, failures to `error_log` (`Source::ScryfallApi`), a day's rest
  after a file that arrived and could not be used (`feed::backoff`), and a 429 written to disk
  before it returns (`sync::persist_penalty`).
- **No streamed driver yet**: on a host that keeps no files, `refresh` refuses in one sentence
  before it asks Scryfall anything. The push sink is what a streamed driver would feed, so
  fetching on the web host later is that driver (the tag engine's `refresh_streamed`, about a page)
  plus the host's launch line; on Android it is the launch line alone.
- **`refresh_if_due(state)`**: stale and not resting, then `refresh` with no progress sink.
  Silent and best-effort.
- **No progress event and no refresh command.** No page listens and no tool may fetch anything;
  `refresh` takes its progress callback so tests can drive it.
- **The desktop launch** (`desktop.rs`'s `spawn_optional_feeds`) gains a seventh task,
  `grimoire_core::rulings::refresh_if_due`, beside the tag and combo tasks and for their reason: a
  separate service on its own schedule that must not be the reason another is late. The light
  app's hosts and `downloads::launch_due` (the light app's metered-data prompt) do not change.

### 6.3 The core commands

Both are read commands, in core's table, on `command_table::TABLE_ONLY` with their reason (no
page calls them):

- **`rulings_for_cards { oracleIds }`** → `Vec<CardRulings>`, one entry per distinct asked id in
  the order asked, each `{ oracleId, rulings: [{ source, publishedAt, comment }] }` in `seq` order
  (oldest first). An id with no rows answers an empty list, so "no rulings" and "not asked" stay
  apart. Blank ids are dropped; ids are looked up 500 to a statement (`tags`' `LOOKUP_CHUNK`).
  Named after `oracle_tags_for_cards`, which also takes oracle ids.
- **`rulings_status`** → `RulingStatus { updatedAt, ingestedAt, checkedAt, rulingCount,
  cardCount, stale, refreshing }`, the shape of `TagStatus`. Reads one row, never fails: a corpus
  with no `ruling_meta` row answers `null`s and `stale: true`.

### 6.4 The MCP tool `card_rulings`

| Arguments | Calls | Answers |
| --- | --- | --- |
| `cardIds` (1–10 printing ids, required) | `card_detail` for each id's name and oracle id, then `rulings_for_cards`, then `rulings_status` | `cards`: per id asked, `{ cardId, name, oracleId, rulings: [{ publishedAt, source, text }] }`; `missing`: the ids the database lacks; `rulingData: { downloadedAt }`, and a `note` when that is `null` |

- Several cards in one call, because an interaction question is usually about two or three.
  Printings of one card share their rulings; each id asked gets its own entry anyway, so the
  answer lines up with the question.
- `text` is Scryfall's `comment`, renamed because a "comment" reads as somebody's opinion.
- The description says rulings are Wizards' official rulings (`source: "wotc"`) plus a few notes
  of Scryfall's own (`"scryfall"`); that each is dated and an older one can predate a rules change;
  and that a card can truly have none.
- Read-only: `readOnlyHint: true, openWorldHint: false`. A card id the database lacks is named in
  `missing` rather than failing the call; all ids missing still answers.

### 6.5 `get_card`

`get_card` gains `rulingCount` (the length of the card's list from `rulings_for_cards`) and
`rulingData: { downloadedAt }`, with the note when the list was never downloaded. Its description
names `card_rulings` for the text. A read that fails leaves both fields out, as `get_card` already
does for its other extras.

### 6.6 The "never downloaded" note

`with_feed_data` (`mcp/tools.rs`) builds the note for every feed. Its last sentence today is "The
app fetches it weekly when it starts, and Settings can fetch it now." That is true of combos
(Settings → local cache has *Refresh combos*) and not of oracle tags, which Settings has no button
for (the page's tag refresh wrapper was removed on 2026-09-27), nor of rulings. So the helper takes the fetch sentence per feed:
combos keep "…and Settings can fetch it now"; oracle tags and rulings say "The app fetches it
weekly when it starts." For rulings:

> The rulings list has not been downloaded yet, so an empty answer does not mean there are no
> rulings. The app fetches it weekly when it starts.

`rulingData.downloadedAt` is `ruling_meta.ingested_at`.

### 6.7 The `card_interactions` prompt and the server's `instructions`

- The table of questions gains rows: "How do these two cards work together?", "does this trigger
  when…?", "what happens if…?" → `card_rulings` for each card, then reason from the oracle text and
  the rulings; and `get_card`'s `rulingCount` says whether a card has any.
- "The app has no rulings yet" becomes the rule for citing them: say a ruling is Wizards' (or
  Scryfall's note), give its date, quote it rather than paraphrase where the wording matters, and
  when no ruling covers the question, say the answer is reasoned from the oracle text. A ruling
  older than a later rules change can be out of date; prefer the newer when two disagree.
- "A list that was never downloaded" names the rulings list and `rulingData` beside combos and
  tags, and says which list Settings can fetch (combos only).
- `rpc.rs`'s `INSTRUCTIONS` names `card_rulings` (a test already holds the instructions to every
  tool).
- 27 tools after project D.

### 6.8 Documentation

- `docs/reference/local-mcp-server.md`: `card_rulings` in the tool table, `get_card`'s new
  fields, the prompt row, and §6's "still to do" without rulings.
- `docs/reference/data-and-sync.md`: corpus schema 10 and the rulings feed (tables, refresh,
  §4's measurements).
- `docs/agent/EXTERNAL_SERVICES.md`: the rulings file in the Scryfall section, desktop only.
- `apps/desktop/src-tauri/CLAUDE.md`: the MCP bullet (27 tools, `card_rulings`, the two
  commands on `TABLE_ONLY`) and the launch's seventh feed.
- `schema.rs`'s `CORPUS_SCHEMA_VERSION` doc gains the schema 10 paragraph.

## 7. Testing

- **The rung**: a corpus built at head with both rulings tables dropped, once stamped 9 and once
  stamped 10 (the split's population), climbs to a corpus with both tables at version 10, its
  other rows untouched; a second migrate is a no-op; a corpus at head with only one of the two
  tables gets the other.
- **Staging**: `rulings_staging` matches `rulings` column by column (`PRAGMA table_info`), and the
  swap leaves the primary key in place.
- **Ingest**: a fixture file covers a good card, two cards, an exact duplicate, a line with no
  oracle id, a non-ruling object, a line that is not JSON, and file order kept as `seq`; a file
  with no rulings and a mostly unusable file are refused and keep the previous rows; the meta row
  counts rulings and cards.
- **Refresh** against a mock Scryfall (`httpmock`, as the tag and combo refreshes are tested): a
  first run downloads and ingests; a run inside the week asks nothing; a 304 moves only
  `checked_at`; an unchanged `updated_at` downloads nothing; a size mismatch keeps the old rows
  and rests the feed; a second concurrent refresh is refused; the temporary file is removed; a
  host that keeps no files is refused before any request (`platform::host::emulate_page`).
- **Reads**: `rulings_for_cards` answers in the order asked, oldest first, empty for an id with
  no rulings; `rulings_status` on a corpus with no meta row.
- **Command table**: `commands::tests::every_command_answers_on_one_connection_and_one_thread`
  and `command_table::` pass with the two `TABLE_ONLY` entries.
- **MCP**: `card_rulings` against a real database on disk (several ids, a missing id, a card with
  none, the never-downloaded note); `get_card`'s `rulingCount` and note; the tag note no longer
  names Settings and the combo note still does; `structuredContent` and the instructions tests
  cover the new tool.
- `pnpm verify` once, at the end.

**Owed on the owner's machine** (this session runs on Linux and cannot): a launch of the Windows
desktop that fetches the real file into the owner's corpus (time and size of the ingest beside the
other feeds), and one agent question answered through a real client.

## 8. Calls made in this design that the owner did not make

These are proposals; each can be overruled:

1. `card_rulings` takes printing ids (`cardIds`, 1–10) like every other tool, and resolves them to
   oracle ids; the core command is keyed by oracle id.
2. Exact duplicate rulings (43 today) are dropped at ingest.
3. Rulings are answered in file order, which is date order, oldest first.
4. One `WITHOUT ROWID` table keyed `(oracle_id, seq)`, no other index (22.4 MB).
5. No progress event and no `rulings_refresh` command.
6. A push sink and only the file-backed driver: the web host would need a streamed driver before
   it could fetch the file.
7. Scryfall's `comment` is answered as `text`.
8. `rulingCount` is the length of the card's list, not a count query of its own.
9. The fetch sentence of the "never downloaded" note is per feed, which also corrects the oracle
   tag note (it promised a Settings button that does not exist).
