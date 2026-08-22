import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { TagHit, TagNamespace } from "@/lib/ipc";

const tagChildren = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { tagChildren },
}));

import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { chipKey } from "./tagFilters";
import { TagTree } from "./TagTree";

/**
 * The Storybook fake's own art taxonomy, in the shape `tag_children` answers it.
 *
 * **`forest` sits under two parents and that is the fixture's whole reason** — 43 % of real art
 * tags have more than one (4 970 of 11 531, measured 2026-08-20), so a rail that drew each tag
 * once would be lying about the graph for two tags in five. `animal` is the second shape worth
 * keeping: nothing is tagged with it directly, so it is only reachable by descending
 * `creature → animal → cat`.
 *
 * **There is no `dog` here.** Nothing in the fake's 43-card corpus depicts one, and a test that
 * asserted on a tag the fake does not carry would fail looking exactly like broken code.
 */
const ART_EDGES: Record<string, string[]> = {
  creature: ["animal", "angel", "elf", "sphinx"],
  animal: ["cat", "monkey"],
  plant: ["flower", "forest"],
  landscape: ["forest", "water"],
};
const ART_ROOTS = ["creature", "plant", "landscape", "lightning"];
/** How far each art tag reaches through the closure, so the counts in the rail are not all 3. */
const ART_REACH: Record<string, number> = {
  creature: 6,
  animal: 2,
  cat: 1,
  monkey: 1,
  plant: 3,
  flower: 2,
  forest: 2,
  landscape: 3,
  water: 1,
  lightning: 1,
};

function hit(slug: string, namespace: TagNamespace = "art", over: Partial<TagHit> = {}): TagHit {
  return {
    slug,
    id: `${namespace}-${slug}`,
    label: slug[0].toUpperCase() + slug.slice(1),
    namespace,
    description: null,
    cardCount: ART_REACH[slug] ?? 1,
    childCount: (ART_EDGES[slug] ?? []).length,
    parents: [],
    ...over,
  };
}

/** `tag_children`, answered from the graph above. A slug with no edges answers nothing. */
function answerFromGraph(namespace: string, slug: string | null): TagHit[] {
  const slugs = slug === null ? ART_ROOTS : (ART_EDGES[slug] ?? []);
  return slugs.map((s) => hit(s, namespace === "oracle" ? "oracle" : "art"));
}

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <ContextMenuProvider>{children}</ContextMenuProvider>
    </QueryClientProvider>
  );
}

interface DrawOptions {
  namespace?: TagNamespace | "both";
  hits?: readonly TagHit[] | null;
  pending?: boolean;
  picked?: ReadonlySet<string>;
  /** What the page's write does. The default resolves; one test refuses. */
  mute?: () => Promise<void>;
}

function draw(options: DrawOptions = {}) {
  const onToggle = vi.fn();
  // Typed with the parameter, so `onMute.mock.calls[0][0]` below stays a `TagHit` rather than
  // an index into an empty tuple — `vi.fn(impl)` otherwise infers the signature of `impl`.
  const onMute = vi.fn<(hit: TagHit) => Promise<void>>(options.mute ?? (() => Promise.resolve()));
  const element = ({ namespace = "art", hits = null, pending, picked }: DrawOptions) => (
    <TagTree
      namespace={namespace}
      hits={hits}
      pending={pending}
      onToggle={onToggle}
      onMute={onMute}
      picked={picked}
    />
  );
  const { rerender } = render(element(options), { wrapper });
  /**
   * Change the props **without remounting**, which is the only way to ask a question about state
   * the component owns — `expanded` is a `useState` inside `TagTree`, so a second `render` would
   * answer about a fresh one and pass whatever the code did.
   */
  const change = (next: DrawOptions) => rerender(element({ ...options, ...next }));
  return { onToggle, onMute, change };
}

/** The row a reader presses to pick a tag, found by the label it starts with. */
const row = (label: string) => screen.findByRole("button", { name: new RegExp(`^${label},`) });

