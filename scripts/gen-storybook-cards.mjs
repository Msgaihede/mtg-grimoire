#!/usr/bin/env node
// Regenerate `.storybook/fake/cards.ts` from the local card database.
//
//     node scripts/gen-storybook-cards.mjs
//
// The fixture is a corpus of *real* printings, and this script is the reason that claim can
// be checked: every field of every row is a column of `cards` as the app's own sync wrote
// it, so a fixture cannot quietly disagree with the shapes the app parses. Legality blobs
// are the case that made this worth a script — all 116 694 rows carry exactly 23 keys
// (measured 2026-08-09), the set grows with every new format, and a hand-written blob is a
// second source of truth that drifts silently because nothing type-checks its keys.
//
// **Read-only, and the database is the user's.** `data/` is gitignored and holds a
// collection nobody can regenerate; this opens with `readOnly: true` and issues nothing but
// `SELECT`s. The generated `.ts` and this script are committed; the database never is.
//
// Under `tauri dev` the database is `src-tauri/target/debug/data/mtg.db` — the data folder
// sits beside the *exe*, and under dev that exe is in `target/debug`. Override with
// `MTG_DB` if a different copy is wanted.

import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";

const repoRoot = resolve(import.meta.dirname, "..");
const dbPath = process.env.MTG_DB ?? resolve(repoRoot, "src-tauri/target/debug/data/mtg.db");
const outPath = resolve(repoRoot, ".storybook/fake/cards.ts");

/**
 * The corpus, as natural keys plus the render branch each row exists to make reachable.
 *
 * Keyed by `(name, set, collector number, lang)` rather than by Scryfall id, so a reader can
 * see what a row *is* without resolving a UUID — and so a selection that stops resolving
 * after a sync fails loudly here rather than silently emitting a shorter corpus. The four
 * parts together are unique: `sld` alone has 15 English Lightning Bolts and one of them is
 * collector number `1638★`, a different printing from `1638`.
 *
 * The comment is emitted above the row it belongs to. It is the fixture's contract with the
 * stories: delete a row and whatever branch it names stops being reachable.
 */
