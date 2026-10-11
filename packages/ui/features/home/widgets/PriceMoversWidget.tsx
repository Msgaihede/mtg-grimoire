/**
 * The owned printings whose price moved most over a window — gainers, losers, or both ranked
 * together by the size of the move.
 *
 * **A body, not a card.** `WidgetCard` draws the title, the chip and the tray; this draws the rows
 * and the footer, cut to the box it was handed.
 *
 * ## Two empty sentences, never one
 *
 * An empty list here means one of two things and a reader must never be handed one for the other.
 * **There is no history yet** — the app has only just started remembering prices, so there is
 * nothing to measure a move against; that heals by itself as refreshes happen, and saying *nothing
 * moved* would be a claim about prices nobody has compared. **Or nothing moved** — there is history
 * behind the window and no owned printing changed price over it, which is a real answer about the
 * reader's cards. `PriceMovers.days` and `since` are what tell the two apart, which is why the
 * command answers them beside the list: a count of zero movers cannot.
 *
 * ## Money
 *
 * Every figure is quoted at the marketplace the reader picked, with that id **in the key**, so a
 * switch re-issues the read — `packages/ui/CLAUDE.md`'s rule, and here it decides more than the numbers:
 * the history is kept per marketplace, so a switch can move the widget from *nothing moved* to
 * *no history yet*. A move is written with its sign, and the minus is a real minus sign (U+2212),
 * which is what every other signed figure on this page draws.
 *
 * **Colour is a fill, never ink** — `WidgetParts.tsx`'s rule: the move sits on a tinted chip in body
 * ink, and the green or red is spent on the chip and on the glyph beside the name.
 *
 * ## One read, whatever the box
 *
 * The read asks for {@link PRICE_MOVERS_READ} rows — the command's own ceiling — and the box cuts
 * that to whole rows. A read sized to the rows that fit would re-issue itself on every drag of the
 * resize corner and draw *pending* over a list that was already right; a hundred rows over local
 * SQLite is not a cost worth that.
 *
 * ## Everything you own, or what the reader chose (issue #906)
 *
 * The `Which cards` pick narrows the widget to **chosen collection folders, wishlist folders and
 * individual cards** — {@link PriceMoversWidgetSettings}' three lists, stored in the widget's own
 * `config` as {@link PriceMoversConfig}. A chosen folder brings every folder filed inside it
 * ({@link moverScopeOf}), the Wishlist savings widget's rule, so `Commander` means the drawer;
 * `Not in a folder` is the root of each cabinet; a deck's group and a deck's managed wishlist are
 * folders like any other, because a filter is not a write. A card may be one the reader does not
 * own: its price is remembered from the next snapshot on, because `useHomeLayout` hands every card
 * a Price movers widget names to `set_price_watch`. So a freshly chosen card has *no history yet*,
 * and says so in its own sentence ({@link CHOSEN_NO_HISTORY}) rather than the collection's. The
 * choices are read off the config in `../priceMoversScope.ts`.
 *
 * ## A mover is a press
 *
 * It opens the price history popup on that printing, at that finish, over the widget's own window
 * — by writing `priceHistory` in the store, because the dialog is mounted at `App` level: this body
 * sits inside the grid's CSS `zoom`, and a dialog drawn from here would inherit it (`App.tsx` says
 * the rest). **Never in a `still` body**, which is a catalogue preview and opens nothing
 * (`widgetProps.ts`), so its rows stay plain rows rather than buttons that go nowhere.
 */
import { useQuery } from "@tanstack/react-query";
import { Plus, TrendingDown, TrendingUp, X } from "lucide-react";
import { useEffect, useId, useState, type ReactElement } from "react";

import { MultiDropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { useCollectionFolderList } from "@/features/collection/useCollectionFolders";
import { DEBOUNCE_MS, searchTerms } from "@/features/search/useCardSearch";
import { useWishlistFolderList } from "@/features/wishlist/useWishlistFolders";
import { plural } from "@/lib/counts";
import { FINISH_LABEL } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { buildFolderTree, flattenFolders } from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type PriceMover,
  type PriceMoverDirection,
  type PriceMovers,
  type PriceMoverWindow,
} from "@/lib/ipc";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";

