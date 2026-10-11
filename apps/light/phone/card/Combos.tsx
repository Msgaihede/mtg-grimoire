import { useId, useState } from "react";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { CardArt } from "@grimoire/ui/components/CardArt";
import { ManaText } from "@grimoire/ui/components/ManaText";
import {
  bracketRange,
  bracketSentence,
  COMBOS_AS_OF,
  COMBOS_NO_ORACLE_CARD,
  COMBOS_PAGE_SIZE,
  combosReadFailed,
  emptyCombosSentence,
  missingCount,
  nextComboOffset,
  otherPieces,
  ownedNote,
  ownedSummary,
  splitLines,
} from "@grimoire/ui/features/card/combos";
import { COMBO_TAG } from "@grimoire/ui/features/decks/DeckBracket";
import { comboBrackets } from "@grimoire/ui/features/decks/validation/bracket";
import { count, plural } from "@grimoire/ui/lib/counts";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { ipc, ipcError, type CardCombo, type ComboStatus } from "@grimoire/ui/lib/ipc";
import { COMBOS_STATUS_KEY, cardCombosKey } from "@grimoire/ui/lib/query";
import { cn } from "@grimoire/ui/lib/utils";
import { Note, SheetSection, ShowMore, Source } from "./parts";

/**
 * How many combos the folded list draws. Three, because a combo line is two or three lines of
 * type and the section sits under everything else about the card: the first three are the
 * smallest ones (the backend sorts by size, then popularity), which are what a reader looking at
 * one card is most likely to be asking about.
 */
export const COMBOS_FOLDED = 3;

/**
 * Which combos **name this card** — Commander Spellbook's feed asked about one card rather than a
 * pile, which is the card modal's `Combos` row on the desktop and this section here.
 *
 * **The desktop's read, page for page.** `useInfiniteQuery` under `cardCombosKey` with no search,
 * no size and no ownership filter — exactly the key `CombosDialog` opens on — and the dialog's own
 * page size and pager out of `@/features/card/combos`. An infinite query's cache entry is its
 * pages, so a second reader paging that key at a different size would hand the dialog pages it
 * never asked for. All four printings of a card share one answer, because a combo names an oracle
 * card and not a piece of cardboard.
 *
 * **Five states that are not a list, and two of them must never share a sentence** —
 * `commander-brackets.md`'s card-side table, drawn here as it is in the dialog. *We have never
 * downloaded the list* is a fact about the reader's database; *this card is in no combo* is a fact
 * about their card; `combos_for_card` answers both with zero rows, so the status row decides, and
 * nothing is drawn until both reads have landed. A printing with no oracle card asks nothing at
 * all, a read in flight says so, and a refused read says so in the backend's words rather than
 * reading as an absence. The dialog's fourth empty, *no combo matches that filter*, cannot arise
 * here: the sheet draws no filter.
 *
 * **What is skipped is the way out**: the dialog's *View on Commander Spellbook* is not drawn here
 * yet. The seam it waited for exists since phase 5 (`card/OpenOn.tsx` has the sheet's other links).
 */
