//! **The Draft & Packs page's booster data**: one set's MTGJSON file, fetched, cached and handed
//! to the core (`grimoire_core::boosters`), which parses it and joins it to the corpus
//! (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §2). This host's alone —
//! `command_table`'s `DESKTOP_ONLY` says why.
//!
//! **Optional by construction**: nothing is asked until a reader picks a set on the Packs page
//! or for a draft's booster. The file is `https://mtgjson.com/api/v5/{CODE}.json.gz` (the code
//! upper-cased, MTGJSON's spelling and its file names), kept as it came under the data folder at
//! `boosters/{CODE}.json.gz`, and asked again when it is older than [`FRESH_FOR_MS`] or the reader
//! presses Refresh. A set whose sheets name another set's cards (HOB's box topper is HOC's) needs
//! those files too ([`grimoire_core::boosters::source_set_codes`]); one of them that cannot be had
//! is left out, and only the cards it alone maps are dropped.
//!
//! **A stale file is better than none**: when MTGJSON cannot be reached and a copy is on disk,
//! that copy is used — unless the reader asked for a refresh, who is then told it failed.
//!
//! The parse is a few megabytes of JSON and runs on the blocking pool, never on the async
//! runtime. Every refusal is one plain sentence.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use grimoire_core::boosters::{booster_set, source_set_codes, BoosterSet, NO_BOOSTERS};
use grimoire_core::platform::http;

use crate::sync::AppState;

/// MTGJSON's per-set files. No trailing slash.
const MTGJSON: &str = "https://mtgjson.com/api/v5";

/// How long a cached set file is trusted: a week.
pub const FRESH_FOR_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// The most bytes a gzipped set file may be. The largest sets are a few megabytes; this bounds a
/// host that answers something else entirely.
const MAX_GZ_BYTES: usize = 64 * 1024 * 1024;

/// The most bytes a set file may unpack to.
const MAX_JSON_BYTES: u64 = 512 * 1024 * 1024;

pub const UNREACHABLE: &str = "MTGJSON could not be reached.";
pub const NOT_A_SET: &str = "That is not a set code.";
pub const UNREADABLE: &str = "MTGJSON's set file could not be read.";

/// The client MTGJSON is asked with: the app's `User-Agent`, a connect bound and a read bound.
fn client() -> &'static http::Client {
    static CLIENT: OnceLock<http::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        http::Client::new(&http::Config {
            user_agent: grimoire_core::scryfall::USER_AGENT,
            connect_timeout: Some(Duration::from_secs(15)),
            read_timeout: Some(Duration::from_secs(60)),
        })
    })
}

/// One set's boosters and the sealed products that hold them, joined to this corpus. Fetched
/// from MTGJSON the first time and cached for a week; `refresh` asks again now.
#[tauri::command]
pub async fn packs_booster_set(
    state: tauri::State<'_, Arc<AppState>>,
    set_code: String,
    refresh: bool,
) -> Result<BoosterSet, String> {
    let code = file_code(&set_code)?;
    let dir = state.data_dir.join("boosters");
    let (main_gz, fetched_at) = set_file(&dir, &code, refresh).await?;

    let (main_json, sources) = tauri::async_runtime::spawn_blocking(move || {
        let json = gunzip(&main_gz)?;
        let sources = source_set_codes(&json)?;
        Ok::<_, String>((json, sources))
    })
    .await
    .map_err(|_| UNREADABLE.to_owned())??;

    let mut source_gz = Vec::new();
    for source in sources {
        // A source file that cannot be had is left out: its cards drop from their sheets.
        let Ok(source) = file_code(&source) else {
            continue;
        };
        if let Ok((gz, _)) = set_file(&dir, &source, refresh).await {
            source_gz.push(gz);
        }
    }

    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source_json: Vec<String> = source_gz.iter().filter_map(|gz| gunzip(gz).ok()).collect();
        let refs: Vec<&str> = source_json.iter().map(String::as_str).collect();
        let conn = crate::sync::lock_db_read(&app);
        booster_set(&conn, &main_json, &refs, fetched_at)
    })
    .await
    .map_err(|_| UNREADABLE.to_owned())?
}

/// A set code as MTGJSON names its file: 2 to 6 letters and digits, upper-cased. Anything else
/// is refused before a URL is built from it.
pub fn file_code(code: &str) -> Result<String, String> {
    let code = code.trim();
    let shaped = (2..=6).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric());
    if shaped {
        Ok(code.to_ascii_uppercase())
    } else {
        Err(NOT_A_SET.to_owned())
    }
}

/// Whether a cached file written at `written_ms` is still good at `now_ms`. A refresh is never
/// served from the cache; a file stamped in the future (a clock moved back) is asked again.
pub fn is_fresh(written_ms: Option<i64>, now_ms: i64, refresh: bool) -> bool {
    match written_ms {
        Some(written) if !refresh => written <= now_ms && now_ms - written < FRESH_FOR_MS,
        _ => false,
    }
}

fn cache_path(dir: &Path, code: &str) -> PathBuf {
    dir.join(format!("{code}.json.gz"))
}

