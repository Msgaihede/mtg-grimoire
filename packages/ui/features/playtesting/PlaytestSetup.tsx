import { useId, useState, type JSX } from "react";
import { Play } from "lucide-react";
import type { DeckRow, DeckVariant, PlaytestDifficulty } from "@/lib/ipc";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import type { PlaytestPicks } from "./play/usePlaytestGame";

/** What the setup screen reads of a deck. */
export type SetupDeck = Pick<DeckRow, "id" | "name" | "formatName" | "archived" | "theoryEnabled">;

/** The picks as the screen holds them: a seat may have no deck yet. */
export interface SetupPicks {
  deckId: number | null;
  variant: DeckVariant;
  opponentDeckId: number | null;
  opponentVariant: DeckVariant;
  difficulty: PlaytestDifficulty;
}

export const DIFFICULTIES: readonly { id: PlaytestDifficulty; label: string }[] = [
  { id: "veryEasy", label: "Very easy" },
  { id: "easy", label: "Easy" },
  { id: "medium", label: "Medium" },
  { id: "hard", label: "Hard" },
  { id: "veryHard", label: "Very hard" },
];

const NOTHING_PICKED: SetupPicks = {
  deckId: null,
  variant: "live",
  opponentDeckId: null,
  opponentVariant: "live",
  difficulty: "medium",
};

/**
 * **The last picks, for the rest of the window's life** (`lib/viewMemory.ts`): a reader who plays
 * a game, comes back and wants another against a harder opponent should find both decks still
 * picked. Module memory and never storage, for that module's reason — a restart opens fresh.
 */
const memory = viewMemory<SetupPicks>("playtesting.setup");

/** A deck's list when it is first picked: the plan where it keeps one, the only list otherwise. */
function firstVariant(deck: SetupDeck | undefined): DeckVariant {
  return deck?.theoryEnabled ? "theory" : "live";
}

/**
 * The Playtesting page's setup: the reader's deck and the opponent's, each in one of its lists,
 * and how well the AI plays — then Start.
 *
 * **Any two of the reader's decks, the same one twice included**: a mirror match is a real test
 * of a deck. Archived decks are left out, as the gallery puts them last and out of the way. Which
 * list a deck is dealt from is the editor's own pair, **Theory first, Actual second**, and only
 * for a deck that keeps a plan (`theoryEnabled`); a deck with one list has nothing to choose.
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
  // A remembered deck since archived or deleted is no longer a pick.
  const yours = byId(held.deckId);
  const theirs = byId(held.opponentDeckId);
  const ready = yours !== undefined && theirs !== undefined;

  const options: DropdownOption[] = playable.map((d) => ({
    value: String(d.id),
    label: d.name,
    ...(d.formatName === null ? {} : { hint: d.formatName }),
  }));

  const start = () => {
    if (yours === undefined || theirs === undefined) return;
    onStart({
      deckId: yours.id,
      variant: yours.theoryEnabled ? held.variant : "live",
      opponentDeckId: theirs.id,
      opponentVariant: theirs.theoryEnabled ? held.opponentVariant : "live",
      difficulty: held.difficulty,
    });
  };

  return (
    <section className="flex h-full justify-center overflow-y-auto px-6 py-10">
      <h2 className="sr-only">Playtesting</h2>
      <div className="flex w-full max-w-[640px] flex-col gap-7">
        <p className="m-0 text-sm text-dim">
          Play one of your decks against another, the opponent played by the rules engine’s AI. You
          decide in your main phases, when you attack and block, and when a card asks you something;
          the rest plays itself.
        </p>

        {loading ? (
          <p className="m-0 text-sm text-dim">Reading your decks…</p>
        ) : playable.length === 0 ? (
          <p className="m-0 text-sm text-dim">
            Playtesting needs a deck to play. Make one in Decks, then come back.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <Seat
                title="Your deck"
                options={options}
                deck={yours}
                variant={held.variant}
                onDeck={(id) => pick({ deckId: id, variant: firstVariant(byId(id)) })}
                onVariant={(variant) => pick({ variant })}
              />
              <Seat
                title="Opponent’s deck"
                options={options}
                deck={theirs}
                variant={held.opponentVariant}
                onDeck={(id) =>
                  pick({ opponentDeckId: id, opponentVariant: firstVariant(byId(id)) })
                }
                onVariant={(opponentVariant) => pick({ opponentVariant })}
              />
            </div>

            <div className="flex flex-col gap-2">
              <span id="playtest-difficulty" className={LABEL}>
                Opponent’s skill
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
              {!ready && <span className="text-xs text-dim">Pick both decks to start.</span>}
              {ready && yours.id === theirs.id && (
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
