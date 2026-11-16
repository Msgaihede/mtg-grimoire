# Foil Effects Redesign (issue #1689) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foil drawings and light the owner approved on the "Foil Effects Redesign" design canvas (https://claude.ai/artifact/N3fWoFyGSHMTz5c3hLxBTT, version 10), including a deck of 100+ foils that stays smooth.

**Architecture:** `lib/foilEffect.ts` stays the pure model (which drawing, where the light is, ripple's rings); `components/useFoilLight.ts` stays the one window-wide light pass, now once per frame with a budget; `index.css`'s "Foil" section is replaced by the canvas's `proposed.css`; `scripts/foil-textures.ts` gains the mana textures and loses ripple's three pictures (ripple is CSS gradients now).

**Tech Stack:** React 19, TypeScript 6, Vitest + jsdom, Tailwind v4 CSS, Node 24 for the texture script.

**Spec:** the canvas above is the spec; its decisions are restated under Global Constraints. The canvas generator and render harness are in the session scratchpad (`proto/gen.mjs`, `proposed.css`, `ripple.mjs`, `mana-raster.mjs`), which is where every value below was measured.

## Global Constraints

- Issue #1689: regular foil returns to the pre-2026-11-15 sheen (screen, its own alphas); mana foil (`manafoil`) gets its own drawing; every foil less blown out; ripple at half the circles, rings that grow/shrink and fade, never move.
- Strength: `--foil-on` is `0.6` everywhere (the canvas's approved default). `[data-foil="foil"]` scales by `--foil-on / 0.6` so it is exactly the old sheen.
- Every drawing reaches the card's edge (no `inset` clips). Etched still leaves the art window flat.
- Light: no cursor following. Each card has its own angle `115° ± 9°` and resting offset `± 0.08` (seeded per card, deterministic). Idle cards drift `0.2` of a card across the whole window, mirrored; the hovered card moves `0.9` of a card across itself, blended in over the outer 15 % of its edge (smoothstep). No easing over time.
- Ripple: 9 fixed rings `[cx, cy, r, dir]` = `[.2,.14,.3,30] [.8,.2,.26,150] [.46,.4,.22,270] [.08,.55,.32,80] [.9,.6,.34,210] [.52,.76,.28,330] [.2,.95,.24,120] [.8,1,.22,0] [.52,.06,.2,240]`; 5 shown (the nearest to the light, fading over ±0.1); grow `0.7 + 0.6·smoothstep(-0.35, 0.35, along dir)`; visibility fades over `0.9s` (`@property --foil-s1..9`).
- Mana lattice (FDN 362): rows `0.1012 W` apart, rings `0.2083 W` apart, alternate rows offset half, ring radius `0.0484 W`, row origin `(0.298 W, 0.203 H)`, glyph box `1.25 r`, symbol `WUBRG[(j + 2i) mod 5]`; two white PNGs at 750×1050 (discs+rims, glyphs+thin rims).
- Performance (owner, 2026-11-16, "a whole deck of surge foils was really laggy", 100+ cards): one light pass per frame; every box read before any write; only changed values written; idle cards' light stepped to `0.004`; at most **4 idle cards relit a frame** (6 on the canvas; 4 after measuring the shipped window, about 1.5 ms per idle card), farthest behind first, the rest on following frames; "hovered" is the card whose frame holds the pointer event's target (the topmost), never every box containing the pointer; an idle ripple shows its resting rings; each foil card's frame is its own compositor layer (`translateZ(0)`, only under `hover: hover`).
- Unchanged: touch and reduced motion get the resting light; the pointer leaving the window rests every card; scroll/resize relight; never a mask/clip/opacity/filter/transform on the overlay span itself.

## Review Focus

1. A card mounted (virtualised wall scrolling) while the pointer is in the window must be lit within a frame — not left at a stale rest until the next move.
2. A frame whose React `style` re-applies (effect changes from surge to foil on a printing swap) must not keep the old drawing's ripple vars or textures — `foilStyle` covers every var the light writes.
3. The idle backlog must drain after the pointer stops (catch-up frames run without pointer events) and stop scheduling once drained (no rAF loop forever).
4. The frame's new compositor layer must not lift or clip anything drawn over the card (deck marks strip, quantity tag, chip tooltip) — checked live.
5. Ripple cards after the pointer leaves: the hovered card's rings fade back to its resting set, not freeze mid-fade.

---

### Task 1: The model — `lib/foilEffect.ts`

**Files:** Modify `packages/ui/lib/foilEffect.ts`; Test `packages/ui/lib/foilEffect.test.ts`.

**Interfaces — Produces:**
- `FOIL_EFFECTS` gains `"mana"`; `BY_TREATMENT.manafoil = "mana"`; `FOIL_PATTERN_LAYERS` mana `2`, ripple `1`.
- `FOIL_STRENGTH = 0.6`, `FOIL_REST = {x:.32,y:.28}`, `FOIL_IDLE = 0.2`, `FOIL_HOVER = 0.9`, `FOIL_IDLE_STEP = 0.004`.
- `interface FoilCard { angle: number; ox: number; oy: number }`; `foilCard(seed: string): FoilCard`.
- `interface FoilPointer { gx: number; gy: number; rx: number; ry: number; hover: number }`; `foilPointer(at: {x,y}, box: {left,top,width,height}, view: {width,height}, onCard: boolean): FoilPointer`.
- `foilAim(pointer: FoilPointer | null, card: FoilCard): {x,y}` (null → the card's rest; hover 0 → stepped to `FOIL_IDLE_STEP`).
- `RIPPLE_RINGS`, `RIPPLE_SHOWN = 5`, `rippleRings(x, y): {grow, show}[]`.
- `foilLight(at: {x,y}, card: FoilCard, ripple: "live" | "rest" | null): Record<string,string>` — `--foil-px/py/mx/my/hyp/on/angle/at`, plus `--foil-g1..9`/`--foil-s1..9` when ripple (`"rest"`: show from the card's rest, grow from `at`).

- [ ] Tests: `foilEffect("foil", [manafoil])` is `"mana"`; layer counts; `foilCard` is deterministic, angle in `[106, 124]`, offsets in `[-0.08, 0.08]`, two seeds differ; idle drift across the whole window is ≤ 0.2 of the card and mirrored; hover range on the card ≈ 0.9; entering the card at its edge does not jump (hover 0 at the edge); idle aim is a multiple of 0.004; exactly 5 rings shown at a ring-free point; grow in `[0.7, 1.3]`; `"rest"` show values are the rest light's whatever `at` is; `--foil-on` is `"0.6"`.
- [ ] Implement; run `pnpm exec vitest run packages/ui/lib/foilEffect.test.ts`.

### Task 2: Textures — `scripts/foil-textures.ts`, `components/foilTextures.ts`

**Files:** Modify both; delete `packages/ui/assets/foil/ripple-{a,b,c}.png`; create `mana-discs.png`, `mana-glyphs.png`.

- [ ] Port `flatten`/`fill` (path → nonzero coverage, 4×4 supersampled) and the lattice from `mana-raster.mjs` as recipes `mana-discs`, `mana-glyphs` (750 wide), reading `node_modules/mana-font/svg/{w,u,b,r,g}.svg`; remove `rippleSet` and the three ripple recipes.
- [ ] `foilTextures.ts`: mana → `[manaDiscs, manaGlyphs]`; ripple → one CSS value, `rippleImage()` built from `RIPPLE_RINGS` (ring i's stops `calc(var(--foil-gI) * R% ± band)`, alpha `calc(var(--foil-sI) * a)`, % of the farthest-corner ray of a 5:7 card); textures table holds CSS values, not bare URLs.
- [ ] Run `node scripts/foil-textures.ts mana-discs mana-glyphs`; check both PNGs render (open them).

### Task 3: The light pass — `components/useFoilLight.ts`, `components/CardArt.tsx`

**Interfaces — Consumes:** Task 1. **Produces:** `useFoilLight(overlay, effect: FoilEffect | null, card: FoilCard)`; `FoilOverlay` prop `seed?: string` (CardArt passes `cardId ?? name`, `CardModalArt` its card id, `DeckCardFace` its card id; none → `useId()`).

- [ ] Tests (CardArt.test.tsx "the foil's light", rAF queued by a spy and flushed by hand): rest light at mount (`--foil-on` 0.6, the card's own rest); a move relights only after a frame; the card holding the event target gets the hover light and moves with the pointer across it, one beside it barely moves; with 11 idle foils one move writes 4, then 4, then 3, then nothing is scheduled; touch and reduced motion stay at rest; leaving the window rests all; scroll relights.
- [ ] Implement: pointer `{x, y, target}`; `schedule()` one rAF; `light()` reads boxes and `frame.contains(target)` first, writes hovered + `FOIL_IDLE_BUDGET` idle by `behind`, reschedules while idle remain; `rest()` writes every foil's rest. `foilStyle(effect, card)` = textures + `foilLight(foilAim(null, card), card, ripple ? "rest" : null)`.

### Task 4: The drawings — `index.css` "Foil" section

- [ ] Replace the section with `proposed.css` (no `inset` clips; etched clip to the card's edge; regular foil = old sheen; mana; ripple single layer, no shine; `--foil-angle`/`--foil-at` sweeps) plus `@property --foil-s1..9 { syntax: "<number>"; inherits: true; initial-value: 0 }`, `[data-foil="ripple"] { transition: --foil-s1 0.9s ease, … }`, and `@media (hover: hover) { :has(> [data-foil]) { transform: translateZ(0) } }`. Update the section's header comment (strength 0.6, the light, the layer).
- [ ] Storybook: add a Mana Foil story to `CardArt.stories.tsx` beside the other kinds.

### Task 5: Docs, verify, live check, ship

- [ ] `docs/reference/frontend-design.md` (the foil bullets: kinds, light, the deck budget and layers, with the measured numbers), `packages/ui/CLAUDE.md` foil bullet.
- [ ] `pnpm verify` once. Live: `running-the-app` skill, the app lock, a deck with many foils over CDP — screenshot a surge, mana, ripple, etched card and time a pointer sweep over the stacks.
- [ ] Commit (`feat(cards): …`, closes #1689), push, PR, bind, auto-fix, auto-merge, comment the resolution on #1689. Delete `.canvas-staging/` first; `rm -rf target/cache` after.
