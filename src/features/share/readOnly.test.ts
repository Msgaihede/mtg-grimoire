/**
 * The shared view's read-only guarantee, as a source sweep — because there is nothing at runtime
 * to check.
 *
 * **There is no read-only mode anywhere on this app's data path.** `lock_db_read` returns the
 * *write* connection on wasm, and `@/lib/writes` is only about which mutation owns an error
 * banner. So a flag would be a claim rather than a fence. What this view actually has is a
 * stronger property: it renders a **fetched document**, and nothing in `src/features/share/`
 * names a mutation. That is checkable, and this is the check.
 *
 * ## What makes it total, and what it rests on
 *
 * `ipc.ts` is the one door to the backend, so every backend call anywhere in the app is spelled
 * `ipc.<name>`. Sweeping this directory for that spelling therefore finds every call these files
 * make — provided the calls are made *here*. A helper outside this directory that took a
 * callback would be invisible to it, which is why `useOwnedIndex` writes its own paging loop
 * instead of importing `features/transfer/export/scope.ts`'s `sweep`: the ipc name stays inside
 * the swept files, and the fence stays total. Keep it that way.
 *
 * **`AddToWishlist` imports one hook from outside this directory and that is not the same hole.**
 * `useWishlistFolderList` (`features/wishlist/useWishlistFolders.ts`) calls
 * `ipc.wishlistFolderList` in *its* file, where this glob cannot see it. What the paragraph above
 * forbids is a helper this directory can point at an **arbitrary** command — one that takes a
 * callback, or `ipc` itself — because then the name being swept for is chosen here and written
 * elsewhere. That hook names one fixed read and takes no argument at all, so nothing in this
 * directory can steer it, and reaching it is what keeps the app's wishlist folders one query
 * rather than two cache entries that agree today. A second hand-written `useQuery` here would be
 * exactly the drift that hook's own doc comment argues against.
 *
 * ## The one write, and why it had to break this test to get in
 *
 * Spec decision 8 gives this view a want list: tick rows, press *Add to wishlist*, choose a
 * folder the reader already has. That is a write, deliberately, by an explicit press, into the
 * reader's **own** wishlist — never into the binder on screen, which belongs to somebody else and
 * is a snapshot besides. It landed on 2026-09-08 and it went red here first, which is exactly the
 * friction this test exists to create: one reviewed line in {@link WRITES} below, rather than a
 * guarantee that quietly stopped being true.
 *
 * **{@link WRITES} is a second list rather than two more entries on {@link READS}**, and the
 * split is the whole value of what is left: the sweep is unchanged either way, so a single list
 * would buy nothing and would cost the sentence *every one of them is a read* — which is the
 * property a reviewer checks this file for. One list of reads that is still only reads, one list
 * of writes with one name on it, and a diff that adds to the second is a diff about the promise.
 */
import { describe, expect, it } from "vitest";

/**
 * Every source file of the shared view, as text.
 *
 * Tests and stories are **out** of the sweep on purpose: they mock `ipc` wholesale and a
 * hoisted spy named after a command is not a call to it. What is being fenced is what the app
 * does, and a suite that fenced its own mocks would be measuring itself.
 */
