import { LayoutGrid, Rows3 } from "lucide-react";
import { MANA_KEYS, MANA_LABEL, manaSymbolClass, type ManaKey } from "@/lib/mana";
import { useAppStore, type SearchView } from "@/lib/store";
import { cn } from "@/lib/utils";
import { SetCombobox } from "./SetCombobox";
import { FORMATS, MANA_VALUES, type CardSearch } from "./useCardSearch";

/**
 * Keyboard focus, everywhere in the row.
 *
 * Gold says "interactive emphasis" for both focus and on, so the two are told apart by
 * *shape* rather than by hue: focus is always an `outline`, standing off the control's
 * edge; on is always the control's own border or a ring hugging it. A chip that is both
 * shows both, which is the one case where either alone would be a lie.
 */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** Every control in the row is 36px tall, so the chips and the text controls share a line. */
const CONTROL =
  "h-9 rounded-md border text-sm transition-colors duration-150 motion-reduce:transition-none";

/**
 * Every filter the search view offers, in one row.
 *
 * The colour chips are the app's one deliberate splash of colour and the reason the rest
 * of the chrome stays grey: a real mana symbol on its authentic printed fill is
 * recognisable at 36px to anyone who has held a card, in a way that a letter in a coloured
 * circle is not. Everything else here is quiet on purpose — outlined, mono, grey — so that
 * the one thing the eye lands on is which colours are switched on.
 */
export function FilterBar({ search }: { search: CardSearch }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="card-search-text" className="sr-only">
        Search cards
      </label>
      <input
        id="card-search-text"
        type="search"
        value={search.text}
        onChange={(e) => search.setText(e.target.value)}
        placeholder="Search cards…"
        className={cn(
          CONTROL,
          FOCUS,
          "min-w-56 flex-1 border-border bg-surface px-3 placeholder:text-muted focus:border-accent",
        )}
      />

      {/* Wider than the other groups' `gap-1`: a pressed chip's ring reaches 4px past its
          edge, and at 4px apart two pressed chips look like one welded object. */}
      <div role="group" aria-label="Color identity" className="flex gap-1.5">
        {MANA_KEYS.map((key) => (
          <ManaChip
            key={key}
            symbol={key}
            pressed={search.colors.includes(key)}
            onClick={() => search.toggleColor(key)}
          />
        ))}
      </div>

      <div role="group" aria-label="Mana value" className="flex gap-1">
        {MANA_VALUES.map((value) => {
          // The last chip is open-ended: past Emrakul the tail is a handful of cards
          // nobody filters by exact cost, and the backend reads it the same way.
          const open = value === MANA_VALUES[MANA_VALUES.length - 1];
          const on = search.manaValues.includes(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => search.toggleManaValue(value)}
              aria-pressed={on}
              aria-label={open ? `Mana value ${value} or more` : `Mana value ${value}`}
              className={cn(
                CONTROL,
                FOCUS,
                "size-9 font-mono text-xs tabular-nums",
                on ? "border-accent text-accent" : "border-border text-muted hover:text-text",
              )}
            >
              {open ? `${value}+` : value}
            </button>
          );
        })}
      </div>

      <SetCombobox selected={search.sets} onToggle={search.toggleSet} />

      <label htmlFor="card-search-format" className="sr-only">
        Format
      </label>
      <select
        id="card-search-format"
        value={search.format}
        onChange={(e) => search.setFormat(e.target.value)}
        className={cn(
          CONTROL,
          FOCUS,
          "bg-surface px-2",
          search.format ? "border-accent text-accent" : "border-border text-muted",
        )}
      >
        <option value="">Any format</option>
        {FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      {/* Only when there is something to clear. A control that spends most of its life
          disabled teaches the reader to stop looking at it. */}
      {search.activeCount > 0 && (
        <button
          type="button"
          onClick={search.resetAll}
          className={cn(
            CONTROL,
            FOCUS,
            "inline-flex items-center gap-2 border-border px-2.5 text-muted hover:text-text",
          )}
        >
          Reset all
          <span className="rounded-full bg-accent px-1.5 font-mono text-[0.7rem] leading-4 text-accent-foreground">
            {search.activeCount}
          </span>
        </button>
      )}

      <ViewToggle />
    </div>
  );
}

/** The two layouts, and the words for them a reader would use. */
const LAYOUTS = [
  { id: "grid", label: "Card view", Icon: LayoutGrid },
  { id: "table", label: "Table view", Icon: Rows3 },
] as const satisfies readonly { id: SearchView; label: string; Icon: typeof LayoutGrid }[];

/**
 * How the results are drawn — art, or a table.
 *
 * Not a filter, and it rides the filter row anyway: it is the only other control that
 * governs the list below, and a second row holding one pair of buttons would be a whole
 * band of chrome above the art. `ml-auto` sends it to the far end so the filters still
 * read as a group without it, and the pair is icon-only because two 36px squares carry
 * "grid or rows" at a glance in a way two words on a busy row do not.
 */
function ViewToggle() {
  const view = useAppStore((s) => s.searchView);
  const setSearchView = useAppStore((s) => s.setSearchView);

  return (
    <div role="group" aria-label="Result layout" className="ml-auto flex gap-1">
      {LAYOUTS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => setSearchView(id)}
          aria-pressed={view === id}
          aria-label={label}
          title={label}
          className={cn(
            CONTROL,
            FOCUS,
            "size-9",
            view === id ? "border-accent text-accent" : "border-border text-muted hover:text-text",
          )}
        >
          <Icon className="mx-auto size-4" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/**
 * One colour chip: the printed symbol, on the printed fill.
 *
 * Pressed is the card's own colour at full strength with a gold ring; unpressed is the
 * same chip dimmed rather than a different chip, so the row reads as one control with
 * some of it switched on — and so a colourblind reader has the symbol's *shape*, which is
 * what Wizards designed it to carry, and not only the hue.
 */
function ManaChip({
  symbol,
  pressed,
  onClick,
}: {
  symbol: ManaKey;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={MANA_LABEL[symbol]}
      title={MANA_LABEL[symbol]}
      style={{ backgroundColor: `var(--color-mana-${symbol.toLowerCase()})` }}
      className={cn(
        "grid size-9 place-items-center rounded-full text-lg leading-none text-black",
        "transition-[opacity,box-shadow] duration-150 motion-reduce:transition-none",
        // Clear of the pressed ring, so a focused chip that is already on shows both.
        "focus-visible:outline-2 focus-visible:outline-offset-[5px] focus-visible:outline-accent",
        // 60%, not 40: below about half, the fills stop being cream/sky/bone/salmon/sage
        // and become six shades of the same brown, which is the moment the row goes back
        // to being letters in circles. The gold ring is what says "on"; the dimming only
        // has to say "and these are not".
        pressed
          ? "opacity-100 ring-2 ring-accent ring-offset-2 ring-offset-bg"
          : "opacity-60 hover:opacity-85",
      )}
    >
      {/* The glyph itself comes from the bundled `mana-font`; the fill is ours, because
          the font's own `--ms-mana-*` values are a shade off the direction doc's. */}
      <i className={manaSymbolClass(symbol)} aria-hidden="true" />
    </button>
  );
}
