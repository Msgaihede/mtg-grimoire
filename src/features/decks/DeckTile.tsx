/**
 * One deck on the gallery wall, and the three things drawn inside it: the cover frame, the
 * badge that says which of a deck's two lists exist, and the question the trash icon asks.
 *
 * Lifted out of `DecksPage.tsx` on 2026-08-16, whole. **The tile's own menu handlers stay on
 * the tile's own `<button>`** — `src/CLAUDE.md`'s rule, and the reason this component is the one
 * that calls `useContextMenu` rather than being handed an opener: a menu opener has to be able
 * to take focus, and `focus()` on a node with no `tabIndex` is a no-op, so a handler tidied onto
 * the `<li>` would drop the caret on `<body>` every time Escape closed the panel.
 *
 * `Panel` comes from `panels.ts` and not from the page: the page holds it and hands it here, so
 * reading it out of `DecksPage.tsx` would have been an import back into the file this was lifted
 * out of — erased at runtime, and a cycle to a reader and to `import/no-cycle` all the same.
 */
import { useEffect, useRef, type RefObject } from "react";
import { Archive, ArchiveRestore, Copy, FolderInput, Trash2 } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardScaleVars } from "@/lib/cardZoom";
import { FOCUS } from "@/lib/focus";
import { ART_ASPECT, cardImageUrl, deckCoverUrl } from "@/lib/images";
import type { DeckRow } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { buildDeckMenu, type DeckMenuDeps } from "./deckMenu";
import { deckDraggable, MoveToFolder, type FolderNode } from "./FolderTree";
import { RenameField } from "./metaRows";
import type { Panel } from "./panels";
import type { Decks } from "./useDecks";
import { ANY_GAME, gameLabel } from "./useFormatSpecs";

/**
 * Every icon control on a tile, so four of them are one row rather than four sizes.
 *
 * The press is {@link PRESS}, the app's one recipe. It never greys — all four controls are live
 * whatever state the deck is in — so it carries no out-of-reach clause. The heading row's
 * `HEADING_BUTTON` in `DecksPage.tsx` is the same press for the same reason, at that row's size.
 */
const ICON_BUTTON = cn(
  "grid size-[calc(1.5rem*var(--control-scale,1))] place-items-center rounded-md",
  "text-dim hover:text-text",
  PRESS,
  FOCUS,
);

/**
 * The glyph inside one of those controls — 14px at 100%, and on `--control-scale` rather than
 * `--mark-scale` because it is drawn *on* a picture and takes `CONTROL_SHRINK`'s 85% with the
 * button around it.
 *
 * Its own constant because there are five of them (Archive and Restore are one control drawn two
 * ways), and a glyph that disagreed with its own button's box would centre off by a pixel at one
 * end of the ladder and overflow it at the other.
 */
const ICON = "size-[calc(0.875rem*var(--control-scale,1))]";

/**
 * Which of a deck's two lists exist — the one thing a tile can say about a deck that a
 * card count cannot.
 *
 * Derived rather than stored, from the two fields `deck_list` already answers.
 * {@link DeckRow.cardCount} counts the **live** list only, so a deck with theory switched on
 * and nothing live in it is a plan and not yet a deck: `THEORY ONLY`. One derivation, because
 * a badge and the editor's Live/Theory switch must never disagree about which lists a deck has.
 *
 * `THEORY ONLY` is the state **switching the theory list on now produces**, rather than an
 * unusual one: the write moves the live list into the plan and leaves live empty, so the badge
 * reads the deck the way the editor does from that moment.
 */
export type DeckBadge = "LIVE" | "LIVE + THEORY" | "THEORY ONLY";

export function deckBadge(deck: DeckRow): DeckBadge {
  if (!deck.theoryEnabled) return "LIVE";
  return deck.cardCount === 0 ? "THEORY ONLY" : "LIVE + THEORY";
}

