/**
 * Which printing of one token or emblem a deck brings — the dialog behind a tile's picture.
 *
 * **No new Rust, and that is a fact about the corpus rather than a shortcut.** `card_printings`
 * is `oracle_id = ?1 AND is_paper = 1` (`card.rs:96`) — no legality term at all — and every
 * token, emblem and double-faced-token row in the corpus is paper and carries an `oracle_id`
 * (0 missing of 3 245, measured 2026-09-07 on the debug corpus). So the command that draws the
 * card modal's printing list already answers this one, unchanged.
 *
 * **`playableOnly` is not passed here because this command does not take one.** It is
 * `search_cards`' flag — `DeckCoverPicker` passes `playableOnly: false` to *that* command for
 * exactly this reason, since `filters.rs`' `legal_mask != 0` gate is what hides a token from the
 * search wall — and reading the two as one command is the way this picker would come back empty
 * for every token in the game.
 *
 * **A grid with a scroller, not a dropdown.** Treasure answers 97 paper printings across 70
 * distinct arts (spec §2), which is a wall of pictures rather than a list of words: the reader is
 * choosing a *picture*, so the picture has to be the thing they press.
 */
import { useMemo, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { CardArt } from "@/components/CardArt";
import { Dialog } from "@/components/Dialog";
import { count } from "@/lib/counts";
import { FOCUS_INSET } from "@/lib/focus";
import { WALL_CARD_VARIANT } from "@/lib/images";
import { ipc, ipcError, type Printing } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import type { DeckTokenView } from "./deckTokens";

/**
 * How wide a token is drawn, in this dialog and on the wall behind it.
 *
 * **150, which is `GridView`'s `TILE_WIDTH` and `DeckSearchPanel`'s `TILE_BASE` a third time** —
 * and it is a third constant rather than an import for a reason each of those two also has. Both
 * of theirs are a *base* that `CardGrid` and the deck's Grid view then multiply by the reader's
 * zoom for their own card section; neither the token wall nor this picker is a zoom section, so
 * importing one would be importing a number that means "the size before the reader's zoom" and
 * using it as the size. What the two walls here must agree about is each other, which is why the
 * number is declared once for the pair: a reader who presses a tile has to meet the same picture
 * at the same size, or the swap does not read as a swap.
 *
 * It lives in this file rather than in the panel because the import has to run one way, and a
 * panel that opens a picker is the honest direction for it.
 */
export const TOKEN_TILE_WIDTH = 150;

export interface TokenArtPickerProps {
  /**
   * The token being repictured, or `null` when the dialog is shut.
   *
   * **The whole view rather than an oracle id**, because every string this dialog sets in type
   * is already on it: the name it is titled by, the {@link DeckTokenView.subtitle} that says
   * *which* Wurm, and the {@link DeckTokenView.printingId} a tile is marked current by. Fetching
   * any of those again would be a second answer to a question the wall behind the scrim has
   * already had answered.
   */
  token: DeckTokenView | null;
  /** A printing was pressed. The host writes it; this dialog knows nothing about the command. */
  onPick: (cardId: string) => void;
  /** Escape and the ✕: close, and hand the caret back to the tile that opened this. */
  onDismiss: () => void;
  /** An outside click: close and move no focus — the reader is already somewhere else. */
  onClose: () => void;
}

/**
 * The printings of one token, as pictures.
 *
 * **Open is `token !== null`** rather than a flag beside it, so there is one fact and not two
 * that have to agree. `Dialog` mounts nothing while it is shut, and during the exit fade
 * `AnimatePresence` holds the element tree from the last render in which it was open — so the
 * body below never sees a `null` token it would have to guard a second time.
 */
export function TokenArtPicker({
  token,
  onPick,
  onDismiss,
  onClose,
}: TokenArtPickerProps): JSX.Element {
  return (
    <Dialog
      open={token !== null}
      // Named for the thing being changed rather than for the act: the ✕ and Escape both say
      // "close", and a heading that repeated the verb would leave the token's own name — the one
      // word telling this dialog from the next one — as the smallest thing on the header.
      title={token === null ? "" : `Art for ${token.name}`}
      // The disambiguator, where there is one. A deck holding Wurmcoil Engine opens two of these
      // and the heading is `Art for Wurm` both times; this line is the whole of what tells the
      // reader which of the two they pressed.
      subtitle={token?.subtitle ?? undefined}
      closeLabel="Close the art picker"
      size="w-[52rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      {token !== null && <PickerBody token={token} onPick={onPick} />}
    </Dialog>
  );
}

/**
 * The read and the wall it draws.
 *
 * Its own component so the four states one round trip has — in flight, refused, nothing to
 * offer, and the pictures — are four branches side by side rather than four conditions threaded
 * through the dialog's body. `DeckCoverPicker`'s `SearchResults` is the same split for the same
 * reason.
 */
function PickerBody({
  token,
  onPick,
}: {
  token: DeckTokenView;
  onPick: (cardId: string) => void;
}) {
  const { marketplace } = useMarketplace();

  /**
   * Every paper printing of this token.
   *
   * **The card modal's key and page size verbatim**, so this shares that cache entry rather
   * than opening a second one: absent `limit` is `MAX_PRINTINGS` (400), which is far past the
   * most-printed token in the game — Treasure's 97 — so there is nothing here for a wider page
   * to reach.
   *
   * **The marketplace is in the key because the command takes one**, and for no other reason:
   * this wall draws no price at all. A token is not a card anybody buys, so `finishPrices` is
   * fetched and never read, and a currency switch re-issues a read whose answer cannot move.
   * That is one wasted round trip against local SQLite on a setting nobody changes mid-pick,
   * where a key that dropped the argument would serve one marketplace's rows under another's.
   */
  const query = useQuery({
    queryKey: ["card", "printings", token.oracleId, marketplace.id],
    queryFn: () => ipc.cardPrintings(token.oracleId, marketplace.id),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const failure = query.isError ? ipcError(query.error) : null;

  if (failure !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not read this token&rsquo;s printings — {failure}
      </p>
    );
  }

  if (query.isPending) {
    return <p className="text-sm text-dim">Reading the printings…</p>;
  }

  if (items.length === 0) {
    // Reachable and not hypothetical: 3 or 4 of the corpus's referenced token printings resolve
    // to no local row (spec §2), and a token added by hand can outlive a sync that dropped it.
    // It says what is true rather than claiming a failure — the read succeeded and answered
    // nothing.
    return (
      <p className="text-sm text-dim">
        No paper printing of this token is in your card data yet.
      </p>
    );
  }

  return (
    <>
      {/* A scroller of its own, and the reason is the app's standing one: a modal is clamped to
          the window and scrolls **inside** itself, so a token with 97 printings may not decide
          this panel's height. The tiles wrap, so nothing here can scroll sideways — which is the
          other half of the rule, and the half a fixed-column grid would have broken. */}
      <ul className="flex max-h-[26rem] flex-wrap gap-x-2.5 gap-y-3 overflow-y-auto p-1.5">
        {items.map((printing) => (
          <li key={printing.id} style={{ width: TOKEN_TILE_WIDTH }}>
            <PrintingTile
              printing={printing}
              tokenName={token.name}
              current={printing.id === token.printingId}
              onPick={() => onPick(printing.id)}
            />
          </li>
        ))}
      </ul>
      {/* Said only when it is true, which for a token it never is today: 400 is the page and
          Treasure's 97 is the longest list in the game. It is here because the page size is a
          promise the backend makes and not one this file can keep — `list_printings` clamps, and
          a wall that silently drew the newest 400 of a longer list would read as an answer. */}
      {total > items.length && (
        <p className="mt-2 text-[0.6875rem] text-dim">
          Showing {items.length} of {count(total)} printings.
        </p>
      )}
    </>
  );
}

/** One printing offered as this token's picture. */
function PrintingTile({
  printing,
  tokenName,
  current,
  onPick,
}: {
  printing: Printing;
  /** The token's own name — the frame's `alt`, and what the button is named by. */
  tokenName: string;
  current: boolean;
  onPick: () => void;
}) {
  /** `MOM · 12 · 2023` — what a reader tells two pictures of one token apart by. */
  const label = useMemo(() => {
    const parts = [printing.setCode.toUpperCase(), printing.collectorNumber];
    if (printing.releasedAt !== null) parts.push(printing.releasedAt.slice(0, 4));
    return parts.join(" · ");
  }, [printing.setCode, printing.collectorNumber, printing.releasedAt]);

  return (
    <>
      <button
        type="button"
        onClick={onPick}
        // The state, not a decoration: the gold ring below is the only other thing saying which
        // printing this deck already brings, and a ring is invisible to a screen reader.
        aria-pressed={current}
        // **The whole accessible name, spelled rather than composed.** The two captions under
        // this button are siblings of it, so they are not in its name — which is deliberate:
        // a name assembled from flex children runs its words together when a `gap` separates
        // them, and 97 buttons all announcing "Treasure" is the collection wall's shipped
        // duplicate-name bug a second time. Every term a reader would use to tell two of these
        // apart is in here instead.
        aria-label={
          printing.artist === null
            ? `${tokenName} — ${label}`
            : `${tokenName} — ${label}, art by ${printing.artist}`
        }
        // The button *is* the frame and the frame clips its own corners, so an outline standing
        // off its edge is painted entirely in the clipped region and is never seen.
        className={cn("block w-full rounded-lg", FOCUS_INSET)}
      >
        <CardArt
          cardId={printing.id}
          // The `alt`, and the fallback's own line — a frame with no picture still names its
          // token, which is what keeps a rate-limited screen a list of cards rather than a wall
          // of broken images.
          name={tokenName}
          // The whole printed frame at 672×936, `CardArt`'s own default and every other wall's.
          // A token *is* its art — there is no `art` crop worth taking, and the printed frame
          // carries the illustrator credit Scryfall's image policy asks for wherever a bare crop
          // would have owed one.
          variant={WALL_CARD_VARIANT}
          // The web build's only picture; ignored on desktop, where the local cache wins.
          imageUrl={printing.imageUris?.[WALL_CARD_VARIANT]}
          // Gold means "this is the one" everywhere else in this app, and this frame already
          // draws it — `CardArt`'s own `selected` recipe rather than a second ring spelled here.
          selected={current}
          // This wall is not virtualised: every printing of the token is mounted at once, so the
          // browser's own gate is the only thing bounding what 97 tiles ask for.
          loading="lazy"
        />
      </button>
      {/* Two elements, never one line with a separator in it. They are outside the button, so
          neither is in its accessible name and neither can be run together with the other. */}
      <p className="mt-1 truncate text-[0.6875rem] text-dim">{label}</p>
      {printing.artist !== null && (
        <p className="truncate text-[0.6875rem] text-dim">{printing.artist}</p>
      )}
    </>
  );
}
