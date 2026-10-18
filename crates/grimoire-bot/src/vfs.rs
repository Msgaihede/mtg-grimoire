//! **The page store**: a SQLite VFS whose database files are pages in somebody else's storage —
//! the Durable Object's synchronous SQL storage in workerd, an in-memory map in a test — each
//! page sealed with XChaCha20-Poly1305 before it leaves this module.
//!
//! # Why a VFS of its own
//!
//! workerd has no OPFS, so the web host's pool (`sqlite-wasm-vfs`'s sahpool) has nothing to stand
//! on; and SQLite's own in-memory database is not an option at 128 MB an isolate, with the group's
//! whole collection materialised in it and nothing kept across an eviction. What a Durable Object
//! *does* have is `ctx.storage.sql`, a SQLite database of its own that it reads and writes
//! **synchronously** — which is what a VFS's `xRead` and `xWrite` are. So the engine's SQLite
//! keeps its files as rows there: `pages(file, no, data)` and `files(name, size)`, written by the
//! Durable Object's script (`infrastructure/bot-device/src/store.ts`), which is the [`PageStore`]
//! this module is handed.
//!
//! It is registered through `rsqlite-vfs`, the traits the browser's pool is built on, as SQLite's
//! default VFS — so `grimoire_core::launch::open_single` opens its two names through it without
//! knowing there is one.
//!
//! # What is kept where
//!
//! * **A database** — a name ending in `.db` under a mount (`<mount>/user.db`,
//!   `<mount>/corpus.db`) — is pages in the store, [`BLOCK`] bytes each, numbered from zero.
//! * **Everything else** — a rollback journal, a super-journal, a temporary b-tree — is memory
//!   (`rsqlite_vfs::MemChunksFile`), and is gone with the isolate.
//!
//! # What makes a crash safe
//!
//! **A database's pages reach the store only at `xSync`, all of them in one
//! [`PageStore::commit`]**, which the Durable Object runs inside `ctx.storage.transactionSync`.
//! Until then every page written is held here, dirty, in memory. In rollback-journal mode SQLite
//! syncs the database file once per transaction, after the last of its pages is written and
//! before the journal goes — so the store holds the state of one committed transaction or the
//! next, and never a page of one beside a page of another. That is also why the journal can be
//! memory: a hot journal is a statement about a database file that may be half-written, and in
//! the store none ever is. An isolate that dies with dirty pages lost a transaction that had not
//! committed, which is what a rollback is.
//!
//! The engine asks for WAL; this VFS is version 1 with no shared memory, so SQLite refuses it and
//! stays on `delete` — exactly what the browser's pool does, and what `Opened::journal` reports.
//! `synchronous = NORMAL` (the core's) syncs the database at every commit in that mode; only
//! `OFF` would not, and the core never sets it.
//!
//! # What the seal covers
//!
//! Each page is `nonce ‖ ciphertext ‖ tag`, under a key HKDF-SHA256 derives from the `BOT_KEK`
//! secret with the Durable Object's id as the salt ([`PageCipher::new`]) — so one object's pages
//! do not open in another's. The associated data is the file's name within its mount and the
//! page's number ([`aad`]), so a page moved to another place in the file, or to the other file,
//! does not open either. **What it does not cover**: a page replaced by an *older* sealing of the
//! same page (the store can replay one), and the file's length, which is kept in the clear. Both
//! are an operator with write access to the storage, and that operator holds the key too
//! (`infrastructure/bot-device/README.md`, the residual risk).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rsqlite_vfs::ffi::{sqlite3_vfs, SQLITE_IOERR, SQLITE_IOERR_DELETE};
use rsqlite_vfs::{
    MemChunksFile, SQLiteIoMethods, SQLiteVfs, SQLiteVfsFile, VfsAppData, VfsError, VfsFile,
    VfsResult, VfsStore,
};
use sha2::Sha256;

