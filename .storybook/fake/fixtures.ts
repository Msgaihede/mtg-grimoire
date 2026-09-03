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
 *
 * **There is a second `fixtures.ts` in this repository** — `src/features/decks/validation/
 * fixtures.ts`, the hand-copied mirror of `schema.rs`'s `FORMAT_SPECS_SEED` that `SPECS` comes
 * from — and `ValidationPanel.stories.tsx` imports both. Anything citing that one by line number
 * spells the directory out, because a bare `fixtures.ts:201` in a file that imports two of them
 * names neither.
 */
import { CARDS, type FakeCard } from "./cards";
import { finishPrice } from "@/lib/finish";
import { buildGroups, type GroupBy } from "@/features/decks/grouping";
import type { SortBy } from "@/features/decks/sorting";
import { theoryMatchPlan } from "@/features/decks/theoryMatch";
import type { ValidationIssue } from "@/features/decks/validation/types";
import type {
  CategoryKind,
  CategoryOrigin,
  DeckCard,
  DeckCategory,
  ReleaseInfo,
  ReleaseNote,
  UpdateAsset,
} from "@/lib/ipc";

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
 * {@link deckCard} each kept. The number is only ever a React key — the zone column's row key was
 * the one place any component read a `DeckCard.id` at all (grepped 2026-08-10, cited without a
 * line because the deck editor is being rebuilt around it) — so the only thing that has to hold
 * is that two rows in one list never share one. `DeckStats.stories.tsx` used to
 * buy that for its orphans with `900 + quantity`, an arithmetic dodge around a hardcoded 900; a
 * counter has nothing to get wrong, and it covers {@link orphanDeckCard} on the same terms as
 * everything else.
 */
let nextId = 1;

/**
 * The five categories every deck in these fixtures owns, as `(kind, name, isActive,
 * sortOrder)`.
 *
 * Four of them are `schema::PREDEFINED_CATEGORIES` and the fifth is the one schema v8's
 * migration builds out of a deck's old `main` zone, which it names **"Main deck"**. The sort
 * orders are that migration's own — commander 0, main 1, side 2, companion 3, maybe 4 — so a
 * deck that predates v8 reads with its Commander column first and its Maybeboard last, and
 * that is the shape every *seeded* deck here is in.
 *
 * **A kind is not a name, and this table is where that distinction is made concrete.** A
 * category is a row the user renames, reorders and switches off; `kind` is the fixed word the
 * rules read. Only four kinds are predefined — a user may own any number of `main` categories
 * with names of their own — so a fixture that wants two main columns overrides `categoryName`
 * and `categoryId` rather than looking for a second `main` row here.
 */
export const DECK_CATEGORIES: readonly {
  kind: CategoryKind;
  name: string;
  isActive: boolean;
  sortOrder: number;
  origin: CategoryOrigin;
}[] = [
  { kind: "commander", name: "Commander", isActive: true, sortOrder: 0, origin: "user" },
  // **`user`, and "Main deck" is the one row where that takes explaining.** `origin` is written
  // by whoever made the row: `ensure_predefined_categories` seeds the other four as `user`, and
  // v15's backfill marks an existing pile `auto` only where its name is one `autoCategoryFor`
  // can produce. "Main deck" is deliberately not on that list — the v8 migration's pile is a
  // real pile holding real cards — so it draws when empty like any pile the reader owns.
  { kind: "main", name: "Main deck", isActive: true, sortOrder: 1, origin: "user" },
  { kind: "side", name: "Sideboard", isActive: true, sortOrder: 2, origin: "user" },
  { kind: "companion", name: "Companion", isActive: true, sortOrder: 3, origin: "user" },
  // The one seeded inactive category, and **that** is the whole of what makes a Maybeboard
  // special — not its kind. Switch it on and it counts like anything else.
  { kind: "maybe", name: "Maybeboard", isActive: false, sortOrder: 4, origin: "user" },
];

