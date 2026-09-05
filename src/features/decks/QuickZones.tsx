import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { useDndDragging, useDndDropTarget, useDndTargetRef } from "@/lib/dndTarget";
import { FolderPlus, MoveRight, Plus, Wand2, type LucideIcon } from "lucide-react";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import type { DeckCategory } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/Dialog";
import {
  dropWrite,
  dropWrites,
  readDragData,
  readDragGroup,
  type DeckWrite,
  type DragPayload,
  type DropTarget,
} from "./dnd";
import { META_FIELD, META_SUBMIT } from "./metaRows";

/**
 * The DOM contract one quick zone carries — its label, on the box a card is let go over.
 *
 * The same kind of thing as `DECK_CARD_ATTR` in `dnd.ts` and `DECK_GROUP_ATTR` in
 * `cardControl.tsx`, and here for a reason of its own: the bar is `aria-hidden`, so it has
 * no role and no accessible name to address it by — and **two of the four labels are also
 * headings on the desk behind it**, so a text query would be ambiguous exactly where it matters.
 * A live pass and a test both need one box rather than "one of the two things called Sideboard".
 */
export const QUICK_ZONE_ATTR = "data-quick-zone";

/**
 * The four destinations a card can be thrown at without aiming — drawn across the top of the
 * deck for the length of a drag, and at no other time.
 *
 * **They are the remove tray's twin, and the pairing is the design.** That tray is
 * `sticky bottom-0` while a card is in the air; this is `sticky top-0`, so the two ends of the
 * reader's window are the two things a drag can mean without hunting for a column: *file it* at
 * the top, *take it out* at the bottom. Everything between them is the deck itself, where a drop
 * means the pile it landed on.
 *
 * ## Why this owns its own monitor rather than reading `PriceStrip`'s
 *
 * `PriceStrip` already tracks a drag — `dragging`, which the tray is drawn from — and it is
 * narrowed by `canMonitor` to the deck's **own** cards, with the reason written at the site: a
 * monitor that answered for the docked panel's tiles would re-render the strip — and, while that
 * monitor lived in `DeckEditor`, the panel and the very tile the reader has hold of — in the
 * middle of the drag.
 *
 * These zones have to answer for exactly the drags that monitor refuses — a card arriving from
 * the search panel is the whole point of an `Auto` zone — so widening it was not available. A
 * component of its own with a monitor of its own re-renders **itself** when a drag starts and
 * leaves both the strip and the editor untouched, which keeps that rule true rather than working
 * around it.
 *
 * ## Layout: zero height, so nothing moves when it appears
 *
 * The wrapper is `h-0 -mb-3` and the bar inside it is absolutely positioned, which is the same
 * care the remove tray takes and for the same reason — *"appearing in the flow would push every
 * pile up by its own height at the exact moment the reader is aiming at one"*. The `-mb-3`
 * cancels the editor column's own `gap-3`: a zero-height flex item still gets a gap after it, so
 * without the negative margin the whole deck would drop 12px on `dragstart`. Net zero, whether
 * this is mounted or not — which is what lets it be mounted only during a drag.
 *
 * **`sticky` rather than `fixed`, and that is not a shortcut.** A `fixed` box is laid out against
 * the window, so it would have to be told where the shell's 208px sidebar ends and the page's own
 * padding begins — a number this feature does not own — or be positioned from a measured rect,
 * which is the one thing `src/CLAUDE.md` names a trap (`clientWidth` against `innerWidth`, and
 * jsdom answering `0` to both). In the flow the browser answers instead, and the bar is the
 * editor's width at every window size for free. To the reader it is still pinned near the top of
 * the screen: the editor **is** the page scroller, so `top-0` is the top of what they can see.
 *
 * **It clears the deck, and that was measured rather than estimated.** Driven in the shipped
 * window 2026-08-15 (`npm run tauri dev`, a debug build): the bar was **58px** tall and sat over
 * the editor's own header row, clearing the desk row by **155px** at 1280×800 and by **65px** at
 * 1920×1080 — the difference being that the header wraps to two lines at 1280 and does not at
 * 1920. So nothing it draws sits over a pile a reader is aiming at. Scrolled, the deck passes
 * under it, which is what "pinned near the top" means and is the same bargain the tray strikes at
 * the other end. The zero-height claim was measured on the same pass: with a card in the air the
 * header row and the first card were at **exactly** the coordinates they held before the drag
 * started (78 and 341.5), and with the editor scrolled to 500 the header row had gone to **−422**
 * while the bar stayed at 78.
 *
 * **The bar is 92px since 2026-08-18, and the number is the ribbon's rather than its own.** It
 * grew 58 → 74 on 2026-08-17 (the box went `h-10` → `h-14`, to stop being missed) and 74 → 92
 * now, which is the height of the deck's name/settings row it lands on — the thing it is drawn
 * *instead of*. At 74 it covered all but the last **18px** of that row, so a strip of the
 * ribbon's second line sat under a bar that was plainly meant to replace it. Both figures are
 * from the shipped window on 2026-08-18 (`npm run tauri dev`, a debug build, 1280×800): row and
 * bar start at the same y=78, the row measured **92** and the bar **74**.
 *
 * The wrapper is `h-0` and the desk row therefore does not move, so the growth comes off the gap
 * under the bar and that arithmetic is exact rather than a second estimate: the two clearances
 * are **121px** at 1280×800 and **29px** at 1920×1080. **29px is the figure to watch**, and it
 * is smaller than it sounds — the row the bar overhangs at 1920 is the *toolbar*, not a pile,
 * because the ribbon is one line at that width and 92px is two. It has overhung it since the
 * bar was 74 (by 14px, now 32), and a toolbar is not a thing a hand mid-drag can use anyway.
 * Every pile is still clear at both sizes, which is the claim that matters.
 *
 * `aria-hidden`, exactly as the tray is: this is chrome for a gesture only a pointer can make,
 * and every one of the four has a click path a caret can reach — the toolbar's `Add to` select
 * (which is where `Auto` comes from), the card's right-click `Move to`, and the Categories
 * dialog's own New category field.
 */
