# MTG Domain Research — condensed, all load-bearing exact data (verified live 2026-08-04)

## Format table (deck size / max copies / sideboard / singleton / commander / life)
| Format | Deck | Copies | SB | Singleton | Commander | Life |
|---|---|---|---|---|---|---|
| Standard, Pioneer, Modern, Legacy, Pauper, Alchemy, Historic, Premodern, Penny | 60 min | 4 | ≤15 | No | — | 20 |
| Vintage, Timeless, Old School | 60 min | 4 (1 if restricted) | ≤15 | No | — | 20 |
| Commander/EDH | exactly 100 incl cmdr | 1 | none | Yes | 1–2 legendary creature/Vehicle/Spacecraft-with-P/T or "can be your commander" | 40 |
| Brawl (Arena 100) | exactly 100 | 1 | none | Yes | required (creature/PW/Vehicle/Spacecraft — CR 903.12c broader than EDH) | 25 |
| Standard Brawl | exactly 60 | 1 | none | Yes | required | 25 |
| Competitive Brawl | exactly 100 | 1 | none | Yes | required; no free mulligan | 25 |
| Oathbreaker | exactly 60 incl OB+sig spell | 1 | none | Yes | PW + instant/sorcery signature spell in OB color identity | 20 |
| Gladiator | 100 min | 1 | none (→ no companions) | Yes | — | 20 |
| Pauper Commander | 99 commons + cmdr | 1 | none | Yes | UNCOMMON creature/Vehicle/Spacecraft, need NOT be legendary | 30 |
| Duel Commander | exactly 100 | 1 | none | Yes | 1–2 legendary | 20 |
| PreDH | Commander rules, pool pre-2011 (reprints count) | 1 | none | Yes | 1–2 legendary | 40 |
| Tiny Leaders: Reborn | exactly 50, every card+every face MV≤3 | 1 | ≤10 | Yes | leg. creature/PW/Vehicle | 20 |
| Limited | 40 min | unlimited | rest of pool | No | — | 20 |
- CR engine rules: 100.2a (60/4/basics unlimited), 100.2b (40 limited), 100.4a (SB 15, 4-limit combined), 100.5 (no max), 903.5e (no EDH SB).
- Pauper legality is card-level: ever printed common in paper/MTGO → all versions legal.
- Standard Brawl allows Arcane Signet + Command Tower though not Standard-legal → NEVER derive one format from another.
- Brawl ≠ Historic-minus-bans (Lightning Bolt: historic banned, brawl legal).
- Brawl: first mulligan free (CR 903.12g), no 21-cmdr-damage (903.12h). Competitive Brawl (launched 2026-06-26): 10 bans vs Brawl's 35, bans commanders not the 99.
- Timeless restricted: Channel, Demonic Tutor, Necropotence, Tibalt's Trickery. Zero bans.
- Yorion unusable in Commander (min=max=100). Gladiator: no SB → no companion.