const SELECTIONS = [
  // --- Lightning Bolt: four printings of one oracle card, for the printings list and the
  // printing swap. Each differs in the field that list is *read* by.
  ["Lightning Bolt", "lea", "161", "en", "The printings list's oldest row: common, black border, nonfoil only, and `usd` 620.00 — a three-figure price on a card printed at common."],
  ["Lightning Bolt", "2x2", "117", "en", "The same card at a different rarity — a printings list that showed one gem for the card rather than one per row would look right here and be wrong."],
  ["Lightning Bolt", "sld", "1638", "en", "Borderless, full-art, `frameEffects` set: the three fields a printings row is *distinguished* by, all at once."],
  ["Lightning Bolt", "sta", "105", "ja", "`lang` is not always `en`. Every language is listed in a printings list, and a row that assumes English silently mislabels this one."],

  // --- Black Lotus: `banned` almost everywhere, and the digital printing a paper list drops.
  ["Black Lotus", "lea", "232", "en", "**No dollar price at all**: `usd`, `usd_foil` and `usd_etched` are all null, so `card_row`'s fallback chain resolves `priceUsd` to null while `eur` reads 38 719.86. A card nobody can quote in USD is not a bug and a `—` is the right answer; it is also the legality panel's longest red column."],
  ["Black Lotus", "vma", "4", "en", "`isPaper: false` (with `digital: true`) **and** rarity `bonus`, which has no colour token: the paper-only filter has something to hide — and it hides it by `isPaper`, not by `digital` — and `RarityGem` has its uncoloured branch."],

  ["Ancestral Recall", "lea", "47", "en", "`restricted` in vintage — the `max_one` restricted semantic, which is a different rule from `banned` and must not render as one. Its `usd` is null too."],
  ["Ancestral Recall", "2ed", "48", "en", "**`usd` 4 999.95** — the four-figure price the formatter's widest column has to hold, and the only one in this corpus. Paired with the `lea` row above on purpose: one oracle card, two printings, one priced in dollars and one not, so a printings list shows both states at once."],

  // --- Lands and basics.
  ["Forest", "unf", "239", "en", "A full-art basic: unlimited copies in a singleton deck, and `fullArt: true`."],
  ["Island", "lea", "288", "en", "A plain basic, so the full-art branch has a non-full-art twin to be told apart from."],
  ["Urza's Saga", "mh2", "259", "en", "`layout: \"saga\"` on a land, with an empty mana cost — a cost line that must render as nothing rather than as `{}`."],
  ["Ancient Tomb", "tmp", "315", "en", "`gameChanger: true` on a land — the Commander bracket chip on a card with no mana cost at all."],

  // --- The layouts. Each one is a different shape of `faces`.
  ["Delver of Secrets // Insectile Aberration", "isd", "51", "en", "`transform`: two faces, the back with an empty mana cost that must not render as a cost pill, and a flip control addressed by face index."],
  ["Fire // Ice", "apc", "128", "en", "`split`: two faces, two costs, one card, and a `//` name the search has to match either half of."],
  ["Dusk // Dawn", "akh", "210", "en", "`split` **with `Aftermath`** — the half a reader has to turn the card *left* for, where the row above is the same layout turned right. The pane tells the two apart by `faces[1].oracleText` starting with `\"Aftermath\"`, a rule that agreed with Scryfall's `keywords` array on **347 of 347** live split printings; without this row that branch has no fixture and only the right turn is reachable."],
  ["Akki Lavarunner // Tok-Tok, Volcano Born", "chk", "153", "en", "`flip`: two faces printed on **one** side, so a face count answers 1 and there is no back to flip to — the card is read by turning it 180°. 45 live printings, and the only layout here whose two faces share one picture."],
  ["Llanowar", "ohop", "22", "en", "`planar`: a Plane card, printed sideways exactly as a classic split is and taking the same right turn. 330 live printings, and the layout no story covered."],
  ["Bonecrusher Giant // Stomp", "eld", "115", "en", "`adventure`: two faces where only the front is a permanent — the mana value is the creature's, not the sum."],
  ["Agadeem's Awakening // Agadeem, the Undercrypt", "znr", "90", "en", "`modal_dfc` with an `{X}` in the cost: the back is a land, so the colour identity folds in a face the front never shows."],
  ["Bruna, the Fading Light", "emn", "15", "en", "`meld`: the layout whose other half is a third card, and the one a face-count assumption breaks on."],
  ["Brisela, Voice of Nightmares", "emn", "15b", "en", "The **meld result** — and it has to be this printing rather than any Brisela: `5a7a212e-e0b6-4f12-a95c-173cae023f93` is the id Bruna's own `all_parts` names, so this is the row \"open the melded card\" lands on. 72 of the corpus's rows are `meld`, 24 of them results."],
  ["Gisela, the Broken Blade", "emn", "28", "en", "The melded card's **other half** (`c75c035a-7da9-4b36-982d-fca8220b1797`), so both of Brisela's `meld_part` relations resolve to a row the fake holds rather than one of two."],
  ["Prismatic Ending // Prismatic Ending", "amh2", "5s", "en", "`imageStatus: \"missing\"` with no image URLs at all — the no-image branch. All 162 rows in that state are `art_series` (measured 2026-08-09), so this is what that branch really looks like."],

  // --- Commander eligibility, which is the deck validator's hardest read.
  ["Smuggler's Copter", "kld", "235", "en", "A Vehicle **with a P/T box** — CR 903.3 makes a commander of it, and that is unanswerable without `power`/`toughness`."],
  ["Kenrith, the Returned King", "eld", "303", "en", "Five-colour identity from a mono-white card: `colors` and `colorIdentity` disagree, which is exactly why both are stored."],
  ["Tymna the Weaver", "fca", "18", "en", "Partner, half one — two commanders in the zone is legal only for this pair-shaped rule."],
  ["Thrasios, Triton Hero", "fca", "58", "en", "Partner, half two. Their identities union to four colours, which no single commander here has."],
  ["Lurrus of the Dream-Den", "iko", "226", "en", "A companion, with its deck-building condition in the oracle text — the string `companions.ts` re-derives the rule from."],
  ["Rhystic Study", "pcy", "45", "en", "`gameChanger: true` at rarity `common`: the bracket chip is a property of the card, never of its rarity."],

  // --- Printed values that are text, not numbers.
  ["Tarmogoyf", "fut", "153", "en", "`power: \"*\"`, `toughness: \"1+*\"` — the P/T that proves these columns are text."],

  // --- Mana costs. Every branch of `ManaText`, including the one with no glyph.
  ["Dismember", "nph", "57", "en", "Phyrexian mana (`{1}{B/P}{B/P}`) — a hybrid the font *does* draw, so it pins the glyph path beside the fallback below."],
  ["Boros Reckoner", "gtc", "215", "en", "Hybrid: `{R/W}{R/W}{R/W}`, three symbols each of which is two colours, and a `colors` string of two letters that is not JSON."],
  ["Boros Charm", "gtc", "148", "en", "Plain multicolour — `{R}{W}`, two separate pips. Here because it is *not* hybrid: read from memory it looks like one, and a fixture that conflated the two would leave `ms-rw` untested while appearing to cover it."],
  ["Kozilek, Compleated", "mb2", "502", "en", "`{8}{C/P}{C/P}` — colourless Phyrexian, one of only four tokens in the whole corpus `mana-font` has no glyph for (measured 2026-08-09: `L`, `C/P`, `HW`, `D`). Mixed with a `{8}` that *does* draw, so the braces fallback is pinned inline rather than as a whole line."],
  ["Little Girl", "unh", "16", "en", "`{HW}` — half-white, the second glyph-less token, and a mana value of **0.5**. A mana-value chip that assumes integers rounds this into the wrong bucket."],
  ["Emrakul, the Aeons Torn", "roe", "4", "en", "Mana value 15 — the `8+` chip's bucket, and the widest curve bar a deck can have."],
  ["Avacyn, Angel of Hope", "avr", "6", "en", "Mana value 8: the first value the `8+` bucket contains, which is the off-by-one the chip is most likely to get wrong."],
  ["Elesh Norn, Grand Cenobite", "nph", "9", "en", "Mana value 7 — the last bucket that is its own chip."],
  ["Consecrated Sphinx", "mp2", "8", "en", "Mana value 6, at rarity `special` — the other rarity with no colour token."],

  // --- Finishes and prices, which are a lookup in a blob rather than a column.
  ["Sol Ring", "c21", "263", "en", "Nonfoil only, colourless, one generic pip: the plainest row in the corpus and the one a layout regression shows up on first."],
  ["Sol Ring", "sld", "913", "en", "**Foil only.** A quick-add that offers nonfoil for every card writes an entry that then prices through a `usd` key this blob does not have."],
  ["Counterspell", "mh2", "267", "en", "All three finishes at once (`nonfoil`, `foil`, `etched`) — the finish picker's full row."],
  ["Restart Sequence", "acr", "211", "en", "Etched only, and `usd` is null while `usd_etched` is not: the price chain must read the finish's own key rather than falling back."],

  // --- Ordinary cards, so the corpus is not all edge cases: one per colour, at the rarities
  // and prices a search result page is mostly made of.
  ["Swords to Plowshares", "ema", "32", "en", "White, uncommon, one pip, one sentence of rules text — the short end of the oracle-text box."],
  ["Llanowar Elves", "dom", "168", "en", "Green, common, a 1/1 body: the ordinary creature every P/T column is sized for."],
  ["Jace, the Mind Sculptor", "wwk", "31", "en", "A planeswalker: mythic, four loyalty abilities, 362 characters of oracle text (measured 2026-08-09) — the long end of the same box."],
  ["Ragavan, Nimble Pilferer", "mh2", "138", "en", "Mythic at one mana, with five of the six price keys filled — only `usd_etched` is null, because it has no etched printing. The row a price column reads with almost nothing missing."],
  // --- Named treatments (`promo_types`), which are a *kind* of foil rather than a finish.
  // One row per branch of `finishTreatments` in `@/lib/treatment`, and every one of them a
  // reprint of an oracle card already above, so the printings list is where they show up
  // rather than the wall being four cards longer.
  ["Elesh Norn, Grand Cenobite", "mul", "133", "en", "**Halo Foil, foil-only.** The second card in issue #160's screenshot, where it drew the same `Sparkles` as every ordinary foil. The plainest treated row: one foil word, no choice of finish to fence against."],
  ["Elesh Norn, Grand Cenobite", "mul", "133z", "en", "**Two treatments at once** — `serialized` and `doublerainbow` — so the mark has to join them (\"Double Rainbow Foil · Serialized\") and lead with the foil word rather than the order Scryfall wrote them in. The third card on the same screenshot."],
  ["Swords to Plowshares", "msc", "143", "en", "**A foil word on a printing sold in both finishes** — `surgefoil`, `[\"nonfoil\",\"foil\"]`. The fence: 1 434 printings are like this, and the plain copy must not be called a Surge Foil. Nothing else in the corpus can catch that arm. **Swords rather than the newer Sol Ring that also fits**: `db.test.ts` resolves a bare `Sol Ring` to the *newest* printing of that name, so a 2025 reprint would have silently rewritten what two decklist-import tests are about."],
  ["Swords to Plowshares", "sld", "713", "en", "**A trait on a nonfoil-only printing** — `serialized`, `[\"nonfoil\"]`. The half of the widened reading that reaches a card which draws no mark at all today: serialized cardboard is serialized in whatever finish you hold it."],

  ["A-Vivi Ornitier", "fin", "A-248", "en", "An Alchemy rebalance: `isPaper: false`, so the search's `paperOnly` default has a second thing to hide and the two are not one set's quirk. Also the second printing whose oracle card the printings list must therefore return nothing extra for."],
];

