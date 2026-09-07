/**
 * What a card offers on a right-click **inside the deck editor** — the card menu every other
 * surface draws, plus the things that only mean something about a card that is in a deck.
 *
 * ```
 * … the card menu every surface draws …
 * ─────────────────────
 * Move to              ▸  every category of the deck, in the reader's own order
 * Collection           ▸  the three presses that answer this row's shortfall
 * Set as commander        (only where the format has a command zone)
 * Set as companion        (only where the format has a slot for one)
 * Set as foil             (or a `Finish ▸` submenu where the printing is sold in three)
 * Label card           ▸  None / the deck's labels / New label…
 * ─────────────────────
 * Remove card             every copy, out of this pile
 * ```
 *
 * **A pure builder whose dependencies are an argument**, exactly as `cardMenu`'s and
 * `categoryMenu`'s are: every write arrives as a callback, so this file is testable with no
 * provider, no query client and no window. It has **no component in it at all** since
 * 2026-08-20, when "New label…" stopped being a text field inside the panel and became a row
 * that opens a dialog (`NewTagDialog` on the day; `AddLabelDialog` now) — the label rows are a
 * `MenuItem[]` built from `deps.labels`, which
 * `DeckEditor` already holds from `deck_get`, so the whole submenu is `submenu` rather than
 * `lazy` and nothing here mounts, queries or holds state.
 *
 * **Two rows are stricter than the rest of this menu, and the asymmetry is deliberate rather
 * than a drift.** `Move to ▸ Commander` is live for a card `Set as commander` greys two rows
 * above it, and both answers are right. `Move to` is *filing*: it is built from every category
 * the deck has and permits exactly what a drag onto the pile's heading permits, because the two
 * are one gesture with two input devices and a menu that refused what a drop allows would be the
 * odd one out. The zone rows are *claims* — "this card is the commander" — so they are fenced by
 * the rule the validation panel judges the built deck by. The cost is the one place a reader can
 * see this menu appear to contradict itself; the alternative costs either the keyboard's only
 * route into the command zone or a claim the panel then refuses, and both are worse.
 *
 * **Built once by `DeckEditor` and handed to the four views as one function.** A view that
 * assembled its own would be four copies of one rule, and the rule reads the deck's categories,
 * its format spec and its labels — three facts no view has.
 */
import {
  CircleMinus,
  Crown,
  FolderInput,
  Gem,
  HeartOff,
  LibraryBig,
  PackageOpen,
  Plus,
  Sparkles,
  Tag,
  UserRound,
} from "lucide-react";
import type { MenuAction, MenuItem } from "@/components/menu/types";
import { buildCardMenu, type CardMenuDeps, type CardMenuTarget } from "@/features/card/cardMenu";
import { plural } from "@/lib/counts";
import { FINISH_LABEL, parseFinishes } from "@/lib/finish";
import type { DeckCard, DeckCategory, DeckFinish, DeckLabel, FormatSpec } from "@/lib/ipc";
// **`./quickCollection`, and the name is load-bearing on Windows.** The plan called this module
// `quickAdd.ts`; `QuickAdd.tsx` — the toolbar's card field — already sits in this folder, and a
// case-insensitive file system resolves `./quickAdd` and `./QuickAdd` to whichever the resolver
// reaches first. This import took the toolbar component for one run and answered
// "quickAddShort is not a function"; tsc refuses the program outright (TS1149). It is
// `folderTree.ts` beside `FolderTree.tsx` a second time.
import { quickAddBlock, quickAddShort } from "./quickCollection";
import { commanderIneligibility } from "./validation/commanders";
import { companionIssues } from "./validation/companions";

/**
 * The card a right-click on a deck row is about, as `CardMenuTarget` describes it.
 *
 * A `DeckCard` carries every field, `typeLine` included — so a menu add made from here is filed
 * by what the card *does*, exactly as a drag of the same row is. Omitting the key would file it
 * under `Main deck` with no rule consulted, which is the arm `cardMenu.tsx` documents as the one
 * a surface with a type line must never take.
 */
export function deckCardTarget(card: DeckCard): CardMenuTarget {
  return {
    cardId: card.cardId,
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    oracleId: card.oracleId,
    finishes: card.finishes,
    typeLine: card.typeLine,
  };
}

/**
 * What a row says when the card is already in the pile it names.
 *
 * Two rows are greyed by it — the card's own category under `Move to`, and a zone row on the
 * card that fills it — and both are the same statement, so it is one string. Only the first
 * **draws** it, since 2026-08-17: a zone row greys wordlessly, for the reason on
 * {@link zoneItem}. Not a *refusal* in `validation/`'s sense: nothing is wrong with the card,
 * there is simply nothing for the press to write.
 */
