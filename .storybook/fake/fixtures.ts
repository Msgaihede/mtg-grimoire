/**
 * The fixtures more than one file needs: a printing addressed the way a reader addresses one, the
 * `deck_cards` row `deck::get_deck` answers with, and the orphan that row becomes when a sync
 * takes its printing away.
 *
 * **A story file cannot own these, and that is why they are here rather than in one of them.**
 * Every non-default export of a CSF file is indexed as a **story**, so the obvious arrangement —
 * one `.stories.tsx` exporting the helper and the other nine importing it — puts a helper function
 * in the sidebar and fails to render it. Several of those nine carried that fact in a comment and
 * drew the wrong conclusion from it ("so a story file cannot own shared helpers", therefore every
 * file writes its own). The constraint is real; the conclusion was not. A module that is not a CSF
 * file is bound by none of it, which is what this one is: **eleven** implementations of the
 * printing lookup (ten in story files, one more in `seeds.ts`, which never had the CSF excuse),
 * three of the deck-row builder, three of the orphan and four of the reconciler's sentence are one
 * of each from here.
 *
 * **Not `.storybook/fake/cards.ts`, however obvious a home that looks.** That file is generated
 * *wholesale* — `scripts/gen-storybook-cards.mjs:386-388` builds its entire source in one template
 * string and `writeFileSync`s it over whatever was there — so a helper added beside `CARDS` is
 * deleted by the next corpus refresh, with no conflict and nothing to notice. Its own header says
 * "do not edit by hand". This file is where hand-written fixtures *over* that corpus live instead.
 */
import { CARDS, type FakeCard } from "./cards";
import { finishPrice } from "@/lib/finish";
import type { DeckCard } from "@/lib/ipc";

/**
 * A fixture printing, by the two columns that identify one — the set code and the collector
 * number printed on the card.
 *
 * By those rather than by index, because `CARDS` is generated (`scripts/gen-storybook-cards.mjs`)
 * and a regeneration may reorder it: an index would then quietly point at a different card and
 * every claim written under it would still read as true. The pair is a key here even though it is
 * not one in `cards` — measured over `CARDS` 2026-08-09, all 43 `(setCode, collectorNumber)` pairs
 * are distinct.
 *
 * **It throws at module load rather than handing a caller a card the corpus has no row for.** The
 * corpus is meant to be regenerated against a newer sync, and a pasted id would survive that as a
 * story rendering "This printing is not in the card database any more" — or as a silently orphaned
 * seed row with a blank name and a plausible story — and passing every check. A lookup fails the
 * whole file instead.
 */
export function printing(setCode: string, collectorNumber: string): FakeCard {
  const card = CARDS.find((c) => c.setCode === setCode && c.collectorNumber === collectorNumber);
  if (!card) throw new Error(`No fixture printing ${setCode} ${collectorNumber}`);
  return card;
}

/**
 * `deck_cards.id`, handed out in call order.
 *
 * One counter for every story file rather than one per file, which is what the three copies of
 * {@link deckCard} each kept. The number is only ever a React key — `ZoneColumn.tsx:381` is the
 * one place any component reads a `DeckCard.id` at all (grepped 2026-08-10) — so the only thing
 * that has to hold is that two rows in one list never share one. `DeckStats.stories.tsx` used to
 * buy that for its orphans with `900 + quantity`, an arithmetic dodge around a hardcoded 900; a
 * counter has nothing to get wrong, and it covers {@link orphanDeckCard} on the same terms as
 * everything else.
 */
let nextId = 1;

/**
 * One `deck_cards` row joined to its card, as `deck::get_deck` answers it.
 *
 * Built from `CARDS` rather than through `validation/fixtures`' `card()` builder, and the
 * difference is the id: that builder makes one up (`c-<name>`), which is right for the validation
 * engine — it never draws anything — and wrong anywhere a row is rendered, because the row
 * thumbnail is `cardImageUrl(card.cardId, 0, "art")` and a made-up id has no art on either side of
 * the **Art** toolbar switch.
 *
 * Every card fact comes off the printing rather than being written here, which is the discipline
 * the deck story files are built on: a component's verdict is only worth rendering if the facts it
 * read are the ones the database holds.
 *
 * `unitPriceUsd` goes through the app's own `finishPrice`, asked for **nonfoil** — which is the
 * `usd` key of this printing's `prices` blob and never the `cards.price_usd` column, since that
 * one is a nonfoil→foil→etched fallback chain built for sorting. A deck names a printing rather
 * than a finish, and nonfoil is the cheapest way to satisfy it. Anything that *sums* these
 * (`DeckStats` does) would otherwise quote a deck at foil rates nobody was offered.
 */
