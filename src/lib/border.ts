/**
 * How a printing's frame meets the edge of the card — the filter tray's **Border** cell
 * (issue #573).
 *
 * **Three words a reader uses, over two columns Scryfall stores.** `borderless` is a value of
 * `cards.border_color`; `fullart` is the separate `cards.full_art` boolean; and `regular` is
 * *neither* — the ordinary framed card, whatever colour its border is (black, white, silver,
 * gold, yellow). A borderless full-art printing answers both of the first two, so the three
 * chips are not a partition of the corpus: measured on the synced corpus 2026-09-27 (109,254
 * paper printings), `regular` 98,878, `borderless` 8,947 and `fullart` 2,264, **835** of them
 * both. OR within, AND with every other filter — the type chips' shape.
 *
 * The ids are `printingFilters.ts`' own (`fullart`, `borderless`), so the printings modal and
 * the tray spell one fact one way. `filters::picked_borders` in Rust holds the same three and
 * drops anything else; the two lists are hand-mirrored like the rest of `ipc.ts`' contract.
 *
 * **Not alphabetical, and that is `sortOptions`' first exemption**: the order *is* the
 * information — the ordinary card first, then the two treatments that take the frame away.
 */
export const BORDERS = ["regular", "borderless", "fullart"] as const;
export type Border = (typeof BORDERS)[number];

export const BORDER_LABEL: Record<Border, string> = {
  regular: "Regular",
  borderless: "Borderless",
  fullart: "Full art",
};