/// The VFS's name. Registered as SQLite's default, so it is never spelled in a URI.
pub const VFS_NAME: &str = "bot-pages";

/// How many bytes a stored page holds — SQLite's own default page size, so a database page is
/// one stored row and a write is never a read-modify-write. A file whose page size is something
/// else still works: its reads and writes are cut to blocks here.
pub const BLOCK: usize = 4096;

/// How many decrypted pages are kept for reads, per file. SQLite has a page cache of its own on
/// the connection; this is what saves a decryption and a storage read when SQLite's lets a page
/// go and asks again. 256 pages is a megabyte a file.
pub const CACHE_PAGES: usize = 256;

/// The nonce XChaCha20-Poly1305 takes, and the tag it adds.
const NONCE: usize = 24;
const TAG: usize = 16;

/// The domain tag every page's associated data starts with.
const AAD_TAG: &[u8] = b"mtg-grimoire/bot-page/v1";

/// HKDF's `info` for the page key.
const KEY_INFO: &[u8] = b"mtg-grimoire/bot-pages/v1";

/// What a page that does not open says. Spelled once: the Durable Object's status names it.
pub const UNREADABLE: &str =
    "a stored page did not decrypt (wrong BOT_KEK, or the page was altered)";

/// **Where the pages are.** The Durable Object's SQL storage in workerd; an in-memory map in a
/// test ([`MemoryStore`]). Every method is synchronous, which is the whole reason a Durable
/// Object can host this VFS at all.
///
/// The store sees sealed pages only ([`PageCipher`]): it never holds a byte of plaintext.
pub trait PageStore: StoreBounds {
    /// The length of `file` in bytes, or `None` when there is no such file.
    fn size(&self, file: &str) -> Result<Option<u64>, String>;
    /// Page `no` of `file`, as it was sealed, or `None` when it was never written.
    fn read(&self, file: &str, no: u64) -> Result<Option<Vec<u8>>, String>;
    /// **One atomic step**: record `file` at `size` bytes, drop every page numbered
    /// `truncate_from` or above when that is `Some`, and put each of `pages` — after the drop, so
    /// a page rewritten past a truncation survives it. The file is created when it is new.
    fn commit(
        &self,
        file: &str,
        size: u64,
        pages: &[(u64, Vec<u8>)],
        truncate_from: Option<u64>,
    ) -> Result<(), String>;
    /// Forget `file` and every page of it.
    fn remove(&self, file: &str) -> Result<(), String>;
}

/// `Send + Sync` natively, where the tests run SQLite on many threads; nothing on wasm32, where a
/// store holds a JavaScript object and there is one thread.
#[cfg(not(target_family = "wasm"))]
pub trait StoreBounds: Send + Sync {}
#[cfg(not(target_family = "wasm"))]
impl<T: Send + Sync + ?Sized> StoreBounds for T {}
#[cfg(target_family = "wasm")]
pub trait StoreBounds {}
#[cfg(target_family = "wasm")]
impl<T: ?Sized> StoreBounds for T {}

/// The associated data a page is sealed under: the domain tag, the file's name within its mount
/// and the page's number.
pub fn aad(file: &str, no: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(AAD_TAG.len() + file.len() + 10);
    out.extend_from_slice(AAD_TAG);
    out.push(0);
    out.extend_from_slice(file.as_bytes());
    out.push(0);
    out.extend_from_slice(&no.to_be_bytes());
    out
}

/// The page key, and the seal.
#[derive(Clone)]
pub struct PageCipher(XChaCha20Poly1305);

impl PageCipher {
    /// The key for one Durable Object: HKDF-SHA256 over `kek`, salted with the object's id.
    pub fn new(kek: &[u8; 32], object: &str) -> PageCipher {
        let mut key = [0u8; 32];
        Hkdf::<Sha256>::new(Some(object.as_bytes()), kek)
            .expand(KEY_INFO, &mut key)
            .expect("32 bytes is a length HKDF-SHA256 can expand to");
        PageCipher(XChaCha20Poly1305::new((&key).into()))
    }

