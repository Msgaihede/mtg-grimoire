/**
 * The Share control on the cabinet — which level offers one, and what each press does.
 *
 * **The five cases the plan asked for, plus the two the wiring forced.** `shareTargetFor` is a
 * pure function over one folder and the effective lock, so *which level offers a control* is
 * checked as a table rather than by mounting the page four times; everything below it needs the
 * menu, the dialog and the two backends behind them.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const shareList = vi.hoisted(() => vi.fn());
const shareCreate = vi.hoisted(() => vi.fn());
const shareRefresh = vi.hoisted(() => vi.fn());
const shareRevoke = vi.hoisted(() => vi.fn());
const shareOpen = vi.hoisted(() => vi.fn());
const syncSupporterStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shareList, shareCreate, shareRefresh, shareRevoke, shareOpen, syncSupporterStatus },
}));

/** The one seam the app names the clipboard through — `@tauri-apps/plugin-clipboard-manager`
 *  behind it, which has no answer in jsdom. */
const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { CollectionFolder, ShareRow, SupporterStatus } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { stubNarrowWindow } from "@/test-viewport";
import { shareFor, ShareFolderMenu, shareTargetFor, type ShareTarget } from "./ShareFolderMenu";

/* ------------------------------------------------------------------ fixtures ---------- */

/**
 * A drawer the list named **no** uid for — the state the fence below is about.
 *
 * `collection_folders.sync_uid` is nullable in the DDL even though every creation path mints
 * one, so this is a shape the wire can produce rather than a hypothetical.
 */
const folder = (over: Partial<CollectionFolder> = {}): CollectionFolder => ({
  id: 3,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: null,
  ...over,
});

/** The ordinary case: a user folder with the cross-device name a share is addressed by
 *  (`ShareRow.folderUid`). */
const named = (over: Partial<CollectionFolder> = {}): CollectionFolder =>
  folder({ syncUid: "u3", ...over });

const COLLECTION: ShareTarget = { kind: "collection", title: "Collection" };
const BINDER: ShareTarget = { kind: "folder", uid: "u3", title: "Trade binder", locked: false };
const LOCKED: ShareTarget = { ...BINDER, locked: true };

const LINK = "https://share.example/s/testshareid00000";

const share = (over: Partial<ShareRow> = {}): ShareRow => ({
  id: "testshareid00000",
  folderUid: "u3",
  title: "Trade binder",
  ownerName: "Giradeli",
  url: LINK,
  fields: ["condition"],
  state: "live",
  published: 1_757_000_000,
  updatedAt: 1_757_000_000,
  ...over,
});

/** A device out of the box: nothing connected, nothing ever bound. `groupBound` is the whole of
 *  what tells this from a membership that ended — `SupporterStatus`' own warning. */
const NOTHING_CONNECTED: SupporterStatus = {
  entitled: false,
  status: "dead",
  since: null,
  groupBound: false,
};
const SUPPORTING: SupporterStatus = {
  entitled: true,
  status: "active",
  since: 1_750_000_000,
  groupBound: true,
};
/** Connected once, and the pledge has stopped. The control is still drawn — this reader has
 *  connected *something* — and the publish is what refuses. */
const MEMBERSHIP_ENDED: SupporterStatus = { ...NOTHING_CONNECTED, groupBound: true };

/** The crate's own sentence for a build whose `SHARE_BASE` is still the placeholder —
 *  `share::publish::NOT_DEPLOYED`, which is what every build answers today. */
const NOT_DEPLOYED =
  "Sharing a collection is not available in this build yet - the service it publishes to has " +
  "no address here.";
/** `share::publish::NOT_CONNECTED` — the connect story, in the words the backend sends. */
const NOT_CONNECTED =
  "Sharing a collection needs a supporter membership. Connect Patreon in Settings - any device " +
  "in your group will do.";

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ContextMenuProvider>{ui}</ContextMenuProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The Share button, once the supporter read has answered. */
const shareButton = (name: RegExp | string = /^Share/) =>
  screen.findByRole("button", { name });

