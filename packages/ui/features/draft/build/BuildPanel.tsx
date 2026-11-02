import { useId, useMemo, useState, type JSX } from "react";
import { Hammer } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { openDraftDeck } from "@/features/draft/navigation";
import { plural } from "@/lib/counts";
import { ipc, ipcError, type DraftCard, type DraftView } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { colorTally, isLand } from "../pick/pool";
import { ColorTally } from "../pick/PoolColumns";
import { splitPool, toDraftDeck } from "../pick/split";
import { FIELD, LABEL, PANEL, PrimaryButton } from "../setup/parts";

/**
 * What each of the deck's printings does, by printing id — one read for the whole deck, the way
 * the importer asks (`oracle_tags_for_printings`). **A read that fails is not a deck that fails**
 * (`useDeckCore`'s `oracleTagsFor`, for its reason): every card is then filed by its type line.
 */
async function deckTags(
  cards: readonly DraftCard[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const ids = [...new Set(cards.map((c) => c.cardId))];
  if (ids.length === 0) return new Map();
  try {
    const answers = await ipc.oracleTagsForPrintings(ids);
    return new Map(answers.map((a) => [a.cardId, a.slugs]));
  } catch {
    return new Map();
  }
}

/** Whose draft this is, which decides how it is put away once the deck is built. */
export type DraftRole = "solo" | "host" | "guest";

/**
 * The Build step: what the pool holds, a name for the deck, and the press that turns the pool
 * into a deck in the deck editor's draft mode, opened in this view (spec §5) — a **virtual**
 * Limited deck, never the collection's. **The cards picked into the deck are filed by what they
 * do** (issue #1471) — `autoCategoryFor`, the add path's own rule, over one read of their Oracle
 * tags — and the sideboard's go into its Pool. A Commander draft's (`view.commanders > 0`,
 * spec §4a) is a Casual deck with a Commander pile beside Deck and Pool, built with
 * `draft_deck_create`'s `commander` flag.
 *
 * Once the deck exists the draft is put away: a solo draft's saved copy is dropped
 * (`draft_end`), and a pod's seat leaves the lobby (`lobby_leave` — for the host that closes the
 * room, which every guest has already been dealt their last view by). A failure to put it away
 * loses nothing — the deck is made, and a solo draft left saved is one *Abandon* on the hub — so
 * it is not said.
 */
export function BuildPanel({
  view,
  draft,
  role,
  sideboard = [],
  onBuilt,
}: {
  view: DraftView;
  /** The pool's cards on the sideboard, by `instanceId` (`../pick/split.ts`). */
  sideboard?: readonly string[];
  /** The page's name for the draft — `null` for a guest, whose draft runs on the host. */
  draft: number | null;
  role: DraftRole;
  /** The deck is made and the draft put away — the session forgets it. */
  onBuilt?: () => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState(`${view.label} Draft`);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const tally = useMemo(() => colorTally(view.pool), [view.pool]);
  const lands = view.pool.filter(isLand).length;
  const creatures = view.pool.filter((c) => !isLand(c) && /\bCreature\b/.test(c.typeLine)).length;
  const others = view.pool.length - lands - creatures;
  const split = useMemo(() => splitPool(view.pool, sideboard), [view.pool, sideboard]);
  const ready = name.trim() !== "" && view.pool.length > 0;
  const commander = view.commanders > 0;

  const build = async () => {
    setBusy(true);
    try {
      const { cardIds, deck } = toDraftDeck(split, await deckTags(split.deck));
      const row = await ipc.draftDeckCreate(name.trim(), cardIds, deck, commander);
      try {
        if (role === "solo" && draft !== null) await ipc.draftEnd(draft);
        else await ipc.lobbyLeave();
      } catch {
        // See the component's doc: the deck is made, and nothing the reader did is lost.
      }
      // The decks root holds *Draft in progress* (`DRAFT_DECKS_KEY`). Nothing is seeded for the
      // editor: it opens in the Draft view (`host="draft"`), which is draft mode from its first
      // frame, and the row's own `draft` flag decides from `deck_get` on.
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      onBuilt?.();
      notify.success(`Built “${row.name}” from a ${view.pool.length}-card pool`);
      openDraftDeck(row.id);
    } catch (e) {
      notify.error("Couldn’t build the deck", { body: ipcError(e) });
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${fieldId}-title`} className={cn(PANEL, "flex flex-col gap-5 p-6")}>
      <div className="flex flex-col gap-2">
        <h3 id={`${fieldId}-title`} className="m-0 font-heading text-xl font-semibold">
          Build your deck
        </h3>
        <p className="m-0 max-w-[60ch] text-sm text-dim">
          The draft is done. Your {plural(view.pool.length, "card")} go into a deck of their own:
          the {split.deck.length} in your deck filed by what they do, the {split.sideboard.length}{" "}
          in your sideboard in its Pool — click a card below to move it, and add basics in the
          editor.{" "}
          {commander
            ? `A Commander deck needs ${view.minDeckSize} cards and ${view.commanders === 1 ? "a commander" : `${view.commanders} commanders`} in its Commander pile.`
            : `A deck needs ${view.minDeckSize} cards.`}{" "}
          Nothing is added to your collection.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span>
          <span className="font-mono tabular-nums">{creatures}</span>{" "}
          <span className="text-dim">{creatures === 1 ? "creature" : "creatures"}</span>
        </span>
        <span>
          <span className="font-mono tabular-nums">{others}</span>{" "}
          <span className="text-dim">{others === 1 ? "other spell" : "other spells"}</span>
        </span>
        <span>
          <span className="font-mono tabular-nums">{lands}</span>{" "}
          <span className="text-dim">{lands === 1 ? "land" : "lands"}</span>
        </span>
        <ColorTally tally={tally} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-72 flex-1 flex-col gap-1.5">
          <label htmlFor={fieldId} className={LABEL}>
            Deck name
          </label>
          <input
            id={fieldId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready && !busy) void build();
            }}
            className={FIELD}
          />
        </div>
        <PrimaryButton ready={ready} busy={busy} onPress={() => void build()}>
          <Hammer className="size-4" aria-hidden="true" />
          Build deck
        </PrimaryButton>
      </div>
    </section>
  );
}
