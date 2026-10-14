# Research: card scanner matching methods (2026-10-14)

**Date:** 2026-10-14. **Method:** five research tracks over public sources and a synthesis, then a
replay, a failure taxonomy and a frame-level survey of 86 real readers' scans. **Outcome:**
reframing and the gap gate, PR #1046 (commit `62f0c635`), recorded in [the scanner
reference](../../reference/card-scanner.md). The raw notes and the synthesis report are not kept;
this document is the record of both.

## Summary

**Every mature trading-card scanner names the card first and reads the printing second.** A fast
global match names the card or its illustration (a perceptual hash in hobby code and card sorters; a
learned embedding behind a learned card detector in most 2025–2026 builds: Konami's Neuron,
PokeScope, TCG-AR, CollectorVision), printed keys (collector number, set code, set symbol) and
session priors (a set lock, a declared foil batch) pick the exact printing, and a confidence gate
sends doubtful cards to review instead of guessing. Accuracy comes from the work around the matcher:
capture that is controlled or trained for, the printing read from text rather than judged from
pixels, a smaller candidate set, and no answer on a thin margin. No independent benchmark exists.
Vendor figures of 98–99% come from flatbed and sorter imaging; real photos give 85.1% top-1 at card
level (TCG-AR, 2026-07), 63.9–68.9% confidently identified at 0.6% wrong (deckpal, 2026-10) and
71–82% at variant level for established Pokémon apps (a competitor's 20-card test).

**Our replay of 86 real readers' scans (2026-10-14) sits with the real-photo group**: right printing
34.9%, right card 41.9%, 19 wrong cards, 36.0% undecided. **41 of the 56 failures (73%) went wrong
before the hash ran** — 28 rectified an inner box (text box or art window, usually turned 90°), 13
the sleeve pocket — and since the hash and both OCR bands read that one crop, a wrong quad left the
tracker no correct evidence. PR #1046 added **reframing** (a poorly matching quad is also read as
four inner regions of the card, each extrapolated to the card it implies) and **the gap gate** (an
Exact answer only the hash vouches for must stand 0.012 clear of the nearest other card). Exact as
scanned moved to 36.0% printing, 44.2% card, 7 wrong, 47.7% undecided, 13 scans better and none
worse; Fast to 32.6% and 40.7%, its 9 wrong unchanged. Next, ranked: the title read from the whole
frame when a stretch is stuck, the card found inside the pocket, sibling-printing reads, a
burst-level Fast gate, a learned corner detector trained on our own composites (the ready-made MTG
weights are AGPL), the not-found flow, and foil glare last.

## Scope and method

**Five tracks**, each an independent web-research pass recording takeaways, cited findings,
inferences and gaps: **MTG**; **Pokémon**; **Yu-Gi-Oh!, other games, sports, sorters and APIs**;
**matching techniques** (hashes, local features, embeddings and vector search, card detection,
robustness tricks); **hard conditions and UX** (binders, foil, sleeves and slabs, stacks and blur,
capture and review UX, hardware). A synthesis ranked fixes against our failure classes; we then
measured our own scanner and built the first two.

**How sources were judged.** The strongest are an author's own technical material with numbers:
Konami's 2020 slides, the TCG-AR paper, model cards, READMEs and deckpal's benchmark pull requests.
Labels below: *vendor claim* (marketing with no method or test protocol), *competitor's comparison*
(a rival ranking the field, usually itself first: Eyevo, Rare Candy, Scrytics, Lotus Scan, PokeLenz,
Cards AI), *snippet only* (seen only in a search-engine summary because the page returned 403, 404
or 429) and *AI-assisted repo*. Figures are self-reported and card-level unless marked measured or
variant-level; inferences are marked ours; where notes disagree, both figures are given.

**What could not be read.** Reddit could not be searched or fetched (the search tool refused the
domain), so no community thread is cited and per-app user consensus is missing; Hacker News was not
reached either. help.tcgplayer.com and pfu-us.ricoh.com answered 403, so every TCGplayer help-centre
claim is snippet only; some App Store pages answered 429 or 404. Konami's CEDEC decks need a login
and Nikkei xTECH is paywalled; two theses were blocked; the PDQ test-drive PDF could not be parsed;
two USPTO patents are image-only; the jslok repository is gone; the source of Ripdex's 98.1% claim
was not found.

## How other scanners identify cards

### Magic: The Gathering

