import type { ImportMatch } from "@/lib/ipc";

/**
 * Decklists in the shapes people actually paste, shared by the parser's tests and — later —
 * by the import dialog's stories, plus the one stand-in every test that drives them needs:
 * {@link match}, a resolved printing.
 *
 * `REFERENCE_LIST` is the list this feature was designed against, copied out of
 * `docs/superpowers/specs/2026-08-12-deck-import-design.md` **verbatim** — 105 lines, 117
 * cards, seven `//` split names, no section headers. Every one of those numbers is asserted
 * in `parse.test.ts` rather than remembered here, because a fixture is only evidence while
 * nobody has tidied it: sorting it, deduplicating it or "fixing" a name that looks odd would
 * leave every test still green and the parser proven against a list no reader ever pasted.
 * If those counts stop matching, the fixture was mistyped — re-copy it rather than adjust the
 * assertion.
 */
export const REFERENCE_LIST = `1 Aerith Gainsborough
1 Aerith, Last Ancient
1 Akroma's Will
1 Animist's Might
1 Arcane Signet
1 Arwen, Weaver of Hope
1 Ashaya, Soul of the Wild
1 Avacyn, Angel of Hope
1 Boromir, Warden of the Tower
1 Boseiju, Who Endures
1 Bountiful Promenade
1 Branchloft Pathway // Boulderloft Pathway
1 Bridgeworks Battle // Tanglespan Bridgeworks
1 Brigid, Clachan's Heart // Brigid, Doun's Mind
1 Brushland
1 Bugenhagen, Wise Elder
1 Canopy Vista
1 Captain Sisay
1 Celestine, the Living Saint
1 Clive's Hideaway
1 Command Beacon
1 Command Tower
1 Dawn's Truce
1 Day of Destiny
1 Delighted Halfling
1 Dragonlord Dromoka
1 Eiganjo, Seat of the Empire
1 Eladamri's Call
1 Elena, Turk Recruit
1 Elesh Norn, Grand Cenobite
1 Elesh Norn, Mother of Machines
1 Fabled Passage
1 Flowering of the White Tree
6 Forest
1 Gandalf the White
1 Garruk's Uprising
1 Ghalta, Primal Hunger
1 Ghalta, Stampede Tyrant
1 Goreclaw, Terror of Qal Sisma
1 Great Hall of the Citadel
1 Gwenna, Eyes of Gaea
1 Heroes' Podium
1 Heroic Intervention
1 Hushwood Verge
1 Kamahl's Druidic Vow
1 Karametra, God of Harvests
1 Kogla, the Titan Ape
1 Kolvori, God of Kinship // The Ringhart Crest
1 Kutzil, Malamet Exemplar
1 Loran of the Third Path
1 Lush Portico
1 Mangara, the Diplomat
1 Master's Guidance
1 Minas Tirith
1 Mona Lisa, Science Geek
1 Monumental Henge
1 Mox Amber
1 Nylea, Keen-Eyed
1 Odric, Lunarch Marshal
1 Ojer Kaslem, Deepest Growth // Temple of Cultivation
1 Old Gnawbone
1 Overgrown Farmland
1 Path to Exile
1 Phelia, Exuberant Shepherd
8 Plains
1 Plaza of Heroes
1 Radagast of Rhosgobel
1 Reki, the History of Kamigawa
1 Relic of Legends
1 Saryth, the Viper's Fang
1 Selvala, Eager Trailblazer
1 Selvala, Heart of the Wilds
1 Serah Farron // Crystallized Serah
1 Shalai, Voice of Plenty
1 Sigarda, Font of Blessings
1 Sigarda, Host of Herons
1 Skrelv, Defector Mite
1 Sol Ring
1 Sovereign Okinec Ahau
1 Stroke of Midnight
1 Sungrass Prairie
1 Sunpetal Grove
1 Surrak and Goreclaw
1 Sutina, Speaker of the Tajuru
1 Swords to Plowshares
1 Tataru Taru
1 Temple Garden
1 Thalia, Heretic Cathar
1 The Earth King
1 The Great Henge
1 The Grey Havens
1 The Seriema
1 The Wandering Rescuer
1 Torgal, A Fine Hound
1 Toski, Bearer of Secrets
1 Urza's Ruinous Blast
1 Venat, Heart of Hydaelyn // Hydaelyn, the Mothercrystal
1 Wakka, Devoted Guardian
1 War of the Last Alliance
1 Windswept Heath
1 Wooded Bastion
1 Yasharn, Implacable Earth
1 Yavimaya, Cradle of Growth
1 Yeva, Nature's Herald
1 Yoshimaru, Ever Faithful`;

