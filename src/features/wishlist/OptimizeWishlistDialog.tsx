/**
 * **One press that moves every pinned wish onto the cheapest printing of the same card** — and a
 * preview the reader verifies before any of it is written (issue #352).
 *
 * The wishlist is a shopping list, and the same card is sold at wildly different prices depending
 * on which printing a wish happens to name: a wish pinned from a search result is pinned to
 * whatever printing the reader was looking at, which is very often not the cheap one. The sweep
 * answers that in bulk. What it must never do is answer it *silently* — a list of forty wishes
 * repointed with no preview is a shopping list somebody would have to audit card by card to trust
 * — so `wishlist_optimize_plan` writes nothing, this dialog draws exactly what would change, and
 * only the rows left ticked reach `wishlist_optimize_apply`.
 *
 * ## What the reader is actually deciding
 *
 * Usually nothing: every priced move arrives ticked and the ordinary act is one press on the
 * footer. The body is for the two minorities.
 *
 * * **A cheaper printing in another language counts**, so a sweep can quietly turn an English
 *   binder into a Japanese one. That is a legitimate thing to want and a legitimate thing to
 *   refuse, and the only way to refuse it is to see it — which is why `lang` is drawn on **both**
 *   sides of every row, and why this list suspends the app's usual rule that an `EN` on nine rows
 *   out of ten is a column of noise (`PullFromCollectionDialog`'s `DEFAULT_LANG`). Here the `EN`
 *   is half of the fact.
 * * **A wish whose current printing this marketplace does not list** is offered and counts no
 *   saving — `— → $2.00`, unticked. An unlisted printing may be cheap rather than dear, so the
 *   app has no basis for calling the swap an improvement; it still offers it, because the reader
 *   may know something the feed does not.
 *
 * ## What is not here
 *
 * **No query and no mutation.** The plan, its two failure states and the write all arrive as
 * props — `PullFromCollectionDialog`'s fence, and for its reason: the dialog renders in a test
 * with no query client, and the one write it makes is visible in its own signature rather than
 * reachable through a hook it happens to import. `useWishlistOptimize` is where both live.
 *
 * **No arithmetic and no wording rules either** — `optimizePlan.ts` owns the ticked set, every
 * total, the select-all's tri-state, the scope sentence and the reading of the outcome, so all of
 * it is checkable with no DOM.
 *
 * The chrome is `components/Dialog.tsx`'s: the scrim, the centring, `aria-modal`, `trapTab`, the
 * ✕ and the `"inner"` Escape rung are written once there, and a new modal is built **on** that
 * file rather than beside it.
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "@/components/Dialog";
import { FinishMark } from "@/components/FinishMark";
import { count, plural } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import {
  ipcError,
  type WishlistOptimizePlan,
  type WishlistOptimizeOutcome,
  type WishOptimizeApplyItem,
  type WishOptimizeMove,
  type OptimizePrinting,
} from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { statusLine } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { cn } from "@/lib/utils";
import {
  defaultTicked,
  everyMove,
  optimizeScope,
  selectionOf,
  summariseOutcome,
  toggleTicked,
  type OptimizeOutcome,
  type OptimizeSkip,
  type WishId,
} from "./optimizePlan";

/** Stable identity for "the read has not answered", so the derivations below are not re-run over
 *  a fresh empty array on every render of a dialog that is still waiting. `NO_ROWS` in
 *  `PullFromCollectionDialog`, for its reason. */
const NO_MOVES: readonly WishOptimizeMove[] = Object.freeze([]);

/** What the body says while the sweep is in flight. Named for what is being looked for rather
 *  than for the machinery — the reader asked a price question. */
const CHECKING = "Looking for cheaper printings…";

/**
 * The two shapes of "nothing to do", which are different facts and must not be folded together.
 *
 * A reader who presses this over a wishlist they have never optimised expects something to
 * happen, so a blank panel is read as broken. Saying **which** of the two it is, is the whole
 * content: one is the good news that the list is already as cheap as this marketplace makes it,
 * the other is that the sweep had nothing in front of it — which is a statement about the folder
 * they are standing in and the filters they have on, and is fixed by changing one of those.
 */
const NOTHING_IN_SCOPE = {
  headline: "Nothing to check.",
  why: "No wishes are in scope, so there are no prices to compare. Step out of this folder, or clear a filter, and try again.",
} as const;

