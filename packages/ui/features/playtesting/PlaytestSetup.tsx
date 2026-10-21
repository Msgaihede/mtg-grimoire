import { Fragment, useId, useMemo, useState, type JSX, type ReactNode } from "react";
import { CircleCheck, CircleHelp, Fish, Play, Plus, TriangleAlert, X } from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { FILTER_FIELD, FILTER_FOCUS, ToggleChip } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { ViewAllToggle } from "@/components/ViewAllToggle";
import { coverUrl } from "@/features/decks/deckCover";
import {
  deckFormats,
  filterDecks,
  NO_DECK_FILTER,
  type DeckFilter,
} from "@/features/decks/deckFilter";
import { DEFAULT_DECK_SORT, sortDecks, type DeckSort } from "@/features/decks/deckSort";
import { DeckPickTile } from "@/features/decks/DeckTile";
import { NO_WALL_MARKS, wallStyle, type DeckWallMarks } from "@/features/decks/deckWall";
import {
  DeckFolderPickCard,
  decksUnder,
  ParentDeckFolderPickCard,
} from "@/features/decks/FolderCard";
import {
  buildFolderTree,
  flattenFolders,
  ROOT_LABEL,
  type FolderNode,
} from "@/features/decks/FolderTree";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import type { DeckFolder, DeckRow, DeckVariant, PlaytestDifficulty } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { useImageRetry } from "@/lib/useImageRetry";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { DEFAULT_DIFFICULTY, type PlaytestPicks } from "./play/usePlaytestGame";
import {
  gapWords,
  supportSentence,
  usePlaytestSupport,
  type SupportAsk,
  type SupportState,
} from "./support";

/** One seat's pick as the screen holds it: it may have no deck yet. */
export interface SetupSeat {
  deckId: number | null;
  variant: DeckVariant;
}

/** Who sits at the table: the reader and the goldfish, the reader and one opponent, or the reader
 *  and three. */
export type Gamemode = "goldfish" | "duel" | "fourPlayer";

/** The picks as the screen holds them. */
export interface SetupPicks {
  mode: Gamemode;
  /**
   * Four seats, always — the reader's first, then the three opponents'. A duel plays the first
   * two and the goldfish the first alone, and the seats a gamemode does not play keep their picks
   * while the reader goes back and forth between the modes.
   */
  seats: SetupSeat[];
  difficulty: PlaytestDifficulty;
}

export const DIFFICULTIES: readonly { id: PlaytestDifficulty; label: string }[] = [
  { id: "veryEasy", label: "Very easy" },
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
  { id: "veryHard", label: "Very hard" },
];

/** The gamemodes, in the order the lobby draws them. `opponents` is how many deck seats it plays
 *  besides the reader's — the goldfish is no deck's — and `table` is the line under its name. */
export const GAMEMODES: readonly {
  id: Gamemode;
  label: string;
  table: string;
  opponents: number;
}[] = [
  { id: "goldfish", label: "Goldfish", table: "Solo", opponents: 0 },
  { id: "duel", label: "Duel", table: "1 v 1", opponents: 1 },
  { id: "fourPlayer", label: "Four-player", table: "1 v 3", opponents: 3 },
];

const EMPTY_SEAT: SetupSeat = { deckId: null, variant: "live" };

const NOTHING_PICKED: SetupPicks = {
  mode: "duel",
  seats: [EMPTY_SEAT, EMPTY_SEAT, EMPTY_SEAT, EMPTY_SEAT],
  difficulty: DEFAULT_DIFFICULTY,
};

/**
 * **The last picks, for the rest of the window's life** (`lib/viewMemory.ts`): a reader who plays
 * a game, comes back and wants another against a harder opponent should find every deck still
 * seated, and the gamemode as they set it. Module memory and never storage, for that module's
 * reason — a restart opens fresh.
 */
const memory = viewMemory<SetupPicks>("playtesting.setup");

const NO_FOLDERS: readonly DeckFolder[] = [];

/** The flat wall's heading — the Decks page's own words for every deck at once. */
const EVERY_DECK = "Every deck";

