/**
 * Every deck's To-do band, gathered on the home page and ticked off where it stands — a heading per
 * deck and its to-dos beneath it, sub-to-dos indented one step per level (issue #672, spec
 * `docs/superpowers/specs/2026-09-29-deck-todos-design.md` §7).
 *
 * **A body, not a card.** `WidgetCard` draws the title, the `Which decks` chip, the settings popover
 * and the Customize tray; this draws the headings, the to-dos, the one-line failure slot and the
 * `+N more` footer, cut to the box `fit` describes. The `Chosen…` checklist at the foot of the
 * popover is {@link DeckTodosWidgetSettings}, which `HomePage.tsx`'s `renderExtraSettings` hands to
 * this kind.
 *
 * ⚠️ **A to-do list is not a note.** It shares the deck notes' editor and inline dialect and nothing
 * else: one list to a deck, a column on the `decks` row (`decks.todos`), and a to-do is a *line* of
 * it with no id of its own. This file reads the list through `todoMarkdown.ts` and never loads the
 * editor — a card on a dashboard is no place for 141.5 kB of ProseMirror.
 *
 * ## Rust answers the lists; this file draws the conclusions
 *
 * One read, {@link deckTodoListsKey} over `deck_todo_lists`: every deck whose list is not empty, with
 * its name, whether it is archived, whether its band is open, and when it was last edited. Scope,
 * the archived switch, the two to-do switches and the order are all decided here, over that one
 * answer — the three orders are three readings of one list, `DeckCompletionWidget`'s argument. **The
 * open count is `countTodos` over the deck's whole list**, at every depth and whatever the switches
 * hide, so the heading says how much is left in the deck and never how much fitted on the card.
 *
 * ## A tick is a compare-and-set
 *
 * A to-do is named by its **source line in the body this card read**, and the body may have moved
 * since — the band autosaving in another window, a sync landing. So the tick sends the body it read
 * as `expected` and Rust refuses a mismatch with `TODOS_CHANGED` rather than flipping whatever now
 * sits on that line. A refusal re-reads and prints the refusal's own sentence in the one-line
 * failure slot; the reader ticks again against the fresh list. A success writes the new body into
 * the cache at once, so a second tick is made against the body the first one wrote, and then
 * re-reads under `["decks", "todos"]` — which is the band's key too. **While a write is out every
 * box refuses**, because a second tick's `expected` would be the body the first is replacing.
 *
 * **A line `parseTodos` reads only because nothing is dropped** — a plain bullet, a stray line from
 * a newer build — is drawn as an open to-do with no box to flip: `toggleTodo` answers `null` for it,
 * so its checkbox is `aria-disabled` and a press writes nothing.
 *
 * ## A heading opens the deck on its To-do band
 *
 * `DeckCompletionWidget`'s press — `setActiveView("decks")` then `setOpenDeckId(id)`, the order
 * `setActiveView`'s own clearing of the id forces — with one write in front: the band's disclosure,
 * sent only when {@link DeckTodoList.todosOpen} says it is shut, and awaited, so the deck opens on
 * it. A refused disclosure still opens the deck; the band is one press away there.
 *
 * ## Rows are whole, and a heading never closes the list
 *
 * Every row costs its own drawn height — a heading {@link LINE_PX}, a to-do its padding and one
 * {@link TEXT_LINE_PX} per line its text is estimated to wrap to — and rows are taken, with the
 * body's gap between each, until the next would not fit: `fit.fitCount`'s arithmetic, over rows of
 * more than one height. A footer line is reserved only when something is left over. **The to-do
 * the cut lands on is drawn clamped to the lines left** rather than dropped, so a to-do taller than
 * the whole card still shows its first lines instead of leaving the card empty but for `+N more`.
 * A heading whose to-dos all fell past the cut is dropped with them, `ActivityWidget`'s rule for a
 * day with no line left: it would read as a deck with nothing to do.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`' module doc has the argument.
 */
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { Check } from "lucide-react";
import type { ReactElement } from "react";

