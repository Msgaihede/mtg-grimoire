/**
 * What moving the reader's pinned wishes to their cheapest printings would save — a figure, and the
 * moves that save most.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the popover and the Customize tray; this
 * draws the figure, the rows and two footer lines, cut to the box `fit` describes.
 *
 * ## No new command: the dialog's own plan, over the whole list
 *
 * `wishlist_optimize_plan` already answers, per pinned wish, both printings with their prices and
 * the saving (`WishOptimizeMove`). This asks it about **the whole wishlist** —
 * `wholeWishlistQuery`, flattened, no filters, at the reader's marketplace — which is the question
 * `WishlistPage` puts to the dialog when a press here lands there, so the dialog offers exactly what
 * this card counted. **It is one cache entry, not two copies**: `wishlistSavingsKey` is
 * `useWishlistOptimize`'s own key for that question, and the payload is spelled the way that hook
 * spells it (`limit: 0, offset: 0`, which the command ignores), so the dialog opens on this card's
 * answer and the dialog's apply — which invalidates `["wishlist"]` — refreshes this card with it.
 * The marketplace decides every figure, and it rides inside the query object that ends the key.
 *
 * **What it inherits from the plan and does not paper over**: digital printings are skipped
 * (`wishlist_optimize.rs`'s candidate query), and the cheaper printing may be in another language —
 * the plan has no language filter. A language rule, if one is wanted, belongs to the plan and both
 * surfaces.
 *
 * ## Two settings, and both are the question (issue #598)
 *
 * **The decks' managed wishlists are counted by default** — `includeManaged`, the `managed` switch
 * on. They are still wishlists: a card a deck is short of is money the reader has yet to spend, and
 * the saving on it is as real as on any wish they filed by hand. What differs is only who can take
 * it — the wish is the deck's printing and the deck is the only thing that repoints it — so the
 * dialog a press opens draws those rows with no checkbox (`optimizePlan.ts`'s `canApply`). Until
 * issue #598 the plan left them out unconditionally, which made a reader whose wishlist was all
 * decks' see *No wishlist items found* over a wishlist full of wishes.
 *
 * **`Which wishlists` narrows the count to the folders the reader chose** in
 * {@link WishlistSavingsWidgetSettings}' checklist, `Not in a folder` among them. A chosen folder
 * brings every folder inside it ({@link sweepScopeOf}), because a reader who picks `Commander`
 * means the drawer and not only the wishes lying loose in it — which is also what the wishlist's
 * own shelves sum.
 *
 * **Both ride in the key and in the press**: {@link sweepScopeOf}'s answer is the last segment of
 * `wishlistSavingsKey` and what `setPendingOptimize` hands the Wishlist page, so the dialog still
 * plans exactly what this card counted, from the same cache entry.
 *
 * ## Money that is not there is said, never summed
 *
 * `saved` is `null` exactly when `from.price` is — a wish whose printing this marketplace does not
 * list. {@link splitSavings} leaves those out of the figure and counts them for a line of their own
 * (`2 more have no current price`); a card whose moves are *all* like that says so in a sentence
 * rather than drawing `Could save $0.00`. The figure is gold and everything else body ink —
 * `WidgetParts.tsx`'s rule.
 *
 * ## Four empty sentences, and `skipped` is never *cheapest*
 *
 * `considered` is **every** wish the plan scanned — an any-printing wish is counted in
 * `alreadyCheapest` (`wishlist_optimize.rs:276-288`) — so `considered === 0` is an empty wishlist,
 * not a list with nothing pinned. No move at all is *every pinned wish is already cheapest*, which is
 * also the true answer for a list of any-printing wishes — **but only when `skipped` is zero**.
 *
 * `skipped` is a pinned wish the plan could not compare at all (`wishlist_optimize.rs:290-316`): no
 * oracle id to find siblings by, a printing `cards` no longer has, or — the one a reader meets — **no
 * printing of the card priced at this marketplace and finish**: Card Kingdom or Mana Pool picked
 * before its feed has landed, a foil wish where nobody quotes foil. With no move and some skipped,
 * *already cheapest* would be false, so {@link skippedOnly} says that no price was there to compare,
 * naming the marketplace, since switching one is what changes the answer. With moves as well, the
 * face is unchanged and {@link skippedFooter} is one more line — counted, never summed. And moves
 * none of which is priced is the fourth sentence.
 *
 * ## Footers are one line
 *
 * The cut, the unpriced and the skipped lines are each `WidgetFooterLine`: one line at any width,
 * drawing a short `line` (`1 more: no Cardmarket price`) and speaking the whole sentence (`1 more has
 * no price at Cardmarket to compare against`) as its hint and to a screen reader. Each is reserved
 * at what one line draws, `fit.ts`' `footerLinePx` — 24px comfortable, 21 compact. The live pass of
 * 2026-09-26 found the skipped sentence on two lines at every two-cell width and three at a 1024px
 * window, against a reservation of one 22px line, and the body scrolling under it.
 *
 * **And no row or line is drawn that the body cannot hold** ({@link savingsLayout}): the re-check
 * the same day found a 2×2 at a 1024px window still drawing one wish row it had no room for, because
 * the rows were cut with `rowsFit`'s floor of one. Where no row fits, the card is the figure and as
 * many of the unpriced and skipped lines as fit — never a cut line restating the figure.
 *
 * ## A press opens the dialog
 *
 * A row or the figure writes `setActiveView("wishlist")` and then `setPendingOptimize(scope)` — the
 * view first, because the view change clears every hand-off — and `WishlistPage` opens
 * `OptimizeWishlistDialog` over this card's scope without touching the reader's own folder or
 * filters.
 *
 * **No `@container` here or on the page that draws this**, and no z-index that is not from
 * `LAYER` — `fit.ts`'s module doc has the argument.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { isManaged } from "@/features/wishlist/managed";
import { useWishlistFolderList } from "@/features/wishlist/useWishlistFolders";
import { wholeWishlistQuery, type SweepScope } from "@/features/wishlist/wholeWishlistQuery";
import { count, plural } from "@/lib/counts";
import { buildFolderTree, flattenFolders, folderDescendants } from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type HomeWidget,
  type WishlistFolder,
  type WishOptimizeMove,
} from "@/lib/ipc";
import type { Currency, Marketplace } from "@/lib/marketplace";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";

import { bodyGapPx, footerLinePx, type WidgetFit } from "../fit";
import { wishlistSavingsKey } from "../keys";
import { widgetConfig } from "../layout";
import {
  WidgetFigures,
  WidgetFooterLine,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
  type FooterWords,
} from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { widgetMeta } from "../widgets";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { wishlistFolderOption } from "./FoldersWidget";

/** A row with a caption is 51px, a bare one 36 — `SetCompletionWidget.tsx`'s `rowPx` sum. */
const ROW_CAPTIONED = 51;
const ROW_BARE = 36;
/** The figure line, comfortable and compact — `CollectionValueWidget.tsx`'s two numbers. */
const FIGURES_PX = 74;
const FIGURES_COMPACT_PX = 62;

