import { describe, expect, it, vi } from "vitest";
import type {
  MenuAction,
  MenuItem,
  MenuRadio,
  MenuSubmenu,
} from "@/components/menu/types";
import type { CardMenuDeps } from "@/features/card/cardMenu";
import type { DeckCard, DeckCategory, DeckLabel } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { buildDeckCardMenu, deckCardLabelRows, type DeckCardMenuDeps } from "./deckCardMenu";
import { card, spec } from "./validation/fixtures";

/** The shared builder's own dependencies, stubbed — this file is about the deck's extras,
 *  and `cardMenu.test.tsx` owns the rows above the rule. */
const CARD_DEPS: CardMenuDeps = {
  marketplace: MARKETPLACES.tcgplayer,
  addToCollection: vi.fn(),
  addToWishlist: vi.fn(),
  // A wishlist that files nothing — the case this file was already asserting, and the one that
  // leaves "Add to → Wishlist" the single row it has always been.
  wishlistFolders: [],
  openAllPrintings: vi.fn(),
  DeckTargetSubmenu: () => null,
};

function category(
  id: number,
  name: string,
  kind: DeckCategory["kind"],
  sortOrder: number,
  over: Partial<DeckCategory> = {},
): DeckCategory {
  return {
    id,
    deckId: 4,
    name,
    kind,
    isActive: true,
    origin: "user",
    sortOrder,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: 0,
    ...over,
  };
}

/**
 * The deck's piles **in the reader's own `sortOrder`**, which is deliberately not the alphabet
 * — that is what makes the order assertion below discriminate at all.
 *
 * `Recursion` is `origin: "auto"` and holds nothing, so `drawsWhenEmpty` keeps it off the desk
 * entirely. It is the one pile a drag cannot reach and the whole reason this menu exists.
 */
const CATEGORIES: DeckCategory[] = [
  category(3, "Commander", "commander", 0),
  category(1, "Main deck", "main", 1),
  category(7, "Recursion", "main", 2, { origin: "auto" }),
  category(2, "Sideboard", "side", 3),
  category(4, "Companion", "companion", 4),
];

const CATEGORY_ORDER = ["Commander", "Main deck", "Recursion", "Sideboard", "Companion"];

const LABELS: DeckLabel[] = [
  { id: 8, name: "Budget swap", color: "moss", cardCount: 2 },
  { id: 9, name: "Cut candidate", color: "ember", cardCount: 1 },
];

function bolt(over: Partial<DeckCard> = {}): DeckCard {
  return card({ name: "Lightning Bolt", quantity: 1, ...over });
}

function deps(over: Partial<DeckCardMenuDeps> = {}): DeckCardMenuDeps {
  return {
    card: CARD_DEPS,
    categories: CATEGORIES,
    cards: [],
    spec: spec("modern"),
    setFinish: vi.fn(),
    moveTo: vi.fn(),
    setLabel: vi.fn(),
    labels: LABELS,
    addLabel: vi.fn(),
    remove: vi.fn(),
    ...over,
  };
}

/**
 * The same deck card with the three `Collection ▸` callbacks wired — what `DeckEditor` hands the
 * builder once issue #350's writes exist.
 *
 * **Deliberately not folded into {@link deps}**, because every other test in this file is then a
 * test of a menu whose surface wired no such writes — which is exactly what the submenu's absence
 * rule has to be checked against, and it is checked for free by the ordering assertions that were
 * already here.
 */
function collectionDeps(over: Partial<DeckCardMenuDeps> = {}): DeckCardMenuDeps {
  return deps({
    quickAdd: vi.fn(),
    quickAddAndUnwish: vi.fn(),
    pullCard: vi.fn(),
    ...over,
  });
}

const labels = (items: MenuItem[]) =>
  items.filter((i) => i.kind !== "separator").map((i) => i.label);

function find(items: MenuItem[], label: string | RegExp): MenuItem {
  const match = items.find(
    (i) =>
      i.kind !== "separator" &&
      (typeof label === "string" ? i.label === label : label.test(i.label)),
  );
  if (!match) throw new Error(`no row called ${String(label)} in [${labels(items).join(", ")}]`);
  return match;
}

const has = (items: MenuItem[], label: string | RegExp) =>
  items.some(
    (i) =>
      i.kind !== "separator" &&
      (typeof label === "string" ? i.label === label : label.test(i.label)),
  );

