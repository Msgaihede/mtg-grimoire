/**
 * The printing picker behind the Tokens & Emblems band and the views' token pile — **one dialog,
 * two jobs** (token stacks spec §4.6).
 *
 * - **`swap`** — a press on one entry's picture: which printing and finish *that entry* should
 *   be. The host swaps that entry and no other (rule 4), so a Treasure the reader keeps in two
 *   printings changes one of them.
 * - **`add`** — the band's **Add printing**: the printings of every token the deck has, behind a
 *   search box, and a press adds that printing at one copy (rule 5). **`All tokens`** beside the
 *   box (managed tokens spec §3.6) swaps them for every token in the game, and a pick of one the
 *   deck does not make adds it by hand.
 *
 * **The grain is the printing _and_ the finish**, which is the collection wall's own grain and
 * for its reason: a foil and a plain copy of one printing are two objects at two prices sharing a
 * set and a number, and an entry is one of them (`deck_token_printings` is keyed on
 * `(deck, list, card, finish)`). So a printing sold in two finishes is **two tiles**, nonfoil
 * first, keyed through `tileKeyOf` exactly as the collection's are; the foil one wears
 * `FoilOverlay`'s sheen and says its finish in its foot, and each quotes the price at its own
 * finish. A press hands the host `{ cardId, finish }` and nothing else.
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
import { memo, useDeferredValue, useId, useMemo, useState, type JSX } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CardArt } from "@/components/CardArt";
import { CardChin } from "@/components/CardChin";
import { Dialog } from "@/components/Dialog";
import { FILTER_FIELD, ToggleChip } from "@/components/FilterChips";
import { atLeast, cardScaleVars, chinHeight } from "@/lib/cardZoom";
import { count } from "@/lib/counts";
import { FINISH_LABEL, FINISHES, parseFinishes, type Finish } from "@/lib/finish";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { WALL_CARD_VARIANT } from "@/lib/images";
import { ipc, ipcError, type Printing, type TokenPrinting } from "@/lib/ipc";
import type { Currency, MarketplaceId } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { tileKeyOf } from "@/lib/tileKey";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { stackCardWidth } from "./CardStack";
import { tokenSubtitle, type DeckTokenView } from "./deckTokens";

/**
 * The wall's gutters at 100% zoom — `gap-x-2.5` and `gap-y-3`, the numbers this dialog shipped
 * with, through {@link atLeast} for `DeckTokensPanel`'s reason: a gutter is space **between**
 * cards rather than chrome **on** one, so it grows with the tiles and holds at its base going
 * down.
 */
const TILE_GAP_X = 10;
const TILE_GAP_Y = 12;

/**
 * The one line that stands in for the wall — in flight, refused, or nothing to offer.
 *
 * **`Dialog` draws no padding around a body and says so**, so each of these was flush against the
 * panel's own edge. That was merely tight in a `w-[52rem]` panel and reads as unplaced in one
 * sized off the window, so the three take the header's own `px-5` and the vertical rhythm every
 * other dialog body in this folder uses. It is a class rather than three spellings because the
 * three are one sentence in three moods, and a fourth state must not have to rediscover it.
 */
const STATE_LINE = "px-5 pb-6 pt-4 text-sm";

/**
 * The scroller every wall here sits in — the dialog's one growing box.
 *
 * **`min-h-0 flex-1` rather than a `max-h` in rem**, which is what `Dialog`'s own doc asks a body
 * for and what the panel's `max-h` needs to bind against: a 26rem ceiling is 416px, and one tile
 * at 2× is 420 wide and 588 tall, so a fixed box would be shorter than a single row of what it is
 * drawn to hold. **`relative`** because a scroll container has to be the containing block for its
 * own positioned content (`src/CLAUDE.md`). The side padding is the header's `px-5`, so the
 * tiles, the add picker's token headings and the dialog's title share one left edge — and it is
 * room enough for the current tile's `ring-2`, which stands outside the frame.
 */
const WALL_SCROLLER = "relative min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3";

/** What a press hands the host: one printing in one finish — an entry's `(card_id, finish)`. */
export interface TokenPick {
  cardId: string;
  finish: Finish;
}

/**
 * Which of the two jobs the dialog is open for — or, as `null` on the props, that it is shut.
 *
 * **`swap` carries the entry as a view rather than an id**, because every string the dialog sets
 * in type is already on it: the name it is titled by, the {@link DeckTokenView.subtitle} that
 * says *which* Wurm, and the `(printingId, finish)` pair a tile is marked current by. The host
 * looks it up afresh on every render by `entryKey` (`DeckEditor`'s `pickingToken`), so a wall
 * re-derived after a write is never answered about with a frozen copy.
 *
 * **`add` carries the tokens on the wall** — one view per *entry*, so a Treasure kept in two
 * printings arrives twice. The picker reads each token once, in the order it is handed.
 */
