//! Card pictures kept on this computer — the opt-in answer to Scryfall refusing Tabletop
//! Simulator's downloader.
//!
//! **Why this exists.** Scryfall's image hosts refuse a request whose `User-Agent` is an HTTP
//! library's default: measured 2026-10-14, a Unity-style agent
//! (`UnityPlayer/… (UnityWebRequest/1.0, libcurl/…)`) gets `400` with
//! `"rule": "generic_user_agent"` from `cards.scryfall.io` and `api.scryfall.com`, while an
//! application's own agent gets the JPEG. Which agent TTS sends was not measured, so links stay the
//! default (the owner's call, 2026-10-14: they are the only pictures every player at a table can
//! load) and this is the switch for a reader whose cards come up blank.
//!
//! When it is on, every picture a save names is fetched **by this app** — through
//! [`grimoire_core::scryfall::Client::fetch_image`], so with the app's own agent, its size cap and
//! its timeout — into `MTG Grimoire/Images/`, and the save points at the `file:///` copy. The
//! files are listed in the pass's manifest like the saves, so a picture no save names any more is
//! pruned, and switching back to links prunes them all.
//!
//! **A file's name is a digest of the URL it came from**, and the URL carries Scryfall's
//! `?<epoch>` cache-buster: a re-scanned card is a new URL, so a new file, and the old one is
//! pruned. A file already on disk is never fetched again.

use crate::mirror::run::PassReport;
use crate::tabletop::save::Stack;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The folder, inside `MTG Grimoire`, the pictures go in.
pub const IMAGES_DIR: &str = "Images";

/// The gap between two downloads: ten a second, the pace Scryfall asks of image fetches and the
/// one `images::Cache` keeps.
const PACE: Duration = Duration::from_millis(100);

/// Where a picture's bytes come from — the app's Scryfall client in the app, a closure in a test.
pub trait Fetch {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String>;
}

/// The app's own client: its `User-Agent`, its 4 MB cap, its ten-second bound.
pub struct ClientFetch<'a>(pub &'a grimoire_core::scryfall::Client);

impl Fetch for ClientFetch<'_> {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        tauri::async_runtime::block_on(self.0.fetch_image(url)).map_err(|e| e.to_string())
    }
}

/// The file a URL is kept in, relative to the `MTG Grimoire` folder: `Images/<digest>.jpg`.
pub fn rel_path(url: &str) -> String {
    let digest = Sha256::digest(url.as_bytes());
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("{IMAGES_DIR}/{hex}.jpg")
}

/// `file:///C:/Users/…/x.jpg` for an absolute path, every byte but an unreserved one or a
/// separator percent-encoded — a `Documents` folder holds spaces, and a deck folder may hold `Æ`.
pub fn file_url(abs: &Path) -> String {
    let text = abs.to_string_lossy().replace('\\', "/");
    let mut out = String::from("file://");
    if !text.starts_with('/') {
        out.push('/');
    }
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Is this a picture? A JPEG or a PNG by its first bytes — what Scryfall serves for `large` and
/// `png`. An error page that answered `200` is not kept, or it would be a card face for good.
fn is_picture(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF]) || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}

/// One pass's pictures: what has been resolved, and which files it wants kept.
pub struct Localizer<'a> {
    root: &'a Path,
    fetch: &'a dyn Fetch,
    /// URL → what a save should name: the `file:///` copy, or the URL itself when it could not
    /// be had (the save still names *something*, and the next pass tries again).
    done: HashMap<String, String>,
    /// The picture files this pass names — the manifest's lines for them.
    pub files: BTreeSet<String>,
    last_fetch: Option<Instant>,
}

impl<'a> Localizer<'a> {
    pub fn new(root: &'a Path, fetch: &'a dyn Fetch) -> Self {
        Self {
            root,
            fetch,
            done: HashMap::new(),
            files: BTreeSet::new(),
            last_fetch: None,
        }
    }

    /// The URL a save should name for `url`, fetching the picture if this computer lacks it.
    /// A fetch that fails counts once in `failed` and leaves the remote URL in place.
    pub fn localize(&mut self, url: &str, report: &mut PassReport) -> String {
        if let Some(known) = self.done.get(url) {
            return known.clone();
        }
        let rel = rel_path(url);
        let abs: PathBuf = self.root.join(&rel);
        let answer = if abs.is_file() {
            report.unchanged += 1;
            self.files.insert(rel);
            file_url(&abs)
        } else {
            match self.download(url, &abs) {
                Ok(()) => {
                    report.written += 1;
                    self.files.insert(rel);
                    file_url(&abs)
                }
                Err(_) => {
                    report.failed += 1;
                    url.to_owned()
                }
            }
        };
        self.done.insert(url.to_owned(), answer.clone());
        answer
    }

