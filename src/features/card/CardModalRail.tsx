/**
 * The card modal's right-hand options rail — spec §7's list, and the grimoire figures under it.
 *
 * **It is a list rather than a fixed set of slots, and that is the whole design.** Four entries
 * are every surface's (`Legality`, `Oracle tags`, `Card text`, `Open on Scryfall`) and whatever
 * else a surface contributes arrives as {@link RailAction}s — so the deck editor's six and the
 * search wall's four are one component drawing a longer or a shorter list, rather than a
 * component with four named slots plus a hole for the extras. A rail built the other way makes
 * "how many options does this surface have" a fact about *this file*, which is the one place it
 * cannot be known.
 *
 * **It is a column at every rung and a column in two different places.** At `@min-[900px]/card`
 * and above it is the panel's third grid column; below `@min-[640px]/card` there are no columns
 * at all and its entries join the single scroller under this same **Options** heading. That
 * placement is the host's (`CardDetailModal`); all this file draws is a `flex flex-col` that
 * works in either, which is why nothing here positions itself.
 */
import { ExternalLink } from "lucide-react";
import { useId } from "react";
import { openExternal, scryfallCardUrl } from "@/lib/externalLinks";
import { FOCUS } from "@/lib/focus";
import type { CardDetail, DeckVariant } from "@/lib/ipc";
import { PRESS_SOFT } from "@/lib/motion";
import { useAppStore, type CardOverlay } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { CardModalScope } from "./cardModalScope";

/** One surface-specific rail entry — a word and what pressing it does, and nothing else. */
export interface RailAction {
  label: string;
  onSelect: () => void;
}

/**
 * What the **In your grimoire** block states.
 *
 * **`deck` is not in the plan's shape and had to be added, because nothing else can answer it.**
 * The block's deck line reads `4× in Burn spells · Actual`, and of its three parts
 * {@link CardModalScope.deck} carries two — `categoryName` and `variant` — while the *quantity*
 * is on no field this component can reach: `PaneDeckContext` is a slot (deck, category, printing,
 * list, finish) and deliberately holds no count, since a count changes under an open modal every
 * time the stepper is pressed. The host has the deck in hand and passes the number down beside the
 * other three, which keeps the four figures one prop rather than three plus an exception.
 *
 * `null` outside a deck, and the line is drawn only when {@link CardModalScope.deck} is non-null
 * *and* this is a number — the two agree by construction at the one host that fills them.
 */
export interface RailCounts {
  owned: number;
  wished: number;
  decks: number;
  /** Copies in the deck row the card was opened out of, or `null` outside a deck. */
  deck: number | null;
}

/**
 * The app's two words for a deck's two lists, as the deck editor's own tabs and the card menu's
 * deck submenu already spell them.
 *
 * **`Actual`, not `Live`**, and **neither is `mainboard`** — the mockup's word, which this app has
 * no concept of: a deck here is `live`/`theory` with user-named categories, so a line reading
 * "mainboard" would be naming something the reader cannot see anywhere else in the app. Written
 * out rather than derived, so the two spellings are greppable.
 */
const VARIANT_LABEL: Record<DeckVariant, string> = { live: "Actual", theory: "Theory" };

/**
 * A rail entry's box — 44px tall and the full width of the rail, left-aligned.
 *
 * 44px is the touch floor the phone rung is drawn at, and it is the height at *every* rung rather
 * than a rung-specific one: the rail is the same list of the same options wherever it lands, and a
 * control that changed height with the panel would be a second thing for a reader to re-find.
 *
 * {@link PRESS_SOFT} rather than {@link import("@/lib/motion").PRESS}, for its own documented
 * reason — these are as wide as the column they sit in, and a full-width row dipping 3% reads as
 * the panel moving rather than as a button going down.
 */
const RAIL_ENTRY = cn(
  "flex h-11 w-full items-center gap-2 rounded-md border border-border px-3 text-left text-sm",
  "text-text hover:border-accent/40 hover:text-accent",
  PRESS_SOFT,
);

/** What the list draws, once the four common entries and the surface's own are one array. */
interface RailEntry extends RailAction {
  /** Drawn after the label and `aria-hidden`, so it is never part of the accessible name. */
  external?: boolean;
}