const ALREADY_CHEAPEST = {
  headline: "Nothing to change.",
  why: "Every wish here is already on the cheapest printing this marketplace lists for it. Wishes for “any printing” are counted as cheapest too — they are already priced at the cheapest printing of their card, and pinning one would take that away.",
} as const;

/**
 * What a passed-over wish means, for the counts line.
 *
 * `skipped` is the one figure in this dialog with no row to look at and no obvious reading, and
 * the three causes are unrelated to each other — so it is spelled out rather than left as a
 * number a reader has to guess at.
 */
const SKIPPED_NOTE =
  "Skipped: the wish names no card, or names a printing the card database no longer has, or " +
  "nothing this marketplace prices at that finish.";

/** The way out, and the affirmative, in the app's two button shapes — `PullFromCollectionDialog`'s
 *  pair, which is where the app settled them. Written once because the footer draws both on one
 *  line and two that drifted would read as two decisions. */
const CANCEL = cn(
  "h-8 shrink-0 rounded-md border border-border px-3 text-xs text-dim",
  "transition-colors duration-150 hover:text-text",
  "motion-reduce:transition-none",
  FOCUS,
);

const CONFIRM = cn(
  "h-8 shrink-0 rounded-md border border-accent px-3 text-xs text-accent",
  "transition-colors duration-150 hover:bg-accent hover:text-bg",
  "disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-accent",
  "aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-accent",
  "motion-reduce:transition-none",
  FOCUS,
);

/**
 * What this dialog needs of `useWishlistOptimize().apply` — narrowed the way
 * `PullFromCollectionDialog`'s `PullWrite` is, so the dialog renders with no query client and the
 * one write it makes is visible in its own signature.
 */
export interface OptimizeWrite {
  mutate: (items: WishOptimizeApplyItem[]) => void;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  error: unknown;
  data: WishlistOptimizeOutcome | undefined;
}

/** Where the sweep is looking, in the three facts {@link optimizeScope} turns into a sentence. */
export interface OptimizeScope {
  /** The level the list is drawn at, already named — the page's `folderNameOf(folderId)`, which
   *  answers the root's own word for `null`. Ignored while flattened. */
  folder: string;
  flatten: boolean;
  /** Whether any card filter is narrowing the list. */
  filtered: boolean;
}

export interface OptimizeWishlistDialogProps {
  open: boolean;
  scope: OptimizeScope;
  /** The plan, or `null` while the read has not answered. */
  plan: WishlistOptimizePlan | null;
  loading: boolean;
  /** Why the plan could not be read, already through `ipcError`. */
  readError: string | null;
  /**
   * Which marketplace every figure here was quoted at — its currency for {@link formatPrice} and
   * its label for the as-of line.
   *
   * A prop rather than a `useMarketplace()` of its own, which keeps this component query-free
   * (see the file's own note) and, more to the point, keeps it reading the *same* answer the
   * query key was built from. The plan deliberately does not echo the marketplace back, so the
   * one copy of that fact is the caller's.
   */
  marketplace: Marketplace;
  apply: OptimizeWrite;
  /**
   * What to call the folder a wish is filed in — used only while flattened, where a row can come
   * from any drawer and the caption is the one thing telling two otherwise identical rows apart.
   * Absent draws no folder at all.
   */
  folderNameOf?: (id: number | null) => string | null;
  onClose: () => void;
}

/**
 * Ask which wishes to move onto their cheapest printing, and move them.
 *
 * Every prop but `open` is about the read, the write or where the sweep is looking; the dialog
 * owns only the reader's ticks and the snapshot it presses on, and both live in the body — which
 * {@link Dialog} mounts and unmounts with the flag, so each open starts clean and no effect has
 * to reset anything.
 */
