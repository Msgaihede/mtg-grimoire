import { useId, useState, type JSX } from "react";
import { Play } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type DraftView, type PlaytestDifficulty, type SetSummary } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { viewMemory } from "@/lib/viewMemory";
import { MODE_TITLE } from "../pick/DraftSession";
import {
  cubeCards,
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  DRAFT_PACKS,
  freshDraftName,
  MIN_DECK_SIZE,
  readCubeList,
  SEALED_PACKS,
  TABLE_SEATS,
} from "./deal";
import { AddPackWall, PackOrder } from "./PackOrder";
import { FIELD, FlowBar, InlineError, LABEL, PrimaryButton, Segmented } from "./parts";
import { useDealDraft } from "./useDealDraft";

/** The modes the setup's tabs switch between. A pod has a lobby of its own (`lobby/`). */
export type SetupMode = "quick" | "sealed" | "cube";

const TABS: readonly { id: SetupMode; label: string }[] = [
  { id: "quick", label: "Quick Draft" },
  { id: "sealed", label: "Sealed" },
  { id: "cube", label: "Cube Draft" },
];

/** What the setup holds, for the window's life (`lib/viewMemory.ts`): a reader who drafts, builds,
 *  and comes back for another finds their packs and their cube list where they left them. */
interface SetupHeld {
  quick: SetSummary[];
  sealed: SetSummary[];
  difficulty: PlaytestDifficulty;
  cube: CubeHeld;
}

interface CubeHeld {
  name: string;
  seats: number;
  packs: number;
  packSize: number;
  minDeckSize: number;
  list: string;
}

const FRESH: SetupHeld = {
  quick: [],
  sealed: [],
  difficulty: DEFAULT_DIFFICULTY,
  cube: { name: "", seats: TABLE_SEATS, packs: 3, packSize: 15, minDeckSize: MIN_DECK_SIZE, list: "" },
};

const memory = viewMemory<SetupHeld>("draft.setup");

/**
 * The Choose step for a draft against bots: Quick Draft (three boosters, any sets, repeats
 * allowed), Sealed (six boosters straight into the pool) and Cube Draft (a pasted list, dealt into
 * boosters). Start deals the boosters here and hands them to the host (`draft_start`), and the
 * page moves on to the pick screen with the view it answers.
 */
