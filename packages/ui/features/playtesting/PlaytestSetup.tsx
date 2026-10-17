import { useId, useState, type JSX } from "react";
import { ChevronRight, CircleCheck, Play, TriangleAlert } from "lucide-react";
import type { DeckRow, DeckVariant, PlaytestDifficulty } from "@/lib/ipc";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import type { PlaytestPicks } from "./play/usePlaytestGame";
import {
  gapWords,
  supportSentence,
  usePlaytestSupport,
  type SupportAsk,
  type SupportOf,
  type SupportState,
} from "./support";

/** What the setup screen reads of a deck. */
export type SetupDeck = Pick<DeckRow, "id" | "name" | "formatName" | "archived" | "theoryEnabled">;

/** One opponent's seat as the screen holds it: it may have no deck yet. */
export interface SetupSeat {
  deckId: number | null;
  variant: DeckVariant;
}

/** How many sit at the table: the reader and one opponent, or the reader and three. */
export type TableSize = "duel" | "fourPlayer";

/** The picks as the screen holds them: a seat may have no deck yet. */
export interface SetupPicks {
  deckId: number | null;
  variant: DeckVariant;
  table: TableSize;
  /**
   * The three opponents' seats, always three: a duel plays the first, and the other two keep
   * their picks while the reader goes back and forth between the two tables.
   */
  opponents: SetupSeat[];
  difficulty: PlaytestDifficulty;
}

export const DIFFICULTIES: readonly { id: PlaytestDifficulty; label: string }[] = [
  { id: "veryEasy", label: "Very easy" },
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
  { id: "veryHard", label: "Very hard" },
];

export const TABLES: readonly { id: TableSize; label: string; opponents: number }[] = [
  { id: "duel", label: "1 opponent", opponents: 1 },
  { id: "fourPlayer", label: "3 opponents", opponents: 3 },
];

const EMPTY_SEAT: SetupSeat = { deckId: null, variant: "live" };

const NOTHING_PICKED: SetupPicks = {
  deckId: null,
  variant: "live",
  table: "duel",
  opponents: [EMPTY_SEAT, EMPTY_SEAT, EMPTY_SEAT],
  difficulty: "medium",
};

/**
 * **The last picks, for the rest of the window's life** (`lib/viewMemory.ts`): a reader who plays
 * a game, comes back and wants another against a harder opponent should find every deck still
 * picked, and the table as they set it. Module memory and never storage, for that module's
 * reason — a restart opens fresh.
 */
const memory = viewMemory<SetupPicks>("playtesting.setup");

/** A deck's list when it is first picked: the plan where it keeps one, the only list otherwise. */
function firstVariant(deck: SetupDeck | undefined): DeckVariant {
  return deck?.theoryEnabled ? "theory" : "live";
}

/**
 * The Playtesting page's setup: the reader's deck and the opponent's — or, at a four-player
 * table, three opponents' (issue #994) — each in one of its lists, and how well the AI plays;
 * then Start.
 *
 * **Any of the reader's decks in any seat, the same one twice included**: a mirror match is a
 * real test of a deck, and a pod of one deck three times is a fair one for a Commander list.
 * Every opponent plays at the one skill. Archived decks are left out, as the gallery puts them
 * last and out of the way. Which list a deck is dealt from is the editor's own pair, **Theory
 * first, Actual second**, and only for a deck that keeps a plan (`theoryEnabled`); a deck with
 * one list has nothing to choose.
 *
 * **The table** is a duel by default, and "3 opponents" adds two more seats below the first. Start
 * waits for a deck in every seat shown; the seats a duel hides keep their picks.
 *
 * **What the rules engine plays of each deck is marked before it is picked** (issue #1078): a
 * glyph on each deck's row in the lists (for the list it is first dealt from), and under each seat
 * the deck's verdict and the cards phase.rs's parser reads only in part (`support.ts`). A deck
 * with such cards can still be played; the reader is told, never stopped.
 *
 * Presentational over the deck rows, so the page's `useDecks` is the one read and the tests and
 * stories hand it rows; the engine's verdict on them is the one thing asked here.
 */
