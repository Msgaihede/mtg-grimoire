/**
 * Somebody else's **deck**, read inside the app (issue #1032) — drawn by the deck editor's own
 * four views, read-only.
 *
 * ## The editor's views, and none of its writes
 *
 * `StackView`, `GridView`, `TableView` and `TextView` are the editor's desk, and every write a
 * card or a pile can make arrives through one prop, `actions` (`cardControl.tsx`'s
 * `DeckCardActions`): the stepper, the drag, the drop, the right-click menu, the pick. **This view
 * passes none**, and absent is the whole of each switch — a view draws no stepper without
 * `setQuantity`, no drag without `drop`, no menu without `menu` — which is the shape that bag
 * already promises "a story, a read-only mount". Nor `onSelect`: the app's card pane hands the
 * reader every write it has, and this is a fetched document. So the read-only guarantee here is
 * the same structural one {@link SharedPage}'s header argues, and `readOnly.test.ts` still sweeps
 * this file.
 *
 * **`tracksCollection` is `false`**, because the owned counts are the publisher's and are not on
 * the wire: a deck drawn with `true` would mark every card missing.
 *
 * The three pickers are the editor's (`Stacks · Grid · Table · Text`, its groupings, its sorts),
 * minus the two groupings that need what a share does not carry — `Labels` and `Matches theory`.
 * Their state is this view's and is remembered nowhere: it is somebody else's deck.
 */
import { memo, useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { BUTTON } from "@/features/settings/controls";
import { buildGroups, DEFAULT_EMPTY_GROUP_RULES } from "@/features/decks/grouping";
import type { GroupBy } from "@/features/decks/grouping";
import type { SortBy } from "@/features/decks/sorting";
import { GridView } from "@/features/decks/views/GridView";
import { StackView } from "@/features/decks/views/StackView";
import { TableView } from "@/features/decks/views/TableView";
import { TextView } from "@/features/decks/views/TextView";
import { resolveMarketplace } from "@/lib/marketplace";
import type { ShareDeck, ShareSnapshot } from "@/lib/shareSnapshot";
import { cn } from "@/lib/utils";
import { sharedDeckRows } from "./sharedDeckRows";

/** The editor's view switch, in its order: `Stacks` pinned, the rest alphabetical. */
export type SharedDeckView = "stacks" | "grid" | "table" | "text";
const VIEW_OPTIONS: readonly DropdownOption[] = [
  { value: "stacks", label: "Stacks" },
  { value: "grid", label: "Grid" },
  { value: "table", label: "Table" },
  { value: "text", label: "Text" },
];

/** The editor's groupings a share can answer, alphabetical as its picker draws them. */
const GROUP_OPTIONS: readonly DropdownOption[] = [
  { value: "category", label: "Categories" },
  { value: "deck", label: "Full deck" },
  { value: "manaValue", label: "Mana value" },
  { value: "type", label: "Type" },
];

/** The editor's sorts, alphabetical — `Price` only where prices travelled. */
const SORT_OPTIONS: readonly DropdownOption[] = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "manaCost", label: "Mana cost" },
  { value: "price", label: "Price" },
  { value: "type", label: "Type" },
];

const COUNT = new Intl.NumberFormat("en-US");

export const SharedDeck = memo(function SharedDeck({
  snapshot,
  deck,
  owner,
  title,
  stamp,
  refreshing,
  onRefresh,
  onClose,
}: {
  snapshot: ShareSnapshot;
  deck: ShareDeck;
  /** The publisher's name, or `""` — already guarded by the page. */
  owner: string;
  title: string;
  /** The *as of* date, or `null` for a stamp this build cannot read. */
  stamp: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<SharedDeckView>("stacks");
  const [groupBy, setGroupBy] = useState<GroupBy>("category");
  const [sortBy, setSortBy] = useState<SortBy>("alphabetical");

  const marketplace = resolveMarketplace(snapshot.marketplace);
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const showValue = fields.includes("value");

  const rows = useMemo(() => sharedDeckRows(snapshot, deck), [snapshot, deck]);
  const groups = useMemo(
    () =>
      buildGroups(rows.cards, rows.categories, groupBy, sortBy, false, DEFAULT_EMPTY_GROUP_RULES),
    [rows, groupBy, sortBy],
  );
  // What the deck counts as, the gallery's own rule: active piles that are played *in* the deck.
  const size = useMemo(
    () =>
      rows.cards
        .filter(
          (c) => c.categoryActive && c.categoryKind !== "side" && c.categoryKind !== "companion",
        )
        .reduce((n, c) => n + c.quantity, 0),
    [rows],
  );

  const viewProps = { groups, marketplace, tracksCollection: false };

  return (
    <>
      <header className="border-b border-border py-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* `{" "}` between the two block spans, for the binder's reason: without it the heading's
              accessible name is `Giradeli’sKrenko`. */}
          <h2 className="max-w-[34rem]">
            {owner !== "" && <span className="block text-sm text-dim">{owner}’s</span>}{" "}
            <span className="block font-heading text-[1.75rem] leading-tight">{title}</span>
          </h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRefresh}
              aria-disabled={refreshing}
              className={cn(BUTTON, "border-border text-dim hover:text-text")}
            >
              <RefreshCw
                className={cn("size-4", refreshing && "animate-spin motion-reduce:animate-none")}
                aria-hidden
              />
              {refreshing ? "Checking…" : "Check for an update"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className={cn(BUTTON, "border-border text-dim hover:text-text")}
            >
              <X className="size-4" aria-hidden />
              Close this deck
            </button>
          </div>
        </div>
        <p className="mt-4 font-mono text-[0.8125rem] text-dim">
          {deck.format !== "" && `${deck.format} deck · `}
          {COUNT.format(size)} {size === 1 ? "card" : "cards"}
          {stamp !== null && `, as of ${stamp}`}
        </p>
        <p className="mt-4 max-w-[54ch] text-sm text-dim">
          Read-only snapshot. It won't change until {owner === "" ? "its owner" : owner} shares it
          again.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4">
        <Picker
          id="shared-deck-view"
          label="View"
          value={view}
          options={VIEW_OPTIONS}
          onPick={(v) => setView(v as SharedDeckView)}
        />
        <Picker
          id="shared-deck-group"
          label="Group by"
          value={groupBy}
          options={GROUP_OPTIONS}
          onPick={(v) => setGroupBy(v as GroupBy)}
        />
        <Picker
          id="shared-deck-sort"
          label="Sort"
          value={sortBy}
          options={showValue ? SORT_OPTIONS : SORT_OPTIONS.filter((o) => o.value !== "price")}
          onPick={(v) => setSortBy(v as SortBy)}
        />
      </div>

      {/* The editor's floor, so one card's pile is never cut through its art. */}
      <div className="min-h-96 min-w-0">
        {view === "stacks" && <StackView {...viewProps} />}
        {view === "grid" && <GridView {...viewProps} />}
        {view === "table" && <TableView {...viewProps} />}
        {view === "text" && <TextView {...viewProps} />}
      </div>
    </>
  );
});

/** One of the toolbar's three pickers — the editor's `Dropdown`, labelled as the editor labels it. */
function Picker({
  id,
  label,
  value,
  options,
  onPick,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly DropdownOption[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <label id={`${id}-label`} htmlFor={id} className="text-[0.6875rem] text-dim">
        {label}
      </label>
      <Dropdown
        id={id}
        labelledBy={`${id}-label`}
        value={value}
        onChange={onPick}
        options={options}
      />
    </div>
  );
}
