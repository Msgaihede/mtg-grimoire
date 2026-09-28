/**
 * **Where the caret goes after a token write takes a tile away or puts one on** — Remove printing
 * on the band and on the pile in all four views, and a pick in the printing picker.
 *
 * The live pass of 2026-09-28 found every one of those presses leaving the caret on `<body>`: the
 * removed tile unmounts with the control the caret was on, and the picker's panel goes with the
 * pick, so the next Tab restarted at the top of the app. `DeckEditor`'s `setQuantityAt` already
 * answers the same failure for a deck card — the stepper's zero hands the caret to the pile the
 * card left, by an owed target found **by attribute** after the re-render (`focusDeckGroup`) — and
 * this is that pattern for tokens, with two differences the tokens need:
 *
 * - **It waits for the write's answer, and does nothing on a refusal.** A card's zero is taken out
 *   of the cache optimistically, so the card is gone at the press; a token's tile goes only when
 *   the re-read lands. A target chosen at the press would be *connected then and unmounted by the
 *   re-read* — the trap `focus-restore-target-is-connected-but-doomed` records — so the target is
 *   resolved against the list the re-read drew, in an effect after that render. A refused write
 *   unmounts nothing, and the caret stays on the control that was pressed.
 * - **The target is an entry, found by its key.** A tile's `entryKey` is the printing and the
 *   finish, stable across the re-read, so `TOKEN_ENTRY_ATTR` names it on every surface and the
 *   control is looked up inside it: its Remove printing where it draws one, its picture otherwise
 *   (an implicit entry is not stored, so it has no Remove).
 *
 * **Where the caret lands after Remove printing**, on the band and in the pile alike
 * ({@link caretEntryAfterRemove}): the same token's next entry, else its previous one; then the
 * next token, else the previous one; then the surface's floor. **The band's floor is its Add
 * printing. The pile's is the band's Add printing too, and that is the honest answer rather than
 * a shortcut**: the pile's heading grip is the natural floor, but the floor is only reached when
 * the pile has no entry left — and a pile with no entry is not drawn (`hasTokenPile`), grip and
 * all. The band's Add printing is the one control left on the screen that puts a token back.
 *
 * **After a pick** ({@link usePickCaret}) the caret goes to the picked tile's picture on the surface
 * the picker was opened from, and back to the opener where it cannot be found; Escape and the ✕
 * hand it back to the opener, which is `Dialog`'s own `onDismiss` contract.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { tileKeyOf } from "@/lib/tileKey";
import type { DeckTokenView, TokenEntryRef } from "./deckTokens";

/** On an entry's tile, line or row: its `entryKey`. The one box an entry's controls sit in. */
export const TOKEN_ENTRY_ATTR = "data-token-entry";
/** On an entry's Remove printing. */
export const TOKEN_REMOVE_ATTR = "data-token-remove";
/** On an entry's picture press — the control every entry draws, stored or implicit. */
export const TOKEN_ART_ATTR = "data-token-art";
/** On the band's Add printing — the caret's floor when no token is left to hand it to. */
export const TOKEN_ADD_ATTR = "data-token-add";
/** On the band's own box — the surface a pick from the band hands the caret back into. The
 *  pile's is `TOKEN_PILE_ATTR`, which the views already carry. */
export const TOKEN_BAND_ATTR = "data-token-band";

/** What an entry's box spreads to be found: its key under {@link TOKEN_ENTRY_ATTR}. */
export function tokenEntryProps(view: Pick<DeckTokenView, "entryKey">) {
  return { [TOKEN_ENTRY_ATTR]: view.entryKey };
}

/** Spread on an entry's Remove printing, on every surface. */
export const TOKEN_REMOVE_MARK = { [TOKEN_REMOVE_ATTR]: "" };
/** Spread on an entry's picture press, on every surface. */
export const TOKEN_ART_MARK = { [TOKEN_ART_ATTR]: "" };
/** Spread on the band's Add printing. */
export const TOKEN_ADD_MARK = { [TOKEN_ADD_ATTR]: "" };

/** A control that can still take the caret: in the document and not `disabled`. A pressed
 *  control whose tile the re-read replaced is connected until it is not, which is why this is
 *  asked at the moment of focusing and never at the press. */