describe("buildDeckCardMenu", () => {
  /** The deck's rows are an *addition*: a card in a deck is still a card, so everything every
   *  other card surface offers is here and in the same order. */
  it("keeps the card menu's own rows in front of the deck's", () => {
    const items = buildDeckCardMenu(bolt(), deps());
    expect(labels(items).slice(0, 5)).toEqual([
      "Copy card name",
      "Copy card image",
      "Open on",
      "View all printings",
      "Add to",
    ]);
    expect(labels(items).slice(5)).toEqual([
      "Move to",
      "Set as companion",
      // The finish row sits with the zone rows rather than with `Move to`: those say what this
      // card *is* in the deck, and so does this. `Move to` is filing.
      "Set as foil",
      "Label card",
      "Remove card",
    ]);
  });

  /**
   * **The finish row, and the three shapes that question has** — `collectionItem`'s rule one
   * file over, for its reason: a choice with one answer is not a choice.
   */
  describe("the finish row", () => {
    const BOTH = '["nonfoil","foil"]';

    /**
     * By **id**, not by label — `find` matches labels, and `Set as commander` and `Set as
     * companion` are two rows above this one that a `/^Set as/` regex swallows. The id is the
     * one thing the row keeps through all three of its shapes.
     */
    const finishRow = (items: MenuItem[]): Exclude<MenuItem, { kind: "separator" }> => {
      const row = items.find(
        (i): i is Exclude<MenuItem, { kind: "separator" }> =>
          i.kind !== "separator" && i.id === "finish",
      );
      if (!row) throw new Error(`no finish row in [${labels(items).join(", ")}]`);
      return row;
    };

    it("toggles in one press on a printing sold in two finishes", () => {
      const setFinish = vi.fn();
      const card = bolt({ finishes: BOTH, finish: null });
      const row = finishRow(buildDeckCardMenu(card, deps({ setFinish })));

      expect(row.label).toBe("Set as foil");
      expect(row.kind).toBe("action");
      if (row.kind === "action") row.onSelect();
      expect(setFinish).toHaveBeenCalledWith(card, "foil");
    });

    it("names the way back when the row is already foil", () => {
      const setFinish = vi.fn();
      const card = bolt({ finishes: BOTH, finish: "foil" });
      const row = finishRow(buildDeckCardMenu(card, deps({ setFinish })));

      // `regular`, not `nonfoil`: "set as nonfoil" is not a thing anybody says.
      expect(row.label).toBe("Set as regular");
      if (row.kind === "action") row.onSelect();
      expect(setFinish).toHaveBeenCalledWith(card, null);
    });

    it("offers a submenu of the printing's own finishes when it is sold in three", () => {
      const card = bolt({ finishes: '["nonfoil","foil","etched"]', finish: "foil" });
      const row = finishRow(buildDeckCardMenu(card, deps()));

      expect(row.kind).toBe("submenu");
      if (row.kind !== "submenu") return;
      // Scryfall's order — plain, then the premium treatments — and deliberately not
      // `sortOptions`': the order *is* the information here.
      expect(labels(row.items)).toEqual(["Regular", "Foil", "Etched"]);
      // The finish it already is, drawn and greyed rather than dropped, so the list keeps its
      // length and its positions.
      expect(row.items.map((i) => i.kind === "action" && i.disabled === true)).toEqual([
        false,
        true,
        false,
      ]);
    });

    /**
     * **Greyed, and silent.** This menu's own precedent (`zoneItem`) rather than
     * `cardMenu.tsx`'s greyed-with-a-reason: a menu row is sized by its widest content, so a
     * sentence on a row that greys on a large minority of cards would set the width of every
     * row in the panel.
     */
    it("greys on a printing sold in one finish, and says nothing", () => {
      const row = finishRow(buildDeckCardMenu(bolt({ finishes: '["nonfoil"]' }), deps()));

      expect(row.kind === "action" && row.disabled).toBe(true);
      expect(row.kind === "action" && row.reason).toBeUndefined();
    });

    /** A printing whose `finishes` column is empty or unreadable is *unknown*, not a choice to
     *  offer — the same floor `finishChoices` gives the collection picker. */
    it("greys on a printing whose finish list is missing", () => {
      const row = finishRow(buildDeckCardMenu(bolt({ finishes: null }), deps()));
      expect(row.kind === "action" && row.disabled).toBe(true);
    });

    /** The row stays **present** when it is greyed, so its position never moves — `View all
     *  printings`' rule, for its reason. */
    it("keeps its place in the list when it is greyed", () => {
      const at = (finishes: string | null) =>
        buildDeckCardMenu(bolt({ finishes }), deps()).findIndex(
          (i) => i.kind !== "separator" && i.id === "finish",
        );

      expect(at('["nonfoil"]')).toBe(at(BOTH));
      expect(at('["nonfoil","foil","etched"]')).toBe(at(BOTH));
    });
  });

  /**
   * **`Remove card` sits below a rule of its own**, and the rule is the point: everything above
   * it says where this card goes or what it is called, and this one takes the cardboard out. A
   * row that removes a card must not sit flush against the row that renames its label.
   *
   * `labels` strips separators, so nothing else in this file can see one being dropped.
   */
  it("puts a rule between the card's filing rows and the row that removes it", () => {
    const items = buildDeckCardMenu(bolt(), deps());
    const shape = items.map((item) => (item.kind === "separator" ? `—${item.id}` : item.id));

    expect(shape.slice(-2)).toEqual(["—sep-remove", "remove-card"]);
  });

  /**
   * One press, no confirmation — where the *pile's* `Clear stack…` has one. The asymmetry is
   * deliberate: one card is one add to put back and the reader can see which one it was, and a
   * pile is a column they would have to rebuild.
   */
  it("removes the card that was right-clicked, with nothing to confirm", () => {
    const remove = vi.fn();
    const row = bolt({ categoryId: 1 });

    (find(buildDeckCardMenu(row, deps({ remove })), "Remove card") as MenuAction).onSelect();

    expect(remove).toHaveBeenCalledWith(row);
  });

  /**
   * **Built from the deck's `categories`, never from the drawn groups**, which is the whole
   * point of the row: `Recursion` is an emptied `auto` pile, so no heading is drawn for it and
   * a drag cannot reach it at all. This is the replacement for the `Move…` select removed on
   * 2026-08-14, not a duplicate of the drag.
   */
  it("lists every category of the deck, including one with no heading on screen", () => {
    const move = find(buildDeckCardMenu(bolt(), deps()), "Move to") as MenuSubmenu;
    expect(labels(move.items)).toContain("Recursion");
  });

  /**
   * **Deck categories are a documented exemption from `sortOptions`** — an order the reader
   * arranged themselves — so the alphabet must not touch this list. Sorted, it would read
   * Commander, Companion, Main deck, Recursion, Sideboard.
   */
  it("keeps the reader's own category order rather than sorting it", () => {
    const move = find(buildDeckCardMenu(bolt(), deps()), "Move to") as MenuSubmenu;
    expect(labels(move.items)).toEqual(CATEGORY_ORDER);
    expect(labels(move.items)).not.toEqual([...CATEGORY_ORDER].sort());
  });

  /** The pile the card is already in is drawn and greyed rather than dropped: "every category"
   *  is what makes the list findable, and a press that wrote a move from a pile to itself
   *  would be a write that means nothing. */
  it("greys the pile the card is already in, with the reason", () => {
    const items = buildDeckCardMenu(bolt({ categoryId: 1 }), deps());
    const move = find(items, "Move to") as MenuSubmenu;
    const here = find(move.items, "Main deck") as MenuAction;
    expect(here.disabled).toBe(true);
    expect(here.reason).toMatch(/already/i);
  });

  it("moves the card into the pile that was pressed", () => {
    const moveTo = vi.fn();
    const row = bolt({ categoryId: 1 });
    const move = find(buildDeckCardMenu(row, deps({ moveTo })), "Move to") as MenuSubmenu;
    (find(move.items, "Recursion") as MenuAction).onSelect();
    expect(moveTo).toHaveBeenCalledWith(row, 7);
  });

  it("offers no commander row in a format with no command zone", () => {
    expect(has(buildDeckCardMenu(bolt(), deps()), /commander/i)).toBe(false);
  });

  /**
   * The test underneath is `commanderIneligibility`'s own — the rule the validation panel judges
   * a built deck by and the importer offers candidates by. A looser one here would offer a card
   * the panel then refuses.
   *
   * **No `reason`, and that is the assertion worth having** (2026-08-17): the rule's sentences
   * are written for the validation panel, and drawing one here set the width of every row in the
   * menu. The row greys; the words live where there is room for them.
   */
  it("greys the commander row for an ineligible card, wordlessly", () => {
    const items = buildDeckCardMenu(bolt(), deps({ spec: spec("commander") }));
    const row = find(items, "Set as commander") as MenuAction;
    expect(row.disabled).toBe(true);
    expect(row.reason).toBeUndefined();
  });

  it("offers the commander row live for an eligible card, and sends it to the command zone", () => {
    const moveTo = vi.fn();
    const atraxa = card({
      name: "Atraxa, Praetors' Voice",
      typeLine: "Legendary Creature — Phyrexian Angel Horror",
      power: "4",
      toughness: "4",
      quantity: 1,
    });
    const items = buildDeckCardMenu(atraxa, deps({ spec: spec("commander"), moveTo }));
    const row = find(items, "Set as commander") as MenuAction;
    expect(row.disabled).toBeUndefined();
    row.onSelect();
    expect(moveTo).toHaveBeenCalledWith(atraxa, 3);
  });

  /** Gladiator is the one seeded format with no sideboard, so it has no slot a companion could
   *  sit in — the row is absent rather than greyed, exactly as the category menu drops the two
   *  rows the backend would refuse. */
  it("offers no companion row where the format has no sideboard", () => {
    const items = buildDeckCardMenu(bolt(), deps({ spec: spec("gladiator") }));
    expect(has(items, /companion/i)).toBe(false);
  });

  it("greys the companion row for a card with no companion ability, wordlessly", () => {
    const row = find(buildDeckCardMenu(bolt(), deps()), "Set as companion") as MenuAction;
    expect(row.disabled).toBe(true);
    expect(row.reason).toBeUndefined();
  });

  it("offers the companion row for a real companion whose condition the deck meets", () => {
    const moveTo = vi.fn();
    const jegantha = card({
      name: "Jegantha, the Wellspring",
      typeLine: "Legendary Creature — Elemental Elk",
      manaCost: "{R}{G}",
      quantity: 1,
    });
    const items = buildDeckCardMenu(
      jegantha,
      deps({ cards: [bolt(), jegantha], moveTo, spec: spec("commander") }),
    );
    const row = find(items, "Set as companion") as MenuAction;
    expect(row.disabled).toBeUndefined();
    row.onSelect();
    expect(moveTo).toHaveBeenCalledWith(jegantha, 4);
  });

  /**
   * The reigning commander gets a greyed row rather than a live one — the write would be a move
   * from a category to itself, which is the same nothing `Move to`'s own pile is greyed for.
   * Worth its own case because the test is *not* `commanderIneligibility`'s: the card in the
   * command zone is by definition an eligible one, so an eligibility test alone would offer it.
   *
   * `ALREADY_HERE` is still what greys it and is no longer drawn on it — a zone row words
   * nothing, whichever of the two refusals it met. `Move to`'s own pile still draws that string.
   */
  it("greys the zone row on the card that is already in it", () => {
    const atraxa = card({
      name: "Atraxa, Praetors' Voice",
      categoryKind: "commander",
      typeLine: "Legendary Creature — Phyrexian Angel Horror",
      power: "4",
      toughness: "4",
      quantity: 1,
    });
    // `fixtures.ts` files a `commander` card under its own category id, which is this deck's.
    const items = buildDeckCardMenu(atraxa, deps({ spec: spec("commander") }));
    const row = find(items, "Set as commander") as MenuAction;
    expect(row.disabled).toBe(true);
    expect(row.reason).toBeUndefined();
  });

  /** A deck whose seeded zone has been lost cannot be written to, so nothing offers it: an
   *  item that exists only to be refused is worse than one that is not there. */
  it("draws no commander row when the deck has no command zone to move into", () => {
    const items = buildDeckCardMenu(
      bolt(),
      deps({ spec: spec("commander"), categories: CATEGORIES.filter((c) => c.kind !== "commander") }),
    );
    expect(has(items, "Set as commander")).toBe(false);
  });

  /**
   * **`submenu`, not `lazy` — and that is a fact about the rows rather than a preference.**
   *
   * The kind was `lazy` for one reason: a `MenuItem[]` cannot carry a text input, and "New label…"
   * was one until 2026-08-20. It is a row now, so nothing in this submenu mounts, queries or
   * holds state — the labels come from `deps.labels`, which the editor already holds from
   * `deck_get`. A `lazy` here would be a component mounted to draw four radios.
   */
  it("builds the label rows as a plain submenu, with nothing to mount", () => {
    const row = find(buildDeckCardMenu(bolt(), deps()), "Label card") as MenuSubmenu;
    expect(row.kind).toBe("submenu");
    expect(labels(row.items)).toEqual(["None", "Budget swap", "Cut candidate", "More labels…"]);
  });

  /**
   * The row that opens `AddLabelDialog`, and the whole of what it does: hand the card up.
   *
   * **It must not write.** The field this replaced created the label and attached it, and the
   * attach belonged to an observer the panel took with it when it closed — so a create still in
   * flight at a dismissal lost its second half silently. The surface owns both halves now, and
   * a row that reached for either would be that bug coming back.
   */
  it("hands the card to the surface when More labels… is pressed", () => {
    const target = bolt();
    const wired = deps();
    const row = find(buildDeckCardMenu(target, wired), "Label card") as MenuSubmenu;
    const item = find(row.items, "More labels…") as MenuAction;

    item.onSelect();

    expect(wired.addLabel).toHaveBeenCalledWith(target);
    expect(wired.setLabel).not.toHaveBeenCalled();
  });

  /**
   * **`Collection ▸`** — issue #350's three presses, and the only rows in this menu that write to
   * the reader's binder rather than to their list.
   */
  describe("the Collection submenu", () => {
    /** Short by three: the deck plays four and the reader owns one, which is the `1/4` the
     *  card's chin draws. */
    const short = () => bolt({ quantity: 4, ownedQuantity: 1 });

    const collection = (items: MenuItem[]) => find(items, "Collection") as MenuSubmenu;

    /**
     * **The absence is the surface saying it wired no writes** — `cardMenu.tsx`'s `moveItem`
     * rule, which drops its whole item rather than drawing a picker that cannot file. This is
     * also the state every other test in this file is written against.
     */
    it("builds nothing at all where the surface wired no collection writes", () => {
      expect(has(buildDeckCardMenu(short(), deps()), "Collection")).toBe(false);
    });

    /** The three answer one question and travel together, so two of them is a half-wired
     *  surface rather than a menu with a row missing. */
    it("builds nothing where only some of the three writes are wired", () => {
      const partial = deps({ quickAdd: vi.fn(), pullCard: vi.fn() });
      expect(has(buildDeckCardMenu(short(), partial), "Collection")).toBe(false);
    });

    /**
     * **After `Move to` and in front of the zone rows.** It is *filing*, like `Move to`;
     * everything from `Set as commander` down is a claim about what the card **is** in this deck.
     */
    it("sits after Move to and before the zone rows", () => {
      const items = buildDeckCardMenu(short(), collectionDeps({ spec: spec("commander") }));
      expect(labels(items).slice(5)).toEqual([
        "Move to",
        "Collection",
        "Set as commander",
        "Set as companion",
        "Set as foil",
        "Label card",
        "Remove card",
      ]);
    });

    /** The rows, in the plan's own order, with the shortfall named in each. */
    it("names the row's own shortfall in all three labels", () => {
      const rows = collection(buildDeckCardMenu(short(), collectionDeps())).items;
      expect(labels(rows)).toEqual([
        "Quick add 3 copies",
        "Quick add 3 and remove from wishlist",
        "Pull 3 from your collection",
      ]);
    });

    /** The app must never print "1 copies", and one copy is the count a reader meets most —
     *  `plural` from `@/lib/counts`, which is where this feature already spells one. */
    it("goes singular for a single copy", () => {
      const rows = collection(
        buildDeckCardMenu(bolt({ quantity: 1, ownedQuantity: 0 }), collectionDeps()),
      ).items;
      expect(labels(rows)).toEqual([
        "Quick add 1 copy",
        "Quick add 1 and remove from wishlist",
        "Pull 1 from your collection",
      ]);
    });

    /**
     * The rule between *recording* cardboard and *moving* it: the two rows above say the copies
     * exist, and the one below takes copies the reader already owns loose.
     *
     * `labels` strips separators, so nothing else in this file can see one being dropped.
     */
    it("rules off the pull from the two rows that record copies", () => {
      const rows = collection(buildDeckCardMenu(short(), collectionDeps())).items;
      expect(rows.map((i) => (i.kind === "separator" ? `—${i.id}` : i.id))).toEqual([
        "quick-add",
        "quick-add-unwish",
        "—sep-pull",
        "pull-from-collection",
      ]);
    });

    /** The count the label quoted is the count the write is pressed with — one spelling of the
     *  shortfall, so the row can never file a number the card is not wearing. */
    it("presses each write with the card and the count its own label quoted", () => {
      const quickAdd = vi.fn();
      const quickAddAndUnwish = vi.fn();
      const pullCard = vi.fn();
      const row = short();
      const rows = collection(
        buildDeckCardMenu(row, collectionDeps({ quickAdd, quickAddAndUnwish, pullCard })),
      ).items;

      (find(rows, "Quick add 3 copies") as MenuAction).onSelect();
      expect(quickAdd).toHaveBeenCalledWith(row, 3);

      (find(rows, "Quick add 3 and remove from wishlist") as MenuAction).onSelect();
      expect(quickAddAndUnwish).toHaveBeenCalledWith(row, 3);

      // No count: the pull moves cardboard that exists, so what it can take is decided by what
      // the binder holds rather than by the shortfall.
      (find(rows, "Pull 3 from your collection") as MenuAction).onSelect();
      expect(pullCard).toHaveBeenCalledWith(row);
      expect(pullCard.mock.calls[0]).toHaveLength(1);
    });

    /**
     * **Greyed _with_ a reason**, where this menu's zone and finish rows grey silently — the split
     * is `cardMenu.tsx`'s test rather than a drift. A plan holding no cards is a rule about the
     * list the reader is standing in, and nothing on the card in front of them says it.
     */
    it("greys all three rows on a theory row, and says why", () => {
      const plan = bolt({ quantity: 4, ownedQuantity: 0, variant: "theory" });
      const rows = collection(buildDeckCardMenu(plan, collectionDeps())).items;
      const actions = rows.filter((i): i is MenuAction => i.kind === "action");

      expect(actions).toHaveLength(3);
      for (const row of actions) {
        expect(row.disabled).toBe(true);
        expect(row.reason).toBe("a plan holds no cards");
      }
    });

    /** Nothing to file: the deck plays four and the reader owns four. The label still quotes the
     *  shortfall — `Quick add 0 copies` beside `nothing missing` is the fact and its reason side
     *  by side, rather than a label that changes shape with the state. */
    it("greys all three rows on a card the reader is not short of, and says why", () => {
      const stocked = bolt({ quantity: 4, ownedQuantity: 4 });
      const rows = collection(buildDeckCardMenu(stocked, collectionDeps())).items;
      const actions = rows.filter((i): i is MenuAction => i.kind === "action");

      expect(actions).toHaveLength(3);
      for (const row of actions) {
        expect(row.disabled).toBe(true);
        expect(row.reason).toBe("nothing missing");
      }
      expect(labels(rows)[0]).toBe("Quick add 0 copies");
    });

    /** A greyed row writes nothing, which is the half `disabled` alone does not promise: it is
     *  `aria-disabled` on the panel, so the row stays in the caret's reach. */
    it("writes nothing when a greyed row is pressed anyway", () => {
      const quickAdd = vi.fn();
      const pullCard = vi.fn();
      const stocked = bolt({ quantity: 4, ownedQuantity: 4 });
      const rows = collection(
        buildDeckCardMenu(stocked, collectionDeps({ quickAdd, pullCard })),
      ).items;

      for (const row of rows) if (row.kind === "action") row.onSelect();

      expect(quickAdd).not.toHaveBeenCalled();
      expect(pullCard).not.toHaveBeenCalled();
    });

    /**
     * **The parent stays live, and that is what lets the reason be read at all** — a greyed
     * submenu cannot be opened, so its rows' sentences would be written where nobody can reach
     * them. Greyed rather than hidden for `View all printings`' reason: every card of this
     * surface can be short, so a row that vanished on the ones that are not reads as a bug.
     */
    it("keeps the parent live and in place while its rows are greyed", () => {
      const stocked = buildDeckCardMenu(bolt({ quantity: 4, ownedQuantity: 4 }), collectionDeps());
      const parent = collection(stocked);

      expect(parent.kind).toBe("submenu");
      expect(labels(stocked).indexOf("Collection")).toBe(
        labels(buildDeckCardMenu(bolt({ quantity: 4 }), collectionDeps())).indexOf("Collection"),
      );
    });
  });
});