/**
 * The `card_faces` keys the fixture keeps.
 *
 * The column holds Scryfall's array verbatim, and a double-faced card's two faces each carry
 * an `image_uris` object of eleven URLs: the Delver row's `faces` is **3 320 bytes** whole
 * and **650** projected onto this list (measured 2026-08-09). Nothing reads them —
 * `card::parse_faces` takes five of these keys, the deck validator takes the per-face cost,
 * mana value and P/T, and card art is addressed through `mtgimg://` by
 * `(card, face, variant)` rather than by URL. So this is a projection of the real blob, not
 * an invention: every key listed is copied through untouched, and none is ever synthesised.
 *
 * A split or adventure card barely shrinks (Fire // Ice: 506 → 362) because its faces carry
 * no `image_uris` at all — the front and back of one physical card is what the eleven URLs
 * are for.
 */
const FACE_KEYS = [
  "name",
  "mana_cost",
  "cmc",
  "type_line",
  "oracle_text",
  "colors",
  "color_indicator",
  "power",
  "toughness",
  "loyalty",
  "defense",
  "layout",
  "artist",
  "illustration_id",
];

/**
 * One row: every column the fixture carries, plus the one fact that is not a column.
 *
 * `ever_uncommon` is `deck::DECK_CARD_SELECT`'s own `EXISTS`, verbatim: Pauper Commander
 * eligibility is a property of the *oracle card*, so it cannot be read off the printing in
 * front of you and the `paupercommander` legality key answers a different question (the 99).
 *
 * `raw` comes back `CAST(… AS BLOB)` because the column is a **gzip member** from schema v3
 * on while still being *declared* `TEXT` — SQLite's TEXT affinity leaves a BLOB alone, but a
 * driver that trusts the declared type hands back mojibake. It is gunzipped in JS below.
 */
