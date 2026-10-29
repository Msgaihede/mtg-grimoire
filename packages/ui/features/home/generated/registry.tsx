/**
 * **The catalogue, drawn with this app's own components** — json-render's registry for
 * `./catalog.ts`.
 *
 * Every name in the catalogue maps onto the component a hand-written widget uses for the same
 * job: `Figures` is `WidgetFigures`, `Row` is `WidgetRow`, `CardTile` is `CardTile`, `Price` is
 * `formatPrice` at the reader's marketplace. So a generated widget wears the app's tokens, sizes
 * and press feedback, and a change to a part changes every widget built from it. `defineRegistry`
 * types each entry against its catalogue props, so a prop renamed on one side is a compile error
 * on the other.
 *
 * **The parts that measure their box read it from {@link CatalogFitContext}** — the widget card's
 * `WidgetFit`, which a custom widget's body provides exactly as every other widget is handed it.
 * Outside a widget (a story, a test) it is a medium card's.
 *
 * **Actions navigate through the store's own hand-offs**, in the order the hand-written widgets
 * use them (`setActiveView` before a one-shot like `setOpenDeckId`, whose comments say why). None
 * writes the reader's data: the graph a widget reads is read-only, and so is the widget.
 */
import { createContext, useContext, useMemo, type ReactElement } from "react";
import { getByPath, type StateModel } from "@json-render/core";
import { defineRegistry, useBoundProp, type ComponentContext } from "@json-render/react";
import { CardArt } from "@/components/CardArt";
import { CardTile } from "@/components/CardTile";
import { CountTag } from "@/components/CountTag";
import { Dropdown, MultiDropdown } from "@/components/Dropdown/Dropdown";
import { ToggleChip as FilterToggleChip } from "@/components/FilterChips";
import { GameChangerMark } from "@/components/GameChangerMark";
import { OwnedBadge } from "@/components/OwnedBadge";
import { PriceRange as PriceRangeControl } from "@/components/PriceRange";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { BarChart, StatsCard } from "@/features/decks/stats/StatsCard";
import { histogram } from "@/features/draft/booster/value";
import { ValueHistogram } from "@/features/draft/packs/ValueHistogram";
import { Segmented as SegmentedControl } from "@/features/draft/setup/parts";
import { ModeRadios } from "@/features/transfer/import/shared/ModeRadios";
import { FinishMark } from "@/components/FinishMark";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { BUTTON, SWITCH, TOUCH_FIELD, switchTone } from "@/features/settings/controls";
import { setGlyphClass } from "@/lib/keyrune";
import type { Currency } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { makeFit, type WidgetFit } from "../fit";
import { PriceChart } from "../priceHistory/PriceChart";
import {
  DOWN_FILL,
  UP_FILL,
  WidgetBars,
  WidgetFigures,
  WidgetFooterLine,
  WidgetMessage,
  WidgetRow,
  WidgetRowList,
} from "../WidgetParts";
import { catalog, type Catalog } from "./catalog";

/** A medium card's fit — what the parts measure against outside a widget card. */
const OUTSIDE_A_CARD: WidgetFit = makeFit({
  w: 4,
  h: 3,
  widthPx: 480,
  heightPx: 300,
  density: "comfortable",
});

/** The box the measured parts (`Figures`, `Bars`, `RowList`) fit themselves to. */
export const CatalogFitContext = createContext<WidgetFit>(OUTSIDE_A_CARD);

/** The palette words a spec may colour with, as the CSS the parts take. */
const PAINT: Record<string, string> = {
  accent: "var(--color-accent)",
  up: UP_FILL,
  down: DOWN_FILL,
  dim: "var(--color-dim)",
  W: "var(--color-mana-w)",
  U: "var(--color-mana-u)",
  B: "var(--color-mana-b)",
  R: "var(--color-mana-r)",
  G: "var(--color-mana-g)",
  C: "var(--color-mana-c)",
};

const GAP: Record<string, string> = { none: "gap-0", sm: "gap-1.5", md: "gap-3", lg: "gap-5" };

const TONE: Record<string, string> = {
  default: "text-text",
  dim: "text-dim",
  accent: "text-accent",
  up: "text-[var(--color-mana-g)]",
  down: "text-destructive",
  destructive: "text-destructive",
};

