/**
 * What "Open on TCGplayer" opens, and what it opens when it cannot open the right thing.
 *
 * **Here rather than in `lib/externalLinks.ts` because that file builds strings and this one draws
 * a conclusion.** Its doctrine is that every function in it is pure and that `openExternal` is the
 * single call that leaves the app; a helper that asks Rust for a product id would break the first
 * half of that sentence. So the *shapes* stay there ({@link tcgplayerProductUrl},
 * {@link marketplaceSearchUrl}) and the decision lives here, in `features/card/` beside the two
 * surfaces that press it — `CardModalRail`'s last rail row and `cardMenu`'s `Open on →` row.
 *
 * **Here rather than in Rust for the root `CLAUDE.md`'s boundary.** Rust supplies facts — the two
 * ids Scryfall stores — and every judgement below is about which of them a *reader* meant, drawn
 * from a finish that only the surface knows. Nothing on this page does I/O except the one command
 * it resolves the ids with, and nothing imports React.
 *
 * **Written once because two surfaces press it and they must open the same page.** The rail and
 * the context menu are one row a reader has learnt the position of, in two places; a second
 * spelling of this table is how the menu comes to open a foil listing where the rail opens a
 * nonfoil one for the card sitting under both of them.
 *
 * ### What was measured, 2026-09-09
 *
 * - Coverage of `tcgplayer_id ?? tcgplayer_etched_id`: **98.38 %** of paper English non-token
 *   printings (99 885 rows), 93.90 % of all paper, 86.44 % of the whole corpus, **0.04 %** of
 *   digital-only cards — which are not sold on TCGplayer at all. The fallback is therefore a
 *   normal path and not an error path.
 * - Lightning Bolt (LEA) is `tcgplayer_id: 1174`, and `https://www.tcgplayer.com/product/1174`
 *   answers 200 with `?Printing=Foil` and `?page=1&Printing=Normal` alike.
 * - TCGplayer's printing vocabulary for Magic is exactly `Normal` and `Foil` — the catalogue's own
 *   price rows for Commander Masters carry no third `subTypeName`.
 * - Etched foil is a **separate product**: `484936 The Ur-Dragon (Foil Etched)`, whose own subtype
 *   is `Foil`. 892 printings carry only the etched id and 333 carry both.
 *
 * **`Printing` really does select the listings, and that was driven in a browser on 2026-09-09.**
 * On product `484935` the `Foil` and `Normal` states each showed **4 listings** with the matching
 * checkbox checked and the other clear, and the bare URL showed all **8** with neither checked — so
 * **4 + 4 = 8**: the parameter *partitions* the listings, and appending nothing leaves a genuine
 * neutral rather than a hidden default. That second half is what the two rows of the table below
 * that append nothing rest on. {@link tcgplayerProductUrl} carries the full reading, including the
 * etched product's missing `Normal` checkbox and the `&Language=English` TCGplayer adds itself.
 *
 * **It was Chrome over the DevTools protocol and not this app's WebView2**, so what it settles is
 * TCGplayer's end of the press; the app's own end is verified separately. And it retires nothing
 * from `SEARCH_URL.tcgplayer`'s caveat — the *search* grid is still the client-rendered SPA an
 * automated fetch sees only the shell of, and still not content-verified.
 */
import {
  marketplaceSearchUrl,
  openExternal,
  tcgplayerProductUrl,
  type TcgplayerPrinting,
} from "@/lib/externalLinks";
import { parseFinishes, type Finish } from "@/lib/finish";
import { ipc, type TcgplayerIds } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";

/**
 * The finish the link should be for: what the surface said, else the printing's only finish.
 *
 * The order is `playedFinish`'s and it is the same rule one surface over — the reader's own
 * statement outranks the object's, because a collection row's `finish`, a deck row's and a
 * wishlist's `preferred_finish` each say *this copy is the shiny one* about the very copy the
 * reader is going shopping for. A surface with nothing to say passes `null` (or, for the walls
 * that hold no finish at all, `undefined`), and then the printing answers for itself.
 *
 * **It reads the sole finish itself rather than calling `soleFinish` from `@/lib/finish`, and the
 * divergence is deliberate.** That function answers `null` for a nonfoil-only printing **on
 * purpose** — it drives the foil marking on card art, where the honest statement about a plain card
 * is *no mark* rather than a mark meaning "plain". Here a nonfoil-only printing genuinely is
 * `Normal`: it is sold in exactly one finish, TCGplayer has a word for that finish, and refusing to
 * name it would send a reader to a product page with no printing selected for a card that has only
 * one. So the two functions differ in exactly one row of a three-row table, and this is the
 * near-duplicate a reader will find and want to collapse — it must not be collapsed, because
 * `soleFinish`'s `null` is load-bearing for 53 224 paper printings' worth of unmarked art.
 *
 * A printing sold in two or three finishes with no statement about it answers `null`: which one a
 * reader wants is genuinely unknown, and the unfiltered page — every listing in both finishes, as
 * the bare URL was measured to show — is a better answer than a coin flip.
 */
export function linkFinish(
  surfaceFinish: Finish | null | undefined,
  finishes: string | null,
): Finish | null {
  if (surfaceFinish) return surfaceFinish;
  const listed = parseFinishes(finishes);
  return listed.length === 1 ? listed[0] : null;
}