/** A deck's list when it is first seated: the plan where it keeps one, the only list otherwise. */
function firstVariant(deck: DeckRow): DeckVariant {
  return deck.theoryEnabled ? "theory" : "live";
}

/** The list a deck is dealt from in a seat: the one picked, where it keeps two. */
function dealt(deck: DeckRow, variant: DeckVariant): DeckVariant {
  return deck.theoryEnabled ? variant : "live";
}

/** A seat's name in the panel: `You`, then `Opponent` — numbered when there are three. */
function seatTitle(seat: number, opponents: number): string {
  if (seat === 0) return "You";
  return opponents > 1 ? `Opponent ${seat}` : "Opponent";
}

/** The same seat on a deck tile's plate, where the art leaves room for a word and a digit. */
function seatPlate(seat: number, opponents: number): string {
  if (seat === 0) return "You";
  return opponents > 1 ? `Opp ${seat}` : "Opp";
}

/**
 * The Playtesting page's lobby: the reader sets up a game — the gamemode, a deck in every seat,
 * each deck's list, how well the AI plays — and starts it.
 *
 * **Two halves, like a game's lobby.** On the left, the reader's decks as the Decks page draws
 * them — the same tiles, the same folder cards walked the same way, filtered and laid out by the
 * same rules — with every managing hand taken off: a deck here is picked, never renamed, filed
 * or created. On the right, the table: the gamemode, the seats, the AI's skill and Start.
 *
 * **One seat is always the one being picked for**, ringed in accent and named over the wall
 * ("Picking for Opponent 2"). A deck pressed on the wall sits there, and the next empty seat round
 * the table is up; pressing a seat makes it the one being picked for, so a seated deck is
 * swapped by pressing its seat and then another deck. A seat's ✕ empties it.
 *
 * **Any of the reader's decks in any seat, the same one twice included**: a mirror match is a
 * real test of a deck, and a pod of one deck three times is a fair one for a Commander list.
 * Archived decks are left off the wall, as the gallery puts them last and out of the way. A deck
 * that keeps a plan (`theoryEnabled`) seats with the editor's own Theory | Actual switch, Theory
 * first; a deck with one list has nothing to switch.
 *
 * **Goldfish** takes every opponent seat and the skill away: the goldfish is no deck, plays
 * nothing and never loses, so there is nothing to pick for it — the board opens against it with
 * the sandbox on, exactly as the deck editor's "Goldfish this deck" does.
 *
 * **What the rules engine plays of each deck is marked, never explained at length** (issue
 * #1078): a ⚠ with a count on a tile whose deck has cards phase.rs's parser reads only in part,
 * and on a seat a ✓ or that ⚠ — which opens the cards it means. A deck with such cards can still
 * be played; the reader is told, never stopped.
 *
 * Presentational over the deck rows and folders, so the page's reads are the one read and the
 * tests and stories hand it rows; the engine's verdict on them is the one thing asked here.
 */
