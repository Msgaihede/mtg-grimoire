import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ipc, type TagHit, type TagNamespace } from "@/lib/ipc";
import { chipKey } from "./tagFilters";
import { TagTree } from "./TagTree";
import { useTagSearch } from "./useTagSearch";

/**
 * The rail as the page mounts it: a needle, a taxonomy, and somewhere for a picked tag to go.
 *
 * **Driven end to end by `.storybook/fake/`, not by hand-written rows.** `useTagSearch` debounces
 * and queries, the faked `@tauri-apps/api/core` carries it, and `db.ts`'s `tag_search` and
 * `tag_children` answer — so every level, every count and every parent below is the fake's
 * taxonomy rather than a fixture that can quietly disagree with it.
 *
 * `hits` is `null` when the box is empty and an array when it is not, and the two are genuinely
 * different states: `[]` is *“that motif matches no tag”*, which is worth printing, and `null` is
 * *“nothing has been asked”*, which is when the tree is drawn.
 */
function Rail({ text, namespace }: { text: string; namespace: TagNamespace | "both" }) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set<string>());
  const queryClient = useQueryClient();
  const { hits, isPending } = useTagSearch(text, namespace);

  /**
   * Hide a tag, and put the two lists that draw it out of date — the page's write, because it is
   * the page that owns the invalidation and the rail only awaits the answer.
   *
   * Kept real rather than stubbed so that a press in the workbench really does take a row off the
   * rail; a `fn()` here would draw the rail's *“hidden tags come back from Settings”* line over a
   * tag that is still on screen, which is the exact failure the component's `catch` exists for.
   */
  const onMute = useCallback(
    async (hit: TagHit) => {
      await ipc.tagMute(hit.namespace, hit.id, hit.slug);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tag-children"] }),
        queryClient.invalidateQueries({ queryKey: ["tag-search"] }),
      ]);
    },
    [queryClient],
  );

  return (
    // The rail is `min-h-0 flex-1` inside a 256px column, so it needs a parent with a height or
    // its own scroller is handed nothing. `w-64` is `TagsPage`'s own width for it.
    <div className="flex h-[420px] w-64 flex-col border-r border-border pr-4">
      <TagTree
        namespace={namespace}
        hits={text.trim().length > 0 ? hits : null}
        pending={isPending}
        // A **toggle**, matching the page: a second press on a row takes the tag back off. A
        // workbench that only ever added would draw a rail whose rows go dead once pressed, and
        // that is the bug issue #181 was reported as rather than the behaviour to demonstrate.
        onToggle={(hit) =>
          setPicked((s) => {
            const next = new Set(s);
            const key = chipKey(hit.namespace, hit.slug);
            if (!next.delete(key)) next.add(key);
            return next;
          })
        }
        onMute={onMute}
        picked={picked}
      />
    </div>
  );
}