const SELECT = `
  SELECT c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number, c.lang,
         c.rarity, c.layout, c.mana_cost, c.cmc, c.type_line, c.oracle_text,
         c.colors, c.color_identity, c.power, c.toughness,
         c.legalities, c.prices, c.price_usd, c.finishes, c.faces,
         c.artist, c.illustration_id, c.released_at, c.image_status,
         c.promo, c.promo_types, c.full_art, c.frame_effects, c.border_color, c.game_changer,
         c.is_paper, c.digital,
         CAST(c.raw AS BLOB) AS raw,
         EXISTS(SELECT 1 FROM cards u
                 WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon
    FROM cards c
   WHERE c.name = ?1 AND c.set_code = ?2 AND c.collector_number = ?3 AND c.lang = ?4`;

const db = new DatabaseSync(dbPath, { readOnly: true });
const stmt = db.prepare(SELECT);
/** One relative's illustrator, by id — see {@link meldParts}. `undefined` for an id no row has. */
const artistStmt = db.prepare("SELECT artist FROM cards WHERE id = ?1");
const total = db.prepare("SELECT count(*) AS n FROM cards").get().n;

const rows = [];
for (const [name, setCode, collectorNumber, lang, why] of SELECTIONS) {
  const found = stmt.all(name, setCode, collectorNumber, lang);
  const label = `${name} [${setCode} ${collectorNumber} ${lang}]`;
  if (found.length !== 1) {
    throw new Error(`${label}: expected exactly one row, found ${found.length}`);
  }
  rows.push({ why, card: toFakeCard(found[0], label) });
}
db.close();

