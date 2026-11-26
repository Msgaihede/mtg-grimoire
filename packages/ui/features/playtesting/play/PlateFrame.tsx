import { useRef, type JSX, type MouseEvent, type ReactNode } from "react";
import {
  Ban,
  Castle,
  CircleDot,
  Crown,
  DoorOpen,
  Gauge,
  Landmark,
  Radiation,
  Skull,
  Star,
  Ticket,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { CardImage } from "@/components/CardImage";
import type {
  GameCard,
  PlaytestCommanderDamage,
  PlaytestCompanion,
  PlaytestPlayer,
  PlaytestSeat,
  PlaytestView,
} from "@/lib/ipc";
import { cardImageUrl } from "@/lib/images";
import { cn } from "@/lib/utils";
import { shownName } from "../table/Inspect";
import { useAimTarget, type DropAim } from "../table/tableDrag";
import { conditionWords } from "./details";
import { tableCards } from "./players";

/** What of a seat's standing its plate draws beside poison: the wire's own fields. */
export type Standing = Pick<
  PlaytestSeat,
  | "energy"
  | "experience"
  | "rad"
  | "tickets"
  | "speed"
  | "monarch"
  | "initiative"
  | "cityBlessing"
  | "ring"
  | "dungeon"
  | "conditions"
>;

/** One mark of a player's standing on their plate: a glyph, its short text, and its words. */
export interface StandingMark {
  key: string;
  icon: LucideIcon;
  /** What the badge says beside its glyph: a count, or a word or two. */
  text: string;
  /** Its name for a screen reader: "3 energy", "The monarch". */
  label: string;
  /** Its words on hover, where they say more than `label` (a dungeon room's text). */
  title?: string;
  /** Gold for a designation a player holds (the monarch, the initiative); red for a condition
   *  that keeps them from something (can't gain life); plain otherwise. */
  tone: "plain" | "accent" | "danger";
}

/**
 * The marks a player's standing puts on their plate, in the order they are drawn: their counters
 * (energy, experience, rad, tickets, CR 122.1), speed, the Ring's temptations, the monarch, the
 * initiative, the city's blessing, the dungeon room they are in, and the conditions on them —
 * can't gain life, can't cast spells (phase's `player_status`). **Only what a player has**:
 * a count of 0, a speed of `null`, a designation not held draws nothing, so a game without any of
 * it shows the plate as it always was.
 */
export function standingMarks(seat: Standing): StandingMark[] {
  const marks: StandingMark[] = [];
  const count = (key: string, icon: LucideIcon, n: number, word: string) => {
    if (n > 0) marks.push({ key, icon, text: String(n), label: `${n} ${word}`, tone: "plain" });
  };
  count("energy", Zap, seat.energy, "energy");
  count("experience", Star, seat.experience, "experience");
  count("rad", Radiation, seat.rad, "rad");
  count("tickets", Ticket, seat.tickets, seat.tickets === 1 ? "ticket" : "tickets");
  if (seat.speed !== null) {
    marks.push({
      key: "speed",
      icon: Gauge,
      text: `Speed ${seat.speed}`,
      label: `Speed ${seat.speed}`,
      tone: "plain",
    });
  }
  if (seat.ring > 0) {
    marks.push({
      key: "ring",
      icon: CircleDot,
      text: `Ring ×${seat.ring}`,
      label: `Tempted by the Ring ${seat.ring === 1 ? "once" : `${seat.ring} times`}`,
      tone: "plain",
    });
  }
  if (seat.monarch) {
    marks.push({
      key: "monarch",
      icon: Crown,
      text: "Monarch",
      label: "The monarch",
      tone: "accent",
    });
  }
  if (seat.initiative) {
    marks.push({
      key: "initiative",
      icon: Castle,
      text: "Initiative",
      label: "Has the initiative",
      tone: "accent",
    });
  }
  if (seat.cityBlessing) {
    marks.push({
      key: "cityBlessing",
      icon: Landmark,
      text: "City's blessing",
      label: "Has the city's blessing",
      tone: "plain",
    });
  }
  if (seat.dungeon !== null) {
    const { name, room, roomText } = seat.dungeon;
    const words = roomText === "" ? "" : ` — ${roomText}`;
    marks.push({
      key: "dungeon",
      icon: DoorOpen,
      text: room,
      label: `In ${name}, ${room}`,
      title: `${name}: ${room}${words}`,
      tone: "plain",
    });
  }
  seat.conditions.forEach((condition, i) => {
    const { text, label } = conditionWords(condition);
    marks.push({ key: `condition-${i}`, icon: Ban, text, label, tone: "danger" });
  });
  return marks;
}

/**
 * The permanents attached to a player (`enchantedBy`: a Curse, CR 303.4), found by id on every
 * seat's battlefield — whoever controls them. An id no battlefield holds (a view between moves)
 * is left out.
 */
export function cursesOn(
  seat: Pick<PlaytestSeat, "enchantedBy">,
  view: Pick<PlaytestView, "you" | "opponents">,
): GameCard[] {
  if (seat.enchantedBy.length === 0) return [];
  const table = tableCards(view);
  return seat.enchantedBy.flatMap((id) => table.filter((c) => c.id === id));
}

/**
 * A plate's frame: `data-plate`, which the combat's arrows and the life pops find it by (the
 * player's own name, so each of a four-player table's opponents is found apart), a gold glow on
 * the plate of the player whose turn it is, and the player's marks — their poison counters when
 * they have any, and the commander damage they have been dealt (issue #1336).
 *
 * **One commander, one mark** (CR 903.10a): each commander that has dealt the player combat damage
 * has a mark of its own — its art and its count — so a pair of partners is two counts, never their
 * sum. A count at `lethal` (21, the view's `commanderDamageLethal`) turns red: the player has lost,
 * unless something says they can't (the goldfish's plate says "dead on" instead).
 *
 * **It is the player as a drop target too** (`aim`, issue #1335): a creature carried onto an
 * opponent's plate attacks them, and a spell or an ability carried onto any plate aims at that
 * player. The ring while a card it takes is over it is the click target's dashed one, solid.
 *
 * **The rest of the player's standing is beside the poison** (`standing`, {@link standingMarks}):
 * energy, experience, rad and tickets, speed, the Ring, the monarch, the initiative, the city's
 * blessing, the dungeon room — each only once the player has it — and the Curses attached to them
 * (`curses`), each a chip with its name that points at the card for the preview.
 *
 * **A revealed companion is on its owner's plate** (`companion`, CR 702.139a, issue #1744) while
 * it is outside the game: its art and name, public to every seat. On the reader's own plate, while
 * the rules offer its special action (`toHand`), the chip is a button that puts it into the hand
 * for {3} (`onCompanion`, a `companionToHand`).
 */
export function PlateFrame({
  seat,
  active,
  poison,
  commanderDamage = [],
  lethal = null,
  compact = false,
  className,
  aim,
  standing,
  curses = NO_CURSES,
  onPointCard,
  onUnpoint,
  companion = null,
  onCompanion,
  children,
}: {
  seat: PlaytestPlayer;
  active: boolean;
  poison: number;
  /** The player's counters and designations beyond poison; absent, none are drawn. */
  standing?: Standing | null;
  /** The permanents attached to the player (a Curse), resolved from `enchantedBy` ({@link cursesOn}). */
  curses?: readonly GameCard[];
  /** Point at a Curse's chip: its card in the preview. Without it the chip names it only. */
  onPointCard?: (card: GameCard, e: MouseEvent) => void;
  onUnpoint?: () => void;
  /** The player's revealed companion while it is outside the game; `null` for none. */
  companion?: PlaytestCompanion | null;
  /** Put the reader's companion into their hand: offered only while its `toHand` holds. */
  onCompanion?: () => void;
  /** The commander damage this player has been dealt, one entry a commander. */
  commanderDamage?: readonly PlaytestCommanderDamage[];
  /** The commander damage that loses the game; `null` outside a Commander game. */
  lethal?: number | null;
  compact?: boolean;
  className?: string;
  /** The player as a target a carried card is let go on (`aim.ts`): attacked, or aimed at. */
  aim?: DropAim;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const aimed = useAimTarget({ ref, aim });
  const standingShown = standing == null ? NO_MARKS : standingMarks(standing);
  const marked =
    poison > 0 ||
    commanderDamage.length > 0 ||
    standingShown.length > 0 ||
    curses.length > 0 ||
    companion !== null;
  return (
    <div
      ref={ref}
      data-plate={seat}
      data-active={active || undefined}
      className={cn(
        "relative flex items-center gap-2 transition-shadow duration-200 motion-reduce:transition-none",
        compact ? "rounded-full" : "rounded-[14px]",
        active &&
          "shadow-[0_0_0_2px_var(--color-accent),0_0_18px_color-mix(in_oklch,var(--color-accent)_45%,transparent)]",
        aimed && "outline-3 outline-offset-2 outline-accent outline-solid",
        className,
      )}
    >
      {children}
      {marked && (
        <span
          className={cn(
            "inline-flex flex-none items-center gap-1",
            !compact && "absolute -top-3 right-2",
          )}
        >
          {poison > 0 && (
            <span
              aria-label={`${poison} poison`}
              className="inline-flex flex-none items-center gap-1 rounded-full border border-mana-g bg-surface px-2 font-mono text-xs/6 font-semibold text-mana-g tabular-nums"
            >
              <Skull className="size-3.5" aria-hidden="true" />
              {poison}
            </span>
          )}
          {commanderDamage.map((c) => (
            <CommanderDamageMark key={c.id} damage={c} lethal={lethal} />
          ))}
          {standingShown.map((m) => (
            <span
              key={m.key}
              data-standing={m.key}
              aria-label={m.label}
              title={m.title ?? m.label}
              className={cn(
                "inline-flex max-w-[160px] flex-none items-center gap-1 rounded-full border bg-surface px-2 text-xs/6 font-semibold whitespace-nowrap tabular-nums",
                m.tone === "accent"
                  ? "border-accent text-accent"
                  : m.tone === "danger"
                    ? "border-destructive text-destructive"
                    : "border-border text-text",
              )}
            >
              <m.icon className="size-3.5 flex-none" aria-hidden="true" />
              <span aria-hidden="true" className="min-w-0 truncate">
                {m.text}
              </span>
            </span>
          ))}
          {curses.map((c) => (
            <span
              key={c.id}
              data-curse={c.id}
              data-point={c.id}
              aria-label={`Attached: ${shownName(c)}`}
              title={shownName(c)}
              onMouseEnter={onPointCard === undefined ? undefined : (e) => onPointCard(c, e)}
              onMouseLeave={onUnpoint}
              className="inline-flex max-w-[140px] flex-none cursor-default items-center rounded-full border border-border bg-surface px-2 text-xs/6 whitespace-nowrap text-text"
            >
              <span aria-hidden="true" className="min-w-0 truncate">
                {shownName(c)}
              </span>
            </span>
          ))}
          {companion !== null && <CompanionMark companion={companion} onToHand={onCompanion} />}
        </span>
      )}
    </div>
  );
}

/** One commander's damage to the plate's player: its art (a crown for a face-down one) and the
 *  count, red at `lethal`. */
function CommanderDamageMark({
  damage,
  lethal,
}: {
  damage: PlaytestCommanderDamage;
  lethal: number | null;
}): JSX.Element {
  const dead = lethal !== null && damage.damage >= lethal;
  const name = damage.name === "" ? "A face-down commander" : damage.name;
  const of = lethal === null ? "" : ` of ${lethal}`;
  return (
    <span
      data-commander-damage={damage.id}
      data-lethal={dead || undefined}
      aria-label={`${damage.damage} commander damage from ${name}${dead ? ", lethal" : ""}`}
      title={`${name}: ${damage.damage}${of} commander damage`}
      className={cn(
        "inline-flex flex-none items-center gap-1 rounded-full border bg-surface py-px pr-2 pl-px font-mono text-xs/5 font-semibold tabular-nums",
        dead ? "border-destructive text-destructive" : "border-border text-text",
      )}
    >
      {damage.cardId !== null ? (
        <span
          aria-hidden="true"
          className="size-5 flex-none overflow-hidden rounded-full border border-border"
        >
          <CardImage
            src={cardImageUrl(damage.cardId, 0, "art")}
            alt=""
            className="block h-full w-full object-cover"
          />
        </span>
      ) : (
        <Crown className="ml-1 size-3.5" aria-hidden="true" />
      )}
      {damage.damage}
    </span>
  );
}

/** A revealed companion outside the game: its art and name, and — while the rules offer it and
 *  the board can act — a press that puts it into the hand for {3}. */
function CompanionMark({
  companion,
  onToHand,
}: {
  companion: PlaytestCompanion;
  onToHand?: () => void;
}): JSX.Element {
  const art =
    companion.cardId !== null ? (
      <span
        aria-hidden="true"
        className="size-5 flex-none overflow-hidden rounded-full border border-border"
      >
        <CardImage
          src={cardImageUrl(companion.cardId, 0, "art")}
          alt=""
          className="block h-full w-full object-cover"
        />
      </span>
    ) : null;
  const chip =
    "inline-flex max-w-[200px] flex-none items-center gap-1 rounded-full border bg-surface py-px pr-2 pl-px text-xs/5 whitespace-nowrap";
  if (companion.toHand && onToHand !== undefined) {
    return (
      <button
        type="button"
        data-companion="to-hand"
        aria-label={`Put ${companion.name}, your companion, into your hand for {3}`}
        title={`${companion.name} — put into your hand for {3}`}
        onClick={onToHand}
        className={cn(chip, "cursor-pointer border-accent font-semibold text-accent")}
      >
        {art}
        <span className="min-w-0 truncate">To hand · {companion.name}</span>
      </button>
    );
  }
  return (
    <span
      data-companion="revealed"
      aria-label={`Companion: ${companion.name}`}
      title={`Companion: ${companion.name}`}
      className={cn(chip, "border-border text-text", companion.cardId === null && "pl-2")}
    >
      {art}
      <span aria-hidden="true" className="min-w-0 truncate">
        {companion.name}
      </span>
    </span>
  );
}

const NO_CURSES: readonly GameCard[] = [];
const NO_MARKS: readonly StandingMark[] = [];
