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
backend standing in for the desktop IPC layer, and `class="dark"` on `<html>`. Without it,
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
| Type | display, body, data | `font-heading` · `font-sans` · `font-mono` |

Two traps that silently produce near-invisible UI:

- **Dim text is `text-dim`, never `text-muted`.** `--color-muted` is a *surface* (it aliases
  `--color-surface`, which is what shadcn means by it), so `text-muted` compiles and paints text
  in the panel colour.
- **`accent` is gold and it is a *text* colour.** When you bring in a stock shadcn component,
  rewrite its `bg-accent` surfaces to `bg-surface`. `text-accent-foreground` already resolves.

Underlying tokens, if you need `var()` directly: `--color-bg` `--color-surface` `--color-border`
`--color-text` `--color-dim` `--color-accent` `--color-accent-fg` `--radius`. Domain colour is
tokenised too and is **not** interchangeable: `--color-mana-w|u|b|r|g|c` are the five colours as
printed symbols are filled (mana UI only — chips and pips, never a panel, border or text);
`--color-pie-*` are the saturated frame deeps for identity pips and charts; and
`--color-rarity-common|uncommon|rare|mythic` are footnote-sized only.

### Magic symbols are components, never glyphs you type

Mana and set symbols come from the bundled `mana-font` and `keyrune` faces, already wired.
Render mana cost or rules text with `ManaText` (it parses `{2}{W/U}{P}` and Phyrexian, hybrid
and snow symbols), the sync bar with `ManaLine`, rarity with `RarityGem`, and the filter chip
family with `ToggleChip` / `ManaChip` / `ManaValueChips` / `LayoutToggle` / `ResetAll`. Do not
hand-draw a mana pip.

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
