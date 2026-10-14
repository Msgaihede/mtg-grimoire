import { useState, type JSX } from "react";
import type { GameCard, GoldfishAction, GoldfishView } from "@/lib/ipc";
import { CardImage } from "@/components/CardImage";
import { Figure } from "@/components/Figure";
import { ToggleChip } from "@/components/FilterChips";
import { cardImageUrl } from "@/lib/images";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { pointerAt } from "./Inspect";
import { landsFirst } from "./layout";
import type { Pointed } from "./types";

/**
 * The opening hand — the artboard `Goldfish · opening hand` (2026-10-12): seven cards, the ones
 * picked for the bottom lifted out of the row, four figures about what is being kept, and the two
 * decisions.
 *
 * **The engine says how many go to the bottom; this only collects which.** `mulligan.bottom` is
 * the London mulligan's count with Commander's free first one already taken off (`session.rs`),
 * and `keep` is refused unless it carries exactly that many ids — so Keep stays greyed until the
 * picks match, rather than letting the reader send an action the engine will only bounce.
 *
 * **It reads four fields of the view** (`OpeningHandView`), so the playtest board hands it the
 * reader's seat and its mulligan as they are, rather than a second opening hand being drawn.
 *
 * **The cards fill whatever box it is given** (issue #993): before the first turn the seven are
 * the only thing on the table worth reading, so both boards hand it the whole board below their
 * top band, and the row sizes each card to the smaller of what seven fit across and what fits
 * down — see {@link CARD_WIDTH}.
 *
 * **A card rested on opens the board's inspect preview** (issue #1023), as a card in the fan does:
 * each card points itself at the board through `onPoint` / `onUnpoint` and carries `data-point`,
 * so the board's own guard lets go of it when the pointer leaves. The board's keys stay off — the
 * card is only being read, not acted on, before the first turn.
 */
export type OpeningHandView = Pick<GoldfishView, "hand" | "mulligan" | "library" | "libraryLands">;

export interface OpeningHandProps {
  view: OpeningHandView;
  onAct: (a: GoldfishAction) => void;
  /** The pointer has come onto a card: the board's inspect preview shows it once it rests. */
  onPoint?: (pointed: Pointed) => void;
  /** The pointer has left the card. Takes no argument — it is handed to `onMouseLeave` as is. */
  onUnpoint?: () => void;
}

export function OpeningHand({ view, onAct, onPoint, onUnpoint }: OpeningHandProps): JSX.Element {
  // Keyed on the hand's ids so a mulligan's new seven start with nothing picked: the ids are new
  // whenever a card changes zone (CR 400.7), so a pick held across the redraw would name a card
  // that is no longer in the hand — and `keep` would be refused for it.
  const key = view.hand.map((c) => c.id).join(",");
  return <Deciding key={key} view={view} onAct={onAct} onPoint={onPoint} onUnpoint={onUnpoint} />;
}

/** The size of every London mulligan's draw: always seven, whatever is then put back. */
const DRAW = 7;

/**
 * Each card's width in the row, which is a size container (`cqw`/`cqh` are the row's box): the
 * smaller of a seventh of the row less its six 14px gaps, and the row's height less the 28px a
 * picked card's 14px rise and its outline need, at 5:7 — and never past `display`'s 672px, the
 * widest the cache stores, so a 4K board does not upscale a card into a blur.
 *
 * Spelt out as one literal so Tailwind's scanner sees it; the row is the only container here and
 * holds nothing `fixed`, so its containment reparents nothing.
 */
const CARD_WIDTH = "w-[min(calc((100cqw_-_84px)/7),calc((100cqh_-_28px)*5/7),672px)]";

