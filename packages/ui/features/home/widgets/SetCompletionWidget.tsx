/**
 * How close each set the reader collects is to complete — a row per set, with how many of its
 * cards they hold and a track under the name.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip, the settings popover and the
 * tray; this draws the rows and the footer, cut to the box it was handed. The `Chosen…` checklist
 * at the foot of the popover is {@link SetCompletionWidgetSettings}, which `HomePage.tsx`'s
 * `renderExtraSettings` hands to this kind — and it writes exactly what {@link setScope} and
 * {@link chosenSetCodes} read.
 *
 * ## Rust counts, this file decides
 *
 * `set_completion` answers one row per set holding at least one owned card, with two measures of
 * it: the distinct collector numbers held inside the set's printed size (`owned` of `size`), and
 * the distinct numbers held of every number the corpus holds for the set (`ownedAll` of `total`).
 * **Which measure is drawn, which sets, in what order and what "complete" means are display
 * decisions and live here** — the crate's facts/conclusions line: the registry's picks are readings
 * of one answer, and a command per reading would be several places one count is written.
 *
 * ## Every set has a denominator (issue #1692)
 *
 * `size` is Scryfall's `printed_size`, and **Scryfall has published none since early 2023**: the
 * cards stopped printing one. Before this issue a set with no size drew an em dash, no track and
 * sorted last under `Nearest complete` — so every set of the last few years sat below the rows the
 * card had room for, and adding a card from one changed nothing a reader could see. A copy numbered
 * past an older set's run (a showcase, a Commander deck's reprints) was not counted either, so it
 * depended on which printing was added.
 *
 * Now {@link measureSet} measures a set with no printed size **against every printing it has**
 * (`total`, which the corpus always knows) and says so on the row's hint, and `Count against →
 * Every printing` measures every set that way — variants and all — for a reader who collects the
 * whole set. The default order is `Recently changed`, so the set a reader just added to is the
 * first row whatever its share.
 *
 * ## Which sets is a filter; order is a display decision
 *
 * `All sets` is every set the answer holds, less token, promo, art-series and minigame sets unless
 * `Token & promo sets` is on ({@link EXTRA_SET_TYPES}); `Chosen…` is the reader's `setCodes` under
 * the same switch — a choice the switch hides is **kept** and simply not drawn, `DeckCompletion`'s
 * rule for a deck its comparison cannot measure. {@link sortSets} then orders what is left, every
 * tie settled by name through `sortOptions`. A complete set leaves the list only when `Complete
 * sets` is off.
 *
 * ## A percentage never rounds up to done
 *
 * `302 of 303` is not `100%`. The figure is floored, so it reads 100 only for a set that really is
 * complete, and a set with a single card of a large one reads `<1%` rather than a flat `0%` beside
 * a caption saying the reader has one.
 *
 * ## A row opens its set
 *
 * A press opens the Search page on every card in the set (`showSetInSearch`), where each card the
 * reader owns carries its count — the cards missing are the ones without one. A still body opens
 * nothing.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { count, plural } from "@/lib/counts";
import { ipc, ipcError, type HomeWidget, type SetCompletion } from "@/lib/ipc";
import { sortOptions } from "@/lib/options";
import { useAppStore } from "@/lib/store";

import { footerLinePx } from "../fit";
import { setCompletionKey } from "../keys";
import { widgetConfig } from "../layout";
import { WidgetFooterLine, WidgetMessage, WidgetRow, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { widgetMeta } from "../widgets";

/** The orders the registry's `sort` pick offers. */
export type SetOrder = "recent" | "complete" | "cards" | "newest" | "name";

/** The registry's `measure` pick: the printed run where there is one, or every printing. */
export type SetMeasure = "printed" | "all";

/** The registry's `scope` pick: every set, or the reader's checklist. */
export type SetScope = "all" | "chosen";