export function QuickZones({
  categories,
  onDrop,
  onNewCategory,
}: {
  /** Every category the deck has, in the reader's own order — `DeckEditor`'s `categories`, not
   *  the drawn groups. Only the two fixed zones are read out of it. */
  categories: readonly DeckCategory[];
  /** What a drop writes. `DeckEditor`'s `applyDrop`, which is stable — see it. */
  onDrop: (writes: DeckWrite[]) => void;
  /**
   * The card was thrown at **New category**, and the drag is over.
   *
   * The name has to be asked for, and a modal cannot be opened mid-gesture — the platform owns
   * the pointer until the drop — so this fires on the drop and the dialog opens after it. The
   * payload travels because by then there is no drag left to read it from.
   */
  onNewCategory: (payload: DragPayload) => void;
}): ReactElement | null {
  /**
   * The card in the air, or `null`.
   *
   * **Every kind**, unlike `DeckEditor`'s — see this component's doc. It is what the zones are
   * drawn from *and* what decides which of them can take it, so the bar never offers a
   * destination that would refuse the card once it got there.
   */
  const dragging = useDndDragging(readDragData);

  if (!dragging) return null;

  return (
    <div
      aria-hidden="true"
      className={cn(
        // Zero height and the gap after it cancelled — see this component's doc. `top-0` is the
        // editor's own scrollport, so the bar rides the top of whatever the reader can see
        // however far down the deck they have scrolled.
        //
        // **`left-0` because `sticky` pins only the axes it is given an inset for, and this
        // scroller really does have two.** `DeckEditor`'s page section is `overflow-y-auto`,
        // which computes `overflow-x` to `auto` as well — and it is not theoretical: measured
        // 2026-08-15 in the shipped window, the editor overflows horizontally by a constant
        // **66px** at 1024 *and* at 1920, from a toolbar `<select>` that hangs past the row. With
        // `top-0` alone the bar scrolled sideways with the content (seen at 1024: bar left
        // **162** against the editor's **228** after the drag's own auto-scroller ran right), and
        // a drop target the pointer is being carried to must not slide out from under it. Free
        // where nothing overflows: `scrollLeft` is 0, so the natural position already satisfies
        // it.
        "sticky top-0 left-0 -mb-3 h-0",
        // The rung the remove tray is on, and for its reason: a drag can start while a select or
        // a menu is open, and these are the targets the pointer is being carried to.
        LAYER.dragTray,
      )}
    >
      <div className="absolute inset-x-0 top-0">
        <QuickZoneBar
          payload={dragging}
          categories={categories}
          onDrop={onDrop}
          onNewCategory={onNewCategory}
        />
      </div>
    </div>
  );
}