import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { Inline } from "@/features/decks/noteMarkdown";
import {
  countTodos,
  parseTodos,
  toggleTodo,
  visibleTodos,
  type TodoItem,
} from "@/features/decks/todoMarkdown";
import { count, plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DeckRow, type DeckTodoList, type HomeWidget } from "@/lib/ipc";
import { PRESS_SOFT } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

import { footerLinePx, type WidgetFit } from "../fit";
import { deckListKey, deckTodoListsKey } from "../keys";
import { WidgetFooterLine, WidgetMessage } from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { widgetMeta } from "../widgets";
import { pinnedDeckIds } from "./DecksWidget";

/** The registry's `order` pick. */
export type TodoOrder = "edited" | "name" | "open";

/** The registry's `scope` pick: every deck, or the reader's checklist. */
export type TodoScope = "all" | "chosen";

/**
 * Everything a to-do write can have moved: the lists this card reads **and** each band's own
 * `["decks", "todos", deckId]`. Taken off {@link deckTodoListsKey} so the two cannot come to spell
 * the prefix differently.
 */
const TODOS_ROOT: QueryKey = deckTodoListsKey.slice(0, 2);

/**
 * One line of a to-do's text: 14px type on a 19px leading — {@link TodoLine}'s `leading-[19px]`.
 * **Each line a to-do wraps to adds this and nothing else**, since the row's padding is paid once.
 */
const TEXT_LINE_PX = 19;

/** A to-do row's padding, above and below its text — {@link TodoLine}'s `py-1`. */
const ROW_PAD_PX = 8;

/**
 * A one-line row, in pixels: a heading ({@link DeckHeading}'s `h-[27px]`) and a to-do of one line
 * are both this tall — `ActivityWidget`'s figure. **The classes named on the two constants above
 * and on the heading spell this out and must stay in step with it.**
 */
const LINE_PX = TEXT_LINE_PX + ROW_PAD_PX;

/**
 * The line clamps a to-do the cut lands on may be drawn at, **as whole class names** — Tailwind
 * emits a rule only for a class it finds written out, so a count interpolated into `line-clamp-…`
 * would clamp nothing. Index `n - 1` clamps to `n` lines. Twelve is past any to-do worth reading
 * on a card; one the cut lands on with more room than that is clamped at twelve and leaves the
 * rest of the room empty. The widget's test compiles every entry against the real Tailwind.
 */
export const CLAMP_CLASSES = [
  "line-clamp-1",
  "line-clamp-2",
  "line-clamp-3",
  "line-clamp-4",
  "line-clamp-5",
  "line-clamp-6",
  "line-clamp-7",
  "line-clamp-8",
  "line-clamp-9",
  "line-clamp-10",
  "line-clamp-11",
  "line-clamp-12",
] as const;

/** How far each level of sub-to-do is pushed in: the box (14px) and the gap after it (8px), so a
 *  sub-to-do's box sits under its parent's first word. */
const INDENT_PX = 22;

/** The box and its gap, which a to-do's text never has for itself. */
const BOX_PX = 22;

/** An average glyph of 14px Geist, rounded up — how {@link linesOf} guesses where a to-do wraps.
 *  Rounded **up**, so a guess that is wrong costs a line of room rather than a scrollbar. */
const CHAR_PX = 7;

/** Stable identity for "the deck list has not answered". */
const NO_DECK_ROWS: readonly DeckRow[] = [];

const PENDING = "Loading to-dos…";
/** No deck in scope has a to-do at all — the first-launch face, and an answer rather than a
 *  failure. The spec's words; {@link NO_TODOS_HINT} is the dim line under them. */
export const NO_TODOS = "No to-dos yet";
export const NO_TODOS_HINT = "Add them in any deck's To-do band.";
export const NOTHING_CHOSEN = "No decks chosen. Choose decks in this widget's settings.";

/** A switch's label, read off the registry so a sentence cannot point at a renamed row. */
function toggleWord(key: string): string {
  return widgetMeta("deckTodos").toggles.find((toggle) => toggle.key === key)?.label ?? key;
}

