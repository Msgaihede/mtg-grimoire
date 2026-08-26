/**
 * The tile that makes a folder, drawn **first in the wall of folder cards** rather than in a row
 * of controls beside the breadcrumb. The wishlist and the collection both draw one.
 *
 * **It is solid-bordered, and that is the whole visual claim.** Across this app a dashed edge is
 * not decoration but a rule with a meaning already established and argued at length in
 * `WishFolderCard`'s own doc: *dashed means provisional* — a container rather than a thing you
 * own. A deck folder wears it because a folder is not a deck you can play, a wishlist folder
 * because it is not a card you can buy, a binder because it is not a copy you own. Nothing else on
 * those screens is dashed, so the dash keeps meaning exactly that. A **button** is none of those
 * things: it is not a container at all, provisional or otherwise, and dressing it in the dash to
 * make the wall look uniform would spend the one word the wall has for "container" on a control.
 * So the tile matches the folder card's **footprint** — same track, same height, same radius, the
 * same `hover:border-accent` so the wall answers a pointer uniformly — and departs on the one
 * property that carries meaning. Solid says: this is a thing you press, standing among things you
 * open.
 *
 * The rest follows from that: the content is **centred** where a folder card's is left-aligned
 * with a name over a figures line, because there is no name and no figure here, and a label
 * hugging the top-left of an otherwise empty tile reads as a folder whose second line failed to
 * load. `FolderPlus` is the glyph the deck tree already presses to make a folder
 * (`FolderTree.tsx`), so the wall and the sidebar say one thing one way.
 *
 * **Drawn as an `<li>`, so a caller drops it straight into the existing `<ul aria-label="Folders">`**
 * — the shape all three folder cards use, and a row of folders genuinely is a list. It carries no
 * drop target and no `⋯`: nothing can be filed into a folder that does not exist yet.
 */
import type { ReactElement } from "react";
import { FolderPlus } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * A folder card's intrinsic height, so the tile stands at the right size when it is the **only**
 * thing in the wall — a cabinet with no folders in it yet, which is the state every reader meets
 * first. Beside a folder card `h-full` already matches it (the `<li>` is the grid item and grid
 * items stretch to the row), so this floor is what answers the *empty* case rather than what does
 * the matching.
 *
 * **Measured rather than reasoned**, in headless Chromium over Tailwind's own compiled utilities
 * at the wall's real `grid-cols-[repeat(auto-fill,minmax(180px,1fr))]` track: a folder card's
 * button computes **62px** — `p-2.5` (10 × 2) + a `text-sm` line (20) + `mt-1` (4) + a `text-xs`
 * line (16) + two 1px borders. This tile's own content reaches the same 62 by a different route
 * (20 + a `size-4` glyph + `gap-1` + a `text-sm` line + 2), which is two type scales agreeing
 * today rather than a guarantee — so the floor is written down, and changing the glyph or the gap
 * cannot silently shorten the tile out from under the wall.
 *
 * **`calc(3.75rem + 2px)` rather than a flat `3.875rem`, because the two hairlines are the one
 * part that does not scale.** Everything else in that sum is `rem` — the padding, both line
 * heights, the gap — and a 1px border is a hairline at every size, which is this app's standing
 * rule about what a zoom or a root font size may move. Written that way the floor stays exactly a
 * folder card's height rather than 2px of drift past it.
 *
 * It is a floor on a **block child of the grid item**, not on a flex item, so it grows the box
 * rather than capping it — the failure a past session recorded, where a `min-h` replaced a flex
 * item's `min-height: auto` and the content spilled two elements away. Driven at the narrowest
 * real track (180px) with a label long enough to take two lines, the button measured 82px with
 * `scrollHeight === clientHeight` and the label's rect inside the button's on all four sides:
 * it wraps and grows, and clips nothing.
 */
const FOLDER_CARD_HEIGHT = "min-h-[calc(3.75rem+2px)]";

/**
 * @param onClick Handed **the button element itself**, because both callers anchor a naming
 *   panel's focus return on the trigger (`open({ kind: "newFolder", … }, opener)`) — a
 *   `MouseEvent` would make every call site dig `currentTarget` out of it, and `currentTarget` is
 *   null by the time an async handler reads it.
 * @param label What the tile says, and therefore its accessible name — visible label and name are
 *   one string here (WCAG 2.5.3), never an `aria-label` that replaces it. A caller overrides it to
 *   name the level: "New binder", "New drawer".
 */
export function NewFolderCard({
  onClick,
  label = "New folder",
}: {
  onClick: (trigger: HTMLElement) => void;
  label?: string;
}): ReactElement {
  // The bare `<li>`, where the folder cards' is `relative rounded-xl`, is deliberate: both of those
  // classes exist on those cards to carry the **drop ring**, which is drawn on the `<li>` so it
  // stands outside the button's own edge. This tile takes no drop — nothing can be filed into a
  // folder that does not exist yet — so the wrapper paints nothing and positions nothing, and two
  // inert classes copied across for the resemblance would be two things a reader has to check for
  // a meaning they do not have.
  return (
    <li>
      <button
        type="button"
        onClick={(e) => onClick(e.currentTarget)}
        className={cn(
          // `h-full` matches the tallest card in the row; the floor below answers the empty wall.
          "flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl",
          FOLDER_CARD_HEIGHT,
          // Solid, where every folder card beside it is dashed. See this file's header — the one
          // property that must not be copied from the cards it stands with.
          "border border-border p-2.5 text-center text-sm",
          "transition-colors duration-150 hover:border-accent hover:bg-surface",
          "motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <FolderPlus className="size-4 flex-none text-dim" aria-hidden="true" />
        {label}
      </button>
    </li>
  );
}