/** A `cards` row as the fixture spells it: camelCase names, real booleans, JSON as text. */
function toFakeCard(r, label) {
  // Non-null in the fixture's type though nullable in SQL, so a row that would break that
  // promise is caught here — with the row's name on it — rather than as a `tsc` error in a
  // generated file nobody reads. `oracle_id` is the one worth naming: 0 of 116 694 rows are
  // null (measured 2026-08-09), reversible printings included, because `card_row` falls back
  // to `card_faces[0]`. So this fires only if a selection reached something genuinely new.
  for (const key of ["oracle_id", "set_name", "released_at", "legalities", "prices", "finishes"]) {
    if (r[key] === null) throw new Error(`${label}: ${key} is null, which the row type forbids`);
  }
  const raw = JSON.parse(gunzipSync(Buffer.from(r.raw)).toString("utf8"));
  // `image_uris` if present, else `card_faces[0]`'s — spec §5's resolution rule, and not a
  // rare path: 4 244 of 116 694 rows have no top-level `image_uris` (measured 2026-08-09).
  const uris = raw.image_uris ?? raw.card_faces?.[0]?.image_uris ?? {};
  return {
    id: r.id,
    oracleId: r.oracle_id,
    name: r.name,
    setCode: r.set_code,
    setName: r.set_name,
    collectorNumber: r.collector_number,
    lang: r.lang,
    rarity: r.rarity,
    layout: r.layout,
    manaCost: r.mana_cost,
    cmc: r.cmc,
    typeLine: r.type_line,
    oracleText: r.oracle_text,
    colors: r.colors,
    colorIdentity: r.color_identity,
    power: r.power,
    toughness: r.toughness,
    legalities: r.legalities,
    prices: r.prices,
    priceUsd: r.price_usd,
    finishes: r.finishes,
    faces: trimFaces(r.faces),
    meldParts: meldParts(r, raw),
    artist: r.artist,
    illustrationId: r.illustration_id,
    releasedAt: r.released_at,
    imageStatus: r.image_status,
    promo: r.promo === 1,
    promoTypes: r.promo_types,
    fullArt: r.full_art === 1,
    frameEffects: r.frame_effects,
    borderColor: r.border_color,
    gameChanger: r.game_changer === 1,
    everUncommon: r.ever_uncommon === 1,
    isPaper: r.is_paper === 1,
    digital: r.digital === 1,
    artCropUrl: uris.art_crop ?? null,
    normalUrl: uris.normal ?? null,
  };
}

