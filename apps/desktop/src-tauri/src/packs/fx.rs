//! **The dollar's price in euros, for Open Packs alone** (issue #1463): the European Central
//! Bank's daily reference rate, which lets the page take the lowest of a dollar marketplace's
//! price and a euro marketplace's — TCGplayer's and Cardmarket's — once both are in one currency.
//!
//! **A fact, not a conclusion.** This module answers what the ECB published and when; which
//! prices are converted, into which currency, and which is lowest are the page's
//! (`packages/ui/features/draft/packs/currency.ts`). No other surface converts a price.
//!
//! **Optional by construction**, as the price feeds are: nothing is asked until a reader picks
//! marketplaces of two currencies on the Packs page. The file is [`ECB_DAILY`] — public, keyless
//! and a few kilobytes — kept as it came under the data folder at `fx/eurofxref-daily.xml`, and
//! asked again when it is older than [`FRESH_FOR_MS`]. The ECB publishes once each working day,
//! around 16:00 CET, so a copy a few hours old is the newest there is most of the day.
//!
//! **A stale rate is better than none**: when the ECB cannot be reached and a copy is on disk,
//! that copy is used, and the page names its date. With neither, the command refuses in one
//! sentence and the page prices at the marketplaces of one currency only.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::sync::AppState;

/// The ECB's euro foreign exchange reference rates, today's.
pub const ECB_DAILY: &str = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/// How long a cached rate is trusted: six hours.
pub const FRESH_FOR_MS: i64 = 6 * 60 * 60 * 1000;

/// The most bytes the file may be. It is about 1.6 KB; this bounds a host that answers
/// something else entirely.
const MAX_BYTES: usize = 64 * 1024;

pub const RATE_UNREACHABLE: &str = "The exchange rate could not be fetched.";
pub const RATE_UNREADABLE: &str = "The exchange rate could not be read.";

/// One euro in dollars, as the ECB published it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRate {
    /// Dollars to one euro — `1.0812` — the ECB's `USD` rate.
    pub usd_per_eur: f64,
    /// `YYYY-MM-DD`: the working day the ECB set the rate on.
    pub date: String,
    /// Milliseconds: when the file was fetched.
    pub fetched_at: i64,
}

/// The ECB's dollar rate, from the cache while it is fresh, else from the ECB (and cached), else
/// a stale copy.
#[tauri::command]
pub async fn packs_exchange_rate(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Result<ExchangeRate, String> {
    let path = cache_path(&state.data_dir);
    let now = grimoire_core::platform::clock::now_ms();
    let written = super::written_ms(&path);
    if fresh(written, now) {
        if let Some(rate) = read_cached(&path, written.unwrap_or(now)).await {
            return Ok(rate);
        }
    }
    let fetched = match download().await {
        Ok(xml) => parse_usd_rate(&xml, now).map(|rate| (rate, xml)),
        Err(e) => Err(e),
    };
    match fetched {
        Ok((rate, xml)) => {
            store(&path, xml.as_bytes()).await;
            Ok(rate)
        }
        Err(e) => match written {
            Some(at) => read_cached(&path, at).await.ok_or(e),
            None => Err(e),
        },
    }
}

/// Where the file is kept.
pub fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join("fx").join("eurofxref-daily.xml")
}

/// Whether a file written at `written_ms` is still good at `now_ms`. A file stamped in the
/// future (a clock moved back) is asked again.
pub fn fresh(written_ms: Option<i64>, now_ms: i64) -> bool {
    written_ms.is_some_and(|written| written <= now_ms && now_ms - written < FRESH_FOR_MS)
}

async fn read_cached(path: &Path, fetched_at: i64) -> Option<ExchangeRate> {
    let bytes = tokio::fs::read(path).await.ok()?;
    parse_usd_rate(std::str::from_utf8(&bytes).ok()?, fetched_at).ok()
}

/// Write the file beside its final name and move it into place, so a half-written download is
/// never read. A cache that cannot be written is no failure: the rate is in hand.
async fn store(path: &Path, bytes: &[u8]) {
    let Some(dir) = path.parent() else {
        return;
    };
    if tokio::fs::create_dir_all(dir).await.is_err() {
        return;
    }
    let part = path.with_extension("xml.part");
    if tokio::fs::write(&part, bytes).await.is_ok() && tokio::fs::rename(&part, path).await.is_err()
    {
        let _ = tokio::fs::remove_file(&part).await;
    }
}

/// The ECB's file, as text.
async fn download() -> Result<String, String> {
    let response = super::client()
        .get(ECB_DAILY)
        .send()
        .await
        .map_err(|_| RATE_UNREACHABLE.to_owned())?;
    if response.status() != 200 {
        return Err(RATE_UNREACHABLE.to_owned());
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(RATE_UNREADABLE.to_owned());
    }
    let mut body = response.into_body();
    let mut bytes = Vec::new();
    while let Some(chunk) = body.chunk().await {
        let chunk = chunk.map_err(|_| RATE_UNREACHABLE.to_owned())?;
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(RATE_UNREADABLE.to_owned());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| RATE_UNREADABLE.to_owned())
}

