import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { ipc, type HomeLayout, type HomeWidget } from "@/lib/ipc";
import { boxed, startPointerDrag } from "@/test-drag";
import { pickOption } from "@/test-dropdown";
import { HOME_WIDGET_ATTR, HomePage } from "./HomePage";
import { HOME_LAYOUT_KEY } from "./useHomeLayout";
import { DEFAULT_LAYOUT, WIDGETS } from "./widgets";

/**
 * The page, over the real hook, the real layout functions and the real drag.
 *
 * **The arrangement is seeded into the query cache rather than mocked into `ipc`.**
 * `HOME_LAYOUT_KEY` is exported for exactly this, and the difference is not stylistic: replacing
 * the `ipc` object with a bag of `vi.fn()`s erases the type mirror, so a field that stopped
 * existing fails at runtime instead of at `tsc`. Seeding leaves every command real. The one
 * exception is {@link write} — a spy on the single method this page calls, which is still the real
 * object and still type-checked against the real signature.
 */

/** The write, spied rather than mocked: `set_home_layout` has no host to reach in jsdom, and the
 *  count is what the "writes once" test is about. Wrapped in a function so its type is inferred
 *  from the real method rather than written out — the whole point of not replacing the object. */
function spyOnWrite() {
  return vi.spyOn(ipc, "setHomeLayout").mockResolvedValue(undefined);
}

let write: ReturnType<typeof spyOnWrite>;

