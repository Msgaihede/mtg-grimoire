//! Files in the data directory: a download being written, a feed being read back, the handful
//! of files the schema itself keeps, and the image cache's pictures.
//!
//! **Everything this crate does to a file goes through here**, so the answer to "what does the
//! engine touch on disk" is the list of callers of this module. Two halves, because there are
//! two kinds of caller: plain functions for code that is already off the async runtime — an
//! ingest on a blocking thread, the launch — and [`aio`] for an `async fn` that must not park
//! its task's thread on a disk (`scryfall::Client::download` writes 77 MB a chunk at a time).
//!
//! | | Native | Browser |
//! | --- | --- | --- |
//! | this module | `std::fs` | refused: [`unsupported`] |
//! | [`aio`] | `tokio::fs` | refused, the same way |
//!
//! **A browser has no filesystem, and nothing here pretends otherwise.** There the database
//! lives in the origin-private file system behind SQLite's own VFS, and a download wants a
//! different shape altogether — a stream handed straight to the ingest, no temp file. What that
//! shape is belongs to the web host (the light-app spec §6), which is the first thing that could
//! run it. Until then every function here answers `Unsupported` in a browser, and the two
//! questions answer `false`. That is a refusal a caller already handles: a download that cannot
//! be written is a failed sync — the card sync makes the download's folder first, so it stops
//! there, after the bulk check and before the download is asked for, with its reason in
//! `sync_meta`'s `last_error`, and the tag engine does the same. **The combo feed and the
//! price feeds ask first and find out at the folder**, so there each launch would spend a
//! request it cannot keep and fold a row into `error_log`; that is theirs to reorder when a
//! web host first runs them. A backup before a climb is logged and skipped, and `schema::replace_unreadable_corpus` — which a browser's host has no reason
//! to call — would try, be refused, say so and leave everything as it was.
//!
//! `std::fs` itself compiles for a browser and fails there when called, which is why `schema`
//! could name it directly until the I/O step. `tokio::fs` does not compile there at all.

use super::clock::Wall;
use std::io;
use std::path::{Path, PathBuf};

/// What every function here answers on a host with no files.
pub fn unsupported() -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, "this host keeps no files")
}

/// A file open for reading from its start.
pub struct Reader(imp::Reader);

impl io::Read for Reader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

pub fn open(path: &Path) -> io::Result<Reader> {
    imp::open(path).map(Reader)
}

/// The whole of `path`, in memory — for code already off the async runtime that wants a file
/// whole, as the scanner's asset load does with its 12 MB of models.
pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    imp::read(path)
}

/// Write `bytes` as the whole of `path`, replacing what was there.
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    imp::write(path, bytes)
}

pub fn remove(path: &Path) -> io::Result<()> {
    imp::remove(path)
}

pub fn create_dir_all(path: &Path) -> io::Result<()> {
    imp::create_dir_all(path)
}

/// Remove `path`, a directory with nothing in it. One that still holds something is refused
/// and left as it was.
pub fn remove_dir(path: &Path) -> io::Result<()> {
    imp::remove_dir(path)
}

/// Every entry of `dir`, as its file name and its path. An entry whose name is not Unicode is
/// left out: nothing this app writes has one.
pub fn entries(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    imp::entries(dir)
}

/// What a directory entry is, as the entry itself says — a link is a link, never what it
/// points at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    /// A link, a device, anything else.
    Other,
}

/// One entry of a [`listing`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The entry's name, for reading. One that is not Unicode is given with the bytes that
    /// are not replaced; [`Entry::path`] is always exact, and is what to act on.
    pub name: String,
    pub path: PathBuf,
    pub kind: Kind,
    /// The entry's own length — a link's is the link's, never what it points at. `None` for a
    /// directory, and for an entry the host would not measure.
    pub len: Option<u64>,
    /// When it was last written, or stamped with [`set_modified`]. `None` as for `len`.
    pub modified: Option<Wall>,
}