import { priceMoversKey } from "../keys";
import {
  measuresChosen,
  moverScopeOf,
  namesAnything,
  priceMoversConfig,
  ROOT_FOLDER,
  type ChosenCard,
} from "../priceMoversScope";
import {
  DOWN_FILL,
  UP_FILL,
  WidgetFooter,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
} from "../WidgetParts";
import type { WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { widgetMeta } from "../widgets";
import { pickOf } from "../widgetSettings";
import { collectionFolderOption, wishlistFolderOption } from "./FoldersWidget";

/** How many movers the widget reads — `price_movers`' own clamp. See the module doc. */
export const PRICE_MOVERS_READ = 100;

/** A row's height with its caption, and without — the design's two. */
const ROW_PX = 51;
const BARE_ROW_PX = 36;
/** What the footer line takes off the body, gap included. */
const FOOTER_PX = 22;

/** The minus sign every signed figure draws — never a hyphen. */
const MINUS = "−";

const PENDING = "Loading price history…";
export const NO_HISTORY =
  "No price history yet. Price changes show up here over time.";
/** `Chosen` with nothing chosen — the Wishlist savings widget's `NOTHING_CHOSEN`. */
export const NOTHING_CHOSEN =
  "No folders or cards chosen. Choose them in this widget's settings.";
/** Every chosen folder has been deleted since, and no card was chosen — a race another surface
 *  won, and never a reason to measure the whole collection in their place. */
export const CHOSEN_GONE = "The chosen folders no longer exist.";
/** History exists, and none of it is old enough for anything the reader chose — most often a card
 *  chosen this week, whose price is remembered only from the day it was chosen. */
export const CHOSEN_NO_HISTORY =
  "No price history for your chosen cards yet. Price changes show up here over time.";

/** How many matches the card search offers at once — a list under a field, not a results page. */
const CARD_RESULTS = 8;

/**
 * The most cards one widget follows. **The layout document is capped at 64 KiB** (`home.rs`'
 * `MAX_BYTES`) and every chosen card rides in it with its words, about a hundred bytes each, so a
 * hundred is a tenth of the document — and five such widgets still sit inside the watch list's
 * own 500.
 */
export const MAX_CHOSEN_CARDS = 100;

function windowOf(value: string | number | undefined): PriceMoverWindow {
  return value === "30d" || value === "all" ? value : "7d";
}

function directionOf(value: string | number | undefined): PriceMoverDirection {
  return value === "up" || value === "down" ? value : "both";
}

/** What a window measures against, as the footer says it. */
export function windowPhrase(range: PriceMoverWindow): string {
  return range === "7d"
    ? "the last seven days"
    : range === "30d"
      ? "the last thirty days"
      : "the oldest price kept";
}

/** A move with its sign: `+$184.00`, `−$8.60`. */
export function signedMoney(delta: number, currency: Currency): string {
  return `${delta < 0 ? MINUS : "+"}${formatPrice(Math.abs(delta), currency)}`;
}

/**
 * The sentence for a list with nothing in it — see the module doc for why there are two.
 *
 * `null` when there is something to draw. **History first**: a database remembering its first day
 * of prices has no baseline for any window, and telling that reader nothing moved would be a claim
 * about a comparison nobody made. With history, a window that reaches past the oldest snapshot is
 * the same situation at a longer range and says so in its own words.
 */
export function emptySentence(
  answer: PriceMovers,
  range: PriceMoverWindow,
  direction: PriceMoverDirection,
  chosen = false,
): string | null {
  if (answer.days < 2) return NO_HISTORY;
  if (answer.since === null) {
    // Under a scope the day count is the whole table's, and says nothing about the cards the
    // reader chose — a card chosen on Tuesday has no week behind it however long the app has run.
    if (chosen) return CHOSEN_NO_HISTORY;
    return `Only ${plural(answer.days, "day")} of price history so far. Not enough for ${windowPhrase(range)} yet.`;
  }
  if (answer.movers.length > 0) return null;
  const span = range === "all" ? "since the oldest price kept" : `over ${windowPhrase(range)}`;
  const moved =
    direction === "up" ? "went up" : direction === "down" ? "went down" : "changed price";
  return `Nothing ${chosen ? "you chose" : "you own"} ${moved} ${span}.`;
}

export function PriceMoversWidget({ widget, fit, still }: WidgetBodyProps): ReactElement {
  // `range` rather than `window`, which would shadow the global inside a component body.
  const range = windowOf(pickOf(widget, "window"));
  const direction = directionOf(pickOf(widget, "direction"));
  const { marketplace, currency } = useMarketplace();
  const openPriceHistory = useAppStore((s) => s.openPriceHistory);

  // The folders are read only when a chosen cabinet has to be expanded into them — a widget over
  // everything owned, or over cards alone, has no use for either tree.
  const chosen = measuresChosen(widget);
  const config = priceMoversConfig(widget);
  const needsCollection = chosen && config.collectionFolderIds.some((id) => id !== ROOT_FOLDER);
  const needsWishlist = chosen && config.wishlistFolderIds.some((id) => id !== ROOT_FOLDER);
  const collectionList = useCollectionFolderList({ enabled: needsCollection });
  const wishlistList = useWishlistFolderList({ enabled: needsWishlist });
  const scope = moverScopeOf(widget, collectionList.folders, wishlistList.folders);
  const foldersIn =
    (!needsCollection || collectionList.query.isSuccess) &&
    (!needsWishlist || wishlistList.query.isSuccess);

  const query = useQuery({
    queryKey: priceMoversKey(range, direction, marketplace.id, PRICE_MOVERS_READ, scope),
    // Unscoped is the four-argument read every build before the scope sent.
    queryFn: () =>
      scope === null
        ? ipc.priceMovers(range, direction, marketplace.id, PRICE_MOVERS_READ)
        : ipc.priceMovers(range, direction, marketplace.id, PRICE_MOVERS_READ, scope),
    // Not asked until the chosen folders are known, and never for a scope naming nothing: a
    // chosen set read against an empty tree would measure the roots alone, and that answer would
    // be drawn for a moment as if it were the widget's.
    enabled: scope === null || (foldersIn && namesAnything(scope)),
  });

  if (chosen) {
    const picked =
      config.collectionFolderIds.length + config.wishlistFolderIds.length + config.cards.length;
    if (picked === 0) return <WidgetMessage>{NOTHING_CHOSEN}</WidgetMessage>;
    const failed =
      (needsCollection ? collectionList.query.error : null) ??
      (needsWishlist ? wishlistList.query.error : null);
    if (failed !== null) {
      return (
        <WidgetMessage tone="destructive">
          Couldn't load your folders — {ipcError(failed)}
        </WidgetMessage>
      );
    }
    if (!foldersIn) return <WidgetMessage>{PENDING}</WidgetMessage>;
    if (scope !== null && !namesAnything(scope)) {
      return <WidgetMessage>{CHOSEN_GONE}</WidgetMessage>;
    }
  }

  if (query.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (query.isError) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load price history — {ipcError(query.error)}
      </WidgetMessage>
    );
  }
  const empty = emptySentence(query.data, range, direction, chosen);
  if (empty !== null) return <WidgetMessage>{empty}</WidgetMessage>;

  const bare = fit.compact || fit.tier === 0;
  const footer = fit.tier >= 2 && fit.h >= 2;
  const shown = query.data.movers.slice(
    0,
    // A tile is bare and still carries a caption — its move goes under the name — so it is counted
    // at the captioned height, the rule `SetCompletionWidget.rowPx` writes down.
    fit.rowsFit(bare && fit.tier !== 0 ? BARE_ROW_PX : ROW_PX, footer ? FOOTER_PX : 0),
  );

  return (
    <>
      <WidgetRowList fit={fit} label="Price movers">
        {shown.map((mover) => (
          <MoverRow
            key={`${mover.cardId}:${mover.finish}`}
            mover={mover}
            currency={currency}
            bare={bare}
            tile={fit.tier === 0}
            onPress={
              still
                ? undefined
                : () =>
                    openPriceHistory({ cardId: mover.cardId, finish: mover.finish, window: range })
            }
          />
        ))}
      </WidgetRowList>
      {footer && (
        <WidgetFooter>
          {marketplace.label} prices{chosen ? " of what you chose" : ""}{" "}
          {range === "all" ? "since the oldest price kept" : `over ${windowPhrase(range)}`}.
        </WidgetFooter>
      )}
    </>
  );
}