/**
 * Every to-do in scope is done and completed ones are hidden. **Not {@link NO_TODOS}**, which would
 * tell a reader who has just finished a list that they never wrote one — `DeckCompletionWidget`'s
 * `ALL_COMPLETE`, for the same reason and in its words.
 */
export const ALL_DONE = `Every to-do here is done. Enable ${toggleWord("done")} in settings to view them.`;

/**
 * Nothing is drawn, yet a to-do in scope is still open — which only `Show sub-to-dos` off can do:
 * `visibleTodos` drops a done parent over an open child once children are not drawn, so a deck
 * whose only open work is nested draws nothing. {@link ALL_DONE} there would be false and would
 * name the wrong switch.
 */
export const NESTED_ONLY = `Open to-dos are nested under finished ones. Enable ${toggleWord("nested")} in settings to view them.`;

/** A pick's row label and one option's label, read off the registry — `DeckCompletionWidget`'s
 *  `pickWords`, so the checklist's hint names the control this card really has. */
function pickWords(key: string, optionId: string): { row: string; option: string } {
  const pick = widgetMeta("deckTodos").picks.find((entry) => entry.key === key);
  return {
    row: pick?.label ?? key,
    option: pick?.options.find((option) => option.id === optionId)?.label ?? optionId,
  };
}

/** Which decks this card draws. A stored word no option carries reads as `all`. */
export function todoScope(widget: HomeWidget): TodoScope {
  return pickOf(widget, "scope") === "chosen" ? "chosen" : "all";
}

function orderOf(value: string | number | undefined): TodoOrder {
  return value === "name" || value === "open" ? value : "edited";
}

/** One deck's list, read: every to-do, the ones the switches leave, and how many are open. */
export interface TodoDeck {
  list: DeckTodoList;
  /** What the switches leave to draw — `visibleTodos` over the whole tree. */
  visible: TodoItem[];
  /** Open to-dos across the whole list, at every depth. */
  open: number;
}

/** What {@link todoDecks} is asked. */
export interface TodoFilter {
  scope: TodoScope;
  deckIds: readonly number[];
  archived: boolean;
  showDone: boolean;
  nested: boolean;
}

/**
 * The decks in scope, read — and the ones among them with anything to draw.
 *
 * `inScope` is every deck the scope and the archived switch leave **that holds a to-do at all**;
 * `drawn` is those with something left once completed ones and sub-to-dos are hidden. The two are
 * kept apart because the card's empty sentences are about them: nothing in scope is
 * {@link NO_TODOS}, and nothing drawn over a non-empty scope is {@link ALL_DONE} when nothing in
 * scope is open and {@link NESTED_ONLY} when something is.
 *
 * **The archived switch holds in both scopes**, so it always means what its label says; the
 * checklist offers an archived deck only while it is on, and a choice made while it was on is
 * carried through rather than dropped — `DeckCompletionWidgetSettings`' rule for a deck the current
 * comparison cannot measure.
 */
export function todoDecks(
  lists: readonly DeckTodoList[],
  filter: TodoFilter,
): { inScope: TodoDeck[]; drawn: TodoDeck[] } {
  const chosen = new Set(filter.deckIds);
  const inScope: TodoDeck[] = [];
  for (const list of lists) {
    if (list.archived && !filter.archived) continue;
    if (filter.scope === "chosen" && !chosen.has(list.deckId)) continue;
    const items = parseTodos(list.body);
    if (items.length === 0) continue;
    inScope.push({
      list,
      visible: visibleTodos(items, { showDone: filter.showDone, nested: filter.nested }),
      open: countTodos(items).open,
    });
  }
  return { inScope, drawn: inScope.filter((deck) => deck.visible.length > 0) };
}

/**
 * The decks in the reader's order. `sortOptions` copies, so the cached array is never sorted in
 * place, and its collator — `Intl.Collator("en")`, this app's only string comparison for a list a
 * reader reads — settles every tie by name.
 */