/// Every entry of `dir` with what it is — and, for anything but a directory, how long it is
/// and when it was last written. **A directory that is not there answers `None`**, which is an ordinary state:
/// nothing was ever put in it.
///
/// For a caller that has to tell "absent" from "unreadable": any other failure, on the
/// directory or on one entry of it, is the error, so a partial listing is never mistaken for a
/// whole one. An entry that vanishes between being listed and being asked what it is is left
/// out. **No entry is left out for its name**: a caller that deletes what it lists must not
/// leave behind a file it could not spell.
///
/// On Windows a file's length and time come out of the directory listing itself, so this is
/// one call per directory; elsewhere it is one more per file.
pub fn listing(dir: &Path) -> io::Result<Option<Vec<Entry>>> {
    imp::listing(dir)
}

/// Set `path`'s modified time. **It never creates the file**: a path that is not there is
/// `NotFound`, and stays not there.
pub fn set_modified(path: &Path, when: Wall) -> io::Result<()> {
    imp::set_modified(path, when)
}

pub fn is_file(path: &Path) -> bool {
    imp::is_file(path)
}

pub fn exists(path: &Path) -> bool {
    imp::exists(path)
}

/// The same files from inside an `async fn`.
pub mod aio {
    use super::imp;
    use std::io;
    use std::path::Path;

    /// A file open for writing.
    pub struct Writer(imp::Writer);

    impl Writer {
        /// Create `path`, or empty it if it is there.
        pub async fn create(path: &Path) -> io::Result<Writer> {
            imp::create(path).await.map(Writer)
        }

        /// Open `path` to write after its last byte.
        pub async fn append(path: &Path) -> io::Result<Writer> {
            imp::append(path).await.map(Writer)
        }

        pub async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
            imp::write_all(&mut self.0, bytes).await
        }

        pub async fn flush(&mut self) -> io::Result<()> {
            imp::flush(&mut self.0).await
        }

        /// Make what was written durable: on the disk, not in the system's cache.
        pub async fn sync_all(&self) -> io::Result<()> {
            imp::sync_all(&self.0).await
        }