export type TokenPickerMode =
  | { kind: "swap"; entry: DeckTokenView }
  | { kind: "add"; tokens: readonly DeckTokenView[] };

export interface TokenArtPickerProps {
  /** Which job, or `null` when the dialog is shut. See {@link TokenPickerMode}. */
  mode: TokenPickerMode | null;
  /**
   * How wide a token is drawn — `cardZoom.deck`, read once by the host and handed straight
   * through.
   *
   * **This wall and the one behind the scrim have to agree, and that is the whole reason the
   * prop exists.** A reader who presses a tile has to meet the same picture at the same size, or
   * the swap does not read as a swap. It was a shared 150px constant until 2026-09-08, when the
   * wall took the stacked card's own width at the desk's zoom; a constant left here would have
   * been the two walls agreeing at exactly one stop of a sixteen-stop ladder.
   *
   * The dialog is `AllPrintingsDialog`'s width for it — 75vw between a 64rem floor and the
   * window — because a 420px tile in the old `w-[52rem]` panel is one printing per row, and
   * Treasure answers 97 of them.
   */
  zoom: number;
  /**
   * A tile was pressed. The host writes it — a swap of the one entry in `swap`, an added printing
   * in `add` — and this dialog knows nothing about either command.
   */
  onPick: (to: TokenPick) => void;
  /** Escape and the ✕: close, and hand the caret back to the control that opened this. */
  onDismiss: () => void;
  /** An outside click: close and move no focus — the reader is already somewhere else. */
  onClose: () => void;
}

/**
 * The picker.
 *
 * **Open is `mode !== null`** rather than a flag beside it, so there is one fact and not two
 * that have to agree. `Dialog` mounts nothing while it is shut, and during the exit fade
 * `AnimatePresence` holds the element tree from the last render in which it was open — so the
 * bodies below never see a `null` mode they would have to guard a second time.
 */
export function TokenArtPicker({
  mode,
  zoom,
  onPick,
  onDismiss,
  onClose,
}: TokenArtPickerProps): JSX.Element {
  return (
    <Dialog
      open={mode !== null}
      // `swap` is named for the thing being changed rather than for the act: the ✕ and Escape
      // both say "close", and a heading that repeated the verb would leave the token's own name —
      // the one word telling this dialog from the next one — as the smallest thing on the header.
      // `add` has no one token to be named for, so it is named for the act, in the button's own
      // words.
      title={mode === null ? "" : mode.kind === "swap" ? `Art for ${mode.entry.name}` : "Add a printing"}
      // The disambiguator, where there is one. A deck holding Wurmcoil Engine opens two of these
      // and the heading is `Art for Wurm` both times; this line is the whole of what tells the
      // reader which of the two they pressed.
      subtitle={
        mode?.kind === "swap"
          ? (mode.entry.subtitle ?? undefined)
          : mode?.kind === "add"
            ? "Add one copy of any token or emblem this deck makes. Turn on All tokens to search every token."
            : undefined
      }
      closeLabel="Close"
      // **`AllPrintingsDialog`'s three numbers, verbatim, and the reason is the same one it
      // gives**: this is a grid to pick out of rather than a form or a list, so its width is a
      // proportion of the window with a floor and a ceiling either side, and its height is
      // spelled because the body is a wall rather than a form. Read that file for the whole
      // argument — 75vw, floored at the app's own 1024px window floor and ceilinged at the
      // column the shell reserves, then `min(100%, 90vh)` so 5vh of glass either side keeps the
      // modal floating.
      size="w-[min(100%,max(64rem,75vw))] max-h-[min(100%,90vh)]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      {/* Keyed by the job, so a search typed while adding never survives into a swap. */}
      {mode?.kind === "swap" && (
        <SwapBody key="swap" entry={mode.entry} zoom={zoom} onPick={onPick} />
      )}
      {mode?.kind === "add" && (
        <AddBody key="add" tokens={mode.tokens} zoom={zoom} onPick={onPick} />
      )}
    </Dialog>
  );
}

/**
 * The printings of one token's paper printings — **the card modal's key and page size
 * verbatim**, so the picker shares that cache entry rather than opening a second one: absent
 * `limit` is `MAX_PRINTINGS` (400), far past the most-printed token in the game — Treasure's 97.
 *
 * **The marketplace is in the key because the command takes one and the wall now spends it**: a
 * tile's foot quotes its finish's price, `finishPrices` at the marketplace asked for, so two
 * marketplaces are two answers and a switch refetches rather than relabelling one feed's numbers.
 */
function printingsQuery(oracleId: string, marketplaceId: MarketplaceId) {
  return {
    queryKey: ["card", "printings", oracleId, marketplaceId] as const,
    queryFn: () => ipc.cardPrintings(oracleId, marketplaceId),
  };
}