export function PlaytestSetup({
  decks,
  folders = NO_FOLDERS,
  marks = NO_WALL_MARKS,
  sort = DEFAULT_DECK_SORT,
  loading = false,
  onStart,
}: {
  decks: readonly DeckRow[];
  folders?: readonly DeckFolder[];
  /** Each deck's colours and bracket, for the tiles — `useDeckWallMarks`, read by the page. */
  marks?: DeckWallMarks;
  /** The order the reader keeps the Decks page in, so the two walls agree. */
  sort?: DeckSort;
  loading?: boolean;
  onStart: (picks: PlaytestPicks) => void;
}): JSX.Element {
  const [held, setHeld] = useState<SetupPicks>(() => memory.recall() ?? NOTHING_PICKED);
  const pick = (next: Partial<SetupPicks>) =>
    setHeld((was) => {
      const now = { ...was, ...next };
      memory.keep(now);
      return now;
    });
  /** The seat the reader last pressed, or picked into — `null` until they do. */
  const [chosen, setChosen] = useState<number | null>(null);

  const playable = useMemo(() => decks.filter((d) => !d.archived), [decks]);
  const byId = (id: number | null) => playable.find((d) => d.id === id);
  const opponents = GAMEMODES.find((m) => m.id === held.mode)?.opponents ?? 1;
  const played = opponents + 1;
  // A remembered deck since archived or deleted is no longer a pick.
  const seated = held.seats.slice(0, played).map((s) => byId(s.deckId));
  const firstEmpty = seated.findIndex((d) => d === undefined);
  const ready = firstEmpty === -1;
  // The seat being picked for: the one the reader chose while the gamemode still plays it, else
  // the first empty seat, else the reader's own.
  const active = chosen !== null && chosen < played ? chosen : Math.max(firstEmpty, 0);
  const title = (seat: number) => seatTitle(seat, opponents);

  // The seats' decks first, in the lists they are dealt from; then every deck on the wall, in the
  // list it is first dealt from, for the marks on the tiles.
  const asked: SupportAsk[] = seated.flatMap((d, i) =>
    d === undefined ? [] : [{ deckId: d.id, variant: dealt(d, held.seats[i].variant) }],
  );
  const supportOf = usePlaytestSupport(
    asked,
    playable.map((d) => ({ deckId: d.id, variant: firstVariant(d) })),
  );

  const setSeat = (seat: number, next: SetupSeat) =>
    pick({ seats: held.seats.map((s, i) => (i === seat ? next : s)) });

  const seatDeck = (deck: DeckRow) => {
    const seats = held.seats.map((s, i) =>
      i === active ? { deckId: deck.id, variant: firstVariant(deck) } : s,
    );
    pick({ seats });
    // The next seat still to fill, going on round the table from this one.
    let next = active;
    for (let step = 1; step < played; step++) {
      const seat = (active + step) % played;
      if (byId(seats[seat].deckId) === undefined) {
        next = seat;
        break;
      }
    }
    setChosen(next);
  };

  const start = () => {
    if (!ready) return;
    const [yours, ...theirs] = seated as DeckRow[];
    const variant = dealt(yours, held.seats[0].variant);
    const opponentPicks = theirs.map((deck, i) => ({
      deckId: deck.id,
      variant: dealt(deck, held.seats[i + 1].variant),
    }));
    // The goldfish plays no skill: its picks say only what the reader plays.
    onStart(
      opponents === 0
        ? { deckId: yours.id, variant, opponents: opponentPicks }
        : { deckId: yours.id, variant, opponents: opponentPicks, difficulty: held.difficulty },
    );
  };

  /** What sits on a tile's art: the plates of the seats it is in, and the engine's ⚠. */
  const cornerFor = (deck: DeckRow): ReactNode => {
    const seats = seated.flatMap((d, i) => (d?.id === deck.id ? [i] : []));
    const state = supportOf(deck.id, firstVariant(deck));
    const partly = state.state === "known" ? state.support.unsupported.length : 0;
    if (seats.length === 0 && partly === 0) return undefined;
    return (
      <>
        {seats.length > 0 && (
          <span className="absolute left-[calc(0.375rem*var(--mark-scale,1))] top-[calc(0.375rem*var(--mark-scale,1))] flex gap-1">
            {seats.map((seat) => (
              <span key={seat} className={SEAT_PLATE}>
                {seatPlate(seat, opponents)}
              </span>
            ))}
          </span>
        )}
        {state.state === "known" && partly > 0 && (
          <span role="img" aria-label={supportSentence(state.support)} className={TILE_WARN}>
            <TriangleAlert
              className="size-[calc(0.75rem*var(--mark-scale,1))]"
              aria-hidden="true"
            />
            {partly}
          </span>
        )}
      </>
    );
  };

  if (loading || playable.length === 0) {
    return (
      <section className="flex h-full items-center justify-center px-6">
        <h2 className="sr-only">Playtesting</h2>
        <p className="m-0 text-sm text-dim">
          {loading
            ? "Reading your decks…"
            : "Playtesting needs a deck to play. Make one in Decks, then come back."}
        </p>
      </section>
    );
  }

  const mirror = ready && opponents === 1 && seated[0]?.id === seated[1]?.id;

  return (
    <section className="flex h-full min-h-0">
      <h2 className="sr-only">Playtesting</h2>
      <DeckWall
        decks={playable}
        folders={folders}
        marks={marks}
        sort={sort}
        pickingFor={active === 0 ? "you" : title(active)}
        isSeated={(deck) => seated.some((d) => d?.id === deck.id)}
        cornerFor={cornerFor}
        onPick={seatDeck}
      />

      <aside
        aria-label="Game setup"
        className="flex w-[26rem] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-surface/45 p-6"
      >
        <Gamemodes mode={held.mode} onMode={(mode) => pick({ mode })} />

        <div className="flex flex-col gap-2.5">
          <h3 className={LABEL}>Seats</h3>
          <ol aria-label="Seats" className="m-0 flex list-none flex-col gap-2 p-0">
            {seated.map((deck, seat) => (
              <SeatRow
                // A seat is its place at the table, which never moves.
                key={seat}
                title={title(seat)}
                deck={deck}
                variant={held.seats[seat].variant}
                active={seat === active}
                state={
                  deck === undefined
                    ? undefined
                    : supportOf(deck.id, dealt(deck, held.seats[seat].variant))
                }
                onActivate={() => setChosen(seat)}
                onVariant={(variant) => setSeat(seat, { ...held.seats[seat], variant })}
                onClear={() => {
                  setSeat(seat, EMPTY_SEAT);
                  setChosen(seat);
                }}
              />
            ))}
            {opponents === 0 && <GoldfishSeat />}
          </ol>
        </div>

        {opponents > 0 && (
          <Segmented
            label="AI skill"
            options={DIFFICULTIES}
            value={held.difficulty}
            onPick={(difficulty) => pick({ difficulty })}
          />
        )}

        <div className="mt-auto flex flex-col gap-2 pt-2">
          <button
            type="button"
            // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order, and
            // this one ungreys as the reader seats decks.
            aria-disabled={!ready}
            onClick={start}
            className={cn(
              "inline-flex h-12 items-center justify-center gap-2.5 rounded-full border",
              "text-[15px] font-semibold transition-colors motion-reduce:transition-none",
              PRESS,
              FOCUS,
              ready
                ? "border-accent bg-accent text-accent-fg hover:bg-accent/90"
                : "cursor-default border-border bg-surface text-dim active:scale-100",
            )}
          >
            <Play className="size-4 fill-current" aria-hidden="true" />
            Start game
          </button>
          <p className="m-0 min-h-4 text-center text-xs text-dim">
            {!ready
              ? firstEmpty === 0
                ? "Pick your deck to start."
                : `Pick a deck for ${title(firstEmpty)} to start.`
              : mirror
                ? "A mirror match."
                : null}
          </p>
        </div>
      </aside>
    </section>
  );
}