/**
 * The bar itself — four boxes, drawn for one particular card in the air.
 *
 * Split from {@link QuickZones} so the workbench can stand it beside every payload at once: the
 * component above is a monitor and a `sticky` box, and a story cannot hold a drag open at the end
 * of a `play` (every drag has to be let go of, or pdnd's one global flag leaks into the next
 * story). Nothing but the story files and {@link QuickZones} renders this.
 */
export function QuickZoneBar({
  payload,
  categories,
  onDrop,
  onNewCategory,
}: {
  /** The card in the air. Not nullable — a bar with no card is not a state this draws. */
  payload: DragPayload;
  categories: readonly DeckCategory[];
  onDrop: (writes: DeckWrite[]) => void;
  onNewCategory: (payload: DragPayload) => void;
}): ReactElement {
  const maybeboard = categories.find((c) => c.kind === "maybe");
  const sideboard = categories.find((c) => c.kind === "side");

  /**
   * A drop that adds says `+`; one that moves says `→`.
   *
   * A fact about the *card*, not about the zone: a printing off a wall is added by all four and a
   * row of this deck is moved by all four, so the glyph is computed once. The reference this was
   * drawn from puts a `+` on every zone, which is right for the drag it was drawn during and a
   * lie during the other one.
   */
  const Arrow = payload.kind === "deck-card" ? MoveRight : Plus;

  const zoneFor = (label: string, target: DropTarget, icon: LucideIcon = Arrow): Zone => ({
    label,
    icon,
    takes: dropWrite(payload, target) !== null,
    // The rule, asked twice — once here so a zone that would mean nothing never lights up and
    // never accepts the card, and again on the drop itself, because the two questions can be a
    // second apart and only the second one writes. `cardControl.tsx`'s `useCategoryDrop` says the
    // same thing about a pile.
    // `held` rather than the `payload` above it, and the difference is the point: that one is
    // what this render was drawn for, and this is what the library is holding *now*.
    accepts: (data) => dropWrites(readDragGroup(data), target).length > 0,
    drop: (data) => {
      // Every card the drag was carrying — `dropWrites`' rule that a mixed set is not refused
      // whole, so four deck rows and one search tile dropped on `Auto` file the four and pass
      // over the fifth rather than failing for a reason nothing on screen names.
      const writes = dropWrites(readDragGroup(data), target);
      if (writes.length > 0) onDrop(writes);
    },
  });

  /** A fixed zone the deck somehow has not got. Drawn and refused rather than left out: the four
   *  are seeded with every deck, so a gap here is a database nobody expects — and a bar that
   *  changed shape between decks would be a worse way to say so than a greyed box. */
  const missing = (label: string): Zone => ({
    label,
    icon: Arrow,
    takes: false,
    accepts: () => false,
    drop: () => {},
  });

  const zones: Zone[] = [
    // `Wand2` rather than the shared glyph: `Auto` is the one zone that does not name where the
    // card is going, because the card decides.
    zoneFor("Auto", { kind: "auto" }, Wand2),
    {
      label: "New category",
      icon: FolderPlus,
      // Every kind can start a pile: an add lands in it, and a card already in the deck moves
      // into it. There is no `DeckWrite` to resolve because nothing is written until the reader
      // has typed a name.
      takes: true,
      accepts: (data) => readDragData(data) !== null,
      drop: (data) => {
        const held = readDragData(data);
        if (held) onNewCategory(held);
      },
    },
    // The pile's **own name**, not the fixed word: the four seeded zones cannot be renamed, so
    // the two agree today — and the day one of them can be, a heading and a drop target reading
    // differently would be two names for one pile.
    maybeboard
      ? zoneFor(maybeboard.name, { kind: "category", categoryId: maybeboard.id })
      : missing("Maybeboard"),
    sideboard
      ? zoneFor(sideboard.name, { kind: "category", categoryId: sideboard.id })
      : missing("Sideboard"),
  ];

  return (
    <div
      className={cn(
        // **92px, because that is the ribbon it is drawn over.** The bar is `sticky top-0` in
        // the editor's own scroller, so at rest it lands exactly on the deck's name/settings
        // row — and that row is 92px at the app's own 1280×800: `py-1.5` either side of two
        // wrapped lines of 36px controls with `gap-y-2` between them (6 + 36 + 8 + 36 + 6).
        // At 74px the bar covered all but the last 18px of it, so a strip of the ribbon's
        // second line stayed showing under a box that was plainly meant to replace it.
        // Measured in the shipped window 2026-08-18 (`npm run tauri dev`, a debug build): row
        // and bar both start at y=78, the row is 92 and the bar was 74.
        //
        // **It does not follow the ribbon back down, and that is a decision rather than an
        // oversight.** The row wraps below **~1600px** — 92 at 1280, 1400 and 1500, 48 at 1600
        // and every width above, all measured on the same pass — so a bar that matched it
        // everywhere would be 48px on a wide window, which leaves the boxes **30px**: shorter
        // than the 40px the reader reported as easy to miss, on the one surface that exists for
        // two seconds. So the height is fixed, and on a wide window the bar covers the one-line
        // ribbon and most of the toolbar row under it — a row no hand mid-drag can use anyway.
        // What it must never cover is a pile, and it does not: the desk row clears it by 29px
        // at 1920×1080 and by 121px at 1280×800.
        //
        // The height is on the bar and not on the boxes: they are `flex-1` in a row with no
        // `items-*`, so they stretch to whatever is left once the padding is taken off, and
        // the one number that has to agree with the ribbon is written once.
        "flex h-[5.75rem] rounded-lg border border-border bg-surface shadow-lg",
        // Horizontal only. `gap-3` between the boxes and `px-4` outside the outermost two —
        // four targets that touch each other and the bar's edge read as one banded block
        // rather than as four things to aim at. `py-2` is the old `p-2` left alone: the
        // vertical space belongs to the boxes, which is what "fills the ribbon" means.
        "gap-3 px-4 py-2",
        // **Centred, because the boxes stop growing before the bar does.** Each is capped at
        // 300px (see {@link QuickZone}), so on a wide window the four no longer fill the
        // editor's width and the leftover has to go somewhere: split evenly is the only place
        // that keeps the group under the reader's pointer, which arrives from the middle of the
        // deck rather than from either edge. Costs nothing where they still stretch — measured
        // 2026-08-18 at 1280×800, each box is 236.8px, well inside the cap, and `justify-center`
        // on a row with no slack left is a no-op.
        "justify-center",
      )}
    >
      {zones.map((zone) => (
        <QuickZone key={zone.label} {...zone} />
      ))}
    </div>
  );
}

