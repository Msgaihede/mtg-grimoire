import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import { DEFAULT_FORMAT } from "./FormatSelect";
import { pickerFormats, useFormatSpecs, type FormatOption } from "./useFormatSpecs";

/**
 * What the New deck dialog starts on for a reader who has never made one.
 *
 * **Deliberately not {@link DEFAULT_FORMAT}, and the two are answers to different questions.**
 * `casual` is `decks.format_key`'s own DDL default and `deck::DEFAULT_FORMAT` — it is what "this
 * deck was given no format" resolves to, a deck that caps nothing and is judged against no card
 * pool. That is the right answer for a deck nobody chose a format for, and the wrong one for a
 * dialog *asking* the reader to choose: an empty gallery's first deck is far more likely to be
 * Commander than to be nothing in particular, and offering `casual` first spends the reader's
 * first act on correcting it.
 *
 * Commander is also really on the picker to be offered — `enabled_in_picker` is `1` on its row
 * of `schema.rs`'s `FORMAT_SPECS_SEED` — which is a fact about the seed and therefore checked
 * rather than assumed: {@link newDeckFormat} tests it against the picker like any other key.
 */
export const FIRST_DECK_FORMAT = "commander";

/**
 * What a new deck's format select should be set to — the whole rule, as a pure function.
 *
 * ```
 * lastFormat, if the picker holds it
 * else FIRST_DECK_FORMAT, if the picker holds it
 * else DEFAULT_FORMAT
 * ```
 *
 * **The membership tests are the point, not defensive padding.** A `<select>` whose `value` is
 * not among its `<option>`s shows the wrong row — browsers fall back to the first option — so
 * the reader is told their deck will be one format while the state says another, and the lie
 * becomes real the moment they touch any other field and the draft is committed. Two states
 * reach this function that way, and both are ordinary rather than theoretical:
 *
 * * **A format that left the seed.** `decks.format_key` is deliberately not a foreign key and
 *   `format_specs` is re-seeded by migrations (`INSERT OR REPLACE`, so a row can be dropped from
 *   the seed or have `enabled_in_picker` cleared), and `deck_last_format` answers the stored
 *   fact unvalidated. A remembered key this build no longer offers is a state that exists.
 * * **The one launch where `format_specs` has not answered yet.** `pickerFormats(specs)` is `[]`
 *   until the query resolves, and both dialogs already draw a single `Casual` option for that
 *   moment — `FormatSelect`'s `picker.length === 0` arm and `CreateDeckDialog`'s `CASUAL_ONLY`.
 *   **The third arm is what makes the *value* fall back with them**, and it is the reason
 *   **no fallback rendering has to change anywhere**. It looks removable — an empty picker holds
 *   neither key, so the first two arms already decline — which is exactly why it is written
 *   down: delete it and the select renders `Casual` while the draft says `commander`.
 */
export function newDeckFormat(
  picker: readonly FormatOption[],
  lastFormat: string | null | undefined,
): string {
  const offered = (key: string) => picker.some((f) => f.key === key);
  if (lastFormat && offered(lastFormat)) return lastFormat;
  if (offered(FIRST_DECK_FORMAT)) return FIRST_DECK_FORMAT;
  return DEFAULT_FORMAT;
}

/**
 * The format a new deck starts on, resolved: the reader's last choice where this build can still
 * offer it, and {@link FIRST_DECK_FORMAT} where it cannot.
 *
 * **Mounted by `DecksPage`, precisely because that is _not_ the surface that draws the picker.**
 * The gallery is up long before **New deck** is pressed, so by press time this answer is real
 * and `CreateDeckDialog`'s `Panel` can seed its draft in a lazy `useState` initializer —
 * mount-only, with no effect that could land on top of a format the reader has already picked,
 * and no `useEffect` able to tell "the answer just arrived" from "they have not touched it yet".
 * Moving this into the dialog would put the read and the seeding in the same moment and lose
 * exactly that. **The cost is a read, and it is real**: opening the Decks view and never
 * pressing New deck now issues one `deck_last_format` the old code did not. It is one
 * `app_meta` row from local SQLite, against a view that is already asking for the whole wall.
 *
 * **The key is `["decks", "lastFormat"]`, under the `["decks"]` root on purpose.** `useDecks`'
 * mutations — and `CreateDeckDialog`'s create, on success *and* on error — invalidate that whole
 * root, so making a deck refreshes this answer for free and **no call site has to remember to
 * invalidate anything**. The alternative, a root of its own, is one more thing every future
 * create path would have to know about, which is precisely the coupling `deck_create` owning the
 * write was chosen to avoid.
 *
 * A pending read and a refused one are both `undefined`, which lands on the same arm as "no deck
 * has ever been made" — and that is correct rather than convenient. **A preference that cannot be
 * read falls back on its default; it never fails a dialog.** The cost of a refusal here is that
 * the reader re-picks a format they picked last time, and there is nothing worth saying about it
 * on a panel whose subject is the deck they are trying to make.
 */
export function useNewDeckFormat(): string {
  const { specs } = useFormatSpecs();
  // No `keep` row: this answer is only ever wanted before a deck exists, so there is no format
  // already chosen that the seed might no longer offer.
  const picker = useMemo(() => pickerFormats(specs), [specs]);

  const lastFormat = useQuery({
    queryKey: ["decks", "lastFormat"],
    queryFn: () => ipc.deckLastFormat(),
  });

  return newDeckFormat(picker, lastFormat.data);
}
