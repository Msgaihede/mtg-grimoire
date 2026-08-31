import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/web/route.rs";
let s = readFileSync(p, "utf8");
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}

// ── 1. The advertised list ───────────────────────────────────────────────────────────────
must(
  `    // The last two gaps, closed. See the arms.
    "marketplace_feed_status",
    "import_resolve",
    "deck_import_commit",
];`,
  `    // The last two gaps, closed. See the arms.
    "marketplace_feed_status",
    "import_resolve",
    "deck_import_commit",
    // **Three of Settings' four clears.** \`cache_clear\` is the fourth and is not here: it
    // sweeps a directory of image files, which on this target is Cache Storage — see the
    // arms, and \`reset::clear_cache\`'s own gate.
    "collection_clear",
    "wishlist_clear",
    "decks_clear",
    // **The two halves of the updater that report rather than replace.** The other three —
    // \`update_check\`, \`update_download\`, \`update_apply\` — and \`update_open_release_page\`
    // stay desktop's; the arms below say why the first of those is *absent* here rather than
    // merely unrouted.
    "update_status",
    "update_history",
];`,
);

// ── 2. The arms ──────────────────────────────────────────────────────────────────────────
must(
  `        other => Err(RouteError::Unknown(other.to_owned())),
    }
}`,
  `        // ── Settings' clears ─────────────────────────────────────────────────────────
        //
        // **Three of the four, and none of them takes an argument** — \`src/lib/ipc.ts\` calls
        // each as a bare \`invoke("…_clear")\`, so there is no name here to get wrong.
        //
        // **\`cache_clear\` is deliberately absent and is not an oversight.** It is the only
        // one of the four whose function does not compile for this target: \`clear_cache\`
        // takes a \`&crate::images::Cache\` and sweeps a directory, and on web the byte cache
        // is Cache Storage rather than a filesystem. That is a rewrite rather than a port —
        // the same call \`lib.rs\` makes about \`images\` itself — and it is its own piece of
        // work. Until it lands, the Local cache panel's button is the one control on the
        // Settings page that still answers \`unknown command\` in a browser.
        "collection_clear" => encode(
            command,
            // \`with_write_owned\`, matching the desktop wrapper: the facet index's \`owned\`
            // bitset is built from \`collection_entries\`, so a wipe that skipped the rebuild
            // would leave the sidebar offering an Owned facet over a collection that is gone.
            crate::collection_source::with_write_owned(state, crate::reset::clear_collection)
                .map_err(RouteError::Failed)?,
        ),

        "wishlist_clear" => encode(
            command,
            crate::sync::with_write(state, crate::reset::clear_wishlist)
                .map_err(RouteError::Failed)?,
        ),

        // **\`None\` for the covers directory, and it is the load-bearing argument on this
        // line.** \`clear_decks\` hands that path to \`sweep_dir\`, which deletes everything
        // under it recursively; its own doc already defines \`None\` as "the directory could
        // not be resolved, so the rows go and the pictures they pointed at are inert". A
        // browser has no covers directory at all — \`crate::paths\` does not compile here —
        // so \`None\` is not a fallback, it is the true answer, and there is no value this
        // target could pass that would be safe to sweep.
        "decks_clear" => encode(
            command,
            crate::sync::with_write(state, |c| crate::reset::clear_decks(c, None))
                .map_err(RouteError::Failed)?,
        ),

        // ── The updater, reporting only ──────────────────────────────────────────────
        //
        // **\`update_check\` is absent from this table and cannot be added to it**, which is
        // a different thing from the four \`*_refresh\` commands merely not being here yet.
        // This function is synchronous — the Worker's \`#[wasm_bindgen] call\` is — so an
        // \`async fn\` cannot be a \`match\` arm at all, whatever it fetches with. The two
        // network operations this target does perform are \`glue::ingest_cards\` and
        // \`glue::ingest_combos\`: bespoke \`async\` \`#[wasm_bindgen]\` entry points with their
        // own \`postMessage\` kinds, which is what a web \`update_check\` would have to become.
        // Nothing calls it in the meantime: \`UpdatePanel\` reads \`installKind\` below and
        // offers a browser no Check button.
        //
        // \`Web\`, \`false\`, \`false\` — and \`status_for\` takes the read connection itself, like
        // every other read in this table. Nothing here can be busy with a check it cannot
        // run, and nothing can be staged where there is no file to stage.
        "update_status" => encode(
            command,
            crate::update::status_for(state, crate::update::InstallKind::Web, false, false),
        ),

        // Two \`app_meta\` reads and no network, on every target — \`update::history\`'s own
        // doc is explicit that it never fetches. **In a browser it always answers an empty
        // list**, because only \`update_check\` writes that row and \`app_meta\` is not one of
        // the synced tables. That is the same "never fetched" state the Tagger models, and
        // it is why the panel draws no version history there.
        "update_history" => encode(command, crate::update::history(state)),

        other => Err(RouteError::Unknown(other.to_owned())),
    }
}`,
);

// ── 3. The drift fence ───────────────────────────────────────────────────────────────────
must(
  `        assert_eq!(
            COMMANDS.len(),
            114,
            "update this number when a command is added"
        );`,
  `        assert_eq!(
            COMMANDS.len(),
            119,
            "update this number when a command is added"
        );`,
);

// ── 4. The header's own count of what is routed ──────────────────────────────────────────
must(
  `/// **This is still not the whole surface.** The app has 152 commands. The first four here are`,
  `/// **This is still not the whole surface.** The app has 154 commands. The first four here are`,
);

writeFileSync(p, s);
console.log("route.rs patched");