/**
 * What `card::card_meld_parts` answers for this row, as JSON — the **answer**, not the source.
 *
 * There is no `all_parts` column to copy: Rust parses the list out of the gzipped `raw` blob, and
 * the fixture carries no `raw` for `db.ts` to parse. So the derivation happens once, here, and
 * the row holds the finished relations.
 *
 * `null` for every layout that is not `meld`, where the command answers `[]`. Within a meld row:
 * only `meld_part` and `meld_result` survive (`all_parts` also carries the set's `combo_piece`
 * checklist card), Scryfall's order is kept, and the row's **own card is dropped by `name`**.
 * By name rather than by id, because a meld row's `all_parts` can name a *different printing* of
 * the same card — `Brisela, Voice of Nightmares` `0cd83c0e-…` carries its own `meld_result` as id
 * `bbcd6747-…` — so an id test leaves the open card in its own list of relatives.
 *
 * `artist` is looked up from `cards` by that id, because the pane swaps the *picture* to the
 * melded card while keeping the open card's facts and Scryfall's image policy requires the credit
 * to name the illustrator whose art is on screen. `null` for an id no row has, which no live meld
 * row produces: all 72 of them reference ids that resolve.
 */
function meldParts(r, raw) {
  if (r.layout !== "meld") return null;
  const parts = (raw.all_parts ?? [])
    .filter((p) => p.component === "meld_part" || p.component === "meld_result")
    .filter((p) => p.name !== r.name)
    .map((p) => ({
      id: p.id,
      name: p.name,
      component: p.component,
      artist: artistStmt.get(p.id)?.artist ?? null,
    }));
  return JSON.stringify(parts);
}

/** Every face, projected onto {@link FACE_KEYS}. `"[]"` for a single-faced printing. */
function trimFaces(faces) {
  if (faces === null) return "[]";
  const trimmed = JSON.parse(faces).map((face) =>
    Object.fromEntries(FACE_KEYS.filter((k) => k in face).map((k) => [k, face[k]])),
  );
  return JSON.stringify(trimmed);
}

