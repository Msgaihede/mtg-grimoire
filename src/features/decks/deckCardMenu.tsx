/**
 * What a card offers on a right-click **inside the deck editor** — the card menu every other
 * surface draws, plus the four things that only mean something about a card that is in a deck.
 *
 * ```
 * … the ten-surface card menu …
 * ─────────────────────
 * Move to              ▸  every category of the deck, in the reader's own order
 * Set as commander        (only where the format has a command zone)
 * Set as companion        (only where the format has a slot for one)
 * Tag card             ▸  None / the deck's tags / New tag…
 * ```
 *
 * **A pure builder whose dependencies are an argument**, exactly as `cardMenu`'s and
 * `categoryMenu`'s are: every write arrives as a callback, so this file is testable with no
 * provider, no query client and no window — the one component in it, the tag body, holds that
 * contract too and is `MenuLazy.Content`, mounted on an expand rather than on a right-click.
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
 * its format spec and its tags — three facts no view has.
 */
import { useState } from "react";
import { Crown, FolderInput, Tag, UserRound } from "lucide-react";
import { MenuRows } from "@/components/menu/ContextMenu";
import type { MenuAction, MenuItem } from "@/components/menu/types";
import { buildCardMenu, type CardMenuDeps, type CardMenuTarget } from "@/features/card/cardMenu";
import type { DeckCard, DeckCategory, DeckTag, FormatSpec } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
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
 * Two rows can carry it — the card's own category under `Move to`, and a zone row on the card
 * that fills it — and both are the same statement, so it is one string. Not a *refusal* in
 * `validation/`'s sense: nothing is wrong with the card, there is simply nothing for the press
 * to write.
 */
const ALREADY_HERE = "already here";

/** Everything the deck's own rows need that is not the card. Built once per surface, never
 *  once per row. */
export interface DeckCardMenuDeps {
  /** The ten-surface menu's dependencies, whole — this file adds to that menu, it does not
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
  /** `useDeck.setTag`. `null` takes the label off. */
  setTag: (card: DeckCard, tagId: number | null) => void;
  /** The deck's labels, already in hand from `deck_get` — the tag body draws these rather than
   *  reading `deck_tag_list` a second time. */
  tags: readonly DeckTag[];
  /**
   * "New tag…" — make a label with `DEFAULT_TAG_COLOR` and put it on this card, as **one write
   * the surface owns**.
   *
   * A callback rather than a hook mounted in the body below, and it is two decisions at once.
   *
   * **It keeps this file's purity contract**: every write arrives as an argument, so the builder
   * *and* its one component are testable with no provider and no query client. The body used to
   * mount `useDeckMeta` itself, which is **four** reads — the categories as a priced aggregate,
   * the tags of both lists, and the global suggestion palette — fired to draw a text field the
   * reader may never type in. The editor mounts that hook now, for the *category* menu, and
   * hands the one write down; four reads inside opening a deck are a different price from four
   * inside expanding a submenu.
   *
   * **And it is what keeps the write alive.** A `mutate`-scoped `onSuccess` belongs to the
   * *observer*, and TanStack drops it when the observer unmounts — so a create started here and
   * chained to `setTag` in the body would lose its second half to an Escape or an outside press
   * landing during the round trip: the label made and silently never attached. The surface's
   * observer outlives the panel, so the chain does not depend on this component surviving its
   * own press. It is `cardMenu.tsx`'s split, for `cardMenu.tsx`'s reason.
   *
   * Fire and forget: a refusal is the surface's to draw, because by the time one arrives there
   * is no menu left to draw it in.
   */
  createTag: (card: DeckCard, name: string) => void;
}

