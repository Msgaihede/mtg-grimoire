import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CachePanel } from "./CachePanel";
import type { LocalCache } from "./useDataReset";

function cache(over: Partial<LocalCache> = {}): LocalCache {
  return {
    clear: { run: vi.fn(), pending: false },
    status: null,
    ...over,
  };
}

const panel = () => screen.getByRole("region", { name: "Local cache" });
const dialog = () => screen.getByRole("dialog");

describe("CachePanel", () => {
  /**
   * The promise the panel has to make on its face, because it is what separates this button
   * from the three below it: nothing a reader chose is in here.
   */
  it("says up front that nothing the reader owns or made is touched", () => {
    render(<CachePanel cache={cache()} />);

    expect(panel()).toHaveTextContent("fetched again when it is next needed");
    expect(panel()).toHaveTextContent("collection, decks and deck covers are not touched");
  });

  /**
   * A confirmation, but a plain one — no typed word. The absence is the assertion: a word typed
   * on every dialog is a word nobody reads, which is what would make it useless on the three
   * that need it.
   */
  it("confirms without asking for a typed word", async () => {
    const user = userEvent.setup();
    const state = cache();
    render(<CachePanel cache={state} />);

    await user.click(within(panel()).getByRole("button", { name: "Clear cache" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(state.clear.run).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Clear cache" }));
    expect(state.clear.run).toHaveBeenCalledOnce();
  });

  it("says what it freed once it has run", () => {
    render(
      <CachePanel cache={cache({ status: { tone: "plain", text: "Freed 330 MB across 5,540 files." } })} />,
    );

    expect(within(panel()).getByRole("alert")).toHaveTextContent("Freed 330 MB across 5,540 files.");
  });

  /**
   * The one refusal this command has. It is a "not now" rather than a fault — the corpus
   * download is mid-flight and reads its own file back — so the reader is told when to try
   * again in the same sentence.
   */
  it("draws the mid-sync refusal it can be given", () => {
    render(
      <CachePanel
        cache={cache({
          status: {
            tone: "problem",
            text: "a card update is running — clear the cache once it has finished",
          },
        })}
      />,
    );

    expect(within(panel()).getByRole("alert")).toHaveTextContent("once it has finished");
  });

  it("goes inert while the sweep is running", () => {
    render(<CachePanel cache={cache({ clear: { run: vi.fn(), pending: true } })} />);

    expect(within(panel()).getByRole("button", { name: "Clear cache" })).toBeDisabled();
  });
});