/**
 * Moxfield's export: a Commander header, a blank line, then the deck.
 *
 * **Every `(SET) number` here is a real printing of the card beside it**, verified against the
 * live 116 695-row corpus (Scryfall data of 2026-08-10) by reverse lookup — each pair names one
 * paper English row, and that row's name is the line's. That was not true until 2026-08-12:
 * five of the six lines carried an invented pair, and each named a *different* card —
 * `(BRC) 132` is Arcane Signet, `(LTC) 285` Talisman of Conviction, `(UNF) 235` Plains,
 * `(2X2) 21` Monastery Mentor, and Captain Sisay has no `brc` printing at all. So the repo's
 * own Moxfield fixture demonstrated the trap `hint_names_the_card` now closes rather than a
 * Moxfield export.
 *
 * **Nothing in CI would have caught it**, which is why this paragraph is here: the parser tests
 * assert *parsing*, and Storybook carries its own corpus, so no green check ever resolves a
 * fixture against real data. A hint that cannot be verified is **dropped from its line** rather
 * than guessed at — a line with no hint is an ordinary decklist line and teaches nothing false.
 */
export const MOXFIELD_LIST = `1 Captain Sisay (INV) 237

Commander
1 Captain Sisay (INV) 237

Deck
1 Sol Ring (LTC) 284
1 Arcane Signet (ELD) 331
6 Forest (UNF) 239

Sideboard
1 Path to Exile (2X2) 23`;

/** Arena's export: an About block with the deck's name, then Deck and Sideboard. */
export const ARENA_LIST = `About
Name Bant Ramp
Deck
4 Llanowar Elves (M19) 314
2 Lightning Bolt (M10) 146

Sideboard
2 Duress (M20) 94`;

/** MTGO's text export: no headers, `SB:` prefixes on the sideboard. */
export const MTGO_LIST = `4 Lightning Bolt
2 Sol Ring
SB: 2 Duress
SB: 1 Path to Exile`;

/**
 * Archidekt's full text export: a heading per category, and every line carrying its category in
 * brackets, its printing, and often a `^Label,#colour^`.
 *
 * **This is `REFERENCE_LIST`'s deck**, with printings, categories and labels added — same 105 card
 * lines, same 117 copies — which is what makes the two fixtures check each other. 14 headings,
 * 44 labelled lines, 3 `*F*` markers, 7 `//` split names, and **17 lines whose first bracket entry
 * carries `{noDeck}`**: Archidekt's word for a pile that counts toward nothing, which is this
 * app's `is_active = 0`.
 *
 * Every one of those numbers is asserted in `parse.test.ts` rather than remembered here. If they
 * stop matching, the fixture was mistyped — re-copy it rather than adjust the assertion.
 */
