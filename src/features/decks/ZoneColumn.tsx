import { useEffect, useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import { MoreHorizontal } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import type { DeckCard, DeckZone } from "@/lib/ipc";
import { usdPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";

/**
 * Keyboard focus, in the shape the rest of the app uses: a gold outline standing off the
 * control's edge, never a ring (a ring means "state" everywhere else).
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * What each zone is called on screen.
 *
 * The database's five values are terse enough to be ambiguous — `side` is a sideboard and
 * `maybe` is a scratchpad — so the words live in one place and every surface that names a
 * zone (the column heading, the move menu, a stepper's accessible name) reads them from it.
 */
export const ZONE_LABEL: Record<DeckZone, string> = {
  main: "Main deck",
  side: "Sideboard",
  commander: "Commander",
  companion: "Companion",
  maybe: "Maybe",
};

/** The two questions a deck list is read for: what does it *do*, and what does it *cost*. */
export type GroupBy = "type" | "manaValue";

/** One heading and the rows under it. */
export interface CardGroup {
  /** Stable across regroupings, so React keeps the rows rather than remounting them. */
  key: string;
  /** What the heading reads, and the accessible name of the list under it. */
  label: string;
  /** **Copies**, not rows: four Bolts are four cards, and a deck is counted in cards. */
  count: number;
  cards: DeckCard[];
}

/**
 * The eight card types, in the order they are printed on the type line, and the word each
 * bucket is named by.
 *
 * Order is the whole of the rule for a card with two types: an Artifact Creature is a
 * creature to everyone who has ever built a deck, and `Creature` comes first here. `Land` is
 * last of the eight for the same reason it is last in a decklist — it is where the counting
 * ends.
 */
const TYPE_BUCKETS = [
  "Creature",
  "Planeswalker",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Battle",
  "Land",
] as const;

/** Where a token, a scheme, or a row whose printing has left the card database goes. */
const OTHER = "Other";

/** How a row menu finds the box that would clip it. An attribute rather than a ref chain
 *  because the menu is three components away from the scroller and owns none of them. */
const SCROLLER_ATTR = "data-zone-scroller";

/**
 * Which way a row's menu opens — down from the row's top edge, or up from its bottom.
 *
 * Pure, because the thing it decides cannot be seen in jsdom: every rectangle there is zero,
 * so a component test of the flip would pass over any arithmetic at all. The column's
 * scroller clips (`overflow-y-auto` inside `overflow-hidden`) and there is nothing below it
 * to scroll to, so a menu opened on a row near the foot of a column is simply cut in half.
 *
 * Down wins ties: it is where the reader is looking, and flipping a menu that fits would move
 * it for nothing.
 */
export function shouldFlipUp({
  rowTop,
  rowBottom,
  menuHeight,
  viewTop,
  viewBottom,
}: {
  rowTop: number;
  rowBottom: number;
  menuHeight: number;
  viewTop: number;
  viewBottom: number;
}): boolean {
  const fitsBelow = rowTop + menuHeight <= viewBottom;
  const fitsAbove = rowBottom - menuHeight >= viewTop;
  // Neither fits — a menu taller than the column it is in — so it opens the way it reads.
  return !fitsBelow && fitsAbove;
}

/**
 * The bucket one card belongs to.
 *
 * The **front** face decides: `type_line` carries both sides of a double-faced card
 * separated by `//`, and the back of a modal DFC is routinely a land while its front is a
 * spell. A deck's curve is cast from the front.
 */
function typeBucket(typeLine: string | null): string {
  const front = (typeLine ?? "").split("//")[0];
  return TYPE_BUCKETS.find((t) => front.includes(t)) ?? OTHER;
}

/**
 * The mana-value bucket, in the filter chips' own bucketing: 0–7 exactly, 8 open-ended.
 *
 * `null` is *unknown* rather than zero. `cards.cmc` is nullable and an orphaned row has no
 * mana value at all — filing it under 0 would be a number this app made up, and it would sit
 * at the head of the curve where a reader counts their cheapest spells.
 */
function manaValueBucket(cmc: number | null): { key: string; label: string; order: number } {
  if (cmc === null) return { key: "mv-unknown", label: "Mana value unknown", order: 9 };
  const mv = Math.min(8, Math.max(0, Math.floor(cmc)));
  return {
    key: `mv-${mv}`,
    label: mv === 8 ? "Mana value 8 or more" : `Mana value ${mv}`,
    order: mv,
  };
}

/**
 * A zone's rows under headings — the pure half of this file, and the one Task 15's type
 * counts read rather than re-deriving.
 *
 * Input order is preserved inside every group: the backend answers a deck in zone priority,
 * then by name, and a heading is not a reason to re-sort what is under it. Empty buckets are
 * dropped rather than drawn — a deck with no planeswalkers has no planeswalker heading.
 */
export function groupCards(cards: readonly DeckCard[], groupBy: GroupBy): CardGroup[] {
  const order = new Map<string, number>();
  const groups = new Map<string, CardGroup>();

  for (const card of cards) {
    const bucket =
      groupBy === "type"
        ? (() => {
            const label = typeBucket(card.typeLine);
            const at = TYPE_BUCKETS.indexOf(label as (typeof TYPE_BUCKETS)[number]);
            return { key: label.toLowerCase(), label, order: at < 0 ? TYPE_BUCKETS.length : at };
          })()
        : manaValueBucket(card.cmc);

    const group = groups.get(bucket.key);
    if (group) {
      group.cards.push(card);
      group.count += card.quantity;
    } else {
      order.set(bucket.key, bucket.order);
      groups.set(bucket.key, {
        key: bucket.key,
        label: bucket.label,
        count: card.quantity,
        cards: [card],
      });
    }
  }

  return [...groups.values()].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

export interface ZoneColumnProps {
  zone: DeckZone;
  /** What the heading reads — {@link ZONE_LABEL}, passed in so the editor owns the wording. */
  title: string;
  cards: readonly DeckCard[];
  /** `null` draws a flat list: the commander and companion zones hold one or two cards, and a
   *  heading over a single row is a heading that says nothing. */
  groupBy: GroupBy | null;
  /** The zones a row here can be moved to, in the order the menu offers them. The editor
   *  derives it from the format's spec, so a Modern deck is never offered a commander zone. */
  moveTargets: readonly DeckZone[];
  /**
   * The card whose actions menu is open **in this zone**, or `null`.
   *
   * Owned by the editor rather than by the row, because `useDismissOnEscape` orders exactly
   * two rungs: two `"inner"` layers open at once are not ordered at all and would both close
   * on one press. One piece of state for the whole editor is what makes "never two"
   * structural instead of remembered — `DecksPage`'s `Panel`, for its reason.
   */
  openMenuCardId: string | null;
  /**
   * True while a write **the open menu started** is in flight — never while some other row's
   * stepper or a rename is, or one row's edit would grey out another's menu. Only the open
   * menu reads it: it disables its own controls and guards its own blur-away.
   */
  busy: boolean;
  onOpenMenu: (card: DeckCard, trigger: HTMLButtonElement) => void;
  /** Focus left the menu on its own: it closes, and the caret stays where the reader put it. */
  onCloseMenu: () => void;
  onSetQuantity: (card: DeckCard, quantity: number) => void;
  onMove: (card: DeckCard, to: DeckZone) => void;
  onSetCover: (card: DeckCard) => void;
  onSelect: (cardId: string) => void;
  className?: string;
  /** The editor hands the caret to a zone after a card lands in it — the row the menu was on
   *  has left, and an element that unmounts with focus on it drops it to `<body>`. */
  ref?: Ref<HTMLElement>;
}

/**
 * One zone of a deck: what is in it, how many that is, and every edit that can be made to a
 * row without leaving the page.
 *
 * There is no Save. Every control here writes through an IPC command and the list redraws
 * from what the database answered — which is what "autosave" honestly means for a deck: the
 * row *is* the draft.
 */
export function ZoneColumn({
  zone,
  title,
  cards,
  groupBy,
  moveTargets,
  openMenuCardId,
  busy,
  onOpenMenu,
  onCloseMenu,
  onSetQuantity,
  onMove,
  onSetCover,
  onSelect,
  className,
  ref,
}: ZoneColumnProps) {
  const copies = cards.reduce((n, c) => n + c.quantity, 0);
  const groups: CardGroup[] = groupBy
    ? groupCards(cards, groupBy)
    : [{ key: "all", label: "", count: copies, cards: [...cards] }];

  return (
    <section
      ref={ref}
      tabIndex={-1}
      // The count is in the name rather than only on screen: a reader arriving in this column
      // — from the caret being handed here after a move, or from a screen reader's region
      // list — is asking "which zone, and how big".
      aria-label={`${title}, ${copies} ${copies === 1 ? "card" : "cards"}`}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border",
        FOCUS,
        className,
      )}
    >
      <h3 className="flex shrink-0 items-baseline justify-between gap-2 border-b border-border bg-surface px-3 py-2 text-sm">
        <span className="min-w-0 truncate">{title}</span>
        <span className="font-mono text-xs tabular-nums text-dim">{copies}</span>
      </h3>

      {/* The zone's own scroller. Every column scrolls on its own so a 60-card main deck does
          not push the sideboard off the bottom of the window — and it is what a row menu
          measures itself against, since it is what would clip one. */}
      <div {...{ [SCROLLER_ATTR]: "" }} className="min-h-0 flex-1 overflow-y-auto p-1">
        {cards.length === 0 ? (
          <p className="px-2 py-3 text-xs text-dim">Nothing here yet.</p>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              {group.label && (
                // 12px, dim, and deliberately not Cinzel: the display face is for view titles
                // and section headers, and a bucket inside a column is neither.
                <p className="flex items-baseline justify-between gap-2 px-2 pb-0.5 pt-2 text-xs text-dim">
                  <span className="min-w-0 truncate">{group.label}</span>
                  <span className="font-mono tabular-nums">{group.count}</span>
                </p>
              )}
              <ul aria-label={group.label || undefined}>
                {group.cards.map((card) => (
                  <CardRow
                    key={card.id}
                    card={card}
                    zone={zone}
                    zoneTitle={title}
                    moveTargets={moveTargets}
                    menuOpen={openMenuCardId === card.cardId}
                    busy={busy}
                    onOpenMenu={onOpenMenu}
                    onCloseMenu={onCloseMenu}
                    onSetQuantity={onSetQuantity}
                    onMove={onMove}
                    onSetCover={onSetCover}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/**
 * One card in one zone.
 *
 * Two lines rather than a table row: the name in the reading face on top, and the printing's
 * own data — rarity, set, number, price, what the collection can cover — in the data face
 * underneath. A single line would either truncate the name to nothing in a 300px column or
 * force a horizontal scroller across the whole editor, and the direction's floor is 1024px
 * with no page-level horizontal scroll at all.
 */
function CardRow({
  card,
  zone,
  zoneTitle,
  moveTargets,
  menuOpen,
  busy,
  onOpenMenu,
  onCloseMenu,
  onSetQuantity,
  onMove,
  onSetCover,
  onSelect,
}: {
  card: DeckCard;
  zone: DeckZone;
  zoneTitle: string;
  moveTargets: readonly DeckZone[];
  menuOpen: boolean;
  busy: boolean;
  onOpenMenu: (card: DeckCard, trigger: HTMLButtonElement) => void;
  onCloseMenu: () => void;
  onSetQuantity: (card: DeckCard, quantity: number) => void;
  onMove: (card: DeckCard, to: DeckZone) => void;
  onSetCover: (card: DeckCard) => void;
  onSelect: (cardId: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLButtonElement>(null);
  // The allocator never claims a copy for the scratchpad, so every `maybe` row reads 0 owned
  // by construction. A mark there would report a shortage the reader does not have.
  const short = zone !== "maybe" && card.ownedQuantity < card.quantity;

  return (
    <li
      className={cn(
        "group relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2",
        "rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-surface",
        "motion-reduce:transition-none",
      )}
      // The mouse's way in. The keyboard's is the name button below — a `role="button"` on
      // this row would make every control inside it presentational, which is the one thing a
      // row full of controls cannot afford.
      //
      // The name button takes the caret on the way, and that is not a flourish: the pane
      // records whatever had focus when it opened and hands the caret back there on Escape,
      // and a click on the row's *background* focuses nothing at all — so without this, every
      // card opened by clicking a row is a card whose Escape drops the caret onto `<body>`
      // and whose next Tab restarts from the top of the app. Measured in the running window.
      onClick={() => {
        nameRef.current?.focus();
        onSelect(card.cardId);
      }}
    >
      {/* The stepper writes straight through: a deck editor is where quantities are
          *maintained*, and making the reader open a card to change a 3 to a 4 is the
          difference between a tool and a form. The row's click opens the card, so the
          stepper's clicks stop here.
          **Clicks only.** The collection table stops `keydown` here as well, because its rows
          answer Enter and Space themselves; these do not — the name button is the keyboard's
          way into the card — and stopping keys is not free: React's synthetic
          `stopPropagation` stops the *native* event at the root container, so an Escape
          pressed with the caret in this stepper never reaches the card pane's `window`
          listener and the pane cannot be closed from here at all. Measured in the running
          app; pinned by `the editor lets Escape through to the card pane`. */}
      <span className="row-span-2" onClick={(e) => e.stopPropagation()}>
        <QuantityStepper
          size="sm"
          value={card.quantity}
          min={0}
          // Named for the card *and* the zone: the same printing can sit in the main deck and
          // the sideboard, and two steppers called "Copies of Lightning Bolt" would be two
          // controls a screen reader cannot tell apart.
          label={`Copies of ${card.name} in ${zoneTitle}`}
          onChange={(next) => onSetQuantity(card, next)}
        />
      </span>

      <span className="flex min-w-0 items-baseline gap-1.5">
        <button
          ref={nameRef}
          type="button"
          // Opening the card is the row's job and this is the row's keyboard handle. The click
          // bubbles to the row, which does the same thing — one destination, two ways in.
          className={cn("min-w-0 truncate text-left text-sm", FOCUS)}
        >
          {card.name}
        </button>
        <ManaText source={card.manaCost} className="shrink-0 text-xs" />
      </span>

      {/* Clicks only, for the reason the stepper's cell gives: the menu's own Escape is the
          editor's `"inner"` layer and travels by `window`. */}
      <span className="justify-self-end" onClick={(e) => e.stopPropagation()}>
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={menuOpen}
          aria-haspopup="dialog"
          aria-label={`More actions for ${card.name}`}
          onClick={() => {
            if (triggerRef.current) onOpenMenu(card, triggerRef.current);
          }}
          className={cn(
            "grid size-6 place-items-center rounded-md text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            REVEAL_ON_HOVER,
            menuOpen && "opacity-100",
            FOCUS,
          )}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </span>

      {/* The data line. Everything on it is a fact about the printing rather than about the
          deck, which is why it is set in the data face and one step dimmer. */}
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[0.7rem] text-dim">
        <RarityGem rarity={card.rarity} />
        <span className="truncate">
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
        {/* Per copy, from the row's own `usd` — never a total, which is Task 15's arithmetic
            and belongs beside the deck rather than on every line of it. */}
        <span className="shrink-0 tabular-nums">{usdPrice(card.unitPriceUsd)}</span>
      </span>

      {/* Drawn only where it says something: the copies this deck reserved against the copies
          it wants. A fully covered row prints nothing at all — sixty green ticks are sixty
          things to read past on the way to the three that matter. */}
      <span className="justify-self-end font-mono text-[0.7rem] tabular-nums text-dim">
        {short && (
          <span title={`You own ${card.ownedQuantity} of the ${card.quantity} this deck wants`}>
            <span aria-hidden="true">
              {card.ownedQuantity}/{card.quantity}
            </span>
            <span className="sr-only">
              You own {card.ownedQuantity} of {card.quantity}
            </span>
          </span>
        )}
      </span>

      {card.needsReview && (
        // A sentence, not a flag: the reconciler wrote what happened, and the row is listed
        // and counted exactly as before. Truncated on screen with the whole of it one hover
        // away — the second half is what to do about it — and read in full by anything that
        // reads text rather than pixels.
        <p
          title={card.needsReview}
          className="col-span-3 truncate pt-0.5 text-[0.7rem] leading-tight text-dim"
        >
          <span className="mr-1 font-medium text-destructive">Needs review:</span>
          {card.needsReview}
        </p>
      )}

      {menuOpen && (
        <RowMenu
          card={card}
          zone={zone}
          moveTargets={moveTargets}
          busy={busy}
          triggerRef={triggerRef}
          onClose={onCloseMenu}
          onMove={onMove}
          onSetCover={onSetCover}
        />
      )}
    </li>
  );
}

/**
 * What a row can do besides change its number: go somewhere else, or become the deck's face.
 *
 * Anchored to the row rather than portalled — the shipped CSP is `style-src 'self'` and every
 * overlay primitive in reach injects a runtime `<style>` the moment it opens (`SetCombobox`'s
 * decision, for its reason). Not `aria-modal` either: the editor behind it stays live.
 */
function RowMenu({
  card,
  zone,
  moveTargets,
  busy,
  triggerRef,
  onClose,
  onMove,
  onSetCover,
}: {
  card: DeckCard;
  zone: DeckZone;
  moveTargets: readonly DeckZone[];
  busy: boolean;
  /** The control that opened this. Pressing it again is a *toggle*, not a click away. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onMove: (card: DeckCard, to: DeckZone) => void;
  onSetCover: (card: DeckCard) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  const measured = useRef(false);

  // Which way it opens, decided against the column's own scroller — the one that clips it.
  // `useLayoutEffect`, so a menu on the last row is never painted hanging out of the column
  // before it flips, and **before** the focus below: focusing an element inside a scroller
  // makes the browser scroll it into view, which is the very measurement being taken.
  //
  // Measured once and once only, and the ref is what makes that true in development: React's
  // StrictMode mounts, runs the effects, unmounts and runs them *again* on the same instance —
  // so the second pass re-measured a menu the first pass's focus had already scrolled into
  // view, found it fitting, and unflipped it. Two hours of the running window said so; the
  // guard is one line and the note is the rest of it.
  useLayoutEffect(() => {
    if (measured.current) return;
    const panel = panelRef.current;
    const row = panel?.parentElement;
    const view = panel?.closest(`[${SCROLLER_ATTR}]`);
    if (!panel || !row || !view) return;
    measured.current = true;
    const r = row.getBoundingClientRect();
    const v = view.getBoundingClientRect();
    setFlip(
      shouldFlipUp({
        rowTop: r.top,
        rowBottom: r.bottom,
        menuHeight: panel.offsetHeight,
        viewTop: v.top,
        viewBottom: v.bottom,
      }),
    );
  }, []);

  // The caret moves into the layer, as it does for every other one in the app: the panel's
  // own controls are then the next thing Tab reaches, and Escape has something to hand back.
  //
  // `preventScroll`, because the flip above has already made the menu visible and the browser
  // would otherwise do it a second way: focusing an element inside a scroller scrolls it into
  // view, which — measured in the running window — dragged the list 75px under the reader's
  // eyes to reveal a menu that was about to be flipped out of the way anyway.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Actions for ${card.name}`}
      className={cn(
        "absolute right-1 z-20 w-44 rounded-lg border border-border bg-bg/95 p-1",
        "text-xs shadow-lg",
        // Anchored to the row's top edge normally, and to its bottom edge on the rows near
        // the foot of the column — where opening downwards would put half the menu past the
        // scroller's edge, with nothing to scroll it back into view.
        flip ? "bottom-1" : "top-1",
        FOCUS,
      )}
      // Anchored to the row, so a press in here is a press on the row unless it is stopped —
      // and "move to the sideboard" is not a request to open the card. It would also steal the
      // caret out of this menu on the way (the row takes focus when it opens a card), which is
      // the blur that closes a layer mid-write.
      onClick={(e) => e.stopPropagation()}
      // Clicking or tabbing away closes it, and does it without a window listener that could
      // fight the Escape handshake (`AddToCollection`'s arrangement). `onClose`, not a
      // hand-back: the reader is already somewhere else.
      //
      // **Not while a write is in flight.** Every control below disables itself on the press,
      // a browser blurs a disabled control with no `relatedTarget` at all, and this handler
      // would read that as the reader leaving — taking the menu down *as if the write had
      // worked*, before the answer arrives. Task 11's binding pattern; pinned by the
      // `focusOut(…, { relatedTarget: null })` tests in both suites.
      //
      // And **not to the trigger**, which is how the trigger stays a toggle: a press on it
      // blurs this panel first, so closing here would take the menu down and the press would
      // then open it again — a control that can only ever open. `NewDeck`'s boundary is the
      // whole control for the same reason; this one names the exception instead, because the
      // panel is positioned against the row rather than against the button.
      onBlur={(e) => {
        if (busy) return;
        if (e.relatedTarget === triggerRef.current) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p className="px-2 py-1 text-dim">Move to</p>
      {moveTargets
        .filter((to) => to !== zone)
        .map((to) => (
          <button
            key={to}
            type="button"
            disabled={busy}
            onClick={() => onMove(card, to)}
            className={cn(
              "block w-full rounded-md px-2 py-1 text-left",
              "transition-colors duration-150 hover:bg-surface disabled:opacity-50",
              "motion-reduce:transition-none",
              FOCUS,
            )}
          >
            Move to {ZONE_LABEL[to]}
          </button>
        ))}
      {/* A cover is art, and an orphan has none — `cards` has no row for this printing, so the
          gallery would draw an empty frame with no illustrator to credit (Task 11's ruling).
          Not offered rather than offered and refused. */}
      {card.needsReview === null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onSetCover(card)}
          className={cn(
            "mt-1 block w-full rounded-md border-t border-border px-2 pb-1 pt-2 text-left",
            "transition-colors duration-150 hover:bg-surface disabled:opacity-50",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Set as cover
        </button>
      )}
    </div>
  );
}
