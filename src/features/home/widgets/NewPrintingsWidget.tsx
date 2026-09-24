/**
 * Reprints of cards the reader's watched decks already hold, newest first, in day groups.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the window chip, the settings popover and
 * the Customize tray; this draws the groups, the rows, the rules and the footer, cut to the box it
 * was handed. The body's scroller is the card's too — `overflow-y-auto`, `overflow-x-hidden`,
 * `scrollbar-slim scrollbar-accent` and the `inert` mask — so nothing here says anything about
 * scrolling.
 *
 * ## The day group is `ActivityWidget`'s, deliberately
 *
 * A dim uppercase date with a rule and a count already means *these things happened together* on
 * this page, and a reprint feed is the same sentence about a different noun. Headers do **not**
 * stick to the top of the scroller, matching that widget: a sticky header needs a background of
 * its own, which would paint a band across Customize's tinted card.
 *
 * **Rows flow into `fit.listColumns` columns *inside* a group and never across one** — the header
 * spans the full width and its rows fill the columns under it. Without that rule a four-column
 * card reads as four unrelated lists.
 *
 * ## Three empty sentences, never one
 *
 * `PriceMoversWidget`'s rule and its reason. An empty list means *no deck is watched*, or *nothing
 * was reprinted in this window* — and a count of zero printings cannot tell them apart.
 * `decksWatched` travels beside the list so the page can pick, and {@link emptySentence} is where
 * it picks.
 *
 * ## One read, whatever the box
 *
 * {@link NEW_PRINTINGS_READ} rows — the command's own clamp — and **the box cuts that to whole
 * rows**. A read sized to the rows that fit would re-issue on every drag of the resize corner and
 * paint *pending* over a list that was already right. The rows below the cut are in the DOM and
 * scrollable; cutting is a painting rule, not a limit.
 *
 * ## The rows this body draws are its own, and that is on purpose
 *
 * `WidgetRow` cannot carry a rarity gem *inside* a caption, a bordered deck-count chip and a 5px
 * unseen dot, and widening it for one kind would put three optional slots on the row every other
 * widget draws. `WidgetParts.tsx`'s module doc allows exactly this — the activity feed's day
 * sections and the recent cards' film strip are the precedents — so the row is local and says so
 * here. The list *box* is still `WidgetRowList`, because a grid of `fit.listColumns` at
 * `fit.rowGap` is the one thing this body has no business restating.
 *
 * **The caption carries the language code whenever the answer is not English alone.** `Every
 * language` answers one reprint once per language, which is what that reader asked for — and
 * without the code those are ten rows reading `Sol Ring · SLD · 3 decks` and the list looks broken
 * rather than complete. So it is drawn at **every** tier, the two-cell tile included: it is what
 * tells two rows apart rather than a detail a small card can drop. The code is named with
 * `languageHint`, so `PH` says *Printed in Phyrexian* on the pointer as it does everywhere else in
 * this app (issue #161).
 *
 * **{@link ROW_PX} is 54: a 46px thumb, 3px of padding each side and the row's 1px border.** The
 * thumb is **33px** wide rather than the artboards' 34: `CardArt` is `w-full` at `5 / 7`
 * (`CARD_ASPECT`), so 34px is 47.6px tall and the row would be 56 — and 54 is the number the
 * design's whole size matrix was computed against. The artboard's own thumb was a hand-drawn
 * placeholder at 34 × 46, which is not 5:7 at all. **The classes below spell these numbers out and
 * must stay in step with them**; a row taller than the arithmetic thinks is a card whose last row
 * is clipped.
 *
 * ## The unseen cursor
 *
 * `app_meta.new_printings_seen`, `recent_cards`' shape — **not `config`**, because `config`
 * round-trips through older builds and a cursor an older build rewrites is a cursor that lies.
 *
 * **The cursor is read once per mount and held**, which the design does not say and which is the
 * difference between a mark that works and one that does not: the widget writes the cursor when it
 * renders a non-empty list, so a body that re-read it would watch every gold dot vanish under the
 * reader's eyes a frame after they appeared. It is latched with a **render-phase `setState`** —
 * React's own answer to state that has to follow a prop, and `AnchoredPopup`'s idiom one component
 * over — rather than in an effect, because a `setState` inside an effect fails lint only at
 * `verify`. The write is fire-once per mount, never while `still` (a catalogue preview publishes
 * nothing), and **its failure is silent**: a mark is not worth a sentence.
 *
 * ## What the spec asked for and the wire cannot say
 *
 * §4's tier-2 caption ends `· borderless`, which is a **frame effect**. `NewPrinting` carries
 * `promo_types` and not `frame_effects`, so what a wide row can honestly add is the printing's own
 * treatment — *Serialized*, *Surge Foil* — through `treatment.ts`, which is the one reader of that
 * column in this app. Naming a frame effect from a column that does not hold one would be this
 * card inventing a fact about somebody's cardboard.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the first argument in full.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { CardArt } from "@/components/CardArt";
import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { RarityGem } from "@/components/RarityGem";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type DeckRow,
  type HomeWidget,
  type NewPrinting,
  type NewPrintings,
} from "@/lib/ipc";
import { isKnownLanguage, LANGUAGE_CODES, languageHint, languageName } from "@/lib/languages";
import { PRESS } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { useAppStore } from "@/lib/store";
import { cardTreatments, treatmentName } from "@/lib/treatment";
import { cn } from "@/lib/utils";

import { AppScale } from "../AppScale";
import type { WidgetFit } from "../fit";
import { deckListKey, newPrintingsKey, NEW_PRINTINGS_ROOT } from "../keys";
import { widgetConfig } from "../layout";
import { WidgetFooter, WidgetMessage, WidgetRowList } from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { widgetMeta } from "../widgets";
import { NewPrintingDialog } from "./NewPrintingDialog";

/** How many printings the widget reads — `new_printings`' own clamp. See the module doc. */
export const NEW_PRINTINGS_READ = 100;

