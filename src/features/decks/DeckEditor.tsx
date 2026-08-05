import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  FILTER_CONTROL,
  FILTER_FOCUS,
  filterChipState,
  ToggleChip,
} from "@/components/FilterChips";
import { ipcError, type DeckCard, type DeckZone } from "@/lib/ipc";
import { PRICES_AS_OF } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { DeckSearchPanel, PANEL_WIDTH_PX } from "./DeckSearchPanel";
import { useDeck } from "./useDeck";
import { useFormatSpecs } from "./useFormatSpecs";
import { ZONE_LABEL, ZoneColumn, type GroupBy } from "./ZoneColumn";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The four zones that are columns. `maybe` is not one of them — it is the scratchpad, and it
 *  sits collapsed underneath. */
const COLUMNS: DeckZone[] = ["main", "side", "commander", "companion"];

/**
 * How wide each column wants to be, and how it gives way.
 *
 * The main deck takes two shares of whatever is spare because it holds sixty rows to the
 * others' fifteen, one and one. The bases are what the columns wrap at rather than what they
 * are: below about 40rem of content the row breaks and each column gets the width to itself,
 * which is how the editor stays readable at 1024px with the card pane docked beside it — and
 * why nothing here ever scrolls sideways.
 */
const ZONE_WIDTH: Record<DeckZone, string> = {
  main: "flex-[2_1_24rem]",
  side: "flex-[1_1_16rem]",
  commander: "flex-[1_1_16rem]",
  companion: "flex-[1_1_16rem]",
  maybe: "w-full",
};

/**
 * Narrowest the deck itself may be squeezed to, in px, before the docked search panel gives
 * way to its rail.
 *
 * The same rule the zone columns already follow — the narrowest thing yields first — one level
 * up. Three docked columns do not fit in a 1024px window: sidebar, padding, the card pane and
 * the panel come to 1044 before the deck gets a pixel, and the deck was measured at **2px**
 * before this existed, which reads as a rendering fault rather than as a squeeze.
 *
 * 208 rather than the 224 this was first drawn at, and the 16px is a *scrollbar*: the page's
 * own, which the arithmetic did not count. At 1280 with a card open the row measures **617**,
 * not the 632 on paper, so a 224 floor collapsed the panel at the app's default window size —
 * the common case, where a reader clicking a tile to read a card would have lost their search
 * to it. Verified in the running window at every width below.
 *
 * | window | card pane | row | deck | panel |
 * |---|---|---|---|---|
 * | 1024 | closed | 776 | 380 | open |
 * | 1024 | open | 361 | 313 | rail |
 * | 1280 | open | 617 | 221 | open |
 * | 1440 | open | 777 | 381 | open |
 *
 * 208 is also the sidebar's width, which is the app's own evidence that a column this wide is
 * still a column: a zone row at 208 keeps its stepper and truncates the card's name.
 */
const DECK_FLOOR = 208;

/** The `gap-3` between the deck and the panel, which the panel's width has to be counted with. */
const PANEL_GAP = 12;

/** The two ways a deck list can be read, and what each is called on the control. */
const GROUPINGS: { id: GroupBy; label: string }[] = [
  { id: "type", label: "Type" },
  { id: "manaValue", label: "Mana value" },
];

/** Which row's actions menu is open. One per editor: `useDismissOnEscape` orders exactly two
 *  rungs, so two open menus would both close on one press. */
type Menu = { zone: DeckZone; cardId: string } | null;

/**
 * One deck, open for editing.
 *
 * The Decks view in its second state rather than a screen of its own — `openDeckId` is the
 * whole of the navigation — and a **view**, not a dismissible layer: Escape closes the menu a
 * row has open and nothing else, and the way out is the back control. The card pane docked
 * beside it by `App` keeps working from in here, which is why a row's click is a store write
 * and nothing more.
 *
 * There is no Save. Every control writes through one of Task 4's commands and the list
 * redraws from what the database answered, which is what spec §7's "autosave drafts" honestly
 * means for a deck: the row *is* the draft.
 */