/// When a file was last written, in milliseconds since the epoch.
fn written_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// The gzipped file for `code` and when it was fetched: from the cache while it is fresh, else
/// from MTGJSON (and cached), else — no refresh asked — a stale copy.
async fn set_file(dir: &Path, code: &str, refresh: bool) -> Result<(Vec<u8>, i64), String> {
    let path = cache_path(dir, code);
    let now = grimoire_core::platform::clock::now_ms();
    let written = written_ms(&path);
    if is_fresh(written, now, refresh) {
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if is_gzip(&bytes) {
                return Ok((bytes, written.unwrap_or(now)));
            }
        }
    }
    match download(code).await {
        Ok(bytes) => {
            store(dir, &path, &bytes).await;
            Ok((bytes, now))
        }
        Err(e) => {
            if !refresh {
                if let (Ok(bytes), Some(at)) = (tokio::fs::read(&path).await, written) {
                    if is_gzip(&bytes) {
                        return Ok((bytes, at));
                    }
                }
            }
            Err(e)
        }
    }
}

/// Write the file beside its final name and move it into place, so a half-written download is
/// never read as a set. A cache that cannot be written is no failure: the bytes are in hand.
async fn store(dir: &Path, path: &Path, bytes: &[u8]) {
    if tokio::fs::create_dir_all(dir).await.is_err() {
        return;
    }
    let part = path.with_extension("gz.part");
    if tokio::fs::write(&part, bytes).await.is_ok() && tokio::fs::rename(&part, path).await.is_err()
    {
        let _ = tokio::fs::remove_file(&part).await;
    }
}

/// MTGJSON's file for `code`, as it came. A 404 is a set MTGJSON has no file for, so no boosters.
async fn download(code: &str) -> Result<Vec<u8>, String> {
    let url = format!("{MTGJSON}/{code}.json.gz");
    let response = client()
        .get(&url)
        .send()
        .await
        .map_err(|_| UNREACHABLE.to_owned())?;
    match response.status() {
        200 => {}
        404 => return Err(NO_BOOSTERS.to_owned()),
        _ => return Err(UNREACHABLE.to_owned()),
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_GZ_BYTES as u64)
    {
        return Err(UNREADABLE.to_owned());
    }
    let mut body = response.into_body();
    let mut bytes = Vec::new();
    while let Some(chunk) = body.chunk().await {
        let chunk = chunk.map_err(|_| UNREACHABLE.to_owned())?;
        if bytes.len() + chunk.len() > MAX_GZ_BYTES {
            return Err(UNREADABLE.to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    if !is_gzip(&bytes) {
        return Err(UNREADABLE.to_owned());
    }
    Ok(bytes)
}

/// Whether `bytes` start as a gzip stream does.
pub fn is_gzip(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x1f, 0x8b])
}

/// A gzipped set file as text, bounded by [`MAX_JSON_BYTES`].
pub fn gunzip(bytes: &[u8]) -> Result<String, String> {
    if !is_gzip(bytes) {
        return Err(UNREADABLE.to_owned());
    }
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes)
        .take(MAX_JSON_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|_| UNREADABLE.to_owned())?;
    if text.len() as u64 > MAX_JSON_BYTES {
        return Err(UNREADABLE.to_owned());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn a_set_code_is_two_to_six_letters_and_digits_upper_cased() {
        assert_eq!(file_code("hob").unwrap(), "HOB");
        assert_eq!(file_code(" fdn ").unwrap(), "FDN");
        assert_eq!(file_code("40k").unwrap(), "40K");
        assert_eq!(file_code("PLST20").unwrap(), "PLST20");
        for bad in [
            "", "a", "abcdefg", "../x", "a b", "ab/c", "hób", "ab.c", "ab?c",
        ] {
            assert_eq!(file_code(bad).unwrap_err(), NOT_A_SET, "{bad:?}");
        }
    }

    #[test]
    fn a_cached_file_is_used_for_a_week_unless_a_refresh_is_asked() {
        let now = 100 * DAY;
        assert!(is_fresh(Some(now), now, false));
        assert!(is_fresh(Some(now - 6 * DAY), now, false));
        assert!(!is_fresh(Some(now - 7 * DAY), now, false));
        assert!(!is_fresh(Some(now - 30 * DAY), now, false));
        assert!(!is_fresh(Some(now), now, true));
        assert!(!is_fresh(None, now, false));
        // A file stamped after now: the clock moved, so it is asked again.
        assert!(!is_fresh(Some(now + DAY), now, false));
    }

    #[test]
    fn a_set_file_is_unpacked_and_anything_that_is_not_gzip_is_refused() {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(br#"{"data":{}}"#).unwrap();
        let bytes = gz.finish().unwrap();
        assert!(is_gzip(&bytes));
        assert_eq!(gunzip(&bytes).unwrap(), r#"{"data":{}}"#);
        assert_eq!(gunzip(b"<html>").unwrap_err(), UNREADABLE);
        assert_eq!(gunzip(&bytes[..4]).unwrap_err(), UNREADABLE);
    }

    #[test]
    fn the_cache_is_one_file_per_set_under_boosters() {
        let dir = Path::new("data").join("boosters");
        assert_eq!(cache_path(&dir, "HOB"), dir.join("HOB.json.gz"));
    }

    #[test]
    fn a_file_written_now_reads_as_written_now() {
        let path = crate::scratch::path("written.json.gz");
        std::fs::write(&path, [0x1f, 0x8b]).unwrap();
        let now = grimoire_core::platform::clock::now_ms();
        let written = written_ms(&path).unwrap();
        assert!((now - written).abs() < 60_000, "{now} {written}");
        assert!(is_fresh(Some(written), now.max(written), false));
    }
}
