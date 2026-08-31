import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MutedTag } from "@/lib/ipc";
import { HiddenTagsPanel } from "./HiddenTagsPanel";
import { mutedKey, type HiddenTags } from "./useHiddenTags";

const muted = (slug: string, namespace: MutedTag["namespace"], tagId = `${namespace}-${slug}`) =>
  ({ namespace, tagId, slug, mutedAt: 1_787_252_107 }) satisfies MutedTag;

function state(over: Partial<HiddenTags> = {}): HiddenTags {
  return { tags: [], show: vi.fn(), pending: null, error: null, ...over };
}

const panel = () => screen.getByRole("region", { name: "Hidden tags" });

describe("HiddenTagsPanel", () => {
  /**
   * The reason this panel exists: the rail's live line says hidden tags "come back from
   * Settings", and until 2026-08-20 they did not — `tag_unmute` had no caller anywhere in the
   * app. So the region's *name* is part of the contract, and it is what a reader who followed
   * that sentence is scanning the page for.
   */
  it("is a named region a reader following the rail's sentence can find", () => {
    render(<HiddenTagsPanel hidden={state({ tags: [muted("cloud", "art")] })} />);

    expect(panel()).toBeInTheDocument();
  });

  /** An empty list is an answer, and it has to say where hiding happens — this is exactly where
   *  a reader looking for a tag they hid arrives, and a bare "nothing here" is where they stop. */
  it("says how a tag gets hidden even when nothing is", () => {
    render(<HiddenTagsPanel hidden={state({ tags: [] })} />);

    expect(panel()).toHaveTextContent("You have not hidden any tags.");
    expect(panel()).toHaveTextContent("Right-click a tag on the Tags page");
    expect(within(panel()).queryByRole("button")).not.toBeInTheDocument();
  });

  /** `null` is "the read has not landed", which is neither state above — a panel that flashed
   *  "you have not hidden any tags" at a reader who has is a panel that lied first. */
  it("claims nothing while the read is still in flight", () => {
    render(<HiddenTagsPanel hidden={state({ tags: null })} />);

    expect(panel()).not.toHaveTextContent("You have not hidden any tags.");
    expect(panel()).not.toHaveTextContent("These tags are not offered");
    expect(within(panel()).queryByRole("listitem")).not.toBeInTheDocument();
  });

  /**
   * The third state, and the one that used to be indistinguishable from an empty panel: the read
   * itself failed. Saying "these tags are not offered on the Tags page" over an empty space is a
   * caption for a list that is not there, and saying "you have not hidden any tags" is a claim
   * about a table nothing successfully read. So the panel says neither and the alert says what
   * happened.
   */
  it("says a failed read happened rather than looking like an empty list", () => {
    render(<HiddenTagsPanel hidden={state({ tags: null, error: "the database is locked" })} />);

    expect(panel()).not.toHaveTextContent("You have not hidden any tags.");
    expect(panel()).not.toHaveTextContent("These tags are not offered");
    expect(within(panel()).getByRole("alert")).toHaveTextContent("the database is locked");
  });

  /**
   * The two taxonomies are separate id spaces that share plenty of slugs — `dog` is in both and
   * they mean different things by it — so a row that did not say which one it came from would
   * offer the reader two identical rows and no way to tell which tag they were giving back.
   */
  it("names the taxonomy each hidden tag came from", () => {
    render(<HiddenTagsPanel hidden={state({ tags: [muted("dog", "art"), muted("dog", "oracle")] })} />);

    expect(within(panel()).getAllByRole("listitem")).toHaveLength(2);
    expect(within(panel()).getByRole("button", { name: /dog, art tag/ })).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: /dog, oracle tag/ })).toBeInTheDocument();
  });

  /** Keyed on `(namespace, tagId)`, which is what `muted_tags` is keyed on — the panel must hand
   *  back both halves or the wrong taxonomy's tag is the one that returns. */
  it("gives a tag back by its namespace and id", async () => {
    const user = userEvent.setup();
    const s = state({ tags: [muted("dog", "art"), muted("dog", "oracle")] });
    render(<HiddenTagsPanel hidden={s} />);

    await user.click(within(panel()).getByRole("button", { name: /dog, oracle tag/ }));

    expect(s.show).toHaveBeenCalledOnce();
    expect(s.show).toHaveBeenCalledWith(expect.objectContaining({ namespace: "oracle", slug: "dog" }));
  });

  /** One write at a time: a second press while the first is in flight would fire a second
   *  `tag_unmute` at a list about to be replaced under it. */
  it("holds every button while one is being given back", () => {
    render(
      <HiddenTagsPanel
        hidden={state({ tags: [muted("cloud", "art"), muted("sky", "art")], pending: mutedKey(muted("cloud", "art")) })}
      />,
    );

    for (const b of within(panel()).getAllByRole("button")) expect(b).toBeDisabled();
    expect(within(panel()).getByRole("button", { name: /cloud/ })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(within(panel()).getByRole("button", { name: /sky/ })).not.toHaveAttribute("aria-busy");
  });

  /** A refused unmute leaves the row exactly where it was, so the sentence is the only thing
   *  separating "refused" from "nothing happened yet". */
  it("says so when the write is refused", () => {
    render(
      <HiddenTagsPanel hidden={state({ tags: [muted("cloud", "art")], error: "the database is locked" })} />,
    );

    expect(within(panel()).getByRole("alert")).toHaveTextContent("the database is locked");
  });
});
