/**
 * The home page's layout document, read and rearranged — every function here is pure and
 * answers a new object.
 *
 * **Nothing in this file throws**, which is `features/decks/auditText.ts`'s rule inherited one
 * table over and for the same reason: what arrives is a document a *different build* may have
 * written. `home.rs` stores it as one `app_meta` row and validates the shape it writes rather
 * than the shape it reads, so this page can be handed a newer document, an older one, or a row
 * somebody edited by hand. A layout that cannot be understood costs the reader their arrangement;
 * it may never cost them the page.
 *
 * ## The grid
 *
 * Version 2 places every widget on a grid of square cells: `x`/`y` in cells from the top-left,
 * `w`/`h` in cells covered. **The column count is a fact about the window, and a stored layout
 * outlives the window it was arranged in** — so no function here assumes one. Each that needs it
 * takes `cols`, and {@link normalise} is what brings a document inside the grid it is about to be
 * drawn on. The rows are unbounded: the page grows downward.
 *
 * Five rules, each a way to get this wrong:
 *
 * * **A widget kind this build has never heard of is kept, not dropped.** `isWidgetKind` is how a
 *   *renderer* decides what to draw; {@link parseLayout} is not a renderer.
 * * **A newer document's `version` is kept, and so are its widgets.** Writing is answered the
 *   other way: `home::store` refuses a version it does not write.
 * * **An empty widget list is a layout, not a missing document.** Only a value that is not a
 *   layout *at all* becomes {@link DEFAULT_LAYOUT}.
 * * **An entry that is not a widget is dropped; the document is not.**
 * * **A move or a resize that would overlap another widget changes nothing.** The page draws the
 *   refusal as a red ghost before the pointer is let go; the document never holds two widgets on
 *   one cell, so nothing downstream has to decide which one wins.
 */

import type { HomeLayout, HomeWidget } from "@/lib/ipc";

import { boundsOf, DEFAULT_LAYOUT, isWidgetKind, widgetMeta, type WidgetKind } from "./widgets";

/** The document version this build writes. `home::VERSION`. */
export const LAYOUT_VERSION = 2;

/** The narrowest grid the page is ever drawn on, in columns. Also the width a version-1 `span: 2`
 *  widget is upgraded to. */
export const MIN_COLUMNS = 8;

/** How far down {@link firstFree} looks before giving up and stacking at the foot. A page that
 *  genuinely has no room in its first two hundred rows is not a page anybody arranged. */
const SEARCH_ROWS = 200;

/** A rectangle of cells. */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A value read as a plain object, or `null`.
 *
 * `auditText.ts`'s `facts()` verbatim: `JSON.parse` admits `[]` and `"a string"` as readily as
 * `{}`, and both of the first two are `typeof === "object"`.
 */