export const ARCHIDEKT_SECTIONED = `Commander
1x Serah Farron // Crystallized Serah (fin) 506 [Commander{top}] ^Keeper,#4aab08^

Anthem
1x Day of Destiny (dmc) 99 [Anthem]
1x Elesh Norn, Grand Cenobite (plst) IMA-18 [Anthem] ^Keeper,#4aab08^
1x Flowering of the White Tree (ltr) 15 [Anthem] ^Keeper,#4aab08^
1x Heroes' Podium (dmc) 185 [Anthem] ^Keeper,#4aab08^

Counters
1x Sovereign Okinec Ahau (lci) 240 [Counters] ^Keeper,#4aab08^
1x Surrak and Goreclaw (mom) 380 [Counters] ^Keeper,#4aab08^

Creature
1x Aerith, Last Ancient (fic) 76 [Creature]
1x Avacyn, Angel of Hope (2xm) 8 [Creature] ^Keeper,#4aab08^
1x Celestine, the Living Saint (40k) 10 [Creature]
1x Elena, Turk Recruit (fic) 133 [Creature] ^Keeper,#4aab08^
1x Ghalta, Primal Hunger (blc) 220 [Creature]
1x Ghalta, Stampede Tyrant (lci) 185 [Creature] ^Keeper,#4aab08^
1x Old Gnawbone (afr) 197 [Creature] ^Keeper,#4aab08^
1x Phelia, Exuberant Shepherd (mh3) 364 [Creature] ^Keeper,#4aab08^
1x Radagast of Rhosgobel (hob) 136 [Creature]
1x Tataru Taru (fic) 30 [Creature,Maybeboard{noDeck}{noPrice}]

Draw
1x Garruk's Uprising (blc) 219 [Draw] ^Keeper,#4aab08^
1x Kutzil, Malamet Exemplar (lci) 232 [Draw] ^Keeper,#4aab08^
1x Mangara, the Diplomat (fca) 25 [Draw] ^Keeper,#4aab08^
1x Ojer Kaslem, Deepest Growth // Temple of Cultivation (lci) 204 [Draw] ^Keeper,#4aab08^
1x Reki, the History of Kamigawa (sld) 263 [Draw] ^Keeper,#4aab08^
1x Toski, Bearer of Secrets (blc) 244 [Draw,Maybeboard{noDeck}{noPrice}]
1x Venat, Heart of Hydaelyn // Hydaelyn, the Mothercrystal (fin) 329 [Draw]

Flash Enabler
1x Gandalf the White (ltr) 305 [Flash Enabler] ^Keeper,#4aab08^
1x Yeva, Nature's Herald (rvr) 162 [Flash Enabler]

Land
1x Boseiju, Who Endures (neo) 266 [Land] ^Keeper,#4aab08^
1x Bountiful Promenade (clb) 348 [Land]
1x Branchloft Pathway // Boulderloft Pathway (znr) 284 [Land]
1x Brushland (blc) 295 [Land]
1x Canopy Vista (tdc) 343 [Land]
1x Clive's Hideaway (fin) 275 [Land]
1x Command Beacon (tdc) 352 [Land]
1x Command Tower (fic) 382 [Land]
1x Eiganjo, Seat of the Empire (neo) 268 [Land]
1x Fabled Passage (eoc) 60 [Land]
6x Forest (fic) 482 *F* [Land]
1x Great Hall of the Citadel (ltr) 254 [Land]
1x Hushwood Verge (dsk) 261 [Land]
1x Lush Portico (mkm) 263 [Land,Maybe (New){noDeck}{noPrice}]
1x Minas Tirith (ltr) 256 [Land] ^Keeper,#4aab08^
1x Monumental Henge (mh3) 222 [Land] ^Keeper,#4aab08^
1x Overgrown Farmland (tdc) 381 [Land]
8x Plains (fic) 478 *F* [Land]
1x Plaza of Heroes (dmu) 252 [Land] ^Keeper,#4aab08^
1x Sungrass Prairie (tdc) 397 [Land]
1x Sunpetal Grove (tdc) 399 [Land]
1x Temple Garden (grn) 258 [Land]
1x The Grey Havens (ltr) 443 [Land]
1x Windswept Heath (mh3) 235 [Land]
1x Wooded Bastion (plst) 2XM-332 [Land,Maybeboard{noDeck}{noPrice}]

Protection
1x Boromir, Warden of the Tower (ltr) 302 [Protection] ^Keeper,#4aab08^
1x Dawn's Truce (blb) 9 [Protection]
1x Heroic Intervention (sld) 1872 [Protection] ^Keeper,#4aab08^
1x Shalai, Voice of Plenty (tdc) 130 [Protection] ^Keeper,#4aab08^
1x Sigarda, Font of Blessings (mat) 47 [Protection] ^Keeper,#4aab08^
1x Sigarda, Host of Herons (inr) 247 [Protection] ^Keeper,#4aab08^
1x Skrelv, Defector Mite (one) 33 *F* [Protection] ^Keeper,#4aab08^
1x The Wandering Rescuer (dsk) 351 [Protection] ^Keeper,#4aab08^

Ramp
1x Arcane Signet (fic) 335 [Ramp]
1x Bugenhagen, Wise Elder (fic) 66 [Ramp]
1x Delighted Halfling (ltr) 402 [Ramp]
1x Goreclaw, Terror of Qal Sisma (cmm) 293 [Ramp] ^Keeper,#4aab08^
1x Gwenna, Eyes of Gaea (bro) 347 [Ramp] ^Keeper,#4aab08^
1x Karametra, God of Harvests (c20) 218 [Ramp]
1x Relic of Legends (fic) 354 [Ramp] ^Keeper,#4aab08^
1x Selvala, Eager Trailblazer (otj) 363 [Ramp]
1x Selvala, Heart of the Wilds (cmm) 320 [Ramp] ^Keeper,#4aab08^
1x Sol Ring (fic) 358 [Ramp] ^Keeper,#4aab08^
1x Sutina, Speaker of the Tajuru (j25) 56 [Ramp] ^Keeper,#4aab08^
1x The Earth King (tla) 172 [Ramp]
1x The Great Henge (cmm) 294 [Ramp]
1x Torgal, A Fine Hound (fin) 208 [Ramp]
1x Yasharn, Implacable Earth (znr) 240 [Ramp] ^Keeper,#4aab08^

Removal
1x Animist's Might (mat) 20 [Removal]
1x Bridgeworks Battle // Tanglespan Bridgeworks (mh3) 249 [Removal] ^Keeper,#4aab08^
1x Kogla, the Titan Ape (iko) 162 [Removal] ^Keeper,#4aab08^
1x Loran of the Third Path (pbro) 12p [Removal] ^Keeper,#4aab08^
1x Path to Exile (fic) 248 [Removal]
1x Stroke of Midnight (fca) 26 [Removal]
1x Swords to Plowshares (fic) 256 [Removal]
1x Urza's Ruinous Blast (cmm) 842 [Removal] ^Keeper,#4aab08^
1x Wakka, Devoted Guardian (fic) 97 [Removal]

Stax
1x Elesh Norn, Mother of Machines (one) 10 [Stax] ^Keeper,#4aab08^
1x Thalia, Heretic Cathar (inr) 300 [Stax]

Tutor
1x Captain Sisay (sld) 1913 [Tutor] ^Keeper,#4aab08^
1x The Seriema (eoe) 35 [Tutor] ^Keeper,#4aab08^
1x War of the Last Alliance (ltr) 36 [Tutor] ^Keeper,#4aab08^

(New) Maybeboard
1x Aerith Gainsborough (fin) 4 [(New) Maybeboard{noDeck}{noPrice},Creature]
1x Arwen, Weaver of Hope (ltc) 35 [(New) Maybeboard{noDeck}{noPrice},Maybeboard{noDeck}{noPrice},Sideboard]
1x Ashaya, Soul of the Wild (dsc) 170 [(New) Maybeboard{noDeck}{noPrice},Maybeboard{noDeck}{noPrice},Protection]
1x Eladamri's Call (mh1) 197 [(New) Maybeboard{noDeck}{noPrice},Maybeboard{noDeck}{noPrice},Tutor]
1x Mona Lisa, Science Geek (tmt) 123 [(New) Maybeboard{noDeck}{noPrice},Creature] ^Fence (flavor),#fa890d^
1x Nylea, Keen-Eyed (thb) 185 [(New) Maybeboard{noDeck}{noPrice},Maybeboard{noDeck}{noPrice},Ramp]
1x Yavimaya, Cradle of Growth (mh2) 261 [(New) Maybeboard{noDeck}{noPrice},Land]

Maybeboard
1x Akroma's Will (lcc) 125 [Maybeboard{noDeck}{noPrice},Maybe (New){noDeck}{noPrice},Protection]
1x Brigid, Clachan's Heart // Brigid, Doun's Mind (ecl) 285 [Maybeboard{noDeck}{noPrice},Maybe (New){noDeck}{noPrice},Temp,Creature]
1x Dragonlord Dromoka (tdc) 286 [Maybeboard{noDeck}{noPrice},Creature]
1x Kamahl's Druidic Vow (dom) 166 [Maybeboard{noDeck}{noPrice},(New) Maybeboard{noDeck}{noPrice},Maybe (New){noDeck}{noPrice},Ramp]
1x Kolvori, God of Kinship // The Ringhart Crest (khm) 181 [Maybeboard{noDeck}{noPrice},Ramp]
1x Master's Guidance (tle) 141 [Maybeboard{noDeck}{noPrice},Maybe (New){noDeck}{noPrice},Temp,Enchantment]
1x Mox Amber (dom) 224 [Maybeboard{noDeck}{noPrice},Ramp]
1x Odric, Lunarch Marshal (cmr) 379 [Maybeboard{noDeck}{noPrice},Sideboard,Anthem]
1x Saryth, the Viper's Fang (mkc) 185 [Maybeboard{noDeck}{noPrice},Sideboard]
1x Yoshimaru, Ever Faithful (nec) 32 [Maybeboard{noDeck}{noPrice}]`;