const SOURCES = Object.entries(
  import.meta.glob<string>("/src/features/share/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([path]) => !/\.(test|stories)\.tsx?$/.test(path));

/** `ipc.something` — the spelling every backend call in this app is written in. */
const IPC_CALL = /\bipc\.([A-Za-z_$][\w$]*)/g;

/**
 * The three ways to reach a command **without** writing its name after a dot.
 *
 * {@link IPC_CALL} above reads one spelling, and a fence that reads one spelling is a fence for
 * one spelling: `const { shareRevoke } = ipc` and `ipc["shareRevoke"]` both pass it, and so does
 * handing `ipc` itself to a helper that does the calling elsewhere. None of the three is a
 * plausible accident, which is exactly why they are refused outright rather than parsed for
 * names — there is no legitimate use of any of them in this directory, so "absent" is a complete
 * answer and a simpler one than trying to read what they would have called.
 *
 * The `import` line is not caught by any of them: it is `import { ipc } from "@/lib/ipc"`, where
 * `ipc` is followed by ` }` and preceded by `{ `.
 */
const BACK_DOORS: readonly { form: RegExp; what: string }[] = [
  { form: /\bipc\s*\[/, what: 'ipc["…"] — a command named by a string the sweep cannot read' },
  { form: /=\s*ipc\b(?!\s*\.)/, what: "a binding taken off ipc — destructured or aliased" },
  { form: /[(,]\s*ipc\s*[,)]/, what: "ipc passed as an argument, so the call happens elsewhere" },
  {
    form: /import\s+\*\s+as\s+\w+\s+from\s+"@\/lib\/ipc"/,
    what: "a namespace import, which renames the door",
  },
];

/**
 * The commands this directory is allowed to name. **Every one of them is a read.**
 *
 * * `shareOpen` — fetch somebody else's snapshot. Sends no token and needs no membership.
 * * `shareList` — the group's own published shares, for the surfaces that ask this hook.
 * * `collectionList`, `wishlistList` — the reader's own two lists, swept into the
 *   cross-reference. Reads *of* the reader's data, never writes to it.
 */
const READS: readonly string[] = ["shareOpen", "shareList", "collectionList", "wishlistList"];

/**
 * The commands this directory is allowed to name that are **not** reads. There is one.
 *
 * * `wishlistAdd` — the want list (spec decision 8), in `AddToWishlist.tsx`. It writes
 *   `wishlist_entries`, which is the reader's **own** list, from an explicit press, into a folder
 *   they already have. Nothing it does reaches the binder on screen, and it needs no new table,
 *   no synced column and no schema rung — a want list is the wishlist this app has always had,
 *   reached from a new place.
 *
 * **Adding a second name here is a change to what this view promises**, not a formality: the
 * promise is that a shared collection is a document, and every write named here has to be a write
 * to something else the reader owns. A `shareRefresh` or a `collectionAdd` on this list would be
 * the promise gone, whatever the sweep then said.
 */
const WRITES: readonly string[] = ["wishlistAdd"];

/** The three commands that change a share. None of them belongs on a viewer. */
const SHARE_WRITES: readonly string[] = ["shareCreate", "shareRefresh", "shareRevoke"];

describe("the shared view", () => {
  it("sweeps files at all", () => {
    // A glob that matches nothing passes every assertion below without testing anything, which
    // is this shape of test's own failure mode: a moved directory would turn the guarantee into
    // a green build over an empty set.
    expect(SOURCES.length).toBeGreaterThan(4);
    expect(SOURCES.map(([path]) => path)).toContain("/src/features/share/SharedPage.tsx");
  });

  it("names every command it reaches, and every one of them is a read or the want list", () => {
    for (const [path, source] of SOURCES) {
      for (const [, command] of source.matchAll(IPC_CALL)) {
        expect(
          [...READS, ...WRITES],
          `${path} calls ipc.${command}. Everything in src/features/share/ renders a document ` +
            "somebody else published; a command that is not a read makes the view's read-only " +
            "promise false. The one exception is the want list (spec decision 8), which writes " +
            "the reader's own wishlist — if this is that, add the command to WRITES in " +
            "readOnly.test.ts in the same commit and say why.",
        ).toContain(command);
      }
    }
  });

  /**
   * And the list of reads is still only reads, which is the half a merged list would have lost.
   *
   * Asserted rather than left to the reading, because the two lists are one `[...READS,
   * ...WRITES]` away from being interchangeable and a write appended to the wrong one is a diff
   * that looks exactly like a diff to the right one.
   */
  it("keeps the write off the list of reads", () => {
    for (const write of WRITES) expect(READS).not.toContain(write);
  });

  it("never touches a share itself", () => {
    for (const [path, source] of SOURCES) {
      for (const command of SHARE_WRITES) {
        expect(source, `${path} names ipc.${command}`).not.toContain(`ipc.${command}`);
      }
    }
  });

  /**
   * And the back door: `ipc.ts` is only the one door while nothing goes round it. A file that
   * imported the raw `invoke`/`Core` layer could call anything at all, and every assertion above
   * would go on passing over it.
   */
  it("reaches the backend only through the ipc wrapper", () => {
    for (const [path, source] of SOURCES) {
      expect(source, `${path} imports the raw call layer`).not.toMatch(
        /from "@\/lib\/(core|invoke)"|from "@tauri-apps\/api\/core"/,
      );
    }
  });

  /**
   * And the other back door, which is the same hole read from inside the wrapper: a command
   * reached without its name being written after a dot.
   *
   * The name sweep above is the guarantee, and it can only see `ipc.<name>`. Every form here
   * defeats it silently — `const { shareRevoke } = ipc` is a write that the *fence* reports as
   * a clean file, which is worse than no fence at all.
   */
  it("names every command it calls, in the one spelling the sweep can read", () => {
    for (const [path, source] of SOURCES) {
      for (const { form, what } of BACK_DOORS) {
        expect(source, `${path} uses ${what}`).not.toMatch(form);
      }
    }
  });
});
