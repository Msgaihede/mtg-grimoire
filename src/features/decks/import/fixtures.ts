/**
 * Decklists in the shapes people actually paste, shared by the parser's tests and — later —
 * by the import dialog's stories.
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