/**
 * A second Archidekt export, kept for one thing the other two cannot show: **five different
 * labels on one list.**
 *
 * `ARCHIDEKT_SECTIONED` and `ARCHIDEKT_FLAT` between them carry `Keeper` on 86 lines and
 * `Fence (flavor)` on one, which is enough to prove the marker is read and nothing at all about a
 * *picker* — one box is not a choice, and a fixture with one label can never catch the fold that
 * collapses two.
 *
 * Copied from a real export (a Bruna, the Fading Light deck, 2026-08-24) and trimmed to
 * **19 card lines and 46 copies**, 13 of them labelled, keeping every shape that decides
 * something:
 *
 * * **Five distinct labels** — `Keeper`, `Fence`, `Replace Art`, `Getting`, `Fence (flavor)` —
 *   each with its own hex.
 * * **`Fence` and `Fence (flavor)` are two labels**, not one and its restatement. They fold to
 *   different `labelNameKey`s, which is the case a `startsWith` or a loose comparison would get
 *   wrong.
 * * **A label on the commander line**, so the "does a label survive the commander choice"
 *   question has a card to ask it about.
 * * **A label on a `{noDeck}` maybeboard line**, because a pile that counts toward nothing is
 *   still a pile whose cards wear labels.
 * * **`28x Snow-Covered Plains`**, so a label's copy count is visibly copies rather than lines.
 * * **Unlabelled lines throughout**, which is what most of any list is.
 *
 * Every one of those numbers is asserted in `parse.test.ts` and `destinations/deck.test.ts`
 * rather than remembered here.
 */
