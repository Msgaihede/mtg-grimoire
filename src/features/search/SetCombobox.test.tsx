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

/**
 * `n` sets named and coded by index — the list the paging tests need and the one the fixture
 * corpus cannot supply (31 sets, against a 100-row first page).
 *
 * The names double as an ordering assertion: the shared collator runs `numeric: true`, so the
 * first page really is `Set 0` … `Set 99` rather than `Set 0, Set 1, Set 10, Set 100`, and an
 * off-by-one in the slice shows up as a name rather than as a count.
 */
const manySets = (n: number): SetSummary[] =>
  Array.from({ length: n }, (_, i) => ({
    code: `s${i}`,
    name: `Set ${i}`,
    setType: "expansion",
    releasedAt: "2020-01-01",
    cardCount: 10,
  }));

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
   * ~700 sets have printings and the popup renders 100 of them, so without this the reader
   * is told there are two sets called "Commander" when there are twenty-five. The list is
   * the wrong place to fix that — a 700-row `<ul>` in a dropdown is a jank source — so the
   * page is stated instead, and the control beside the sentence is how the rest is reached.
   */
  it("says so when it is showing only part of the matches", async () => {
    listSets.mockResolvedValue(manySets(160));
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    expect(await screen.findByText(/100 of 160/)).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(100);
  });

  /**
   * The footer is a *page*, not a ceiling — and the button says the number it will really
   * add. Fifty on the first press and ten on the last, because a control that promises fifty
   * rows and delivers ten is a control the reader stops believing about anything else.
   *
   * The focus assertion is the other half: the caret has to stay in the search box or the
   * arrow keys stop working the moment the reader reaches for more with the mouse. It holds
   * because the button prevents its own `mousedown`, the same line every option row carries.
   */
  it("reveals the next page on request, and counts the last one honestly", async () => {
    listSets.mockResolvedValue(manySets(160));
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await userEvent.click(await screen.findByRole("button", { name: "Show 50 more" }));

    expect(screen.getAllByRole("option")).toHaveLength(150);
    expect(screen.getByText(/150 of 160/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /search sets/i })).toHaveFocus();

    // Ten left, so the button offers ten rather than another fifty.
    await userEvent.click(screen.getByRole("button", { name: "Show 10 more" }));

    expect(screen.getAllByRole("option")).toHaveLength(160);
    // Nothing left to show, so the footer goes with it rather than saying "160 of 160".
    expect(screen.queryByText(/of 160/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show \d+ more/ })).not.toBeInTheDocument();
  });

  /**
   * A new query is a new list, and how deep the reader had paged into the old one means
   * nothing in it — 150 rows of the *previous* answer's depth carried into a fresh search is
   * 150 rows nobody asked for, and the reader has no way to tell they are looking at page
   * three of something they just started.
   */
  it("goes back to the first page when the query changes", async () => {
    listSets.mockResolvedValue(manySets(160));
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    await userEvent.click(await screen.findByRole("button", { name: "Show 50 more" }));
    expect(screen.getAllByRole("option")).toHaveLength(150);

    // Every name contains an "s", so the match count is unchanged and only the paging moved.
    await userEvent.type(screen.getByRole("combobox", { name: /search sets/i }), "s");

    expect(screen.getAllByRole("option")).toHaveLength(100);
    expect(screen.getByText(/100 of 160/)).toBeInTheDocument();
  });

  /**
   * The mouse's way past the bottom is a button; the keyboard's is the arrow that was already
   * pointing at it. Without this, a reader who never touches the mouse is capped at 100 sets
   * with no sign that there are more — Tab would reach the button, but Tab out of the search
   * field is also how this popup is dismissed everywhere else in the app.
   *
   * Driven with `user.keyboard` against the already-focused field rather than `user.type`,
   * which focuses whatever it is handed and would pass whether or not the caret had stayed
   * where the component put it.
   */
  it("walks the keyboard off the end of a page and onto the next one", async () => {
    listSets.mockResolvedValue(manySets(105));
    const onToggle = vi.fn();
    wrap(<SetCombobox selected={[]} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(await screen.findAllByRole("option")).toHaveLength(100);
    const box = screen.getByRole("combobox", { name: /search sets/i });

    // End goes to the end of what is drawn; the arrow past it asks for the rest.
    await userEvent.keyboard("{End}{ArrowDown}");

    expect(screen.getAllByRole("option")).toHaveLength(105);
    const active = document.getElementById(box.getAttribute("aria-activedescendant") ?? "");
    expect(active).toHaveTextContent("Set 100");
    // And the revealed row is a real option, not just a rendered one.
    await userEvent.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledWith("s100");
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
   *
   * The rank is the *third* key, under "picked" and "has printings in this search", and above
   * the alphabet — so what follows the exact match is A, L, O and not the release order the
   * backend answered in. That last clause is the part that changed: the old sort leaned on
   * `Array#sort` being stable to keep `list_sets`'s newest-first order inside each rank, and
   * nothing about the picker's order is decided by the backend any more.
   */
  it("puts an exact code match first, then the rest alphabetically", async () => {
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
    // The rest are still offered, alphabetically — which here is the exact reverse of the
    // 2012/1999/1997 order they arrived in, so a sort that quietly stopped running would
    // fail this rather than pass it by coincidence.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Limited Edition Alpha"),
      expect.stringContaining("Arena League 1999"),
      expect.stringContaining("League Tokens 2012"),
      expect.stringContaining("Oversized League Prizes"),
    ]);
  });

  /**
   * **Picked first, whatever the alphabet says.** The list is paged, and a set the reader has
   * already ticked must never sit past the end of the page: they could neither see that it
   * was on nor reach it to turn it off, and the button above would go on counting a filter
   * with no visible source. Zendikar Rising is the worst case in one row — last alphabetically
   * of the three, and first on screen because it is on.
   */
  it("keeps a picked set at the top even when it sorts last", async () => {
    listSets.mockResolvedValue([
      {
        code: "afr",
        name: "Adventures in the Forgotten Realms",
        setType: "expansion",
        releasedAt: "2021-07-23",
        cardCount: 281,
      },
      {
        code: "mid",
        name: "Innistrad: Midnight Hunt",
        setType: "expansion",
        releasedAt: "2021-09-24",
        cardCount: 277,
      },
      {
        code: "znr",
        name: "Zendikar Rising",
        setType: "expansion",
        releasedAt: "2020-09-25",
        cardCount: 280,
      },
    ]);
    wrap(<SetCombobox selected={["znr"]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Zendikar Rising"),
      expect.stringContaining("Adventures in the Forgotten Realms"),
      expect.stringContaining("Innistrad: Midnight Hunt"),
    ]);
  });

  /**
   * **The other half of that rule: the float is a snapshot, so the list never moves under the
   * press that is using it.**
   *
   * Ordering on the live `selected` would send a row to the top *because it was just clicked*,
   * and this is a multi-select the reader works down with the mouse — so the second set they
   * wanted would no longer be where they were looking and the next click would land on
   * whatever slid up. The rows already refuse to disturb the keyboard (`onMouseDown`
   * preventDefault); refusing to disturb the mouse is the same promise.
   *
   * Nothing else can move a row on a pick either, which is what makes one snapshot enough:
   * `facets::compute` skips the dimension it counts, so ticking a set changes no set's count.
   */
  it("does not move a set under the press that picks it", async () => {
    listSets.mockResolvedValue([
      {
        code: "afr",
        name: "Adventures in the Forgotten Realms",
        setType: "expansion",
        releasedAt: "2021-07-23",
        cardCount: 281,
      },
      {
        code: "mid",
        name: "Innistrad: Midnight Hunt",
        setType: "expansion",
        releasedAt: "2021-09-24",
        cardCount: 277,
      },
      {
        code: "znr",
        name: "Zendikar Rising",
        setType: "expansion",
        releasedAt: "2020-09-25",
        cardCount: 280,
      },
    ]);
    const onToggle = vi.fn();
    const { rerender } = wrap(<SetCombobox selected={[]} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole("button", { name: "Set" }));
    const opened = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(opened).toEqual([
      expect.stringContaining("Adventures in the Forgotten Realms"),
      expect.stringContaining("Innistrad: Midnight Hunt"),
      expect.stringContaining("Zendikar Rising"),
    ]);

    await userEvent.click(screen.getByRole("option", { name: /Zendikar/ }));
    expect(onToggle).toHaveBeenCalledWith("znr");
    // The control is controlled: the parent commits the pick while the popup is still open,
    // which is the render the old ordering would have reshuffled.
    rerender(<SetCombobox selected={["znr"]} onToggle={onToggle} />);

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(opened);
    expect(screen.getByRole("option", { name: /Zendikar/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Re-opening is what re-takes the snapshot, and only then does it float.
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      expect.stringContaining("Zendikar Rising"),
      expect.stringContaining("Adventures in the Forgotten Realms"),
      expect.stringContaining("Innistrad: Midnight Hunt"),
    ]);
  });

  /**
   * **Greyed rows sink; the pickable ones above them stay alphabetical.** A row this search
   * has nothing in is still worth offering — it says the search has nothing there, which is
   * an answer — but it is not worth a place near the top of a paged list, and it is the last
   * thing that should be pushing a live set off the end of a page.
   *
   * The four here interleave under a plain A-Z (Adventures, Dominaria, The Brothers' War,
   * Zendikar), so a sort that dropped the facet level would fail this rather than tie with it.
   */
  it("sinks the sets this search has nothing in, alphabetical within each group", async () => {
    listSets.mockResolvedValue([
      {
        code: "bro",
        name: "The Brothers' War",
        setType: "expansion",
        releasedAt: "2022-11-18",
        cardCount: 287,
      },
      {
        code: "afr",
        name: "Adventures in the Forgotten Realms",
        setType: "expansion",
        releasedAt: "2021-07-23",
        cardCount: 281,
      },
      {
        code: "znr",
        name: "Zendikar Rising",
        setType: "expansion",
        releasedAt: "2020-09-25",
        cardCount: 280,
      },
      {
        code: "dmu",
        name: "Dominaria United",
        setType: "expansion",
        releasedAt: "2022-09-09",
        cardCount: 281,
      },
    ]);
    wrap(
      <SetCombobox selected={[]} onToggle={vi.fn()} counts={{ afr: 12, znr: 3, bro: 0, dmu: 0 }} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Set" }));

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Adventures in the Forgotten Realms"),
      expect.stringContaining("Zendikar Rising"),
      expect.stringContaining("Dominaria United"),
      expect.stringContaining("The Brothers' War"),
    ]);
    // Sunk, not dropped: they are still options, and still say why they cannot be pressed.
    expect(options[3]).toHaveAttribute("aria-disabled", "true");
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
    // Greyed rows sink, so the greyed one is the *second* row here and not the first —
    // Kamigawa opens under the cursor. One press down is the wall.
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onToggle).not.toHaveBeenCalled();

    await userEvent.keyboard("{ArrowUp}{Enter}");
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
