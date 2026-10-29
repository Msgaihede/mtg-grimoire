import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { mulberry32, randomSeed } from "@/features/draft/booster/rng";
import { boosterSetKey } from "@/features/draft/sets";
import {
  ipc,
  type BoosterSet,
  type DraftMode,
  type DraftSeatSetup,
  type DraftSetup,
  type PlaytestDifficulty,
  type PodFormat,
  type SetSummary,
} from "@/lib/ipc";
import {
  dealCube,
  dealSetPacks,
  minDeckSizeFor,
  setsLabel,
  soloSeats,
  type CubeShape,
} from "./deal";

/**
 * What a set-booster draft is dealt from: a set per round, the bots' skill, and the table. Every
 * set mode deals the same `[seat][round]` boosters — a Winston draft's host shuffles them into its
 * stack — so only the seat count and the deck's floor differ.
 */
export interface SetDraftChoice {
  mode: Extract<DraftMode, "quick" | "sealed" | "pod" | "commander" | "winston">;
  rounds: readonly SetSummary[];
  difficulty: PlaytestDifficulty;
  seats?: DraftSeatSetup[];
  /** What a pod drafts; ignored (sent as `"booster"`) for every other mode. */
  podFormat?: PodFormat;
}

export interface CubeDraftChoice {
  name: string;
  cardIds: readonly string[];
  shape: CubeShape;
  difficulty: PlaytestDifficulty;
  minDeckSize: number;
}

/**
 * The deal, as a `DraftSetup` the host takes: the boosters opened here (spec §3, one generator for
 * Packs and Draft), the bots' dice, the table. **Nothing is started** — the caller hands the setup
 * to `draft_start` or, for a pod, `lobby_start`.
 *
 * A set's booster data is read through `useBoosterSet`'s own cache entry (`boosterSetKey`), so a set
 * the reader opened on the Packs page is not fetched again, and the reverse. A failure rejects with
 * the host's sentence, or the deal's own (a set with no booster to draft from, a cube too short).
 */
export function useDealDraft(): {
  dealSets: (choice: SetDraftChoice) => Promise<DraftSetup>;
  dealCubeDraft: (choice: CubeDraftChoice) => DraftSetup;
} {
  const client = useQueryClient();

  const boosterSet = useCallback(
    (code: string) =>
      client.fetchQuery({
        queryKey: boosterSetKey(code),
        queryFn: () => ipc.packsBoosterSet(code, false),
        staleTime: Infinity,
        retry: false,
      }),
    [client],
  );

  const dealSets = useCallback(
    async (choice: SetDraftChoice): Promise<DraftSetup> => {
      const codes = [...new Set(choice.rounds.map((s) => s.code))];
      const fetched = await Promise.all(codes.map(boosterSet));
      const byCode = new Map<string, BoosterSet>(codes.map((code, i) => [code, fetched[i]]));
      const seats = choice.seats ?? soloSeats();
      const podFormat: PodFormat = choice.mode === "pod" ? (choice.podFormat ?? "booster") : "booster";
      const seed = randomSeed();
      const rng = mulberry32(seed);
      const packs = dealSetPacks(
        choice.rounds.map((s) => byCode.get(s.code) as BoosterSet),
        seats.length,
        rng,
      );
      return {
        mode: choice.mode,
        difficulty: choice.difficulty,
        seed,
        label: setsLabel(choice.rounds.map((s) => s.name)),
        seats,
        packs,
        packSets: choice.rounds.map((s) => s.code.toUpperCase()),
        minDeckSize: minDeckSizeFor(choice.mode, podFormat),
        podFormat,
      };
    },
    [boosterSet],
  );

  const dealCubeDraft = useCallback((choice: CubeDraftChoice): DraftSetup => {
    const seed = randomSeed();
    const packs = dealCube(choice.cardIds, choice.shape, mulberry32(seed));
    return {
      mode: "cube",
      difficulty: choice.difficulty,
      seed,
      label: choice.name.trim() || "Cube",
      seats: soloSeats(choice.shape.seats),
      packs,
      packSets: Array.from({ length: choice.shape.packs }, () => ""),
      minDeckSize: choice.minDeckSize,
      podFormat: "booster",
    };
  }, []);

  return { dealSets, dealCubeDraft };
}
