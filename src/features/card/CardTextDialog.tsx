import type { JSX } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Dialog } from "@/components/Dialog";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import { ipc, ipcError, type CardDetail, type CardFace } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";
import { useAppStore } from "@/lib/store";
import { cardDetailKey } from "./cardDetailKey";

/**
 * What the card **says**, one click away from the modal that draws its picture.
 *
 * ## Why this exists at all
 *
 * The card detail modal's mockup drops every word of it — no oracle text, no type line beyond
 * the header's, no rarity — on the theory that the art carries all of it. Spec §3.2 refuses
 * that, and the refusal is not a taste argument: **an image is not text.** It is unreachable by
 * a screen reader, unselectable, un-searchable by the reader's own browser find, and *absent
 * altogether* on a printing whose picture has never cached — which on a first run is most of
 * them, and on the web target is every printing the row did not hand a URL for. A modal whose
 * only statement of what a card does is a JPEG has no answer for any of those four readers.
 *
 * So `CardDetailPane`'s `Facts` survives here, minus the prices: those are a fact about *this
 * printing* and belong beside the picture in the modal's left column (spec §4), while a type
 * line and a rules paragraph are facts about the **card** and are the same for every printing
 * of it.
 *
 * ## Self-mounting, like its two siblings
 *
 * It takes no props. `cardOverlay` is one store field with one writer, so at most one of the
 * three nested overlays is ever open, and this one is drawn as an `App`-level **sibling** of the
 * card modal rather than as a child of its panel — that panel is a container-query context, and
 * a layout-contained box is the containing block for its `fixed` descendants, so a scrim
 * rendered inside it would stretch to the panel instead of to the window.
 *
 * It reads the card through the **same query key the card modal uses**, marketplace included, so
 * opening this costs no second `card_detail` round trip: the entry is already warm and the
 * dialog paints from the cache on the render it opens.
 */
export function CardTextDialog(): JSX.Element {
  const overlay = useAppStore((s) => s.cardOverlay);
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  // Which marketplace the card was read at. Nothing here draws a price — but the marketplace is
  // in `card_detail`'s **key**, because it is in `card_detail`'s answer, and a key that left it
  // out would be a second cache entry for a card the modal has already fetched.
  const { marketplace } = useMarketplace();

  const open = overlay === "cardText" && cardId !== null;

  const card = useQuery({
    // The card modal's own key, imported rather than spelled out — see {@link cardDetailKey}
    // for why every surface that reads a card has to agree on it to the character.
    queryKey: cardDetailKey(cardId, marketplace.id),
    // `skipToken` rather than `enabled`, so the closed state is *no query function at all*
    // rather than a disabled one — this component is mounted for the whole life of the app and
    // must cost nothing until a reader asks. A cache entry the modal has already filled is read
    // the moment it does.
    // The second half of the test is **TypeScript's rather than a second condition** — `open`
    // already carries it — because narrowing does not flow through a derived boolean and
    // `cardDetail` takes a `string`.
    queryFn: open && cardId !== null ? () => ipc.cardDetail(cardId, marketplace.id) : skipToken,
  });

  return (
    <Dialog
      open={open}
      title="Card text"
      // The card names itself here rather than in the heading: the heading says which *question*
      // is open, which is what a reader with three rail entries is choosing between, and the
      // subtitle says which card it is being asked about.
      subtitle={card.data?.name}
      closeLabel="Close card text"
      size="w-[38.75rem]"
      // **A claim about the highest thing this surface can be asked to cover.** It is opened from
      // the card modal's options rail and from nowhere else, so it is *always* over another
      // dialog — two `fixed inset-0` scrims, neither inside the other, in the root stacking
      // context. At the default rung they would tie and be resolved by document order, which is
      // the bug `layers.ts` opens with.
      layer="stacked"
      onDismiss={close}
      onClose={close}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <CardTextBody
          card={card.data ?? null}
          loading={card.isPending}
          error={card.error === null ? null : ipcError(card.error)}
        />
      </div>
    </Dialog>
  );
}

