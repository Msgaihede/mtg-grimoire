import type { JSX } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { ipc, ipcError, type CardDetail } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { cardDetailKey } from "./cardDetailKey";
import { formatLabel, legalityRows, statusClass, statusWord } from "./legality";

/**
 * Where this card may be played — **every format, including the ones it may not.**
 *
 * ## Why it does not go through `legalityChips`
 *
 * The helper next door drops every `not_legal` key before anything is drawn, and the docked pane
 * compensated with a caption: *Formats not listed are not legal.* That is the right trade for a
 * 384px column where the chips are a tail under the prices — a card keeps 11.3 of 23 keys on
 * average, so the filter is half the ink — and it is the wrong trade here, because this surface
 * exists for one question and absence is not an answer to it. A reader who pressed **Legality**
 * is asking *can I play this in my format*, and a format that is simply missing from the grid
 * says that to nobody: it reads as data that failed to load.
 *
 * So this reads `card.legalities` directly and draws all 23 rows, `not_legal` in a recessed
 * badge. `legalityChips` is untouched and still right for its own caller. **A regression to it
 * here would silently lose about half the grid**, which is why the test pins a `not_legal` row
 * by name rather than counting anything.
 *
 * ## Never colour alone
 *
 * Each badge carries the **word**. Four statuses land on four treatments, and a reader who
 * cannot tell the green from the red still gets the answer in type — the app's rule wherever a
 * status is coloured, and the same argument `CardTextDialog` is built on one rail entry over:
 * a fact a reader is required to *see* is a fact half of them do not have.
 *
 * ## No footer
 *
 * The mockup ends on two lines this does not draw — *On the Commander Game Changer list* and
 * *Canadian Highlander: 3 points* — and spec §3.1 drops both. `CardDetail` carries no
 * `gameChanger` (the column exists and two other DTOs expose it, so it is a small Rust change,
 * and the line is simply not wanted); Canadian Highlander points exist in **no** data source
 * this app has — not in Scryfall's bulk files at all, because that format's committee maintains
 * the list — so a table here would be a number with no refresh path and no build to go red when
 * it rots. Neither gets a placeholder either: an empty row promising a fact is worse than a
 * grid that never claimed it.
 *
 * ## Self-mounting, like its two siblings
 *
 * It takes no props. `cardOverlay` is one store field with one writer, so at most one nested
 * overlay is ever open, and this is drawn as an `App`-level **sibling** of the card modal rather
 * than as a child of its panel — that panel is a container-query context, and a layout-contained
 * box is the containing block for its `fixed` descendants, so a scrim rendered inside it would
 * stretch to the panel instead of to the window.
 */
