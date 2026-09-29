/**
 * The tokens and emblems this deck makes, as a band at the foot of the editor.
 *
 * **It draws what {@link useDeckTokens} concluded and decides nothing itself.** Which printing a
 * tile shows, how many copies the stepper starts at, which token nothing in the deck makes and
 * the order the wall reads in are all `deckTokens.ts`' answers, arrived at once for the whole
 * feature; this file is the arrangement of them. That is the same boundary the rest of the deck
 * builder keeps, and it is what lets a rule change be one edit rather than four components
 * disagreeing about a wall.
 *
 * **The band draws every token, the stacks draw the counted ones** (managed tokens, 2026-09-27,
 * spec §3.2). An untouched token reads 0 now, so this is where a token is found and counted in the
 * first place — the deck's tokens at whatever count, and every token added by hand, at 0
 * included, marked as one (§3.5) and with the Remove printing that takes it off the deck (§3.4).
 * The views' pile is the same list less every entry at 0.
 *
 * ## Four placement constraints, and each one has already cost something
 *
 * - **A `<section>`, never an `<aside>`.** A second complementary landmark broke five of
 *   `App.test.tsx`'s pane assertions without touching the pane — the Deck stats band's own
 *   comment records it (`DeckEditor.tsx`). A landmark is a promise about the page, and this block
 *   is not a complementary one.
 * - **`shrink-0` is mandatory.** The editor's root is the only box in it with a height, and
 *   `shrink-0` on the bands below the desk "is the whole of why this editor scrolls now". Without
 *   it this band is squeezed to nothing on a deck taller than the window, which is every deck the
 *   feature is for.
 * - **Below the price strip, and since 2026-09-08 _above_ the Deck stats band rather than under
 *   it.** The constraint that has teeth is the strip's, and it is unmoved: its drag-remove tray
 *   sits at `-top-3`, reaching up into the editor column's own `gap-3`, so the strip and the deck
 *   above it may not be separated — a band inserted between them would leave a reader dragging a
 *   card the height of four charts to reach the drop that removes it. This band is below that
 *   pair either way. What changed is which side of the charts it takes, and the reader's reason
 *   is that a token wall is a **list of cards** the deck is about to need, where the stats band
 *   is four charts read at a glance: the cards belong next to the cards. The old ordering was
 *   argued only as "under the stats is the far side of that pair and costs nothing", which was
 *   true and was never a reason to be there.
 * - **The heading is `Tokens & Emblems`, never bare `Tokens`.** `autoCategory.ts` already uses
 *   that word for an auto-category of cards that *make* tokens, driven by the
 *   `repeatable-token-generator` oracle tag — the opposite meaning of the same word — and the
 *   auto-category is deliberately not renamed, because renaming it would silently regroup every
 *   existing deck. So the two strings are kept apart instead.
 *
 * ## One read, one picker, two drawings
 *
 * **This band takes the {@link DeckTokens} answer as a prop and calls `useDeckTokens` nowhere**
 * (2026-09-24, issue #507). The views draw the same tokens a second time, inside whichever view is
 * on the desk, and the two drawings have to be one answer: a quantity stepped on the band is the
 * number the pile draws, and a printing picked from a pile is the picture the band draws.
 * `DeckEditor` therefore calls the hook **once** and hands the result to both, and it mounts the
 * **one** `TokenArtPicker` both of them open — so this band holds no picker and no `picking`
 * state. A tile's press is `onPick(view)` and the header's **Add printing** is `onAddPrinting()`,
 * both up to the host. Two hook calls would have been two write observers, and two pickers would
 * have been two dialogs free to disagree about which token they were for.
 *
 * ## One tile per entry, and a header on every deck
 *
 * **A tile is an _entry_ — one printing in one finish — since user schema v52** (token stacks
 * spec §4), so a Treasure the reader keeps as a plain and a foil copy is two tiles, keyed on
 * {@link DeckTokenView.entryKey} and never on the oracle id. Each tile's stepper writes its own
 * entry, its picture opens the picker on that entry alone, and its **Remove printing** deletes
 * that entry and no other — on every tile but an implicit one, which is not stored.
 *
 * **The header draws on every deck** — the heading, the count and Add printing. It carried the
 * deck's token mode until managed tokens (spec §3.9): with every token at 0 until the reader
 * counts it, there is nothing left for `Managed` or `Hide` to decide, and the column stays in the
 * schema with nothing reading it. Dismiss, its `Show dismissed` switch and **Reset printings** went
 * the same day (§3.3, §3.4): a token at 0 says "not this one", and Remove printing is Reset one
 * entry at a time.
 *
 * ## A tile is a stacked card, at the reader's own zoom
 *
 * **The wall draws at {@link stackCardWidth}(`cardZoom.deck`) and not at a constant of its own**
 * (2026-09-08). It was a flat 150px, and the argument for that was that a token wall is not a
 * zoom section, so importing either card wall's base would be importing a number that means *the
 * size before the reader's zoom* and using it as the size. Every word of that is still true of
 * the *base*; what it got wrong is the conclusion. `cardZoom.deck` is the desk's own number and
 * this band is on the desk — one editor, one deck, one size for the cards in it — so a reader who
 * sized their piles to fit the window met a row of tokens beside them at a size nobody had asked
 * for, fixed at every stop of the ladder.
 *
 * **`deck`, the same key `StackView` and `GridView` read**, which is the same argument those two
 * make about each other: Stacks and Grid are two drawings of one pile, and the tokens the pile
 * makes are a third thing on the same desk. What is emphatically *not* shared is `deckSearch` —
 * the docked column beside the desk — which is the split `cardZoom` holds a number per section
 * for at all.
 *
 * **It reads the number and does not attach `useCardZoomGesture`.** That hook registers its
 * element in a per-section map the zoom badge anchors itself off, one element per section, so a
 * second `deck` registration here would take the badge off the deck the reader is actually
 * zooming. Ctrl+wheel over this band therefore steps nothing, which is what it already did over
 * the stats band and the price strip beside it.
 *
 * **Everything on a tile scales with it, through `cardScaleVars`** — the app's rule for anything
 * drawn on a card, and here it reaches the stepper and the icon button beside it through
 * `--control-scale` with no prop threaded anywhere. The type is `calc(… * var(--mark-scale, 1))`
 * for the same reason: a 420px picture over an 11px caption at 2×, or a 105px one over the same
 * caption at 0.5×, is the tile disagreeing with itself. The **gutters** take {@link atLeast}
 * rather than `scaled`, which is `cardZoom.ts`' one surviving floor: a gutter measures space
 * *between* cards rather than chrome *on* one, and halving it at 0.5× is precisely the zoom a
 * reader chose in order to see more of them at once.
 *
 * ## A token's name does not identify it
 *
 * 104 token and emblem names are carried by more than one `oracle_id` (debug corpus,
 * 2026-09-07) — `Elemental` by 31, `Spirit` by 22, `Soldier` by 13 — and `Wurmcoil Engine` alone
 * puts two tokens both called `Wurm`, both 3/3, both colourless artifacts, on one deck's wall,
 * separated only by Deathtouch against Lifelink. Two tiles announcing one accessible name is a
 * bug that has already shipped here once, on the collection wall, where a 2X2 and an LEA
 * Lightning Bolt both announced *"Copies of Lightning Bolt"*; neither suite caught it, because
 * both names were **correct** and merely not unique.
 *
 * So every control on a tile folds {@link DeckTokenView.subtitle} into its own name, through
 * {@link tokenEntryName}, and every accessible name is spelled rather than assembled: two flex
 * children with a `gap` between them compute to a name with the words run together
 * (`"Missing2"`).
 *
 * **The tile draws no line of type for the name since issue #615** (2026-09-28). The picture is the
 * printed card and says it already, so the tile reads top to bottom as the card, the controls
 * across its full width, the subtitle under them, and where the token came from. The name is still
 * the first term of every control's accessible name — the ear is not the eye, and a stepper named
 * `Quantity of <subtitle>` would be no name at all.
 *
 * **Since v52 the subtitle is not enough either**, because one token is several tiles: the two
 * Treasures above share a name *and* a subtitle, and differ only in their printing and finish.
 * So `tokenEntryName` spells those too — `Quantity of Treasure, <subtitle>, TMOM · 12, Foil` — and
 * the foot under each picture draws them for the eye (`CardChin`, the same foot every wall of
 * cards draws). It is `deckTokens.ts`' and not this file's, because the pile in the four views
 * names the same entry and one entry must answer to one name on one screen.
 *
 * **The subtitle is clamped in CSS and never in the string.** A token's oracle text is the term
 * that separates the two Wurms, so a truncation short enough to fit a 150px tile would fold them
 * back together in exactly the case this exists for.
 */
