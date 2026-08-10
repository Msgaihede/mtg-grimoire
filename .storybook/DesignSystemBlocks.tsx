import { useEffect, useRef, useState, type ReactNode } from "react";
import { Unstyled } from "@storybook/addon-docs/blocks";
import {
  MANA_KEYS,
  MANA_LABEL,
  MANA_LINE_GRADIENT,
  type ManaKey,
  type ManaLineSync,
} from "@/lib/mana";
import { setGlyphClass } from "@/lib/keyrune";
import { cn } from "@/lib/utils";
import { ManaChip } from "@/components/FilterChips";
import { ManaLine } from "@/components/ManaLine";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";

/**
 * The specimens `DesignSystem.mdx` draws, as a module rather than as the page's own JS.
 *
 * **Not a style choice.** A `/** … *\/` block at the top level of an MDX file is a markdown
 * paragraph, and an `export` on the next line continues that paragraph instead of starting an
 * ESM block — so the first `{` in the swallowed declaration is read as an inline expression and
 * `acorn` refuses it ("Could not parse expression with acorn", measured against this very page
 * at what was then line 61). Beyond that, nothing type-checks or lints code that lives inside
 * MDX: this file is inside `tsconfig`'s `.storybook` program and inside ESLint's sweep, and the
 * page it serves is one that no test renders.
 *
 * Everything here is prop-driven and fetches nothing. The page defines no story, so no fake
 * backend is installed around it and no store is written while it renders.
 */

/**
 * Colour is set inline as well as by class throughout.
 *
 * The class is the app's own and is what a reader should copy; the inline value is the same
 * token read through `var()`, and it is what keeps a specimen on the app's ground even if this
 * directory were ever to fall out of the `@source` list in `src/index.css`.
 */
const GROUND = { background: "var(--color-bg)", color: "var(--color-text)" };
const HAIRLINE = { borderColor: "var(--color-border)" };
const DIM = { color: "var(--color-dim)" };

/**
 * A specimen on the app's own ground.
 *
 * `Unstyled` because Storybook's docs typography would otherwise reach into the sample and
 * restyle it, and a palette that is only correct on a white page is not this palette.
 */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Unstyled>
      <div
        className={cn("mb-4 overflow-hidden rounded-lg border border-border p-5", className)}
        style={{ ...GROUND, ...HAIRLINE }}
      >
        {children}
      </div>
    </Unstyled>
  );
}

function PanelTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-heading text-lg leading-none">{children}</h3>;
}

/** One `--color-*` custom property, with the value the browser computed for it. */
interface ColorToken {
  name: string;
  value: string;
}

/**
 * Every `--color-*` custom property the running stylesheet declares on `:root`.
 *
 * Walked out of `document.styleSheets` rather than listed, so a token added to `src/index.css`
 * shows up on this page without this file being edited. A hand-kept list is a second source of
 * truth that goes stale without anything failing, which is the whole failure this page exists
 * to avoid.
 *
 * The `@theme inline` block at the top of `src/index.css` is deliberately unrepresented:
 * `inline` means Tailwind substitutes those values into the utilities instead of emitting a
 * custom property, so there is nothing on `:root` to read. Their targets — `--background`,
 * `--accent` and the rest of the shadcn names — live in the `:root` block, and every one of
 * them resolves to a token this walk does find.
 */
function readColorTokens(): ColorToken[] {
  const names = new Set<string>();

  const visit = (rules: CSSRuleList) => {
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules.item(i);
      if (!rule) continue;
      // `@layer`, `@media` and `@supports` are rules that hold rules, and Tailwind emits the
      // whole theme inside `@layer theme` — a flat pass would find none of it.
      if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
      if (!("selectorText" in rule)) continue;
      const styleRule = rule as CSSStyleRule;
      // `:root, :host` is how Tailwind spells it, so a match rather than an equality test.
      if (!styleRule.selectorText.includes(":root")) continue;
      for (let j = 0; j < styleRule.style.length; j += 1) {
        const prop = styleRule.style.item(j);
        if (prop.startsWith("--color-")) names.add(prop);
      }
    }
  };

  const sheets = document.styleSheets;
  for (let i = 0; i < sheets.length; i += 1) {
    const sheet = sheets.item(i);
    if (!sheet) continue;
    // A stylesheet from another origin throws on `cssRules`. None is expected in this frame,
    // and one unreadable sheet must not take the page with it.
    try {
      visit(sheet.cssRules);
    } catch {
      continue;
    }
  }

  const root = getComputedStyle(document.documentElement);
  return [...names].sort().map((name) => ({ name, value: root.getPropertyValue(name).trim() }));
}