/**
 * One mover: the glyph that says which way, the name, where it is from, and the move — and, given
 * an `onPress`, a press that opens its price history.
 */
function MoverRow({
  mover,
  currency,
  bare,
  tile,
  onPress,
}: {
  mover: PriceMover;
  currency: Currency;
  bare: boolean;
  tile: boolean;
  /** `undefined` in a still body, which opens nothing — the row is then not a button at all. */
  onPress: (() => void) | undefined;
}): ReactElement {
  const up = mover.delta > 0;
  const Glyph = up ? TrendingUp : TrendingDown;
  const money = signedMoney(mover.delta, currency);
  const caption = `${mover.setCode.toUpperCase()} · ${FINISH_LABEL[mover.finish].toLowerCase()}`;
  const common = {
    name: mover.name,
    icon: <Glyph aria-hidden="true" className="size-3.5" />,
    iconColor: up ? UP_FILL : DOWN_FILL,
    // Both ends of the move, for a pointer — the row itself only has room for the difference.
    hint: `${formatPrice(mover.then, currency)} then, ${formatPrice(mover.now, currency)} now`,
    onPress,
    /**
     * The whole row in one string, `DecksWidget`'s rule: the parts are flex children with a `gap`
     * and no whitespace between them, so name computation would run them together. Every word a
     * wide row shows is here in the order it shows them — which keeps the visible name inside the
     * accessible one (WCAG 2.5.3) and keeps the name a reader speaks the same as the card is
     * resized — and then what the press does.
     */
    pressLabel:
      onPress === undefined ? undefined : `${mover.name} · ${caption} · ${money} — price history`,
  };
  // At two cells the move goes under the name, `WidgetRow`'s rule for a tile.
  return tile ? (
    <WidgetRow {...common} caption={money} captionStrong />
  ) : (
    <WidgetRow
      {...common}
      caption={bare ? undefined : caption}
      value={money}
      delta={up ? "up" : "down"}
    />
  );
}

