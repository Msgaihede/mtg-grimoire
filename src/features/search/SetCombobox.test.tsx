import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { SetSummary } from "@/lib/ipc";

// `vi.hoisted`, because `vi.mock` is hoisted above every `const` in this file and the
// factory runs the moment `./SetCombobox` pulls `@/lib/ipc` in.
const listSets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { listSets },
}));
import { SetCombobox } from "./SetCombobox";

const sets: SetSummary[] = [
  {
    code: "lea",
    name: "Limited Edition Alpha",
    setType: "core",
    releasedAt: "1993-08-05",
    cardCount: 295,
  },
  {
    code: "neo",
    name: "Kamigawa: Neon Dynasty",
    setType: "expansion",
    releasedAt: "2022-02-18",
    cardCount: 512,
  },
  { code: "tok", name: "Token Set", setType: "token", releasedAt: "2021-01-01", cardCount: 0 },
];

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
  return {
    ...view,
    // Testing Library's `rerender` replaces the *whole* tree, provider included, so it has
    // to be handed the wrapper again or the second render finds no QueryClient.
    rerender: (next: ReactElement) =>
      view.rerender(<QueryClientProvider client={qc}>{next}</QueryClientProvider>),
  };
}

describe("SetCombobox", () => {
  it("finds a set by name and by code, and shows its symbol", async () => {
    listSets.mockResolvedValue(sets);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));
    const box = screen.getByRole("textbox", { name: /set/i });

    await userEvent.type(box, "neon");
    expect(
      await screen.findByRole("option", { name: /Kamigawa: Neon Dynasty/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "lea");
    const alpha = await screen.findByRole("option", { name: /Alpha/ });
    // The keyrune glyph, from the bundled font — a set is recognised by its symbol long
    // before its three-letter code.
    expect(alpha.querySelector(".ss.ss-lea")).not.toBeNull();
  });

  /** `sets` carries every set Scryfall knows, including token-only ones `default_cards`
   *  holds nothing for. A picker full of sets that can never match is a worse picker. */
  it("leaves out sets the local database has no printings for", async () => {
    listSets.mockResolvedValue(sets);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));

    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Token Set/ })).not.toBeInTheDocument();
  });

  it("picks a set and shows it as picked", async () => {
    listSets.mockResolvedValue(sets);
    const onToggle = vi.fn();
    const { rerender } = wrap(<SetCombobox selected={[]} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Alpha/ }));
    expect(onToggle).toHaveBeenCalledWith("lea");

    rerender(<SetCombobox selected={["lea"]} onToggle={onToggle} />);
    expect(screen.getByRole("combobox", { name: /set/i })).toHaveTextContent("1 set");
  });

  it("closes on Escape", async () => {
    listSets.mockResolvedValue(sets);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  /**
   * ~700 sets have printings and the popup renders 50 of them, so without this the reader
   * is told there are two sets called "Commander" when there are twenty-five. The list is
   * the wrong place to fix that — a 700-row `<ul>` in a dropdown is a jank source — so the
   * cap is stated instead.
   */
  it("says so when it is showing only part of the matches", async () => {
    listSets.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({
        code: `s${i}`,
        name: `Set ${i}`,
        setType: "expansion",
        releasedAt: "2020-01-01",
        cardCount: 10,
      })),
    );
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));

    expect(await screen.findByText(/50 of 60/)).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(50);
  });

  /**
   * 441 keyrune classes against ~1 050 sets: a code with no glyph is the routine case, and
   * it must leave a row that reads normally rather than one with a hole in it.
   */
  it("still names a set keyrune has no symbol for", async () => {
    listSets.mockResolvedValue([
      {
        code: "zzz",
        name: "未来の拡張",
        setType: "expansion",
        releasedAt: "2030-01-01",
        cardCount: 7,
      },
    ]);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));

    const row = await screen.findByRole("option", { name: /未来の拡張/ });
    expect(row).toHaveTextContent("ZZZ");
  });
});