beforeEach(() => {
  vi.clearAllMocks();
  shareList.mockResolvedValue([]);
  shareCreate.mockResolvedValue(share());
  shareRefresh.mockResolvedValue(share());
  shareRevoke.mockResolvedValue(undefined);
  syncSupporterStatus.mockResolvedValue(SUPPORTING);
  copyText.mockResolvedValue(undefined);
  useAppStore.setState({ openedShares: [], activeView: "collection" });
});

/* -------------------------------------------------- which level offers a control ---------- */

describe("which level offers a Share control", () => {
  /**
   * **Not on a deck group, not on `Recently removed`** — the app-owned kinds, which
   * `CollectionPage.tsx`'s `userFolders` already separates and which
   * `share::snapshot::FOLDER_NOT_SHAREABLE` refuses on the other side of the wire.
   */
  it("offers Share on a user folder and on the root, and on nothing else", () => {
    expect(shareTargetFor(null, false)).toEqual(COLLECTION);
    expect(shareTargetFor(named(), false)).toEqual(BINDER);
    expect(shareTargetFor(named(), true)).toEqual(LOCKED);

    expect(shareTargetFor(folder({ kind: "deck", deckId: 4, name: "Burn" }), false)).toBeNull();
    expect(shareTargetFor(folder({ kind: "removed", name: "Recently removed" }), false)).toBeNull();
  });

  /**
   * **The one fallback that must never happen.** `share_create`'s `folderUid` is `null` for the
   * *whole collection*, so a folder the list named no uid for must produce **no target** — a
   * `null` uid quietly becoming a `null` argument publishes every card the reader owns instead
   * of the one binder they picked, which is the failure `ipc.ts` warns about at `shareCreate` in
   * as many words. `collection_folders.sync_uid` is nullable in the DDL, so this stays a state
   * to answer for however rare it is.
   */
  it("names no target for a folder the list named no uid for", () => {
    expect(shareTargetFor(folder(), false)).toBeNull();
    // An empty uid is as unusable as a missing one, and it is the shape a half-written row would
    // carry — folded into the same branch rather than left to reach the wire as a name nothing
    // resolves.
    expect(shareTargetFor(folder({ syncUid: "" }), false)).toBeNull();
  });
});

/* ---------------------------------------------------- which row belongs to a level ---------- */

describe("the share a level already has", () => {
  /**
   * **A withdrawn row survives its own revocation** until the next reconcile drops it, so the
   * menu can say *withdrawn* rather than having the fact vanish with no explanation — which
   * means one folder can carry two rows for a moment. The live one wins, or the menu would
   * offer *Share…* over a link that is still answering.
   */
  it("prefers a live row over a withdrawn one for the same folder", () => {
    const dead = share({ id: "old", state: "revoked" });
    const live = share({ id: "new" });
    expect(shareFor([dead, live], BINDER)?.id).toBe("new");
    expect(shareFor([live, dead], BINDER)?.id).toBe("new");
    // With nothing but the withdrawn row, that row is still the answer — it is what the
    // *Withdrawn* line is drawn from.
    expect(shareFor([dead], BINDER)?.id).toBe("old");
    // And a row belongs to the level it names: the whole collection is `folderUid: null`, which
    // is a destination rather than an omission.
    expect(shareFor([live], COLLECTION)).toBeNull();
    expect(shareFor([share({ folderUid: null })], COLLECTION)?.id).toBe("testshareid00000");
  });
});

/* ------------------------------------------------------------ the greyed row ---------- */