beforeEach(() => {
  write = spyOnWrite();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* --------------------------------------------------------------------- fixtures ------- */

/** One stored entry. `span: 1` and no config unless a test says otherwise. */
function widget(over: Partial<HomeWidget> & { id: string; kind: string }): HomeWidget {
  return { span: 1, config: null, ...over };
}

function layoutOf(...widgets: HomeWidget[]): HomeLayout {
  return { version: 1, widgets };
}

/**
 * Three widgets of kinds this build has never heard of.
 *
 * **Most of what this page does has nothing to do with what is inside a card**, and driving those
 * gestures over the placeholder keeps this file from asserting on six sibling components' headings,
 * loading states and query keys. The unknown arm is real behaviour rather than a stub — see the
 * last test, which is about the placeholder itself.
 */
const A = widget({ id: "a", kind: "future-a" });
const B = widget({ id: "b", kind: "future-b" });
const C = widget({ id: "c", kind: "future-c" });

/** What `WidgetCard` builds every tray control's accessible name out of. */
const nameOf = (kind: string) => `Unknown widget (${kind})`;

let client: QueryClient;

/** The page, with one arrangement already in the cache. */
function mount(layout: HomeLayout) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded before the render, so the query is never pending and `ready` is true from the first
  // frame — which is what separates "no widgets yet" from "the reader cleared the page".
  client.setQueryData(HOME_LAYOUT_KEY, layout);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HomePage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The arrangement as the page has it now — the cache is where the document lives. */
function storedIds(): string[] {
  return (client.getQueryData<HomeLayout>(HOME_LAYOUT_KEY)?.widgets ?? []).map(
    (entry) => entry.id,
  );
}

/** One widget's box — the element the page owns, which carries the width and the drop target. */
function boxFor(container: HTMLElement, id: string): HTMLElement {
  const box = container.querySelector<HTMLElement>(`[${HOME_WIDGET_ATTR}="${id}"]`);
  if (box === null) throw new Error(`no box for widget ${id}`);
  return box;
}

async function customize(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Customize" }));
}

/* ------------------------------------------------------------------------ tests ------- */

describe("HomePage", () => {
  it("draws the six seeded widgets, once each", async () => {
    mount({ ...DEFAULT_LAYOUT, widgets: DEFAULT_LAYOUT.widgets.map((entry) => ({ ...entry })) });

    // By heading rather than by position: a widget's place is the one thing the reader is free to
    // change, so it is the one thing nothing may address it by.
    for (const meta of WIDGETS) {
      await waitFor(() => {
        expect(screen.getAllByRole("heading", { name: meta.label })).toHaveLength(1);
      });
    }
  });

  it("reveals the edit affordances on Customize and hides them again", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A));

    expect(screen.queryByRole("button", { name: "Add widget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.queryByRole("button", { name: `Remove ${nameOf("future-a")}` })).toBeNull();

    await customize(user);

    expect(screen.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Remove ${nameOf("future-a")}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Move ${nameOf("future-a")}` })).toBeInTheDocument();

    await customize(user);

    expect(screen.queryByRole("button", { name: "Add widget" })).toBeNull();
    expect(screen.queryByRole("button", { name: `Remove ${nameOf("future-a")}` })).toBeNull();
  });

  it("appends the widget the Add widget menu names", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A));

    await customize(user);
    await pickOption(user, "Add widget", "Activity");

    await waitFor(() => {
      expect(
        client.getQueryData<HomeLayout>(HOME_LAYOUT_KEY)?.widgets.map((entry) => entry.kind),
      ).toEqual(["future-a", "activity"]);
    });
  });

  it("puts the seeded arrangement back on Reset", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A));

    await customize(user);
    await user.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect(client.getQueryData<HomeLayout>(HOME_LAYOUT_KEY)).toEqual(DEFAULT_LAYOUT);
    });
  });

  it("drops one widget on remove, and writes the document once", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A, B));

    await customize(user);
    await user.click(screen.getByRole("button", { name: `Remove ${nameOf("future-a")}` }));

    await waitFor(() => {
      expect(storedIds()).toEqual(["b"]);
    });
    expect(screen.queryByRole("heading", { name: nameOf("future-a") })).toBeNull();

    // One press, one write — the mutation is not retried and nothing else on this page writes.
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      version: 1,
      widgets: [expect.objectContaining({ id: "b" })],
    });
  });

  it("moves a card between one column and the whole line", async () => {
    const user = userEvent.setup();
    const { container } = mount(layoutOf(widget({ id: "a", kind: "future-a", span: 1 })));

    await customize(user);

    // **`classList.contains`, never a string match on `className`.** The recipes carry `hover:`
    // variants, and a substring check would pass on a class that only ever applies under the
    // pointer — an assertion that cannot fail is not one.
    expect(boxFor(container, "a").classList.contains("flex-1")).toBe(true);
    expect(boxFor(container, "a").classList.contains("basis-full")).toBe(false);

    await user.click(screen.getByRole("button", { name: `Full width, ${nameOf("future-a")}` }));

    await waitFor(() => {
      expect(boxFor(container, "a").classList.contains("basis-full")).toBe(true);
      expect(boxFor(container, "a").classList.contains("flex-1")).toBe(false);
    });
  });

  it("reorders on a drop", async () => {
    const user = userEvent.setup();
    const { container } = mount(layoutOf(A, B, C));

    await customize(user);

    // **A box on every element the hit-test touches.** jsdom measures every rect as four zeroes
    // and dnd-kit hit-tests by coordinate, so an unboxed target is a degenerate box at the origin
    // that still contains (0, 0) — it "wins" a drop the pointer never reached.
    for (const [index, id] of ["a", "b", "c"].entries()) {
      boxed(boxFor(container, id), index * 60);
    }
    const grip = screen.getByRole("button", { name: `Move ${nameOf("future-a")}` });
    boxed(grip, 0, 20);

    const held = await startPointerDrag(grip);
    try {
      expect(held.started).toBe(true);
      // The trailing side of the last card: `widgetEdge` splits a box down the middle on the x
      // axis, because the grid is a wrapping flex row.
      await held.over(boxFor(container, "c"), { x: 0.9 });
      await held.drop();
    } finally {
      // Always, and that is what keeps one broken assertion from reading as five: the manager
      // holds one drag operation, and a test that walks away mid-gesture leaves the next one
      // unable to pick anything up.
      await held.cancel();
    }

    await waitFor(() => {
      expect(storedIds()).toEqual(["b", "c", "a"]);
    });
  });

  it("moves a widget one step with the grip's arrow keys", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A, B, C));

    await customize(user);
    // `dndManager` ships no `KeyboardSensor`, so this is the whole of the reorder for a reader
    // who is not holding a pointer.
    screen.getByRole("button", { name: `Move ${nameOf("future-c")}` }).focus();
    await user.keyboard("{ArrowLeft}");

    await waitFor(() => {
      expect(storedIds()).toEqual(["a", "c", "b"]);
    });
  });

  it("offers a way back when the reader has cleared the page", async () => {
    mount(layoutOf());

    // An empty document is a layout and not a missing one, so the page says so — and carries the
    // two controls that can put something on it without a Customize press for a card that is not
    // there to grow a tray.
    expect(screen.getByText(/Your home page is empty/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("draws a placeholder for a kind it has never heard of, and does not throw", async () => {
    const user = userEvent.setup();
    expect(() => mount(layoutOf(widget({ id: "x", kind: "timeMachine" })))).not.toThrow();

    expect(screen.getByRole("heading", { name: nameOf("timeMachine") })).toBeInTheDocument();
    expect(
      screen.getByText(/came from a newer version of MTG Grimoire/),
    ).toBeInTheDocument();

    // And it keeps its whole tray, because a widget this build cannot draw is the one a reader is
    // most likely to want off the page.
    await customize(user);
    expect(screen.getByRole("button", { name: `Remove ${nameOf("timeMachine")}` })).toBeInTheDocument();
  });
});
