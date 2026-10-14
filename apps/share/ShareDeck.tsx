import { useMemo, useState } from "react";
import { CardArt } from "@grimoire/ui/components/CardArt";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { type Currency } from "@grimoire/ui/lib/marketplace";
import { formatPrice } from "@grimoire/ui/lib/prices";
import type {
  ShareCard,
  ShareDeck as ShareDeckHalf,
  ShareSnapshot,
} from "@grimoire/ui/lib/shareSnapshot";
import { cn } from "@grimoire/ui/lib/utils";
import { NOTHING, ShareTile, wireFinish } from "./ShareTile";

/**
 * A shared **deck** on the public page (issue #1032) — read-only, drawn the way the deck editor
 * draws one: Stacks by default, switchable to Grid, Table and Text.
 *
 * ## Why this is not the editor's own views
 *
 * The in-app viewer (`packages/ui/features/share/SharedDeck.tsx`) mounts the editor's four views
 * themselves. This page cannot: it is a bundle with **no core**, and `SharePage.test.tsx` walks
 * its import graph and refuses anything under `features/` — where those views live, beside the
 * drag-and-drop, the store and the card menus they are built around. So the four drawings here
 * are the editor's *shapes* — a column of overlapping cards per pile, a wall of tiles, a table, a
 * decklist — built from the same `components/` the binder page already draws with (`CardArt`
 * through `remoteSrc`, `ShareTile`), and nothing that could write anything, because there is
 * nothing on this page to write to.
 *
 * ## What it groups by
 *
 * The deck's own piles by default — the editor's *Categories* — plus the editor's *Type* and
 * *Mana value*, which are what the type line and mana value on the wire are for. Under either
 * derived grouping the editor's two rules hold: the command zone stays first as itself, and a
 * pile played beside the deck (a switched-off one, the Sideboard, a Companion) is appended as
 * itself rather than bucketed into the curve.
 */

export type DeckView = "stacks" | "grid" | "table" | "text";
type GroupBy = "pile" | "type" | "manaValue";

interface Row {
  card: ShareCard;
  /** The card's position in the snapshot — the only unique key the format has (see the binder). */
  key: string;
}

interface Group {
  key: string;
  name: string;
  rows: Row[];
  /** Copies, so a heading and the cards under it are the same unit. */
  count: number;
  /** A pile played beside the deck, drawn after it. */
  beside: boolean;
}

/** The editor's type buckets, in the order it draws them. The first word a type line carries wins. */
const TYPES = [
  "Creature",
  "Planeswalker",
  "Battle",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Land",
] as const;

function typeOf(card: ShareCard): string {
  const line = card.t ?? "";
  // The front face only: a `Creature // Land` modal card is played as its front.
  const front = line.split("//")[0];
  return TYPES.find((t) => front.includes(t)) ?? "Other";
}

function isLand(card: ShareCard): boolean {
  return typeOf(card) === "Land";
}

/** Mana value, then name — the editor's default reading order inside a pile. */
function byCost(a: Row, b: Row): number {
  return (a.card.mv ?? 0) - (b.card.mv ?? 0) || a.card.n.localeCompare(b.card.n);
}

const sumOf = (rows: readonly Row[]) => rows.reduce((n, r) => n + r.card.q, 0);