export function focusable(element: Element | null | undefined): HTMLElement | null {
  if (!(element instanceof HTMLElement) || !element.isConnected) return null;
  return element.matches(":disabled") ? null : element;
}

/**
 * One entry's control inside `root` — its Remove printing, or its picture where it draws no
 * Remove (`prefer: "remove"`); its picture alone (`prefer: "art"`). `null` when the entry is not
 * drawn there.
 *
 * **The key is compared, never interpolated into a selector**: an `entryKey` is a printing id and
 * a finish joined by `:`, and a selector built from it would be a second spelling of the key's
 * escaping to keep right.
 */
export function entryControl(
  root: ParentNode | null,
  key: string,
  prefer: "remove" | "art",
): HTMLElement | null {
  if (root === null) return null;
  for (const box of root.querySelectorAll<HTMLElement>(`[${TOKEN_ENTRY_ATTR}]`)) {
    if (box.getAttribute(TOKEN_ENTRY_ATTR) !== key) continue;
    const remove =
      prefer === "remove" ? box.querySelector<HTMLElement>(`[${TOKEN_REMOVE_ATTR}]`) : null;
    return remove ?? box.querySelector<HTMLElement>(`[${TOKEN_ART_ATTR}]`);
  }
  return null;
}

/** An entry reference's key — {@link DeckTokenView.entryKey}'s own spelling. */
export function entryKeyOf(entry: { cardId: string; finish: string | null }): string {
  return tileKeyOf(entry.cardId, entry.finish);
}

/**
 * Whether a list shows `removed` gone: no **stored** entry at its key. A derived token whose last
 * stored entry was removed can come back as its implicit entry at the very same printing and
 * finish — the same key, and a tile that no longer draws the Remove the caret was on — so an
 * implicit entry at the key counts as gone.
 */
export function removalShown(after: readonly DeckTokenView[], removedKey: string): boolean {
  return !after.some((view) => view.entryKey === removedKey && !view.implicit);
}

/**
 * **Which entry the caret goes to after `removed` left `before`**, read off `after` — the list the
 * surface draws once the re-read has landed. In order:
 *
 * 1. **The same token's next remaining entry, else its previous one** — by position among the
 *    token's entries, so the entry that followed the removed one (and now sits where it was) is
 *    next. That includes an implicit entry a derived token falls back to.
 * 2. **The next token's first entry, else the previous token's last** — tokens in `before`'s order,
 *    so the token that sat after the removed one is next.
 * 3. **`null`**: nothing is left to hand it to, and the surface's floor takes it.
 */
export function caretEntryAfterRemove(
  before: readonly DeckTokenView[],
  after: readonly DeckTokenView[],
  removedKey: string,
): string | null {
  const removed = before.find((view) => view.entryKey === removedKey);
  if (removed === undefined) return null;
  const sameBefore = before.filter((view) => view.oracleId === removed.oracleId);
  const index = sameBefore.findIndex((view) => view.entryKey === removedKey);
  const sameAfter = after.filter((view) => view.oracleId === removed.oracleId);
  if (sameAfter.length > 0) return (sameAfter[index] ?? sameAfter[sameAfter.length - 1]).entryKey;

  const tokens = [...new Set(before.map((view) => view.oracleId))];
  const at = tokens.indexOf(removed.oracleId);
  const entriesOf = (oracleId: string) => after.filter((view) => view.oracleId === oracleId);
  for (const oracleId of tokens.slice(at + 1)) {
    const entries = entriesOf(oracleId);
    if (entries.length > 0) return entries[0].entryKey;
  }
  for (const oracleId of tokens.slice(0, at).reverse()) {
    const entries = entriesOf(oracleId);
    if (entries.length > 0) return entries[entries.length - 1].entryKey;
  }
  return null;
}

/**
 * A target for an owed caret, asked after every render that follows the write's answer:
 * an element to focus, `null` to give up (the caret stays where the render left it), or
 * {@link NOT_YET} while the list on screen does not show the write yet.
 */
export const NOT_YET = Symbol("not yet");
export type CaretResolver = (views: readonly DeckTokenView[]) => HTMLElement | null | typeof NOT_YET;