/** One tile's worth: a printing, one finish it is sold in, and the key the two make. */
interface PrintingTileData {
  key: string;
  printing: Printing;
  finish: Finish;
}

/**
 * Every printing as one tile **per finish it is sold in** — the picker's grain.
 *
 * In `FINISHES`' order — nonfoil, foil, etched — and not the column's: Scryfall writes the array
 * in whatever order it likes, and a wall whose plain copy sat after its foil on one printing and
 * before it on the next would read as two orders. That order is one of `src/lib/options.ts`'
 * exemptions — a printing's finishes, plain before the premium treatments.
 *
 * **A printing that lists no finish this build can name is drawn once, as nonfoil**, rather than
 * dropped. Every token printing in the corpus lists at least one, so this is the floor rather
 * than a case; and a printing missing from the wall would be one the reader could not pick at
 * all, where a plain tile is what the backend's own default resolves to anyway.
 */
function printingTiles(printings: readonly Printing[]): PrintingTileData[] {
  return printings.flatMap((printing) => {
    const listed = parseFinishes(printing.finishes);
    const finishes = FINISHES.filter((finish) => listed.includes(finish));
    return (finishes.length === 0 ? (["nonfoil"] as const) : finishes).map((finish) => ({
      key: tileKeyOf(printing.id, finish),
      printing,
      finish,
    }));
  });
}

/**
 * `swap`: one token's printings, the entry's own tile marked current.
 *
 * Its own component so the four states one round trip has — in flight, refused, nothing to
 * offer, and the pictures — are four branches side by side rather than four conditions threaded
 * through the dialog's body. `DeckCoverPicker`'s `SearchResults` is the same split for the same
 * reason.
 */
function SwapBody({
  entry,
  zoom,
  onPick,
}: {
  entry: DeckTokenView;
  /** `cardZoom.deck` — see {@link TokenArtPickerProps.zoom}. */
  zoom: number;
  onPick: (to: TokenPick) => void;
}) {
  const { marketplace } = useMarketplace();
  const query = useQuery(printingsQuery(entry.oracleId, marketplace.id));

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const failure = query.isError ? ipcError(query.error) : null;

  if (failure !== null) {
    return (
      <p role="alert" className={cn(STATE_LINE, "text-destructive")}>
        Couldn&rsquo;t load this token&rsquo;s printings — {failure}
      </p>
    );
  }

  if (query.isPending) {
    return <p className={cn(STATE_LINE, "text-dim")}>Loading printings…</p>;
  }

  if (items.length === 0) {
    // Reachable and not hypothetical: 3 or 4 of the corpus's referenced token printings resolve
    // to no local row (spec §2), and a token added by hand can outlive a sync that dropped it.
    // It says what is true rather than claiming a failure — the read succeeded and answered
    // nothing.
    return (
      <p className={cn(STATE_LINE, "text-dim")}>
        No paper printings found for this token.
      </p>
    );
  }

  return (
    <div className={WALL_SCROLLER}>
      <PrintingWall
        tiles={printingTiles(items)}
        tokenName={entry.name}
        zoom={zoom}
        currency={marketplace.currency}
        // **Current by the pair, never by the card.** An entry is a printing *in a finish*, so
        // the foil copy of a printing marks the foil tile and leaves the plain one of the same
        // picture unpressed — the ring on both would say the deck brings two objects it does not.
        isCurrent={(tile) => tile.printing.id === entry.printingId && tile.finish === entry.finish}
        onPick={onPick}
      />
      <Truncation shown={items.length} total={total} />
    </div>
  );
}

/**
 * `add`: the printings of every token the deck has, grouped by token, behind a search box.
 *
 * **One read per token, and each is the card modal's own cache entry** ({@link printingsQuery}),
 * through `useQueries` — so a reader who has just swapped a Treasure's art opens this with
 * Treasure's printings already in hand. The tokens arrive one view per *entry*, so they are folded
 * to one per `oracleId` first; two Treasure entries are one token and one read.
 *
 * **Grouped under each token's name and subtitle**, because the whole wall is several tokens'
 * worth of pictures and a token's name does not identify it — `Wurmcoil Engine` makes two
 * `Wurm`s, and two runs of Wurm pictures with nothing between them would be one wall of
 * indistinguishable choices.
 *
 * **The search box matches a token's name or a printing's set code**, the two things a reader
 * holding a box of tokens can read off one. A name hit keeps every printing of that token; a set
 * hit keeps the printings from that set, across every token.
 *
 * **`All tokens`, beside the box, swaps the deck's tokens for every token in the game** (managed
 * tokens spec §3.6) — {@link EveryTokenWall}, one read of `token_printings` behind the same box
 * and the same grouping. **Off by default and held here**, so every open starts on the deck's own
 * tokens (the dialog mounts this body afresh each time), and a search typed in one state narrows
 * the other when the reader flips it — one box, one question. **On from the start where the deck
 * has no token of its own** (fix round 1): the band offers Add printing on a deck that makes
 * nothing, and the deck's own wall would open there on a sentence and a toggle to go and find.
 */