export function DeckEditor({ deckId }: { deckId: number }) {
  const deck = useDeck(deckId);
  const { specs, formatSpecFor } = useFormatSpecs();
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);

  const [groupBy, setGroupBy] = useState<GroupBy>("type");
  const [menu, setMenu] = useState<Menu>(null);
  const [showMaybe, setShowMaybe] = useState(false);
  /** Where the docked panel's adds land. Here rather than in the panel because it is a fact
   *  about the deck being edited, and the zones it may take are this editor's own. */
  const [targetZone, setTargetZone] = useState<DeckZone>("main");
  /** What is in the name field while it is being typed in, or `null` when the field is simply
   *  the deck's name (`QuantityStepper`'s draft, for its reason). */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  /**
   * The same draft, readable *now*.
   *
   * Enter commits and then blurs, and the blur handler commits again — in the same tick, with
   * `nameDraft` still holding the closure's value, which is one rename written twice. A ref is
   * cleared where it is read, so the second call has nothing to send.
   */
  const draftRef = useRef<string | null>(null);
  const typeName = useCallback((value: string) => {
    draftRef.current = value;
    setNameDraft(value);
  }, []);
  const dropDraft = useCallback(() => {
    draftRef.current = null;
    setNameDraft(null);
  }, []);

  const editorRef = useRef<HTMLElement>(null);
  /** The row the deck and the panel share, and the only width either of them can be judged
   *  against — the window's own is three layouts away from it. */
  const deskRef = useRef<HTMLDivElement>(null);
  const [deskWidth, setDeskWidth] = useState(0);
  /** Whatever opened the menu that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);
  /** One per drawn column, so a card that moves takes the caret to where it landed. */
  const zoneRefs = useRef<Partial<Record<DeckZone, HTMLElement | null>>>({});
  const tookFocus = useRef(false);

  const row = deck.deck;
  const spec = row ? formatSpecFor(row.formatKey) : null;
  const loading = deck.query.isPending;
  const readFailure = deck.query.isError ? ipcError(deck.query.error) : null;
  /** The read succeeded and answered nothing: another view deleted this deck. */
  const gone = !loading && !deck.query.isError && deck.query.data === null;

  /** The most recently *started* of a set of writes — which is the one whose refusal is still
   *  news. Ties go to the later entry, which only happens when none of them has ever run. */
  const newest = <T extends { submittedAt: number }>(of: T[]): T =>
    of.reduce((a, b) => (b.submittedAt >= a.submittedAt ? b : a));

  // The three writes the editor's **own banner** speaks for, newest first. The *latest* of them
  // owns it, not whichever is still holding an error: a refused move used to leave its sentence
  // up while the reader went on to rename the deck successfully (the collection table's
  // lesson). The docked panel's add is deliberately not here — it says so in the panel, beside
  // the button that was pressed, and two banners for one refusal would be worse than one in the
  // wrong place.
  const writes = [deck.setQuantity, deck.moveCard, deck.update];
  const lastWrite = newest(writes);
  const writeFailure = lastWrite.isError ? ipcError(lastWrite.error) : null;

  /**
   * Whether the write in flight is one the **open menu** started — the only thing that should
   * grey that menu out or hold it open through a blur.
   *
   * Scoped rather than "any write is running": a rename in the header, or a stepper on a row
   * three lines up, has nothing to do with this menu, and disabling its controls for the
   * duration would make one edit block another for no reason. Read off the mutations' own
   * `variables`, which are the slot each write named.
   */
  const menuBusy =
    menu !== null &&
    ((deck.moveCard.isPending && deck.moveCard.variables?.cardId === menu.cardId) ||
      (deck.update.isPending && deck.update.variables?.coverCardId === menu.cardId));

  const byZone = useMemo(() => {
    const map: Record<DeckZone, DeckCard[]> = {
      main: [],
      side: [],
      commander: [],
      companion: [],
      maybe: [],
    };
    for (const card of deck.cards) map[card.zone].push(card);
    return map;
  }, [deck.cards]);

  /**
   * The seeded rules drive the chrome: a Modern deck has no commander zone and a Commander
   * deck has no sideboard (`sideboard_max` is 0 for every singleton format).
   *
   * A zone that still holds cards is drawn whatever the format says. A re-format that hid the
   * commander zone would otherwise leave the copies in it invisible *and* unreachable — still
   * counted, with nothing on screen to say why. And with no spec at all — a format the seed no
   * longer carries, or the table still loading — everything is drawn: never hide a zone whose
   * rules are not in hand.
   */
  const columns = COLUMNS.filter((zone) => {
    if (zone === "main" || byZone[zone].length > 0 || spec === null) return true;
    if (zone === "side") return spec.sideboardMax !== 0;
    if (zone === "commander") return spec.requiresCommander;
    return spec.allowsCompanion;
  });
  /** Where a row can go, and where the search panel can put one. The scratchpad is always one
   *  of them — it is what it is for. */
  const moveTargets: DeckZone[] = [...columns, "maybe"];

  // A re-format can take the add target away — pick Sideboard on a Modern deck, switch it to
  // Commander, and the select is left holding a zone that is not on screen and not in its own
  // options. Reset during render, which is React's own answer to state that has to follow a
  // prop; `main` is in `columns` unconditionally, so it is always a zone this deck has.
  if (!moveTargets.includes(targetZone)) setTargetZone("main");

  // The caret comes here on the way in, once the deck's name is known so the region announces
  // which deck it is. The gallery's New deck button had the caret and unmounts the moment this
  // view takes over, and an element that disappears with focus on it drops it to `<body>`.
  useEffect(() => {
    if (tookFocus.current || loading) return;
    tookFocus.current = true;
    editorRef.current?.focus();
  }, [loading]);

  // How much width the deck and the panel have between them. A window resize changes it, and
  // so does the card pane opening and closing beside the whole view — neither of which this
  // component would otherwise hear about, which is why it is an observer and not a prop
  // (`CardGrid`'s arrangement, for its reason). Re-run when the deck lands, because the element
  // being measured does not exist until then.
  const hasRow = row !== null;
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setDeskWidth(entry.contentRect.width));
    observer.observe(el);
    setDeskWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [hasRow]);

  /**
   * Whether the panel may draw itself open, or has to fall back to its rail.
   *
   * `0` is "not measured yet" and reads as room: the first paint of a wide window should not
   * flash a rail, and the observer answers on the same frame.
   */
  const roomForPanel = deskWidth === 0 || deskWidth - (PANEL_WIDTH_PX + PANEL_GAP) >= DECK_FLOOR;

  // A refused write re-reads the deck, and the read is what decides what happened: every write
  // goes through `touch_deck`, which answers "That deck is not there any more" when the deck
  // has been deleted under the reader — so the same refusal is either a busy database (the
  // banner says so, the deck stays) or a deck that is gone (the read answers null and the
  // editor says so). Keyed on `submittedAt` so each new failure re-reads exactly once.
  //
  // **All four writes, banner or no banner.** `add_card` calls `touch_deck` like the rest, so a
  // press in the docked panel answers the same sentence — and without it here the panel would
  // report a deck that is gone while the zone columns beside it went on painting it, with every
  // further press failing the same way and nothing on screen explaining why.
  const refetch = deck.query.refetch;
  const lastOfAny = newest([...writes, deck.addCard]);
  const failedAt = lastOfAny.isError ? lastOfAny.submittedAt : 0;
  useEffect(() => {
    if (failedAt) void refetch();
  }, [failedAt, refetch]);

  // Focus first, then close: the trigger is still mounted at this point. This is the
  // **keyboard** way out; the click-away way out is `closeMenu` and hands nothing back,
  // because the reader who clicked elsewhere is already somewhere else.
  const dismissMenu = useCallback(() => {
    openerRef.current?.focus();
    setMenu(null);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismissOnEscape({ layer: "inner", onDismiss: dismissMenu, enabled: menu !== null });

  // A deck deleted under an open menu takes the menu's row with it — but not the state that
  // says one is open, and an `"inner"` layer nothing draws is a layer that eats the first
  // Escape of whatever the reader does next. Reset during render, which is React's own answer
  // to state that has to follow a prop (`CardDetailPane`'s face, `Cover`'s art).
  if (gone && menu !== null) setMenu(null);

  const openMenu = useCallback((card: DeckCard, trigger: HTMLButtonElement) => {
    openerRef.current = trigger;
    setMenu((open) =>
      open?.cardId === card.cardId && open.zone === card.zone
        ? null
        : { zone: card.zone, cardId: card.cardId },
    );
  }, []);

  const setQuantity = useCallback(
    (card: DeckCard, quantity: number) => {
      // Zero takes the row out from under the caret — optimistically, so it happens on the
      // press — and the control the caret was on goes with it. The zone it left is where the
      // reader is looking and it announces its new count, which is the same hand-off a move
      // makes. Before the write, because the row is gone by the time an answer arrives.
      if (quantity === 0) (zoneRefs.current[card.zone] ?? editorRef.current)?.focus();
      deck.setQuantity.mutate({ cardId: card.cardId, zone: card.zone, quantity });
    },
    [deck.setQuantity],
  );

  const move = useCallback(
    (card: DeckCard, to: DeckZone) => {
      // Somewhere to look: the scratchpad is shut by default, and a card moved into a closed
      // drawer is a card that has vanished.
      if (to === "maybe") setShowMaybe(true);
      deck.moveCard.mutate(
        { cardId: card.cardId, from: card.zone, to },
        {
          onSuccess: () => {
            // The row this menu belongs to is about to leave the column, so the caret goes to
            // where the card landed — which announces the zone and its new count. The editor
            // itself is the fallback for a zone that is not on screen (the scratchpad, on the
            // render before it opens).
            (zoneRefs.current[to] ?? editorRef.current)?.focus();
            setMenu(null);
          },
        },
      );
    },
    [deck.moveCard],
  );

  /** Somewhere to look, exactly as a move into the scratchpad arranges: the pile is shut by
   *  default, and a card added into a closed drawer is a card that has vanished. */
  const pickTargetZone = useCallback((zone: DeckZone) => {
    if (zone === "maybe") setShowMaybe(true);
    setTargetZone(zone);
  }, []);

  const setCover = useCallback(
    (card: DeckCard) => {
      deck.update.mutate(
        { coverCardId: card.cardId },
        {
          onSuccess: () => {
            openerRef.current?.focus();
            setMenu(null);
          },
        },
      );
    },
    [deck.update],
  );

  /** Whatever is half-typed, the field goes back to standing for the deck's name. A blank is
   *  not a rename: the backend refuses it in words, and a name is not something a deck can
   *  lose by tabbing through it. */
  const commitName = useCallback(() => {
    const draft = draftRef.current;
    dropDraft();
    if (draft === null || row === null) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === row.name) return;
    deck.update.mutate({ name: trimmed });
  }, [deck.update, dropDraft, row]);

  /** The picker, plus the deck's own format when the seed no longer offers it — a select that
   *  cannot show its own value would silently re-format the deck on the first other change. */
  const formats = useMemo(() => {
    const picker = specs
      .filter((s) => s.enabledInPicker)
      .map((s) => ({ key: s.key, name: s.displayName }));
    if (!row || picker.some((f) => f.key === row.formatKey)) return picker;
    return [{ key: row.formatKey, name: row.formatName ?? row.formatKey }, ...picker];
  }, [specs, row]);

  return (
    <section
      ref={editorRef}
      tabIndex={-1}
      aria-label={row ? `Deck editor: ${row.name}` : "Deck editor"}
      className={cn("flex h-full min-h-0 flex-col gap-3", FOCUS)}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => setOpenDeckId(null)}
          aria-label="Back to decks"
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Decks
        </button>

        {row && (
          <>
            {/* The document's heading for this state of the view. Drawn as the field beside it
                rather than twice — the ribbon's `h1` says "Decks", and this says which one. */}
            <h2 className="sr-only">{row.name}</h2>
            <input
              aria-label="Deck name"
              value={nameDraft ?? row.name}
              onChange={(e) => typeName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitName();
                  e.currentTarget.blur();
                }
                // **Only when there is something to revert.** Escape consumed here is Escape
                // the card pane never sees — the pane is an `"outer"` layer listening on
                // `window` in the bubble phase, and a handler at the event's own target has
                // already run by then. A field nobody has typed in has nothing to undo, so the
                // press belongs to whatever is open behind it; a field that has been typed in
                // owns exactly one press, and the next one is the pane's again.
                // The ref rather than the state, for the reason it exists: two presses inside
                // one tick — a key held down, an autorepeat — both read a `nameDraft` that
                // React has not re-rendered yet, and the second would consume a press it has
                // nothing to spend it on. The ref is cleared where it is read.
                if (e.key === "Escape" && draftRef.current !== null) {
                  e.preventDefault();
                  dropDraft();
                }
              }}
              // Geist, not the display face, for the reason the card pane gives about a card's
              // name: this is *content*, and Cinzel is for view titles and hero copy. Cinzel is
              // also drawn in caps — which in a field you type into means the letters never
              // match the ones being typed.
              // The shared focus recipe, like every other control in the app: an outline says
              // focus, a border or a ring says state. The border here is the hover affordance
              // that says the title is a field at all.
              className={cn(
                "min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1",
                "text-xl font-medium leading-tight",
                "transition-colors duration-150 hover:border-border motion-reduce:transition-none",
                FOCUS,
              )}
            />
          </>
        )}
      </div>

      {row && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            // "Deck format", not "Format": the docked search panel offers a format *filter*
            // of its own, and two controls called Format in one view are two controls a
            // screen reader — and a test — cannot tell apart. Named like the field beside it
            // ("Deck name"), which is what it belongs to.
            aria-label="Deck format"
            value={row.formatKey}
            onChange={(e) => deck.update.mutate({ formatKey: e.target.value })}
            disabled={formats.length === 0}
            className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
          >
            {formats.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}
              </option>
            ))}
          </select>

          {/* The one switch with a consequence outside this deck, so it says what it does: a
              built deck's claims come off what every other deck can reach. */}
          <ToggleChip
            label="Built"
            pressed={row.isBuilt}
            hint="Reserves your copies for this deck"
            onClick={() => deck.update.mutate({ isBuilt: !row.isBuilt })}
          />

          <div role="group" aria-label="Group cards by" className="ml-auto flex gap-1">
            {GROUPINGS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setGroupBy(id)}
                aria-pressed={groupBy === id}
                className={cn(
                  FILTER_CONTROL,
                  FILTER_FOCUS,
                  "px-3",
                  filterChipState(groupBy === id),
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Task 15's seam: the live stats strip (curve, pips, price, owned-vs-missing) and the
          validation chip mount here, over the same `deck.cards` and `spec` this editor already
          holds — one query, so a curve and a legality panel can never disagree. Nothing in this
          task computes either. */}

      {writeFailure && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          Could not change this deck — {writeFailure}
        </p>
      )}

      {loading && (
        <p role="status" className="py-16 text-center text-sm text-dim">
          Opening your deck…
        </p>
      )}

      {readFailure && (
        <p role="alert" className="py-16 text-center text-sm text-destructive">
          Could not open this deck — {readFailure}
        </p>
      )}

      {gone && (
        <p className="mx-auto max-w-prose py-16 text-center text-sm text-dim">
          This deck is not there any more. It may have been deleted from the gallery — go back and
          pick another one.
        </p>
      )}

      {row && (
        // The deck on the left, the way cards get into it on the right (spec §7). One flex
        // row, so the panel is the full height of the editor and the zones keep whatever is
        // left — and `min-w-0` on the deck side, because a wrapping row of columns that
        // cannot shrink is the horizontal scrollbar the 1024px floor forbids.
        //
        // This element is also what `DECK_FLOOR` is measured against: it is the width the two
        // of them actually have, after the sidebar, the page padding and the card pane have
        // taken theirs.
        <div ref={deskRef} className="flex min-h-0 flex-1 gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex min-h-0 flex-1 flex-wrap gap-3 overflow-y-auto">
              {columns.map((zone) => (
                <ZoneColumn
                  key={zone}
                  ref={(el) => {
                    zoneRefs.current[zone] = el;
                  }}
                  zone={zone}
                  title={ZONE_LABEL[zone]}
                  cards={byZone[zone]}
                  // The compact zones hold one card or two, and a "Creature 1" heading over a
                  // single commander is a heading that says nothing.
                  groupBy={zone === "main" || zone === "side" ? groupBy : null}
                  moveTargets={moveTargets}
                  openMenuCardId={menu?.zone === zone ? menu.cardId : null}
                  busy={menuBusy}
                  onOpenMenu={openMenu}
                  onCloseMenu={closeMenu}
                  onSetQuantity={setQuantity}
                  onMove={move}
                  onSetCover={setCover}
                  onSelect={setSelectedCardId}
                  // `max-h-full` is what makes a column scroll rather than the editor: in a
                  // *wrapping* flex row, `align-items: stretch` stretches an item to its line's
                  // cross size — which is the tallest item's content — and never to the
                  // container. Without the cap, a 60-card main deck makes the whole zone row as
                  // tall as itself and takes the sideboard off the bottom of the window with it.
                  className={cn("min-h-48 max-h-full", ZONE_WIDTH[zone])}
                />
              ))}
            </div>

            {/* The scratchpad, under the deck rather than beside it: cards go here to be
                thought about, they count toward nothing, and Task 15's stats and validation
                never read them. Shut by default for the same reason. */}
            <div className="shrink-0">
              <button
                type="button"
                aria-expanded={showMaybe}
                onClick={() => setShowMaybe((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md text-xs text-dim",
                  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                  FOCUS,
                )}
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                    showMaybe && "rotate-90",
                  )}
                  aria-hidden="true"
                />
                {ZONE_LABEL.maybe}{" "}
                <span className="font-mono tabular-nums">{byZone.maybe.length}</span>
              </button>
              {showMaybe && (
                <ZoneColumn
                  ref={(el) => {
                    zoneRefs.current.maybe = el;
                  }}
                  zone="maybe"
                  title={ZONE_LABEL.maybe}
                  cards={byZone.maybe}
                  groupBy={groupBy}
                  moveTargets={moveTargets}
                  openMenuCardId={menu?.zone === "maybe" ? menu.cardId : null}
                  busy={menuBusy}
                  onOpenMenu={openMenu}
                  onCloseMenu={closeMenu}
                  onSetQuantity={setQuantity}
                  onMove={move}
                  onSetCover={setCover}
                  onSelect={setSelectedCardId}
                  className={cn("mt-2 max-h-64", ZONE_WIDTH.maybe)}
                />
              )}
            </div>
          </div>

          <DeckSearchPanel
            add={deck.addCard}
            zones={moveTargets}
            targetZone={targetZone}
            onTargetZoneChange={pickTargetZone}
            roomy={roomForPanel}
          />
        </div>
      )}

      {/* Spec §5: a price is never shown without saying how old it is. Once, under the deck,
          rather than as a tooltip on every one of sixty rows. */}
      <p className="shrink-0 text-[0.7rem] text-dim">{PRICES_AS_OF}</p>
    </section>
  );
}
