/**
 * **Deck colors** — every colour combination in Magic, and the reader's decks in each one.
 *
 * A reader building a deck for every colour identity keeps a sheet: thirty-two rows, the decks
 * written beside the colours they play, the empty rows the ones still to build. This is that sheet,
 * kept for them — filled from their own decks, refreshed by every deck write, and pressable: a deck
 * opens in the editor. `deckColors.ts` owns every rule (what colour a deck is, which decks count,
 * the order inside a row); this file draws the answer into the box `fit` describes.
 *
 * ## What a row shows
 *
 * The combination's mana symbols, its name (`Azorius`, `Witch-Maw`; the `names` switch, and never on
 * a two-cell tile, where the symbols are the name), and its decks as chips: the deck's name or its
 * cover (`face`), the bracket the reader declared (`bracket`) and the reader's own deck tags (`tags`).
 * **The bracket is the declared one only.** The gallery's `~3` reading is estimated from every card
 * of every deck (`deck_bracket_reads`), a read the home page's graph does not carry; a deck on Auto
 * shows no bracket here rather than a guess. An empty combination is a dashed slot — the row a
 * reader's sheet leaves blank — unless the reader turned `empty` off.
 *
 * `limit: first` is the request's other layout: one deck a combination and a `+N` press that opens
 * the rest **in place**, so the sheet stays one line a colour until the reader asks for more.
 *
 * ## Arranging
 *
 * **Which deck stands first in a combination is the reader's** (`deckOrder` in the config, read by
 * `arranged`). A chip is dragged onto another chip of its own combination, or moved one place with
 * Ctrl+← / Ctrl+→ while focused — `StickyNotesWidget`'s chord and its reason: plain arrows are left
 * for a caret walk. A deck the reader has never placed stands after the placed ones, by name.
 *
 * ## The box
 *
 * The body scrolls: thirty-two rows are the widget's subject, and cutting them to whole rows — every
 * other list widget's rule — would cut the very rows that are empty. Wide cards lay the five sections
 * out in balanced columns (`columns`), so an eight-cell card shows the whole sheet at once.
 */
import { useQuery } from "@tanstack/react-query";
import { Tag } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { CardImage } from "@/components/CardImage";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { coverUrl } from "@/features/decks/deckCover";
import { folderPaths } from "@/features/decks/DeckSettingsForm";
import { plural } from "@/lib/counts";
import { DROP_EDGE } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import { ART_ASPECT } from "@/lib/images";
import { ipc, ipcError, type DeckRow, type HomeWidget } from "@/lib/ipc";
import { MANA_LABEL, manaSymbolClass } from "@/lib/mana";
import { PRESS, PRESS_SOFT } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { useImageRetry } from "@/lib/useImageRetry";
import { cn } from "@/lib/utils";

import {
  COMBOS,
  colorSources,
  colorsScope,
  comboLetters,
  deckColorsView,
  deckOrder,
  decksInScope,
  folderWhitelist,
  rearranged,
  type ComboOrder,
  type ComboRow,
  type DeckColorsView,
} from "../deckColors";
import { movedTo, steppedBy, useDeckColorChip } from "../deckColorsDrag";
import type { WidgetFit } from "../fit";
import { deckCommanderIdentitiesKey, deckFoldersKey, deckListKey, deckPipCostsKey } from "../keys";
import { WidgetMessage } from "../WidgetParts";
import type { ConfigPatch, WidgetBodyProps, WidgetSettingsProps } from "../widgetProps";
import { SettingsCheck, SettingsPicker } from "../WidgetSettingsPanel";
import { pickOf, toggleOnOf } from "../widgetSettings";
import { widgetMeta } from "../widgets";

export const LOADING = "Loading decks…";
export const NO_DECKS = "No decks yet. Build one on the Decks page.";
export const NOTHING_CHOSEN = "No folders chosen. Pick folders in this widget's settings.";
export const NONE_IN_FOLDERS = "No decks in the chosen folders.";

/** How a test and a live pass find one deck's chip: the value is the deck's id. */
export const DECK_CHIP_ATTR = "data-deck-chip";
/** …and one combination's row: the value is its `ComboKey` (`"WU"`, `""` for colourless). */
export const COMBO_ROW_ATTR = "data-combo";