describe("deckCardLabelRows", () => {
  /** A deck card wears **at most one** label — `setLabel` takes `labelId: number | null` — so these
   *  are radios and "None" is the row that takes the label off. */
  it("offers None first and ticks the label the card is wearing", () => {
    const rows = deckCardLabelRows(bolt({ labelId: 8, labelName: "Budget swap" }), LABELS, vi.fn());
    expect(labels(rows)).toEqual(["None", "Budget swap", "Cut candidate"]);
    expect(rows.every((r) => r.kind === "radio")).toBe(true);
    expect((find(rows, "None") as MenuRadio).checked).toBe(false);
    expect((find(rows, "Budget swap") as MenuRadio).checked).toBe(true);
    expect((find(rows, "Cut candidate") as MenuRadio).checked).toBe(false);
  });

  it("ticks None for a card wearing no label", () => {
    const rows = deckCardLabelRows(bolt(), LABELS, vi.fn());
    expect((find(rows, "None") as MenuRadio).checked).toBe(true);
  });

  /**
   * **The backend's order is kept, and that reverses a fix made on 2026-08-14.**
   *
   * The list used to be drawn through `sortOptions`, and for a good reason: `deck_meta.rs`'
   * `ORDER BY t.name` was a `TEXT` column with no `COLLATE NOCASE`, so it arrived in byte order
   * — every capitalised label above every lower-case one, and a reader looking for "budget"
   * under B finding it at the bottom. An alphabet the reader cannot predict is worth replacing
   * with one they can.
   *
   * The premise is gone. `deck_label_list` answers **most-used first** since schema v21, which is
   * the first of the two exemptions this app grants — an order that *is* the information.
   * Re-sorting here would throw away a fact the backend went and counted, and would bury the
   * label this deck reaches for most under whatever its first letter is.
   *
   * "None" stays pinned in front: it is the row that takes a label *off*, not one of the labels.
   */
  it("keeps the backend's most-used-first order rather than re-sorting the labels", () => {
    const arrived: DeckLabel[] = [
      { id: 1, name: "Cut", color: "ember", cardCount: 9 },
      { id: 2, name: "budget", color: "moss", cardCount: 4 },
      { id: 3, name: "Ramp", color: "gold", cardCount: 1 },
    ];

    expect(labels(deckCardLabelRows(bolt(), arrived, vi.fn()))).toEqual([
      "None",
      "Cut",
      "budget",
      "Ramp",
    ]);
  });

  it("takes the label off with null and puts one on by id", () => {
    const setLabel = vi.fn();
    const row = bolt({ labelId: 8 });
    const rows = deckCardLabelRows(row, LABELS, setLabel);
    (find(rows, "None") as MenuRadio).onSelect();
    expect(setLabel).toHaveBeenCalledWith(row, null);
    (find(rows, "Cut candidate") as MenuRadio).onSelect();
    expect(setLabel).toHaveBeenLastCalledWith(row, 9);
  });
});