/**
 * Which of a deck's two covers is showing, as a URL — or `null` when it has neither.
 *
 * **`coverKind` is the one answer, and reading either id instead is the bug this exists to
 * close.** A deck usually carries both at once: `deckSetCoverImage` leaves `coverCardId` alone
 * and picking a card leaves the file on disk, so "has a custom cover" and "is showing one" are
 * different questions. The gallery used to ask only for `coverCardId`, which meant a custom
 * cover was never drawn *anywhere* on this screen — measured in the live window, where the tile
 * said "No cover" while the route answered the file 626×457 in 2 ms.
 *
 * **A card cover this app cannot credit is not drawn at all.** Scryfall's image policy is that
 * an `art` crop, having no printed frame, may be shown only where the illustrator is named — so
 * if the credit cannot be shown, neither can the crop. `DeckRow.coverArtist` is `null` exactly
 * when the printing has left `cards`, and it comes back on the next sync that brings the
 * printing back, so this is a state that heals itself and never a picture permanently withheld.
 * The frame then says "No cover" rather than claiming a failure, because from the reader's side
 * that is what it is: nothing to show yet.
 *
 * **The rule belongs to the card-art arm and must never be moved onto the custom one.** The
 * policy is about *Scryfall's* pictures. A file the reader uploaded is theirs, carries no
 * Scryfall artist, and needs no credit — so a `coverArtist === null` test on that arm would
 * hide every custom cover, and it would read like a missing guard rather than the bug it is.
 *
 * `DeckCoverPicker`'s `CoverPreview` makes the same two decisions in the same words, which is
 * the point: the gallery and the dialog draw one picture and used to disagree about this exact
 * case. If a third surface ever draws a cover, these four lines want a shared home rather than
 * a third copy.
 */
function coverUrl(deck: DeckRow): string | null {
  if (deck.coverKind === "custom") return deckCoverUrl(deck.id);
  return deck.coverCardId !== null && deck.coverArtist !== null
    ? cardImageUrl(deck.coverCardId, 0, "art")
    : null;
}

/**
 * One deck: its cover art, its name, what it is and how big it is.
 *
 * The art is the tile — an `art` crop rather than a card image, because a wall of full cards
 * is what the *search* looks like and a deck is not a card. The price of the crop is the
 * credit line under it: an art crop carries no printed frame, so the illustrator is named
 * wherever one is shown.
 */