import { useCallback, useId, useRef, type JSX } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { CardChin } from "@/components/CardChin";
import {
  QUANTITY_STEPPER_CARD_BOX,
  QUANTITY_STEPPER_CARD_ICON,
  QuantityStepper,
} from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { atLeast, cardScaleVars } from "@/lib/cardZoom";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { ipcError } from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { PRESS } from "@/lib/motion";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { stackCardWidth } from "./CardStack";
import { CountPill, tokenCountWords } from "./CountPill";
import { BOTTOM_LEFT_MARK } from "./DeckCardFace";
import {
  entryRef,
  isHandAdded,
  tokenArtName,
  tokenEntryName,
  type DeckTokenView,
  type TokenEntryRef,
} from "./deckTokens";
import { META_SUBMIT } from "./metaRows";
import { NotMadeByDeckMark } from "./NotMadeByDeckMark";
import {
  focusable,
  TOKEN_ADD_ATTR,
  TOKEN_ADD_MARK,
  TOKEN_ART_MARK,
  TOKEN_BAND_ATTR,
  TOKEN_REMOVE_MARK,
  tokenEntryProps,
  useRemoveCaret,
} from "./tokenCaret";
import type { DeckTokens } from "./useDeckTokens";

/**
 * The area's name, in one place because three things say it: the region's `aria-label`, the
 * disclosure's visible text, and every test and story that addresses either.
 *
 * **`&` rather than `and`**, which is the deck editor's own house style for a pair of nouns in a
 * heading (`Categories & labels`), and the ampersand is what a reader scans past.
 */