describe("a folder the reader has set aside", () => {
  /**
   * **Greyed with its reason in the row's accessible name**, which is the grammar this page's
   * `Delete…` row already uses — and the phrase rather than
   * `share::snapshot::FOLDER_IS_LOCKED`'s whole sentence, because a menu row is as wide as its
   * widest content.
   */
  it("greys Share on a locked folder and says why in the row's name", async () => {
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={LOCKED} />);

    await user.click(await shareButton());
    const row = screen.getByRole("menuitem", { name: /Share this folder/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).not.toHaveAttribute("disabled");
    expect(row).toHaveAccessibleName(/unlock it first/);

    await user.click(row);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(shareCreate).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------- the connect story ---------- */

describe("a reader with no membership", () => {
  /**
   * **Hidden, not greyed** (spec §9). A control whose only outcome is a sentence explaining that
   * it does not work teaches a reader nothing its absence would not have — `PinnedFolders`' own
   * rule — and the Settings sync panel is where the connection story lives.
   *
   * The other half of the same sentence: the story itself is what a reader who *has* connected
   * something meets when the publish is refused, in the crate's own words, and it names where
   * to go.
   */
  it("shows the connect story rather than a nag when nothing is connected", async () => {
    syncSupporterStatus.mockResolvedValue(NOTHING_CONNECTED);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={COLLECTION} />);

    // The entry point beside it needs no membership at all — viewing is open to everyone — so
    // it is what says the read has answered.
    await screen.findByRole("button", { name: "Open a shared collection" });
    expect(screen.queryByRole("button", { name: /^Share/ })).toBeNull();
    expect(screen.queryByText(/Connect Patreon/)).toBeNull();

    // …and the membership that *ended* keeps the control and meets the story on the press.
    // `cleanup` first: two mounts in one document would put two of every control on screen.
    cleanup();
    syncSupporterStatus.mockResolvedValue(MEMBERSHIP_ENDED);
    shareCreate.mockRejectedValue(NOT_CONNECTED);
    mount(<ShareFolderMenu target={COLLECTION} />);
    await user.click(await shareButton());
    await user.click(screen.getByRole("menuitem", { name: /Share your collection/ }));
    await user.type(screen.getByLabelText("Your name"), "Giradeli");
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Connect Patreon in Settings/);
  });
});

/* ----------------------------------------------------------------- the stale mark ---------- */

describe("a share whose folder was locked afterwards", () => {
  /**
   * **Stale, and the reader's own press is what withdraws it** (spec §10). The next publish
   * refuses — `share::snapshot::FOLDER_IS_LOCKED` — so the snapshot on the relay is frozen
   * rather than wrong, and a link somebody has in a chat window going dead because its owner
   * tidied a drawer would be the app taking a decision it was never asked to take.
   */
  it("marks a share stale when its folder has since been locked, and does not auto-revoke", async () => {
    shareList.mockResolvedValue([share()]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={LOCKED} />);

    await user.click(await shareButton());
    const stale = await screen.findByRole("menuitem", { name: /Stale/ });
    expect(stale).toHaveAttribute("aria-disabled", "true");
    expect(stale).toHaveAccessibleName(/the folder is locked/);

    const update = screen.getByRole("menuitem", { name: /Update now/ });
    expect(update).toHaveAttribute("aria-disabled", "true");
    expect(update).toHaveAccessibleName(/unlock it first/);
    await user.click(update);

    expect(shareRefresh).not.toHaveBeenCalled();
    expect(shareRevoke).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------- refreshing ---------- */

describe("updating a share that already exists", () => {
  /**
   * **The live half of the row the stale case only greys.** `share_refresh` re-publishes under
   * the name and fields the cached row carries and **keeps the link** — a reader who has handed
   * the URL out never hands out a second one — so the id it is given is the whole of what makes
   * it the right share.
   */
  it("re-publishes this level's share, by its own id, and says so", async () => {
    // Two rows, so an implementation that reached for the first of the list rather than for
    // this level's would send the wrong id.
    shareList.mockResolvedValue([share({ id: "whole", folderUid: null }), share()]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(await screen.findByRole("menuitem", { name: /Update now/ }));

    await waitFor(() => expect(shareRefresh).toHaveBeenCalledWith("testshareid00000"));
    expect(shareRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Snapshot updated."),
    );
  });

  /** A failed upload keeps the old snapshot serving and the link alive, so the report is a
   *  sentence rather than a state change — spec §10's *upload dies mid-`PUT`* row. */
  it("reports a refused update rather than claiming one", async () => {
    shareList.mockResolvedValue([share()]);
    shareRefresh.mockRejectedValue("The upload did not finish. The old snapshot is still live.");
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(await screen.findByRole("menuitem", { name: /Update now/ }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/old snapshot is still live/),
    );
  });
});

/* ---------------------------------------------------------- the other two states ---------- */

describe("a share the reader is not publishing to any more", () => {
  /**
   * **`lapsed` is the relay's daily pass talking** — a membership that stopped paying, whose
   * shares stop answering (spec §6). It is the one state an entire Worker cron exists to
   * produce, and it is the one a reader has to be told about before their friends tell them.
   */
  it("says a lapsed share is paused, and why", async () => {
    shareList.mockResolvedValue([share({ state: "lapsed" })]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    const paused = await screen.findByRole("menuitem", { name: /Paused/ });
    expect(paused).toHaveAttribute("aria-disabled", "true");
    expect(paused).toHaveAccessibleName(/your membership ended/);
    // The link is still worth copying — a lapse is reversible, and the reader may want to hand
    // it out again after renewing rather than publish a second one.
    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
  });

  /**
   * **Withdrawal is terminal**, and the row is kept until the next reconcile drops it so the
   * fact does not vanish with no explanation. Sharing the folder again is a fresh publish, which
   * is why `Share this folder…` is live under it rather than greyed.
   */
  it("says a withdrawn share is withdrawn, and offers to share again", async () => {
    shareList.mockResolvedValue([share({ state: "revoked" })]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    const gone = await screen.findByRole("menuitem", { name: /Withdrawn/ });
    expect(gone).toHaveAttribute("aria-disabled", "true");
    expect(gone).toHaveAccessibleName(/the link stopped answering/);

    const again = screen.getByRole("menuitem", { name: /Share this folder/ });
    expect(again).not.toHaveAttribute("aria-disabled");
    // …and nothing offers to copy or refresh a link that has stopped answering.
    expect(screen.queryByRole("menuitem", { name: /Copy link/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Update now/ })).toBeNull();
  });
});

/* -------------------------------------------------------------------- the link ---------- */

describe("the link", () => {
  /** A claim about the clipboard's contents, so it is made only after the write resolved —
   *  `ExportDialog`'s rule for the same press. */
  it("copies the link and says so", async () => {
    shareList.mockResolvedValue([share()]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(await screen.findByRole("menuitem", { name: /Copy link/ }));

    expect(copyText).toHaveBeenCalledWith(LINK);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Link copied."),
    );
  });

  /** A refused write is not a copied link, and the status line must not claim one. */
  it("reports a refused clipboard write rather than claiming a copy", async () => {
    shareList.mockResolvedValue([share()]);
    copyText.mockRejectedValue(new Error("clipboard is not available"));
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(await screen.findByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /clipboard is not available/,
      ),
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("Link copied.");
  });
});

/* ------------------------------------------------------------- the publish ---------- */

describe("publishing", () => {
  /**
   * **`SHARE_BASE` is a placeholder on every build today**, so this refusal is what a reader
   * actually meets — and it has to read as a state rather than as a crash.
   */
  it("draws a refusal as a sentence and keeps the dialog open", async () => {
    shareCreate.mockRejectedValue(NOT_DEPLOYED);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={COLLECTION} />);

    await user.click(await shareButton());
    await user.click(screen.getByRole("menuitem", { name: /Share your collection/ }));
    await user.type(screen.getByLabelText("Your name"), "Giradeli");
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no address here/);
    expect(screen.getByLabelText("Your name")).toBeInTheDocument();
  });

  /**
   * The three switches, by name — `ShareFields` is `#[serde(default)]` on the far side, so a
   * misspelling here is a column silently missing from every card rather than a refusal.
   */
  it("sends the name and the three fields the reader ticked", async () => {
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(screen.getByRole("menuitem", { name: /Share this folder/ }));
    await user.type(screen.getByLabelText("Your name"), "Giradeli");
    await user.click(screen.getByLabelText("Condition"));
    await user.click(screen.getByLabelText("Value"));
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(shareCreate).toHaveBeenCalledWith("u3", "Giradeli", {
        condition: true,
        lang: false,
        value: true,
      }),
    );
  });

  /** `null` is the whole collection and is a destination rather than an omission. */
  it("publishes the whole collection from the root", async () => {
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={COLLECTION} />);

    await user.click(await shareButton());
    await user.click(screen.getByRole("menuitem", { name: /Share your collection/ }));
    await user.type(screen.getByLabelText("Your name"), "Giradeli");
    await user.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(shareCreate).toHaveBeenCalledWith(null, "Giradeli", {
        condition: false,
        lang: false,
        value: false,
      }),
    );
  });

  /**
   * §4.3: the second device inherits the name from the relay's list rather than asking again.
   * `share_list` is the only command that reconciles, so its answer is the only place this name
   * can come from.
   */
  it("offers the name this group already publishes under", async () => {
    shareList.mockResolvedValue([share({ folderUid: null, title: "Collection" })]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(screen.getByRole("menuitem", { name: /Share this folder/ }));
    expect(await screen.findByLabelText("Your name")).toHaveValue("Giradeli");
  });

  /**
   * ⚠️ **…even when the list answers *after* the dialog is already open.**
   * `share_list` is the one `share_*` read that reaches the relay, so it is slow by
   * construction — and `Dialog` mounts nothing while it is closed, so a field seeded once at
   * mount would have stayed empty for good and made the reader re-type a name their group
   * already publishes under. The suggestion is a *fallback for an untouched field* rather than
   * a seed, which is what makes a late answer arrive rather than be missed.
   */
  it("takes the group's name even when the list answers after the dialog opened", async () => {
    let answer: (rows: ShareRow[]) => void = () => {};
    shareList.mockReturnValue(
      new Promise<ShareRow[]>((resolve) => {
        answer = resolve;
      }),
    );
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(screen.getByRole("menuitem", { name: /Share this folder/ }));
    expect(screen.getByLabelText("Your name")).toHaveValue("");

    answer([share({ folderUid: null, title: "Collection" })]);

    await waitFor(() => expect(screen.getByLabelText("Your name")).toHaveValue("Giradeli"));
  });

  /** …and the reader's own first keystroke wins permanently, which is the half a `key` on the
   *  form would have got wrong: a late answer would have thrown their draft away. */
  it("keeps what the reader typed when the list answers underneath them", async () => {
    let answer: (rows: ShareRow[]) => void = () => {};
    shareList.mockReturnValue(
      new Promise<ShareRow[]>((resolve) => {
        answer = resolve;
      }),
    );
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(screen.getByRole("menuitem", { name: /Share this folder/ }));
    await user.type(screen.getByLabelText("Your name"), "Bob");

    answer([share({ folderUid: null, title: "Collection" })]);

    // A wait long enough for the answer to have landed and re-rendered, and the value is still
    // the reader's.
    await waitFor(() => expect(shareList).toHaveBeenCalled());
    expect(screen.getByLabelText("Your name")).toHaveValue("Bob");
  });
});

/* ----------------------------------------------------------------- withdrawing ---------- */

describe("withdrawing", () => {
  /** Terminal, and the reader's own press — so it is behind a confirmation and never a
   *  consequence of anything else. */
  it("withdraws only on the reader's own press", async () => {
    shareList.mockResolvedValue([share()]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    await user.click(await shareButton());
    await user.click(await screen.findByRole("menuitem", { name: /Stop sharing/ }));
    expect(shareRevoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() => expect(shareRevoke).toHaveBeenCalledWith("testshareid00000"));
  });

  /**
   * **The caret comes back to the control the layer was raised from** — a dialog that Escape
   * closed already hands focus back, and a dialog the reader *answered* must not be the one that
   * does not.
   *
   * **It asserts the outcome rather than the route, and the two routes are not the same code.**
   * `ConfirmDialog.confirm()` calls `onDismiss()` before `onConfirm()` — that file's own stated
   * rule — so on this path the host's `onDismiss` has already run `back()` before the mutation
   * starts, and the `back()` calls in `revoke`'s own arms are belt-and-braces for a revocation
   * that never went through the dialog. Written against `document.activeElement`, this case
   * stays true whichever of the two returns the caret and goes red if neither does.
   */
  it("hands the caret back to the Share button after a withdrawal", async () => {
    shareList.mockResolvedValue([share()]);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={BINDER} />);

    const opener = await shareButton();
    await user.click(opener);
    await user.click(await screen.findByRole("menuitem", { name: /Stop sharing/ }));
    await user.click(screen.getByRole("button", { name: "Stop sharing" }));

    await waitFor(() => expect(shareRevoke).toHaveBeenCalled());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

/* --------------------------------------------------------------- the way in ---------- */

describe("opening somebody else's share", () => {
  /**
   * **The entry point spec decision 6 left nowhere to put.** The *Shared* rail row is hidden
   * until a reader has opened a share, and this control is for publishing — so without this
   * button the in-app viewer shipped reachable by `Ctrl+6` and discoverable by nothing.
   *
   * Beside the Share control because both halves of the feature are one idea read in two
   * directions: publish your binder, open somebody else's.
   */
  it("offers a way to open somebody else's share, and it needs no membership", async () => {
    syncSupporterStatus.mockResolvedValue(NOTHING_CONNECTED);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={COLLECTION} />);

    await user.click(await screen.findByRole("button", { name: "Open a shared collection" }));
    expect(await screen.findByLabelText("Link to a shared collection")).toBeInTheDocument();
  });

  /**
   * ⚠️ **The caret comes back to the *Open* button, and `back()` cannot do it.**
   *
   * `Dialog` hands the caret to whatever opened it and says the host owes that; this host has two
   * openers, and `back()` focuses the **Share** button — which for the reader driven here is not
   * drawn at all, because they have connected nothing. So the shared callback would leave the
   * caret on `<body>` for exactly the reader most likely to press *Open*, and their next Tab
   * would restart at the top of the app. Driven in the shipped window and reproduced twice
   * before it was fixed, by Escape and by the ✕.
   *
   * **Nothing connected on purpose**, so this case would still be red if the fix had been to
   * point the existing `back()` at the Open button and leave one ref.
   */
  it("hands the caret back to the Open button when the paste box closes", async () => {
    syncSupporterStatus.mockResolvedValue(NOTHING_CONNECTED);
    const user = userEvent.setup();
    mount(<ShareFolderMenu target={COLLECTION} />);

    const opener = await screen.findByRole("button", { name: "Open a shared collection" });
    await user.click(opener);
    await screen.findByLabelText("Link to a shared collection");

    await user.click(screen.getByRole("button", { name: "Close open a shared collection" }));

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

/* ------------------------------------------------------------- below the fold ---------- */

describe("the phone's frame", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * **The words give way, never the controls** — `ImportExportPair`'s own rule, applied here
   * because this group and that pair share one row's right-hand end. Worded they measured
   * **421.67px** against the phone's **335px** row and took `Export` off the window; as two glyph
   * pairs they are about 156px.
   *
   * **The accessible names do not move**, which is the half that keeps every other case in this
   * file honest: the name is an `aria-label` at both widths, so a reader on a phone hears the
   * same sentence and every query above still addresses the same control.
   */
  it("draws both buttons as glyphs below the phone fold, keeping their names", async () => {
    stubNarrowWindow(true);
    mount(<ShareFolderMenu target={BINDER} />);

    const share = await screen.findByRole("button", { name: "Share Trade binder" });
    const open = screen.getByRole("button", { name: "Open a shared collection" });
    // The box `ImportExportPair` compacts to, so the two groups are the same shape on the line.
    expect(share).toHaveClass("w-9", "px-0");
    expect(open).toHaveClass("w-9", "px-0");
    // …and the words are gone, which is the whole of what buys the room back.
    expect(share).not.toHaveTextContent("Share");
    expect(open).not.toHaveTextContent("Open a shared collection");
  });

  /** Above it, the same two controls carry their words — the state every other case here is in,
   *  asserted once so the branch cannot silently compact the desk. */
  it("keeps the words above the phone fold", async () => {
    stubNarrowWindow(false);
    mount(<ShareFolderMenu target={BINDER} />);

    const share = await screen.findByRole("button", { name: "Share Trade binder" });
    expect(share).toHaveTextContent("Share");
    expect(share).not.toHaveClass("w-9");
    expect(screen.getByRole("button", { name: "Open a shared collection" })).toHaveTextContent(
      "Open a shared collection",
    );
  });
});
