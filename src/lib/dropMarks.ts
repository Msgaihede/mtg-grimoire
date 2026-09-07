/**
 * The marks a drop target wears. Shared vocabulary, owned by no feature.
 *
 * These lived in `components/AppShell.tsx` until 2026-08-16, which made
 * `AppShell → cardMenu → FolderTree → AppShell` a real import cycle for the sake of two
 * strings. Nothing here imports anything, so nothing that wants a drop mark has to pull a
 * whole window in to get one.
 *
 * ## One box, two marks, and the rule that was missing until 2026-09-03
 *
 * **Both marks go on the element that carries the target's own edge — never on a wrapper around
 * it.** That rule is new, and its absence is the whole of the reader's report that the
 * affordances "don't align with the dotted outline and faint highlight". Every folder card in
 * this app drew {@link DROP_RING} on the outer `<li>` and its dashed border plus
 * {@link DROP_OVER} on the `<button>` inside — and a ring is a box shadow painted *outside* the
 * border box, so what shipped was a gold rectangle standing 2px proud of a dashed rectangle it
 * never touched. `features/decks/FolderCard.tsx` was worst: a ring on the `<li>` for the deck
 * drag, a second on an inner `<div>` for the folder drag, and the button's dash inside both —
 * three concentric outlines for one landing.
 *
 * The drop *registrations* did not move to fix it and could not: dnd-kit keeps one target per
 * element, and those wrappers are the boxes the two drags are registered on and measured
 * against (`folderEdge` divides the inner one into three landings). Only the `className` moved.
 */

/**
 * What a target that could take the card you are holding looks like, on a surface with **no
 * border of its own** — a nav entry, a deck row, a quick zone.
 *
 * **1px, inset, and at 45%, where this was 2px of solid gold painted outside the box.** All
 * three changes answer the same report (2026-09-03): the marks are bulky and they overlap
 * neighbouring content. A ring is a box shadow, so at 2px *outside* the border box it bleeds
 * into the gap between cards — on a wall of drawers a dozen of them at once, each intruding on
 * its neighbour's space. `ring-inset` paints it inside instead, which makes the overlap
 * impossible by construction rather than by tuning; and at 1px and 45% a whole wall of eligible
 * targets reads as a set of quiet hints, which is what "several of these would take it" should
 * look like beside the one that says "this one".
 *
 * Gold is the app's existing vocabulary rather than a new one — interactive emphasis everywhere
 * in this window, and the same colour as the keyboard's focus mark. Deliberate: a drop target
 * lighting up and a control being reachable are the same claim made to two different hands.
 *
 * **`DROP_MARK_ROOM` is no longer this token's dependency, and stays anyway.** An inset ring
 * cannot be clipped by a scroller's padding box, so the defect that constant was written for is
 * gone from the ring. `FOCUS` still stands 4px proud and still needs the room, which is a WCAG
 * 2.4.7 matter rather than a cosmetic one — see that constant's own note.
 *
 * Instant, with no rule of its own: a ring is a box shadow, and a surface's colour animation
 * does not cover one. That is the answer this wants anyway — an affordance that arrives
 * gradually during a drag is one still arriving when the reader has let go
 * (`DropIndicator`'s reasoning).
 */
export const DROP_RING = "ring-1 ring-inset ring-accent/45";

/**
 * The same claim on a surface that **already has an edge**: the four folder cards, whose
 * `border border-dashed border-border` is drawn for them all day.
 *
 * **A ring inside a dash would be two lines 1px apart, which is the reported bug drawn smaller.**
 * A card that already owns an outline does not need a second one to say a drag could land on it
 * — it needs *that* outline to change colour. So the eligible mark here is the dash going faintly
 * gold, {@link DROP_OVER} takes it to full strength beside its wash, and at no point are there
 * two edges to fail to line up. Alignment stops being something to get right and becomes
 * something there is no way to get wrong.
 *
 * It keeps the dash, which across this app is a rule and not decoration: *dashed means
 * provisional — a container rather than a thing you own*. A drawer lighting up for a drag is
 * still a drawer.
 *
 * **`transition-none` because these buttons already tween their colours over 150ms for their
 * hover**, and a drop affordance must not fade in — the rule {@link DROP_RING} gets for free by
 * being a box shadow, and one a border colour would otherwise break, since a colour tween covers
 * a border exactly as it covers a background. It costs nothing: the class is only ever applied
 * *during* a drag, and `:hover` does not update while the pointer is holding something.
 *
 * The `motion-reduce` sweep in `tokens.test.ts` ignores `transition-none`, which is the opt-out
 * it looks for — and the utility those buttons actually carry is deliberately **not** spelled out
 * anywhere in this comment, because that sweep reads a doc comment as markup and would demand an
 * opt-out for a sentence.
 */