export const ARCHIDEKT_LABELLED = `Commander
1x Bruna, the Fading Light (sld) 1336 *F* [Commander{top}] ^Keeper,#4aab08^

Draw
1x Battle Angels of Tyr (sld) 875 *F* [Draw]
1x Chimil, the Inner Sun (lcc) 106 *F* [Draw] ^Fence,#fffc19^
1x Herald's Horn (m3c) 296 [Draw] ^Replace Art,#d00dfa^
1x The One Ring (ltr) 451 *F* [Draw]
1x Trouble in Pairs (mkc) 15 [Draw] ^Replace Art,#d00dfa^

Land
1x Ancient Tomb (puma) U31 *F* [Land] ^Keeper,#4aab08^
1x Cavern of Souls (2x2) 402 *F* [Land] ^Keeper,#4aab08^
1x Minas Tirith (ltr) 752 *F* [Land]
28x Snow-Covered Plains (sld) 1473★ *F* [Land] ^Keeper,#4aab08^

Ramp
1x Arcane Signet (lcc) 104 *F* [Ramp]
1x Land Tax (cmm) 464 *E* [Ramp] ^Keeper,#4aab08^
1x Starnheim Aspirant (khm) 380 [Ramp] ^Replace Art,#d00dfa^

Removal
1x Generous Gift (cmm) 624 *F* [Removal]
1x Stroke of Midnight (tdc) 132 [Removal] ^Replace Art,#d00dfa^

(New) Maybeboard
1x Seluma, Light of Aysen (mbc) 4 [(New) Maybeboard{noDeck}{noPrice},Sideboard] ^Getting,#2ccce4^
1x The Arkenstone // Seek the Heart (hob) 170 [(New) Maybeboard{noDeck}{noPrice},Sideboard] ^Getting,#2ccce4^

Maybeboard
1x Esper Sentinel (mh2) 12 [Maybeboard{noDeck}{noPrice}]
1x The Mind Stone (msh) 21 [Maybeboard{noDeck}{noPrice},(New) Maybeboard{noDeck}{noPrice},Sideboard] ^Fence (flavor),#fa890d^`;

/**
 * The same deck out of Archidekt with no headings at all: one flat alphabetical list, every line
 * carrying its `[Category]`. **88 lines and 100 copies** — `ARCHIDEKT_SECTIONED` less its 17
 * `{noDeck}` cards, which is the arithmetic that ties the two together.
 *
 * Four lines carry `{noDeck}` on a *later* bracket entry (`[Land,Maybe (New){noDeck}{noPrice}]`).
 * Those cards are in the deck: only the **first** entry decides.
 */
