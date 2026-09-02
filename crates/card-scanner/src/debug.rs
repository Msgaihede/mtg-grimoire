//! The debug artifacts — the reason the CLI is worth having.
//!
//! Every stage of a scan writes a numbered image, and a run writes a sheet linking them. The
//! numbering is the pipeline order, so a directory listing reads as the sequence that
//! produced it and a failure is located by finding the last artifact that still looks right.
//!
//! **A failed scan writes its artifacts too.** A scan that found no card is exactly when
//! someone wants to see the edge image — "it didn't work", with nothing to look at, is the
//! state this module exists to prevent.
//!
//! Two sheets, because they are read in different places. [`write_contact_sheet`] references
//! the PNGs on disk and so only opens on the machine that produced them.
//! [`write_embedded_sheet`] inlines everything as data URIs: 51 MB of PNGs becomes under two
//! megabytes, which is the difference between a failure one person can see and one a
//! colleague can be shown.

use crate::detect::{DetectTrace, Detection};
use std::io;
use std::path::{Path, PathBuf};

/// Stage names, numbered so the filenames sort into pipeline order.
pub const STAGE_INPUT: &str = "00-input";
pub const STAGE_GRAY: &str = "01-gray";
pub const STAGE_BINARY: &str = "02-binary";
pub const STAGE_CONTOURS: &str = "03-contours";
pub const STAGE_QUAD: &str = "04-quad";
pub const STAGE_RECTIFIED: &str = "05-rectified";
pub const STAGE_RECTIFIED_180: &str = "06-rectified-180";

pub struct DebugWriter {
    dir: PathBuf,
}