export function sortTodoDecks(decks: readonly TodoDeck[], order: TodoOrder): TodoDeck[] {
  switch (order) {
    case "name":
      return sortOptions(decks, (deck) => deck.list.name);
    case "open":
      return sortOptions(
        decks,
        (deck) => deck.list.name,
        (deck) => [-deck.open],
      );
    case "edited":
      return sortOptions(
        decks,
        (deck) => deck.list.name,
        (deck) => [-deck.list.updatedAt],
      );
  }
}

/**
 * One drawn row: a deck's heading, or one to-do at a depth. A to-do's `lines` is its text's
 * estimated line count; `clamp` is set only on the to-do the cut landed on, and is the number of
 * lines it is drawn at.
 */
export type TodoRow =
  | { kind: "deck"; deck: TodoDeck }
  | {
      kind: "item";
      deck: TodoDeck;
      item: TodoItem;
      depth: number;
      lines: number;
      clamp?: number;
    };

/** A row's drawn height, in pixels — a to-do at `lines` lines. */
function rowPx(row: TodoRow, lines = row.kind === "item" ? row.lines : 1): number {
  return row.kind === "deck" ? LINE_PX : ROW_PAD_PX + lines * TEXT_LINE_PX;
}

/**
 * How many lines a to-do's text is guessed to take at this width: each hard-broken line on its own,
 * each at least one, by {@link CHAR_PX}. A guess and not a measurement — nothing here touches the
 * DOM — which is why it errs wide.
 */
export function linesOf(text: string, widthPx: number): number {
  const perLine = Math.max(1, Math.floor(widthPx / CHAR_PX));
  return text
    .split("\n")
    .reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / perLine)), 0);
}

/** The decks' rows in drawn order — each heading, then its to-dos depth first. */
export function todoRows(decks: readonly TodoDeck[], bodyWidthPx: number): TodoRow[] {
  const rows: TodoRow[] = [];
  const walk = (deck: TodoDeck, items: readonly TodoItem[], depth: number) => {
    for (const item of items) {
      const width = bodyWidthPx - depth * INDENT_PX - BOX_PX;
      rows.push({ kind: "item", deck, item, depth, lines: linesOf(item.text, width) });
      walk(deck, item.children, depth + 1);
    }
  };
  for (const deck of decks) {
    rows.push({ kind: "deck", deck });
    walk(deck, deck.visible, 0);
  }
  return rows;
}

/** How many of these rows are to-dos — what the footer counts. */
function itemCount(rows: readonly TodoRow[]): number {
  return rows.filter((row) => row.kind === "item").length;
}

/**
 * The rows `budget` pixels hold, in order, with `gap` between each: every row that fits whole,
 * then — if the row the cut lands on is a to-do with at least one line of room left — that to-do
 * clamped to those lines. A heading left last is dropped.
 */
function cutTo(
  rows: readonly TodoRow[],
  budget: number,
  gap: number,
): { shown: TodoRow[]; hidden: number } {
  const shown: TodoRow[] = [];
  let used = 0;
  for (const row of rows) {
    const before = shown.length === 0 ? 0 : gap;
    if (used + before + rowPx(row) <= budget) {
      shown.push(row);
      used += before + rowPx(row);
      continue;
    }
    if (row.kind === "item") {
      const room = Math.floor((budget - used - before - ROW_PAD_PX) / TEXT_LINE_PX);
      const clamp = Math.min(room, CLAMP_CLASSES.length);
      if (clamp >= 1) shown.push({ ...row, clamp });
    }
    break;
  }
  if (shown[shown.length - 1]?.kind === "deck") shown.pop();
  return { shown, hidden: itemCount(rows) - itemCount(shown) };
}

/**
 * The rows the box holds — and how many to-dos it had no room for.
 *
 * Cut against the body less `reserved` first; only when that leaves a to-do out is a footer line
 * reserved as well and the cut made again, so a card with nothing left over spends no room on a
 * footer it does not draw. `hidden` counts **to-dos**, never headings, since it is what the footer
 * says — and a clamped to-do is drawn, so it is not among them.
 */