export function deckCard(card: FakeCard, over: Partial<DeckCard> = {}): DeckCard {
  return {
    id: nextId++,
    cardId: card.id,
    zone: "main",
    quantity: 1,
    // Denormalised on the row, like the collection's — the one name an orphaned row still has.
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    needsReview: null,
    oracleId: card.oracleId,
    manaCost: card.manaCost,
    cmc: card.cmc,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    colors: card.colors,
    colorIdentity: card.colorIdentity,
    legalities: card.legalities,
    power: card.power,
    toughness: card.toughness,
    layout: card.layout,
    rarity: card.rarity,
    faces: card.faces,
    gameChanger: card.gameChanger,
    everUncommon: card.everUncommon,
    unitPriceUsd: finishPrice(card.prices, "nonfoil"),
    // An **allocation**, never a decrement — how many copies this deck has reserved out of the
    // collection. Zero until a story says otherwise, which is also what an unbuilt deck with an
    // empty collection reads.
    ownedQuantity: 0,
    ...over,
  };
}

/**
 * `reconcile::sweep_orphans`' sentence, verbatim (`src-tauri/src/reconcile.rs:634-635`).
 *
 * 131 characters — one line in the collection table's band — and the *second* half is what to do
 * about it, which is why the whole sentence rides as that cell's `title` as well.
 *
 * The deck validation engine prints it back as `${name}: ${needsReview}` rather than composing one
 * of its own, because the reconciler already knows what happened and a second explanation would be
 * a second thing to keep true. A story asserts against this constant rather than a retyped copy:
 * if `reconcile.rs` rewords the sentence, the thing that should fail is the fixture.
 */
export const MISSING =
  "This printing is not in the card database. It may have been removed by the last " +
  "card-data sync, or it may return with the next one.";

/**
 * A deck row whose printing has left `cards` — the shape a LEFT JOIN miss takes: every
 * card-derived field `null`, the row's own four intact, and a sentence saying so.
 *
 * `engine.isOrphan` asks for **four** nulls together (`layout`, `rarity`, `legalities`,
 * `oracleId`), because one of them null is a card and all four null is no card at all. The row's
 * own four columns survive: `deck_cards` denormalises `name`, `set_code`, `collector_number` and
 * `lang` at write time for exactly this day — unlike `collection_entries`, which keeps no name —
 * so an orphaned deck row still knows what it is called.
 *
 * What it has lost is its type line, its mana cost, its rarity, its price and its art, and each of
 * those is a hole something draws differently: `ZoneColumn` files it under `Other` and fetches no
 * picture for it, and `DeckStats` shows three at once — a card with no mana value is counted out
 * of the curve rather than filed under 0, a card with no type line lands in that same `Other`
 * bucket, and a card with no price is counted as unpriced rather than as free.
 *
 * The card id is one the corpus has no row for (grepped 2026-08-10: 0 occurrences in `cards.ts`),
 * which is what an orphan *is*.
 */
export function orphanDeckCard(over: Partial<DeckCard> = {}): DeckCard {
  return {
    id: nextId++,
    cardId: "0f0c1b0e-8e0d-4a2f-9f4b-2f5c9a1d3e77",
    zone: "main",
    quantity: 1,
    name: "Sword of the Meek",
    setCode: "dst",
    collectorNumber: "132",
    lang: "en",
    needsReview: MISSING,
    oracleId: null,
    manaCost: null,
    cmc: null,
    typeLine: null,
    oracleText: null,
    colors: null,
    colorIdentity: null,
    legalities: null,
    power: null,
    toughness: null,
    layout: null,
    rarity: null,
    faces: null,
    gameChanger: null,
    // `false` for an orphan, because nothing is known about a card that is not there.
    everUncommon: false,
    unitPriceUsd: null,
    ownedQuantity: 0,
    ...over,
  };
}