export const ARCHIDEKT_FLAT = `1x Aerith, Last Ancient (fic) 76 [Creature]
1x Animist's Might (mat) 20 [Removal]
1x Arcane Signet (fic) 335 [Ramp]
1x Avacyn, Angel of Hope (2xm) 8 [Creature] ^Keeper,#4aab08^
1x Boromir, Warden of the Tower (ltr) 302 [Protection] ^Keeper,#4aab08^
1x Boseiju, Who Endures (neo) 266 [Land] ^Keeper,#4aab08^
1x Bountiful Promenade (clb) 348 [Land]
1x Branchloft Pathway // Boulderloft Pathway (znr) 284 [Land]
1x Bridgeworks Battle // Tanglespan Bridgeworks (mh3) 249 [Removal] ^Keeper,#4aab08^
1x Brushland (blc) 295 [Land]
1x Bugenhagen, Wise Elder (fic) 66 [Ramp]
1x Canopy Vista (tdc) 343 [Land]
1x Captain Sisay (sld) 1913 [Tutor] ^Keeper,#4aab08^
1x Celestine, the Living Saint (40k) 10 [Creature]
1x Clive's Hideaway (fin) 275 [Land]
1x Command Beacon (tdc) 352 [Land]
1x Command Tower (fic) 382 [Land]
1x Dawn's Truce (blb) 9 [Protection]
1x Day of Destiny (dmc) 99 [Anthem]
1x Delighted Halfling (ltr) 402 [Ramp]
1x Eiganjo, Seat of the Empire (neo) 268 [Land]
1x Elena, Turk Recruit (fic) 133 [Creature] ^Keeper,#4aab08^
1x Elesh Norn, Grand Cenobite (plst) IMA-18 [Anthem] ^Keeper,#4aab08^
1x Elesh Norn, Mother of Machines (one) 10 [Stax] ^Keeper,#4aab08^
1x Fabled Passage (eoc) 60 [Land]
1x Flowering of the White Tree (ltr) 15 [Anthem] ^Keeper,#4aab08^
6x Forest (fic) 482 *F* [Land]
1x Gandalf the White (ltr) 305 [Flash Enabler] ^Keeper,#4aab08^
1x Garruk's Uprising (blc) 219 [Draw] ^Keeper,#4aab08^
1x Ghalta, Primal Hunger (blc) 220 [Creature]
1x Ghalta, Stampede Tyrant (lci) 185 [Creature] ^Keeper,#4aab08^
1x Goreclaw, Terror of Qal Sisma (cmm) 293 [Ramp] ^Keeper,#4aab08^
1x Great Hall of the Citadel (ltr) 254 [Land]
1x Gwenna, Eyes of Gaea (bro) 347 [Ramp] ^Keeper,#4aab08^
1x Heroes' Podium (dmc) 185 [Anthem] ^Keeper,#4aab08^
1x Heroic Intervention (sld) 1872 [Protection] ^Keeper,#4aab08^
1x Hushwood Verge (dsk) 261 [Land]
1x Karametra, God of Harvests (c20) 218 [Ramp]
1x Kogla, the Titan Ape (iko) 162 [Removal] ^Keeper,#4aab08^
1x Kutzil, Malamet Exemplar (lci) 232 [Draw] ^Keeper,#4aab08^
1x Loran of the Third Path (pbro) 12p [Removal] ^Keeper,#4aab08^
1x Lush Portico (mkm) 263 [Land,Maybe (New){noDeck}{noPrice}]
1x Mangara, the Diplomat (fca) 25 [Draw] ^Keeper,#4aab08^
1x Minas Tirith (ltr) 256 [Land] ^Keeper,#4aab08^
1x Monumental Henge (mh3) 222 [Land] ^Keeper,#4aab08^
1x Ojer Kaslem, Deepest Growth // Temple of Cultivation (lci) 204 [Draw] ^Keeper,#4aab08^
1x Old Gnawbone (afr) 197 [Creature] ^Keeper,#4aab08^
1x Overgrown Farmland (tdc) 381 [Land]
1x Path to Exile (fic) 248 [Removal]
1x Phelia, Exuberant Shepherd (mh3) 364 [Creature] ^Keeper,#4aab08^
8x Plains (fic) 478 *F* [Land]
1x Plaza of Heroes (dmu) 252 [Land] ^Keeper,#4aab08^
1x Radagast of Rhosgobel (hob) 136 [Creature]
1x Reki, the History of Kamigawa (sld) 263 [Draw] ^Keeper,#4aab08^
1x Relic of Legends (fic) 354 [Ramp] ^Keeper,#4aab08^
1x Selvala, Eager Trailblazer (otj) 363 [Ramp]
1x Selvala, Heart of the Wilds (cmm) 320 [Ramp] ^Keeper,#4aab08^
1x Serah Farron // Crystallized Serah (fin) 506 [Commander{top}] ^Keeper,#4aab08^
1x Shalai, Voice of Plenty (tdc) 130 [Protection] ^Keeper,#4aab08^
1x Sigarda, Font of Blessings (mat) 47 [Protection] ^Keeper,#4aab08^
1x Sigarda, Host of Herons (inr) 247 [Protection] ^Keeper,#4aab08^
1x Skrelv, Defector Mite (one) 33 *F* [Protection] ^Keeper,#4aab08^
1x Sol Ring (fic) 358 [Ramp] ^Keeper,#4aab08^
1x Sovereign Okinec Ahau (lci) 240 [Counters] ^Keeper,#4aab08^
1x Stroke of Midnight (fca) 26 [Removal]
1x Sungrass Prairie (tdc) 397 [Land]
1x Sunpetal Grove (tdc) 399 [Land]
1x Surrak and Goreclaw (mom) 380 [Counters] ^Keeper,#4aab08^
1x Sutina, Speaker of the Tajuru (j25) 56 [Ramp] ^Keeper,#4aab08^
1x Swords to Plowshares (fic) 256 [Removal]
1x Tataru Taru (fic) 30 [Creature,Maybeboard{noDeck}{noPrice}]
1x Temple Garden (grn) 258 [Land]
1x Thalia, Heretic Cathar (inr) 300 [Stax]
1x The Earth King (tla) 172 [Ramp]
1x The Great Henge (cmm) 294 [Ramp]
1x The Grey Havens (ltr) 443 [Land]
1x The Seriema (eoe) 35 [Tutor] ^Keeper,#4aab08^
1x The Wandering Rescuer (dsk) 351 [Protection] ^Keeper,#4aab08^
1x Torgal, A Fine Hound (fin) 208 [Ramp]
1x Toski, Bearer of Secrets (blc) 244 [Draw,Maybeboard{noDeck}{noPrice}]
1x Urza's Ruinous Blast (cmm) 842 [Removal] ^Keeper,#4aab08^
1x Venat, Heart of Hydaelyn // Hydaelyn, the Mothercrystal (fin) 329 [Draw]
1x Wakka, Devoted Guardian (fic) 97 [Removal]
1x War of the Last Alliance (ltr) 36 [Tutor] ^Keeper,#4aab08^
1x Windswept Heath (mh3) 235 [Land]
1x Wooded Bastion (plst) 2XM-332 [Land,Maybeboard{noDeck}{noPrice}]
1x Yasharn, Implacable Earth (znr) 240 [Ramp] ^Keeper,#4aab08^
1x Yeva, Nature's Herald (rvr) 162 [Flash Enabler]`;