## Scryfall legalities — exactly 23 keys (order as emitted)
standard, future, historic, timeless, gladiator, pioneer, modern, legacy, pauper, vintage, penny, commander, oathbreaker, standardbrawl, brawl, competitivebrawl, alchemy, paupercommander, duel, oldschool, premodern, predh, tlr
- Values: legal | not_legal | restricted | banned.
- `future` = Future Standard, exclude from UI pickers. `penny` = Penny Dreadful (MTGO, pool churns per season). `duel` = Duel Commander. `tlr` = Tiny Leaders: Reborn. `predh` = PreDH.
- TRAP A — `restricted` overloaded: vintage/timeless/oldschool = max 1 copy; duel/tlr = BANNED AS COMMANDER (singleton formats). Store semantic tag per format.
- TRAP B — `oldschool` is the ONLY printing-sensitive key (Serra Angel lea/3ed legal, 8ed not_legal). All other keys oracle-level. Attach legality to printing, not oracle, or special-case oldschool.
- TRAP C — `paupercommander` covers the 99 only; uncommon PDH commanders return not_legal. Compute commander eligibility: printed at uncommon anywhere AND creature/Vehicle/Spacecraft.
- TRAP D — Alchemy rebalanced = separate objects: name & collector_number prefixed `A-`, digital:true, games:["arena"].
- Useful predicates (live counts): is:commander 3666, is:brawler 2256, is:duelcommander 3260, is:oathbreaker 287, is:companion 10, is:partner 228, is:gamechanger 53.
- `game_changer` boolean on card object = Game Changers list (53 cards, don't hardcode). Brackets beta: 5 brackets; B3 ≤3 game changers; advisory only, not hard validation.

## Commander rules
- Color identity: USE SCRYFALL'S `color_identity` (handles DFC backs 903.4d, adventures 903.4e, reminder-text exclusion 903.4c, color indicators). 903.5c: every color of card ⊆ commander identity. 903.5d: lands with basic land types — each producible color ⊆ identity (separate check).
- Commander eligibility (CR 903.3, 2026): legendary creature OR Vehicle OR Spacecraft with P/T box OR "can be your commander" text (32 cards). Use is:commander.
- Partner variants (702.124): partner (both have it); partner—[text] (same text: "Character select", "Father & son", "Friends forever", "Survivors"); partner with [name] (mutual); choose a Background (+ legendary Background enchantment); Doctor's companion (+ legendary Time Lord Doctor, no other creature types). Cannot mix variants (702.124f); never >2 commanders (702.124g); 100 incl both (702.124b); combined color identity (702.124c).
- Singleton exceptions — anchor EXACT phrases: "A deck can have any number of cards named" (12 cards: Cid Timeless Artificer, Dragon's Approach, Hare Apparent, Persistent Petitioners, Rat Colony, Relentless Rats, Shadowborn Apostle, Slime Against Humanity, Tempest Hawk, Templar Knight) and "A deck can have up to" (Seven Dwarves=7, Nazgûl=9). Naive substring "any number of cards named" → 3 false positives (Battalion Foot Soldier etc = library search triggers). Re-derive on data refresh; + basic lands.
- Companions (10): Gyruda even MV; Jegantha no repeated symbol in a cost; Kaheera creatures Cat/Elemental/Nightmare/Dinosaur/Beast; Keruga MV≥3+lands; Lurrus permanents MV≤2; Lutri nonland names distinct (unbanned in Commander 2026-02-09, still banned Brawl/CompBrawl); Obosh odd MV+lands; Umori shared card type; Yorion min+20; Zirda permanents have activated ability. Companion must satisfy color identity+singleton in EDH ("effectively a 101st card"; sits in SB slot for 60-card formats).
- Governance: WotC Commander Format Panel since 2024-09-30; mtgcommander.net STALE; use magic.wizards.com/en/formats/commander.

## Deck text formats
### Arena
`<qty> <Card Name> (<SET>) <collector#>` — set+cn optional on import. Sections: About (then `Name <deckname>` metadata line), Deck, Sideboard, Commander, Companion (companion ALSO appears in Sideboard — don't double-count). Headerless: blank line splits main/SB. CRLF + UTF-8 BOM. Strip leading zeros in cn on export. Arena localizes headers (統率者, Kommandeur, デッキ, Réserve...). Set codes: use `arena_code ?? code` (24 divergent sets: dom→dar, ody→od, 7ed→7e, tmp→te, usg→uz, ...). Split-card separator: accept `/`, `//`, `///`, normalize `//`. Alchemy Y-codes (ydmu...) have arena_code null.
### MTGO .dek XML
`<Cards CatID="57934" Quantity="4" Sideboard="false" Name="..." Annotation="0"/>`; UTF-8 BOM; commander = sideboard entry with Annotation="16777728".
### MTGO .txt / plain
`4 Bonecrusher Giant`; blank line separates SB, no header. Cockatrice: `SB:` prefix or Sideboard header; `4x` accepted.
### Site conventions
Moxfield: `4 Name (SET) 123`, Commander/Sideboard headers, `Creatures (10)` category headers ignored. Archidekt: `1x Name (code) *F* [Category] ^Label,#hex^`; foil *F*, alter *A*, etched *E*; backticked `Sideboard`. TappedOut: `*CMDR*` (site-specific!), `*CMPN*`, foils *F* / *F:pre* / *f-etch*, `(ATQ:1074)`, `SB:`, `#Land` tags. Deckstats: `[SET#num]`, `!Foil`, `//Sideboard`. Comments `//` everywhere.

## Collection CSV headers (verbatim)
- Moxfield: "Count","Tradelist Count","Name","Edition","Condition","Language","Foil","Tags","Last Modified","Collector Number","Alter","Proxy","Purchase Price" (+ "Folder Name" in collection export). Edition=lowercase set code; Foil ∈ ''|foil|etched; Condition: Mint, Near Mint, Good (Lightly Played), Played, Heavily Played, Damaged. Import REQUIRES Name; fuzzy-matches bad collector numbers silently.
- Archidekt: Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,Collector Number. Finish ∈ Normal|Foil|Etched; Condition NM/LP/MP/HP/D; Language 2-letter uppercase. (Some docs add MTGO ID col — parse by header name, not position.)
- Deckbox: Count,Tradelist Count,Name,Edition,Edition Code,Card Number,Condition,Language,Foil,Signed,Artist Proof,Altered Art,Misprint,Promo,Textless,Printing Id,Printing Note,Tags,My Price,Cost,Rarity,Price,TcgPlayer ID,Scryfall ID
- TCGplayer: Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU
- Cardmarket: SEMICOLON-delimited, NO name: idProduct;groupCount;price;idLanguage;condition;isFoil;isSigned;isAltered;isPlayset;... condition numeric 1–7, idLanguage numeric 1–11.
- ManaBox: Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency (import also accepts leading Binder Name,Binder Type)
- Dragon Shield: literal `"sep=,"` first line, then Folder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Language,Price Bought,Date Bought,LOW,MID,MARKET. CRLF required; resolves by Set NAME not code; Printing open-ended ("Surge Foil"...) → match contains "foil".
- MTGO collection: Card Name,Quantity,ID #,Rarity,Set,Collector #,Premium,Sideboarded,Annotation
- MTGGoldfish: Card,Set ID,Set Name,Quantity,Foil,Variation,Collector Number,Scryfall ID
- Helvault free: extras,name,scryfall_id,quantity
- Format detection by signature columns: Moxfield=Tradelist Count+Edition+Collector Number+Purchase Price; Archidekt=Edition Code+Scryfall ID; ManaBox=Scryfall ID+ManaBox ID; Dragon Shield=Trade Quantity+Card Name+Card Number; Cardmarket=semicolon+idProduct.
- Pre-parse: strip "sep=,", strip BOM, accept CRLF. Parse by header name case-insensitively, never position.

## Collection model conventions
- Identity: (set, collector_number, lang) unique across 538,675 objects, zero collisions ≡ scryfall_id. Physical SKU = (scryfall_id, finish) → 900,851 SKUs. Denormalize set+cn+lang alongside UUID (Scryfall has 350 live ID migrations — poll /migrations; merge=repoint, delete=flag for review).
- collector_number STRING, ~9% non-numeric (741z, A-123, 1★, 118†s, M21-1); max len 9; natural sort.
- finishes: strict enum nonfoil|foil|etched (never boolean — #1 importer data-loss bug). `glossy` never shipped. Etched inconsistently modeled upstream: 892 standalone [etched] objects + 333 dual-product objects.
- promo_types = 114 values, printing FAMILY not copy finish (silverfoil: all 369 objects cover both plain+foil; surgefoil 693/2441). Render treatment = promo_type × chosen finish.
- Serialized: own cn (386z) but serial number (042/500) NOT in Scryfall — user-supplied field.
- Languages: 19 codes (en ja fr de es it zhs pt zht ru ko ph qya dw grc sa he ar la). Printed codes differ (ja→jp, ko→kr, es→sp, zhs→cs, zht→ct).
- Row grain: (scryfall_id, finish, condition, language, flags) → quantity + tradelist_quantity. Flags: altered, signed, proxy, misprint. price_acquired + date_acquired + acquisition_source (no app has source — differentiator). Never persist market value on row.
- Conditions: NA scale NM/LP/MP/HP/DMG (TCGplayer /catalog/conditions returns DM + 6th value Unopened); EU Cardmarket M(T?)/NM/EX/GD/LP/PL/PO — "LP" is a FALSE FRIEND between scales (EU LP ≈ NA Played). Approx monotonic mapping: MT/M/NM→NM, EX→LP, GD→MP, LP→MP–HP, PL→HP, PO→DMG (label approximate; don't ship CardNexus table — internally inconsistent). Synonym table: SP→LP, Excellent→LP, Mint/M/MT→NM, DM/DMG/D→Damaged, Good (Lightly Played)→LP. Store original string + normalized enum.
- Grading: separate nullable {company, grade, subgrades?, certNumber?}; CGC has two grades numbered 10; PSA no 9.5.
- Deck model: reserving-but-non-destructive — deck_allocation(entry_id, deck_id, qty) + per-deck is_built; collection totals preserved, availability computed (Deckbox-style; avoids ManaBox destructive move and Moxfield/Archidekt gap).
- Scryfall ops: UA+Accept mandatory; 2/s for /search /named /collection; /cards/collection batches 75 ids; 10/s general; manifest 10/min; *.scryfall.io unlimited.
- Verify before implementing: Cardmarket MT vs M (accept both), BGS subgrades, Alchemy Y-set codes, MTGO .txt Sideboard header, Helvault PRO header.