/** One row's height. 46px thumb + 3px padding each side + the 1px border. See the module doc. */
export const ROW_PX = 54;
/** The thumb, in pixels. 5:7 makes this 46.2 tall, which is the drawn 46. */
const THUMB_PX = 33;
/** A day header: 16px of type, over the body's own row gap. */
const HEADER_PX = 16;
/** The gap between two day groups — the body's `gap-2`. */
const GROUP_GAP_PX = 8;
/** What the footer takes off the body before rows are counted, gap included. */
const FOOTER_PX = 22;
/** A month rule, and the `Seen already` rule: 20px, over a row gap. */
const RULE_PX = 20;
/** The closing line: 34px, gap included. */
const CLOSING_PX = 34;

/** From this many cells tall, the `Seen already` rule is drawn — above it the gold dots mean
 *  something, below it they would be noise. Spec §5. */
const SEEN_RULE_FROM_H = 5;
/** From this many cells tall, a month rule is drawn where the month turns: 1 380px of Fridays is
 *  unreadable without one. */
const MONTH_RULE_FROM_H = 6;
/** From this many cells tall, an exhausted window ends with a statement rather than trailing off. */
const CLOSING_FROM_H = 8;

/**
 * The window a card reads when its stored one is not an option this build offers.
 *
 * It matches the registry's `dflt`, so it is only ever reached by a config a *newer* build wrote
 * or a hand-edited row — `pickOf` answers the registry default for everything else. See the note
 * on §8's footprint default above {@link NewPrintingsWidget}.
 */
const WINDOW_FALLBACK = 90;

const PENDING = "Reading recent printings…";
/**
 * The first of the three sentences, and the one a count of zero printings would get wrong.
 *
 * Spec §7 pairs it with a `Choose decks…` press that opens the card's settings popover — which is
 * `WidgetCard`'s own state and reaches no body, so the sentence points at the control instead.
 * `DecksWidget.NOTHING_PINNED` says the same thing the same way for the same reason.
 */
export const NO_DECKS =
  "No decks are being watched, so there is nothing to compare new printings against — choose them in this card's settings under Customize.";

/** An explicit locale and an explicit UTC time zone, `printings.ts`' rule and its reason:
 *  `releasedAt` is a calendar date, so a formatter left on the local zone prints the day before
 *  it for everyone west of Greenwich. */
const DAY_SHORT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const DAY_LONG = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const MONTH_LABEL = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
/** The closing line's date — `26 June`, the day the window runs out at. */
const DAY_IN_WORDS = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

/** Stable identity for "nothing read yet", so {@link printingDays} is not re-run over a fresh
 *  empty array on every render of a card that is still waiting. */
const NONE: readonly NewPrinting[] = [];
/** The same, for the deck list the settings' deck picker is built from. */
const NO_DECK_ROWS: readonly DeckRow[] = [];

/** One release day, and the printings that landed on it. */
export interface PrintingDay {
  /** The `YYYY-MM-DD` itself — the group's identity, and what a month rule is derived from. */
  key: string;
  /** `18 Sep` — the tier-0 heading. */
  label: string;
  /** `Friday 18 September` — every wider tier, and the group list's accessible name. */
  longLabel: string;
  /** `August 2026` — what a month rule says, and what tells two groups' months apart. */
  month: string;
  printings: NewPrinting[];
}

/**
 * The flat feed folded into day groups.
 *
 * **A fold and never a sort**: `released_at` is already `YYYY-MM-DD` and the command already
 * answers newest first, so re-ordering here would be a second opinion about a question SQL has
 * answered — and the two would drift the first time either changed.
 */
export function printingDays(printings: readonly NewPrinting[]): PrintingDay[] {
  const days: PrintingDay[] = [];
  for (const printing of printings) {
    const last = days[days.length - 1];
    if (last !== undefined && last.key === printing.releasedAt) {
      last.printings.push(printing);
      continue;
    }
    const when = new Date(`${printing.releasedAt}T00:00:00Z`);
    days.push({
      key: printing.releasedAt,
      label: DAY_SHORT.format(when),
      longLabel: DAY_LONG.format(when),
      month: MONTH_LABEL.format(when),
      printings: [printing],
    });
  }
  return days;
}

/** Midnight UTC of a `YYYY-MM-DD`, in Unix seconds — what a release day is compared as. */
function dayStart(key: string): number {
  return Date.parse(`${key}T00:00:00Z`) / 1000;
}

/**
 * Has the reader seen this day already?
 *
 * The cursor is the moment this device last drew a non-empty feed, so everything released before
 * it was on the screen they looked at. A day with an unreadable date reads as *seen*, which draws
 * no dot — the quiet failure, where the loud one would mark a whole feed new for ever.
 */
export function daySeen(day: PrintingDay, seenAt: number | null): boolean {
  if (seenAt === null) return false;
  const start = dayStart(day.key);
  return Number.isFinite(start) && start < seenAt;
}

