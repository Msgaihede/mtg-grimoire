import { useDecks } from "@/features/decks/useDecks";
import { plural } from "@/lib/counts";
import { FOCUS_INSET } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { linkTo } from "../router";
import { DimNote, ReadError } from "./parts";

/**
 * The reader's decks, as a list. The gallery's covers and folders are phase 3's.
 *
 * **Each row is a link, not a button**: it changes the URL, so it answers what a link answers —
 * a middle click, "copy link" — and a screen reader hears *link*. `linkTo` keeps a plain press
 * inside the page.
 */
export function DecksPage() {
  const { decks, query } = useDecks();

  if (query.isLoadingError) return <ReadError>Your decks could not be read.</ReadError>;
  if (!query.isPending && decks.length === 0) return <DimNote>No decks</DimNote>;

  return (
    <ul aria-label="Your decks" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {decks.map((deck) => (
        <li key={deck.id} className="border-b border-border">
          <a
            {...linkTo({ view: "decks", deckId: deck.id, cardId: null })}
            className={cn(
              "flex min-h-14 w-full flex-col justify-center px-4 py-2 text-left",
              FOCUS_INSET,
            )}
          >
            <span className="truncate text-base">{deck.name}</span>
            {/* A space between the two, as a sibling. A flex column draws no whitespace-only text,
                so nothing moves; but the link's name is its contents run together, and without
                this it is computed as `Modern GoodstuffModern · 60 cards`. */}
            {" "}
            <span className="truncate text-xs text-dim">
              {deck.formatName ?? deck.formatKey} · {plural(deck.cardCount, "card")}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
