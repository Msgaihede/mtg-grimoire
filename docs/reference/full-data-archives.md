# Full data archives

Settings → Backup offers a complete ZIP export and import beside the existing automatic
plain-text mirror (issue #784). The mirror remains a readable projection; the ZIP is the
restorable record.

The shared engine's `archive` module snapshots all user-schema tables except sync protocol
state. This includes collection and wishlist folders and entries, decks and their settings,
notes, labels, history, and `app_meta` preferences such as dashboard layout and customization.
The downloadable card catalog and image cache are not archived. Pairing credentials and sync
operation logs are not portable user data: restoring disconnects the local sync group, while
retaining this installation's device identity. Review restored data before pairing again.
The text mirror's absolute folder path and installation identifier also stay local, so a
restored backup cannot inherit another installation's authority to prune text files.

The desktop host writes `manifest.json` and one `<table>.jsonl` file per table. The manifest
records the format version, application version, user schema version, column names and row
counts. Each JSON line is an ordered row array; binary cells use a tagged base64 value.
ZIP entries are read directly, never extracted into filesystem paths. Unexpected or duplicate
entries, oversized content, invalid rows, and incompatible schemas are rejected.
Exports and imports share a 512 MiB compressed/expanded limit and a 1 MiB manifest limit;
an oversized export fails before replacing an existing backup.

Restore requires the same user schema version as the running app. A backup from before an
update that changes the schema must be restored using the matching older app first. This
explicit refusal avoids guessing how newer or older columns should map.

Rust owns the save/open dialogs and the destructive confirmation. No path comes from the
webview. After confirmation, a recovery ZIP is saved in `data/backups/`, then user data is
replaced in one transaction. Validation or insertion failure rolls back the replacement.
Every desktop window reloads after success to discard editors and preferences attached to
the previous records.

Installing an update through the app also writes a full ZIP to `data/backups/` before
replacing the portable executable or starting the installer. If writing the backup fails,
the update does not proceed. These automatic ZIPs are retained for the reader to manage;
an update installed outside the app does not pass through this hook.