const TEXT_SIZE: Record<string, string> = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
};

/** A card picture's width at each size — the 5:7 frame is `CardArt`'s own. */
const ART_WIDTH: Record<string, string> = { sm: "w-16", md: "w-28", lg: "w-44" };

const SYMBOL_SIZE: Record<string, string> = { sm: "text-base", md: "text-2xl", lg: "text-4xl" };

/** The reader's currency, for every part that writes money. */
function useCurrency(): Currency {
  return useMarketplace().currency;
}

/** A figure or a row's value: money at the reader's currency, or as it was given. */
function valueText(value: number | string | null, money: boolean | null, currency: Currency) {
  if (value === null) return undefined;
  if (typeof value === "number" && money) return formatPrice(value, currency);
  return typeof value === "number" ? value.toLocaleString() : value;
}

/** A pressable part's handler, only when the spec bound its `press` event — an unbound part
 *  stays a picture rather than a button that does nothing. */
function pressOf(ctx: { on: ComponentContext<Catalog, "Row">["on"] }) {
  const press = ctx.on("press");
  return press.bound ? press.emit : undefined;
}

function Figures({ props }: ComponentContext<Catalog, "Figures">): ReactElement {
  const fit = useContext(CatalogFitContext);
  const currency = useCurrency();
  return (
    <WidgetFigures
      fit={fit}
      fill={props.fill ?? false}
      divided={props.divided ?? false}
      figures={props.figures.map((f, i) => ({
        key: `${i}:${f.label}`,
        label: f.label,
        value: valueText(f.value, f.money, currency) ?? "—",
        note: f.note ?? undefined,
        tone: f.money ? "accent" : "text",
      }))}
    />
  );
}

function Bars({ props }: ComponentContext<Catalog, "Bars">): ReactElement {
  const fit = useContext(CatalogFitContext);
  const currency = useCurrency();
  const top = Math.max(0, ...props.bars.map((b) => b.value));
  return (
    <WidgetBars
      fit={fit}
      fill={props.fill ?? false}
      bars={props.bars.map((b, i) => {
        const value = valueText(b.value, props.money, currency) ?? "";
        return {
          key: `${i}:${b.label}`,
          label: b.label,
          value,
          share: top > 0 ? Math.max(0, b.value) / top : 0,
          fill: PAINT[b.color ?? "accent"],
          said: `${b.label}: ${value}`,
        };
      })}
    />
  );
}

function RowList({ props, children }: ComponentContext<Catalog, "RowList">): ReactElement {
  const fit = useContext(CatalogFitContext);
  return (
    <WidgetRowList fit={fit} label={props.label ?? undefined}>
      {children}
    </WidgetRowList>
  );
}

function Row(ctx: ComponentContext<Catalog, "Row">): ReactElement {
  const { props } = ctx;
  const currency = useCurrency();
  const icon = props.rarity ? (
    <RarityGem rarity={props.rarity} />
  ) : props.setCode ? (
    <i aria-hidden="true" className={setGlyphClass(props.setCode)} />
  ) : undefined;
  return (
    <WidgetRow
      name={props.name}
      caption={props.caption ?? undefined}
      value={valueText(props.value, props.money, currency)}
      delta={props.delta ?? undefined}
      icon={icon}
      track={props.track ?? undefined}
      onPress={pressOf(ctx)}
      pressLabel={props.name}
    />
  );
}

function Price({ props }: ComponentContext<Catalog, "Price">): ReactElement {
  const currency = useCurrency();
  return (
    <span className={cn("font-mono tabular-nums", TONE[props.tone ?? "accent"])}>
      {formatPrice(props.value, currency)}
    </span>
  );
}

function Chart({ props }: ComponentContext<Catalog, "PriceChart">): ReactElement {
  const currency = useCurrency();
  const points = useMemo(
    () => props.points.map((p) => ({ day: p.day, price: p.value, live: false })),
    [props.points],
  );
  return <PriceChart points={points} currency={currency} summary={props.summary} />;
}

function Tile(ctx: ComponentContext<Catalog, "CardTile">): ReactElement {
  const { props } = ctx;
  const currency = useCurrency();
  return (
    <CardTile
      cardId={props.cardId}
      name={props.name}
      rarity={props.rarity}
      finish={props.finish}
      chin={{ setCode: props.setCode, collectorNumber: props.collectorNumber }}
      money={props.price === null ? undefined : formatPrice(props.price, currency)}
      onPress={pressOf(ctx)}
      pressLabel={props.name}
    />
  );
}