export function SetupScreen({
  mode,
  onMode,
  onBack,
  onStarted,
}: {
  mode: SetupMode;
  onMode: (mode: SetupMode) => void;
  onBack: () => void;
  onStarted: (draft: number, view: DraftView) => void;
}): JSX.Element {
  const [held, setHeldState] = useState<SetupHeld>(() => memory.recall() ?? FRESH);
  const setHeld = (patch: Partial<SetupHeld>) =>
    setHeldState((cur) => {
      const next = { ...cur, ...patch };
      memory.keep(next);
      return next;
    });
  const setCube = (patch: Partial<CubeHeld>) => setHeld({ cube: { ...held.cube, ...patch } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A cube whose list named cards this corpus lacks: those names, and the cards it did find. */
  const [missing, setMissing] = useState<{ names: string[]; cardIds: string[] } | null>(null);
  const { dealSets, dealCubeDraft } = useDealDraft();

  const packsFor = mode === "sealed" ? SEALED_PACKS : DRAFT_PACKS;
  const chosen = mode === "sealed" ? held.sealed : held.quick;
  const setChosen = (next: SetSummary[]) =>
    setHeld(mode === "sealed" ? { sealed: next } : { quick: next });

  const ready =
    mode === "cube" ? held.cube.list.trim() !== "" : chosen.length === packsFor;

  const begin = async (deal: () => Promise<Parameters<typeof ipc.draftStart>[0]>) => {
    setBusy(true);
    setError(null);
    try {
      const setup = await deal();
      const draft = freshDraftName();
      const view = await ipc.draftStart(setup, draft);
      onStarted(draft, view);
    } catch (e) {
      setError(ipcError(e));
      setBusy(false);
    }
  };

  const startCube = (cardIds: readonly string[]) =>
    begin(async () =>
      dealCubeDraft({
        name: held.cube.name,
        cardIds,
        shape: { seats: held.cube.seats, packs: held.cube.packs, packSize: held.cube.packSize },
        difficulty: held.difficulty,
        minDeckSize: held.cube.minDeckSize,
      }),
    );

  const start = async () => {
    setMissing(null);
    if (mode !== "cube") {
      await begin(() => dealSets({ mode, rounds: chosen, difficulty: held.difficulty }));
      return;
    }
    const list = readCubeList(held.cube.list);
    if (list.lines.length === 0) {
      setError("Nothing in the list reads as a card — write one per line, like “1 Lightning Bolt”.");
      return;
    }
    setBusy(true);
    setError(null);
    let found: ReturnType<typeof cubeCards>;
    try {
      // One call for the whole list — the importer's resolver (`import_resolve`).
      found = cubeCards(list, await ipc.importResolve(list.lines.map((l) => l.resolve)));
    } catch (e) {
      setError(ipcError(e));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (found.unresolved.length > 0) {
      setMissing({ names: found.unresolved, cardIds: found.cardIds });
      return;
    }
    await startCube(found.cardIds);
  };

  return (
    <section className="flex h-full min-h-0 flex-col">
      <FlowBar title={MODE_TITLE[mode]} onBack={onBack} step="choose" />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pb-6 pr-6 pt-3">
          <ModeTabs mode={mode} onMode={onMode} />
          {mode === "cube" ? (
            <CubeList value={held.cube.list} onChange={(list) => setCube({ list })} />
          ) : (
            <AddPackWall chosen={chosen} max={packsFor} onChange={setChosen} />
          )}
        </div>
        <aside
          aria-label="Draft setup"
          className="flex w-[24rem] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-surface/45 px-6 pb-6 pt-3"
        >
          {mode !== "sealed" && (
            <Segmented
              label="Bot difficulty"
              options={DIFFICULTIES}
              value={held.difficulty}
              onPick={(difficulty) => setHeld({ difficulty })}
            />
          )}
          {mode === "cube" ? (
            <CubeFields cube={held.cube} onChange={setCube} />
          ) : (
            <PackOrder chosen={chosen} max={packsFor} onChange={setChosen} />
          )}
          {missing !== null && (
            <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive/50 p-3">
              <p className="m-0 text-sm">
                {missing.names.length === 1 ? "One name matches" : `${missing.names.length} names match`}{" "}
                no card here:
              </p>
              <ul className="m-0 flex max-h-40 list-none flex-col gap-0.5 overflow-y-auto p-0 text-sm text-dim">
                {missing.names.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  const ids = missing.cardIds;
                  setMissing(null);
                  void startCube(ids);
                }}
                className="self-start text-sm text-accent hover:text-text"
              >
                Draft without them
              </button>
            </div>
          )}
          <div className="mt-auto flex flex-col gap-2 pt-2">
            <PrimaryButton ready={ready} busy={busy} onPress={() => void start()}>
              <Play className="size-4 fill-current" aria-hidden="true" />
              {mode === "sealed" ? "Open sealed pool" : "Start draft"}
            </PrimaryButton>
            <InlineError message={error} />
            {!ready && error === null && (
              <p className="m-0 text-center text-xs text-dim">
                {mode === "cube"
                  ? "Paste a cube list to start."
                  : `Choose ${packsFor - chosen.length} more ${packsFor - chosen.length === 1 ? "pack" : "packs"} to start.`}
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

/** Quick Draft | Sealed | Cube Draft — the setup's three ways to sit down against bots. */
function ModeTabs({
  mode,
  onMode,
}: {
  mode: SetupMode;
  onMode: (mode: SetupMode) => void;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Draft mode"
      className="flex self-start rounded-full border border-border bg-surface p-1"
    >
      {TABS.map((tab) => {
        const pressed = tab.id === mode;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={pressed}
            onClick={() => onMode(tab.id)}
            className={cn(
              "h-8 rounded-full px-4 text-sm",
              "transition-colors duration-150 motion-reduce:transition-none",
              pressed ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
              FOCUS,
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** The cube's list, one card per line. */
function CubeList({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  const id = useId();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <label htmlFor={id} className={LABEL}>
        Cube list
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={"1 Lightning Bolt\n1 Counterspell\n1 Llanowar Elves\n…"}
        className={cn(FIELD, "h-auto min-h-80 flex-1 resize-none py-2 font-mono leading-relaxed")}
      />
      <p className="m-0 text-xs text-dim">
        One card per line — “1 Lightning Bolt”, a set hint like “(M10) 146” if you want a printing.
        Lists from Moxfield, Arena and CubeCobra paste as they are.
      </p>
    </div>
  );
}

/**
 * A number field with its label. What is typed is held as typed — clamping each keystroke would
 * turn the `1` of a `15` into the floor — and a number in `[min, max]` is passed on at once; the
 * field is clamped into range when it is left.
 */
function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}): JSX.Element {
  const id = useId();
  const [text, setText] = useState(String(value));
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
        onBlur={() => {
          const n = Math.round(Number(text));
          const clamped = Number.isFinite(n) && text !== "" ? Math.min(max, Math.max(min, n)) : value;
          setText(String(clamped));
          onChange(clamped);
        }}
        className={cn(FIELD, "w-full font-mono tabular-nums")}
      />
    </div>
  );
}

function CubeFields({
  cube,
  onChange,
}: {
  cube: CubeHeld;
  onChange: (patch: Partial<CubeHeld>) => void;
}): JSX.Element {
  const nameId = useId();
  const need = cube.seats * cube.packs * cube.packSize;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className={LABEL}>
          Cube name
        </label>
        <input
          id={nameId}
          value={cube.name}
          placeholder="My Vintage Cube"
          onChange={(e) => onChange({ name: e.target.value })}
          className={FIELD}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label="Seats"
          value={cube.seats}
          min={2}
          max={TABLE_SEATS}
          onChange={(seats) => onChange({ seats })}
        />
        <NumberField
          label="Packs"
          value={cube.packs}
          min={1}
          max={5}
          onChange={(packs) => onChange({ packs })}
        />
        <NumberField
          label="Pack size"
          value={cube.packSize}
          min={5}
          max={20}
          onChange={(packSize) => onChange({ packSize })}
        />
        <NumberField
          label="Min deck"
          value={cube.minDeckSize}
          min={20}
          max={60}
          onChange={(minDeckSize) => onChange({ minDeckSize })}
        />
      </div>
      <p className="m-0 text-xs text-dim">
        You and {cube.seats - 1} {cube.seats === 2 ? "bot" : "bots"}; the deal takes{" "}
        <span className="font-mono tabular-nums">{need}</span> cards from the list.
      </p>
    </div>
  );
}
