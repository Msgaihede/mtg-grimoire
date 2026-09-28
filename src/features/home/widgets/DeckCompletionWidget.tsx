/**
 * How far each deck is along, and what the rest would cost — a row per deck, with a track under the
 * name and the missing cards' price at the right.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the `Compare against` chip, the settings
 * popover and the Customize tray; this draws the rows and the footer, cut to the box `fit`
 * describes. The `Chosen…` checklist at the foot of the popover is
 * {@link DeckCompletionWidgetSettings}, which `HomePage.tsx`'s `renderExtraSettings` hands to this
 * kind — and it writes exactly what {@link completionScope} and `pinnedDeckIds` read.
 *
 * ## Two comparisons, one arithmetic (issue #600)
 *
 * `Compare against` is the question, and each answer is Rust's (`deck_completion.rs`):
 *
 * * **Collection** — every deck that is not virtual, its **actual** list against the copies filed
 *   in its own group: the deck editor's `Actual` tab, owned for owned (spec §3.1, fenced in Rust
 *   against `get_deck`). A virtual deck holds nothing by definition, so it is neither answered nor
 *   offered.
 * * **Theory** — every `Theory + Actual` deck, its **actual** list against its **theory** list:
 *   how much of the plan is already sleeved, exact printing and finish, and what the Compare
 *   dialog's shopping list would cost. A virtual deck keeps a plan like any other and is answered;
 *   a deck with no plan has nothing to compare and is not.
 *
 * Either way every active pile counts and **nothing here re-derives a count.** A card saying "4 missing" about a deck that opens saying "6 missing"
 * is a bug report, so this file draws the numbers it is handed and decides only which decks, in
 * what order, and how many fit.
 *
 * **Complete is `missing === 0` and nothing else.** `missingCost` is `null` only when nothing on
 * the measured list is priced (`DeckStats.tsx:497-509`), and a deck short only unpriced copies
 * answers `0` — so money never decides whether a deck is done, an em dash is drawn exactly for
 * `null`, and {@link rowHint} says which copies a figure leaves out.
 *
 * **A figure measured on the plan says `Plan` wherever the row is drawn** — {@link countCaption},
 * the tile's shortfall and the press's name all lead with it, and a compact panel, which draws no
 * count at all, keeps the word alone as the row's caption: its price and its track are still the
 * plan's. Under `Theory` that is every row, and the chip says so too; the word stays on each row
 * because a row read aloud, or a card whose chip is cut, has nothing else to say it. The list is counted at one height — the tallest row it may draw, since `rowsFit` takes
 * one — so once any listed row is a plan's, a compact panel counts every row at the captioned
 * height, and a live row beside it draws bare in room counted for more. A theory row's
 * `81 of 100` is its plan's hundred against the sleeved list, and a reader who opens a deck holding
 * sixty cards beside a card saying "of 100" would otherwise read the two as disagreeing. The hint says it in full; the word is what survives without a pointer. The press is
 * unchanged: it opens the deck exactly as every other row's does, and which list the editor then
 * shows is the editor's own decision.
 *
 * ## A deck that asks for nothing is not on the card
 *
 * A deck just made, or a plan not yet written, answers `wanted: 0` — and `missing === 0` is true of
 * it, so every rule above would call it complete: listed under `Complete decks`, counted in the
 * footer, and the reason a scope of nothing but fresh shells said *every deck here is complete*.
 * It is neither complete nor in progress; there is nothing to measure. {@link completionRows}
 * leaves it out, **once, before anything orders, counts or decides the card is empty**, so none of
 * those three can come to disagree about it. A scope holding only such decks draws
 * {@link emptyAll} under `All decks` and {@link CHOSEN_UNMEASURABLE} under `Chosen…`.
 *
 * ## Which decks is a filter; order is a display decision
 *
 * `All decks` is `deck_list`'s own order with archived decks and every deck the comparison cannot
 * measure taken out — a filter, never a sort, `DecksWidget`'s rule. `Chosen…` is the reader's
 * `deckIds`, less the decks {@link measurableBy} refuses: a choice made under one comparison is
 * **kept** under the other, and simply not drawn where it cannot be measured. {@link sortCompletions}
 * then orders what is left, because the registry's three orders are three readings of one answer
 * (`SetCompletionWidget.sortSets`' argument) and a command per order would be three places one
 * count is written. Every tie is settled by name through `sortOptions`.
 *
 * ## Complete decks, and the footer
 *
 * A deck missing nothing leaves the list unless the reader turns `Complete decks` on, and is counted
 * in the footer either way. **The footer is a statement about every deck in scope, never about the
 * rows the box had room for**, so a card resized smaller does not change what "$221.70 to finish
 * the rest" is a total of. See {@link completionFooter}.
 *
 * **It is one line at any width** — `WidgetFooterLine`, drawing {@link CompletionFooter.line} and
 * speaking the sentence — and it is reserved at what that line draws, `fit.ts`' `footerLinePx`: the
 * 16px line and the body's gap above it, 24px comfortable and 21 compact. The live pass of
 * 2026-09-26 measured both, against the 22 this reserved before, and found the whole sentence
 * wrapping onto a second line at three cells wide.
 *
 * ## Staying fresh: one bridge, from `["collection"]`
 *
 * The key sits under `["decks"]`, which every deck write already invalidates. **But owned copies
 * are collection rows**, and a quantity stepped in the binder invalidates `["collection"]` and
 * nothing else — so a deck's shortfall would go stale under the reader's hand.
 * {@link useCollectionBridge} is `ActivityWidget`'s bridge, one root wide: a marker query under
 * `["collection"]` so an invalidation of that root always has something to match, and a cache
 * subscription that turns one into an invalidation of this key. Off on a `still` body.
 *
 * ## Money
 *
 * `missingCost` is priced at the marketplace in the key, so a switch re-issues the read and the
 * card says it is measuring rather than drawing the last marketplace's figure beside the new
 * one's symbol. The comparison is in the key for the same reason.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import { useEffect, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { count, plural } from "@/lib/counts";
import {
  ipc,
  ipcError,
  type DeckCompletion,
  type DeckCompletionCompare,
  type DeckRow,
  type HomeWidget,
} from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";

import { footerLinePx } from "../fit";
import { deckCompletionKey, deckCompletionRoot, deckListKey } from "../keys";
import { widgetConfig } from "../layout";
import { WidgetFooterLine, WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { widgetMeta } from "../widgets";
import { pinnedDeckIds } from "./DecksWidget";

/** The three orders the registry's `order` pick offers. */
export type CompletionOrder = "done" | "cheapest" | "name";