export function cutRows(
  rows: readonly TodoRow[],
  fit: WidgetFit,
  reserved: number,
): { shown: TodoRow[]; hidden: number } {
  const budget = fit.bodyHeightPx - reserved;
  const whole = cutTo(rows, budget, fit.rowGap);
  if (whole.hidden === 0) return whole;
  return cutTo(rows, budget - footerLinePx(fit), fit.rowGap);
}

/** A to-do's checkbox name — the band's editor's words, so a reader driving by voice says one
 *  thing in both places. Whitespace is collapsed: a hard break is a line on screen, not in a name. */
export function tickLabel(item: TodoItem): string {
  const text = item.text.replace(/\s+/g, " ").trim() || "empty to-do";
  return `Mark "${text}" ${item.done ? "not done" : "done"}`;
}

/** The open count in words, as a heading carries it. */
function openWords(deck: TodoDeck): string {
  return `${count(deck.open)} open`;
}

/** One tick in flight: the deck, the body read, the body to write, and the line pressed. */
interface Tick {
  deckId: number;
  body: string;
  next: string;
  line: number;
}

export function DeckTodosWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const scope = todoScope(widget);
  const deckIds = pinnedDeckIds(widget);
  const order = orderOf(pickOf(widget, "order"));
  const filter: TodoFilter = {
    scope,
    deckIds,
    archived: toggleOnOf(widget, "archived"),
    showDone: toggleOnOf(widget, "done"),
    nested: toggleOnOf(widget, "nested"),
  };
  const counts = toggleOnOf(widget, "counts");

  const client = useQueryClient();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);

  const listsQuery = useQuery({ queryKey: deckTodoListsKey, queryFn: () => ipc.deckTodoLists() });

  /**
   * The tick. The success writes the new body into the cache before anything re-reads, so the
   * next tick's `expected` is the body this one wrote; `onSettled` returns the re-read, so the row
   * stays greyed until the list on screen is the one Rust holds — and a refusal's re-read is what
   * the reader ticks against next.
   */
  const tick = useMutation({
    mutationFn: ({ deckId, next, body }: Tick) => ipc.deckTodosSet(deckId, next, body),
    onSuccess: (_answer, { deckId, next }) => {
      client.setQueryData<DeckTodoList[]>(deckTodoListsKey, (lists) =>
        lists?.map((each) => (each.deckId === deckId ? { ...each, body: next } : each)),
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: TODOS_ROOT }),
  });

  if (listsQuery.error !== null) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load to-dos — {ipcError(listsQuery.error)}
      </WidgetMessage>
    );
  }
  if (listsQuery.data === undefined) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (scope === "chosen" && deckIds.length === 0) {
    return <WidgetMessage>{NOTHING_CHOSEN}</WidgetMessage>;
  }

  const { inScope, drawn } = todoDecks(listsQuery.data, filter);
  if (inScope.length === 0) return <NoTodos />;
  if (drawn.length === 0) {
    const open = inScope.some((deck) => deck.open > 0);
    return <WidgetMessage>{open ? NESTED_ONLY : ALL_DONE}</WidgetMessage>;
  }

  const failure = tick.error === null ? null : ipcError(tick.error);
  const rows = todoRows(sortTodoDecks(drawn, order), fit.bodyWidthPx);
  const { shown, hidden } = cutRows(rows, fit, failure === null ? 0 : footerLinePx(fit));

  /** Consecutive rows of one deck, so each deck is one list item with its heading at the top. */
  const groups: { deck: TodoDeck; items: Extract<TodoRow, { kind: "item" }>[] }[] = [];
  for (const row of shown) {
    if (row.kind === "deck") groups.push({ deck: row.deck, items: [] });
    else groups[groups.length - 1]?.items.push(row);
  }

  const busy = tick.isPending;
  const onTick = (deck: TodoDeck, item: TodoItem, next: string | null) => {
    if (busy || next === null) return;
    tick.mutate({ deckId: deck.list.deckId, body: deck.list.body, next, line: item.line });
  };

  /**
   * **`decks` is one view with two states**, told apart by `openDeckId` — and `setActiveView`
   * clears that id on the way in, so the view is written first (`DecksWidget.tsx:267-276`). The
   * band's disclosure goes before both, and is awaited, so the deck opens on it. `["decks"]` is
   * what every deck write invalidates, and it is what the deck editor's row read sits under.
   */
  const openDeck = async (list: DeckTodoList) => {
    if (!list.todosOpen) {
      try {
        await ipc.deckUpdate(list.deckId, { todosOpen: true });
        void client.invalidateQueries({ queryKey: ["decks"] });
      } catch {
        // Open the deck anyway: its To-do band is one press away there, and a heading that did
        // nothing would be a worse answer than a band still shut.
      }
    }
    setActiveView("decks");
    setOpenDeckId(list.deckId);
  };

  return (
    <>
      <ul
        aria-label="Decks"
        className="m-0 flex shrink-0 list-none flex-col p-0"
        style={{ gap: fit.rowGap }}
      >
        {groups.map(({ deck, items }) => (
          <li key={deck.list.deckId} className="flex flex-col" style={{ gap: fit.rowGap }}>
            <DeckHeading
              deck={deck}
              counts={counts}
              onOpen={still ? undefined : () => void openDeck(deck.list)}
            />
            <ul className="m-0 flex list-none flex-col p-0" style={{ gap: fit.rowGap }}>
              {items.map(({ item, depth, clamp }) => {
                const next = toggleTodo(deck.list.body, item.line);
                const pending =
                  busy &&
                  tick.variables?.deckId === deck.list.deckId &&
                  tick.variables.line === item.line;
                return (
                  <TodoLine
                    key={item.line}
                    item={item}
                    depth={depth}
                    clamp={clamp}
                    boxless={next === null}
                    refused={busy || next === null}
                    pending={pending}
                    onTick={still ? undefined : () => onTick(deck, item, next)}
                  />
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {failure !== null && <FailureLine sentence={failure} />}
      {hidden > 0 && (
        <WidgetFooterLine
          line={`+${count(hidden)} more`}
          said={`${plural(hidden, "more to-do")} not shown`}
        />
      )}
    </>
  );
}

/**
 * A deck's heading — `ActivityWidget`'s day heading, pressed: the name in the accent's display
 * face, a rule to the right edge, and the open count in mono at the end.
 *
 * `h4` under the card's own `h3`, so the card and its decks are one outline. **The name is spelled
 * once, as a label** on the heading and on the press inside it, because the three pieces are laid
 * out with a `gap` and a gap between two children joins them with no space at all (`Burn2 open`);
 * the drawn pieces are `aria-hidden`. The heading carries the label itself rather than taking it
 * from the press, so a still heading — which has no press — is named the same way. A still heading
 * is the same picture with no press in it.
 */
function DeckHeading({
  deck,
  counts,
  onOpen,
}: {
  deck: TodoDeck;
  counts: boolean;
  onOpen: (() => void) | undefined;
}): ReactElement {
  const said = counts ? `${deck.list.name} · ${openWords(deck)}` : deck.list.name;
  const inner = (
    <>
      <span
        aria-hidden="true"
        className="min-w-0 truncate font-heading text-sm leading-none text-accent"
      >
        {deck.list.name}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "h-px min-w-3 flex-1 bg-border group-hover:bg-accent/50",
          "transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none",
        )}
      />
      {counts && (
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-xs leading-none tabular-nums text-dim"
        >
          {openWords(deck)}
        </span>
      )}
    </>
  );
  const row = "flex h-full w-full min-w-0 items-center gap-2";
  return (
    <h4 aria-label={said} className="m-0 flex h-[27px] shrink-0 items-center">
      {onOpen === undefined ? (
        <span className={row}>{inner}</span>
      ) : (
        <button
          type="button"
          aria-label={said}
          onClick={onOpen}
          className={cn("group rounded-sm text-left", row, PRESS_SOFT, FOCUS)}
        >
          {inner}
        </button>
      )}
    </h4>
  );
}

/**
 * One to-do: its box and its text, pushed in {@link INDENT_PX} per level.
 *
 * **The whole row is the checkbox** — a `role="checkbox"` press named in the band's editor's words
 * ({@link tickLabel}), so the words are as easy to hit as the box. A link inside is therefore drawn
 * as a link and never followed: nothing pressable may sit inside a press, and the deck's band is
 * where a link is opened. `refused` is `aria-disabled` and blocks the press — a write already out,
 * or a line with no box to flip — and it neither dips under the press (`PRESS_SOFT`'s `:active`
 * scale, cancelled by `aria-disabled:active:scale-100`, `src/CLAUDE.md`'s spelling) nor warms its
 * box under the pointer. `boxless` is the second of those two, and is drawn as such: a dashed box,
 * so a line that can never be ticked does not look like one that can. `pending` is the row the
 * write in flight is about, and is the one drawn faint. `clamp` is set on the to-do the cut landed
 * on ({@link cutTo}), and draws its text at that many lines with an ellipsis.
 */
function TodoLine({
  item,
  depth,
  clamp,
  boxless,
  refused,
  pending,
  onTick,
}: {
  item: TodoItem;
  depth: number;
  clamp: number | undefined;
  boxless: boolean;
  refused: boolean;
  pending: boolean;
  onTick: (() => void) | undefined;
}): ReactElement {
  const inner = (
    <>
      <TickBox done={item.done} boxless={boxless} warms={onTick !== undefined && !refused} />
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-line break-words text-sm leading-[19px]",
          item.done ? "text-dim line-through" : "text-text",
          clamp !== undefined && CLAMP_CLASSES[clamp - 1],
        )}
      >
        <Inlines inlines={item.inlines} />
      </span>
    </>
  );
  const row = "flex w-full min-w-0 items-start gap-2 py-1 text-left";
  return (
    <li aria-level={depth + 1} className="flex shrink-0" style={{ paddingLeft: depth * INDENT_PX }}>
      {onTick === undefined ? (
        <div className={row}>{inner}</div>
      ) : (
        <button
          type="button"
          role="checkbox"
          aria-checked={item.done}
          aria-label={tickLabel(item)}
          aria-disabled={refused ? true : undefined}
          onClick={onTick}
          className={cn(
            "group rounded-sm",
            row,
            PRESS_SOFT,
            "aria-disabled:active:scale-100",
            FOCUS,
            refused && "cursor-default",
            pending && "opacity-50",
          )}
        >
          {inner}
        </button>
      )}
    </li>
  );
}

/** The drawn box: gold and ticked when done, a dim outline when not — which warms to the accent
 *  under the pointer only on a row a press would tick — and dashed on a line with no box to flip. */
function TickBox({
  done,
  boxless,
  warms,
}: {
  done: boolean;
  boxless: boolean;
  warms: boolean;
}): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-[2.5px] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
        done
          ? "border-accent bg-accent text-accent-fg"
          : cn("border-dim", boxless && "border-dashed", warms && "group-hover:border-accent"),
      )}
    >
      {done && <Check className="size-2.5" strokeWidth={3.5} />}
    </span>
  );
}