export function buildDeckCardMenu(card: DeckCard, deps: DeckCardMenuDeps): MenuItem[] {
  /** The tag body, closed over the card. Named rather than inline so its identity is stable for
   *  the life of the built array — `cardMenu.tsx`'s `DeckPicker` does the same, for the same
   *  reason: a fresh component type on every render remounts the body and loses what is typed
   *  in it. */
  function TagBody({ onDone }: { onDone: () => void }) {
    return <DeckCardTags card={card} deps={deps} onDone={onDone} />;
  }

  return [
    ...buildCardMenu(deckCardTarget(card), deps.card),
    // The rule is where "this card" stops and "this card in this deck" starts. Everything above
    // it is true of the same printing in a search wall; nothing below it means anything there.
    { kind: "separator", id: "sep-deck" },
    moveItem(card, deps),
    ...zoneItems(card, deps),
    { kind: "lazy", id: "tag-card", label: "Tag card", Icon: Tag, Content: TagBody },
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
 * **No `sortOptions`.** Deck categories are one of exactly two documented exemptions from this
 * app's option-list rule — an order the reader arranged themselves, in `CategoriesDialog` — and
 * sorting them here would list a reader's piles in one order on the desk and another in this
 * menu, over the same deck. The other exemption is a grade scale; both carry a comment at the
 * site, and this is that comment.
 *
 * The pile the card is **already in** is drawn and greyed rather than dropped. "Every category"
 * is what makes the list findable by position, and a row that wrote a move from a pile to itself
 * would be a press that means nothing — `aria-disabled`, so it stays in the tab order and stays
 * readable, which is what a greyed row in this app is for.
 */
function moveItem(card: DeckCard, deps: DeckCardMenuDeps): MenuItem {
  return {
    kind: "submenu",
    id: "move-to",
    label: "Move to",
    Icon: FolderInput,
    items: deps.categories.map((category): MenuItem => {
      if (category.id === card.categoryId) {
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
        onSelect: () => deps.moveTo(card, category.id),
      };
    }),
  };
}

/**
 * **Set as commander** and **Set as companion** — present only where the format has the zone,
 * greyed with a reason where the card cannot fill it.
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
 * A card that is **already in** the zone is greyed with `ALREADY_HERE`, exactly as its own pile
 * is under `Move to`, and for the same reason: the write would be a move from a category to
 * itself. It is the one refusal here that is not `validation/`'s, because it is not a question
 * about the card — the reigning commander is by definition an eligible one.
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

/** One zone row: live, or greyed carrying the sentence that says why. */
function zoneItem(
  id: string,
  label: string,
  Icon: MenuAction["Icon"],
  refusal: string | null,
  onSelect: () => void,
): MenuAction {
  if (refusal === null) return { kind: "action", id, label, Icon, onSelect };
  // `disabled` here becomes `aria-disabled` on the row and never the `disabled` attribute —
  // the greyed row exists to be read, so it has to stay in the tab order.
  return { kind: "action", id, label, Icon, disabled: true, reason: refusal, onSelect: () => {} };
}

/**
 * The tag choices, as rows.
 *
 * **Radios, and "None" first, because a deck card wears at most one tag** — `setTag` takes
 * `tagId: number | null`, and `deck_cards.tag_id` is a single column. A checkbox list would be
 * a control promising something the model cannot store.
 *
 * The deck's own order, which `deck_get` answers alphabetically; no `sortOptions` call, because
 * the list arrives sorted and re-sorting it here would be a second opinion about one list.
 * Exported so the rule above can be pinned without mounting a menu.
 */
export function deckCardTagRows(
  card: DeckCard,
  tags: readonly DeckTag[],
  setTag: (card: DeckCard, tagId: number | null) => void,
): MenuItem[] {
  return [
    {
      kind: "radio",
      id: "tag-none",
      label: "None",
      checked: card.tagId === null,
      onSelect: () => setTag(card, null),
    },
    ...tags.map(
      (tag): MenuItem => ({
        kind: "radio",
        id: `tag-${tag.id}`,
        label: tag.name,
        checked: card.tagId === tag.id,
        onSelect: () => setTag(card, tag.id),
      }),
    ),
  ];
}

/**
 * The body behind **Tag card**: the deck's labels as radios, and a field for a new one.
 *
 * **`lazy` rather than `submenu`, and the field is why.** The rows themselves are free —
 * `DeckEditor` already holds `deck.tags` from `deck_get` — but a `MenuItem[]` cannot carry a
 * text field, and "New tag…" is an inline field by design: a reader who has just decided a card
 * is a cut candidate should not have to open a dialog to say so. The mount is the expand, so
 * nothing here runs on a right-click.
 *
 * **It writes nothing itself, and that is not tidiness.** `deps.createTag` is the surface's, for
 * two reasons stated in full on that field: this component keeps the file's no-provider,
 * no-query-client contract, and — the one that is a defect rather than a preference — a write
 * started *here* and chained here would lose its second half to an Escape or an outside press
 * arriving during the round trip, because a `mutate`-scoped callback belongs to an observer this
 * body takes with it when it goes. The label would be created and silently never attached.
 *
 * So `onDone` is called **immediately**, on the press, where it used to wait for a round trip.
 * The wait was the workaround for owning the write; with the write owned by the editor there is
 * nothing left here to keep alive, and a menu that lingered after the reader had committed would
 * be a menu waiting on a network for no reason. A refusal lands in the editor's banner, which is
 * where every other refused deck write already speaks.
 */
function DeckCardTags({
  card,
  deps,
  onDone,
}: {
  card: DeckCard;
  deps: DeckCardMenuDeps;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const ready = name.trim() !== "";

  return (
    <>
      <MenuRows items={deckCardTagRows(card, deps.tags, deps.setTag)} />
      <div role="separator" className="my-1 h-px bg-border" />
      {/* `role="none"`, because a `role="menu"` may own only menu rows, a `group` or a
          separator — and a form is none of those. `Submenu`'s own box takes the same role for
          the same reason: presentational is what makes a wrapper legal here without inventing a
          second name for the field inside it, which is what a named `group` would be. */}
      <form
        role="none"
        className="flex items-center gap-1 px-2 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed === "") return;
          // The colour is `DEFAULT_TAG_COLOR`'s and is chosen by the write, not asked for here:
          // recolouring a label is what `TagsDialog` is for, and a colour picker inside a
          // context menu would make the fast path the slow one.
          deps.createTag(card, trimmed);
          onDone();
        }}
      >
        <input
          aria-label="New tag"
          placeholder="New tag…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(
            "h-7 w-36 rounded-md border border-border bg-bg px-1.5 text-xs text-text",
            FOCUS,
          )}
        />
        {/* `aria-disabled` rather than `disabled`, this file's rule everywhere else and the
            app's: an empty field is a state the reader types out of, and a control that leaves
            the tab order while they are deciding is one they cannot get back to. */}
        <button
          type="submit"
          aria-disabled={ready ? undefined : true}
          className={cn(
            "h-7 shrink-0 rounded-md border border-border px-2 text-xs",
            "transition-colors duration-150 motion-reduce:transition-none",
            ready ? "text-dim hover:text-text" : "text-dim opacity-50",
            FOCUS,
          )}
        >
          Add
        </button>
      </form>
    </>
  );
}
