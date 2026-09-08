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
import { ART_ASPECT, cardArtSrc, cardImageUrl } from "@/lib/images";
import type { DeckRow } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import type { PipCounts } from "@/lib/mana";
import { PRESS } from "@/lib/motion";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";
import { DeckColorBar } from "./DeckColorBar";
import { buildDeckMenu, type DeckMenuDeps } from "./deckMenu";
import { deckColorsLabel } from "./deckPips";
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
 * The box both of the art's marks are drawn in — the theory badge at its bottom-left, the bracket
 * pill at its bottom-right.
 *
 * **One constant because they are one mark drawn twice**, rather than two that happen to agree
 * today: they sit at the two ends of the same edge of the same picture, so a padding, a face or a
 * radius changed on one of them alone is two vocabularies in one corner. That is `src/CLAUDE.md`'s
 * *N independent decisions* rule met at the smallest scale it can be met at, and the pair had two
 * class lists for exactly as long as it took to notice they were the same list.
 *
 * **Every size in it scales with `--mark-scale`, and the inset is the reason.** A mark drawn *on*
 * a picture is read against that picture: 6px in from a 200px crop is a corner, 6px in from a
 * 400px one is a smudge against the edge. Its type and padding follow for the same reason, and
 * the variable is inherited from the tile's root so no call site is involved — `cardZoom.ts`'s
 * arrangement.
 *
 * Accent on both, where the dim arm used to be the one-list deck's: every badge left is a deck
 * that keeps two lists, and a bracket is a reading worth pointing at. What is *not* shared is the
 * dash — see {@link deckBadge} and the pill's own comment.
 */
const TILE_MARK = cn(
  "absolute bottom-[calc(0.375rem*var(--mark-scale,1))] rounded-sm border bg-bg/70",
  "px-[calc(0.375rem*var(--mark-scale,1))]",
  "font-mono tracking-wide",
  "text-[calc(0.6rem*var(--mark-scale,1))] leading-[calc(1rem*var(--mark-scale,1))]",
  "border-accent text-accent",
);

/**
 * Which of a deck's two lists exist — the one thing a tile can say about a deck that a
 * card count cannot.
 *
 * Derived rather than stored, from the two fields `deck_list` already answers.
 * {@link DeckRow.cardCount} counts the **actual** list only, so a deck with theory switched on
 * and nothing in that list is a plan and not yet a deck: `THEORY ONLY`. One derivation, because
 * a badge and the editor's Theory/Actual switch must never disagree about which lists a deck
 * has.
 *
 * **A deck that keeps no plan wears no badge at all**, and that is the caption's `Any` argument
 * read across: one list is what every deck is born with, so a word for it would sit on nearly
 * every tile in the gallery and say nothing about the deck under it. The badge is here to mark
 * the deck that keeps *two*, and `null` is the answer for the rest.
 *
 * `THEORY ONLY` is the state **switching the theory list on now produces**, rather than an
 * unusual one: the write moves the actual list into the plan and leaves it empty, so the badge
 * reads the deck the way the editor does from that moment.
 *
 * **`Actual` is the word and `live` is still the stored variant** — the split the editor's
 * switch argues, which this file only follows. Issue #357 was this badge still reading
 * `LIVE + THEORY` a week after the tabs stopped: the vocabulary a reader meets inside a deck and
 * the one on its tile are one vocabulary.
 */
export type DeckBadge = "THEORY + ACTUAL" | "THEORY ONLY";

export function deckBadge(deck: DeckRow): DeckBadge | null {
  if (!deck.theoryEnabled) return null;
  return deck.cardCount === 0 ? "THEORY ONLY" : "THEORY + ACTUAL";
}

/**
 * Has this deck a cover the app is **allowed** to draw — a printing, and an illustrator to
 * credit it to?
 *
 * Split out from {@link coverUrl} on 2026-08-31, and the split is what keeps the empty frame
 * honest on the web build. There a cover with no URL on the row is `null` from {@link coverUrl}
 * just as a deck with no cover is, and the frame's three words are the only thing telling a
 * reader which of the two happened. "No cover" means *you have not chosen one*; a deck that has
 * chosen one and cannot be handed its bytes says "No image", which is the same sentence a
 * failed fetch gets and the true one.
 *
 * **The illustrator half of this test survived the credit line's deletion, and it still means
 * what it said** (2026-09-07). The `Art by` row under the tile is gone, but the name did not go
 * with it — it moved onto the picture as {@link Cover}'s tooltip — so the condition this guard
 * enforces is unchanged: a crop is drawn only where the app can name who painted it. Reading
 * this the other way round is the mistake to avoid, and it is an easy one for a reader arriving
 * after that change: the guard was never *about* the line, it was about the crop.
 */