    /// `nonce ‖ ciphertext ‖ tag`, the nonce drawn fresh for every sealing.
    pub fn seal(&self, file: &str, no: u64, plain: &[u8]) -> Result<Vec<u8>, String> {
        let mut nonce = [0u8; NONCE];
        getrandom::fill(&mut nonce)
            .map_err(|e| format!("no randomness for a page's nonce: {e}"))?;
        let sealed = self
            .0
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plain,
                    aad: &aad(file, no),
                },
            )
            .map_err(|_| "a page could not be sealed".to_owned())?;
        let mut out = Vec::with_capacity(NONCE + sealed.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    /// The page, or [`UNREADABLE`].
    pub fn open(&self, file: &str, no: u64, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.len() < NONCE + TAG {
            return Err(UNREADABLE.to_owned());
        }
        let (nonce, body) = sealed.split_at(NONCE);
        self.0
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: body,
                    aad: &aad(file, no),
                },
            )
            .map_err(|_| UNREADABLE.to_owned())
    }
}

/// A [`PageStore`] in memory — the tests', and a fake anybody may use. It also counts what it
/// was asked, so a test can see a write held back until a sync.
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<MemoryInner>,
}

#[derive(Default)]
struct MemoryInner {
    files: HashMap<String, u64>,
    pages: BTreeMap<(String, u64), Vec<u8>>,
    commits: usize,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }

    /// How many [`PageStore::commit`]s it has taken.
    pub fn commits(&self) -> usize {
        self.inner.lock().unwrap().commits
    }

    /// Every page of `file`, sealed, by number — what an operator reading the storage sees.
    pub fn sealed_pages(&self, file: &str) -> Vec<(u64, Vec<u8>)> {
        let inner = self.inner.lock().unwrap();
        inner
            .pages
            .iter()
            .filter(|((f, _), _)| f == file)
            .map(|((_, no), data)| (*no, data.clone()))
            .collect()
    }

    /// Replace a stored page with other bytes — an operator, or a bad disk.
    pub fn tamper(&self, file: &str, no: u64, data: Vec<u8>) {
        self.inner
            .lock()
            .unwrap()
            .pages
            .insert((file.to_owned(), no), data);
    }

    /// The names of every file it holds.
    pub fn files(&self) -> Vec<String> {
        let mut out: Vec<String> = self.inner.lock().unwrap().files.keys().cloned().collect();
        out.sort();
        out
    }
}

impl PageStore for MemoryStore {
    fn size(&self, file: &str) -> Result<Option<u64>, String> {
        Ok(self.inner.lock().unwrap().files.get(file).copied())
    }

    fn read(&self, file: &str, no: u64) -> Result<Option<Vec<u8>>, String> {
        Ok(self
            .inner
            .lock()
            .unwrap()
            .pages
            .get(&(file.to_owned(), no))
            .cloned())
    }

    fn commit(
        &self,
        file: &str,
        size: u64,
        pages: &[(u64, Vec<u8>)],
        truncate_from: Option<u64>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.commits += 1;
        inner.files.insert(file.to_owned(), size);
        if let Some(from) = truncate_from {
            inner.pages.retain(|(f, no), _| f != file || *no < from);
        }
        for (no, data) in pages {
            inner.pages.insert((file.to_owned(), *no), data.clone());
        }
        Ok(())
    }

