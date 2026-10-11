import { useId, useState } from "react";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { isOpen } from "@grimoire/ui/features/trade/trade";
import type { Trade } from "@grimoire/ui/lib/ipc";
import { PRESS_STILL } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { ActionSheet, SheetBack, SheetRow } from "../deck/sheet";
import { GOLD_BUTTON, Refusal } from "./parts";

type Page = "main" | "rename";

/**
 * What a trade offers beyond its own page: a new name, a copy, and the way out for good.
 *
 * - **Rename** — a page of this sheet with the one box. **Refused on a trade that is not open**,
 *   and the row stays drawn saying why: a closed trade is a record, and the backend would refuse
 *   the write in a sentence the reader had to type a name to earn.
 * - **Duplicate** — a new open trade with the same cards, percentages and marketplace, on today's
 *   prices. Offered on every trade; the page moves to the copy.
 * - **Delete** — a request. The page asks first, in a dialog of its own, because the trade and
 *   everything on it goes and nothing brings it back.
 */
export function MoreSheet({
  open,
  trade,
  refusal,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
  onDismiss,
}: {
  open: boolean;
  trade: Trade;
  refusal: string | null;
  /** Answers once the name is stored, or rejects with the backend's sentence. */
  onRename: (name: string) => Promise<void>;
  onDuplicate: () => void;
  /** *Delete…* — a request, never the delete itself. */
  onDelete: () => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const id = useId();
  const [page, setPage] = useState<Page>("main");
  const [name, setName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const draft = name ?? trade.name;
  const typed = draft.trim();

  const leave = (how: () => void) => () => {
    setPage("main");
    setName(null);
    how();
  };
  const rename = () => {
    if (renaming || typed === "") return;
    // A name left as it was is no write at all.
    if (typed === trade.name) {
      leave(onDismiss)();
      return;
    }
    setRenaming(true);
    onRename(typed)
      .then(leave(onDismiss))
      // The sentence is the page's to draw — it is handed back down as `refusal`.
      .catch(() => undefined)
      .finally(() => setRenaming(false));
  };

  return (
    <ActionSheet
      open={open}
      title={trade.name}
      subtitle="Trade"
      closeLabel="Close trade actions"
      onClose={leave(onClose)}
      onDismiss={leave(onDismiss)}
      footer={
        refusal === null ? undefined : (
          <div className="shrink-0 border-t border-border px-4 py-2">
            <Refusal>{refusal}</Refusal>
          </div>
        )
      }
    >
      {page === "rename" ? (
        <>
          <SheetBack label="Rename" onBack={() => setPage("main")} />
          <form
            className="flex flex-col gap-3 px-4 pt-3 pb-4"
            onSubmit={(event) => {
              event.preventDefault();
              rename();
            }}
          >
            <label htmlFor={`${id}-name`} className="text-[0.8125rem] text-dim">
              Name
            </label>
            <input
              id={`${id}-name`}
              type="text"
              value={draft}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              // 16px: below it a phone zooms the page when the box takes the caret.
              className={cn(
                "h-11 w-full min-w-0 rounded-md border border-border bg-bg px-3 text-base text-text",
                "select-text focus:border-accent focus:outline-none",
                PRESS_STILL,
              )}
            />
            <button
              type="submit"
              aria-disabled={typed === "" || renaming || undefined}
              aria-busy={renaming || undefined}
              className={cn(GOLD_BUTTON, "self-end px-6")}
            >
              {/* Not a bare `Rename`: the way back at the head of this page is named that. */}
              Rename trade
            </button>
          </form>
        </>
      ) : (
        <ul>
          <SheetRow
            label="Rename"
            Icon={Pencil}
            opens
            reason={isOpen(trade.status) ? null : "Reopen the trade to rename it."}
            onPress={() => setPage("rename")}
          />
          <SheetRow label="Duplicate" Icon={Copy} onPress={leave(onDuplicate)} />
          <SheetRow label="Delete…" Icon={Trash2} destructive onPress={leave(onDelete)} />
        </ul>
      )}
    </ActionSheet>
  );
}
