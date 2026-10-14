import { memo, type RefObject } from "react";
import {
  ChevronLeft,
  Columns3Cog,
  Fish,
  History,
  Scale,
  SquareArrowRightEnter,
  SquareArrowRightExit,
  Tag,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { FILTER_FOCUS } from "@/components/FilterChips";
import { ShareFolderMenu, type ShareTarget } from "@/features/collection/ShareFolderMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import type { DeckVariant } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { layerMatches, type Layer } from "./DeckEditorLayers";
import { DeckNameField } from "./DeckNameField";
import { PLAIN_PRESS } from "./headerControls";

/*
 * **The first of the deck header's three lines** — the way back, the deck's name, and everything
 * that can be done to the deck — moved out of `DeckEditor.tsx` with its constants and every word
 * of their argument (issue #557). The second line is `DeckLedger` and the third is the toolbar,
 * which is `DeckDesk`'s because the toolbar is where the desk's own state is set.
 *
 * **Memoised, and that is the point of the move rather than a side effect of it.** Before the
 * split, one keystroke in the deck's filter re-rendered this line with everything else in the
 * editor. The filter is `DeckDesk`'s state now, so a keystroke never reaches the editor at all;
 * and every prop here is held still by the editor, so a render of the editor that changed nothing
 * on this line — a write settling, the stats band toggling — does not draw it again either.
 */

/**
 * The header's dialog buttons, each carrying the layer it opens.
 *
 * It used to carry a `kind` per row, which stopped being enough when `export` grew a payload: the
 * header exports the **whole deck** (`categoryId: null`) and a category heading exports one pile,
 * and both are the same layer kind.
 *
 * **"Import cards" and not "Import"**, which is what it said for one test run: the dialog it
 * opens carries a control called `Import`, and two buttons with one name on screen at once is a
 * pair a screen reader can only tell apart by position. It names what it puts in the deck, the
 * way the gallery's `Import deck` names what it makes. **"Export deck" and not "Export cards"**
 * for the mirror of that reason — the category menu's row is already called `Export cards…`, so
 * this one names its scope instead.
 *
 * **Two buttons where there was one called "Categories & tags"** — the title it carried while
 * a label was called a tag. The piles and the labels were two sections of one drawer, so
 * reaching the second cost a press and a scroll; they are two
 * dialogs now, each one press away and each sized for what it draws. The ampersand went with the
 * split — a control named for two things is a control that can only ever be right about one of
 * them.
 *
 * **Every row here costs width on a row that already wraps.** This block measured **825px** at
 * 1280×800 against the ~729 the ribbon can spare (2026-08-14, a debug build) with five buttons on
 * it; `Export deck` was the sixth and the figure was never re-measured.
 *
 * **What answered that measurement is the 2026-08-24 header** rather than a seventh argument about
 * wording. Six words became six glyphs with a word beside each: the two transfer buttons moved
 * into {@link TRANSFER}'s joined pair, the four that are left carry an icon, and each word is
 * dropped — never the control — as the column narrows (see {@link TIGHT_HEADER_PX}). Two selects
 * went with it, `Deck game` and `Deck format`, whose questions were already asked in Deck settings
 * and whose only job here was to be read; the ledger line below says which format the deck is on.
 * The row still wraps rather than overflows, and every control is reachable at every width —
 * nothing here is ever put behind a menu.
 */
export interface HeaderAction {
  layer: NonNullable<Layer>;
  /** The accessible name, the tooltip, and — for {@link ACTIONS} — the word on the button. */
  label: string;
  Icon: LucideIcon;
}

/**
 * The two transfer buttons, drawn as one joined pair.
 *
 * **A pair rather than two loose buttons, because they are one idea read in two directions** —
 * cards into this deck, this deck out to a file — and joining them says so in the width of one
 * control and a hairline. The glyphs are lucide's own mirror pair, so the direction is the
 * picture rather than a word the reader has to find.
 *
 * **The visible word is shorter than the name, deliberately and legally.** `Import` and `Export`
 * are each contained in the accessible name beside them, which is what WCAG 2.5.3 asks for, and
 * the names are the ones {@link ACTIONS}' own doc argues at length. Both words disappear below
 * {@link WIDE_HEADER_PX}, where the buttons are their glyphs and the name is the tooltip.
 */
export const TRANSFER: readonly HeaderAction[] = [
  { layer: { kind: "import" }, label: "Import cards", Icon: SquareArrowRightEnter },
  { layer: { kind: "export", categoryId: null }, label: "Export deck", Icon: SquareArrowRightExit },
];

export const ACTIONS: readonly HeaderAction[] = [
  { layer: { kind: "categories" }, label: "Categories", Icon: Columns3Cog },
  { layer: { kind: "labels" }, label: "Labels", Icon: Tag },
  { layer: { kind: "history" }, label: "History", Icon: History },
  { layer: { kind: "settings" }, label: "Deck settings", Icon: Wrench },
];

/**
 * The three widths this header reasons about, measured on **the editor column** rather than on
 * the window — which is what `deskWidth` already is (see the observer that sets it), so nothing
 * new is measured and nothing new re-renders.
 *
 * The numbers are the column a window leaves once the sidebar, the shell's padding and the page
 * scrollbar are taken off: **1017** at the app's own 1280x800 with the rail expanded, 1157 with
 * it collapsed, 1657 at 1920, and **761** at the narrowest window the shell reasons about. So
 * {@link SETTINGS_ICON_PX} sits above the app's default and below the collapsed-rail width — the
 * longest word in the row, `Deck settings`, is the first to go — and {@link TIGHT_HEADER_PX} sits
 * between 761 and the default, which is where every remaining word goes and the toolbar splits in
 * two. {@link WIDE_HEADER_PX} is above 1157: `Import` and `Export` say themselves only where
 * there is room to spare.
 *
 * **Zero means unmeasured and reads as the middle**, which is `roomForPanel`'s convention one row
 * up: the first paint of a wide window must not flash a narrow header, and jsdom — which lays
 * nothing out and whose `ResizeObserver` never fires — draws the state every test is written
 * against.
 *
 * **Three rungs and not four, re-asked at a phone width on 2026-08-29** (with
 * {@link panelOverWidth}) and deliberately left where they are. A 390px window is a ~350px desk,
 * which is under {@link TIGHT_HEADER_PX} — so the ladder is already at its bottom rung there and
 * every word in the row has gone. A fourth rung could only drop **controls**, and which of the
 * six actions a deck may be edited without is a different question from which of them has room
 * for its word: the first is about what the header *holds* and belongs with whatever decides
 * what the ribbon sheds, and the second is what this ladder is. The row is `flex-wrap`, so what
 * a narrow desk costs is height rather than an overhang.
 */
export const WIDE_HEADER_PX = 1400;
export const SETTINGS_ICON_PX = 1100;
export const TIGHT_HEADER_PX = 900;

export interface DeckEditorHeaderProps {
  /** The header's first control — where the bar's ↥ puts the caret back. */
  backRef: RefObject<HTMLButtonElement | null>;
  /** Close the deck: `Back to decks`, and Escape's floor beside it. */
  closeDeck: () => void;
  /** The deck's name, or `null` before `deck_get` has answered — the line is then the back
   *  button alone. */
  name: string | null;
  renameDeck: (name: string) => void;
  theoryEnabled: boolean;
  variant: DeckVariant;
  pickVariant: (next: DeckVariant) => void;
  layer: Layer;
  openLayer: (next: NonNullable<Layer>, handBack: (() => void) | null) => void;
  tightHeader: boolean;
  wideHeader: boolean;
  settingsIcon: boolean;
  /**
   * Deal this list onto the goldfish board — a game against a target that does nothing, on the
   * desktop's rules engine. **Absent where the edition has no Playtesting** (the light app's phone
   * and browser faces, whose hosts have no engine), and then there is no button.
   */
  openGoldfish?: () => void;
  /**
   * What the Share control publishes — {@link deckShareTarget}'s answer (issue #1032), held still
   * by the editor so this memoised header is not redrawn for it. `null` draws no Share half.
   */
  share?: ShareTarget | null;
}

export const DeckEditorHeader = memo(function DeckEditorHeader({
  backRef,
  closeDeck,
  name,
  renameDeck,
  theoryEnabled,
  variant,
  pickVariant,
  layer,
  openLayer,
  tightHeader,
  wideHeader,
  settingsIcon,
  openGoldfish,
  share = null,
}: DeckEditorHeaderProps) {
  const tip = useTooltip();
  return (
    <>
      {/**
       * The deck's own ribbon, and the `py-1.5` on it is load-bearing rather than spacing.
       *
       * This row is the **first child of the page scroller** — the `section` above is
       * `overflow-y-auto` — and the name field's focus ring is `outline-2 outline-offset-2`,
       * so it stands **4px proud of the field on every side**. With no padding here the field
       * is vertically centred in a row whose tallest child is the 36px back button, which puts
       * the top of that ring outside the scroller's padding box: a scroll container clips
       * there, and what is left of it runs into the shell's mana line above. Six pixels is the
       * ring's four and two to spare, top and bottom.
       *
       * **Vertical only.** Horizontal padding here would indent the back button and the deck's
       * actions past the toolbar row beneath them and past the deck itself, and the ring has
       * room on that axis already — `gap-x-3` is 12px either side of the field's box, which is
       * three times what the ring asks for.
       *
       * **Three lines since 2026-08-24, and this is the first of them**: what the deck is and
       * what can be done to it, then the ledger of what it adds up to, then the toolbar that
       * decides how it is drawn. The two selects that used to sit at the right of this row are
       * gone — see {@link ACTIONS}.
       */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 py-1.5">
        <button
          ref={backRef}
          type="button"
          // {@link closeDeck}, shared with Escape's `"navigation"` rung — one act, one function,
          // so the key and the button can never come to mean different things.
          onClick={closeDeck}
          aria-label="Back to decks"
          // The words go and the chevron stays, at the width where every other word on the row
          // goes. The tooltip is bound only then, for the reason it is bound at all: at any
          // other width it would repeat the word printed beside it.
          {...(tightHeader ? tip("Back to decks", { describes: false }) : {})}
          className={cn(
            "inline-flex h-9 shrink-0 items-center rounded-md text-sm text-dim",
            tightHeader ? "w-9 justify-center px-0" : "gap-1 px-2",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
          {!tightHeader && "Decks"}
        </button>

        {name !== null && (
          <>
            {/* The document's heading for this state of the view. Drawn as the field beside it
                rather than twice — the ribbon's `h1` says "Decks", and this says which one. */}
            <h2 className="sr-only">{name}</h2>
            {/**
             * The deck's name, and it is the row's one flexible child.
             *
             * **The wrapper that used to hold it is gone** (2026-08-24). It grouped the field
             * with the Theory/Actual switch and the Compare button, which was right while those
             * three were the row's left-hand half; both of them are in the actions block now, so
             * the group had one child left. The field is therefore the flex item this row's
             * layout was always about.
             *
             * **`flex-wrap` and a floor on the field, because this row overflowed in the shipped
             * window and no test could see it.** Measured over CDP with Theory on: the field was
             * the only shrinkable child between two `shrink-0` siblings, so it collapsed to its
             * intrinsic minimum — **18px at 1100, 1200 and 1280** — while the switch and the
             * control beside it spilled 180px / 80px out of this box and over the actions. At
             * 1200 the last pixels of that control (a "N cards differ" readout then, the
             * Compare button since) hit-tested to the *format select*: a reader aiming at the
             * difference re-formatted their deck.
             *
             * So the narrowest things yield first. The field keeps its own floor
             * (`NAME_FLOOR`, in {@link DeckNameField}) and the actions block wraps to a second
             * line when it no longer fits beside it; nothing overlaps at any width, because
             * nothing is squeezed past its own content any more.
             *
             * **The field is the bare `<input>` this box's flex layout expects**, which is why
             * {@link DeckNameField} draws no wrapper of its own — see it.
             */}
            <DeckNameField name={name} onRename={renameDeck} />

            {/**
             * Everything that can be done to this deck, in one block against the right edge.
             *
             * **`ml-auto` and `flex-nowrap`, which is the reverse of what this block used to
             * carry and is safe for a reason the old shape did not have.** It was
             * `flex-wrap justify-end` and deliberately shrinkable, because `shrink-0` on it had
             * pinned it at its max-content width — **692px, at every window size** — and every
             * pixel of the squeeze fell on the deck's name. What has changed is that the block
             * now gives width back *itself*: the four labelled buttons drop to their icons, and
             * `Deck settings` goes first (see {@link SETTINGS_ICON_PX}). So it is a fixed run
             * whose fixed width is a function of the column, and the outer row's `flex-wrap` is
             * what catches the width below which even the narrow run does not fit — the whole
             * block folds to a line of its own rather than crushing the name.
             */}
            <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-2">
              {/* Only for a deck that keeps a plan. A two-way switch over a deck with one list
                  is a control whose other half is empty by construction — the way to get one is
                  Deck settings, where the toggle that creates it lives. The same condition covers
                  `Compare` beside it, which weighs exactly the two lists this switch chooses
                  between and is meaningless to a deck that has one. */}
              {theoryEnabled && (
                <>
                  <div
                    role="group"
                    aria-label="Deck list"
                    className="flex shrink-0 overflow-hidden rounded-md border border-border"
                  >
                    {/* The words are written out rather than `capitalize`d off the value, for
                        WCAG 2.5.3's reason read the other way: `text-transform` changes what is
                        drawn and not what the control is *called*, so a `capitalize` switch is
                        one a reader sees as "Actual" and voice control has to be asked for as
                        "actual". Which is doubly true now that the word is not the value: the
                        variant is still `live` in the database, in the IPC and in every URL this
                        app keeps — `Actual` is the *name*, and renaming a stored value to match a
                        label would be a migration bought with nothing. */}
                    {/* **Theory first, Actual second** (2026-08-26, the reader's call), which
                        reverses the order argued here on 2026-08-24 and restores the one before
                        it: the plan is the list a deck is *built* in, so it is the one the eye
                        should land on first, and the live list is what the plan has become so far.
                        **Nothing about which tab is pressed, remembered or restored is decided
                        here** — that is `lastVariant`'s doing, and it survived the last flip of
                        this order untouched for the reason it survives this one: the write that
                        turns the switch on moves the deck into theory and leaves it there, so the
                        reader arrives on the tab their cards are now under whichever end of the
                        group it is painted at. This is the order the two words are painted in,
                        and no more than that.

                        **No hairline between them, unlike {@link TRANSFER}'s pair.** One of these
                        two is always pressed — a deck is showing one of its lists or the other —
                        so the filled half's own edge is the divider, and a border drawn on top of
                        it would be a second line saying the same thing. The pair needed one while
                        `Compare` sat between them and carried it; it does not now. */}
                    {(
                      [
                        { id: "theory", label: "Theory" },
                        { id: "live", label: "Actual" },
                      ] as const
                    ).map(({ id, label }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => pickVariant(id)}
                        aria-pressed={variant === id}
                        className={cn(
                          // 36px like every other press in this ribbon — the back button and
                          // {@link PLAIN_PRESS}. At 28px this segmented pair was the shortest thing
                          // in the row by eight pixels and read as a secondary control, which is
                          // the opposite of what it is: it says which of the deck's two lists is
                          // on screen.
                          "h-9 px-2.5 text-xs",
                          "transition-colors duration-150 motion-reduce:transition-none",
                          variant === id
                            ? "bg-accent font-medium text-accent-fg"
                            : "text-dim hover:text-text",
                          FOCUS,
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/**
                   * **Beside the switch, not inside it** (2026-08-26, the reader's call).
                   *
                   * It was a third segment between the two words from 2026-08-24 — a verb between
                   * two nouns, on a row that had no width for a third label — and what that shape
                   * got wrong is that `Compare` is not one of the deck's two lists. The group is a
                   * two-way switch named `Deck list`, and a press inside it that answers a
                   * different question is a press a reader has to learn is not a third list. Out
                   * here it is what it is: an action about both lists, standing next to them.
                   *
                   * **The row's own `gap-2` is the whole of the spacing decision** — it is a
                   * sibling of the switch and of {@link TRANSFER}'s pair in the same flex line, so
                   * it sits at the same distance from its neighbours as everything else on the
                   * row, and nothing here says otherwise.
                   *
                   * The word is back with it, because a button outside the group has no adjacent
                   * nouns to lean on. It gives way at {@link TIGHT_HEADER_PX} exactly as
                   * {@link ACTIONS}' words do — the word goes, never the control — and the tooltip
                   * is bound exactly when the word is not there to be read. The scales are
                   * lucide's `Scale`: two things weighed against each other.
                   */}
                  <button
                    type="button"
                    onClick={(e) => {
                      const trigger = e.currentTarget;
                      openLayer({ kind: "theoryDiff" }, () => trigger.focus());
                    }}
                    aria-expanded={layer?.kind === "theoryDiff"}
                    aria-haspopup="dialog"
                    aria-label="Compare"
                    {...(tightHeader ? tip("Compare", { describes: false }) : {})}
                    className={cn(
                      PLAIN_PRESS,
                      FILTER_FOCUS,
                      "inline-flex shrink-0 items-center justify-center whitespace-nowrap",
                      tightHeader ? "w-9 px-0" : "gap-1.5",
                      "hover:text-text",
                    )}
                  >
                    <Scale className="size-4 shrink-0" aria-hidden="true" />
                    {!tightHeader && "Compare"}
                  </button>
                </>
              )}

              {/* **Goldfish** — the board, dealt from the list on screen. Ahead of the transfer
                  pair: it is the one action here that is about *playing* the deck rather than
                  filing it. Not a layer: it leaves the editor for the board, as Back leaves it
                  for the gallery. **An icon button at every width**, the fish alone (the
                  owner's call, 2026-10-12) — so its name is the tooltip, always bound, as the
                  other actions bind theirs once their words have gone. */}
              {openGoldfish !== undefined && (
                <button
                  type="button"
                  onClick={openGoldfish}
                  aria-label="Goldfish this deck"
                  {...tip("Goldfish this deck", { describes: false })}
                  className={cn(
                    PLAIN_PRESS,
                    FILTER_FOCUS,
                    "inline-flex w-9 shrink-0 items-center justify-center px-0",
                    "hover:text-text",
                  )}
                >
                  <Fish className="size-4 shrink-0" aria-hidden="true" />
                </button>
              )}

              {/* The joined pair — see {@link TRANSFER}, which is where both names are argued
                  and where the widths they keep or lose are decided. */}
              <div
                role="group"
                aria-label="Import and export"
                className="flex shrink-0 overflow-hidden rounded-md border border-border bg-surface"
              >
                {TRANSFER.map(({ layer: target, label, Icon }, at) => (
                  <button
                    key={label}
                    type="button"
                    onClick={(e) => {
                      const trigger = e.currentTarget;
                      openLayer(target, () => trigger.focus());
                    }}
                    aria-expanded={layerMatches(layer, target)}
                    aria-haspopup="dialog"
                    aria-label={label}
                    {...(wideHeader ? {} : tip(label, { describes: false }))}
                    className={cn(
                      "inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap",
                      "text-xs text-dim",
                      at === 1 && "border-l border-border",
                      wideHeader ? "gap-1.5 px-2.5" : "w-9 px-0",
                      "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                      FOCUS,
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {wideHeader && label.split(" ")[0]}
                  </button>
                ))}
              </div>

              {/* **Share** (issue #1032) — publish this deck as a read-only link, update it, copy
                  it, withdraw it. The cabinets' own control, so a deck share is offered, refused
                  and receipted exactly as a binder's is: hidden for a reader who has connected
                  nothing, and with no *Open a shared collection* half here — that is the
                  cabinets' to offer, and this header is about the deck on screen. */}
              {share !== null && <ShareFolderMenu target={share} withOpen={false} />}

              {/* Each row carries the layer it opens rather than a kind — see {@link ACTIONS},
                  which is where every one of these buttons' names is argued. The word is what
                  gives way as the column narrows, never the control, and the tooltip is bound
                  exactly when the word is not there to be read. */}
              {ACTIONS.map(({ layer: target, label, Icon }) => {
                // `Deck settings` is the longest word in the row, so it is the first to go.
                const bare = tightHeader || (settingsIcon && target.kind === "settings");
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={(e) => {
                      const trigger = e.currentTarget;
                      openLayer(target, () => trigger.focus());
                    }}
                    aria-expanded={layerMatches(layer, target)}
                    aria-haspopup="dialog"
                    aria-label={label}
                    {...(bare ? tip(label, { describes: false }) : {})}
                    className={cn(
                      PLAIN_PRESS,
                      FILTER_FOCUS,
                      "inline-flex shrink-0 items-center justify-center whitespace-nowrap",
                      bare ? "w-9 px-0" : "gap-1.5",
                      "hover:text-text",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {!bare && label}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
});