/**
 * A to-do's runs — the notes' five marks and a link, which is exactly the dialect `noteMarkdown.ts`
 * pins. Its own small copy rather than the notes band's, because a link here is drawn and never
 * pressed (see {@link TodoLine}). A hard break arrives as a `"\n"` inside a run and is drawn by the
 * `whitespace-pre-line` on the span around these.
 */
function Inlines({ inlines }: { inlines: readonly Inline[] }): ReactElement {
  return (
    <>
      {inlines.map((run, i) => {
        switch (run.kind) {
          case "strong":
            return (
              <strong key={i} className="font-semibold">
                {run.text}
              </strong>
            );
          case "em":
            return <em key={i}>{run.text}</em>;
          case "strike":
            return <s key={i}>{run.text}</s>;
          case "code":
            return (
              <code key={i} className="rounded bg-surface px-1 font-mono text-[0.95em]">
                {run.text}
              </code>
            );
          case "link":
            return (
              <span key={i} className="text-accent underline underline-offset-2">
                {run.text}
              </span>
            );
          case "text":
            return <span key={i}>{run.text}</span>;
        }
      })}
    </>
  );
}

/**
 * The one-line failure slot: a refused tick's own sentence. One line at any width, `truncate` like
 * `WidgetFooterLine`, with the whole sentence as a hint once it is cut; `role="alert"`, so the
 * refusal is spoken as it appears. The body reserves one footer line for it while it is drawn.
 */