/** The narrowest a column of sections is drawn: the symbols, a name, and room for two chips. */
const COLUMN_MIN_PX = 300;
/** The most columns a card lays its sections out in — five sections, so three is already two
 *  to a column on the widest card. */
const MAX_COLUMNS = 3;

/**
 * A combination's symbols sit in a box five symbols wide, right-aligned, so every name and every
 * first deck in a section starts at the same edge — the sheet's columns B–F. A two-cell tile draws
 * them a size down: there the symbols are the only name a row has, and the chips need the width.
 */
const PIPS_BOX = {
  wide: "w-[4.75rem] text-[0.6875rem]",
  tile: "w-[3.875rem] text-[0.5625rem]",
} as const;
/** The longest name is `Ink-Treader` at the row's 12px. */
const NAME_BOX = "w-[5.25rem]";

/** The chip's two heights, one a density. Every row is at least one chip tall, so the symbols
 *  and the name line up with the first line of decks rather than floating over a wrapped second. */
const CHIP_H = { comfortable: "h-6", compact: "h-5" } as const;
const ROW_MIN = { comfortable: "min-h-6", compact: "min-h-5" } as const;
/** A cover chip's width, one a density; its height is the art crop's own ratio. */
const COVER_W = { comfortable: 72, compact: 60 } as const;

/** The bracket mark — `DeckTile`'s `TILE_MARK` face (gold hairline, mono figure) at a chip's size. */
const BRACKET_MARK =
  "flex-none rounded-sm border border-accent/70 px-1 font-mono text-[0.625rem] leading-4 text-accent";
/** One deck tag — `DeckTile`'s `TILE_TAG` felt and ink at a chip's size. */
const TAG_MARK =
  "min-w-0 max-w-[7rem] truncate rounded-sm border border-border bg-bg/70 px-1 text-[0.625rem] leading-4 text-text";
/** A tag in the chip's hint, which wraps rather than truncating. */
const TIP_TAG = "rounded-sm border border-border bg-bg/70 px-1.5 text-xs leading-5 text-text";

type Face = "name" | "art";
type Density = keyof typeof CHIP_H;

/** The words a bracket is said in: the declared one, or `null` for a deck left on Auto. */
function bracketWords(deck: DeckRow): string | null {
  return deck.bracket > 0 ? `Bracket ${deck.bracket}` : null;
}

/**
 * One chip's accessible name: every fact it can show, whatever this box happens to draw — so the
 * name a reader drives by voice does not change as the card is resized or a switch is flipped.
 */
function chipLabel(deck: DeckRow): string {
  const parts = [deck.name, deck.formatName ?? deck.formatKey];
  const bracket = bracketWords(deck);
  if (bracket !== null) parts.push(bracket);
  if (deck.tags.length > 0) parts.push(`Tags: ${deck.tags.join(", ")}`);
  if (deck.archived) parts.push("Archived");
  return parts.join(" · ");
}

/**
 * A combination's symbols, as the printed article — `ManaText`'s `ms-cost` pills.
 *
 * **The size is the box's, not the glyph's.** `mana-font`'s `.ms-cost` sets its own `font-size:
 * 0.95em`, which beats a size class on the `<i>` itself (measured: 15.2px, five pills 80px in a
 * 76px box), so the box carries the type size and the pills are 0.95 of it — five of them at 11px
 * are 72px, inside {@link PIPS_BOX}'s 76.
 */
function Pips({ letters, tile }: { letters: readonly string[]; tile: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex flex-none items-center justify-end gap-px",
        PIPS_BOX[tile ? "tile" : "wide"],
      )}
    >
      {(letters.length === 0 ? ["C"] : letters).map((letter) => (
        <i key={letter} className={cn(manaSymbolClass(letter as "W"), "ms-cost")} />
      ))}
    </span>
  );
}

/** What a combination's colours are called, for the hint and the screen reader. */
function colorWords(letters: readonly string[]): string {
  return letters.length === 0
    ? MANA_LABEL.C
    : letters.map((letter) => MANA_LABEL[letter as "W"]).join(", ");
}