export const DROP_EDGE = "border-accent/45 transition-none";

/**
 * And which of the marked set the card is actually over.
 *
 * A wash of the same gold rather than a hover surface, for two reasons. `:hover` does not update
 * during a drag — the pointer is holding something — so this has to be drawn from the drop
 * target's own state; and the entry a card is dropped on is very often the **active** one (the
 * Decks entry, with its editor open, is where a panel tile goes), whose surface is already
 * `bg-bg` and whose label is gold. A second surface colour would have been invisible there, and
 * the `text-text` this used to carry took the gold label *off* the active entry — emphasis
 * subtracted at the moment it was wanted.
 *
 * **It escalates by colour and never by width**, which is what keeps it from fighting
 * {@link DROP_RING} through `tailwind-merge`. Both tokens are applied to one element in a single
 * `cn()`, so a `ring-2` here would land in the same width group as that token's `ring-1` and
 * whichever came last would win — a mark whose thickness depended on argument order. Instead the
 * width lives in one place and this raises `ring-accent/45` to `ring-accent` in the ring-*colour*
 * group, where overriding is the intended behaviour. On a surface with no ring width at all the
 * colour is simply a no-op, which is the right answer for the folder cards: there
 * {@link DROP_EDGE}'s border goes solid and this brings the wash.
 *
 * The wash went `bg-accent/10` → `bg-accent/15` on 2026-09-03, because the step up from eligible
 * to over had to grow when the eligible mark shrank.
 *
 * `transition-none` for {@link DROP_EDGE}'s reason, and for one this token owns alone: the two
 * marks now sit on the **same element**, so they must arrive together. A border that snapped
 * while its wash faded in would be a second kind of misalignment — in time rather than in space —
 * introduced by the very change that fixed the first.
 */
export const DROP_OVER = "bg-accent/15 ring-accent transition-none";

/**
 * The room a **scroller** has to leave around the drop targets inside it, so that the marks drawn
 * _outside_ a target's border box survive its own `overflow`.
 *
 * A ring is a box shadow and an outline is painted outside the border box, so neither is part of
 * the box that laid the target out — but `overflow` clips at the scroller's **padding box**, so a
 * target flush against a scroller's content edge has its mark painted in the clipped region and
 * simply loses it. That is what shipped in the deck builder: the three grow-views are
 * `overflow-x-auto` with no padding, every pile against the left content edge lost the left 2px of
 * its {@link DROP_RING} for the whole length of a drag, and the rail lost its right — an
 * affordance sliced off at exactly the moment it was being read. It is invisible to jsdom, which
 * has no layout engine and therefore no clip.
 *
 * **The ring is no longer the reason, and the number does not change.** {@link DROP_RING} became
 * `ring-inset` on 2026-09-03 and an inset ring is painted *within* the border box, so it cannot
 * be clipped at all — that half of this constant's job is simply gone. What remains is the half
 * that always asked for more: the same boxes carry `FOCUS` — `outline-2 outline-offset-2`, which
 * stands 4px proud — and a focus mark clipped to half its width is a WCAG 2.4.7 failure rather
 * than a cosmetic one. Six is that four plus two to spare, and it is the number `StackView`'s
 * `SECTION_PADDING` already draws inside a pile, so the chrome around a pile and the chrome
 * around the desk agree.
 *
 * It goes on the box that carries the `overflow` and one level in is not the same fix — padding on
 * a child moves the target away from the edge but the mark is still drawn outside *that* child, so
 * it lands right back on the clip. Same rule as the `relative` on a scroll container in
 * `src/CLAUDE.md`, for the same reason: the scroller is the box the geometry is about.
 */
export const DROP_MARK_ROOM = "p-1.5";