/**
 * The set types `Token & promo sets` brings in — Scryfall's `set_type` words for sets nobody
 * completes as a set: tokens, promos, art series and other memorabilia, and minigames. A set the
 * corpus's set list does not name (`setType: null`) is an ordinary set.
 */
export const EXTRA_SET_TYPES: ReadonlySet<string> = new Set([
  "token",
  "promo",
  "memorabilia",
  "minigame",
]);

/** One set's answer with the measure this card draws it by. */
export interface MeasuredSet extends SetCompletion {
  /** Distinct numbers held, under the measure. */
  held: number;
  /** What they are held of — the printed size, or every printing in the set. Never below 1. */
  of: number;
  /** `Printed set size` was asked and the set has none, so it is measured against every printing. */
  unsized: boolean;
}

/** Stable identity for "the read has not answered", so nothing downstream re-runs on it. */
const NO_SETS: readonly SetCompletion[] = [];

/**
 * A row's height, by what it carries — the design's four figures (36 bare, 42 with a track, 51 with
 * a caption, 57 with both) as a sum, and what `rowsFit` cuts by.
 *
 * **Asked of the row actually drawn, not of the card's density.** The design keyed it on `bare`
 * alone, and a two-cell tile is bare *and* moves its figure under the name as a caption — so it was
 * counted at 42 and drawn at 57, and the shipped window showed a third row cut through its middle
 * (2026-09-15, catalogue preview).
 */
function rowPx(caption: boolean, track: boolean): number {
  return 36 + (caption ? 15 : 0) + (track ? 6 : 0);
}

/** A switch's label, read off the registry so a sentence below cannot point at a renamed row. */
function toggleWord(key: string, fallback: string): string {
  return (
    widgetMeta("setCompletion").toggles.find((toggle) => toggle.key === key)?.label ?? fallback
  );
}

/** A pick's row label and one option's label, read off the registry — `DeckCompletionWidget`'s
 *  `pickWords`, so the checklist's hint names the control this card really has. */
function pickWords(key: string, optionId: string): { row: string; option: string } {
  const pick = widgetMeta("setCompletion").picks.find((entry) => entry.key === key);
  return {
    row: pick?.label ?? key,
    option: pick?.options.find((option) => option.id === optionId)?.label ?? optionId,
  };
}

const PENDING = "Loading sets…";
export const EMPTY = "No sets yet. Sets you own cards from show up here.";
export const NOTHING_CHOSEN = "No sets chosen. Choose sets in this widget's settings.";
export const CHOSEN_GONE =
  "None of the chosen sets has cards in your collection. Choose different sets in this widget's settings.";
/** The hint on a set measured whole because it prints no size — every set since early 2023. */
export const UNSIZED_HINT = "This set has no printed set size, so every printing in it counts.";

/** `All sets` when every set held is one `Token & promo sets` keeps off the card. */
export function onlyExtras(): string {
  return `Your sets so far are all token or promo sets. Turn on ${toggleWord("extras", "Token & promo sets")} in this widget's settings to show them.`;
}

/** Every set in scope is complete and `Complete sets` is off. */
export function allComplete(): string {
  return `Every set here is complete. Turn on ${toggleWord("complete", "Complete sets")} in this widget's settings to show them.`;
}

function orderOf(value: string | number | undefined): SetOrder {
  return value === "complete" || value === "cards" || value === "newest" || value === "name"
    ? value
    : "recent";
}

/** The measure this card draws. Anything but `all` is `printed`. */
export function setMeasure(widget: HomeWidget): SetMeasure {
  return pickOf(widget, "measure") === "all" ? "all" : "printed";
}

/** Which sets this card draws. Anything but `chosen` is `all`. */
export function setScope(widget: HomeWidget): SetScope {
  return pickOf(widget, "scope") === "chosen" ? "chosen" : "all";
}

/**
 * The reader's checklist — lower-case set codes, each once. `widgetConfig`'s shape check is shallow
 * for an array with no first element, so the elements are narrowed here; a fresh fallback per call
 * so no two widgets come to share one array (`DecksWidget.pinnedDeckIds`' reasons).
 */