function AddBody({
  tokens,
  zoom,
  onPick,
}: {
  tokens: readonly DeckTokenView[];
  zoom: number;
  onPick: (to: TokenPick) => void;
}) {
  const findId = useId();
  const [find, setFind] = useState("");
  /**
   * **The box's text as the wall reads it — a beat behind the box, on purpose** (2026-09-28).
   *
   * The live pass measured a keystroke at **816–1,152 ms** with `All tokens` on over the debug
   * corpus's whole wall (4,863 tiles): the box's own state lived here, so every key re-rendered
   * the wall in the same urgent render that drew the letter, and the letter waited for it. Now
   * the urgent render draws the box and hands both walls the text they already had — they are
   * `memo`, so they bail out there — and the wall narrows in a background render React drops the
   * moment the next key lands. The box answers at the speed of typing; the wall catches up.
   */
  const wallFind = useDeferredValue(find);
  // Read once, at mount: the body is keyed and mounted afresh per open, and a deck gaining its
  // first token while the dialog is up must not flip the wall under the reader's pointer.
  const [everyToken, setEveryToken] = useState(() => tokens.length === 0);

  return (
    <>
      {/* The box sits above the scroller rather than in it, so it stays where the caret is while
          the wall under it scrolls — `NoteCardsDialog`'s arrangement, and its sr-only label for
          the same reason: the placeholder says what to type, the label says what the box is.
          `All tokens` shares its row, at the far end: it is a second answer to the question the
          box asks — *which* tokens — so it sits beside it rather than above the wall. `flex-wrap`
          for the narrowest window the dialog is drawn in. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5 py-3">
        <label htmlFor={findId} className="sr-only">
          Find a printing by token name or set code
        </label>
        <input
          id={findId}
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Token name or set code…"
          className={cn(
            FILTER_FIELD,
            FOCUS,
            "min-w-0 flex-1 basis-48 border-border bg-surface px-3 placeholder:text-dim focus:border-accent",
          )}
        />
        {/* `ToggleChip`, the app's pressed-or-not chip — `aria-pressed`, so the state is a fact a
            screen reader hears, and the one shape every other "widen the list" switch here
            takes. */}
        <ToggleChip
          label="All tokens"
          pressed={everyToken}
          onClick={() => setEveryToken(!everyToken)}
        />
      </div>

      {everyToken ? (
        <EveryTokenWall find={wallFind} zoom={zoom} onPick={onPick} />
      ) : (
        <DeckTokensWall tokens={tokens} find={wallFind} zoom={zoom} onPick={onPick} />
      )}
    </>
  );
}

/**
 * The deck's own tokens, grouped — Add printing's wall with `All tokens` off, which is the wall it
 * always was: one `card_printings` read per token, each the card modal's own cache entry. Split
 * out of {@link AddBody} only so the toggle can swap it for {@link EveryTokenWall}; every state
 * and every sentence is the one it had. `memo` for {@link AddBody}'s `wallFind`: the urgent
 * render of a keystroke hands it the text it already has, and it bails out.
 */