const ALREADY_HERE = "already here";

/** Everything the deck's own rows need that is not the card. Built once per surface, never
 *  once per row. */
export interface DeckCardMenuDeps {
  /** The shared card menu's dependencies, whole — this file adds to that menu, it does not
   *  reimplement any of it. */
  card: CardMenuDeps;
  /**
   * **Every category the deck has, in `sortOrder`** — `DeckEditor`'s own array and never the
   * drawn groups. That array is deliberately unfiltered, and for an emptied `auto` pile it is
   * the only surface the pile appears on at all: no heading is drawn for one, so a drop target
   * for it does not exist and a drag cannot reach it. See {@link moveItem}.
   */
  categories: readonly DeckCategory[];
  /**
   * Every row of the deck, **unfiltered** — what the companion condition is judged against.
   * The toolbar's filter narrows what is *drawn*; whether a card may be your companion is a
   * question about the deck.
   */
  cards: readonly DeckCard[];
  /** The deck's format, or `null` — while `useFormatSpecs` is in flight, and for a deck whose
   *  key has left the seed. No format opinion, no commander and no companion row. */
  spec: FormatSpec | null;
  /** `useDeck.moveCard`, addressed by the row rather than by a slot: the caller knows which
   *  pile the card is leaving. */
  moveTo: (card: DeckCard, categoryId: number) => void;
  /** `useDeck.setLabel`. `null` takes the label off. */
  setLabel: (card: DeckCard, labelId: number | null) => void;
  /** `useDeck.setCardFinish`. `null` is the regular copy — see {@link finishItem}. */
  setFinish: (card: DeckCard, to: DeckFinish) => void;
  /** The labels **this list is wearing**, already in hand from `deck_get`, most-used first —
   *  the label rows are built from these rather than from a second `deck_label_list`, which is
   *  what lets the submenu be `submenu`
   *  rather than `lazy`. */
  labels: readonly DeckLabel[];
  /**
   * **"New label…"** — open the surface's `AddLabelDialog` on this card. It writes nothing
   * itself.
   *
   * This row used to be a text field inside the panel, and the field used to *be* the write:
   * `createLabel(card, name)`, in {@link DEFAULT_LABEL_COLOR}, because a menu has no room for a
   * colour picker. Both halves of that changed on 2026-08-20 — a label's colour is the reader's
   * own now (`labelColors.ts`) and picking gold silently for every label born from a menu would
   * make them all alike, so the row opens a dialog with a name and a colour in it.
   *
   * **The write is still the surface's, and the two reasons are unchanged.** It keeps this
   * file's purity contract — every write arrives as an argument, so the builder is testable with
   * no provider and no query client — and, the one that is a defect rather than a preference, a
   * `mutate`-scoped `onSuccess` belongs to the *observer*, and TanStack drops it when the
   * observer unmounts. A create started in a panel and chained to `setLabel` there loses its
   * second half to an Escape landing during the round trip: the label made and silently never
   * attached. The editor's observer outlives both the menu and the dialog.
   */
  addLabel: (card: DeckCard) => void;
  /**
   * **Remove card** — take this row out of the pile it is in.
   *
   * `useDeck.setQuantity(…, 0)` at the surface, which is the app's **only** removal write: the
   * remove tray's drop and the stepper's zero are already that call, and `useDeck` carries no
   * `remove` mutation because zero is what removes a deck row. So this row is a third caller of
   * one write rather than a second way to take a card out — nothing new can be refused, and the
   * refusal that can arrive is already in the editor's banner family.
   *
   * **On the Live list that write also gives the copies back**, into `Recently removed` — the
   * deck's group is where they physically sat. The row says `Remove card` rather than naming the
   * folder because the sentence that names it stands at the foot of the deck (`CUT_CARDS_NOTE`),
   * which is where it is true of all three ways to make this press instead of only this one.
   *
   * **No confirmation, deliberately, where the pile's `Clear stack…` has one.** One card is one
   * add to put back and the reader can see which one it was; a pile is a column they would have
   * to rebuild, and the two rows differ by exactly that.
   */
  remove: (card: DeckCard) => void;
  /**
   * **Quick add to collection** — record the copies this row is short of and file them in the
   * deck's own group, and write nothing to the wishlist (`deck_quick_add_to_collection` with no
   * wish named).
   *
   * **`copies` is the number the row's own label quoted**, handed over rather than re-derived at
   * the surface: `quickAddShort` is the one spelling of a shortfall this feature has, and a
   * second one is how a press comes to file a number the card is not wearing. See
   * {@link collectionItems}.
   *
   * **Optional, and absent takes the whole `Collection ▸` item with it** — `cardMenu.tsx`'s
   * `moveItem` rule, which drops its own item when the write it needs is missing rather than
   * drawing a picker that cannot file.
   */
  quickAdd?: (card: DeckCard, copies: number) => void;
  /**
   * **Quick add and remove from wishlist** — the same record, and then take the copies off a wish
   * that matches this exact printing and finish.
   *
   * The surface owns the read and the question: it fetches the matching wishes at the press,
   * files silently where there is one or none, and opens a picker where there are several. None
   * of that is this builder's, which stays pure and holds no query client — and the ambiguity is
   * genuinely the reader's to settle, not a rule a menu row could carry.
   *
   * Optional, on {@link quickAdd}'s terms.
   */
  quickAddAndUnwish?: (card: DeckCard, copies: number) => void;
  /**
   * **Pull from your collection** — move copies the reader already owns loose into this deck's
   * group, the per-card entrance to the write `deck_pull_from_collection` already answers for.
   *
   * **It takes no `copies`, and that asymmetry is the write's rather than an omission.** The two
   * rows above *create* cardboard, so the number is the whole of what they need; this one moves
   * cardboard that exists, so what it can take is decided by what the binder actually holds —
   * the surface reads the plan and either pulls the one candidate or opens
   * `PullFromCollectionDialog`, which is the prompt and which words the empty case itself.
   *
   * Optional, on {@link quickAdd}'s terms.
   */
  pullCard?: (card: DeckCard) => void;
  /**
   * **The whole picked set, when the right-clicked card is in it** — issue #214. Empty, absent, or
   * holding one card, and this menu is about the row that was right-clicked, exactly as it was
   * before multi-select existed.
   *
   * The *surface* decides membership rather than this builder, because the answer is
   * `dragsWholeSelection`'s rule for a press instead of a drag: a right-click on a card outside
   * the set is about that card, not about four others the reader had picked and forgotten. Passing
   * `[]` there is what says so, and it keeps this file free of any notion of a selection.
   *
   * **Three rows read it and three deliberately do not** — see {@link buildDeckCardMenu}.
   */
  picked?: readonly DeckCard[];
}