function FailureLine({ sentence }: { sentence: string }): ReactElement {
  const tip = useTooltip();
  return (
    <p
      role="alert"
      {...tip(sentence, { whenClipped: true })}
      className="relative m-0 shrink-0 truncate text-xs text-destructive"
    >
      {sentence}
    </p>
  );
}

/** No deck in scope holds a to-do: the spec's two lines, the second dim. */
function NoTodos(): ReactElement {
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <p className="m-0 text-sm text-text">{NO_TODOS}</p>
      <p className="m-0 text-xs text-dim">{NO_TODOS_HINT}</p>
    </div>
  );
}

/**
 * This kind's own settings, under the rows the registry declares: the deck checklist behind
 * `Which decks → Chosen…` — `DeckCompletionWidgetSettings`' picker, writing the same
 * `{ deckIds, scope: "chosen" }` that {@link todoScope} and `pinnedDeckIds` read.
 *
 * **It offers every deck, archived ones only while `Include archived decks` is on**, since the
 * card draws no archived deck while it is off ({@link todoDecks}). A choice it does not offer is
 * **kept** in the stored set rather than dropped, and comes back ticked when the switch does. Every
 * deck rather than only those with a list: a reader may choose a deck before writing its first
 * to-do.
 *
 * **Drawn only while the scope is `Chosen…`**, with a sentence in its place otherwise — a picker
 * under `All decks` would be a control whose every press changes nothing on the card.
 */
