## Conventions

MTG Grimoire is a **dark-only** desktop app for tracking a Magic: The Gathering collection.
There is no light theme and no theme switch: `:root` and `.dark` carry identical values, and the
class exists only to switch on the `dark:` variant that vendored shadcn components ship with.
Design on the dark surface; never invent a light palette for these components.

### Wrapping — required

Wrap every tree in `GrimoirePreviewProvider`. The name says "preview" but it is the **only**
provider, and designs need it as much as cards do:

```jsx
const { GrimoirePreviewProvider, Ribbon } = window.MtgGrimoire;
<GrimoirePreviewProvider>{/* your UI */}</GrimoirePreviewProvider>
```

It supplies three things this app cannot run without: a TanStack `QueryClient`, a seeded local
backend standing in for the desktop IPC layer, and `class="dark"` on `<html>`. It also installs
the keyboard-modality listener every focus ring is gated on, so without it Tab draws no outline. Without it,
`AppShell`, `Ribbon` and `SyncProgress` throw or render permanently empty — they read live sync
state, not props alone. Pure presentational components (`RarityGem`, `ManaText`, `OwnedBadge`,
`QuantityStepper`, `Figure`, `SortableHeader`) render fine unwrapped, but wrap anyway: it costs
nothing and the surface tokens come with it. `GrimoireWorld` takes `seed` / `fault` props if you
want a subtree on different data.

### Styling idiom — Tailwind v4 utilities over a custom `@theme`

Style your own layout with these utilities. They are real classes in `styles.css`; do not
invent parallel names or hard-code hex values.

| Family | Use | Names |
|---|---|---|
| Surface | page, panels | `bg-bg` · `bg-surface` · `bg-muted` |
| Text | body, secondary, gold | `text-text` · `text-dim` · `text-accent` |
| Border | every rule and edge | `border-border` |
| Type | display, data | `font-heading` · `font-mono` |

Body type needs no class: `body` is `font-sans` already. Inside a `font-heading` or `font-mono`
subtree, return to body type with the `font-sans` utility — `<p className="font-sans text-dim">`.
The `--font-sans` token ships too, if you need it in a `var()`.

Two traps that silently produce near-invisible UI:

- **Dim text is `text-dim`, never `text-muted`.** `--color-muted` is a *surface* (it aliases
  `--color-surface`, which is what shadcn means by it), so `text-muted` compiles and paints text
  in the panel colour.
- **`accent` is gold and it is a *text* colour.** When you bring in a stock shadcn component,
  rewrite its `bg-accent` surfaces to `bg-surface`. `text-accent-foreground` already resolves.

Underlying tokens, if you need `var()` directly: `--color-bg` `--color-surface` `--color-border`
`--color-text` `--color-dim` `--color-accent` `--color-accent-fg` `--radius`. Domain colour is
tokenised too: `--color-mana-w|u|b|r|g|c` are the five colours and colourless as printed symbols
are filled, and since 2026-09-28 they are **the only palette for anything that stands for a Magic
colour** — chips, pips, chart fills, rails, count tags and glyphs alike. All six are pale, so
anything printed on one is near-black (`--color-accent-fg`), never light text. There is no gold
among them: a gold mark (a game changer's crown, a multicolour fill) is `--color-accent`. The
saturated `--color-pie-*` deeps that used to sit beside them are deleted and must not come back.
`--color-rarity-common|uncommon|rare|mythic` are footnote-sized only.

### Magic symbols are components, never glyphs you type

Mana and set symbols come from the bundled `mana-font` and `keyrune` faces, already wired.
Render mana cost or rules text with `ManaText` (it parses `{2}{W/U}{P}` and Phyrexian, hybrid
and snow symbols), the sync bar with `ManaLine`, rarity with `RarityGem`, and the filter chip
family with `ToggleChip` / `ManaChip` / `ManaValueChips` / `LayoutToggle` / `ResetAll`. Do not
hand-draw a mana pip.

### Cards are real card images — keep `card-art/` beside the bundle

Every card a component draws (`CardImage`, `CardArt`, the deck editor's stacks) shows the real
printed card, served from the `card-art/` folder at this design system's root. The provider finds
it from the bundle script's own address, so **when you install this system on a canvas, copy
`card-art/` along with `components/bundle.js`** — without it every card falls back to the app's
own no-image frame. The images cover the seeded fixture's printings (`CARDS` on
`window.MtgGrimoire`); a card id outside it draws a labelled placeholder, never a broken image.

### The deck editor is components, not a drawing

Draw the deck editor by mounting its parts rather than recreating them: `StackView` (the Stacks
desk — piles in columns, the rail on the right), `CardStack` (one pile), `DeckCardFace` (a stacked
card's face), `CardChin` (the rarity · set · number · finish · price foot), `GroupHeader` (a pile's
heading), `QuantityTag` and `TheoryMatchMark` (the card's corner marks) and `CountPill`.
`StackView`, `CardStack`, `CardChin` and `QuantityTag` have cards of their own — read their
`.prompt.md` and `.d.ts` before passing a prop; the rest ship on `window.MtgGrimoire` as the
pieces those four are built from. The seeded fixtures the stories use ship too —
`printing`, `deckCard`, `deckCategory` and `deckGroups` — so a deck built from them draws real
cards.

### Selects and hints — use the app's own

- **A select is `Dropdown` (one value) or `MultiDropdown` (several), never a native `<select>`.**
  Both are controlled: keep the value in `useState` and pass `value`/`onChange` (multi:
  `selected`/`onToggle`, plus a `triggerLabel` you compute — a count like "2 formats", never a
  value). Rows are `{ value, label, icon?, hint?, disabled?, title? }` — `title` is the reason a
  disabled row gives. `size="sm"` in dense panes, `fill` to stretch into a grid cell, `searchable`
  for long lists.
- **A hint is `useTooltip()`'s spread, never a `title` attribute.** `const tip = useTooltip();`
  then `<button {...tip("Sorted by release date")}>` — no wrapper element, so it cannot move a
  layout. `{ interactive: true }` for a hint the reader acts on; `{ whenClipped: true }` on a
  truncated cell whose tooltip is its own full text. Needs `GrimoirePreviewProvider`, which mounts
  the one panel.

```jsx
const { Dropdown, useTooltip } = window.MtgGrimoire;

function FormatPicker() {
  const [format, setFormat] = React.useState("modern");
  const tip = useTooltip();
  return (
    <div className="flex items-center gap-2">
      <Dropdown
        label="Format"
        value={format}
        onChange={setFormat}
        options={[
          { value: "standard", label: "Standard" },
          { value: "modern", label: "Modern" },
        ]}
      />
      <span className="text-dim text-sm" {...tip("Legality follows this format.")}>?</span>
    </div>
  );
}
```

### Where the truth is

Read `styles.css` and the files it `@import`s before styling anything — that closure is the
whole visual system. For any component, read its `.prompt.md` (variants and real usage) and
`.d.ts` (the prop contract) in `components/<group>/<Name>/`.

### An idiomatic build

```jsx
const { GrimoirePreviewProvider, RarityGem, ManaText, Figure } = window.MtgGrimoire;

<GrimoirePreviewProvider>
  <div className="bg-surface border border-border rounded-lg p-4 space-y-2">
    <h2 className="font-heading text-text text-lg">Lightning Bolt</h2>
    <ManaText source="{R}" />
    <p className="text-dim text-sm">Deals 3 damage to any target.</p>
    <RarityGem rarity="rare" withLabel />
    <Figure label="Price (USD)" value="$620.00" />
  </div>
</GrimoirePreviewProvider>
```