export function OptimizeWishlistDialog({
  open,
  scope,
  plan,
  loading,
  readError,
  marketplace,
  apply,
  folderNameOf,
  onClose,
}: OptimizeWishlistDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      // British in prose, as everything a reader sees in this app is — the code identifiers stay
      // `optimize`, which is why the wire and the ipc mirror read `wishlistOptimizePlan`.
      title="Optimise prices"
      subtitle={optimizeScope(scope)}
      closeLabel="Close the price check"
      // Wider than the import dialog's `w-[42rem]` and narrower than the pull's `w-[52rem]`: a row
      // here carries a name, two printings and two prices, but no sentence naming a folder, a
      // condition and four traits. Still inside the app's 1024px window floor once the scrim's
      // `sm:p-6` is taken off both sides.
      width="w-[48rem]"
      // One callback for both rungs, `PullFromCollectionDialog`'s note: where the caret lands is
      // the opener's half of the contract and is decided in the view that owns the trigger.
      onDismiss={onClose}
      onClose={onClose}
    >
      <OptimizeBody
        plan={plan}
        loading={loading}
        readError={readError}
        marketplace={marketplace}
        apply={apply}
        flattened={scope.flatten}
        folderNameOf={folderNameOf}
        onClose={onClose}
      />
    </Dialog>
  );
}

/**
 * The preview, the press and the outcome — mounted only while the dialog is open, which is
 * {@link Dialog}'s guarantee and what makes the ticks and the snapshot a session rather than
 * something an effect has to clear.
 */