const LABEL = "m-0 text-[0.6875rem] font-normal tracking-[0.08em] text-dim uppercase";

/** A seat's plate on a tile's art: the seat's word in accent, the app's mark for a pick. */
const SEAT_PLATE = cn(
  "rounded-sm bg-accent px-[calc(0.375rem*var(--mark-scale,1))] text-accent-fg",
  "font-mono text-[calc(0.625rem*var(--mark-scale,1))] leading-[calc(1.125rem*var(--mark-scale,1))]",
  "font-medium tracking-wider uppercase",
);

/** The engine's ⚠ on a tile's art, in the corner the gallery's tray takes — the lobby draws none. */
const TILE_WARN = cn(
  "absolute right-[calc(0.375rem*var(--mark-scale,1))] top-[calc(0.375rem*var(--mark-scale,1))]",
  "inline-flex items-center gap-[calc(0.1875rem*var(--mark-scale,1))] rounded-sm bg-bg/85",
  "px-[calc(0.375rem*var(--mark-scale,1))] text-accent",
  "font-mono text-[calc(0.6875rem*var(--mark-scale,1))] leading-[calc(1.25rem*var(--mark-scale,1))]",
);

/**
 * The wall of decks to pick from — the Decks page's wall, walked the same way: the folder cards of
 * the level on screen and the way back up, then that level's decks, in the reader's own sort.
 *
 * **Typing a name or pressing a format searches every deck**, folders left out — where the
 * gallery narrows the drawer on screen. A reader here is looking for one deck to play, and the
 * deck they typed should come up wherever it is filed. `View all` lays the same flat wall out
 * without a filter, as it does in the gallery.
 */
