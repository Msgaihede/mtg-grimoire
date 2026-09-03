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
 * **Pressing it opens the field *here*, and that is what changed on 2026-09-03.** The tile used to
 * raise a bordered strip under the breadcrumb — an input, `Create folder` and `Cancel` in words,
 * and a line reading *in Collection* to say which level the strip was about — every piece of which
 * re-established a context the wall on screen already carried. Now the tile becomes the field:
 * the name is typed on the line the folder's name will occupy, at the same track and the same
 * footprint, so nothing above the wall opens and nothing in the wall reflows. `FolderNameField`
 * carries the shape and the argument; this file's job is the two states and the caret between
 * them.
 *
 * **Drawn as an `<li>`, so a caller drops it straight into the existing `<ul aria-label="Folders">`**
 * — the shape all three folder cards use, and a row of folders genuinely is a list. It carries no
 * drop target and no `⋯`: nothing can be filed into a folder that does not exist yet.
 */
import type { ReactElement } from "react";
import { FolderPlus } from "lucide-react";
import {
  FOLDER_CARD_HEIGHT,
  FolderNameField,
  useFolderFieldReturn,
} from "@/components/FolderNameField";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";

/**
 * @param naming Whether the tile is currently *being* the field. The page owns it, because one
 *   field is open at a time across the whole wall — pressing a folder's `Rename…` has to close
 *   this one, and a tile holding its own flag could not know that had happened.
 * @param pending The create is in flight. Holds the field open rather than closing it optimistically.
 * @param onClick Handed **the button element itself**, kept from when this raised a panel that
 *   anchored its focus return on the trigger. The caret's way back is {@link useFolderFieldReturn}
 *   now — the trigger unmounts while the field is open, so an element remembered by the page is a
 *   detached node by the time the page focuses it — but the element is still what a caller wants
 *   for anything anchored on the press, and `currentTarget` is null by the time an async handler
 *   reads it off the event.
 * @param label What the tile says, and therefore its accessible name — visible label and name are
 *   one string here (WCAG 2.5.3), never an `aria-label` that replaces it. A caller overrides it to
 *   name the level: "New binder", "New drawer". The field's own accessible name is built from it,
 *   so "New binder" is typed into a box called "New binder name" and the two cannot drift.
 */
export function NewFolderCard({
  naming,
  pending,
  onClick,
  onSubmit,
  onCancel,
  label = "New folder",
}: {
  naming: boolean;
  pending: boolean;
  onClick: (trigger: HTMLElement) => void;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  label?: string;
}): ReactElement {
  const tileRef = useFolderFieldReturn<HTMLButtonElement>(naming);

  // `relative`, and nothing else: the field's ✓ / ✕ pair is absolute against this `<li>`, which is
  // the same corner a folder card's `⋯` resolves against — so the two answers land in the same
  // place on a naming tile as the menu does on the card beside it. The `rounded-xl` the folder
  // cards carry here is theirs alone: it exists to clip a **drop ring**, and this tile takes no
  // drop, so copying it across would be an inert class a reader has to check for a meaning it
  // does not have.
  return (
    <li className="relative">
      {naming ? (
        <FolderNameField
          mode="create"
          label={`${label} name`}
          submitLabel="Create folder"
          pending={pending}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      ) : (
        <button
          ref={tileRef}
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
      )}
    </li>
  );
}
