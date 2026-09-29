import { useEffect, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { FILTER_CONTROL, ToggleChip } from "@/components/FilterChips";
import { FOCUS_INSET } from "@/lib/focus";
import type { ArtWeightFloor, TagNamespace } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { TAG_NAMESPACE_LABEL, TagNamespaceMark } from "./namespaces";
import { chipKey, type TagChip, type TagSelection } from "./tagFilters";

/**
 * What the reader has picked, and the one control that modifies it.
 *
 * **A chip says its taxonomy, always.** The two are separate files with separate id spaces that
 * share plenty of slugs, so a row holding two chips both reading "Forest" would be two controls
 * a reader cannot tell apart — which is the same fact `chipKey` exists for one floor down. The
 * rail only marks the namespace in `"both"` mode, because there a column of identical marks is
 * noise; a chip is a lasting statement about a query and outlives whatever the box was set to.
 */

/**
 * The weight control's label — and it must never say "strong matches only".
 *
 * The spec and the plan both called it that and both were wrong. The predicate behind it is
 * `ati.weight <> 'weak'`, so it admits `median` — Scryfall's word for "a normal tagging with no
 * special weight applied", 462 008 of 475 163 art taggings (measured 2026-08-20). It does not
 * narrow to strong matches; it drops what Scryfall defines as `weak`: "the subject is a minor
 * detail or background element". The words say that and nothing more.
 *
 * The wire field stays `artWeightFloor: "any" | "strong"`, which is honest about being a floor.
 * Only the visible words changed.
 *
 * Exported so a story, a test and the page all quote the one string rather than three copies of
 * a sentence that has already been got wrong once.
 */
export const HIDE_BACKGROUND_LABEL = "Hide background details";

/** What the control does, for its tooltip — Scryfall's own definition of the rows it drops. */
const HIDE_BACKGROUND_HINT =
  "drops taggings Scryfall marked as a minor detail or background element";

/** Why it cannot be pressed, with it off. See {@link TagChipsProps.onFloorChange}. */
const HIDE_BACKGROUND_IDLE = "nothing to hide until an art tag is picked";

/**
 * Why it cannot be pressed, with it **on** — the state the row can genuinely be handed.
 *
 * Pick an art tag, press this, then remove that chip: `selection.floor` is still `"strong"` while
 * there is no longer an art include for it to narrow, so the chip is on *and* out of reach.
 * `filterChipState` draws that pair as "on, and out of reach" rather than letting one silently
 * win, and this is the sentence that says the same thing — a chip that read
 * {@link HIDE_BACKGROUND_IDLE} while lit would be telling the reader their setting was off.
 * The page owns whether the state can arise; the chip owns being honest about the one it is given.
 */
const HIDE_BACKGROUND_LATENT = "on, and narrowing nothing until an art tag is picked";

export interface TagChipsProps {
  selection: TagSelection;
  onRemove: (slug: string, namespace: TagNamespace) => void;
  onToggleMode: (slug: string, namespace: TagNamespace) => void;
  /**
   * Move the art weight floor — **and what decides the control is drawn at all.**
   *
   * A control with nothing to report is worse than one a row does not offer, so the two cannot
   * come apart; `ManaValueChips`' X chip is wired the same way for the same reason. A page that
   * leaves it off gets exactly the chips.
   *
   * The floor applies to the art side's *include* half alone — `oracle_tag_cards` carries no
   * `weight` column, and a floor on an exclude would let weak forests back into a result the
   * reader asked to have none in — so with no art include there is nothing for it to narrow and
   * it greys rather than disappearing. An option that vanishes reads as a control that broke.
   */
  onFloorChange?: (floor: ArtWeightFloor) => void;
  /**
   * What the group of chips is called — and it has to be settable, because the Tags page can
   * draw **two** of these rows at once: the tags picked off its rail, and the tags typed into
   * the search box above it (`TagQueryRow`). Two groups both announced "Picked tags" would be
   * two controls a screen reader cannot tell apart, which is `chipKey`'s own argument one
   * floor up.
   */
  ariaLabel?: string;
  /**
   * What to say when nothing is picked. `null` draws nothing at all, which is what a row that
   * only appears once the reader has typed a tag wants — the Tags page's invitation would read
   * as an instruction the search box cannot carry out.
   */
  emptyMessage?: string | null;
  /**
   * **Draw the chips as one line that scrolls sideways, and never as a second row** — the filter
   * quick bar's `lead` (spec 2026-09-29 §5), where the Tags page docks its picked tags beside the
   * folded filters.
   *
   * The bar is a fixed 53px strip, so the page row's `flex-wrap` has nowhere to go there: a third
   * tag would either spill out of the bar or grow it, and a docked bar that changes height moves
   * every sticky thing measured against it. So the row does not wrap, it **scrolls on its own x
   * axis** with the scrollbar hidden (a trackpad or Shift+wheel reaches the rest, and so does Tab,
   * which scrolls a focused chip into view), and it is **capped at `min(28rem, 32%)`** of the bar
   * so a reader with many tags picked still has the search box and the colours beside them. It
   * `shrink`s below that cap before anything else on the bar has to, which is what lets the
   * mana values stay inline one rung longer than the chips would otherwise allow.
   *
   * The empty sentence goes to `text-xs whitespace-nowrap` with it: the bar's controls are
   * `text-xs`, and a `text-sm` invitation wrapping to two lines inside a 53px strip is the one
   * thing this prop exists to prevent.
   *
   * Unset, nothing changes — the page row still wraps, which is the right answer for a row with
   * the whole page's width under it.
   */
  singleLine?: boolean;
}

export function TagChips({
  selection,
  onRemove,
  onToggleMode,
  onFloorChange,
  ariaLabel = "Picked tags",
  emptyMessage = "No tags selected. Pick one from the list to filter cards.",
  singleLine = false,
}: TagChipsProps) {
  const row = useRef<HTMLDivElement>(null);
  /**
   * The chip the caret should land on once the one it was standing on has gone.
   *
   * A ref rather than state, because it must not cause a render of its own — and read in an
   * effect rather than in the handler, because the button being focused does not exist until the
   * page has re-rendered without the removed chip. Left alone the reader is dropped on `<body>`
   * and their next Tab restarts at the top of the app, which is the same failure a context-menu
   * opener with no `tabIndex` has.
   */
  const caretTo = useRef<string | null>(null);

  // No dependency list: the ref is the guard, and the render this needs to run after is
  // whichever one the parent does with the chip gone. Nothing here sets state, so this is not
  // the reflexive derived-state sync that `react-hooks` refuses.
  useEffect(() => {
    const key = caretTo.current;
    if (key === null) return;
    caretTo.current = null;
    const buttons = row.current?.querySelectorAll<HTMLButtonElement>("[data-remove-key]") ?? [];
    // Matched on the dataset rather than through a selector, so a slug carrying a character CSS
    // would need escaped cannot silently match nothing.
    for (const button of buttons) {
      if (button.dataset.removeKey === key) {
        button.focus();
        return;
      }
    }
  });

  const chips = selection.chips;

  /**
   * **The one-line row says when it is hiding something, and only then.** It scrolls with its
   * scrollbar hidden, so a chip past the cap is cut off at the row's edge with no cue that there is
   * more to reach. `StatedFiltersLine` answers the same problem with a right-edge fade — but that
   * line is always as wide as its box, and this row **shrinks to its chips**, so an unconditional
   * fade would dim the last chip of a row with nothing hidden at all. So the fade is keyed on
   * `data-overflow` (the class string below), and this sets it from `scrollWidth > clientWidth`.
   *
   * Written onto the element rather than held in state: it is a fact about layout that only the
   * stylesheet reads, and a `setState` here would be a render per resize for no output React draws.
   * Checked on three occasions — now, whenever the chips change (a row already at its width cap
   * does not *resize* when a chip is added, only its content grows, so the row's observer would
   * say nothing), and whenever the row or the group inside it resizes (the bar narrowing with the
   * window). The page row wraps and never overflows sideways, so it is never watched.
   */
  useLayoutEffect(() => {
    const el = row.current;
    if (!singleLine || !el) return;
    const check = () => el.toggleAttribute("data-overflow", el.scrollWidth > el.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    const group = el.firstElementChild;
    if (group) observer.observe(group);
    return () => {
      observer.disconnect();
      el.removeAttribute("data-overflow");
    };
  }, [singleLine, chips]);

  // The floor narrows the art *includes* and nothing else, so this is exactly the condition
  // under which the control can change a single row.
  const canFloor = chips.some((c) => c.namespace === "art" && c.mode === "include");

  const floorOn = selection.floor === "strong";

  return (
    // The row, and inside it the group. **The weight control is not a picked tag**, so it sits
    // outside the `role="group"` that names them — a group whose label promises the reader a
    // list of their tags must not also contain a switch.
    //
    // Both boxes change together under `singleLine` (see the prop): the row is what scrolls and
    // carries the cap, and the group inside it must stop wrapping too, or the row would scroll a
    // group that had already folded itself onto a second line. The row is `relative` because it
    // is a scroll container (`src/CLAUDE.md`), and it fades its right edge only while the effect
    // above has marked it `data-overflow` — the variant written whole, since Tailwind reads
    // source text and an assembled class emits no rule.
    <div
      ref={row}
      className={
        singleLine
          ? "relative flex min-w-0 max-w-[min(28rem,32%)] shrink flex-nowrap items-center gap-1.5 overflow-x-auto [scrollbar-width:none] data-[overflow]:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]"
          : "flex flex-wrap items-center gap-1.5"
      }
    >
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn(
          "flex items-center gap-1.5",
          singleLine ? "flex-nowrap" : "flex-wrap",
        )}
      >
        {chips.length === 0 ? (
          // An empty row is an invitation rather than a blank: the Tags page's whole gesture is
          // picking a motif, and nothing else on screen says where from. A caller with no such
          // gesture to name passes `null` and gets a row that simply is not there.
          emptyMessage && (
            <p
              className={
                singleLine ? "text-xs whitespace-nowrap text-dim" : "text-sm text-dim"
              }
            >
              {emptyMessage}
            </p>
          )
        ) : (
          chips.map((chip, i) => (
            <PickedChip
              key={chipKey(chip.namespace, chip.slug)}
              chip={chip}
              onToggleMode={() => onToggleMode(chip.slug, chip.namespace)}
              onRemove={() => {
                // The one after it, or the one before it when this was the last. Noted before
                // the write, because `selection` is the parent's and is already the old list by
                // the time the effect above runs.
                const next = chips[i + 1] ?? chips[i - 1];
                caretTo.current = next ? chipKey(next.namespace, next.slug) : null;
                onRemove(chip.slug, chip.namespace);
              }}
            />
          ))
        )}
      </div>

      {onFloorChange && (
        <ToggleChip
          label={HIDE_BACKGROUND_LABEL}
          pressed={floorOn}
          disabled={!canFloor}
          // `title` is the tooltip and the accessible name together, so the visible label has to
          // lead it (WCAG 2.5.3) — and neither out-of-reach state leaves a dim chip with no
          // explanation anywhere. Three sentences rather than two, because on-and-greyed is a
          // state the row can really be handed: see {@link HIDE_BACKGROUND_LATENT}.
          title={`${HIDE_BACKGROUND_LABEL} — ${
            canFloor
              ? HIDE_BACKGROUND_HINT
              : floorOn
                ? HIDE_BACKGROUND_LATENT
                : HIDE_BACKGROUND_IDLE
          }`}
          onClick={() => onFloorChange(floorOn ? "any" : "strong")}
        />
      )}
    </div>
  );
}

/**
 * One picked tag: its taxonomy, its label, and the way out.
 *
 * **Include and exclude are told apart by the word `not` and by a dashed edge, not by hue.**
 * Gold already means "on" everywhere in this app and the direction's colour budget is spent on
 * the mana line and the card art; a red chip would also read as an error, which an exclusion is
 * not. `not Forest` is legible to a reader who cannot tell the two borders apart at all.
 */
function PickedChip({
  chip,
  onToggleMode,
  onRemove,
}: {
  chip: TagChip;
  onToggleMode: () => void;
  onRemove: () => void;
}) {
  const excluded = chip.mode === "exclude";
  const shown = excluded ? `not ${chip.label}` : chip.label;
  const namespaceWord = TAG_NAMESPACE_LABEL[chip.namespace].toLowerCase();
  const state = excluded
    ? `${shown}, ${namespaceWord} tag, excluded. Click to include.`
    : `${shown}, ${namespaceWord} tag, included. Click to exclude.`;

  return (
    <span
      className={cn(
        FILTER_CONTROL,
        "inline-flex items-center overflow-hidden",
        excluded ? "border-dashed border-dim" : "border-accent",
        // The recipe's press belongs to the two buttons inside rather than to this box, which is
        // not itself pressable.
        "active:scale-100",
      )}
    >
      <button
        type="button"
        onClick={onToggleMode}
        aria-label={state}
        className={cn(
          "flex h-full items-center gap-1.5 pl-2.5 pr-1.5",
          PRESS,
          // **Inset, because this button fills a clipped box.** The chip is
          // `overflow-hidden` so its two halves keep the pill's corners, and `FOCUS` stands 4px
          // proud of the border box — which is entirely inside the clipped region here, i.e. no
          // focus indicator at all and a WCAG 2.4.7 failure invisible to anyone using a mouse.
          FOCUS_INSET,
          excluded ? "text-dim hover:text-text" : "text-accent",
        )}
      >
        <TagNamespaceMark namespace={chip.namespace} />
        <span className="max-w-48 truncate text-sm">{shown}</span>
      </button>
      <button
        type="button"
        // How the effect in `TagChips` finds this button again after its neighbour has gone.
        data-remove-key={chipKey(chip.namespace, chip.slug)}
        onClick={onRemove}
        // The label, not the visible ×, and the taxonomy with it: two chips sharing a slug would
        // otherwise be two buttons with one name.
        aria-label={`Remove ${chip.label}, ${namespaceWord} tag`}
        className={cn(
          "grid h-full w-7 flex-none place-items-center text-dim hover:text-text",
          PRESS,
          // Inset for the same reason as its neighbour above.
          FOCUS_INSET,
        )}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}