function TextInput({ props, bindings }: ComponentContext<Catalog, "TextInput">): ReactElement {
  const [value, setValue] = useBoundProp<string>(props.value ?? undefined, bindings?.value);
  return (
    <input
      type="text"
      aria-label={props.label}
      placeholder={props.placeholder ?? undefined}
      value={value ?? ""}
      onChange={(e) => setValue(e.target.value)}
      className={cn(
        "h-8 min-w-0 rounded-md border border-border bg-transparent px-2.5 text-sm text-text",
        "placeholder:text-dim caret-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        TOUCH_FIELD,
      )}
    />
  );
}

function Select({ props, bindings }: ComponentContext<Catalog, "Select">): ReactElement {
  const [value, setValue] = useBoundProp<string>(props.value ?? undefined, bindings?.value);
  return (
    <Dropdown label={props.label} options={props.options} value={value ?? ""} onChange={setValue} />
  );
}

function Switch({ props, bindings }: ComponentContext<Catalog, "Switch">): ReactElement {
  const [checked, setChecked] = useBoundProp<boolean>(
    props.checked ?? undefined,
    bindings?.checked,
  );
  const on = checked ?? false;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={props.label}
      onClick={() => setChecked(!on)}
      className={cn(SWITCH, switchTone(on))}
    >
      {props.label}
    </button>
  );
}

/** The bins a price histogram is drawn in: enough for a shape, few enough that each is a bar. */
const HISTOGRAM_BINS = 24;

function Hint({ props, children }: ComponentContext<Catalog, "Hint">): ReactElement {
  const tip = useTooltip();
  return (
    <span className="inline-flex min-w-0" {...tip(props.text)}>
      {children}
    </span>
  );
}

function Columns({ props }: ComponentContext<Catalog, "ColumnChart">): ReactElement {
  const max = Math.max(1, ...props.columns.map((c) => c.count));
  return (
    <BarChart
      bars={props.columns.map((c, i) => ({
        key: `${i}:${c.label}`,
        label: c.label,
        count: c.count,
        said: c.said,
      }))}
      max={max}
      height={props.height ?? 120}
      fill={PAINT[props.color ?? "accent"]}
      variant={props.mana ? "mana" : "default"}
    />
  );
}

function Histogram({ props }: ComponentContext<Catalog, "PriceHistogram">): ReactElement | null {
  const currency = useCurrency();
  const bins = useMemo(
    () => histogram(Float64Array.from(props.values).sort(), HISTOGRAM_BINS),
    [props.values],
  );
  return (
    <ValueHistogram
      bins={bins}
      marked={props.marked}
      markedLabel={props.markedLabel ?? ""}
      paid={null}
      currency={currency}
      unit={props.unit}
      summary={props.summary}
    />
  );
}

function Combobox({ props, bindings }: ComponentContext<Catalog, "Combobox">): ReactElement {
  const [value, setValue] = useBoundProp<string>(props.value ?? undefined, bindings?.value);
  return (
    <Dropdown
      searchable
      label={props.label}
      options={props.options}
      value={value ?? ""}
      placeholder={props.placeholder ?? undefined}
      onChange={setValue}
    />
  );
}

function MultiSelect({ props, bindings }: ComponentContext<Catalog, "MultiSelect">): ReactElement {
  const [selected, setSelected] = useBoundProp<string[]>(
    props.selected ?? undefined,
    bindings?.selected,
  );
  const picked = selected ?? [];
  return (
    <MultiDropdown
      label={props.label}
      options={props.options}
      selected={picked}
      triggerLabel={props.triggerLabel}
      onToggle={(v) =>
        setSelected(picked.includes(v) ? picked.filter((p) => p !== v) : [...picked, v])
      }
    />
  );
}

function Segmented({ props, bindings }: ComponentContext<Catalog, "Segmented">): ReactElement {
  const [value, setValue] = useBoundProp<string>(props.value ?? undefined, bindings?.value);
  return (
    <SegmentedControl
      label={props.label}
      options={props.options.map((o) => ({ id: o.value, label: o.label }))}
      value={value ?? ""}
      onPick={setValue}
    />
  );
}

