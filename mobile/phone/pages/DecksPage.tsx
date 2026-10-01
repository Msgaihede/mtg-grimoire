import { useDecks } from "@/features/decks/useDecks";
import { plural } from "@/lib/counts";
import { FOCUS_INSET } from "@/lib/focus";
import { cn } from "@/lib/utils";

/** The reader's decks, as a list. The gallery's covers and folders are phase 3's. */
export function DecksPage({ onOpen }: { onOpen: (deckId: number) => void }) {
  const { decks, query } = useDecks();

  if (query.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-destructive">
        Your decks could not be read.
      </p>
    );
  }
  if (!query.isPending && decks.length === 0) return <p className="p-4 text-sm text-dim">No decks</p>;

  return (
    <ul aria-label="Your decks" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {decks.map((deck) => (
        <li key={deck.id} className="border-b border-border">
          <button
            type="button"
            onClick={() => onOpen(deck.id)}
            className={cn(
              "flex min-h-14 w-full flex-col justify-center px-4 py-2 text-left",
              FOCUS_INSET,
            )}
          >
            <span className="truncate text-base">{deck.name}</span>
            {/* A space between the two, as a sibling. A flex column draws no whitespace-only text,
                so nothing moves; but the button's name is its contents run together, and without
                this it is computed as `Modern GoodstuffModern · 60 cards`. */}
            {" "}
            <span className="truncate text-xs text-dim">
              {deck.formatName ?? deck.formatKey} · {plural(deck.cardCount, "card")}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