/** One box in the bar, before it is drawn — what it says, whether the card in the air can land
 *  in it, and the two questions the drag library asks it. */
interface Zone {
  label: string;
  icon: LucideIcon;
  /** Whether the card currently in the air can land here — **the greying, and nothing else**.
   *  The refusal that decides is {@link Zone.accepts}, which the library asks. */
  takes: boolean;
  accepts: (data: Record<string, unknown>) => boolean;
  drop: (data: Record<string, unknown>) => void;
}

/**
 * One box in the bar.
 *
 * ## It is drawn to be found in a hurry, which it was not
 *
 * The reader's report was that the bar is easy to miss (2026-08-17), and the four things that made
 * it so were each individually defensible and wrong together: a **40px** box holding **12px**
 * `text-dim` type (`oklch(0.65)`) behind a **1px** dashed `border-border` hairline
 * (`oklch(0.30)`) filled `bg-bg` (`oklch(0.16)`). The label was the second-dimmest colour in the
 * palette, the outline was four hundredths of a step off the fill it enclosed, and all of it had
 * to be found **during a drag** — the one moment a reader is looking at the card under their
 * pointer rather than at the chrome, and the only moment this surface exists at all. A control
 * that appears for two seconds cannot also be quiet.
 *
 * So the box is **as tall as the bar leaves it** — 56px when that was fixed at `h-14`, **74px**
 * since the bar took the ribbon's own 92 and these became the stretch inside it (2026-08-18) —
 * the label is `text-sm font-medium` in **`text-text`** — the app's own
 * parchment, the same value as the deck's headings — and the outline is **2px of dashed
 * `border-dim`**, which is exactly the colour the *label* used to be. That inverts the hierarchy
 * on purpose: the reader now finds the box first and reads it second, which is the order a drop
 * target is used in. **Dashed rather than solid, still**, because a dashed edge is what says
 * *let go here* rather than *press me* — the same reason it was dashed when it was a hairline —
 * and 2px is what makes that reading survive at arm's length.
 *
 * **The one colour it does not spend is gold.** `DROP_RING`/`DROP_OVER` and `border-accent` are
 * where the card is *going*, and a resting box already wearing the accent would leave the hover
 * state nothing to say. The whole change is therefore in the neutral half of the palette: value
 * and size carry "there is a target here", and gold still carries "this one".
 *
 * **Registered once, on mount, which is inside the drag** — a drop target added mid-drag enters
 * the next collision pass, which is the whole reason a surface that only exists during a drag can
 * be dropped on at all (the remove tray says the same). `useDndDropTarget` reads its two handlers
 * through a ref of its own, so they are rebuilt on every render of the bar without the
 * registration tearing itself down and back up under the reader's pointer.
 *
 * **It is an `overlay`, and that is not decoration.** dnd-kit resolves overlapping targets by
 * geometry and consults no z-index at all, so this short bar drawn over a tall pile does not
 * reliably win the pointer — `LAYER.dragTray` decides what is painted and nothing about what is
 * hit. `useDndDropTarget`'s `overlay` is the pair that says it: highest priority so the bar beats
 * the pile when the pointer is on it, and a pointer-only detector so it produces no collision at
 * all when the pointer is not — without the second half a 293px card dropped anywhere in the top
 * third of the desk overlapped the 74px bar by *shape* and the bar took it, which is the defect
 * the live pass of 2026-08-28 found.
 */