function hasCover(deck: DeckRow): boolean {
  return deck.coverCardId !== null && deck.coverArtist !== null;
}

/**
 * A deck's cover as a URL — or `null` when it has none, or none this app may draw.
 *
 * **A cover this app cannot credit is not drawn at all, and that is as true after 2026-09-07 as
 * before it.** Scryfall's rule — `https://scryfall.com/docs/api`, under the image guidelines, and
 * *not* `docs/api/images`, which carries no artist rule at all any more — is that an `art` crop,
 * having no printed frame, may be shown only in an interface that names the illustrator. So if
 * the credit cannot be shown, neither can the crop. What changed is only *where* the credit is
 * shown: it is {@link Cover}'s tooltip rather than a line of text under the tile, so the artist
 * is still named and this condition still means exactly what it said.
 * `DeckRow.coverArtist` is `null` exactly when
 * the printing has left `cards`, and it comes back on the next sync that brings the printing
 * back, so this is a state that heals itself and never a picture permanently withheld. The frame
 * then says "No cover" rather than claiming a failure, because from the reader's side that is
 * what it is: nothing to show yet.
 *
 * **It used to be two arms and a `coverKind` test, and the deletion is what makes the rule above
 * unconditional.** A deck could also wear a picture the reader had chosen off disk, served at
 * `/cover/<deckId>` — and it carried *both* covers at once, since setting either left the other
 * alone, so `coverKind` was the only answer to which one was showing. Two things follow from its
 * going and both are simplifications rather than losses: the policy no longer has to be kept off
 * one of the arms (a reader's own photograph has no Scryfall illustrator, so an artist test there
 * would have hidden every custom cover — which read like a missing guard and was the opposite),
 * and a `custom` row arriving from a device on an older rung draws its card art, which is what
 * every device but the uploader already drew.
 *
 * `DeckCoverPicker`'s `CoverPreview` makes the same decision in the same words, which is the
 * point: the gallery and the dialog draw one picture and used to disagree about this exact case.
 * If a third surface ever draws a cover, these three lines want a shared home rather than a
 * third copy.
 *
 * **The platform branch is {@link cardArtSrc}'s and is written nowhere else.** `mtgimg://` is a
 * Tauri custom protocol and wasm cannot register a URL scheme with a browser, so on web the only
 * picture reachable is the one `deck_list` put on the row — and a deck whose row carries none
 * answers `null` here, which is the empty frame rather than a broken `<img>`. This went missing
 * when the walls were routed through `cardArtSrc` (PRs #320/#321), so every deck cover on web
 * and on the phone was the platform's broken-image glyph from the day #327 made the card-art
 * crop the *only* cover.
 */
function coverUrl(deck: DeckRow): string | null {
  return deck.coverCardId !== null && deck.coverArtist !== null
    ? cardArtSrc(cardImageUrl(deck.coverCardId, 0, "art"), deck.imageUris?.art)
    : null;
}

/**
 * One deck: its cover art, what colours it is, its name, what it is and how big it is.
 *
 * The art is the tile — an `art` crop rather than a card image, because a wall of full cards
 * is what the *search* looks like and a deck is not a card. The price of the crop is the
 * illustrator's name, which an art crop carries no printed frame to give: see {@link Cover},
 * which is where that credit now lives.
 *
 * **The colours and the bracket arrived 2026-09-07 and the credit line left in the same pass**
 * (issue #387). The tile said four things about a deck and one about its illustrator, and the
 * two facts a reader actually browses a wall by — what colours it is, and how strong it is —
 * were reachable only by opening it. {@link DeckColorBar} is the first and the bracket is the
 * second; the credit became a tooltip on the picture it belongs to, which is a row of chrome off
 * every tile and a name that has moved *closer* to the thing it names.
 * `docs/superpowers/plans/2026-09-07-deck-gallery-overview.md` carries the whole argument,
 * including the policy reading behind the move.
 *
 * **The bracket spent that one iteration inside the caption and is a pill on the art since**, and
 * the redesign moved it for what the caption is: the tile's least important line, truncating from
 * the end, in a column narrow enough that a fourth segment is the segment that goes. A bracket is
 * not the fourth thing about a format — it is the one number on the tile a reader compares decks
 * by — so it is a mark on the picture beside the badge, and the caption is back to the three
 * terms that describe the *list* (`Commander · Paper · 100 cards`).
 *
 * **So the tile has marks that belong to the art rather than to the tile, and they live in one
 * overlay** — the badge bottom-left, the pill bottom-right. Both stay outside the `<button>` for
 * the badge's own long-standing reason (see the overlay below), and the art's bottom is not the
 * tile's bottom, which is the whole of why that box exists.
 */
