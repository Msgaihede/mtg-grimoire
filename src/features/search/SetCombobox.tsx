import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import { FOCUS } from "@/lib/focus";
import { ipc, type SetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { sortOptions } from "@/lib/options";
import { cn } from "@/lib/utils";
import { facetTitle, optionDisabled } from "./facets";

/**
 * Options rendered before the reader asks for more.
 *
 * There are ~1 050 sets and the list is filtered as the reader types, so anything past
 * the first screenful is scrolled past rather than read. Capping keeps the popup out of
 * the virtualiser's territory — a 1 050-row `<ul>` inside a dropdown is a jank source for
 * a control that is open for two seconds. The footer says when the cap is in force, so a
 * short list is never mistaken for the whole answer.
 *
 * **A first page and not a ceiling**: {@link MORE_STEP} reveals the next one, so the whole
 * list is reachable by both the mouse and the arrow keys. Typing is still the fast way
 * through 1 047 sets and the footer goes on saying so.
 */
const MAX_OPTIONS = 100;

/**
 * How many more rows one press of the footer's control reveals.
 *
 * Half a page rather than a whole one: a press is cheap and the reader is scanning, so the
 * cost of asking again is a smaller cost than a repaint that lands them somewhere they did
 * not recognise. The control is worded with the number it will *actually* add, which on the
 * last press is whatever is left rather than this.
 */
const MORE_STEP = 50;

/**
 * How many sets one search may name.
 *
 * Mirrors `MAX_SET_FILTER` in `src-tauri/src/filters.rs`, whose `picked_sets` truncates
 * past it — so
 * without a ceiling here the button would say "65 sets" while the backend filtered on 64,
 * and the results would quietly disagree with the control that produced them. The backend
 * keeps its truncation as the belt; this is the braces, and it is the only one the reader
 * can see.
 *
 * **It is a fact about the backend filter and not about this control**, which is why a caller
 * that supplies its own `options` is not held to it — see that prop on {@link SetCombobox}.
 */
const MAX_SETS = 64;

/** Exact code, then code prefix, then a name match. Lower sorts first. */
const rank = (code: string, needle: string): number =>
  code === needle ? 0 : code.startsWith(needle) ? 1 : 2;

/**
 * A searchable, multi-select set picker.
 *
 * **Everything that is not about sets belongs to `<MultiDropdown>`** — the disclosure button,
 * the panel and where it lands, the search box, the rows, the keyboard walk,
 * `aria-activedescendant`, and all three dismissals (Escape with the caret handed back, an
 * outside `mousedown`, focus leaving). That shell is hand-rolled rather than pulled from a
 * component library for the reason this control used to state itself: the shipped CSP is
 * `style-src 'self'`, and every overlay primitive in reach injects a runtime `<style>` element
 * the moment it opens — which passes `tauri dev` and breaks in a packaged build. Nothing here
 * is portalled and nothing is injected; `PopupPanel`'s own doc carries the rest of that record.
 *
 * What is left is the part that is about *sets*: which ones to offer, in what order, how many
 * at a time, which of them this search has anything in, and how many one search may name.
 */
export function SetCombobox({
  selected,
  onToggle,
  counts,
  options,
  align = "end",
  fill = false,
}: {
  selected: readonly string[];
  onToggle: (code: string) => void;
  /**
   * How many printings this search holds per set code, or `undefined` when that is not
   * known — in which case nothing is greyed, because not-greyed means "we don't know".
   *
   * **Greys, never hides.** The `cardCount > 0` filter below drops sets the corpus holds
   * nothing for at all, which is a fact about the database; this is a fact about the search
   * the reader is halfway through typing, and dropping those rows would make the list jump
   * under the cursor on every keystroke.
   */
  counts?: Record<string, number>;
  /**
   * The sets to offer, when the caller has a shorter list than "every set in the corpus".
   *
   * The two search-shaped callers leave this absent and get the session-cached `list_sets()`
   * below — ~1 050 rows, which is the right answer when the question is *which sets shall I
   * narrow the whole corpus to*. `AllPrintingsDialog` asks a different question: it holds one
   * card's printings in memory and wants the sets **that card** was printed in, which
   * `printingFilters.setOptions` has already counted off those very rows. Greying the other
   * thousand instead would be `counts`' rule applied where it does not fit — greying says
   * "empty in this search", and a set this card was never in is not empty, it is not part of
   * the question.
   *
   * Supplying it **turns the query off** rather than racing it, so a caller that has its own
   * list costs no `list_sets` at all; and it lifts {@link MAX_SETS}, which mirrors a *backend*
   * truncation that a caller filtering an in-memory list never reaches.
   */
  options?: readonly SetSummary[];
  /**
   * Which edge of the panel is pinned to the trigger — `AddToCollectionButton`'s prop, with the
   * same two values for the same reason, and this app's standing rule about an anchored popup:
   * it is pinned to, and grows from, the corner nearest its trigger's own edge.
   *
   * **A first guess rather than the last word**, since the panel became `<MultiDropdown>`'s:
   * `placeDropdown` measures the trigger against the window and overrules the guess when the
   * asked-for edge would put the panel past the far gutter. It is still a guess worth passing,
   * because the caller knows its own layout better than one measurement does.
   *
   * `"end"` is the default because both search-shaped callers put this control at the **right
   * end** of a wrapping filter row, where the panel was measured opening 174px past a 1280px
   * window from the static position — and nothing clips these popups, so the overflow scrolled
   * the whole app sideways the moment `scrollIntoView` ran. `AllPrintingsDialog` puts it second
   * in its row and passes `"start"`: there is nothing to the left of the trigger to open back
   * across, and a panel that opened leftwards from a control at the head of a row reads as
   * belonging to whatever it landed on.
   */
  align?: "start" | "end";
  /**
   * Stretch the trigger to its container and push the chevron to the far edge.
   *
   * For the filter **tray**, where this control is one cell of a grid beside a `<select>` and a
   * pair of buttons: a trigger sized to its own text would be the one field in that grid with a
   * ragged right edge, and the column it sits in would change width as the reader picked sets.
   * Every row-shaped caller leaves it off and keeps a control as wide as what it says.
   */
  fill?: boolean;
}) {
  const [query, setQuery] = useState("");
  /**
   * How many rows are drawn. Reset to {@link MAX_OPTIONS} on a new query and on each open —
   * on an open beside the `pinned` snapshot that is retaken for the same reason, rather than
   * from an effect that would have to work out which change it was reacting to. A new query is
   * a new list, and how deep the reader had paged into the old one means nothing in it.
   */
  const [shown, setShown] = useState(MAX_OPTIONS);
  /**
   * Which sets float to the top — **a snapshot taken when the popup opens, not `selected`.**
   *
   * The reason is the press itself. Ordering on the live `selected` would move a row to the
   * top of the list *because the reader just clicked it*, so the second set they wanted is no
   * longer under the cursor and the third click lands on whatever slid up — in a control whose
   * whole purpose is picking several sets in a row, and whose own rows already go to the
   * trouble of an `onMouseDown` preventDefault so the mouse cannot disturb the keyboard.
   *
   * Frozen for the length of one opening, it buys the thing the pinning was for — the sets
   * already ticked are visible and un-tickable rather than stranded past the end of the page —
   * without the list ever moving under a press. The other two levels cannot move a row on a
   * pick either: `facets::compute` skips the dimension it counts, so ticking a set does not
   * change a single set's count, and a rank is a fact about the typed needle.
   *
   * It also covers the case pinning exists for in reverse: un-ticking a set that this search
   * has nothing in would otherwise sink it out of the page mid-gesture, leaving no way back.
   */
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set(selected));

  // One call per session: the set list changes at most once a sync, and the picker has to
  // open instantly.
  const sets = useQuery({
    queryKey: ["sets"],
    queryFn: () => ipc.listSets(),
    // Off entirely when the caller brought its own list — not merely ignored. A disabled query
    // never runs its `queryFn`, so the printings modal makes no `list_sets` call at all, and the
    // shared `["sets"]` cache entry is neither seeded nor invalidated by a caller that has no use
    // for it. It stays `isPending` while disabled, which is why the empty line below asks about
    // `options` before it asks about the query.
    enabled: options === undefined,
    // Cached for good once it has answered with rows — but an empty answer is not an
    // answer. The first launch opens this picker while the opening sync is still writing
    // `sets`, and a `staleTime` of `Infinity` over that `[]` would leave the filter empty
    // for the rest of the session with no way to ask again.
    staleTime: (q) => (q.state.data?.length ? Infinity : 0),
  });

  /**
   * Everything that belongs to one *opening* rather than to the mount: how far the reader has
   * paged, and which sets are floated to the top. The cursor is the third such thing and is the
   * shell's own — `<MultiDropdown>` puts it on the first selected row it can find.
   *
   * Handed over as `onOpen`, and deliberately not an effect on the shell's `open`: the shell
   * calls this in the same batch as the state change that opens the panel, where an effect
   * would take the snapshot one commit after the first render of the list it is meant to order.
   *
   * Note what is *not* here: the query, which survives an opening on purpose so reopening the
   * picker shows the reader the list they left. That is also the one thing an `onOpen` may not
   * touch — the shell computes its opening row from the list drawn on the render *before* this
   * runs, so clearing the query here would open the panel on a row of a list it is about to
   * discard. (`setShown` is reset by `onQueryChange` for the separate reason that a new query is
   * a new list; `pinned` is not, because the sets already ticked are the same sets whatever has
   * been typed.)
   */
  const startOpening = useCallback(() => {
    setShown(MAX_OPTIONS);
    setPinned(new Set(selected));
  }, [selected]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // The caller's list when it brought one, the corpus otherwise — everything below this line
    // reads the same shape and cannot tell which it got.
    const found = (options ?? sets.data ?? [])
      // A set with no printings here can never match a search, so offering it is
      // offering an empty result. `sets` holds memorabilia and token-only sets that
      // `default_cards` carries nothing for, and Arena/MTGO sets whose every printing
      // the search's paper-only default hides again. A supplied list is held to the same
      // rule rather than exempted, and passes it for free: a caller counting its own rows
      // has no way to arrive at a zero.
      .filter((s) => s.cardCount > 0)
      // Name matches anywhere, code from the start: three letters inside a longer code
      // are a coincidence, three letters inside a set's name are usually what was meant.
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.code.startsWith(needle));
    // Three grouping levels, then the alphabet — `sortOptions` settles them in order and
    // `list_sets`'s own newest-first order survives none of it. That order is still the
    // right thing for the backend to answer; what the picker draws is a display decision.
    // The shell deliberately never sorts, so the order built here is the order drawn.
    //
    // **1 — picked first.** The list is paged, and a set the reader has already ticked must
    // never sit past the end of the page, where they can neither see it nor un-tick it.
    // It beats the facet level deliberately: a picked row is drawn at the top even if it
    // somehow greyed. (It cannot today — `optionDisabled`'s first rule is that a selected
    // option is never greyed — but the order is written so the two could not fight.)
    // Read off `pinned` and **not `selected`**, which is what keeps the list still under a
    // press; see that state's own doc for the gesture it protects.
    //
    // **2 — then what this search has printings for**, greyed rows sinking rather than
    // disappearing, for the same reason they are greyed and not filtered. The predicate is
    // `optionDisabled` and **not `canToggle`**: the two differ by the `MAX_SETS` cap, and
    // at the cap every unpicked row becomes untoggleable at once — so folding the cap in
    // here would re-sort the whole list the instant the 64th set is ticked. The cap is a
    // transient global state; the facet is a fact about this search, and only the fact gets
    // to decide an order.
    //
    // **3 — then the code rank**, which is why `rank` exists at all: typing a whole set code
    // is an unambiguous request for that set, and without this it is the one result you
    // cannot reach. "lea" is Limited Edition Alpha, but it also appears in six League Tokens
    // sets, nine Arena Leagues, Oversized League Prizes and M15 Pre**relea**se Challenge —
    // seventeen name matches, enough to push the exact one past the page end entirely.
    // Ranked rather than filtered, because the rest are still real matches and the reader
    // may have meant one of them. With nothing typed every row scores 0, so the level costs
    // nothing; it sits *below* the two above because a picked or available set the reader
    // can act on beats a spelling coincidence.
    //
    // **4 — then the set's name**, which `sortOptions` does. This is where the old stable
    // sort's "within each rank the backend's own order survives" stopped being true: the
    // alphabet decides now, so `lea` is followed by Arena League 1999 and not by whichever
    // League set shipped most recently.
    return sortOptions(
      found,
      (s) => s.name,
      (s) => [
        pinned.has(s.code) ? 0 : 1,
        optionDisabled(counts, s.code, selected.includes(s.code)) ? 1 : 0,
        needle ? rank(s.code, needle) : 0,
      ],
    );
  }, [options, sets.data, query, selected, counts, pinned]);

  /**
   * The rows actually drawn: {@link matches} cut to what the reader has asked to see.
   *
   * Named `page` and not `options`, which it was until the picker learnt to take a caller's list
   * — the two are different lists a line apart, and the ambiguity is worth naming away rather
   * than shadowing. `options` is the **source** a caller may supply; this is one page of what
   * survived the needle from whichever source was used.
   */
  const page = matches.slice(0, shown);
  /**
   * What the footer's control would add — the *honest* number, so the last press reads
   * "Show 7 more" rather than promising fifty rows that are not there.
   */
  const moreCount = Math.min(MORE_STEP, matches.length - page.length);
  // Counted from what is on screen rather than from `shown`, which can outrun the list when
  // the query narrows under a reader who has already paged down.
  const revealMore = () => setShown(page.length + MORE_STEP);

  const label =
    selected.length === 0 ? "Any set" : `${selected.length} set${selected.length === 1 ? "" : "s"}`;

  /**
   * The one sentence a listbox with no rows draws — three facts that look alike and are not.
   *
   * **`options` is asked about first, and that order is the whole of why this is a variable.** A
   * disabled query reports `isPending` forever, so a caller that brought its own list and typed a
   * needle nothing matches would have been told the sets were still *loading* — a sentence about
   * a request that will never be made, on the one branch where the list is already complete.
   * There is only ever one thing left to say there, because a supplied list cannot be pending and
   * cannot fail.
   */
  const emptyLine =
    options !== undefined || sets.isSuccess
      ? "No sets match that."
      : sets.isError
        ? "Could not read the set list — try Refresh data."
        : "Loading sets…";

  /**
   * At the ceiling, adding is off and removing is still on — the way out has to stay open.
   *
   * **Never at one when the caller supplied the list**, for {@link MAX_SETS}' own reason: the
   * ceiling exists because `filters.rs` truncates a *backend* set filter, and a caller narrowing
   * rows it already holds sends nothing there. Refusing its 65th tick would be a limit this app
   * invented, and the sentence below would explain it by naming a search that is not happening.
   */
  const full = options === undefined && selected.length >= MAX_SETS;
  /**
   * Why a row cannot be pressed — the cap, or nothing in this search to press it for.
   *
   * One predicate for both, because both the mouse and the Enter key have to hit the same
   * wall: a list that refuses the click and takes the keystroke is a list with two rules.
   * A picked row is live under either, which is the way out of both dead ends.
   */
  const canToggle = (code: string) =>
    (!full || selected.includes(code)) && !optionDisabled(counts, code, selected.includes(code));

  const footer = (
    <>
      {full && (
        <p className="pt-2 text-center text-[0.7rem] text-dim">
          {MAX_SETS} sets is the most one search can name — remove one to add another.
        </p>
      )}
      {moreCount > 0 && (
        <div className="pt-2 text-center text-[0.7rem] text-dim">
          {/* The advice stays first and unchanged: at 1 047 sets, paging to the end is
              reachable but it is not the intended path, and the button below is the
              escape for the search that cannot be narrowed rather than the fast way. */}
          <p>
            Showing {page.length} of {matches.length} — keep typing to narrow it down.
          </p>
          <button
            type="button"
            // Same reason as the rows above: a press here must not pull the caret out of the
            // search box, or the arrow keys stop working the moment the reader reaches for more
            // with the mouse. The shell's root only closes when focus leaves the root, and this
            // button is inside it — so Tabbing onto it is safe either way, and this is about the
            // mouse.
            onMouseDown={(e) => e.preventDefault()}
            onClick={revealMore}
            className={cn(
              FOCUS,
              // A quiet footer control, not a primary action: it wears the footer's own
              // size and colour and is told apart from the sentence by the underline.
              "mt-1 rounded-md px-1.5 py-0.5 underline underline-offset-2",
              "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            )}
          >
            Show {moreCount} more
          </button>
        </div>
      )}
    </>
  );

  const dropdownOptions = page.map((s) => ({
    value: s.code,
    label: s.name,
    hint: s.code.toUpperCase(),
    // keyrune covers 441 of ~1 050 sets and its own `.ss` rule draws a generic symbol for the
    // rest, so every row has a glyph and the code rides along as text for the ones where that
    // glyph is not the set's own.
    icon: <i className={cn(setGlyphClass(s.code), "w-4 shrink-0 text-center")} aria-hidden="true" />,
    // One predicate for both the mouse and the Enter key: a list that refuses the click and
    // takes the keystroke is a list with two rules. The cap and a facet zero look the same
    // because they mean the same.
    disabled: !canToggle(s.code),
    // The tooltip, and only the tooltip. Unlike the chips, this row's accessible name comes
    // from its own content — the set's name, its code and its tick — and an `aria-label`
    // carrying the count would replace all three with a sentence that has no code in it.
    title: facetTitle(s.name, counts?.[s.code]),
  }));

  return (
    <MultiDropdown
      // The trigger's *content* is the value ("2 sets"); its name has to come from somewhere
      // else, or assistive tech announces the value twice and never says which field it is.
      label="Set"
      triggerLabel={label}
      selected={selected}
      onToggle={onToggle}
      options={dropdownOptions}
      align={align}
      fill={fill}
      active={selected.length > 0}
      searchable
      searchPlaceholder="Name or code"
      // Not the shell's `"Search"` default and not a `"Search " + label` concat either: this box
      // searches sets, and the plural is the word a reader hears.
      searchLabel="Search sets"
      // Controlled, because the match is this control's own — name-contains, code-prefix and a
      // three-level rank — and the shell's substring test would silently re-cut a list that was
      // deliberately ordered.
      query={query}
      onQueryChange={(next) => {
        setQuery(next);
        // A new query is a new list, and neither the old cursor position nor how far the reader
        // had paged into the old one means anything in it. (The shell resets the cursor itself.)
        setShown(MAX_OPTIONS);
      }}
      emptyLine={emptyLine}
      // The bottom of a *page* is not the bottom of the list, so the arrow key that walked off
      // the end asks for the next one — the same bargain the footer's button strikes for the
      // mouse. Not because that button is out of reach (it is inside the shell's root, so Tab
      // does get there); it is that Tab is *also* how a reader leaves this control entirely, and
      // the arrow key they are already holding is the one that meant "more of this list".
      onReachEnd={revealMore}
      onOpen={startOpening}
      panelClassName="w-72"
      footer={footer}
    />
  );
}