/**
 * Reading order inside a group, for the groups where order carries meaning.
 *
 * WUBRG is not a preference — it is the order the symbols are printed in (`src/lib/mana.ts`,
 * line 20) — and a rarity ladder sorted alphabetically would run common, mythic, rare,
 * uncommon. Only the *order* is written down: a suffix this list does not know sorts to the end
 * of its group rather than vanishing from the page, because membership is still the live walk's
 * answer and not this list's.
 */
const SUFFIX_ORDER = ["w", "u", "b", "r", "g", "c", "gold", "common", "uncommon", "rare", "mythic"];

/** The chrome group, in reading order: ground, panel, hairline, then text, then gold. */
const CHROME_ORDER = [
  "--color-bg",
  "--color-surface",
  "--color-border",
  "--color-text",
  "--color-dim",
  "--color-muted",
  "--color-accent",
  "--color-accent-fg",
];

function suffixRank(name: string, prefix: string): number {
  const i = SUFFIX_ORDER.indexOf(name.slice(prefix.length));
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

interface PaletteGroup {
  id: string;
  title: string;
  blurb: string;
  match: (name: string) => boolean;
  /** Rank inside the group. Ties keep the alphabetical order `readColorTokens` returns. */
  rank: (name: string) => number;
}

const GROUPS: PaletteGroup[] = [
  {
    id: "chrome",
    title: "Chrome",
    blurb:
      "The quiet dark card-table everything else sits on. Eight tokens, and only one of them is a colour.",
    match: (name) => CHROME_ORDER.includes(name),
    rank: (name) => CHROME_ORDER.indexOf(name),
  },
  {
    id: "mana",
    title: "The five colours",
    blurb:
      "Authentic printed-symbol fills, for mana UI only — chips, pips, the line. Never a panel, never a border, never text.",
    match: (name) => name.startsWith("--color-mana-"),
    rank: (name) => suffixRank(name, "--color-mana-"),
  },
  {
    id: "pie",
    title: "Frame and pie deeps",
    blurb:
      "Saturated enough to carry meaning at 1px: identity pips and the deck-stats pies. Not interchangeable with the fills above.",
    match: (name) => name.startsWith("--color-pie-"),
    rank: (name) => suffixRank(name, "--color-pie-"),
  },
  {
    id: "rarity",
    title: "Rarity",
    blurb: "A 6px gem dot or a tinted word. Nothing bigger — a rarity is a footnote.",
    match: (name) => name.startsWith("--color-rarity-"),
    rank: (name) => suffixRank(name, "--color-rarity-"),
  },
  {
    id: "other",
    title: "Also declared on :root",
    blurb:
      "Not the app palette. Tailwind emits one of its own default tokens here as soon as a utility asks for one.",
    match: () => true,
    rank: () => 0,
  },
];

function Swatch({ name, value }: ColorToken) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="size-10 shrink-0 rounded-md border border-border"
        style={{ background: `var(${name})`, ...HAIRLINE }}
      />
      <span className="min-w-0 leading-5">
        <code className="block truncate font-mono text-xs">{name}</code>
        <code className="block truncate font-mono text-xs" style={DIM}>
          {value || "not declared on :root"}
        </code>
      </span>
    </div>
  );
}

/**
 * Every palette token, grouped, with the value read off `:root` at render time.
 *
 * A lazy `useState` initialiser rather than an effect, and that is the lint's doing as much as
 * the design's: `react-hooks/set-state-in-effect` refuses a `setState` in an effect body
 * (measured — it fails `npm run lint`), and it is right to. Nothing here is subscribing to
 * anything. The stylesheet is loaded before the preview renders in both `storybook dev` (Vite
 * injects it as the module graph loads) and `storybook build` (a `<link>` the browser blocks
 * on), so the first render is already late enough to read it, and it never changes afterwards.
 */