export function DeckTile({
  deck,
  pips,
  bracketLabel,
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
  /**
   * The deck's pip distribution, or `null` while the read is out — see `useDeckPips`.
   *
   * A prop rather than a read of this deck's own, for the reason {@link zoom} is one: the
   * gallery asks `deck_pip_costs` once for every deck on the wall and hands each tile its
   * record, where forty tiles each fetching their own would be forty queries for one screen.
   * `null` is the honest shape of "not yet" and {@link DeckColorBar} draws nothing for it —
   * a bar that appeared a moment after the wall did would be forty tiles changing height
   * under the reader's pointer.
   */
  pips: PipCounts | null;
  /**
   * `Bracket 3` when the reader answered, `Bracket ~3` for a reading, `null` where the format
   * has no command zone or nothing has answered yet.
   *
   * **The tile draws the string and decides nothing.** Whether a format has a command zone is
   * `format_specs.commanderRule`, and whether the number is an answer or a reading is
   * `useDeckBrackets`' own — both are questions with a source of truth elsewhere, and a tile
   * that re-derived either would be a second opinion about a deck the editor has already
   * stated one about.
   *
   * **The `~` means here exactly what it means on the editor's `DeckBracket` button, and the
   * two spellings may not diverge.** There it is the whole of the visible difference between
   * what the cards read as and what the reader told the deck it is; a gallery that spelled a
   * reading differently would teach the mark twice, and a reader who has had the bracket
   * conversation at their table would see their own answer hedged on the wall. It is drawn and
   * not spoken — a screen reader says "tilde three" or nothing at all — which is why the mark it
   * is drawn in stays plain visible text rather than a glyph with an `sr-only` twin.
   *
   * **The string is this prop and the pill only shapes it.** `BRACKET ~3` is `text-transform`
   * over `Bracket ~3`, never a second string built here: the page owns the words, the tile owns
   * the type, and a spelling that existed in two places is a spelling that would eventually be
   * corrected in one.
   */
  bracketLabel: string | null;
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
  const colorsLabel = deckColorsLabel(pips);
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
        {/* The crop loses its bottom corners exactly when a band is coming — see {@link Cover}. */}
        <Cover deck={deck} />
        {/* What colours the deck is, between the picture and the name — **inside the button**,
            because it is part of the tile's flow rather than a mark laid on the art, and the
            reader who is about to press this tile is reading it in that order: the picture, the
            colours, the name.
            **In the flow is also what makes it sit flush**: the band carries no top margin and
            the crop above it no bottom radius, so the two abut with nothing between them and read
            as one object. Nothing may be introduced here that reopens that seam — an element, a
            margin or a gap on the button would put a hairline of page between a picture and the
            band it belongs to.
            **Drawn on every deck, and empty where there is nothing to say.** An all-lands pile
            and a read still in flight both get a bare 20px course of the tile's surface rather
            than no band at all: the band is a course of the tile now, and a tile missing one
            stands 20px short of the row, which reads as a layout fault rather than as a deck
            with no colours. The component's head has the measurement.
            **It is `aria-hidden`, and the words are the `sr-only` span under the name.** The
            picture may sit above the name; the *sentence* may not, and that is the badge's rule
            below applied one element up — a tile is named for its deck, and a bar that named
            itself here made the button read `White, Red Zoo …`, which is a tile that no longer
            answers to "click Zoo". */}
        <DeckColorBar pips={pips} />
        {/* The deck's name, and the first of the four sizes on this tile that move with the
            zoom. Written as a `calc` off `--mark-scale` rather than as a scaled pixel prop for
            `cardZoom.ts`'s reason: the variable is inherited, so the marks drawn inside a tile
            follow it with no call site involved. 0.875rem is `text-sm`, 1.25rem its leading.
            **The 8px above it is measured from a band now rather than from a hairline, and it
            stays 8px.** The colour bar used to leave 4px above itself and take 5px, so this
            margin was air under a rule that was air under a picture; the band abuts the crop and
            is 20px tall, so what these 8px now separate is the *picture* — crop and band, one
            object — from the words under it. That is the design's number and it is the one this
            line was always about. */}
        <span
          className={cn(
            "mt-[calc(0.5rem*var(--mark-scale,1))] block truncate",
            "text-[calc(0.875rem*var(--mark-scale,1))] leading-[calc(1.25rem*var(--mark-scale,1))]",
          )}
        >
          {deck.name}
        </span>
        {/* The bar, in words, for a reader who cannot see it — and **after the name**, which is
            the whole point of its being here rather than on the bar itself. `deckColorsLabel` is
            the one definition the two share, so the picture and the sentence cannot come to name
            different colours. `null` exactly where the bar draws nothing.

            **What this button's name looks like under test is not what it sounds like.** An
            accessible name is its parts concatenated, and the separator between them comes from
            each part being block-level — a fact about the *stylesheet*. jsdom applies none, so it
            computes `ZooWhiteModern · 60 cards` where a browser says `Zoo White Modern · 60
            cards`; padding this string with spaces does not fix it either, because the algorithm
            trims each part before joining. (`ManaText`'s trailing space works because its spans
            are inline siblings, which is a different join.) So the test over this asserts the
            **anchor** and the DOM order rather than the whole sentence — `^Zoo` is exactly the
            thing that broke, and it breaks in jsdom too. This repo has the same class of failure
            recorded once already, where a `gap` between a label and its count computed to
            `Missing2`. */}
        {colorsLabel !== null && <span className="sr-only">{colorsLabel}</span>}
        {/* `Modern · Arena · 60 cards`, and `Modern · 60 cards` on a deck that has been given
            no platform. **The `Any` row is deliberately not drawn**: it is what every deck is
            born as, so printing it would put a word that says nothing on nearly every tile in
            the gallery — and this caption already truncates in a narrow column. A deck that
            *has* been pinned is the one worth marking, which is the same argument the theory
            badge above makes about the lists a deck keeps — a deck with only the one list wears
            none.

            **The bracket was a fourth segment here for one iteration and is a pill on the art
            now** — see the overlay below. What sent it there is this line's own weakness: it is
            the tile's least important line, it truncates from the end in a narrow column, and a
            fourth segment is the segment that goes. The three that are left all describe the
            *list* — what rules it is built to, where it is played, how big it is — where a
            bracket describes how strong it is, which is a different question and now has a
            different place to be asked in.

            **The truncation is the existing behaviour and is still correct.** The answer was
            never a shorter format name or a wider tile: the deck's name above this is what a
            reader is scanning, and the full string is a hover away on any surface that needs
            it. */}
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

      {/* The art's two marks — which lists this deck keeps, and what bracket it reads as — in one
          box that *is* the art.

          **Both stay outside the `<button>`, and that is the badge's own rule rather than a new
          one.** An accessible name is computed from a button's contents, so a mark inside it is
          read *before* the deck: the tile is named for its deck, and `getByRole("button", { name:
          /^Zoo/ })` is the assertion that catches it. What is new is only that there are two of
          them and that the badge has moved down to join the second.

          **The box is a sibling of the button and exactly the cover's box**: full tile width from
          the top, on {@link ART_ASPECT}, so its height resolves to the picture's height with
          nothing measured — no ref, no `ResizeObserver`, and no frame of disagreement. Both boxes
          are driven by the same grid track, so it stays exact at every stop on the zoom ladder,
          which a copied pixel height could not be. It has to be its own box because the art's
          bottom is *not* the tile's bottom — under the picture sit the colour band, the name and
          the caption, and a mark anchored to the `<li>`'s bottom would land on the caption.

          **Not `aria-hidden`, deliberately, and the design source says otherwise.** On the canvas
          both marks duplicated caption text, so hiding them was right there and is wrong here:
          the badge has always been announced, and the caption has *lost* the bracket, so this
          pill is now the only place the bracket is said at all. Hiding it would take a fact off
          the wall for a screen reader and leave it on for everybody else. A later reader
          comparing this against the canvas will want to "restore" the attribute — this paragraph
          is the answer.

          `pointer-events-none` on the wrapper, so a corner of the picture is not a dead spot, and
          the two marks inside inherit it rather than repeating it. That is also what settles the
          pill's hint: `pointer-events` inherits, so a tooltip bound in here could never open
          (`src/CLAUDE.md`), and the way `FoilOverlay` buys one back — `pointer-events-auto` on
          the mark itself — is not available to a mark that is a *sibling* of the button rather
          than a child of it. There the press still opens the card; here it would open nothing.
          The pill says its words in visible type anyway, which is exactly what the caption gave
          before it, so the hint would buy a sentence at the price of a hole in the picture. */}
      {(badge !== null || bracketLabel !== null) && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0"
          style={{ aspectRatio: ART_ASPECT }}
        >
          {/* That this deck keeps a plan. Absent on a deck with one list — {@link deckBadge}
              argues why. */}
          {badge !== null && (
            <span
              className={cn(
                TILE_MARK,
                "left-[calc(0.375rem*var(--mark-scale,1))]",
                // Dashed means provisional, here as on a folder card: a theory list is a plan.
                badge === "THEORY ONLY" && "border-dashed",
              )}
            >
              {badge}
            </span>
          )}
          {/* What the deck reads as, in the opposite corner of the same edge — one mark for what
              the deck *is* and one for how strong it is, which is the pair a reader browses a
              wall by.

              **Never dashed, and that is the one thing it does not take from the badge.** The
              dash means provisional — a plan, a container, something not yet standing for itself
              — and a bracket is an estimate, which is a different word: it is the deck's real
              strength as the cards read today, not a strength the deck intends to have.

              **`null` draws nothing, exactly as the caption's segment did.** It covers both "this
              format has no command zone" and "nothing has answered yet", and the two are treated
              alike on purpose — neither is a fact about the deck worth a mark, and a placeholder
              for the second would be a pill that appeared a beat after the wall did. Never
              `Bracket ?`, never a skeleton, never a dash.

              `uppercase` rather than a second string: the words are {@link bracketLabel}'s and
              the page's, the shape is the tile's. */}
          {bracketLabel !== null && (
            <span className={cn(TILE_MARK, "right-[calc(0.375rem*var(--mark-scale,1))] uppercase")}>
              {bracketLabel}
            </span>
          )}
        </div>
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
 * **One thing changes what this frame should be painting, and it changes the URL.** Picking a
 * different card hands this component a different {@link coverUrl}, which is the reset the retry
 * hook does and the key `CardImage` puts on its own `<img>` — so nothing about staleness is
 * written here.
 *
 * **It took a `key` until 2026-08-31, and the reason it needed one is the reason the feature is
 * gone.** A cover could be a picture the reader had chosen off disk, served at `/cover/<deckId>`
 * — a route naming the *deck* rather than the picture, with `images.ts` forbidding a
 * cache-buster on it. Replacing that file therefore changed no URL at all, and the `no-store`
 * the route was served with never got a say: a header decides what happens to a *request*, and a
 * browser with no reason to make one goes on painting the frame it already decoded. So the
 * custom arm was keyed on `deck.updatedAt`, which every write to a deck moves — a whole-second
 * floor, since `decks.updated_at` is `unixepoch()`, so two uploads inside one clock second left
 * the element in place. This screen was where it bit: `DeckSettingsDialog`, the surface that
 * uploaded a cover, is mounted right here over this wall. Every line of that is now unreachable,
 * because a printing's URL names its own picture.
 *
 * **The card-art arm deliberately took no key even then**, and that is what survives: `updatedAt`
 * moves for very nearly every write to the deck — a rename does, and `deck_set_view_state` is
 * the one that deliberately does not, because reading a deck is not editing it — so keying it
 * would throw away a crop the browser has already decoded and leave the tile blank while it came
 * back, for a rename.
 *
 * ## The bottom corners, which belong to whatever is under the picture
 *
 * **`rounded-t-lg` and never all four**, because {@link DeckColorBar} is always under this crop.
 * The band is a 20px solid fused to the bottom edge, so for the two to read as one object the
 * crop stops rounding the edge they share.
 *
 * **It was conditional for one day and the condition is gone** (2026-09-08). The band used to
 * draw nothing for a deck with no pips, so this frame took a `fused` prop off `hasColorBar` and
 * kept all four of its corners when it was on its own — which was right about the *corners* and
 * wrong about the wall: a bandless tile stood 20px shorter than its neighbours, and in a grid of
 * stretched cells that put one tile's name and caption out of line with the row. The band now
 * always draws, empty where there is nothing to say, so there is no case left where this crop has
 * nothing under it and no question for a call site to answer. `DeckColorBar`'s own head carries
 * the argument.
 *
 * ## The illustrator's name, which is this frame's since 2026-09-07
 *
 * **It is a tooltip on the picture now, where it was a line of text under the tile — and this is
 * a policy question rather than a tidy-up.** The rule is Scryfall's, it is a *must*, and where it
 * lives is worth stating because **nothing in this repo named a URL for it before 2026-09-07** —
 * this file said "Scryfall's image policy" and left a reader to find it. The obvious page to look
 * on is `docs/api/images`, and it is **not** on it. The Card Imagery page carries no artist rule at
 * all any more — it is a table of image variants and their statuses, and the word "artist" does
 * not appear on it. The rule is on `https://scryfall.com/docs/api`, under *"When using images
 * from Scryfall, you must adhere to the following guidelines"*, and reads verbatim (fetched live
 * 2026-09-07):
 *
 * > When using the art_crop, list the artist name and copyright elsewhere in the same interface
 * > presenting the art crop, or use the full card image elsewhere in the same interface.
 * >
 * > Users should be able to identify the artist and source of the image somehow.
 *
 * So it is satisfied two ways, and neither of them is "a permanent line under every tile". The
 * gallery draws `art` crops and shows no full card image anywhere, so it has to take the first
 * arm: **the artist has to stay reachable here.** The tooltip is that, and it satisfies
 * *somehow* more directly than the line did — the name is on the picture it belongs to, which is
 * where a reader who wants to know who painted it points, rather than under a different element
 * of the tile.
 *
 * **Always shown, never `whenClipped`.** That option opens a tooltip only when the anchor's own
 * text is genuinely cut off, which is exactly right for a truncating cell repeating itself and
 * exactly wrong here: there is no text in this frame to clip, so a `whenClipped` binding would
 * open for nobody and the name would be unreachable on every tile in the gallery. The credit is
 * the one hint on this tile that is not a convenience.
 *
 * **`describes` is left at its default, where the four controls in the tray pass
 * `describes: false`.** Those already say their words in an `aria-label`, so a description would
 * be the same sentence twice; this frame says the artist nowhere else, and the guideline asks
 * that a reader be able to identify them *somehow*. The `alt` stays empty — the crop is
 * decorative, the deck's name is two lines down, and putting the illustrator into the tile's
 * accessible name would announce a painter before the deck on every tile on the wall.
 */
function Cover({ deck }: { deck: DeckRow }) {
  const tip = useTooltip();
  const url = coverUrl(deck);
  // Not `url === null`: on web those are two different states — see {@link hasCover}.
  const chosen = hasCover(deck);
  const image = useImageRetry(url);

  return (
    <span
      // `null` binds nothing — `useTooltip` refuses falsy content — so a deck with no artist to
      // credit is a frame with no hint, which is the same silence {@link coverUrl} answers with
      // for the picture itself. The two cannot come apart: they are one test on one field.
      {...tip(deck.coverArtist && `Art by ${deck.coverArtist}`)}
      className={cn(
        "grid w-full place-items-center overflow-hidden bg-surface",
        // The join rather than a decoration: a rounded corner over a square band is a picture
        // sitting *on* something, and the two are meant to be one object. Unconditional, because
        // the band always draws — see the note above the component. `overflow-hidden` above is
        // what makes it reach the crop as well as the frame.
        "rounded-t-lg",
      )}
      style={{ aspectRatio: ART_ASPECT }}
    >
      {image.src ? (
        <CardImage
          // Decorative: the deck's name is in the caption two lines down, and an `alt` here
          // would announce the tile twice.
          alt=""
          // No `key` of this component's own: `CardImage` keys itself on the `src`, which is
          // the whole answer for a card cover, because a different printing is a different URL.
          // See the note above the component for the key this had while a cover could be a file.
          src={image.src}
          loading="lazy"
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
          {!chosen ? "No cover" : image.retrying ? "Retrying…" : "No image"}
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
        // No focus outline: a landing pad, not a control — `tabIndex={-1}` only so the caret has
        // somewhere to go while the confirmation is open, and neither Tab nor an arrow reaches
        // it. Its two buttons keep theirs. `src/lib/focus.ts` has the rule.
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