    /// Fetch, check, and write through a `.part` so a killed pass never leaves half a picture
    /// under a name the next pass would trust.
    fn download(&mut self, url: &str, abs: &Path) -> Result<(), String> {
        if let Some(at) = self.last_fetch {
            if let Some(wait) = PACE.checked_sub(at.elapsed()) {
                std::thread::sleep(wait);
            }
        }
        self.last_fetch = Some(Instant::now());
        let bytes = self.fetch.fetch(url)?;
        if !is_picture(&bytes) {
            return Err(format!("{url} did not answer with a picture"));
        }
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let part = abs.with_extension("jpg.part");
        std::fs::write(&part, &bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&part, abs).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            e.to_string()
        })
    }

    /// Point every picture in these stacks at its local copy.
    pub fn localize_stacks(&mut self, stacks: &mut [Stack], report: &mut PassReport) {
        for card in stacks.iter_mut().flat_map(|s| s.cards.iter_mut()) {
            card.front.image = self.localize(&card.front.image, report);
            card.card_back = self.localize(&card.card_back, report);
            if let Some(back) = card.back_face.as_mut() {
                back.image = self.localize(&back.image, report);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::tabletop::save::{Card, Face};
    use std::cell::RefCell;

    /// A fetch that answers a tiny JPEG for every URL and counts its calls.
    #[derive(Default)]
    pub(crate) struct FakeFetch {
        pub calls: RefCell<Vec<String>>,
        pub refuse: bool,
    }

    impl Fetch for FakeFetch {
        fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
            self.calls.borrow_mut().push(url.to_owned());
            if self.refuse {
                return Err("400 generic_user_agent".into());
            }
            Ok(vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3])
        }
    }

    fn card(front: &str) -> Card {
        Card {
            front: Face {
                name: "X".into(),
                image: front.into(),
            },
            back_face: None,
            card_back: crate::tabletop::save::DEFAULT_BACK.into(),
        }
    }

    #[test]
    fn a_path_with_spaces_and_letters_beyond_ascii_is_a_file_url() {
        assert_eq!(
            file_url(Path::new(r"C:\Users\Me\My Games\Æther\a.jpg")),
            "file:///C:/Users/Me/My%20Games/%C3%86ther/a.jpg"
        );
        assert_eq!(
            file_url(Path::new("/home/me/a.jpg")),
            "file:///home/me/a.jpg"
        );
    }

    #[test]
    fn a_new_epoch_is_a_new_file() {
        assert_ne!(rel_path("https://x/a.jpg?1"), rel_path("https://x/a.jpg?2"));
        assert!(rel_path("https://x/a.jpg?1").starts_with("Images/"));
    }

    #[test]
    fn each_picture_is_fetched_once_and_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let fetch = FakeFetch::default();
        let mut report = PassReport::default();
        let mut stacks = vec![Stack {
            nickname: "Library".into(),
            face_up: false,
            cards: vec![card("https://cards.scryfall.io/a.jpg?1"); 3],
        }];
        let original = stacks.clone();
        let mut loc = Localizer::new(tmp.path(), &fetch);
        loc.localize_stacks(&mut stacks, &mut report);

        assert_eq!(
            fetch.calls.borrow().len(),
            2,
            "the face and the card back, once each"
        );
        assert_eq!(report.written, 2);
        assert!(stacks[0].cards[2].front.image.starts_with("file:///"));
        assert_eq!(loc.files.len(), 2);

        // A second pass finds both on disk and fetches nothing.
        let mut again = PassReport::default();
        Localizer::new(tmp.path(), &fetch).localize_stacks(&mut original.clone(), &mut again);
        assert_eq!(fetch.calls.borrow().len(), 2);
        assert_eq!(again.unchanged, 2);
    }

    #[test]
    fn a_refused_fetch_keeps_the_link_and_counts_once() {
        let tmp = tempfile::tempdir().unwrap();
        let fetch = FakeFetch {
            refuse: true,
            ..Default::default()
        };
        let mut report = PassReport::default();
        let mut loc = Localizer::new(tmp.path(), &fetch);
        let url = "https://cards.scryfall.io/a.jpg?1";
        assert_eq!(loc.localize(url, &mut report), url);
        assert_eq!(loc.localize(url, &mut report), url);
        assert_eq!(report.failed, 1);
        assert!(loc.files.is_empty());
    }

    #[test]
    fn an_answer_that_is_not_a_picture_is_not_kept() {
        assert!(!is_picture(b"{\"object\":\"error\"}"));
        assert!(is_picture(&[0xFF, 0xD8, 0xFF, 0xDB]));
    }
}