    fn remove(&self, file: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.files.remove(file);
        inner.pages.retain(|(f, _), _| f != file);
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------------------------

/// One Durable Object's storage, under its mount name.
struct Mount {
    store: Arc<dyn PageStore>,
    cipher: PageCipher,
}

/// **Every file this VFS has open or knows of, and every mount** — the VFS's app data, one per
/// process (an isolate, in workerd).
///
/// ⚠️ **One isolate can host more than one Durable Object of a class**, and a wasm module's
/// memory is the isolate's: so two links can share this registry, and a mount name is what keeps
/// their files apart (`host` mounts each object under its own id).
#[derive(Default)]
struct Registry {
    mounts: HashMap<String, Arc<Mount>>,
    files: HashMap<String, File>,
}

/// The registry's lock. A `Mutex` and not a `RefCell` because a native test suite runs SQLite on
/// many threads at once; on wasm32 it is never contended.
fn registry(vfs: *mut sqlite3_vfs) -> MutexGuard<'static, Registry> {
    let data: &'static VfsAppData<Mutex<Registry>> = unsafe { Store::app_data(vfs) };
    data.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The registered VFS, once. Registering is idempotent: a second call finds it.
fn installed() -> Result<*mut sqlite3_vfs, String> {
    struct Pointer(*mut sqlite3_vfs);
    // The pointer is SQLite's, for the life of the process, and only ever handed back to it.
    unsafe impl Send for Pointer {}
    unsafe impl Sync for Pointer {}
    static VFS: OnceLock<Result<Pointer, String>> = OnceLock::new();
    match VFS.get_or_init(|| {
        // SQLite must be initialised before a VFS can be registered; `sqlite3_vfs_register` calls
        // `sqlite3_initialize` itself, which on wasm32 installs `sqlite-wasm-rs`'s memvfs first.
        rsqlite_vfs::register_vfs::<IoMethods, Vfs>(VFS_NAME, Mutex::new(Registry::default()), true)
            .map(Pointer)
            .map_err(|e| format!("the page store could not be registered with SQLite: {e}"))
    }) {
        Ok(p) => Ok(p.0),
        Err(e) => Err(e.clone()),
    }
}

/// **Make `mount` a name SQLite can open files under**, over `store`, sealed with `cipher`. The
/// VFS is registered as SQLite's default on the first call. A mount already there is replaced —
/// what a Durable Object constructed again in the same isolate does.
// One `Arc` type on every target: natively the store is `Send + Sync` (the tests' threads), and
// on wasm32 there is one thread and a store holds a JavaScript object, so it is neither.
#[cfg_attr(target_family = "wasm", allow(clippy::arc_with_non_send_sync))]
pub fn mount(name: &str, store: Arc<dyn PageStore>, cipher: PageCipher) -> Result<(), String> {
    if name.is_empty() || name.contains('/') {
        return Err("a mount's name is one path segment".to_owned());
    }
    let vfs = installed()?;
    let mut reg = registry(vfs);
    let prefix = format!("{name}/");
    reg.files.retain(|file, _| !file.starts_with(&prefix));
    reg.mounts
        .insert(name.to_owned(), Arc::new(Mount { store, cipher }));
    Ok(())
}

/// Forget `mount` and every file under it — after its connection is closed. The store is not
/// touched: what was committed stays there.
pub fn unmount(name: &str) {
    let Ok(vfs) = installed() else {
        return;
    };
    let mut reg = registry(vfs);
    let prefix = format!("{name}/");
    reg.files.retain(|file, _| !file.starts_with(&prefix));
    reg.mounts.remove(name);
}

/// A full name's mount, and the file's name within it.
fn split(file: &str) -> Option<(&str, &str)> {
    file.split_once('/')
}

/// **The name SQLite gave, with `/` as its only separator** — the key every file is filed under.
///
/// The engine names its pair with `Path::join` (`launch::open_single`), and on Windows that is
/// `<mount>\user.db`: measured 2026-10-18 on CI's `windows-latest`, where [`split`] found no `/`,
/// both databases fell through to [`File::Memory`] and the store stayed empty. workerd only ever
/// sees `/`, so this changes nothing the Worker does; it is what lets the native suite run on the
/// desktop's own platform.
fn canonical(file: &str) -> std::borrow::Cow<'_, str> {
    if file.contains('\\') {
        std::borrow::Cow::Owned(file.replace('\\', "/"))
    } else {
        std::borrow::Cow::Borrowed(file)
    }
}

/// Whether a file is a database kept in the store, rather than something kept in memory.
fn persisted(relative: &str) -> bool {
    relative.ends_with(".db")
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/// A file SQLite has open or has made.
enum File {
    /// A journal or a temporary file.
    Memory(MemChunksFile),
    /// A database, in the store.
    Paged(PagedFile),
}

/// A database file over a mount's store.
struct PagedFile {
    mount: Arc<Mount>,
    /// The name within the mount — what the store and the seal know it by.
    name: String,
    /// The length SQLite sees, dirty pages included.
    size: u64,
    /// Pages written since the last sync, by number, in the clear.
    dirty: BTreeMap<u64, Vec<u8>>,
    /// The lowest page number a truncation since the last sync dropped, if any.
    truncate_from: Option<u64>,
    /// Pages read, in the clear, and the order they were last used in — behind a `Mutex`
    /// because `xRead` gets a shared borrow and a read fills it.
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    pages: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
}

impl Cache {
    fn get(&mut self, no: u64) -> Option<Vec<u8>> {
        let page = self.pages.get(&no)?.clone();
        self.touch(no);
        Some(page)
    }

    fn put(&mut self, no: u64, page: Vec<u8>) {
        if self.pages.insert(no, page).is_none() {
            self.order.push_back(no);
            while self.order.len() > CACHE_PAGES {
                if let Some(old) = self.order.pop_front() {
                    self.pages.remove(&old);
                }
            }
        } else {
            self.touch(no);
        }
    }

    fn touch(&mut self, no: u64) {
        if let Some(at) = self.order.iter().position(|n| *n == no) {
            self.order.remove(at);
            self.order.push_back(no);
        }
    }

    fn drop_from(&mut self, from: u64) {
        self.pages.retain(|no, _| *no < from);
        self.order.retain(|no| *no < from);
    }
}

fn io(message: impl Into<String>) -> VfsError {
    VfsError::new(SQLITE_IOERR, message.into())
}

impl PagedFile {
    fn open(mount: Arc<Mount>, name: &str, size: u64) -> PagedFile {
        PagedFile {
            mount,
            name: name.to_owned(),
            size,
            dirty: BTreeMap::new(),
            truncate_from: None,
            cache: Mutex::new(Cache::default()),
        }
    }

    /// Block `no` in the clear: dirty, cached, stored, or zeros past what was ever written.
    fn block(&self, no: u64) -> VfsResult<Vec<u8>> {
        if let Some(page) = self.dirty.get(&no) {
            return Ok(page.clone());
        }
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(page) = cache.get(no) {
            return Ok(page);
        }
        // A page at or past a truncation since the last sync is gone, whatever the store holds.
        if self.truncate_from.is_some_and(|from| no >= from) {
            return Ok(vec![0; BLOCK]);
        }
        let sealed = self.mount.store.read(&self.name, no).map_err(io)?;
        let page = match sealed {
            None => vec![0; BLOCK],
            Some(sealed) => {
                let mut page = self
                    .mount
                    .cipher
                    .open(&self.name, no, &sealed)
                    .map_err(io)?;
                page.resize(BLOCK, 0);
                page
            }
        };
        cache.put(no, page.clone());
        Ok(page)
    }

    /// Commit every dirty page, sealed, in one step.
    fn sync(&mut self) -> VfsResult<()> {
        if self.dirty.is_empty() && self.truncate_from.is_none() {
            // Nothing written; the length may still be news (a file created and synced empty).
            if self.mount.store.size(&self.name).map_err(io)? == Some(self.size) {
                return Ok(());
            }
        }
        let mut sealed = Vec::with_capacity(self.dirty.len());
        for (no, page) in &self.dirty {
            sealed.push((
                *no,
                self.mount.cipher.seal(&self.name, *no, page).map_err(io)?,
            ));
        }
        self.mount
            .store
            .commit(&self.name, self.size, &sealed, self.truncate_from)
            .map_err(io)?;
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        for (no, page) in std::mem::take(&mut self.dirty) {
            cache.put(no, page);
        }
        self.truncate_from = None;
        Ok(())
    }
}

impl VfsFile for PagedFile {
    fn read(&self, buf: &mut [u8], offset: usize) -> VfsResult<bool> {
        let offset = offset as u64;
        let end = offset + buf.len() as u64;
        let available = end.min(self.size);
        let mut at = offset;
        while at < available {
            let no = at / BLOCK as u64;
            let within = (at % BLOCK as u64) as usize;
            let take = ((BLOCK - within) as u64).min(available - at) as usize;
            let page = self.block(no)?;
            let into = (at - offset) as usize;
            buf[into..into + take].copy_from_slice(&page[within..within + take]);
            at += take as u64;
        }
        let filled = (available.saturating_sub(offset) as usize).min(buf.len());
        buf[filled..].fill(0);
        Ok(end <= self.size)
    }

    fn write(&mut self, buf: &[u8], offset: usize) -> VfsResult<()> {
        let offset = offset as u64;
        let end = offset + buf.len() as u64;
        let mut at = offset;
        while at < end {
            let no = at / BLOCK as u64;
            let within = (at % BLOCK as u64) as usize;
            let take = ((BLOCK - within) as u64).min(end - at) as usize;
            let mut page = if within == 0 && take == BLOCK {
                vec![0; BLOCK]
            } else {
                self.block(no)?
            };
            let from = (at - offset) as usize;
            page[within..within + take].copy_from_slice(&buf[from..from + take]);
            self.dirty.insert(no, page);
            at += take as u64;
        }
        self.size = self.size.max(end);
        Ok(())
    }

    fn truncate(&mut self, size: usize) -> VfsResult<()> {
        let size = size as u64;
        if size < self.size {
            // Every block wholly past the new end goes; the block the end falls inside keeps its
            // bytes, which a read past `size` never returns.
            let keep = size.div_ceil(BLOCK as u64);
            self.dirty.retain(|no, _| *no < keep);
            self.cache
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .drop_from(keep);
            self.truncate_from = Some(self.truncate_from.map_or(keep, |t| t.min(keep)));
        }
        self.size = size;
        // **A shrink with nothing dirty is SQLite's last step of a commit**, after its sync
        // (`pager_end_transaction` truncates a file a `VACUUM` shrank and syncs nothing after),
        // so it is stored now rather than with the next transaction. A shrink with pages still
        // dirty is part of a transaction, and waits for that transaction's sync.
        if self.dirty.is_empty() && self.truncate_from.is_some() {
            self.sync()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> VfsResult<()> {
        self.sync()
    }

    fn size(&self) -> VfsResult<usize> {
        Ok(self.size as usize)
    }
}

impl VfsFile for File {
    fn read(&self, buf: &mut [u8], offset: usize) -> VfsResult<bool> {
        match self {
            File::Memory(f) => f.read(buf, offset),
            File::Paged(f) => f.read(buf, offset),
        }
    }

    fn write(&mut self, buf: &[u8], offset: usize) -> VfsResult<()> {
        match self {
            File::Memory(f) => f.write(buf, offset),
            File::Paged(f) => f.write(buf, offset),
        }
    }

    fn truncate(&mut self, size: usize) -> VfsResult<()> {
        match self {
            File::Memory(f) => f.truncate(size),
            File::Paged(f) => f.truncate(size),
        }
    }

    fn flush(&mut self) -> VfsResult<()> {
        match self {
            File::Memory(f) => f.flush(),
            File::Paged(f) => f.flush(),
        }
    }

    fn size(&self) -> VfsResult<usize> {
        match self {
            File::Memory(f) => f.size(),
            File::Paged(f) => f.size(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The VFS, through `rsqlite-vfs`
// ---------------------------------------------------------------------------------------------

struct Store;

impl Registry {
    /// The file SQLite names, loading a stored database the first time it is asked for.
    fn find(&mut self, name: &str) -> VfsResult<Option<&mut File>> {
        let name = &*canonical(name);
        if !self.files.contains_key(name) {
            let Some((mount, relative)) = split(name) else {
                return Ok(None);
            };
            if !persisted(relative) {
                return Ok(None);
            }
            let Some(m) = self.mounts.get(mount).cloned() else {
                return Ok(None);
            };
            let Some(size) = m.store.size(relative).map_err(io)? else {
                return Ok(None);
            };
            self.files.insert(
                name.to_owned(),
                File::Paged(PagedFile::open(m, relative, size)),
            );
        }
        Ok(self.files.get_mut(name))
    }
}

impl VfsStore<File, Mutex<Registry>> for Store {
    fn add_file(vfs: *mut sqlite3_vfs, file: &str, flags: i32) -> VfsResult<()> {
        let _ = flags;
        let file = &*canonical(file);
        let mut reg = registry(vfs);
        let made = match split(file) {
            Some((mount, relative)) if persisted(relative) => {
                let m = reg
                    .mounts
                    .get(mount)
                    .cloned()
                    .ok_or_else(|| io(format!("no storage is mounted for {file}")))?;
                File::Paged(PagedFile::open(m, relative, 0))
            }
            _ => File::Memory(MemChunksFile::default()),
        };
        reg.files.insert(file.to_owned(), made);
        Ok(())
    }

    fn contains_file(vfs: *mut sqlite3_vfs, file: &str) -> VfsResult<bool> {
        Ok(registry(vfs).find(file)?.is_some())
    }

    fn delete_file(vfs: *mut sqlite3_vfs, file: &str) -> VfsResult<()> {
        let file = &*canonical(file);
        let mut reg = registry(vfs);
        let known = reg.find(file)?.is_some();
        match reg.files.remove(file) {
            Some(File::Paged(paged)) => paged
                .mount
                .store
                .remove(&paged.name)
                .map_err(|e| VfsError::new(SQLITE_IOERR_DELETE, e)),
            Some(File::Memory(_)) => Ok(()),
            None if !known => Err(VfsError::new(
                SQLITE_IOERR_DELETE,
                format!("{file} not found"),
            )),
            None => Ok(()),
        }
    }

    fn with_file<F: Fn(&File) -> VfsResult<i32>>(vfs_file: &SQLiteVfsFile, f: F) -> VfsResult<i32> {
        let name = unsafe { vfs_file.name() };
        let mut reg = registry(vfs_file.vfs);
        match reg.find(name)? {
            Some(file) => f(file),
            None => Err(io(format!("{name} not found"))),
        }
    }

    fn with_file_mut<F: Fn(&mut File) -> VfsResult<i32>>(
        vfs_file: &SQLiteVfsFile,
        f: F,
    ) -> VfsResult<i32> {
        let name = unsafe { vfs_file.name() };
        let mut reg = registry(vfs_file.vfs);
        match reg.find(name)? {
            Some(file) => f(file),
            None => Err(io(format!("{name} not found"))),
        }
    }
}

struct IoMethods;

impl SQLiteIoMethods for IoMethods {
    type File = File;
    type AppData = Mutex<Registry>;
    type Store = Store;

    const VERSION: ::core::ffi::c_int = 1;
}

struct Vfs;

impl SQLiteVfs<IoMethods> for Vfs {
    const VERSION: ::core::ffi::c_int = 1;

    /// Nothing waits here: there is one connection, and nothing to wait for.
    fn sleep(_dur: Duration) {}

    fn random(buf: &mut [u8]) {
        // SQLite's randomness seeds temporary names and nothing that is a secret; a failure here
        // leaves the bytes as they were, which is still a name.
        let _ = getrandom::fill(buf);
    }

    fn epoch_timestamp_in_ms() -> i64 {
        grimoire_core::platform::clock::now_ms()
    }
}

#[cfg(test)]
mod tests;
