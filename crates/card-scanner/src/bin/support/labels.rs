//! Every label a session needs, read once — shared by `eval` and `replay`, which each build a
//! fresh session per card and cannot afford `Reference::load_labels` every time.

use card_scanner::index::{parse_uuid, Bundle, ID_LEN};
use card_scanner::reference::{Label, Reference};
use std::path::Path;

/// One printing's label, as `Reference::add_label` takes it.
pub struct LabelRow {
    pub id: [u8; ID_LEN],
    pub oracle: Option<[u8; ID_LEN]>,
    pub illustration: Option<[u8; ID_LEN]>,
    pub label: Label,
}

/// Every label in the corpus, read once — the query `Reference::load_labels` runs.
///
/// **Not `load_labels` per session, because that is the evaluation's largest fixed cost**:
/// measured 2026-09-15 on the dev corpus (release, 117,738 rows), `load_labels` took 883 ms, of
/// which 526 ms was the query and 345 ms the `add_label` calls — and a fresh session per pass per
/// card runs it 480 times. [`labels_agree`] is what keeps this copy of the query honest.
pub fn rows_from_corpus(conn: &rusqlite::Connection) -> Result<Vec<LabelRow>, String> {
    let fail = |e: rusqlite::Error| format!("corpus labels: {e}");
    let mut stmt = conn
        .prepare(
            "SELECT id, illustration_id, name, set_code, collector_number, lang, released_at,
                    oracle_id
             FROM cards",
        )
        .map_err(fail)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                Label {
                    name: r.get(2)?,
                    set: r.get(3)?,
                    number: r.get(4)?,
                    lang: r.get(5)?,
                    released: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                },
                r.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(fail)?;
    Ok(rows
        .flatten()
        .filter_map(|(id, illustration, label, oracle)| {
            Some(LabelRow {
                id: parse_uuid(&id)?,
                oracle: oracle.as_deref().and_then(parse_uuid),
                illustration: illustration.as_deref().and_then(parse_uuid),
                label,
            })
        })
        .collect())
}

/// Does a reference built from `rows` answer as one built by `Reference::load_labels` does?
/// Checked once per run, so a change to that query fails the evaluation instead of quietly
/// evaluating against different labels.
pub fn labels_agree(bundle: &[u8], rows: &[LabelRow], conn: &rusqlite::Connection) -> Result<(), String> {
    let fresh = || Bundle::from_bytes(bundle).map(Reference::new).map_err(|e| format!("bundle: {e}"));
    let mut loaded = fresh()?;
    loaded.load_labels(conn).map_err(|e| format!("corpus labels: {e}"))?;
    let mut ours = fresh()?;
    attach(&mut ours, rows);
    let shape = |r: &Reference| (r.label_count(), r.name_count(), r.printing_count());
    if shape(&loaded) != shape(&ours) {
        return Err(format!(
            "this tool's label query no longer matches Reference::load_labels: \
             (labels, names, printings) {:?} against {:?}",
            shape(&ours),
            shape(&loaded)
        ));
    }
    Ok(())
}

pub fn attach(r: &mut Reference, rows: &[LabelRow]) {
    for row in rows {
        r.add_label(row.id, row.oracle, row.illustration, row.label.clone());
    }
}

pub fn open_corpus(path: &Path) -> Result<rusqlite::Connection, String> {
    if !path.exists() {
        return Err(format!("no corpus at {}", path.display()));
    }
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("cannot open corpus {}: {e}", path.display()))
}