const meta = {
  title: "Tags/Rail",
  component: Rail,
  tags: ["autodocs"],
  args: { text: "", namespace: "art" as TagNamespace | "both" },
  // Keyed on the needle, so typing one into Controls remounts rather than animating the rail
  // through every intermediate debounce.
  render: (args) => <Rail key={`${args.namespace}|${args.text}`} {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "One level of the tag graph at a time, or the type-ahead's answer when the box has " +
          "text in it.\n\n" +
          "**It is lazy, and the fetch *is* the mount.** `tag_children` with no slug answers " +
          "the roots, and there are thousands of art roots in the real taxonomy against " +
          "~16,000 tags across the two files — " +
          "`docs/superpowers/research/2026-08-20-scryfall-art-tags.md` holds the dated count, " +
          "which is where one belongs. A level is fetched by " +
          "the component that draws it, which mounts when its disclosure is opened and never " +
          "before, so a closed branch has asked the backend nothing.\n\n" +
          "**A tag renders under EACH of its parents.** 43% of art tags have more than one " +
          "(4,970 of 11,531), and the graph is 10 deep — so a rail that drew each tag once " +
          "would be hiding it from whichever branch the reader happened to be in, wrong for two " +
          "tags in five. {@link MultipleParents} is that shape in the fake, where `forest` sits " +
          "under both `plant` and `landscape`.\n\n" +
          "**It is not `role=\"tree\"`, deliberately.** An ARIA `tree` promises one tab stop and " +
          "a roving caret walked by the arrow keys (WAI-ARIA APG). This rail does not implement " +
          "that model, and announcing a keyboard contract nothing keeps leaves the reader " +
          "pressing Down at a list that does not move. Nested lists of disclosure buttons say " +
          "exactly what is there.\n\n" +
          "**Not virtualised, and driven to confirm it can stay that way.** A recursive graph " +
          "of disclosures is the wrong shape for `VirtualTable`, and how a level of thousands " +
          "actually feels was a question for the live pass rather than for jsdom, which has no " +
          "layout engine at all. Answered 2026-08-20 in the shipped window (debug build), with " +
          "a real taxonomy in: 4,142 rows on `Both` painted in 575–673 ms, then a 115,988 px " +
          "scroller ran at p50 6.9 ms with **zero** frames over 33 ms. The cost is one 622 ms " +
          "long task on the navigation — see `docs/reference/tags-live-findings.md`.\n\n" +
          "**There is no `dog` here and there must not be.** Nobody in the fake's 43 " +
          "illustrations is a dog, and its own standard is that every art tag is true of the " +
          "picture it is on — a wall of cats filed under “Dog” would teach a reader that this " +
          "page's whole subject is decorative. The crate's fixture (`tags/query.rs`'s tests) is " +
          "where that branch lives.",
      },
    },
  },
} satisfies Meta<typeof Rail>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The art taxonomy's roots, which is what an untouched box draws.
 *
 * Four of them in the fake, ordered by reach: `Creature` (6 illustrations), `Plant` (4),
 * `Landscape` (3), `Lightning` (1). The count is written out as *illustrations* rather than left
 * a bare number, and the unit is not decoration — an art tag counts **pictures**, so `lightning`
 * on one of the four Lightning Bolts answers one illustration where the oracle tag `burn`
 * answers all four. A rail printing “1 card” beside `lightning` would teach the opposite.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Creature, art tag, 6 illustrations" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Lightning, art tag, 1 illustration" }),
    ).toBeInTheDocument();

    // **Nothing below the roots has been fetched.** `Cat` is two levels down, and the level that
    // holds it has never mounted — which is the whole of the lazy contract, and the only thing
    // standing between this component and thousands of rows on first paint.
    await expect(canvas.queryByRole("button", { name: /^Cat, / })).toBeNull();
    // A leaf draws no disclosure at all: `childCount` counts only children that exist and are
    // not muted, so a triangle never opens onto nothing.
    await expect(canvas.queryByRole("button", { name: "Show tags under Lightning" })).toBeNull();
  },
};

/**
 * Both taxonomies at once, which is what the page opens on.
 *
 * The mark beside each label is drawn **only here**: in a single-taxonomy rail a column of
 * identical marks is noise, and in `Both` the two id spaces genuinely share slugs. The counts
 * change unit with the mark — oracle tags reach *cards*, art tags reach *illustrations* — and the
 * ranking puts art first on an equal-reach tie, because the page's primary job is an art theme.
 */
export const BothTaxonomies: Story = {
  args: { namespace: "both" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Card Advantage, oracle tag, 10 cards" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Creature, art tag, 6 illustrations" }),
    ).toBeInTheDocument();
    // The taxonomy is in the accessible name as well as in the mark, because the mark is
    // `aria-hidden` — announced too, a screen reader would hear it twice.
    await expect(
      canvas.getByRole("button", { name: "Creature, art tag, 6 illustrations" }),
    ).toHaveTextContent("Art");
  },
};

/**
 * A tag under two parents, drawn under each of them.
 *
 * `Forest` really is a landscape *and* a stand of plants, so it is filed under both — and the
 * rail lists it in each branch rather than picking one. Nothing here deduplicates: `tag_children`
 * answers a multi-parent tag under every parent, and each row is its own subtree with its own
 * expansion state, so the two rows below come out right by construction.
 *
 * **The expansion state is keyed on the *route*, never on the slug.** Keyed on the slug, opening
 * either `Forest` would open both and the reader would watch a branch they never touched unfold.
 * The fake's `forest` is a leaf, so the two rows here cannot be opened to show that directly —
 * `TagTree.test.tsx` is where the route key is pinned against a branch built for it.
 */