export function chosenSetCodes(widget: HomeWidget): string[] {
  const codes = widgetConfig(widget, { setCodes: [] as string[] }).setCodes.filter(
    (code): code is string => typeof code === "string" && code !== "",
  );
  return [...new Set(codes)];
}

/** Is this one of the sets `Token & promo sets` brings in? */
export function isExtraSet(set: SetCompletion): boolean {
  return set.setType !== null && EXTRA_SET_TYPES.has(set.setType);
}

/**
 * One set under a measure. `printed` takes Scryfall's printed run where the set has one and every
 * printing where it does not; `all` takes every printing. The denominator is floored at what is
 * held and at one, so a share is always defined and never past one — Rust's `owned_all <= total`
 * makes the first a guard and nothing more.
 */
export function measureSet(set: SetCompletion, measure: SetMeasure): MeasuredSet {
  if (measure === "printed" && set.size !== null && set.size > 0) {
    return { ...set, held: set.owned, of: set.size, unsized: false };
  }
  return {
    ...set,
    held: set.ownedAll,
    of: Math.max(set.total, set.ownedAll, 1),
    unsized: measure === "printed",
  };
}

/** How much of the set is held under its measure, `0..=1`. */
function share(set: MeasuredSet): number {
  return Math.min(1, set.held / set.of);
}

/** Held whole under its measure. */
export function isComplete(set: MeasuredSet): boolean {
  return set.held >= set.of;
}

/**
 * The sets this card considers, measured — before anything orders or cuts them.
 *
 * `all` is every set the answer holds; `chosen` is those whose code the reader ticked, a code no set
 * answers to dropped in silence (a set whose last copy left the collection answers no row). Either
 * way a set {@link isExtraSet} calls a token or promo set is out unless `extras` is on.
 */
export function setsInScope(
  sets: readonly SetCompletion[],
  scope: SetScope,
  setCodes: readonly string[],
  extras: boolean,
  measure: SetMeasure,
): MeasuredSet[] {
  const chosen = new Set(setCodes);
  return sets
    .filter((set) => extras || !isExtraSet(set))
    .filter((set) => scope === "all" || chosen.has(set.setCode))
    .map((set) => measureSet(set, measure));
}

/**
 * The sets in the order the reader picked.
 *
 * Alphabetical first — through `sortOptions`, the app's one collator — and the pick's own key over
 * that, so every tie is settled by name rather than by whatever order the command answered in.
 * `sortOptions` copies, so the cached array is never sorted in place. `newest` puts a set with no
 * release date last.
 */
export function sortSets(sets: readonly MeasuredSet[], order: SetOrder): MeasuredSet[] {
  const byName = (set: MeasuredSet) => set.name;
  switch (order) {
    case "name":
      return sortOptions(sets, byName);
    case "recent":
      return sortOptions(sets, byName, (set) => [-set.changedAt]);
    case "cards":
      return sortOptions(sets, byName, (set) => [-set.held]);
    case "newest":
      return sortOptions(sets, byName, (set) => {
        const day = set.releasedAt === null ? Number.NaN : Date.parse(set.releasedAt);
        return Number.isNaN(day) ? [1, 0] : [0, -day];
      });
    case "complete":
      return sortOptions(sets, byName, (set) => [-share(set)]);
  }
}

/** The figure: a floored percentage, and `<1%` for a set barely started. */
export function percentLabel(set: MeasuredSet): string {
  const percent = Math.floor(share(set) * 100);
  return percent === 0 && set.held > 0 ? "<1%" : `${percent}%`;
}

/** The caption: `248 of 303`. */
export function countLabel(set: MeasuredSet): string {
  return `${set.held} of ${set.of}`;
}

/** What a row's figure does not say: that a set with no printed size is measured whole. */
export function rowHint(set: MeasuredSet): string | undefined {
  return set.unsized ? UNSIZED_HINT : undefined;
}

