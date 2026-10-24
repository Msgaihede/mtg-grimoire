import { useState, type JSX } from "react";
import type { GameCard, GamePlace, PlaytestAction, PlaytestSeat } from "@/lib/ipc";
import { CardImage } from "@/components/CardImage";
import { Dialog } from "@/components/Dialog";
import { cardImageUrl } from "@/lib/images";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { pointerAt } from "./Inspect";
import type { Pointed, ZoneLook } from "./types";

/**
 * A zone turned face up: the library's top cards (look at, scry, surveil), the whole library
 * (search), or the graveyard or exile to look through — each card with the places it can go.
 *
 * **Every render reads the cards from the latest `view`, never from a copy taken on open.** Each
 * button is one action, and the view that comes back has a new id for the card that moved
 * (CR 400.7) and the same ids for the rest — so a list snapshotted on open would offer buttons for
 * cards that are no longer where it says, and the engine would refuse every one of them.
 *
 * **The top-N window shrinks as cards leave it.** Scry 3 is about three cards, and once one has
 * gone to the bottom the fourth card down is not part of the decision — so `moved` counts the
 * cards sent out of the window and the dialog shows `count - moved` from the top. A card sent to
 * the top stays in it (it is reordering the window, not leaving it).
 *
 * **`readOnly` turns it into a look and nothing more** — the reader's own graveyard or exile with
 * the sandbox's moves not working (it is off, or it is not the reader's main phase): the cards are
 * public and worth reading, but moving one by hand is the sandbox's, so no card carries a place to
 * go and the search's Shuffle is gone. The board never opens the library this way: with the
 * sandbox off a library is not looked through at all.
 *
 * **`opponent` is a look at another player's zone** — an opponent's graveyard or exile, named as
 * theirs (`owner`), and read-only like `readOnly`: their cards are moved through their own
 * battlefield's menu with the sandbox on, never from here.
 *
 * **A card the rules let the reader cast from here carries a Cast** ({@link GameCard.castable}: a
 * foretold card in exile, a flashback card in the graveyard), whatever `readOnly` says — it is the
 * rules' play, not a hand move. It closes the dialog, since the cast may ask a question of its own.
 * A foretold card says so under it.
 *
 * **A card rested on opens the board's inspect preview** (issue #1373): at 120 px a card's text
 * cannot be read, and the look is for reading it. Each card points itself at the board through
 * `onPoint` / `onUnpoint` and carries `data-point`, as the opening hand's do, and the board lifts
 * the preview over this dialog's scrim (`Inspect`'s `overDialog`). A scroll of the list lets go,
 * since it carries the card out from under the pointer without a `mouseleave`.
 */