function QuickZone({ label, icon: Icon, takes, accepts, drop }: Zone): ReactElement {
  // Named `attach` rather than `ref` for `useCategoryDrop`'s reason: React's ref lint reads a
  // hook result called `ref` as a ref object. It is a callback the caller hands to `ref=`.
  const { ref, attach } = useDndTargetRef();
  const { over } = useDndDropTarget({
    ref,
    // The zone's own two questions are `accepts` and `drop`, which both take the raw record —
    // this zone reads a *group* of cards through `dropWrites` and a `DropTarget`, so there is no
    // narrower payload for the primitive to hand back. `accepts` is therefore the whole of the
    // read and `canDrop` has nothing left to ask.
    read: (data) => (accepts(data) ? data : null),
    canDrop: () => true,
    onDrop: (data) => drop(data),
    overlay: true,
  });

  return (
    <div
      ref={attach}
      {...{ [QUICK_ZONE_ATTR]: label }}
      className={cn(
        // No height of its own: the bar carries one, and these stretch into it. See the bar.
        // **`max-w-[300px]` against the `flex-1`**: the four share the editor's width evenly
        // until one of them would pass 300px, and then they stop and the bar centres what is
        // left (see the bar's `justify-center`). A drop target twice the width of the label in
        // it is not twice as easy to hit — the pointer is already inside it — and four boxes
        // spanning a 2560px window read as a banner rather than as four things to choose
        // between. Binds above ~1300px of bar; at 1280×800 the boxes are 236.8px and it does
        // nothing.
        "flex min-w-0 max-w-[300px] flex-1 items-center justify-center gap-2 rounded-md border-2 border-dashed",
        "border-dim bg-bg px-3 text-sm font-medium text-text",
        // No transition on either state, exactly as the remove tray has none: an affordance that
        // fades in during a drag is an affordance that is still arriving when the reader has let
        // go.
        !takes && "opacity-40",
        // The sidebar's own pair, said here so a drop target reads the same wherever a card is
        // carried. Gold is where a card is *going*; the tray at the other end of the window is
        // the one destructive drop in this view and is the only thing drawn in that colour.
        over && cn(DROP_RING, DROP_OVER, "border-accent text-accent"),
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </div>
  );
}

/**
 * The other half of the **New category** zone: the one question a drop there cannot answer.
 *
 * A modal rather than a field in the bar, because the bar is gone by the time this is needed —
 * the platform ends the drag on the drop, and a control that appeared where the pointer had just
 * been would be a control the reader is no longer looking at. It is a `Dialog` like every
 * other surface this editor opens over itself.
 *
 * **Two writes, in order, and only the first is asked about here.** The category is created, then
 * the card is filed into it by whichever write the drag meant — an add for a printing off a wall,
 * a move for a row of this deck. A refused *create* keeps the dialog open with the name still in
 * the field, which is what makes the one refusal that actually happens survivable: the grain is
 * `(deck_id, name)`, so a name the deck already has comes back as a refusal rather than as a
 * second pile. A refused *file* is `DeckEditor`'s banner, like every other add and move.
 */
export function QuickCategoryDialog({
  open,
  cardName,
  pending,
  failure,
  onCreate,
  onDismiss,
  onClose,
}: {
  open: boolean;
  /** The card that was thrown at the zone, named so the reader can see what they are filing —
   *  the platform's drag preview was the last thing that said it, and it is gone. */
  cardName: string;
  pending: boolean;
  /** `deck_category_create`'s refusal, or `null`. */
  failure: string | null;
  onCreate: (name: string) => void;
  onDismiss: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      title="New category"
      closeLabel="Close new category"
      size="w-[26rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <QuickCategoryBody
        cardName={cardName}
        pending={pending}
        failure={failure}
        onCreate={onCreate}
      />
    </Dialog>
  );
}

/** Mounted only while the dialog is open — `Dialog`'s guarantee — so the draft below starts
 *  clean on every open with no effect clearing it. */
function QuickCategoryBody({
  cardName,
  pending,
  failure,
  onCreate,
}: {
  cardName: string;
  pending: boolean;
  failure: string | null;
  onCreate: (name: string) => void;
}): ReactElement {
  const [name, setName] = useState("");
  const fieldRef = useRef<HTMLInputElement>(null);

  // **The one dialog in this editor that puts the caret in a field**, against `Dialog`'s own
  // rule that its panels hold "settled values rather than questions" and must not make a reader's
  // first keystroke an edit. This one is a question and nothing else: it was opened by a gesture
  // that has already finished, it holds a single empty box, and the reader's next act is
  // certainly to type a name.
  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const blocked = pending || name.trim() === "";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // The guard is here rather than on the button, because `aria-disabled` greys a control
    // without stopping it — which is the whole trade that rule makes.
    if (blocked) return;
    onCreate(name.trim());
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-5 pt-4 pb-6">
      <p className="text-[0.6875rem] leading-relaxed text-dim">
        {cardName ? (
          <>
            <span className="text-text">{cardName}</span> goes in the new pile as soon as it is
            made.
          </>
        ) : (
          "The card goes in the new pile as soon as it is made."
        )}
      </p>

      <div className="flex gap-2">
        <label htmlFor="quick-category-name" className="sr-only">
          New category name
        </label>
        <input
          id="quick-category-name"
          ref={fieldRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Removal…"
          className={META_FIELD}
        />
        <button
          type="submit"
          // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order, and
          // in a two-control dialog that is half of what Tab has to reach. `META_SUBMIT` greys on
          // the attribute, so the same greying is spelled again for this one — written out whole,
          // because Tailwind scans source text.
          aria-disabled={blocked}
          className={cn(
            META_SUBMIT,
            "aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-accent",
          )}
        >
          Create
        </button>
      </div>

      {failure && (
        <p className="text-[0.6875rem] text-destructive" role="alert">
          {failure}
        </p>
      )}
    </form>
  );
}