export function DeckColorsWidget({ widget, fit, still, onConfig }: WidgetBodyProps): ReactElement {
  const scope = colorsScope(widget);
  const decksQuery = useQuery({ queryKey: deckListKey, queryFn: () => ipc.deckList() });
  const pipsQuery = useQuery({ queryKey: deckPipCostsKey, queryFn: () => ipc.deckPipCosts() });
  const identitiesQuery = useQuery({
    queryKey: deckCommanderIdentitiesKey,
    queryFn: () => ipc.deckCommanderIdentities(),
  });
  // Only a whitelist reads the folders: under `All decks` the tree changes nothing on the card.
  const foldersQuery = useQuery({
    queryKey: deckFoldersKey,
    queryFn: () => ipc.deckFolderList(),
    enabled: scope === "chosen",
  });

  if (decksQuery.isError) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load your decks — {ipcError(decksQuery.error)}
      </WidgetMessage>
    );
  }
  const colorError = pipsQuery.error ?? identitiesQuery.error;
  if (colorError) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't read your decks' colors — {ipcError(colorError)}
      </WidgetMessage>
    );
  }
  if (scope === "chosen" && foldersQuery.isError) {
    return (
      <WidgetMessage tone="destructive">
        Couldn't load your deck folders — {ipcError(foldersQuery.error)}
      </WidgetMessage>
    );
  }
  if (
    decksQuery.isPending ||
    pipsQuery.isPending ||
    identitiesQuery.isPending ||
    (scope === "chosen" && foldersQuery.isPending)
  ) {
    return <WidgetMessage>{LOADING}</WidgetMessage>;
  }

  const decks = decksQuery.data;
  if (decks.length === 0) return <WidgetMessage>{NO_DECKS}</WidgetMessage>;
  if (scope === "chosen") {
    const list = folderWhitelist(widget);
    if (list.folderIds.length === 0 && !list.unfiled) {
      return <WidgetMessage>{NOTHING_CHOSEN}</WidgetMessage>;
    }
  }

  const counted = decksInScope(decks, foldersQuery.data ?? [], widget);
  if (scope === "chosen" && counted.length === 0) {
    return <WidgetMessage>{NONE_IN_FOLDERS}</WidgetMessage>;
  }
  const sources = colorSources(decks, identitiesQuery.data ?? [], pipsQuery.data ?? []);
  const order = deckOrder(widget);
  const view = deckColorsView(
    counted,
    sources,
    order,
    pickOf(widget, "sort") === "pie" ? "pie" : ("alpha" satisfies ComboOrder),
  );

  return (
    <Sheet
      widget={widget}
      fit={fit}
      still={still}
      view={view}
      order={order}
      existing={decks}
      onConfig={onConfig}
    />
  );
}

/** The drawn sheet — its own component so its local state (which rows are opened) and its hooks
 *  sit below the early returns above. */