/**
 * Which day groups the box has room for, cut to whole rows — the design's `body()` for this kind.
 *
 * `ActivityWidget.fitDays`' shape with one difference that matters: a day header here is **not** a
 * row, so the budget is kept in pixels rather than in lines. Each group spends its header and then
 * as many whole row-lines as are left; **a group with no line left is dropped rather than drawn as
 * a header over nothing**, which would read as a day on which nothing was printed. A group's rows
 * fill `fit.listColumns` columns, so one line is one column's worth of rows.
 *
 * It stops at the first group that does not fit rather than skipping it: the groups are ordered and
 * nothing later is cheaper, so carrying on could only draw an older day above a newer one's rows.
 *
 * Exported for its own test — it is arithmetic, and the cases worth pinning are easier to state
 * over a list than through a render.
 */
export function fitGroups(
  days: readonly PrintingDay[],
  fit: WidgetFit,
  reserved: number,
): PrintingDay[] {
  let left = Math.max(0, fit.bodyHeightPx - reserved);
  const out: PrintingDay[] = [];
  for (const day of days) {
    // Every group after the first is preceded by the body's own gap.
    const lead = (out.length > 0 ? GROUP_GAP_PX : 0) + HEADER_PX + fit.rowGap;
    const lines = Math.floor((left - lead + fit.rowGap) / (ROW_PX + fit.rowGap));
    if (lines <= 0) break;
    const take = Math.min(day.printings.length, lines * fit.listColumns);
    const rows = Math.ceil(take / fit.listColumns);
    left -= lead + rows * ROW_PX + (rows - 1) * fit.rowGap;
    out.push({ ...day, printings: day.printings.slice(0, take) });
  }
  // **A card with room for nothing still says something.** `fit.linesFit`'s floor of one, stated
  // for groups: a 2×2 squeezed under its own footprint draws its newest day and scrolls.
  if (out.length === 0 && days.length > 0) {
    return [{ ...days[0], printings: days[0].printings.slice(0, 1) }];
  }
  return out;
}

/** Where the two kinds of rule fall in a fitted list. */
export interface RuleMarks {
  /** Indices a month rule is drawn **before** — never index 0, where it would be a heading over
   *  the card's own heading. */
  months: number[];
  /** The index the `Seen already` rule is drawn before, or `null` when there is no boundary
   *  inside what is drawn. */
  seenAt: number | null;
}

/**
 * The rules a fitted list carries — read once for the budget and once for the drawing, so a rule
 * can never be painted into space nothing reserved.
 *
 * The `Seen already` rule needs a group on **both** sides of it: drawn under the last group it
 * would be a line closing the list rather than a boundary inside it.
 */
export function ruleMarks(
  days: readonly PrintingDay[],
  opts: { months: boolean; seen: boolean; seenAt: number | null },
): RuleMarks {
  const months: number[] = [];
  if (opts.months) {
    for (let i = 1; i < days.length; i += 1) {
      if (days[i].month !== days[i - 1].month) months.push(i);
    }
  }
  let seen: number | null = null;
  if (opts.seen) {
    const first = days.findIndex((day) => daySeen(day, opts.seenAt));
    if (first > 0) seen = first;
  }
  return { months, seenAt: seen };
}

/**
 * The sentence for a list with nothing in it — see the module doc for why there is more than one.
 *
 * `null` when there is something to draw. **The watched count is read before the list**, for
 * `PriceMovers`' reason one widget over: a reader watching no decks has an empty list for a reason
 * that has nothing to do with reprints, and telling them nothing was reprinted is a claim about a
 * comparison nobody made.
 */
export function emptySentence(answer: NewPrintings, days: number): string | null {
  if (answer.decksWatched === 0) return NO_DECKS;
  if (answer.printings.length > 0) return null;
  return (
    `Nothing in the ${plural(answer.decksWatched, "deck")} you watch has been reprinted in the ` +
    `last ${plural(days, "day")}. New printings arrive with each card data sync.`
  );
}

/**
 * The language allow-list this widget will send, from the `langs` pick and the stored ids.
 *
 * **Empty is every language** — the one sentinel, and the same rule the command has. Three modes
 * collapse into one list here rather than travelling as a mode *and* a list, which would be two
 * fields that can disagree.
 *
 * **`chosen` with nothing usable reads as English, and gets no sentence.** This parts from
 * `DecksWidget`, which says *no decks pinned yet* rather than falling back, and the difference is
 * what the empty set means: an empty deck set is a real statement (*compare against nothing*),
 * where an empty language set would mean *show no printings at all*, which nobody means by
 * unticking the last box. The ids are narrowed against `languages.ts`'s table on the way — the
 * vocabulary check a hand-editable `config` needs, and `widgetConfig`'s shallow shape check cannot
 * make.
 */
export function resolveLangs(widget: HomeWidget): string[] {
  const mode = pickOf(widget, "langs");
  if (mode === "all") return [];
  if (mode !== "chosen") return ["en"];
  const chosen = chosenLangIds(widget);
  return chosen.length > 0 ? chosen : ["en"];
}

/**
 * The ticked language codes, narrowed against `languages.ts` — `DecksWidget.pinnedDeckIds`'
 * element check, one config key over. A **fresh** fallback per call, so no two widgets can come to
 * share one array.
 *
 * ⚠️ **Lowercased on the way out, because `isKnownLanguage` folds case and the corpus does not.**
 * `cards.lang` holds Scryfall's own lowercase word and SQLite's `=` on text is case-sensitive, so
 * a hand-edited `["EN"]` would pass this check, travel as written, be dropped by Rust's
 * `is_lang_code` (two-to-four *lowercase* letters), empty the allow-list — and an empty list is
 * *every language*. A narrowing that widens is the worst shape a fence can have, so the fold
 * happens here rather than being left to agree by accident at three sites.
 */
