import { skipToken, useQuery } from "@tanstack/react-query";
import {
  emptyTagsSentence,
  ORACLE_TAG_STATUS_KEY,
  ORACLE_TAGS_AS_OF,
  ORACLE_TAGS_NO_ORACLE_CARD,
  oracleTagsKey,
  slugsFor,
} from "@grimoire/ui/features/card/oracleTags";
import { ipc, ipcError, type OracleTagStatus } from "@grimoire/ui/lib/ipc";
import { Note, SheetSection, Source } from "./parts";

/**
 * The card's **Oracle tags** — what it *does* — as a read-only run of pills.
 *
 * **The desktop's two reads under the desktop's two keys** (`OracleTagsDialog`'s, out of
 * `@/features/card/oracleTags`), so a card whose tags one face has read is warm on the other, and
 * all four printings of a card share one answer: tags are a fact about the oracle card, not about
 * a piece of cardboard.
 *
 * **Four states that are not pills, and two of them must never share a sentence.** An empty
 * answer is either a taxonomy this database has never fetched or a card Tagger's editors have not
 * tagged — the command answers both with `[]` on purpose, so the status row decides between them
 * and nothing is drawn until it has. A card with no oracle id asks nothing at all, and a refused
 * read says so in the backend's words rather than reading as an absence.
 *
 * **No Art tags here, and that is not an omission this section can fix.** Art tags are what an
 * illustration *shows*; no command answers them for one card, and the desktop's card modal draws
 * none either. They are the Tags page's.
 */
export function OracleTagsSection({ oracleId }: { oracleId: string | null }) {
  const tags = useQuery({
    queryKey: oracleTagsKey(oracleId ?? ""),
    // No call at all for a card with no oracle id: the command matches on `cards.oracle_id`, so a
    // null id has nothing to ask about and the answer is known here without a round trip.
    queryFn: oracleId !== null ? () => ipc.oracleTagsForCards([oracleId]) : skipToken,
  });
  const status = useQuery<OracleTagStatus>({
    queryKey: ORACLE_TAG_STATUS_KEY,
    queryFn: () => ipc.oracleTagsStatus(),
  });
  const slugs = slugsFor(tags.data, oracleId);

  return (
    <SheetSection title="Oracle tags">
      {oracleId === null ? (
        <Note>{ORACLE_TAGS_NO_ORACLE_CARD}</Note>
      ) : tags.isError ? (
        <Note tone="alert">{`Couldn't read the tags — ${ipcError(tags.error)}.`}</Note>
      ) : tags.isPending || status.isPending ? (
        // Both reads, not just the tag one: the sentence an empty answer gets is *decided* by the
        // status row, so drawing before it lands would flash whichever of the two claims the
        // default happened to be.
        <Note>Loading tags…</Note>
      ) : slugs.length > 0 ? (
        // The slug verbatim, not a prettified version of it: `CardTags` carries slugs and no
        // labels, so a title-cased "Spot Removal" would be a name this face invented — and the
        // slug is what the search box's `otag:` keyword resolves against.
        <ul aria-label="Oracle tags" className="flex flex-wrap gap-1.5">
          {slugs.map((slug) => (
            <li key={slug} className="rounded-full border border-border px-2.5 py-1 text-xs">
              {slug}
            </li>
          ))}
        </ul>
      ) : (
        <Note>{emptyTagsSentence(status.data)}</Note>
      )}
      <Source>{ORACLE_TAGS_AS_OF}</Source>
    </SheetSection>
  );
}