export function PlaytestSetup({
  decks,
  loading = false,
  onStart,
}: {
  decks: readonly SetupDeck[];
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

  const playable = decks.filter((d) => !d.archived);
  const byId = (id: number | null) => playable.find((d) => d.id === id);
  const seated = TABLES.find((t) => t.id === held.table)?.opponents ?? 1;
  const four = seated > 1;
  // A remembered deck since archived or deleted is no longer a pick.
  const yours = byId(held.deckId);
  const seats = held.opponents.slice(0, seated);
  const theirs = seats.map((s) => byId(s.deckId));
  const ready = yours !== undefined && theirs.every((d) => d !== undefined);
  const pickSeat = (i: number, next: Partial<SetupSeat>) =>
    pick({ opponents: held.opponents.map((s, j) => (j === i ? { ...s, ...next } : s)) });

  // The seats' decks first, in the lists they are picked in; then every deck, in the list it is
  // first dealt from, for the marks in the lists.
  const asked: SupportAsk[] = [];
  if (yours !== undefined) asked.push({ deckId: yours.id, variant: dealt(yours, held.variant) });
  theirs.forEach((d, i) => {
    if (d !== undefined) asked.push({ deckId: d.id, variant: dealt(d, seats[i].variant) });
  });
  const supportOf = usePlaytestSupport(
    asked,
    playable.map((d) => ({ deckId: d.id, variant: firstVariant(d) })),
  );

  const options: DropdownOption[] = playable.map((d) => {
    const known = supportOf(d.id, firstVariant(d));
    return {
      value: String(d.id),
      label: d.name,
      ...(d.formatName === null ? {} : { hint: d.formatName }),
      icon: <SupportGlyph state={known} />,
      ...(known.state === "known" ? { title: supportSentence(known.support) } : {}),
    };
  });

  const start = () => {
    if (yours === undefined) return;
    const opponents: PlaytestPicks["opponents"] = [];
    for (const [i, deck] of theirs.entries()) {
      if (deck === undefined) return;
      opponents.push({
        deckId: deck.id,
        variant: deck.theoryEnabled ? seats[i].variant : "live",
      });
    }
    onStart({
      deckId: yours.id,
      variant: yours.theoryEnabled ? held.variant : "live",
      opponents,
      difficulty: held.difficulty,
    });
  };

  return (
    <section className="flex h-full justify-center overflow-y-auto px-6 py-10">
      <h2 className="sr-only">Playtesting</h2>
      <div className="flex w-full max-w-[640px] flex-col gap-7">
        <p className="m-0 text-sm text-dim">
          Play one of your decks against another, or against three in a four-player game, each
          opponent played by the rules engine’s AI. You decide in your main phases, when you attack
          and block, and when a card asks you something; the rest plays itself.
        </p>

        {loading ? (
          <p className="m-0 text-sm text-dim">Reading your decks…</p>
        ) : playable.length === 0 ? (
          <p className="m-0 text-sm text-dim">
            Playtesting needs a deck to play. Make one in Decks, then come back.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              <span id="playtest-table" className={LABEL}>
                Table
              </span>
              <div
                role="group"
                aria-labelledby="playtest-table"
                className="flex w-fit overflow-hidden rounded-md border border-border"
              >
                {TABLES.map(({ id, label }) => (
                  <Segment
                    key={id}
                    label={label}
                    pressed={held.table === id}
                    onPress={() => pick({ table: id })}
                  />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Seat
                title="Your deck"
                options={options}
                supportOf={supportOf}
                deck={yours}
                variant={held.variant}
                onDeck={(id) => pick({ deckId: id, variant: firstVariant(byId(id)) })}
                onVariant={(variant) => pick({ variant })}
              />
              {seats.map((seat, i) => (
                <Seat
                  // A seat is its place at the table, which never moves.
                  key={i}
                  title={four ? `Opponent ${i + 1}’s deck` : "Opponent’s deck"}
                  options={options}
                  supportOf={supportOf}
                  deck={theirs[i]}
                  variant={seat.variant}
                  onDeck={(id) => pickSeat(i, { deckId: id, variant: firstVariant(byId(id)) })}
                  onVariant={(variant) => pickSeat(i, { variant })}
                />
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <span id="playtest-difficulty" className={LABEL}>
                {four ? "Opponents’ skill" : "Opponent’s skill"}
              </span>
              <div
                role="group"
                aria-labelledby="playtest-difficulty"
                className="flex w-fit overflow-hidden rounded-md border border-border"
              >
                {DIFFICULTIES.map(({ id, label }) => (
                  <Segment
                    key={id}
                    label={label}
                    pressed={held.difficulty === id}
                    onPress={() => pick({ difficulty: id })}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order,
                // and this one ungreys as the reader picks.
                aria-disabled={!ready}
                onClick={start}
                className={cn(
                  "inline-flex h-11 items-center gap-2 rounded-full border border-accent bg-surface px-6",
                  "text-[15px] font-semibold text-accent transition-colors motion-reduce:transition-none",
                  PRESS,
                  FOCUS,
                  ready
                    ? "hover:bg-accent hover:text-accent-fg"
                    : "cursor-default opacity-45 active:scale-100",
                )}
              >
                <Play className="size-4" aria-hidden="true" />
                Start
              </button>
              {!ready && (
                <span className="text-xs text-dim">
                  {four ? "Pick all four decks to start." : "Pick both decks to start."}
                </span>
              )}
              {ready && !four && yours.id === theirs[0]?.id && (
                <span className="text-xs text-dim">A mirror match.</span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const LABEL = "text-[0.6875rem] tracking-[0.08em] text-dim uppercase";

/** The list a deck is dealt from in a seat: the one picked, where it keeps two. */
function dealt(deck: SetupDeck, variant: DeckVariant): DeckVariant {
  return deck.theoryEnabled ? variant : "live";
}

/**
 * A deck row's mark: green for a deck the engine plays whole, gold for one with cards it plays
 * only in part — a caution rather than the red of a broken rule, since the deck still plays. The
 * slot is held while the engine is still being asked, so the names do not shift as marks arrive.
 */
function SupportGlyph({ state }: { state: SupportState }): JSX.Element {
  if (state.state !== "known") return <span className="size-3.5 shrink-0" aria-hidden="true" />;
  return state.support.unsupported.length === 0 ? (
    <CircleCheck className="size-3.5 shrink-0 text-ok" aria-hidden="true" />
  ) : (
    <TriangleAlert className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
  );
}

/**
 * Under a seat: the engine's verdict on the deck picked there, and — folded, behind a press —
 * the cards it plays only in part, each with what phase leaves out of it.
 */
function SupportNote({ state }: { state: SupportState }): JSX.Element {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (state.state === "checking") {
    return <p className="m-0 text-xs text-dim">Checking the cards against the rules engine…</p>;
  }
  if (state.state === "failed") {
    return (
      <p className="m-0 text-xs text-dim">
        The cards could not be checked against the rules engine.
      </p>
    );
  }
  const { support } = state;
  const partly = support.unsupported;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p className="m-0 flex items-start gap-1.5 text-dim">
        <SupportGlyph state={state} />
        <span>{supportSentence(support)}</span>
      </p>
      {partly.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((was) => !was)}
            className={cn(
              "inline-flex w-fit items-center gap-1 rounded-sm text-dim hover:text-text",
              "transition-colors duration-150 motion-reduce:transition-none",
              FOCUS,
            )}
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
              aria-hidden="true"
            />
            {open
              ? "Hide the cards"
              : partly.length === 1
                ? "Show the card"
                : `Show the ${partly.length} cards`}
          </button>
          {open && (
            <ul
              id={listId}
              aria-label="Cards the rules engine plays only in part"
              className="m-0 flex list-none flex-col gap-1.5 p-0 pl-5"
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
        </>
      )}
    </div>
  );
}

/** One seat's picks: the deck, and its list when it keeps two. */
function Seat({
  title,
  options,
  supportOf,
  deck,
  variant,
  onDeck,
  onVariant,
}: {
  title: string;
  options: DropdownOption[];
  supportOf: SupportOf;
  deck: SetupDeck | undefined;
  variant: DeckVariant;
  onDeck: (id: number) => void;
  onVariant: (variant: DeckVariant) => void;
}): JSX.Element {
  const id = useId();
  const state = deck === undefined ? undefined : supportOf(deck.id, dealt(deck, variant));
  // A row's mark is the list the deck is first dealt from; the closed trigger's is the list this
  // seat deals, which the reader may have switched.
  const seated =
    state === undefined
      ? options
      : options.map((o) =>
          o.value === String(deck?.id) ? { ...o, triggerIcon: <SupportGlyph state={state} /> } : o,
        );
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} id={`${id}-label`} className={LABEL}>
        {title}
      </label>
      <Dropdown
        id={id}
        labelledBy={`${id}-label`}
        fill
        options={seated}
        value={deck === undefined ? "" : String(deck.id)}
        placeholder="Pick a deck"
        onChange={(value) => onDeck(Number(value))}
      />
      {deck?.theoryEnabled && (
        <div
          role="group"
          aria-label={`${title}: list`}
          className="flex w-fit overflow-hidden rounded-md border border-border"
        >
          {/* The editor's pair and its order: Theory first, Actual second
              (`DeckEditorHeader`). `live` is still the stored word; Actual is its name. */}
          <Segment
            label="Theory"
            pressed={variant === "theory"}
            onPress={() => onVariant("theory")}
          />
          <Segment label="Actual" pressed={variant === "live"} onPress={() => onVariant("live")} />
        </div>
      )}
      {state !== undefined && <SupportNote state={state} />}
    </div>
  );
}

/** One half of a segmented pair (or one of five): the editor's Theory/Actual button. */
function Segment({
  label,
  pressed,
  onPress,
}: {
  label: string;
  pressed: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-pressed={pressed}
      className={cn(
        "h-9 px-3 text-xs",
        "transition-colors duration-150 motion-reduce:transition-none",
        pressed ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
        FOCUS,
      )}
    >
      {label}
    </button>
  );
}