const PENDING = "Checking prices…";
export const NO_WISHES =
  "No wishlist items found. Pin a wishlist card to track cheaper printings.";
export const ALL_CHEAPEST =
  "All pinned cards are already on their cheapest printing.";
/** `Chosen` with nothing chosen — `DecksWidget`'s `NOTHING_PINNED`, one widget over. */
export const NOTHING_CHOSEN =
  "No wishlists chosen. Choose them in this widget's settings.";
/** Every chosen folder has been deleted or renamed away since — a race another surface won, and
 *  never a reason to count the whole wishlist in their place. */
export const CHOSEN_GONE = "The chosen wishlist folders no longer exist.";

/** The id the checklist gives the root — `WishlistQuery.shelves`' own `0`, wishes filed in no
 *  folder. No folder has it: `wishlist_folders.id` is an `INTEGER PRIMARY KEY`. */
export const ROOT_SHELF = 0;

/**
 * The folders the reader chose, narrowed — `pinnedDeckIds`' rule: `widgetConfig`'s shape check is
 * shallow, so a hand-edited `["3"]` or a `NaN` is dropped here the way a deleted folder is. A fresh
 * fallback per call, so no two widgets share one array.
 */
export function savingsFolderIds(widget: HomeWidget): number[] {
  return widgetConfig(widget, { folderIds: [] as number[] }).folderIds.filter((id) =>
    Number.isInteger(id),
  );
}