export const MultipleParents: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Says which branch as well as which direction: a rail ten levels deep has a column of these
    // and "Show children" would name every one of them the same.
    await userEvent.click(await canvas.findByRole("button", { name: "Show tags under Plant" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Show tags under Landscape" }));

    const underPlant = await canvas.findByRole("list", { name: "Tags under Plant" });
    const underLandscape = await canvas.findByRole("list", { name: "Tags under Landscape" });
    await waitFor(async () => {
      await expect(
        within(underPlant).getByRole("button", { name: "Forest, art tag, 2 illustrations" }),
      ).toBeInTheDocument();
      await expect(
        within(underLandscape).getByRole("button", { name: "Forest, art tag, 2 illustrations" }),
      ).toBeInTheDocument();
    });

    // Two rows for one tag, and each level holds only its own siblings — `Flower` under `Plant`,
    // `Water` under `Landscape`.
    await expect(
      canvas.getAllByRole("button", { name: "Forest, art tag, 2 illustrations" }),
    ).toHaveLength(2);
    await expect(
      within(underPlant).queryByRole("button", { name: /^Water, / }),
    ).toBeNull();
    await expect(
      within(underLandscape).queryByRole("button", { name: /^Flower, / }),
    ).toBeNull();
  },
};

/**
 * A category reached only through its children, which is what the rollup is for.
 *
 * Nothing in the fake is tagged `animal` directly — Lurrus carries `cat` and Ragavan carries
 * `monkey` — and `Animal` still answers two illustrations, because the closure walks each tagging
 * up the graph. It is the same shape as the real `removal`, which has zero direct taggings and
 * reaches 6,686 cards.
 */
export const ACategoryWithNoTaggingsOfItsOwn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Show tags under Creature" }));
    const level = await canvas.findByRole("list", { name: "Tags under Creature" });

    const animal = within(level).getByRole("button", { name: "Animal, art tag, 2 illustrations" });
    await userEvent.click(within(level).getByRole("button", { name: "Show tags under Animal" }));

    const under = await canvas.findByRole("list", { name: "Tags under Animal" });
    await expect(
      within(under).getByRole("button", { name: "Cat, art tag, 1 illustration" }),
    ).toBeInTheDocument();
    await expect(
      within(under).getByRole("button", { name: "Monkey, art tag, 1 illustration" }),
    ).toBeInTheDocument();

    // Picking the category presses the row in, and pressing it again lets it back out — one
    // control, both directions (issue #181). `aria-pressed` is where the state lives; the tick
    // beside the label is the same fact drawn.
    await userEvent.click(animal);
    await waitFor(async () => {
      await expect(animal).toHaveAttribute("aria-pressed", "true");
    });

    await userEvent.click(animal);
    await waitFor(async () => {
      await expect(animal).toHaveAttribute("aria-pressed", "false");
    });
  },
};

/**
 * The type-ahead's answer: one flat list in the backend's own rank order.
 *
 * Not through `sortOptions`, because that ranking *is* the information — exact hit first, then
 * the prefix hits, then the substring ones — and alphabetising it would bury the exact match. The
 * search is a **substring** search, deliberately unlike Scryfall's own, which 404s `otag:remov`:
 * a reader told “no such tag” until they spell `dogs-of-war` exactly is not using a search box.
 */
export const Matches: Story = {
  args: { namespace: "both", text: "forest" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("list", { name: "Matching tags" });
    // Generous, because `useTagSearch` debounces by `DEBOUNCE_MS` before it asks anything and
    // several thousand tests share this machine under `npm run verify` — what runs out is
    // wall-clock under contention rather than anything this story does.
    await waitFor(
      async () => {
        await expect(
          within(list).getByRole("button", { name: "Forest, art tag, 2 illustrations" }),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    // The tree is gone while the box has text in it — the two are alternatives, not a list under
    // a list.
    await expect(canvas.queryByRole("list", { name: "Tags" })).toBeNull();
  },
};

/**
 * A motif that matches no tag, which is an answer rather than a fault.
 *
 * `[]` and `null` are different states and the rail draws different things for them. There are no
 * dragons in the fake's 43 illustrations and therefore no `dragon` tag, so this is a real empty
 * answer from the backend rather than a stubbed one — and the placeholder in the search box
 * offers `dragon` as an example precisely because the real taxonomy has it.
 */
export const NoMatches: Story = {
  args: { namespace: "both", text: "dragon" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Not a `role="status"`: none of these is news, it is what is in front of the reader.
    // The wait covers `useTagSearch`'s debounce — see {@link Matches}.
    await expect(
      await canvas.findByText("No tags match that.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  },
};
