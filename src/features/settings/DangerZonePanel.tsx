import { useState, type JSX, type ReactNode } from "react";
import { useDeckDrivenCollection } from "@/lib/useDeckDrivenCollection";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";
import type { ClearAction, DangerZone } from "./useDataReset";

/**
 * Which of the three questions is open. **One value, never three flags** — the deck gallery's
 * `Panel` union states the reason in full and it holds here for a smaller surface: two
 * half-answered confirmations at once is not a state this page draws, and separate booleans can
 * express it.
 */
type Asking = "collection" | "wishlist" | "decks" | null;

/** One row: what it clears, what pressing it does, and what the confirmation has to promise. */
interface Row {
  key: Exclude<Asking, null>;
  /** The button's words, and the confirmation's heading. */
  label: string;
  /** The line under the label on the panel — what the reader is choosing between. */
  summary: string;
  /**
   * The warning inside the dialog, which is a different job from {@link summary}: this one
   * names the **consequences a reader did not ask for**, because those are the whole reason
   * the typed word exists.
   */
  warning: ReactNode;
}

/**
 * The collection row's summary, and the clause it gains while the collection is deck-driven.
 *
 * **The button itself stays enabled on purpose** — clearing the hidden hand-built rows is a
 * legitimate thing to want, and the backend deliberately allows this one write while the
 * setting is on. So this is the whole of what deck-driven collection changes here: one clause,
 * said where the button already is, on the sentence that is on screen without the reader
 * opening anything.
 */
const COLLECTION_SUMMARY =
  "Every card you own, with its condition, purchase price, tags and notes.";
const COLLECTION_SUMMARY_DECK_DRIVEN =
  "Every card you own, with its condition, purchase price, tags and notes — your hand-built " +
  "collection, which is currently hidden because this collection is driven by your decks.";

const ROWS: readonly Row[] = [
  {
    key: "collection",
    label: "Clear collection",
    summary: COLLECTION_SUMMARY,
    warning: (
      <>
        Deletes every entry in your collection — each one’s condition, purchase price, tags,
        notes and acquisition story with it. Your decks are kept, but every card in them stops
        being marked as owned. This cannot be undone.
      </>
    ),
  },
  {
    key: "wishlist",
    label: "Clear wishlist",
    summary: "Every card you are looking for and every folder, with its preferred finish and notes.",
    warning: (
      <>
        Deletes every entry on your wishlist and every folder you filed them in, along with the
        finish and notes recorded against each one. Your collection and decks are not touched.
        This cannot be undone.
      </>
    ),
  },
  {
    key: "decks",
    label: "Clear decks",
    summary: "Every deck and folder, with its cards, piles, tags, cover and history.",
    warning: (
      <>
        Deletes every deck and every folder — the cards in each deck, its piles, its tags, its
        cover picture and its whole edit history. Your collection and wishlist are kept. This
        cannot be undone.
      </>
    ),
  },
];

/**
 * The three irreversible clears.
 *
 * ## Why a panel of its own, at the bottom of the page
 *
 * Nothing here can be taken back. `deck_audit` is per-deck and cascades away with the decks it
 * describes, so there is nowhere for a wipe to be recorded and nothing for Undo to read — which
 * means the confirmation is not the *first* line of defence, it is the only one. Everything
 * about this panel is spent on making that separation visible: its own region, its own heading,
 * the destructive red on all three buttons, and last on a page whose other four panels are
 * ordinary settings.
 *
 * ## Why the typed word
 *
 * `ConfirmDialog`'s `typeToConfirm` makes the reader write out `Confirm` before the button
 * arms. A second press of Enter cannot do this by accident, and neither can a click landing
 * where a dialog used to be. The cache panel above deliberately does **not** ask for it — see
 * that prop, and the short version is that a word typed on every dialog is a word nobody reads.
 *
 * ## One status line for three buttons
 *
 * `useDangerZone` owns the rule (`@/lib/writes`: the most recently *started* write owns the
 * banner) so this component renders one sentence and makes no decision about which.
 */
export function DangerZonePanel({ danger }: { danger: DangerZone }): JSX.Element {
  const { deckDriven } = useDeckDrivenCollection();
  // The one row this setting touches, and only its summary — the button underneath it stays
  // exactly as enabled as it always was.
  const rows: readonly Row[] = deckDriven
    ? ROWS.map((row) =>
        row.key === "collection" ? { ...row, summary: COLLECTION_SUMMARY_DECK_DRIVEN } : row,
      )
    : ROWS;
  const [asking, setAsking] = useState<Asking>(null);
  // **The row outlives the flag by the length of the dialog's fade**, which is why it is held
  // beside `asking` rather than looked up from it. `Dialog` animates out over ~200 ms, and a
  // heading derived from `asking` would blank to an empty string on the render that starts the
  // exit — a dialog visibly losing its own title as it closes. `DecksPage` holds its
  // `settingsDeckId` beside its panel flag for exactly this, and says so there. Never cleared:
  // it is only ever read while something is or was open.
  const [shown, setShown] = useState<Row | null>(null);
  const action: Record<Exclude<Asking, null>, ClearAction> = {
    collection: danger.collection,
    wishlist: danger.wishlist,
    decks: danger.decks,
  };
  const ask = (row: Row) => {
    setShown(row);
    setAsking(row.key);
  };
  const pending = shown === null ? false : action[shown.key].pending;

  return (
    <SettingsSection id="danger" title="Clear data">
      {/* **No promise the page cannot keep.** This said "in the folder named on this page" until
          it was read in the shipped window, where the data folder is named nowhere on Settings —
          it is a tooltip on the ribbon's status line, and "Not here yet" is what this page says
          about the folder. A sentence that sends a reader looking for something that is not
          there is worse than the shorter one. */}
      <p className="text-sm text-dim">
        Each of these empties one part of the app for good. There is no undo and no backup — the
        app keeps a single copy of your data, and these buttons delete it.
      </p>

      <ul className="space-y-3">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0"
          >
            <p className="min-w-0 text-sm text-dim">{row.summary}</p>
            <button
              type="button"
              onClick={() => ask(row)}
              disabled={action[row.key].pending}
              aria-busy={action[row.key].pending || undefined}
              className={cn(
                BUTTON,
                "border-destructive text-destructive",
                "transition-colors duration-150 hover:bg-destructive hover:text-bg",
                "disabled:hover:bg-transparent disabled:hover:text-destructive",
                "motion-reduce:transition-none",
              )}
            >
              {row.label}
            </button>
          </li>
        ))}
      </ul>

      {/* `problem` for a refusal and `plain` for a result, which is `PanelAlert`'s own split:
          "cleared 1,284 collection entries" is not bad news, and drawing it in the destructive
          red would make the panel shout about the thing the reader just asked for. */}
      <PanelAlert tone={danger.status?.tone ?? "plain"}>{danger.status?.text ?? null}</PanelAlert>

      {/* One dialog, not three: `asking` is a single value, so there is exactly one to mount —
          and the shell's "closed is nothing mounted" is what throws the typed word away between
          them, with no effect to reset it and no way for a half-typed confirmation to survive a
          cancel and turn up on the next question. */}
      <ConfirmDialog
        open={asking !== null}
        title={shown?.label ?? ""}
        confirmLabel={shown?.label ?? ""}
        typeToConfirm
        pending={pending}
        onConfirm={() => shown && action[shown.key].run()}
        onDismiss={() => setAsking(null)}
        onClose={() => setAsking(null)}
      >
        {shown?.warning}
      </ConfirmDialog>
    </SettingsSection>
  );
}