impl DebugWriter {
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        Ok(DebugWriter { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn save<P, C>(&self, stem: &str, img: &image::ImageBuffer<P, C>) -> io::Result<PathBuf>
    where
        P: image::Pixel + image::PixelWithColorType,
        [P::Subpixel]: image::EncodableLayout,
        C: std::ops::Deref<Target = [P::Subpixel]>,
    {
        let path = self.dir.join(format!("{stem}.png"));
        img.save(&path).map_err(io::Error::other)?;
        Ok(path)
    }

    pub fn json(&self, stem: &str, value: &serde_json::Value) -> io::Result<PathBuf> {
        let path = self.dir.join(format!("{stem}.json"));
        std::fs::write(&path, serde_json::to_vec_pretty(value)?)?;
        Ok(path)
    }
}

/// Write every intermediate a detection produced.
///
/// `detection` is `None` when nothing was found, and the trace is still written — see the
/// module note.
pub fn write_detection(
    w: &DebugWriter,
    source: &image::DynamicImage,
    trace: Option<&DetectTrace>,
    detection: Option<&Detection>,
) -> io::Result<()> {
    // The input is downscaled rather than copied: a 3000×4000 phone photo is several
    // megabytes of PNG per scan, and eighteen of those is a debug folder nobody opens twice.
    // 900 px is enough to see what was photographed.
    let preview = source.resize(900, 900, image::imageops::FilterType::Triangle);
    w.save(STAGE_INPUT, &preview.to_rgb8())?;

    if let Some(t) = trace {
        w.save(STAGE_GRAY, &t.gray)?;
        w.save(STAGE_BINARY, &t.binary)?;
        w.save(STAGE_CONTOURS, &t.contours)?;
        w.save(STAGE_QUAD, &t.quads)?;
    }
    if let Some(d) = detection {
        w.save(STAGE_RECTIFIED, &d.rectified)?;
        w.save(STAGE_RECTIFIED_180, &d.rectified_180)?;
    }
    Ok(())
}

/// One row of a sheet.
pub struct SheetEntry {
    pub name: String,
    /// Directory holding this scan's artifacts, relative to the sheet.
    pub dir: String,
    pub found: bool,
    /// Human-readable summary, and the failure reason when `found` is false.
    pub detail: String,
    pub elapsed_ms: f64,
    /// Everything below is `None` on a scan that found nothing.
    ///
    /// Structured rather than pre-formatted into `detail`, because a sheet is read *down a
    /// column*: "which scans have an implausible aspect" is answered by running an eye over
    /// aligned figures, and one prose sentence per row makes that impossible.
    pub method: Option<String>,
    pub via: Option<String>,
    pub aspect: Option<f32>,
    pub area: Option<f32>,
    pub angle: Option<f32>,
    pub score: Option<f32>,
}

impl SheetEntry {
    /// Is this detection's aspect close enough to a card's to be believed?
    ///
    /// **Not a gate.** `detect::score_quad` already applied the gate and everything here
    /// passed it. This is the *reviewer's* threshold, which is deliberately stricter: a quad
    /// at 0.64 clears an 0.18 tolerance and is still far more likely to be some sub-region of
    /// the card — its text box, its art window — than the card itself. Measured on the sample
    /// scans, every detection below this line was wrong and every one above it was right, so
    /// the sheet says so rather than leaving it to be noticed.
    pub fn aspect_is_convincing(&self) -> bool {
        self.aspect
            .is_none_or(|a| (a - crate::CARD_ASPECT).abs() / crate::CARD_ASPECT < 0.08)
    }

    fn state(&self) -> &'static str {
        if !self.found {
            "miss"
        } else if self.aspect_is_convincing() {
            "hit"
        } else {
            "doubt"
        }
    }
}

/// Write an `index.html` that shows every scan's stages side by side, referencing the PNGs.
///
/// A hundred scans is more than anyone reviews one directory at a time, and the failure modes
/// here are visual — a quad clipped to the art box rather than the card, a rectification that
/// came out upside-down. Both are obvious in a grid and invisible in a log.
pub fn write_contact_sheet(root: &Path, entries: &[SheetEntry]) -> io::Result<PathBuf> {
    let mut rows = String::new();
    for e in entries {
        rows.push_str(&format!(
            r#"<section class="{state}">
  <h2>{name} <span class="badge">{state}</span></h2>
  <p>{detail}</p>
  <div class="strip">
    <figure><img src="{dir}/04-quad.png" loading="lazy"><figcaption>quad</figcaption></figure>
    <figure><img src="{dir}/02-binary.png" loading="lazy"><figcaption>binary</figcaption></figure>
    <figure><img src="{dir}/05-rectified.png" loading="lazy"><figcaption>rectified</figcaption></figure>
    <figure><img src="{dir}/06-rectified-180.png" loading="lazy"><figcaption>180&deg;</figcaption></figure>
  </div>
</section>
"#,
            state = e.state(),
            name = html_escape(&e.name),
            detail = html_escape(&e.detail),
            dir = e.dir,
        ));
    }

    let found = entries.iter().filter(|e| e.found).count();
    let html = format!(
        r#"<!doctype html>
<meta charset="utf-8">
<title>card-scanner debug</title>
<style>
  :root {{ color-scheme: dark light; }}
  body {{ font: 14px system-ui, sans-serif; margin: 0; padding: 24px; background: #14161a; color: #e6e8ec; }}
  h1 {{ font-size: 20px; margin: 0 0 4px; }}
  .summary {{ color: #9aa3af; margin-bottom: 24px; }}
  section {{ border: 1px solid #2a2f38; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; }}
  section.miss {{ border-color: #7f2a2a; background: #1d1416; }}
  section.doubt {{ border-color: #7a5c1e; background: #1d1a12; }}
  h2 {{ font-size: 14px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }}
  p {{ margin: 0 0 10px; color: #9aa3af; font-size: 12px; font-family: ui-monospace, monospace; }}
  .badge {{ font-size: 11px; padding: 1px 6px; border-radius: 999px; background: #1f6f3f; }}
  .miss .badge {{ background: #7f2a2a; }}
  .doubt .badge {{ background: #7a5c1e; }}
  .strip {{ display: flex; gap: 12px; flex-wrap: wrap; }}
  figure {{ margin: 0; }}
  img {{ max-height: 260px; border-radius: 6px; background: #000; display: block; }}
  figcaption {{ font-size: 11px; color: #6b7280; margin-top: 4px; }}
</style>
<h1>card-scanner debug</h1>
<p class="summary">{found} of {total} scans found a card.</p>
{rows}
"#,
        found = found,
        total = entries.len(),
        rows = rows
    );

    let path = root.join("index.html");
    std::fs::write(&path, html)?;
    Ok(path)
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Base64, standard alphabet with padding.
///
/// Twenty lines against a dependency that would exist only for a dev tool's HTML — and this
/// crate's dependency list is one the app inherits when integration lands.
fn base64(data: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { A[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { A[n as usize & 63] as char } else { '=' });
    }
    out
}

/// One PNG artifact, re-read and shrunk into a JPEG data URI.
fn data_uri(path: &Path, max_edge: u32) -> Option<String> {
    let img = image::open(path).ok()?;
    let small = img.resize(max_edge, max_edge, image::imageops::FilterType::Triangle);
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 72)
        .encode_image(&small.to_rgb8())
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64(&buf)))
}

/// A single self-contained HTML fragment with every artifact inlined.
///
/// Emits no `<!doctype>`, `<html>`, `<head>` or `<body>`: a fragment embeds anywhere,
/// including in a published page.
pub fn write_embedded_sheet(
    root: &Path,
    entries: &[SheetEntry],
    eyebrow: &str,
) -> io::Result<PathBuf> {
    let total = entries.len();
    let found = entries.iter().filter(|e| e.found).count();
    let convincing = entries.iter().filter(|e| e.state() == "hit").count();
    let mean_ms = if total == 0 {
        0.0
    } else {
        entries.iter().map(|e| e.elapsed_ms).sum::<f64>() / total as f64
    };
    let canny = entries.iter().filter(|e| e.method.as_deref() == Some("canny")).count();
    let otsu = entries.iter().filter(|e| e.method.as_deref() == Some("otsu")).count();

    let mut rows = String::new();
    for e in entries {
        let dir = root.join(&e.dir);
        let mut figs = String::new();
        // Pipeline order, stage number kept. The strip is read left to right as the sequence
        // that produced the result, so the first frame that looks wrong locates the fault
        // without opening anything.
        for (file, num, caption, edge) in [
            ("00-input.png", "00", "input", 300u32),
            ("02-binary.png", "02", "edges / mask", 300),
            ("03-contours.png", "03", "contours", 300),
            ("04-quad.png", "04", "chosen quad", 300),
            ("05-rectified.png", "05", "rectified", 260),
            ("06-rectified-180.png", "06", "180 rotation", 260),
        ] {
            let path = dir.join(file);
            if !path.exists() {
                continue;
            }
            if let Some(uri) = data_uri(&path, edge) {
                figs.push_str(&format!(
                    r#"<figure><img src="{uri}" alt="{caption}" loading="lazy"><figcaption><b>{num}</b> {caption}</figcaption></figure>"#
                ));
            }
        }

        let state = e.state();
        let label = match state {
            "hit" => "located",
            "doubt" => "suspect",
            _ => "no card",
        };

        let body = if e.found {
            let chip = |k: &str, v: String, warn: bool| {
                format!(
                    r#"<div class="chip{}"><dt>{k}</dt><dd>{v}</dd></div>"#,
                    if warn { " chip--warn" } else { "" }
                )
            };
            format!(
                r#"<dl class="chips">{}{}{}{}{}</dl>"#,
                chip(
                    "aspect",
                    format!("{:.3}", e.aspect.unwrap_or_default()),
                    !e.aspect_is_convincing()
                ),
                chip("frame area", format!("{:.1}%", e.area.unwrap_or_default() * 100.0), false),
                chip("corner err", format!("{:.1}\u{b0}", e.angle.unwrap_or_default()), false),
                chip("detector", e.method.clone().unwrap_or_default(), false),
                chip("geometry", e.via.clone().unwrap_or_default(), false),
            )
        } else {
            format!(r#"<p class="why">{}</p>"#, html_escape(&e.detail))
        };

        rows.push_str(&format!(
            r#"<article class="scan scan--{state}">
  <header><h2>{name}</h2><span class="tag tag--{state}">{label}</span><span class="ms">{ms:.0} ms</span></header>
  {body}
  <div class="strip">{figs}</div>
</article>
"#,
            name = html_escape(&e.name),
            ms = e.elapsed_ms,
        ));
    }

    let html = format!(
        r#"<title>Tier Zero Readout</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  /* Light is the base set. The two blocks after it redefine only tokens, so no colour is
     ever defined solely behind a media query — which is the classic unreadable-artifact bug.
     Neutrals carry a slight cyan bias so they sit with the accent rather than beside it. */
  :root {{
    --ground:#eef1f4; --panel:#ffffff; --sunk:#e4e9ee; --line:#d3dae1;
    --ink:#101519; --ink-2:#5a6672; --ink-3:#8794a1;
    --accent:#0f7d99;
    --hit:#1f7a4d; --hit-bg:#dcefe4;
    --doubt:#8a6410; --doubt-bg:#f7ead0;
    --miss:#a5342f; --miss-bg:#f6dcdb;
    --shadow:0 1px 2px rgba(16,21,25,.06), 0 8px 24px rgba(16,21,25,.05);
  }}
  @media (prefers-color-scheme: dark) {{
    :root:not([data-theme="light"]) {{
      --ground:#0d1014; --panel:#151a20; --sunk:#1c232b; --line:#28313b;
      --ink:#e8edf2; --ink-2:#9aa7b4; --ink-3:#6b7986;
      --accent:#54c3e0;
      --hit:#5ed69a; --hit-bg:#14301f;
      --doubt:#e8b45c; --doubt-bg:#332612;
      --miss:#f08b85; --miss-bg:#37191a;
      --shadow:0 1px 2px rgba(0,0,0,.5), 0 10px 28px rgba(0,0,0,.35);
    }}
  }}
  :root[data-theme="dark"] {{
    --ground:#0d1014; --panel:#151a20; --sunk:#1c232b; --line:#28313b;
    --ink:#e8edf2; --ink-2:#9aa7b4; --ink-3:#6b7986;
    --accent:#54c3e0;
    --hit:#5ed69a; --hit-bg:#14301f;
    --doubt:#e8b45c; --doubt-bg:#332612;
    --miss:#f08b85; --miss-bg:#37191a;
    --shadow:0 1px 2px rgba(0,0,0,.5), 0 10px 28px rgba(0,0,0,.35);
  }}

  body {{
    margin:0; padding:32px 28px 64px; background:var(--ground); color:var(--ink);
    font-family:"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    font-size:14px; line-height:1.55;
  }}
  .wrap {{ max-width:1180px; margin:0 auto; display:flex; flex-direction:column; gap:22px; }}

  .masthead {{ display:flex; flex-direction:column; gap:6px; }}
  .eyebrow {{
    font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:11px; font-weight:500;
    letter-spacing:.14em; text-transform:uppercase; color:var(--accent);
  }}
  h1 {{ font-size:27px; font-weight:600; margin:0; letter-spacing:-.02em; text-wrap:balance; }}
  .lede {{ margin:0; color:var(--ink-2); max-width:64ch; }}

  /* Summary before detail: the four numbers that decide whether the detail is worth reading. */
  .tiles {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:12px; }}
  .tile {{
    background:var(--panel); border:1px solid var(--line); border-radius:10px;
    padding:13px 15px; box-shadow:var(--shadow); display:flex; flex-direction:column; gap:3px;
  }}
  .tile dt {{
    font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:10.5px; font-weight:500;
    letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3);
  }}
  .tile dd {{
    margin:0; font-size:25px; font-weight:600; letter-spacing:-.02em;
    font-variant-numeric:tabular-nums;
  }}
  .tile small {{ color:var(--ink-3); font-size:11.5px; font-weight:400; }}

  .scan {{
    background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--line);
    border-radius:12px; box-shadow:var(--shadow); overflow:hidden;
  }}
  /* State is carried by the rail as well as the tag, so a miss is findable by shape when
     scrolling fast rather than only by reading each label. */
  .scan--hit {{ border-left-color:var(--hit); }}
  .scan--doubt {{ border-left-color:var(--doubt); }}
  .scan--miss {{ border-left-color:var(--miss); }}

  .scan header {{ display:flex; align-items:center; gap:10px; padding:12px 16px 0; }}
  .scan h2 {{
    font-family:"IBM Plex Mono", ui-monospace, monospace;
    font-size:13px; font-weight:500; margin:0;
  }}
  .tag {{
    font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:10px; font-weight:600;
    letter-spacing:.08em; text-transform:uppercase; padding:2px 8px; border-radius:999px;
  }}
  .tag--hit {{ background:var(--hit-bg); color:var(--hit); }}
  .tag--doubt {{ background:var(--doubt-bg); color:var(--doubt); }}
  .tag--miss {{ background:var(--miss-bg); color:var(--miss); }}
  .ms {{
    margin-left:auto; font-family:"IBM Plex Mono", ui-monospace, monospace;
    font-size:11.5px; color:var(--ink-3); font-variant-numeric:tabular-nums;
  }}

  .chips {{ display:flex; flex-wrap:wrap; gap:7px; margin:11px 16px 13px; }}
  .chip {{
    background:var(--sunk); border-radius:7px; padding:5px 10px;
    display:flex; align-items:baseline; gap:7px;
  }}
  .chip dt {{
    font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:10px; font-weight:500;
    letter-spacing:.07em; text-transform:uppercase; color:var(--ink-3);
  }}
  .chip dd {{
    margin:0; font-family:"IBM Plex Mono", ui-monospace, monospace;
    font-size:12.5px; font-weight:500; font-variant-numeric:tabular-nums;
  }}
  .chip--warn dd {{ color:var(--doubt); }}
  .why {{
    margin:11px 16px 13px; font-family:"IBM Plex Mono", ui-monospace, monospace;
    font-size:12px; color:var(--miss);
  }}

  /* The filmstrip scrolls inside its own container; the page body never does. */
  .strip {{ display:flex; gap:12px; overflow-x:auto; padding:0 16px 16px; scrollbar-width:thin; }}
  figure {{ margin:0; flex:0 0 auto; }}
  .strip img {{
    height:214px; width:auto; display:block; border-radius:7px;
    background:#000; border:1px solid var(--line);
  }}
  figcaption {{
    font-family:"IBM Plex Mono", ui-monospace, monospace;
    font-size:10.5px; color:var(--ink-3); margin-top:6px; letter-spacing:.03em;
  }}
  figcaption b {{ color:var(--accent); font-weight:600; }}

  @media (max-width:640px) {{ body {{ padding:22px 14px 44px; }} h1 {{ font-size:22px; }} }}
</style>
<div class="wrap">
  <div class="masthead">
    <span class="eyebrow">{eyebrow}</span>
    <h1>Detection and rectification across {total} photographs</h1>
    <p class="lede">Every frame through tier zero: edges, contours, the chosen quadrilateral,
    and the homography that flattens it. Read a row left to right &mdash; the first frame that
    looks wrong is where the fault is.</p>
  </div>

  <dl class="tiles">
    <div class="tile"><dt>Card located</dt><dd>{found}<small> / {total}</small></dd></div>
    <div class="tile"><dt>Aspect convincing</dt><dd>{convincing}<small> / {total}</small></dd></div>
    <div class="tile"><dt>Mean time</dt><dd>{mean_ms:.0}<small> ms</small></dd></div>
    <div class="tile"><dt>Detector chosen</dt><dd>{canny}<small> canny &middot; {otsu} otsu</small></dd></div>
  </dl>

  {rows}
</div>
"#,
        eyebrow = html_escape(eyebrow),
    );

    let path = root.join("sheet-embedded.html");
    std::fs::write(&path, html)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::{detect, DetectOptions};

    fn tmp(name: &str) -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("card-scanner-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn entry(name: &str, found: bool, aspect: Option<f32>) -> SheetEntry {
        SheetEntry {
            name: name.into(),
            dir: "d".into(),
            found,
            detail: "detail".into(),
            elapsed_ms: 100.0,
            method: Some("canny".into()),
            via: Some("dp".into()),
            aspect,
            area: Some(0.15),
            angle: Some(3.0),
            score: Some(0.8),
        }
    }

    #[test]
    fn writes_every_stage_for_a_successful_detection() {
        let dir = tmp("ok");
        let w = DebugWriter::new(&dir).expect("mkdir");
        // Card-like bands, because the detector now rejects a rectification without them.
        let mut img = image::RgbImage::from_pixel(600, 800, image::Rgb([15, 15, 20]));
        let (y0, y1) = (200u32, 640u32);
        for y in y0..y1 {
            let ty = (y - y0) as f32 / (y1 - y0) as f32;
            let v: u8 = match ty {
                t if t < 0.10 => 235,
                t if t < 0.55 => 105,
                t if t < 0.62 => 235,
                t if t < 0.92 => 195,
                _ => 120,
            };
            for x in 180..495 {
                img.put_pixel(x, y, image::Rgb([v, v, v]));
            }
        }
        let src = image::DynamicImage::ImageRgb8(img);
        let (r, trace) = detect(&src, &DetectOptions::default());
        let d = r.expect("a card");
        write_detection(&w, &src, trace.as_ref(), Some(&d)).expect("write");

        for stage in [
            STAGE_INPUT,
            STAGE_GRAY,
            STAGE_BINARY,
            STAGE_CONTOURS,
            STAGE_QUAD,
            STAGE_RECTIFIED,
            STAGE_RECTIFIED_180,
        ] {
            assert!(dir.join(format!("{stage}.png")).exists(), "{stage} was not written");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_the_trace_even_when_no_card_was_found() {
        // The property the module note promises: a failed scan is still inspectable.
        let dir = tmp("fail");
        let w = DebugWriter::new(&dir).expect("mkdir");
        let src = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            300,
            300,
            image::Rgb([128, 128, 128]),
        ));
        let (r, trace) = detect(&src, &DetectOptions::default());
        assert!(r.is_err(), "the fixture was supposed to find nothing");
        write_detection(&w, &src, trace.as_ref(), None).expect("write");

        assert!(dir.join("02-binary.png").exists(), "a failed scan wrote no binary image");
        assert!(!dir.join("05-rectified.png").exists(), "there was nothing to rectify");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_detection_can_be_located_but_not_convincing() {
        // The three-state distinction the sheet turns on. 0.64 clears the detector's 0.18
        // tolerance and is still not a card shape.
        assert_eq!(entry("a", true, Some(0.716)).state(), "hit");
        assert_eq!(entry("a", true, Some(0.641)).state(), "doubt");
        assert_eq!(entry("a", false, None).state(), "miss");
    }

    #[test]
    fn contact_sheet_escapes_and_counts() {
        let dir = tmp("sheet");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let entries = vec![entry("a<b>.jpg", true, Some(0.71)), entry("c.jpg", false, None)];
        let p = write_contact_sheet(&dir, &entries).expect("write");
        let html = std::fs::read_to_string(p).expect("read");
        assert!(html.contains("1 of 2 scans found a card"));
        assert!(html.contains("a&lt;b&gt;.jpg"), "the name was not escaped");
        assert!(!html.contains("<b>.jpg"), "raw markup leaked into the sheet");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn embedded_sheet_is_self_contained() {
        let dir = tmp("embed");
        std::fs::create_dir_all(dir.join("d")).expect("mkdir");
        // One real artifact, so the data-URI path is genuinely exercised.
        image::RgbImage::from_pixel(60, 80, image::Rgb([200, 30, 30]))
            .save(dir.join("d").join("04-quad.png"))
            .expect("png");

        let entries = vec![entry("x.jpg", true, Some(0.716)), entry("y.jpg", false, None)];
        let p = write_embedded_sheet(&dir, &entries, "test run").expect("write");
        let html = std::fs::read_to_string(&p).expect("read");

        assert!(html.contains("data:image/jpeg;base64,"), "no artifact was inlined");
        assert!(!html.contains(r#"src="d/"#), "the sheet still references a file on disk");
        // A fragment, not a document — it has to embed inside a published page.
        assert!(!html.contains("<!doctype"), "the fragment carries a doctype");
        assert!(!html.contains("<body"), "the fragment carries a body tag");
        assert!(html.contains("1 / 2") || html.contains(">1<"), "the summary did not render");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_matches_known_vectors() {
        // Padding is the part that goes wrong, so all three residues are covered.
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(b""), "");
    }
}
