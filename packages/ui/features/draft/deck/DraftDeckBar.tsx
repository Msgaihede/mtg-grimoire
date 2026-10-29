import { memo, useState, type JSX, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Crown, Save, SquareArrowRightExit, Trash2 } from "lucide-react";
import { FILTER_FOCUS } from "@/components/FilterChips";
import { ManaText } from "@/components/ManaText";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { ipc, ipcError, type BasicLand } from "@/lib/ipc";
import { MANA_LABEL, MANA_LINE_KEYS } from "@/lib/mana";
import { notify } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { PLAIN_PRESS } from "@/features/decks/headerControls";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "@/features/decks/metaRows";
import { returnToDraftPage } from "../navigation";
import { COMMANDER_DECK_SIZE } from "../deckSize";
import { useDiscardDraftDeck, useKeepDraftDeck } from "../useDraftDecks";

/** How many copies a Shift-press adds — a reader building a 40-card deck adds lands in fives. */
export const BASICS_SHIFT_COPIES = 5;

/** The basics' query key, under its own root: a basic printing is a fact about the corpus and the
 *  draft's sets, not about any deck, so no deck write needs to move it. */
export const draftBasicsKey = (setCodes: readonly string[]) =>
  ["draftBasics", [...setCodes].sort().join(",")] as const;

/** A Commander draft's deck as the bar checks it: the cards that count (Deck and Commander) and
 *  the cards in its Commander pile. */
export interface CommanderCheck {
  cards: number;
  commanders: number;
}

export interface DraftDeckBarProps {
  deckId: number;
  /** The deck's name, for the receipts — `Saved “Draft — FDN”` — and the discard question. */
  name: string;
  /**
   * The distinct set codes of the deck's cards — the draft's sets, so a basic is added in a
   * printing of one of them where the corpus has one (`draft_basic_lands`). The host derives it
   * from the rows it already holds; the order does not matter.
   */
  setCodes: readonly string[];
  /**
   * Add `quantity` copies of a basic to the deck's default pile — the editor's own add.
   *
   * **No toast**, deliberately: a basics press is a stepper in all but shape — it changes a count
   * drawn where the reader is looking — so it is exempt from the always-toast rule
   * (`packages/ui/CLAUDE.md`) and a refusal lands in the editor's banner like a stepper's.
   */
  onAddBasic: (cardId: string, quantity: number) => void;
  /** Open the editor's own export dialog on the whole deck; `trigger` takes the caret back. */
  onExport: (trigger: HTMLElement) => void;
  /**
   * A Commander draft's deck (it has a Commander pile, spec §4a): the bar says its count against
   * 60 and whether a commander is chosen. `null` or absent for a Limited draft deck, whose size
   * the editor's own ledger already checks against the format.
   */
  commander?: CommanderCheck | null;
}

/**
 * **The deck editor's draft mode** (spec §5): what the editor draws for a deck a draft made and
 * the reader has not saved yet — in place of the card search dock, Quick Add and the collection's
 * surfaces, which the editor leaves off for such a deck.
 *
 * One line saying why the searches are gone, then the three things a draft deck needs that an
 * ordinary deck gets elsewhere: **Basics** (a strip of five — a drafted pool holds no basic lands,
 * and with no search there is no other way to add one), **Save deck** (the deck leaves the
 * unsaved list and is a deck like any other), **Export** (the editor's own dialog) and **Discard**
 * (the deck and its pool are deleted, behind a question).
 *
 * Memoised: every prop is held still by the editor (`setCodes` is memoised on its joined text),
 * so a stepper press elsewhere on the desk does not redraw it.
 */
