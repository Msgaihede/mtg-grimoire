import { readFileSync, writeFileSync } from "node:fs";
const p = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset/src-tauri/src/update.rs";
let s = readFileSync(p, "utf8");
function must(from, to) {
  if (!s.includes(from)) throw new Error("NOT FOUND: " + from.slice(0, 100));
  if (s.split(from).length > 2) throw new Error("NOT UNIQUE: " + from.slice(0, 100));
  s = s.replace(from, to);
}

// The union is closed on both sides; the fifth member has to be in the census.
must(
  `        // The four install kinds are a closed union on the other side too. \`src/lib/ipc.ts\`
        // mirrors this by hand, and a rename here with no rename there is a status the panel
        // renders as no branch at all.
        for (kind, name) in [
            (InstallKind::Portable, "portable"),
            (InstallKind::Nsis, "nsis"),
            (InstallKind::Managed, "managed"),
            (InstallKind::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }`,
  `        // The five install kinds are a closed union on the other side too. \`src/lib/ipc.ts\`
        // mirrors this by hand, and a rename here with no rename there is a status the panel
        // renders as no branch at all — which is exactly what a browser got while \`web\` did
        // not exist and \`installKind\` arrived \`undefined\`.
        for (kind, name) in [
            (InstallKind::Portable, "portable"),
            (InstallKind::Nsis, "nsis"),
            (InstallKind::Managed, "managed"),
            (InstallKind::Web, "web"),
            (InstallKind::Other, "other"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), name);
        }`,
);

// A test for the split that lets a target with no `Updater` answer at all.
must(
  `    /// The cache is re-compared against the running version on every read, which is what
    /// makes it self-clearing:`,
  `    /// **[\`status_for\`] answers without an [\`Updater\`], which is what makes the Updates
    /// panel decidable in a browser.**
    ///
    /// Driven with a cached release in \`app_meta\` on purpose: the interesting half is that
    /// everything except the three parameters still comes off the database, so a web caller
    /// gets the same self-clearing comparison against the running version that the desktop
    /// does. What differs is only the kind — and therefore the asset, which \`pick_asset\`
    /// refuses for \`Web\` exactly as it refuses it for \`Managed\`.
    #[test]
    fn status_for_answers_off_the_database_without_an_updater() {
        let (state, _dir) = file_state("status-for");
        let release = parse_release(&live_payload()).unwrap();
        {
            let conn = crate::sync::lock_db(&state);
            set_app_meta(&conn, K_LAST_CHECK_AT, "1800000000").unwrap();
            set_app_meta(
                &conn,
                K_LATEST_SEEN,
                &serde_json::to_string(&release).unwrap(),
            )
            .unwrap();
        }

        // A portable install on 0.1.0 is offered the release and its asset.
        let portable = status_for(&state, InstallKind::Portable, false, false);
        assert_eq!(portable.install_kind, InstallKind::Portable);
        assert_eq!(portable.last_check_at.as_deref(), Some("1800000000"));
        assert!(portable.available.is_some());
        assert!(portable.asset.is_some());

        // The same database read as a browser: the news survives, the download does not.
        let web = status_for(&state, InstallKind::Web, false, false);
        assert_eq!(web.install_kind, InstallKind::Web);
        assert_eq!(web.last_check_at.as_deref(), Some("1800000000"));
        assert!(
            web.available.is_some(),
            "the cached release is a fact about the database, not about the install kind"
        );
        assert!(
            web.asset.is_none(),
            "nothing on this target can install an asset, so none may be offered"
        );
        // The two flags are the caller's, and a browser has nothing to report for either.
        assert!(!web.busy);
        assert!(!web.staged);
        assert_eq!(web.current_version, current_version());
    }

    /// The cache is re-compared against the running version on every read, which is what
    /// makes it self-clearing:`,
);

writeFileSync(p, s);
console.log("update.rs tests patched");