export const TOKENS_HEADING = "Tokens & Emblems";

/**
 * Whether the band's wall is on screen — the band open, over a read that answered at least one
 * row — and with it the one line that says a refused token write (`TokenWall`'s alert).
 *
 * **Exported because `DeckEditor` asks the same question and must get the same answer**: its
 * banner carries the token writes exactly while this is false, so a refusal is said once and never
 * nowhere. It keyed on `tokensOpen` alone until the fan-in of managed tokens, and that left one
 * press saying nothing anywhere: **Add printing on a deck that makes nothing** opens the band, so
 * the banner stood down — but a band with no row draws no wall, so a refused first add had no
 * line to land in either.
 */
export function tokenWallDrawn(tokens: DeckTokens, open: boolean): boolean {
  return open && (tokens.query.data?.length ?? 0) > 0;
}

/**
 * A tile's icon button — Remove printing, since managed tokens took the eye and the reset away —
 * the same box the `card` stepper beside it draws, **at the same zoom**.
 *
 * **`QUANTITY_STEPPER_CARD_BOX` itself rather than a copy of it** (issue #687, which grew the row
 * from `xs` to `card` so it matches the deck stack's own quantity column): both halves scale on
 * `--control-scale`, so the three controls in the row are one height at every stop rather than
 * three that agree at 100%. The variable is published by the tile's root.
 */
const TILE_BUTTON = cn(
  "grid shrink-0 place-items-center border border-border text-dim",
  QUANTITY_STEPPER_CARD_BOX,
  "hover:text-text",
  PRESS,
  FOCUS,
);

/** The glyph inside {@link TILE_BUTTON} — the stepper's own, at the same fraction of the box. */
const TILE_ICON = QUANTITY_STEPPER_CARD_ICON;

/**
 * The wall's gutters at 100% zoom — `gap-x-2.5` and `gap-y-4`, the numbers this band shipped
 * with.
 *
 * They go through {@link atLeast} rather than `scaled`: a gutter is the one measurement on a wall
 * of cards that is **between** them rather than **on** one, so it grows with the tiles and holds
 * at its base going down. `cardZoom.ts` carries the whole argument, and `GridView`'s wall is the
 * other surface that reads it.
 *
 * The vertical one is the larger because a tile ends in a controls row and up to three lines of
 * type under the picture, where its neighbour's picture starts immediately: 10px between two
 * pictures reads as the same air as 16px between a caption and the next row's art.
 */
const TILE_GAP_X = 10;
const TILE_GAP_Y = 16;