/**
 * One `deck_categories` row as `deck::get_deck` answers it, addressed by the **kind** a story
 * means rather than by an id nobody chose.
 *
 * The id is `sortOrder + 1`, which is a DTO's whole requirement of one: stable across calls
 * (a column keyed on it does not remount) and distinct per kind (two columns are two
 * columns). A *row* in `db.ts` mints its own from the table, because there it has to be unique
 * across every deck in the store; these are the ids of a deck that is the only deck there is.
 *
 * `cardCount` and `totalPrice` default to an empty column. They are read off the world in a
 * story that has one — `deck_get` computes all three over the variant *and the marketplace* it
 * was asked for — so a story building a `DeckDetail` by hand is the caller that has to say.
 * **One total, not the pair this used to carry**: the marketplace is a query parameter now, so a
 * category row has exactly one sum on it and whose it is was decided before the row was built.
 */
export function deckCategory(kind: CategoryKind, over: Partial<DeckCategory> = {}): DeckCategory {
  const category = DECK_CATEGORIES.find((c) => c.kind === kind);
  if (!category) throw new Error(`No fixture category of kind ${kind}`);
  const row = {
    id: category.sortOrder + 1,
    deckId: 1,
    name: category.name,
    kind: category.kind,
    isActive: category.isActive,
    sortOrder: category.sortOrder,
    // All five of these rows are `user` (see the table), so a fixture wanting the *other* class
    // — a pile the app made while filing a card, which draws only while it holds one — says
    // `origin: "auto"` in its overrides. It is not derivable from the name here any more than it
    // is in the app: `Ramp` is both a bucket `autoCategoryFor` answers with and a pile people
    // make by hand.
    origin: category.origin,
    cardCount: 0,
    totalPrice: null,
    ...over,
  };
  // Both lists, defaulting to the one-list count — so a fixture that says nothing is a deck
  // with nothing in its theory list, and the two numbers differ only where a test means them
  // to. They must never be defaulted independently: a total *below* the variant-scoped count
  // is a shape the backend cannot produce, and the delete confirmation reads the total.
  return { ...row, cardCountAllVariants: over.cardCountAllVariants ?? row.cardCount };
}

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
 * The unit price goes through the app's own `finishPrice`, asked for each finish in turn — the
 * `usd`, `usd_foil` and `usd_etched` keys of this printing's `prices` blob, first one that
 * answers, and never the `cards.price_usd` column, which is that same chain precomputed for
 * sorting and is the one nothing may sum. A deck names a printing rather than a finish, so it is
 * priced in whichever finish it is *sold* in: **a foil-only printing has no `usd` key at all**,
 * and asking flatly for nonfoil here is what left every Invocation and Secret Lair in a deck
 * reading as unpriced.
 *
 * **One price, and it is TCGplayer's**, because that is what a query naming no marketplace is
 * answered with. A story about another marketplace goes through a seeded world, where
 * `deck_get` prices the rows the way the app does; a hand-built row is a row about something
 * else, and overriding `unitPrice` is how it says so.
 *
 * **The category is named by its kind**, `main` unless the caller says otherwise, and the
 * three category fields on the row are then {@link deckCategory}'s — so a story that writes
 * `deckCard(card, { categoryKind: "side" })` gets a row that agrees with itself about which
 * column it is in, its heading and whether it counts. Overriding `categoryName` or
 * `categoryActive` on top is how a story reaches a category the user made.
 */
