/**
 * What the notes widget has to get right, and every case here is a way it could be quietly wrong.
 *
 * **Nothing here replaces `@/lib/ipc` wholesale.** A `vi.mock` of that module rebuilds `ipc` out
 * of `vi.fn()`s and erases the mirror `ipc.test.ts` checks against the Rust structs, so the happy
 * paths seed the **query cache** under `stickyNotesKey` with `staleTime: Infinity` and no
 * `queryFn` ever runs. The two cases that are *about* a read — in flight, and refused — spread
 * the real module and replace one method.
 *
 * **The dialog is stubbed, and that is the point of stubbing it.** `StickyNoteDialog` mounts
 * `NoteEditor` behind a `lazy`, which is a ProseMirror instance and 141.5 kB of chunk; what this
 * file is about is *whether* the widget mounts it and for which note, and the real one would drag
 * the whole editor into a suite that has nothing to say about it. `tsc` is what keeps the props
 * honest.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stickyNotes = vi.hoisted(() => vi.fn());
const stickyNoteCreate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, stickyNotes, stickyNoteCreate } };
});

vi.mock("../StickyNoteDialog", () => ({
  StickyNoteDialog: ({ note }: { note: { id: number; title: string } }) => (
    <div data-testid="dialog">{`Editing ${note.title}`}</div>
  ),
}));

/**
 * `pickOf` cannot answer for a kind `widgets.ts` has never heard of, and the `stickyNotes`
 * registry row lands with the page's switch — one file this body does not own.
 *
 * So the real function is asked **first** and the stored word is only read when it has nothing to
 * say. The day the row lands this mock stops doing anything at all, which is what keeps the case
 * below a case about the widget's own reading of the pick rather than about the stand-in.
 */
vi.mock("../widgetSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../widgetSettings")>();
  return {
    ...actual,
    pickOf: (widget: HomeWidget, key: string) =>
      actual.pickOf(widget, key) ??
      ((widget.config as Record<string, unknown> | null) ?? {})[key],
  };
});

import type { HomeWidget, StickyNote } from "@/lib/ipc";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { stickyNotesKey } from "../keys";
import {
  boardGeometry,
  EMPTY_BLURB,
  EMPTY_TITLE,
  railChips,
  StickyNotesWidget,
  tileColumns,
  tileScale,
} from "./StickyNotesWidget";

/** Now, in whole seconds — so a fixture can say "two days ago" and the drawn sentence agrees. */
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function note(over: Partial<StickyNote> & { id: number }): StickyNote {
  return {
    title: `Note ${over.id}`,
    body: "",
    color: "slate",
    pinned: false,
    sortOrder: over.id,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * DAY,
    ...over,
  };
}

/** Eight notes, which is more than any footprint below draws — so a cut is always a real cut. */
const NOTES: StickyNote[] = [
  note({ id: 1, title: "Trade night — Friday", body: "Bring the binder", color: "amber", pinned: true }),
  note({ id: 2, title: "Bracket 3 — house rules", body: "No two-card infinites", color: "jade" }),
  note({ id: 3, title: "Cards to proxy", body: "Testing the Atraxa list", color: "azure" }),
  note({ id: 4, title: "Sealed box math", body: "EV per box at 92 EUR", color: "slate" }),
  note({ id: 5, title: "Wishlist — birthday", body: "The short version", color: "rose" }),
  note({ id: 6, title: "Sleeve stock", body: "Two packs left", color: "slate" }),
  note({ id: 7, title: "Draft archetypes", body: "Blue-black control", color: "jade" }),
  note({ id: 8, title: "Deck ideas — Atraxa", body: "Counters, on creatures", color: "azure" }),
];

function widget(config: unknown = null, w = 4, h = 3): HomeWidget {
  return { id: "stickyNotes", kind: "stickyNotes", x: 0, y: 0, w, h, config };
}

/** A footprint drawn at the grid's target cell — the size the page aims its columns at. */
function fitFor(w: number, h: number): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: spanPx(w, 104),
    heightPx: spanPx(h, 104),
    density: "comfortable",
  });
}

/**
 * The tiles' accessible names, in the order the board drew them.
 *
 * Read off `aria-label`, which is the whole of each name — the case below that asserts
 * `toHaveAccessibleName` is what proves that, and this one is about **order**.
 */