export function LibraryDialog({
  look,
  view,
  onAct,
  onClose,
  readOnly = false,
  opponent = false,
  owner = "The opponent's",
  onPoint,
  onUnpoint,
}: {
  look: ZoneLook;
  view: Pick<PlaytestSeat, "libraryCards" | "graveyard" | "exile" | "library">;
  onAct: (a: PlaytestAction) => void;
  onClose: () => void;
  readOnly?: boolean;
  opponent?: boolean;
  /** Whose zone an `opponent` look is, as its title starts: "Opponent 2's" at a four-player
   *  table. */
  owner?: string;
  /** The pointer has come onto a card: the board's inspect preview shows it once it rests. */
  onPoint?: (pointed: Pointed) => void;
  /** The pointer has left the card. Takes no argument — it is handed to `onMouseLeave` as is. */
  onUnpoint?: () => void;
}): JSX.Element {
  const [moved, setMoved] = useState(0);
  const [filter, setFilter] = useState("");

  const searching = look.mode === "search";
  const windowed = look.zone === "library" && look.count !== "all";
  const remaining = look.count === "all" ? Infinity : Math.max(0, look.count - moved);

  const all: GameCard[] =
    look.zone === "library"
      ? view.libraryCards
      : // Newest first: the engine keeps both oldest first, and what was put there last is what a
        // reader goes looking for.
        [...(look.zone === "graveyard" ? view.graveyard : view.exile)].reverse();
  const shown = windowed ? all.slice(0, remaining) : all;
  const needle = filter.trim().toLowerCase();
  const cards =
    searching && needle !== "" ? shown.filter((c) => c.name.toLowerCase().includes(needle)) : shown;

  const title = opponent ? opponentTitle(look, owner) : titleFor(look);
  const places = opponent || readOnly ? [] : placesFor(look);

  const send = (card: GameCard, to: GamePlace) => {
    // Out of the window unless it went back on top of it.
    if (windowed && to !== "libraryTop") setMoved((n) => n + 1);
    onAct({ type: "move", id: card.id, to });
  };

  return (
    <Dialog
      open
      title={title}
      subtitle={subtitleFor(look, view)}
      closeLabel={`Close ${look.zone === "library" ? "the library" : look.zone === "graveyard" ? "the graveyard" : "exile"}`}
      size="w-[52rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      {searching && (
        <div className="border-b border-border px-5 py-3">
          <input
            type="text"
            aria-label="Find a card by name"
            placeholder="Find a card by name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text",
              "placeholder:text-dim",
              FOCUS,
            )}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-5" onScroll={() => onUnpoint?.()}>
        {cards.length === 0 ? (
          <p className="m-0 text-sm text-dim">{emptyLine(look, all.length, needle !== "")}</p>
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,120px)] gap-x-3 gap-y-4 p-0">
            {cards.map((card, i) => (
              <li
                key={card.id}
                role="group"
                aria-label={card.name}
                className="flex flex-col gap-1.5"
              >
                <div
                  data-point={card.id}
                  onMouseEnter={(e) =>
                    onPoint?.({
                      card,
                      ids: [card.id],
                      place: look.zone === "library" ? "libraryTop" : look.zone,
                      line: `${card.name} · ${placeLine(look, opponent, searching ? null : i)}`,
                      at: pointerAt(e),
                    })
                  }
                  onMouseLeave={() => onUnpoint?.()}
                >
                  {card.cardId !== null ? (
                    <CardImage
                      src={cardImageUrl(card.cardId, 0, "grid")}
                      alt={card.name}
                      className="block h-[168px] w-[120px] rounded-md"
                    />
                  ) : (
                    <span className="flex h-[168px] w-[120px] items-center justify-center rounded-md border border-border bg-surface p-2 text-center text-xs">
                      {card.name}
                    </span>
                  )}
                </div>
                {card.foretold && <span className="font-mono text-[11px] text-dim">Foretold</span>}
                {look.zone === "library" && !searching && (
                  <span className="font-mono text-[11px] text-dim">
                    {i === 0 ? "On top" : `${i + 1} from the top`}
                  </span>
                )}
                {((card.castable && !opponent) || places.length > 0) && (
                  <div className="flex flex-wrap gap-1">
                    {card.castable && !opponent && (
                      <button
                        type="button"
                        onClick={() => {
                          onAct({ type: "play", id: card.id });
                          onClose();
                        }}
                        className={cn(
                          "h-6 rounded border border-accent px-1.5 text-[11px] text-accent",
                          "transition-colors motion-reduce:transition-none hover:bg-accent hover:text-accent-fg",
                          PRESS,
                          FOCUS,
                        )}
                      >
                        Cast
                      </button>
                    )}
                    {places.map(([to, label]) => (
                      <button
                        key={to}
                        type="button"
                        onClick={() => send(card, to)}
                        className={cn(
                          "h-6 rounded border border-border px-1.5 text-[11px] text-dim",
                          "transition-colors motion-reduce:transition-none hover:border-accent hover:text-text",
                          PRESS,
                          FOCUS,
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        {searching && !readOnly && !opponent && (
          <button
            type="button"
            // Every search that finds a card says "then shuffle". The dialog stays open, so a
            // card can still go on top after it (Vampiric Tutor's order).
            onClick={() => onAct({ type: "shuffle" })}
            className={cn(FOOTER_BUTTON, "border-border text-text hover:border-accent")}
          >
            Shuffle
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className={cn(
            FOOTER_BUTTON,
            "border-accent text-accent hover:bg-accent hover:text-accent-fg",
          )}
        >
          Done
        </button>
      </div>
    </Dialog>
  );
}

const FOOTER_BUTTON = cn(
  "inline-flex h-9 items-center rounded-full border bg-surface px-4 text-[13px]",
  "transition-colors motion-reduce:transition-none",
  PRESS,
  FOCUS,
);

function titleFor(look: ZoneLook): string {
  const n = look.count === "all" ? "" : String(look.count);
  switch (look.mode) {
    case "look":
      return look.count === "all" ? "Your library" : `The top ${n} of your library`;
    case "scry":
      return `Scry ${n}`;
    case "surveil":
      return `Surveil ${n}`;
    case "search":
      return "Search your library";
    case "browse":
      return look.zone === "graveyard"
        ? "Your graveyard"
        : look.zone === "exile"
          ? "Exile"
          : "Your library";
  }
}

/** The opponent's zone, named as theirs. Only a graveyard or exile is ever opened for them. */
function opponentTitle(look: ZoneLook, owner: string): string {
  return look.zone === "exile" ? `${owner} exile` : `${owner} graveyard`;
}

function subtitleFor(look: ZoneLook, view: Pick<PlaytestSeat, "library">): string {
  switch (look.mode) {
    case "scry":
      return "Top first. Leave each on top or put it on the bottom.";
    case "surveil":
      return "Top first. Leave each on top or put it into your graveyard.";
    case "look":
      return "Top first.";
    case "search":
      return `${view.library} card${view.library === 1 ? "" : "s"}, in library order.`;
    case "browse":
      return "Newest first.";
  }
}

/** The buttons under each card: where it can go from here, as the mode allows. */
function placesFor(look: ZoneLook): [GamePlace, string][] {
  if (look.mode === "scry")
    return [
      ["libraryTop", "Top"],
      ["libraryBottom", "Bottom"],
    ];
  if (look.mode === "surveil")
    return [
      ["libraryTop", "Top"],
      ["graveyard", "Graveyard"],
    ];
  // Top too: a tutor that says "shuffle, then put that card on top" (Vampiric Tutor) is Shuffle,
  // then Top — which is why the footer's Shuffle leaves the dialog open.
  if (look.mode === "search")
    return [
      ["hand", "Hand"],
      ["battlefield", "Battlefield"],
      ["graveyard", "Graveyard"],
      ["exile", "Exile"],
      ["libraryTop", "Top"],
    ];
  const rows: [GamePlace, string][] = [
    ["hand", "Hand"],
    // A move, never a play: from the library, the graveyard or exile a card is put onto the
    // battlefield by whatever effect is being acted out, not cast.
    ["battlefield", "Battlefield"],
  ];
  if (look.zone !== "graveyard") rows.push(["graveyard", "Graveyard"]);
  if (look.zone !== "exile") rows.push(["exile", "Exile"]);
  rows.push(["libraryTop", "Top"], ["libraryBottom", "Bottom"]);
  return rows;
}

/**
 * Where a card in the look is, for the preview's caption: "in the graveyard", "in their exile",
 * "on top of the library", "3 from the top". `index` is the card's place from the top in a look
 * at the library in order, and `null` in a search, where the cards are in library order but the
 * reader is looking for a name rather than a position.
 */
function placeLine(look: ZoneLook, opponent: boolean, index: number | null): string {
  if (look.zone === "graveyard") return opponent ? "in their graveyard" : "in the graveyard";
  if (look.zone === "exile") return opponent ? "in their exile" : "in exile";
  if (index === null) return "in the library";
  return index === 0 ? "on top of the library" : `${index + 1} from the top`;
}

function emptyLine(look: ZoneLook, total: number, filtering: boolean): string {
  if (filtering) return "No card in the library has that in its name.";
  if (look.zone === "graveyard") return "The graveyard is empty.";
  if (look.zone === "exile") return "Nothing is in exile.";
  if (total === 0) return "The library is empty.";
  return "Nothing left to look at.";
}