/** The registry's `scope` pick: every measurable deck, or the reader's checklist. */
export type CompletionScope = "all" | "chosen";

/** Stable identity for "the deck list has not answered", so nothing downstream re-runs on it. */
const NO_DECK_ROWS: readonly DeckRow[] = [];

/** One deck's answer with the name it is drawn under. `deck_completion` carries ids only; the name
 *  is `deck_list`'s, joined here, so a rename lands with the gallery's own refetch. */
export type CompletionRow = DeckCompletion & { name: string };

/**
 * A row's height — `SetCompletionWidget.tsx:55-57`'s sum (36 bare, +15 a caption, +6 the track),
 * and this kind always draws its track. **The height the list is counted at**, which is not always
 * the height a given row draws: `rowsFit` takes one height for the whole list, so the body asks this
 * of the tallest row it may draw — a tile moves its figure under the name, so every tile row is
 * captioned, and once a compact panel lists a plan's row every row is counted as captioned while a
 * live row beside it still draws bare.
 */
function rowPx(caption: boolean): number {
  return 36 + (caption ? 15 : 0) + 6;
}

/** The bridge's marker segment — a word no other reader of `["collection"]` uses, so nothing that
 *  matches by prefix (`setQueriesData(["collection", "list"])`) can reach it. */
const BRIDGE_MARKER = "homeDeckCompletion";

/** The word a figure measured on the theory list leads with. See the module doc. */
const PLAN = "Plan";

/** The `Complete decks` switch's label, read off the registry so the sentence below cannot point
 *  at a renamed row. */
function completeWord(): string {
  return (
    widgetMeta("deckCompletion").toggles.find((toggle) => toggle.key === "complete")?.label ??
    "Complete decks"
  );
}