export function chosenLangIds(widget: HomeWidget): string[] {
  return widgetConfig(widget, { langIds: [] as string[] })
    .langIds.filter((code) => typeof code === "string" && isKnownLanguage(code))
    .map((code) => code.toLowerCase());
}

/** The chosen deck ids, narrowed — `DecksWidget.pinnedDeckIds`' rule verbatim, and for its reason:
 *  `widgetConfig`'s shape check is shallow, so a hand-edited `["3"]` or a `NaN` is dropped here. */
export function chosenDeckIds(widget: HomeWidget): number[] {
  return widgetConfig(widget, { deckIds: [] as number[] }).deckIds.filter((id) =>
    Number.isInteger(id),
  );
}

/** Which decks the card watches. **Two words, not three** — there is no `decks.pinned` column, so
 *  `chosen` is the only id-carrying scope there can be and anything else is `all`. */
export function scopeOf(widget: HomeWidget): "all" | "chosen" {
  return pickOf(widget, "scope") === "chosen" ? "chosen" : "all";
}

/**
 * What the footer says the languages are: *English*, *every language*, *English and Japanese*,
 * *4 languages*.
 *
 * Named off `languageName`, so `PH` reads as Phyrexian here exactly as it does in the card pane —
 * issue #161's answer, reused rather than restated.
 */
export function languagePhrase(langs: readonly string[]): string {
  if (langs.length === 0) return "every language";
  if (langs.length === 1) return languageName(langs[0]);
  if (langs.length === 2) return `${languageName(langs[0])} and ${languageName(langs[1])}`;
  return plural(langs.length, "language");
}

/**
 * ⚠️ **§8's footprint-scaled window default is deliberately not implemented, and it shipped once
 * as dead code before that was noticed.**
 *
 * The design wanted a card of `w * h >= 24` to arrive on *a year* rather than ninety days, and
 * called it "a one-line default in the component". It is not one, in two ways. The registry gives
 * the `window` pick `dflt: 90`, and `pickValue` falls back to it — so `pickOf` answers a *number*
 * for a card nobody has configured, the `typeof picked === "number"` arm is true on every render,
 * and a `defaultWindow(fit.w, fit.h)` beside it can never run. Reading the raw config instead
 * fixes that half and exposes the other: the title chip is `chipLabel(widget)`, which takes no
 * `fit`, so a fresh 6 × 4 card would **read a year while its own chip said 90 days**. Threading
 * the fit through `chipLabel` is a change to chrome all ten kinds draw, for one kind's nicety.
 *
 * So every card opens on ninety days and the chip never lies; a reader who wants the year is one
 * press away in the settings. Recorded in §12 of `docs/reference/home-page.md`.
 */

