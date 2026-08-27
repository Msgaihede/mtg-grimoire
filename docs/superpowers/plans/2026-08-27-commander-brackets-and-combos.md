# Plan — Commander brackets: a manual override, current rules, and combo data

Closes [#169](https://github.com/Msgaihede/mtg-grimoire/issues/169). Research:
[2026-08-27-commander-brackets-and-combos.md](../research/2026-08-27-commander-brackets-and-combos.md).
**Read that first — it carries every number and every rule this plan assumes.**

Half of #169 already ships: `DeckLedger` puts card count, price, format and the bracket readout on
the header's second line (2026-08-24). What is left is the Commander half.

## What changes

1. **A deck can be told its bracket.** `decks.bracket`, `0` = Auto, `1`–`5` set by hand.
2. **The estimate is brought current.** The estimator implements the February 2025 beta, which
   October 2025 replaced. Tutors stop being a signal, mass land denial drops from 5 to 4, and the
   estimate never returns 5 again — brackets 4 and 5 have identical deck restrictions, and what
   separates them is an intent no card list shows.
3. **The estimate becomes a floor**, which is what every bracket restriction actually is: "not
   allowed below bracket N". That is also what makes the warning possible — a set bracket below
   the floor is the mismatch to report.
4. **Combos arrive as a fourth optional bulk feed.** Commander Spellbook's `variants.json.gz`,
   ingested the way the price feeds and the tagger datasets are: nothing downloads until asked,
   a failure keeps the previous rows, and a database that has never fetched it is a supported
   state whose bracket estimate simply reads three signals instead of four.

## Contracts every task codes against

### Schema v26

```sql
ALTER TABLE decks ADD COLUMN bracket INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS combos (
    id             TEXT PRIMARY KEY,   -- Commander Spellbook variant id
    bracket_tag    TEXT NOT NULL,      -- R|S|P|O|C|E|B
    card_count     INTEGER NOT NULL,   -- DISTINCT oracle ids in combo_cards for this combo
    template_count INTEGER NOT NULL,   -- `requires[]`; > 0 means this app cannot fully check it
    identity       TEXT NOT NULL,
    produces       TEXT NOT NULL,      -- feature names, '\n'-joined
    popularity     INTEGER
);
CREATE TABLE IF NOT EXISTS combo_cards (
    combo_id          TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
    oracle_id         TEXT NOT NULL,
    name              TEXT NOT NULL,
    quantity          INTEGER NOT NULL,
    must_be_commander INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_combo_cards_combo  ON combo_cards(combo_id);
CREATE INDEX IF NOT EXISTS idx_combo_cards_oracle ON combo_cards(oracle_id);

CREATE TABLE IF NOT EXISTS combo_meta (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    etag        TEXT,
    stamp       TEXT,                          -- the file's own `timestamp`
    fetched_at  INTEGER,                       -- when rows last changed; NULL = never ingested
    checked_at  INTEGER NOT NULL,
    combo_count INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0     -- variants dropped: not `OK`, or not Commander-legal
);
```

`bracket` is `NOT NULL DEFAULT 0` with `0` meaning **Auto**, deliberately mirroring
`decks.default_category_id`'s `AUTO_CATEGORY` sentinel rather than being nullable: `DeckPatch`'s
rule is that an absent field means "leave it", so a nullable column would make "put it back to
Auto" unreachable through the patch without double-`Option` machinery. Rust spells the sentinel
`deck::AUTO_BRACKET`; TypeScript spells it `AUTO_BRACKET` beside `AUTO_CATEGORY`.

### The match query

`combo_cards.oracle_id` is the index this turns on. Start from the deck, never from `combos`:

```sql
WITH deck(oracle_id) AS (SELECT DISTINCT oracle_id FROM cards
                          WHERE id IN (…) AND oracle_id IS NOT NULL),
     hit AS (SELECT cc.combo_id, count(DISTINCT cc.oracle_id) AS have
               FROM combo_cards cc JOIN deck d ON d.oracle_id = cc.oracle_id
              GROUP BY cc.combo_id)
SELECT c.id, c.bracket_tag, c.template_count, c.produces, c.popularity
  FROM hit h JOIN combos c ON c.id = h.combo_id
 WHERE h.have = c.card_count;
```

### IPC

```ts
export const AUTO_BRACKET = 0;

export type ComboBracketTag = "R" | "S" | "P" | "O" | "C" | "E" | "B";

export interface DeckCombo {
  id: string;
  bracketTag: ComboBracketTag;
  /** Card names, the file's order. */
  cards: string[];
  /** Templates the combo also needs ("a creature with flying") — unresolvable here. `0` is a
   *  combo the deck definitely has. */
  templateCount: number;
  /** What it does — feature names, one per line. */
  produces: string;
  popularity: number | null;
}

export interface ComboStatus {
  combos: number;
  cards: number;
  stamp: string | null;
  /** Unix seconds when rows last changed; `null` on a database that has never ingested. */
  fetchedAt: number | null;
  checkedAt: number | null;
  stale: boolean;
}

export type ComboPhase = "checking" | "downloading" | "ingesting" | "done" | "error";
export interface ComboProgress { phase: ComboPhase; done: number; total: number }

ipc.combosStatus(): Promise<ComboStatus>            // combos_status
ipc.combosRefresh(force: boolean): Promise<ComboStatus>  // combos_refresh
ipc.combosForCards(cardIds: string[]): Promise<DeckCombo[]>  // combos_for_cards
```

Event `combos:progress` carries `ComboProgress`.

`DeckRow.bracket: number` and `DeckPatch.bracket?: number` join the existing shapes.

### The floor

```
4  gameChangers >= 4, or any mass land denial, or >= 3 extra-turn cards, or a combo tagged R
3  gameChangers 1–3, or a combo tagged P or S
2  any extra-turn card, or a combo tagged C or O
1  none of the above
```

Highest wins. Never 5. Tags `E` (any deck) and `B` (banned — a legality finding the engine
already reports from the banned list) raise nothing. Combos with `templateCount > 0` raise
nothing either: their named cards are all present but the template is not checkable, so they are
shown as *possible* and kept out of the arithmetic.

`>= 3 extra-turn cards → 4` is **this app's judgement, not the document's**: brackets 2 and 3
allow extra turns "in low quantities … not intended to be chained", and three is where this app
draws chaining. Say so wherever it is written down.

## Tasks

Each task owns the files listed. **No file appears twice.** Do not run the suites — the
controller runs `npm run verify` once after fan-in.

### A — Rust: schema v26
`src-tauri/src/schema.rs`, `src-tauri/src/deck.rs`, `src-tauri/src/deck_undo.rs`

The v26 rung: the DDL above, plus staging tables `combos_staging` / `combo_cards_staging` and
`create_combo_staging` / `drop_combo_staging` / `swap_combo_staging` mirroring the tag family's
three helpers (a swap replays the two indexes — a rename carries the *staging* table's indexes).
`SCHEMA_VERSION` to 26; the rung writes the literal `26`, as every rung before it writes its own.

`deck.rs`: `AUTO_BRACKET`, `DECK_SELECT`'s column list (append, never insert — the reads are
positional), `DeckRow.bracket`, `DeckPatch.bracket`, `DeckBefore` + the audit line, validation
refusing anything outside `0..=5` by name, `duplicate_deck` carrying it. `deck_undo.rs`:
`"bracket"` on `DECK_FIELDS`.

### B — Rust: the combo feed
`src-tauri/src/combos.rs` (new), `src-tauri/src/lib.rs`

Modelled on `marketplace_feed.rs`, not on `tags/` — this is not Scryfall, so it gets its own
`reqwest` client, its own timeouts, no share of the rate-limit budget and no place in the 429
penalty state. Streaming throughout: reqwest byte stream → temp file under `data_dir/tmp/` →
`flate2::read::GzDecoder` → `serde_json` `DeserializeSeed` over the `variants` array, one variant
live at a time. `MAX_FEED_BYTES` guard against the declared length *and* the streamed total.
Keep only `status == "OK"` and `legalities.commander == true`; count the rest into
`combo_meta.skipped`. Staging tables filled, then swapped inside one transaction. A failure
writes `error_log` and leaves the previous rows standing. Weekly refresh interval, `force` past
it, ETag for a free 304. Three commands and the progress event from the contract above.

### C — TypeScript: the bracket rules
`src/features/decks/validation/bracket.ts`, `src/features/decks/validation/bracket.test.ts`

Implement the floor. Delete `isTutor` and everything that fed it, citing the October 2025 removal.
`BracketEstimate` gains `floor` (replacing `bracket`), `combos`, `possibleCombos` and `reasons`
— a `reasons` entry says which rule set the floor and which cards or combos it read. Add
`bracketWarning(set, estimate)` returning the mismatch sentence or null.

### D — TypeScript: the IPC bindings
`src/lib/ipc.ts`, `src/lib/ipc.test.ts`

Everything under **IPC** above, documented in this file's voice.

### E — UI: the bracket control
`src/features/decks/DeckBracket.tsx`, `.test.tsx`, `.stories.tsx`, `src/features/decks/DeckEditor.tsx`

The button reads the set bracket when there is one (`Bracket 3`, no tilde) and the estimate
otherwise (`Bracket ~3`). A set bracket below the floor gets a warning treatment and an
`aria-label` that says so in words. The advisory gains an `Auto` + 1–5 picker writing
`deckUpdate(id, { bracket })`, the mismatch sentence, and the combos found — with the possible
ones on their own line. `combosForCards` is queried inside `DeckBracket`, which only mounts for a
format with a command zone; key it on the sorted card ids. When `combosStatus` reports nothing
ingested, say so and point at Settings rather than implying the deck has no combos.

### F — Settings: the combo feed panel
`src/features/settings/CombosPanel.tsx`, `.test.tsx`, `.stories.tsx`,
`src/features/settings/SettingsPage.tsx`, `src/features/settings/SettingsPage.stories.tsx`

`MarketplacePanel`'s shape: what is ingested, how old, a Refresh, the progress line, and honest
copy for a database that has never fetched it. Sits after `MarketplacePanel`.

### G — Storybook: the fake
`.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`, `.storybook/fake/cards.ts`

The three commands against fixture data, `bracket` on the fake deck rows, and a seed with a
recognisable two-card combo in it so E's and F's stories have something to draw.

### H — Docs
`docs/reference/commander-brackets.md` (new), `CLAUDE.md`, `src/features/decks/CLAUDE.md`,
`src-tauri/CLAUDE.md`, `docs/reference/decks-storage.md`

The long-form record: the current bracket table, what the app can and cannot see, the feed's
measured numbers, and the three judgements that are this app's rather than the document's.
