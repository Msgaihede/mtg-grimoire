import { readFileSync, writeFileSync } from "node:fs";
const SRC = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src";

function edit(rel, pairs) {
  const p = `${SRC}/${rel}`;
  let s = readFileSync(p, "utf8");
  for (const [from, to] of pairs) {
    if (!s.includes(from)) throw new Error(`${rel}: NOT FOUND: ${from.slice(0, 90)}`);
    if (s.split(from).length > 2) throw new Error(`${rel}: NOT UNIQUE: ${from.slice(0, 90)}`);
    s = s.replace(from, to);
  }
  writeFileSync(p, s);
  console.log("patched " + rel);
}

edit("web/route.rs", [
  [
    `    /// **The list and the table must not drift.**`,
    `    /// **The three clears answer their own counts through the route**, which is more than
    /// \`every_advertised_command_is_actually_routed\` can say: that one only proves an arm
    /// exists. Seeded, cleared, and the emptiness read back off the connection.
    ///
    /// **\`decks_clear\` is the one worth a test of its own and it does not get one here**,
    /// because the thing to prove about it cannot be proved from this side: its \`covers\`
    /// argument is hard-coded \`None\` in the arm, and \`None\` is the only value a browser
    /// could pass. What a wrong value would do — \`sweep_dir\` recursively deleting whatever
    /// directory it was handed — is \`reset.rs\`'s own concern and is fenced there. All this
    /// asserts is that the arm runs and empties the table.
    #[test]
    fn the_three_clears_empty_their_tables_through_the_route() {
        let s = state("web-route-clears");
        {
            let conn = crate::db::lock_blocking(&s.db);
            conn.execute_batch(
                "INSERT INTO collection_entries
                    (card_id, set_code, collector_number, lang, finish, condition, quantity,
                     created_at, updated_at)
                 VALUES ('a', 'lea', '1', 'en', 'nonfoil', 'NM', 4, 0, 0);
                 INSERT INTO wishlist_entries
                    (oracle_id, name, quantity, created_at, updated_at)
                 VALUES ('o1', 'Black Lotus', 2, 0, 0);",
            )
            .unwrap();
        }

        let cleared = call(&s, "collection_clear", &json!({})).unwrap();
        // camelCase, because \`CollectionCleared\` is \`rename_all = "camelCase"\` and
        // \`src/lib/ipc.ts\` reads this exact key.
        assert_eq!(cleared["entries"], json!(1));
        // \`wishlist_clear\` answers a bare count rather than a struct — see its Rust doc.
        assert_eq!(call(&s, "wishlist_clear", &json!({})).unwrap(), json!(1));
        // The decks table is empty in the fixture, so this proves the arm runs and refuses
        // nothing rather than proving a count.
        let decks = call(&s, "decks_clear", &json!({})).unwrap();
        assert!(decks.get("decks").is_some(), "got {decks:?}");

        let conn = crate::db::lock_blocking(&s.db);
        for table in ["collection_entries", "wishlist_entries"] {
            let left: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(left, 0, "{table} still has rows after its clear");
        }
    }

    /// **\`cache_clear\` is the fourth clear and must stay unroutable**, which is a different
    /// statement from "nobody has got to it yet". \`reset::clear_cache\` takes a
    /// \`&crate::images::Cache\` and sweeps a directory of files; on this target the byte
    /// cache is Cache Storage, so the arm cannot exist until that is rewritten.
    ///
    /// Asserted rather than left implicit because the failure it guards is silent in the
    /// other direction: an arm added here without the rewrite would compile only on the
    /// desktop leg and take the wasm build red on a branch nobody ran \`--target\` on.
    #[test]
    fn cache_clear_is_not_routed_while_the_image_cache_is_a_rewrite() {
        let s = state("web-route-cache-clear");
        let err = call(&s, "cache_clear", &json!({})).unwrap_err();
        assert_eq!(err, RouteError::Unknown("cache_clear".into()));
        assert!(!COMMANDS.contains(&"cache_clear"));
    }

    /// **The answer \`UpdatePanel\` reads to decide it must not draw a Download button.**
    ///
    /// \`installKind\` is the whole point of routing this: the panel tests it, and where the
    /// command did not answer at all the panel read the *absence* as "not managed" and drew
    /// the controls. So the assertion is on the value and on its camelCase key, both of
    /// which the TypeScript side reads by name.
    #[test]
    fn update_status_answers_the_web_install_kind_and_a_version() {
        let s = state("web-route-update-status");
        let out = call(&s, "update_status", &json!({})).unwrap();
        assert_eq!(out["installKind"], json!("web"));
        assert_eq!(out["currentVersion"], json!(crate::update::current_version()));
        // Nothing on this target can be mid-check or hold a staged build.
        assert_eq!(out["busy"], json!(false));
        assert_eq!(out["staged"], json!(false));
        // Never checked, because nothing here can check — and \`app_meta\` does not sync, so
        // no other device fills this in either.
        assert_eq!(out["available"], json!(null));
        assert_eq!(out["lastCheckAt"], json!(null));
    }

    /// **An empty list, and that is the answer rather than a failure.** \`update::history\`
    /// reads one \`app_meta\` row that only \`update_check\` ever writes, and \`update_check\` is
    /// absent on this target — so a browser's history is empty for ever, which is the same
    /// "never fetched" state the Tagger models.
    #[test]
    fn update_history_answers_an_empty_list_where_nothing_can_check() {
        let s = state("web-route-update-history");
        assert_eq!(call(&s, "update_history", &json!({})).unwrap(), json!([]));
    }

    /// **\`update_check\` is absent from this table and cannot be added to it.** Not "not yet"
    /// — [\`call\`] is synchronous because the Worker's \`#[wasm_bindgen] call\` is, so an
    /// \`async fn\` cannot be an arm here whatever it fetches with.
    ///
    /// Its three companions are refused for the ordinary reason: they swap an \`.exe\`.
    #[test]
    fn the_updater_commands_that_act_are_refused_by_name() {
        let s = state("web-route-update-absent");
        for name in [
            "update_check",
            "update_download",
            "update_apply",
            "update_open_release_page",
        ] {
            assert_eq!(
                call(&s, name, &json!({})).unwrap_err(),
                RouteError::Unknown(name.into()),
                "\`{name}\` must not be routed"
            );
            assert!(!COMMANDS.contains(&name));
        }
    }

    /// **The list and the table must not drift.**`,
  ],
]);