function Sheet({
  widget,
  fit,
  still,
  view,
  order,
  existing,
  onConfig,
}: {
  widget: HomeWidget;
  fit: WidgetFit;
  still: boolean;
  view: DeckColorsView;
  order: readonly number[];
  existing: readonly DeckRow[];
  onConfig: ConfigPatch;
}): ReactElement {
  const tip = useTooltip();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);
  /** The deck a keyboard move just stepped. React moves a keyed node by re-inserting it, which
   *  blurs it in Chromium, so the chip is handed its focus back after the write has drawn. */
  const refocus = useRef<number | null>(null);

  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    box.current?.querySelector<HTMLElement>(`[${DECK_CHIP_ATTR}="${id}"]`)?.focus();
  });

  const face: Face = pickOf(widget, "face") === "art" ? "art" : "name";
  const first = pickOf(widget, "limit") === "first";
  const showBracket = toggleOnOf(widget, "bracket");
  const showTags = toggleOnOf(widget, "tags");
  const showEmpty = toggleOnOf(widget, "empty");
  // A two-cell tile has no width for a name beside the symbols and the decks: the symbols are the
  // name there, and the hint on them still says it.
  const showNames = toggleOnOf(widget, "names") && fit.tier > 0;
  const density: Density = fit.compact ? "compact" : "comfortable";
  const columns = Math.max(1, Math.min(MAX_COLUMNS, Math.floor(fit.bodyWidthPx / COLUMN_MIN_PX)));
  const existingIds = new Set(existing.map((deck) => deck.id));

  const openDeck = (id: number) => {
    // `setActiveView` first: it clears `openDeckId` on the way in — `DecksWidget`'s reason.
    setActiveView("decks");
    setOpenDeckId(id);
  };

  /** Store a row's new order. `rearranged` keeps every other row's arrangement as it was. The
   *  drop target reads its callbacks through a ref, so a fresh function per render costs nothing. */
  const writeRow = (row: readonly number[]) =>
    onConfig({ deckOrder: rearranged(order, row, existingIds) });

  const toggleOpened = (key: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groups = view.groups
    .map((group) => ({
      ...group,
      rows: showEmpty ? group.rows : group.rows.filter((row) => row.decks.length > 0),
    }))
    .filter((group) => group.rows.length > 0);

  const summary = `${view.covered} of ${COMBOS.length} colors · ${plural(view.placed, "deck")}`;
  const uncoloured = view.uncoloured;

  return (
    <div ref={box} className="flex min-w-0 flex-col gap-2">
      <p className="relative m-0 flex flex-wrap items-baseline gap-x-1.5 text-xs text-dim">
        {/* Said once, whole, ahead of the drawn line — which splits the figure out to ink it. */}
        <span className="sr-only">{summary}</span>
        <span aria-hidden="true">
          <span className="font-mono text-text tabular-nums">{view.covered}</span> of{" "}
          {COMBOS.length} colors
        </span>
        <span aria-hidden="true">·</span>
        <span aria-hidden="true">{plural(view.placed, "deck")}</span>
        {uncoloured.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span
              className="underline decoration-dotted underline-offset-2"
              {...tip(
                <span className="flex flex-col gap-0.5">
                  <span>No colors yet — no commander and no cards with a mana cost:</span>
                  {uncoloured.map((deck) => (
                    <span key={deck.id} className="text-text">
                      {deck.name}
                    </span>
                  ))}
                </span>,
              )}
            >
              {plural(uncoloured.length, "deck")} without colors yet
            </span>
          </>
        )}
      </p>

      {groups.length === 0 ? (
        <WidgetMessage>No colors have a deck yet.</WidgetMessage>
      ) : (
        <div style={{ columnCount: columns, columnGap: 16 }}>
          {groups.map(({ group, rows, covered }) => (
            <Section
              key={group.size}
              label={group.label}
              covered={covered}
              total={group.combos.length}
            >
              {rows.map((row) => (
                <Row
                  key={row.combo.key}
                  row={row}
                  face={face}
                  density={density}
                  showNames={showNames}
                  tile={fit.tier === 0}
                  showBracket={showBracket}
                  showTags={showTags}
                  first={first}
                  opened={opened.has(row.combo.key)}
                  onToggleOpened={() => toggleOpened(row.combo.key)}
                  still={still}
                  onOpen={openDeck}
                  onArrange={(next, moved) => {
                    if (moved !== undefined) refocus.current = moved;
                    writeRow(next);
                  }}
                />
              ))}
            </Section>
          ))}
        </div>
      )}
    </div>
  );
}

/** One section: its heading, how many of its combinations are covered, and its rows. Never split
 *  across two columns — a heading at the foot of one column over rows at the top of the next
 *  would be two sections. */
function Section({
  label,
  covered,
  total,
  children,
}: {
  label: string;
  covered: number;
  total: number;
  children: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mb-2.5 break-inside-avoid last:mb-0">
      <h4
        id={id}
        className={cn(
          "m-0 mb-1 flex items-baseline justify-between gap-2 border-b border-border pb-0.5",
          "text-[0.6875rem] font-normal tracking-[0.04em] text-dim uppercase",
        )}
      >
        <span>{label}</span>
        <span className="font-mono tabular-nums" aria-label={`${covered} of ${total} with a deck`}>
          {covered}/{total}
        </span>
      </h4>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">{children}</ul>
    </section>
  );
}

