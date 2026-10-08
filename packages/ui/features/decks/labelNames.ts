/**
 * What makes two label names **the same name**.
 *
 * ## Why this exists twice
 *
 * The authority is `schema::label_name_key` in Rust, and it has to be: a label list that is one
 * row per name is a *table* property, so the fence is a `UNIQUE INDEX` on `deck_labels.name_key`
 * and the refusal is `deck_label_create`'s. Two windows racing the same new name is exactly what
 * an index is for and exactly what a check in a form cannot do.
 *
 * This copy is the **courtesy**, and it is worth its duplication for one reason: a reader who
 * types a name that already exists has not made a mistake — they have found the label they
 * wanted. Letting them press Add, wait for a round trip and read a refusal, when the label is
 * sitting in the list on the same screen, would be the app knowing the answer and declining to
 * say so. So the dialogs disable the button and point at the row instead.
 *
 * **They must agree, and the agreement is pinned rather than assumed**: `labelNames.test.ts` and
 * `deck_meta::tests::deck_label_create_compares_names_case_insensitively_and_normalised` walk the
 * same table of spellings. A drift shows up as the frontend offering to create something the
 * backend then refuses — annoying rather than dangerous, which is why the index stays the
 * authority and this stays a courtesy.
 *
 * ## The three passes
 *
 * Identical to the Rust doc's, for the same reasons:
 *
 * * **NFC** folds a combining accent onto the letter before it, so `Cafe` + U+0301 and the
 *   precomposed `Café` are one string. Both are typeable and which one arrives depends on the
 *   reader's keyboard rather than on what they meant.
 * * **`toLowerCase`** is the case-insensitive half. JavaScript's is the full Unicode mapping,
 *   like Rust's `to_lowercase` — not an ASCII fold, so `RAMPE` and `rampe` agree and so do
 *   `İ` and the Greek sigma's two lowercase forms.
 * * **NFC again**, because lowercasing can un-normalise: a few codepoints map to sequences that
 *   are not in composed form, and without the second pass those names key to something no
 *   re-normalised lookup ever matches again.
 *
 * Trimmed first, because a name is what a reader typed minus the whitespace they did not mean.
 */

/**
 * One label name as its identity key. **Never shown and never stored as the display name** — a
 * label keeps whatever capitals the reader chose, and this answers only "is that the same label".
 */
export function labelNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase().normalize("NFC");
}

/**
 * Whether `name` is already held by one of `labels` — the check both dialogs make before offering
 * to create anything.
 *
 * `exceptId` is the row allowed to hold it: `undefined` for a create, the row's own id for a
 * rename, which is what lets a reader recapitalise `removal` to `Removal` without being told
 * the name is taken by itself.
 */
export function findLabelByName<T extends { id: number; name: string }>(
  labels: readonly T[],
  name: string,
  exceptId?: number,
): T | undefined {
  const key = labelNameKey(name);
  // An empty name matches nothing rather than matching a label called nothing: `valid_name`
  // refuses a blank on the way in, so there is no such row to find and a caller asking about
  // one is a half-typed field rather than a duplicate.
  if (key === "") return undefined;
  return labels.find((t) => t.id !== exceptId && labelNameKey(t.name) === key);
}