export function NewPrintingsWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const client = useQueryClient();
  const scope = scopeOf(widget);
  const deckIds = chosenDeckIds(widget);
  // The pick only ever answers one of its own options or its `dflt` of 90, so a stored `NaN`,
  // `9999` or `"90"` reads as ninety here and never reaches the backend's clamp — the narrowing
  // `widgetSettings.ts` already does. See the note above on §8's footprint default.
  const picked = pickOf(widget, "window");
  const days = typeof picked === "number" ? picked : WINDOW_FALLBACK;
  const langs = resolveLangs(widget);
  // **Whether a row must say its language** — anything but English alone, and at every tier. Read
  // off the *resolved* list and never off the pick, so a `chosen` that narrowed down to English
  // alone draws no code: there would be nothing for it to tell apart.
  const showLang = !(langs.length === 1 && langs[0] === "en");
  const flags = {
    virtual: toggleOnOf(widget, "virtual"),
    theory: toggleOnOf(widget, "theory"),
    basics: toggleOnOf(widget, "basics"),
  };

  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);

  const query = useQuery({
    queryKey: newPrintingsKey(scope, deckIds, days, langs, flags, NEW_PRINTINGS_READ),
    queryFn: () =>
      ipc.newPrintings(
        scope,
        deckIds,
        days,
        langs,
        flags.virtual,
        flags.theory,
        flags.basics,
        NEW_PRINTINGS_READ,
      ),
  });

  /**
   * The cursor as it stood when this card mounted — see the module doc. `undefined` is *not read
   * yet*; `null` is the reader's real *never*, which marks every row.
   *
   * **Latched during render rather than in an effect.** React's own answer to state that has to
   * follow a prop: the adjustment is made before the commit, so no frame ever draws a dot the
   * cursor had already put out, and there is no `setState` inside an effect for lint to find at
   * `verify`.
   */
  const [seenAt, setSeenAt] = useState<number | null | undefined>(undefined);
  if (seenAt === undefined && query.data !== undefined) setSeenAt(query.data.seenAt);

  // The row dialog's state — see {@link openRow}. Above every early return, for the rules of hooks.
  const [pressed, setPressed] = useState<NewPrinting | null>(null);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);

  /**
   * Move the cursor, once, as soon as there is a list to have seen.
   *
   * Fire-once through a ref rather than through the effect's deps, because the deps go on
   * answering `true` for the rest of the mount. **Never while `still`** — a catalogue preview
   * publishes nothing. **The failure is silent**: a mark is not worth a sentence, and a refusal
   * here leaves every dot where it was, which is the honest picture of a cursor that did not move.
   * The invalidation is what keeps `NEW_PRINTINGS_ROOT` a root with a writer (`keys.ts`); it
   * changes nothing on screen, because what the dots are drawn from is the latched cursor above.
   */
  const wrote = useRef(false);
  const hasRows = query.data !== undefined && query.data.printings.length > 0;
  useEffect(() => {
    if (still || !hasRows || wrote.current) return;
    wrote.current = true;
    void ipc.markNewPrintingsSeen(Math.floor(Date.now() / 1000)).then(
      () => client.invalidateQueries({ queryKey: NEW_PRINTINGS_ROOT }),
      () => undefined,
    );
  }, [client, hasRows, still]);

  const printings = query.data?.printings ?? NONE;
  const grouped = useMemo(() => printingDays(printings), [printings]);

  /**
   * **`decks` is one view with two states, and all three writes are ordered.** `setActiveView`
   * clears `openDeckId` on the way in — `DecksWidget` says the whole of that at its own site — so
   * the deck is named after the view.
   *
   * ⚠️ **It clears `selectedCardId` too (`store.ts`'s `setActiveView`), which is why the card is
   * named last and not first.** Selecting the printing before the navigation reads better and does
   * nothing at all: the very next line throws it away, and the deck opens with no card picked out.
   * `setOpenDeckId` clears nothing, so view → deck → card is the one order in which every write
   * survives.
   */
  const openDeck = (deckId: number, printingId: string) => {
    setOpen(false);
    setActiveView("decks");
    setOpenDeckId(deckId);
    setSelectedCardId(printingId);
  };

  /**
   * The printing a row opened, and whether its dialog is up — **two pieces of state rather than a
   * nullable one**, because `Dialog` outlives `open` by the length of its fade and needs a card to
   * draw while it goes. The printing is latched as the row had it, so a refetch that reorders the
   * list under an open dialog cannot swap the card inside it.
   *
   * The opener is kept so Escape and the ✕ can hand the caret back to the row, which is what
   * `Dialog` asks of its host; a scrim press does not, on that shell's rule that the reader is
   * already somewhere else.
   */
  const openRow = (printing: NewPrinting, from: HTMLButtonElement) => {
    opener.current = from;
    setPressed(printing);
    setOpen(true);
  };
  const dismiss = () => {
    setOpen(false);
    opener.current?.focus();
  };
  /**
   * *Open card details* — the card modal, on this printing, over the home page.
   *
   * **The caret goes back to the row before the card is selected**, and the order is the whole of
   * it: the card modal remembers whatever holds the caret as it mounts and hands it back there when
   * it closes, so a row focused first is where the reader lands after both layers are gone. The
   * other order leaves this dialog's panel as the remembered opener, which is a node on its way out
   * of the document.
   */
  const openCard = (printingId: string) => {
    dismiss();
    setSelectedCardId(printingId);
  };

  // **The refusal is read before the emptiness**, which is `ActivityWidget`'s rule and its reason:
  // a failed read has no rows either, and calling it "nothing has been reprinted" tells a reader
  // with six decks that the game has stopped printing cards.
  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not read recent printings — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;

  const answer = query.data;
  const empty = emptySentence(answer, days);
  if (empty !== null) return <WidgetMessage>{empty}</WidgetMessage>;

  /**
   * The furniture, budgeted before the rows are laid in — spec §5's rule, so a card one pixel short
   * of a rule drops a row rather than clipping the rule.
   *
   * **Two passes, and the second can only shrink.** How many rules there are depends on which
   * groups fit, and which groups fit depends on the rules; fitting once, counting the rules that
   * landed and re-fitting against them settles it in one step, and because the second list is a
   * prefix of the first its rules are a subset of what was reserved. Nothing is ever drawn into
   * space nothing budgeted.
   */
  const exhaustible = answer.printings.length < NEW_PRINTINGS_READ && answer.oldest !== null;
  const closing = fit.h >= CLOSING_FROM_H && exhaustible;
  const base = FOOTER_PX + (closing ? CLOSING_PX : 0);
  const ruleOpts = {
    months: fit.h >= MONTH_RULE_FROM_H,
    seen: fit.h >= SEEN_RULE_FROM_H,
    seenAt: seenAt ?? null,
  };
  const first = fitGroups(grouped, fit, base);
  const firstMarks = ruleMarks(first, ruleOpts);
  const ruleCount = firstMarks.months.length + (firstMarks.seenAt === null ? 0 : 1);
  const shown =
    ruleCount === 0 ? first : fitGroups(grouped, fit, base + ruleCount * (RULE_PX + fit.rowGap));
  const marks = ruleMarks(shown, ruleOpts);
  const drawn = shown.reduce((sum, day) => sum + day.printings.length, 0);

  return (
    <>
      <div className="flex flex-col" style={{ gap: GROUP_GAP_PX }}>
        {shown.map((day, index) => (
          // A `Fragment` and not a `display: contents` wrapper: the rules and the group are
          // siblings of each other in the body's own gapped column, and `contents` is a box
          // Chromium has mistreated in the accessibility tree before (`src/CLAUDE.md`).
          <Fragment key={day.key}>
            {marks.months.includes(index) && <Rule label={day.month} heading />}
            {marks.seenAt === index && <Rule label="Seen already" />}
            <Section
              day={day}
              fit={fit}
              tier={fit.tier}
              showLang={showLang}
              seen={daySeen(day, seenAt ?? null)}
              still={still}
              onOpen={openRow}
            />
          </Fragment>
        ))}
      </div>
      {/* Drawn only when everything the read answered is on screen: a list that is still scrolling
          has not run out of window, it has run out of card. */}
      {closing && drawn === answer.printings.length && answer.oldest !== null && (
        <p className="m-0 shrink-0 pt-1.5 text-center text-xs text-dim">
          Nothing older than {DAY_IN_WORDS.format(new Date(`${answer.oldest}T00:00:00Z`))} in this
          window.
        </p>
      )}
      <WidgetFooter>
        {footerLine(fit.tier, answer.decksWatched, days, langs, flags)}
      </WidgetFooter>
      {/* Mounted inside the body, `StickyNoteDialog`'s precedent: the scrim is `fixed` and the
          home page has no containment, so it is drawn against the window wherever it sits in the
          tree. **`AppScale` is what that precedent lacks** — the grid's Ctrl+scroll `zoom` reaches
          a `fixed` descendant too, and a dialog is chrome rather than dashboard. Never while
          `still` — a catalogue preview has no rows to press. */}
      {pressed !== null && !still && (
        <AppScale>
          <NewPrintingDialog
            printing={pressed}
            open={open}
            onDismiss={dismiss}
            onClose={() => setOpen(false)}
            onOpenDeck={openDeck}
            onOpenCard={openCard}
          />
        </AppScale>
      )}
    </>
  );
}