export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A field read as a non-blank name, or `null`. */
function name(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** A stored cell count, or `null` when it is not a usable whole number `>= floor`. */
function cells(value: unknown, floor: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.round(value);
  return n >= floor ? n : null;
}

/** Do two rectangles share a cell? Edges that touch do not. */
export function overlaps(a: CellRect, b: CellRect): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/**
 * Is this rectangle inside a `cols`-wide grid and clear of every widget but `ignoreId`?
 *
 * `ignoreId` is the widget being moved or resized — its own current cells are not in its way.
 */
export function isFree(
  widgets: readonly (CellRect & { id?: string })[],
  rect: CellRect,
  cols: number,
  ignoreId?: string,
): boolean {
  if (rect.x < 0 || rect.y < 0 || rect.w < 1 || rect.h < 1 || rect.x + rect.w > cols) return false;
  return widgets.every(
    (widget) => (ignoreId !== undefined && widget.id === ignoreId) || !overlaps(rect, widget),
  );
}

/**
 * The first free top-left corner for a `w`×`h` rectangle, reading rows top to bottom and each row
 * left to right — which is where a reader looks for something that just arrived.
 *
 * A rectangle wider than the grid is placed at the grid's width. When nothing in
 * {@link SEARCH_ROWS} is free the answer is the row under everything, which is always free.
 */
export function firstFree(
  widgets: readonly (CellRect & { id?: string })[],
  w: number,
  h: number,
  cols: number,
): { x: number; y: number } {
  const wide = Math.min(w, cols);
  for (let y = 0; y < SEARCH_ROWS; y += 1) {
    for (let x = 0; x + wide <= cols; x += 1) {
      if (isFree(widgets, { x, y, w: wide, h }, cols)) return { x, y };
    }
  }
  return { x: 0, y: rowsUsed(widgets) };
}

/** How many rows the arrangement reaches down to. `0` for an empty page. */
export function rowsUsed(widgets: readonly CellRect[]): number {
  return widgets.reduce((deepest, widget) => Math.max(deepest, widget.y + widget.h), 0);
}

/**
 * A footprint brought inside a kind's bounds and the grid's width.
 *
 * The grid clamp comes last on the width, so a kind whose floor is wider than a very narrow grid
 * still fits the grid — a widget that cannot be placed at all would be a widget that vanished.
 */
export function bounded(kind: string, w: number, h: number, cols: number): [number, number] {
  const { min, max } = boundsOf(kind);
  const wide = Math.min(cols, Math.max(min[0], Math.min(max[0], Math.round(w))));
  const tall = Math.max(min[1], Math.min(max[1], Math.round(h)));
  return [Math.max(1, wide), Math.max(1, tall)];
}

/**
 * A layout brought inside the grid it is about to be drawn on.
 *
 * A widget left at `x: 13` on a page now eight columns wide would make CSS grid mint implicit
 * columns for it and squeeze every other widget into a sliver — so anything wider than the grid is
 * narrowed, anything past its right edge is pulled back in, anything outside its kind's bounds is
 * brought inside them, and anything that then collides with a widget **earlier in the list** is
 * re-placed at the first free spot. **Idempotent**: a layout that already fits is answered with
 * the same geometry, so this can run on every measurement.
 *
 * Earlier widgets keep their place and later ones move, which is the list's order doing the one
 * thing it still means on a grid: who was there first.
 */
export function normalise(widgets: readonly HomeWidget[], cols: number): HomeWidget[] {
  const placed: HomeWidget[] = [];
  for (const widget of widgets) {
    const [w, h] = bounded(widget.kind, widget.w, widget.h, cols);
    const rect = {
      ...widget,
      w,
      h,
      x: Math.max(0, Math.min(Math.round(widget.x), cols - w)),
      y: Math.max(0, Math.round(widget.y)),
    };
    if (isFree(placed, rect, cols)) {
      placed.push(rect);
      continue;
    }
    placed.push({ ...rect, ...firstFree(placed, w, h, cols) });
  }
  return placed;
}

/** Do two widget lists hold the same widgets at the same cells, in the same order? */
export function sameGeometry(a: readonly HomeWidget[], b: readonly HomeWidget[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (widget, i) =>
        widget.id === b[i].id &&
        widget.x === b[i].x &&
        widget.y === b[i].y &&
        widget.w === b[i].w &&
        widget.h === b[i].h,
    )
  );
}

/**
 * The version-1 width an older build reads — `1` a column, `2` the whole row.
 *
 * **Written, never read**, except by {@link parseLayout}'s upgrade. More than half of the
 * narrowest grid is the whole row in that build's two-column page.
 */
export function spanFor(w: number): 1 | 2 {
  return w > MIN_COLUMNS / 2 ? 2 : 1;
}

/** One entry read as a widget, or `null` when it is not one. Geometry is `null` for an entry that
 *  was never placed on the grid — a version-1 widget. */
function parseWidget(
  value: unknown,
): { widget: Omit<HomeWidget, "x" | "y" | "w" | "h">; rect: CellRect | null } | null {
  const entry = record(value);
  if (entry === null) return null;
  const id = name(entry.id);
  const kind = name(entry.kind);
  if (id === null || kind === null) return null;
  const x = cells(entry.x, 0);
  const y = cells(entry.y, 0);
  const w = cells(entry.w, 1);
  const h = cells(entry.h, 1);
  const span = cells(entry.span, 1);
  return {
    // `kind` is *not* checked against `isWidgetKind` — see the module doc. `config` is opaque and
    // carried through exactly as stored.
    widget: { id, kind, config: entry.config ?? null, ...(span === null ? {} : { span }) },
    rect: x === null || y === null || w === null || h === null ? null : { x, y, w, h },
  };
}

/** A structural copy, so no caller can reach into {@link DEFAULT_LAYOUT} or into the layout it
 *  was handed. `config` is shared by reference: it is opaque and every write replaces it. */
export function copy(layout: HomeLayout): HomeLayout {
  return { ...layout, widgets: layout.widgets.map((entry) => ({ ...entry })) };
}

