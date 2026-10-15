/**
 * A shared deck, as the deck editor's own rows — so the in-app viewer draws it with the editor's
 * four views rather than a fifth drawing of a deck (issue #1032).
 *
 * The views read `DeckCard` and `DeckCategory`, which are the backend's answers about *the
 * reader's own* deck, and most of what they carry is not on the wire and never will be: labels,
 * owned counts, legalities, notes. Each such field is filled with the value that means **"not
 * known"** in the editor's own vocabulary — `null`, `0`, `false` — never a guess, and the viewer
 * hands the views `tracksCollection: false`, so no owned or missing figure is drawn from a zero
 * this module made up.
 *
 * **Ids are positions.** A pile is its index in `deck.piles` (plus one, since `0` is the editor's
 * `AUTO_CATEGORY`), a row its index in `cards`. The document is immutable, so both are stable,
 * and neither names a row in anybody's database — the format's rule that a local id never reaches
 * the wire, read from the other end.
 */
import type { CategoryKind, DeckCard, DeckCategory } from "@/lib/ipc";
import type { ShareDeck, ShareSnapshot } from "@/lib/shareSnapshot";

/** The five pile kinds the rules read. A word this build does not know reads as `main`. */
const KINDS: readonly CategoryKind[] = ["main", "side", "commander", "companion", "maybe"];

function kindOf(word: string): CategoryKind {
  return (KINDS as readonly string[]).includes(word) ? (word as CategoryKind) : "main";
}

/** `nonfoil` is the regular copy, which the editor spells `null`. */
function finishOf(word: string): DeckCard["finish"] {
  return word === "foil" || word === "etched" ? word : null;
}

export interface SharedDeckRows {
  cards: DeckCard[];
  categories: DeckCategory[];
}

/**
 * The snapshot's cards as deck rows, filed under its piles as deck categories.
 *
 * A card whose folder is no pile of `deck` — a document a later build wrote, or a hand-made one —
 * is filed under a pile of its own named for nothing rather than dropped: a card the publisher
 * shared and the viewer did not draw is the one failure a viewer must not have.
 */
export function sharedDeckRows(snapshot: ShareSnapshot, deck: ShareDeck): SharedDeckRows {
  const names = new Map(snapshot.folders.map((f) => [f.uid, f.name]));
  const categories: DeckCategory[] = deck.piles.map((pile, at) => ({
    id: at + 1,
    deckId: 0,
    variant: "live",
    name: names.get(pile.uid) ?? "",
    kind: kindOf(pile.kind),
    // `user`, so a pile draws whether or not it holds a card — and it always does, since an empty
    // pile does not travel.
    origin: "user",
    isActive: pile.active,
    sortOrder: at,
    cardCount: 0,
    totalPrice: null,
  }));
  const byUid = new Map(deck.piles.map((pile, at) => [pile.uid, categories[at]]));

  let stray: DeckCategory | undefined;
  const pileFor = (uid: string | null): DeckCategory => {
    const pile = uid === null ? undefined : byUid.get(uid);
    if (pile !== undefined) return pile;
    if (stray === undefined) {
      stray = {
        ...categories[0],
        id: categories.length + 1,
        name: "Other",
        kind: "main",
        isActive: true,
        sortOrder: categories.length,
      };
      categories.push(stray);
    }
    return stray;
  };

  const cards = snapshot.cards.map((card, at): DeckCard => {
    const pile = pileFor(card.fo);
    pile.cardCount += card.q;
    return {
      id: at + 1,
      cardId: card.id,
      categoryId: pile.id,
      categoryName: pile.name,
      categoryKind: pile.kind,
      categoryActive: pile.isActive,
      variant: "live",
      labelId: null,
      labelName: null,
      labelColor: null,
      quantity: card.q,
      name: card.n,
      setCode: card.s,
      setName: null,
      collectorNumber: card.cn,
      lang: card.l ?? "en",
      finish: finishOf(card.f),
      needsReview: null,
      oracleId: null,
      manaCost: card.mc ?? null,
      cmc: card.mv ?? null,
      typeLine: card.t ?? null,
      oracleText: null,
      colors: null,
      colorIdentity: null,
      producedMana: null,
      legalities: null,
      power: null,
      toughness: null,
      layout: null,
      rarity: null,
      faces: null,
      gameChanger: null,
      finishes: null,
      promoTypes: null,
      everUncommon: false,
      // `== null`, the format's absence: an unquoted finish is an em dash, never a zero.
      unitPrice: card.p ?? null,
      ownedQuantity: 0,
    };
  });
  return { cards, categories };
}