/** One combination: its symbols, its name, and its decks. */
function Row({
  row,
  face,
  density,
  showNames,
  tile,
  showBracket,
  showTags,
  first,
  opened,
  onToggleOpened,
  still,
  onOpen,
  onArrange,
}: {
  row: ComboRow;
  face: Face;
  density: Density;
  showNames: boolean;
  /** A two-cell tile: the symbols a size down. */
  tile: boolean;
  showBracket: boolean;
  showTags: boolean;
  first: boolean;
  opened: boolean;
  onToggleOpened: () => void;
  still: boolean;
  onOpen: (id: number) => void;
  /** Store the row in this order; `moved` is the deck a key press stepped, to keep its focus. */
  onArrange: (row: readonly number[], moved?: number) => void;
}): ReactElement {
  const tip = useTooltip();
  const { combo, decks } = row;
  const letters = comboLetters(combo.key);
  const ids = decks.map((deck) => deck.id);
  const hidden = first && !opened ? Math.max(0, decks.length - 1) : 0;
  const shown = hidden > 0 ? decks.slice(0, 1) : decks;
  const empty = decks.length === 0;
  const pressable = !still;
  const arrangeable = pressable && shown.length > 1;

  /** A drop: the dragged deck takes the target's place. Read through the drop target's ref, so a
   *  fresh function per render is the current row at the drop. */
  const onMove = (dragged: number, target: number) => {
    const to = ids.indexOf(target);
    if (to >= 0) onArrange(movedTo(ids, dragged, to));
  };

  const onNudge = (event: ReactKeyboardEvent, id: number) => {
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = steppedBy(ids, id, step, shown.length);
    if (next.some((each, i) => each !== ids[i])) onArrange(next, id);
  };

  return (
    <li
      {...{ [COMBO_ROW_ATTR]: combo.key }}
      className={cn("flex min-w-0 items-start gap-2", ROW_MIN[density])}
    >
      <span
        className={cn("flex flex-none items-center", CHIP_H[density])}
        {...tip(`${combo.name} — ${colorWords(letters)}`, { describes: false })}
      >
        <Pips letters={letters} tile={tile} />
        <span className="sr-only">
          {combo.name}, {colorWords(letters)}:
        </span>
      </span>
      {showNames && (
        <span
          aria-hidden="true"
          className={cn(
            "flex flex-none items-center truncate text-xs",
            NAME_BOX,
            CHIP_H[density],
            empty ? "text-dim" : "text-text",
          )}
        >
          {combo.name}
        </span>
      )}
      <ul className="m-0 flex min-w-0 flex-1 list-none flex-wrap items-start gap-1 p-0">
        {empty && (
          <li className={cn("w-10 rounded-md border border-dashed border-border", CHIP_H[density])}>
            <span className="sr-only">No deck</span>
          </li>
        )}
        {shown.map((deck) => (
          <DeckChip
            key={deck.id}
            deck={deck}
            combo={combo.key}
            face={face}
            density={density}
            showBracket={showBracket}
            showTags={showTags}
            pressable={pressable}
            arrangeable={arrangeable}
            onOpen={onOpen}
            onMove={onMove}
            onNudge={onNudge}
          />
        ))}
        {first && decks.length > 1 && (
          <li className="flex">
            <button
              type="button"
              disabled={!pressable}
              onClick={onToggleOpened}
              aria-expanded={opened}
              aria-label={
                opened
                  ? `Show only the first ${combo.name} deck`
                  : `Show ${plural(hidden, "more deck")} in ${combo.name}`
              }
              className={cn(
                "rounded-md border border-dashed border-border px-1.5 font-mono text-xs text-dim tabular-nums",
                "hover:border-dim hover:text-text",
                CHIP_H[density],
                PRESS,
                FOCUS,
              )}
            >
              {opened ? "−" : `+${hidden}`}
            </button>
          </li>
        )}
      </ul>
    </li>
  );
}