**Commercial apps say little, and what they say splits them in two.** Art matchers admit same-art
reprints defeat them: ManaBox recognises cards from their artwork and has the reader tap the set
icon or lock sets, with Quick Mode taking the first matching version and foil and language set by
hand; sleeve glare can stop its border detection ([FAQ](https://manabox.app/guides/scanner/faq/);
[getting started](https://manabox.app/guides/scanner/getting-started/)). Dragon Shield's developer
gave the same art-only explanation in 2022 ([App Store](https://apps.apple.com/app/id1460657155)).
The 2026 on-device iOS apps — Scrytics (a model over frame, art and symbol against ~100k printings,
trained on glare and sleeves; beta; vendor claim)
([scanner](https://scrytics.com/features/scanner)), Eldwyn (a scanner that learns the set being
scanned) ([App Store](https://apps.apple.com/app/id6759303500)), ManaForge (OCR of name, set and
number) ([App Store](https://apps.apple.com/app/id6758670832)) and Sparkheim (a Heimdall mode that
locks a reader-set zone for binder pages) ([listing](https://mwm.ai/apps/sparkheim-mtg/6792481720))
— all claim the exact printing, all mention the set, number or symbol, and none publishes accuracy;
Scrytics' developer says no independent benchmark exists
([roundup](https://scrytics.com/blog/best-mtg-card-scanner-app-2026), competitor's comparison).
Delver Lens's method is undocumented beyond a 2018 listing; CardCastle (2018) asks for border
contrast and unsleeved cards and stages scans for correction
([tutorial](https://support.cardcastle.co/en/articles/2010498-card-scanning-tutorial)).

**Seller and sorter systems claim more and show the printed keys.** TCGplayer's app (4.10.4,
2024-07-01) scans sleeved, in binders and several cards at once, ideally at 45° on a plain
background
([APKMirror](https://www.apkmirror.com/apk/tcgplayer-inc/tcgplayer/tcgplayer-4-10-4-release/)); its
Scan & Identify (2025-01-23) runs Roca Vision, the vision of the Roca sorters (bought 2021-11-04 at
a claimed 99%+), claims over 98% across 700M+ cards, and shows set code, number and symbol beside
the catalogue image for review (vendor claim) ([announcement](https://seller.tcgplayer.com/blog/announcing-scan-identify-revolutionize-your-inventory-listing)).
TCG Machines is the one vendor that has explained a change of method: its greyscale grid hash was
fast and usually right but failed on The List, near-identical layouts and uniformly dark cards, so
in 2023 it **added OCR of name, collector number and set code for M15 onward**
([blog](https://tcgmachines.com/blog/our-robots-can-read)).

**The classic open-source pipeline is a small version of ours**: contour quad, warp, perceptual
hash, brute-force Hamming. hj3yoo (2018) dropped a Tiny YOLOv3 detector for contours, cutting
latency from ~65 + 50n ms to 7 + 16n ms for n cards, and found **a 256-bit pHash separated most
cards**, but needed whole, unoverlapped cards
([README](https://github.com/hj3yoo/mtg_card_detector/blob/master/README.md)). tmikonen (2020)
applies CLAHE in LAB and thresholds each RGB channel separately, accepts a match only when its
distance sits four standard deviations below the mean of all the others, and suggests an art-only
fallback because the art box is often found when the card edge is not
([blog](https://tmikonen.github.io/quantitatively/2020-01-01-magic-card-detector/)). oracle_ii
reports ~2% card-level error (25 of 1,045) with no set guarantee
([README](https://github.com/frnsys/oracle_ii)); Patterson (2014) grew his references from
reader-confirmed scans ([talk](https://www.rubyevents.org/talks/a-magical-gathering)).

**The 2026 generation keeps the hash and splits the decision.** neotoxicfr hashes an inner art crop
(y 16–50%, x 14–86%, inside every frame's art box) with a **1024-bit four-plane colour dHash**
(grey, B, G, R; 17×16 each), one entry per Scryfall `illustration_id` (~50k); a query hashes at six
offsets (vertical 0, −2%, +2%, +4%; horizontal ±1.1%) and keeps the minimum, in a few ms; true
matches sit at 180–340 of 1,024 bits, the best impostor 46–150 further, random pairs ~512; the
printing is left to collector-line OCR, title language, foil glyphs or The List's stamp ([art
index](https://github.com/neotoxicfr/mtg-scanner-art-index)). DarylNo **files automatically only
when one printing exists or the collector line confirms one**, else offers a comparison view
([CardScanner](https://github.com/DarylNo/CardScanner)). GrimbiXcode **finds the collector line
without assuming where the card is** — mask light-on-dark pixels, keep character-sized blobs, group
them into left-aligned two-line blocks, rescale to ~48 px glyphs, Otsu-binarise — then repairs set
codes against the set list (BLE → BLB), drops leading zeros and keeps suffixes and promo stars; 22
of 22 photos pass ([mtgscan](https://github.com/GrimbiXcode/mtgscan)). tomoncupa (2026-10-02,
AI-assisted repo) re-reads the line on an enlarged bottom-left crop, needs two agreeing reads, and
measured name matching over 33,897 cards: with one-word names allowed, 2,797 right and 805 wrong;
with two or more words at ≥0.92 similarity, 2,646 right, 25 wrong and 31,226 unanswered ([PR
#1](https://github.com/tomoncupa/magic/pull/1)). OmniCard picks non-English printings by the most
agreed-on number and copyright year ([PR #177](https://github.com/anubisascends/OmniCard/pull/177)).

### Pokémon

**Disclosed commercial designs are visual retrieval plus number OCR.** PokeScope (2025-11-08) runs
YOLOv8 trained on sleeves, top-loaders and binder pages, fine-tuned CLIP, and Tesseract on the card
number, added because visuals alone confused holo and reverse holo, editions and reprints; 10,000+
hand photos grew to 50,000+ with synthetic binder reflections and top-loader glare; matching went
~60% → 95%+ (self-reported and internally inconsistent); 95% in 0.5 s was preferred to 99% in 3 s
([PokeScope](https://pokescope.app/blog/how-i-built-pokemon-card-scanner-ai-50000-users/)). Eyevo's
AI mode (96% claimed) beats its OCR mode on holos but not on exact variants
([Eyevo](https://eyevotcg.com/blog/ai-vs-ocr-scanning-which-to-use/)); Ximilar chose similarity
search because classifiers fail at >20,000 Pokémon and >90,000 MTG classes
([Ximilar](https://ximilar.com/blog/pokemon-card-image-search-engine)). The big apps (TCGplayer,
Collectr, Dex) publish no method and leave the finish, sometimes the set, to the user ([Dex
help](https://dextcg.com/help/collection/scanning-your-cards)). Cross-app numbers are competitor-run
or eyeballed: Eyevo's 20-card variant-level test put Eyevo at 96%, TCGplayer 82%, Pokellector 78%
([Eyevo](https://eyevotcg.com/blog/best-pokemon-card-scanner-apps-2026/), competitor's comparison);
HobbyCardIndex's estimates (2026-05) are 85–95% on modern cards, 10–20 points lower on vintage,
parallels down to 60–70%, and **a sleeve inside a top-loader inside a team bag costing 20–30
points** ([HCI](https://hobbycardindex.com/hubs/pokemon-card-scanners/)).

**Open source holds the two most useful engineering records.** Hugo Peixoto's ptcg-detection (Rust:
Sobel, an outside-in border scan, Hough lines, a 256-bit gradient hash, brute-force Hamming) is our
closest relative, and when the hash could not separate two sets he **added a local signal** —
set-symbol templates in three candidate regions, thresholds 0.10–0.20 — rather than a better global
hash ([ptcg-detection](https://github.com/hugopeixoto/ptcg-detection)). deckpal (2026-09/10) is the
best-instrumented scanner found anywhere; its gates, reprint guard, number reader, embedding and
detector appear below ([deckpal](https://github.com/cheyras/deckpal)). Others repeat YOLO plus CLIP
or SigLIP plus a vector index without metrics
([Adrihp06](https://huggingface.co/Adrihp06/TCGscanner-detector)), or show per-set classifiers do
not scale ([Cole-Crawley](https://github.com/Cole-Crawley/pokemon-card-scanner)); an earlier Liège
MSc (2025) reached only 0.5 identification accuracy over ~18,000 cards
([MATHEO](https://matheo.uliege.be/handle/2268.2/23388)).

### Yu-Gi-Oh! and other trading card games

**Konami's Neuron is the best-documented commercial pipeline in any game.** On the phone,
MobileNetV2 + SSDLite detects up to 20 cards and a VGG16-BN classifier at 128×128 ends in a
10,000-way softmax, trained only on synthetic composites of the official card images with Mixup and
Random Erasing (~3.6M images in 2020) and **tested on real photos before every release**
([slides](https://pages.awscloud.com/rs/112-TZM-766/images/KONAMI_AIMLTokyo7.pdf)). Reports of the
2018 talk put the first model at ~50% and blended-image (Mixup) training near 100% (snippet only).
One class per card: Neuron names the card, not the printing (our inference).

**Elsewhere the printing comes from the set code**, with a prompt when one code was printed at
several rarities. OpenYuGi **fuses OCR and art matching in an explicit points table** — exact set
code +80, region-normalised code +75, exact name +50, passcode +45, variant art +40 (cosine ≥0.42),
partial name +25, ATK and DEF +15 each, card type +10, over 30 to match — and asks when the top two
are within 10 points; glare on the set-ID line is its first failure ([OpenYuGi](https://github.com/DJ-Cat-N-Cheese/Yu-Gi-Oh-Card-Tracker/blob/main/docs/CardScanning.md)).
tsaow splits 3×3 binder pages by a fixed grid (margin 12 px, inner crop 0.03, overlap 0.15)
([tsaow](https://github.com/tsaow/Yugioh_card_scanner)); Lowhur's triplet network **re-ranks its top
50 by ORB agreement**, fixing near misses ([PyImageSearch](https://pyimagesearch.com/2021/03/03/an-interview-with-anthony-lowhur-recognizing-10000-yugioh-cards-with-computer-vision-and-deep-learning/)).
Smaller games ride on multi-game services; fabscan (Flesh and Blood) repeats contour, title OCR and
a 64-bit pHash ([fabscan](https://github.com/IAmThermite/fabscan), snippet only). eBay's
scan-to-list returns a list of matches for the seller to pick ([eBay](https://www.ebayinc.com/stories/news/new-ebay-scanning-tool-to-cut-listing-time-in-half-for-trading-card-sellers/));
Card Dealer Pro falls back from image matching to reading the card's text, back included
([overview](https://support.carddealerpro.com/hc/en-us/articles/21788884792219-Trading-Card-Scanner-Overview),
snippet only).

### Sports cards

**Sports apps split identity from variant explicitly.** CollX finds the base card by visual search
over 17–20M cards, then shows a parallel picker ([FAQ](https://collx.app/faq)); a competitor puts
its parallel accuracy near 65% against Ludex's 85% ([Cards
AI](https://www.cardsaiapp.com/blog/collx-vs-ludex), competitor's comparison). CardSight AI detects
every card in a frame, returns ranked parallel suggestions and High/Medium/Low tiers, and headlines
a 99.5% mAP that is probably a detection metric (our inference)
([CardSight](https://cardsight.ai/solutions/identification), vendor claim); Ximilar **re-ranks its
visual shortlist with a second model and returns nothing when unsure**
([Ximilar](https://www.ximilar.com/blog/how-to-identify-sports-cards-with-ai/), vendor). For graded
slabs the serious tools skip card recognition and look up the cert number (§ *Sleeves, top-loaders
and graded slabs*).

### Sorting machines and APIs

**Sorters pair a catalogue match with a reject threshold, and hardware does the rest**: Roca's
threshold is Conservative or Standard, with an unidentified bin; Moss Machine hashes the top-left
745×745 crop with **a 256-bit pHash per colour channel**, rejects early on one channel and leaves
set and foil to user filters ([Moss
Machine](https://kairicollections.github.io/Moss-Machines-Magic-the-Gathering-sorting/)); Mault runs
CollectorVision's models in the browser with pgvector on a server
([mault](https://github.com/Pathaleon/mault)). TinEye's card API returns one best match with no
confidence ([TinEye](https://help.tineye.com/article/306-about-cardsearchengine)).

### Comparison

| Scanner | Game | Finds the card with | Names it with | Picks the printing with | Reported accuracy | Source |
| --- | --- | --- | --- | --- | --- | --- |
| ManaBox | MTG | Border detection | Artwork | User tap, set lock, Quick Mode | None published | [FAQ](https://manabox.app/guides/scanner/faq/) |
| Roca Vision / TCGplayer | Multi-game | Undisclosed | Undisclosed | Set code, number, symbol shown for review | >98% over 700M cards (vendor) | [TCGplayer](https://seller.tcgplayer.com/scan-identify) |
| TCG Machines | MTG sorter | Fixed sorter imaging | Greyscale grid hash | OCR of name, number, set code (M15+) | ~99% (vendor) | [blog](https://tcgmachines.com/blog/our-robots-can-read) |
| neotoxicfr art index | MTG | Not part of the index | 1024-bit colour dHash of the art, per illustration | Collector-line OCR | Calibration only | [repo](https://github.com/neotoxicfr/mtg-scanner-art-index) |
| GrimbiXcode | MTG | Text lines found anywhere | Collector-number OCR | Exact set + number lookup | 22 of 22 photos | [repo](https://github.com/GrimbiXcode/mtgscan) |
| ptcg-detection | Pokémon (Rust) | Sobel + Hough | 256-bit gradient hash | Set-symbol templates | None | [repo](https://github.com/hugopeixoto/ptcg-detection) |
| PokeScope | Pokémon | YOLOv8 trained on binders | Fine-tuned CLIP | Card-number OCR | ~60% → 95%+ (self-reported) | [blog](https://pokescope.app/blog/how-i-built-pokemon-card-scanner-ai-50000-users/) |
| deckpal | Pokémon | Learned detector | Fine-tuned CLIP, dHash veto | Printed-key ladder, reprint guard | 68.9% auto-ID at 0.6% wrong (measured) | [#284](https://github.com/cheyras/deckpal/pull/284) |
| TCG-AR | Pokémon | Oriented R-CNN | ArcFace ResNet-50 | None | 85.1% top-1 on real photos (measured) | [arXiv](https://arxiv.org/html/2607.02090v1) |
| Konami Neuron | Yu-Gi-Oh! | SSDLite, up to 20 cards | 10k-class CNN | None (card level) | Not published | [slides](https://pages.awscloud.com/rs/112-TZM-766/images/KONAMI_AIMLTokyo7.pdf) |
| OpenYuGi | Yu-Gi-Oh! | Contours or YOLO-OBB | OCR, ORB or YOLO art features | Set code (+80 points); user for rarity | None (beta) | [docs](https://github.com/DJ-Cat-N-Cheese/Yu-Gi-Oh-Card-Tracker/blob/main/docs/CardScanning.md) |
| CollectorVision | MTG first | Cornelius corner model | Milo ArcFace (illustration + set) | Inside the embedding | Not published | [repo](https://github.com/HanClinto/CollectorVision) |
| CollX | Sports | Undisclosed | Visual search, 17–20M cards | Parallel picker | Parallels ~65% (competitor's figure) | [FAQ](https://collx.app/faq) |

## What makes them accurate

### Capture control

**Systems that control the imaging report 98–99%, by removing variables**: diffuse light, a fixed
distance, a plain background, and batches declared up front — Roca's Sifter runs sleeved cards and
each foil type as separate jobs ([Roca Sifter
Q&A](https://seller.tcgplayer.com/blog/your-roca-sifter-questions-answered)). Phones approximate it
with advice and with feeder ramps that fix the card's position and light ([Card
Slinger](https://cardslinger.shop/pages/faq-tips)); learned systems train for what they cannot
control (PokeScope's binder images, Konami's composites, TCG-AR's glare augmentation).

### Printed keys

**Every source that resolves same-art printings reads them.** A global hash separates identical-art
reprints only through the few cells covering frame, symbol and collector line; TCGplayer lists
core-set and Commander reprints, basic lands, tokens and special foils as its hard MTG cases
([help](https://help.tcgplayer.com/hc/en-us/articles/27303183354007-How-Quicklist-IdentificationTechnology-Works),
snippet only). The set code and number sit together bottom left from M15 (2014) onward, so the line
must not be a hard filter on older cards. Cheap hardening: repair set codes against the set list and
keep suffixes (GrimbiXcode); re-read on an enlarged corner crop (tomoncupa); require agreement
across scales or frames — deckpal reads at 4× and confirms at 6×, accepting a read only if both
agree, the number is plausible for the set and every digit has confidence ≥0.6, which took reads
from 0 to 8 of 137, all correct; **every correct read came from a crop at least 400 px tall**, the
number being 2–3 px tall on the median 294-px crop
([#303](https://github.com/cheyras/deckpal/pull/303)).

**Grouping same-art printings offline lets the image stop at the illustration.** deckpal's ~1,000
art families over ~2,300 cards (ORB on CLAHE luma under a near-identity homography, closed over
dHash ≤ 6) feed a **reprint guard that turns any answer inside a family into a question unless a
printed key decided it**: confident-wrong 21.9% → 8.6% for auto-ID 37.6% → 33.9%, and 14 of 67 → 4
of 57 on held-out photos ([#294](https://github.com/cheyras/deckpal/pull/294)). A confident printed
key is final, and a name is never swapped for another card's; on its owner's photos 21 or 22 of the
wrong answers were the right card in the wrong printing, against 3 wrong cards
([#288](https://github.com/cheyras/deckpal/pull/288)).

### Refusing to guess

**A correct "not sure" with a short list is the failure the industry prefers.** TCGplayer grades
matches Good (~99.9%), Fair (~98.94%) and Poor, sending Poor to an Unidentified tab
([FAQ](https://help.tcgplayer.com/hc/en-us/articles/27302442668695-Scan-Identify-FAQ), snippet
only); Ximilar returns nothing when unsure; OpenYuGi asks within 10 points; tmikonen gates at four
sigma. deckpal's tiers are similarity ≥0.65 with margin ≥0.03, or 0.45 with margin 0.12, and a hash
may answer alone only at distance ≤ 7, after a distance-9 hash named a Mankey as a Togetic and 22 of
64 confident vintage hash answers proved to be another card
([#288](https://github.com/cheyras/deckpal/pull/288);
[#294](https://github.com/cheyras/deckpal/pull/294)); its ladder fixes took auto-ID 63.9% → 68.9%
and wrong-of-confident 1.9% → 0.6% over 244 cards
([#284](https://github.com/cheyras/deckpal/pull/284)). The cost is coverage (tomoncupa's 805 → 25
wrong bought 31,226 refusals), worth paying because the recurring complaint is the wrong printing,
not the missed card ([Lotus Scan](https://www.scanyourmtg.com/faq/wrong-set-detection/),
competitor's summary).

### Narrowing the candidate set

**Restricting TCG-AR's candidates to the 631 cards of one deck raised real-photo top-1 from 85.1% to
96.4%** ([TCG-AR](https://arxiv.org/html/2607.02090v1)). Products do the same with context the user
already has: set locks (ManaBox, Card Dealer Pro), Eldwyn's learned current set, single-printing
batches (TCGplayer), and sorters' declared foil runs, where foil-only printings are always marked
foil ([foil detection](https://support.tcgmachines.com/knowledge/foil-detection)).

### Real-photo numbers against vendor claims

| Source | Date | Setting | Figure | Kind |
| --- | --- | --- | --- | --- |
| Roca Sorter | 2019, 2021 | Sorter imaging | >99% | Vendor claim |
| TCGplayer Scan & Identify | 2025-01 | ADF and phone uploads | >98% over 700M cards | Vendor claim |
| TCG Machines | 2023 | Sorter | ~99% | Vendor claim |
| Ximilar | 2022 | API | 97%+ exact image | Vendor claim |
| oracle_ii | — | Webcam, controlled | ~98% card level | Self-measured, 1,045 cards |
| PokeScope | 2025-11 | Phone | ~60% → 95%+ | Self-reported, no test set |
| Eyevo's test | 2026 | 20 cards, variant level | Rivals 71–82%, Eyevo 96% | Competitor's comparison |
| HobbyCardIndex | 2026-05 | ~200 cards, eyeballed | 85–95% modern | Reviewer's estimate |
| TCG-AR | 2026-07 | 636 real crops, 20,360 cards | 85.1% top-1, 96.2% top-5 | Measured, card level |
| deckpal | 2026-10 | Real crops, 244 cards | 68.9% auto-ID, 0.6% wrong | Measured |
| Ours, Exact as scanned | 2026-10-14 | 86 readers' scans | 36.0% printing, 44.2% card | Measured |

The first block measures controlled imaging, the second hand-held phones; the two are not
comparable, and our binder-heavy corpus belongs with the second.

## Matching techniques

### Perceptual hashes

**Global hashes survive compression and scaling, not framing.** In McKeown and Buchanan's
million-image test (2022) unrelated images sat at normalised Hamming distance 0.4904 ± 0.0649
(pHash, 64-bit), 0.5000 ± 0.0321 (PDQ, 256-bit) and 0.4973 ± 0.0600 (NeuralHash, 96-bit); a modified
copy's mean distance from its original ([arXiv 2212.08035](https://arxiv.org/html/2212.08035v1)):

| Edit | pHash 64-bit | PDQ 256-bit | NeuralHash |
| --- | ---: | ---: | ---: |
| 5% crop | 0.1686 | 0.3255 | 0.0605 |
| 30-px border | 0.2656 | 0.3949 | 0.0763 |
| Watermark | 0.1227 | 0.1029 | — |
| JPEG Q30 | 0.0053 | 0.0094 | — |
| 1.5× scale | 0.0020 | — | — |
| Mirror | 0.4904 (random) | — | — |

aHash and dHash were named but not tested. PDQ, PhotoDNA and NeuralHash survive compression and
resizing but not filtering or rotation ([arXiv 2406.00918](https://arxiv.org/html/2406.00918v2)),
and PDQ fails its working threshold under less than 5% cropping (snippet of [arXiv
1912.07745](https://arxiv.org/pdf/1912.07745)). Krawetz (150k images, 64-bit) found dHash as fast as
aHash with few false positives, suggested thresholds of 0 (same), 1–10 (variant) and >10
(different), and noted it is not rotation-invariant ([Hacker
Factor](https://www.hackerfactor.com/blog/index.php?/archives/529-Kind-of-Like-That.html)).

**Hash length helps roughly as √bits and fixes neither framing nor reprints** (our inference): the
unrelated spread halves from 64 to 256 bits, but assuming independent impostors the nearest of ~118k
sits near 92 of 256 bits while a genuine match under a 5% crop averages ~83, so a badly framed match
has almost no margin. Card hashes run from 64 bits (Lexmark's patent, fabscan) through 256 (hj3yoo,
ptcg-detection, Moss Machine per channel, ours) to 1024 (neotoxicfr); none is compared against card
top-1 or measured on foil.

### Local features and re-ranking

**Learned local features run near ORB's speed on a CPU and are far more robust to lighting**: on
HPatches illumination, homography accuracy within 3 px is ORB 74.6% and XFeat 95.0%, at 44.3 and
27.1 FPS on a laptop CPU ([XFeat](https://arxiv.org/html/2404.19174v1)). **Their place is re-ranking
a shortlist**: on ILIAS, local-descriptor re-ranking lifted mAP@1k from 28.9 to 35.6–38.9
([ILIAS](https://vrg.fel.cvut.cz/ilias/)), at ~1 KB of descriptors per image against 10–40 KB for
SIFT ([Lookout](https://research.google/blog/on-device-supermarket-product-recognition/)); TCG-AR
found homography registration its least reliable stage. Our inference: a homography to each top-k
reference would verify a match and show which part of the card was framed, rescuing pocket crops,
but 122k references would need features computed on the fly, it helps only when the right card is
shortlisted (a sideways art window's rarely is), and nothing is measured in WebAssembly.

### Learned embeddings and vector search

**The one rigorous card number is TCG-AR's** (Liège, arXiv, 2026-07-02): a ResNet-50 with an ArcFace
head (512-d, s = 30, m = 0.5) or a triplet head, trained only on ~122k synthetic crops, one
reference per card ([TCG-AR](https://arxiv.org/html/2607.02090v1)):

| Head | Candidates | Top-1 | Top-5 |
| --- | --- | ---: | ---: |
| ArcFace | Synthetic test | 97.0% | 99.5% |
| ArcFace | Real, open set (20,360 cards) | 85.1% | 96.2% |
| ArcFace | Real, deck-restricted (631 cards) | 96.4% | 99.2% |
| Triplet | Real, open set | 1.7% | 4.4% |

The real crops include sleeved and holofoil cards, unsplit; **75% of open-set top-1 errors (71
of 95) had the right card in the top five**, mostly other prints of the same creature. The notes
disagree on its speed (~1.2 FPS on a CPU in one reading, ~10 FPS on a GPU in another).

**The MTG-ready embedder and the best Pokémon one disagree on reprints.** CollectorVision's Milo
(MobileViT-XXS, ~1.0M parameters, 5.2 MB fp32 ONNX, 448×448 in, 128-d out) is **trained with ArcFace
on `illustration_id` and `set_code` at once**; with its corner model it matches ~108k references in
under 100 ms on a laptop CPU, embedding both orientations and summing per-frame scores per card
([Milo](https://huggingface.co/HanClinto/milo);
[CollectorVision](https://github.com/HanClinto/CollectorVision)); no retrieval accuracy is
published. deckpal instead masks same-art reprints out of each other's negatives, because tint-based
printing guesses came out 7 right and 7 wrong, and leaves printings to OCR; its fine-tune took
real-crop top-1 from 80.9% to 93.8% (v1; v2 90.6%) and the median top-1 − top-2 margin from 0.053 to
0.334 ([#288](https://github.com/cheyras/deckpal/pull/288)). With our collector line deciding
printings, deckpal's choice is the safer default.

**Frozen models, copy detection and cost.** On ILIAS frozen DINOv2-L scored 15.3 mAP@1k against
SigLIP2-L's 20.8 and DINOv3-L's 26.5, contradicting claims that DINOv2 is best for instances ([ILIAS
paper](https://arxiv.org/abs/2502.11748)). SSCD scores 61.5 µAP and **72.5 with score normalisation
against each item's background neighbours**, trained with heavy augmentation — the recipe for crop
and border tolerance, unmeasured on cards ([SSCD](https://arxiv.org/pdf/2202.10261)). MobileCLIP
encoders run from 11.4M parameters at 1.5 ms (S0) to 321.6M at 19.6 ms (S4) on an iPhone 12 Pro Max
([MobileCLIP2-S0](https://huggingface.co/timm/MobileCLIP2-S0-OpenCLIP/blob/main/README.md)); ONNX
Runtime Web's threads **need SharedArrayBuffer and so cross-origin isolation** ([ORT
Web](https://opensource.microsoft.com/blog/2021/09/02/onnx-runtime-web-running-your-machine-learning-model-in-browser/));
no phone-browser latency was found. At our scale exact search is right
([FAISS](https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index)) and storage
small (122,390 128-d int8 vectors ≈ 15.7 MB against ~3.9 MB for our dHash); the encoder, run on
every alternate framing, is the cost.

### Card detection

**Classical edge-and-line detectors stay strong on one flat rectangle and fail on a stronger
competing one.** Dropbox's Canny-plus-Hough detector beat Apple's in an A/B test, **users 60% less
likely to correct its quads** ([Dropbox](https://dropbox.tech/machine-learning/fast-and-accurate-document-detection-for-scanning));
on SmartDoc's hardest background, a mouse pad, the detected quad is often the pad ([arXiv
2008.02615](https://arxiv.org/pdf/2008.02615)). Learned corner models predict corners when nothing
is there, so they need a presence head, and carry 5–10 px of corner error when trained at low
resolution ([DocAligner](https://pypi.org/project/docaligner-docsaid/)) — enough to break a hash, so
refine with a full-resolution line fit (inference).

**Learned card detectors.** TCG-AR's Oriented R-CNN, trained on 18,000 synthetic composites, reached
0.90 mAP on real scenes but 0.6 FPS on a CPU. **CollectorVision's Cornelius** (MobileViT-XXS with a
SimCC head, 384×384) outputs four ordered corners and a sharpness score that gates presence: **quad
IoU 0.969 held out, 0.970 under ±50° rotation, 23 ms on one CPU thread**
([Cornelius](https://huggingface.co/HanClinto/cornelius)). jackttv's `yolo26n-pose` regresses
corners, trained on synthetic multi-card composites, without metrics ([model
card](https://huggingface.co/jackttv/card-scanner-yolo-pose)); duclvQ's YOLOv8n-pose found a usable
quad on 183 of 186 ordinary photos but **usually nothing on binder pages, fans and stacks**
([duclvQ](https://huggingface.co/duclvQ/tcg-card-detector)). deckpal's whole-image presence head let
busy tables and sleeves outvote the card (31% of card frames passed) until a max-pooled second head
raised it to 72.4% ([#317](https://github.com/cheyras/deckpal/pull/317)).

### Robustness tricks

**The measured evidence favours avoiding bad frames over repairing them**: Lookout skips frames by
IMU angular rate; the Laplacian's variance is the usual sharpness gate
([PyImageSearch](https://pyimagesearch.com/2015/09/07/blur-detection-with-opencv/)); **Google
PhotoScan registers five frames taken as the phone moves and takes a soft minimum of brightness**
([PhotoScan](https://research.google/blog/photoscan-taking-glare-free-pictures-of-pictures/));
patents cover glare-guided tilting, burst selection below a glare threshold and torch-on/off
comparison ([US9503612](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9503612);
[US10586316](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10586316);
[US10630905](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10630905)). Unmeasured
inferences for a hash: gate on the margin over the best rival, mask saturated low-chroma dHash cells
and normalise over the rest, sum margins across frames rather than counting votes, and treat
art-only matching as a trade (it tolerates pockets but worsens reprints).

### What is measured and what is not

**Measured somewhere**: hash robustness to crops and borders on generic photos (pHash, PDQ,
NeuralHash; not dHash), local-feature accuracy and CPU speed (HPatches), re-ranked retrieval
(ILIAS), ArcFace against triplet on real card photos (TCG-AR), corner IoU (Cornelius), a real-crop
ladder counting confident-wrong apart from coverage (deckpal), and now our replay. **Measured
nowhere found**: dHash under perspective, blur, glare or foil at ~100k; hash length against card
top-1; art-only against whole-card; multi-frame fusion gain; any detector on sleeves or binders; any
model in WebAssembly on a phone; printing-level accuracy on same-art reprints.

## Hard capture conditions and UX

### Binder pages and multi-card frames

**Pokémon-first apps offer multi-card capture; MTG-first apps still want one card on a plain
background.** PokeLenz claims a 3×3 page through the pockets and **advises moving closer and
scanning fewer cards when small text fails** ([PokeLenz](https://pokelenz.com/multi-card-scanner));
Collectr's binder mode is reported looser (competitor's comparison); Ludex and ManaBox want one card
and no overlaps
([Ludex](https://ludex.featurebase.app/help/articles/9439975-scanning-best-practices)). **Neither
segmentation family trusts the card's own edge**: a grid prior (pocket-trainer cuts the page into
equal cells, valid only when it fills the photo, tested only on a synthetic page) ([PR
#13](https://github.com/ReallyBadNews/pocket-trainer/pull/13)) or a detector trained on pockets
(PokeScope). No source describes a lattice prior, a classical way to find the card inside a pocket,
or per-pocket accuracy.

### Foil, holo and glare

**Phones handle glare with guidance and training; hardware measures the finish separately.**
Guidance: a slight tilt for foils, diffuse light, an angled lamp rather than overhead
([Grimoria](https://grimoria.app/help/scanner/tips-best-results)). The PhyzBatch fires a single LED
to see diffraction from the foiling, costing 55–60 → ~45 cards a minute ([TCG
Machines](https://support.tcgmachines.com/knowledge/foil-detection)); Roca's sensor detects the
metal layer but not the foil type; Lexmark's patent uses an inductive coil. **Sheen is both noise
and signal**: under dull light a Prizm Silver parallel was identified as the base card ([Ludex
lighting](https://pregradecards.com/news/how-lighting-affects-trading-card-scan-accuracy-in-ludex),
anecdote). Most phone apps leave foil to the user. Inference: our per-frame homographies are
PhotoScan's precondition, and cross-frame variance could flag a foil.

### Sleeves, top-loaders and graded slabs

**Sleeves are supported but risky everywhere**: glare stops border detection (ManaBox), vendors
advise unsleeving ([TCG
Stacked](https://www.tcgstacked.com/de/articles/mobile-card-scanning-digitize-collection)), sorters
run sleeved cards separately, and feeders need double-feed detection off ([Kronozio](https://help.kronozio.com/support/solutions/articles/73000571240-scan-cards-using-the-fujitsu-ricoh-fi-8170-raw-sleeves-and-toploaders-)).
**Graded slabs skip card recognition**: the cert number on the label is looked up through the
grader's API, as Card Dealer Pro 2.0 does for PSA, SGC, CGC and BGS ([CDP
2.0](https://www.carddealerpro.com/cdp2); [PSA API](https://api.psacard.com/publicapi/swagger.json))
— a separate, low-priority path for MTG.

### Hand-held stacks, blur and capture UX

**Stacks have converged on a continuous, tap-free live mode**, often with a feeder ramp ([Rare Candy
3.0](https://rarecandy.com/blog/rare-candy-scanner-3)), which must tell **the same card still in
view from another copy of it** (ManaBox: tap to count it again; deckpal re-arms on a different card
in the same place). BlinkID gates blur and glare at three strictness levels with real-time prompts
([BlinkID](https://github.com/BlinkID/blinkid-ios/blob/master/CHANGELOG.md)); no vendor publishes
its capture trigger. Microblink advises **no manual image-quality review** and found **users read
instructions more carefully after a failed scan than during onboarding**
([Microblink](https://docs.microblink.com/blinkid/ui-ux-best-practices)). The recurring capture
patterns are a viewport the card must sit in (or none), auto-capture with a manual fallback,
condition-specific prompts, sounds that encode price tier (ManaBox, SortSwift) and session locks;
the dominant complaint is the wrong printing, the dominant request a faster manual fallback.

### Surfacing uncertainty and corrections

**Mature tools tier matches and route the low tier to its own queue**: TCGplayer shows the scan
beside the catalogue image with set code, number and symbol; SortSwift offers alternatives side by
side and **bulk approval of high-confidence scans**
([SortSwift](https://sortswift.com/features/scanning-review-tools)); pocket-trainer holds an
uncertain pocket at a yellow "?" until it is confirmed; ManaBox's Quick Mode is a strictness switch.
Inferences: our undecided share maps onto a three-tier queue with bulk approval at the top; a "?"
must not block capture; a doubt between printings of one card wants a printing picker, between cards
a visual list.

### Hardware lessons

**Hardware wins by removing variables and pays throughput for extra checks** (foil detection costs a
sorter about a quarter of its speed). What transfers to a phone: session declarations (sleeved,
binder page, foil run, set, language) as its batches; the torch treated as a glare risk on sleeves
and foils, being a point source like the PhyzBatch's foil-test LED; a rig mode with a fixed region
for feeder and stand users; and always an unidentified bucket rather than a forced match.

## What our own scans showed

The full record — every rule, threshold, test and run — is in [the scanner
reference](../../reference/card-scanner.md): §3
[*Reframe*](../../reference/card-scanner.md#reframe--the-quad-read-as-an-inner-box-2026-10-14), §
[*Exact*](../../reference/card-scanner.md#exact) ("The gap gate"), § [*The synthetic
evaluation*](../../reference/card-scanner.md#the-synthetic-evaluation) and §10 [*The
replay*](../../reference/card-scanner.md#the-replay). What follows is the short version, measured
2026-10-14.

### The pipeline

Our scanner, in Rust for native and WebAssembly, finds quads on device with contours, Canny and Otsu
thresholding under a 63:88 aspect prior and a containment filter; rectifies each by homography with
alternate framings (0.92, 0.96 and 1.04 insets); matches a 256-bit colour dHash by brute-force
Hamming distance against 122,390 printings; reads the title band and the collector line by OCR from
fixed bands of the rectified crop; and combines frames in a multi-frame voting tracker. Exact mode
resolves a 7-frame burst through tiers and can answer with an ambiguous list. The text-detection
model ships but no read runs it, and a binding title read (`title_binds`) already limits the hash to
that card's printings.

### The replay baseline

86 real readers' scans (84 of them sent 2026-10-14): 55 one reader's binder pages filmed in portrait
and 31 hand-held stacks, replayed against the shipped 122,390-printing bundle before any change. The
newer bundle moved only 2 of 86 scans against the old 113,494-printing one.

| Pass | Right printing | Right card | Wrong card | Undecided | Never resolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| As scanned (Exact) | 34.9% | 41.9% | 19 | 36.0% | 25 |
| Fast | 31.4% | 38.4% | 9 | 51.2% | — |

### Why the 56 failures fail

Each failure was classed by eye from its scan's rectified crop:

| Failure class | Scans | Share of 56 | Share of 86 |
| --- | ---: | ---: | ---: |
| Inner box: the text box or art window, usually turned 90° | 28 | 50% | 32.6% |
| Sleeve pocket, with the whole card inset inside the crop | 13 | 23% | 15.1% |
| Right card, sibling printing | 6 | 11% | 7.0% |
| A decent crop that still failed (foils, a basic land, runs too short to resolve) | 6 | 11% | 7.0% |
| Other (no detection, a quad including the hand, a blank box) | 3 | 5% | 3.5% |

The sibling printings are prerelease promos against the set printing and variant frames: Famished
Worldsire EOE 182 against PEOE 182p, Loading Zone PEOE 196p, Nykthos Paragon PLST against PMH2,
Chimil ECC against PLCI 249s, Toph TLA 384 against 246, Raubahn FIN 388 against 533.

**41 of 56 (73%) fail before the hash runs, and in most inner-box failures the title is legible in
the full frame.** Inside a pocket the card's outer edge often never forms a contour, because the
pocket edge and sleeve are stronger; a sideways art window passes the 63:88 prior, and with no outer
contour the containment filter has nothing to drop it for — our version of SmartDoc's mouse pad.
**The hash, the title band and the collector band all read that one crop**, so a wrong quad blinds
all three, and the tracker decides nothing or settles on the nearest impostor. Only 12 failures are
of matching or reading; the synthesis estimated that on the ~42 scans with a usable crop the matcher
named the right card ~86% of the time and the printing ~71%, in the range of published systems, on
far too small a sample to rank us.

### The survey

Every detected frame of the 86 runs — 1,452 frames, with no session or tracker — was read as the
quad and as 8 extrapolated readings, each matched against all printings. **The quad as found named
the right card on 440 frames; some other reading did where it did not on only 84 more.** Across
every frame, 107 readings other than the quad named the right card — the lower block 45, the text
block 36, the upper block 15 and the art window 11, both orientations counted. Extrapolating outward from
an inner box roughly doubles whatever error its corners had. **Distance does not separate right from
wrong; the gap to the nearest other card does**:

| Measure | Right | Wrong |
| --- | ---: | ---: |
| Distance, median | 0.250 | 0.301, overlapping across most of the range |
| Gap to the nearest *other* card, median | 0.023 | 0.008 (90th percentile 0.020) |
| Gap with the quad read as the card, median | 0.035 | — |

A per-frame gate at gap ≥ 0.024 keeps 67% of right frames and 3% of wrong; at ≥ 0.02, 73% and 7%.

### What was built (PR #1046, commit `62f0c635`)

**Reframing.** A poorly matching quad is also read as four M15 regions, each from either long side
and extrapolated to the card it implies: the art window (x 0.073–0.924, y 0.108–0.557), the lower
block (type line to the bottom edge, y 0.557–1), the text block (x 0.073–0.924, y 0.560–0.920) and
the upper block (y 0–0.557), measured off the mean of 200 cached M15 renders. A reading must beat
the quad by 0.03 and stand 0.04 clear of the nearest other card, judged against every printing, and
is held across frames.

**The gap gate.** An Exact answer only the hash vouches for — no title settled the card, no
collector line pinned the printing — must stand 0.012 normalised (~3 bits) clear of the nearest
printing of another card, else it is not found; a reprint of the answer is not a rival, since
same-art printings tie by design. Fast's per-frame half is built and off.

**Two designs failed first, and each failure became a rule.** Chosen afresh each frame by distance,
reframing cut wrong cards 19 → 6 but raised never-resolved 25 → 44: one inner box's readings imply
cards a third of a card apart, the winner jumped between them and the lock never settled. Held but
chosen by distance, it cut wrong cards 19 → 11 but lost four right scans. Hence a held reading,
judged by the gap.

| Gap gate (Exact) | Wrong cards | Right answers lost |
| --- | ---: | --- |
| Off | 19 | — |
| **0.012** | **7** | None |
| 0.02 | 4 | One card (Raubahn) |
| 0.03 | 4 | Raubahn and Beastcaller Savant |

All 19 wrong cards were ambiguous lists without the reader's card in them, so what the gate removes
is a picker of strangers. Fast's gate at 0.008 removed 6 of its 9 wrong cards but cost two right
printings (Esquire of the King LTR 13, Decorum Dissertation SOS 78): one frame's gap says less than
a burst's.

### The result

| As scanned (Exact), 86 scans | Right printing | Right card | Wrong card | Undecided | Never resolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| Both off | 34.9% | 41.9% | 19 | 36.0% | 25 |
| Reframing alone | 36.0% | 44.2% | 14 | 39.5% | 29 |
| Gap gate alone | 34.9% | 41.9% | 7 | 50.0% | 25 |
| **Both (shipped)** | **36.0%** | **44.2%** | **7** | **47.7%** | 29 |

**13 scans better and none worse in Exact**; Fast 31.4% → 32.6% printing and 38.4% → 40.7% card, 2
better and none worse, wrong unchanged at 9. The synthetic evaluation (160 printings, seed 7, plain
and sleeved) checked that clean cards did not pay: Fast identical in both scenes, and 4 cards
changed anywhere — in sleeved Exact, Bruna INR 14 wrong → not found and Phantasmal Terrain 2ED 69
right (first of a list) → not found; Elektra MSH 326 not found → undecided; Forest LTR 721 right
either way, 3 frames slower. **The evaluation caught two bugs in the first build**: readings judged
under a set filter's few printings inflated the gap (Hypnotic Specter LEB 113 went right → wrong),
and clearing the held reading on untrusted frames stopped the lock forming (Archfiend of Despair FRC
46 lost). Mean frame time rose 14–22% in paired runs, under load. **Not measured on a phone or in
WebAssembly.**

## What to investigate next

Our ranking, by the scans each can recover and what it costs; ceilings are the sizes of the targeted
classes, not forecasts.

### 1. Read the title from the whole frame when a stretch is stuck

**Targets** the 28 inner-box scans and the no-detection cases, at card level. **Evidence**: the
title is legible in most of them, but OCR reads only where the quad says; the survey puts geometry's
ceiling low (84 frames beyond the quad's 440); a title names the card, and `title_binds` then limits
the hash to its printings, turning a useless sideways hash into a choice among a handful.
GrimbiXcode finds text lines anywhere without a model, and a line parallel to a sideways inner box
also settles orientation. **The biggest classical lever left.** **Cost**: medium — the
text-detection model already ships and the gates exist; the work is a whole-frame or
inner-box-anchored line search, run only when a stretch is stuck, with strict name-only gates
(tomoncupa's two-word, 0.92, two-reads rule cut wrong answers 805 → 25). **First experiment**: a
survey-mode pass that, where the quad matched poorly, reads lines across the full frame and counts
the inner-box scans gaining a binding title read against the reads binding a wrong card.

### 2. Find the card inside the pocket

**Targets** the 13 pocket scans. **Evidence**: they failed despite the 0.92 inset, so the inset
varies by pocket, and a few percent of crop error ruins a hash (PDQ 0.3255 at a 5% crop);
neotoxicfr's offset search, tmikonen's per-channel CLAHE thresholds and Dropbox's line-segment quads
each address it; the pocket is a strong prior (parallel, a few millimetres inside, 63:88). **Cost**:
low–medium, and confinable to a binder toggle (Roca's sleeved batches, pocket-trainer's grid,
Sparkheim's zone). **First experiment, the cheapest of all**: the survey mode can measure an inset
and offset grid inside each detected pocket in about a minute; count right-card frames and gaps on
the 13 pocket scans, and on the rest for harm.

### 3. Sibling printings

**Targets** the 6 sibling scans, and every card ranks 1 and 2 recover. **Evidence**: every source
picks same-art printings from printed keys, and ours differ in what a parse can drop: promo suffixes
(PEOE 182p, PLCI 249s), The List (PLST against PMH2), variant frames with other numbers (TLA 384 and
246, FIN 388 and 533). **Cost**: low. In order: repair set codes against the set list; keep `p`, `s`
and promo stars; require agreeing reads across frames before one overrides the image; gate the
collector line by frame era (M15 onward); add a soft set prior from the reader's recent confident
scans, since binders are often filed by set — TCG-AR's 85.1% → 96.4% shows a prior's worth, and as a
tie-break rather than a filter it cannot force a wrong set. **First experiment**: read the six
scans' collector slices and raw reads to see whether each key was read and dropped, misread, or
never read.

### 4. A burst-level Fast gap gate

**Targets** Fast's 9 wrong cards. **Evidence**: the per-frame gate at 0.008 removed 6 but cost two
printings; one frame's gap is informative but noisy (≥ 0.024 keeps 67% of right frames and 3% of
wrong); summing evidence over frames uses more of it, as CollectorVision does. **Cost**: low.
**First experiment**: weight Fast votes by gap, or require the gap over several frames, swept on the
replay and checked on the synthetic evaluation.

### 5. A learned corner detector

**Targets** 44 of 56 failures, the highest ceiling. **Evidence**: a corner model predicts corners
from context rather than waiting for an edge contour; Cornelius reaches IoU 0.969 at 23 ms on one
thread; but generic models return nothing on binders (duclvQ), and binder results come from binder
training data (PokeScope; TCG-AR's 18,000 composites). **Cost**: the highest — synthetic composites
of Scryfall images in pockets and binder pages with art windows and text boxes as decoys, training,
a runtime in both builds, cross-origin isolation on the web host, a presence head and a
full-resolution line fit. **The ready-made MTG weights (CollectorVision) are AGPL, so retrain** on
the published architecture; reframing, the gates and the replay carry over. **First experiment**:
hand-label corners on the binder batch, so any detector, classical or learned, is scored by corner
error before a runtime is built.

### 6. The not-found fallback

**Targets** the ~48% undecided, a share the gap gate raised on purpose. **Evidence**: readers
forgive "not sure" more than a wrong printing; instructions are read after a failure; page-wide
shots starve the bands (PokeLenz's advice, deckpal's 400 px); tiered review queues are the norm.
**Cost**: medium, mostly UI — a move-closer prompt, a three-tier review queue with bulk approval, a
binder mode with a page-grid prior. **First experiment**: classify the undecided replay scans by
quad found, rectified size and best gap, to see which prompt each warranted.

### 7. Foil glare

**Targets** part of the 6 decent-crop failures; low priority on this corpus. **Evidence**:
soft-minimum fusion, glare-masked cells and blur and glare gates, all unmeasured on cards; for the
basic land, uniformly dark cards defeat hashes (TCG Machines), so the collector line must decide.
**Cost**: medium. **First experiment**: count the foils among the decent-crop failures and compare
their saturated-pixel fraction with non-foils'.

**Process.** Keep a held-out set as the corpus grows: every threshold here (reframing's 0.03 and
0.04, the gap gate's 0.012) was tuned on 86 scans, mostly one reader's binder pages, each worth 1.2
points. Label new scans by condition (binder, pocket, hand-held, foil, basic land, same-art reprint,
frame era) and report right printing, right card, wrong card and undecided for each, as Konami tests
on real photos before every release and deckpal counts confident-wrong apart from coverage.

## Licences and patents

**The most reusable MTG models are AGPL-3.0**: CollectorVision's Cornelius, Milo and library
([CollectorVision](https://github.com/HanClinto/CollectorVision)) and jackttv's `yolo26n-pose`
corner model ([model card](https://huggingface.co/jackttv/card-scanner-yolo-pose)). Our app ships
through Google Play and as a web app from a Worker; on the usual reading of the AGPL, bundling AGPL
code or weights would oblige us to offer the whole app's source under the same licence. Unless we
intend that, reimplement the published architectures (MobileViT-XXS with a SimCC corner head;
MobileViT-XXS with an ArcFace head on illustration and set) and train our own weights. One Pokémon
prototype chose RTMDet over YOLO partly for its licence (jslok, snippet only); as general knowledge
rather than from the notes, Ultralytics' YOLO is AGPL-3.0, so YOLO-trained weights (duclvQ,
Adrihp06, OpenYuGi's) should be presumed AGPL until checked. **Licences not recorded** for
neotoxicfr, GrimbiXcode, DarylNo, deckpal, ptcg-detection, duclvQ, OpenYuGi, pocket-trainer,
tomoncupa, Moss Machine and tmikonen: check before copying code; the methods can be reimplemented.

**Patents.** Lexmark's [US12200174B2](https://patents.google.com/patent/US12200174B2/en) ("Trading
card sorter and methods", priority 2021-03-02, granted 2025-01-14) describes cropping the borders, a
32×32 DCT and a 64-bit pHash matched by Hamming distance to the nearest reference within a threshold
(its one example: 8), a 64-bit gradient dHash that must agree, comparison against inverted
references, optional OCR of set, number and language, and an inductive foil sensor. **Its claims
were not analysed; whether they reach a phone scanner that hashes and reads the collector line is a
question for counsel.** US 12,026,926 ("Automatically updating a card-scan machine learning model
based on predicting card characters") describes active learning from users' corrections (snippet
only); its PDF is a scanned image and the assignee could not be read
([USPTO](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12026926)). US 12400308
("Method and apparatus for identifying characteristics of trading cards") is image-only too;
assignee and claims unknown
([USPTO](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12400308)). Glare-capture
patents on guided tilting, burst selection and torch comparison (US9503612, US10586316, US10630905)
matter if we build glare guidance; their assignees were not recorded.

## Gaps and caveats

- **No independent benchmark** exists for MTG or any other game; no commercial scanner publishes
  per-condition accuracy (foil, sleeve, binder, language); no source measures printing-level
  accuracy on same-art reprints, or binder-page accuracy.
- **Commercial internals are unknown** for Delver Lens, ManaBox (on-device or cloud, which model),
  Roca Vision, Dragon Shield, Collectr, CollX, Ludex and TCGplayer's app, and nobody says how they
  read the set symbol. Konami's CEDEC decks were not read.
- **Most figures are claims**: vendor (Roca, TCGplayer, TCG Machines, Ximilar, CardSight, Scrytics),
  self-reported (PokeScope, Eyevo) or competitor's comparisons (Eyevo, Rare Candy, Cards AI, Lotus
  Scan). Reddit, the obvious source of user-reported failure rates, could not be read.
- **The notes disagree** on TCG-AR's speed, PokeScope's own improvement figure and deckpal's best
  fine-tune (v1 93.8% against v2 90.6%); Ripdex's 98.1% has no traceable source; the printing count
  grew during the work (~118k in the technique notes, 122,390 shipped).
- **Our corpus is small and narrow**: 86 scans, 55 of them one reader's binder pages; each is 1.2
  points; every threshold was tuned on it with no held-out set; failure classes were assigned by
  eye. A replay is not the scan: it lacks the detail pictures a camera sends, so Exact always waits
  the whole seven frames and a run too short to resolve scores as undecided. Frame times were taken
  under load on a shared machine; nothing was measured on a phone or in WebAssembly.

## Sources

### MTG
- Apps: [ManaBox FAQ](https://manabox.app/guides/scanner/faq/), [ManaBox getting started](https://manabox.app/guides/scanner/getting-started/), [Dragon Shield](https://apps.apple.com/app/id1460657155), [CardCastle](https://support.cardcastle.co/en/articles/2010498-card-scanning-tutorial), [Scrytics scanner](https://scrytics.com/features/scanner), [Scrytics roundup](https://scrytics.com/blog/best-mtg-card-scanner-app-2026), [Eldwyn](https://apps.apple.com/app/id6759303500), [ManaForge](https://apps.apple.com/app/id6758670832), [Sparkheim](https://mwm.ai/apps/sparkheim-mtg/6792481720), [Lotus Scan FAQ](https://www.scanyourmtg.com/faq/wrong-set-detection/).
- TCGplayer, Roca, TCG Machines: [app 4.10.4](https://www.apkmirror.com/apk/tcgplayer-inc/tcgplayer/tcgplayer-4-10-4-release/), [Scan & Identify announcement](https://seller.tcgplayer.com/blog/announcing-scan-identify-revolutionize-your-inventory-listing), [Scan & Identify](https://seller.tcgplayer.com/scan-identify), [how it works (snippet)](https://help.tcgplayer.com/hc/en-us/articles/27303183354007-How-Quicklist-IdentificationTechnology-Works), [Scan & Identify FAQ (snippet)](https://help.tcgplayer.com/hc/en-us/articles/27302442668695-Scan-Identify-FAQ), [Roca Sifter Q&A](https://seller.tcgplayer.com/blog/your-roca-sifter-questions-answered), [Our robots can read](https://tcgmachines.com/blog/our-robots-can-read), [foil detection](https://support.tcgmachines.com/knowledge/foil-detection).
- Open source: [Patterson 2014](https://www.rubyevents.org/talks/a-magical-gathering), [hj3yoo](https://github.com/hj3yoo/mtg_card_detector/blob/master/README.md), [tmikonen](https://tmikonen.github.io/quantitatively/2020-01-01-magic-card-detector/), [oracle_ii](https://github.com/frnsys/oracle_ii), [neotoxicfr art index](https://github.com/neotoxicfr/mtg-scanner-art-index), [DarylNo](https://github.com/DarylNo/CardScanner), [GrimbiXcode](https://github.com/GrimbiXcode/mtgscan), [tomoncupa #1](https://github.com/tomoncupa/magic/pull/1), [OmniCard #177](https://github.com/anubisascends/OmniCard/pull/177).

### Pokémon
- Apps: [PokeScope build](https://pokescope.app/blog/how-i-built-pokemon-card-scanner-ai-50000-users/), [Eyevo AI vs OCR](https://eyevotcg.com/blog/ai-vs-ocr-scanning-which-to-use/), [Eyevo roundup](https://eyevotcg.com/blog/best-pokemon-card-scanner-apps-2026/), [HobbyCardIndex](https://hobbycardindex.com/hubs/pokemon-card-scanners/), [Dex help](https://dextcg.com/help/collection/scanning-your-cards), [Ximilar 2022](https://ximilar.com/blog/pokemon-card-image-search-engine).
- Open source and academic: [ptcg-detection](https://github.com/hugopeixoto/ptcg-detection), [deckpal](https://github.com/cheyras/deckpal), [deckpal #284](https://github.com/cheyras/deckpal/pull/284), [#288](https://github.com/cheyras/deckpal/pull/288), [#294](https://github.com/cheyras/deckpal/pull/294), [#303](https://github.com/cheyras/deckpal/pull/303), [#317](https://github.com/cheyras/deckpal/pull/317), [Adrihp06 detector](https://huggingface.co/Adrihp06/TCGscanner-detector), [Cole-Crawley](https://github.com/Cole-Crawley/pokemon-card-scanner), [Ptcg-AR thesis](https://matheo.uliege.be/handle/2268.2/23388).

### Yu-Gi-Oh!, other games, sports, sorters and APIs
- [Konami Neuron slides](https://pages.awscloud.com/rs/112-TZM-766/images/KONAMI_AIMLTokyo7.pdf), [OpenYuGi](https://github.com/DJ-Cat-N-Cheese/Yu-Gi-Oh-Card-Tracker/blob/main/docs/CardScanning.md), [tsaow](https://github.com/tsaow/Yugioh_card_scanner), [Lowhur](https://pyimagesearch.com/2021/03/03/an-interview-with-anthony-lowhur-recognizing-10000-yugioh-cards-with-computer-vision-and-deep-learning/), [fabscan](https://github.com/IAmThermite/fabscan), [eBay 2021](https://www.ebayinc.com/stories/news/new-ebay-scanning-tool-to-cut-listing-time-in-half-for-trading-card-sellers/), [Card Dealer Pro overview (snippet)](https://support.carddealerpro.com/hc/en-us/articles/21788884792219-Trading-Card-Scanner-Overview).
- [CollX FAQ](https://collx.app/faq), [Cards AI (competitor)](https://www.cardsaiapp.com/blog/collx-vs-ludex), [CardSight AI](https://cardsight.ai/solutions/identification), [Ximilar sports](https://www.ximilar.com/blog/how-to-identify-sports-cards-with-ai/), [Moss Machine](https://kairicollections.github.io/Moss-Machines-Magic-the-Gathering-sorting/), [Mault](https://github.com/Pathaleon/mault), [TinEye CardSearchEngine](https://help.tineye.com/article/306-about-cardsearchengine).
- Learned card models: [TCG-AR](https://arxiv.org/html/2607.02090v1), [CollectorVision](https://github.com/HanClinto/CollectorVision), [Milo](https://huggingface.co/HanClinto/milo), [Cornelius](https://huggingface.co/HanClinto/cornelius), [jackttv yolo-pose](https://huggingface.co/jackttv/card-scanner-yolo-pose), [duclvQ](https://huggingface.co/duclvQ/tcg-card-detector).

### Matching techniques
- [McKeown & Buchanan](https://arxiv.org/html/2212.08035v1), [perceptual-hash robustness](https://arxiv.org/html/2406.00918v2), [PDQ test drive](https://arxiv.org/pdf/1912.07745), [Hacker Factor dHash](https://www.hackerfactor.com/blog/index.php?/archives/529-Kind-of-Like-That.html), [XFeat](https://arxiv.org/html/2404.19174v1), [ILIAS](https://vrg.fel.cvut.cz/ilias/), [ILIAS paper](https://arxiv.org/abs/2502.11748), [SSCD](https://arxiv.org/pdf/2202.10261), [Google Lookout](https://research.google/blog/on-device-supermarket-product-recognition/), [MobileCLIP2-S0](https://huggingface.co/timm/MobileCLIP2-S0-OpenCLIP/blob/main/README.md), [ONNX Runtime Web](https://opensource.microsoft.com/blog/2021/09/02/onnx-runtime-web-running-your-machine-learning-model-in-browser/), [FAISS index guide](https://github.com/facebookresearch/faiss/wiki/Guidelines-to-choose-an-index).
- [Dropbox document detection](https://dropbox.tech/machine-learning/fast-and-accurate-document-detection-for-scanning), [SmartDoc contours](https://arxiv.org/pdf/2008.02615), [DocAligner](https://pypi.org/project/docaligner-docsaid/), [blur detection](https://pyimagesearch.com/2015/09/07/blur-detection-with-opencv/), [PhotoScan](https://research.google/blog/photoscan-taking-glare-free-pictures-of-pictures/), [US9503612](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9503612), [US10586316](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10586316), [US10630905](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10630905).

### Hard conditions and UX
- [PokeLenz](https://pokelenz.com/multi-card-scanner), [Ludex best practices](https://ludex.featurebase.app/help/articles/9439975-scanning-best-practices), [pocket-trainer #13](https://github.com/ReallyBadNews/pocket-trainer/pull/13), [Grimoria tips](https://grimoria.app/help/scanner/tips-best-results), [Card Slinger](https://cardslinger.shop/pages/faq-tips), [TCG Stacked](https://www.tcgstacked.com/de/articles/mobile-card-scanning-digitize-collection), [Ludex lighting](https://pregradecards.com/news/how-lighting-affects-trading-card-scan-accuracy-in-ludex), [Rare Candy Scanner 3.0](https://rarecandy.com/blog/rare-candy-scanner-3), [BlinkID changelog](https://github.com/BlinkID/blinkid-ios/blob/master/CHANGELOG.md), [Microblink UI/UX](https://docs.microblink.com/blinkid/ui-ux-best-practices), [SortSwift review tools](https://sortswift.com/features/scanning-review-tools), [Kronozio](https://help.kronozio.com/support/solutions/articles/73000571240-scan-cards-using-the-fujitsu-ricoh-fi-8170-raw-sleeves-and-toploaders-), [Card Dealer Pro 2.0](https://www.carddealerpro.com/cdp2), [PSA Public API](https://api.psacard.com/publicapi/swagger.json).
- Patents: [US12200174B2](https://patents.google.com/patent/US12200174B2/en), [US 12,026,926](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12026926), [US 12400308](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12400308).