export function Palette() {
  const [tokens] = useState(readColorTokens);

  if (tokens.length === 0) {
    return (
      <Panel>
        <PanelTitle>Nothing to show</PanelTitle>
        <p className="mt-2 text-sm" style={DIM}>
          No <code>--color-*</code> custom property was found on <code>:root</code>. The app
          stylesheet is not loaded in this frame, so nothing on this page can be trusted.
        </p>
      </Panel>
    );
  }

  const sections: { group: PaletteGroup; members: ColorToken[] }[] = [];
  let left = tokens;
  for (const group of GROUPS) {
    const members = left.filter((t) => group.match(t.name));
    left = left.filter((t) => !group.match(t.name));
    if (members.length === 0) continue;
    members.sort((a, b) => group.rank(a.name) - group.rank(b.name));
    sections.push({ group, members });
  }

  return (
    <>
      {sections.map(({ group, members }) => (
        <Panel key={group.id}>
          <PanelTitle>{group.title}</PanelTitle>
          <p className="mt-2 text-sm" style={DIM}>
            {group.blurb}
          </p>
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
            {members.map((t) => (
              <Swatch key={t.name} name={t.name} value={t.value} />
            ))}
          </div>
        </Panel>
      ))}
    </>
  );
}

/**
 * Whether the bundled face is the one painting, said as the boolean the API returns.
 *
 * `document.fonts.ready` first, because a face is fetched lazily and a check that runs before
 * the fetch lands reports a miss that is only a race. `false` here means the specimen above it
 * is being drawn by the next family in its stack.
 */
function FontCheck({ spec }: { spec: string }) {
  const [state, setState] = useState("…");
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) setState(String(document.fonts.check(spec)));
    });
    return () => {
      live = false;
    };
  }, [spec]);

  return <code className="font-mono text-xs">{`document.fonts.check('${spec}') → ${state}`}</code>;
}

/**
 * One line of type, with the browser's own answer for what is drawing it.
 *
 * Measured on the specimen element rather than read from a token: `--font-sans` and
 * `--font-mono` are `@theme inline` and never reach `:root`, and a token would in any case only
 * say what was asked for rather than what the reader is looking at.
 */
export function TypeSpecimen({
  role,
  sample,
  sampleClass,
  check,
  children,
}: {
  role: string;
  sample: string;
  sampleClass?: string;
  /** A CSS `font` shorthand for `document.fonts.check`. */
  check: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s = getComputedStyle(el);
    setRead(`${s.fontFamily} · ${s.fontSize} · ${s.fontWeight}`);
  }, []);

  return (
    <Panel>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs" style={DIM}>
          {role}
        </span>
        <code className="font-mono text-xs" style={DIM}>
          {read ?? "measuring…"}
        </code>
      </div>
      <div ref={ref} className={cn("mt-3", sampleClass)}>
        {sample}
      </div>
      <div className="mt-3 text-xs leading-5" style={DIM}>
        {children}
      </div>
      <div className="mt-2">
        <FontCheck spec={check} />
      </div>
    </Panel>
  );
}

/**
 * The live name beside the retired one.
 *
 * The retired class is assembled from two pieces rather than written out, exactly as
 * `src/lib/tokens.test.ts` does it: `src/index.css` lists `../.storybook` as a Tailwind source,
 * so spelling it here would emit a live rule for it into the shipped app CSS. Documentation
 * must be free to name a class without shipping it.
 */
export function DimTextNote() {
  return (
    <Panel>
      <p className="font-mono text-xs">
        <span style={DIM}>dim text → </span>
        <span className="text-dim">text-dim</span>
        <span style={DIM}> · never </span>
        <span>{`text-${"muted"}`}</span>
      </p>
    </Panel>
  );
}

/** The four with a token of their own, and one of the two real values without one. */
const RARITIES = ["common", "uncommon", "rare", "mythic", "special"];

export function RarityRow() {
  return (
    <Panel>
      <div className="flex flex-wrap gap-6">
        {RARITIES.map((rarity) => (
          <RarityGem key={rarity} rarity={rarity} withLabel />
        ))}
      </div>
    </Panel>
  );
}