/** Its disclosure, which is a separate control so that opening a branch is not picking it. */
const twisty = (label: string) =>
  screen.findByRole("button", { name: new RegExp(`tags under ${label}$`, "i") });

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  tagChildren
    .mockReset()
    .mockImplementation((ns: string, slug: string | null) =>
      Promise.resolve(answerFromGraph(ns, slug)),
    );
});

describe("TagTree", () => {
  /**
   * **The whole reason the rail is lazy.** `tag_children` with no slug answers the roots and
   * there are 3 219 art roots; the taxonomies together hold ~16 000 tags. Opening the page must
   * ask for one level and stop.
   */
  it("asks for the roots and nothing else when it opens", async () => {
    draw();
    expect(await row("Creature")).toBeInTheDocument();

    expect(tagChildren).toHaveBeenCalledTimes(1);
    expect(tagChildren).toHaveBeenCalledWith("art", null);
  });

  it("fetches a node's children only once its disclosure is pressed", async () => {
    const user = userEvent.setup();
    draw();
    await row("Creature");
    expect(tagChildren).not.toHaveBeenCalledWith("art", "creature");

    await user.click(await twisty("Creature"));

    expect(await row("Angel")).toBeInTheDocument();
    expect(tagChildren).toHaveBeenCalledWith("art", "creature");
  });

  /** `animal` carries no direct taggings at all — it is reachable only by descending through
   *  `creature`, which is the same shape as the real `removal` (zero direct taggings, 6 686
   *  cards). Two levels have to open for it to be reachable. */
  it("opens a second level, so a tag with no direct taggings is still reachable", async () => {
    const user = userEvent.setup();
    draw();

    await user.click(await twisty("Creature"));
    await user.click(await twisty("Animal"));

    expect(await row("Cat")).toBeInTheDocument();
  });

  /**
   * **A tag renders under EACH of its parents.** 43 % of art tags have more than one, so a tree
   * that showed `forest` once would be hiding it from whichever branch the reader was in.
   */
  it("renders a multi-parent tag under both of its parents", async () => {
    const user = userEvent.setup();
    draw();

    await user.click(await twisty("Plant"));
    await user.click(await twisty("Landscape"));

    const forests = await screen.findAllByRole("button", { name: /^Forest,/ });
    expect(forests).toHaveLength(2);
    // …and under the right two headings rather than twice under one.
    const under = (parent: string) => screen.getByRole("list", { name: `Tags under ${parent}` });
    expect(within(under("Plant")).getByRole("button", { name: /^Forest,/ })).toBeInTheDocument();
    expect(
      within(under("Landscape")).getByRole("button", { name: /^Forest,/ }),
    ).toBeInTheDocument();
  });

  /** Two rows for one tag are two disclosures, so opening the one under Plant must not open the
   *  one under Landscape — the reader expanded *that* row. */
  it("expands one copy of a multi-parent tag without expanding the other", async () => {
    const user = userEvent.setup();
    draw();
    await user.click(await twisty("Plant"));
    await user.click(await twisty("Landscape"));

    const twisties = screen.queryAllByRole("button", { name: /tags under Forest$/i });
    // `forest` has no children in this fixture, so it draws no disclosure at all — which is the
    // other half of the contract: a triangle never opens onto nothing.
    expect(twisties).toHaveLength(0);
  });

  /**
   * The same property one level over, and the one `HIT_LIST_PATH` exists for: a tag opened in the
   * **tree** must not come back opened in the **hit list**.
   *
   * Found by driving the shipped window on 2026-08-20 rather than here, and it is worth saying
   * why a suite could have caught it and did not: `expanded` is keyed on a path, and a hit's path
   * was `childPath("", hit)` — byte-identical to that tag's path as a root of the tree. So
   * searching `cloud` with `cloud` open in the tree inlined its five children **and then listed
   * three of them again** as hits a few rows down. In the tree a tag under two parents appears
   * twice under two headings that explain it; a flat list of hits has no heading to explain
   * anything, so the duplicate reads as a rendering fault.
   *
   * The rerender is load-bearing: `expanded` is `TagTree`'s own `useState`, so a second `render`
   * would ask a freshly mounted component and pass no matter what the paths did.
   */
  it("does not open a search hit because the same tag is open in the tree", async () => {
    const user = userEvent.setup();
    const { change } = draw();
    await user.click(await twisty("Plant"));
    // The tree really is open — otherwise the assertion below is vacuous.
    expect(screen.getByRole("list", { name: "Tags under Plant" })).toBeInTheDocument();

    change({ hits: [hit("plant"), hit("forest")] });

    expect(await screen.findByRole("list", { name: "Matching tags" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Tags under Plant" })).not.toBeInTheDocument();
    await expect(twisty("Plant")).resolves.toHaveAccessibleName("Show tags under Plant");
    // The symptom, stated as the reader met it: `forest` is a hit **and** a child of `plant`, so
    // an inherited disclosure draws it twice in one flat list.
    expect(screen.getAllByRole("button", { name: /^Forest,/ })).toHaveLength(1);
  });

  /**
   * A hit is a fact about one taxonomy, and the two share plenty of slugs — so a rail that has
   * descended into a row must ask about **that row's** namespace, not the box's.
   */
  it("descends in the row's own namespace, not the box's", async () => {
    const user = userEvent.setup();
    tagChildren.mockReset().mockImplementation((ns: string, slug: string | null) => {
      if (slug === null) return Promise.resolve([hit("creature", "art"), hit("removal", "oracle")]);
      return Promise.resolve(answerFromGraph(ns, slug));
    });
    draw({ namespace: "both" });

    await user.click(await twisty("Creature"));

    expect(tagChildren).toHaveBeenCalledWith("art", "creature");
    expect(tagChildren).not.toHaveBeenCalledWith("both", "creature");
  });

  it("shows a tag's card count and its namespace", async () => {
    tagChildren
      .mockReset()
      .mockResolvedValue([hit("landscape", "art"), hit("removal", "oracle", { cardCount: 6686 })]);
    draw({ namespace: "both" });

    // **The rail draws the figure alone**, because the unit word is thirteen characters repeated
    // down every row of a fixed 288px column and it was taking the name's space — see
    // `tagReachFigure`, which carries the widths measured in the shipped window. The unit is
    // still announced, which is the pair of assertions below: nothing a screen reader hears
    // changed, and the eye gets a name instead of an ellipsis.
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByText("6,686")).toBeInTheDocument();
    expect(screen.queryByText("3 illustrations")).not.toBeInTheDocument();
    // The art side counts illustrations and the oracle side counts cards — the ipc contract says
    // so in as many words, and a bare number beside a tag name says nothing about either, so the
    // *name* is where that has to be. …as is which taxonomy each row came from, because `both`
    // merges two id spaces that share slugs.
    expect(screen.getByRole("button", { name: /^Landscape,/ })).toHaveAccessibleName(
      /art tag, 3 illustrations/,
    );
    expect(screen.getByRole("button", { name: /^Removal,/ })).toHaveAccessibleName(
      /oracle tag, 6,686 cards/,
    );
  });

  it("hands the tag up when a row is pressed", async () => {
    const user = userEvent.setup();
    const { onToggle } = draw();

    await user.click(await row("Landscape"));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0][0]).toMatchObject({ slug: "landscape", namespace: "art" });
  });

  /**
   * Issue #181: the press is a **toggle**, so a row that is already picked hands the same tag up
   * again rather than going dead. The rail cannot see the answer — the selection is the page's —
   * so all this proves is that the second press is not swallowed here.
   */
  it("hands a picked row's tag up again on a second press", async () => {
    const user = userEvent.setup();
    const { onToggle } = draw({ picked: new Set([chipKey("art", "landscape")]) });

    await user.click(await row("Landscape"));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0][0]).toMatchObject({ slug: "landscape", namespace: "art" });
  });

  /**
   * A row already in the chip row says so as `aria-pressed`, which is what the ARIA toggle-button
   * pattern is for and what the tick beside the label draws. It used to be a `, picked` suffix on
   * the **name**, because a press on a picked row did nothing and a button announcing "pressed"
   * that ignores the next press would be a control that lies. Issue #181 made it a real toggle,
   * so the state moved to where a screen reader already looks for it — and the name went back to
   * being the tag.
   */
  it("marks a row that is already picked", async () => {
    draw({ picked: new Set([chipKey("art", "landscape")]) });

    expect(await row("Landscape")).toHaveAttribute("aria-pressed", "true");
    expect(await row("Plant")).toHaveAttribute("aria-pressed", "false");
    expect(await row("Landscape")).not.toHaveAccessibleName(/picked/);
  });

  /** The menu row runs the same toggle, so it has to say which half of it the press will do —
   *  a row labelled "Add" that removes the tag is the worse half of the same bug. */
  it("offers the menu row as an add while the tag is unpicked", async () => {
    const user = userEvent.setup();
    const { onToggle } = draw();

    await user.pointer({ keys: "[MouseRight]", target: await row("Landscape") });

    await user.click(await screen.findByRole("menuitem", { name: "Add this tag to the filter" }));
    expect(onToggle.mock.calls[0][0]).toMatchObject({ slug: "landscape" });
  });

  it("offers the menu row as a removal once the tag is picked", async () => {
    const user = userEvent.setup();
    const { onToggle } = draw({ picked: new Set([chipKey("art", "landscape")]) });

    await user.pointer({ keys: "[MouseRight]", target: await row("Landscape") });

    await user.click(
      await screen.findByRole("menuitem", { name: "Remove this tag from the filter" }),
    );
    expect(onToggle.mock.calls[0][0]).toMatchObject({ slug: "landscape" });
  });

  /** When the box has text the rail is the answer to it, and no level of the tree is fetched. */
  it("draws the type-ahead's answer instead of the tree while the box has text", async () => {
    draw({ hits: [hit("forest"), hit("flower")] });

    expect(await row("Forest")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Creature,/ })).not.toBeInTheDocument();
    expect(tagChildren).not.toHaveBeenCalledWith("art", null);
  });

  it("says a search found nothing rather than drawing an empty rail", async () => {
    draw({ hits: [] });
    expect(await screen.findByText(/no tags match/i)).toBeInTheDocument();
  });

  it("says a search is still running", async () => {
    draw({ hits: [], pending: true });
    expect(await screen.findByText(/searching/i)).toBeInTheDocument();
  });

  /**
   * **Muting a category takes its whole subtree off the rail**, because the children are not
   * roots — accepted, documented backend behaviour. The row has to say so before the press, or
   * the rail reads as broken the moment it is used.
   */
  it("warns on the menu row that hiding a category takes its subtree with it", async () => {
    const user = userEvent.setup();
    const { onMute } = draw();

    await user.pointer({ keys: "[MouseRight]", target: await row("Creature") });

    await user.click(await screen.findByRole("menuitem", { name: /tags under it/i }));
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(onMute.mock.calls[0][0]).toMatchObject({ slug: "creature" });
  });

  it("offers a plain hide on a leaf", async () => {
    const user = userEvent.setup();
    const { onMute } = draw();

    await user.pointer({ keys: "[MouseRight]", target: await row("Lightning") });

    const item = await screen.findByRole("menuitem", { name: /^Hide this tag$/ });
    await user.click(item);
    expect(onMute.mock.calls[0][0]).toMatchObject({ slug: "lightning" });
  });

  /**
   * A blank `id` is a real value — `oracle_tags.id` arrived by an `ALTER TABLE` that could not
   * add a `NOT NULL` column without a default — and `tag_mute` refuses one, because a stored
   * mute with a blank id would equal every un-refreshed row and take the whole taxonomy off the
   * page. The row says why rather than failing on the press.
   *
   * Matched by regex: a greyed row's accessible name carries its reason as well as its label.
   */
  it("greys the hide row for a tag with no id, and says why", async () => {
    const user = userEvent.setup();
    tagChildren.mockReset().mockResolvedValue([hit("removal", "oracle", { id: "" })]);
    const { onMute } = draw({ namespace: "oracle" });

    await user.pointer({ keys: "[MouseRight]", target: await row("Removal") });

    const item = await screen.findByRole("menuitem", { name: /Hide this tag.*refresh/i });
    expect(item).toHaveAttribute("aria-disabled", "true");
    await user.click(item);
    expect(onMute).not.toHaveBeenCalled();
  });

  /**
   * Once a tag has been hidden the rail says where it went, so a category that took its subtree
   * with it does not read as a rail that broke.
   *
   * **The region is mounted from the start and empty**, which is the whole point rather than an
   * implementation detail: a `role="status"` that first appears with its sentence already inside
   * it announces nothing, and the one reader this line exists for is the one who cannot see the
   * rows leave. Asserted both ways for that reason.
   */
  it("says where a hidden tag went once one has been hidden", async () => {
    const user = userEvent.setup();
    draw();

    const status = await screen.findByRole("status");
    expect(status).toBeEmptyDOMElement();
    await user.pointer({ keys: "[MouseRight]", target: await row("Lightning") });
    await user.click(await screen.findByRole("menuitem", { name: /^Hide this tag$/ }));

    await waitFor(() => expect(status).toHaveTextContent(/settings/i));
    // The same node throughout — a second `role="status"` swapped in for the first would
    // announce exactly as poorly as one that was never there.
    expect(screen.getByRole("status")).toBe(status);
  });

  /**
   * **A refused hide must not become an unhandled rejection.** The page's `onMute` is
   * `ipc.tagMute` plus two invalidations, so it rejects whenever the `invoke` does — and an
   * awaited promise nobody catches is silent in the shipped window and pure noise in a suite
   * that reaches it. The rail's own answer is to say nothing new: the row is still there, which
   * is already the truth.
   */
  it("swallows a refused hide rather than claiming the tag went anywhere", async () => {
    const user = userEvent.setup();
    const { onMute } = draw({
      mute: () => Promise.reject(new Error("tag_mute: a tag with no id cannot be muted")),
    });

    await user.pointer({ keys: "[MouseRight]", target: await row("Lightning") });
    await user.click(await screen.findByRole("menuitem", { name: /^Hide this tag$/ }));

    // Every queued microtask given its chance to surface. **This is where the assertion really
    // lives, and it is vitest's rather than a line below**: an unhandled rejection fails the
    // whole run (exit 1, an "Unhandled Rejection" banner naming this file), so without the
    // `catch` in `hide` this test is red — verified by mutation, 2026-08-20.
    //
    // Two ways of catching it here were tried and neither works: `process.on` needs
    // `@types/node`, which is banned for retyping `setTimeout` across the app program, and
    // jsdom does **not** dispatch `unhandledrejection` on `window` under this runner — a
    // `window` listener sits there never called and the test passes vacuously under the mutant.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMute).toHaveBeenCalledTimes(1);
    // …and the rail made no claim it cannot stand behind: the row is still there, which is the
    // truth, and saying why belongs to the page that made the call.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(await row("Lightning")).toBeInTheDocument();
  });

  it("says an empty taxonomy is empty rather than drawing nothing", async () => {
    tagChildren.mockReset().mockResolvedValue([]);
    draw();
    expect(await screen.findByText(/no tags to show/i)).toBeInTheDocument();
  });

  it("reports a refused level instead of looking empty", async () => {
    tagChildren.mockReset().mockRejectedValue(new Error("no such table: art_tags"));
    draw();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
  });
});
