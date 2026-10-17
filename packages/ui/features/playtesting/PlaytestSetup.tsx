import { useId, useState, type JSX } from "react";
import { Play } from "lucide-react";
import type { DeckRow, DeckVariant, PlaytestDifficulty } from "@/lib/ipc";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { DEFAULT_DIFFICULTY, type PlaytestPicks } from "./play/usePlaytestGame";

/** What the setup screen reads of a deck. */
export type SetupDeck = Pick<DeckRow, "id" | "name" | "formatName" | "archived" | "theoryEnabled">;

/** One opponent's seat as the screen holds it: it may have no deck yet. */
export interface SetupSeat {
  deckId: number | null;
  variant: DeckVariant;
}

/** Who sits at the table: the reader and the goldfish, the reader and one opponent, or the reader
 *  and three. */
export type TableSize = "goldfish" | "duel" | "fourPlayer";

/** The picks as the screen holds them: a seat may have no deck yet. */
export interface SetupPicks {
  deckId: number | null;
  variant: DeckVariant;
  table: TableSize;
  /**
   * The three opponents' seats, always three: a duel plays the first, the goldfish none, and the
   * seats a table does not play keep their picks while the reader goes back and forth between
   * the tables.
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

/** The tables, in the order the choice draws them. `opponents` is how many deck seats it plays:
 *  the goldfish is no deck's. */
export const TABLES: readonly { id: TableSize; label: string; opponents: number }[] = [
  { id: "goldfish", label: "Goldfish", opponents: 0 },
  { id: "duel", label: "1 opponent", opponents: 1 },
  { id: "fourPlayer", label: "3 opponents", opponents: 3 },
];

const EMPTY_SEAT: SetupSeat = { deckId: null, variant: "live" };

const NOTHING_PICKED: SetupPicks = {
  deckId: null,
  variant: "live",
  table: "duel",
  opponents: [EMPTY_SEAT, EMPTY_SEAT, EMPTY_SEAT],
  difficulty: DEFAULT_DIFFICULTY,
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
 * The Playtesting page's setup: the reader's deck and who it plays — the goldfish, one opponent's
 * deck or, at a four-player table, three opponents' (issue #994) — each deck in one of its lists,
 * and how well the AI plays; then Start.
 *
 * **Any of the reader's decks in any seat, the same one twice included**: a mirror match is a
 * real test of a deck, and a pod of one deck three times is a fair one for a Commander list.
 * Every opponent plays at the one skill. Archived decks are left out, as the gallery puts them
 * last and out of the way. Which list a deck is dealt from is the editor's own pair, **Theory
 * first, Actual second**, and only for a deck that keeps a plan (`theoryEnabled`); a deck with
 * one list has nothing to choose.
 *
 * **The table** is a duel by default; "3 opponents" adds two more seats below the first, and
 * **"Goldfish"** takes every opponent seat and the skill away: the goldfish is no deck, plays
 * nothing and never loses, so there is nothing to pick for it — the board opens against it with
 * the sandbox on, exactly as the deck editor's "Goldfish this deck" does. Start waits for a deck
 * in every seat shown (the reader's alone, against the goldfish); the seats a table hides keep
 * their picks.
 *
 * Presentational over the deck rows, so the page's `useDecks` is the one read and the tests and
 * stories hand it rows.
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
  const goldfish = seated === 0;
  const four = seated > 1;
  // A remembered deck since archived or deleted is no longer a pick.
  const yours = byId(held.deckId);
  const seats = held.opponents.slice(0, seated);
  const theirs = seats.map((s) => byId(s.deckId));
  const ready = yours !== undefined && theirs.every((d) => d !== undefined);
  const pickSeat = (i: number, next: Partial<SetupSeat>) =>
    pick({ opponents: held.opponents.map((s, j) => (j === i ? { ...s, ...next } : s)) });

  const options: DropdownOption[] = playable.map((d) => ({
    value: String(d.id),
    label: d.name,
    ...(d.formatName === null ? {} : { hint: d.formatName }),
  }));

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
    const variant = yours.theoryEnabled ? held.variant : "live";
    // The goldfish plays no skill: its picks say only what the reader plays.
    onStart(
      goldfish
        ? { deckId: yours.id, variant, opponents }
        : { deckId: yours.id, variant, opponents, difficulty: held.difficulty },
    );
  };

  return (
    <section className="flex h-full justify-center overflow-y-auto px-6 py-10">
      <h2 className="sr-only">Playtesting</h2>
      <div className="flex w-full max-w-[640px] flex-col gap-7">
        <p className="m-0 text-sm text-dim">
          Play one of your decks against the goldfish — an opponent that does nothing, to see how
          your deck runs on its own — or against another of your decks, or three in a four-player
          game, each played by the rules engine’s AI. You decide in your main phases, when you
          attack and block, and when a card asks you something; the rest plays itself.
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
                  deck={theirs[i]}
                  variant={seat.variant}
                  onDeck={(id) => pickSeat(i, { deckId: id, variant: firstVariant(byId(id)) })}
                  onVariant={(variant) => pickSeat(i, { variant })}
                />
              ))}
            </div>

            {!goldfish && (
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
            )}

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
                  {goldfish
                    ? "Pick your deck to start."
                    : four
                      ? "Pick all four decks to start."
                      : "Pick both decks to start."}
                </span>
              )}
              {ready && seated === 1 && yours.id === theirs[0]?.id && (
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

/** One seat's picks: the deck, and its list when it keeps two. */
function Seat({
  title,
  options,
  deck,
  variant,
  onDeck,
  onVariant,
}: {
  title: string;
  options: DropdownOption[];
  deck: SetupDeck | undefined;
  variant: DeckVariant;
  onDeck: (id: number) => void;
  onVariant: (variant: DeckVariant) => void;
}): JSX.Element {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} id={`${id}-label`} className={LABEL}>
        {title}
      </label>
      <Dropdown
        id={id}
        labelledBy={`${id}-label`}
        fill
        options={options}
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
