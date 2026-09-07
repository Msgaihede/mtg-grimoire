/**
 * The tokens and emblems this deck makes, as a band at the foot of the editor.
 *
 * **It draws what {@link useDeckTokens} concluded and decides nothing itself.** Which printing a
 * tile shows, how many copies the stepper starts at, whether a dismissed token is on the wall and
 * the order the wall reads in are all `deckTokens.ts`' answers, arrived at once for the whole
 * feature; this file is the arrangement of them. That is the same boundary the rest of the deck
 * builder keeps, and it is what lets a rule change be one edit rather than four components
 * disagreeing about a wall.
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
 * - **Below the Deck stats band**, which is itself below the price strip. The strip's
 *   drag-remove tray sits at `-top-3`, reaching up into the editor column's own `gap-3`, so the
 *   strip and the deck above it may not be separated — and a band inserted between them would
 *   leave a reader dragging a card the height of four charts to reach the drop that removes it.
 *   Under the stats is the far side of that pair and costs nothing.
 * - **The heading is `Tokens & emblems`, never bare `Tokens`.** `autoCategory.ts` already uses
 *   that word for an auto-category of cards that *make* tokens, driven by the
 *   `repeatable-token-generator` oracle tag — the opposite meaning of the same word — and the
 *   auto-category is deliberately not renamed, because renaming it would silently regroup every
 *   existing deck. So the two strings are kept apart instead.
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
 * {@link tileName}, and the subtitle is drawn under the token's name as an element of its own —
 * never as a second half of one line. Two flex children with a `gap` between them compute to a
 * name with the words run together (`"Missing2"`), which is why the visible name and the visible
 * subtitle are two paragraphs and every accessible name is spelled rather than assembled.
 *
 * **The subtitle is clamped in CSS and never in the string.** A token's oracle text is the term
 * that separates the two Wurms, so a truncation short enough to fit a 150px tile would fold them
 * back together in exactly the case this exists for.
 */
import { useId, useState, type JSX } from "react";
import { ChevronRight, Eye, EyeOff, Undo2 } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { ToggleChip } from "@/components/FilterChips";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { count, plural } from "@/lib/counts";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { ipcError, type DeckVariant } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { DeckTokenView } from "./deckTokens";
import { TOKEN_TILE_WIDTH, TokenArtPicker } from "./TokenArtPicker";
import { useDeckTokens, type DeckTokens } from "./useDeckTokens";

/**
 * The area's name, in one place because three things say it: the region's `aria-label`, the
 * disclosure's visible text, and every test and story that addresses either.
 *
 * **`&` rather than `and`**, which is the deck editor's own house style for a pair of nouns in a
 * heading (`Categories & labels`), and the ampersand is what a reader scans past.
 */
export const TOKENS_HEADING = "Tokens & emblems";

/** A tile's two icon buttons — the same 20px box the `xs` stepper beside them draws. */
const TILE_BUTTON = cn(
  "grid size-5 shrink-0 place-items-center rounded-md border border-border text-dim",
  "hover:text-text",
  PRESS,
  FOCUS,
);

export interface DeckTokensPanelProps {
  deckId: number;
  /** Which of the deck's two lists the wall is derived from. The **override** is not per
   *  variant — `deck_tokens` is grained on `(deck_id, oracle_id)` — but the derived list is,
   *  because deck cards are. */
  variant: DeckVariant;
  /** `decks.tokens_open`. Collapsed is what every existing deck is, and what a reader who never
   *  sleeves tokens goes on paying one header row for. */
  open: boolean;
  onToggle: (next: boolean) => void;
}

/**
 * The band: a header that always draws, and a wall that draws when the reader asks for it.
 *
 * **The read runs whether or not the wall is drawn**, and that is deliberate rather than an
 * oversight. The header has to say how many tokens this deck makes — that number *is* the reason
 * to open the area — and the resolve is ~5 ms for a 100-card deck against the corpus the app
 * already has (spec §3). Gating the query on `open` would trade that for a header that could only
 * say "press to find out".
 */