export function CardModalRail({
  card,
  scope,
  actions,
  counts,
}: {
  card: CardDetail;
  scope: CardModalScope;
  /** Surface-specific entries, appended after the four common ones. */
  actions: readonly RailAction[];
  /** owned / wished / decks, and the deck line when there is one. */
  counts: RailCounts;
}) {
  const optionsId = useId();
  const grimoireId = useId();
  const openOverlay = useAppStore((s) => s.openCardOverlay);

  // The three overlays are one store field with one writer, so naming which is the whole of what
  // an entry does — see `AppState.cardOverlay`, where the single-field shape is argued. Nothing
  // here holds open-state of its own, which is what makes at most one of them open true by
  // construction rather than by three call sites agreeing.
  const overlay = (which: CardOverlay) => () => openOverlay(which);

  const entries: RailEntry[] = [
    { label: "Legality", onSelect: overlay("legality") },
    { label: "Oracle tags", onSelect: overlay("oracleTags") },
    { label: "Card text", onSelect: overlay("cardText") },
    {
      label: "Open on Scryfall",
      external: true,
      // `openExternal` is the app's single call that leaves it, and it is made **on the press**:
      // a rail that merely offers Scryfall must not have visited it. Never a raw `window.open` —
      // in a Tauri webview that navigates the app's own window. The URL is built by
      // `scryfallCardUrl`, which lowercases the set code and escapes a collector number like
      // `1556★`; assembling it here would be a second spelling of a documented permalink.
      onSelect: () => void openExternal(scryfallCardUrl(card.setCode, card.collectorNumber)),
    },
    ...actions,
  ];

  const deckLine =
    scope.deck === null || counts.deck === null
      ? null
      : // One text node rather than a number and a label in two elements: a CSS `gap` is not a
        // word separator to the accessible-name computation, so a split line reads as
        // "4×in Burn spells" both to a `getByText` and to a screen reader.
        `${counts.deck}× in ${scope.deck.categoryName} · ${VARIANT_LABEL[scope.deck.variant]}`;

  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby={optionsId} className="flex flex-col gap-2">
        <h3 id={optionsId} className="text-xs uppercase tracking-wide text-dim">
          Options
        </h3>
        {/* A list, so a reader moving item to item is told how many there are — which is the
            part that differs per surface and the one thing a heading cannot say. */}
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li key={entry.label}>
              <button type="button" onClick={entry.onSelect} className={cn(RAIL_ENTRY, FOCUS)}>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.external === true && (
                  <ExternalLink className="size-4 shrink-0 text-dim" aria-hidden="true" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* **Hidden below `@min-[1200px]/card`**, which is artboard `2c` (906–1501px) dropping the
          block and `1a` (1502+) keeping it. The middle rung is where the panel is three columns
          and the rail has the least room, and these figures are the part of it a reader can get
          from the wall they came from — the tile's own owned badge — so they are what goes.

          The fold is measured on the panel's `@container/card`, declared by `Dialog`'s `container`
          prop; this only queries it. `@min-[…]` rather than the bare `@[…]`: both compile to the
          identical rule on this build, and one spelling per repo is what makes a grep for a rung
          find every site. Written out whole, because Tailwind scans source text for whole class
          names and an interpolated one emits no rule at all.

          **jsdom applies no container query and every box is 0**, so nothing in the suite can see
          this fold happen — the test pins the class, and the widths are settled in the window. */}
      <section
        aria-labelledby={grimoireId}
        className="hidden flex-col gap-2 border-t border-border pt-4 @min-[1200px]/card:flex"
      >
        <h3 id={grimoireId} className="text-xs uppercase tracking-wide text-dim">
          In your grimoire
        </h3>
        <dl className="flex flex-col gap-1 text-sm">
          <GrimoireFigure label="Owned" value={counts.owned} />
          <GrimoireFigure label="Wished" value={counts.wished} />
          <GrimoireFigure label="In decks" value={counts.decks} />
        </dl>
        {deckLine !== null && <p className="text-xs text-dim">{deckLine}</p>}
      </section>
    </div>
  );
}

/** One figure — the word on the left, the number pushed to the right by `justify-between`. */
function GrimoireFigure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-dim">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
