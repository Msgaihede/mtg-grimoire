import { useCallback, useState } from "react";

/** What {@link useSeededDrafts} hands a form: each box's text, and the ways to move it. */
export interface SeededDrafts<K extends string> {
  /** Each box's text: the reader's draft, or what is stored where they have not typed. */
  drafts: Readonly<Record<K, string>>;
  /** One box typed in. */
  setDraft: (key: K, text: string) => void;
  /** Several boxes said anew at once — a committed figure written back in its own form. */
  setDrafts: (texts: Partial<Record<K, string>>) => void;
  /** Every box back to what is stored, drafts and all — a Reset that stored nothing new. */
  reseed: () => void;
  /** Whether a box says something other than what is stored: a draft not yet taken. */
  edited: (key: K) => boolean;
}

/**
 * Controlled drafts for a row of settings boxes, each re-seeded when its stored figure moves.
 *
 * **Never by React `key` (issue #1589).** A box keyed by its stored figure is a new DOM node the
 * moment a commit stores it, so Enter dropped focus to the page; and a refused draft, which stores
 * nothing, was never re-seeded, so it stayed on screen after the next box's commit cleared the
 * sentence. Here a box is the same node for its whole life, and only a box whose *own* seed moved
 * — a commit, another window's change, a write put back on a refusal — loses its draft; the rest
 * keep theirs.
 *
 * The re-seed happens during render (React's "adjusting state when a prop changes"), not in an
 * effect, so no frame ever draws the old figure beside the new one.
 */
export function useSeededDrafts<K extends string>(seeds: Record<K, string>): SeededDrafts<K> {
  const [state, setState] = useState(() => ({ seeds, drafts: seeds }));

  let current = state;
  const keys = Object.keys(seeds) as K[];
  if (keys.some((k) => seeds[k] !== state.seeds[k])) {
    const drafts = { ...state.drafts };
    for (const k of keys) if (seeds[k] !== state.seeds[k]) drafts[k] = seeds[k];
    current = { seeds, drafts };
    setState(current);
  }

  const setDraft = useCallback(
    (key: K, text: string) => setState((s) => ({ ...s, drafts: { ...s.drafts, [key]: text } })),
    [],
  );
  const setDrafts = useCallback(
    (texts: Partial<Record<K, string>>) =>
      setState((s) => ({ ...s, drafts: { ...s.drafts, ...texts } })),
    [],
  );
  const reseed = useCallback(() => setState((s) => ({ ...s, drafts: s.seeds })), []);

  const { drafts } = current;
  const edited = (key: K) => drafts[key] !== seeds[key];
  return { drafts, setDraft, setDrafts, reseed, edited };
}