/** A pick's row label and one option's label, read off the registry — `NewPrintingsWidget`'s
 *  `pickWords`, so the checklist's hint names the control this card really has. */
function pickWords(key: string, optionId: string): { row: string; option: string } {
  const pick = widgetMeta("deckCompletion").picks.find((entry) => entry.key === key);
  return {
    row: pick?.label ?? key,
    option: pick?.options.find((option) => option.id === optionId)?.label ?? optionId,
  };
}

const PENDING = "Measuring your decks…";
/** `All decks` under `Collection` with nothing to measure. **Never drawn under `Chosen…`**, where
 *  an archived choice is kept and the reader has decks by definition: that is
 *  {@link CHOSEN_UNMEASURABLE}. */
export const NO_DECKS =
  "No decks to measure. Build a deck on the Decks page to track completion.";
/** `All decks` under `Theory` with nothing to compare — which is every reader who has never set a
 *  deck's kind to `Theory + Actual`, so it names the setting that makes one. */
export const NO_PLANS =
  "No theory lists to compare. Set a deck's kind to Theory + Actual to track it here.";
export const NOTHING_CHOSEN = "No decks chosen. Choose decks in this widget's settings.";
export const CHOSEN_UNMEASURABLE =
  "The chosen decks cannot be measured this way. Choose other decks in this widget's settings.";
export const ALL_COMPLETE = `All decks are complete. Enable ${completeWord()} in settings to view them.`;

/** What `All decks` says when nothing is in scope, by comparison. */
export function emptyAll(compare: DeckCompletionCompare): string {
  return compare === "theory" ? NO_PLANS : NO_DECKS;
}

function orderOf(value: string | number | undefined): CompletionOrder {
  return value === "cheapest" || value === "name" ? value : "done";
}

/** The comparison this card asks for. Anything but `theory` is `collection`, which is also what
 *  Rust answers for a word it does not know. */
export function completionCompare(widget: HomeWidget): DeckCompletionCompare {
  return pickOf(widget, "compare") === "theory" ? "theory" : "collection";
}

/**
 * Which decks this card draws. **`pinned` is `chosen`**: the pick was `Most recent` / `Pinned`
 * until issue #600 renamed it, and a card stored under the old word keeps its checklist rather
 * than reading as `All decks` — `pickOf` alone would call a word no option carries the default.
 */
export function completionScope(widget: HomeWidget): CompletionScope {
  const stored = widgetConfig(widget, { scope: "" }).scope;
  return stored === "chosen" || stored === "pinned" ? "chosen" : "all";
}

/**
 * Can this comparison measure this deck? `Collection` is every deck that holds cardboard — not a
 * virtual one, which owns nothing by definition; `Theory` is every deck that keeps a plan. The one
 * rule the body's rows and the checklist's options both read, so a deck the picker offers is a deck
 * the card can draw.
 */
export function measurableBy(deck: DeckRow, compare: DeckCompletionCompare): boolean {
  return compare === "theory" ? deck.theoryEnabled : !deck.virtualOnly;
}

/** How much of the deck is held, `0..=1`. The guard is against a division by zero only: a deck
 *  that asks for nothing never reaches here from the body — {@link completionRows} left it out. */
function share(row: DeckCompletion): number {
  return row.wanted <= 0 ? 1 : Math.min(1, row.owned / row.wanted);
}

/**
 * The decks in scope, in the order they are considered — before anything sorts or cuts them.
 *
 * `all` is `deck_list`'s order less archived decks; `chosen` is the reader's order, a duplicate id
 * once, and an id no deck answers to dropped in silence — `DecksWidget.decksToShow`'s two rules.
 * Either way a deck {@link measurableBy} refuses is out: Rust answers no row for it, and saying so
 * here too is what keeps a future answer from drawing a deck the comparison cannot measure.
 */