function RadioGroup({ props, bindings }: ComponentContext<Catalog, "RadioGroup">): ReactElement {
  const [value, setValue] = useBoundProp<string>(props.value ?? undefined, bindings?.value);
  return (
    <ModeRadios
      label={props.label}
      modes={props.options.map((o) => ({ key: o.value, label: o.label, hint: o.hint ?? "" }))}
      value={value ?? ""}
      onChange={setValue}
    />
  );
}

function ToggleChip({ props, bindings }: ComponentContext<Catalog, "ToggleChip">): ReactElement {
  const [pressed, setPressed] = useBoundProp<boolean>(
    props.pressed ?? undefined,
    bindings?.pressed,
  );
  const on = pressed ?? false;
  return (
    <FilterToggleChip
      label={props.label}
      hint={props.hint ?? undefined}
      pressed={on}
      onClick={() => setPressed(!on)}
    />
  );
}

function NumberStepper({
  props,
  bindings,
}: ComponentContext<Catalog, "NumberStepper">): ReactElement {
  const [value, setValue] = useBoundProp<number>(props.value ?? undefined, bindings?.value);
  const min = props.min ?? 0;
  return (
    <QuantityStepper
      label={props.label}
      value={value ?? min}
      min={min}
      max={props.max ?? undefined}
      onChange={setValue}
    />
  );
}

function PriceRange({ props, bindings }: ComponentContext<Catalog, "PriceRange">): ReactElement {
  const currency = useCurrency();
  const [min, setMin] = useBoundProp<number | null>(props.min, bindings?.min);
  const [max, setMax] = useBoundProp<number | null>(props.max, bindings?.max);
  return (
    <PriceRangeControl
      min={min ?? undefined}
      max={max ?? undefined}
      currency={currency}
      onChange={(low, high) => {
        setMin(low ?? null);
        setMax(high ?? null);
      }}
    />
  );
}

/**
 * An action param as its value. Inside a `repeat`, json-render resolves `{ "$item": "id" }` in an
 * action's params to the item's **state path** (`/decks/1/id`) — the shape its own `setState`
 * needs — and its prompt tells a model so. These actions want the value, so a param that arrives
 * as a path is read back from the spec's state. No value they take begins with `/`: a Scryfall id,
 * a set code, an id number, a view.
 */
function valueOf<T>(param: T, state: StateModel): T {
  return typeof param === "string" && param.startsWith("/")
    ? (getByPath(state, param) as T)
    : param;
}

const BUTTON_VARIANT: Record<string, string> = {
  default: "border-border",
  primary: "border-accent/50 text-accent",
  quiet: "border-transparent text-dim hover:text-text",
};