export function DeckTokensPanel({
  deckId,
  variant,
  open,
  onToggle,
}: DeckTokensPanelProps): JSX.Element {
  const tokens = useDeckTokens(deckId, variant);
  const bodyId = useId();

  /**
   * Which token's art is being picked, by `oracle_id`.
   *
   * **An id and never the view**, which is the `Layer` union's rule one surface over: the wall is
   * re-derived after every write, so a frozen view would answer about the token as it was when
   * the tile was pressed — a printing swap would leave the dialog marking the printing the deck
   * has just stopped bringing.
   */
  const [picking, setPicking] = useState<string | null>(null);
  const picked = tokens.tokens.find((view) => view.oracleId === picking) ?? null;

  /**
   * The resolver's rows, before `showDismissed` narrows them.
   *
   * The header counts off these rather than off `tokens.tokens`, so the number beside the heading
   * does not move when the reader reveals a dismissal — the count is *what this deck brings*, and
   * revealing a dismissed token does not bring it.
   */
  const rows = tokens.query.data ?? [];
  // Counted on every render and deliberately not memoised. `query.data ?? []` is a fresh array
  // whenever the read has not landed, so a `useMemo` over it would be rebuilt every render *and*
  // cost a dependency comparison — the hook keeps a stable `NO_ROWS` for the memo that matters,
  // which is the one that sorts the wall. A `filter().length` over a deck's tokens is a handful
  // of rows and buys nothing back.
  const dismissed = rows.filter((row) => row.state === "hidden").length;
  const kept = rows.length - dismissed;

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
  const canOpen = rows.length > 0;

  return (
    // The Deck stats band's own grammar, character for character: a rule and the content under
    // it. That is the shape the toolbar above the deck is in too — a rule and its controls — and
    // a surface, a border and a radius here would say *a panel you opened*, which this is not.
    <section aria-label={TOKENS_HEADING} className="shrink-0 border-t border-border pt-3">
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

        {/* The count is a bare number and it is honest here for the app's own reason: the
            heading is set in type immediately beside it and says what is being counted. It is
            its own element, so nothing computes it into another control's name. */}
        {canOpen && <span className="text-xs text-dim">{count(kept)} to bring</span>}

        {answered && rows.length === 0 && (
          <p className="text-xs text-dim">Nothing in this deck makes a token or an emblem.</p>
        )}

        {readFailure !== null && (
          <p role="alert" className="text-xs text-destructive">
            Could not read this deck&rsquo;s tokens — {readFailure}
          </p>
        )}

        {open && dismissed > 0 && (
          <ToggleChip
            className="ml-auto"
            label="Show dismissed"
            hint={plural(dismissed, "token or emblem", "tokens and emblems")}
            pressed={tokens.showDismissed}
            onClick={() => tokens.setShowDismissed(!tokens.showDismissed)}
          />
        )}
      </div>

      {/* Always in the tree so `aria-controls` above always names something, and empty while the
          area is shut so a closed band costs no picture, no tile and no state. */}
      <div id={bodyId}>
        {open && canOpen && <TokenWall tokens={tokens} onPick={setPicking} />}
      </div>

      {/* **Mounted inline, and the check that makes that legal is written down rather than
          assumed.** `Dialog`'s scrim is a bare `fixed inset-0` and corrects for nothing, so a
          dialog opened from inside a box that is transformed, filtered or
          `container-type: inline-size` stretches to *that box* instead of to the window. Neither
          this `<section>` nor the editor's root is any of those — the root is
          `relative flex h-full min-h-0 flex-col`, and `relative` is not a containing block for
          `fixed`. Settings' panels mount their own dialogs on exactly this reasoning, and the
          rule to keep is that a container query may never be added above this line. */}
      <TokenArtPicker
        token={picked}
        onPick={(cardId) => {
          if (picked !== null) tokens.setPrinting(picked.oracleId, cardId);
          setPicking(null);
        }}
        onDismiss={() => setPicking(null)}
        onClose={() => setPicking(null)}
      />
    </section>
  );
}