export function decksInScope(
  decks: readonly DeckRow[],
  scope: CompletionScope,
  deckIds: readonly number[],
  compare: DeckCompletionCompare,
): DeckRow[] {
  if (scope === "all") {
    return decks.filter((deck) => !deck.archived && measurableBy(deck, compare));
  }
  const byId = new Map(decks.map((deck) => [deck.id, deck]));
  const seen = new Set<number>();
  const chosen: DeckRow[] = [];
  for (const id of deckIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const deck = byId.get(id);
    if (deck !== undefined && measurableBy(deck, compare)) chosen.push(deck);
  }
  return chosen;
}

/**
 * The decks in scope, each with its answer — {@link decksInScope}, joined to the read.
 *
 * **A deck with no answer is dropped in silence** — the beat between a deck being created and this
 * read refetching. **So is a deck whose measured list asks for nothing**, in either scope, and this
 * is the one place that happens — the module doc's *A deck that asks for nothing is not on the
 * card*.
 */
export function completionRows(
  decks: readonly DeckRow[],
  completions: readonly DeckCompletion[],
  scope: CompletionScope,
  deckIds: readonly number[],
  compare: DeckCompletionCompare,
): CompletionRow[] {
  const byDeck = new Map(completions.map((answer) => [answer.deckId, answer]));
  const rows: CompletionRow[] = [];
  for (const deck of decksInScope(decks, scope, deckIds, compare)) {
    const answer = byDeck.get(deck.id);
    if (answer === undefined || answer.wanted <= 0) continue;
    rows.push({ ...answer, name: deck.name });
  }
  return rows;
}

/**
 * The rows in the reader's order. `sortOptions` copies, so the cached array is never sorted in
 * place, and its collator settles every tie by name.
 *
 * `cheapest`: a complete deck costs nothing to finish and leads; then the priced ones ascending;
 * then a deck nothing is priced in (`null`), last — spec §3.2.
 */
export function sortCompletions(
  rows: readonly CompletionRow[],
  order: CompletionOrder,
): CompletionRow[] {
  switch (order) {
    case "name":
      return sortOptions(rows, (row) => row.name);
    case "cheapest":
      return sortOptions(
        rows,
        (row) => row.name,
        (row) =>
          row.missing === 0 ? [0, 0] : row.missingCost === null ? [2, 0] : [1, row.missingCost],
      );
    case "done":
      return sortOptions(
        rows,
        (row) => row.name,
        (row) => [-share(row)],
      );
  }
}

/** The footer's facts and its two spellings. */
export interface CompletionFooter {
  /** Decks in scope missing nothing. */
  complete: number;
  /** What the priced missing copies of the rest cost, or `null` when none of them is priced. */
  cost: number | null;
  /** Missing copies across the rest with no price at this marketplace. */
  unpriced: number;
  /** `2 decks complete · $221.70 to finish the rest · 3 copies unpriced`, or `""` — the footer's
   *  hint and what a screen reader hears. */
  text: string;
  /** The same clauses in their short words, in the same order — `2 complete · $221.70 to finish ·
   *  3 unpriced` — which is what the footer's one line draws. */
  line: string;
}

/**
 * The line under the rows — over **every deck in scope**, never over the rows that fit.
 *
 * Complete is `missing === 0`. The cost sums every incomplete deck's `missingCost` that is not
 * `null`; the unpriced copies are counted beside it at the same marketplace and never summed as
 * zero, so a deck short only unpriced copies adds `$0.00` and says its copies.
 *
 * **Two spellings, because a footer is one line** (`WidgetFooterLine`). The whole sentence ran to
 * ~345–380px of 12px Geist and wrapped at every three-cell width into space the rows had been
 * counted without; `line` is ~250 and keeps the clauses in the sentence's order, so where even it
 * is cut, the ellipsis takes the unpriced copies first — which the sentence and each row's hint
 * still say.
 */
export function completionFooter(
  rows: readonly CompletionRow[],
  currency: Currency,
): CompletionFooter {
  let complete = 0;
  let cost: number | null = null;
  let unpriced = 0;
  for (const row of rows) {
    if (row.missing === 0) {
      complete += 1;
      continue;
    }
    if (row.missingCost !== null) cost = (cost ?? 0) + row.missingCost;
    unpriced += row.unpricedMissing;
  }
  const parts: string[] = [];
  const short: string[] = [];
  if (complete > 0) {
    parts.push(`${plural(complete, "deck")} complete`);
    short.push(`${count(complete)} complete`);
  }
  if (cost !== null) {
    const money = formatPrice(cost, currency);
    parts.push(`${money} to finish ${complete > 0 ? "the rest" : "every deck here"}`);
    short.push(`${money} to finish`);
  }
  if (unpriced > 0) {
    parts.push(`${plural(unpriced, "copy", "copies")} unpriced`);
    short.push(`${count(unpriced)} unpriced`);
  }
  return { complete, cost, unpriced, text: parts.join(" · "), line: short.join(" · ") };
}