/** One deck: its name or its cover, its bracket and its tags. A press opens it in the editor. */
function DeckChip({
  deck,
  combo,
  face,
  density,
  showBracket,
  showTags,
  pressable,
  arrangeable,
  onOpen,
  onMove,
  onNudge,
}: {
  deck: DeckRow;
  combo: string;
  face: Face;
  density: Density;
  showBracket: boolean;
  showTags: boolean;
  pressable: boolean;
  arrangeable: boolean;
  onOpen: (id: number) => void;
  onMove: (dragged: number, target: number) => void;
  onNudge: (event: ReactKeyboardEvent, id: number) => void;
}): ReactElement {
  const tip = useTooltip();
  const { attach, armed, over } = useDeckColorChip({ deckId: deck.id, combo }, onMove);
  const bracket = showBracket && deck.bracket > 0 ? deck.bracket : null;
  const tags = showTags ? deck.tags : [];

  const hint = (
    <span className="flex max-w-[16rem] flex-col gap-1">
      <span className="font-medium text-text">{deck.name}</span>
      <span className="text-dim">
        {[deck.formatName ?? deck.formatKey, bracketWords(deck), deck.archived ? "Archived" : null]
          .filter((part) => part !== null)
          .join(" · ")}
      </span>
      {deck.tags.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {deck.tags.map((t) => (
            <span key={t} className={TIP_TAG}>
              {t}
            </span>
          ))}
        </span>
      )}
      {face === "art" && deck.coverArtist && (
        <span className="text-dim">Art by {deck.coverArtist}</span>
      )}
      {arrangeable && <span className="text-dim">Drag, or Ctrl+← / Ctrl+→, to arrange</span>}
    </span>
  );

  const content =
    face === "art" ? (
      <CoverFace deck={deck} bracket={bracket} tags={tags} width={COVER_W[density]} />
    ) : (
      <NameFace deck={deck} bracket={bracket} tags={tags} />
    );

  const shape =
    face === "art"
      ? "relative block overflow-hidden rounded-md border border-border bg-surface p-0"
      : cn(
          "flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border bg-surface px-1.5 text-xs text-text",
          CHIP_H[density],
        );

  return (
    <li className="flex min-w-0 max-w-full">
      {pressable ? (
        <button
          ref={attach}
          type="button"
          {...{ [DECK_CHIP_ATTR]: deck.id }}
          aria-label={chipLabel(deck)}
          aria-keyshortcuts={arrangeable ? "Control+ArrowLeft Control+ArrowRight" : undefined}
          onClick={() => onOpen(deck.id)}
          onKeyDown={arrangeable ? (event) => onNudge(event, deck.id) : undefined}
          {...tip(hint, { describes: false })}
          className={cn(
            shape,
            "text-left hover:border-dim",
            face === "art" ? PRESS_SOFT : PRESS,
            FOCUS,
            armed && DROP_EDGE,
            over && "border-accent bg-accent/15",
          )}
        >
          {content}
        </button>
      ) : (
        <span className={shape} {...{ [DECK_CHIP_ATTR]: deck.id }}>
          {content}
        </span>
      )}
    </li>
  );
}

/** The name face: the deck's name, then its bracket and its first tag. */
function NameFace({
  deck,
  bracket,
  tags,
}: {
  deck: DeckRow;
  bracket: number | null;
  tags: readonly string[];
}): ReactElement {
  return (
    <>
      <span className={cn("min-w-0 truncate", deck.archived && "text-dim")}>{deck.name}</span>
      {bracket !== null && <span className={BRACKET_MARK}>B{bracket}</span>}
      {tags.length > 0 && <span className={TAG_MARK}>{tags[0]}</span>}
      {tags.length > 1 && (
        <span className="flex-none font-mono text-[0.625rem] text-dim">+{tags.length - 1}</span>
      )}
    </>
  );
}

/**
 * The cover face: the deck's art crop, its name on a strip across the foot, its bracket in the top
 * corner and a tag mark when it wears tags — the gallery tile's furniture at a chip's size.
 *
 * **A crop is drawn only where the illustrator can be named** (`coverUrl`, Scryfall's rule for an
 * art crop), and the name is the chip's hint. A deck with no cover draws its name on the felt.
 */