/** Whether this card counts the folders its reader chose, rather than every wishlist. */
export function countsChosen(widget: HomeWidget): boolean {
  return pickOf(widget, "scope") === "chosen";
}

/**
 * The question this card asks — {@link SweepScope} — from its settings and the folders there are.
 *
 * * `includeManaged` is the `managed` switch, on unless the reader turned it off.
 * * `shelves` is `null` under `All wishlists`. Under `Chosen` it is every chosen folder **and
 *   every folder inside one**, because `WishlistQuery.shelves` answers direct members only and a
 *   chosen drawer means the drawer — a deck's managed folder brings its Tokens child this way. A
 *   chosen id no folder carries any more is dropped; {@link ROOT_SHELF} always stands.
 *
 * Sorted, so the key does not move when the reader ticks the same set in another order.
 */
export function sweepScopeOf(widget: HomeWidget, folders: readonly WishlistFolder[]): SweepScope {
  const includeManaged = toggleOnOf(widget, "managed");
  if (!countsChosen(widget)) return { includeManaged, shelves: null };
  const known = new Set(folders.map((folder) => folder.id));
  const shelves = new Set<number>();
  for (const id of savingsFolderIds(widget)) {
    if (id === ROOT_SHELF) {
      shelves.add(ROOT_SHELF);
      continue;
    }
    if (!known.has(id)) continue;
    shelves.add(id);
    for (const inside of folderDescendants(folders, id)) shelves.add(inside);
  }
  return { includeManaged, shelves: [...shelves].sort((a, b) => a - b) };
}

/**
 * The moves split by whether they can be priced: the priced ones **biggest saving first** (ties by
 * name, through `sortOptions`, which copies), how many cannot be, and the sum of what can. A move
 * with no `saved` is never added as zero.
 */
export function splitSavings(moves: readonly WishOptimizeMove[]): {
  priced: WishOptimizeMove[];
  unpriced: number;
  total: number;
} {
  const priced = sortOptions(
    moves.filter((move) => move.saved !== null),
    (move) => move.name,
    (move) => [-(move.saved ?? 0)],
  );
  const total = priced.reduce((sum, move) => sum + (move.saved ?? 0), 0);
  return { priced, unpriced: moves.length - priced.length, total };
}

/** `Pinned $40.00 · cheapest $21.60` — both prices per copy — and the copies when there are more
 *  than one, so a saving twice the difference reads as what it is. */
export function moveCaption(move: WishOptimizeMove, currency: Currency): string {
  const base = `Pinned ${formatPrice(move.from.price, currency)} · cheapest ${formatPrice(move.to.price, currency)}`;
  return move.quantity > 1 ? `${base} · ${count(move.quantity)} copies` : base;
}

/**
 * The moves that did not fit: `4 more save $11.45`, said as `4 more wishes save $11.45`.
 *
 * **Only the priced moves count, in the number as in the sum.** The body only ever cuts from the
 * priced list, so this is a fence for the next caller rather than a branch the card takes: an
 * unpriced move handed in is neither counted as a wish that saves nor added as zero, and a cut with
 * nothing priced in it answers `null` rather than `0 more wishes save $0.00`.
 *
 * Each footer answers two spellings (`FooterWords`), because a footer is one line
 * (`WidgetFooterLine`): the `line` is drawn and the `said` sentence is its hint and what a screen
 * reader hears. See the module doc's *Footers are one line*.
 */
export function cutFooter(cut: readonly WishOptimizeMove[], currency: Currency): FooterWords | null {
  const priced = cut.filter((move) => move.saved !== null);
  if (priced.length === 0) return null;
  const sum = formatPrice(
    priced.reduce((total, move) => total + (move.saved ?? 0), 0),
    currency,
  );
  const n = priced.length;
  return {
    line: `${count(n)} more ${n === 1 ? "saves" : "save"} ${sum}`,
    said: `${count(n)} more ${n === 1 ? "card saves" : "cards save"} ${sum}`,
  };
}

/** The moves with no current price, on their own line: `2 more: no current price`, said as
 *  `2 more have no current price`. */
