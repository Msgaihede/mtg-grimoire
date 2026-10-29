import { createLucideIcon, type IconNode } from "lucide-react";

/**
 * Three face-down piles side by side, the middle one deeper — a Winston draft's table, which
 * lucide has no picture of. The page's own glyph, drawn on lucide's terms (a 24 grid, 2px strokes,
 * round caps) and built with its factory, so the hub's `ModeCard` and the saved draft's row take it
 * exactly as they take `Crown` (`components/icons.ts` argues the factory).
 */
export const WinstonPiles = createLucideIcon("winston-piles", [
  ["rect", { x: "1.5", y: "11", width: "5.5", height: "9", rx: "1", key: "winston-pile-1" }],
  ["path", { d: "M2.5 8.5h3.5", key: "winston-pile-1-edge" }],
  ["rect", { x: "9.25", y: "11", width: "5.5", height: "9", rx: "1", key: "winston-pile-2" }],
  ["path", { d: "M10.25 8.5h3.5", key: "winston-pile-2-edge" }],
  ["path", { d: "M10.25 6h3.5", key: "winston-pile-2-edge-far" }],
  ["rect", { x: "17", y: "11", width: "5.5", height: "9", rx: "1", key: "winston-pile-3" }],
  ["path", { d: "M18 8.5h3.5", key: "winston-pile-3-edge" }],
] satisfies IconNode);
