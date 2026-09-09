/**
 * The three-way branch a stranger meets: not ready yet, the binder, or a sentence.
 *
 * `main.tsx` is not imported here and cannot be — it is side effects against a real share shell.
 * `boot` takes its document, its `fetch` and its renderer, which is what makes all three states
 * assertable and what makes the **call shape** of that fetch assertable at all.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Same reason as `SharePage.test.tsx`: vitest inherits `vite.config.ts`'s `__CORE__: "tauri"`
// while this bundle is built with `"web"`, and `cardArtSrc` branches on exactly that.
vi.mock("@/pwa/target", () => ({ isWebTarget: () => true }));

import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { SNAPSHOT_TOO_NEW, SNAPSHOT_UNREADABLE } from "@/lib/shareSnapshot";
import golden from "../src-tauri/src/share/__golden__/snapshot.json?raw";
import { boot, FAILED_DETAIL, OPENING, PENDING_DETAIL } from "./boot";
import { SNAPSHOT_OFFLINE, SNAPSHOT_PENDING } from "./SharePage";

/** A shell with the `<link>` the Worker inlines, or without it. */
function shell(href: string | null): Document {
  const body =
    href === null
      ? '<div id="root"></div>'
      : `<link id="snapshot" rel="preload" as="fetch" crossorigin href="${href}"><div id="root"></div>`;
  return new DOMParser().parseFromString(`<html><head>${body}</head><body></body></html>`, "text/html");
}

function responding(body: string, ok = true) {
  return vi.fn(async () => new Response(body, { status: ok ? 200 : 404 }));
}

/**
 * Runs `boot` and draws whatever it rendered **last** — the waiting state is a real render and
 * this deliberately keeps only the answer, which is what a reader ends up looking at.
 */
async function drive(doc: Document, fetch: typeof globalThis.fetch) {
  const drawn: React.ReactNode[] = [];
  await boot({ doc, fetch, render: (view) => drawn.push(view) });
  render(<TooltipProvider>{drawn[drawn.length - 1]}</TooltipProvider>);
  return drawn;
}

describe("boot", () => {
  it("says the collection is not ready when the shell inlined no link", async () => {
    const fetched = vi.fn();
    const drawn = await drive(shell(null), fetched as unknown as typeof globalThis.fetch);

    expect(screen.getByText(SNAPSHOT_PENDING)).toBeInTheDocument();
    expect(screen.getByText(PENDING_DETAIL)).toBeInTheDocument();
    // The whole point of the branch: a missing link is a state, not a URL to guess at.
    expect(fetched).not.toHaveBeenCalled();
    expect(drawn).toHaveLength(1);
  });

  it("draws the binder when the blob answers", async () => {
    const fetched = responding(golden);
    await drive(shell("/s/abc/deadbeef.json.gz"), fetched as unknown as typeof globalThis.fetch);

    expect(screen.getByText(/Giradeli/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Cards" })).getAllByRole("listitem")).toHaveLength(2);
  });

  /**
   * ⚠️ **`fetch` is called with the URL and nothing else, and that is the assertion.**
   *
   * The shell's `<link rel="preload" as="fetch" crossorigin>` requests the blob in credentials
   * mode `same-origin`, which is `fetch`'s own default. Passing `{ credentials: "omit" }` made
   * the two disagree, Chromium refused to reuse the warmed response — *"a preload for … is found,
   * but is not used because the request credentials mode does not match"* — and the blob was
   * fetched **twice** on every cold view, which is the whole of what inlining that link was for.
   * Measured in the running page 2026-09-08 and invisible to every test until this one.
   */
  it("fetches the blob with no credentials option, so the shell's preload is reused", async () => {
    const fetched = responding(golden);
    await drive(shell("/s/abc/deadbeef.json.gz"), fetched as unknown as typeof globalThis.fetch);

    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toContain("/s/abc/deadbeef.json.gz");
    expect(init?.credentials).toBeUndefined();
  });

  it("does not fetch again when the reader filters", async () => {
    const fetched = responding(golden);
    await drive(shell("/s/abc/deadbeef.json.gz"), fetched as unknown as typeof globalThis.fetch);
    expect(fetched).toHaveBeenCalledTimes(1);

    // Spec §7: filtering, sorting, folder navigation and search all happen over the one loaded
    // snapshot. This is the only place in the suite where that claim can go red.
    await userEvent.setup().type(screen.getByLabelText("Search this collection"), "tundra");
    expect(within(screen.getByRole("list", { name: "Cards" })).getAllByRole("listitem")).toHaveLength(1);
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it("draws the waiting state before the answer", async () => {
    const drawn = await drive(
      shell("/s/abc/deadbeef.json.gz"),
      responding(golden) as unknown as typeof globalThis.fetch,
    );
    expect(drawn).toHaveLength(2);
    render(<TooltipProvider>{drawn[0]}</TooltipProvider>);
    expect(screen.getByText(OPENING)).toBeInTheDocument();
  });

  it("says the collection could not be loaded when the blob is gone", async () => {
    const complained = vi.spyOn(console, "error").mockImplementation(() => {});
    await drive(
      shell("/s/abc/deadbeef.json.gz"),
      responding("", false) as unknown as typeof globalThis.fetch,
    );
    complained.mockRestore();

    expect(screen.getByText(SNAPSHOT_OFFLINE)).toBeInTheDocument();
    expect(screen.getByText(FAILED_DETAIL)).toBeInTheDocument();
  });

  it("prints the sentence the parser threw, rather than one of its own", async () => {
    const complained = vi.spyOn(console, "error").mockImplementation(() => {});
    await drive(
      shell("/s/abc/deadbeef.json.gz"),
      responding("<!doctype html>") as unknown as typeof globalThis.fetch,
    );
    complained.mockRestore();
    expect(screen.getByText(SNAPSHOT_UNREADABLE)).toBeInTheDocument();
  });

  it("names a snapshot from a newer build rather than drawing half a binder", async () => {
    const complained = vi.spyOn(console, "error").mockImplementation(() => {});
    const newer = JSON.stringify({ ...JSON.parse(golden), v: 99 });
    await drive(
      shell("/s/abc/deadbeef.json.gz"),
      responding(newer) as unknown as typeof globalThis.fetch,
    );
    complained.mockRestore();
    expect(screen.getByText(SNAPSHOT_TOO_NEW)).toBeInTheDocument();
  });

  it("says something rather than nothing when the fetch itself rejects", async () => {
    const complained = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuses = vi.fn(async () => {
      throw new Error("");
    });
    await drive(shell("/s/abc/deadbeef.json.gz"), refuses as unknown as typeof globalThis.fetch);
    complained.mockRestore();

    // An empty message is not a sentence, so the generic one stands in.
    expect(screen.getByText(SNAPSHOT_OFFLINE)).toBeInTheDocument();
  });
});
