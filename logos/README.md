# MTG Grimoire app icon (10a — Spell Circle, full bleed)

Colours are the app's own tokens, resolved to hex for export:
gold `#D1A84B` (--color-accent), panel `#16181E` (--color-surface), field `#0C0D12` (--color-bg).

## Files

- `svg/mtg-grimoire-mark.svg` — the mark, transparent background. Master artwork; edit this one.
- `svg/mtg-grimoire-tile.svg` — mark on the dark rounded tile (13/64 corner radius), 1px inset.

Everything is centred on the BOOK — its two boards, excluding the clasp and the ribbon — so the book
sits dead centre in the frame with equal margins on all four sides, and the clasp and ribbon reach
into that margin. Clear space is about 9/64 on the tile, 12/64 on the transparent mark.
- `png/mark-*.png` — transparent renders, 16 to 1024 px.
- `tauri/` — drop-in replacement for `src-tauri/icons/`, **rendered from the mark, transparent**.
- `icon.ico` — Windows icon: 16, 24, 32, 48, 64 and 256 px in one file.

**The shipped app icon is the mark, not the tile, and that is a decision rather than an oversight**
(2026-08-22). The tile's `#0C0D12` field is only ever invisible on a dark surface: on the light
Explorer background, a light-theme taskbar, or a pale wallpaper it draws a black rounded square
around the book, which is what the swap removed. Measured on the exports it replaced, the tile set
was **3–5% non-opaque** — the rounded corners and nothing else — against **45–60%** now.

Two things fall out of it and neither is a regression:

- **The book is 5.7% larger than it was**, because the mark is drawn at `scale(0.92)` where the
  tile draws it at `0.87`. The tile spent that difference on its own edge.
- **The `.ico` ladder traded 128 px for 24 px.** 24 is a size Windows actually asks for (the small
  taskbar, Alt-Tab) and 128 is one it interpolates from 256, so this is the better ladder — but it
  is the generator's choice, not a tuned one.

Regenerate the whole set from the master with
`npx tauri icon logos/png/mark-1024.png -o <dir>`, then copy the flat files over **both**
`src-tauri/icons/` and `logos/tauri/`, which are kept byte-identical. Do not point that command at
`svg/mtg-grimoire-tile.svg` or its renders — that is what put the black plate there. Render into a
scratch directory rather than over `src-tauri/icons/`: the command also emits `android/`, `ios/`
and a `64x64.png`, none of which this repo tracks, and `icon.icns` belongs to `src-tauri/icons/`
alone while the Windows `.ico` is copied to `logos/icon.ico` as well.

## Notes

- Below about 24 px the casting circle and the clasp rivets fill in. If you want a crisper small
  size, ask for a simplified 16/32 variant drawn without the dashed circle.
- Everything is drawn on the same 64x64 grid, so the SVG re-renders at any size without redrawing.
