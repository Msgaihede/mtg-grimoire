import type { CardDetail, CardFace } from "@/lib/ipc";

/**
 * The faces a card's words are printed on — **lifted from `CardDetailPane`'s `Facts`, with one
 * deliberate change**, and read by both faces of the app: the desktop's `CardTextDialog` and the
 * phone's card sheet.
 *
 * The shape that survives is the one that is silent when it is wrong: `card.faces` is **empty**
 * for a `normal` card and for a `meld` one (Scryfall sends no `card_faces` for either), and for a
 * card that *has* faces the printing's own `oracleText` is `null` and every word is on them. So
 * the printing's own `typeLine` / `oracleText` / `manaCost` have to be synthesised into a single
 * face, or the surface draws nothing at all for most of the game. Getting *that* branch wrong
 * renders a card, just an empty one.
 *
 * **The change: no `face` index.** `Facts` sat under the pane's flip control and asked
 * `faceCount(layout, faces.length) === 2 ? [faces[face]] : faces` — one side for a `transform`
 * or a `modal_dfc`, because the picture beside it is of one side and the two have to agree, and
 * *both* halves for a `split`, an `adventure` or a `flip`, which are two faces printed on one
 * piece of cardboard. Neither reader of this has a flip control: a reader asking what the card
 * does is not answered by half of a transforming card.
 *
 * So the index goes, and with it the branch — which is worth saying out loud rather than leaving
 * as a diff to read. With no index to pick *which* face, `sides === 2 ? [one] : all` is
 * `all : all`: the two arms became the same expression, so writing the test anyway would be a
 * dead branch that reads as a decision. `faceCount` is therefore not called here, and its
 * absence is the whole of the change.
 *
 * **One module because there were two copies.** The phone sheet carried its own for a phase,
 * because the dialog that held this function reads the desktop's store and the phone face may not
 * reach it; a store-free home is what lets both import the one rule.
 */
export function facesOf(card: CardDetail): CardFace[] {
  if (card.faces.length > 0) return card.faces;
  return [
    {
      // Empty, not the card's name: both readers print a face name only where there is more than
      // one face, and a synthesised list has exactly one — the heading has already said it.
      name: "",
      typeLine: card.typeLine,
      oracleText: card.oracleText,
      manaCost: card.manaCost,
      artist: card.artist,
    },
  ];
}