/**
 * The caption: `96 of 100 · 4 missing`, or `60 of 60 · complete` — led by `Plan · ` when the figure
 * is the theory list's.
 */
export function countCaption(row: DeckCompletion): string {
  const count = `${row.owned} of ${row.wanted} · ${row.missing === 0 ? "complete" : `${row.missing} missing`}`;
  return row.list === "theory" ? `${PLAN} · ${count}` : count;
}

/**
 * What a two-cell tile draws under the name in place of the caption and the figure: the shortfall
 * and its price, `4 missing · $12.50` — or `Complete` — with `Plan · ` in front on a theory deck.
 */
function tileCaption(row: DeckCompletion, price: string): string {
  const shortfall = row.missing === 0 ? "complete" : `${row.missing} missing · ${price}`;
  if (row.list === "theory") return `${PLAN} · ${shortfall}`;
  return shortfall.charAt(0).toUpperCase() + shortfall.slice(1);
}

/**
 * What a row's figure does not say. A theory deck is measured against its plan rather than its
 * sleeved list, and a figure that leaves copies out says how many — `null` being *nothing on the
 * list is priced*, and any other figure beside unpriced copies being a partial sum.
 */
export function rowHint(row: DeckCompletion, marketplace: Marketplace): string | undefined {
  const parts: string[] = [];
  if (row.list === "theory") {
    parts.push("This deck's actual list, measured against its theory list.");
  }
  if (row.missing > 0 && row.missingCost === null) {
    parts.push(`Nothing on this deck's list has a price at ${marketplace.label}.`);
  } else if (row.unpricedMissing > 0) {
    const n = row.unpricedMissing;
    parts.push(
      `${plural(n, "missing copy", "missing copies")} with no price at ${marketplace.label} ${n === 1 ? "is" : "are"} not in this figure.`,
    );
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * Keep this read as fresh as the collection writes that move it — `ActivityWidget.tsx:124-155`'s
 * bridge, one root wide. The module doc has the argument.
 *
 * The marker is never read: `staleTime: Infinity` so nothing refetches it on its own, and
 * `notifyOnChangeProps: []` so its refetch re-renders nothing. The subscription listens for the
 * **invalidate action** rather than any event, because a query under `["collection"]` emits
 * `fetch` and `success` on every ordinary read. No loop: what it invalidates sits under `["decks"]`.
 *
 * **A burst in one tick is one invalidation.** One binder write invalidates `["collection"]`,
 * and that dispatches an `invalidate` event per cached query under the root — synchronously, in
 * one `invalidateQueries` call. Answered one by one, each event re-issued this read and the next
 * cancelled it, and **a cancelled TanStack fetch does not abort a Tauri invoke**: K events were K
 * backend measurements of every deck, K − 1 thrown away. So an event only *queues* the
 * invalidation, and a microtask sends it once the burst is over. (`ActivityWidget`'s bridge, which
 * this one was copied from, still answers event by event — a known follow-up, not a difference of
 * design.)
 */
function useCollectionBridge(enabled: boolean): void {
  const client = useQueryClient();

  useQuery({
    queryKey: ["collection", BRIDGE_MARKER],
    queryFn: () => true,
    staleTime: Infinity,
    notifyOnChangeProps: [],
    enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    // Every marketplace's and both comparisons' entries, from the one definition in `keys.ts` so
    // this line cannot come to spell it differently.
    const root = [...deckCompletionRoot];
    let queued = false;
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "invalidate") return;
      if (event.query.queryKey[0] !== "collection") return;
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void client.invalidateQueries({ queryKey: root });
      });
    });
  }, [client, enabled]);
}