function Deciding({ view, onAct, onPoint, onUnpoint }: OpeningHandProps): JSX.Element {
  const mulligans = view.mulligan?.mulligans ?? 0;
  const need = view.mulligan?.bottom ?? 0;
  const freeFirst = view.mulligan?.freeFirst ?? false;
  const hand = view.hand;

  /** Ids picked for the bottom, oldest pick first. */
  const [picked, setPicked] = useState<number[]>([]);

  const pick = (id: number) =>
    setPicked((now) => {
      if (now.includes(id)) return now.filter((x) => x !== id);
      if (need === 0) return now;
      // Picking past the count drops the **oldest** pick, the artboard's behaviour: a reader who
      // changes their mind clicks the card they now want rather than first un-picking the one
      // they no longer do.
      const next = [...now, id];
      return next.length > need ? next.slice(next.length - need) : next;
    });

  const kept = hand.filter((c) => !picked.includes(c.id));
  const lands = kept.filter((c) => c.isLand).length;
  const spells = kept.filter((c) => !c.isLand);
  // An em dash rather than "0.0" over a hand of nothing but lands: an average of no spells is not
  // a mana value of zero, and Figure's own rule is that a figure that cannot be said is not faked.
  const average =
    spells.length === 0
      ? "—"
      : (spells.reduce((n, c) => n + c.manaValue, 0) / spells.length).toFixed(1);

  const ready = picked.length === need;
  const keepSize = hand.length - need;
  // What the *next* mulligan would leave: it draws seven again and puts one more on the bottom
  // than this one does — except that the first is free in Commander, so the count the next hand
  // owes is the mulligans taken by then, less the free one.
  const nextBottom = mulligans + 1 - (freeFirst ? 1 : 0);
  const nextKeep = Math.max(0, DRAW - nextBottom);

  const instruction =
    need === 0
      ? "Keep these seven, or mulligan"
      : `Mulligan ${mulligans} · pick ${need} card${need === 1 ? "" : "s"} to put on the bottom of your library`;

  const freeNote = freeFirst
    ? mulligans >= 1
      ? "Your first mulligan was free."
      : "Your first mulligan is free."
    : "Every mulligan puts a card on the bottom.";

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-5">
      <div className="flex flex-col items-center gap-1.5">
        <h2 className="m-0 font-heading text-2xl font-semibold">Opening hand</h2>
        <p className="m-0 text-sm text-dim">{instruction}</p>
      </div>

      {/* Every height the box has left over goes to the cards (`CARD_WIDTH`). Lands first, the
          way a reader sorts a hand they have just picked up; the board's hand keeps that order
          once it is kept (`arrangeHand`). */}
      <div className="min-h-[120px] w-full flex-1 [container-type:size]">
        <div
          role="group"
          aria-label="Opening hand"
          className="flex h-full items-center justify-center gap-[14px]"
        >
          {landsFirst(hand).map((card) => (
            <HandCard
              key={card.id}
              card={card}
              picked={picked.includes(card.id)}
              onPick={() => pick(card.id)}
              onPoint={onPoint}
              onUnpoint={onUnpoint}
            />
          ))}
        </div>
      </div>

      <dl className="m-0 flex gap-8">
        <Figure label="Lands kept" value={String(lands)} note={`of ${kept.length}`} />
        <Figure label="Spells kept" value={String(spells.length)} />
        <Figure label="Their mana value" value={average} note="average" />
        <Figure
          label="In the library"
          value={`${view.libraryLands} lands`}
          note={`of ${view.library}`}
        />
      </dl>

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order, and
          // this one greys and ungreys as the reader picks.
          aria-disabled={!ready}
          onClick={() => {
            if (ready) onAct({ type: "keep", bottom: picked });
          }}
          className={cn(
            "inline-flex h-11 items-center rounded-full border border-accent bg-surface px-5",
            "text-[15px] font-semibold text-accent transition-colors motion-reduce:transition-none",
            PRESS,
            FOCUS,
            ready
              ? "hover:bg-accent hover:text-accent-fg"
              : "cursor-default opacity-45 active:scale-100",
          )}
        >
          {need === 0 ? `Keep ${hand.length}` : `Put ${need} on the bottom and keep ${keepSize}`}
        </button>
        <button
          type="button"
          onClick={() => onAct({ type: "mulligan" })}
          className={cn(
            "inline-flex h-11 items-center rounded-full border border-border bg-surface px-5",
            "text-[15px] text-text transition-colors motion-reduce:transition-none",
            "hover:border-accent",
            PRESS,
            FOCUS,
          )}
        >
          Mulligan to {nextKeep}
        </button>
      </div>

      <div className="flex items-center gap-2.5">
        {/* Informational: whether the first mulligan is free is the game's rule, decided by the
            engine for the deck's format, and not a switch the reader can flip mid-hand. */}
        <ToggleChip
          label="Free first mulligan"
          pressed={freeFirst}
          onClick={() => {}}
          hint="Commander's multiplayer rule"
          disabled
        />
        <span className="text-xs text-dim">{freeNote}</span>
      </div>
    </div>
  );
}

function HandCard({
  card,
  picked,
  onPick,
  onPoint,
  onUnpoint,
}: {
  card: GameCard;
  picked: boolean;
  onPick: () => void;
  onPoint?: (pointed: Pointed) => void;
  onUnpoint?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={picked ? `${card.name}, going to the bottom` : card.name}
      onClick={onPick}
      onMouseEnter={(e) =>
        onPoint?.({
          card,
          ids: [card.id],
          place: "hand",
          line: `${card.name} · in your opening hand`,
          at: pointerAt(e),
        })
      }
      onMouseLeave={() => onUnpoint?.()}
      data-point={card.id}
      className={cn(
        "relative aspect-[5/7] flex-none rounded-lg p-0",
        CARD_WIDTH,
        "transition-transform duration-150 ease-[ease] motion-reduce:transition-none",
        FOCUS,
        picked && "-translate-y-[14px] outline-2 outline-offset-2 outline-accent outline-solid",
      )}
    >
      {card.cardId !== null ? (
        <CardImage
          // `display`, not `grid`: a card drawn this large from 488px goes soft on a scaled
          // display, and `display` is the key the inspect preview already caches.
          src={cardImageUrl(card.cardId, 0, "display")}
          alt={card.name}
          className="block h-full w-full rounded-md"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-md border border-border bg-surface p-2 text-center text-sm">
          {card.name}
        </span>
      )}
      {picked && (
        <span className="absolute bottom-2 left-1.5 rounded bg-accent px-2 py-0.5 text-[13px] text-accent-fg">
          To the bottom
        </span>
      )}
    </button>
  );
}
