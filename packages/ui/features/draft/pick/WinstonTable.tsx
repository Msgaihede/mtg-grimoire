import { useId, type JSX } from "react";
import { Hourglass, WandSparkles } from "lucide-react";
import { CardArt } from "@/components/CardArt";
import { GrimoireMark } from "@/components/GrimoireMark";
import { plural } from "@/lib/counts";
import type { DraftView, WinstonView } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { InlineError, LABEL, PrimaryButton, QUIET_BUTTON } from "../setup/parts";

/** A face-down card's shadow edges, by how deep the pile under it is — none, one, or two. */
const EDGES = [
  "",
  "shadow-[3px_3px_0_var(--color-bg),4px_4px_0_var(--color-border)]",
  "shadow-[3px_3px_0_var(--color-bg),4px_4px_0_var(--color-border),7px_7px_0_var(--color-bg),8px_8px_0_var(--color-border)]",
] as const;

/**
 * A Winston draft's table (spec §4a), in the pack's place on the pick screen: the shared stack
 * face down with its count, the three piles beside it as face-down stacks with theirs, and the
 * pile the turn is deciding on ringed.
 *
 * **On the reader's turn** the active pile is turned face up below the table — the one pile whose
 * cards the host tells this seat — with **Take pile** (the pile is the reader's, and is refilled
 * with a card from the stack) and **Decline** (a card from the stack is added to it, and the next
 * pile is looked at; declining the last takes the stack's top card blind). On anyone else's turn
 * the table says who is deciding. The decision is the host's to apply: the caller sends it
 * (`draft_winston`, or a guest's `lobby_winston`) and draws the view that comes back.
 */
export function WinstonTable({
  view,
  stack,
  busy,
  error,
  onDecide,
  onAutoPick,
}: {
  view: DraftView;
  stack: WinstonView;
  busy: boolean;
  error: string | null;
  onDecide: (pile: number, take: boolean) => void;
  /** The bot's decision for the reader — absent for a guest, whose host's app makes it. */
  onAutoPick?: () => void;
}): JSX.Element {
  const headingId = useId();
  const active = stack.activePile;
  const pile = active === null ? undefined : stack.piles[active];
  const deciding = stack.yourTurn && pile !== undefined && view.status === "drafting";
  const last = active !== null && active === stack.piles.length - 1;
  const turnSeat = view.seats[stack.turnSeat];
  const who = turnSeat?.name ?? `Seat ${stack.turnSeat + 1}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <h3 id={headingId} className="m-0 font-heading text-lg font-semibold leading-none">
          {deciding ? `Your turn · Pile ${(active ?? 0) + 1}` : "Winston table"}
        </h3>
        <span className="font-mono text-sm tabular-nums text-dim">
          {plural(stack.mainCount, "card")} in the stack
        </span>
        {deciding && onAutoPick !== undefined && (
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onAutoPick();
            }}
            className={cn(QUIET_BUTTON, "ml-auto")}
          >
            <WandSparkles className="size-4" aria-hidden="true" />
            Pick for me
          </button>
        )}
      </div>

      <ol aria-label="Stack and piles" className="m-0 flex list-none flex-wrap items-end gap-6 p-0">
        <li className="flex flex-col items-center gap-2">
          <FaceDown count={stack.mainCount} label={`The stack, ${plural(stack.mainCount, "card")}`} />
          <span className={LABEL}>Stack</span>
        </li>
        <li aria-hidden="true" className="h-24 w-px self-center bg-border" />
        {stack.piles.map((p, i) => (
          <li key={i} className="flex flex-col items-center gap-2">
            <FaceDown
              count={p.count}
              active={p.active}
              label={`Pile ${i + 1}, ${plural(p.count, "card")}${p.active ? ", being looked at" : ""}`}
            />
            <span className={cn(LABEL, p.active && "text-accent")}>Pile {i + 1}</span>
          </li>
        ))}
      </ol>

      {deciding && pile !== undefined ? (
        <div className="flex flex-col gap-3 rounded-xl border border-accent/50 bg-accent/5 p-4">
          <p className="m-0 text-sm">
            Pile {(active ?? 0) + 1} holds {plural(pile.cards.length, "card")}.{" "}
            <span className="text-dim">
              {last
                ? "Decline it and you take the stack's top card instead, unseen."
                : `Decline it and a card from the stack joins it; you look at pile ${(active ?? 0) + 2} next.`}
            </span>
          </p>
          <ul
            aria-label={`Pile ${(active ?? 0) + 1}`}
            className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-0"
          >
            {pile.cards.map((c) => (
              <li key={c.instanceId}>
                <CardArt cardId={c.cardId} name={c.name} hoverZoom />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton
              ready={pile.cards.length > 0 || pile.count > 0}
              busy={busy}
              onPress={() => onDecide(active ?? 0, true)}
            >
              Take pile
            </PrimaryButton>
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onDecide(active ?? 0, false);
              }}
              className={cn(QUIET_BUTTON, "h-11 rounded-full px-5")}
            >
              Decline
            </button>
          </div>
        </div>
      ) : (
        view.status === "drafting" && (
          <div
            role="status"
            className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center"
          >
            <Hourglass className="size-6 text-accent" aria-hidden="true" />
            <p className="m-0 text-sm">
              {stack.yourTurn
                ? "Sending your decision…"
                : turnSeat?.bot === true
                  ? `${who} is deciding…`
                  : `Waiting for ${who}`}
            </p>
          </div>
        )
      )}
      <InlineError message={error} />
    </section>
  );
}

/** A face-down pile: a card back, its edges as deep as the pile, and its count on it. An empty
 *  pile is its dashed outline. */
function FaceDown({
  count,
  label,
  active = false,
}: {
  count: number;
  label: string;
  active?: boolean;
}): JSX.Element {
  return (
    <span role="img" aria-label={label} className="relative block w-24">
      {count === 0 ? (
        <span className="block aspect-[5/7] w-full rounded-lg border border-dashed border-border" />
      ) : (
        <span
          className={cn(
            "flex aspect-[5/7] w-full items-center justify-center rounded-lg border bg-surface",
            active ? "border-accent ring-2 ring-accent/60" : "border-border",
            EDGES[Math.min(2, count - 1)],
          )}
        >
          <GrimoireMark size={36} className="text-accent" />
        </span>
      )}
      <span
        aria-hidden="true"
        className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-bg/85 px-2 font-mono text-xs tabular-nums text-text"
      >
        {count}
      </span>
    </span>
  );
}