/**
 * **The plural** — issue #214. When the right-clicked card is a member of the reader's picked
 * set, three rows act on the whole set and three deliberately do not.
 *
 * The set itself is decided by the *surface* and arrives as `picked`, so nothing here knows what
 * a selection is; what these pin is the shape the builder gives one.
 */
describe("buildDeckCardMenu with a picked set", () => {
  const BOLT = bolt();
  const BEAR = card({ name: "Bear", quantity: 2 });
  const PONDER = card({ name: "Ponder", quantity: 1 });
  const PICKED = [BOLT, BEAR, PONDER];

  /** A submenu's rows, for the two that go plural on the outer label and act on the inner one. */
  const rowsOf = (item: MenuItem) => (item as MenuSubmenu).items;

  it("counts the set in the labels of the three rows that act on it", () => {
    const items = buildDeckCardMenu(BOLT, deps({ picked: PICKED }));
    expect(has(items, "Move 3 cards to")).toBe(true);
    expect(has(items, "Label 3 cards")).toBe(true);
    expect(has(items, "Remove 3 cards")).toBe(true);
  });

  /**
   * **And the shared half counts it too** — found by driving the shipped window on 2026-08-24,
   * where the menu read `Move 2 cards to` directly under a singular `Add to`.
   *
   * The seam is what neither existing suite could see: this file's own tests assert the deck's
   * rows, and `cardMenu.test.tsx` builds the shared menu directly, so nothing was looking at what
   * `buildDeckCardMenu` hands *through*. `buildCardMenu` decides for itself which of its rows a
   * set can mean anything to; the claim here is only that it is told.
   */
  it("hands the set through to the card menu's own rows", () => {
    const items = buildDeckCardMenu(BOLT, deps({ picked: PICKED }));
    expect(has(items, "Add 3 cards to")).toBe(true);
    // And the rows that have no plural are untouched by it.
    expect(has(items, "Copy card name")).toBe(true);
    expect(has(items, "View all printings")).toBe(true);
  });

  /**
   * **A finish belongs to a printing and a command zone holds one card**, so neither has a plural
   * that means anything. Named here rather than left as an absence, because a row that quietly
   * acted on one card out of three would be the worst of the three options.
   */
  it("leaves the finish and zone rows about the one card that was right-clicked", () => {
    const items = buildDeckCardMenu(BOLT, deps({ picked: PICKED }));
    expect(has(items, "Set as foil")).toBe(true);
    expect(has(items, "Set as companion")).toBe(true);
    expect(has(items, /Set 3 cards/)).toBe(false);
  });

  /** A set of one is the card, so no label grows a `1 card` that says less than the card's name. */
  it("stays singular for a set of one", () => {
    const items = buildDeckCardMenu(BOLT, deps({ picked: [BOLT] }));
    expect(labels(items).slice(5)).toEqual([
      "Move to",
      "Set as companion",
      "Set as foil",
      "Label card",
      "Remove card",
    ]);
  });

  it("removes every picked card on one press", () => {
    const remove = vi.fn();
    const items = buildDeckCardMenu(BOLT, deps({ picked: PICKED, remove }));
    (find(items, "Remove 3 cards") as MenuAction).onSelect();

    expect(remove.mock.calls.map((call) => (call[0] as DeckCard).name)).toEqual([
      "Lightning Bolt",
      "Bear",
      "Ponder",
    ]);
  });

  it("moves every picked card on one press", () => {
    const moveTo = vi.fn();
    const items = buildDeckCardMenu(BOLT, deps({ picked: PICKED, moveTo }));
    (find(rowsOf(find(items, "Move 3 cards to")), "Sideboard") as MenuAction).onSelect();

    expect(moveTo).toHaveBeenCalledTimes(3);
    expect(moveTo.mock.calls.map((call) => call[1] as number)).toEqual([2, 2, 2]);
  });

  /**
   * **Greyed only when there is nothing left to move.** A set straddling two piles keeps the row
   * live for both, and the loop passes over the members that are already home — `dropWrite`'s
   * "a card dropped back in its own pile is not a move" at a second entrance.
   */
  it("keeps a destination live while any picked card is still elsewhere", () => {
    const moveTo = vi.fn();
    const here = card({ name: "Bear", quantity: 2, categoryId: 2 });
    const items = buildDeckCardMenu(BOLT, deps({ picked: [BOLT, here], moveTo }));
    const row = find(rowsOf(find(items, "Move 2 cards to")), "Sideboard") as MenuAction;

    expect(row.disabled).toBeUndefined();
    row.onSelect();
    expect(moveTo.mock.calls.map((call) => (call[0] as DeckCard).name)).toEqual(["Lightning Bolt"]);
  });

  it("greys a destination every picked card is already in", () => {
    const here = card({ name: "Bear", quantity: 2, categoryId: 2 });
    const there = card({ name: "Ponder", quantity: 1, categoryId: 2 });
    const items = buildDeckCardMenu(here, deps({ picked: [here, there] }));

    expect((find(rowsOf(find(items, "Move 2 cards to")), "Sideboard") as MenuAction).disabled).toBe(
      true,
    );
  });

  /**
   * **`Collection ▸` stays about the one card that was right-clicked**, and the count in every
   * one of its labels is why: three rows short by three different amounts have no one number to
   * name, so a plural row could only quote a total no card on screen is wearing — or file
   * whichever member the label happened to be about.
   */
  it("keeps the Collection rows about the right-clicked card under a set", () => {
    const quickAdd = vi.fn();
    const pressed = card({ name: "Lightning Bolt", quantity: 4, ownedQuantity: 1 });
    const other = card({ name: "Bear", quantity: 3, ownedQuantity: 0 });
    const items = buildDeckCardMenu(
      pressed,
      collectionDeps({ picked: [pressed, other], quickAdd }),
    );
    const rows = (find(items, "Collection") as MenuSubmenu).items;

    // The right-clicked row's own shortfall, and never the set's total of six.
    expect(labels(rows)).toEqual([
      "Quick add 3 copies",
      "Quick add 3 and remove from wishlist",
      "Pull 3 from your collection",
    ]);
    (find(rows, "Quick add 3 copies") as MenuAction).onSelect();
    expect(quickAdd.mock.calls).toEqual([[pressed, 3]]);
  });

  it("labels every picked card on one press", () => {
    const setLabel = vi.fn();
    const items = buildDeckCardMenu(BOLT, deps({ picked: PICKED, setLabel }));
    (find(rowsOf(find(items, "Label 3 cards")), "Budget swap") as MenuRadio).onSelect();

    expect(setLabel.mock.calls.map((call) => [(call[0] as DeckCard).name, call[1] as number])).toEqual([
      ["Lightning Bolt", 8],
      ["Bear", 8],
      ["Ponder", 8],
    ]);
  });
});
