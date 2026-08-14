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
 * provider, no query client and no window. The one component in it is the tag body, which is
 * `MenuLazy.Content` and therefore mounted on an expand rather than on a right-click.
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
import { ipcError, type DeckCard, type DeckCategory, type DeckTag, type DeckVariant, type FormatSpec } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { FOCUS } from "./cardControl";
import { DEFAULT_TAG_COLOR } from "./tagColors";
import { useDeckMeta } from "./useDeckMeta";
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
  /** Which deck and which of its two lists the "New tag…" field writes into. */
  deckId: number;
  variant: DeckVariant;
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
          reason: "already here",
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
        commanderIneligibility(card, spec.commanderRule, spec),
        () => deps.moveTo(card, commander.id),
      ),
    );
  }

  const companion = deps.categories.find((c) => c.kind === "companion");
  if (spec.allowsCompanion && companion !== undefined) {
    items.push(
      zoneItem("set-companion", "Set as companion", UserRound, companionRefusal(card, deps), () =>
        deps.moveTo(card, companion.id),
      ),
    );
  }
  return items;
}

/**
 * Why this card cannot be the deck's companion, in the validation panel's own words, or `null`.
 *
 * **Judged as one copy, and against the deck with this row taken out** — which is the deck the
 * reader would have if they pressed the row. The copy count matters because `companionIssues`
 * also counts the zone, and a four-of moved there is a *deck* problem the panel will report
 * rather than a reason this card cannot be a companion; the row's removal matters because a
 * companion is not part of the starting deck its own condition is checked against.
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
 * **It writes the tag itself and hands the card off.** `useDeckMeta` is the single definition of
 * this app's tag CRUD, and it is mounted here rather than in the editor precisely because it is
 * three reads the editor should not pay for on every deck opened; behind a lazy row they are the
 * deliberate act `MenuLazy` exists for, and they land in the same `["decks"]`-rooted cache the
 * Tags dialog reads from. The *second* write — putting the new label on the card — is
 * `DeckEditor`'s `setTag`, which outlives this panel.
 *
 * **`onDone` is called on success and never before it**, which is the whole of what keeps the
 * chain alive: `ctx.run` closes the menu before a *row's* handler runs, so a body that closed
 * itself the moment it started an async write would unmount its own observer mid-flight and the
 * second half of the chain would never happen. A body that finishes without a row being pressed
 * is exactly what `onDone` is for.
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
  const meta = useDeckMeta(deps.deckId, deps.variant);
  const [name, setName] = useState("");
  const create = meta.createTag;
  const failure = create.isError ? ipcError(create.error) : null;

  return (
    <>
      <MenuRows items={deckCardTagRows(card, deps.tags, deps.setTag)} />
      <div role="separator" className="my-1 h-px bg-border" />
      {/* `role="group"`, because a `role="menu"` may own only menu rows, a `group` or a
          separator — and a field is none of those. The group is the honest wrapper: it names
          what is inside it and keeps the panel's own structure legal. */}
      <form
        role="group"
        aria-label="New tag"
        className="flex items-center gap-1 px-2 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed === "" || create.isPending) return;
          create.mutate(
            // The default colour, silently: recolouring a label is what `TagsDialog` is for,
            // and a colour picker inside a context menu would make the fast path the slow one.
            { name: trimmed, color: DEFAULT_TAG_COLOR.token },
            {
              onSuccess: (tag) => {
                deps.setTag(card, tag.id);
                onDone();
              },
            },
          );
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
        <button
          type="submit"
          disabled={create.isPending || name.trim() === ""}
          className={cn(
            "h-7 shrink-0 rounded-md border border-border px-2 text-xs text-dim",
            "transition-colors duration-150 hover:text-text disabled:opacity-50",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Add
        </button>
      </form>
      {failure && (
        // Said here rather than nowhere: this body is still mounted, because it only closes the
        // menu once the write has landed.
        <p role="alert" className="max-w-56 px-2 pb-1 text-[0.7rem] text-destructive">
          Could not add that tag — {failure}
        </p>
      )}
    </>
  );
}