export function unpricedFooter(n: number): FooterWords {
  return {
    line: `${count(n)} more: no current price`,
    said: `${count(n)} more ${n === 1 ? "has" : "have"} no current price`,
  };
}

/** The pinned wishes the plan could not compare, beside moves it could: `2 more: no Card Kingdom
 *  price`, said as `2 more have no price at Card Kingdom to compare against`. */
export function skippedFooter(n: number, marketplace: Marketplace): FooterWords {
  return {
    line: `${count(n)} more: no ${marketplace.label} price`,
    said: `${count(n)} more ${n === 1 ? "has" : "have"} no ${marketplace.label} price`,
  };
}

/** No move, and pinned wishes the plan could not compare — a sentence, never *already cheapest*. */
export function skippedOnly(n: number, marketplace: Marketplace): string {
  return `${plural(n, "pinned card")} ${
    n === 1 ? "has" : "have"
  } no ${marketplace.label} price, so savings can't be calculated.`;
}

/** Moves exist and none of them can be priced — a sentence, never `Could save $0.00`. */
export function unpricedOnly(n: number, marketplace: Marketplace): string {
  return `${plural(n, "pinned card")} ${n === 1 ? "has" : "have"} a cheaper printing, but ${
    n === 1 ? "its current printing has" : "their current printings have"
  } no ${marketplace.label} price, so savings can't be calculated.`;
}

/** What a body this size draws of a card with moves to show. */
export interface SavingsLayout {
  /** Wish rows, the biggest savings first. */
  rows: number;
  /** Whether the cut line is drawn — only under rows, and only when some were cut. */
  cut: boolean;
  /** How many of the other lines are drawn: the unpriced line, then the skipped one. */
  lines: number;
}

/**
 * How much of the card a box holds: the figure always, then rows, the cut line and the other
 * lines — **never a row or a line the body cannot hold, at any footprint down to `CELL_MIN`.**
 *
 * The furniture is reserved before the rows are laid in — the figure line, the unpriced and the
 * skipped line when there is one of each, and the cut line **only when rows are cut**, which is
 * known only once the rows without it are counted. The second count can only shrink, so the cut
 * line is never drawn into space nothing reserved. **Rows are counted with `fitCount`, whose zero
 * is a real answer, and never with `rowsFit`, which floors at one** — that floor drew a wish row
 * into a 2×2 at the smallest window the app allows (1024px, a 181px card) and the body scrolled:
 * 3px under the cut line alone, 27px comfortable and 16px compact under two lines (the live
 * re-check, 2026-09-26, debug build). `ComingSoonWidget`'s `layoutFor` is the same rule.
 *
 * **Where no row fits under its lines, the card is the figure and as many of the other lines as
 * fit under it**, in their drawing order, then the figure alone. No cut line there: with no row
 * drawn it would restate the figure, which already counts every wish (`on N wishes`), so what is
 * not drawn is still said truthfully. The figure's reservation less the gap nothing follows is what
 * a figure with no row under it costs; at `CELL_MIN` that is 66px comfortable and 57 compact, inside
 * a 96px and a 98px body.
 */
export function savingsLayout(
  fit: WidgetFit,
  { priced, lines, rowPx }: { priced: number; lines: number; rowPx: number },
): SavingsLayout {
  const figure = fit.compact ? FIGURES_COMPACT_PX : FIGURES_PX;
  const line = footerLinePx(fit);
  const rows = (reserved: number) => fit.fitCount(rowPx, reserved) * fit.listColumns;
  const all = rows(figure + lines * line);
  if (priced <= all) return { rows: priced, cut: false, lines };
  const room = rows(figure + (lines + 1) * line);
  if (room > 0) return { rows: room, cut: true, lines };
  const alone = figure - bodyGapPx(fit.h, fit.compact);
  const fitting = Math.max(0, Math.floor((fit.bodyHeightPx - alone) / line));
  return { rows: 0, cut: false, lines: Math.min(lines, fitting) };
}

