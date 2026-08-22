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
- `tauri/` — drop-in replacement for `src-tauri/icons/` (tile version, opaque).
- `icon.ico` — Windows icon: 16, 32, 48, 64, 128 and 256 px in one file.

## Notes

- Below about 24 px the casting circle and the clasp rivets fill in. If you want a crisper small
  size, ask for a simplified 16/32 variant drawn without the dashed circle.
- Everything is drawn on the same 64x64 grid, so the SVG re-renders at any size without redrawing.