export interface DeckTokensPanelProps {
  /**
   * `useDeckTokens`' answer for the deck and the list on screen, called **once** by the editor
   * and handed to this band and to the views' token pile alike — see this file's header. The
   * override is not per variant (`deck_tokens` is grained on `(deck_id, oracle_id)`) but the
   * derived list is, because deck cards are, so the host is what passes the hook the variant.
   */
  tokens: DeckTokens;
  /** `decks.tokens_open`. Collapsed is what every existing deck is, and what a reader who never
   *  sleeves tokens goes on paying one header row for. */
  open: boolean;
  onToggle: (next: boolean) => void;
  /**
   * A tile's picture was pressed: open the picker on **this entry** — one printing in one finish
   * of one token — to swap it (spec §4.2 rule 4; the token's other entries are untouched).
   *
   * **The host owns the picker**, because the views' token pile opens the same one — see this
   * file's header. The view is handed over whole, and the host is what must not keep it: the wall
   * is re-derived after every write, so the host holds the view's
   * {@link DeckTokenView.entryKey} and looks the entry up again on every render — the `Layer`
   * union's rule one surface over — rather than answering about the entry as it was when pressed.
   */
  onPick: (view: DeckTokenView) => void;
  /**
   * The header's **Add printing**: open the picker on every token the deck has, to add one
   * printing at one copy (spec §4.6, rule 5) — or, with the picker's `All tokens`, a printing of
   * any token in the game. The host owns that picker too, and decides which tokens it lists; the
   * band draws the button on every deck whose read has answered, one that makes nothing included.
   */
  onAddPrinting: () => void;
}

/**
 * The band: a header that always draws, and a wall that draws when the reader asks for it.
 *
 * **The read runs whether or not the wall is drawn**, and that is deliberate rather than an
 * oversight. The header has to say how many tokens this deck brings — that number *is* the reason
 * to open the area — and the resolve is ~5 ms for a 100-card deck against the corpus the app
 * already has (spec §3). Gating the query on `open` would trade that for a header that could only
 * say "press to find out".
 */
