import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Archive, ArchiveRestore, ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { ART_ASPECT, cardImageUrl, imageRetryDelayMs, IMAGE_RETRY_LIMIT } from "@/lib/images";
import { ipcError, type DeckRow } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { useDecks, type Decks } from "./useDecks";
import { useFormatSpecs } from "./useFormatSpecs";

/**
 * Keyboard focus, in the shape the rest of the app uses: a gold outline standing off the
 * control's edge, never a ring (a ring means "state" everywhere else).
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * The wall.
 *
 * `auto-fill`, not `auto-fit`: with two decks in the gallery `auto-fit` collapses the empty
 * tracks and stretches those two across the whole window, which blows a 626 px art crop up to
 * half a screen. `auto-fill` keeps a tile a tile.
 */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4";

/** Every icon control on a tile, so three of them are one row rather than three sizes. */
const ICON_BUTTON = cn(
  "grid size-6 place-items-center rounded-md text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/**
 * What a new deck's format is until the reader says otherwise — `decks.format_key`'s own DDL
 * default and `deck::DEFAULT_FORMAT`, spelled here because the picker has to *select*
 * something before the seeded table has answered.
 *
 * Casual rather than the first row of the list: Casual caps nothing and is judged against no
 * card pool, so a deck that has not been given a format yet is not a deck full of complaints.
 */
const DEFAULT_FORMAT = "casual";

/**
 * Scryfall's image policy (spec §5/§10), which is why it is not conditional on there being
 * any art on screen: the credit belongs to the interface that shows card images, and this
 * gallery is one whether or not a deck has picked a cover yet.
 */
const CREDIT = "Card images © Wizards of the Coast · Data © Scryfall";

/**
 * The one dismissible layer this view can have open, and there is deliberately only ever one.
 *
 * `useDismissOnEscape` orders exactly two rungs — one capture-phase `"inner"` layer and one
 * bubble-phase `"outer"` one — so two `"inner"` peers open at once are not ordered at all and
 * would both close on a single press. Modelling the create form and the delete question as
 * *one* piece of state is what makes "never two" structural rather than remembered.
 */
type Panel = { kind: "create" } | { kind: "confirm"; deckId: number } | null;

/**
 * The decks, as a wall of the art they were built around.
 *
 * The gallery's whole story is the covers, so there is no summary strip above them and no
 * colour anywhere that is not a card's own: a deck is picked by looking at it. The chrome is
 * one caption, one credit and — on the tile the mouse or the caret is on — three small
 * controls.
 */
export function DecksPage() {
  const decks = useDecks();
  const { query } = decks;
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const returnToDeckId = useAppStore((s) => s.returnToDeckId);
  const clearReturnToDeck = useAppStore((s) => s.clearReturnToDeck);
  const [panel, setPanel] = useState<Panel>(null);
  const [showArchived, setShowArchived] = useState(false);
  const newDeckRef = useRef<HTMLButtonElement>(null);
  const wallRef = useRef<HTMLElement>(null);
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);

  // Coming back from an editor: the caret goes to the tile of the deck that was open. The
  // tile is not there to be focused until the wall has loaded, which is why this waits for the
  // query rather than running on mount — and why it clears the note either way once the answer
  // is in, so a deck deleted from inside its own editor does not leave one pending forever.
  useEffect(() => {
    if (returnToDeckId === null || query.isPending) return;
    wallRef.current
      ?.querySelector<HTMLButtonElement>(`[data-deck-id="${returnToDeckId}"]`)
      ?.focus();
    clearReturnToDeck();
  }, [returnToDeckId, query.isPending, decks.decks, clearReturnToDeck]);

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab
  // restarts from the top of the app.
  //
  // This is the **keyboard** way out — Escape, and the panels' own Cancel controls. The
  // click-away way out is `close` below and is a different function on purpose: CLAUDE.md's
  // rule is that an outside click does *not* hand the caret back, because the reader is
  // already somewhere else, and one function wired to both paths breaks it in two visible
  // ways (a Tab forward out of Cancel bounces backwards, and a control that disables itself
  // mid-write blurs into a hand-back nobody asked for).
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setPanel(null);
  }, []);

  /** The click-away way out: the layer goes, the caret stays where the reader put it. */
  const close = useCallback(() => setPanel(null), []);

  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: panel !== null });

  const openCreate = useCallback(() => {
    // A refusal from the last attempt is not news about this one.
    decks.create.reset();
    openerRef.current = newDeckRef.current;
    setPanel({ kind: "create" });
  }, [decks.create]);

  const askDelete = useCallback((deck: DeckRow, opener: HTMLButtonElement) => {
    openerRef.current = opener;
    setPanel({ kind: "confirm", deckId: deck.id });
  }, []);

  const confirmDelete = useCallback(
    (deck: DeckRow) => {
      decks.remove.mutate(deck.id, {
        onSuccess: () => {
          // The tile the caret was on is about to leave with the deck, so the hand-back goes
          // to the one control that is certainly still there.
          openerRef.current = null;
          setPanel(null);
          newDeckRef.current?.focus();
        },
      });
    },
    [decks.remove],
  );

  const onCreated = useCallback(
    (deck: DeckRow) => {
      // Nobody makes a deck in order to look at a tile of it.
      setOpenDeckId(deck.id);
      dismiss();
    },
    [dismiss, setOpenDeckId],
  );

  const live = useMemo(() => decks.decks.filter((d) => !d.archived), [decks.decks]);
  const archived = useMemo(() => decks.decks.filter((d) => d.archived), [decks.decks]);

  const failure = query.isError ? ipcError(query.error) : null;
  const status = query.isPending ? "Reading your decks…" : failure;
  // The *latest* of the three, not whichever is still holding an error: a refused archive
  // used to leave its banner up while the reader went on to duplicate something successfully,
  // which is an alert about a thing already dealt with (the collection table's lesson).
  const writes = [decks.update, decks.remove, decks.duplicate];
  const lastWrite = writes.reduce((a, b) => (b.submittedAt >= a.submittedAt ? b : a));
  const writeFailure = lastWrite.isError ? ipcError(lastWrite.error) : null;

  return (
    <section ref={wallRef} className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second "Decks" under it
          would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Decks</h2>

      <div className="flex items-center gap-3">
        <NewDeck
          buttonRef={newDeckRef}
          open={panel?.kind === "create"}
          onOpen={openCreate}
          onDismiss={dismiss}
          onClose={close}
          create={decks.create}
          onCreated={onCreated}
        />
      </div>

      {writeFailure && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          Could not change your decks — {writeFailure}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {/* Mounted for the life of the view and swapped into: a live region that appears
            together with its own text announces nothing, because there was no change for a
            screen reader to notice. */}
        <p
          role="status"
          className={cn(
            status && "py-16 text-center text-sm",
            failure ? "text-destructive" : "text-dim",
          )}
        >
          {status}
        </p>

        {!status && decks.decks.length === 0 && (
          <p className="mx-auto max-w-prose py-16 text-center text-sm text-dim">
            A deck is a list you build for a format. Start one and the app checks it as you go —
            deck size, copy limits, the commander's colours — and tells you which of the cards you
            already own.
          </p>
        )}

        {live.length > 0 && (
          // Named, the way the search's wall of art is (`CardGrid`'s `role="group"` +
          // `aria-label`) — but left a list rather than made a group, because these tiles are
          // countable and a list says how many there are on the way in.
          <ul aria-label="Your decks" className={GRID}>
            {live.map((deck) => (
              <DeckTile
                key={deck.id}
                deck={deck}
                decks={decks}
                confirming={panel?.kind === "confirm" && panel.deckId === deck.id}
                onOpen={setOpenDeckId}
                onAskDelete={askDelete}
                onConfirmDelete={confirmDelete}
                onCancelDelete={dismiss}
                onCloseDelete={close}
              />
            ))}
          </ul>
        )}

        {!status && live.length === 0 && archived.length > 0 && (
          <p className="py-8 text-center text-sm text-dim">
            Nothing here — every deck you have is filed away below.
          </p>
        )}

        {archived.length > 0 && (
          <div className={cn(live.length > 0 && "mt-8 border-t border-border pt-4")}>
            {/* A disclosure rather than a second wall: filed decks are kept, not shown. */}
            <button
              type="button"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md text-xs text-dim",
                "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                FOCUS,
              )}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                  showArchived && "rotate-90",
                )}
                aria-hidden="true"
              />
              Archived <span className="font-mono tabular-nums">{archived.length}</span>
            </button>
            {showArchived && (
              <ul aria-label="Archived decks" className={cn(GRID, "mt-3")}>
                {archived.map((deck) => (
                  <DeckTile
                    key={deck.id}
                    deck={deck}
                    decks={decks}
                    confirming={panel?.kind === "confirm" && panel.deckId === deck.id}
                    onOpen={setOpenDeckId}
                    onAskDelete={askDelete}
                    onConfirmDelete={confirmDelete}
                    onCancelDelete={dismiss}
                    onCloseDelete={close}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <p className="text-[0.7rem] text-dim">{CREDIT}</p>
    </section>
  );
}

/**
 * One deck: its cover art, its name, what it is and how big it is.
 *
 * The art is the tile — an `art` crop rather than a card image, because a wall of full cards
 * is what the *search* looks like and a deck is not a card. The price of the crop is the
 * credit line under it: an art crop carries no printed frame, so the illustrator is named
 * wherever one is shown.
 */
function DeckTile({
  deck,
  decks,
  confirming,
  onOpen,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
  onCloseDelete,
}: {
  deck: DeckRow;
  decks: Decks;
  confirming: boolean;
  onOpen: (id: number) => void;
  onAskDelete: (deck: DeckRow, opener: HTMLButtonElement) => void;
  onConfirmDelete: (deck: DeckRow) => void;
  /** Cancel: a control *in* the layer, so the caret goes back to what opened it. */
  onCancelDelete: () => void;
  /** Clicked or tabbed away: the layer goes and the caret stays where it went. */
  onCloseDelete: () => void;
}) {
  /** One derivation of the plural, for the caption and the question that quotes it. */
  const unit = deck.cardCount === 1 ? "card" : "cards";
  return (
    <li className="group relative">
      {/* The art and the caption are one button — a deck is picked by looking at it, and a
          reader who aims at the name should not miss. The controls below are siblings of it
          rather than children: a button inside a button is invalid HTML. */}
      <button
        type="button"
        onClick={() => onOpen(deck.id)}
        // How the caret finds its way back here from an editor: the tile the reader left
        // through is the tile they should return to, and this is the only handle that
        // survives the gallery unmounting while the editor is up.
        data-deck-id={deck.id}
        className={cn("block w-full rounded-lg text-left", FOCUS)}
      >
        <Cover cardId={deck.coverCardId} />
        <span className="mt-2 block truncate text-sm">{deck.name}</span>
        <span className="mt-0.5 block truncate text-xs text-dim">
          {deck.formatName ?? deck.formatKey} ·{" "}
          <span className="font-mono tabular-nums">{deck.cardCount}</span> {unit}
        </span>
      </button>

      {/* Scryfall's image policy, per tile — and the plan's ruling: a cover whose artist is
          unknown draws no line at all, never the word "null" and never a placeholder. An
          orphaned cover heals itself on the next sync. */}
      {deck.coverArtist && (
        <p className="mt-0.5 truncate text-[0.7rem] text-dim" title={deck.coverArtist}>
          Art by {deck.coverArtist}
        </p>
      )}

      {/* Invisible until the tile is hovered or holds the caret — a wall of art is not a wall
          of buttons — and always in the tab order, because "visible on hover" is not a state a
          keyboard has. Over the art's corner on the app's own felt at 85%, which is the
          quietest thing that can sit on a picture.

          Mounted through the delete question as well, rather than swapped out for it: the
          question hands the caret back to the control that asked it, and a control that
          unmounts on the way up is one that drops focus onto `<body>` on the way down. Focus
          being *inside* the tile is also what keeps this row visible while the question is
          open — `group-focus-within`, the same clause that answers a keyboard. */}
      <div
        className={cn(
          "absolute right-1 top-1 flex gap-0.5 rounded-md bg-bg/85 p-0.5",
          REVEAL_ON_HOVER,
        )}
      >
        <button
          type="button"
          aria-label={`Duplicate ${deck.name}`}
          title="Duplicate"
          onClick={() => decks.duplicate.mutate(deck.id)}
          className={ICON_BUTTON}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`${deck.archived ? "Restore" : "Archive"} ${deck.name}`}
          title={deck.archived ? "Restore" : "Archive"}
          onClick={() => decks.update.mutate({ id: deck.id, patch: { archived: !deck.archived } })}
          className={ICON_BUTTON}
        >
          {deck.archived ? (
            <ArchiveRestore className="size-3.5" aria-hidden="true" />
          ) : (
            <Archive className="size-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label={`Delete ${deck.name}`}
          title="Delete"
          onClick={(e) => onAskDelete(deck, e.currentTarget)}
          className={cn(ICON_BUTTON, "hover:text-destructive")}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {confirming && (
        <DeleteConfirm
          deck={deck}
          cards={`${deck.cardCount} ${unit}`}
          pending={decks.remove.isPending}
          onConfirm={() => onConfirmDelete(deck)}
          onCancel={onCancelDelete}
          onClose={onCloseDelete}
        />
      )}
    </li>
  );
}

/**
 * What a cover is doing about its image — `CardGrid`'s `Tile`, in the one shape a deck needs.
 *
 * Not shared with it, because the two disagree about what a failure *looks* like: a card tile
 * falls back to the card's own name inside the frame, while a deck tile already has its name
 * in the caption underneath and needs the frame to say what happened instead. What is shared
 * is the schedule (`imageRetryDelayMs`) and the reason for it: an `<img>` that errors once
 * stays broken for the session, and a 429 in the fetcher fails every uncached image fast with
 * a 503 — so the frame comes back on its own, twice, on a dithered doubling delay that never
 * starts sooner than the floor the protocol clamps its own penalty to. Without this a rate
 * limit left a gallery of silent grey rectangles that only a restart could fill.
 */
function Cover({ cardId }: { cardId: string | null }) {
  const [state, setState] = useState<"showing" | "waiting" | "failed">("showing");
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(cardId);

  // The other half of `CardGrid`'s pattern, and the half that is easy to leave behind because
  // nothing today needs it: this component belongs to a *tile*, not to a printing, so a deck
  // that changes its cover hands it a different id without remounting it. Without the reset,
  // the new art would inherit the old one's failure — a frame stuck on "No image" over a
  // picture that is perfectly fetchable. Reset during render is React's own answer to it; an
  // effect would paint one frame of the last cover's failure over the new cover's art. Latent
  // until Task 12's "Set as cover", which is exactly when a divergence here would bite.
  if (shown !== cardId) {
    setShown(cardId);
    setState("showing");
    setAttempt(0);
  }

  useEffect(() => {
    if (state !== "waiting") return;
    const next = attempt + 1;
    const timer = setTimeout(() => {
      setAttempt(next);
      setState("showing");
    }, imageRetryDelayMs(next));
    return () => clearTimeout(timer);
  }, [state, attempt]);

  const url = cardId ? cardImageUrl(cardId, 0, "art") : null;

  return (
    <span
      className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
      style={{ aspectRatio: ART_ASPECT }}
    >
      {url && state === "showing" ? (
        <img
          // Decorative: the deck's name is in the caption two lines down, and an `alt` here
          // would announce the tile twice.
          alt=""
          // The retry is a different URL so nothing between here and the handler can answer
          // it from whatever it made of the failure.
          src={attempt === 0 ? url : `${url}?retry=${attempt}`}
          loading="lazy"
          decoding="async"
          onError={() => setState(attempt < IMAGE_RETRY_LIMIT ? "waiting" : "failed")}
          className={cn(
            "size-full object-cover transition-transform duration-150",
            "group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100",
          )}
        />
      ) : (
        // Says what the empty frame is for rather than leaving a grey rectangle that reads as
        // a rendering fault — and tells "this deck has no cover yet" apart from "the art did
        // not arrive", which are two different things to do something about. Out of the
        // accessible name, which is the deck.
        <span aria-hidden="true" className="text-[0.7rem] text-dim">
          {!url ? "No cover" : state === "waiting" ? "Retrying…" : "No image"}
        </span>
      )}
    </span>
  );
}

/**
 * The one question this view asks before doing something it cannot undo.
 *
 * `deckDelete` really deletes — the deck, its cards and its claims, by cascade — and a deck
 * is minutes of work, so the destructive control asks once, in words, naming what it would
 * take and offering the reversible thing instead.
 */
function DeleteConfirm({
  deck,
  cards,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  deck: DeckRow;
  cards: string;
  pending: boolean;
  onConfirm: () => void;
  /** The Cancel control, which is *in* here: hands the caret back to what opened the layer. */
  onCancel: () => void;
  /** Focus left the layer on its own. Closes and hands nothing back. */
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // The caret moves into the layer, as it does for every other one in the app: the panel's
  // own controls are then the next thing Tab reaches, and Escape has something to hand back.
  // Neither button is focused — the reader has not decided yet, and a stray Enter should not
  // decide for them.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={`Delete ${deck.name}`}
      // Anchored to the tile, not portalled: the shipped CSP is `style-src 'self'` and every
      // overlay primitive in reach injects a runtime <style> the moment it opens — fine under
      // `tauri dev`, blank in a packaged build. `SetCombobox`'s decision, for its reason. Not
      // `aria-modal` either: the gallery behind it stays live.
      // `top-8` rather than the tile's own top edge: the actions row stays where it was, so
      // the question reads as having dropped out of the control that asked it — and the
      // control the caret goes back to is still on screen while the reader decides.
      className={cn(
        "absolute inset-x-0 top-8 z-20 rounded-lg border border-border bg-bg/95 p-2",
        "text-xs shadow-lg",
        FOCUS,
      )}
      // Clicking or tabbing away is an answer too, and it is the safe one — `onClose`, not
      // `onCancel`: the reader is already somewhere else, and yanking the caret back to the
      // trash icon would bounce a Tab forward straight backwards.
      //
      // Not while the delete is in flight. `Delete deck` disables itself on the press, a
      // disabled control is blurred by the browser with no `relatedTarget` at all, and this
      // handler would read that as the reader leaving and take the panel down mid-write —
      // so the pending state is never seen and the answer arrives over a question that is
      // no longer on screen.
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{deck.name}”?</p>
      <p className="mt-1 text-dim">
        Its {cards} {deck.cardCount === 1 ? "goes" : "go"} with it. Archiving keeps the deck
        instead.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(
            "rounded-md border border-destructive px-2 py-1 text-destructive",
            "transition-colors duration-150 hover:bg-destructive hover:text-bg",
            "disabled:opacity-50 motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Delete deck
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The view's one primary action, and the form behind it. */
function NewDeck({
  buttonRef,
  open,
  onOpen,
  onDismiss,
  onClose,
  create,
  onCreated,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpen: () => void;
  /** Escape, and the trigger pressed a second time: the caret comes back here. */
  onDismiss: () => void;
  /** Focus left the form on its own. Closes and hands nothing back. */
  onClose: () => void;
  create: Decks["create"];
  onCreated: (deck: DeckRow) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={rootRef}
      className="relative"
      // Clicking or tabbing away closes the form, and does it without a window listener that
      // could fight the Escape handshake — `AddToCollection`'s arrangement, for its reason.
      // The boundary is the whole control rather than the panel: on `relatedTarget` being the
      // trigger, closing here would race the toggle below and leave the form open forever.
      //
      // A half-typed name is discarded, exactly as every other popup in this app discards its
      // half-made decision (the quick-add loses its quantity, the set picker its query). One
      // rule for all of them is worth more than a rescued word — and the alternative, a
      // trigger that refuses to close while the field is dirty, is a control that stops
      // working for a reason the reader cannot see.
      //
      // Not while the deck is being written, though, and this is the same mechanism the delete
      // question guards against: `Create deck` disables itself on the press, the browser blurs
      // a disabled control with no `relatedTarget` at all, and this handler would read the
      // press as the reader leaving — closing the form *as if it had worked*. It is worse here
      // than there, because this form is the only place a refusal can be read: `writeFailure`
      // above covers the three writes a tile makes, not this one, and reopening the form calls
      // `create.reset()`. So a refused create would leave no deck and no sentence saying why.
      onBlur={(e) => {
        if (create.isPending) return;
        if (open && !rootRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? onDismiss() : onOpen())}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-md border border-accent px-3 text-sm",
          "text-accent transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <Plus className="size-4" aria-hidden="true" />
        New deck
      </button>
      {open && <CreateDeckForm create={create} onCreated={onCreated} />}
    </div>
  );
}

/**
 * Two questions and no more: what it is called, and what it is for.
 *
 * The format list is the seeded `format_specs` table read in its own `sort_order`, filtered
 * to `enabled_in_picker` — which is the whole of why Future Standard, a format you can test
 * a card against but cannot build for, is not offered here.
 */
function CreateDeckForm({
  create,
  onCreated,
}: {
  create: Decks["create"];
  onCreated: (deck: DeckRow) => void;
}) {
  const { specs } = useFormatSpecs();
  const picker = useMemo(() => specs.filter((s) => s.enabledInPicker), [specs]);
  const [name, setName] = useState("");
  const [formatKey, setFormatKey] = useState(DEFAULT_FORMAT);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();

  // The caret starts in the field the reader has to fill.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const failure = create.isError ? ipcError(create.error) : null;
  const trimmed = name.trim();

  return (
    <div
      role="dialog"
      aria-label="New deck"
      // Anchored rather than portalled, and not `aria-modal`: `SetCombobox`'s decision, for
      // its reason — `style-src 'self'` refuses what every overlay library injects.
      className={cn(
        "absolute left-0 top-11 z-20 w-72 rounded-lg border border-border bg-surface p-3",
        "shadow-lg",
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          create.mutate({ name: trimmed, formatKey }, { onSuccess: onCreated });
        }}
        className="space-y-3"
      >
        <div>
          <label htmlFor={`${id}-name`} className="mb-1 block text-xs text-dim">
            Name
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-bg px-2 text-sm",
              "focus:border-accent focus:outline-none",
            )}
          />
        </div>
        <div>
          <label htmlFor={`${id}-format`} className="mb-1 block text-xs text-dim">
            Format
          </label>
          <select
            id={`${id}-format`}
            value={formatKey}
            onChange={(e) => setFormatKey(e.target.value)}
            // The seeded table is read once per session and is normally already in hand by
            // the time this opens; on the one launch where it is not, the select still has to
            // *say* something, and what it would create is what it shows.
            disabled={picker.length === 0}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
              "disabled:opacity-60",
              FOCUS,
            )}
          >
            {picker.length === 0 ? (
              <option value={DEFAULT_FORMAT}>Casual</option>
            ) : (
              picker.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.displayName}
                </option>
              ))
            )}
          </select>
        </div>

        {failure && (
          <p role="alert" className="text-xs text-destructive">
            Could not create the deck — {failure}
          </p>
        )}

        <button
          type="submit"
          disabled={!trimmed || create.isPending}
          className={cn(
            "h-9 w-full rounded-md border border-accent text-sm text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
            "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Create deck
        </button>
      </form>
    </div>
  );
}
