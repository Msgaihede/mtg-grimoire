import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

/**
 * **The board and its save are the board's own suites'.** This file is about the page around
 * them — the setup, the press that brings a board up over the screen, the way back to the setup,
 * Continue game and the question before a new game — so both stand in for themselves: the board
 * draws what it was handed and a way to leave, and the save is a summary this file decides.
 */
const saved = vi.hoisted(() => ({
  summary: null as null | {
    setup: import("@grimoire/ui/features/life/types").LifeSetup;
    savedAt: number;
    turnNo: number;
    players: number;
  },
  cleared: 0,
}));
vi.mock("@grimoire/ui/features/life/game/savedGame", () => ({
  peekSavedGame: () => saved.summary,
  clearSavedGame: () => {
    saved.cleared++;
    saved.summary = null;
  },
}));
vi.mock("@grimoire/ui/features/life/board/LifeBoard", () => ({
  LifeBoard: ({
    setup,
    resume,
    onLeave,
  }: {
    setup: import("@grimoire/ui/features/life/types").LifeSetup;
    resume: boolean;
    onLeave: () => void;
  }) => (
    <div role="application" aria-label="Life board">
      <span>{`${setup.players} players at ${setup.life}${resume ? ", resumed" : ""}`}</span>
      <button type="button" onClick={onLeave}>
        Leave the board
      </button>
    </div>
  ),
}));

import { DEFAULT_SETUP, setupFromFormat } from "@grimoire/ui/features/life/types";
import { SETUP_KEY } from "@grimoire/ui/features/life/setup/setupStore";
import { LAYER } from "@grimoire/ui/lib/layers";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

type Bridged = Window & { grimoireImmersive?: { setImmersive: (on: boolean) => void } };

const wasWide = window.innerWidth;
const wasHigh = window.innerHeight;
let immersive: ReturnType<typeof vi.fn<(on: boolean) => void>>;

beforeEach(() => {
  installLayout();
  window.localStorage.clear();
  saved.summary = null;
  saved.cleared = 0;
  // A phone upright: the seating a setup that has not picked one gets here is round the table.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 360 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 760 });
  // The Android host's bridge, stood in for: the page's one road to immersive full screen there.
  immersive = vi.fn<(on: boolean) => void>();
  (window as Bridged).grimoireImmersive = { setImmersive: immersive };
});
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: wasWide });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: wasHigh });
  delete (window as Bridged).grimoireImmersive;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const openLife = () => renderPhone(<PhoneFace />, { path: "/life" });
const board = () => screen.queryByRole("application", { name: "Life board" });
const group = (name: string) => screen.getByRole("group", { name });
const pressed = (name: string) =>
  within(group(name))
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.textContent);