/**
 * The line under the rows: what was compared, over what window, in which languages, and which of
 * the three switches is not at its default.
 *
 * Tier 0 has room for the first two facts and abbreviates both. Everything wider says the whole
 * sentence — the artboard's `6 decks watched · 90 days · basics hidden`, with the languages in it
 * because a feed's language set is the one setting that changes how many rows a reprint is.
 */
export function footerLine(
  tier: number,
  decksWatched: number,
  days: number,
  langs: readonly string[],
  flags: { virtual: boolean; theory: boolean; basics: boolean },
): string {
  if (tier === 0) return `${plural(decksWatched, "deck")} · ${days}d`;
  const parts = [
    `${plural(decksWatched, "deck")} watched`,
    plural(days, "day"),
    languagePhrase(langs),
    // Stated whichever way round it is: basics are excluded by default, so a reader who never
    // touched the switch is still told what is not in the list.
    flags.basics ? "basics included" : "basics hidden",
  ];
  // The other two are stated only where they differ from the default, which is what keeps the
  // ordinary line short enough to read.
  if (flags.virtual) parts.push("virtual decks included");
  if (!flags.theory) parts.push("theory cards hidden");
  return parts.join(" · ");
}

/**
 * A rule across the body with a word on it — the month turning, or the line the reader's last
 * visit falls on.
 *
 * One component for both because they are one drawing: a stub of rule, the word, and the rest of
 * the rule. A month is set in the display face (`font-heading`) and the boundary is not, which is
 * the whole of what tells a *when* from a *what happened here*.
 */
