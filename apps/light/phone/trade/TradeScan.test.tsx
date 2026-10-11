import { useState } from "react";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import type { CommandTable } from "@grimoire/fake/scope";
import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@grimoire/ui/features/scanner/fixtures";
import type {
  ScannerTrayRow,
  Trade,
  TradeLineInput,
  TradeSide,
} from "@grimoire/ui/lib/ipc";
import { installLayout, renderPhone } from "../testing";
import { TradeScan } from "./TradeScan";

/**
 * Generous on purpose, as the Scanner page's own suite is: these mount a whole page over the fake,
 * and a wait sized for an idle machine fails on a busy one for no reason a reader could act on.
 */
const SETTLE = { timeout: 12_000 };
vi.setConfig({ testTimeout: 45_000 });

/** The fixture tray's three rows that are not waiting on a pick — five copies. */
const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);
const [SAGA, TOMB, LOTUS] = RESOLVED;

const TRADE: Trade = {
  id: 5,
  name: "Trade 5",
  marketplace: "tcgplayer",
  rateMine: 100,
  rateTheirs: 100,
  status: "open",
  finishedBefore: false,
  outcome: null,
  createdAt: 1_760_000_000,
  closedAt: null,
  lines: [],
};

type AddLines = { id: number; side: TradeSide; lines: TradeLineInput[] };

