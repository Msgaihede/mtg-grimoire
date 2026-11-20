/**
 * How large the numbers are, and where they sit — every measurement the board draws a number by.
 *
 * **Measured for Geist Mono at weight 600** on the design canvas (2026-11-19): a character is
 * 0.58em wide, and a digit's ink runs from 0.125em to 0.865em down its line box — 0.74em high.
 * The fits below are written in those terms, so a number is placed by its ink and not by its line
 * box, which has a quarter of an em of air the eye does not count.
 *
 * **Every panel on a board shows its number at one size** ({@link commonSize}): the largest a
 * two-digit total can be in the board's smallest panel. A panel only goes below it when its own
 * number has more characters than fit there — the reader compares totals across the table at a
 * glance, and a leader drawn larger than the rest reads as a different kind of number.
 */
import { hubRoom, type HubRoom, type SeatPlan } from "./seating";

/** A character's width, in ems. */
export const CHAR = 0.58;
/** Where a digit's ink starts below the top of its line box, in ems. */
export const INK_TOP = 0.125;
/** A digit's ink height, in ems. */
export const INK_HIGH = 0.74;
/** The air between the number's ink and the line under it, in px. */
export const UNDER = 4;

/**
 * How much a panel's furniture — its chips, its − and + — is scaled up. Nothing grows on a phone,
 * where the largest panel is 376px on its shorter side; in a tablet or desktop window the same
 * things would be specks in the corners of a huge panel, so they grow with it, to 1.6 at most.
 */
export function grown(lw: number, lh: number): number {
  return Math.max(1, Math.min(1.6, Math.min(lw, lh) / 420));
}

/** The height kept under the number for its delta: 24 to 32px on a phone; taller in a large
 *  panel, where 32px under a number 400px high would be lost. */
export function underHigh(lw: number, lh: number): number {
  return Math.round(Math.max(24, Math.min(Math.max(32, Math.min(lw, lh) * 0.085), lh * 0.16)));
}

/**
 * The largest a number of `chars` characters can be in a panel of this shape, whatever else the
 * panel is showing.
 *
 * Two fits are tried and the larger wins: one that runs the full height and stays between the
 * corner chips (216px of them across), and one that sits under the top row (42px) and runs out
 * towards the − and +, leaving them some air (148px). The line under the number always has its
 * place. `keepTop` and `keepBottom` are what the menu button takes out of this panel
 * (`hubRoom`). On a phone no number over 260px looks right; in a large window the ceiling rises
 * to half the panel's shorter side.
 */
export function numberFit(
  lw: number,
  lh: number,
  chars: number,
  keepTop = 0,
  keepBottom = 0,
): number {
  const under = underHigh(lw, lh);
  const foot = Math.max(8, keepBottom);
  // The − and + grow on a large panel, and the number gives them the room.
  const wider = 104 * (grown(lw, lh) - 1);
  const fit = (top: number, clear: number) =>
    Math.min(
      (lw - clear - wider) / (CHAR * chars),
      (lh - Math.max(top, keepTop) - foot - under - 4) / INK_HIGH,
    );
  return Math.min(Math.max(260, Math.min(lw, lh) * 0.5), Math.max(fit(8, 216), fit(42, 148)));
}

/** The one size every panel's number is drawn at, before any panel's own characters. */
export function commonSize(plan: SeatPlan, W: number, H: number): number {
  let common = Infinity;
  for (const s of plan.seats) {
    const room = hubRoom(s, plan.hub, W, H);
    common = Math.min(common, numberFit(room.lw, room.lh, 2, room.top, room.bottom));
  }
  return common;
}

/**
 * How large one player's chips are: larger than a seat's at a full table, having the whole
 * screen, and growing again in a large window.
 */
export function chipZoom(players: number, lw: number, lh: number): number {
  return players === 1 ? Math.max(1.4, Math.min(1.9, Math.min(lw, lh) / 420)) : grown(lw, lh);
}

/** Where a panel's number goes, in its own turned frame. */
export interface NumberPlace {
  /** The font size, px. */
  size: number;
  /** The top margin of the number's line box. */
  top: number;
  /** The margin from the number's line box to the line under it (negative: it tucks up under
   *  the box's own air). */
  underLift: number;
  /** How far the − and + move down to stay level with one player's digits. */
  glyphDrop: number;
}

export interface NumberQuestion {
  lw: number;
  lh: number;
  /** The number's characters as drawn. */
  chars: number;
  /** {@link commonSize} for the board. */
  common: number;
  keep: HubRoom;
  /** The panel is one player's whole board (and not their commander damage view). */
  solo: boolean;
  /** With `solo`: the band of commander chips above the total is drawn. */
  commanderBand: boolean;
}

/**
 * The number's size and place.
 *
 * **One player's life total is the page**: its digits sit dead centre on the panel whatever is
 * above or below them, and are as large as fits there. Above is the menu button or, in a
 * Commander game, the band of commander chips (one row along the top edge on its side, under the
 * menu button with room for the tax to drop to a second row upright: 59 and 149px of chips at
 * their phone size). Below is the line under the number, then the edge or the menu button.
 */
