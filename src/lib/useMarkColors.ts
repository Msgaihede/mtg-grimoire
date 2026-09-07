import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { labelFgCss, normalizeLabelColor } from "@/lib/hexColor";

/**
 * What colour each card mark is drawn in — the reader's choice, and the four custom properties it
 * becomes.
 *
 * ## Why custom properties rather than a prop or a store read
 *
 * The theory mark is drawn on four surfaces (the stack's banner, the grid tile's chip, the
 * table's badge and the text columns'), and none of them decides its colour. Threading a hex from
 * `DeckEditor` through `StackView → CardStack → row` and through two more views is five props for
 * a value nobody on the path has an opinion about; reading a store inside the mark puts a
 * subscription in a component that renders once per card on a wall of two hundred.
 *
 * So the colour lives on `:root`, `index.css` holds the defaults, and this writes over them. The
 * marks name a variable and stay dumb — which is also what lets a story or a vitest render draw
 * the real colours with no provider and no seeding.
 *
 * **No Tailwind arbitrary value anywhere in it.** A mistyped `bg-[…]` emits no CSS at all and
 * fails nothing, and a mark that has quietly lost its fill is invisible to both suites.
 *
 * ## An uncustomised mark is left alone
 *
 * Absent means absent: nothing is written for a mark the reader has never chosen, so the
 * stylesheet's own value stands and a future palette change moves it. Writing today's default
 * inline would pin it forever — the cost `labelColors.ts` records for a stored label colour, paid
 * for nothing.
 *
 * ## What it takes from `useNavCollapsed`, and the one thing it does not
 *
 * The query/mutation shape is that hook's, down to `staleTime: Infinity` and the optimistic
 * `setQueryData` before `mutate`: one `app_meta` row, read once per app run, whose cache entry
 * **is** where the value lives. What differs is that **this write's refusal is surfaced**.
 * `set_mark_color` answers `BUSY` while a sync holds the write connection exactly as
 * `set_nav_collapsed` does, and the rail swallows that because the reader cannot see what was
 * lost until the next launch — here they are standing in front of a colour picker watching a
 * swatch, so the panel says the write did not land. `markcolors.rs` states the same split from
 * its own end.
 *
 * The reader's colour is still kept for the session when a write is refused, exactly as the rail
 * keeps its fold: taking the swatch back *and* explaining why is the rail's silent trade with
 * the compensation removed.
 */

/**
 * The query key, exported for `NAV_COLLAPSED_KEY`'s reason: a story or a test that wants the
 * window to open on a chosen colour seeds the cache rather than mocking the command, and a key
 * spelled twice is a key that drifts.
 */
export const MARK_COLORS_KEY: readonly string[] = ["markColors"];

/**
 * The marks this build can colour, and the whole of the vocabulary.
 *
 * **This side owns which marks exist** — `markcolors.rs` validates the *shape* of a colour and
 * knows nothing about a theory tick — so a key a newer build wrote is read out of the row and
 * dropped here rather than becoming a colour. The array's order is the order
 * {@link useMarkColors} answers in and the order the Appearance panel draws.
 */
export const MARK_COLOR_KEYS = ["theoryExact", "theoryName"] as const;

export type MarkColorKey = (typeof MARK_COLOR_KEYS)[number];

/**
 * What `index.css` draws each mark in, spelled a second time so the picker has a value to open
 * on and a Reset has something to draw once the row is cleared.
 *
 * **A `var(--color-theory-exact)` cannot be an `<input type="color">`'s value**, which is the
 * whole reason these are literals here and in the stylesheet both — `LABEL_COLORS`' argument one
 * folder over, where a hex is written to a column rather than read into a control.
 *
 * **The duplicate is deliberate and the fence is what makes it safe.**
 * `useMarkColors.test.ts`' `the defaults against the palette` reads `src/index.css` through
 * Vite's `?raw` and compares each entry here against the declaration for that mark's own custom
 * property — `labelColors.test.ts`' arrangement for `LABEL_COLORS`, copied because the duplication
 * is the same duplication. Without it a palette edit that moved `--color-theory-exact` and left
 * this alone would ship a picker opening on a colour the mark is not drawn in, with nothing red
 * anywhere, and it reddens from **either** side: neither spelling is the specification, and that
 * they cannot come apart is. (This comment claimed the fence existed before it did, and then said
 * it was owed; it was written on 2026-09-07.)
 */
export const MARK_COLOR_DEFAULTS: Readonly<Record<MarkColorKey, string>> = {
  theoryExact: "#56bd78",
  theoryName: "#0e68ab",
};

/**
 * Which custom property each mark writes. The `-fg` is that name with the suffix, so the pair
 * cannot come apart.
 */
const MARK_COLOR_VARS: Readonly<Record<MarkColorKey, string>> = {
  theoryExact: "--color-theory-exact",
  theoryName: "--color-theory-name",
};

/** Is this one of the marks this build draws? `ipc.markColors` answers `Record<string, string>`
 *  for exactly this reason — the keys are this side's to narrow. */
export function isMarkColorKey(key: string): key is MarkColorKey {
  return (MARK_COLOR_KEYS as readonly string[]).includes(key);
}

/** The stored row, read once per app run. Both hooks below take these same options, so the two
 *  share one cache entry and one fetch. */