export function CombosSection({ oracleId }: { oracleId: string | null }) {
  const listId = useId();
  const [expanded, setExpanded] = useState(false);

  const combos = useInfiniteQuery({
    queryKey: cardCombosKey(oracleId ?? "", null, null, false),
    // No call at all for a card with no oracle id — the command matches on oracle id, so a null
    // one has nothing to ask about.
    queryFn:
      oracleId !== null
        ? ({ pageParam }) =>
            ipc.combosForCard({
              oracleId,
              search: null,
              cardCount: null,
              ownedOnly: false,
              limit: COMBOS_PAGE_SIZE,
              offset: pageParam,
            })
        : skipToken,
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextComboOffset(pages),
  });
  const status = useQuery<ComboStatus>({
    queryKey: COMBOS_STATUS_KEY,
    queryFn: () => ipc.combosStatus(),
  });

  // `total`, never `matching`: it is the one number nothing can narrow, and the empty branch has
  // to be about the card rather than about a filter. Here the two are equal — no filter is sent —
  // and reading the right one keeps that true if the sheet ever grows one.
  const total = combos.data?.pages[0]?.total ?? 0;
  const rows = combos.data?.pages.flatMap((page) => page.combos) ?? [];
  const shown = expanded ? rows : rows.slice(0, COMBOS_FOLDED);

  const body =
    oracleId === null ? (
      <Note>{COMBOS_NO_ORACLE_CARD}</Note>
    ) : combos.isError ? (
      <Note tone="alert">{combosReadFailed(ipcError(combos.error))}</Note>
    ) : combos.isPending || status.isPending ? (
      <Note>Loading combos…</Note>
    ) : total === 0 ? (
      <Note>{emptyCombosSentence(status.data)}</Note>
    ) : (
      <>
        <ul id={listId} aria-label="Combos" className="flex flex-col gap-1.5">
          {shown.map((combo) => (
            <ComboItem key={combo.id} combo={combo} oracleId={oracleId} />
          ))}
        </ul>
        {total > COMBOS_FOLDED && (
          <ShowMore
            expanded={expanded}
            controls={listId}
            onToggle={() => setExpanded((open) => !open)}
            more={`Show all ${count(total)} combos`}
          />
        )}
        {/* **A press, not a scroll sentinel.** The dialog pages when its rail's foot comes into
            view because the rail is its own scroller; here the list is part of the sheet's one
            column, and a page that arrived because the reader scrolled past the legality grid
            would be work nobody asked for. */}
        {expanded && combos.hasNextPage && (
          <button
            type="button"
            onClick={() => void combos.fetchNextPage()}
            aria-disabled={combos.isFetchingNextPage}
            className={cn(
              "h-11 w-full rounded-md text-sm text-accent aria-disabled:opacity-50",
              FOCUS_INSET,
            )}
          >
            {combos.isFetchingNextPage
              ? "Loading combos…"
              : `Show ${count(Math.min(COMBOS_PAGE_SIZE, total - rows.length))} more`}
          </button>
        )}
      </>
    );

  return (
    <SheetSection
      title="Combos"
      // One text node, the figure and its unit together — `6,044 combos`, never `6,044combos`.
      figure={total > 0 ? `${count(total)} ${total === 1 ? "combo" : "combos"}` : null}
    >
      {body}
      <Source>{COMBOS_AS_OF}</Source>
    </SheetSection>
  );
}

/**
 * One combo: a line to scan, and the whole combo under it on a press.
 *
 * **The line is the dialog's rail row read for a finger** — the *other* cards' names (the open
 * card is the sheet's heading already), what the combo produces, its brackets as a range, its size
 * and what the reader is short of. **Ownership is a word and never only a colour.**
 *
 * **The press unfolds in place**, the accordion the dialog grew out of, because a phone has no
 * room for a rail beside a pane: the pieces at a size a thumb can tell apart, with the reader's
 * copies under each, then the brackets in words, the prerequisites, the steps and the mana — every
 * field the feed left empty drawing nothing rather than an empty heading.
 *
 * **Named by one string**, built rather than left to fall out of the layout: the row's parts are
 * separate boxes and a `gap` is not a word separator to the accessible-name computation. Every
 * visible string on the line is in it verbatim, with the range box expanded by `bracketSentence`
 * — that is the box's reason for having a sentence at all.
 */