function names(): string[] {
  return within(screen.getByRole("list", { name: "Your notes" }))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "");
}

/** The coloured edge across a tile's top — the one element painted in a `-strip` property. */
function strips(tile: HTMLElement): HTMLElement[] {
  return Array.from(tile.querySelectorAll<HTMLElement>("span")).filter((span) =>
    span.style.background.endsWith("-strip)"),
  );
}

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw({
  config = null,
  w = 4,
  h = 3,
  still = false,
  editing = false,
  notes = NOTES,
  seed = true,
}: {
  config?: unknown;
  w?: number;
  h?: number;
  still?: boolean;
  editing?: boolean;
  notes?: StickyNote[];
  seed?: boolean;
} = {}) {
  if (seed) qc.setQueryData(stickyNotesKey, notes);
  return render(
    <StickyNotesWidget
      widget={widget(config, w, h)}
      fit={fitFor(w, h)}
      editing={editing}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  stickyNotes.mockReset().mockResolvedValue([]);
  stickyNoteCreate.mockReset().mockResolvedValue(9);
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
});

/* ------------------------------------------------------------------ geometry ----------- */

describe("tileColumns", () => {
  // The spec's three targets: two at 2×2, three at 4×3, four at 6×3. The numbers are the body's
  // measured width at each of those footprints, cell 104.
  it("is two at 2×2, three at 4×3 and four at 6×3", () => {
    expect(tileColumns(fitFor(2, 2).bodyWidthPx)).toBe(2);
    expect(tileColumns(fitFor(4, 3).bodyWidthPx)).toBe(3);
    expect(tileColumns(fitFor(6, 3).bodyWidthPx)).toBe(4);
  });

  it("floors at two and caps at four", () => {
    expect(tileColumns(0)).toBe(2);
    expect(tileColumns(80)).toBe(2);
    expect(tileColumns(4_000)).toBe(4);
  });
});

describe("boardGeometry", () => {
  // Read off the artboards: a 2×2 board is four 96×67 tiles of two preview lines, and a 6×3 is
  // eight tiles of five. A drift here is a drift from the design, not a rounding difference.
  it("reproduces the artboards' rows, tile height and preview lines", () => {
    expect(boardGeometry(fitFor(2, 2), false)).toMatchObject({
      columns: 2,
      rows: 2,
      rowHeight: 68,
      lines: 2,
      tiles: 4,
    });
    expect(boardGeometry(fitFor(6, 3), false)).toMatchObject({
      columns: 4,
      rows: 2,
      rowHeight: 126,
      lines: 5,
      tiles: 8,
    });
  });

  // One tall row rather than two short ones, which is what makes the preview six lines there and
  // five on the card twice its height — the tile is stretched into the rows that fit.
  it("spreads a single row over the whole box", () => {
    const geometry = boardGeometry(fitFor(4, 2), false);
    expect(geometry.rows).toBe(1);
    expect(geometry.lines).toBe(6);
  });

  it("spends a preview line on the edited date when it is drawn", () => {
    expect(boardGeometry(fitFor(6, 3), true).lines).toBe(4);
    expect(boardGeometry(fitFor(6, 3), false).lines).toBe(5);
  });

  // ⚠️ `fitCount` and never `linesFit`: zero rows is the answer for a card with room for no tile.
  it("answers zero rows for a card that fits none", () => {
    expect(boardGeometry(fitFor(4, 1), false)).toMatchObject({ rows: 0, tiles: 0 });
  });
});

describe("tileScale", () => {
  it("drops to the small scale on a two-cell card and holds everywhere else", () => {
    expect(tileScale(0).nameSize).toBeLessThan(tileScale(1).nameSize);
    expect(tileScale(1)).toEqual(tileScale(3));
  });
});

describe("railChips", () => {
  it("draws four names at a four-cell card", () => {
    expect(railChips(fitFor(4, 3).bodyWidthPx)).toBe(4);
    expect(railChips(0)).toBe(1);
  });
});

/* ------------------------------------------------------------------ the read ----------- */