export function DeckTile({
  deck,
  decks,
  nodes,
  folderId,
  zoom,
  panel,
  moving,
  onOpen,
  onAskDelete,
  onAskMove,
  onStartRename,
  onRename,
  menuDeps,
  menuOpenerRef,
  onMove,
  onConfirmDelete,
  onCancelPanel,
  onClosePanel,
}: {
  deck: DeckRow;
  decks: Decks;
  nodes: readonly FolderNode[];
  /** The folder it is in now, normalised through the folder list this screen actually has. */
  folderId: number | null;
  /**
   * How large the reader draws a deck — `cardZoom.deckGallery`, read once by the page and handed
   * to every tile on the wall.
   *
   * A prop rather than a store read of its own for the reason the page's own comment gives: a
   * folder of forty decks would otherwise be forty subscriptions to one number. What it sizes is
   * the tile's *chrome* — the name, the caption, the badge, the credit and the four controls —
   * through the two variables {@link cardScaleVars} sets on the root below. The art needs
   * nothing: the cover is a full-width box on a fixed aspect, so it follows the grid track the
   * page sized with the same number.
   */
  zoom: number;
  panel: Panel;
  moving: boolean;
  onOpen: (id: number) => void;
  onAskDelete: (deck: DeckRow, opener: HTMLButtonElement) => void;
  onAskMove: (deck: DeckRow, opener: HTMLButtonElement) => void;
  /** F2 — and the context menu's "Rename…", which is the pointer's route to the same field. */
  onStartRename: (deck: DeckRow, opener: HTMLButtonElement | null) => void;
  /** The field's own Save. */
  onRename: (name: string) => void;
  /** Everything the tile's right-click menu does that is not the deck. One object for the whole
   *  wall, built by `DecksPage` — a menu is data, and `buildDeckMenu` is what turns this
   *  and the deck into rows. */
  menuDeps: DeckMenuDeps;
  /** Where this tile writes itself when its menu opens, so that a layer the menu raises has an
   *  opener to hand the caret back to. See `DecksPage`'s `menuOpenerRef`. */
  menuOpenerRef: RefObject<HTMLButtonElement | null>;
  onMove: (folderId: number | null) => void;
  onConfirmDelete: (deck: DeckRow) => void;
  /** Cancel: a control *in* the layer, so the caret goes back to what opened it. */
  onCancelPanel: () => void;
  /** Clicked or tabbed away: the layer goes and the caret stays where it went. */
  onClosePanel: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const tip = useTooltip();
  const { id, name } = deck;
  const { menu, menuKey } = useContextMenu();
  /** This tile's rows, built when the reader right-clicks it and never before — and from **one**
   *  thunk for both doors, so the pointer and the keyboard cannot come to two menus. */
  const build = () => buildDeckMenu(deck, menuDeps);
  const openMenu = menu(build);
  const openMenuByKey = menuKey(build);

  // The gesture half of filing. The whole tile is the handle — the art is the deck — and the
  // controls in the corner mark themselves `data-no-drag` so a press on Delete is a press on
  // Delete rather than the first five pixels of a drag.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return deckDraggable({ element, payload: () => ({ deckId: id, name }) });
  }, [id, name]);

  /** One derivation of the plural, for the caption and the question that quotes it. */
  const unit = deck.cardCount === 1 ? "card" : "cards";
  const badge = deckBadge(deck);
  const confirming = panel?.kind === "deleteDeck" && panel.deckId === deck.id;
  const choosingFolder = panel?.kind === "moveDeck" && panel.deckId === deck.id;
  const renaming = panel?.kind === "renameDeck" && panel.deckId === deck.id;

  return (
    // The two scale variables are set here, on the tile's own root, so everything drawn inside it
    // inherits them — including the shared marks in `components/`, which read
    // `var(--mark-scale, 1)` and get the fallback on every surface that is not a card. That is
    // the whole mechanism: a table's 12px gem stays 12px without knowing this variable exists.
    <li ref={ref} style={cardScaleVars(zoom)} className="group relative">
      {/* The art and the caption are one button — a deck is picked by looking at it, and a
          reader who aims at the name should not miss. The controls below are siblings of it
          rather than children: a button inside a button is invalid HTML. */}
      <button
        type="button"
        onClick={() => onOpen(deck.id)}
        // The tile's right-click menu, **on the button rather than on the `<li>`**: the panel
        // hands the caret back to the element the menu was opened on, and an `<li>` cannot take
        // it — `focus()` on a non-focusable node is a no-op, so Escape would drop the reader on
        // `<body>`. It is also the element a `menuKey` (Shift+F10) has to sit on, since only a
        // focusable one receives the press.
        //
        // `build` is a thunk, so a wall of forty tiles builds no menu until one is right-clicked;
        // the handler stops the event itself, so an outer surface offering its own menu never
        // replaces these rows.
        //
        // **The stash is this handler's own line and `e.currentTarget` is this button.** It is
        // written even for a press `menu` then declines (a right-click inside a text field), and
        // that is harmless rather than sloppy: nothing reads the opener until a menu *row* is
        // chosen, which can only follow a menu that opened. Writing it inside the `build` thunk
        // would be exact, and `react-hooks/refs` rejects it — a ref read in a callback handed to
        // a function during render is indistinguishable, to the rule, from a ref read *during*
        // render.
        onContextMenu={(e) => {
          menuOpenerRef.current = e.currentTarget;
          openMenu(e);
        }}
        // **F2 renames the tile the caret is on** — the tree's own key, one floor along
        // (`FolderTree`'s row answers the same press), and the keyboard's route to the field
        // below. A shortcut rather than the only way in: the tile's context menu is the
        // pointer's route to the same field.
        //
        // **Shift+F10 and the ContextMenu key open the same menu the right-click does, and they
        // are composed with F2 rather than put in its place.** The reader chose a menu that
        // opens by keyboard over a pointer-only one, and this is the element the press has to
        // land on for the same reason the right-click is here: an `<li>` cannot take the caret
        // back. A `menuKey` that *replaced* this handler would open a menu and take the rename
        // with it — which the F2 case in this file's suite is what catches.
        //
        // The stash is this handler's own line for the reason the right-click's is, and is
        // written even for a press `menuKey` declines: nothing reads the opener until a menu
        // *row* is chosen, which can only follow a menu that opened.
        onKeyDown={(e) => {
          menuOpenerRef.current = e.currentTarget;
          openMenuByKey(e);
          if (e.defaultPrevented) return;
          if (e.key !== "F2") return;
          e.preventDefault();
          onStartRename(deck, e.currentTarget);
        }}
        // How the caret finds its way back here from an editor: the tile the reader left
        // through is the tile they should return to, and this is the only handle that
        // survives the gallery unmounting while the editor is up.
        data-deck-id={deck.id}
        className={cn("block w-full rounded-lg text-left", FOCUS)}
      >
        <Cover deck={deck} />
        {/* The deck's name, and the first of the four sizes on this tile that move with the
            zoom. Written as a `calc` off `--mark-scale` rather than as a scaled pixel prop for
            `cardZoom.ts`'s reason: the variable is inherited, so the marks drawn inside a tile
            follow it with no call site involved. 0.875rem is `text-sm`, 1.25rem its leading. */}
        <span
          className={cn(
            "mt-[calc(0.5rem*var(--mark-scale,1))] block truncate",
            "text-[calc(0.875rem*var(--mark-scale,1))] leading-[calc(1.25rem*var(--mark-scale,1))]",
          )}
        >
          {deck.name}
        </span>
        {/* `Modern · Arena · 60 cards`, and `Modern · 60 cards` on a deck that has been given
            no platform. **The `Any` row is deliberately not drawn**: it is what every deck is
            born as, so printing it would put a word that says nothing on nearly every tile in
            the gallery — and this caption already truncates in a narrow column. A deck that
            *has* been pinned is the one worth marking, which is the same argument the LIVE /
            THEORY badge above makes about the lists a deck keeps. */}
        <span
          className={cn(
            "mt-[calc(0.125rem*var(--mark-scale,1))] block truncate text-dim",
            "text-[calc(0.75rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
          )}
        >
          {deck.formatName ?? deck.formatKey}
          {deck.gameKey !== ANY_GAME && ` · ${gameLabel(deck.gameKey)}`} ·{" "}
          <span className="font-mono tabular-nums">{deck.cardCount}</span> {unit}
        </span>
      </button>

      {/* Which lists this deck has, over its own art. Outside the button rather than in it:
          `aria-label` would otherwise read the badge before the name, and the tile is named
          for its deck. `pointer-events-none` so a corner of the picture is not a dead spot. */}
      <span
        className={cn(
          // The badge sits *on* the art, so its inset scales with the picture it is tucked into:
          // 6px in from a 200px crop is a corner, and 6px in from a 400px one is a smudge against
          // the edge. Its own type and padding follow for the same reason.
          "pointer-events-none absolute rounded-sm border bg-bg/70",
          "left-[calc(0.375rem*var(--mark-scale,1))] top-[calc(0.375rem*var(--mark-scale,1))]",
          "px-[calc(0.375rem*var(--mark-scale,1))]",
          "font-mono tracking-wide",
          "text-[calc(0.6rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
          badge === "LIVE" ? "border-border text-dim" : "border-accent text-accent",
          // Dashed means provisional, here as on a folder card: a theory list is a plan.
          badge === "THEORY ONLY" && "border-dashed",
        )}
      >
        {badge}
      </span>

      {/* Scryfall's image policy, per tile — and the plan's ruling: a cover whose artist is
          unknown draws no line at all, never the word "null" and never a placeholder. An
          orphaned cover heals itself on the next sync.

          `coverKind` is in the condition because `coverArtist` is a lookup on `coverCardId`
          and nothing else — the backend's `LEFT JOIN cards c ON c.id = d.cover_card_id`, which
          does not know or care which cover is showing. A deck carrying both (the ordinary case
          after an upload) therefore answers an artist while wearing the reader's own picture,
          and crediting an illustrator whose work is *not on screen* is the one thing this line
          must never do. `DeckCoverPicker`'s `CoverPreview` guards the same way. */}
      {deck.coverKind === "card_art" && deck.coverArtist && (
        <p
          className={cn(
            "mt-[calc(0.125rem*var(--mark-scale,1))] truncate text-dim",
            "text-[calc(0.7rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
          )}
          {...tip(deck.coverArtist, { whenClipped: true })}
        >
          Art by {deck.coverArtist}
        </p>
      )}

      {/* Renaming a deck, in the tile it belongs to.
          **Under the tile rather than in place of it**, which is where the folder tree's field
          stands — and the difference is what the two are standing over. A folder row is a name
          and a count, so a field can replace it whole; a tile is the art the deck was built
          around, and a reader renaming one deck out of forty needs to see which. It also has to
          be a *sibling* of the button: `RenameField` is a `<form>`, and a form inside a button
          is invalid HTML.
          `metaRows.tsx`'s field, not a third rename control — the caret handling in there was
          got wrong twice before it was written down once. `data-no-drag` because the tile is a
          drag handle: without it a press on Save plus five pixels of travel files the deck. */}
      {renaming && (
        <div data-no-drag="">
          <RenameField
            label={`Rename ${deck.name}`}
            initial={deck.name}
            pending={decks.update.isPending}
            onSave={onRename}
            onCancel={onCancelPanel}
          />
        </div>
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
          // The tray's own inset, gap and felt move with the controls it holds rather than with
          // the marks, so the row stays one object at every stop: four buttons at 85% inside a
          // 4px pad reads as a control, and four scaled buttons inside a fixed one reads as four
          // buttons that have outgrown their tray.
          "absolute flex rounded-md bg-bg/85",
          "right-[calc(0.25rem*var(--control-scale,1))] top-[calc(0.25rem*var(--control-scale,1))]",
          "gap-[calc(0.125rem*var(--control-scale,1))] p-[calc(0.125rem*var(--control-scale,1))]",
          REVEAL_ON_HOVER,
        )}
      >
        <button
          type="button"
          data-no-drag=""
          aria-label={`Move ${deck.name} to a folder`}
          aria-expanded={choosingFolder}
          aria-haspopup="dialog"
          {...tip("Move to a folder", { describes: false })}
          onClick={(e) => (choosingFolder ? onCancelPanel() : onAskMove(deck, e.currentTarget))}
          className={ICON_BUTTON}
        >
          <FolderInput className={ICON} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`Duplicate ${deck.name}`}
          {...tip("Duplicate", { describes: false })}
          onClick={() => decks.duplicate.mutate(deck.id)}
          className={ICON_BUTTON}
        >
          <Copy className={ICON} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`${deck.archived ? "Restore" : "Archive"} ${deck.name}`}
          {...tip(deck.archived ? "Restore" : "Archive", { describes: false })}
          onClick={() => decks.update.mutate({ id: deck.id, patch: { archived: !deck.archived } })}
          className={ICON_BUTTON}
        >
          {deck.archived ? (
            <ArchiveRestore className={ICON} aria-hidden="true" />
          ) : (
            <Archive className={ICON} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          data-no-drag=""
          aria-label={`Delete ${deck.name}`}
          {...tip("Delete", { describes: false })}
          onClick={(e) => onAskDelete(deck, e.currentTarget)}
          className={cn(ICON_BUTTON, "hover:text-destructive")}
        >
          <Trash2 className={ICON} aria-hidden="true" />
        </button>
      </div>

      {choosingFolder && (
        <MoveToFolder
          label={`Move ${deck.name} to a folder`}
          nodes={nodes}
          currentId={folderId}
          pending={moving}
          onPick={onMove}
          onClose={onClosePanel}
        />
      )}

      {confirming && (
        <DeleteConfirm
          deck={deck}
          cards={`${deck.cardCount} ${unit}`}
          pending={decks.remove.isPending}
          onConfirm={() => onConfirmDelete(deck)}
          onCancel={onCancelPanel}
          onClose={onClosePanel}
        />
      )}
    </li>
  );
}