/**
 * The rows this press is about: the picked set, or the one card that was right-clicked.
 *
 * A set of one is the card, which is not merely equivalent but is what stops every label in the
 * menu growing a `1 card` that says less than the card's own name.
 */
function targets(card: DeckCard, deps: DeckCardMenuDeps): readonly DeckCard[] {
  const picked = deps.picked ?? [];
  return picked.length > 1 ? picked : [card];
}

/** `4 cards` — the plural half of every label below. Never reached for a set of one, which reads
 *  as the singular sentence it always did. */
function manyCards(n: number): string {
  return `${n} cards`;
}

/**
 * A deck card's menu.
 *
 * ## Which rows go plural, and which cannot
 *
 * `Move to`, `Label` and `Remove` act on **every** picked card when the right-clicked one is
 * in the set (issue #214). All three are per-row writes over an address the row already carries, so
 * plural is a loop and the label is the only thing that has to change.
 *
 * **`Finish`, `Set as commander` and `Set as companion` stay about the one card, and that is a
 * statement rather than an omission.** A finish is a property of a *printing* — the two-finish
 * toggle, the three-finish submenu and the greyed row are three different shapes decided by what
 * *this* printing is sold in, so a mixed set has no one shape to draw and a plural row would
 * silently skip whichever members could not take the finish it named. The two zone rows are
 * narrower still: a deck has one commander and one companion, so "set 4 cards as commander" names
 * a thing that cannot happen.
 *
 * **`Collection ▸`'s three rows stay singular for the same reason and one of its own** — see
 * {@link collectionItems}. Every label in it names a *count*, and that count is one row's
 * shortfall: four rows short by four different amounts have no one number to name, so a plural
 * row could only quote a total no card on screen is wearing.
 *
 * Everything above the first separator is `cardMenu.tsx`'s and is about the printing rather than
 * about this deck; it is singular for that reason and not for this one.
 */
