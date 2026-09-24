/**
 * One reprinted printing, drawn large, and the watched decks that hold the card — what a press on
 * a New printings row opens (issue #514).
 *
 * ## A centred modal, and why it stopped being a popover
 *
 * It was an `AnchoredPopup` of the decks alone, 248px wide, anchored inside the row. That panel is
 * `absolute` and the row is inside the widget body's scroller — `overflow-x-hidden`,
 * `overflow-y-auto` — so the scroller clipped it on exactly the cards a reader is most likely to
 * have: a 2 × 2 tile has 204px of body across, and a panel wider than its card is cut down the
 * left. A large card image is the one thing that could not survive that clip, so the surface moved
 * to `src/CLAUDE.md`'s answer for a surface that is *consulted*: `components/Dialog`, over a scrim.
 * `StickyNoteDialog` is the precedent for mounting one from a widget body, and its header states
 * the condition this relies on too — **the home page has no containment**, so a `fixed` scrim
 * drawn inside a widget is drawn against the window.
 *
 * ## It looks like the card modal because it is the card modal's parts
 *
 * The reader asked for the preview to look like the card details popup, and the way to make two
 * surfaces look alike without them drifting apart is for them to be one drawing. So the heading is
 * `CardModalTitle` (name, type line, mana cost), the left column is **`CardModalArt` itself** — the
 * bordered frame, the chin naming the printing, the flip and foil controls and one price cell per
 * finish — and the right column's rows are `CardModalRail`'s `RAIL_ENTRY` boxes. The column is
 * `18.75rem`, the card modal's own at its two-column rung, and the fold is the same
 * `@container/card` measurement, which is why `container` is passed.
 *
 * **The card is read with `cardDetailKey`**, the entry the card modal and its four overlays share —
 * so pressing *Open card details* paints the modal from the cache this dialog already filled, and
 * a reader who has just closed that modal opens this one without a round trip either.
 *
 * ## What it hands the art column, and what it does not
 *
 * `CardModalArt` is presentational and every write is a callback, so the host decides what each
 * one means here. **The foil toggle is a view and nothing more**: there is no deck row behind this
 * dialog, so `deckRow` is `null` and the column's own label says *View as foil* rather than *Set
 * as foil*. **Meld is empty**: a meld card's counterparts are a second query and a third piece of
 * state for a rare layout, and the card modal — one press away — draws them. The set's name keeps
 * its meaning (`showSetInSearch`), which is a navigation, so the home page and this dialog go with
 * it.
 *
 * **No artist credit line**, where the card modal draws one: that modal's credit exists because it
 * also shows art *crops* elsewhere in the panel and follows a meld view onto another illustrator.
 * This dialog shows a full printed card and only that, which carries its own credit —
 * `src/CLAUDE.md`'s image rule, met by construction.
 */