/**
 * The same deck again, in the shape that defeats today's parser hardest: uppercase set codes,
 * **empty parentheses** where the exporter had no set (33 of 88 lines), and **front faces only**
 * — `Branchloft Pathway`, never `Branchloft Pathway // Boulderloft Pathway`.
 *
 * Both halves resolve on the Rust side already: `BY_SET_AND_NUMBER` answers the hinted lines and
 * `hint_names_the_card` accepts a front face through `fold_rank`, and `BY_FRONT_FACE` answers the
 * rest. What fails today is the *parse* — `LINE`'s set group is `\w{1,10}`, so `()` leaves the
 * whole tail inside the name.
 *
 * 88 lines, 100 copies, no headings, no labels, no brackets, no `//`.
 */
export const EMPTY_HINT_LIST = `1 Aerith, Last Ancient () 76
1 Animist's Might (MAT) 20
1 Arcane Signet () 335
1 Avacyn, Angel of Hope (2XM) 8
1 Boromir, Warden of the Tower (LTR) 302
1 Boseiju, Who Endures (NEO) 266
1 Bountiful Promenade () 348
1 Branchloft Pathway (ZNR) 284
1 Bridgeworks Battle (MH3) 249
1 Brushland (BLC) 295
1 Bugenhagen, Wise Elder () 66
1 Canopy Vista (TDC) 343
1 Captain Sisay () 1913
1 Celestine, the Living Saint () 10
1 Clive's Hideaway () 275
1 Command Beacon (TDC) 352
1 Command Tower () 382
1 Dawn's Truce (BLB) 9
1 Day of Destiny () 99
1 Delighted Halfling (LTR) 402
1 Eiganjo, Seat of the Empire (NEO) 268
1 Elena, Turk Recruit () 133
1 Elesh Norn, Grand Cenobite () IMA-18
1 Elesh Norn, Mother of Machines (ONE) 10
1 Fabled Passage (EOC) 60
1 Flowering of the White Tree (LTR) 15
6 Forest () 482
1 Gandalf the White (LTR) 305
1 Garruk's Uprising (BLC) 219
1 Ghalta, Primal Hunger (BLC) 220
1 Ghalta, Stampede Tyrant (LCI) 185
1 Goreclaw, Terror of Qal Sisma (CMM) 293
1 Great Hall of the Citadel (LTR) 254
1 Gwenna, Eyes of Gaea (BRO) 347
1 Heroes' Podium () 185
1 Heroic Intervention () 1872
1 Hushwood Verge (DSK) 261
1 Karametra, God of Harvests (C20) 218
1 Kogla, the Titan Ape (IKO) 162
1 Kutzil, Malamet Exemplar (LCI) 232
1 Loran of the Third Path () 12p
1 Lush Portico (MKM) 263
1 Mangara, the Diplomat () 25
1 Minas Tirith (LTR) 256
1 Monumental Henge (MH3) 222
1 Ojer Kaslem, Deepest Growth (LCI) 204
1 Old Gnawbone (AFR) 197
1 Overgrown Farmland (TDC) 381
1 Path to Exile () 248
1 Phelia, Exuberant Shepherd (MH3) 364
8 Plains () 478
1 Plaza of Heroes (DMU) 252
1 Radagast of Rhosgobel (HOB) 136
1 Reki, the History of Kamigawa () 263
1 Relic of Legends () 354
1 Selvala, Eager Trailblazer (OTJ) 363
1 Selvala, Heart of the Wilds (CMM) 320
1 Serah Farron () 506
1 Shalai, Voice of Plenty (TDC) 130
1 Sigarda, Font of Blessings (MAT) 47
1 Sigarda, Host of Herons () 247
1 Skrelv, Defector Mite (ONE) 33
1 Sol Ring () 358
1 Sovereign Okinec Ahau (LCI) 240
1 Stroke of Midnight () 26
1 Sungrass Prairie (TDC) 397
1 Sunpetal Grove (TDC) 399
1 Surrak and Goreclaw (MOM) 380
1 Sutina, Speaker of the Tajuru () 56
1 Swords to Plowshares () 256
1 Tataru Taru () 30
1 Temple Garden (GRN) 258
1 Thalia, Heretic Cathar () 300
1 The Earth King (TLA) 172
1 The Great Henge (CMM) 294
1 The Grey Havens (LTR) 443
1 The Seriema (EOE) 35
1 The Wandering Rescuer (DSK) 351
1 Torgal, A Fine Hound () 208
1 Toski, Bearer of Secrets (BLC) 244
1 Urza's Ruinous Blast (CMM) 842
1 Venat, Heart of Hydaelyn () 329
1 Wakka, Devoted Guardian () 97
1 War of the Last Alliance (LTR) 36
1 Windswept Heath (MH3) 235
1 Wooded Bastion () 2XM-332
1 Yasharn, Implacable Earth (ZNR) 240
1 Yeva, Nature's Herald () 162`;