const HEADER = `/**
 * The card corpus every story draws on: ${rows.length} real printings, straight out of the
 * local card database.
 *
 * **Generated by \`scripts/gen-storybook-cards.mjs\` — do not edit by hand.** Re-run it to
 * refresh against a newer sync. Every value here is a column of \`cards\` as the app's own
 * ingest wrote it, which is the point: a hand-written fixture agrees with the code that
 * reads it rather than with the data, and the two drift apart in exactly the places a story
 * exists to show. The \`legalities\` blobs are the case that settled it — all ${total.toLocaleString("en-US")} rows in
 * the database carry exactly 23 keys, and the set grows with every new format.
 *
 * Each row's comment names the render branch it exists to make reachable. Deleting a row
 * deletes that branch's only fixture.
 *
 * Nothing is imported here on purpose: \`tsconfig\` has \`noUnusedLocals\`, and a type pulled in
 * only to be named in a doc comment is an unused import that fails \`npm run build\`. The DTO
 * names below are prose; \`src/lib/ipc.ts\` is where they are defined.
 */

/**
 * One row of the fake \`cards\` table.
 *
 * A **row**, not a DTO. It carries the union of the columns the three card-shaped DTOs are
 * derived from, so \`db.ts\` can build a \`CardSummary\`, a \`CardDetail\` and a \`Printing\` from
 * the same row without any of them being stored — which is what makes a fixture unable to
 * answer the same question two ways.
 *
 * Field names and nullability mirror \`src-tauri/src/card.rs\`'s \`card_row\`, because the DTOs
 * derived from it must come out identical to Rust's. Two rules from CLAUDE.md are
 * load-bearing here and are easy to get wrong from memory:
 *
 * * \`colors\` and \`colorIdentity\` are **concatenated letters** (\`"WU"\`), not JSON arrays.
 *   \`JSON.parse\` throws on them. Colourless is \`""\`, not \`null\`.
 * * \`legalities\`, \`prices\`, \`finishes\` and \`faces\` **are** JSON, as strings.
 */
export interface FakeCard {
  id: string;
  oracleId: string;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  lang: string;
  rarity: string | null;
  layout: string;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  colors: string | null;
  colorIdentity: string | null;
  power: string | null;
  toughness: string | null;
  /** JSON object of 23 keys — measured, not assumed, and it grows with the formats. */
  legalities: string;
  /** JSON object: \`usd\`, \`usd_foil\`, \`usd_etched\`, \`eur\`, \`eur_foil\`, \`tix\`. Decimal
   *  **strings**, because that is what Scryfall publishes and what \`prices.ts\` parses.
   *  A **finish's** price is a lookup in here and nowhere else. */
  prices: string;
  /**
   * The \`cards.price_usd\` column — the number a search result shows **on a marketplace priced
   * from Scryfall's data**, and the only source \`CardSummary.price\` has there (\`search.rs\`
   * selects this column; it does not touch {@link FakeCard.prices}). Card Kingdom and Mana Pool
   * price the same row out of \`marketplace_prices\` instead, so this column is one of four
   * answers rather than the answer.
   *
   * It is a **display and sort fallback chain**, not a finish's price: \`card_row.rs\` fills it
   * \`usd\` → \`usd_foil\` → \`usd_etched\`, so on a foil-only printing it quotes the foil. Never
   * sum it — a collection row prices through the blob above, by the finish it holds.
   *
   * \`null\` when all three keys are null, which is a real state rather than a gap: Black Lotus
   * \`lea\` and Ancestral Recall \`lea\` both have it, priced in euros and in nothing else.
   */
  priceUsd: number | null;
  /** JSON array: \`["nonfoil","foil"]\`. */
  finishes: string;
  /**
   * JSON: Scryfall's \`card_faces\` array, \`"[]"\` for a single-faced printing.
   *
   * The array a \`CardFace\` is *derived* from, not an array of them — \`card.rs\`'s
   * \`parse_faces\` picks five keys out of each face and the deck validator reads the per-face
   * cost, mana value and P/T, so the row has to carry what both of them read. The one thing
   * dropped from the real blob is each face's \`image_uris\`; see the generator for why.
   */
  faces: string;
  /**
   * What \`card::card_meld_parts\` answers for this row, as JSON — \`null\` for every layout that
   * is not \`meld\`.
   *
   * **The answer, not the source, and the one field here that is not derived from a column.**
   * \`cards\` has no \`all_parts\`: Rust parses the relation list out of the gzipped \`raw\` blob, and
   * the fixture has no copy of \`raw\` to parse. So this carries the finished array —
   * \`{id, name, component, artist}\` per relative, in Scryfall's own order, with the row's own
   * card already dropped and \`artist\` already looked up — and \`db.ts\` hands it over rather than
   * deriving anything.
   *
   * The row's own card is dropped **by name rather than by id**, because a meld row's
   * \`all_parts\` can name a different *printing* of the same card, and an id test would leave the
   * open card in its own list of relatives. A \`meld\` row whose blob carries no \`all_parts\` is
   * \`"[]"\`, which is what the command answers for one.
   */
  meldParts: string | null;
  artist: string | null;
  illustrationId: string | null;
  releasedAt: string;
  imageStatus: string | null;
  promo: boolean;
  /**
   * JSON array: Scryfall's \`promo_types\`, \`null\` on four fifths of the corpus.
   *
   * The column the **kind** of foil lives in — \`finishes\` has three words for how shiny a
   * copy is and none for *which* shiny. Read with \`cardTreatments\` / \`finishTreatments\`
   * from \`@/lib/treatment\`, which owns the naming; the row carries the column verbatim.
   *
   * Distinct from \`promo\` above despite the shared word: that is a boolean about how the
   * card was *distributed*, this is a list of what the cardboard *is*. A Surge Foil is not a
   * promo and a prerelease stamp is not a treatment.
   */
  promoTypes: string | null;
  fullArt: boolean;
  frameEffects: string | null;
  borderColor: string | null;
  /**
   * On the Commander Format Panel's **game changers** list. An **oracle**-level fact, like
   * {@link FakeCard.everUncommon} below: every printing of a card agrees, so a collapsed
   * search row takes the representative printing's and needs no aggregate.
   *
   * Read by three DTOs — the bracket chip on a \`DeckCard\`, the crown a \`CardSummary\` draws
   * beside its finish marks, and an \`ImportMatch\`. A plain boolean though \`cards.game_changer\`
   * is nullable: the column is only ever set for the cards Wizards named, so a NULL means *not
   * on the list* and is flattened here rather than carried as a third state.
   */
  gameChanger: boolean;
  /** Printed at uncommon on **some** printing of this oracle card — Pauper Commander
   *  eligibility, which is a fact about the card and never about the printing shown. */
  everUncommon: boolean;
  /**
   * **The column every paper filter actually keys on**, and the one a fake backend must
   * implement against: \`filters.rs\` emits \`is_paper = 1\` for \`paperOnly\`, and \`card.rs\`'s
   * \`PRINTINGS_WHERE\` is \`oracle_id = ?1 AND is_paper = 1\`. Neither reads
   * {@link FakeCard.digital}.
   *
   * Derived from Scryfall's \`games\` array (\`games.contains("paper")\`), so it is not the
   * negation of \`digital\` by construction — it merely is one today: measured 2026-08-09,
   * 107 337 rows are \`is_paper = 1, digital = 0\` and 9 357 are the reverse, with **0** rows
   * where the two agree. Filter on this one anyway; the equivalence is an observation about
   * one bulk file, not a rule.
   */
  isPaper: boolean;
  /**
   * Scryfall's \`digital\` flag: this printing exists only on MTGO or Arena.
   *
   * Carried because it is a fact about the printing and a badge can say so — **not** because
   * anything filters on it. See {@link FakeCard.isPaper} for what does.
   */
  digital: boolean;
  /** Real Scryfall \`art_crop\` URL, used only under the "Live" art toolbar global — no image
   *  bytes are committed to this repository. \`null\` for a printing with no art anywhere. */
  artCropUrl: string | null;
  /** Real Scryfall \`normal\` URL, same. */
  normalUrl: string | null;
}
`;