/**
 * The stored document, read defensively — **never throws, and never the default for a document
 * it merely disagrees with**.
 *
 * The default is answered for a value that is not a layout at all: `null`, a number, a string, an
 * array, `{}`, a `widgets` that is not an array. Everything else is a layout, including one
 * holding no widgets and one at a version this build does not write.
 *
 * **A widget with no usable geometry is placed, not dropped.** That is every widget of a
 * version-1 document — the page this build replaced — and the upgrade keeps the reader's widgets
 * in the order they arranged them: each takes its kind's own footprint (a `span: 2` widget the
 * whole of the narrowest grid) at the first free cell after the ones before it. A document that
 * arrives at version 1 leaves at {@link LAYOUT_VERSION}, because what it now holds is a grid.
 *
 * The result is **not** normalised against a column count — this runs before any window has been
 * measured. The page normalises it against the grid it draws.
 */
export function parseLayout(value: unknown): HomeLayout {
  const document = record(value);
  if (document === null || !Array.isArray(document.widgets)) return copy(DEFAULT_LAYOUT);
  const stored =
    typeof document.version === "number" && Number.isFinite(document.version)
      ? document.version
      : LAYOUT_VERSION;
  const entries = document.widgets
    .map(parseWidget)
    .filter((parsed): parsed is NonNullable<typeof parsed> => parsed !== null);
  // **Placed widgets claim their cells before any unplaced one is flowed in**, so a hand-edited
  // document mixing the two cannot hand a reader-arranged widget's cells to an entry that never
  // had any — `normalise` would then move the arranged one, which is backwards.
  const placed: HomeWidget[] = entries.flatMap((parsed) =>
    parsed.rect === null ? [] : [{ ...parsed.widget, ...parsed.rect }],
  );
  const taken: HomeWidget[] = [...placed];
  const widgets = entries.map((parsed): HomeWidget => {
    if (parsed.rect !== null) return { ...parsed.widget, ...parsed.rect };
    const { def } = boundsOf(parsed.widget.kind);
    // A version-1 page had two widths, and anything past the first was the whole row.
    const [w, h] =
      (parsed.widget.span ?? 1) >= 2
        ? bounded(parsed.widget.kind, MIN_COLUMNS, def[1], MIN_COLUMNS)
        : bounded(parsed.widget.kind, def[0], def[1], MIN_COLUMNS);
    const widget = { ...parsed.widget, w, h, ...firstFree(taken, w, h, MIN_COLUMNS) };
    taken.push(widget);
    return widget;
  });
  return { version: Math.max(stored, LAYOUT_VERSION), widgets };
}

/**
 * The document as it is written: every widget carrying the version-1 `span` an older build reads.
 * `useHomeLayout` runs every write through this, so no function above has to remember it.
 */
export function toStored(layout: HomeLayout): HomeLayout {
  return {
    ...layout,
    widgets: layout.widgets.map((entry) => ({ ...entry, span: spanFor(entry.w) })),
  };
}

/**
 * The same layout with one more widget of this kind, at its own footprint, at the first free cell.
 *
 * The id is minted rather than taken from the kind, because a reader may pin two sets of decks in
 * two `decks` widgets — see {@link newWidgetId}. The config is `null`, which is what "this widget
 * has not been configured" is spelled as everywhere.
 */
export function addWidget(layout: HomeLayout, kind: WidgetKind, cols: number): HomeLayout {
  const { def } = widgetMeta(kind);
  const [w, h] = bounded(kind, def[0], def[1], cols);
  const added: HomeWidget = {
    id: newWidgetId(kind, layout),
    kind,
    w,
    h,
    ...firstFree(layout.widgets, w, h, cols),
    config: null,
  };
  return { ...layout, widgets: [...layout.widgets.map((entry) => ({ ...entry })), added] };
}

/** The same layout without the widget carrying this id. An id nothing carries removes nothing. */
export function removeWidget(layout: HomeLayout, id: string): HomeLayout {
  return {
    ...layout,
    widgets: layout.widgets.filter((entry) => entry.id !== id).map((entry) => ({ ...entry })),
  };
}

/**
 * The same layout with one widget's top-left corner moved.
 *
 * **Unchanged when the new cells are not free** — outside the grid, or under another widget. A
 * move onto the widget's own current cells is always free, so a drag that ends where it began is
 * a no-op rather than a refusal.
 */
export function moveWidget(
  layout: HomeLayout,
  id: string,
  x: number,
  y: number,
  cols: number,
): HomeLayout {
  const moving = layout.widgets.find((entry) => entry.id === id);
  if (moving === undefined) return copy(layout);
  // Whole cells only — a drag works in pixels, and a stored `x: 2.4` is a cell nothing can draw.
  x = Math.round(x);
  y = Math.round(y);
  const rect = { x, y, w: moving.w, h: moving.h };
  if (!isFree(layout.widgets, rect, cols, id)) return copy(layout);
  return {
    ...layout,
    widgets: layout.widgets.map((entry) => (entry.id === id ? { ...entry, x, y } : { ...entry })),
  };
}