/**
 * **A caret owed by a token write** — the mechanism both hand-offs share.
 *
 * `owe(written, resolve, refused)`: once `written` answers `true`, `resolve` is asked after each
 * render until it names a target (or gives up), and that target is focused; if it answers `false`,
 * `refused()` is focused instead (or nothing moves, where it answers `null`). A later `owe`
 * replaces an earlier one that has not resolved, so two presses never race for the caret.
 *
 * **After the render, never at the answer**: the answer arrives before the re-read that shows it,
 * and a target found then would be one the re-read is about to replace. `views` is the list the
 * surface draws, so an effect on it runs once the new list has committed. The answer itself
 * bumps a state, so a re-read that landed *before* the answer is still resolved.
 */
export function useOwedCaret(views: readonly DeckTokenView[]) {
  const owed = useRef<{ answered: boolean; resolve: CaretResolver } | null>(null);
  const [answers, setAnswers] = useState(0);

  const owe = useCallback(
    (
      written: Promise<boolean> | void,
      resolve: CaretResolver,
      refused: () => HTMLElement | null,
    ) => {
      const pending = { answered: false, resolve };
      owed.current = pending;
      void Promise.resolve(written).then((landed) => {
        if (owed.current !== pending) return;
        if (landed === false) {
          owed.current = null;
          refused()?.focus();
          return;
        }
        pending.answered = true;
        setAnswers((n) => n + 1);
      });
    },
    [],
  );

  useEffect(() => {
    const pending = owed.current;
    if (pending === null || !pending.answered) return;
    const target = pending.resolve(views);
    if (target === NOT_YET) return;
    owed.current = null;
    target?.focus();
  }, [views, answers]);

  return owe;
}

/**
 * **Remove printing that hands the caret on** — `remove` wrapped for one surface.
 *
 * `views` is what the surface draws (the band every entry, the pile the counted ones), `root` the
 * surface's box to look the control up in, and `fallback` its floor: the band's Add printing, the
 * pile's grip or, where the pile has gone with its last token, the band's Add printing. The target
 * is {@link caretEntryAfterRemove}'s entry's Remove, or its picture where it draws none; a refusal
 * leaves the caret on the Remove that was pressed.
 */
export function useRemoveCaret({
  views,
  remove,
  root,
  fallback,
}: {
  views: readonly DeckTokenView[];
  remove: ((entry: TokenEntryRef) => Promise<boolean> | void) | undefined;
  root: () => ParentNode | null;
  fallback: () => HTMLElement | null;
}): ((entry: TokenEntryRef) => void) | undefined {
  const owe = useOwedCaret(views);
  const removeAt = useCallback(
    (entry: TokenEntryRef) => {
      if (remove === undefined) return;
      const before = views;
      const removedKey = entryKeyOf(entry);
      owe(
        remove(entry),
        (after) => {
          if (!removalShown(after, removedKey)) return NOT_YET;
          const key = caretEntryAfterRemove(before, after, removedKey);
          return (key === null ? null : entryControl(root(), key, "remove")) ?? fallback();
        },
        // Refused: nothing unmounted, so the caret is still on the Remove that was pressed.
        () => null,
      );
    },
    [remove, views, owe, root, fallback],
  );
  return remove === undefined ? undefined : removeAt;
}

/**
 * **A pick in the printing picker that hands the caret on** — to the tile the pick made (a swap's
 * new printing, an added one) on the surface the picker was opened from, once the re-read draws
 * it; to the control that opened the picker where the tile cannot be found, or where the write
 * was refused.
 *
 * `views` is every entry (the band's list): a picked key is looked for there, and a pick onto a
 * key the list already held — a fold — is found at once. `surface` is the box the opener sat in,
 * looked up at the moment of focusing rather than held, since a view switch could replace it.
 * `handBack` is the opener, or the floor where the opener went with its tile (a swap takes its own
 * entry away).
 */
export function usePickCaret(views: readonly DeckTokenView[]) {
  const owe = useOwedCaret(views);
  return useCallback(
    (
      written: Promise<boolean> | void,
      picked: { cardId: string; finish: string | null },
      surface: () => ParentNode | null,
      handBack: () => HTMLElement | null,
    ) => {
      const key = entryKeyOf(picked);
      owe(
        written,
        (after) => {
          if (!after.some((view) => view.entryKey === key)) return NOT_YET;
          return entryControl(surface(), key, "art") ?? handBack();
        },
        handBack,
      );
    },
    [owe],
  );
}