/**
 * What a cover is doing about its image — `CardGrid`'s `Tile`, in the one shape a deck needs.
 *
 * The frame is its own, because the two disagree about what a failure *looks* like: a card
 * tile falls back to the card's own name inside the frame, while a deck tile already has its
 * name in the caption underneath and needs the frame to say what happened instead — and it has
 * a third thing to say, "No cover", which is not a failure at all. What is shared is
 * {@link useImageRetry}: the schedule, and the reason for it.
 *
 * **Two things change what this frame should be painting, and only one of them changes the
 * URL.** Picking a different card, or switching between card art and the reader's own picture,
 * hands this component a different {@link coverUrl} — which is the reset the retry hook does
 * and the key `CardImage` puts on its own `<img>`, and it is the whole of what lets one frame
 * serve both kinds of cover with nothing written here. **Replacing the custom file changes no
 * URL at all**: `/cover/<deckId>` names the deck rather than the picture, `images.ts` forbids a
 * cache-buster on it, and the `no-store` that route is served with never gets a say — a header
 * decides what happens to a *request*, and a browser with no reason to make one goes on
 * painting the frame it already decoded. So the custom arm is keyed on `deck.updatedAt`, which
 * the upload moves because setting a cover is a write to the deck; a moved key is a new
 * element, and an element that has never decoded anything paints nothing.
 *
 * **A moved key is a new element only when the key actually moved, and the floor on that is a
 * whole second.** `decks.updated_at` is `unixepoch()` — an integer count of seconds — so two
 * uploads inside one clock second leave the number where it was, the element is not replaced,
 * and the second picture waits for the next write to the deck. It is the narrowest case there
 * is and it is not repaired here: a cache-buster is what `images.ts` forbids, and a monotonic
 * counter would be a second answer to "has this deck changed". `DeckCoverPicker`'s
 * `CoverPreview` keys on the same number, so it shares the floor exactly.
 *
 * **This screen is where that bites**: `DeckSettingsDialog`, the surface that uploads a
 * cover, is mounted right here over this wall, so the tile behind the scrim was the one still
 * showing the replaced file. `DeckCoverPicker`'s `CoverPreview` makes the same move with the
 * same number under the name `customCoverKey` — one picture, on both sides of that scrim.
 *
 * **The card-art arm deliberately takes no key.** `updatedAt` moves for very nearly every write
 * to the deck — a rename does, and `deck_set_view_state` is the one that deliberately does not,
 * because reading a deck is not editing it — so keying it too would throw away a crop the
 * browser has already decoded and leave the tile blank while it came back, for a rename. There
 * is nothing there to notice: a printing's URL names its own picture.
 *
 * A missing custom file is a **404**, never a placeholder — `images.rs` chose that deliberately
 * so the fault is visible rather than hidden behind a grey rectangle that looks like a picture.
 * It arrives here as an `<img>` error like any other, so it lands in the same three sentences
 * below and never as a broken-image glyph.
 */