function DeckWall({
  decks,
  folders,
  marks,
  sort,
  pickingFor,
  isSeated,
  cornerFor,
  onPick,
}: {
  decks: readonly DeckRow[];
  folders: readonly DeckFolder[];
  marks: DeckWallMarks;
  sort: DeckSort;
  pickingFor: string;
  isSeated: (deck: DeckRow) => boolean;
  cornerFor: (deck: DeckRow) => ReactNode;
  onPick: (deck: DeckRow) => void;
}): JSX.Element {
  const zoom = useAppStore((s) => s.cardZoom.deckGallery);
  const fieldId = useId();
  const [folderId, setFolderId] = useState<number | null>(null);
  const [filter, setFilter] = useState<DeckFilter>(NO_DECK_FILTER);
  const [viewAll, setViewAll] = useState(false);

  // The Decks page's rule: a deck filed in a folder this list does not carry reads as the root.
  const folderOf = useMemo(() => {
    const known = new Set(folders.map((f) => f.id));
    return (deck: DeckRow) =>
      deck.folderId !== null && known.has(deck.folderId) ? deck.folderId : null;
  }, [folders]);
  const nodes = useMemo(() => buildFolderTree(folders, decks), [folders, decks]);
  const byFolder = useMemo(
    () => new Map(flattenFolders(nodes).map((n) => [n.folder.id, n])),
    [nodes],
  );
  // A folder deleted since it was opened stops resolving, and the wall is at the top level.
  const openNode = folderId === null ? null : (byFolder.get(folderId) ?? null);

  const filtering = filter.query.trim() !== "" || filter.formats.length > 0;
  const flat = viewAll || filtering;
  const childFolders = flat ? [] : openNode === null ? nodes : openNode.children;
  const here = flat ? decks : decks.filter((d) => folderOf(d) === (openNode?.folder.id ?? null));
  const shown = sortDecks(filterDecks(here, filter), sort, {
    pips: marks.pipsByDeck,
    brackets: marks.floorByDeck,
  });
  const formats = deckFormats(decks);

  // The open folder's path, from the top level down to it.
  const trail: FolderNode<DeckFolder>[] = [];
  for (let n = flat ? null : openNode; n !== null;) {
    trail.unshift(n);
    n = n.folder.parentId === null ? null : (byFolder.get(n.folder.parentId) ?? null);
  }
  const parent = trail.length > 1 ? trail[trail.length - 2] : null;
  const crumbs =
    trail.length === 0
      ? []
      : [
          { id: null, name: ROOT_LABEL },
          ...trail.slice(0, -1).map((n) => ({ id: n.folder.id, name: n.folder.name })),
        ];
  const heading = flat ? EVERY_DECK : (openNode?.folder.name ?? ROOT_LABEL);
  const counts = [
    childFolders.length > 0 ? plural(childFolders.length, "folder") : null,
    filtering ? `${shown.length} of ${plural(here.length, "deck")}` : plural(here.length, "deck"),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const setQuery = (query: string) => setFilter((was) => ({ ...was, query }));
  const toggleFormat = (key: string) =>
    setFilter((was) => ({
      ...was,
      formats: was.formats.includes(key)
        ? was.formats.filter((f) => f !== key)
        : [...was.formats, key],
    }));

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {crumbs.length > 0 && (
          <nav aria-label="Folder path" className="flex items-baseline gap-2">
            {crumbs.map((crumb) => (
              <Fragment key={crumb.id ?? "root"}>
                <button
                  type="button"
                  onClick={() => setFolderId(crumb.id)}
                  className={cn(
                    "rounded-sm font-heading text-sm leading-none text-dim hover:text-text",
                    FOCUS,
                  )}
                >
                  {crumb.name}
                </button>
                <span aria-hidden="true" className="text-border">
                  /
                </span>
              </Fragment>
            ))}
          </nav>
        )}
        <h3 className="m-0 font-heading text-xl font-normal leading-none">{heading}</h3>
        <span className="font-mono text-[0.7rem] tabular-nums text-dim">{counts}</span>
        <div className="ml-auto flex items-center gap-2">
          <p
            aria-live="polite"
            className="m-0 inline-flex h-8 items-center gap-2 rounded-full border border-accent/50 bg-accent/10 px-3 text-sm text-dim"
          >
            <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
            <span>
              Picking for <span className="font-medium text-accent">{pickingFor}</span>
            </span>
          </p>
          {(folders.length > 0 || viewAll) && (
            <ViewAllToggle
              pressed={viewAll}
              name="View all decks"
              onToggle={() => setViewAll(!viewAll)}
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={fieldId} className="sr-only">
          Filter decks by name
        </label>
        <input
          id={fieldId}
          type="search"
          value={filter.query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => clearFieldOnEscape(e, filter.query, () => setQuery(""))}
          placeholder="Filter decks by name…"
          className={cn(
            FILTER_FIELD,
            FILTER_FOCUS,
            "min-w-40 max-w-[22rem] flex-1 border-border bg-surface px-3",
            "placeholder:text-dim focus:border-accent",
          )}
        />
        {formats.length > 1 && (
          <div role="group" aria-label="Format" className="flex flex-wrap items-center gap-1">
            {formats.map((format) => (
              <ToggleChip
                key={format.key}
                label={format.label}
                title={`${format.label} format, ${plural(format.count, "deck")}`}
                pressed={filter.formats.includes(format.key)}
                onClick={() => toggleFormat(format.key)}
              />
            ))}
          </div>
        )}
      </div>

      <ul aria-label="Your decks" className="m-0 grid list-none p-0" style={wallStyle(zoom)}>
        {openNode !== null && !flat && (
          <ParentDeckFolderPickCard
            label={parent?.folder.name ?? ROOT_LABEL}
            zoom={zoom}
            onOpen={() => setFolderId(parent?.folder.id ?? null)}
          />
        )}
        {childFolders.map((node) => (
          <DeckFolderPickCard
            key={node.folder.id}
            node={node}
            members={decksUnder(node, decks, folderOf)}
            zoom={zoom}
            onOpen={setFolderId}
          />
        ))}
        {shown.map((deck) => (
          <DeckPickTile
            key={deck.id}
            deck={deck}
            pips={marks.pipsByDeck.get(deck.id) ?? null}
            bracketLabel={marks.bracketFor(deck)}
            bracketExpected={marks.bracketExpectedFor(deck)}
            zoom={zoom}
            picked={isSeated(deck)}
            onPick={onPick}
            corner={cornerFor(deck)}
          />
        ))}
      </ul>
      {filtering && shown.length === 0 && (
        <p className="m-0 py-12 text-center text-sm text-dim">No decks match this filter</p>
      )}
    </div>
  );
}

/** The three ways to sit down, as tiles: each drawn as its table, the reader's seat in accent. */
function Gamemodes({
  mode,
  onMode,
}: {
  mode: Gamemode;
  onMode: (mode: Gamemode) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="flex flex-col gap-2.5">
      <h3 id={id} className={LABEL}>
        Gamemode
      </h3>
      <div role="group" aria-labelledby={id} className="grid grid-cols-3 gap-2">
        {GAMEMODES.map((m) => {
          const pressed = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => onMode(m.id)}
              className={cn(
                "flex h-24 flex-col items-center justify-center gap-1 rounded-lg border",
                "transition-colors duration-150 motion-reduce:transition-none",
                PRESS,
                FOCUS,
                pressed
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-surface text-text hover:border-accent/55",
              )}
            >
              <TableDiagram opponents={m.opponents} />
              <span className="text-sm font-medium leading-tight">{m.label}</span>
              <span className="font-mono text-[0.6875rem] leading-tight text-dim">{m.table}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A table from above with its seats round it — the reader's at the foot, in accent, and the
 *  goldfish's seat a dashed ring, since nobody sits in it. */
function TableDiagram({ opponents }: { opponents: number }): JSX.Element {
  return (
    <svg width="44" height="34" viewBox="0 0 44 34" fill="none" aria-hidden="true">
      <rect x="12" y="9" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="1.5" />
      {opponents === 0 ? (
        <circle
          cx="22"
          cy="4"
          r="2.75"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeDasharray="2 2"
        />
      ) : (
        <circle cx="22" cy="4" r="3" fill="currentColor" />
      )}
      {opponents > 1 && (
        <>
          <circle cx="5" cy="17" r="3" fill="currentColor" />
          <circle cx="39" cy="17" r="3" fill="currentColor" />
        </>
      )}
      <circle cx="22" cy="30" r="3" className="fill-accent" />
    </svg>
  );
}

/**
 * One seat: its deck's cover, name and size, the engine's mark, the deck's list where it keeps
 * two, and the ✕ that empties it — or, empty, the place a deck is about to go.
 *
 * **The seat itself is a toggle** (`aria-pressed`): pressed, it is the seat the next deck picked
 * on the wall sits in. The switch, the mark and the ✕ are siblings of it, since a button inside a
 * button is not markup a browser will build.
 */
function SeatRow({
  title,
  deck,
  variant,
  active,
  state,
  onActivate,
  onVariant,
  onClear,
}: {
  title: string;
  deck: DeckRow | undefined;
  variant: DeckVariant;
  active: boolean;
  state: SupportState | undefined;
  onActivate: () => void;
  onVariant: (variant: DeckVariant) => void;
  onClear: () => void;
}): JSX.Element {
  const tip = useTooltip();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const partly = state?.state === "known" ? state.support.unsupported : [];
  return (
    <li
      className={cn(
        "flex flex-col rounded-lg border",
        deck === undefined && "border-dashed",
        active
          ? "border-accent bg-accent/8"
          : cn("border-border", deck !== undefined && "bg-surface"),
      )}
    >
      <div className="flex items-stretch gap-2 p-2">
        <button
          type="button"
          aria-pressed={active}
          aria-label={deck === undefined ? `${title}: pick a deck` : `${title}: ${deck.name}`}
          onClick={onActivate}
          className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left", FOCUS)}
        >
          {deck === undefined ? (
            <span
              className={cn(
                "grid aspect-[626/457] w-16 shrink-0 place-items-center rounded-md border border-dashed",
                active ? "border-accent text-accent" : "border-border text-dim",
              )}
            >
              <Plus className="size-4" aria-hidden="true" />
            </span>
          ) : (
            <SeatCover deck={deck} />
          )}
          <span className="flex min-w-0 flex-col">
            <span className={cn(LABEL, active && "text-accent")}>{title}</span>
            {deck === undefined ? (
              <span className={cn("text-sm", !active && "text-dim")}>Pick a deck</span>
            ) : (
              <>
                <span className="truncate text-sm">{deck.name}</span>
                <span className="truncate text-xs text-dim">
                  {deck.formatName ?? deck.formatKey} ·{" "}
                  <span className="font-mono tabular-nums">{deck.cardCount}</span>
                </span>
              </>
            )}
          </span>
        </button>
        {deck !== undefined && (
          <div className="flex shrink-0 flex-col items-end justify-between gap-1.5">
            <div className="flex items-center gap-1">
              <SupportMark
                state={state}
                open={open}
                listId={listId}
                onToggle={() => setOpen((was) => !was)}
              />
              <button
                type="button"
                aria-label={`Empty the seat: ${title}`}
                {...tip("Empty the seat", { describes: false })}
                onClick={onClear}
                className={cn(
                  "grid size-6 place-items-center rounded-md text-dim hover:text-text",
                  PRESS,
                  FOCUS,
                )}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            {deck.theoryEnabled && (
              <div
                role="group"
                aria-label={`${title}: list`}
                className="flex overflow-hidden rounded-md border border-border"
              >
                {/* The editor's pair and its order: Theory first, Actual second
                    (`DeckEditorHeader`). `live` is still the stored word; Actual is its name. */}
                <Segment
                  label="Theory"
                  pressed={variant === "theory"}
                  onPress={() => onVariant("theory")}
                  className="h-7 px-2.5"
                />
                <Segment
                  label="Actual"
                  pressed={variant === "live"}
                  onPress={() => onVariant("live")}
                  className="h-7 px-2.5"
                />
              </div>
            )}
          </div>
        )}
      </div>
      {open && partly.length > 0 && (
        <ul
          id={listId}
          aria-label="Cards the rules engine plays only in part"
          className="m-0 flex list-none flex-col gap-1.5 border-t border-border px-3 py-2.5 text-xs"
        >
          {partly.map((card) => (
            <li key={card.name} className="flex flex-col">
              <span className="text-text">
                {card.name}
                {card.quantity > 1 && <span className="text-dim"> ×{card.quantity}</span>}
                {card.commander && <span className="text-dim"> · commander</span>}
              </span>
              <span className="text-dim">{card.gaps.map(gapWords).join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The opponent's seat at the goldfish table: nobody to pick, so nothing to press. */
function GoldfishSeat(): JSX.Element {
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border p-2">
      <span className="grid aspect-[626/457] w-16 shrink-0 place-items-center rounded-md bg-surface text-accent">
        <Fish className="size-6" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={LABEL}>Opponent</span>
        <span className="text-sm">Goldfish</span>
        <span className="text-xs text-dim">Plays nothing</span>
      </span>
    </li>
  );
}

/** A seated deck's cover, small — the crop its tile on the wall is drawn from. */
function SeatCover({ deck }: { deck: DeckRow }): JSX.Element {
  const image = useImageRetry(coverUrl(deck));
  return (
    <span className="grid aspect-[626/457] w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-bg">
      {image.src ? (
        <CardImage
          alt=""
          src={image.src}
          onError={image.onError}
          className="size-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className="text-[0.625rem] text-dim">
          No cover
        </span>
      )}
    </span>
  );
}

/**
 * What the rules engine plays of a seated deck, as a mark: ✓ for every card, or ⚠ and how many
 * cards it plays only in part — a press that opens them under the seat. The sentence is the
 * mark's name and its hint, so it is said without being printed.
 */
function SupportMark({
  state,
  open,
  listId,
  onToggle,
}: {
  state: SupportState | undefined;
  open: boolean;
  listId: string;
  onToggle: () => void;
}): JSX.Element {
  const tip = useTooltip();
  if (state === undefined || state.state === "checking") {
    // The slot is held while the engine is asked, so the ✕ beside it does not shift.
    return <span className="size-6" aria-hidden="true" />;
  }
  if (state.state === "failed") {
    const words = "The cards could not be checked against the rules engine.";
    return (
      <span
        role="img"
        aria-label={words}
        {...tip(words)}
        className="grid size-6 place-items-center text-dim"
      >
        <CircleHelp className="size-4" aria-hidden="true" />
      </span>
    );
  }
  const sentence = supportSentence(state.support);
  const partly = state.support.unsupported.length;
  if (partly === 0) {
    return (
      <span
        role="img"
        aria-label={sentence}
        {...tip(sentence)}
        className="grid size-6 place-items-center text-ok"
      >
        <CircleCheck className="size-4" aria-hidden="true" />
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={listId}
      aria-label={sentence}
      {...tip(open ? "Hide the cards" : "Show the cards", { describes: false })}
      onClick={onToggle}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-xs text-accent hover:bg-accent/10",
        PRESS,
        FOCUS,
      )}
    >
      <TriangleAlert className="size-3.5" aria-hidden="true" />
      {partly}
    </button>
  );
}

/** A labelled row of segments where exactly one is pressed — the AI's skill. */
function Segmented<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onPick: (id: T) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="flex flex-col gap-2.5">
      <h3 id={id} className={LABEL}>
        {label}
      </h3>
      <div
        role="group"
        aria-labelledby={id}
        className="flex overflow-hidden rounded-md border border-border"
      >
        {options.map((option) => (
          <Segment
            key={option.id}
            label={option.label}
            pressed={value === option.id}
            onPress={() => onPick(option.id)}
            className="h-9 min-w-0 flex-1 px-1"
          />
        ))}
      </div>
    </div>
  );
}

/** One segment of a pair or a row: the editor's Theory/Actual button. */
function Segment({
  label,
  pressed,
  onPress,
  className,
}: {
  label: string;
  pressed: boolean;
  onPress: () => void;
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={pressed}
      className={cn(
        "text-xs",
        "transition-colors duration-150 motion-reduce:transition-none",
        pressed ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
        FOCUS,
        className,
      )}
    >
      {label}
    </button>
  );
}