/**
 * The words, per face — and the three states that are not words.
 *
 * Split out from the shell so the four states are one `switch`-shaped read rather than four
 * conditions threaded through a `Dialog` call, and so a story or a test can stage a card that
 * no fake could answer with.
 */
function CardTextBody({
  card,
  loading,
  error,
}: {
  card: CardDetail | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <p className="text-sm text-dim">Reading the card…</p>;
  if (error !== null) {
    return <p className="text-sm text-destructive">Could not read the card — {error}.</p>;
  }
  // `card_detail` answers `null` for an id `cards` has no row for, which is a real state rather
  // than a failure: a collection or a deck can hold a printing the corpus has since dropped. The
  // sentence says which of the two happened, because "nothing here" over an empty panel reads as
  // a card with no rules text.
  if (card === null) {
    return <p className="text-sm text-dim">This printing is no longer in the card database.</p>;
  }

  const faces = facesOf(card);
  return (
    <div className="space-y-4">
      {/* The rarity, in the caption voice the pane set for it: a tinted gem with its word, never
          a filled badge. `withLabel` because this is a panel of *text* — the whole argument for
          the surface is that a colour is not something a reader can be required to see. */}
      {card.rarity && (
        <p className="text-xs text-dim">
          <RarityGem rarity={card.rarity} withLabel />
        </p>
      )}

      {faces.map((face, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0">
              {/* Named only when there is more than one face to tell apart — on a single-faced
                  card the header's subtitle has already said the name, and repeating it here
                  would read as a second card. */}
              {faces.length > 1 && face.name && (
                <span className="mr-1.5 font-medium">{face.name}</span>
              )}
              <span className="text-dim">{face.typeLine ?? "—"}</span>
            </span>
            <ManaText source={face.manaCost} className="shrink-0" />
          </div>
          {face.oracleText && (
            <p className="whitespace-pre-line text-sm leading-relaxed">
              {/* `inline`, not the component's default `inline-flex`: rules text wraps, and a
                  flex run of it would be one unbreakable line. */}
              <ManaText source={face.oracleText} className="inline" />
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Which faces this popup prints — **lifted from `CardDetailPane`'s `Facts`, with one deliberate
 * change.**
 *
 * The shape that survives is the one that is silent when it is wrong: `card.faces` is **empty**
 * for a `normal` card and for a `meld` one (Scryfall sends no `card_faces` for either), so the
 * printing's own `typeLine` / `oracleText` / `manaCost` have to be synthesised into a single
 * face or the panel draws nothing at all for most of the game. Getting *that* branch wrong
 * renders a card, just an empty one.
 *
 * **The change: no `face` index.** `Facts` sat under the pane's flip control and asked
 * `faceCount(layout, faces.length) === 2 ? [faces[face]] : faces` — one side for a `transform`
 * or a `modal_dfc`, because the picture beside it is of one side and the two have to agree, and
 * *both* halves for a `split`, an `adventure` or a `flip`, which are two faces printed on one
 * piece of cardboard. This popup has no picture and no flip control: a reader who opened
 * **Card text** is asking what the card does, and half of a transforming card is not an answer.
 *
 * So the index goes, and with it the branch — which is worth saying out loud rather than leaving
 * as a diff to read. With no index to pick *which* face, `sides === 2 ? [one] : all` is
 * `all : all`: the two arms became the same expression, so writing the test anyway would be a
 * dead branch that reads as a decision. `faceCount` is therefore not called here, and its
 * absence is the whole of the change.
 */
function facesOf(card: CardDetail): CardFace[] {
  if (card.faces.length > 0) return card.faces;
  return [
    {
      // Empty, not the card's name: {@link CardTextBody} prints a face name only where there is
      // more than one face, and a synthesised list has exactly one.
      name: "",
      typeLine: card.typeLine,
      oracleText: card.oracleText,
      manaCost: card.manaCost,
      artist: card.artist,
    },
  ];
}
