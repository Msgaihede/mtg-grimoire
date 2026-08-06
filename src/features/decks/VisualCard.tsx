import { useEffect, useRef, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import type { DeckCard, DeckZone } from "@/lib/ipc";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { cardDraggable } from "./dnd";

/**
 * Keyboard focus, in the shape the rest of the app uses: a gold outline standing off the
 * control's edge, never a ring (a ring means "state" everywhere else).
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * How tall the title plate is, as a **percentage of the card** — and therefore where the
 * card's own printed name ends.
 *
 * **Measured in the running window** (2026-08-06, a 231 × 323px card): the printed name sits
 * 22–30px from the card's top edge and its box ends by 34px, which is 10.5%. A plate shorter
 * than that leaves the printed name showing directly underneath it and every card in the
 * column is **named twice** — which is what the first draft did at a fixed 23px, and it looked
 * like a bug rather than a design. 12% covers the name box on the frames a deck is made of,
 * and it covers the printed cost in the same stroke, which is why the plate carries one.
 *
 * It cannot cover *every* treatment — a borderless Secret Lair prints its name where it likes —
 * and a plate sized for those would eat the illustration on the ordinary ones. So the rule is
 * the ordinary card, and the exotic one shows a sliver of its own lettering.
 *
 * **This number, and three class strings hand-derived from it.** Tailwind reads class names
 * out of this file as *text*, so `h-[12%]`, `top-[12%]` and the `calc()` under them are
 * written out rather than templated from here — a class assembled at runtime is a utility the
 * build never emits at all. The three co-vary with this number and with each other, and
 * `VisualCard.test.tsx`'s "derives the strip's geometry from the numbers it is documented by"
 * re-derives every one of them: a literal that drifts fails a test rather than shipping a
 * plate with the controls printed through it.
 */
export const PLATE = 12;

/** The plate itself. Hand-derived from {@link PLATE}; read that note before changing it. */
const PLATE_HEIGHT = "h-[12%]";

/**
 * Where the controls sit: directly under the plate, at the same {@link PLATE} percent — a
 * second class hand-derived from that one number.
 *
 * **Not at the foot of the card**, which is where they were drawn first and where the search
 * grid's tiles put theirs. A card is 323px tall and the zone scroller at a 1280 × 800 window
 * is ~270px, so a card's foot is below the fold more often than not — and the lift is *paint
 * order*, so hovering a card reveals it downwards without moving it into view. Measured in the
 * running window (2026-08-06): the stepper on a card whose title strip was visible could not
 * be reached without scrolling first. Under the plate they are always where the reader's
 * pointer already is — on the strip, which is the only part of a stacked card that is ever
 * visible.
 */
export const UNDER_PLATE = "top-[12%]";

/**
 * How tall that bar is, and therefore where the rest of a card's own words start.
 *
 * Fixed rather than measured so the two can be written down in one place: `h-9` is 2.25rem,
 * which is what `py-1` around a small stepper already came to. The reconciler's sentence on an
 * orphaned card sits under **both** — drawn at `top-[12%]` it was printed straight through the
 * stepper the moment the card was hovered, which is two sentences in one rectangle.
 *
 * So {@link UNDER_CONTROLS} is the third hand-derived class: {@link PLATE} percent plus this
 * bar's own height, written out for the reason {@link PLATE} gives, and re-derived by the same
 * test. The `2.25rem` in it **is** the `9` here — change one and the sentence lands on the
 * stepper again.
 */
const CONTROL_BAR = "h-9";
const UNDER_CONTROLS = "top-[calc(12%+2.25rem)]";

/**
 * How much of a card is left showing when the next one is stacked on top of it, as a fraction
 * of the card's height.
 *
 * The plate above takes 12% of that, so this is the plate plus a slice of the illustration —
 * which is what a fanned pile of real cards looks like, and is what gives a column of red
 * cards its colour rather than making it a text list drawn expensively.
 *
 * **0.19, tuned against the running window** rather than the 0.135 this was drafted at: 0.135
 * left 4% of art under the plate, which reads as a rendering seam. At 0.19 a 323px card shows
 * 61px — a 39px plate and 22px of art — and a 13-row main deck is ~1 000px of scroller, which
 * is under two screenfuls at the height this editor is read at.
 */
export const TITLE_BAND = 0.19;

/**
 * The pull that makes the stack, as a Tailwind class.
 *
 * **The arithmetic.** `Variant::Grid::dimensions()` in `images.rs` is **488 × 680** — the
 * printed card's proportions, 1.3934 high to wide. The frame here is the app-wide
 * {@link CARD_ASPECT} (5:7, 1.4) with `object-cover`, as every other frame in the app is: the
 * difference is a 3px crop off a 680px image and one aspect ratio across the app is worth more
 * than the third decimal. So a card is `1.4 × width` tall, the part of it that has to stay
 * visible is `TITLE_BAND` of that, and the overlap is the rest:
 *
 *     1.4 × (1 − 0.19) = 1.134 → margin-top: -113.4%
 *
 * A percentage margin resolves against the containing block's **width** (CSS 2.1 §8.3) — even
 * a vertical one — which is the whole reason this can be a class rather than a measured
 * number: the column is fluid, nothing here observes its width, and the overlap follows it
 * exactly at every size. Writing it as a fraction of the *height* is what does not work.
 *
 * The `113.4` is hand-derived from {@link TITLE_BAND} and {@link CARD_ASPECT} for
 * {@link PLATE}'s reason — Tailwind reads this file as text — and the same test does that
 * arithmetic again, so retuning the band without retyping this class fails rather than
 * quietly drawing a pile with the wrong bite out of it.
 */
export const STACK_OVERLAP = "-mt-[113.4%]";

/**
 * How wide a column of cards may get.
 *
 * A card has a size. The zone columns are laid out for text rows — the main deck asks for
 * `24rem` and takes two shares of whatever is spare — and a card that fills one of those is a
 * **poster**: measured in the running window at 1280 with the card pane closed, the main
 * column is 621px, which drew a 596×834px Lightning Bolt and turned a 44-card deck into six
 * screens of scrolling.
 *
 * 16rem is 256px, which after the column's border and padding is a **246px card** — a printed
 * Magic card is 63mm, or 238px at 96dpi, so the stack is life size and never much more. The
 * width above it goes to the editor's own background rather than to the card, which is what
 * lets all four zones sit side by side at 1280 instead of one of them owning a whole line.
 *
 * A cap, not a width: the narrow case is still the narrow case — with the card pane docked at
 * 1280 the deck side is 206px, the column 191px and the card **166px**, where the plate reads
 * `×4 Monastery S… {R} 0/4` and the name is the thing that gives way. This is the only place
 * either view constrains the layout the editor hands it.
 */
export const STACK_MAX_WIDTH = "max-w-[16rem]";

export interface VisualCardProps {
  card: DeckCard;
  /** Where this card is, for the drag payload — a move carries the zone it left. */
  zone: DeckZone;
  /** What that zone is called, for the stepper's accessible name. */
  zoneTitle: string;
  /** Not the first card of its group, so it is pulled up over the one before it. */
  stacked: boolean;
  menuOpen: boolean;
  /**
   * The row menu, built by the column and hung inside this card.
   *
   * A slot rather than a component this file imports: the menu lives in `ZoneColumn.tsx` with
   * the flip arithmetic it is measured by, and that file draws this one. It is a *direct*
   * child of the `<li>` because the menu positions itself against the row it belongs to and
   * measures `parentElement` to decide which way to open.
   */
  menu: ReactNode;
  onOpenMenu: (card: DeckCard, trigger: HTMLButtonElement) => void;
  onSetQuantity: (card: DeckCard, quantity: number) => void;
  onSelect: (cardId: string) => void;
}

/**
 * One card in a zone, drawn as the card.
 *
 * The whole front is one control — press it and the card opens in the pane, exactly as
 * pressing a row's name does — with the stepper and the actions menu on a bar that appears
 * when the pointer or the caret arrives, the search grid's `REVEAL_ON_HOVER` arrangement.
 * Every one of them carries `data-no-drag`, because the `<li>` around them is the drag handle
 * for the whole card and Chromium starts a drag from the nearest draggable ancestor of
 * whatever was pressed.
 *
 * **The title plate is not decoration.** It sits exactly where the card prints its own name
 * and cost, and it carries the same two things in the app's own type — because the printed
 * ones are ~9px tall in a 200px column, are set in a different face on every frame Magic has
 * ever used, and are not there at all when the image has not arrived. A stack of cards nobody
 * can read is not a deck list, and this view has to be both.
 */
export function VisualCard({
  card,
  zone,
  zoneTitle,
  stacked,
  menuOpen,
  menu,
  onOpenMenu,
  onSetQuantity,
  onSelect,
}: VisualCardProps) {
  const rowRef = useRef<HTMLLIElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A printing that has left the card database has no art anywhere — `cards` has no row for
  // it, so the protocol would answer a placeholder for a card nobody can look up. Nothing is
  // asked for, which is also what `useImageRetry` is told, so no schedule runs over it.
  const image = useImageRetry(
    card.needsReview === null ? cardImageUrl(card.cardId, 0, "grid") : null,
  );

  // The allocator never claims a copy for the scratchpad, so every `maybe` row reads 0 owned
  // by construction. A mark there would report a shortage the reader does not have.
  const short = zone !== "maybe" && card.ownedQuantity < card.quantity;

  // The card is the drag handle, exactly as the compact row is — the same registration, the
  // same payload, the same `<li>`, so the drag layer and its tests cannot tell the two views
  // apart. Re-registered only when the payload would change (`CardRow`'s note has the why).
  const { cardId, name } = card;
  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    return cardDraggable({
      element,
      payload: () => ({ kind: "deck-card", cardId, name, fromZone: zone }),
    });
  }, [cardId, name, zone]);

  return (
    <li
      ref={rowRef}
      className={cn(
        // `group` is what the controls bar is revealed by; `relative` is what the lift and
        // every overlay on this card hang from.
        "group relative",
        stacked && STACK_OVERLAP,
        // **The lift, and the whole of it.** A later sibling paints over an earlier one, which
        // is what makes the stack a stack — so raising this card's paint order is what brings
        // it out from under the cards below it, at full size, in the same instant, without
        // moving a pixel of the column. No transform and no transition: the motion budget is
        // chip and nav state, and sixty cards that grow as the pointer crosses them is a
        // column that moves while it is being read. An open menu keeps its card up, because
        // the menu is drawn inside it.
        "hover:z-10 focus-within:z-10",
        menuOpen && "z-10",
      )}
    >
      <button
        type="button"
        // The card *is* the control — one press, the card front, like the search grid's tile.
        // Named by the card and nothing else: sixty buttons called "×4 Lightning Bolt {R}" are
        // sixty names to listen past, and the visible name is inside the label, which is what
        // keeps voice control working. The count, the cost and the shortfall are on the plate,
        // which is a **sibling** of this button rather than a child — an `aria-label` here
        // prunes everything inside, so a plate drawn in here would be a plate nothing reads.
        // See the plate's own note.
        aria-label={card.name}
        onClick={() => onSelect(card.cardId)}
        className={cn(
          "relative block w-full overflow-hidden rounded-lg bg-surface text-left",
          // Not a real card any more, and the frame says so before the sentence under it is
          // read. Dashed rather than solid: solid gold or solid anything reads as *selected*.
          card.needsReview !== null && "border border-dashed border-destructive/40",
          FOCUS,
        )}
        style={{ aspectRatio: CARD_ASPECT }}
      >
        {image.src ? (
          <img
            // The name, not "card image": this is what a screen reader would announce if the
            // button were not labelled, and what the browser shows when a fetch fails.
            alt={card.name}
            src={image.src}
            loading="lazy"
            decoding="async"
            // An `<img>` is draggable by default and Chromium starts a drag from the *nearest*
            // draggable ancestor — so the art would drag itself and the card's own drag would
            // never begin (`CardGrid`'s lesson, and the `<li>` contract the drag layer needs).
            draggable={false}
            onError={image.onError}
            className="size-full object-cover"
          />
        ) : (
          // Nothing to draw. The name is on the plate above this, so the frame says only what
          // is *happening* — which is a different thing from a card with no name.
          <span className="flex size-full items-end justify-center pb-3 text-[0.7rem] text-dim">
            {card.needsReview !== null ? "" : image.retrying ? "Retrying…" : "No image"}
          </span>
        )}
      </button>

      {/* The title plate: the deck list, drawn on the card, in the place the card prints the
          same two facts.

          **A sibling of the card front, never a child of it — and that is an accessibility
          rule, not a layout one.** The front is a `button` with an `aria-label`, and ARIA
          prunes a button's descendants from the accessibility tree: a plate drawn inside it
          would take the cost's `sr-only` mana tokens and the "You own n of m" line out of the
          tree altogether, so this view would silently announce a bare card name where the
          compact row announces both — markup that claims to carry a fact and does not.
          Out here they are the listitem's own words again. The label stays the name and
          nothing else: sixty buttons called "×4 Lightning Bolt {R} 3/4" are sixty names to
          listen past, and the visible name is inside the label, which is what keeps voice
          control working. `pointer-events-none` is what keeps the front one press — the plate
          covers the top {@link PLATE}% of it and every click goes straight through, the same
          arrangement the reconciler's sentence below already uses. It costs the shortfall's
          native tooltip, which is why the sentence there is `sr-only` text rather than a
          `title` nothing can hover.

          **Opaque, not the gallery's `bg-bg/85`.** A corner chip sits on *art*, where 15% of
          what is under it is texture; this sits on the card's own **name**, and anything less
          than opaque ghosted the printed one straight through the plate covering it — every
          card in the column reading as its own name twice, in two typefaces, one of them
          half-erased. Measured at 3× in the running window (2026-08-06): visible at 85%,
          still legible at 95%. So the plate is the app's own felt, and what says it sits on a
          card is the slice of illustration under it rather than the card showing through it.
          The count leads, because a deck list line is "4 Lightning Bolt" and a stack of them
          puts every number in one column to read down. It is absent at one copy: a wall of
          "×1" down a Commander deck is 99 things to read past. */}
      <span
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1.5",
          "rounded-t-lg bg-bg",
          PLATE_HEIGHT,
          "px-1.5 text-xs leading-tight",
        )}
      >
        {card.quantity > 1 && (
          <span className="shrink-0 font-mono tabular-nums text-dim">×{card.quantity}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{card.name}</span>
        <ManaText source={card.manaCost} className="shrink-0" />
        {/* The one deck fact no picture carries, drawn only where it says something: the
            copies this deck reserved against the copies it wants. Sixty green ticks would be
            sixty things to read past on the way to the three that matter. */}
        {short && (
          <span className="shrink-0 font-mono tabular-nums text-dim">
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
        // A sentence, not a flag: the reconciler wrote what happened, and the card is listed
        // and counted exactly as before. Outside the button on purpose — inside, the button's
        // own label would hide it from everything that reads text rather than pixels.
        // `pointer-events-none` because the card underneath it is still the way into the card.
        <p
          title={card.needsReview}
          className={cn(
            "pointer-events-none absolute inset-x-0 line-clamp-4 px-2",
            UNDER_CONTROLS,
            "text-[0.7rem] leading-tight text-dim",
          )}
        >
          <span className="mr-1 font-medium text-destructive">Needs review:</span>
          {card.needsReview}
        </p>
      )}

      {/* The controls, on a bar directly under the plate ({@link UNDER_PLATE} says why there).
          Revealed on hover and on focus (`REVEAL_ON_HOVER`): a control that only a pointer can
          summon is a control half the readers of this app cannot press, and the caret arriving
          here lifts the card by the same `focus-within` that reveals the bar.
          `bg-bg/85` — the gallery's mark-on-a-photograph backing — because unlike the plate
          this one sits on *art*, where 15% of what is under it is texture rather than type.
          `data-no-drag` on the bar covers both of them — without it a press on `−` that travels
          five pixels drags the whole card, with the press never delivered (`cardDraggable`,
          measured in the running window before the guard existed). */}
      <span
        data-no-drag=""
        className={cn(
          "absolute inset-x-0 flex items-center justify-between gap-1",
          UNDER_PLATE,
          CONTROL_BAR,
          "bg-bg/85 px-1.5",
          REVEAL_ON_HOVER,
          menuOpen && "opacity-100",
        )}
      >
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
            "grid size-6 shrink-0 place-items-center rounded-md text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <MoreHorizontal className="size-3.5" aria-hidden="true" />
        </button>
      </span>

      {menu}
    </li>
  );
}