/** Every row grouped as `by` asks. Pure, so the three groupings are tested without a page. */
export function deckGroups(snapshot: ShareSnapshot, deck: ShareDeckHalf, by: GroupBy): Group[] {
  const names = new Map(snapshot.folders.map((f) => [f.uid, f.name]));
  const rows = snapshot.cards.map((card, at): Row => ({ card, key: String(at) }));
  const piles = deck.piles.map((pile) => {
    const kept = rows.filter((r) => r.card.fo === pile.uid).sort(byCost);
    return {
      key: pile.uid,
      name: names.get(pile.uid) ?? "",
      rows: kept,
      count: sumOf(kept),
      // Played beside the deck: switched off, or a zone the rules keep out of its size.
      beside: !pile.active || pile.kind === "side" || pile.kind === "companion",
      command: pile.kind === "commander" && pile.active,
    };
  });
  // A card filed under no pile this document names is drawn, never dropped.
  const known = new Set(deck.piles.map((p) => p.uid));
  const strays = rows.filter((r) => r.card.fo === null || !known.has(r.card.fo)).sort(byCost);
  const stray =
    strays.length === 0
      ? []
      : [
          {
            key: "other",
            name: "Other",
            rows: strays,
            count: sumOf(strays),
            beside: false,
            command: false,
          },
        ];

  const all = [...piles, ...stray].filter((g) => g.rows.length > 0);
  const command = all.filter((g) => g.command);
  const flow = all.filter((g) => !g.command && !g.beside);
  const beside = all.filter((g) => g.beside);
  const strip = (g: (typeof all)[number]): Group => ({
    key: g.key,
    name: g.name,
    rows: g.rows,
    count: g.count,
    beside: g.beside,
  });

  if (by === "pile") return [...command, ...flow, ...beside].map(strip);

  const buckets = new Map<string, Row[]>();
  const bucketOf = (row: Row): string => {
    if (by === "type") return typeOf(row.card);
    if (isLand(row.card)) return "Lands";
    const mv = Math.floor(row.card.mv ?? 0);
    return mv >= 7 ? "7+" : String(mv);
  };
  for (const row of flow.flatMap((g) => g.rows)) {
    const key = bucketOf(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const order =
    by === "type" ? [...TYPES, "Other"] : ["0", "1", "2", "3", "4", "5", "6", "7+", "Lands"];
  const derived = order
    .filter((key) => buckets.has(key))
    .map((key): Group => {
      const kept = (buckets.get(key) ?? []).sort(byCost);
      const name =
        by === "manaValue" && key !== "Lands"
          ? `Mana value ${key}`
          : key === "Sorcery"
            ? "Sorceries"
            : key === "Lands" || key === "Other"
              ? key
              : `${key}s`;
      return { key: `${by}:${key}`, name, rows: kept, count: sumOf(kept), beside: false };
    });
  return [...command.map(strip), ...derived, ...beside.map(strip)];
}

const VIEWS: readonly { value: DeckView; label: string }[] = [
  { value: "stacks", label: "Stacks" },
  { value: "grid", label: "Grid" },
  { value: "table", label: "Table" },
  { value: "text", label: "Text" },
];

const GROUPS: readonly { value: GroupBy; label: string }[] = [
  { value: "pile", label: "Categories" },
  { value: "manaValue", label: "Mana value" },
  { value: "type", label: "Type" },
];

export function ShareDeck({
  snapshot,
  deck,
  currency,
  showValue,
}: {
  snapshot: ShareSnapshot;
  deck: ShareDeckHalf;
  currency: Currency;
  showValue: boolean;
}) {
  const [view, setView] = useState<DeckView>("stacks");
  const [by, setBy] = useState<GroupBy>("pile");
  const groups = useMemo(() => deckGroups(snapshot, deck, by), [snapshot, deck, by]);

  return (
    <div className="pt-6">
      <div className="flex flex-wrap items-center gap-3">
        {/* A segmented switch rather than a select: four words fit, and the view is the one
            question a stranger on this page asks first. */}
        <div
          role="group"
          aria-label="View"
          className="flex overflow-hidden rounded-md border border-border"
        >
          {VIEWS.map((v, at) => (
            <button
              key={v.value}
              type="button"
              aria-pressed={view === v.value}
              onClick={() => setView(v.value)}
              className={cn(
                "h-9 px-3 text-sm transition-colors duration-150 motion-reduce:transition-none",
                at > 0 && "border-l border-border",
                view === v.value ? "bg-accent/15 text-text" : "bg-surface text-dim hover:text-text",
                FOCUS,
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        <label htmlFor="share-deck-group" className="text-sm text-dim">
          Group by
        </label>
        <select
          id="share-deck-group"
          value={by}
          onChange={(e) => setBy(e.target.value as GroupBy)}
          className={cn(
            "h-9 shrink-0 rounded-md border border-border bg-surface px-2 text-sm text-text",
            FOCUS,
          )}
        >
          {GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5">
        {view === "stacks" && <Stacks groups={groups} />}
        {view === "grid" && <Grid groups={groups} currency={currency} showValue={showValue} />}
        {view === "table" && <Table groups={groups} currency={currency} showValue={showValue} />}
        {view === "text" && <Text groups={groups} />}
      </div>
    </div>
  );
}

function Heading({ group }: { group: Group }) {
  return (
    <h2 className="mb-2 flex items-baseline gap-2 text-sm">
      <span className="truncate font-medium">{group.name}</span>
      <span className="shrink-0 font-mono text-xs text-dim">{group.count}</span>
    </h2>
  );
}

/**
 * The editor's signature drawing: one column per pile, each card overlapping the one above so its
 * title bar shows, and the whole card on hover or focus. A copy count rides on the art.
 */
function Stacks({ groups }: { groups: Group[] }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-6">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.name} className="w-40 shrink-0">
          <Heading group={group} />
          <ul role="list" className="flex flex-col">
            {group.rows.map(({ card, key }, at) => (
              <li
                key={key}
                tabIndex={0}
                aria-label={card.q > 1 ? `${card.q} ${card.n}` : card.n}
                className={cn(
                  // Each card after the first rides up so only its top fifth shows — about a
                  // title bar at this width — and the one under the pointer comes to the front.
                  "relative rounded-[0.45rem] hover:z-10 focus-visible:z-10",
                  at > 0 && "-mt-[11.6rem]",
                  FOCUS,
                )}
              >
                <CardArt
                  cardId={null}
                  name={card.n}
                  remoteSrc={card.img ?? null}
                  finish={finishMark(card)}
                  loading="lazy"
                />
                {card.q > 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute left-1.5 top-1.5 rounded bg-bg/85 px-1.5 py-0.5 font-mono text-xs"
                  >
                    {card.q}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A foil or etched copy is marked; the regular copy goes unmarked, the app's rule. */
function finishMark(card: ShareCard) {
  const finish = wireFinish(card.f);
  return finish === "nonfoil" ? null : finish;
}

function Grid({
  groups,
  currency,
  showValue,
}: {
  groups: Group[];
  currency: Currency;
  showValue: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.name}>
          <Heading group={group} />
          <ul
            role="list"
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(9.5rem, 1fr))" }}
          >
            {group.rows.map(({ card, key }) => (
              <ShareTile
                key={key}
                card={card}
                currency={currency}
                showValue={showValue}
                showCondition={false}
                showLang={false}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Table({
  groups,
  currency,
  showValue,
}: {
  groups: Group[];
  currency: Currency;
  showValue: boolean;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border text-left text-xs text-dim">
          <th scope="col" className="py-2 pr-3 font-normal">
            Qty
          </th>
          <th scope="col" className="py-2 pr-3 font-normal">
            Name
          </th>
          <th scope="col" className="py-2 pr-3 font-normal">
            Cost
          </th>
          <th scope="col" className="hidden py-2 pr-3 font-normal sm:table-cell">
            Type
          </th>
          <th scope="col" className="hidden py-2 pr-3 font-normal sm:table-cell">
            Set
          </th>
          {showValue && (
            <th scope="col" className="py-2 text-right font-normal">
              Price
            </th>
          )}
        </tr>
      </thead>
      {groups.map((group) => (
        <tbody key={group.key}>
          <tr>
            <th
              scope="rowgroup"
              colSpan={showValue ? 6 : 5}
              className="pb-1 pt-4 text-left font-medium"
            >
              {group.name}{" "}
              <span className="font-mono text-xs font-normal text-dim">{group.count}</span>
            </th>
          </tr>
          {group.rows.map(({ card, key }) => (
            <tr key={key} className="border-b border-border/50">
              <td className="py-1.5 pr-3 font-mono tabular-nums">{card.q}</td>
              <td className="py-1.5 pr-3">{card.n}</td>
              <td className="py-1.5 pr-3 font-mono text-xs">{card.mc ?? ""}</td>
              <td className="hidden py-1.5 pr-3 text-dim sm:table-cell">{card.t ?? NOTHING}</td>
              <td className="hidden py-1.5 pr-3 font-mono text-xs uppercase text-dim sm:table-cell">
                {card.s} {card.cn}
              </td>
              {showValue && (
                <td className="py-1.5 text-right font-mono tabular-nums">
                  {formatPrice(card.p ?? null, currency)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/** The decklist a player would paste: `4 Lightning Bolt`, pile by pile. */
function Text({ groups }: { groups: Group[] }) {
  return (
    <div className="columns-1 gap-8 sm:columns-2 lg:columns-3">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.name} className="mb-5 break-inside-avoid">
          <Heading group={group} />
          <ul role="list" className="font-mono text-[0.8125rem] leading-relaxed">
            {group.rows.map(({ card, key }) => (
              <li key={key}>
                {card.q} {card.n}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