export function buildDeckCardMenu(card: DeckCard, deps: DeckCardMenuDeps): MenuItem[] {
  const rows = targets(card, deps);
  const many = rows.length > 1;
  return [
    // **The set travels into the shared half too** — found by driving the shipped window
    // (2026-08-24): with two cards picked the deck's own rows read `Move 2 cards to` while
    // `Add to` directly above them stayed singular, which is one menu answering the same
    // question two ways. `buildCardMenu` decides for itself which of its rows a set can mean
    // anything to; what this has to do is hand the set over.
    ...buildCardMenu(deckCardTarget(card), { ...deps.card, picked: rows.map(deckCardTarget) }),
    // The rule is where "this card" stops and "this card in this deck" starts. Everything above
    // it is true of the same printing in a search wall; nothing below it means anything there.
    { kind: "separator", id: "sep-deck" },
    moveItem(card, deps),
    // **After `Move to` and in front of the zone rows**, because it is *filing* and `Move to` is
    // filing: both answer where a card's copies go. Everything below the zone line is a claim
    // about what the card **is** in this deck, which is a different question and is drawn as one.
    ...collectionItems(card, deps),
    ...zoneItems(card, deps),
    // Beside the zone rows rather than beside `Move to`: those say what this card *is* in the
    // deck, and so does this. `Move to` is filing.
    finishItem(card, deps),
    {
      kind: "submenu",
      id: "label-card",
      label: many ? `Label ${manyCards(rows.length)}` : "Label card",
      Icon: Tag,
      items: [
        ...deckCardLabelRows(card, deps.labels, (_card, labelId) => {
          for (const row of rows) deps.setLabel(row, labelId);
        }),
        // The line between putting a label on and making one. Above it every row is a press and
        // the card is labelled; below it the menu closes and a dialog opens, which is a
        // different kind of act and is drawn as one.
        { kind: "separator", id: "sep-new-label" },
        {
          kind: "action",
          id: "label-new",
          // **"More labels…" rather than "New label…", because there are more.** A label is one
          // app-wide row since schema v21, so the rows above this line are the labels *this list
          // is wearing* and every other label the reader owns is behind this one — along with
          // making a genuinely new one, which is what the row used to be for alone.
          label: "More labels…",
          Icon: Plus,
          onSelect: () => deps.addLabel(card),
        },
      ],
    },
    // A second rule, and it is the same kind of line as the first: everything above says where
    // this card goes or what it is called, and this one takes it out. A row that removes
    // cardboard does not sit flush against a row that renames it.
    { kind: "separator", id: "sep-remove" },
    {
      kind: "action",
      id: "remove-card",
      label: many ? `Remove ${manyCards(rows.length)}` : "Remove card",
      // `CircleMinus`, not `Trash2`: the trash can means "delete the thing itself" across these
      // menus — a deck, a folder, a pile — and this takes a card out of a pile that stays.
      Icon: CircleMinus,
      // **Still no confirmation, and the plural is where that is worth re-arguing.** One card is
      // one add to put back; four is four, and four presses of Ctrl+Z, because `deck_audit` has a
      // row per write. What keeps it unconfirmed is that the reader picked those four themselves,
      // one Ctrl-click at a time, and every one of them is wearing a gold ring while they read
      // this row — the pile's `Clear stack…` asks because a pile is a column nobody enumerated.
      onSelect: () => {
        for (const row of rows) deps.remove(row);
      },
    },
  ];
}

/**
 * **Move to**, and it is the replacement for the per-card `Move…` select removed on
 * 2026-08-14 rather than a duplicate of the drag.
 *
 * Two things that control could do and a drag cannot, both named at `cardControl.tsx`'s
 * `DeckCardControls` and both closed here: there is a **keyboard path** to moving a card again
 * (a caret cannot drag), and a pile with **no drawn heading** can be moved into (a heading that
 * is not drawn is not a drop target). The second is why this is built from the deck's
 * `categories` and never from the groups a view drew.
 *
 * **No `sortOptions`.** Deck categories are a documented exemption from this app's option-list
 * rule — an order the reader arranged themselves, in `CategoriesDialog` — and sorting them here
 * would list a reader's piles in one order on the desk and another in this menu, over the same
 * deck. Every exemption carries a comment at its own site saying which kind it is, and this is
 * that comment; `src/CLAUDE.md` states the test and deliberately keeps no list.
 *
 * The pile the card is **already in** is drawn and greyed rather than dropped. "Every category"
 * is what makes the list findable by position, and a row that wrote a move from a pile to itself
 * would be a press that means nothing — `aria-disabled`, so it stays in the tab order and stays
 * readable, which is what a greyed row in this app is for.
 */
function moveItem(card: DeckCard, deps: DeckCardMenuDeps): MenuItem {
  const rows = targets(card, deps);
  return {
    kind: "submenu",
    id: "move-to",
    label: rows.length > 1 ? `Move ${manyCards(rows.length)} to` : "Move to",
    Icon: FolderInput,
    items: deps.categories.map((category): MenuItem => {
      // **Greyed only when there is nothing left to move** — every picked card already in this
      // pile — which for a set of one is the rule this row has always had, spelled to cover the
      // plural. A set straddling two piles keeps the row live for both of them, and the loop
      // below passes over the members that are already home: `dropWrite` refuses a move from a
      // pile to itself for the same reason, so this is that rule at a second entrance rather
      // than a second rule.
      if (rows.every((row) => row.categoryId === category.id)) {
        return {
          kind: "action",
          id: `move-${category.id}`,
          label: category.name,
          disabled: true,
          reason: ALREADY_HERE,
          onSelect: () => {},
        };
      }
      return {
        kind: "action",
        id: `move-${category.id}`,
        label: category.name,
        onSelect: () => {
          for (const row of rows) {
            if (row.categoryId === category.id) continue;
            deps.moveTo(row, category.id);
          }
        },
      };
    }),
  };
}

