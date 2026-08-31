import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = "D:/Code/mtg-grimoire/.claude/worktrees/parity-reset";
const MANIFEST = `${ROOT}/src-tauri/Cargo.toml`;

// **No mutation here changes a path, a directory or anything reachable by `sweep_dir`,
// `remove_dir_all` or `remove_file`.** In particular the `None` that `decks_clear`'s arm
// passes as `covers` is never touched: `clear_decks` hands that value straight to `sweep_dir`,
// which deletes recursively, and a cargo test binary's working directory is `src-tauri/`.
// Every mutation below swaps an enum variant, a called function, or a list entry.
const MUTATIONS = [
  {
    name: "R1 route: update_status answers `Managed` instead of `Web`",
    file: "src-tauri/src/web/route.rs",
    from: `crate::update::status_for(state, crate::update::InstallKind::Web, false, false),`,
    to: `crate::update::status_for(state, crate::update::InstallKind::Managed, false, false),`,
    filter: "update_status_answers_the_web_install_kind",
  },
  {
    name: "R2 route: update_history drops out of COMMANDS but keeps its arm",
    file: "src-tauri/src/web/route.rs",
    from: `    "update_status",
    "update_history",
];`,
    to: `    "update_status",
];`,
    filter: "every_advertised_command_is_actually_routed",
  },
  {
    name: "R3 update: status_for ignores the kind it was handed",
    file: "src-tauri/src/update.rs",
    from: `    let asset = cached.as_ref().and_then(|r| pick_asset(&r.assets, kind)).cloned();
    UpdateStatus {
        current_version: current_version().to_owned(),
        install_kind: kind,`,
    to: `    let asset = cached.as_ref().and_then(|r| pick_asset(&r.assets, kind)).cloned();
    UpdateStatus {
        current_version: current_version().to_owned(),
        install_kind: InstallKind::Portable,`,
    filter: "status_for_answers_off_the_database_without_an_updater",
  },
  {
    name: "R4 update: pick_asset offers a browser the portable zip",
    file: "src-tauri/src/update.rs",
    from: `        InstallKind::Managed | InstallKind::Web | InstallKind::Other => return None,`,
    to: `        InstallKind::Web => PORTABLE_SUFFIX,
        InstallKind::Managed | InstallKind::Other => return None,`,
    filter: "status_for_answers_off_the_database_without_an_updater",
  },
  {
    name: "R5 route: collection_clear's arm empties the wishlist instead",
    file: "src-tauri/src/web/route.rs",
    from: `            crate::collection_source::with_write_owned(state, crate::reset::clear_collection)
                .map_err(RouteError::Failed)?,`,
    to: `            crate::collection_source::with_write_owned(state, crate::reset::clear_wishlist)
                .map_err(RouteError::Failed)?,`,
    filter: "the_three_clears_empty_their_tables_through_the_route",
  },
  {
    name: "R6 route: cache_clear is advertised without an arm (the wasm-red guard)",
    file: "src-tauri/src/web/route.rs",
    from: `    "collection_clear",
    "wishlist_clear",`,
    to: `    "cache_clear",
    "collection_clear",
    "wishlist_clear",`,
    filter: "cache_clear_is_not_routed_while_the_image_cache_is_a_rewrite",
  },
];

for (const m of MUTATIONS) {
  const p = `${ROOT}/${m.file}`;
  const original = readFileSync(p, "utf8");
  if (!original.includes(m.from) || original.split(m.from).length > 2) {
    console.log(`SKIPPED  ${m.name} (anchor missing or not unique)`);
    continue;
  }
  writeFileSync(p, original.replace(m.from, m.to));
  let result = "";
  try {
    const out = execFileSync(
      "cargo",
      ["test", "--manifest-path", MANIFEST, "--lib", m.filter],
      { stdio: "pipe", encoding: "utf8", env: process.env },
    );
    const line = (out.split("\n").find((l) => l.startsWith("test result:")) || "").trim();
    // A filter that selected no tests exits 0 and proves nothing — report the count.
    result = `SURVIVED  (${line})`;
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    const line = (out.split("\n").find((l) => l.startsWith("test result:")) || "").trim();
    const compileFail = out.includes("error[E") || out.includes("could not compile");
    result = compileFail && !line ? "CAUGHT    (compile error)" : `CAUGHT    (${line})`;
  } finally {
    writeFileSync(p, original);
  }
  console.log(`${result}  ${m.name}`);
}
console.log("all files restored");