export function DeckCompletionWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const compare = completionCompare(widget);
  const scope = completionScope(widget);
  const deckIds = pinnedDeckIds(widget);
  const order = orderOf(pickOf(widget, "order"));
  const showComplete = toggleOnOf(widget, "complete");

  const { marketplace, currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);

  useCollectionBridge(!still);

  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const completionQuery = useQuery({
    queryKey: deckCompletionKey(marketplace.id, compare),
    queryFn: () => ipc.deckCompletion(marketplace.id, compare),
  });

  // The refusal is read before the emptiness: a failed read has no rows either, and calling it
  // "no decks to measure" would tell a reader with six decks that they have none.
  const failure = decksQuery.error ?? completionQuery.error;
  if (failure !== null) {
    return (
      <WidgetMessage tone="destructive">
        Could not measure your decks — {ipcError(failure)}
      </WidgetMessage>
    );
  }
  if (decksQuery.data === undefined || completionQuery.data === undefined) {
    return <WidgetMessage>{PENDING}</WidgetMessage>;
  }
  if (scope === "chosen" && deckIds.length === 0) {
    return <WidgetMessage>{NOTHING_CHOSEN}</WidgetMessage>;
  }

  // Every deck that can be measured, and nothing else: a deck asking for nothing is already out,
  // so the empty state below, the footer's count and the order all see the same rows.
  const inScope = completionRows(decksQuery.data, completionQuery.data, scope, deckIds, compare);
  if (inScope.length === 0) {
    return (
      <WidgetMessage>{scope === "chosen" ? CHOSEN_UNMEASURABLE : emptyAll(compare)}</WidgetMessage>
    );
  }
  const listed = showComplete ? inScope : inScope.filter((row) => row.missing > 0);
  if (listed.length === 0) return <WidgetMessage>{ALL_COMPLETE}</WidgetMessage>;

  /**
   * What the box carries. **On a two-cell tile the shortfall moves under the name** — `WidgetRow`'s
   * rule — and it is the missing count that is kept, with its price beside it, because *how far* is
   * what this card is about. A compact panel drops the `96 of 100` caption and keeps the price —
   * **except that a plan's row keeps the word `Plan`**, since its price and track are the plan's
   * and nothing else on the row would say so. The footer is a panel's furniture and is drawn from
   * three cells wide.
   *
   * **`rowsFit` takes one height for the whole list, so it is the tallest row that may be drawn.**
   * Asked over `listed` rather than over the rows that end up shown, because which rows are shown
   * is what the answer decides: once any listed row is a plan's, a compact panel counts every row
   * as captioned. Counting at the bare height beside a captioned row would cut the list to more
   * rows than the box holds — the half-row `SetCompletionWidget`'s `rowPx` note records.
   */
  const tile = fit.tier === 0;
  const fullCaption = !fit.compact;
  const planLine = fit.compact && listed.some((row) => row.list === "theory");
  const captioned = tile || fullCaption || planLine;
  const footer = completionFooter(inScope, currency);
  const footerShown = fit.tier >= 1 && footer.text !== "";
  const shown = sortCompletions(listed, order).slice(
    0,
    fit.rowsFit(rowPx(captioned), footerShown ? footerLinePx(fit) : 0),
  );

  /**
   * **`decks` is one view with two states**, told apart by `openDeckId` — and `setActiveView`
   * clears that id on the way in, so the view is written first (`DecksWidget.tsx:267-276`).
   */
  const openDeck = (id: number) => {
    setActiveView("decks");
    setOpenDeckId(id);
  };

  return (
    <>
      <WidgetRowList fit={fit} label="Decks">
        {shown.map((row) => {
          const caption = countCaption(row);
          // A complete deck has nothing to buy, so it draws no figure at all rather than a `$0.00`.
          const price = row.missing === 0 ? "" : formatPrice(row.missingCost, currency);
          // Floored, so a track never reaches the end of its rail beside a deck still short a card.
          const track = Math.floor(share(row) * 100) / 100;
          const hint = rowHint(row, marketplace);
          const onPress = still ? undefined : () => openDeck(row.deckId);
          // The whole row in one string: three flex children with a `gap` and no whitespace text
          // node compute to "Burn56 of 60 · 4 missing$12.50" (`DecksWidget.tsx:314-321`). It
          // carries the full caption whatever this box draws, `Plan` included, so the name a reader
          // drives by voice does not change as the card is resized.
          const pressLabel = still
            ? undefined
            : [row.name, caption, price].filter((part) => part !== "").join(" · ");
          return tile ? (
            <WidgetRow
              key={row.deckId}
              name={row.name}
              caption={tileCaption(row, price)}
              captionStrong
              track={track}
              hint={hint}
              onPress={onPress}
              pressLabel={pressLabel}
            />
          ) : (
            <WidgetRow
              key={row.deckId}
              name={row.name}
              caption={fullCaption ? caption : row.list === "theory" ? PLAN : undefined}
              value={price}
              track={track}
              hint={hint}
              onPress={onPress}
              pressLabel={pressLabel}
            />
          );
        })}
      </WidgetRowList>
      {footerShown && <WidgetFooterLine line={footer.line} said={footer.text} />}
    </>
  );
}