/** The wall itself, and the one sentence that stands in for it. */
function TokenWall({
  tokens,
  onPick,
}: {
  tokens: DeckTokens;
  onPick: (oracleId: string) => void;
}) {
  return (
    <div className="mt-3">
      {/* The newest write's refusal, said once above the wall rather than on the tile it came
          from: a reader who steps a quantity and then dismisses a different token has made two
          presses and is owed the answer to the second, which is `writeFailure`'s rule and why
          the hook hands one sentence over rather than a map of them. */}
      {tokens.failure !== null && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          Could not save that change — {tokens.failure}
        </p>
      )}

      {tokens.tokens.length === 0 ? (
        // Reachable exactly one way: every token this deck makes has been dismissed and the
        // switch above is off. It says which of the two it is, because an empty wall under a
        // header counting six would otherwise read as something broken.
        <p className="text-xs text-dim">
          Every token this deck makes is dismissed. Show them to bring one back.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-x-2.5 gap-y-4">
          {tokens.tokens.map((view) => (
            <li key={view.oracleId} style={{ width: TOKEN_TILE_WIDTH }}>
              <TokenTile view={view} tokens={tokens} onPick={() => onPick(view.oracleId)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One token's name folded into a verb, for a control's accessible name.
 *
 * **The subtitle is in every one of them**, which is the whole of what keeps two `Wurm` tiles
 * apart for a reader who cannot see them. A name assembled from the tile's visible elements
 * would not do: a `gap` between two flex children runs their words together in the computed
 * name, so each control spells its own.
 */
function tileName(verb: string, view: DeckTokenView): string {
  return view.subtitle === null ? `${verb} ${view.name}` : `${verb} ${view.name}, ${view.subtitle}`;
}

/** One token or emblem: its picture, what it is, and the three things a reader can do to it. */
function TokenTile({
  view,
  tokens,
  onPick,
}: {
  view: DeckTokenView;
  tokens: DeckTokens;
  onPick: () => void;
}) {
  const tip = useTooltip();
  const hidden = view.state === "hidden";

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
      : "Added by hand";

  return (
    <div className={cn("flex flex-col gap-1", hidden && "opacity-60")}>
      <button
        type="button"
        onClick={onPick}
        // Named for what pressing it does. The picture is the control, so a name repeating the
        // token would say "Treasure" over a picture of a Treasure — and the subtitle is what
        // separates this press from the identically-named tile beside it.
        aria-label={tileName("Change the art for", view)}
        className={cn("block w-full rounded-lg", FOCUS_INSET)}
      >
        <CardArt
          cardId={view.printingId}
          // **The web target's and the phone's only picture**, and `null` there is the no-art
          // frame rather than a broken `<img>`: neither has the `mtgimg://` protocol to ask, so
          // a tile with no URL on its row draws nothing at all. `deckTokens.ts` has already
          // picked the variant off the row, so this is a pass-through and never a lookup.
          imageUrl={view.imageUrl}
          // The `alt` and the no-picture fallback's own line. The button's `aria-label` above
          // wins the accessible name, so this is what is left for the frame that never loads —
          // and a named frame is what keeps a rate-limited screen a list of tokens.
          name={view.name}
          // Not virtualised: every token the deck makes is mounted at once, so the browser's own
          // intersection gate is the only thing bounding what the wall asks for.
          loading="lazy"
        />
      </button>

      {/* Two elements, and that is the rule rather than a layout preference — see this file's
          header. The name is clamped to one line and the subtitle to two; both keep their whole
          string in the DOM, because truncating a subtitle is how the two Wurms fold back into
          one. */}
      <p className="truncate text-xs text-text" {...tip(view.name, { whenClipped: true })}>
        {view.name}
      </p>
      {/* **No tooltip, and that is a measurement rather than a preference.** `whenClipped` asks
          `scrollWidth > clientWidth`, which is a question about *width* — and `line-clamp` cuts
          on height, so an unclipped-by-width paragraph answers `false` and the hint could never
          be shown. A hint that can never show is the `pointer-events` trap in another costume:
          nothing goes red and nobody finds out. The whole string is in the DOM either way, so a
          screen reader hears it, every control on this tile spells it into its own name, and the
          art picker sets it under its heading unclamped. */}
      {view.subtitle !== null && (
        <p className="line-clamp-2 text-[0.6875rem] leading-tight text-dim">{view.subtitle}</p>
      )}

      <div className="flex items-center gap-1">
        <QuantityStepper
          size="xs"
          value={view.quantity}
          onChange={(next) => tokens.setQuantity(view.oracleId, next)}
          // **Zero is a value and not an absence**, so the floor is 0 and the write stores it: a
          // token zeroed while its art is kept is a decision, and `deckTokens.ts` reads it back
          // with `??` for the same reason.
          min={0}
          label={tileName("Quantity of", view)}
        />
        <button
          type="button"
          onClick={() =>
            hidden ? tokens.restore(view.oracleId) : tokens.dismiss(view.oracleId)
          }
          aria-label={tileName(hidden ? "Restore" : "Dismiss", view)}
          {...tip(tileName(hidden ? "Restore" : "Dismiss", view), { describes: false })}
          className={TILE_BUTTON}
        >
          {hidden ? (
            <Eye aria-hidden="true" className="size-3.5" />
          ) : (
            <EyeOff aria-hidden="true" className="size-3.5" />
          )}
        </button>
        {/* Drawn only where there is something to undo, which is what `overridden` answers — and
            it is `reset`, not a `setPrinting` of three nulls. The two are the same write and only
            one of them says what the reader pressed. */}
        {view.overridden && (
          <button
            type="button"
            onClick={() => tokens.reset(view.oracleId)}
            aria-label={tileName("Reset", view)}
            {...tip(tileName("Reset", view), { describes: false })}
            className={TILE_BUTTON}
          >
            <Undo2 aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>

      <p className="truncate text-[0.6875rem] text-dim" {...tip(why, { whenClipped: true })}>
        {why}
      </p>
    </div>
  );
}