function ComboItem({ combo, oracleId }: { combo: CardCombo; oracleId: string | null }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const brackets = comboBrackets(combo.bracketTag);
  const names = otherPieces(combo, oracleId)
    .map((piece) => piece.name)
    .join(" + ");
  const produces = splitLines(combo.produces);
  const missing = missingCount(combo);
  const label = [
    names,
    produces.join(" · "),
    bracketSentence(brackets),
    plural(combo.cardCount, "card"),
    ownedSummary(missing),
  ]
    .filter((part) => part !== "")
    .join(". ");

  return (
    <li
      className={cn("rounded-md border", open ? "border-border bg-surface" : "border-transparent")}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${label}.`}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          "flex min-h-11 w-full items-start gap-2.5 rounded-md px-2 py-2 text-left",
          "active:bg-surface",
          FOCUS_INSET,
        )}
      >
        <span className="mt-0.5 min-w-[42px] shrink-0 rounded-md border border-border px-1 py-0.5 text-center text-xs tabular-nums text-dim">
          {bracketRange(brackets)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium leading-snug">{names}</span>
          {produces.length > 0 && (
            <span className="line-clamp-2 text-xs leading-snug text-dim">
              {produces.join(" · ")}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-xs text-dim">
            <span>{plural(combo.cardCount, "card")}</span>
            <span aria-hidden="true">·</span>
            <span className={missing === 0 ? "text-ok" : undefined}>{ownedSummary(missing)}</span>
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("mt-1 size-4 shrink-0 text-dim", open && "rotate-180")}
        />
      </button>
      {open && <ComboDetail id={panelId} combo={combo} brackets={brackets} />}
    </li>
  );
}

/** A combo, whole — the dialog's pane in one column. */
function ComboDetail({
  id,
  combo,
  brackets,
}: {
  id: string;
  combo: CardCombo;
  brackets: readonly number[];
}) {
  const tag = COMBO_TAG[combo.bracketTag];
  return (
    <div id={id} className="flex flex-col gap-3 px-2 pb-3 pt-1">
      {/* Three to a row at 360px — a 96px frame is the size a thumb can still tell two cards
          apart at, and five pieces wrap rather than scroll sideways. */}
      <ul aria-label="Pieces" className="flex flex-wrap gap-2.5">
        {combo.pieces.map((piece, i) => (
          <li key={`${piece.oracleId}:${i}`} className="flex w-24 flex-col gap-1">
            {/* `cardId === null` is a card this corpus has never synced, and `CardArt` draws its
                named, empty frame for it — this app's existing "no art" state. */}
            <CardArt cardId={piece.cardId} name={piece.name} />
            <span className="text-xs leading-snug">
              {piece.quantity > 1 ? `${piece.name} ×${piece.quantity}` : piece.name}
            </span>
            <span
              className={cn(
                "text-[0.7rem] leading-snug",
                piece.owned >= piece.quantity ? "text-ok" : "text-dim",
              )}
            >
              {`${ownedNote(piece.owned, piece.quantity)}${piece.mustBeCommander ? " · must be your commander" : ""}`}
            </span>
          </li>
        ))}
      </ul>
      {/* The brackets in words and Spellbook's own classification, each one text node. */}
      <p className="text-sm">{bracketSentence(brackets)}</p>
      <p className="text-xs text-dim">{`${tag.name} — ${tag.forces}`}</p>
      <Lines title="Prerequisites" lines={splitLines(combo.easyPrerequisites)} />
      <Lines title="Notable prerequisites" lines={splitLines(combo.notablePrerequisites)} />
      <Lines title="Steps" lines={splitLines(combo.description)} ordered />
      {combo.manaNeeded !== "" && (
        <div>
          <h4 className="text-[0.6875rem] uppercase tracking-wide text-dim">Mana needed</h4>
          <ManaText source={combo.manaNeeded} className="mt-0.5 text-sm" />
        </div>
      )}
      {/* A `requires[]` template is not a card id, so a combo that stopped at its named pieces
          would be this app implying fewer things are needed than the feed says. */}
      {combo.templateCount > 0 && (
        <p className="text-xs leading-snug text-dim">
          {`Also needs ${plural(combo.templateCount, "piece")} that can't be matched to a specific card (e.g. a creature with flying or a sacrifice outlet).`}
        </p>
      )}
    </div>
  );
}

/**
 * A titled block of a combo's lines, or nothing at all — an empty heading reads as content that
 * failed to load, on a surface whose other empties are carefully distinguished sentences.
 */
function Lines({
  title,
  lines,
  ordered = false,
}: {
  title: string;
  lines: string[];
  /** Numbered, for the steps: Spellbook's steps are a sequence, and the rest are sets. */
  ordered?: boolean;
}) {
  if (lines.length === 0) return null;
  const items = lines.map((line, i) => <li key={i}>{line}</li>);
  return (
    <div>
      <h4 className="text-[0.6875rem] uppercase tracking-wide text-dim">{title}</h4>
      {ordered ? (
        <ol
          aria-label={title}
          className="mt-1 list-decimal space-y-1 pl-5 text-sm leading-snug marker:text-dim"
        >
          {items}
        </ol>
      ) : (
        <ul aria-label={title} className="mt-1 space-y-1 text-sm leading-snug">
          {items}
        </ul>
      )}
    </div>
  );
}
