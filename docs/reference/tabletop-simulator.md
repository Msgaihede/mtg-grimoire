# Tabletop Simulator saves

`apps/desktop/src-tauri/src/tabletop/`, issue [#1038](https://github.com/Msgaihede/mtg-grimoire/issues/1038),
shipped 2026-10-14. Settings → **Integrations** → **Tabletop Simulator**. Desktop only, and **off
until the reader switches it on**: it writes into a folder that belongs to another program.

When it is on, every deck is a Tabletop Simulator save in an `MTG Grimoire` folder inside the
reader's TTS `Saves` folder, rewritten a couple of seconds after any change to the deck, the same way
the [plain-text mirror](text-mirror.md) keeps its files. In Tabletop Simulator they are under
**Games → Save & Load → MTG Grimoire**.

## What lands on disk

```
<Documents>/My Games/Tabletop Simulator/Saves/      Tabletop Simulator's, never created by us
  MTG Grimoire/
    .grimoire-manifest                              what the last pass wrote (the pruner's authority)
    Burn.json                                       a deck with one list
    Azula/                                          a theory-and-actual deck: a folder, both lists
      Azula (Actual).json
      Azula (Theory).json
    <deck folder>/<deck folder>/…                   the reader's deck folders, nested
    Archived/…                                      archived decks, with their folder tree
```

**Every kind of deck is written**: regular, theory-and-actual (both lists, in a folder of their
own), virtual, and archived. The paths are the text mirror's deck tree, borrowed rather than
re-derived — `run::save_paths` asks `mirror::layout::plan_files` for it and turns each deck's plain
`.txt` into a save path — so sanitising, `Aggro (2)` disambiguation and the reserved `Archived` name
are one implementation, and the two folders cannot disagree about which deck is which.

The `Saves` folder is found under the OS Documents folder (Tauri's `document_dir`, resolved once at
launch) and can be moved with **Change folder…** (`tabletop_pick_folder`, a picker opened by Rust,
issue #545's rule: no path crosses IPC). **A missing `Saves` folder is a sentence, not a
`create_dir_all`** — a reader who has never run Tabletop Simulator must not get a `My Games` tree
from us. Picking the `MTG Grimoire` folder itself is read as its parent.

## What is in a save

One save is one table with up to four stacks, left to right:

| Stack | From | Lies |
| --- | --- | --- |
| Library | every active `main` pile | face down |
| Commander | every active `commander` and `companion` pile | face up |
| Sideboard | every active `side` pile | face down |
| Tokens & extras | `deck_tokens::deck_token_rows` for that list | face up |

A switched-off pile and the maybeboard stay off the table — the first counts toward nothing in the
app, the second is cards the reader is only considering. An empty stack is no object; **a stack of
one card is a `Card`, never a `Deck`**, because TTS refuses a deck of one (a lone commander).

**Tokens**: a token the reader has configured — entries of its own in that list — is those
printings, one card per copy (at least one). A token with only its implicit entry is **the newest
printing** of it (`released_at DESC`, then the resolver's own tie-break), one copy: a token on the
table is something to clone. Emblems and helper cards (The Monarch, dungeons) come through the same
rows.

**Double-faced cards** carry their back face as TTS state 2 (PageUp/PageDown flips it). The back
face is deliberately not the sheet's `BackURL`: a face-down library has to show the ordinary Magic
back, or it would tell the table which transform card is on top. "Double-faced" means the printing's
`card_faces` carry pictures of their own (`transform`, `modal_dfc`, battles, double-faced tokens); a
split card, an adventure and a `meld` half are one picture.

**Pictures are Scryfall's `large` JPEG, read from `cards.raw`**, not the stored `display` URL: that
column holds Scryfall's WEBP family, which TTS does not load, while every raw line still carries the
JPG family (checked on the dev corpus, 2026-10-14). Only `https://cards.scryfall.io/` is accepted,
the image cache's own host fence. The card back is the printing's `card_back_id` on
`backs.scryfall.io`, defaulting to the ordinary back (verified `200 image/jpeg`, 2026-10-14). A
printing that has left the corpus falls back to Scryfall's image redirect for its set and number.

Every picture is a one-card sheet and sheet keys are numbered across the **whole save**, because TTS
folds every `CustomDeck` it loads into one table. The JSON is pretty-printed and carries no date,
GUID or seed, so the same deck renders the same bytes and an unchanged deck is never rewritten.

## Local pictures (opt-in)

**Scryfall refuses a library-default User-Agent on its image hosts.** Checked 2026-10-14: every
card-image URL a save names answers `200 image/jpeg` to a request with an application's own agent,
and `400` with `"rule": "generic_user_agent"` to one carrying a Unity default
(`UnityPlayer/… (UnityWebRequest/1.0, libcurl/…)`) — on `cards.scryfall.io` and `api.scryfall.com`
alike; `backs.scryfall.io` answers either. Which agent Tabletop Simulator's own downloader sends was
not measured.

So links stay the default — the only pictures every player at a table can load (the owner's call,
2026-10-14) — and **Store card images on this computer** (`app_meta.tabletop_local_images`, off) is
the switch for a reader whose cards come up blank. With it on, `images::Localizer` fetches every
picture a save names through `scryfall::Client::fetch_image` — the app's own agent, its 4 MB cap and
10 s bound — at ten a second, into `MTG Grimoire/Images/<sha256 of the URL>.jpg`, written through a
`.part` and kept only if its first bytes are a JPEG or PNG. The save names the `file:///` copy
(percent-encoded: `My Games` has a space). The URL's `?<epoch>` makes a re-scanned card a new file.
A file already there is never fetched again; a fetch that fails counts in `failed` and the save keeps
the link. The pictures are manifest lines like the saves, so one no save names is pruned, and
switching back to links prunes them all. Other players at the table cannot load another computer's
files.

Measured live 2026-10-14 against a copy of the dev database (9 saves): the first pass fetched
**402 pictures in 41.6 s**, every one a real 672×936 JPEG; the second fetched nothing
(`unchanged: 403`).

## How a change becomes a save

`watch::Tabletop` is a fourth observer on the write connection's hook, after the mirror's mask —
not the mask itself, because the two threads would race to `take` it. It marks on a row of
`decks`, `deck_cards`, `deck_categories`, `deck_folders`, `deck_tokens` or `deck_token_printings`
(the mirror ignores the last two) and on `corpus_replaced` (a re-scan moves a picture's URL). The
thread is the mirror's loop for one surface: `TICK` 250 ms, `DEBOUNCE` 2 s, the settings read once
per debounce, a startup pass when on, a full pass on off→on, and a backoff to a minute on failure.
Every pass renders every deck — a deck edit is one save rewritten and the rest compared byte for
byte.

## Pruning

By manifest, the mirror's rule: the folder may hold the reader's own saves, so a file is deleted
only when the previous `.grimoire-manifest` names it and this pass does not. Only `.json` lines and
`Images/*.jpg` lines are honoured and every line is fenced against leaving the folder (`run::safe_entry`). Wanted paths are
compared case-insensitively, so an `azula` → `Azula` rename on NTFS does not delete the file it has
just written. Directories are removed with `remove_dir` only, deepest first, so one still holding a
reader's save stays. The manifest is written last. Its first line names the installation
(`mirror_installation`), and a pass over a folder another installation owns refuses before writing —
two computers syncing one Documents folder would otherwise prune each other's decks.

Switching the integration off leaves every save where it is.

## Settings

`app_meta.tabletop_enabled` (`1`/`0`, default off), `app_meta.tabletop_local_images` (`1`/`0`, default off) and `app_meta.tabletop_saves` (an absolute path,
default the Documents one). Reading never fails; writing validates. `tabletop_saves` is a path on this
computer, so a full-data archive leaves it out beside `mirror_root` (`grimoire_core::archive`). Five
commands, all `command_table::DESKTOP_ONLY`: `tabletop_status`, `tabletop_set_enabled`,
`tabletop_set_local_images`, `tabletop_pick_folder`, `tabletop_rebuild`.

## Not verified

- **No save has been loaded into Tabletop Simulator by this build's author** — there is no TTS on the
  machine it was written on. The format follows Tabletop Simulator's save-format page and the shape
  TTS deck builders write; the first live load should confirm the stacks' placement, the state flip,
  whether links load (the User-Agent question above) and that the `Table_Octagon`/`Sky_Forest` pair opens as expected.
- The Documents folder is the OS's; a reader who moved their TTS saves elsewhere has to point the
  integration at them with **Change folder…**.