/**
 * The words the `Which cards` row and its `Chosen` option carry, read off the registry — so the
 * sentence that points at them cannot come to name a control that has been renamed. The Wishlist
 * savings widget's `scopeWords`, for its reason.
 */
function scopeWords(): { row: string; chosen: string } {
  const pick = widgetMeta("priceMovers").picks.find((entry) => entry.key === "scope");
  return {
    row: pick?.label ?? "Which cards",
    chosen: pick?.options.find((option) => option.id === "chosen")?.label ?? "Chosen",
  };
}

/** The root's row in each folder checklist: the copies or wishes filed in no folder. */
const ROOT_OPTION = "Not in a folder";

/** `Lightning Bolt · M21 #161` — a chosen card as its row names it, the printing being what is measured. */
function cardLabel(card: ChosenCard): string {
  return `${card.name} · ${card.setCode.toUpperCase()} #${card.collectorNumber}`;
}

/**
 * The three lists behind `Chosen`: collection folders, wishlist folders, and cards.
 *
 * **Every folder there is, the app's own included and labelled** — the Folders widget's picker,
 * row for row ({@link collectionFolderOption}, {@link wishlistFolderOption}), in the tree's own
 * order (the reader arranged it). A deck's group, `Recently removed` and a deck's managed wishlist
 * are all choosable, because this is a filter and not somewhere to write.
 *
 * **Drawn only under `Chosen`**, with a sentence in its place otherwise — a list whose every press
 * changes nothing on the card reads as broken. The choices are kept while hidden, so switching
 * back brings them back as they were.
 *
 * **Every write is a patch naming one key**, the page merging it into the stored config.
 */