export function DeckTokensPanel({
  tokens,
  open,
  onToggle,
  onPick,
  onAddPrinting,
}: DeckTokensPanelProps): JSX.Element {
  const bodyId = useId();

  /**
   * The currency every tile's foot writes its entry's price in — read once for the band, as the
   * zoom below is, so a deck that makes twenty tokens is one subscription rather than twenty.
   */
  const { marketplace } = useMarketplace();

  /**
   * How large the reader has asked the desk's cards to be drawn — `cardZoom.deck`, the same
   * number `StackView` and `GridView` read, and deliberately not the docked search column's.
   *
   * **Read once for the whole band and handed down**, which is `GridView`'s own arrangement and
   * its reason: a deck that makes twenty tokens is twenty tiles, and twenty store subscriptions
   * to answer one number they all share. The picker reads the same key in `DeckEditor`, which
   * is what keeps the two walls agreeing about it.
   */
  const zoom = useAppStore((s) => s.cardZoom.deck);

  /** The resolver's rows — what decides whether there is anything to disclose. */
  const rows = tokens.query.data ?? [];

  /**
   * How many copies the deck brings: the stepper's number summed over every entry of every token —
   * the figure beside the heading (token stacks spec §3.1). A Treasure kept as three plain copies
   * and one foil is four.
   *
   * **Summed over `tokens.tokens`, the resolved views**: a view's `quantity` is the entry's own,
   * effective as it arrives — Rust applies the implicit entry's `deck_tokens.quantity ?? 0`, and a
   * zeroed last entry arrives as 0 — so there is no fallback left for this sum to re-derive. **One
   * number with the pile's heading, by construction**: the pile draws the same views less those at
   * 0, and a zero adds nothing to a sum. A `hidden` row an older peer synced in is counted like any
   * other, since nothing on this side reads the word any more (managed tokens spec §3.3).
   */
  const copies = tokens.tokens.reduce((sum, view) => sum + view.quantity, 0);

  /**
   * The read's own refusal, which is **not** `tokens.failure` — that one is the newest *write*.
   *
   * Two failures with two consequences: a refused read leaves the header with nothing to count,
   * and a refused write leaves the wall drawing the value the reader has just tried to change. So
   * they are said in two places, and neither may stand in for the other.
   */
  const readFailure = tokens.query.isError ? ipcError(tokens.query.error) : null;

  /**
   * There is something to expand.
   *
   * **`query.isSuccess` and not `!loading`**, because "this deck makes nothing" and "nothing has
   * answered yet" are two sentences and `loading` alone cannot tell them apart — a refused read
   * is not pending and has no rows either, and captioning it *makes nothing* would be the app
   * asserting a fact it does not have.
   */
  const answered = tokens.query.isSuccess;
  /** There is something to expand: a wall with at least one tile on it. */
  const canOpen = rows.length > 0;
  /**
   * **Add printing is offered once the read has answered, and on every deck it answered for** —
   * a deck whose cards make nothing included, which is the spec's own case for a token added by
   * hand (managed tokens §1.3, §3.6); the picker opens on every token in the game there. Not
   * before the answer — there is no deck to add to yet — and not beside a refused read, which has
   * already said so in its alert.
   */
  const canAdd = answered && readFailure === null;

  /**
   * **Remove printing that hands the caret on** (`tokenCaret.ts`): the removed tile unmounts with
   * the button the caret was on, so once the re-read has drawn the wall without it the caret goes
   * to the same token's next entry, else the next token, else this band's Add printing — and on a
   * refusal nowhere, since nothing unmounted. Looked up in this band and never the pile, which
   * draws the same entries a second time.
   */
  const sectionRef = useRef<HTMLElement>(null);
  const bandRoot = useCallback(() => sectionRef.current, []);
  const bandFloor = useCallback(
    () =>
      focusable(sectionRef.current?.querySelector(`[${TOKEN_ADD_ATTR}]`)) ??
      focusable(sectionRef.current?.querySelector("button")),
    [],
  );
  const removeAt = useRemoveCaret({
    views: tokens.tokens,
    remove: tokens.remove,
    root: bandRoot,
    fallback: bandFloor,
  });

  return (
    // The Deck stats band's own grammar, character for character: a rule and the content under
    // it. That is the shape the toolbar above the deck is in too — a rule and its controls — and
    // a surface, a border and a radius here would say *a panel you opened*, which this is not.
    <section
      ref={sectionRef}
      aria-label={TOKENS_HEADING}
      {...{ [TOKEN_BAND_ATTR]: "" }}
      className="shrink-0 border-t border-border pt-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {canOpen ? (
          <button
            type="button"
            onClick={() => onToggle(!open)}
            // `aria-expanded` on the control and `aria-controls` at the region it acts on: the
            // pair is what says *what* the press does rather than only that a press happened.
            // The region below is always in the tree — it is empty while shut, not absent — so
            // the id this names always resolves, which is the one thing neither attribute
            // complains about when it stops being true.
            aria-expanded={open}
            aria-controls={bodyId}
            className={cn(
              "flex items-center gap-1.5 rounded-md text-sm text-text",
              PRESS,
              FOCUS,
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0",
                "transition-transform duration-[var(--duration-fast)] ease-standard",
                "motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            {TOKENS_HEADING}
          </button>
        ) : (
          // No disclosure where there is nothing to disclose. A greyed control that spends the
          // whole deck refusing is the editor's own argument against drawing one — see the pull
          // button on the Theory tab, absent rather than greyed for the same reason.
          <p className="text-sm text-text">{TOKENS_HEADING}</p>
        )}

        {/* The count is a bare number in a pill, and it is honest here for the app's own
            reason: the heading is set in type immediately beside it and says what is being
            counted. It is its own element, so nothing computes it into another control's name.

            **A pill since 2026-09-24 (issue #507)**, where it read `N to bring`: the views' token
            pile draws the same number beside the same heading, and one component — `CountPill`,
            the figure every pile heading in the four views wears — is what keeps the two
            drawings one mark. **It counts copies since token stacks (spec §3.1)**, where it
            counted distinct tokens: `copies`, above, so a Treasure stepped to 4 is four. */}
        {canOpen && <CountPill count={copies} words={tokenCountWords(copies)} />}

        {answered && rows.length === 0 && (
          <p className="text-xs text-dim">Nothing in this deck makes a token or an emblem.</p>
        )}

        {readFailure !== null && (
          <p role="alert" className="text-xs text-destructive">
            Couldn&rsquo;t load this deck&rsquo;s tokens — {readFailure}
          </p>
        )}

        {/* **Add printing, at the far end of the row** — drawn while the band is shut, and the
            press opens it: the Notes band's `New note`, for its reason — a printing added into a
            region the reader cannot see is answered by nothing but the count moving by one. The
            press and not the pick is the moment, so a picker the reader dismisses still leaves
            them looking at the wall.

            **Drawn on a deck that makes nothing too** (`canAdd`, fix round 1): the picker opens
            there on every token in the game, `All tokens` already pressed, because a token the
            deck does not make is exactly what a reader adds by hand. Its press still opens the
            band, so the first token added is on screen the moment it lands. */}
        {canAdd && (
          <button
            type="button"
            onClick={() => {
              if (!open) onToggle(true);
              onAddPrinting();
            }}
            // `inline-flex items-center gap-1.5` for the glyph beside the word: `META_SUBMIT` is
            // geometry and colour only and names no `display` — the Notes band's own note.
            // `ml-auto` puts it at the far end of the row, where the header's controls stand.
            className={cn("ml-auto inline-flex items-center gap-1.5", META_SUBMIT)}
            // The caret's floor after a removal takes the last token — `tokenCaret.ts`.
            {...TOKEN_ADD_MARK}
          >
            <Plus aria-hidden="true" className="size-3.5 shrink-0" />
            Add printing
          </button>
        )}
      </div>

      {/* Always in the tree so `aria-controls` above always names something, and empty while the
          area is shut so a closed band costs no picture, no tile and no state. The condition is
          `tokenWallDrawn`, the one `DeckEditor` reads to decide whether its banner speaks for a
          refused token write instead. */}
      <div id={bodyId}>
        {tokenWallDrawn(tokens, open) && (
          <TokenWall
            tokens={tokens}
            zoom={zoom}
            currency={marketplace.currency}
            onPick={onPick}
            onRemove={removeAt ?? tokens.remove}
          />
        )}
      </div>
    </section>
  );
}