export function placeNumber(q: NumberQuestion): NumberPlace {
  const { lw, lh, chars, keep } = q;
  const moved = underHigh(lw, lh);
  let size = Math.floor(
    Math.max(24, Math.min(q.common, numberFit(lw, lh, chars, keep.top, keep.bottom))),
  );
  const regionTop = Math.max(CHAR * chars * size <= lw - 216 ? 8 : 42, keep.top);
  const regionFoot = Math.max(8, keep.bottom);
  let inkTop = regionTop + (lh - regionTop - regionFoot - (INK_HIGH * size + UNDER + moved)) / 2;
  if (q.solo) {
    const zoom = chipZoom(1, lw, lh);
    const bandFoot = q.commanderBand ? Math.round(zoom * (lw > lh ? 59 : 149) + 4) : 0;
    const above = lh / 2 - Math.max(8, keep.top, bandFoot);
    const below = lh / 2 - Math.max(8, keep.bottom - 6) - UNDER - moved;
    size = Math.floor(
      Math.max(
        24,
        Math.min(numberFit(lw, lh, chars, 0, 0), (2 * Math.min(above, below)) / INK_HIGH),
      ),
    );
    inkTop = lh / 2 - (INK_HIGH * size) / 2;
  }
  return {
    size,
    top: round1(inkTop - INK_TOP * size),
    underLift: round1(UNDER - (1 - INK_TOP - INK_HIGH) * size),
    glyphDrop: q.solo ? Math.round(inkTop + (INK_HIGH * size) / 2 - lh / 2) : 0,
  };
}

/** The skull behind a dead seat's number. */
export function skullSize(lw: number, lh: number): number {
  return Math.round(Math.max(80, Math.min(Math.max(170, Math.min(lw, lh) * 0.45), lh * 0.82)));
}

/**
 * The visually hidden button laid over the number for a keyboard or a screen reader, which cannot
 * hold a press: as wide as the digits, and at least a finger's width.
 */
export function numberButtonWidth(lw: number, chars: number, size: number): number {
  return Math.round(Math.min(Math.max(64, lw * 0.4), 0.61 * chars * size + 12));
}

/** The life total inside a (not one-player) commander damage view, between its − and +. */
export function ownLifeSize(lw: number, lh: number, chars: number): number {
  return Math.floor(
    Math.max(24, Math.min((lh - 84 - underHigh(lw, lh)) * 0.95, (lw - 132) / (0.61 * chars), 120)),
  );
}

/**
 * One player's commander damage view: there is no opponent's panel to count each commander on, so
 * the player's own panel is split — a tile for each opponent's commander, and their own life with
 * the way back. On its side the opponents are a row across the top and the life box a strip at the
 * bottom; upright, they are stacked and the life box is under them.
 */
export interface SoloView {
  wide: boolean;
  top: number;
  foot: number;
  /** The life box's end of the view, before {@link grown}'s zoom. */
  ownHigh: number;
  zoom: number;
  tileW: number;
  tileH: number;
  /** A narrow tile keeps its − and + in its bottom corners, under the number. */
  tileStacked: boolean;
  /** The life total in the life box. */
  ownSize: number;
}

export function soloView(
  lw: number,
  lh: number,
  foes: number,
  keep: HubRoom,
  chars: number,
): SoloView {
  const wide = lw > lh;
  const top = wide ? 8 : Math.max(8, keep.top);
  const foot = Math.max(8, wide ? 0 : keep.bottom);
  const zoom = grown(lw, lh);
  const ownHigh = wide ? 140 : 180;
  const own = ownHigh * zoom;
  const count = Math.max(1, foes);
  const tileW = wide ? (lw - 16 - 8 * (foes - 1)) / count : lw - 16;
  const tileH = wide ? lh - top - foot - own - 8 : (lh - top - foot - own - 8 * foes) / count;
  const room = wide ? (lw / zoom - 116) / 2 - 136 : lw / zoom - 16 - 136;
  return {
    wide,
    top: round1(top),
    foot: round1(foot),
    ownHigh,
    zoom,
    tileW,
    tileH,
    tileStacked: tileW < 200,
    ownSize: Math.floor(Math.max(24, Math.min(wide ? 76 : 60, room / (0.61 * chars)))),
  };
}

/** One opponent tile's number. */
export function tileNumberSize(view: SoloView, digits: number): number {
  const d = Math.max(2, digits);
  const fits = view.tileStacked
    ? Math.min((view.tileW - 20) / (CHAR * d), view.tileH * 0.42)
    : Math.min((view.tileW - 124) / (CHAR * d), view.tileH * 0.6);
  return Math.floor(
    Math.max(24, Math.min(Math.max(120, Math.min(view.tileW, view.tileH) * 0.45), fits)),
  );
}

/** Pixels to a tenth, as the board writes every position. */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