export function PriceMoversWidgetSettings({ widget, onConfig }: WidgetSettingsProps): ReactElement {
  const chosen = measuresChosen(widget);
  const collection = useCollectionFolderList({ enabled: chosen });
  const wishlist = useWishlistFolderList({ enabled: chosen });
  const config = priceMoversConfig(widget);

  if (!chosen) {
    const words = scopeWords();
    return (
      <p className="m-0 text-xs text-dim">
        Choose {words.chosen} under {words.row} to pick the folders and cards this widget follows.
      </p>
    );
  }

  const collectionOptions: DropdownOption[] = [
    { value: String(ROOT_FOLDER), label: ROOT_OPTION },
    ...flattenFolders(buildFolderTree(collection.folders, [])).map((node) => ({
      value: String(node.folder.id),
      label: collectionFolderOption(node.folder),
    })),
  ];
  const wishlistOptions: DropdownOption[] = [
    { value: String(ROOT_FOLDER), label: ROOT_OPTION },
    ...flattenFolders(buildFolderTree(wishlist.folders, [])).map((node) => ({
      value: String(node.folder.id),
      label: wishlistFolderOption(node.folder, wishlist.folders),
    })),
  ];

  /** Add at the end, remove in place. */
  const toggle = (key: "collectionFolderIds" | "wishlistFolderIds", value: string) => {
    const id = Number(value);
    const current = config[key];
    onConfig({
      [key]: current.includes(id) ? current.filter((each) => each !== id) : [...current, id],
    });
  };
  // What a trigger counts is what its list can show, so a folder deleted since is not counted.
  const shown = (ids: readonly number[], options: readonly DropdownOption[]) =>
    ids.filter((id) => options.some((option) => option.value === String(id)));
  const shownCollection = shown(config.collectionFolderIds, collectionOptions);
  const shownWishlist = shown(config.wishlistFolderIds, wishlistOptions);
  const loadError = collection.query.error ?? wishlist.query.error;

  return (
    <div className="flex flex-col gap-3">
      <FolderPicker
        label="Collection folders"
        options={collectionOptions}
        selected={shownCollection}
        onToggle={(value) => toggle("collectionFolderIds", value)}
      />
      <FolderPicker
        label="Wishlist folders"
        options={wishlistOptions}
        selected={shownWishlist}
        onToggle={(value) => toggle("wishlistFolderIds", value)}
      />
      {loadError !== null && (
        <p className="m-0 text-xs text-destructive">
          Couldn't load your folders — {ipcError(loadError)}
        </p>
      )}
      <CardPicker
        cards={config.cards}
        onAdd={(card) => {
          if (config.cards.length >= MAX_CHOSEN_CARDS) return;
          if (config.cards.some((each) => each.id === card.id)) return;
          onConfig({ cards: [...config.cards, card] });
        }}
        onRemove={(id) => onConfig({ cards: config.cards.filter((each) => each.id !== id) })}
      />
    </div>
  );
}

/** One cabinet's checklist — a visible label, and a trigger saying how many are chosen. */
function FolderPicker({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly DropdownOption[];
  selected: readonly number[];
  onToggle: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="grid gap-1">
      {/* Both `id` and `labelledBy`, the Folders widget's `Picker` and its reason. */}
      <label id={`${id}-label`} htmlFor={id} className="text-xs text-dim">
        {label}
      </label>
      <MultiDropdown
        id={id}
        labelledBy={`${id}-label`}
        fill
        size="sm"
        // `DecksWidgetSettings`' threshold, for its reason: a list for a few, a box for many.
        searchable={options.length > 8}
        searchLabel={`Search ${label.toLowerCase()}`}
        options={options}
        selected={selected.map(String)}
        onToggle={onToggle}
        triggerLabel={selected.length === 0 ? "None chosen" : plural(selected.length, "folder")}
      />
    </div>
  );
}