export function LegalityDialog(): JSX.Element {
  const overlay = useAppStore((s) => s.cardOverlay);
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  // Nothing here draws a price — but the marketplace is in `card_detail`'s **key**, because it
  // is in `card_detail`'s answer, and a key that left it out would open a second cache entry for
  // a card the modal behind this one has already fetched.
  const { marketplace } = useMarketplace();

  const open = overlay === "legality" && cardId !== null;

  const card = useQuery({
    // The card modal's own key, imported rather than spelled out — see {@link cardDetailKey}
    // for why every surface that reads a card has to agree on it to the character.
    queryKey: cardDetailKey(cardId, marketplace.id),
    // `skipToken` rather than `enabled`, so the closed state is *no query function at all*
    // rather than a disabled one — this component is mounted for the whole life of the app and
    // must cost nothing until a reader asks. An entry the modal has already filled is read on
    // the render this opens.
    queryFn: open && cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
  });

  return (
    <Dialog
      open={open}
      title="Legality"
      // The heading says which *question* is open — which is what a reader choosing between
      // three rail entries is picking — and the subtitle says which card it is being asked
      // about.
      subtitle={card.data?.name}
      closeLabel="Close legality"
      size="w-[45rem]"
      // **A claim about the highest thing this surface can be asked to cover**, which is
      // `LAYER.overlayStacked`'s own rule. It is opened from the card modal's options rail and
      // from nowhere else, so it is *always* over another dialog — two `fixed inset-0` scrims,
      // neither inside the other, in the root stacking context. At the default rung they tie,
      // and equal z-indexes are resolved by document order, which is the bug `layers.ts` opens
      // with.
      layer="stacked"
      onDismiss={close}
      onClose={close}
    >
      {/* The fold is measured on **this box** rather than on the window, for spec §2.1's reason:
          the panel is `w-[45rem]` above the phone fold and the whole glass below it, and how its
          own grid should split is a question about the panel's width and nothing else.

          The container is declared here rather than on `Dialog`'s panel because `Dialog`'s
          `container` prop is `@container/card`, a literal spelled for one host — and because a
          container is a containing block for its `fixed` descendants, so it is switched on over
          the smallest subtree that needs it. Nothing under here is `fixed`: the body is a grid
          of text, tooltips mount at the app root, and this dialog opens no popup of its own.

          `@min-[640px]/…` rather than the bare `@[640px]/…` the plan sketched. **Both compile**
          — checked against this build (Tailwind 4.3.3), where the two emit the identical
          `@container legality (width >= 640px)` — so this is one spelling per repo rather than a
          correctness fix: `FilterBar`'s four rungs are the only other named container queries in
          `packages/ui/` and they are all written this way. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-5 @container/legality">
        <LegalityBody
          card={card.data ?? null}
          loading={card.isPending}
          error={card.error === null ? null : ipcError(card.error)}
        />
      </div>
    </Dialog>
  );
}

/**
 * The grid, and the four states that are not a grid.
 *
 * Split out from the shell so the states read as one list rather than as conditions threaded
 * through a `Dialog` call, and so a story or a test can stage a card no fake could answer with.
 */
function LegalityBody({
  card,
  loading,
  error,
}: {
  card: CardDetail | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <p className="text-sm text-dim">Loading card…</p>;
  if (error !== null) {
    return <p className="text-sm text-destructive">Couldn't read the card — {error}.</p>;
  }
  // `card_detail` answers `null` for an id `cards` has no row for, which is a real state rather
  // than a failure: a collection or a deck can hold a printing the corpus has since dropped.
  if (card === null) {
    return <p className="text-sm text-dim">This printing is no longer in the card database.</p>;
  }

  const rows = legalityRows(card.legalities);
  // Not the same as "legal nowhere", which is 23 `not_legal` rows and draws in full. This is a
  // card the corpus holds **no legality blob for at all** — a token, an art card, a row whose
  // JSON did not parse — and saying so is the only thing that tells it from a grid that failed
  // to render.
  if (rows.length === 0) {
    return <p className="text-sm text-dim">Scryfall lists no formats for this card.</p>;
  }

  return (
    // The list keeps a name of its own, and it is the more exact of the two: the dialog's
    // heading says what the surface is about, `Format legality` says what the items in it *are*.
    <ul
      aria-label="Format legality"
      className="grid grid-cols-1 gap-x-8 gap-y-1.5 @min-[640px]/legality:grid-cols-2"
    >
      {rows.map(({ format, status }) => (
        <li key={format} className="flex items-center gap-2.5 text-sm">
          {/* One width for every badge, so the format names line up into a column the eye can
              run down — the grid's whole readability at 23 rows. `text-center` because a
              fixed-width chip with ragged type inside it reads as a broken button. */}
          <span
            className={cn(
              "w-[5.5rem] shrink-0 rounded-full border px-2 py-0.5 text-center text-[0.7rem]",
              statusClass(status),
            )}
          >
            {statusWord(status)}
          </span>
          <span className="min-w-0 truncate">{formatLabel(format)}</span>
        </li>
      ))}
    </ul>
  );
}