describe("the Life tracker on the phone", () => {
  it("is a tab, and draws the setup inside the shell", () => {
    openLife();
    expect(screen.getByRole("heading", { level: 1, name: "Life" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Life" })).toHaveAttribute("aria-current", "page");

    // Commander's preset on a first run.
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Commander");
    expect(
      screen.getByText("Commander starts at 4 players · 40 life · commander damage."),
    ).toBeInTheDocument();
    expect(pressed("Players")).toEqual(["4"]);
    expect(pressed("Starting life")).toEqual(["40"]);
    expect(pressed("Seating")).toEqual(["Around the table"]);
    expect(screen.getByRole("button", { name: "A, Along two sides" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Commander damage" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByRole("switch", { name: "Commander damage lowers life" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start game" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue game/ })).toBeNull();
    expect(board()).toBeNull();
  });

  it("picks a format from its sheet, and says when the setup has left its defaults", async () => {
    const user = userEvent.setup();
    openLife();

    await user.click(screen.getByRole("button", { name: "Format" }));
    const sheet = await screen.findByRole("dialog", { name: "Format" });
    // The six presets, each with what it starts at; the one in force is pressed.
    expect(within(sheet).getByRole("button", { pressed: true })).toHaveTextContent(
      "Commander40 life · 4 players",
    );
    await user.click(within(sheet).getByRole("button", { name: /^Standard/ }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Format" })).toBeNull());
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Standard");
    expect(pressed("Players")).toEqual(["2"]);
    expect(pressed("Starting life")).toEqual(["20"]);
    // Two players have the one layout.
    expect(screen.getByText("The one layout for 2 players.")).toBeInTheDocument();

    await user.click(within(group("Players")).getByRole("button", { name: "3" }));
    expect(screen.getByText("Changed from Standard’s defaults.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(pressed("Players")).toEqual(["2"]);
    expect(screen.queryByRole("button", { name: "Reset to defaults" })).toBeNull();
  });

  it("takes a custom starting life of up to seven digits", async () => {
    const user = userEvent.setup();
    openLife();
    const custom = screen.getByRole("textbox", { name: "Custom starting life" });

    await user.type(custom, "12a34567890");
    expect(custom).toHaveValue("1234567");
    expect(pressed("Starting life")).toEqual([]);

    await user.click(within(group("Starting life")).getByRole("button", { name: "25" }));
    expect(custom).toHaveValue("");
    expect(pressed("Starting life")).toEqual(["25"]);
  });

  it("keeps the setup on this device for the next time", async () => {
    const user = userEvent.setup();
    openLife();
    await user.click(within(group("Players")).getByRole("button", { name: "5" }));
    await user.click(within(group("Seating")).getByRole("button", { name: "Facing one way" }));
    expect(JSON.parse(window.localStorage.getItem(SETUP_KEY) ?? "null")).toMatchObject({
      players: 5,
      seating: "screen",
    });
  });

  it("opens on the setup it kept", () => {
    window.localStorage.setItem(
      SETUP_KEY,
      JSON.stringify({ ...setupFromFormat("brawl"), players: 5, seating: "screen" }),
    );
    openLife();
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Brawl");
    expect(pressed("Players")).toEqual(["5"]);
    expect(pressed("Starting life")).toEqual(["25"]);
    expect(pressed("Seating")).toEqual(["Facing one way"]);
    // Facing one way there is one grid, and no A or B to pick.
    expect(
      screen.getByText("Every panel upright, arranged to fit this window."),
    ).toBeInTheDocument();
  });

  it("reads a kept setup it does not trust field by field", () => {
    window.localStorage.setItem(
      SETUP_KEY,
      JSON.stringify({ ...DEFAULT_SETUP, players: 9, life: 25, format: "vintage" }),
    );
    openLife();
    // The bad fields are the defaults'; the good one is kept.
    expect(pressed("Players")).toEqual(["4"]);
    expect(pressed("Starting life")).toEqual(["25"]);
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Commander");
  });

  it("puts the board over the screen on Start game, immersive, and back to the setup on leaving", async () => {
    const user = userEvent.setup();
    openLife();
    await user.click(screen.getByRole("button", { name: "Start game" }));

    expect(board()).toHaveTextContent("4 players at 40");
    expect(board()).not.toHaveTextContent("resumed");
    // Over the header and the tab bar: the frame is fixed to the screen at the stage rung.
    const frame = screen.getByTestId("life-board-frame");
    expect(frame).toHaveClass("fixed", "inset-0", LAYER.stage);
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    // Immersive from the press itself, through the host's bridge.
    expect(immersive.mock.calls).toEqual([[true]]);

    await user.click(screen.getByRole("button", { name: "Leave the board" }));
    expect(board()).toBeNull();
    expect(screen.getByRole("button", { name: "Start game" })).toBeInTheDocument();
    expect(immersive.mock.calls).toEqual([[true], [false]]);
  });

  it("gives the bars back when the page goes with the board up", async () => {
    const user = userEvent.setup();
    const view = openLife();
    await user.click(screen.getByRole("button", { name: "Start game" }));
    expect(immersive).toHaveBeenLastCalledWith(true);

    view.unmount();
    expect(immersive).toHaveBeenLastCalledWith(false);
  });

  it("offers the saved game, and continues it as it was set up", async () => {
    saved.summary = {
      setup: { ...setupFromFormat("standard"), players: 3 },
      savedAt: 1_800_000_000_000,
      turnNo: 7,
      players: 3,
    };
    const user = userEvent.setup();
    openLife();

    const resume = screen.getByRole("button", { name: /Continue game/ });
    expect(resume).toHaveTextContent("3 players · turn 7");
    await user.click(resume);

    expect(board()).toHaveTextContent("3 players at 20, resumed");
    expect(saved.cleared).toBe(0);
  });

  it("asks before a new game over the saved one, and clears it only on a yes", async () => {
    saved.summary = { setup: DEFAULT_SETUP, savedAt: 1_800_000_000_000, turnNo: 2, players: 4 };
    const user = userEvent.setup();
    openLife();

    await user.click(screen.getByRole("button", { name: "Start game" }));
    const question = await screen.findByRole("dialog", { name: "Start a new game?" });
    expect(question).toHaveTextContent("The game in progress is lost.");
    await user.click(within(question).getByRole("button", { name: "Keep it" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Start a new game?" })).toBeNull(),
    );
    expect(saved.cleared).toBe(0);
    expect(board()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Start game" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Start a new game?" })).getByRole("button", {
        name: "Start new game",
      }),
    );
    expect(saved.cleared).toBe(1);
    expect(board()).toHaveTextContent("4 players at 40");
    expect(board()).not.toHaveTextContent("resumed");
  });
});
