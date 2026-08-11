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

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    const box = screen.getByRole("combobox", { name: /search sets/i });

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

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Token Set/ })).not.toBeInTheDocument();
  });

  it("picks a set and shows it as picked", async () => {
    listSets.mockResolvedValue(sets);
    const onToggle = vi.fn();
    const { rerender } = wrap(<SetCombobox selected={[]} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await userEvent.click(await screen.findByRole("option", { name: /Alpha/ }));
    expect(onToggle).toHaveBeenCalledWith("lea");

    rerender(<SetCombobox selected={["lea"]} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: "Set" })).toHaveTextContent("1 set");
  });

  /**
   * Escape has to hand the caret back. The element it dismisses is the focused one, so
   * without this the reader is dropped onto `<body>` and the next Tab restarts at the top
   * of the app — three controls and a sidebar away from the filter they were setting.
   */
  it("closes on Escape and gives focus back to the button that opened it", async () => {
    listSets.mockResolvedValue(sets);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: "Set" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /search sets/i })).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  /** Tabbing past the picker would otherwise leave 288px of listbox hanging over the
   *  results, with the caret three controls further along the filter row. */
  it("closes when focus leaves it altogether", async () => {
    listSets.mockResolvedValue(sets);
    wrap(
      <>
        <SetCombobox selected={[]} onToggle={vi.fn()} />
        <button type="button">Next control</button>
      </>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await userEvent.tab();

    expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus();
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

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

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

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    const row = await screen.findByRole("option", { name: /未来の拡張/ });
    expect(row).toHaveTextContent("ZZZ");
  });

  /**
   * `filters.rs`'s `picked_sets` keeps at most `MAX_SET_FILTER` sets and silently truncates
   * past it,
   * so a 65th pick would leave the button claiming "65 sets" over results computed from
   * 64. The button is not allowed to say something the search will not do.
   */
  it("stops adding sets at the limit the backend enforces, and still lets one go", async () => {
    listSets.mockResolvedValue(sets);
    const onToggle = vi.fn();
    // 64 already picked, one of which is on screen.
    const atLimit = ["lea", ...Array.from({ length: 63 }, (_, i) => `s${i}`)];
    wrap(<SetCombobox selected={atLimit} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    const unpicked = await screen.findByRole("option", { name: /Kamigawa/ });
    expect(unpicked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(unpicked);
    expect(onToggle).not.toHaveBeenCalled();

    // Removing is the way out, so a picked row stays live.
    const picked = screen.getByRole("option", { name: /Alpha/ });
    expect(picked).not.toHaveAttribute("aria-disabled");
    await userEvent.click(picked);
    expect(onToggle).toHaveBeenCalledWith("lea");

    expect(screen.getByText(/64 sets is the most/i)).toBeInTheDocument();
  });

  /**
   * Typing a whole set code is an unambiguous request for that set, and it used to be the
   * one result you could not reach. The live data has seventeen sets whose *name* contains
   * "lea" — six League Tokens, nine Arena Leagues, Oversized League Prizes, and M15
   * Pre**relea**se Challenge — every one of them ahead of `lea` itself in release order,
   * and enough of them to push Limited Edition Alpha off the end of a capped list entirely.
   *
   * Ranked rather than filtered: the League sets are still real matches for someone who
   * meant them, they just are not what "lea" was typed to find.
   */
  it("puts an exact code match first, ahead of the sets that merely contain it", async () => {
    listSets.mockResolvedValue([
      {
        code: "l12",
        name: "League Tokens 2012",
        setType: "token",
        releasedAt: "2012-01-01",
        cardCount: 12,
      },
      {
        code: "pal99",
        name: "Arena League 1999",
        setType: "promo",
        releasedAt: "1999-01-01",
        cardCount: 9,
      },
      {
        code: "olep",
        name: "Oversized League Prizes",
        setType: "memorabilia",
        releasedAt: "1997-01-01",
        cardCount: 4,
      },
      {
        code: "lea",
        name: "Limited Edition Alpha",
        setType: "core",
        releasedAt: "1993-08-05",
        cardCount: 295,
      },
    ]);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await userEvent.type(screen.getByRole("combobox", { name: /search sets/i }), "lea");

    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("Limited Edition Alpha");
    // The rest are still offered, and in the order they arrived: the sort is stable, so
    // ranking never becomes a second, invisible re-ordering of everything else.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Limited Edition Alpha"),
      expect.stringContaining("League Tokens 2012"),
      expect.stringContaining("Arena League 1999"),
      expect.stringContaining("Oversized League Prizes"),
    ]);
  });

  /**
   * The middle rank, with the pair that actually collides: `pls` is Planeshift and `plst`
   * is The List, so typing the whole of one is also typing a prefix of the other. Whoever
   * typed `pls` meant Planeshift.
   */
  it("puts an exact code match ahead of a longer code that starts with it", async () => {
    listSets.mockResolvedValue([
      {
        code: "plst",
        name: "The List",
        setType: "masters",
        releasedAt: "2020-09-26",
        cardCount: 1400,
      },
      {
        code: "pls",
        name: "Planeshift",
        setType: "expansion",
        releasedAt: "2001-02-05",
        cardCount: 143,
      },
    ]);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await userEvent.type(screen.getByRole("combobox", { name: /search sets/i }), "pls");

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Planeshift"),
      expect.stringContaining("The List"),
    ]);
  });

  /**
   * **Greyed, not hidden.** The `cardCount > 0` filter above drops sets the corpus holds
   * nothing for, which is a fact about the database; this is a fact about the search the
   * reader is halfway through typing, and dropping those rows would make the list jump under
   * the cursor on every keystroke.
   *
   * The same `aria-disabled` treatment the `MAX_SETS` cap already uses, so the picker has one
   * vocabulary for unavailable rather than two.
   */
  it("greys a set this search has nothing in, and keeps it in the list", async () => {
    listSets.mockResolvedValue(sets);
    const onToggle = vi.fn();
    wrap(<SetCombobox selected={[]} onToggle={onToggle} counts={{ lea: 0, neo: 12 }} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    const alpha = await screen.findByRole("option", { name: /Alpha/ });
    expect(alpha).toHaveAttribute("aria-disabled", "true");
    expect(alpha).toHaveAttribute("title", "Limited Edition Alpha — nothing in this search");
    expect(screen.getByRole("option", { name: /Kamigawa/ })).not.toHaveAttribute("aria-disabled");

    await userEvent.click(alpha);
    expect(onToggle).not.toHaveBeenCalled();
  });

  /** The keyboard reaches the same rows, so it has to hit the same wall. Without this the
   *  list refuses the mouse and takes the Enter. */
  it("refuses a greyed set from the keyboard too", async () => {
    listSets.mockResolvedValue(sets);
    const onToggle = vi.fn();
    wrap(<SetCombobox selected={[]} onToggle={onToggle} counts={{ lea: 0, neo: 12 }} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await screen.findByRole("option", { name: /Alpha/ });
    // The cursor opens on the first row, which is the greyed one.
    await userEvent.keyboard("{Enter}");
    expect(onToggle).not.toHaveBeenCalled();

    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onToggle).toHaveBeenCalledWith("neo");
  });

  /** A picked set is never greyed however its count reads — unpicking it is the way out. And
   *  with no counts at all, nothing is greyed: not-greyed means "we don't know". */
  it("leaves a picked set live, and everything live with no counts", async () => {
    listSets.mockResolvedValue(sets);
    const { rerender } = wrap(
      <SetCombobox selected={["lea"]} onToggle={vi.fn()} counts={{ lea: 0, neo: 0 }} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(await screen.findByRole("option", { name: /Alpha/ })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("option", { name: /Kamigawa/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    rerender(<SetCombobox selected={["lea"]} onToggle={vi.fn()} />);
    expect(screen.getByRole("option", { name: /Kamigawa/ })).not.toHaveAttribute("aria-disabled");
  });
});