/** One TCGplayer product page, and the printing to assert on it — `null` for "assert none". */
export interface TcgplayerLink {
  productId: number;
  printing: TcgplayerPrinting | null;
}

/**
 * Which id to open, and which printing to assert — `null` when there is no id to open at all.
 *
 * **The governing rule, stated once: assert a printing only when the id actually chosen can be
 * sold in it.** Everything below is that sentence applied to the four finishes and the three
 * shapes the ids come in, and every case that appends nothing does so because the *product* it
 * fell back to has no row of that name.
 *
 * | finish | id | `Printing` |
 * | --- | --- | --- |
 * | `etched`, etched id present | `etchedProductId` | `Foil` |
 * | `etched`, no etched id | `productId` | *none* |
 * | `foil` | `productId` ?? `etchedProductId` | `Foil` |
 * | `nonfoil`, `productId` present | `productId` | `Normal` |
 * | `nonfoil`, only `etchedProductId` | `etchedProductId` | *none* |
 * | unknown | `productId` ?? `etchedProductId` | *none* |
 * | neither id | — | `null`, and the caller searches by name |
 *
 * Row by row:
 *
 * - **Etched with an etched id** is the exact product, and its printing is `Foil` — the etched
 *   product's *own* subtype, measured on `484936 The Ur-Dragon (Foil Etched)`. Etched is not a
 *   third `Printing` word and there is no third word to reach for.
 * - **Etched with no etched id** (892 printings carry only the etched id, so the reverse happens
 *   too) lands on the ordinary product, which is the closest page for the card — but the etched
 *   copy is **not sold under it**, so any printing named there would be a guess about a row that
 *   is not the one the reader asked for. Nothing is appended, so the page opens unfiltered.
 * - **Foil** takes either id, because both products sell a `Foil` row: the ordinary one's is the
 *   foil printing and the etched one's is the etched card itself. `productId` first — a plain foil
 *   is what "foil" means on a printing that has both, and 333 printings do.
 * - **Nonfoil with an ordinary id** is the one case `Normal` is honest about.
 * - **Nonfoil with only an etched id** is a contradiction in the data rather than in the reader:
 *   an etched product has no `Normal` row, so this appends nothing rather than asking for one.
 * - **Unknown finish** means the reader named none and the printing named none either (see
 *   {@link linkFinish}), so the unfiltered page — every listing — is the honest answer.
 */
export function chooseTcgplayerLink(
  ids: TcgplayerIds,
  finish: Finish | null,
): TcgplayerLink | null {
  const { productId, etchedProductId } = ids;
  if (finish === "etched") {
    if (etchedProductId !== null) return { productId: etchedProductId, printing: "Foil" };
    // The etched copy is not sold under the ordinary product, so no printing can be claimed.
    return productId === null ? null : { productId, printing: null };
  }
  if (finish === "foil") {
    const id = productId ?? etchedProductId;
    return id === null ? null : { productId: id, printing: "Foil" };
  }
  if (finish === "nonfoil") {
    if (productId !== null) return { productId, printing: "Normal" };
    // An etched product has no `Normal` row to select.
    return etchedProductId === null ? null : { productId: etchedProductId, printing: null };
  }
  const id = productId ?? etchedProductId;
  return id === null ? null : { productId: id, printing: null };
}

/**
 * The press: open this card at this marketplace, exactly where possible and by name otherwise.
 *
 * **Nothing is resolved until the press.** `externalLinks.ts`'s first doctrine is that a menu
 * merely *offering* to open a marketplace must not have visited one, and the id lookup is the same
 * rule one layer in: a rail drawn for a card asks Rust nothing, and only a reader choosing the row
 * spends a command.
 *
 * **A press must never do nothing**, which is the whole of why this is one function rather than a
 * builder each call site drives. There are three ways the exact page cannot be had and every one
 * of them opens the name search instead:
 *
 * 1. **The marketplace is not TCGplayer.** The other four publish no derivable product URL, so the
 *    search is not a fallback there but the only shape there has ever been — and this path makes
 *    **no ipc call at all**, because a Cardmarket press has no business asking for a TCGplayer id.
 * 2. **Both ids are `null`** — 1.62 % of paper English non-token printings, every digital-only
 *    card, and every printing the corpus has never held ids for.
 * 3. **The command rejected.** It is built not to (an unknown id and an unreadable blob both answer
 *    two `null`s), so this arm is for the ways a command can fail that are not about the card: a
 *    locked database, a webview that lost the bridge. A reader pressing a link deserves the site
 *    even then.
 */
export async function openMarketplaceForCard(args: {
  marketplace: Marketplace;
  cardId: string;
  cardName: string;
  /** The finish the surface named — a collection row's own, a deck row's, a wishlist preference. */
  finish: Finish | null;
  /** The printing's `finishes` column as stored JSON. */
  finishes: string | null;
}): Promise<void> {
  const { marketplace, cardId, cardName, finish, finishes } = args;
  const search = () => openExternal(marketplaceSearchUrl(marketplace.id, cardName));
  if (marketplace.id !== "tcgplayer") {
    await search();
    return;
  }
  let ids: TcgplayerIds;
  try {
    ids = await ipc.cardTcgplayerIds(cardId);
  } catch {
    await search();
    return;
  }
  const link = chooseTcgplayerLink(ids, linkFinish(finish, finishes));
  if (link === null) {
    await search();
    return;
  }
  await openExternal(tcgplayerProductUrl(link.productId, link.printing));
}
