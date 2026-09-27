import type { ReactElement } from "react";
import { Inbox } from "lucide-react";
import { DROP_EDGE, DROP_OVER } from "@/lib/dropMarks";
import { cn } from "@/lib/utils";

/** Spec §3.8's words, exported so a page test can find the box by them. */
export const EMPTY_SHELF_COPY = "Empty — drag cards here, or pick cards and choose Move to folder…";

/** How a test or a live probe finds the box. */
export const EMPTY_SHELF_ATTR = "data-shelf-empty";

/**
 * An empty folder's shelf: a dashed box under its heading — spec §3.8.
 *
 * **Dashed**, the container vocabulary the folder cards already use: it is a drawer with nothing in
 * it, not a control. 96px, the canvas's height; the page's layout adds the 12px gap
 * (`SHELF_EMPTY_HEIGHT`). Drawn only for a folder with no cards *and* no subfolders — a folder whose
 * cards are all below it draws its heading and rail and no box (Review Focus 2), which is the page's
 * decision through `layoutShelves`.
 *
 * A card drop target, wired by the page: it has an edge of its own, so an eligible drag golds the
 * dash (`DROP_EDGE`) and the one under the pointer takes it to full strength beside a wash.
 */
export function EmptyShelf({
  dropRef,
  dropMark = "none",
}: {
  dropRef?: (el: HTMLElement | null) => void;
  dropMark?: "none" | "armed" | "over";
}): ReactElement {
  return (
    <div
      ref={dropRef}
      {...{ [EMPTY_SHELF_ATTR]: "" }}
      className={cn(
        "flex h-24 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 text-center text-[0.8125rem] text-dim",
        dropMark === "armed" && DROP_EDGE,
        dropMark === "over" && cn("border-accent", DROP_OVER),
      )}
    >
      <Inbox className="size-4 flex-none" aria-hidden="true" />
      <span>{EMPTY_SHELF_COPY}</span>
    </div>
  );
}
