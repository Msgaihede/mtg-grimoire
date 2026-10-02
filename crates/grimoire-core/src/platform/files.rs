//! Files in the data directory: a download being written, a feed being read back, the handful
//! of files the schema itself keeps.
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
//! be written is a failed sync with its reason in `error_log` (the request is sent first — the
//! refusal comes when the first byte has somewhere to go), a backup before a climb is logged
//! and skipped, and `schema::replace_unreadable_corpus` — which a browser's host has no reason
//! to call — would try, be refused, say so and leave everything as it was.
//!
//! `std::fs` itself compiles for a browser and fails there when called, which is why `schema`
//! could name it directly until the I/O step. `tokio::fs` does not compile there at all.

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

/// Every entry of `dir`, as its file name and its path. An entry whose name is not Unicode is
/// left out: nothing this app writes has one.
pub fn entries(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    imp::entries(dir)
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
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use std::io;
    use std::path::{Path, PathBuf};
    use tokio::io::AsyncWriteExt as _;

    pub type Reader = std::fs::File;
    pub type Writer = tokio::fs::File;

    pub fn open(path: &Path) -> io::Result<Reader> {
        std::fs::File::open(path)
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

    pub fn entries(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
        Ok(std::fs::read_dir(dir)?
            .flatten()
            .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry.path())))
            .collect())
    }

    pub fn is_file(path: &Path) -> bool {
        path.is_file()
    }

    pub fn exists(path: &Path) -> bool {
        path.exists()
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
    use super::unsupported;
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

    pub fn write(_path: &Path, _bytes: &[u8]) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn remove(_path: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn create_dir_all(_path: &Path) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn entries(_dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
        Err(unsupported())
    }

    pub fn is_file(_path: &Path) -> bool {
        false
    }

    pub fn exists(_path: &Path) -> bool {
        false
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
        let _ = remove_dir(&dir);
        create_dir_all(&dir).unwrap();
        dir
    }

    fn remove_dir(dir: &Path) -> io::Result<()> {
        for (_, path) in entries(dir)? {
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