/**
 * One resolved printing, with everything the planner does not read filled in as nothing.
 *
 * **The whole of what a stubbed resolver may claim is "a printing answered this line".**
 * `import_resolve` is Rust asking 116 k rows which printing a name and a `(SET) 123` pick
 * out, and no TypeScript test can answer that — so nothing here invents a fact the real resolver
 * would have chosen differently. Everything the caller does not state is `null`, `false` or `0`,
 * and a fixture that taught a false set code, collector number or type line would be worse than
 * no fixture at all: the tests reading it would go green about a deck this app never builds.
 *
 * The two callers ask that of it in two ways, and both are honest about what they are handing
 * in. `plan.test.ts` states the one or two fields a filing rule reads — a type line, a P/T, a
 * colour identity — for a card it made up. `decklists.test.ts` drives real exports and echoes
 * each line's **own** printing hint back, saying nothing where the line said nothing.
 *
 * It lives beside the corpus rather than in either test file because a second copy of twenty
 * field defaults is a second thing to be wrong. Deliberately **not** borrowed from
 * `.storybook/fake/fixtures`: this is domain logic under Vitest, and reaching into the workbench
 * would tie the planner's contract to the fake's.
 */
export function match(over: Partial<ImportMatch> & { name: string }): ImportMatch {
  return {
    cardId: over.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    setCode: "tst",
    collectorNumber: "1",
    lang: "en",
    oracleId: null,
    manaCost: null,
    cmc: null,
    typeLine: null,
    oracleText: null,
    colors: null,
    colorIdentity: null,
    legalities: null,
    power: null,
    toughness: null,
    layout: null,
    rarity: null,
    faces: null,
    gameChanger: false,
    everUncommon: false,
    ownedQuantity: 0,
    printingCount: 1,
    ...over,
  };
}