        /// Let go of the file. Dropping the writer does the same; this is for a caller that
        /// measures the file next and wants that order written down.
        pub fn close(self) {}
    }

    /// The file's length in bytes.
    pub async fn len(path: &Path) -> io::Result<u64> {
        imp::len(path).await
    }

    pub async fn read_to_string(path: &Path) -> io::Result<String> {
        imp::read_to_string(path).await
    }

    /// Write `bytes` as the whole of `path`, replacing what was there.
    pub async fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
        imp::write_async(path, bytes).await
    }

    pub async fn remove(path: &Path) -> io::Result<()> {
        imp::remove_async(path).await
    }

    /// The whole of `path`, in memory.
    pub async fn read(path: &Path) -> io::Result<Vec<u8>> {
        imp::read_async(path).await
    }

    pub async fn create_dir_all(path: &Path) -> io::Result<()> {
        imp::create_dir_all_async(path).await
    }

    /// Move `from` to `to`, **replacing** a file already there — one operation on every host
    /// that has files, which is what lets a writer finish a file under another name and swap
    /// it in whole.
    pub async fn rename(from: &Path, to: &Path) -> io::Result<()> {
        imp::rename_async(from, to).await
    }
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use super::{Entry, Kind, Wall};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::io::AsyncWriteExt as _;

    pub type Reader = std::fs::File;
    pub type Writer = tokio::fs::File;

    pub fn open(path: &Path) -> io::Result<Reader> {
        std::fs::File::open(path)
    }

    pub fn read(path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
        std::fs::write(path, bytes)
    }

    pub fn remove(path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }

    pub fn create_dir_all(path: &Path) -> io::Result<()> {
        std::fs::create_dir_all(path)
    }

    pub fn remove_dir(path: &Path) -> io::Result<()> {
        std::fs::remove_dir(path)
    }

    pub fn entries(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
        Ok(std::fs::read_dir(dir)?
            .flatten()
            .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry.path())))
            .collect())
    }

    pub fn listing(dir: &Path) -> io::Result<Option<Vec<Entry>>> {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let mut found = Vec::new();
        for entry in entries {
            let entry = entry?;
            let kind = match entry.file_type() {
                Ok(kind) if kind.is_file() => Kind::File,
                Ok(kind) if kind.is_dir() => Kind::Dir,
                Ok(_) => Kind::Other,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            // Listed, even when it cannot be measured.
            let meta = match kind {
                Kind::File | Kind::Other => entry.metadata().ok(),
                Kind::Dir => None,
            };
            found.push(Entry {
                name,
                path: entry.path(),
                kind,
                len: meta.as_ref().map(|m| m.len()),
                modified: meta.and_then(|m| m.modified().ok()).map(wall),
            });
        }
        Ok(Some(found))
    }

    /// A file time as a [`Wall`]: whole milliseconds, a time before 1970 counted backwards.
    fn wall(time: SystemTime) -> Wall {
        let ms = |d: Duration| i64::try_from(d.as_millis()).unwrap_or(i64::MAX);
        Wall::from_ms(match time.duration_since(UNIX_EPOCH) {
            Ok(since) => ms(since),
            Err(before) => -ms(before.duration()),
        })
    }

    pub fn set_modified(path: &Path, when: Wall) -> io::Result<()> {
        let ms = when.as_ms();
        let span = Duration::from_millis(ms.unsigned_abs());
        let time = if ms >= 0 {
            UNIX_EPOCH.checked_add(span)
        } else {
            UNIX_EPOCH.checked_sub(span)
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a time a file can hold"))?;
        // `write(true)` and never `create(true)`: a file that is gone stays gone.
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)?
            .set_modified(time)
    }

    pub fn is_file(path: &Path) -> bool {
        path.is_file()
    }

    pub fn exists(path: &Path) -> bool {
        path.exists()
    }

    pub async fn read_async(path: &Path) -> io::Result<Vec<u8>> {
        tokio::fs::read(path).await
    }

    pub async fn create_dir_all_async(path: &Path) -> io::Result<()> {
        tokio::fs::create_dir_all(path).await
    }

    pub async fn rename_async(from: &Path, to: &Path) -> io::Result<()> {
        tokio::fs::rename(from, to).await
    }

    pub async fn create(path: &Path) -> io::Result<Writer> {
        tokio::fs::File::create(path).await
    }

    pub async fn append(path: &Path) -> io::Result<Writer> {
        tokio::fs::OpenOptions::new().append(true).open(path).await
    }

    pub async fn write_all(file: &mut Writer, bytes: &[u8]) -> io::Result<()> {
        file.write_all(bytes).await
    }

    pub async fn flush(file: &mut Writer) -> io::Result<()> {
        file.flush().await
    }

    pub async fn sync_all(file: &Writer) -> io::Result<()> {
        file.sync_all().await
    }

    pub async fn len(path: &Path) -> io::Result<u64> {
        tokio::fs::metadata(path).await.map(|m| m.len())
    }

    pub async fn read_to_string(path: &Path) -> io::Result<String> {
        tokio::fs::read_to_string(path).await
    }

    pub async fn write_async(path: &Path, bytes: &[u8]) -> io::Result<()> {
        tokio::fs::write(path, bytes).await
    }

    pub async fn remove_async(path: &Path) -> io::Result<()> {
        tokio::fs::remove_file(path).await
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use super::{unsupported, Entry, Wall};
    use std::io;
    use std::path::{Path, PathBuf};

    /// Never built: [`open`] refuses.
    pub struct Reader;

    impl Reader {
        pub fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Err(unsupported())
        }
    }

    /// Never built: [`create`] and [`append`] refuse.
    pub struct Writer;

    pub fn open(_path: &Path) -> io::Result<Reader> {
        Err(unsupported())
    }

    pub fn read(_path: &Path) -> io::Result<Vec<u8>> {
        Err(unsupported())
    }

    pub fn write(_path: &Path, _bytes: &[u8]) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn remove(_path: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn create_dir_all(_path: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn remove_dir(_path: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn entries(_dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
        Err(unsupported())
    }

    pub fn listing(_dir: &Path) -> io::Result<Option<Vec<Entry>>> {
        Err(unsupported())
    }

    pub fn set_modified(_path: &Path, _when: Wall) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn is_file(_path: &Path) -> bool {
        false
    }

    pub fn exists(_path: &Path) -> bool {
        false
    }

    pub async fn read_async(_path: &Path) -> io::Result<Vec<u8>> {
        Err(unsupported())
    }

    pub async fn create_dir_all_async(_path: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    pub async fn rename_async(_from: &Path, _to: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    pub async fn create(_path: &Path) -> io::Result<Writer> {
        Err(unsupported())
    }

    pub async fn append(_path: &Path) -> io::Result<Writer> {
        Err(unsupported())
    }

    pub async fn write_all(_file: &mut Writer, _bytes: &[u8]) -> io::Result<()> {
        Err(unsupported())
    }

    pub async fn flush(_file: &mut Writer) -> io::Result<()> {
        Err(unsupported())
    }

    pub async fn sync_all(_file: &Writer) -> io::Result<()> {
        Err(unsupported())
    }

    pub async fn len(_path: &Path) -> io::Result<u64> {
        Err(unsupported())
    }

    pub async fn read_to_string(_path: &Path) -> io::Result<String> {
        Err(unsupported())
    }

    pub async fn write_async(_path: &Path, _bytes: &[u8]) -> io::Result<()> {
        Err(unsupported())
    }

    pub async fn remove_async(_path: &Path) -> io::Result<()> {
        Err(unsupported())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read as _;

    fn dir(name: &str) -> PathBuf {
        let dir = crate::scratch::path(&format!("files-{name}"));
        let _ = empty(&dir);
        create_dir_all(&dir).unwrap();
        dir
    }

    /// Empty `dir`, one level down as well: the listing test leaves a folder in its own.
    fn empty(dir: &Path) -> io::Result<()> {
        for (_, path) in entries(dir)? {
            if !is_file(&path) {
                empty(&path)?;
                remove_dir(&path)?;
                continue;
            }
            remove(&path)?;
        }
        Ok(())
    }

    /// What `schema` asks of it: a mark written, found, listed and taken away.
    #[test]
    fn a_file_is_written_found_listed_and_removed() {
        let dir = dir("sync");
        let path = dir.join("mark.txt");
        assert!(!exists(&path) && !is_file(&path));
        write(&path, b"damaged").unwrap();
        assert!(exists(&path) && is_file(&path));
        assert!(!is_file(&dir), "a directory is not a file");

        let mut text = String::new();
        open(&path).unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, "damaged");
        assert_eq!(
            entries(&dir).unwrap(),
            vec![("mark.txt".to_owned(), path.clone())]
        );

        remove(&path).unwrap();
        assert!(!exists(&path));
        assert_eq!(remove(&path).unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    /// What the image cache's eviction asks of it: a folder that is not there is not an
    /// error, a file is told from a folder, and a file carries its length and a stamp that can
    /// be moved — without ever being created by the moving.
    #[test]
    fn a_listing_tells_a_file_from_a_folder_and_carries_a_stamp_that_can_be_set() {
        let dir = dir("listing");
        assert_eq!(listing(&dir.join("never-made")).unwrap(), None);
        assert_eq!(listing(&dir).unwrap(), Some(Vec::new()));

        let file = dir.join("picture.webp");
        let shard = dir.join("ab");
        write(&file, b"12345").unwrap();
        create_dir_all(&shard).unwrap();

        let mut found = listing(&dir).unwrap().unwrap();
        found.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(found.len(), 2);
        assert_eq!(
            (found[0].name.as_str(), &found[0].path, found[0].kind),
            ("ab", &shard, Kind::Dir)
        );
        assert_eq!((found[0].len, found[0].modified), (None, None));
        assert_eq!(
            (found[1].name.as_str(), &found[1].path, found[1].kind),
            ("picture.webp", &file, Kind::File)
        );
        assert_eq!(found[1].len, Some(5));
        let written = found[1].modified.expect("a file just written has a time");
        let now = Wall::now();
        let minute = std::time::Duration::from_secs(60);
        assert!(
            now - minute < written && written < now + minute,
            "{written:?} against {now:?}"
        );

        // Two seconds is the coarsest stamp any filesystem this app meets keeps (FAT), so a
        // whole number of them survives the trip on all of them.
        let long_ago = Wall::from_ms(1_000_000_000_000);
        set_modified(&file, long_ago).unwrap();
        let stamped = listing(&dir).unwrap().unwrap();
        let stamped = stamped.iter().find(|e| e.kind == Kind::File).unwrap();
        assert_eq!(stamped.modified, Some(long_ago));
        assert_eq!(stamped.len, Some(5), "a stamp is not a write");

        // A folder goes only once it is empty, which is what lets a sweep leave behind one
        // that still holds a file it could not delete.
        write(&shard.join("kept.webp"), b"x").unwrap();
        assert!(
            remove_dir(&shard).is_err(),
            "a folder with a file in it stays"
        );
        assert!(exists(&shard.join("kept.webp")));
        remove(&shard.join("kept.webp")).unwrap();
        remove_dir(&shard).unwrap();
        assert!(!exists(&shard));

        let gone = dir.join("gone.webp");
        assert_eq!(
            set_modified(&gone, long_ago).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert!(
            !exists(&gone),
            "stamping a file that is gone must not make one"
        );
    }

    /// What storing a picture asks of it: bytes finished under another name and swapped in
    /// whole, over a file already there.
    #[tokio::test]
    async fn a_file_is_read_whole_and_a_rename_replaces_what_was_there() {
        let dir = dir("swap");
        let shard = dir.join("images").join("ab");
        aio::create_dir_all(&shard).await.unwrap();
        aio::create_dir_all(&shard).await.unwrap();

        let dest = shard.join("card.webp");
        let tmp = shard.join("card.0.tmp");
        aio::write(&dest, b"old").await.unwrap();
        aio::write(&tmp, b"new bytes").await.unwrap();
        aio::rename(&tmp, &dest).await.unwrap();
        assert_eq!(aio::read(&dest).await.unwrap(), b"new bytes");
        assert!(!exists(&tmp), "the temporary name is gone with the swap");

        assert_eq!(
            aio::read(&tmp).await.unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            aio::rename(&tmp, &dest).await.unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(aio::read(&dest).await.unwrap(), b"new bytes");
    }

    /// What a download asks of it: a file started, added to after a restart, and measured —
    /// `create` empties and `append` does not, which is the whole of a resume.
    #[tokio::test]
    async fn a_download_is_created_appended_to_and_measured() {
        let dir = dir("aio");
        let path = dir.join("bulk.gz");
        assert!(aio::len(&path).await.is_err(), "no file, no length");

        let mut file = aio::Writer::create(&path).await.unwrap();
        file.write_all(b"abc").await.unwrap();
        file.flush().await.unwrap();
        file.sync_all().await.unwrap();
        file.close();
        assert_eq!(aio::len(&path).await.unwrap(), 3);

        let mut file = aio::Writer::append(&path).await.unwrap();
        file.write_all(b"de").await.unwrap();
        file.flush().await.unwrap();
        file.close();
        assert_eq!(aio::read_to_string(&path).await.unwrap(), "abcde");

        drop(aio::Writer::create(&path).await.unwrap());
        assert_eq!(
            aio::len(&path).await.unwrap(),
            0,
            "create starts the file over"
        );

        aio::write(&path, b"whole").await.unwrap();
        assert_eq!(aio::read_to_string(&path).await.unwrap(), "whole");
        aio::remove(&path).await.unwrap();
        assert!(!exists(&path));
    }
}
