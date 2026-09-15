/**
 * The prop shapes the home page is built from — **its own file because the page, the card chrome
 * and nine widget bodies are written independently**, and each needs these contracts from
 * somewhere none of them owns.
 *
 * The split is the grid redesign's: **the page draws every card's chrome and a widget draws only
 * its body.** Title, rename, the chip, the settings popover, remove, the grip and the resize corner
 * are identical for every kind, so they are `WidgetCard`'s and nine copies of them are gone. What a
 * widget is *about* — its data, its empty states, what fits in the box it was given, the rows a
 * reader can press — is the body's, and a body can be written and tested knowing nothing about
 * edit mode, drags or resizes.
 */
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { HomeWidget } from "@/lib/ipc";

import type { WidgetFit } from "./fit";

/**
 * Write some of this widget's settings back. The page merges the fields into the stored config and
 * **keeps every key it was not handed** — including a newer build's. A field set to `undefined` is
 * removed.
 */
export type ConfigPatch = (fields: Record<string, unknown>) => void;

/** One widget body — everything inside the card under its title row. */
export interface WidgetBodyProps {
  /** The stored entry. Read registry settings through `widgetSettings.ts` (`pickOf`, `toggleOn`),
   *  anything else through `widgetConfig` in `layout.ts` — never `widget.config` by hand. */
  widget: HomeWidget;
  /** The box this body is drawn in, and the whole-row arithmetic over it. */
  fit: WidgetFit;
  /**
   * Customize is on. **The page makes the body inert while it is**, so a press on a deck tile
   * picks the card up rather than opening the deck — a body needs to do nothing about it, and may
   * use it only to stop something it would otherwise start (a hover preview, say).
   */
  editing: boolean;
  /**
   * This is a catalogue preview: a picture of a widget of this kind at its default footprint.
   * **A still body writes nothing, opens nothing and publishes nothing** (no card walk, no
   * recorder), and its scrollers clip rather than scroll — a scroller behind
   * `pointer-events: none` is a bar a reader can see and cannot move.
   */
  still: boolean;
  onConfig: ConfigPatch;
}

/**
 * A kind's own settings beyond the rows its registry entry declares — the deck picker behind
 * `Pinned`, the Summary's figure checklist. Drawn at the foot of the settings popover.
 */
export interface WidgetSettingsProps {
  widget: HomeWidget;
  onConfig: ConfigPatch;
}

/**
 * The card every widget is drawn in — `WidgetCard.tsx`. The page supplies the geometry handlers;
 * the card owns the chrome and the two anchored popovers (settings, and the question that comes
 * before a remove).
 */
export interface WidgetCardProps {
  widget: HomeWidget;
  fit: WidgetFit;
  /** Customize is on: the grip, the title field, the tray and the resize corner are drawn. */
  editing: boolean;
  /** A catalogue preview: no tray even if `editing`, and the body clips rather than scrolls. */
  still?: boolean;
  /** This card is being dragged: drawn lifted, in the accent. */
  dragging?: boolean;
  /**
   * Whether this card can be moved and resized by pointer — `false` on a stacked (narrow) page,
   * where there is no grid to drop on. The size steppers in settings still work either way.
   */
  arrangeable?: boolean;
  /** A press anywhere on the card while editing, **except on an element carrying `data-no-drag`**
   *  — the tray, the title field, the resize corner. */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** A press on the resize corner. */
  onResizeStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** The grip's arrow keys: one cell in that direction. */
  onNudge?: (dx: number, dy: number) => void;
  /** The resize corner's arrow keys and the size steppers: one cell more or less. */
  onGrow?: (dw: number, dh: number) => void;
  /** Can the footprint change by this much — inside the kind's bounds and onto free cells? A
   *  stepper that cannot is `aria-disabled` and keeps its tab stop. */
  canGrow?: (dw: number, dh: number) => boolean;
  onConfig: ConfigPatch;
  /** Take the widget off the page. Called only after the reader answers the card's own question. */
  onRemove: () => void;
  /** The kind's {@link WidgetSettingsProps} component, already rendered. */
  extraSettings?: ReactNode;
  /** The body. */
  children: ReactNode;
}