/** The footer's two spellings — `WidgetFooterLine`'s `line` and `said`. */
export interface SetsFooter {
  /** `4 of 23 sets · 2 complete` — the one line drawn. */
  line: string;
  /** The same as a sentence, for the hint and a screen reader. */
  said: string;
}

/**
 * The line under the rows — over **every set in scope**, never over the rows that fit. Drawn only
 * when some set in scope is not on the card (cut by the box or hidden as complete), because a
 * count of the rows a reader can already see tells them nothing; then it says how many there are,
 * which is what a reader looking for the set they just added to needs to know.
 */
export function setsFooter(inScope: readonly MeasuredSet[], shown: number): SetsFooter {
  const complete = inScope.filter(isComplete).length;
  const all = plural(inScope.length, "set");
  const line =
    complete > 0
      ? `${count(shown)} of ${all} · ${count(complete)} complete`
      : `${count(shown)} of ${all}`;
  const said =
    complete > 0
      ? `Showing ${count(shown)} of ${all}. ${count(complete)} complete.`
      : `Showing ${count(shown)} of ${all}.`;
  return { line, said };
}

export function SetCompletionWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const order = orderOf(pickOf(widget, "sort"));
  const measure = setMeasure(widget);
  const scope = setScope(widget);
  const setCodes = chosenSetCodes(widget);
  const bars = toggleOnOf(widget, "bars");
  const showComplete = toggleOnOf(widget, "complete");
  const extras = toggleOnOf(widget, "extras");
  const showSetInSearch = useAppStore((s) => s.showSetInSearch);
  const query = useQuery({ queryKey: setCompletionKey, queryFn: () => ipc.setCompletion() });

  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">Couldn't load sets — {ipcError(query.error)}</WidgetMessage>
    );
  }
  if (query.data.length === 0) return <WidgetMessage>{EMPTY}</WidgetMessage>;
  if (scope === "chosen" && setCodes.length === 0) {
    return <WidgetMessage>{NOTHING_CHOSEN}</WidgetMessage>;
  }

  const inScope = setsInScope(query.data, scope, setCodes, extras, measure);
  if (inScope.length === 0) {
    return <WidgetMessage>{scope === "chosen" ? CHOSEN_GONE : onlyExtras()}</WidgetMessage>;
  }
  const listed = showComplete ? inScope : inScope.filter((set) => !isComplete(set));
  if (listed.length === 0) return <WidgetMessage>{allComplete()}</WidgetMessage>;

  // No caption on a compact card or a two-cell tile: the row keeps its name and its figure.
  const bare = fit.compact || fit.tier === 0;
  // A tile's figure is its caption; a wider bare row has none.
  const captioned = fit.tier === 0 || !bare;
  const rowH = rowPx(captioned, bars);
  // The footer is a panel's furniture, drawn from three cells wide, and only when a set in scope is
  // not on the card — asked of the box without it, since the footer is what would take the room.
  const footerShown =
    fit.tier >= 1 && (listed.length > fit.rowsFit(rowH) || listed.length < inScope.length);
  const reserved = footerShown ? footerLinePx(fit) : 0;
  const shown = sortSets(listed, order).slice(0, fit.rowsFit(rowH, reserved));
  const footer = footerShown ? setsFooter(inScope, shown.length) : null;

  return (
    <>
      <WidgetRowList fit={fit} label="Sets" layout={fit.listLayout(shown.length, rowH, reserved)}>
        {shown.map((set) => {
          // Floored like the figure, so a track never reaches the end of its rail beside a `99%`.
          const track = bars ? Math.floor(share(set) * 100) / 100 : undefined;
          const hint = rowHint(set);
          const caption = countLabel(set);
          const figure = percentLabel(set);
          const onPress = still ? undefined : () => showSetInSearch(set.setCode);
          // The whole row in one string — a `gap` between the name and the caption computes to
          // "Bloomburrow191 of 261" (`DecksWidget`'s row press, and the same reason). It carries
          // the full caption whatever this box draws.
          const pressLabel = still ? undefined : `${set.name} · ${caption} · ${figure}`;
          // At two cells there is no width for a name and a figure side by side, so the figure
          // moves under the name — `WidgetRow`'s own note.
          return fit.tier === 0 ? (
            <WidgetRow
              key={set.setCode}
              name={set.name}
              caption={figure}
              captionStrong
              track={track}
              hint={hint}
              onPress={onPress}
              pressLabel={pressLabel}
            />
          ) : (
            <WidgetRow
              key={set.setCode}
              name={set.name}
              caption={bare ? undefined : caption}
              value={figure}
              track={track}
              hint={hint}
              onPress={onPress}
              pressLabel={pressLabel}
            />
          );
        })}
      </WidgetRowList>
      {footer !== null && <WidgetFooterLine line={footer.line} said={footer.said} />}
    </>
  );
}