const DeckTokensWall = memo(function DeckTokensWall({
  tokens,
  find,
  zoom,
  onPick,
}: {
  tokens: readonly DeckTokenView[];
  /** The box's text, a beat behind the box — narrowed here by a token's name or a printing's
   *  set code. */
  find: string;
  zoom: number;
  onPick: (to: TokenPick) => void;
}) {
  const { marketplace } = useMarketplace();

  /** The tokens, one view per `oracleId`, in the order they were handed — the wall's order. */
  const distinct = useMemo(() => {
    const seen = new Set<string>();
    return tokens.filter((view) => {
      if (seen.has(view.oracleId)) return false;
      seen.add(view.oracleId);
      return true;
    });
  }, [tokens]);

  const reads = useQueries({
    queries: distinct.map((view) => printingsQuery(view.oracleId, marketplace.id)),
  });

  const needle = find.trim().toLowerCase();
  const groups = distinct.map((token, i) => {
    const read = reads[i];
    const nameHit = needle === "" || token.name.toLowerCase().includes(needle);
    const tiles = printingTiles(read?.data?.items ?? []).filter(
      (tile) => nameHit || tile.printing.setCode.toLowerCase().includes(needle),
    );
    return { token, read, tiles };
  });
  const failures = groups.filter((group) => group.read?.isError === true);
  const pending = reads.some((read) => read.isPending);
  const shown = groups.filter((group) => group.tiles.length > 0);

  return (
    <>
      {/* A token whose printings could not be read says so by name, above whatever the others
          answered — one refused read must not take the rest of the wall with it. */}
      {failures.map(({ token, read }) => (
        <p
          key={token.oracleId}
          role="alert"
          className="shrink-0 px-5 pt-3 text-xs text-destructive"
        >
          Couldn&rsquo;t load the printings of {token.name} — {ipcError(read?.error)}
        </p>
      ))}

      {distinct.length === 0 ? (
        <p className={cn(STATE_LINE, "text-dim")}>
          This deck doesn&rsquo;t make any tokens or emblems.
        </p>
      ) : pending ? (
        <p className={cn(STATE_LINE, "text-dim")}>Loading printings…</p>
      ) : shown.length === 0 && failures.length < distinct.length ? (
        <p className={cn(STATE_LINE, "text-dim")}>
          {needle === ""
            ? "No paper printings found for these tokens."
            : `No printing matches “${find.trim()}”. Search by token name or set code.`}
        </p>
      ) : (
        <div className={cn(WALL_SCROLLER, "space-y-5")}>
          {shown.map(({ token, read, tiles }) => {
            // The list's name, spelled whole: the heading and the subtitle are two elements, and
            // a name computed from two flex children runs their words together.
            const tokenLabel =
              token.subtitle === null ? token.name : `${token.name}, ${token.subtitle}`;
            return (
              <div key={token.oracleId}>
                <h3 className="text-sm text-text">{token.name}</h3>
                {/* The disambiguator, unclamped: it is the line that tells two Wurms apart. */}
                {token.subtitle !== null && (
                  <p className="text-xs leading-snug text-dim">{token.subtitle}</p>
                )}
                <PrintingWall
                  className="mt-2"
                  label={tokenLabel}
                  tiles={tiles}
                  tokenName={token.name}
                  zoom={zoom}
                  currency={marketplace.currency}
                  onPick={onPick}
                />
                {needle === "" && (
                  <Truncation shown={read?.data?.items.length ?? 0} total={read?.data?.total ?? 0} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
});

/**
 * **How tall one token's group is drawn before the browser has laid it out** — the heading and
 * the subtitle, one row of tiles at this zoom, the tile's foot and its artist line — which is
 * what `contain-intrinsic-size` holds an off-screen group at (see {@link EveryTokenWall}).
 *
 * An estimate and only that: a group that wraps to a second row, or a subtitle that runs to two
 * lines, lays itself out at its real height the moment it comes near the viewport, and the
 * `auto` keyword keeps that height once it has been measured. What the number has to be is
 * *close*, so the scrollbar's thumb is roughly the size of the list it stands for and a reader
 * dragging it lands near where they aimed.
 */
function groupRowHeight(zoom: number): number {
  // 48 is the heading, the subtitle's line and the `mt-2` above the wall; 18 × zoom the artist
  // line under a tile, scaled as that line's type is. The picture is `CardArt`'s 5:7.
  return 48 + Math.round((stackCardWidth(zoom) * 7) / 5) + chinHeight(zoom) + Math.round(18 * zoom);
}

/** One token of {@link EveryTokenWall}: its facts off its first printing, its printings, and
 *  every tile they make — built once per answer, so an unnarrowed group hands the same list on. */
interface EveryTokenGroup {
  first: TokenPrinting;
  printings: TokenPrinting[];
  tiles: PrintingTileData[];
}

/**
 * **Every token in the game** — Add printing with `All tokens` on (managed tokens spec §3.6).
 *
 * **One read of `token_printings`**, keyed `["tokenPrintings", marketplace]` because every tile's
 * foot quotes a price at that marketplace, and read only while this wall is mounted: the command
 * is a scan of the corpus behind a press, never a keystroke, and the box narrows the answer in
 * hand. The rows arrive in the crate's order — name, then oracle id, then newest first — and are
 * grouped by **`oracleId`**, never the name, under the token's name and `tokenSubtitle`, because
 * the whole game's tokens include pairs a name cannot tell apart (`Wurmcoil Engine`'s two
 * `Wurm`s). Every printing is a tile in every finish it is sold in, exactly as on the deck's own
 * wall, and a pick is the same `{ cardId, finish }`.
 *
 * **Kept responsive at the corpus's size in two moves, each measured** (Storybook frame, headless
 * Edge 154, 1280×800, the development build of React, 3 245 printings over 1 078 tokens — the
 * `Decks/TokenArtPicker` `AllTokensAtScale` story):
 *
 * - **Every group is `content-visibility: auto`**, so a group off screen costs no layout and no
 *   paint — and its lazy pictures ask for nothing — until it is scrolled near, while it is still in
 *   the document for Find and for a screen reader's list of lists. `contain-intrinsic-size` holds
 *   each unlaid group at {@link groupRowHeight}, so the scrollbar describes a list of the right
 *   length. Measured press to paint: **1.8–2.0 s** with the property overridden off, **1.2–1.3 s**
 *   with it — layout was a third of the cost, and React's render of 3 245 tiles was the rest.
 * - **So the first frame draws the first groups and the rest follow** ({@link EveryTokenGroups}):
 *   React's `useDeferredValue` with an initial value renders {@link FIRST_PAINT_GROUPS} groups at
 *   once and the whole wall in a background render it may interrupt — a keystroke in the box, a
 *   press on a tile — rather than one block the reader waits on. The spec's bar is about a second
 *   to first paint in the shipped window, and a wall that misses it is virtualised; this is the
 *   cheaper answer, and the change's record has the figure it measured.
 *
 * **And a keystroke in the box costs the groups it changes, and none of the rest** (2026-09-28).
 * The live pass measured a keystroke over the debug corpus's full wall — 4,863 tiles — at
 * **816–1,152 ms**, because every key re-rendered every group and every tile in the urgent render
 * that drew the letter: the deferral below only ever deferred the *list*, and the groups it drew
 * were not memoised, so even the stale list was drawn again in full. Three moves, one reason:
 * {@link AddBody} hands this wall the box's text through `useDeferredValue` and this wall is
 * `memo`, so the urgent render stops at the box; each group's tiles are built once per answer, and
 * a group the box leaves whole hands on that same list; and a group is {@link EveryTokenGroupItem},
 * `memo` over that list, so the background render redraws only the groups whose tiles changed.
 */
const EveryTokenWall = memo(function EveryTokenWall({
  find,
  zoom,
  onPick,
}: {
  /** The box's text, a beat behind the box — {@link AddBody}'s `wallFind`. */
  find: string;
  zoom: number;
  onPick: (to: TokenPick) => void;
}) {
  const { marketplace } = useMarketplace();
  const query = useQuery({
    queryKey: ["tokenPrintings", marketplace.id],
    queryFn: () => ipc.tokenPrintings(marketplace.id),
  });

  /** The answer grouped by token, in the order it arrived, each group's tiles made once —
   *  memoised on the answer, because a keystroke in the box re-renders this wall and the grouping
   *  is the same every time. */
  const groups = useMemo(() => {
    const byToken = new Map<string, { first: TokenPrinting; printings: TokenPrinting[] }>();
    for (const printing of query.data ?? []) {
      const group = byToken.get(printing.oracleId);
      if (group === undefined) byToken.set(printing.oracleId, { first: printing, printings: [printing] });
      else group.printings.push(printing);
    }
    return [...byToken.values()].map(
      (group): EveryTokenGroup => ({ ...group, tiles: printingTiles(group.printings) }),
    );
  }, [query.data]);

  const needle = find.trim().toLowerCase();
  /**
   * What the box leaves — memoised, so the deferred render below compares one answer with the
   * last by identity rather than seeing a new list on every render.
   *
   * **A group the box leaves whole hands on the tiles it was built with** — a name hit, and a set
   * search every printing of the token matches — so its {@link EveryTokenGroupItem} is handed the
   * list it already drew and skips. A set search narrows the tiles rather than the printings, which
   * is the same answer: a tile is a printing in a finish, and the finish does not change its set.
   */
  const shown = useMemo(
    () =>
      groups
        .map(({ first, tiles }): ShownTokenGroup => {
          if (needle === "" || first.name.toLowerCase().includes(needle)) return { first, tiles };
          const hits = tiles.filter((tile) => tile.printing.setCode.toLowerCase().includes(needle));
          return { first, tiles: hits.length === tiles.length ? tiles : hits };
        })
        .filter((group) => group.tiles.length > 0),
    [groups, needle],
  );

  if (query.isError) {
    return (
      <p role="alert" className={cn(STATE_LINE, "text-destructive")}>
        Couldn&rsquo;t load all token printings — {ipcError(query.error)}
      </p>
    );
  }
  if (query.isPending) {
    return <p className={cn(STATE_LINE, "text-dim")}>Loading tokens…</p>;
  }
  if (shown.length === 0) {
    return (
      <p className={cn(STATE_LINE, "text-dim")}>
        {needle === ""
          ? "No tokens or emblems in your card data yet."
          : `No printing matches “${find.trim()}”. Search by token name or set code.`}
      </p>
    );
  }
  return (
    <EveryTokenGroups
      shown={shown}
      zoom={zoom}
      currency={marketplace.currency}
      onPick={onPick}
    />
  );
});

/**
 * **How many groups the first frame draws** — comfortably more than a window shows at the smallest
 * zoom (a group is one row of tiles, so a 1080-tall panel holds under a dozen at 0.5×), few enough
 * that the frame is a handful of milliseconds rather than a thousand groups' worth.
 */
const FIRST_PAINT_GROUPS = 24;

/** One group of {@link EveryTokenWall}, as the box has narrowed it. */
interface ShownTokenGroup {
  first: TokenPrinting;
  tiles: PrintingTileData[];
}

/**
 * The every-token wall's groups — **the first {@link FIRST_PAINT_GROUPS} at once, the rest in a
 * background render** (see {@link EveryTokenWall}'s measurements).
 *
 * `useDeferredValue(shown, head)` renders `head` on mount and then `shown` at a priority React may
 * interrupt, which is also what keeps a keystroke in the box answered at once: a narrowed list is
 * a new `shown`, and the one on screen stays until the new one has rendered behind it. A component
 * of its own so it **mounts with the answer in hand** — the deferral's initial value is a mount's,
 * and mounted during the read it would defer the empty list and draw every group at once when the
 * answer landed.
 */
function EveryTokenGroups({
  shown,
  zoom,
  currency,
  onPick,
}: {
  shown: readonly ShownTokenGroup[];
  zoom: number;
  currency: Currency;
  onPick: (to: TokenPick) => void;
}) {
  const head = useMemo(() => shown.slice(0, FIRST_PAINT_GROUPS), [shown]);
  const drawn = useDeferredValue(shown, head);
  const intrinsic = `auto ${groupRowHeight(zoom)}px`;
  return (
    <div className={cn(WALL_SCROLLER, "space-y-5")}>
      {drawn.map(({ first, tiles }) => (
        <EveryTokenGroupItem
          key={first.oracleId}
          first={first}
          tiles={tiles}
          intrinsic={intrinsic}
          zoom={zoom}
          currency={currency}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

/**
 * One token's group on the every-token wall — its name, its subtitle and its tiles.
 *
 * **`memo`, and every prop is a value or a stable reference**: `first` is the answer's own row,
 * `tiles` the list {@link EveryTokenWall} built once per answer and hands on while the box leaves
 * the group whole, and the rest are the wall's. So a keystroke redraws the groups whose tiles it
 * changed and skips the rest — a thousand comparisons rather than 4,863 tiles.
 */
const EveryTokenGroupItem = memo(function EveryTokenGroupItem({
  first,
  tiles,
  intrinsic,
  zoom,
  currency,
  onPick,
}: {
  first: TokenPrinting;
  tiles: readonly PrintingTileData[];
  /** `contain-intrinsic-size` — see {@link groupRowHeight}. */
  intrinsic: string;
  zoom: number;
  currency: Currency;
  onPick: (to: TokenPick) => void;
}) {
  // `tokenSubtitle` reads the same facts a deck's token row carries, and the read's row carries
  // every one of them — the type line and the printing's layout included.
  const subtitle = tokenSubtitle(first);
  const label = subtitle === null ? first.name : `${first.name}, ${subtitle}`;
  return (
    <div style={{ contentVisibility: "auto", containIntrinsicSize: intrinsic }}>
      <h3 className="text-sm text-text">{first.name}</h3>
      {subtitle !== null && <p className="text-xs leading-snug text-dim">{subtitle}</p>}
      <PrintingWall
        className="mt-2"
        label={label}
        tiles={tiles}
        tokenName={first.name}
        zoom={zoom}
        currency={currency}
        onPick={onPick}
      />
    </div>
  );
});

/**
 * One run of tiles — a token's printings, one tile per printing per finish.
 *
 * The gutters are inline because a scaled number cannot be a class — Tailwind scans source text
 * for whole class names, so an interpolated one emits no rule at all. The tiles wrap, so nothing
 * here can scroll sideways, which is the other half of the modal's clamp.
 */
function PrintingWall({
  tiles,
  tokenName,
  zoom,
  currency,
  isCurrent,
  onPick,
  label,
  className,
}: {
  tiles: readonly PrintingTileData[];
  tokenName: string;
  zoom: number;
  currency: Currency;
  /**
   * Which tile is the entry being swapped — `swap` only. **Absent in `add`**, where a press adds
   * rather than toggles, so no tile carries `aria-pressed` at all: `false` on every one would
   * announce ninety-seven toggles that are all off.
   */
  isCurrent?: (tile: PrintingTileData) => boolean;
  onPick: (to: TokenPick) => void;
  /** The list's accessible name, where one wall is one of several. */
  label?: string;
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn("flex flex-wrap content-start", className)}
      style={{ columnGap: atLeast(TILE_GAP_X, zoom), rowGap: atLeast(TILE_GAP_Y, zoom) }}
    >
      {tiles.map((tile) => (
        // `cardScaleVars` here rather than inside the tile, because the tile is a fragment — the
        // art and its foot and the credit are siblings, so the `<li>` is the one box above all
        // three. The foot and the credit read `--mark-scale` off it.
        <li key={tile.key} style={{ width: stackCardWidth(zoom), ...cardScaleVars(zoom) }}>
          <PrintingTile
            tile={tile}
            tokenName={tokenName}
            zoom={zoom}
            currency={currency}
            current={isCurrent?.(tile)}
            onPick={() => onPick({ cardId: tile.printing.id, finish: tile.finish })}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Said only when it is true, which for a token it never is today: 400 is the page and Treasure's
 * 97 is the longest list in the game. It is here because the page size is a promise the backend
 * makes and not one this file can keep — `list_printings` clamps, and a wall that silently drew
 * the newest 400 of a longer list would read as an answer.
 */
function Truncation({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="pt-2 text-[0.6875rem] text-dim">
      Showing {shown} of {count(total)} printings.
    </p>
  );
}

/**
 * One printing, in one finish, offered as a token's picture.
 *
 * **The art and its foot are `CardGrid`'s tile**: `CardArt` with the finish it *is* — the sheen
 * and the chip for foil and etched, nothing for nonfoil, which is the finish a price is assumed to
 * be — and `CardChin` under it at `seam="art"`, the one definition of a card's foot in this app:
 * the rarity, `SET · number`, the finish's mark and the price at that finish. The foot is a
 * sibling of the button, so its facts are announced rather than swallowed by the button's name.
 */
function PrintingTile({
  tile,
  tokenName,
  zoom,
  currency,
  current,
  onPick,
}: {
  tile: PrintingTileData;
  /** The token's own name — the frame's `alt`, and what the button is named by. */
  tokenName: string;
  zoom: number;
  currency: Currency;
  /** `undefined` in `add`: see {@link PrintingWall}'s `isCurrent`. */
  current: boolean | undefined;
  onPick: () => void;
}) {
  const { printing, finish } = tile;

  /** `TMOM · 12 · 2023` — what a reader tells two pictures of one token apart by. */
  const label = [
    printing.setCode.toUpperCase(),
    printing.collectorNumber,
    ...(printing.releasedAt === null ? [] : [printing.releasedAt.slice(0, 4)]),
  ].join(" · ");

  /**
   * **The whole accessible name, spelled rather than composed.** The foot and the credit under
   * this button are siblings of it, so they are not in its name — which is deliberate: a name
   * assembled from flex children runs its words together when a `gap` separates them, and 97
   * buttons all announcing "Treasure" is the collection wall's shipped duplicate-name bug a second
   * time. Every term a reader would use to tell two of these apart is in here instead — **the
   * finish included, on every tile**: two tiles over one picture are the plain and the foil copy,
   * and only the word tells them apart to a reader who cannot see the sheen. A printing in a
   * language other than English says so, since `card_printings` lists every language and two of
   * them share a set and a number.
   */
  const name = [
    `${tokenName} — ${label}`,
    ...(printing.lang === "en" ? [] : [printing.lang.toUpperCase()]),
    FINISH_LABEL[finish],
    ...(printing.artist === null ? [] : [`art by ${printing.artist}`]),
  ].join(", ");

  return (
    <>
      {/* The ring goes round the art **and** its foot as one object, which is `CardGrid`'s own
          arrangement: on the frame alone it would stop 28px above the foot's edge. */}
      <div className={cn("rounded-lg", current === true && "ring-2 ring-accent")}>
        <button
          type="button"
          onClick={onPick}
          // The state, not a decoration: the gold ring above is the only other thing saying
          // which printing this entry already is, and a ring is invisible to a screen reader.
          aria-pressed={current}
          aria-label={name}
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
            // The finish this tile **is**. `nonfoil` is not a mark: `CardArt` gates its chip on a
            // non-null finish and `FinishMark` draws nothing for a plain copy, so handing the
            // word through would paint the chip's felt with nothing in it — the collection page's
            // `finishMarkOf` rule.
            finish={finish === "nonfoil" ? null : finish}
            // This wall is not virtualised: every printing of the token is mounted at once, so the
            // browser's own gate is the only thing bounding what 97 tiles ask for.
            loading="lazy"
          />
        </button>
        <CardChin
          zoom={zoom}
          rarity={printing.rarity}
          setCode={printing.setCode}
          collectorNumber={printing.collectorNumber}
          // The code is what fits; the set's name is one hover away, as on every card's foot.
          printingTitle={
            printing.setName === null ? null : `${printing.setName} · #${printing.collectorNumber}`
          }
          finish={finish}
          // One copy **at this tile's finish**, at the marketplace the read was asked for — an em
          // dash where it quotes none, never another finish's or another marketplace's number.
          money={formatPrice(printing.finishPrices[finish], currency)}
          seam="art"
        />
      </div>
      {/* The illustrator, outside the ring and the button: it is a fact about the picture, and
          two printings of one token are most often told apart by who drew them. */}
      {printing.artist !== null && (
        <p className="mt-[calc(0.25rem*var(--mark-scale,1))] truncate text-[calc(0.6875rem*var(--mark-scale,1))] text-dim">
          {printing.artist}
        </p>
      )}
    </>
  );
}