/**
 * Why the three `Collection ▸` rows are greyed, in the words a menu row has room for.
 *
 * **A phrase and not a sentence**, `MenuAction.reason`'s own rule: a row is as wide as its widest
 * content, so one long reason sets the width of the whole panel. Each says the *fact* and neither
 * says the remedy — the remedy for a plan is the `Compare` button two controls away, and the
 * remedy for a card that is not short is that there is nothing to do.
 *
 * **Greyed _with_ a reason, where this file's other two refusals are silent, and the split is a
 * test rather than a drift.** {@link zoneItem} and {@link finishItem} grey on facts the reader can
 * check against the card in front of them — it is not a legendary creature, it is sold in one
 * finish — so the sentence would only repeat what the cardboard says. *A plan holds no cards* is a
 * rule about the **list the reader is standing in**, and nothing on the card says it; that is
 * `cardMenu.tsx`'s `Recently removed` case, where the reason is what turns a dead row into the one
 * place the rule is written down.
 *
 * A `Record` keyed by the block rather than a `switch` with a default, so an arm added to
 * `quickAddBlock`'s union is a red build here instead of a row greyed with `undefined`.
 */
const QUICK_ADD_REASON: Record<Exclude<ReturnType<typeof quickAddBlock>, null>, string> = {
  theory: "a plan holds no cards",
  // **A phrase about the pile, not about the card**, and it is the third of these sentences for
  // the same reason the first is: nothing on the cardboard says the column it sits in is switched
  // off, and a switched-off pile is handed nothing out of the deck's folder — so the `0` owned a
  // row in one wears is a fact about the pile. The arm was added after driving the shipped window
  // found the submenu offering `Quick add 1 copy` on a Maybeboard line whose number no press could
  // move; `quickCollection.ts` carries the measurement.
  inactive: "this pile is switched off",
  "nothing-missing": "nothing missing",
};

/**
 * **Collection ▸** — the three presses that answer a live row's shortfall, and the only place in
 * this menu that writes to the reader's binder rather than to their list (issue #350).
 *
 * ```
 * Collection                              ▸
 *     Quick add 4 copies
 *     Quick add 4 and remove from wishlist
 *     ─────────
 *     Pull 4 from your collection
 * ```
 *
 * **A submenu rather than three flat rows**, because this menu already carries thirteen and three
 * more on every card of the surface a reader spends the longest in is a menu that has to be read
 * instead of scanned. It sits under `Move to` because the two are the same kind of act — see the
 * comment at the call site.
 *
 * **All three stay singular about the right-clicked card even under a picked set**, and that is a
 * statement rather than an omission: {@link finishItem}'s argument reached from the other side.
 * Every label here names a **count**, and the count is one row's shortfall — a set of four rows
 * short by four different amounts has no one number to name, so a plural row could only quote a
 * total no card on screen is wearing, or file whichever member the label happened to be about.
 *
 * **That count is `quickAddShort`'s and is the same string in both states.** It is
 * `max(0, quantity − ownedQuantity)`, which is exactly the red `3/4` `CardStack` draws in the
 * card's chin, so the menu can never press for a number the card is not wearing — and it is
 * imported rather than spelled again here, a second spelling of a shortfall being precisely how
 * the two would come to disagree. A greyed row therefore reads `Quick add 0 copies` beside
 * `nothing missing`: the shortfall and its reason side by side, rather than a label that changes
 * shape with the state and a reason that has to agree with it.
 *
 * **The three rows grey and the parent stays live**, which is the whole of how the reason gets
 * read: a greyed submenu cannot be opened, so its rows' sentences would be written where nobody
 * can reach them. And greyed rather than hidden — every card of this surface can be short, so a
 * row that vanished on the cards that are not would read as a bug.
 */