export function DeckTodosWidgetSettings({ widget, onConfig }: WidgetSettingsProps): ReactElement {
  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const deckIds = pinnedDeckIds(widget);
  const archived = toggleOnOf(widget, "archived");
  const words = pickWords("scope", "chosen");

  if (todoScope(widget) !== "chosen") {
    return (
      <p className="m-0 text-xs text-dim">
        Choose {words.option} under {words.row} to pick the decks this widget tracks.
      </p>
    );
  }

  const eligible = (decksQuery.data ?? NO_DECK_ROWS).filter((deck) => archived || !deck.archived);
  const offered = new Set(eligible.map((deck) => deck.id));
  const ticked = deckIds.filter((id) => offered.has(id));
  /** Sorted by the deck's **name** rather than the row's label, so the `(archived)` suffix does
   *  not file a retired deck under A — `DecksWidgetSettings`' reason verbatim. */
  const options: DropdownOption[] = sortOptions(eligible, (deck) => deck.name).map((deck) => ({
    value: String(deck.id),
    label: deck.archived ? `${deck.name} (archived)` : deck.name,
    hint: deck.formatName ?? deck.formatKey,
  }));

  /** Add at the end, remove in place, and every id this list does not offer is carried through. */
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
        label="Decks to track"
        searchable={options.length > 8}
        searchLabel="Search decks"
        options={options}
        selected={ticked.map(String)}
        onToggle={toggle}
        triggerLabel={ticked.length === 0 ? "None chosen" : plural(ticked.length, "deck")}
      />
      {!decksQuery.isPending && options.length === 0 && !decksQuery.isError && (
        <p className="m-0 text-xs text-dim">No decks yet. Build a deck on the Decks page first.</p>
      )}
      {decksQuery.isError && (
        <p className="m-0 text-xs text-destructive">
          Couldn't load your decks — {ipcError(decksQuery.error)}
        </p>
      )}
    </div>
  );
}