export function WishlistSavingsWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  const { marketplace, currency } = useMarketplace();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setPendingOptimize = useAppStore((s) => s.setPendingOptimize);

  // The folders are read only when a chosen set has to be expanded into them — a card counting
  // every wishlist has no use for the tree.
  const chosen = countsChosen(widget);
  const chosenIds = savingsFolderIds(widget);
  const needsFolders = chosen && chosenIds.length > 0;
  const folderList = useWishlistFolderList({ enabled: needsFolders });
  const scope = sweepScopeOf(widget, folderList.folders);
  const asks = !chosen || (folderList.query.isSuccess && (scope.shelves?.length ?? 0) > 0);

  const query = useQuery({
    queryKey: wishlistSavingsKey(marketplace.id, scope),
    // `useWishlistOptimize`'s own payload for this question, spelled the same way: the key is the
    // hook's, so the value cached under it has to be the answer the hook would have fetched.
    // `limit`/`offset` are required by `WishlistQuery` and ignored by the command.
    queryFn: () =>
      ipc.wishlistOptimizePlan({
        ...wholeWishlistQuery(marketplace.id, scope),
        limit: 0,
        offset: 0,
      }),
    // Not asked until the chosen folders are known: a chosen set read against an empty tree would
    // count the root alone, and that answer would be drawn for a moment as if it were the card's.
    enabled: asks,
  });

  if (chosen && chosenIds.length === 0) return <WidgetMessage>{NOTHING_CHOSEN}</WidgetMessage>;
  if (needsFolders && folderList.query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load your wishlists — {ipcError(folderList.query.error)}
      </WidgetMessage>
    );
  }
  if (needsFolders && folderList.query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (chosen && (scope.shelves?.length ?? 0) === 0) {
    return <WidgetMessage>{CHOSEN_GONE}</WidgetMessage>;
  }

  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load wishlist prices — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;

  const plan = query.data;
  const { skipped } = plan;
  if (plan.considered === 0) return <WidgetMessage>{NO_WISHES}</WidgetMessage>;
  if (plan.moves.length === 0) {
    return (
      <WidgetMessage>{skipped === 0 ? ALL_CHEAPEST : skippedOnly(skipped, marketplace)}</WidgetMessage>
    );
  }
  const skippedLine =
    skipped > 0 ? <WidgetFooterLine {...skippedFooter(skipped, marketplace)} /> : null;
  const { priced, unpriced, total } = splitSavings(plan.moves);
  if (priced.length === 0) {
    return (
      <>
        <WidgetMessage>{unpricedOnly(unpriced, marketplace)}</WidgetMessage>
        {skippedLine}
      </>
    );
  }

  const tile = fit.tier === 0;
  const captioned = tile || !fit.compact;
  const layout = savingsLayout(fit, {
    priced: priced.length,
    lines: (unpriced > 0 ? 1 : 0) + (skipped > 0 ? 1 : 0),
    rowPx: captioned ? ROW_CAPTIONED : ROW_BARE,
  });
  const shown = priced.slice(0, layout.rows);
  const cutWords = layout.cut ? cutFooter(priced.slice(layout.rows), currency) : null;
  // The other lines in their drawing order, as many as the box holds.
  const lines: FooterWords[] = [
    ...(unpriced > 0 ? [unpricedFooter(unpriced)] : []),
    ...(skipped > 0 ? [skippedFooter(skipped, marketplace)] : []),
  ].slice(0, layout.lines);

  const openOptimise = still
    ? undefined
    : () => {
        setActiveView("wishlist");
        setPendingOptimize(scope);
      };
  const totalText = formatPrice(total, currency);
  const wishes = plural(priced.length, "card");

  return (
    <>
      {/* The rule under the figure divides it from rows, so it is drawn only above some. */}
      <WidgetFigures
        fit={fit}
        divided={shown.length > 0}
        figures={[
          {
            key: "saved",
            label: "Could save",
            value: totalText,
            note: `on ${wishes}`,
            tone: "accent",
            hint: pricesAsOf(marketplace),
            onPress: openOptimise,
            pressLabel:
              openOptimise === undefined
                ? undefined
                : `Could save ${totalText} on ${wishes} · Optimize prices`,
          },
        ]}
      />
      {/* No list at all when no row fits: an empty one would still take the body's gap. */}
      {shown.length > 0 && (
        <WidgetRowList fit={fit} label="Wishlist cards that could be cheaper">
          {shown.map((move) => {
            const saved = formatPrice(move.saved, currency);
            const caption = moveCaption(move, currency);
            // The whole row in one string (`DecksWidget.tsx`'s rule), saying what the figure is.
            const pressLabel =
              openOptimise === undefined ? undefined : `${move.name} · ${caption} · saves ${saved}`;
            return tile ? (
              <WidgetRow
                key={move.wishId}
                name={move.name}
                caption={saved}
                captionStrong
                onPress={openOptimise}
                pressLabel={pressLabel}
              />
            ) : (
              <WidgetRow
                key={move.wishId}
                name={move.name}
                caption={captioned ? caption : undefined}
                value={saved}
                onPress={openOptimise}
                pressLabel={pressLabel}
              />
            );
          })}
        </WidgetRowList>
      )}
      {cutWords !== null && <WidgetFooterLine {...cutWords} />}
      {lines.map((words) => (
        <WidgetFooterLine key={words.line} {...words} />
      ))}
    </>
  );
}