/** The search field's box — `StickyNoteDialog`'s name field, a step smaller for a popover. */
const SEARCH_FIELD = cn(
  "h-8 w-full min-w-0 rounded-md border border-border bg-bg px-2 text-[0.8125rem] coarse:text-base",
  "placeholder:text-dim focus:border-accent focus:outline-none",
);

/** A row's press: the whole row, in body ink, the accent on hover. */
const ROW_BUTTON = cn(
  "flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-[0.8125rem]",
  "text-text hover:text-accent coarse:min-h-[var(--target-min)]",
  FOCUS,
);

/**
 * The chosen cards, and a field to find more — **any printing in the card data, owned or not**.
 *
 * The field is the app's card search with Scryfall's syntax ({@link searchTerms}), so `bolt s:m21`
 * finds one printing; the matches are printings rather than cards, because a price is a printing's.
 * Debounced by the app's own 300ms, and an empty field asks nothing. A match already chosen is not
 * offered again. The chosen list is drawn from the words stored beside each id, so it needs no read.
 */
function CardPicker({
  cards,
  onAdd,
  onRemove,
}: {
  cards: readonly ChosenCard[];
  onAdd: (card: ChosenCard) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  const fieldId = useId();
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const { marketplace } = useMarketplace();

  useEffect(() => {
    const timer = setTimeout(() => setAsked(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const search = useQuery({
    // Under `["cards"]` and not `["cards", "search"]`: that root is patched in place after every
    // owned write by code that expects an infinite query's pages there — `useTradeCandidates`.
    queryKey: ["cards", "moverCandidates", marketplace.id, asked],
    queryFn: () =>
      ipc.searchCards({
        ...searchTerms(asked),
        marketplace: marketplace.id,
        limit: CARD_RESULTS,
        offset: 0,
      }),
    enabled: asked.length > 0,
  });

  const full = cards.length >= MAX_CHOSEN_CARDS;
  const chosenIds = new Set(cards.map((card) => card.id));
  const matches =
    full || text.trim().length === 0
      ? []
      : (search.data?.items ?? []).filter((item) => !chosenIds.has(item.id));

  return (
    <div className="grid gap-1">
      <label htmlFor={fieldId} className="text-xs text-dim">
        Cards
      </label>
      {cards.length > 0 && (
        <ul aria-label="Chosen cards" className="m-0 grid list-none gap-0.5 p-0">
          {cards.map((card) => (
            <li key={card.id} className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{cardLabel(card)}</span>
              <button
                type="button"
                aria-label={`Remove ${cardLabel(card)}`}
                onClick={() => onRemove(card.id)}
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-sm text-dim hover:text-text",
                  "coarse:size-[var(--target-min)]",
                  FOCUS,
                )}
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={fieldId}
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search any card"
        disabled={full}
        className={cn(SEARCH_FIELD, "disabled:opacity-50")}
      />
      {full && (
        <p className="m-0 text-xs text-dim">
          This widget follows {MAX_CHOSEN_CARDS} cards, its most. Remove one to add another.
        </p>
      )}
      {search.isError && text.trim().length > 0 && (
        <p className="m-0 text-xs text-destructive">
          Couldn't search cards — {ipcError(search.error)}
        </p>
      )}
      {matches.length > 0 && (
        <ul aria-label="Matching cards" className="m-0 grid list-none gap-0.5 p-0">
          {matches.map((item) => {
            const card: ChosenCard = {
              id: item.id,
              name: item.name,
              setCode: item.setCode,
              collectorNumber: item.collectorNumber,
            };
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-label={`Add ${cardLabel(card)}`}
                  onClick={() => onAdd(card)}
                  className={ROW_BUTTON}
                >
                  <Plus aria-hidden="true" className="size-3.5 shrink-0 text-dim" />
                  <span className="min-w-0 flex-1 truncate">{cardLabel(card)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 text-xs text-dim">
        Prices of cards you don't own are remembered from the next price update on.
      </p>
    </div>
  );
}
