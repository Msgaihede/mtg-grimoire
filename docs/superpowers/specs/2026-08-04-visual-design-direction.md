# Visual Design Direction — MTG Collection Tracker

**Status:** Binding for all frontend work (user-requested overhaul, 2026-08-04).
**Process rule:** every frontend task follows the `frontend-design` skill and THIS document. Implementers do not invent palettes, type, or layout — they execute this direction and spend judgment on detail quality.

## Thesis

Magic's color pie IS the interface's color system. The app chrome is a quiet, dark card-table; color appears only where it carries Magic meaning (mana, color identity, rarity, card art). One signature element carries the identity: the **mana line**.

## Tokens

### Palette (dark chrome — unchanged foundation)
- `--color-bg` oklch(0.16 0.01 270) — table felt
- `--color-surface` oklch(0.21 0.012 270) — cards/panels
- `--color-border` oklch(0.3 0.01 270)
- `--color-text` oklch(0.93 0.005 90) / `--color-muted` oklch(0.65 0.01 90) (dim TEXT, never a bg)
- `--color-accent` oklch(0.75 0.12 85) gold — interactive emphasis, focus, active nav

### The five colors (authentic WUBRG symbol fills — used for mana UI ONLY)
- `--mana-w` #FFFBD5  `--mana-u` #AAE0FA  `--mana-b` #CBC2BF  `--mana-r` #F9AA8F  `--mana-g` #9BD3AE
- Glyphs render in near-black on those fills, exactly like printed symbols.
- Frame/pie deep variants (for identity pips, charts later): W #F8E7B9, U #0E68AB, B #3B3A3E, R #D3202A, G #00733E, gold #D9B95C (multicolor), colorless #C8C4BF.

### Rarity
common `#9AA0A6` (silver-grey) · uncommon `#B3C7CE` · rare `#BFA35A` · mythic `#E86A33`. Small gem dot or tinted text in tables/tiles.

### Type
- **Display:** Cinzel (`@fontsource/cinzel`, weights 500/600) — view titles, first-run hero, section headers ONLY. Never body text, never below 18px.
- **Body/UI:** Geist (already bundled) — everything else.
- **Data:** Geist Mono — collector numbers, prices, counts (tabular-nums stays).

### Signature: the mana line
A 2px horizontal rule of the five-color gradient (W→U→B→R→G, soft blends) under the global ribbon. Always present, never animated, never repeated elsewhere. During an active sync it becomes the progress bar (fill sweeps left→right, gold cap) — the one place identity and function merge.

## Layout

- **Global ribbon** (replaces in-page header actions): left = app mark + view title; right = sync status line, Refresh, future global actions (settings, import/export). One row, 48px, `bg-surface`, mana line beneath.
- **Sidebar:** unchanged concept (Search/Collection/Wishlist/Decks/Settings), gold active indicator.
- **Content:** view-owned; filters live with their view, not in the ribbon.

## Search filters (user requirements, binding)

- **Color filter:** five toggle chips with REAL mana symbols (`mana-font` npm pkg, self-contained icon font — never CDN) on authentic fills above, plus C (colorless, `--mana` colorless fill) — pressed state: full-color fill + subtle ring; unpressed: desaturated/dimmed same chip.
- **Set filter:** searchable combobox over the `sets` table (name + code), set glyphs via `keyrune` npm pkg where available; multi-select allowed.
- **Mana value filter:** discrete chips 0–7 and 8+ (multi-select allowed), mono numerals.
- **Format filter:** existing select, restyled.
- All filters combinable (backend already ANDs; extend search command for sets[]/mana values); **Reset all** appears whenever ≥1 filter is active, clears everything at once.
- Active-filter state must be visible at a glance (filled chips; count badge on Reset).

## Rules of restraint

- Boldness budget: the mana line + mana chips ARE the color. Chrome, tables, panels stay quiet — no gradients, no glows, no five-color anything else.
- Card art (Plan 2+) is the loudest element on any screen that has it; UI must not compete.
- Motion: 150ms ease transitions on chip/nav state; sync sweep on the mana line; nothing else. Respect `prefers-reduced-motion`.
- Quality floor, unannounced: keyboard focus visible (gold ring), AA contrast on all text, works down to 1024px width.
- Copy: sentence case, verbs on buttons ("Refresh data", "Reset all"), errors say what happened + what to do. No lorem, no filler.

## Anti-generic check (performed at authoring)

Rejected: generic dark+single-neon-accent (default #2); cream/serif/terracotta (default #1); newspaper hairlines (default #3). This direction is derived from the subject's own artifacts (symbol fills, color pie, rarity gems) — the same brief given to a generic process would not produce the mana line or authentic symbol fills. Type pairing (Cinzel display / Geist body) chosen for MTG's Beleren-adjacent flavor without licensing risk, used with restraint.
