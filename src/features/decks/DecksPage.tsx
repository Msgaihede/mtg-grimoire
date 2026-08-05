import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Archive, ArchiveRestore, ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { ART_ASPECT, cardImageUrl } from "@/lib/images";
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
  const [panel, setPanel] = useState<Panel>(null);
  const [showArchived, setShowArchived] = useState(false);
  const newDeckRef = useRef<HTMLButtonElement>(null);
  /** Whatever opened the layer that is up, so Escape can hand the caret back to it. */
  const openerRef = useRef<HTMLButtonElement | null>(null);

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab
  // restarts from the top of the app. An outside click deliberately does not do this; the
  // reader is already somewhere else.
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setPanel(null);
  }, []);

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
    <section className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second "Decks" under it
          would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Decks</h2>

      <div className="flex items-center gap-3">
        <NewDeck
          buttonRef={newDeckRef}
          open={panel?.kind === "create"}
          onOpen={openCreate}
          onDismiss={dismiss}
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
            A deck is a list you build for a format. Start one and the app checks it as you go
            — deck size, copy limits, the commander's colours — and tells you which of the
            cards you already own.
          </p>
        )}

        {live.length > 0 && (
          <ul className={GRID}>
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
              <ul className={cn(GRID, "mt-3")}>
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
}: {
  deck: DeckRow;
  decks: Decks;
  confirming: boolean;
  onOpen: (id: number) => void;
  onAskDelete: (deck: DeckRow, opener: HTMLButtonElement) => void;
  onConfirmDelete: (deck: DeckRow) => void;
  onCancelDelete: () => void;
}) {
  const cards = `${deck.cardCount} ${deck.cardCount === 1 ? "card" : "cards"}`;
  return (
    <li className="group relative">
      {/* The art and the caption are one button — a deck is picked by looking at it, and a
          reader who aims at the name should not miss. The controls below are siblings of it
          rather than children: a button inside a button is invalid HTML. */}
      <button
        type="button"
        onClick={() => onOpen(deck.id)}
        className={cn("block w-full rounded-lg text-left", FOCUS)}
      >
        <span
          className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
          style={{ aspectRatio: ART_ASPECT }}
        >
          {deck.coverCardId ? (
            <img
              // Decorative: the deck's name is in the caption two lines down, and an `alt`
              // here would announce the tile twice.
              alt=""
              src={cardImageUrl(deck.coverCardId, 0, "art")}
              loading="lazy"
              decoding="async"
              className={cn(
                "size-full object-cover transition-transform duration-150",
                "group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100",
              )}
            />
          ) : (
            // Says what the empty frame is for rather than leaving a grey rectangle that
            // reads as a rendering fault. Out of the accessible name, which is the deck.
            <span aria-hidden="true" className="text-[0.7rem] text-dim">
              No cover
            </span>
          )}
        </span>
        <span className="mt-2 block truncate text-sm">{deck.name}</span>
        <span className="mt-0.5 block truncate text-xs text-dim">
          {deck.formatName ?? deck.formatKey} ·{" "}
          <span className="font-mono tabular-nums">{deck.cardCount}</span>{" "}
          {deck.cardCount === 1 ? "card" : "cards"}
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
          cards={cards}
          pending={decks.remove.isPending}
          onConfirm={() => onConfirmDelete(deck)}
          onCancel={onCancelDelete}
        />
      )}
    </li>
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
}: {
  deck: DeckRow;
  cards: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
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
      // Clicking or tabbing away is an answer too, and it is the safe one.
      onBlur={(e) => {
        if (!panelRef.current?.contains(e.relatedTarget)) onCancel();
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
  create,
  onCreated,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  create: Decks["create"];
  onCreated: (deck: DeckRow) => void;
}) {
  return (
    <div className="relative">
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