/**
 * This kind's own settings, under the rows the registry declares: the deck checklist behind
 * `Which decks → Chosen…`.
 *
 * **It offers only the decks the current comparison can measure** ({@link measurableBy}) — every
 * deck that is not virtual under `Collection`, every `Theory + Actual` deck under `Theory` — so no
 * tick can name a deck the card will never draw. A choice made under one comparison that the other
 * cannot measure is **kept** in the stored set rather than dropped: it is simply not offered here,
 * and comes back ticked when the reader switches back.
 *
 * **Drawn only while the scope is `Chosen…`**, with a sentence in its place otherwise — a picker
 * under `All decks` would be a control whose every press changes nothing on the card.
 */
export function DeckCompletionWidgetSettings({
  widget,
  onConfig,
}: WidgetSettingsProps): ReactElement {
  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const compare = completionCompare(widget);
  const deckIds = pinnedDeckIds(widget);
  const words = pickWords("scope", "chosen");

  if (completionScope(widget) !== "chosen") {
    return (
      <p className="m-0 text-xs text-dim">
        Choose {words.option} under {words.row} to pick the decks this card measures.
      </p>
    );
  }

  const eligible = (decksQuery.data ?? NO_DECK_ROWS).filter((deck) =>
    measurableBy(deck, compare),
  );
  const offered = new Set(eligible.map((deck) => deck.id));
  const ticked = deckIds.filter((id) => offered.has(id));
  /** Sorted by the deck's **name** rather than the row's label, so the `(archived)` suffix does
   *  not file a retired deck under A — `DecksWidgetSettings`' reason verbatim. */
  const options: DropdownOption[] = sortOptions(eligible, (deck) => deck.name).map((deck) => ({
    value: String(deck.id),
    label: deck.archived ? `${deck.name} (archived)` : deck.name,
    hint: deck.formatName ?? deck.formatKey,
  }));

  /**
   * Add at the end, remove in place, and **every id this list does not offer is carried through**
   * — the other comparison's choices. The patch writes `scope: "chosen"` beside the ids, which is
   * also what retires a stored `pinned`.
   */
  const toggle = (value: string) => {
    const id = Number(value);
    const next = deckIds.includes(id) ? deckIds.filter((each) => each !== id) : [...deckIds, id];
    onConfig({ deckIds: next, scope: "chosen" });
  };

  return (
    <div className="flex flex-col gap-2">
      <MultiDropdown
        fill
        size="sm"
        label="Decks to measure"
        searchable={options.length > 8}
        searchLabel="Search decks"
        options={options}
        selected={ticked.map(String)}
        onToggle={toggle}
        triggerLabel={ticked.length === 0 ? "None chosen" : plural(ticked.length, "deck")}
      />
      {!decksQuery.isPending && options.length === 0 && !decksQuery.isError && (
        <p className="m-0 text-xs text-dim">{emptyAll(compare)}</p>
      )}
      {decksQuery.isError && (
        <p className="m-0 text-xs text-destructive">
          Could not read your decks — {ipcError(decksQuery.error)}
        </p>
      )}
    </div>
  );
}