function collectionItems(card: DeckCard, deps: DeckCardMenuDeps): MenuItem[] {
  const { quickAdd, quickAddAndUnwish, pullCard } = deps;
  // **All three or none, and an absence is the surface saying it wired no writes** — `moveItem`'s
  // rule in `cardMenu.tsx`, which drops its whole item rather than drawing a destination picker
  // that cannot file. The three travel together because they are three answers to one question —
  // how do the copies this row is short of get here — so a submenu offering two of them would
  // read as the third being *impossible* rather than merely unwired.
  if (quickAdd === undefined || quickAddAndUnwish === undefined || pullCard === undefined) {
    return [];
  }
  const copies = quickAddShort(card);
  const block = quickAddBlock(card);
  const reason = block === null ? undefined : QUICK_ADD_REASON[block];
  /** One row: live, or greyed **with** its reason — never greyed with a live `onSelect` behind
   *  it, which is what `aria-disabled` would leave pressable by a caret. */
  const row = (
    id: string,
    label: string,
    Icon: MenuAction["Icon"],
    press: () => void,
  ): MenuAction =>
    reason === undefined
      ? { kind: "action", id, label, Icon, onSelect: press }
      : { kind: "action", id, label, Icon, disabled: true, reason, onSelect: () => {} };

  return [
    {
      kind: "submenu",
      id: "deck-collection",
      // `Collection`, the same word and the same `LibraryBig` the card menu's own
      // `Add to ▸ Collection` wears one rule above: it is the reader's binder in both places, and
      // a second name for it here would read as a second thing.
      label: "Collection",
      Icon: LibraryBig,
      items: [
        row(
          "quick-add",
          // `plural` from `@/lib/counts`, which is where this feature already spells one —
          // `PullFromCollectionDialog` counts in `copy`/`copies` throughout, and the app must
          // never print "1 copies" on the count a reader meets most.
          `Quick add ${plural(copies, "copy", "copies")}`,
          Plus,
          () => quickAdd(card, copies),
        ),
        row(
          "quick-add-unwish",
          // No noun after the number, and the row is shorter for it — a menu row is as wide as
          // its widest content, and this is the widest row in the submenu either way.
          `Quick add ${copies} and remove from wishlist`,
          HeartOff,
          () => quickAddAndUnwish(card, copies),
        ),
        // The rule between *recording* cardboard and *moving* it. The two rows above say the
        // copies exist and file them into the deck's group; this one takes copies the reader
        // already owns loose and moves them — one of these presses changes what the binder holds
        // and the other only changes where it is, which is a different act and is drawn as one.
        { kind: "separator", id: "sep-pull" },
        row(
          "pull-from-collection",
          `Pull ${copies} from your collection`,
          PackageOpen,
          () => pullCard(card),
        ),
      ],
    },
  ];
}

/**
 * **Set as commander** and **Set as companion** — present only where the format has the zone,
 * greyed where the card cannot fill it. Greyed and **wordless**: {@link zoneItem} says why the
 * sentence these two used to carry is not drawn.
 *
 * The presence test is the format's (`requiresCommander` / `allowsCompanion`), so neither ever
 * appears in Standard or Modern; the eligibility test is `validation/`'s, so a card this menu
 * offers is a card the validation panel will accept. A looser rule here would offer a card the
 * panel then refuses, which is the one thing the deck surface must never do — the importer's
 * commander step is fenced by the same function for the same reason.
 *
 * A zone the deck has no category for is **absent** rather than greyed: the write is a
 * `moveCard` into that category, so with no category there is nothing to move into, and an item
 * that exists only to be refused is worse than one that is not there (`categoryMenu.tsx` drops
 * its two rows on the same argument).
 *
 * A card that is **already in** the zone is greyed too, for the reason its own pile is greyed
 * under `Move to`: the write would be a move from a category to itself. It is the one refusal
 * here that is not `validation/`'s, because it is not a question about the card — the reigning
 * commander is by definition an eligible one. `ALREADY_HERE` is what it is greyed *by* and no
 * longer what it is greyed *with*; only `Move to` still draws that string.
 */
function zoneItems(card: DeckCard, deps: DeckCardMenuDeps): MenuItem[] {
  const { spec } = deps;
  if (spec === null) return [];
  const items: MenuItem[] = [];

  const commander = deps.categories.find((c) => c.kind === "commander");
  if (spec.requiresCommander && spec.commanderRule !== null && commander !== undefined) {
    items.push(
      zoneItem(
        "set-commander",
        "Set as commander",
        Crown,
        card.categoryId === commander.id
          ? ALREADY_HERE
          : commanderIneligibility(card, spec.commanderRule, spec),
        () => deps.moveTo(card, commander.id),
      ),
    );
  }

  const companion = deps.categories.find((c) => c.kind === "companion");
  if (spec.allowsCompanion && companion !== undefined) {
    items.push(
      zoneItem(
        "set-companion",
        "Set as companion",
        UserRound,
        card.categoryId === companion.id ? ALREADY_HERE : companionRefusal(card, deps),
        () => deps.moveTo(card, companion.id),
      ),
    );
  }
  return items;
}