function markColorsQuery() {
  return {
    queryKey: MARK_COLORS_KEY,
    queryFn: () => ipc.markColors(),
    // Nothing else writes this row, so there is nothing to go stale against — every change goes
    // through the mutation below, which writes the answer straight into the cache.
    staleTime: Infinity,
    gcTime: Infinity,
  };
}

/** A rejected write as a sentence. Rust rejects with a `String`, so the common case is already
 *  one; anything else is a boundary failure and is worded rather than dropped. */
function sentence(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "The colour could not be saved.";
}

/** A colour the field could not make sense of — refused here rather than at the far end, because
 *  `markcolors.rs` would answer the same and a round trip buys nothing. */
const UNREADABLE = "That is not a colour — six hex digits, like #56bd78.";

/**
 * The colour of each mark, and the two writes that change one.
 *
 * `colors` is **stored, else the default**: a mark the reader has never chosen answers what
 * `index.css` draws it in, so a picker opens on the real colour and a swatch reads as pressed
 * without the row ever having held an entry.
 */
export function useMarkColors(): {
  colors: Readonly<Record<MarkColorKey, string>>;
  setColor: (key: MarkColorKey, hex: string) => void;
  resetColor: (key: MarkColorKey) => void;
  failure: string | null;
} {
  const queryClient = useQueryClient();
  const query = useQuery(markColorsQuery());
  // A colour the field could not make sense of never becomes a mutation, so it needs a home of
  // its own: `write.error` can only speak for a command that was actually sent. Cleared by the
  // next press either way, which is what `useMutation` does with its own error.
  const [refused, setRefused] = useState<string | null>(null);

  const write = useMutation({
    mutationFn: ({ key, hex }: { key: MarkColorKey; hex: string | null }) =>
      ipc.setMarkColor(key, hex),
  });

  const startWrite = write.mutate;
  const stored = query.data;

  // The optimistic half, `useNavCollapsed`'s arrangement: the cache is written before the command
  // is sent, so the swatch and every mark on screen move on the press rather than a round trip
  // later. `null` **deletes** the entry — a reset has to leave the reader in the state they were
  // in before they ever chose, and the default written back is a different state.
  const put = useCallback(
    (key: MarkColorKey, hex: string | null) => {
      queryClient.setQueryData<Record<string, string>>(MARK_COLORS_KEY, (row) => {
        const next = { ...(row ?? {}) };
        if (hex === null) delete next[key];
        else next[key] = hex;
        return next;
      });
      startWrite({ key, hex });
    },
    [queryClient, startWrite],
  );

  const setColor = useCallback(
    (key: MarkColorKey, hex: string) => {
      // `markcolors.rs` refuses shorthand outright so the row cannot hold two spellings of one
      // colour, and says in its own doc that this side expands it first. This is that side.
      const normalised = normalizeLabelColor(hex);
      if (normalised === null) {
        // Nothing is sent and nothing is cached, so the refusal is the only thing that moves.
        setRefused(UNREADABLE);
        return;
      }
      setRefused(null);
      put(key, normalised);
    },
    [put],
  );

  const resetColor = useCallback(
    (key: MarkColorKey) => {
      setRefused(null);
      put(key, null);
    },
    [put],
  );

  const colors = {} as Record<MarkColorKey, string>;
  for (const key of MARK_COLOR_KEYS) {
    // A stored entry this build cannot read is the default, never the junk: the backend refuses
    // anything but `#rrggbb` on the way in, so what is left is a hand-edited row or a spelling a
    // future build wrote, and a mark drawn in an unparseable string is drawn in no colour at all.
    colors[key] = normalizeLabelColor(stored?.[key]) ?? MARK_COLOR_DEFAULTS[key];
  }

  return {
    colors,
    setColor,
    resetColor,
    failure: refused ?? (write.error === null ? null : sentence(write.error)),
  };
}

/**
 * Publish the reader's colours on `document.documentElement`. `AppShell` calls this once, for the
 * life of the window.
 *
 * It reads the same query under the same key as {@link useMarkColors}, so the two share one fetch
 * and a write made in Settings repaints every mark in the app with no second read.
 *
 * **A mark with no stored entry has its properties _removed_ rather than set to the default.**
 * An inline property on `:root` beats the stylesheet's own, so writing today's default would pin
 * it against every future palette change — which is the one thing an absent entry is protecting.
 * Removal rather than "never written" because a Reset has to put a mark back after a colour has
 * already been published in this session.
 */
export function useMarkColorVars(): void {
  const { data } = useQuery(markColorsQuery());

  useEffect(() => {
    const root = document.documentElement;
    for (const key of MARK_COLOR_KEYS) {
      const chosen = normalizeLabelColor(data?.[key]);
      const prop = MARK_COLOR_VARS[key];
      if (chosen === null) {
        root.style.removeProperty(prop);
        root.style.removeProperty(`${prop}-fg`);
      } else {
        root.style.setProperty(prop, chosen);
        // The mark is a filled box with a tick or a signed number on it, so a pale custom green
        // needs the near-black the label picker's own colours get — one formula, one answer.
        root.style.setProperty(`${prop}-fg`, labelFgCss(chosen));
      }
    }
  }, [data]);
}