function OptimizeBody({
  plan,
  loading,
  readError,
  marketplace,
  apply,
  flattened,
  folderNameOf,
  onClose,
}: {
  plan: WishlistOptimizePlan | null;
  loading: boolean;
  readError: string | null;
  marketplace: Marketplace;
  apply: OptimizeWrite;
  flattened: boolean;
  folderNameOf?: (id: number | null) => string | null;
  onClose: () => void;
}) {
  const id = useId();
  const moves = plan?.moves ?? NO_MOVES;

  /**
   * Which wishes are ticked — **`null` until the reader touches something**, which is the whole
   * of how a refetch under an open dialog is handled.
   *
   * The plan sits under `["wishlist"]`, so every wishlist write in the app invalidates it, and a
   * marketplace switch moves its key outright. An untouched dialog re-seeds from whatever came
   * back ({@link defaultTicked}); a dialog the reader has worked on keeps their answer, and a
   * ticked id that names no move is ignored rather than honoured (`optimizePlan.ts`). Deriving
   * the seed rather than writing it in an effect is also what keeps this off `src/CLAUDE.md`'s
   * no-`setState`-in-an-effect rule.
   */
  const [touched, setTouched] = useState<ReadonlySet<WishId> | null>(null);
  const ticked = touched ?? defaultTicked(plan ?? undefined);

  /** What the press would send, and every number on screen. One derivation, so the footer's
   *  total and a row's own tick can never come to disagree. */
  const selection = useMemo(() => selectionOf(moves, ticked), [moves, ticked]);

  /**
   * The moves the press was made from, kept across the write.
   *
   * **Not `plan.moves`, and that is load-bearing.** A successful apply invalidates `["wishlist"]`,
   * so the plan behind this dialog refetches and the wishes that just moved leave it — an outcome
   * summarised against the live plan would lose every name and report nothing saved, on exactly
   * the screen whose job is to say what happened.
   *
   * `null` falls back to whatever the plan currently holds, which is unreachable through the front
   * door (the snapshot is written in the same handler that fires the write) and is the right
   * answer for the one caller that can produce it: a story or a test mounting an already-answered
   * write, where the plan beside it *is* the list that was pressed.
   */
  const [sent, setSent] = useState<readonly WishOptimizeMove[] | null>(null);
  const outcome = useMemo(
    () =>
      apply.isSuccess && apply.data !== undefined
        ? summariseOutcome(apply.data.results, sent ?? moves)
        : null,
    [apply.isSuccess, apply.data, sent, moves],
  );

  const applyRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  const pending = apply.isPending;

  // The disabled-on-press hazard, in `PullFromCollectionDialog`'s shape: a browser blurs a control
  // that disables itself, with no `relatedTarget` at all, so the caret lands on `<body>` and the
  // reader's next Tab restarts from the top of the panel — which is the ✕. Only from `<body>`,
  // because a reader who has moved on in the meantime owns where they are.
  useEffect(() => {
    if (wasPending.current && !pending && document.activeElement === document.body) {
      applyRef.current?.focus();
    }
    wasPending.current = pending;
  }, [pending]);

  const failure = apply.isError ? ipcError(apply.error) : null;
  const { currency } = marketplace;

  /**
   * The one sentence a screen reader is told when the write lands.
   *
   * **Mounted for the life of the body and swapped into**: a live region that appears together
   * with its own text announces nothing, because there was no change to notice. It is `sr-only`
   * because the panel below says the same thing at length and in the place the reader is already
   * looking — this is the announcement, not a second copy on screen.
   */
  const spoken = outcome === null ? "" : headlineOf(outcome, currency);

  return (
    // The shell's header sits above these two, and the panel around them is the `flex flex-col`
    // that makes the scroller work — see `Dialog`.
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {outcome !== null ? (
          <Outcome outcome={outcome} marketplace={marketplace} />
        ) : loading ? (
          <p className="px-2 py-6 text-center text-xs text-dim">{CHECKING}</p>
        ) : readError !== null ? (
          // The read's own refusal, in the backend's words, where the rows would have been. No
          // retry button: the query re-runs the next time this opens, and every wishlist write in
          // the app already invalidates the key it sits under.
          <p className="px-2 py-6 text-center text-xs text-dim">{readError}</p>
        ) : moves.length === 0 ? (
          <NothingToDo plan={plan} />
        ) : (
          <>
            {/* The select-all, on its own line above the list rather than inside the first row:
                it is about the whole list, and a control that shared a row with one wish would
                read as that wish's. */}
            <div className="flex items-center gap-2 border-b border-border px-2 pb-2 pt-1">
              <SelectAll
                id={`${id}-all`}
                state={selection.all}
                onChange={(on) => setTouched(on ? everyMove(moves) : new Set<WishId>())}
              />
              <label htmlFor={`${id}-all`} className="text-xs text-dim">
                Select all
              </label>
              {/* Beside the control rather than inside its label: the name of a checkbox must not
                  move as the reader ticks, or the control renames itself under their finger. */}
              <span className="ml-auto font-mono text-xs tabular-nums text-dim">
                {selection.count} of {moves.length} selected
              </span>
            </div>

            {/* A list rather than a `<table>`: every cell is a control or a caption on one, the
                columns do not sort, and `components/table/VirtualTable.tsx` is what a table is in
                this app. A wishlist is tens of rows, so it is not virtualised either. */}
            <ul>
              {moves.map((move) => (
                <Row
                  key={move.wishId}
                  move={move}
                  on={ticked.has(move.wishId)}
                  currency={currency}
                  folder={flattened ? (folderNameOf?.(move.folderId) ?? null) : null}
                  onToggle={(on) =>
                    setTouched((was) => toggleTicked(was ?? ticked, move.wishId, on))
                  }
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-3.5">
        {/* The quiet line: whose prices these are, and what the sweep passed over. Both are
            qualifications of the figures beside them rather than things to press. */}
        <p className="min-w-[16rem] flex-1 text-[0.7rem] leading-snug text-dim">
          {pricesAsOf(marketplace)}
          {plan !== null && outcome === null && moves.length > 0 && ` ${passedOver(plan)}`}
        </p>

        <p role="status" aria-live="polite" className="sr-only">
          {spoken}
        </p>

        {/* Beside the button that was pressed, not on the page behind the scrim — a refusal
            reported somewhere the reader cannot see is one they have to go looking for. Its own
            animated element, carrying no padding and no border so `height: 0` really is 0. */}
        <AnimatePresence initial={false}>
          {failure !== null && (
            <motion.p
              {...statusLine}
              role="alert"
              className="min-w-0 shrink overflow-hidden text-right text-[0.7rem] text-destructive"
            >
              Could not switch those wishes — {failure}
            </motion.p>
          )}
        </AnimatePresence>

        {outcome === null ? (
          <>
            {/* **The total over the ticked rows and nothing else**, which is the figure the press
                is about — the plan's other counts are the quiet line's, on the left, where they
                qualify rather than compete. Deliberately not a live region: it moves on every
                tick, and a control that announces itself forty times while a reader works down a
                list is a control they turn off. */}
            <p className="shrink-0 font-mono text-xs tabular-nums text-dim">
              {formatPrice(selection.saved, currency)}
              {selection.unpriced > 0 && (
                <span className="ml-2 text-[0.7rem]">
                  + {plural(selection.unpriced, "unpriced wish", "unpriced wishes")}
                </span>
              )}
            </p>

            <button type="button" onClick={onClose} className={CANCEL}>
              Cancel
            </button>

            <button
              ref={applyRef}
              type="button"
              disabled={pending}
              // `aria-disabled` and not the attribute, because this greys and un-greys as the
              // reader works and a real `disabled` button leaves the tab order — so a reader who
              // unticked their last row would find the caret thrown out of the footer by their
              // own press (`src/CLAUDE.md`). `pending` is the other kind of no and *is* the
              // attribute: it is the half-second the write is in flight.
              aria-disabled={selection.count === 0 || undefined}
              onClick={() => {
                // The guard the paint would otherwise be lying about: an `aria-disabled` control
                // still delivers its press.
                if (selection.count === 0) return;
                // The snapshot first, so the outcome can be read against the plan that was
                // pressed rather than against whatever the refetch brings back.
                setSent(moves);
                apply.mutate([...selection.items]);
              }}
              className={CONFIRM}
            >
              {/* The verb keeps its name through the flow — this button says *Switch* and the
                  outcome says *Switched*. `Switch 0 wishes` at nothing ticked rather than a bare
                  `Switch`: the count is what explains the greying, which is the difference
                  between a control that is out of reach and one that looks broken. */}
              {pending ? "Switching…" : `Switch ${plural(selection.count, "wish", "wishes")}`}
            </button>
          </>
        ) : (
          // One way out once the write has landed. Not `Cancel`, which would offer to undo
          // something that is already done.
          <button type="button" onClick={onClose} className={CONFIRM}>
            Done
          </button>
        )}
      </footer>
    </>
  );
}

/**
 * The select-all checkbox, tri-state.
 *
 * `indeterminate` is a **DOM property and not an attribute**, so it cannot be set in JSX and has
 * to be written to the element — which is what this wrapper exists for. It draws the `"some"`
 * state as the dash a reader already knows from every file manager, and the browser maps it to
 * `aria-checked="mixed"` on its own. **No hand-written `aria-checked` beside it**: on a native
 * checkbox that is a second answer to a question the element already answers, and the two can
 * disagree.
 *
 * The press always goes one way from `"some"` — to all of them — because that is the press a
 * reader wants from a half-ticked list. Emptying it is the second press.
 */
function SelectAll({
  id,
  state,
  onChange,
}: {
  id: string;
  state: "all" | "none" | "some";
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      checked={state === "all"}
      onChange={(e) => onChange(e.target.checked)}
      className={cn("size-4 shrink-0 accent-accent", FOCUS)}
    />
  );
}

/**
 * One wish, where it is pinned, where one press would pin it, and what that is worth.
 *
 * **Three lines rather than one**, which is `PullFromCollectionDialog`'s row for its arithmetic:
 * at `w-[48rem]` the row's content box is ~710px, and the checkbox, the price column and the gaps
 * take ~230 of it — two printings spelled `SET · NUMBER · LANG` on either side of an arrow do not
 * fit beside a card's name. Under the name they cost a line of height and nothing else.
 */
function Row({
  move,
  on,
  currency,
  folder,
  onToggle,
}: {
  move: WishOptimizeMove;
  on: boolean;
  currency: Marketplace["currency"];
  /** The drawer this wish is filed in, drawn only while the list is flattened. */
  folder: string | null;
  onToggle: (on: boolean) => void;
}) {
  return (
    <li
      className={cn(
        "rounded-md px-2 py-2",
        "transition-colors duration-150 hover:bg-surface",
        "motion-reduce:transition-none",
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(e.target.checked)}
          // Named for the card, never a bare "Select": a column of forty checkboxes with one name
          // is forty controls a screen reader cannot tell apart. The name does **not** move with
          // the tick — it says what the row is, not what the row is currently doing.
          aria-label={`Switch ${saidAs(move)}`}
          className={cn("mt-1 size-4 shrink-0 accent-accent", FOCUS)}
        />

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-sm">{move.name}</span>
            {/* The finish the wish asked for. `null` — the reader has not said — draws nothing,
                which is right: the plain card is the unmarked case everywhere in this app, and
                the glyph carries its own `role="img"` and label so a screen reader hears "Foil"
                rather than reading a shape. */}
            <FinishMark finish={move.preferredFinish ?? "nonfoil"} />
            {/* **Only above one**, and it is what makes the saving column legible: a row saving
                four times its per-copy figure has to say why. `×` because the count sits beside
                the card rather than on it (`src/CLAUDE.md`'s `CountTag` rule). */}
            {move.quantity > 1 && (
              <span className="shrink-0 font-mono text-[0.7rem] tabular-nums text-dim">
                ×{move.quantity}
              </span>
            )}
            {folder !== null && (
              <span className="min-w-0 shrink truncate text-[0.7rem] text-dim">in {folder}</span>
            )}
          </span>

          {/* **Both printings in full, language included.** The set and the number are what the
              rest of the app spells a printing with; the language is here because a cheaper
              printing in another language is a real answer and the only way to refuse one is to
              see it. The arrow is `aria-hidden` with an `sr-only` word beside it — what a screen
              reader makes of "→" ranges from "right arrow" to silence. */}
          <span className="flex flex-wrap items-baseline gap-x-2 font-mono text-[0.7rem] tabular-nums text-dim">
            <span>{printingFace(move.from)}</span>
            <span aria-hidden="true">→</span>
            <span className="sr-only">to</span>
            <span className="text-text">{printingFace(move.to)}</span>
          </span>
        </span>

        <span className="flex w-40 shrink-0 flex-col items-end gap-0.5 pt-0.5 text-right">
          {/* The two prices, at the wish's own finish and at this marketplace. An em dash is the
              answer for a printing nothing here lists — never another marketplace's number and
              never a zero (`src/CLAUDE.md`). */}
          <span className="font-mono text-xs tabular-nums">
            <span className={move.from.price === null ? "text-dim" : undefined}>
              {formatPrice(move.from.price, currency)}
            </span>
            <span aria-hidden="true"> → </span>
            <span className="sr-only"> to </span>
            <span>{formatPrice(move.to.price, currency)}</span>
          </span>

          {move.saved === null ? (
            // **A statement, not a warning.** `text-dim` and no live-region role: an unpriced
            // current printing is an ordinary hole in a bulk feed, not a fault, and it is the
            // whole reason this row opens unticked.
            <span className="text-[0.7rem] leading-snug text-dim">No saving to count</span>
          ) : (
            <span className="text-[0.7rem] text-dim">
              Save{" "}
              <span className="font-mono tabular-nums text-text">
                {formatPrice(move.saved, currency)}
              </span>
              {move.quantity > 1 && move.savedPerCopy !== null && (
                <span className="font-mono tabular-nums">
                  {" "}
                  ({formatPrice(move.savedPerCopy, currency)} × {move.quantity})
                </span>
              )}
            </span>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * The two shapes of an empty plan, told apart — and the counts either way.
 *
 * Not styled as a failure, which is the state most likely to be mistaken for one: a reader
 * arriving here has just pressed a button expecting a list, so the panel has to say why there
 * isn't one.
 */
function NothingToDo({ plan }: { plan: WishlistOptimizePlan | null }) {
  const empty = plan === null || plan.considered === 0;
  const words = empty ? NOTHING_IN_SCOPE : ALREADY_CHEAPEST;
  return (
    <div className="mx-auto max-w-md px-2 py-6 text-center">
      <p className="text-sm">{words.headline}</p>
      <p className="mt-2 text-xs leading-relaxed text-dim">{words.why}</p>
      {plan !== null && (
        <p className="mt-3 font-mono text-[0.7rem] tabular-nums text-dim">{passedOver(plan)}</p>
      )}
      {plan !== null && plan.skipped > 0 && (
        <p className="mt-1 text-[0.7rem] leading-snug text-dim">{SKIPPED_NOTE}</p>
      )}
    </div>
  );
}

/**
 * What the press actually did — **the dialog stays open to say it**.
 *
 * The page underneath has no place for a transient sentence and the reader has just asked a
 * question they are owed an answer to: how many wishes moved, how many folded into a wish that
 * was already there, what was really saved, and **which rows were left alone**. That last one is
 * the reason this is a panel rather than a line: a skipped change reported as a number is a
 * change the reader cannot go and look at.
 */
function Outcome({
  outcome,
  marketplace,
}: {
  outcome: OptimizeOutcome;
  marketplace: Marketplace;
}) {
  const { currency } = marketplace;
  const moved = outcome.changed + outcome.merged;
  return (
    <div className="mx-auto max-w-lg px-2 py-6">
      <p className="text-center text-sm">{headlineOf(outcome, currency)}</p>

      {moved > 0 && (
        <ul className="mt-3 space-y-1 text-center text-xs leading-relaxed text-dim">
          {/* The merge is the app's own documented rule rather than a failure, and it is the one
              outcome a reader would otherwise read as a wish going missing: two rows became one
              because they are now the same wish. The saving still stands. */}
          {outcome.merged > 0 && (
            <li>
              {count(outcome.merged)} of them folded into a wish you already had in the same folder
              at the same finish — the copies were added together.
            </li>
          )}
          {outcome.unpriced > 0 && (
            <li>
              {plural(outcome.unpriced, "wish", "wishes")} moved from a printing this marketplace
              does not price, so {outcome.unpriced === 1 ? "it counts" : "they count"} nothing
              toward that figure.
            </li>
          )}
        </ul>
      )}

      {outcome.skipped.length > 0 && (
        <div className="mt-4 rounded-md border border-border px-3 py-2">
          <p className="text-xs">
            {plural(outcome.skipped.length, "wish was", "wishes were")} left exactly as
            {outcome.skipped.length === 1 ? " it was" : " they were"}.
          </p>
          <ul className="mt-1.5 space-y-1 text-[0.7rem] leading-snug text-dim">
            {outcome.skipped.map((skip) => (
              <li key={skip.wishId}>{skippedLine(skip)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The one sentence the outcome leads with — and the one the live region announces.
 *
 * **Zero moved is its own sentence rather than "Switched 0 wishes"**: every row came back `stale`
 * or `missing`, which is a reason rather than a number, and the panel underneath names them.
 */
function headlineOf(outcome: OptimizeOutcome, currency: Marketplace["currency"]): string {
  const moved = outcome.changed + outcome.merged;
  if (moved === 0) return "Nothing moved — every wish had already changed since the preview.";
  return (
    `Switched ${plural(moved, "wish", "wishes")} to the cheapest printing, ` +
    `saving ${formatPrice(outcome.saved, currency)}.`
  );
}

/** One skipped wish, named and explained — the two statuses are two different things to do about
 *  it, so they are two different sentences rather than one word in a column. */
function skippedLine(skip: OptimizeSkip): string {
  const name = skip.name ?? `Wish ${skip.wishId}`;
  return skip.status === "stale"
    ? `${name} — its printing had already changed, so nothing was written.`
    : `${name} — it is not on your wishlist any more.`;
}

/**
 * What the sweep looked at and passed over, in one line.
 *
 * The three counts partition `considered` ({@link WishlistOptimizePlan}), so they are stated
 * together or not at all: a reader checking the preview against the `Wishes` figure in the page
 * header needs the whole arithmetic, and `11 already cheapest` on its own over a list of four
 * rows is a number with nothing to add up to.
 */
function passedOver(plan: WishlistOptimizePlan): string {
  return (
    `Checked ${plural(plan.considered, "wish", "wishes")} · ` +
    `${count(plan.alreadyCheapest)} already cheapest · ${count(plan.skipped)} skipped.`
  );
}

/** A printing as this app spells one, plus the language — `SET · NUMBER · LANG`. The language is
 *  always drawn here; see the file's own note for why this list suspends the app's usual rule
 *  about a column of `EN`s. */
function printingFace(printing: OptimizePrinting): string {
  return `${printing.setCode.toUpperCase()} · ${printing.collectorNumber} · ${printing.lang.toUpperCase()}`;
}

/**
 * A wish as a checkbox says it aloud — `cardControl.tsx`'s `deckCardName` grammar, which is a
 * comma-separated list of clauses running from what the card *is* to what is true of it.
 *
 * The quantity is a clause because it is what multiplies the saving, and the finish is one
 * because **two rows can otherwise carry the same name**: a reader wanting the foil and the plain
 * copy of one card has two wishes, and two checkboxes with one name is two controls a screen
 * reader cannot tell apart. Lowercased for `deckCardName`'s reason — `FINISH_LABEL` is written as
 * a label and this is a sentence.
 */
function saidAs(move: WishOptimizeMove): string {
  const parts = [
    move.name,
    plural(move.quantity, "copy", "copies"),
    ...(move.preferredFinish === null || move.preferredFinish === "nonfoil"
      ? []
      : [FINISH_LABEL[move.preferredFinish].toLowerCase()]),
  ];
  return parts.join(", ");
}