function ChipRow({ label, pressed }: { label: string; pressed: boolean }) {
  return (
    <>
      <p className="mb-2 text-xs" style={DIM}>
        {label}
      </p>
      <div className="flex flex-wrap gap-3">
        {MANA_KEYS.map((key: ManaKey) => (
          <ManaChip key={key} symbol={key} pressed={pressed} onClick={() => {}} />
        ))}
      </div>
    </>
  );
}

export function ChipsPanel() {
  return (
    <Panel>
      <ChipRow label="Pressed" pressed />
      <div className="mt-6">
        <ChipRow label="Unpressed" pressed={false} />
      </div>
      <p className="mt-4 font-mono text-xs" style={DIM}>
        {MANA_KEYS.map((key) => MANA_LABEL[key]).join(" · ")}
      </p>
    </Panel>
  );
}

/** Costs worth having in front of you, and what each one is here to settle. */
const COSTS: readonly (readonly [string, string])[] = [
  ["{2}{U}", "Generic and coloured — the ordinary case."],
  ["{R/W}{R/W}", "A hybrid half is one glyph and not two. Boros Guildmage's printed cost."],
  ["{U/P}", "Phyrexian: a colour with a life payment attached, drawn as the one symbol."],
  ["{X}{B}{B}", "A variable is a symbol like any other."],
  ["{S}", "Snow is a restriction on the source rather than a colour, and it is one symbol."],
  ["{T}: Add {G}.", "One parse for costs and rules text: Magic makes no distinction."],
  ["{8}{C/P}{C/P}", "No glyph in the font, so the token stays visible in braces."],
];

export function CostTable() {
  return (
    <Panel>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-3">
        {COSTS.map(([source, note]) => (
          <div key={source} className="contents">
            <dt className="text-lg">
              <ManaText source={source} />
            </dt>
            <dd className="min-w-0 text-sm" style={DIM}>
              <code className="font-mono text-xs">{source}</code>
              {` — ${note}`}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/**
 * A spread of sets, oldest first, and one code no set uses.
 *
 * Every name is the live `sets` table's own, read out of it on 2026-08-10 rather than
 * remembered.
 */
const SETS: readonly (readonly [string, string])[] = [
  ["lea", "Limited Edition Alpha"],
  ["atq", "Antiquities"],
  ["tmp", "Tempest"],
  ["mrd", "Mirrodin"],
  ["isd", "Innistrad"],
  ["ktk", "Khans of Tarkir"],
  ["dom", "Dominaria"],
  ["znr", "Zendikar Rising"],
  ["neo", "Kamigawa: Neon Dynasty"],
  ["ltr", "The Lord of the Rings: Tales of Middle-earth"],
  ["blb", "Bloomburrow"],
  ["dsk", "Duskmourn: House of Horror"],
  ["zzz", "No such set — keyrune's generic fallback"],
];

export function SetGrid() {
  return (
    <Panel>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-4">
        {SETS.map(([code, name]) => (
          <div key={code} className="flex min-w-0 items-center gap-3">
            <i className={cn(setGlyphClass(code), "text-2xl")} aria-hidden="true" />
            <span className="min-w-0 leading-5">
              <code className="block font-mono text-xs uppercase">{code}</code>
              <span className="block truncate text-xs" style={DIM} title={name}>
                {name}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** The gradient at 32px, and the constant that drew it, printed at render time. */
export function GradientPanel() {
  return (
    <Panel>
      <div
        aria-hidden="true"
        className="h-8 w-full rounded-sm"
        style={{ background: MANA_LINE_GRADIENT }}
      />
      <code className="mt-3 block break-words font-mono text-xs" style={DIM}>
        {MANA_LINE_GRADIENT}
      </code>
    </Panel>
  );
}

/** The shipped component at its real 2px, flush to the panel's edge as it is to the ribbon's. */
export function ManaLineState({ caption, sync }: { caption: string; sync: ManaLineSync | null }) {
  return (
    <Panel className="p-0">
      <p className="px-5 pb-3 pt-4 font-heading text-lg leading-none">{caption}</p>
      <ManaLine sync={sync} />
    </Panel>
  );
}