export const DraftDeckBar = memo(function DraftDeckBar({
  deckId,
  name,
  setCodes,
  onAddBasic,
  onExport,
  commander = null,
}: DraftDeckBarProps): JSX.Element {
  const tip = useTooltip();
  const keep = useKeepDraftDeck();
  const discard = useDiscardDraftDeck();
  const [asking, setAsking] = useState(false);

  const basics = useQuery({
    queryKey: draftBasicsKey(setCodes),
    queryFn: () => ipc.draftBasicLands([...setCodes]),
    staleTime: Infinity,
  });
  const byColor = new Map<string, BasicLand>((basics.data ?? []).map((b) => [b.color, b]));

  const save = () => {
    keep.mutate(deckId, {
      onSuccess: () => notify.success(`Saved “${name}” to your decks`),
      onError: (failure) => notify.error("Couldn't save the deck", { body: ipcError(failure) }),
    });
  };

  const discardNow = () => {
    discard.mutate(deckId, {
      onSuccess: () => {
        notify.info(`Discarded “${name}”`);
        returnToDraftPage();
      },
      onError: (failure) => notify.error("Couldn't discard the deck", { body: ipcError(failure) }),
    });
  };

  return (
    <section
      aria-label="Draft deck"
      className="flex shrink-0 flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-xs text-dim">
          Draft deck — build from your Pool; the collection and card search are off.
        </p>

        {/* Five presses in WUBRG order, the order the symbols are printed in. A colour the corpus
            has no basic for (or a read not landed yet) is greyed rather than absent, so the strip
            keeps its shape. */}
        <div role="group" aria-label="Basic lands" className="flex items-center gap-1">
          <span className="mr-1 text-[0.6875rem] text-dim">Basics</span>
          {MANA_LINE_KEYS.map((key) => {
            const land = byColor.get(key);
            const label =
              land === undefined
                ? `No ${MANA_LABEL[key]} basic land in this corpus`
                : `Add a ${land.name} — Shift-click adds ${BASICS_SHIFT_COPIES}`;
            return (
              <button
                key={key}
                type="button"
                aria-label={
                  land === undefined ? `No ${MANA_LABEL[key]} basic land` : `Add ${land.name}`
                }
                aria-disabled={land === undefined}
                {...tip(label, { describes: false })}
                onClick={(e: MouseEvent<HTMLButtonElement>) => {
                  if (land === undefined) return;
                  onAddBasic(land.cardId, e.shiftKey ? BASICS_SHIFT_COPIES : 1);
                }}
                className={cn(
                  PLAIN_PRESS,
                  FILTER_FOCUS,
                  "grid w-9 place-items-center px-0",
                  land === undefined ? "cursor-default opacity-40" : "hover:text-text",
                )}
              >
                <ManaText source={`{${key}}`} className="text-sm" />
              </button>
            );
          })}
        </div>

        {commander !== null && <CommanderStatus check={commander} />}

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={keep.isPending}
            className={cn(PLAIN_PRESS, FILTER_FOCUS, "inline-flex items-center gap-1.5 text-text")}
          >
            <Save aria-hidden className="size-4" />
            Save deck
          </button>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={(e) => onExport(e.currentTarget)}
            className={cn(PLAIN_PRESS, FILTER_FOCUS, "inline-flex items-center gap-1.5")}
          >
            <SquareArrowRightExit aria-hidden className="size-4" />
            Export
          </button>
          <button
            type="button"
            aria-expanded={asking}
            onClick={() => setAsking(true)}
            className={cn(
              PLAIN_PRESS,
              FILTER_FOCUS,
              "inline-flex items-center gap-1.5 hover:text-destructive",
            )}
          >
            <Trash2 aria-hidden className="size-4" />
            Discard
          </button>
        </div>
      </div>

      {asking && (
        <DiscardQuestion
          name={name}
          pending={discard.isPending}
          onCancel={() => setAsking(false)}
          onDiscard={discardNow}
        />
      )}
    </section>
  );
});

/** A Commander draft deck's two checks: its count against 60, and its commander. */
function CommanderStatus({ check }: { check: CommanderCheck }): JSX.Element {
  const sized = check.cards >= COMMANDER_DECK_SIZE;
  const chosen = check.commanders > 0;
  return (
    <div role="group" aria-label="Commander deck" className="flex items-center gap-3 text-xs">
      <span className={cn("inline-flex items-center gap-1", sized ? "text-ok" : "text-dim")}>
        {sized && <Check aria-hidden className="size-3.5" />}
        <span className="font-mono tabular-nums">
          {check.cards}/{COMMANDER_DECK_SIZE}
        </span>{" "}
        cards
      </span>
      <span className={cn("inline-flex items-center gap-1", chosen ? "text-ok" : "text-dim")}>
        <Crown aria-hidden className="size-3.5" />
        {chosen ? "Commander chosen" : "No commander yet — put one in the Commander pile"}
      </span>
    </div>
  );
}

/** The question under the bar — the deck folder's own inline confirmation, not a dialog: the
 *  reader is already looking here, and the answer is one press. */
function DiscardQuestion({
  name,
  pending,
  onCancel,
  onDiscard,
}: {
  name: string;
  pending: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const confirm = useConfirmFocus(`Discard ${name}`);
  return (
    <div {...confirm}>
      <p className="text-xs">Discard “{name}”?</p>
      <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-destructive">
        The deck and the pool you drafted are deleted. Nothing in your collection changes.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={onDiscard}
          className={CONFIRM_DESTRUCTIVE}
        >
          Discard deck
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Keep it
        </button>
      </div>
    </div>
  );
}
