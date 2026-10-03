import { useId, type JSX, type ReactNode } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { ipc, type CardDetail, type OracleTagStatus } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { cardDetailKey } from "./cardDetailKey";
import {
  emptyTagsSentence,
  ORACLE_TAG_STATUS_KEY,
  ORACLE_TAGS_AS_OF,
  ORACLE_TAGS_NO_ORACLE_CARD,
  oracleTagsKey,
  slugsFor,
} from "./oracleTags";

/**
 * The card's Oracle tags, over the card detail modal.
 *
 * **Self-mounting, and drawn as a sibling of the modal rather than inside it.** It takes no props
 * and reads `cardOverlay` and `selectedCardId` off the store, which is the shape
 * `AllPrintingsDialog` already has and the one the card modal's panel forces: that panel is a
 * `@container/card` context, and a container box is the containing block for its `fixed`
 * descendants — so this dialog's `fixed inset-0` scrim rendered *inside* it would resolve against
 * the panel and cover the card modal and nothing else.
 *
 * `layer="stacked"` for the half of that hazard a container cannot fix. This opens **over**
 * another dialog, and at `LAYER.overlay` the two scrims would tie — two `fixed inset-0` boxes,
 * neither inside the other, in the root stacking context — with the winner decided by document
 * order. A rung is a claim about the highest thing a surface can be asked to cover.
 *
 * **Escape needs no code here.** `Dialog` registers its `"inner"` rung on the open flag, and this
 * one mounts after the card modal, so it lands above it on `useDismissOnEscape`'s capture stack
 * and takes the press.
 *
 * ## Three states, and the empty one is the point
 *
 * Scryfall's oracle taxonomy is optional by construction in this app: nothing downloads until it
 * is due, a failed fetch keeps whatever was already stored, and a database that has never fetched
 * it files deck adds by card type instead — the floor rather than an error. An empty panel would
 * read as "this card has no tags", which is a different claim and, on a first launch, a false
 * one. So an empty answer says which of the two it is, out of the status row —
 * `ORACLE_TAGS_NEVER_FETCHED` against `ORACLE_TAGS_UNTAGGED`, both in `./oracleTags` with the
 * phone sheet as their other reader — and never draws an empty box.
 */
export function OracleTagsDialog(): JSX.Element {
  const overlay = useAppStore((s) => s.cardOverlay);
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  const { marketplace } = useMarketplace();

  const open = overlay === "oracleTags" && cardId !== null;

  // **Every read below is gated on `open`**, which is what makes this component free to mount
  // unconditionally at `App` level: a dialog nobody has opened asks the backend nothing, exactly
  // as `Dialog`'s own "closed is nothing mounted" rule promises for its body. The card entry is
  // then almost always already in the cache — the modal underneath fetched it — so opening this
  // costs one small tag read and one small status read.
  const card = useQuery({
    queryKey: cardDetailKey(cardId, marketplace.id),
    queryFn: open && cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
  });

  const oracleId = card.data?.oracleId ?? null;

  const tags = useQuery({
    queryKey: oracleTagsKey(oracleId ?? ""),
    // **No call at all for a card with no oracle id.** The command matches on `cards.oracle_id`,
    // so a null id has nothing to ask about and the answer is known here without a round trip.
    queryFn: open && oracleId !== null ? () => ipc.oracleTagsForCards([oracleId]) : skipToken,
  });

  const status = useQuery<OracleTagStatus>({
    queryKey: ORACLE_TAG_STATUS_KEY,
    queryFn: open ? () => ipc.oracleTagsStatus() : skipToken,
  });

  return (
    <Dialog
      open={open}
      title="Oracle tags"
      subtitle={card.data?.name}
      closeLabel="Close oracle tags"
      size="w-[38.75rem]"
      layer="stacked"
      onDismiss={close}
      onClose={close}
    >
      <Body card={card.data ?? null} oracleId={oracleId} tags={tags} status={status} />
    </Dialog>
  );
}

/** One query's two facts, so {@link Body} can be handed a result without importing TanStack's
 *  whole observer type — and so a story or a test can stage one by hand. */
interface Reading<T> {
  data: T | undefined;
  isPending: boolean;
}

/**
 * The panel's contents, mounted only while it is open — `Dialog`'s own rule, and what keeps the
 * scroll position and every disclosure a session rather than something an effect has to reset.
 */
function Body({
  card,
  oracleId,
  tags,
  status,
}: {
  card: CardDetail | null;
  oracleId: string | null;
  tags: Reading<{ oracleId: string; slugs: string[] }[]>;
  status: Reading<OracleTagStatus>;
}) {
  const headingId = useId();

  // Matched back by id, never by position — see {@link slugsFor}.
  const slugs = slugsFor(tags.data, oracleId);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {card === null ? (
          <Note>Loading card…</Note>
        ) : oracleId === null ? (
          <Note>{ORACLE_TAGS_NO_ORACLE_CARD}</Note>
        ) : tags.isPending || status.isPending ? (
          // Both reads, not just the tag one: the sentence an empty answer gets is *decided* by
          // the status row, so drawing before it lands would flash whichever of the two claims
          // the default happened to be — and one of them is about the reader's database rather
          // than about their card.
          <Note>Loading tags…</Note>
        ) : slugs.length > 0 ? (
          <section aria-labelledby={headingId} className="space-y-2">
            <h3 id={headingId} className="text-xs uppercase tracking-wide text-dim">
              Tagged
            </h3>
            {/* The list keeps a name of its own, the more exact of the two: the heading says what
                the section is, this says what the items in it are. A reader moving list to list
                rather than heading to heading arrives here without the heading. */}
            <ul aria-label="Oracle tags" className="flex flex-wrap gap-1.5">
              {slugs.map((slug) => (
                <li
                  key={slug}
                  className="rounded-full border border-border px-2 py-0.5 text-[0.7rem]"
                >
                  {/* The slug verbatim, and not a prettified version of it. `CardTags` carries
                      slugs and no labels, so a title-cased "Spot Removal" would be a name this
                      file invented — and the slug is the string a reader can act on, since it is
                      what the search box's `otag:` keyword resolves against. */}
                  {slug}
                </li>
              ))}
            </ul>
          </section>
        ) : (
          // An unanswered status reads as never-fetched rather than as untagged — see
          // {@link emptyTagsSentence} for why that is the safe way round.
          <Note>{emptyTagsSentence(status.data)}</Note>
        )}
      </div>
      {/* Outside the scroller: the caption is about the whole panel, so it must not scroll away
          from the thing it qualifies. */}
      <p className="border-t border-border px-4 py-3 text-xs text-dim">{ORACLE_TAGS_AS_OF}</p>
    </>
  );
}

/**
 * One dim sentence in the body — every state that is not a wall of pills.
 *
 * **One text node, and that is load-bearing rather than tidy.** Testing Library reads an
 * element's *own* text children, so a sentence broken by a `<span>` becomes unfindable by
 * anything that queries it as a sentence — which is how a reader reads it, and how the test for
 * it is written. `LegalityDialog`'s two captions and the Tags page's never-downloaded notice
 * both say so at their own sites; this is the third.
 */
function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-dim">{children}</p>;
}