import { useId, useState, type ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";

import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { CardModalArt, type MeldTarget } from "@/features/card/CardModalArt";
import { RAIL_ENTRY } from "@/features/card/CardModalRail";
import { CardModalTitle } from "@/features/card/CardModalTitle";
import { cardDetailKey } from "@/features/card/cardDetailKey";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { CARD_ASPECT } from "@/lib/images";
import {
  ipc,
  ipcError,
  type CardDetail,
  type DeckRow,
  type NewPrinting,
  type NewPrintingDeck,
} from "@/lib/ipc";
import { languageName } from "@/lib/languages";
import type { Marketplace } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

import { deckListKey } from "../keys";

/**
 * The panel's size, per rung — `CardDetailModal`'s `PANEL_SIZE` in shape and one rung shorter.
 *
 * **Below 640 it is the whole window**, the phone's full bleed that every dialog takes, and the
 * two columns are one scroller. At 640 and up it is `44rem`, which is what makes the fold below
 * land: the container query measures the panel's *content* box, a 1px border inside the width, so
 * a `40rem` panel would measure 638 and never reach the `@min-[640px]/card` rung it was sized for.
 * 704 − 2 × 20 of padding − 20 of gap − 300 of art leaves the deck column 344px, room for a
 * thirty-character deck name beside its count.
 *
 * No `max-h` in here — `cn`'s `tailwind-merge` would delete the shell's own `max-h-full`, and
 * `src/CLAUDE.md` has what that costs.
 */
const PANEL_SIZE = "w-full h-full min-[640px]:w-[44rem] min-[640px]:h-auto";

/** A release day in words, year included — the heading's subtitle. `printings.ts`' explicit
 *  locale and UTC zone, for the reason `NewPrintingsWidget` gives beside its own formatters. */
const RELEASED = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** A stable empty answer for the covers read, so the map below is not rebuilt over a fresh `[]`. */
const NO_DECK_ROWS: readonly DeckRow[] = [];

/**
 * No meld relations, and presses that cannot happen — see the module doc for why this dialog does
 * not ask for them. Module-level so the art column is handed one object for the life of the app.
 */
const NO_MELD: MeldTarget = {
  relations: [],
  melded: null,
  onMeld: () => undefined,
  onOpen: () => undefined,
};

/** The foil toggle's write, which here has nothing to write — see the module doc. */
function viewOnly(): void {}

/**
 * The line under the heading: when the printing arrived, and which language it is in where that is
 * not English.
 *
 * The language is said whatever the card's own language setting is, because this is one printing
 * and `cards.id` is one printing **in one language** — a Japanese Sol Ring opened from a card set
 * to *Every language* is still a Japanese card, and the chin under the picture does not say so.
 */
export function releasedLine(printing: NewPrinting): string {
  const day = RELEASED.format(new Date(`${printing.releasedAt}T00:00:00Z`));
  return printing.lang === "en"
    ? `Released ${day}`
    : `Released ${day} · ${languageName(printing.lang)}`;
}

export interface NewPrintingDialogProps {
  /** The printing the dialog is about. Latched by the host past `open`, so the exit fade has a
   *  card to draw rather than an empty panel fading out. */
  printing: NewPrinting;
  open: boolean;
  /** Escape and the ✕ — the host hands the caret back to the row that opened this. */
  onDismiss: () => void;
  /** A scrim press — close without moving the caret; the reader is already somewhere else. */
  onClose: () => void;
  /** A deck row: open that deck with this printing picked out in it. */
  onOpenDeck: (deckId: number, printingId: string) => void;
  /** *Open card details*: the card modal, on this printing. */
  onOpenCard: (printingId: string) => void;
}

export function NewPrintingDialog({
  printing,
  open,
  onDismiss,
  onClose,
  onOpenDeck,
  onOpenCard,
}: NewPrintingDialogProps): ReactElement {
  const { marketplace } = useMarketplace();
  // Read here rather than in the body because the heading needs it too, and `Dialog` draws the
  // heading. The body mounts per opening; this query is keyed on the printing, so a second opening
  // of the same row is a cache read.
  const card = useQuery({
    queryKey: cardDetailKey(printing.printingId, marketplace.id),
    queryFn: () => ipc.cardDetail(printing.printingId, marketplace.id),
  });

  return (
    <Dialog
      open={open}
      container
      size={PANEL_SIZE}
      title={
        <CardModalTitle
          card={card.data ?? null}
          pending={card.isPending}
          // The row already knows the name, so the heading never reads *Loading…* over a card the
          // reader just pressed by name.
          fallback={printing.name}
        />
      }
      subtitle={releasedLine(printing)}
      closeLabel="Close new printing"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body
        printing={printing}
        card={card.data}
        pending={card.isPending}
        error={card.isError ? ipcError(card.error) : null}
        marketplace={marketplace}
        onOpenDeck={onOpenDeck}
        onOpenCard={onOpenCard}
      />
    </Dialog>
  );
}

/**
 * Everything under the heading. Its own component so `face` starts at the front on every opening —
 * `Dialog` mounts `children` only while open.
 */
function Body({
  printing,
  card,
  pending,
  error,
  marketplace,
  onOpenDeck,
  onOpenCard,
}: {
  printing: NewPrinting;
  /** `undefined` until the read lands; `null` is the backend saying the printing is gone. */
  card: CardDetail | null | undefined;
  pending: boolean;
  error: string | null;
  marketplace: Marketplace;
  onOpenDeck: (deckId: number, printingId: string) => void;
  onOpenCard: (printingId: string) => void;
}): ReactElement {
  const [face, setFace] = useState(0);
  const showSetInSearch = useAppStore((s) => s.showSetInSearch);
  const decksId = useId();

  return (
    <div
      className={cn(
        // `CardDetailModal`'s grid, one rung: below the fold one scroller with the picture on top,
        // at and above it the card modal's art column beside the decks. `flex-auto` rather than
        // `flex-1`, for that file's reason — a zero basis reports no content height, and the panel
        // is sized from its content above the fold.
        "scrollbar-slim grid min-h-0 flex-auto grid-cols-1 gap-5 overflow-y-auto p-5",
        "@min-[640px]/card:grid-cols-[18.75rem_1fr]",
      )}
    >
      <div className="min-w-0">
        {error !== null ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            Could not read this card — {error}
          </p>
        ) : card === undefined || pending ? (
          // The frame the picture will fill, so the decks beside it do not jump when the read
          // lands — `CardModalArt`'s own box and radius, empty.
          <div
            aria-hidden="true"
            className="rounded-xl border border-border bg-bg"
            style={{ aspectRatio: CARD_ASPECT }}
          />
        ) : card === null ? (
          <p className="m-0 text-sm text-dim">
            This printing is not in the card database any more. The next card data sync will take
            it off the list.
          </p>
        ) : (
          <CardModalArt
            key={card.id}
            card={card}
            face={face}
            onFlip={() => setFace((f) => (f === 0 ? 1 : 0))}
            marketplace={marketplace}
            deckRow={null}
            openedAs={null}
            onToggleFoil={viewOnly}
            meld={NO_MELD}
            onShowSet={showSetInSearch}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <section aria-labelledby={decksId} className="flex flex-col gap-2">
          {/* **`text-accent`, for the card modal's own reason**: its *In your grimoire* heading is
              the one accented heading in that panel because it is the one block about the
              reader's own things, and this list is exactly that. "Watched", because these are the
              decks this card watches and not every deck the reader has — a virtual deck, or one
              outside a `Chosen…` scope, can hold the card and not be here. */}
          <h3 id={decksId} className="m-0 text-xs uppercase tracking-wide text-accent">
            In {plural(printing.decks.length, "watched deck")}
          </h3>
          <PrintingDecks printing={printing} onOpenDeck={onOpenDeck} />
        </section>
        <button
          type="button"
          onClick={() => onOpenCard(printing.printingId)}
          className={cn(RAIL_ENTRY, FOCUS)}
        >
          <span className="min-w-0 flex-1 truncate">Open card details</span>
        </button>
      </div>
    </div>
  );
}

/**
 * The decks holding this card.
 *
 * **Its covers are the gallery's own read** — `deckListKey` — so a page that already draws a Decks
 * widget pays nothing for them, and a page that does not pays one read the first time a row is
 * opened. Mounted with the dialog's body and not before it, which is what keeps that read out of a
 * card nobody has pressed.
 */
function PrintingDecks({
  printing,
  onOpenDeck,
}: {
  printing: NewPrinting;
  onOpenDeck: (deckId: number, printingId: string) => void;
}): ReactElement {
  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const rows = decksQuery.data ?? NO_DECK_ROWS;
  const covers = new Map(rows.map((deck) => [deck.id, deck]));
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {printing.decks.map((deck) => (
        <li key={deck.deckId}>
          <DeckLine
            deck={deck}
            cover={covers.get(deck.deckId)}
            onPress={() => onOpenDeck(deck.deckId, printing.printingId)}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * One deck: its cover, its name, and how many copies — or a `theory` chip where the copies are
 * planned rather than sleeved.
 *
 * **A rail entry with a cover in it**, `px-3` rather than the rail's `px-5` because the cover is
 * the inset a bare label needed that padding for. The accessible name spells the row once, since
 * the name, the chip and the count are three boxes in a `gap` and would concatenate with no space
 * between them.
 */
function DeckLine({
  deck,
  cover,
  onPress,
}: {
  deck: NewPrintingDeck;
  cover: DeckRow | undefined;
  onPress: () => void;
}): ReactElement {
  const held =
    deck.variant === "theory"
      ? "planned"
      : `${deck.quantity} ${deck.quantity === 1 ? "copy" : "copies"}`;
  return (
    <button
      type="button"
      aria-label={`${deck.name} · ${held}`}
      onClick={onPress}
      className={cn(RAIL_ENTRY, "gap-2.5 px-3", FOCUS)}
    >
      <span className="w-[22px] flex-none overflow-hidden rounded-[3px] border border-border">
        {/* `hasCover`'s test, `DeckTile`'s and `DecksWidget`'s: `coverArtist` is `null` exactly
            when the cover printing has left `cards`, so a request that could only miss is not
            made. A deck with no cover draws the empty frame, which is `CardArt`'s own fallback. */}
        <CardArt
          cardId={cover?.coverArtist != null ? cover.coverCardId : null}
          name=""
          variant="thumb"
          imageUrl={cover?.imageUris?.display}
          loading="lazy"
        />
      </span>
      <span className="min-w-0 flex-1 truncate">{deck.name}</span>
      {deck.variant === "theory" ? (
        <span className="flex-none rounded border border-border px-1 text-[0.6875rem] leading-4 text-dim">
          theory
        </span>
      ) : (
        <span className="flex-none font-mono text-xs tabular-nums text-dim">×{deck.quantity}</span>
      )}
    </button>
  );
}