/** A checklist row's hint: the code, and the year it came out where there is one. */
function setHint(set: SetCompletion): string {
  const code = set.setCode.toUpperCase();
  return set.releasedAt === null ? code : `${code} · ${set.releasedAt.slice(0, 4)}`;
}

/**
 * This kind's own settings, under the rows the registry declares: the set checklist behind
 * `Which sets → Chosen…`.
 *
 * **It offers the sets the card can draw** — every set the collection holds a card of, less the
 * token and promo sets while `Token & promo sets` is off — from the body's own read, so a tick can
 * never name a set the card would not draw. A choice the switch hides is **kept** in the stored list
 * rather than dropped, and comes back ticked when the reader turns it on again.
 *
 * **Drawn only while the scope is `Chosen…`**, with a sentence in its place otherwise — a picker
 * under `All sets` would be a control whose every press changes nothing on the card.
 */
export function SetCompletionWidgetSettings({
  widget,
  onConfig,
}: WidgetSettingsProps): ReactElement {
  const query = useQuery({ queryKey: setCompletionKey, queryFn: () => ipc.setCompletion() });
  const extras = toggleOnOf(widget, "extras");
  const setCodes = chosenSetCodes(widget);
  const words = pickWords("scope", "chosen");

  if (setScope(widget) !== "chosen") {
    return (
      <p className="m-0 text-xs text-dim">
        Set {words.row} to {words.option} to pick sets.
      </p>
    );
  }

  const eligible = (query.data ?? NO_SETS).filter((set) => extras || !isExtraSet(set));
  const offered = new Set(eligible.map((set) => set.setCode));
  const ticked = setCodes.filter((code) => offered.has(code));
  const options: DropdownOption[] = sortOptions(eligible, (set) => set.name).map((set) => ({
    value: set.setCode,
    label: set.name,
    hint: setHint(set),
  }));

  /** Add at the end, remove in place, and **every code this list does not offer is carried
   *  through** — the token and promo sets the switch is hiding. */
  const toggle = (code: string) => {
    const next = setCodes.includes(code)
      ? setCodes.filter((each) => each !== code)
      : [...setCodes, code];
    onConfig({ setCodes: next, scope: "chosen" });
  };

  return (
    <div className="flex flex-col gap-2">
      <MultiDropdown
        fill
        size="sm"
        label="Sets to track"
        searchable={options.length > 8}
        searchLabel="Search sets"
        options={options}
        selected={ticked}
        onToggle={toggle}
        triggerLabel={ticked.length === 0 ? "None chosen" : plural(ticked.length, "set")}
      />
      {query.isSuccess && options.length === 0 && <p className="m-0 text-xs text-dim">{EMPTY}</p>}
      {query.isError && (
        <p className="m-0 text-xs text-destructive">
          Couldn't load your sets — {ipcError(query.error)}
        </p>
      )}
    </div>
  );
}