/**
 * The same layout with one widget's footprint changed, the top-left corner held.
 *
 * The footprint is brought inside the kind's bounds first, and **unchanged when the bounded cells
 * are not free** — the same refusal a move makes.
 */
export function resizeWidget(
  layout: HomeLayout,
  id: string,
  w: number,
  h: number,
  cols: number,
): HomeLayout {
  const resizing = layout.widgets.find((entry) => entry.id === id);
  if (resizing === undefined) return copy(layout);
  const [wide, tall] = bounded(resizing.kind, w, h, cols);
  const rect = { x: resizing.x, y: resizing.y, w: wide, h: tall };
  if (!isFree(layout.widgets, rect, cols, id)) return copy(layout);
  return {
    ...layout,
    widgets: layout.widgets.map((entry) =>
      entry.id === id ? { ...entry, w: wide, h: tall } : { ...entry },
    ),
  };
}

/**
 * The same layout with one widget's settings replaced.
 *
 * **Replaced and not merged** — a caller holding the whole config uses this; a caller changing
 * one field uses {@link patchConfig}.
 */
export function setConfig(layout: HomeLayout, id: string, config: unknown): HomeLayout {
  return {
    ...layout,
    widgets: layout.widgets.map((entry) => (entry.id === id ? { ...entry, config } : { ...entry })),
  };
}

/**
 * The same layout with some of one widget's settings changed and **every other stored key kept**
 * — including keys this build does not know, which is what stops an older build deleting a newer
 * one's settings. A config that is not an object (never configured, or junk) is replaced by the
 * fields.
 *
 * A field set to `undefined` is **removed**, which is how a cleared title goes back to the kind's
 * own name rather than being stored as a blank.
 */
export function patchConfig(
  layout: HomeLayout,
  id: string,
  fields: Record<string, unknown>,
): HomeLayout {
  return {
    ...layout,
    widgets: layout.widgets.map((entry) => {
      if (entry.id !== id) return { ...entry };
      const next: Record<string, unknown> = { ...(record(entry.config) ?? {}), ...fields };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete next[key];
      }
      return { ...entry, config: next };
    }),
  };
}

/**
 * Does this stored value have the shape the fallback names?
 *
 * Shallow by design: a primitive must match by `typeof`, an array must be an array whose elements
 * match the fallback's *first* element when it names one, a nested object must be some plain
 * object, and a `null` or `undefined` fallback accepts anything. **It cannot check a vocabulary.**
 */
function shapeMatches(value: unknown, shape: unknown): boolean {
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return false;
    const element: unknown = shape[0];
    if (element === undefined) return true;
    return value.every((item) => shapeMatches(item, element));
  }
  if (shape === null || shape === undefined) return true;
  if (typeof shape === "object") return record(value) !== null;
  return typeof value === typeof shape;
}

/**
 * One widget's settings, read as the shape the caller wants — **so a widget never has to guard**.
 *
 * The fallback is both the default *and* the schema. For an object fallback the answer is the
 * fallback with the stored fields laid over it one at a time, and a field is only taken when it
 * matches the shape the fallback names. **A stored key the fallback does not name is carried
 * through untouched.** Registry-declared picks and toggles are read through `widgetSettings.ts`
 * instead, which also checks the vocabulary.
 */
export function widgetConfig<T>(widget: HomeWidget, fallback: T): T {
  const stored: unknown = widget.config;
  const shape = record(fallback);
  if (shape === null) return shapeMatches(stored, fallback) ? (stored as T) : fallback;
  const config = record(stored);
  if (config === null) return fallback;
  const merged: Record<string, unknown> = { ...shape };
  for (const [key, value] of Object.entries(config)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      merged[key] = value;
      continue;
    }
    if (shapeMatches(value, shape[key])) merged[key] = value;
  }
  return merged as T;
}

/**
 * An id for a new widget of this kind that no widget already placed is using: the kind itself,
 * then `-2`, `-3`, and so on.
 */
export function newWidgetId(kind: WidgetKind, layout: HomeLayout): string {
  const taken = new Set(layout.widgets.map((entry) => entry.id));
  if (!taken.has(kind)) return kind;
  let n = 2;
  let id = `${kind}-${n}`;
  while (taken.has(id)) {
    n += 1;
    id = `${kind}-${n}`;
  }
  return id;
}

/** Re-exported for the page, which asks both questions of one stored kind. */
export { isWidgetKind };