function Rule({ label, heading = false }: { label: string; heading?: boolean }): ReactElement {
  return (
    <div className="flex h-5 shrink-0 items-center gap-2">
      <span aria-hidden="true" className="h-px w-3.5 bg-border" />
      <span
        className={cn("shrink-0 whitespace-nowrap text-xs tracking-wide text-dim", heading && "font-heading")}
      >
        {label}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * One release day: its heading, and its printings in the card's own column count under it.
 *
 * **Not sticky**, matching `ActivityWidget` and for its reason: a sticky heading needs a background
 * of its own, which would paint a band across Customize's tinted card.
 */
function Section({
  day,
  fit,
  tier,
  showLang,
  seen,
  still,
  onOpen,
}: {
  day: PrintingDay;
  fit: WidgetFit;
  tier: number;
  showLang: boolean;
  seen: boolean;
  still: boolean;
  onOpen: (printing: NewPrinting, from: HTMLButtonElement) => void;
}): ReactElement {
  return (
    <section className="flex flex-col" style={{ gap: fit.rowGap }}>
      {/* ⚠️ **The heading holds the label and nothing else, and the rule and the count are its
          siblings** — `ActivityWidget`'s `Heading` exactly, and for the reason that widget's own
          comment gives. Name computation trims each element's contribution before appending it, so
          a `gap` between two children of the `h4` joins them with no space at all: the count inside
          it made the day read "Friday 18 September2", which is the `Missing2` failure this comment
          used to cite while committing it. `h4` under the card's own heading, so the card and its
          day sections are one outline. */}
      <div className="flex h-4 shrink-0 items-center gap-2 text-[0.6875rem] uppercase leading-4 tracking-wide text-dim">
        <h4 className="m-0 whitespace-nowrap">{tier === 0 ? day.label : day.longLabel}</h4>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <span className="shrink-0 font-mono tracking-normal tabular-nums">
          {day.printings.length}
        </span>
      </div>
      <WidgetRowList fit={fit} label={day.longLabel}>
        {day.printings.map((printing) => (
          <PrintingRow
            key={printing.printingId}
            printing={printing}
            tier={tier}
            showLang={showLang}
            unseen={!seen}
            still={still}
            onOpen={onOpen}
          />
        ))}
      </WidgetRowList>
    </section>
  );
}

/** The row's own box — 46px of thumb, 3px of padding each side and a 1px border is
 *  {@link ROW_PX}. Written once so the two halves of {@link PrintingRow} cannot drift. */
const ROW_BOX =
  "flex w-full items-center gap-2 rounded-md border border-border px-1.5 py-[3px] text-left";

/**
 * One reprinted printing — and the press that opens it, large, over the page.
 *
 * **The whole row is the press** rather than a button beside one: the row *is* the question, and a
 * second control inside it would be two tab stops per printing on a card that can draw thirty-two
 * of them. What it opens is `NewPrintingDialog`, which the body mounts — see that file for why this
 * stopped being an anchored popover (issue #514).
 *
 * ⚠️ **`aria-haspopup="dialog"` and no `aria-expanded`**, and the second half is load-bearing
 * rather than an omission. `WidgetCard` lifts itself to `LAYER.raised` whenever anything inside it
 * carries `aria-expanded="true"` — the rule its own two popovers need — and a card with a z-index
 * is a stacking context, which would cap this row's dialog, scrim and all, at `z-10` in the page's.
 * A dialog opener is not a disclosure anyway: the dialog takes the caret, and the row it came from
 * is behind a scrim until it closes.
 */
function PrintingRow({
  printing,
  tier,
  showLang,
  unseen,
  still,
  onOpen,
}: {
  printing: NewPrinting;
  tier: number;
  showLang: boolean;
  unseen: boolean;
  still: boolean;
  onOpen: (printing: NewPrinting, from: HTMLButtonElement) => void;
}): ReactElement {
  const inner = <RowFace printing={printing} tier={tier} showLang={showLang} unseen={unseen} />;
  if (still) {
    return (
      <li>
        <div className={ROW_BOX}>{inner}</div>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={rowName(printing, showLang, unseen)}
        onClick={(e) => onOpen(printing, e.currentTarget)}
        className={cn(ROW_BOX, "hover:border-dim hover:bg-surface", PRESS, FOCUS)}
      >
        {inner}
      </button>
    </li>
  );
}

/**
 * The whole row in one string, because the parts would not survive name computation — three flex
 * children separated by a `gap` and no whitespace text node concatenate to `Sol RingSLD2 decks`.
 *
 * Every word a wide row shows is in here in the same order, whatever this box happens to be
 * drawing, so the name a reader drives by voice does not change as the card is resized — and the
 * two marks that are `aria-hidden` on screen (the gold dot, the gem) are said in words.
 */
export function rowName(printing: NewPrinting, showLang: boolean, unseen: boolean): string {
  const parts = [printing.name, printing.setCode.toUpperCase()];
  if (printing.setName !== null) parts.push(printing.setName);
  if (showLang) parts.push(languageName(printing.lang));
  if (printing.rarity !== null) parts.push(printing.rarity);
  parts.push(plural(printing.decks.length, "deck"));
  if (unseen) parts.push("not seen yet");
  return parts.join(" · ");
}

/** What a row draws, at whatever tier — the thumb, the name over its caption, and the marks at the
 *  right. Shared by the pressable row and the `still` one so a catalogue preview is a picture of
 *  the real thing rather than a second drawing of it. */
function RowFace({
  printing,
  tier,
  showLang,
  unseen,
}: {
  printing: NewPrinting;
  tier: number;
  showLang: boolean;
  unseen: boolean;
}): ReactElement {
  const tip = useTooltip();
  // §4's tier-2 addition, from the column the wire actually carries — see the module doc for why
  // it is a treatment rather than the spec's frame effect.
  const treatment = tier >= 2 ? treatmentName(cardTreatments(printing.promoTypes)) : null;
  return (
    <>
      <span className="flex-none" style={{ width: THUMB_PX }}>
        {/* **A whole printed card, never the `art` crop.** A crop has no printed frame, so wherever
            one is shown its illustrator must be named; a `thumb` carries the credit printed on the
            card itself, which is Scryfall's second arm met by construction in a 33px frame with no
            room for a credit line. Decorative: the name is the line beside it.

            **`imageUrl` is the web and Android builds' picture** and is ignored on the desktop,
            where the local cache's `thumb` wins (`cardArtSrc`). It is the `display` URL because
            that is what the wire carries — `image_uri::LIST_VARIANTS` is `display` and `art` —
            and a 672px card drawn at 33 is still the card; an empty frame was not (issue #514). */}
        <CardArt
          cardId={printing.printingId}
          name=""
          variant="thumb"
          imageUrl={printing.imageUris?.display}
          loading="lazy"
          className="rounded-[3px]"
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="truncate text-sm font-medium leading-[18px] text-text">
          {printing.name}
        </span>
        <span className="flex min-w-0 items-center gap-[5px] text-[0.6875rem] leading-[14px]">
          <RarityGem rarity={printing.rarity} />
          <span className="flex-none font-mono text-text">{printing.setCode.toUpperCase()}</span>
          {/* **The language, at every tier including the tile.** See the module doc: it is what
              tells two rows of one reprint apart, not a detail a small card can drop. */}
          {showLang && (
            <span
              {...tip(languageHint(printing.lang), { describes: false })}
              className="flex-none font-mono text-dim"
            >
              {printing.lang.toUpperCase()}
            </span>
          )}
          {tier === 0 ? (
            // No room for a chip at two cells, so the deck count goes in the caption — `WidgetRow`'s
            // own rule for a tile, restated where the row is local.
            <span className="min-w-0 truncate font-mono text-dim">
              · {printing.decks.length}×
            </span>
          ) : (
            <span className="min-w-0 truncate text-xs text-dim">
              {printing.setName ?? printing.setCode.toUpperCase()}
              {treatment !== null && ` · ${treatment}`}
            </span>
          )}
        </span>
      </span>
      <span className="flex flex-none items-center gap-1.5">
        {tier > 0 && (
          <span className="whitespace-nowrap rounded border border-border px-[5px] font-mono text-[0.6875rem] leading-4 text-text">
            {plural(printing.decks.length, "deck")}
          </span>
        )}
        {/* The mark is said in the row's accessible name, so the dot itself is a picture. */}
        {unseen && <span aria-hidden="true" className="block size-[5px] rounded-full bg-accent" />}
      </span>
    </>
  );
}

/**
 * The words a pick's row and one of its options carry, read off the registry — so a sentence that
 * points at a control cannot come to name a control that has been renamed. `DecksWidget`'s
 * `scopeWords()`, one kind over and one argument wider.
 */
function pickWords(key: string, optionId: string): { row: string; option: string } {
  const pick = widgetMeta("newPrintings").picks.find((entry) => entry.key === key);
  return {
    row: pick?.label ?? key,
    option: pick?.options.find((option) => option.id === optionId)?.label ?? "Chosen…",
  };
}

/**
 * This kind's own settings, under the rows the registry declares: the deck checklist behind
 * `Which decks → Chosen…`, and the language checklist behind `Languages → Chosen…`.
 *
 * **Each picker is drawn only while its own pick is on `Chosen…`.** A picker under `All decks`
 * would be a control whose every press changes nothing on the card, which reads as broken — and
 * the pick's row is directly above this in the same popover. Both sets are **kept** while hidden,
 * so switching back brings the reader's choice back as it was.
 */
export function NewPrintingsWidgetSettings({
  widget,
  onConfig,
}: WidgetSettingsProps): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <DeckPicker widget={widget} onConfig={onConfig} />
      <LanguagePicker widget={widget} onConfig={onConfig} />
    </div>
  );
}

/** The deck checklist — `DecksWidgetSettings`' shape, one kind over. */
function DeckPicker({ widget, onConfig }: WidgetSettingsProps): ReactElement {
  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const deckIds = chosenDeckIds(widget);
  const words = pickWords("scope", "chosen");

  if (scopeOf(widget) !== "chosen") {
    return (
      <p className="m-0 text-xs text-dim">
        Choose {words.option} under {words.row} to pick the decks this card watches.
      </p>
    );
  }

  /**
   * Sorted by the deck's **name** rather than by the row's label, so the `(archived)` suffix a
   * retired deck carries does not file it under A — `DecksWidgetSettings`' reason verbatim.
   */
  const options: DropdownOption[] = sortOptions(decksQuery.data ?? NO_DECK_ROWS, (deck) => deck.name).map(
    (deck) => ({
      value: String(deck.id),
      label: deck.archived ? `${deck.name} (archived)` : deck.name,
      hint: deck.formatName ?? deck.formatKey,
    }),
  );

  /**
   * **The patch writes `scope: "chosen"` beside the ids**, `DecksWidgetSettings`' rule: the choice
   * is stored rather than inferred, so nothing can flip the card back to `All decks` under the
   * reader's hand and take this picker away mid-press. The page merges the patch, so every other
   * key — a newer build's included — is kept.
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
        label="Decks to watch"
        // Searchable only where scrolling would be the alternative — `DecksWidgetSettings`'
        // judgement, and this panel shows about the same eight rows.
        searchable={options.length > 8}
        searchLabel="Search decks"
        options={options}
        selected={deckIds.map(String)}
        onToggle={toggle}
        triggerLabel={deckIds.length === 0 ? "None chosen" : plural(deckIds.length, "deck")}
      />
      {decksQuery.isError && (
        <p className="m-0 text-xs text-destructive">
          Could not read your decks — {ipcError(decksQuery.error)}
        </p>
      )}
    </div>
  );
}

/**
 * The language checklist — `languages.ts`'s nineteen codes, English pinned first and the rest by
 * name.
 *
 * **The row's label is the language and its code is the hint**, which is the one place this parts
 * from `PrintingsFilterBar`'s own list: that control has a `name` field beside its visible `text`,
 * where a `DropdownOption`'s `label` *is* the accessible name. Putting the code there would make
 * the row announce `PH`, which is precisely the riddle issue #161 is about — so the word is the
 * label, the code is drawn beside it, and both are in the name.
 *
 * **No *nothing chosen* sentence.** `resolveLangs` reads an empty set as English, because an empty
 * language set would otherwise mean *show no printings at all*, which is never what anyone means
 * by unticking the last box. The trigger says so rather than a line under it.
 */
function LanguagePicker({ widget, onConfig }: WidgetSettingsProps): ReactElement | null {
  const chosen = chosenLangIds(widget);
  if (pickOf(widget, "langs") !== "chosen") return null;

  // `en` is pinned outside the sort — the app's own rule for a row whose position a reader learns.
  const rest = sortOptions(
    LANGUAGE_CODES.filter((code) => code !== "en"),
    (code) => languageName(code),
  );
  const options: DropdownOption[] = ["en", ...rest].map((code) => ({
    value: code,
    label: languageName(code),
    hint: code.toUpperCase(),
  }));

  /** **The patch writes `langs: "chosen"` beside the ids**, for the deck picker's reason: the mode
   *  is stored rather than inferred from a non-empty set. */
  const toggle = (value: string) => {
    const next = chosen.includes(value)
      ? chosen.filter((each) => each !== value)
      : [...chosen, value];
    onConfig({ langIds: next, langs: "chosen" });
  };

  return (
    <MultiDropdown
      fill
      size="sm"
      label="Languages to show"
      searchable={options.length > 8}
      searchLabel="Search languages"
      options={options}
      selected={chosen}
      onToggle={toggle}
      // An empty set reads as English, so the trigger says the answer rather than the count.
      triggerLabel={chosen.length === 0 ? "English" : languagePhrase(chosen)}
    />
  );
}