/** The wall itself, and the one sentence that stands in for it. */
function TokenWall({
  tokens,
  zoom,
  currency,
  onPick,
  onRemove,
}: {
  tokens: DeckTokens;
  /** `cardZoom.deck`, read once by the band above. See this file's header. */
  zoom: number;
  /** How every tile's foot writes its entry's one unit price — read once by the band above. */
  currency: Currency;
  onPick: (view: DeckTokenView) => void;
  /** Remove printing, with the caret's hand-off — the band's `removeAt`. */
  onRemove: (entry: TokenEntryRef) => void;
}) {
  return (
    <div className="mt-3">
      {/* The newest write's refusal, said once above the wall rather than on the tile it came
          from: a reader who steps a quantity and then removes a different printing has made two
          presses and is owed the answer to the second, which is `writeFailure`'s rule and why
          the hook hands one sentence over rather than a map of them. */}
      {tokens.failure !== null && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          Couldn't save that change — {tokens.failure}
        </p>
      )}

      {/* The gutters are inline because a scaled number cannot be a class — `GridView`'s wall
          says the same thing at its own `<ul>`, and it is the same rule: Tailwind scans source
          text for whole class names, so a `gap-x-[${n}px]` emits no rule at all. The wall is
          never empty while it is drawn — the band only opens on a deck that has a row, and every
          row is a tile since nothing is filtered out of the band. */}
      <ul
        className="flex flex-wrap"
        style={{ columnGap: atLeast(TILE_GAP_X, zoom), rowGap: atLeast(TILE_GAP_Y, zoom) }}
      >
        {/* Keyed on the **entry**, never the oracle id: since v52 one token is as many tiles as
            it has printings-in-a-finish, and two children sharing an oracle id as their key
            would be one React child drawn twice. */}
        {tokens.tokens.map((view) => (
          <li
            key={view.entryKey}
            style={{ width: stackCardWidth(zoom) }}
            // The entry's key, which is how the caret finds this tile after a write (`tokenCaret`).
            {...tokenEntryProps(view)}
          >
            <TokenTile
              view={view}
              tokens={tokens}
              zoom={zoom}
              currency={currency}
              onPick={() => onPick(view)}
              onRemove={() => onRemove(entryRef(view))}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One entry of a token or emblem: its picture, the three things a reader can do to it — change its
 * printing, count it, remove it — and what it is and why it is here.
 *
 * **In that order, top to bottom** (issue #615): the card and its foot, the controls row across
 * the tile's whole width, the colour-and-stats subtitle, and the source line. The card prints the
 * token's name, so the tile draws no line of its own for it — see this file's header.
 *
 * **A token nothing in the deck makes is drawn as a rule-break card is** (managed tokens spec
 * §3.5): the destructive outline round the picture and its foot, and `NOT MADE BY DECK` in the
 * rule-break mark's corner and style. `CardArt` takes no tone and is not forked for one, so the
 * outline is a ring on the wrapper the picture and its foot share — the picker's own way of
 * outlining the current printing, art and foot as one object — and the chin under it takes
 * `tone="destructive"`, so its own edges are the same red rather than a grey line through the
 * foot of a red card.
 */
function TokenTile({
  view,
  tokens,
  zoom,
  currency,
  onPick,
  onRemove,
}: {
  view: DeckTokenView;
  tokens: DeckTokens;
  /** `cardZoom.deck`. The tile's root publishes it as the two card variables; see the header. */
  zoom: number;
  /** How the foot writes this entry's one unit price. */
  currency: Currency;
  onPick: () => void;
  /** Remove printing on this entry, the caret handed on once it lands. */
  onRemove: () => void;
}) {
  const tip = useTooltip();
  const handAdded = isHandAdded(view);

  /**
   * Why this token is on the wall — the deck cards that make it, or the reader's own press.
   *
   * The **whole** list is in the DOM and the clamp is CSS, so a screen reader hears every maker
   * while the tile draws one line; `whenClipped` puts the rest under the pointer and nowhere
   * else, which is what keeps a hint off the tiles that already fit.
   */
  const why =
    view.sources.length > 0
      ? `From ${view.sources.map((source) => source.name).join(", ")}`
      : "Added or kept by hand";

  return (
    <div
      // The stepper, the icon button beside it and every line of type below size themselves against
      // these two rather than taking a prop — `cardZoom.ts`'s rule, and the reason it is a
      // variable: `QuantityStepper` is drawn in three tables as well as on this tile, and a prop
      // would have to be threaded to every one of them and defaulted where nothing scales.
      style={cardScaleVars(zoom)}
      className="flex flex-col gap-[calc(0.25rem*var(--mark-scale,1))]"
    >
      {/* The picture and its foot are one child of the column, so the column's `gap` does not
          open between them: `CardChin` rides up onto the frame by `CHIN_RISE` to read as the
          card's own edge, which a gap would turn back into a bar floating under a picture. It is
          also the box a hand-added token's outline goes round — see this component's doc. */}
      <div className={cn("rounded-lg", handAdded && "ring-2 ring-destructive")}>
        <button
          type="button"
          onClick={onPick}
          // Named for what pressing it does. The picture is the control, so a name repeating the
          // token would say "Treasure" over a picture of a Treasure — and the subtitle, the
          // printing and the finish are what separate this press from the tiles beside it. A
          // hand-added token's name carries the badge's words, since the badge is `aria-hidden`.
          aria-label={tokenArtName(view)}
          // The test handle for the faded picture below — an attribute rather than the class,
          // which is a recipe (`cardControl.tsx`'s rule for a mark a view spreads on a card).
          data-token-uncounted={view.quantity === 0 ? "" : undefined}
          // `relative` for the badge: it is laid over the picture's bottom-left corner.
          className={cn("relative block w-full rounded-lg", FOCUS_INSET)}
          {...TOKEN_ART_MARK}
        >
          <CardArt
            cardId={view.printingId}
            // The `alt` and the no-picture fallback's own line. The button's `aria-label` above
            // wins the accessible name, so this is what is left for the frame that never loads —
            // and a named frame is what keeps a rate-limited screen a list of tokens.
            name={view.name}
            // **The entry's own finish** — the sheen and the chip for a foil or etched copy, and
            // nothing for a plain one: `nonfoil` is the finish a price is assumed to be, and
            // handed through as a word it would paint the chip's felt with nothing in it (the
            // collection page's `finishMarkOf`).
            finish={view.finish === "nonfoil" ? null : view.finish}
            // Not virtualised: every token the deck makes is mounted at once, so the browser's
            // own intersection gate is the only thing bounding what the wall asks for.
            loading="lazy"
            // **An entry at 0 is drawn faded** (issue #673): it is a token the deck can make and
            // the reader has not counted, so it is on the band to be found and left off every
            // stack. Only the picture fades — the stepper that counts it up, the chin and the
            // lines under it stay at full strength, and so does `NOT MADE BY DECK`, which is a
            // warning rather than a picture. 60% is the switched-off pile's own `opacity-60`
            // (`StackView`), the deck's one word for "counts toward nothing".
            className={cn(
              "transition-opacity duration-[var(--duration-fast)] ease-standard",
              "motion-reduce:transition-none",
              view.quantity === 0 && "opacity-60",
            )}
          />
          {/* Where a rule-break card wears `RULE BREAK`, in its style — `DeckCardFace`'s own
              corner, whose offset clears the chin riding up under the picture here too. Inside
              the button, so a press on it is a press on the picture; its words are the button's
              name's last clause. */}
          {handAdded && <NotMadeByDeckMark name={view.name} className={BOTTOM_LEFT_MARK} />}
        </button>
        {/* **The foot every wall of cards draws** (`CardChin`, at `seam="art"` under a `CardArt`
            frame), and since v52 the line that tells one token's entries apart for the eye: the
            rarity, `SET · number`, the finish's mark and one copy's price at that finish. A
            sibling of the button, so its facts are announced rather than swallowed by the
            button's name. The price is this entry's and nothing else's — no token's price ever
            reaches the deck's totals. */}
        <CardChin
          zoom={zoom}
          rarity={view.rarity}
          setCode={view.setCode ?? ""}
          collectorNumber={view.collectorNumber ?? ""}
          // The code is what fits; the set's name is one hover away, as on a deck card's foot.
          printingTitle={
            view.setName === null ? null : `${view.setName} · #${view.collectorNumber ?? ""}`
          }
          finish={view.finish}
          money={formatPrice(view.unitPrice, currency)}
          seam="art"
          // The outline's colour, carried through the foot: the chin paints its own edges, and a
          // grey one would run a neutral line down the foot of a red-ringed tile.
          tone={handAdded ? "destructive" : "default"}
        />
      </div>

      {/* **The controls come straight after the card, and they span the tile** (issue #615). The
          line of type that used to sit here was the token's name, which the picture above already
          prints on the card itself — so it said the same word twice, a line apart, and pushed the
          one thing a reader presses on this tile down under two lines of reading. It is gone from
          the eye and not from the ear: every control's accessible name still starts with it,
          through `tokenEntryName`, and the frame that never loads still draws it (`CardArt`'s
          `name`).

          **Full width is `fill` on the stepper and `flex-1` around it**, so the number box takes
          whatever the two square buttons and Remove printing leave — the card modal's controls
          column's arrangement, and `QuantityStepper`'s own rule for it: the buttons keep their
          square geometry and only the number grows. The wrapper is what shrinks, since the
          stepper takes no `className`; `min-w-0` because a flex item's floor is its content. */}
      <div className="flex items-center gap-[calc(0.25rem*var(--mark-scale,1))]">
        <div className="min-w-0 flex-1">
          <QuantityStepper
            // **`card`, the deck stack's own quantity size** (issue #687): `xs` was a 20px box
            // under a card the size of a stacked one, where the deck beside it draws 36px.
            size="card"
            value={view.quantity}
            // **This entry and no other** — `entryRef`'s four facts, so a step on the foil Treasure
            // cannot land on the plain one, and an implicit entry says so and is materialised by
            // Rust on the way in (spec §4.2 rule 2).
            onChange={(next) => tokens.setQuantity(entryRef(view), next)}
            // **Zero is a value and not an absence**, so the floor is 0 and the write stores it:
            // the token's last entry stepped to 0 stays at 0 with its printing kept (rule 3), and
            // any other entry stepped to 0 leaves the list — Rust's rule, not this stepper's.
            min={0}
            label={tokenEntryName("Quantity of", view)}
            fill
          />
        </div>
        {/* **Remove printing** — this entry and no other (managed tokens spec §3.4), on every
            tile but an implicit one, which is not stored and has nothing to delete. A derived
            token's last entry falls back to the printing the deck's cards name, at 0; a hand-added
            token's last entry in both lists takes it off the deck. Named for its entry, so a
            token's plain and foil tiles are two presses; `Remove printing` is the pointer's word,
            the same on every tile. At the row's far end, so an implicit entry's stepper simply
            runs the whole width where a stored one stops short of it. */}
        {!view.implicit && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={tokenEntryName("Remove", view)}
            {...tip("Remove printing", { describes: false })}
            className={cn(TILE_BUTTON, "hover:text-destructive")}
            {...TOKEN_REMOVE_MARK}
          >
            <Trash2 aria-hidden="true" className={TILE_ICON} />
          </button>
        )}
      </div>

      {/* **The colour and stats line, under the controls rather than over them** (issue #615, the
          owner's comment on it: keep the row, move it). It is the one line on the tile the card
          does not already say in a form a reader can find at a glance — and it is what separates
          the two `Wurm`s — so it stays, below the thing that is pressed.

          **No tooltip, and that is a measurement rather than a preference.** `whenClipped` asks
          `scrollWidth > clientWidth`, which is a question about *width* — and `line-clamp` cuts
          on height, so an unclipped-by-width paragraph answers `false` and the hint could never
          be shown. A hint that can never show is the `pointer-events` trap in another costume:
          nothing goes red and nobody finds out. The whole string is in the DOM either way, so a
          screen reader hears it, every control on this tile spells it into its own name, and the
          art picker sets it under its heading unclamped. */}
      {view.subtitle !== null && (
        <p className="line-clamp-2 text-[calc(0.6875rem*var(--mark-scale,1))] leading-tight text-dim">
          {view.subtitle}
        </p>
      )}

      <p
        className="truncate text-[calc(0.6875rem*var(--mark-scale,1))] text-dim"
        {...tip(why, { whenClipped: true })}
      >
        {why}
      </p>
    </div>
  );
}