/** The sheet as its host holds it: `open` and `side` are the host's, written by the two calls. */
function Host({
  startSide,
  startOpen,
  onClose,
  onSide,
}: {
  startSide: TradeSide;
  startOpen: boolean;
  onClose: () => void;
  onSide: (side: TradeSide) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const [side, setSide] = useState(startSide);
  return (
    <TradeScan
      open={open}
      trade={TRADE}
      side={side}
      onSide={(next) => {
        onSide(next);
        setSide(next);
      }}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
    />
  );
}

/**
 * The sheet over the fake, with the tray a test wants found there and the scanner's writes
 * watched. **`trade_add_lines` is answered here, not by the fake's own handler**: this file is
 * about what the sheet sends, and `add` is how a test answers it.
 */
function mount({
  tray = [],
  side = "theirs",
  open = true,
  add = () => undefined,
}: {
  tray?: ScannerTrayRow[];
  side?: TradeSide;
  open?: boolean;
  add?: (args: AddLines) => unknown;
} = {}) {
  const seen = {
    added: [] as AddLines[],
    trays: [] as ScannerTrayRow[][],
    commits: 0,
    holds: 0,
  };
  const onClose = vi.fn();
  const onSide = vi.fn();
  renderPhone(<Host startSide={side} startOpen={open} onClose={onClose} onSide={onSide} />, {
    path: "/",
    commands: (own: CommandTable) => {
      const call = (name: string, args?: unknown) =>
        (own[name] as (a: unknown) => unknown)(args ?? {});
      return {
        scanner_tray: () => tray,
        set_scanner_tray: (args: { rows: ScannerTrayRow[] }) => {
          seen.trays.push(args.rows);
          return call("set_scanner_tray", args);
        },
        scanner_tray_commit: () => {
          seen.commits += 1;
          throw new Error("the collection's commit is not the trade's");
        },
        scanner_hold: () => {
          seen.holds += 1;
          return call("scanner_hold");
        },
        trade_add_lines: (args: AddLines) => {
          seen.added.push(args);
          return add(args);
        },
      };
    },
  });
  return { seen, onClose, onSide };
}

const sheet = () => screen.findByRole("dialog", { name: "Scan cards" }, SETTLE);
const settled = () => new Promise<void>((done) => setTimeout(done, 20));

beforeEach(installLayout);
afterEach(async () => {
  // The page unmounted now, and a moment for whatever it left on the wire to land in this test.
  cleanup();
  await settled();
});

describe("the phone's trade scanner", () => {
  it("mounts no scanner while it is closed", async () => {
    const { seen } = mount({ open: false, tray: RESOLVED });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(seen.holds).toBe(0);
  });

  it("adds the scanned cards to the side it is on, each line marked as a scan, and closes", async () => {
    const { seen, onClose } = mount({ tray: RESOLVED, side: "theirs" });
    const panel = await sheet();
    expect(
      await within(panel).findByRole("heading", { name: "Scanned for their side, 5 copies" }, SETTLE),
    ).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Add 5 to their side" }));

    await waitFor(() => expect(seen.added).toHaveLength(1), SETTLE);
    expect(seen.added[0]).toEqual({
      id: 5,
      side: "theirs",
      lines: [
        { cardId: SAGA.cardId, finish: "nonfoil", quantity: 3, source: "scan" },
        { cardId: TOMB.cardId, finish: "foil", quantity: 1, source: "scan" },
        { cardId: LOTUS.cardId, finish: "nonfoil", quantity: 1, source: "scan" },
      ],
    });
    expect(seen.commits).toBe(0);
    // Nothing is left to decide, so the sheet closes, and the emptied tray is stored on the way.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), SETTLE);
    await waitFor(() => expect(seen.trays[seen.trays.length - 1]).toEqual([]), SETTLE);
  });

  it("switches the side with Scan onto, and the cards go to the side it is then on", async () => {
    const { seen, onSide } = mount({ tray: [LOTUS], side: "mine" });
    const panel = await sheet();
    const onto = within(panel).getByRole("group", { name: "Scan onto" });
    expect(within(onto).getByRole("button", { name: "You give" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await within(panel).findByRole("button", { name: "Add 1 to your side" }, SETTLE);

    await userEvent.click(within(onto).getByRole("button", { name: "They give" }));
    expect(onSide).toHaveBeenCalledTimes(1);
    expect(onSide).toHaveBeenCalledWith("theirs");
    expect(within(onto).getByRole("button", { name: "They give" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(
      await within(panel).findByRole("button", { name: "Add 1 to their side" }, SETTLE),
    );
    await waitFor(() => expect(seen.added).toHaveLength(1), SETTLE);
    expect(seen.added[0].side).toBe("theirs");
  });

  it("sends them to your side when that is the side it opened on", async () => {
    const { seen } = mount({ tray: [LOTUS], side: "mine" });
    const panel = await sheet();
    await userEvent.click(
      await within(panel).findByRole("button", { name: "Add 1 to your side" }, SETTLE),
    );
    await waitFor(() => expect(seen.added).toHaveLength(1), SETTLE);
    expect(seen.added[0].side).toBe("mine");
    expect(seen.added[0].lines).toEqual([
      { cardId: LOTUS.cardId, finish: "nonfoil", quantity: 1, source: "scan" },
    ]);
  });

  it("leaves a card that still needs a finish, says what went in a line, and stays open over it", async () => {
    const { seen, onClose } = mount({ tray: [NEEDS_A_FINISH_ROW, ...RESOLVED] });
    const panel = await sheet();
    await userEvent.click(
      await within(panel).findByRole(
        "button",
        { name: "Add 5 to their side · 1 needs a finish" },
        SETTLE,
      ),
    );
    await waitFor(() => expect(seen.added).toHaveLength(1), SETTLE);
    expect(seen.added[0].lines).toHaveLength(3);
    expect(await within(panel).findByText("Added 5 cards to their side.", {}, SETTLE)).toBeInTheDocument();
    const tray = within(panel).getByRole("region", { name: "Scanned for their side" });
    await waitFor(() => expect(within(tray).getAllByRole("listitem")).toHaveLength(1), SETTLE);
    // Exactly the rows that went are the rows that left, and that is what is stored.
    await waitFor(
      () => expect(seen.trays[seen.trays.length - 1]).toEqual([NEEDS_A_FINISH_ROW]),
      SETTLE,
    );
    expect(onClose).not.toHaveBeenCalled();
    // Why the rest cannot go is words under the press: a finger has no hover.
    expect(
      within(panel).getByRole("button", { name: "Add 0 to their side · 1 needs a finish" }),
    ).toHaveAccessibleDescription("Pick a finish for at least one card first");
  });

  it("keeps every card in the tray when the trade refuses them, and says the refusal", async () => {
    const { seen, onClose } = mount({
      tray: RESOLVED,
      add: () => {
        // A command's refusal reaches the page as a bare string.
        throw "This trade is finished. Reopen it to change it.";
      },
    });
    const panel = await sheet();
    await userEvent.click(
      await within(panel).findByRole("button", { name: "Add 5 to their side" }, SETTLE),
    );
    await waitFor(() => expect(seen.added).toHaveLength(1), SETTLE);
    const footer = within(panel).getByRole("button", { name: "Add 5 to their side" }).closest("footer");
    await waitFor(
      () =>
        expect(within(footer as HTMLElement).getByRole("alert")).toHaveTextContent(
          "This trade is finished. Reopen it to change it.",
        ),
      SETTLE,
    );
    const tray = within(panel).getByRole("region", { name: "Scanned for their side" });
    expect(within(tray).getAllByRole("listitem")).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(seen.trays).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("draws no folder and no deck: the tray's other act is Clear all…, worded for the side", async () => {
    mount({ tray: RESOLVED, side: "mine" });
    const panel = await sheet();
    await within(panel).findByRole("button", { name: "Add 5 to your side" }, SETTLE);
    expect(within(panel).queryByRole("button", { name: /^Folder:/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /to collection/ })).toBeNull();

    await userEvent.click(within(panel).getByRole("button", { name: "Tray actions" }));
    const actions = await screen.findByRole("dialog", { name: "Scanned cards" });
    expect(within(actions).queryByRole("button", { name: /Create deck/ })).toBeNull();
    await userEvent.click(within(actions).getByRole("button", { name: "Clear all…" }));
    expect(await screen.findByRole("dialog", { name: "Clear the tray" })).toHaveTextContent(
      "5 scanned copies will leave the tray without being added to your side.",
    );
  });

  it("says so when the tray already held cards as it opened, and nothing over an empty one", async () => {
    mount({ tray: RESOLVED });
    const panel = await sheet();
    expect(await within(panel).findByRole("note", {}, SETTLE)).toHaveTextContent(
      "5 cards were already in the scanner's tray. They are in this list and go onto their side with the rest.",
    );
    cleanup();
    await settled();
    mount({ tray: [] });
    const empty = await sheet();
    expect(
      await within(empty).findByText("Cards you scan appear here.", {}, SETTLE),
    ).toBeInTheDocument();
    expect(within(empty).queryByRole("note")).toBeNull();
  });

  it("lets the scanner go on the press that closes it", async () => {
    const { onClose } = mount({ tray: [LOTUS] });
    const panel = await sheet();
    await within(panel).findByRole("button", { name: "Add 1 to their side" }, SETTLE);
    await userEvent.click(within(panel).getByRole("button", { name: "Close the scanner" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Gone at once, not at the end of the panel's fade.
    expect(screen.queryByRole("region", { name: "Scanned for their side" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop scanning" })).toBeNull();
  });
});