/**
 * Why this card cannot be the deck's companion, in the validation panel's own words, or `null`.
 *
 * **Judged as one copy, and against the deck with this row taken out** — which is the deck the
 * reader would have if they pressed the row. The row's removal matters because a companion is
 * not part of the starting deck its own condition is checked against. The copy count matters
 * because `companionIssues` also counts the zone: a four-of judged as itself would be refused
 * with "you have 4 companions", which is a reason the *deck* is wrong rather than a reason this
 * card cannot be a companion, and greying the row on it would tell the reader that Lutri is not
 * a companion.
 *
 * **The consequence is that a 4-of gets a live row whose press makes a deck the panel refuses**,
 * with `companion-count`, the moment the four copies land in the zone. That is the right place
 * for it — this menu answers "may this card be your companion" and the panel answers "is this
 * deck legal", and the second question is not one a row can ask before it is pressed. It is also
 * a state a reader reaches by every other route: dragging a 4-of onto the Companion pile does
 * exactly the same thing.
 *
 * Inactive categories are filtered out for `engine.ts`' reason: a switched-off pile counts
 * toward nothing, so a condition judged against one would be judged against cards that are not
 * in the deck.
 */
function companionRefusal(card: DeckCard, deps: DeckCardMenuDeps): string | null {
  if (deps.spec === null) return null;
  const deck = deps.cards.filter((row) => row.id !== card.id && row.categoryActive);
  const issues = companionIssues([{ ...card, quantity: 1 }], deck, deps.spec);
  return issues.find((issue) => issue.severity === "error")?.message ?? null;
}

/**
 * One zone row: live, or greyed — and **greyed silently**, which is this menu's one row that
 * refuses without saying why (changed 2026-08-17).
 *
 * It carried `refusal` through to `MenuAction.reason` and drew it beside the label. The
 * sentences are `validation/`'s, written to be read in the validation panel where a paragraph
 * has room — "not a legendary creature", "this card has no companion ability" — and a menu row
 * is sized by its widest content, so two of them set the width of *every* row in the panel. The
 * reader reported the card menu as unusably wide, and these two rows were the whole of it: the
 * card menu's own refusals are short, and `Move to`'s is `ALREADY_HERE`.
 *
 * **The refusal is still computed and is still what greys the row** — the rule underneath is
 * untouched, so a card this menu offers is still a card the validation panel will accept. What
 * is gone is only the drawing of it. Where a reader wants the sentence, the panel is where it
 * is written at full length.
 *
 * `disabled` becomes `aria-disabled` on the row and never the `disabled` attribute: a greyed
 * row stays in the tab order and stays announced.
 */
function zoneItem(
  id: string,
  label: string,
  Icon: MenuAction["Icon"],
  refusal: string | null,
  onSelect: () => void,
): MenuAction {
  if (refusal === null) return { kind: "action", id, label, Icon, onSelect };
  return { kind: "action", id, label, Icon, disabled: true, onSelect: () => {} };
}

/**
 * **Which object this row plays**, and the three shapes that question has.
 *
 * `cardMenu.tsx`'s `collectionItem` applied to a write rather than an add, and for its reason:
 * **a choice with one answer is not a choice.** Sold in two finishes — nonfoil and foil, which
 * is the overwhelming majority of printings — the row is a toggle and costs one press. Sold in
 * three, it is a submenu of the printing's own list. Sold in one, there is nothing to pick.
 *
 * **The greyed row says nothing**, which is {@link zoneItem}'s precedent rather than
 * `cardMenu.tsx`'s greyed-with-a-reason — and for the sharper half of that same argument. A
 * sentence on a row that greys on a large minority of the cards in a deck is noise on the
 * surface a reader uses most, and a menu row is sized by its widest content, so the sentence
 * would set the width of every row in the panel. The row stays **present** rather than dropping
 * out, which is `View all printings`' rule: a row that is on every other card of the surface
 * reads as a bug when it is missing from one, and its position must not move.
 *
 * The finishes are offered in the **printing's own order** — Scryfall's, which is what
 * `FINISHES` is written in — and deliberately not through `sortOptions`. The order *is* the
 * information (plain, then the premium treatments), which is one of the two exemptions
 * `src/CLAUDE.md` grants, and it is the same one the collection's finish picker takes.
 */