function CoverFace({
  deck,
  bracket,
  tags,
  width,
}: {
  deck: DeckRow;
  bracket: number | null;
  tags: readonly string[];
  width: number;
}): ReactElement {
  const image = useImageRetry(coverUrl(deck));
  return (
    <span className="relative block" style={{ width, aspectRatio: ART_ASPECT }}>
      {image.src !== null && (
        <CardImage
          alt=""
          src={image.src}
          loading="lazy"
          onError={image.onError}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {bracket !== null && (
        <span className={cn(BRACKET_MARK, "absolute top-0.5 right-0.5 bg-bg/80")}>B{bracket}</span>
      )}
      {tags.length > 0 && (
        <span className="absolute top-0.5 left-0.5 flex size-4 items-center justify-center rounded-sm border border-border bg-bg/80 text-text">
          <Tag className="size-2.5" aria-hidden="true" />
        </span>
      )}
      <span
        className={cn(
          "absolute inset-x-0 bottom-0 truncate bg-bg/80 px-1 text-[0.625rem] leading-4",
          deck.archived ? "text-dim" : "text-text",
        )}
      >
        {deck.name}
      </span>
    </span>
  );
}

/** The words the `Which decks` row and its `Chosen folders…` option carry, off the registry. */
function scopeWords(): { row: string; chosen: string } {
  const pick = widgetMeta("deckColors").picks.find((entry) => entry.key === "scope");
  return {
    row: pick?.label ?? "Which decks",
    chosen: pick?.options.find((option) => option.id === "chosen")?.label ?? "Chosen folders…",
  };
}

/** The value the root of the tree is ticked as — never a folder id, which are positive. */
const UNFILED = "unfiled";

/**
 * The folder whitelist, under the registry's rows: every deck folder by its whole path, plus the
 * decks filed in no folder at all, and whether a ticked folder brings its subfolders. Drawn only
 * while `Which decks` is `Chosen folders…`; the ticks are kept while hidden, so switching back
 * finds them. A button puts the decks back in their default order once the reader has arranged any.
 */
export function DeckColorsWidgetSettings({ widget, onConfig }: WidgetSettingsProps): ReactElement {
  const scope = colorsScope(widget);
  const foldersQuery = useQuery({
    queryKey: deckFoldersKey,
    queryFn: () => ipc.deckFolderList(),
    enabled: scope === "chosen",
  });
  const arrangedAny = deckOrder(widget).length > 0;

  const reset = arrangedAny ? (
    <button
      type="button"
      onClick={() => onConfig({ deckOrder: undefined })}
      className={cn(
        "self-start rounded-md border border-border px-2 py-[3px] text-[0.8125rem] leading-snug text-dim hover:text-text",
        PRESS,
        FOCUS,
      )}
    >
      Reset deck order
    </button>
  ) : null;

  if (scope !== "chosen") {
    const words = scopeWords();
    return (
      <div className="flex flex-col gap-2">
        <p className="m-0 text-xs text-dim">
          Set {words.row} to {words.chosen} to count only some folders.
        </p>
        {reset}
      </div>
    );
  }

  const list = folderWhitelist(widget);
  const paths = folderPaths(foldersQuery.data ?? []);
  const offered = new Set(paths.map((entry) => entry.id));
  const options = [
    { value: UNFILED, label: "Not in a folder" },
    ...paths.map((entry) => ({ value: String(entry.id), label: entry.path })),
  ];
  const ticked = list.folderIds.filter((id) => offered.has(id));
  const selected = [...(list.unfiled ? [UNFILED] : []), ...ticked.map(String)];

  /** Add at the end, remove in place; every id this list does not offer is carried through. */
  const toggle = (value: string) => {
    if (value === UNFILED) {
      onConfig({ unfiled: list.unfiled ? undefined : true, scope: "chosen" });
      return;
    }
    const id = Number(value);
    const next = list.folderIds.includes(id)
      ? list.folderIds.filter((each) => each !== id)
      : [...list.folderIds, id];
    onConfig({ folderIds: next, scope: "chosen" });
  };

  return (
    <div className="flex flex-col gap-2">
      <SettingsPicker
        label="Folders to count"
        options={options}
        selected={selected}
        onToggle={toggle}
        triggerLabel={selected.length === 0 ? "None chosen" : plural(selected.length, "folder")}
      />
      <SettingsCheck
        label="Include subfolders"
        checked={list.subfolders}
        // On is the default, so it is stored as absence — the registry's rule for every switch.
        onChange={() => onConfig({ subfolders: list.subfolders ? false : undefined })}
      />
      {foldersQuery.isError && (
        <p className="m-0 text-xs text-destructive">
          Couldn't load your deck folders — {ipcError(foldersQuery.error)}
        </p>
      )}
      {!foldersQuery.isPending && !foldersQuery.isError && paths.length === 0 && (
        <p className="m-0 text-xs text-dim">No deck folders yet. Make one on the Decks page.</p>
      )}
      {reset}
    </div>
  );
}
