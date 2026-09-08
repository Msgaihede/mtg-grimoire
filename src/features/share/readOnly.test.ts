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
 * **`AddToWishlist` imports one hook from outside this directory, and that import needs a fence of
 * its own.** `useWishlistFolderList` (`features/wishlist/useWishlistFolders.ts`) calls
 * `ipc.wishlistFolderList` in *its* file, where this glob cannot see it. That much is safe on the
 * paragraph above's own terms — what it forbids is a helper this directory can point at an
 * **arbitrary** command, and that hook names one fixed read and takes no argument at all, so
 * nothing here can steer it. Reaching it is also what keeps the app's wishlist folders one query
 * rather than two cache entries that agree today.
 *
 * ⚠️ **But the module it comes from also exports `useWishlistFolders`, which carries
 * `create`/`rename`/`move`/`reorder`/`remove`.** Changing one identifier on that import line hands
 * this directory a folder-*creating* write — exactly the control `AddToWishlist`'s own header and
 * spec §8 say must not exist here — and **every other assertion in this file stays green**, because
 * {@link BACK_DOORS} is about `ipc` and nothing else constrains what is imported from a sibling
 * feature. So {@link OUTSIDE_IMPORTS} enumerates the names this directory may take from outside
 * `features/share/`, in the shape {@link SHARE_WRITES} already uses: a short list, and a diff that
 * adds to it is a diff a reviewer reads.
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

/**
 * Every name this directory may import from a **sibling feature**, and there are two.
 *
 * * `BUTTON` — `features/settings/controls`. A class string; it reaches nothing.
 * * `useWishlistFolderList` — `features/wishlist/useWishlistFolders`. One fixed read
 *   (`ipc.wishlistFolderList`), no argument, no callback, so nothing here can steer it — and
 *   using it is what keeps the app's folder list one query instead of two cache entries.
 *
 * **The name that must never appear is `useWishlistFolders`**, its neighbour in the same module,
 * which carries five folder writes. It would give this view a folder-creating control, which spec
 * §8 defers and this directory's own doc comments forbid, and the `ipc.*` sweep above cannot see
 * a single call of it.
 *
 * `@/lib/*` and `@/components/*` are deliberately outside this list: they are the app's shared
 * floor rather than another feature's surface, and `ipc.ts` is already fenced by name.
 */
const OUTSIDE_IMPORTS: readonly string[] = ["BUTTON", "useWishlistFolderList"];

/** A named-import list taken from another feature — `import { a, b as c } from "@/features/…"`. */
const CROSS_FEATURE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"@\/features\/([^"]*)"/g;

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

  /**
   * And the hole the `ipc.*` sweep structurally cannot see: a **hook** imported from another
   * feature that does the calling somewhere this glob does not reach.
   *
   * It is one identifier away from real — `useWishlistFolderList` and `useWishlistFolders` are
   * neighbours in one module and the second carries five folder writes — and the swap leaves
   * every other assertion in this file green.
   */
  it("imports only the named few it is allowed to, from other features", () => {
    let seen = 0;
    for (const [path, source] of SOURCES) {
      for (const [, names, from] of source.matchAll(CROSS_FEATURE)) {
        // A file's imports from `features/share/` itself are this directory's own business and
        // are already covered by the sweep, since they are swept files too.
        if (from.startsWith("share/")) continue;
        for (const spec of names.split(",")) {
          const name = spec.trim().split(/\s+as\s+/)[0].trim();
          if (name === "") continue;
          seen += 1;
          expect(
            OUTSIDE_IMPORTS,
            `${path} imports ${name} from @/features/${from}. Everything in ` +
              "src/features/share/ renders a document somebody else published, and a hook from " +
              "another feature can reach commands this file's ipc sweep never sees — " +
              "`useWishlistFolders` next door carries five folder writes. Add the name to " +
              "OUTSIDE_IMPORTS in readOnly.test.ts in the same commit and say why.",
          ).toContain(name);
        }
      }
    }
    // A regex that stopped matching would pass this over an empty set, which is the same
    // vacuity the glob's own tripwire above exists for.
    expect(seen).toBeGreaterThan(0);
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