/**
 * The words the `Which wishlists` row and its `Chosen` option carry, read off the registry — so the
 * sentence that points at them cannot come to name a control that has been renamed. `DecksWidget`'s
 * `scopeWords`, for its reason.
 */
function scopeWords(): { row: string; chosen: string } {
  const pick = widgetMeta("wishlistSavings").picks.find((entry) => entry.key === "scope");
  return {
    row: pick?.label ?? "Which wishlists",
    chosen: pick?.options.find((option) => option.id === "chosen")?.label ?? "Chosen",
  };
}

/** The root's row in the checklist: the wishes filed in no folder, which are a wishlist too. */
const ROOT_OPTION = "Not in a folder";

/**
 * The checklist behind `Chosen`: the root, then every folder in the tree's own order — the reader
 * arranged it, so it is not sorted (`src/CLAUDE.md`'s exemption) — each named as the Folders
 * widget's picker names it, a deck's managed wishlist saying so. **The managed folders are left out
 * while the `managed` switch is off**, because ticking one would count nothing — the plan leaves
 * them out — and a control whose every press changes nothing reads as broken. The ticks are kept
 * while hidden, `DecksWidgetSettings`' rule, so switching back brings them back.
 *
 * **Drawn only under `Chosen`**, with a sentence in its place otherwise, for that same reason.
 */
export function WishlistSavingsWidgetSettings({
  widget,
  onConfig,
}: WidgetSettingsProps): ReactElement {
  const chosen = countsChosen(widget);
  const { query, folders } = useWishlistFolderList({ enabled: chosen });
  const folderIds = savingsFolderIds(widget);

  if (!chosen) {
    const words = scopeWords();
    return (
      <p className="m-0 text-xs text-dim">
        Choose {words.chosen} under {words.row} to pick the wishlists this widget counts.
      </p>
    );
  }

  const managed = toggleOnOf(widget, "managed");
  const options: DropdownOption[] = [
    { value: String(ROOT_SHELF), label: ROOT_OPTION },
    ...flattenFolders(buildFolderTree(folders, []))
      .filter((node) => managed || !isManaged(node.folder))
      .map((node) => ({
        value: String(node.folder.id),
        label: wishlistFolderOption(node.folder, folders),
      })),
  ];

  /** Add at the end, remove in place. The page merges the patch, so every other key is kept. */
  const toggle = (value: string) => {
    const id = Number(value);
    onConfig({
      folderIds: folderIds.includes(id)
        ? folderIds.filter((each) => each !== id)
        : [...folderIds, id],
    });
  };

  // What the trigger counts is what the list can show, so a tick hidden with the managed switch
  // off is not counted as a wishlist the card is reading.
  const shown = folderIds.filter((id) => options.some((option) => option.value === String(id)));

  return (
    <div className="flex flex-col gap-2">
      <MultiDropdown
        fill
        size="sm"
        label="Wishlists to count"
        // `DecksWidgetSettings`' threshold, for its reason: a list for a few, a box for many.
        searchable={options.length > 8}
        searchLabel="Search wishlists"
        options={options}
        selected={shown.map(String)}
        onToggle={toggle}
        triggerLabel={shown.length === 0 ? "None chosen" : plural(shown.length, "wishlist")}
      />
      {query.isError && (
        <p className="m-0 text-xs text-destructive">
          Couldn't load your wishlists — {ipcError(query.error)}
        </p>
      )}
    </div>
  );
}