function finishItem(card: DeckCard, deps: DeckCardMenuDeps): MenuItem {
  const choices = finishChoices(card.finishes);
  const label = (f: DeckFinish) =>
    `Set as ${f === null ? REGULAR.toLowerCase() : FINISH_LABEL[f].toLowerCase()}`;
  /**
   * **The same two glyphs `FinishMark` draws**, because a menu row that names a finish is
   * naming the same finish the mark on the card is — issue #353. `Sparkles` is the app's one
   * foil icon and doubles as the finish control's own picture, which is what the regular row
   * and the submenu head get: nonfoil has no glyph of its own anywhere in the app, and foil is
   * the finish a reader opening this row came looking for.
   */
  const icon = (f: DeckFinish) => (f === "etched" ? Gem : Sparkles);

  // Nothing to pick. The label names foil rather than the finish the printing *is*, because
  // what the greyed row is saying is "this card has no other finish", and foil is the one a
  // reader came looking for.
  if (choices.length <= 1) {
    return {
      kind: "action",
      id: "finish",
      label: label("foil"),
      Icon: icon("foil"),
      disabled: true,
      onSelect: () => {},
    };
  }
  // Two finishes is exactly one *other* finish, so the row names it outright and the press is
  // the whole interaction — no submenu to open for a choice with one answer.
  if (choices.length === 2) {
    const other = choices.find((f) => f !== card.finish) ?? null;
    return {
      kind: "action",
      id: "finish",
      label: label(other),
      Icon: icon(other),
      onSelect: () => deps.setFinish(card, other),
    };
  }
  return {
    kind: "submenu",
    id: "finish",
    label: "Finish",
    Icon: Sparkles,
    items: choices.map((f) => ({
      kind: "action",
      id: `finish-${f ?? "regular"}`,
      label: f === null ? REGULAR : FINISH_LABEL[f],
      // The finish the row already is, greyed — and silently, like every other refusal in this
      // file. It is drawn rather than dropped so the list keeps its length and its positions.
      ...(f === card.finish
        ? { disabled: true, onSelect: () => {} }
        : { onSelect: () => deps.setFinish(card, f) }),
    })),
  };
}

/**
 * The finishes this printing can be **played** in, as this menu's values.
 *
 * `nonfoil` becomes `null`, which is the one spelling of the regular copy that reaches
 * `deck_cards.finish` — see `DeckFinish`. A printing whose `finishes` column is empty or
 * unreadable answers `[null]`, so the row greys: unknown is not a choice to offer.
 */
function finishChoices(finishes: string | null): DeckFinish[] {
  const listed = parseFinishes(finishes);
  if (listed.length === 0) return [null];
  return listed.map((f) => (f === "nonfoil" ? null : f));
}

/**
 * What the app calls a nonfoil copy **in the deck editor**, and it is deliberately not
 * `FINISH_LABEL.nonfoil`.
 *
 * "Set as nonfoil" is not a thing anybody says. The collection's picker is choosing between
 * three named finishes and `Nonfoil` is the right word there; here the reader is toggling one
 * card back off foil, and the opposite of foil is a regular card.
 */
const REGULAR = "Regular";

/**
 * The label choices, as rows.
 *
 * **Radios, and "None" first, because a deck card wears at most one label** — `setLabel` takes
 * `labelId: number | null`, and `deck_cards.label_id` is a single column. A checkbox list would
 * be a control promising something the model cannot store.
 *
 * **Only the labels this list is already wearing, and the backend's order is kept.** Both halves
 * changed with schema v21 and both are the issue's own request. `deck_get` answers the labels
 * *worn by cards in this deck and variant*, most-used first — so the row a reader reaches for
 * is near the top, and a menu no longer fills with every label they have ever made. The rest
 * are behind "More labels…".
 *
 * **This list is therefore not `sortOptions`'d, and that reverses a fix made on 2026-08-14.**
 * The reasoning then was sound and its premise is gone: `deck_get` answered
 * `ORDER BY t.name` over a `TEXT` column with no `COLLATE NOCASE`, which is byte order, so a
 * deck labelled `Cut`, `budget` and `Ramp` drew `Cut, Ramp, budget` and a reader looking for
 * "budget" under B found it below every capitalised label. An alphabet the reader could not
 * predict is worth replacing with one they can. But the order is not an alphabet any more: it
 * is **use**, which is the first of the two exemptions this app grants — an order that *is* the
 * information. Re-sorting it here would throw away the fact the backend went and counted.
 *
 * "None" is pinned in front rather than sorted in: it is the row that takes a label *off*, not
 * one of the labels — `Any card`'s and `Top level`'s arrangement.
 *
 * Exported so the rule above can be pinned without mounting a menu.
 */
export function deckCardLabelRows(
  card: DeckCard,
  labels: readonly DeckLabel[],
  setLabel: (card: DeckCard, labelId: number | null) => void,
): MenuItem[] {
  return [
    {
      kind: "radio",
      id: "label-none",
      label: "None",
      checked: card.labelId === null,
      onSelect: () => setLabel(card, null),
    },
    ...labels.map(
      (label): MenuItem => ({
        kind: "radio",
        id: `label-${label.id}`,
        label: label.name,
        checked: card.labelId === label.id,
        onSelect: () => setLabel(card, label.id),
      }),
    ),
  ];
}
