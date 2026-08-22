import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TagChip } from "@/features/tags/tagFilters";
import type { TagHit } from "@/lib/ipc";
import { parseTagQuery } from "./tagQuery";

const tagSearch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { tagSearch },
}));

import { TagQueryRow } from "./TagQueryRow";
import type { CardSearch } from "./useCardSearch";

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const hit = (slug: string): TagHit => ({
  slug,
  id: `id-${slug}`,
  label: slug,
  namespace: "oracle",
  description: null,
  cardCount: 10,
  childCount: 0,
  parents: [],
});

/** Only the members `TagQueryRow` reads — it takes the whole `CardSearch`, and every other
 *  field on it belongs to the filter row above. */
const search = (over: Partial<CardSearch> = {}) =>
  ({
    tagChips: [] as TagChip[],
    tagNotFound: [],
    tagsResolving: false,
    removeTagChip: vi.fn(),
    toggleTagChipMode: vi.fn(),
    replaceTagToken: vi.fn(),
    ...over,
  }) as unknown as CardSearch;

/** The tokens of a query, so a case names what a reader typed rather than hand-building spans
 *  that the parser is the only authority on. */
const tokensOf = (query: string) => parseTagQuery(query).tokens;

describe("TagQueryRow", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    tagSearch.mockReset().mockResolvedValue([]);
  });

  /**
   * The row is drawn only once it has something to say. A permanent strip would spend the deck
   * panel's scarcest axis — width, and here a whole line of height — on a feature most searches
   * never touch.
   */
  it("draws nothing at all for a box with no tagger syntax in it", () => {
    const { container } = render(<TagQueryRow search={search()} />, { wrapper });
    expect(container).toBeEmptyDOMElement();
  });

  it("draws a chip per resolved tag, named apart from the Tags page's own row", () => {
    render(
      <TagQueryRow
        search={search({
          tagChips: [{ slug: "ramp", label: "Ramp", namespace: "oracle", mode: "include" }],
        })}
      />,
      { wrapper },
    );

    // Not "Picked tags": the Tags page draws that row *and* this one, and two groups sharing a
    // name are two controls a screen reader cannot tell apart.
    const group = screen.getByRole("group", { name: "Tags from the search box" });
    expect(group).toHaveTextContent("Ramp");
  });

  /**
   * The row must not carry the Tags page's invitation. "Pick one from the list to narrow the
   * cards" names a rail this surface does not have, and it would sit under a search box that
   * has nothing to do with it.
   */
  it("never offers the Tags page's empty-row invitation", () => {
    render(<TagQueryRow search={search({ tagNotFound: tokensOf("o:remov") })} />, { wrapper });
    expect(screen.queryByText(/Pick one from the list/)).toBeNull();
  });

  /**
   * The worst failure this feature could have, said out loud. An unknown name empties the wall
   * on purpose, and a reader who mistypes `o:remov` and is shown a silent empty wall concludes
   * their collection has no removal in it.
   */
  it("names the tag it could not find", () => {
    render(<TagQueryRow search={search({ tagNotFound: tokensOf("o:remov") })} />, { wrapper });

    expect(screen.getByRole("status")).toHaveTextContent(/No oracle tag called .remov./);
  });

  /**
   * The near misses come from `tag_search`, which substring-matches — deliberately, and it is
   * the one command in the app that can reach `removal` from `remov`. Pressing one rewrites
   * that term in the box, keeping the keyword the reader typed.
   */
  it("offers the closest tags and puts one in the query when pressed", async () => {
    tagSearch.mockResolvedValue([hit("removal"), hit("removal-creature")]);
    const replaceTagToken = vi.fn();
    const tokens = tokensOf("o:remov");
    render(<TagQueryRow search={search({ tagNotFound: tokens, replaceTagToken })} />, { wrapper });

    const suggestion = await screen.findByRole("button", { name: "removal" });
    await userEvent.click(suggestion);

    expect(replaceTagToken).toHaveBeenCalledWith(tokens[0], "removal");
  });

  /** With nothing close to offer the note is still drawn: the sentence explaining the empty
   *  wall is the part that matters, and the suggestions are the bonus. */
  it("says the name is unknown even when nothing is close to it", async () => {
    render(<TagQueryRow search={search({ tagNotFound: tokensOf("a:zzzz") })} />, { wrapper });

    await waitFor(() => expect(tagSearch).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent(/No art tag called .zzzz./);
    expect(screen.queryByText("Did you mean")).toBeNull();
  });

  /**
   * Two terms can name the same unknown word, and each gets its own note — the note is about a
   * *term's* position in the string, which is what the ✕ and the suggestion both act on.
   */
  it("draws one note per unresolved term", () => {
    render(<TagQueryRow search={search({ tagNotFound: tokensOf("o:remov a:remov") })} />, {
      wrapper,
    });

    expect(screen.getAllByRole("status")).toHaveLength(2);
  });
});
