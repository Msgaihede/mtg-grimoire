import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { ManaText } from "@/components/ManaText";
import { PopupPanel } from "@/components/PopupListbox";
import { DEBOUNCE_MS } from "@/features/search/useCardSearch";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type CardSummary } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { clearFieldOnEscape, useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/**
 * The most suggestions the dropdown offers at once.
 *
 * Five, and the ceiling is the *reader's* rather than the backend's: this is a field in a
 * toolbar and the list is glanced at rather than read, so a list long enough to need a
 * scrollbar has already stopped being a shortcut. Browsing is what the docked search panel is
 * for, and this stays a shortcut over that wall rather than a second one.
 *
 * It is also why there is no `scrollIntoView` effect here and there is one in `SetCombobox`:
 * five rows are all visible at once, so the highlight can never move out of the box.
 */
export const MAX_SUGGESTIONS = 5;

/**
 * Module scope, so that the id an option carries and the id `aria-activedescendant` points at
 * are one spelling rather than two that happen to agree. `SetCombobox` learned this the same
 * way; a mismatch here is invisible to the eye and total to a screen reader, which simply
 * announces nothing.
 */
const optionId = (id: string, index: number) => `${id}-option-${index}`;

/**
 * The deck editor's quick add: a name, a list of what it could be, and the card it turns out
 * to be.
 *
 * **A combobox, and hand-rolled for the reason `SetCombobox` is** — the shipped CSP is
 * `style-src 'self'`, and every portalled overlay primitive injects a runtime `<style>` the
 * moment it opens, which passes `tauri dev` and breaks in a packaged build. This is a plain
 * absolutely-positioned listbox in the same stacking context as the field, so nothing is
 * injected and nothing is locked.
 *
 * **Three routes reach one write.** Enter on the highlighted suggestion, a click on any row,
 * and — inside the debounce window, before any suggestion exists — a one-shot `limit: 1`
 * search. The third is the field's original behaviour and the only one that survives a reader
 * who types a whole name and presses Enter faster than 300ms; losing it would have made the
 * feature a regression for exactly the readers who are fastest at it.
 *
 * The suggestions are **`collapse: true`**, i.e. the newest printing of each match — the same
 * printing the docked panel's wall offers first for the same query. This is a shortcut over
 * that wall, not a second way of choosing a printing: a reader who cares which one they get
 * has the panel open beside them.
 */
export function QuickAdd({
  targetName,
  onAdd,
}: {
  /**
   * What the pile the add lands in is called, or `null` under `AUTO_CATEGORY` — where there
   * is no one answer because the pile is per card. Names the field, exactly as it did when
   * this markup lived in `DeckEditor`.
   */
  targetName: string | null;
  /**
   * Put one copy of this card in the deck.
   *
   * The whole `CardSummary` rather than an id, because the auto arm files by `typeLine` and
   * the search has already answered it — which is the point of filing from a *found* card
   * rather than from a typed name.
   */
  onAdd: (card: CardSummary) => void;
}): ReactElement {
  const [text, setText] = useState("");
  /** {@link text} trimmed, {@link DEBOUNCE_MS} later — the same 300ms the three list views use. */
  const [debouncedText, setDebouncedText] = useState("");
  /** Which suggestion the keyboard is on. Focus stays in the field; this moves instead. */
  const [active, setActive] = useState(0);
  /** The text a settled search found nothing for, or `null`. */
  const [miss, setMiss] = useState<string | null>(null);
  /** Whether the reader has the list up. Closed by Escape, by blur, and by an add. */
  const [open, setOpen] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const listboxId = `${id}-listbox`;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const suggestions = useQuery({
    queryKey: ["quick-add", debouncedText],
    queryFn: () =>
      ipc.searchCards({ text: debouncedText, collapse: true, limit: MAX_SUGGESTIONS, offset: 0 }),
    enabled: debouncedText.length > 0,
    // So the list does not blink empty between keystrokes: a dropdown that empties and refills
    // on every letter is a dropdown whose rows move out from under the pointer.
    placeholderData: keepPreviousData,
  });

  // **No `marketplace`, in the request or in the key**, and that is a deliberate exception to
  // the app's rule that every price-bearing query carries it. These rows draw no price — a
  // name, a cost and a set code — so a currency switch has nothing to change about them, and
  // putting the marketplace in the key would refetch five names for nothing every time one
  // happened. The request below is the *same* search the fallback makes, differing only in
  // `limit`, which is what keeps the top suggestion and the fallback's one hit the same card.

  /**
   * The list on screen is an answer to what is in the field *now*.
   *
   * The debounce means it need not be: 300ms after `sol r` the field can say `sol ring` while
   * the rows still belong to `sol r`, and adding the top hit of a search the reader has already
   * moved past is a real bug rather than a theoretical one. Enter only picks a row while this
   * is true; otherwise it falls through to the one-shot search below, which asks about the text
   * that is actually there.
   */
  const fresh = debouncedText === text.trim() && !suggestions.isPlaceholderData;
  /**
   * The rows, and **nothing at all once the field is empty**.
   *
   * `keepPreviousData` is what makes that second clause necessary: clearing the field changes
   * the query key to `""`, which is a key this query is `enabled: false` for — so it never
   * fetches, never replaces the placeholder, and the last search's five rows would hang under
   * an empty box for the rest of the session. Read off `text` rather than off `debouncedText`
   * so they go the moment the field does, instead of 300ms later.
   */
  const options = text.trim().length > 0 ? (suggestions.data?.items ?? []) : [];
  /**
   * Clamped on read and never reset from an effect: the list shortens under the cursor whenever
   * a query narrows, and a stored index that outruns it would point `aria-activedescendant` at
   * an element that is not there any more.
   */
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  /** What `aria-expanded` says, and the only state in which this layer owns the Escape key. */
  const listOpen = open && options.length > 0;

  /** One place an add happens, whichever of the three routes reached it. */
  const commit = (card: CardSummary) => {
    setMiss(null);
    // Cleared on a hit and kept on a miss, because the two are different next actions: type
    // the next card, or correct this one. The caret stays here either way — a row's
    // `onMouseDown` refuses the focus a click would otherwise take — so the next name can be
    // typed without going back for the field.
    setText("");
    setOpen(false);
    onAdd(card);
  };

  /**
   * Enter's fallback, and the field's original behaviour whole.
   *
   * A reader who knows the name types it and presses Enter, often well inside the debounce
   * window — so at the moment of the press there is frequently no suggestion to take, and this
   * is what answers then. It is also what answers when the search really has no answer, which
   * is where {@link miss} comes from: a miss is said in words rather than swallowed.
   */
  const lookup = useMutation({
    mutationFn: (t: string) => ipc.searchCards({ text: t, collapse: true, limit: 1, offset: 0 }),
    onSuccess: (found, t) => {
      const card = found.items[0];
      if (!card) {
        setMiss(t);
        return;
      }
      commit(card);
    },
  });
  const failure = lookup.isError ? ipcError(lookup.error) : null;

  const submit = () => {
    const t = text.trim();
    // No `targetCategoryId === 0` guard, for the reason the old field had none: zero is
    // `AUTO_CATEGORY`, which is a perfectly good destination, and "the deck has not loaded yet"
    // is covered by this field only existing inside an open deck.
    if (!t) return;
    setMiss(null);
    const picked = fresh ? options[activeIndex] : undefined;
    if (picked) {
      commit(picked);
      return;
    }
    lookup.mutate(t);
  };

  /**
   * Escape closes the list and leaves the caret where it is.
   *
   * Unlike `SetCombobox` there is nothing to hand focus back to — the field is not unmounting,
   * and it is what the caret was in the whole time — so the hook's "give focus back to whatever
   * opened it" clause has nothing to do here.
   */
  const dismiss = useCallback(() => setOpen(false), []);
  /**
   * **Only while the list is actually up.** `enabled: listOpen` rather than `enabled: open` is
   * the whole of what keeps the app's Escape ladder working: with the caret in an empty quick
   * add, a press belongs to whatever layer is open over the desk — the card modal, or, with
   * nothing open, the editor's own `"navigation"` floor, which closes the deck. A capture-phase
   * listener here would consume it first and close nothing at all.
   * `DeckEditor.test.tsx` presses Escape from this very field and asserts the press reaches the
   * window.
   *
   * And it is one more `"inner"` peer on a screen that already carries several.
   * **No ordinal here on purpose**: `DeckEditor`'s `Layer` union is where that census is kept,
   * and a count copied into a second file is a count that rots in one of them. What matters is
   * that this one sits *outside* the union, so what keeps it apart is **focus, not structure** —
   * a layer in that union opened by pressing a button takes the focus out of this field on the
   * way up, and `onBlur` below closes this list with it.
   *
   * **The gap that argument used to leave has since been filled, and not by this file.** It ended
   * "a surface that ever opened *without* moving the caret would break that, and the answer then
   * is a depth in the hook rather than a second `"inner"`" — and both halves happened. The
   * editor's export dialog is opened from a category heading's right-click and has no button at
   * all; the hook grew the depth, keeping a stack of capture-phase registrations where only the
   * token on top acts. So peers are ordered now, and the sentence this paragraph used to open
   * with — that the hook orders exactly two rungs and peers are ordered by nothing — is false.
   * The focus half survives that surface anyway: `ContextMenu` focuses its own panel as it opens,
   * so a right-click has already left this field.
   */
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: listOpen });

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Before the guard below, and that order is the fallback: Enter has to work in a field with
    // nothing to pick from, which is every field for the first 300ms of typing.
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    /**
     * **Escape's second rung in this one field, and it is not a second registration.**
     *
     * The rung above owns the press while the list is up and consumes it in the **capture**
     * phase — so by the time this target-phase handler runs, `listOpen` is exactly the test for
     * "somebody nearer has already spent it". Guarding on the flag rather than on
     * `e.defaultPrevented` says which layer that was, and keeps the two branches from ever
     * double-firing on one press.
     *
     * With the list closed and text in the field, that text is what the press is for: without
     * this the `"navigation"` rung would take it and close the deck the reader was about to add
     * a card to. An empty field owns nothing and the press falls through — `clearFieldOnEscape`
     * is the guard, written once for every box in the app that shares this rule.
     *
     * **Above the `options.length` guard on purpose.** A field can hold a name with no
     * suggestions under it at all — the whole first 300ms of typing, and every miss — and those
     * are the presses this exists for.
     */
    if (!listOpen) clearFieldOnEscape(e, text, () => setText(""));
    // Nothing to move through, so the arrows keep their native meaning — Home and End really do
    // belong to the caret in a text field with no list under it.
    if (options.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Down on a list the reader put away with Escape brings it back rather than moving a
      // highlight they cannot see.
      if (!open) setOpen(true);
      else setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative flex items-center gap-1.5"
      // Tab out of the field and the list should not still be hanging over the deck with the
      // caret three controls further along. `onBlur` is React's `focusout`, so it catches the
      // input losing focus to anything at all; a `relatedTarget` inside this root is not
      // leaving. It is also what keeps this layer and the editor's six full-window surfaces
      // from ever being open together — see the Escape comment above.
      onBlur={(e) => {
        if (!rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <input
        type="text"
        role="combobox"
        // Named for where the card will land, and under `Auto` that is per card — so the name
        // says only what it can promise. "Quick add a card to Auto (by what it does)" would be a
        // control named after a setting rather than after what pressing it does.
        aria-label={targetName === null ? "Quick add a card" : `Quick add a card to ${targetName}`}
        aria-expanded={listOpen}
        aria-controls={listboxId}
        // The field keeps the caret and this moves instead, which is the whole of why the
        // dropdown is a listbox rather than a set of buttons: a reader typing a name must not
        // have to Tab into the answers to take one. Absent when there is nothing to point at —
        // a descendant id that resolves to no element announces nothing.
        aria-activedescendant={options.length > 0 ? optionId(id, activeIndex) : undefined}
        // The rows are the search's answer rather than a completion of what is being typed:
        // `list`, not `both`. Nothing is ever written into the field on the reader's behalf.
        aria-autocomplete="list"
        placeholder="Sol Ring…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // A new query is a new list, and the old cursor position means nothing in it.
          setActive(0);
          // Typing is how a list put away with Escape comes back: the reader has asked a new
          // question, so refusing to answer it would be a dismissal that outlived its press.
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          // 36px, the deck editor's one chrome height — see `CONTROL` in `DeckEditor.tsx`.
          // This field is the first control in that toolbar row and the only one drawn from
          // another file, so it is the one that drifts silently when the row's height moves.
          "h-9 w-52 rounded-md border border-border bg-bg px-2.5 text-[0.8125rem]",
          FOCUS,
        )}
      />

      <AnimatePresence>
        {listOpen && (
          <PopupPanel
            key="quick-add"
            className={cn(
              "absolute top-full left-0 mt-1 w-72 rounded-md border border-border bg-surface p-1 shadow-lg",
              // Over the deck's own groups and the stats aside, which are a layer down. Never a
              // hand-written z-index; see `layers.ts`.
              LAYER.popup,
              // **Pinned to the field's left edge**, and this is the one thing `popup` leaves to
              // whoever anchors it. `SetCombobox` needs `right-0` because it sits at the right
              // end of a wrapping filter row, where 288px of listbox opened past the window and
              // scrolled the whole app sideways; this control is at the *left* end of the
              // toolbar row, so that reason does not apply and the mirror of it would be wrong.
              // The corner it is pinned by is the corner it grows from, or the list reads as
              // unrelated to the field that produced it. Written out whole — Tailwind scans
              // source text, so an interpolated class emits no rule.
              "origin-top-left",
            )}
          >
            {/* No `max-height` and no scroller: {@link MAX_SUGGESTIONS} is five, which is
                shorter than any ceiling worth writing. */}
            <ul id={listboxId} role="listbox">
              {options.map((card, i) => (
                <li
                  key={card.id}
                  id={optionId(id, i)}
                  role="option"
                  aria-selected={i === activeIndex}
                  // Keeps the caret — and therefore the arrow keys and the next name — in the
                  // field while the reader takes a card with the mouse. Without it the click
                  // blurs the input, `onBlur` closes the list, and the press lands on nothing.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(card)}
                  // Both spellings of "the pointer moved over this row", because the mouse and
                  // the keyboard must not disagree about which row Enter would take: a reader
                  // who arrowed to the third row and then moved the pointer over the first has
                  // pointed at the first. React synthesises enter/leave from over/out and does
                  // not listen for `pointerenter` at all, so a move event is the honest one.
                  onPointerMove={() => setActive(i)}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text",
                    "transition-colors duration-150 motion-reduce:transition-none",
                    // The highlight is a *background*, not a colour on the name: the row already
                    // carries three weights of text and recolouring one of them would read as
                    // "this card is different" rather than as "Enter takes this one".
                    i === activeIndex && "bg-bg",
                  )}
                >
                  {/* The row's accessible name is its own content — the name, the cost's
                      `sr-only` tokens and the set code. An `aria-label` here would replace all
                      three with a sentence, and a bare one carrying just the card's name would
                      make this row indistinguishable from the docked panel's tile for the same
                      card, which is a real ambiguity: both are on screen at once. */}
                  <span className="min-w-0 flex-1 truncate">{card.name}</span>
                  {/* `ManaText` renders nothing for a blank cost, so a land costs no layout. */}
                  <ManaText source={card.manaCost} className="shrink-0" />
                  <span className="shrink-0 font-mono text-xs text-dim">
                    {card.setCode.toUpperCase()}
                  </span>
                </li>
              ))}
            </ul>
          </PopupPanel>
        )}
      </AnimatePresence>

      {/* One live region, mounted for as long as the toolbar is: a region that appears together
          with its text announces nothing, because there was no change to notice. */}
      <p role="status" className="min-w-0 text-[0.6875rem] text-dim">
        {failure
          ? `Could not search — ${failure}`
          : lookup.isPending
            ? "Looking…"
            : miss !== null
              ? `No card found for “${miss}”.`
              : ""}
      </p>
    </div>
  );
}