export function deckCard(card: FakeCard, over: Partial<DeckCard> = {}): DeckCard {
  const category = deckCategory(over.categoryKind ?? "main");
  return {
    id: nextId++,
    cardId: card.id,
    categoryId: category.id,
    categoryName: category.name,
    categoryKind: category.kind,
    categoryActive: category.isActive,
    // The deck as it is sleeved. A `theory` row is a plan: it counts on no tile and reserves
    // no copy, which is a different story from this one.
    variant: "live",
    // All three together — a row is unlabelled, or it wears one label with a name and a colour.
    labelId: null,
    labelName: null,
    labelColor: null,
    quantity: 1,
    // Denormalised on the row, like the collection's — the one name an orphaned row still has.
    name: card.name,
    setCode: card.setCode,
    // From `cards` rather than denormalised onto the row, so an orphan has none — see
    // `orphanDeckCard` below, which is the fixture that says so.
    setName: card.setName,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    // The regular copy, which is what an add means until the reader says otherwise. A story
    // about the foil mark or the finish menu writes `deckCard(card, { finish: "foil" })` —
    // and the card it picks has to be one whose `finishes` lists it, or the menu greys.
    finish: null,
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
    finishes: card.finishes,
    // The printing's, like `finishes` above it: what its foil is *called*. A deck row draws
    // this against its own `finish`, so a story that wants a named copy sets both.
    promoTypes: card.promoTypes,
    everUncommon: card.everUncommon,
    unitPrice:
      finishPrice(card.prices, "nonfoil", "usd") ??
      finishPrice(card.prices, "foil", "usd") ??
      finishPrice(card.prices, "etched", "usd"),
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
 * those is a hole something draws differently: the views draw no picture for a row whose
 * `needsReview` is set (`GridView`'s `art` is fed `null` outright), `grouping.ts` files it under
 * `Other` when the deck is grouped by type, and `DeckStats` shows three at once — a card with no mana value is counted out
 * of the curve rather than filed under 0, a card with no type line lands in that same `Other`
 * bucket, and a card with no price is counted as unpriced rather than as free.
 *
 * The card id is one the corpus has no row for (grepped 2026-08-10: 0 occurrences in `cards.ts`),
 * which is what an orphan *is*.
 */
export function orphanDeckCard(over: Partial<DeckCard> = {}): DeckCard {
  const category = deckCategory(over.categoryKind ?? "main");
  return {
    id: nextId++,
    cardId: "0f0c1b0e-8e0d-4a2f-9f4b-2f5c9a1d3e77",
    // The category is the deck's, not the card's: an orphan is filed exactly where the user
    // left it, which is why these four are the row's own and not nulled with the card facts.
    categoryId: category.id,
    categoryName: category.name,
    categoryKind: category.kind,
    categoryActive: category.isActive,
    variant: "live",
    // The row's own, and among the four that survive an orphaning for the same reason: a finish
    // is what the reader said they play, not something read back off a card that has gone.
    finish: null,
    labelId: null,
    labelName: null,
    labelColor: null,
    quantity: 1,
    name: "Sword of the Meek",
    setCode: "dst",
    // `null`, and that is the whole point of this fixture: the code, the number and the name
    // are denormalised onto `deck_cards` so an orphan is still listed, and the set's *name*
    // lives only in `cards`, which no longer has the row.
    setName: null,
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
    finishes: null,
    promoTypes: null,
    // `false` for an orphan, because nothing is known about a card that is not there.
    everUncommon: false,
    // `null` for the row's reason rather than the marketplace's: there is no card to price at
    // all, so no marketplace could quote it.
    unitPrice: null,
    ownedQuantity: 0,
    ...over,
  };
}

/* --------------------------------------------------------------------- deck views ------ */

/**
 * A deck the four views can be judged by, as the groups they take.
 *
 * Built through the app's own {@link buildGroups} rather than written out as `CardGroup`
 * literals, and that is the point: the four view story files are then drawing what
 * `grouping.ts` actually answers — the counts, the sums, the empty categories that still
 * draw, and the inactive pile appended last — rather than four hand-written agreements about
 * what it ought to answer.
 *
 * Five piles, chosen so every branch of a header has something to show: a Commander (the
 * `RULE` marker), two categories of the reader's own, an **empty** Sideboard (a place as much
 * as a heading), and a Maybeboard (`INACTIVE`, and the pile whose cards are never called
 * short of copies).
 *
 * **The Commander comes back first under every `groupBy`, and that is `buildGroups`' answer
 * rather than this fixture's `sortOrder`.** A command zone is never bucketed into a curve or a
 * type column — it is the card the rest of the deck was chosen around — so it is appended as
 * itself and heads the list in all three modes. Nothing here had to change for that, which is
 * the argument for building these groups through the real function restated: the day the rule
 * moved, every view story moved with it.
 *
 * **There is no `currency` argument any more**, and its absence says something true: a row
 * arrives already priced at the marketplace its query named, so `buildGroups` has nothing to
 * choose between and neither has this. A view story about another marketplace is a story about
 * different `unitPrice` values on the rows — which is a seeded world's job, not a fixture
 * parameter's.
 *
 * `separateX` is the deck's own `separateXGroup` read as `buildGroups` takes it, and it
 * **defaults to `false`** for the reason that function's own argument does: every story written
 * before the switch existed keeps the grouping it was written against. It is a `manaValue` rule
 * and inert under the other two groupings, so a story asking for the split passes both — the
 * pair `("manaValue", …, true)` is the only combination that draws anything new.
 *
 * `switchedOff` names **one of the two piles of the reader's own** — `"Ramp"` or `"Removal"` — to
 * seed with `is_active = 0`, the pile that counts toward nothing. It is last and optional for
 * `separateX`'s reason: absent, this is the deck every existing story was written against. It is a
 * name rather than an id because a story naming a heading is naming what a reader would recognise,
 * and it takes one pile rather than a list because the thing it serves — where a switched-off pile
 * is *drawn* — is answered by one as well as by five. **The two seeded zones are deliberately out
 * of its reach**: the Maybeboard is already seeded off and the Sideboard's switch is its own
 * story's subject, so pointing this at either would make one fixture say two things.
 */
export function deckGroups(
  groupBy: GroupBy = "category",
  sortBy: SortBy = "alphabetical",
  separateX = false,
  switchedOff?: "Ramp" | "Removal",
) {
  const commander = deckCategory("commander");
  // The seeded Sideboard sorts at 2 and the reader's own two piles are ahead of it here, so
  // it is moved rather than left to tie with `Removal` and be ordered by row id.
  const side: DeckCategory = { ...deckCategory("side"), sortOrder: 3 };
  const maybe = deckCategory("maybe");
  // **Both are `origin: "user"`, which they inherit, and the names are why that is worth a
  // sentence.** "Ramp" and "Removal" are exactly what `autoCategoryFor` answers with *and*
  // exactly what a person calls a pile they made — so a rule that hid empty piles by matching
  // that list would hide these two, which the doc above says are the reader's own. The class is
  // `deck_categories.origin`, written by whichever path made the row: `category_for_name` finds
  // a pile of this name before it creates one, so filing a ramp spell into the reader's "Ramp"
  // leaves it theirs.
  // `isActive` is written from the argument rather than left to `deckCategory`'s default, so that
  // the switch is a property of the *category row* and reaches the cards through `inPile` below —
  // a group whose `isActive` was flipped after `buildGroups` had run would draw the same wash over
  // rows still claiming to count.
  const ramp: DeckCategory = {
    ...deckCategory("main"),
    id: 10,
    name: "Ramp",
    sortOrder: 1,
    isActive: switchedOff !== "Ramp",
  };
  const removal: DeckCategory = {
    ...deckCategory("main"),
    id: 11,
    name: "Removal",
    sortOrder: 2,
    isActive: switchedOff !== "Removal",
  };

  const inPile = (pile: DeckCategory, row: DeckCard): DeckCard => ({
    ...row,
    categoryId: pile.id,
    categoryName: pile.name,
    categoryKind: pile.kind,
    categoryActive: pile.isActive,
  });

  const cards: DeckCard[] = [
    inPile(commander, deckCard(printing("dom", "168"), { ownedQuantity: 1 })),
    inPile(ramp, deckCard(printing("lea", "288"), { quantity: 2, ownedQuantity: 1 })),
    inPile(
      ramp,
      deckCard(printing("mh2", "138"), {
        ownedQuantity: 1,
        labelId: 1,
        labelName: "Wincon",
        labelColor: "gold",
      }),
    ),
    inPile(ramp, deckCard(printing("lea", "161"), { ownedQuantity: 1, gameChanger: true })),
    // **The corpus's only `{X}` printing** (`{X}{B}{B}{B}`, mana value 3), and the whole of what
    // the `separateX` argument has to move: without it the X heading is a heading over nothing
    // and the switch draws the same curve twice. Filed under Ramp because the back face is a
    // land — an MDFC is in the pile its player casts it from.
    //
    // Mana value 3 is the useful part rather than an accident: Dismember below is also 3, so
    // switching the split on **moves this card out of a bucket that survives it**. A curve where
    // the `3` column vanished with the card would leave a reader unable to tell a re-filing from
    // a disappearance, which is exactly the misreading the X heading exists to prevent.
    inPile(ramp, deckCard(printing("znr", "90"), { ownedQuantity: 1 })),
    inPile(
      removal,
      deckCard(printing("isd", "51"), {
        ownedQuantity: 1,
        labelId: 2,
        labelName: "Cut candidate",
        labelColor: "ember",
      }),
    ),
    inPile(removal, deckCard(printing("gtc", "148"), { quantity: 2, ownedQuantity: 2 })),
    inPile(removal, deckCard(printing("nph", "57"), { ownedQuantity: 0 })),
    inPile(maybe, deckCard(printing("mh2", "267"), { quantity: 3 })),
    inPile(maybe, deckCard(printing("wwk", "31"))),
  ];

  return buildGroups(cards, [commander, ramp, removal, side, maybe], groupBy, sortBy, separateX);
}

/**
 * One finding about one of the cards above, so a view story can draw the `RULE BREAK` mark
 * beside the game-changer badge it must never be confusable with.
 */
export function deckViolations(): Map<string, ValidationIssue[]> {
  // The sentence names the fixture's own card rather than a pasted one: `CARDS` is generated
  // and may be regenerated against a newer sync, and a hardcoded name would go on reading as
  // true while pointing at whatever printing that slot had become.
  const card = printing("lea", "288");
  return new Map([
    [
      card.id,
      [
        {
          severity: "error" as const,
          code: "singleton",
          message: `Commander decks are singleton: max 1 copy of ${card.name}; you have 2.`,
          cardIds: [card.id],
        },
      ],
    ],
  ]);
}

/**
 * The plan behind {@link deckGroups}, as the lookup `theoryMatch.ts` answers with — so a view
 * story can draw the theory mark beside the two it must never be confusable with.
 *
 * **Four of the ten cards and deliberately not all of them.** A fixture where every card carried
 * the mark would prove the mark renders and nothing else; the reader's question on this surface
 * is *which* of these cards is the plan, so the fixture has to be able to answer it wrongly. The
 * four are picked to put the mark against each of the other marks in turn:
 *
 * * `lea 288` (Island) is the one {@link deckViolations} reports — a 2-of in a singleton format —
 *   so this is the card carrying **both** marks, in the opposite corners `CardMarks.tsx` moved
 *   the rule break down to get.
 * * `lea 161` (Lightning Bolt) is the **game changer**, so the mark sits under the crown chip on
 *   the Grid tile and at the other end of the gold ribbon on the stacked card.
 * * `mh2 138` (Ragavan) carries a **label**, so the stack's quantity tag is drawn in a colour and
 *   the mark at the far end of the same strip has to hold its own against it.
 * * `gtc 148` (Boros Charm) is a plain 2-of no other mark touches — the control.
 *
 * **Since issue #212 the quantities are picked to draw all three states at once**, which is the
 * other thing this fixture has to be able to answer wrongly: `lea 288` is asked for **twice** what
 * the deck holds and draws `-2`, `gtc 148` is asked for **half** of it and draws `+1`, and the
 * other two match exactly and draw the tick. Two ticks and two numbers, so a story shows what the
 * mark's two drawings look like beside each other in one pile — which is the comparison neither a
 * unit test nor a screenshot of a single card can make.
 *
 * What is left unmarked matters as much: `dom 168` (Llanowar Elves) is the commander, and
 * `nph 57` (Dismember) is the card the reader owns none of — so a story can show that "in the
 * plan" and "not yet acquired" are two different statements about one deck.
 *
 * **The printings are named rather than the cards**, for {@link deckViolations}' reason: `CARDS`
 * is generated and may be regenerated against a newer sync, and a hardcoded name would go on
 * reading as true while pointing at whatever printing that slot had become.
 */
export function deckTheoryMatches(): ReadonlyMap<string, number> {
  const slots = [
    // A plan asking for **twice** what is sleeved up, on the card that also breaks a rule: the
    // `-2` and the `RULE BREAK` are the two marks in opposite corners, one of them now a number.
    { card: printing("lea", "288"), quantity: 4 },
    // Exactly what the plan asks for — the tick, beside the gold crown chip.
    { card: printing("lea", "161"), quantity: 1 },
    // The tick again, at the far end of a strip whose other mark is a coloured quantity tag.
    { card: printing("mh2", "138"), quantity: 1 },
    // **A surplus**, on the one card in the plan that no other mark touches, so `+1` is read
    // against a bare card face. A 2-of the plan wants one of is a cut the reader has not made.
    { card: printing("gtc", "148"), quantity: 1 },
  ]
    // The wire format `deck_theory_slots` answers with, spelled the way the backend spells it
    // rather than through `theorySlot` — a fixture generating the key with the same function
    // the code looks it up with would pass whatever separator either happened to use.
    // `deckCard` builds every fixture row with `finish: null`, so these are the regular
    // copies, which is the case the grain is strictest about.
    .map((slot) => ({ key: `${slot.card.id}|`, quantity: slot.quantity }));
  // Through the real function over the real fixture deck, so the three states a story shows are
  // the three the shipped arithmetic produces rather than three numbers typed here — the same
  // argument `deckGroups` makes for building its groups with `buildGroups`.
  return theoryMatchPlan(
    slots,
    deckGroups().flatMap((group) => group.cards),
  ) as ReadonlyMap<string, number>;
}

/* ------------------------------------------------------------------- the updater ------- */

/**
 * The two versions every update fixture is about: what this world is running, and what the
 * release it can see is.
 *
 * **A pair of fixture values, and never the app's own version.** The real one is
 * `CARGO_PKG_VERSION` and release-please owns it (CLAUDE.md: versions are never typed by
 * hand); anything here that tried to track it would make every update story render
 * differently after every release. What the pair has to be is **ordered**, because the whole
 * of `update::is_newer` is that comparison and `db.ts`'s `toUpdateStatus` derives `available`
 * from it rather than storing a flag.
 */
export const CURRENT_VERSION = "0.3.0";
export const NEXT_VERSION = "0.4.0";

/**
 * One GitHub release, with both Windows assets on it — `update::ReleaseInfo`, which is also
 * exactly what `app_meta.update_latest_seen` holds (the row *is* that struct, serialised).
 *
 * Two files need this and they need the **same** one: `db.ts` seeds a world's `latestSeen`
 * and `remote` from it, and `Settings/UpdatePanel`'s stories build their `status` argument
 * from it. A second copy would let a prop-driven story and a world-driven story disagree
 * about what a release looks like, which is precisely the drift this panel renders.
 *
 * Fresh per call rather than shared, for the reason every seed builder is: a world writes
 * this object into its own `latestSeen`, and two worlds reaching one release object is one
 * edit away from a story seeing another's.
 *
 * The asset names carry the **suffixes** `update::pick_asset` matches on, so `db.ts`'s
 * `pickAsset` really has to choose between them. The sizes are inside the 4.8–6.5 MB the real
 * Windows artifacts run to (`update::MAX_ASSET_BYTES`' own note), because the panel prints
 * them through `formatBytes` and a round number would read as invented.
 */
export function release(version: string): ReleaseInfo {
  const assets: UpdateAsset[] = [
    {
      name: `mtg-grimoire-${version}-windows-x64-portable.zip`,
      url: `https://example.invalid/mtg-grimoire-${version}-windows-x64-portable.zip`,
      size: 6_453_913,
      // GitHub's own `sha256:<hex>`, and the whole of this updater's integrity story: there is
      // no signing keypair behind it, and an **absent** digest is a refusal rather than an
      // unverified pass.
      digest: "sha256:9f2c1d0b7a5e4c3f8d6b2a19e0f7c4d3b8a5e2c1f0d9b6a3e8c5f2d1b0a7e4c39",
    },
    {
      name: `MTG.Grimoire_${version}_x64-setup.exe`,
      url: `https://example.invalid/MTG.Grimoire_${version}_x64-setup.exe`,
      size: 4_812_744,
      digest: "sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    },
  ];
  return {
    version,
    tag: `v${version}`,
    notes: notesFor(version),
    publishedAt: "2026-08-09T04:02:20Z",
    // `update::REPO`, which is where an install that cannot update itself is sent.
    htmlUrl: `https://github.com/Msgaihede/mtg-grimoire/releases/tag/v${version}`,
    assets,
  };
}

/**
 * A release body in **release-please's own shape**, which is the only shape this app ever
 * shows.
 *
 * Every element `src/lib/releaseNotes.ts` has a rule for is here on purpose, because a
 * fixture that omitted one would let the renderer regress with every story still green:
 *
 * * the **version heading** each body opens with, which the reader is drawn under a row that
 *   already says the version — so the parser drops it, and a fixture without one could not
 *   show that;
 * * the **commit trailer**, which is stripped;
 * * a **repeated bullet**, differing only by SHA, which is what the panel's bug report was
 *   actually about — one message landed on two branches, and release-please writes both;
 * * `**scope:**` bold, inline code, and one real link, which survive.
 */
function notesFor(version: string): string {
  const commit = (sha: string) =>
    `([${sha}](https://github.com/Msgaihede/mtg-grimoire/commit/${sha}0e4c3f8d6b2a19e0f7c4d3b8a5))`;
  return [
    `## [${version}](https://github.com/Msgaihede/mtg-grimoire/compare/v0.2.0...v${version}) (2026-08-09)`,
    "",
    "### Features",
    "",
    `* **decks:** take a card from anywhere in the window ${commit("23d15d5")}`,
    `* **settings:** the update panel you are reading ${commit("4aeff6b")}`,
    `* **settings:** the update panel you are reading ${commit("be1a54a")}`,
    "",
    "### Bug Fixes",
    "",
    `* **wishlist:** count a foil wish against foils only ${commit("c13073e")}`,
    `* **sync:** read \`oracle_tags\` weekly, not daily — [the research](https://github.com/Msgaihede/mtg-grimoire/blob/main/docs/superpowers/research/2026-08-14-scryfall-oracle-tags.md) ${commit("bf9ca58")}`,
  ].join("\n");
}

/**
 * The versions behind {@link CURRENT_VERSION}, newest first — one page of `/releases`.
 *
 * Four rather than thirty (`update::HISTORY_PER_PAGE`): the list is a scroller either way,
 * and a fixture's job is to show the shape rather than to reach the cap. The **last** one
 * carries an empty body, which is a real thing a release can publish and the one state
 * `ReleaseNotes` has a sentence of its own for.
 */
const PAST_VERSIONS = ["0.2.0", "0.1.1", "0.1.0"];

/**
 * `update_history`'s answer: every release the last check saw, newest first.
 *
 * Built from {@link release} rather than written out, so a history entry and the release the
 * panel offers cannot disagree about what a release body looks like — the same argument that
 * keeps `db.ts` and `UpdatePanel.stories.tsx` on one `release()`.
 *
 * It **includes the running version and the one on offer**, because the real one does: Rust
 * caches the whole page and concludes nothing about which entries the reader has passed.
 */
export function releaseHistory(): ReleaseNote[] {
  const note = (version: string, publishedAt: string, notes?: string): ReleaseNote => {
    const { tag, htmlUrl } = release(version);
    return { version, tag, notes: notes ?? notesFor(version), publishedAt, htmlUrl };
  };
  return [
    note(NEXT_VERSION, "2026-08-09T04:02:20Z"),
    note(CURRENT_VERSION, "2026-08-04T09:15:00Z"),
    note(PAST_VERSIONS[0], "2026-07-28T18:40:00Z"),
    note(PAST_VERSIONS[1], "2026-07-21T11:05:00Z"),
    note(PAST_VERSIONS[2], "2026-07-14T08:00:00Z", ""),
  ];
}