describe("StickyNotesWidget", () => {
  it("says it is reading while the read is out", () => {
    stickyNotes.mockImplementation(() => new Promise(() => {}));
    draw({ seed: false });
    expect(screen.getByText("Reading your notes…")).toBeInTheDocument();
  });

  it("says a refusal in the backend's words", async () => {
    stickyNotes.mockRejectedValue("the database is locked");
    draw({ seed: false });
    expect(
      await screen.findByText("Could not read your notes — the database is locked"),
    ).toBeInTheDocument();
  });

  it("says so when there are no notes, and offers the first one", async () => {
    draw({ notes: [] });
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.getByText(EMPTY_BLURB)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "New note" }));
    await waitFor(() => expect(stickyNoteCreate).toHaveBeenCalledWith("", "", "amber"));
  });

  // A catalogue preview writes nothing, so it does not offer a press that would.
  it("draws the empty card as a picture in a still", () => {
    draw({ notes: [], still: true });
    expect(screen.getByText(EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- the two layouts --- */

  it("draws the Board by default and the Pad when the pick says so", () => {
    const board = draw();
    expect(screen.getByRole("list", { name: "Your notes" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    board.unmount();

    draw({ config: { layout: "pad" } });
    expect(screen.getByRole("article", { name: "Trade night — Friday, pinned" })).toBeInTheDocument();
  });

  // ⚠️ Zero is a real answer. A card with room for no tile draws none — never one it clips.
  it("cuts tiles to whole rows and draws none rather than one it clips", () => {
    draw({ w: 4, h: 1 });
    const list = screen.getByRole("list", { name: "Your notes" });
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);
    // The footer still counts what is there, which is what tells "none fit" from "none exist".
    expect(screen.getByText("8 notes")).toBeInTheDocument();
  });

  it("draws exactly the tiles the footprint holds", () => {
    draw({ w: 6, h: 3 });
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
  });

  /* ---------------------------------------------------------------- one tile ---------- */

  // The column carries no CHECK on purpose, so a newer build's sixth colour arrives over sync and
  // has to draw as *something*.
  it("reads a colour it has never heard of as slate", () => {
    draw({ notes: [note({ id: 1, title: "Puce", color: "puce" })] });
    // The **inline** style, not a computed one: jsdom loads no stylesheet and resolves no custom
    // property, so what can be asserted here is the declaration the tile wrote.
    expect(screen.getByRole("button", { name: "Puce" }).style.background).toBe(
      "var(--color-note-slate)",
    );
  });

  it("paints a known colour from its own custom property", () => {
    draw({ notes: [note({ id: 1, title: "Amber", color: "amber" })] });
    expect(screen.getByRole("button", { name: "Amber" }).style.background).toBe(
      "var(--color-note-amber)",
    );
  });

  /**
   * ⚠️ The computed name, never the parts. A CSS `gap` is not a word separator to name
   * computation, so a tile named by its contents would read as the title and the preview run
   * together — and a test asserting the two texts separately passes over exactly that.
   */
  it("names the note's own words in the accessible name of its press", () => {
    draw();
    expect(screen.getByRole("button", { name: "Bracket 3 — house rules" })).toHaveAccessibleName(
      "Bracket 3 — house rules",
    );
    // The gold dot is decoration, so the pin is said in words or not at all.
    expect(screen.getByRole("button", { name: /Trade night/ })).toHaveAccessibleName(
      "Trade night — Friday, pinned",
    );
  });

  it("draws the edited date only while the toggle is on", () => {
    const on = draw();
    expect(screen.getAllByText("Edited 2 days ago").length).toBeGreaterThan(0);
    on.unmount();

    draw({ config: { dates: false } });
    expect(screen.queryByText("Edited 2 days ago")).not.toBeInTheDocument();
  });

  it("draws the colour strip only while the toggle is on", () => {
    const on = draw({ notes: [note({ id: 1, title: "Amber", color: "amber" })] });
    expect(strips(screen.getByRole("button", { name: "Amber" }))).toHaveLength(1);
    on.unmount();

    draw({ config: { strip: false }, notes: [note({ id: 1, title: "Amber", color: "amber" })] });
    expect(strips(screen.getByRole("button", { name: "Amber" }))).toHaveLength(0);
  });

  /**
   * Pinning is a lift and never a re-sort: the unpinned notes keep the order the reader dragged
   * them into. ⚠️ `sortOrder` is monotonic and never dense — `Late` below sits at 9 with nothing
   * between — so a fixture that assumed an index would pass over a widget that read one.
   */
  it("lifts the pinned note to the front, and leaves it alone when the toggle is off", () => {
    const notes = [
      note({ id: 1, title: "Early", sortOrder: 0 }),
      note({ id: 2, title: "Late", sortOrder: 9, pinned: true }),
    ];
    const on = draw({ notes });
    expect(names()).toEqual(["Late, pinned", "Early"]);
    on.unmount();

    // Switched off it is the **order** that goes back to `sortOrder`, and the note is still
    // pinned: the toggle is called *Pinned note first*, so it decides where a pin puts a note and
    // never whether the note wears one.
    draw({ config: { pinned: false }, notes });
    expect(names()).toEqual(["Early", "Late, pinned"]);
  });

  /* ---------------------------------------------------------------- the editor -------- */

  it("opens the editor on the note that was pressed", async () => {
    draw();
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cards to proxy" }));
    expect(screen.getByTestId("dialog")).toHaveTextContent("Editing Cards to proxy");
  });

  /**
   * ⚠️ A still is a picture of a widget at its default footprint. It must open no dialog and
   * mount no editor — a 141.5 kB chunk behind a thumbnail — and the way it cannot is that there
   * is nothing to press.
   */
  it("opens no dialog and mounts no editor while still", () => {
    draw({ still: true });
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
  });

  // Customize makes the whole card a drag handle. The page makes the body inert; drawing the
  // tiles as pictures is the same statement one layer up.
  it("draws pictures rather than presses while Customize is on", () => {
    draw({ editing: true });
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Trade night/ })).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- the Pad ----------- */

  it("opens the Pad on the pinned note and pages through the rest", async () => {
    draw({ config: { layout: "pad" }, w: 3, h: 3 });
    expect(screen.getByText("1 / 8")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next note" }));
    expect(screen.getByText("2 / 8")).toBeInTheDocument();
    expect(
      screen.getByRole("article", { name: "Bracket 3 — house rules" }),
    ).toBeInTheDocument();
  });

  it("carries the other notes on a rail of names at tier 2", async () => {
    draw({ config: { layout: "pad" }, w: 4, h: 3 });
    // Four names fit at a four-cell card; the rest are counted rather than drawn.
    expect(screen.getByRole("button", { name: "Sealed box math" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sleeve stock" })).not.toBeInTheDocument();
    expect(screen.getByText("+4")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cards to proxy" }));
    expect(screen.getByRole("article", { name: "Cards to proxy" })).toBeInTheDocument();
  });

  it("turns the rail into an index at tier 3", () => {
    draw({ config: { layout: "pad" }, w: 6, h: 3 });
    const index = screen.getByRole("list", { name: "Your notes" });
    expect(within(index).getAllByRole("listitem")).toHaveLength(7);
    expect(screen.queryByText(/\d \/ \d/)).not.toBeInTheDocument();
  });

  /**
   * ⚠️ `whitespace-pre-line`, asserted as a class rather than as a computed style: jsdom loads no
   * stylesheet, so the only thing here that can go red is the class being absent. A hard break
   * travels as a `"\n"` **inside** a text run, and without this rule the line boundary the reader
   * typed is drawn as a space.
   */
  it("sets whitespace-pre-line on the block container", () => {
    draw({
      config: { layout: "pad" },
      w: 6,
      h: 3,
      notes: [note({ id: 1, title: "Receipt", body: "30 packs\\\n11 rares" })],
    });
    const prose = screen.getByText("30 packs", { exact: false });
    const container = prose.closest(".whitespace-pre-line");
    expect(container).not.toBeNull();
    expect(container?.classList.contains("whitespace-pre-line")).toBe(true);
  });

  it("draws a note's blocks rather than its markdown", () => {
    draw({
      config: { layout: "pad" },
      w: 6,
      h: 3,
      notes: [
        note({
          id: 1,
          title: "Bracket 3",
          body: "## What the table agreed\n\n- No **two-card** infinites\n- Tutors capped",
        }),
      ],
    });
    const sheet = within(screen.getByRole("article", { name: "Bracket 3" }));
    expect(sheet.getByText("What the table agreed")).toBeInTheDocument();
    expect(sheet.getByText("two-card").tagName).toBe("STRONG");
    // Scoped to the sheet: the index beside it is a list of `<li>`s too.
    expect(sheet.getAllByRole("listitem")).toHaveLength(2);
  });
});