function Cover({ deck }: { deck: DeckRow }) {
  const url = coverUrl(deck);
  const image = useImageRetry(url);

  return (
    <span
      className="grid w-full place-items-center overflow-hidden rounded-lg bg-surface"
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src ? (
        <CardImage
          // Decorative: the deck's name is in the caption two lines down, and an `alt` here
          // would announce the tile twice.
          alt=""
          // `CardImage` keys itself on the `src`, which is the whole answer for a card cover:
          // a different printing is a different URL. A custom cover's URL names the *deck*, so
          // nothing keyed on it can notice an upload — this key is the number that moves when
          // the file behind that unchanged URL is replaced. See the note above the component.
          key={deck.coverKind === "custom" ? deck.updatedAt : undefined}
          src={image.src}
          loading="lazy"
          decoding="async"
          onError={image.onError}
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
        // Inside the frame, so it takes the frame's scale like everything else drawn on a tile —
        // three words centred in a doubled box at their shipped size read as a caption that
        // missed the zoom.
        <span aria-hidden="true" className="text-[calc(0.7rem*var(--mark-scale,1))] text-dim">
          {!url ? "No cover" : image.retrying ? "Retrying…" : "No image"}
        </span>
      )}
    </span>
  );
}

/**
 * The one question this view asks before doing something it cannot undo.
 *
 * `deckDelete` really deletes — the deck row and every `deck_cards` row in it, by cascade — and
 * a deck is minutes of work, so the destructive control asks once, in words, naming what it
 * would take and offering the reversible thing instead.
 *
 * **It says where the cards go, and it says so unconditionally.** A card is in a deck because
 * its collection row physically sits in that deck's group, so deleting the deck does not
 * destroy anything the reader owns — the copies are refiled into `Recently removed`, the one
 * pinned folder in the collection that exists to catch them. "Its 60 cards go with it" was
 * true of the rows and wrong about the cardboard, which is the half a reader is actually
 * afraid of. The collection's own folder-delete confirmation set the precedent — "Its cards
 * move back to your collection; folders inside it are deleted" — and it is the same rule: a
 * destructive question names the destination as well as the loss.
 *
 * **No checkbox and no "ask me each time."** Where the copies land is a fact about the write
 * rather than a choice being offered, and a switch here would imply the other answer exists.
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
      data-no-drag=""
      // Anchored to the tile, not portalled: the shipped CSP is `style-src 'self'` and every
      // overlay primitive in reach injects a runtime <style> the moment it opens — fine under
      // `tauri dev`, blank in a packaged build. `SetCombobox`'s decision, for its reason. Not
      // `aria-modal` either: the gallery behind it stays live.
      // `top-8` rather than the tile's own top edge: the actions row stays where it was, so
      // the question reads as having dropped out of the control that asked it — and the
      // control the caret goes back to is still on screen while the reader decides.
      className={cn(
        "absolute inset-x-0 top-8 rounded-lg border border-border bg-bg/95 p-2",
        "text-xs shadow-lg",
        LAYER.popup,
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
        Its {cards} {deck.cardCount === 1 ? "moves" : "move"} to Recently removed. Archiving
        keeps the deck instead.
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