const body = rows
  .map(({ why, card }) => `${comment(why)}\n${JSON.stringify(card)},`)
  .join("\n\n");

/** The `why` as a wrapped line comment. Prettier does not reflow comments, so this does. */
function comment(why) {
  const lines = [];
  let line = "//";
  for (const word of why.split(" ")) {
    if (line.length + word.length + 1 > 98) {
      lines.push(line);
      line = "//";
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines.join("\n");
}

const source = `${HEADER}\nexport const CARDS: FakeCard[] = [\n${body}\n];\n`;
const prettierConfig = await resolveConfig(outPath);
writeFileSync(outPath, await format(source, { ...prettierConfig, filepath: outPath }));

console.log(`${outPath}: ${rows.length} printings from ${total.toLocaleString("en-US")} in ${dbPath}`);
for (const { card } of rows) {
  console.log(
    `  ${card.name} [${card.setCode} ${card.collectorNumber} ${card.lang}] ` +
      `${card.rarity} ${card.layout} mv=${card.cmc} cost=${card.manaCost ?? "-"} ` +
      `usd=${card.priceUsd ?? "-"} paper=${card.isPaper} ` +
      `pt=${card.power ?? "-"}/${card.toughness ?? "-"} fin=${card.finishes} ` +
      `gc=${card.gameChanger} eu=${card.everUncommon} dig=${card.digital} ` +
      `img=${card.imageStatus} art=${card.artCropUrl === null ? "none" : "yes"} ` +
      `meld=${card.meldParts === null ? "-" : JSON.parse(card.meldParts).map((p) => `${p.component}:${p.name}`).join(",")}`,
  );
}