export const { registry, handlers, executeAction } = defineRegistry(catalog, {
  components: {
    Stack: ({ props, children }) => (
      <div
        className={cn(
          "flex min-w-0",
          props.direction === "horizontal" ? "flex-row" : "flex-col",
          GAP[props.gap ?? "md"],
          props.align &&
            {
              start: "items-start",
              center: "items-center",
              end: "items-end",
              stretch: "items-stretch",
            }[props.align],
          props.justify &&
            {
              start: "justify-start",
              center: "justify-center",
              end: "justify-end",
              between: "justify-between",
            }[props.justify],
          props.wrap && "flex-wrap",
        )}
      >
        {children}
      </div>
    ),
    Grid: ({ props, children }) => (
      <div
        className={cn("grid min-w-0", GAP[props.gap ?? "md"])}
        style={{ gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }}
      >
        {children}
      </div>
    ),
    Divider: () => <hr className="border-border" />,
    Panel: ({ props, children }) => <StatsCard title={props.title}>{children}</StatsCard>,
    Heading: ({ props }) => {
      const level = props.level ?? 2;
      const className = cn(
        "font-semibold text-text",
        level === 1 ? "text-xl" : level === 2 ? "text-base" : "text-sm",
      );
      return level === 1 ? (
        <h2 className={className}>{props.text}</h2>
      ) : level === 2 ? (
        <h3 className={className}>{props.text}</h3>
      ) : (
        <h4 className={className}>{props.text}</h4>
      );
    },
    Text: ({ props }) => (
      <p
        className={cn(
          TONE[props.tone ?? "default"],
          TEXT_SIZE[props.size ?? "sm"],
          props.mono && "font-mono tabular-nums",
          props.truncate && "truncate",
        )}
      >
        {props.text}
      </p>
    ),
    ManaText: ({ props }) => <ManaText source={props.text} className="text-sm text-text" />,
    Price,
    Hint,
    Figures,
    Bars,
    RowList,
    Row,
    Message: ({ props }) => <WidgetMessage tone={props.tone ?? "dim"}>{props.text}</WidgetMessage>,
    Footer: ({ props }) => <WidgetFooterLine line={props.line} said={props.said ?? undefined} />,
    PriceChart: Chart,
    ColumnChart: Columns,
    PriceHistogram: Histogram,
    CardArt: ({ props }) => (
      <div className={ART_WIDTH[props.size ?? "md"]}>
        <CardArt
          cardId={props.cardId}
          name={props.name}
          face={props.face ?? 0}
          finish={props.finish}
        />
      </div>
    ),
    CardTile: Tile,
    RarityGem: ({ props }) => (
      <RarityGem rarity={props.rarity} withLabel={props.withLabel ?? false} />
    ),
    FinishMark: ({ props }) => <FinishMark finish={props.finish} />,
    SetSymbol: ({ props }) => (
      <i
        role="img"
        aria-label={props.setCode.toUpperCase()}
        className={cn(
          setGlyphClass(props.setCode),
          "leading-none",
          SYMBOL_SIZE[props.size ?? "md"],
        )}
      />
    ),
    CountTag: ({ props }) => <CountTag count={props.count} title={props.title} />,
    OwnedBadge: ({ props }) => (
      <OwnedBadge owned={props.owned} wishlisted={props.wishlisted ?? false} />
    ),
    GameChangerMark: () => <GameChangerMark />,
    Button: ({ props, emit }) => (
      <button
        type="button"
        onClick={() => emit("press")}
        className={cn(BUTTON, BUTTON_VARIANT[props.variant ?? "default"])}
      >
        {props.label}
      </button>
    ),
    TextInput,
    Select,
    Switch,
    Combobox,
    MultiSelect,
    Segmented,
    RadioGroup,
    ToggleChip,
    NumberStepper,
    PriceRange,
  },
  actions: {
    openCard: async (params, _, state) => {
      if (params) useAppStore.getState().setSelectedCardId(valueOf(params.cardId, state));
    },
    openDeck: async (params, _, state) => {
      if (!params) return;
      const store = useAppStore.getState();
      store.setActiveView("decks");
      store.setOpenDeckId(valueOf(params.deckId, state));
    },
    openFolder: async (params, _, state) => {
      if (!params) return;
      const scope = valueOf(params.scope, state);
      const store = useAppStore.getState();
      store.setActiveView(scope);
      store.setPendingFolder({ scope, id: valueOf(params.folderId, state) });
    },
    openView: async (params, _, state) => {
      if (params) useAppStore.getState().setActiveView(valueOf(params.view, state));
    },
    showSet: async (params, _, state) => {
      if (params) useAppStore.getState().showSetInSearch(valueOf(params.setCode, state));
    },
    openPriceHistory: async (params, _, state) => {
      if (!params) return;
      useAppStore.getState().openPriceHistory({
        cardId: valueOf(params.cardId, state),
        finish: valueOf(params.finish, state),
        window: "30d",
      });
    },
  },
});

/** A day in words — `4 Jul 2026` — the way the home page writes one. */
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * The catalogue's `$computed` functions, at the reader's marketplace. A hook because money is
 * written in the reader's currency, which is the window's (`useMarketplace`, after its host
 * fallback) and changes when the picker moves.
 */
export function useCatalogFunctions(): Record<string, (args: Record<string, unknown>) => unknown> {
  const currency = useCurrency();
  return useMemo(
    () => ({
      formatPrice: (args) =>
        formatPrice(typeof args.value === "number" ? args.value : null, currency),
      formatNumber: (args) => (typeof args.value === "number" ? args.value.toLocaleString() : "—"),
      formatPercent: (args) =>
        typeof args.value === "number" ? `${Math.round(args.value * 100)}%` : "—",
      formatDate: (args) =>
        typeof args.seconds === "number" ? DATE.format(new Date(args.seconds * 1000)) : "—",
    }),
    [currency],
  );
}