/// The dollar rate and its day out of the ECB's file, stamped `fetched_at`.
///
/// The file is a `Cube` of a `Cube time='…'` of one `Cube currency='…' rate='…'` per currency.
/// Read tag by tag rather than with an XML crate: two attributes of a fixed, flat file. A rate
/// that is not a plain positive number between 0.1 and 10 — the euro has never been outside
/// 0.8 to 1.6 dollars — or a day that is not `YYYY-MM-DD` is refused, so a page that is not
/// the ECB's never prices a card.
pub fn parse_usd_rate(xml: &str, fetched_at: i64) -> Result<ExchangeRate, String> {
    let mut date = None;
    let mut rate = None;
    for tag in xml.split('<').skip(1) {
        let tag = tag.split('>').next().unwrap_or_default();
        let Some(attrs) = tag.strip_prefix("Cube") else {
            continue;
        };
        if let Some(time) = attribute(attrs, "time") {
            date.get_or_insert(time);
        }
        if attribute(attrs, "currency") == Some("USD") {
            rate = attribute(attrs, "rate");
        }
    }
    let date = date
        .filter(|d| is_iso_date(d))
        .ok_or_else(|| RATE_UNREADABLE.to_owned())?;
    let usd_per_eur = rate
        .and_then(|r| r.parse::<f64>().ok())
        .filter(|r| r.is_finite() && (0.1..10.0).contains(r))
        .ok_or_else(|| RATE_UNREADABLE.to_owned())?;
    Ok(ExchangeRate {
        usd_per_eur,
        date: date.to_owned(),
        fetched_at,
    })
}

/// The value of `name='…'` or `name="…"` among a tag's attributes.
fn attribute<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = attrs;
    while let Some(at) = rest.find(name) {
        let before = rest[..at].chars().next_back();
        let after = rest[at + name.len()..].trim_start();
        rest = &rest[at + name.len()..];
        if !before.is_some_and(char::is_whitespace) {
            continue;
        }
        let Some(after) = after.strip_prefix('=') else {
            continue;
        };
        let after = after.trim_start();
        let quote = after.chars().next()?;
        if quote != '\'' && quote != '"' {
            return None;
        }
        let value = &after[1..];
        return value.find(quote).map(|end| &value[..end]);
    }
    None
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ECB's file as it is served, abridged.
    const DAILY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender>
		<gesmes:name>European Central Bank</gesmes:name>
	</gesmes:Sender>
	<Cube>
		<Cube time='2026-10-30'>
			<Cube currency='USD' rate='1.0812'/>
			<Cube currency='JPY' rate='165.21'/>
			<Cube currency='GBP' rate='0.8432'/>
		</Cube>
	</Cube>
</gesmes:Envelope>"#;

    const HOUR: i64 = 60 * 60 * 1000;

    #[test]
    fn the_dollar_rate_and_its_day_are_read_from_the_ecb_file() {
        let rate = parse_usd_rate(DAILY, 42).unwrap();
        assert_eq!(
            rate,
            ExchangeRate {
                usd_per_eur: 1.0812,
                date: "2026-10-30".to_owned(),
                fetched_at: 42,
            }
        );
    }

    #[test]
    fn double_quotes_and_spacing_read_the_same() {
        let xml =
            r#"<Cube><Cube  time = "2026-10-29"><Cube rate="1.07" currency="USD" /></Cube></Cube>"#;
        let rate = parse_usd_rate(xml, 0).unwrap();
        assert_eq!(rate.usd_per_eur, 1.07);
        assert_eq!(rate.date, "2026-10-29");
    }

    #[test]
    fn a_file_that_is_not_the_ecbs_is_refused() {
        for bad in [
            "",
            "<html><body>Maintenance</body></html>",
            // No dollar.
            "<Cube time='2026-10-30'><Cube currency='GBP' rate='0.84'/></Cube>",
            // No day.
            "<Cube><Cube currency='USD' rate='1.08'/></Cube>",
            // A day that is not one.
            "<Cube time='yesterday'><Cube currency='USD' rate='1.08'/></Cube>",
            // A rate that is not a number, or not a plausible one.
            "<Cube time='2026-10-30'><Cube currency='USD' rate='n/a'/></Cube>",
            "<Cube time='2026-10-30'><Cube currency='USD' rate='0'/></Cube>",
            "<Cube time='2026-10-30'><Cube currency='USD' rate='-1.08'/></Cube>",
            "<Cube time='2026-10-30'><Cube currency='USD' rate='1080'/></Cube>",
            "<Cube time='2026-10-30'><Cube currency='USD' rate='NaN'/></Cube>",
        ] {
            assert_eq!(
                parse_usd_rate(bad, 0).unwrap_err(),
                RATE_UNREADABLE,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn an_attribute_name_inside_another_is_not_it() {
        assert_eq!(attribute(" xtime='1' time='2'", "time"), Some("2"));
        assert_eq!(attribute(" currency='USD'", "rate"), None);
    }

    #[test]
    fn a_cached_rate_is_used_for_six_hours() {
        let now = 1000 * HOUR;
        assert!(fresh(Some(now), now));
        assert!(fresh(Some(now - 5 * HOUR), now));
        assert!(!fresh(Some(now - 6 * HOUR), now));
        assert!(!fresh(None, now));
        // A file stamped after now: the clock moved, so it is asked again.
        assert!(!fresh(Some(now + HOUR), now));
    }

    #[test]
    fn the_rate_is_kept_under_fx_in_the_data_folder() {
        let dir = Path::new("data");
        assert_eq!(cache_path(dir), dir.join("fx").join("eurofxref-daily.xml"));
    }
}
