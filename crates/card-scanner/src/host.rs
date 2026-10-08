//! The one place this crate knows what kind of machine it is on: whether there is a second
//! thread to give, a clock to read, and a panic that can be caught.
//!
//! **The pipeline was written for a desktop and assumed all three.** Five stages fan out under
//! `std::thread::scope`, an Exact resolve runs on a thread of its own, fourteen timings start
//! at `Instant::now()`, and two `catch_unwind`s turn an assertion deep in an image crate into a
//! sentence. A browser's Worker has none of it: it is one thread, `Instant::now()` **panics**
//! on `wasm32-unknown-unknown` — at run time, in a build that compiled without a warning — and
//! the web module is built with `panic = "abort"`, where a panic is a trap and nothing unwinds.
//! So the rest of the crate asks here, and this file answers for the host it finds itself on:
//!
//! | | A host with threads (the desktop, Android) | A host with one (a Worker) |
//! | --- | --- | --- |
//! | [`fan_out`], [`par_map`], [`join`], [`join3`] | scoped threads, as each site always had | the same closures **on the caller**, one after another, in the order written down on each |
//! | [`background`] | a named thread | **run where it stands**, before the call returns |
//! | [`Stopwatch`] | an installed clock, else `Instant` | an installed clock, else **zero** |
//! | [`guard`] | `catch_unwind` | nothing: see below |
//!
//! **Nothing here changes an answer.** The stages a site runs side by side never needed each
//! other's results — that is why they could be threads — so running them in turn gives the same
//! candidates, the same hashes and the same reads, later. The two
//! `tests::…_session_answers_the_same_on_one_thread_as_on_many` hold that: one stream of frames
//! through two sessions, verdict for verdict, in each mode.
//!
//! **The inline order is fixed, and it is one rule: the caller's share first, then every other
//! share in the order it was handed over.** [`fan_out`] gives the caller no share, so it is its
//! items in order; [`par_map`] gives it the first item; [`join`] and [`join3`] give it their
//! first closure. A panic in one share stops the ones after it — with threads they would have
//! run to their ends first — and reaches the caller either way.
//!
//! **A test, or a host, can ask for the one-thread arm on a machine that has many**:
//! [`inline`] answers a guard, and while it lives every helper called *on that thread* runs
//! where it stands. It is per thread and needs to be nothing more: work that is never handed
//! to another thread never leaves the one the guard is on, so the nested sites — a resolve's
//! whole-card search fanning out its hashes, a frame's methods fanning out their masks — find
//! it too. Per thread, and never global, because a test binary runs its tests on many threads
//! and one that made the process a Worker would take the threads from every other.
//!
//! **⚠️ [`guard`] guards nothing where a panic aborts.** With `panic = "abort"` there is no
//! unwinding for `catch_unwind` to stop, so the closure's panic is the end of the instance: in a
//! browser a `RuntimeError: unreachable` thrown out of whichever export was running, with the
//! module's memory left as it was at that instruction. **Containing that is the host's**, and
//! the only containment there is: throw the instance away and make another. What this crate does
//! about it is keep a caller from being able to provoke one — `detect::canny_pair` is that —
//! and neither guard has been reached by an input since.
//!
//! **Only this file names a thread, a clock, an unwind or a target.** `tests::the_fence` reads
//! every other source file's shipped code, at any depth under `src/`, and refuses one that
//! does — or that waits as only a host with a second thread can: a channel's blocking
//! `.recv()`, a `Condvar`, a `Barrier`. `src/bin/` is outside it (the tools are a desktop's),
//! and so is a `#[cfg(test)]` module at the foot of a file.

use std::sync::OnceLock;

/// Whether this target has another thread to give and a clock of its own to read.
///
/// `target_family = "wasm"` and not the one triple the web module is built for: a WASI build
/// has a clock, but no more threads than a Worker, and a zero in a timing is the cheap way to
/// be wrong.
const NATIVE: bool = cfg!(not(target_family = "wasm"));

// ---- Threads ---------------------------------------------------------------------------------

thread_local! {
    /// How many [`Inline`] guards are alive on this thread.
    static INLINED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Whether work handed to a helper here leaves the calling thread.
///
/// Never in a Worker. Natively always, except on a thread holding an [`inline`] guard.
pub fn threads() -> bool {
    NATIVE && INLINED.with(|depth| depth.get() == 0)
}

/// Run every helper here where it stands, **on the calling thread**, until the guard is dropped
/// — what a Worker does, on a machine that could do otherwise.
///
/// Guards nest: the thread has its threads back when the last one goes.
pub fn inline() -> Inline {
    INLINED.with(|depth| depth.set(depth.get() + 1));
    Inline(std::marker::PhantomData)
}

/// [`inline`]'s guard. Not `Send`: it speaks for the thread it was made on, and dropped on
/// another it would give that one's threads back instead.
pub struct Inline(std::marker::PhantomData<*const ()>);

impl Drop for Inline {
    fn drop(&mut self) {
        INLINED.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// A worker's answer, with its panic carried on to the caller rather than swallowed: the
/// session's [`guard`] then reports the failure it is, exactly as when the work ran inline.
fn joined<T>(handle: std::thread::ScopedJoinHandle<'_, T>) -> T {
    handle.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// `items.iter().map(f)`, **every item on a thread of its own** when there is more than one,
/// answered in `items`' order. The caller only waits.
///
/// Inline: the items in order. What a frame's detector methods and a method's masks run under.
pub fn fan_out<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    if items.len() < 2 || !threads() {
        return items.iter().map(f).collect();
    }
    let f = &f;
    std::thread::scope(|s| {
        let spawned: Vec<_> = items.iter().map(|item| s.spawn(move || f(item))).collect();
        spawned.into_iter().map(joined).collect()
    })
}

/// `items.iter().map(f)`, **the first item on the caller and each of the rest on a thread of
/// its own**, answered in `items`' order.
///
/// Inline: the items in order. What the matcher hashes and searches a frame's picks under.
pub fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let Some((first, rest)) = items.split_first() else {
        return Vec::new();
    };
    if rest.is_empty() || !threads() {
        return items.iter().map(f).collect();
    }
    let f = &f;
    std::thread::scope(|s| {
        let spawned: Vec<_> = rest.iter().map(|item| s.spawn(move || f(item))).collect();
        let mut out = Vec::with_capacity(items.len());
        out.push(f(first));
        out.extend(spawned.into_iter().map(joined));
        out
    })
}

/// `here` on the caller and `there` on a thread of its own, at once.
///
/// Inline: `here`, then `there`. What a Fast frame's two reads run under.
pub fn join<A, B: Send>(here: impl FnOnce() -> A, there: impl FnOnce() -> B + Send) -> (A, B) {
    if !threads() {
        let a = here();
        return (a, there());
    }
    std::thread::scope(|s| {
        let there = s.spawn(there);
        let a = here();
        (a, joined(there))
    })
}

/// [`join`] with a third: `here` on the caller, `there` and `also` each on a thread of its own.
///
/// Inline: `here`, `there`, `also`. What an Exact resolve's search and two reads run under.
pub fn join3<A, B: Send, C: Send>(
    here: impl FnOnce() -> A,
    there: impl FnOnce() -> B + Send,
    also: impl FnOnce() -> C + Send,
) -> (A, B, C) {
    if !threads() {
        let a = here();
        let b = there();
        return (a, b, also());
    }
    std::thread::scope(|s| {
        let there = s.spawn(there);
        let also = s.spawn(also);
        let a = here();
        (a, joined(there), joined(also))
    })
}

/// Run `job` off the caller, on a thread called `name` — or **where it stands, to its end,
/// before this returns**, on a host with no thread to give.
///
/// That second arm is why a caller must not wait on the job from the thread that started it:
/// a Worker that sat on a spawn which cannot happen would sit for ever. `Session::start_resolve`
/// hands its answer across a channel and polls it, which reads the same either way — full at
/// the first poll here, full some frames later there.
///
/// A thread the operating system refuses drops `job` unrun, and everything it owned with it;
/// the session's channel closing is how that is noticed.
pub fn background(name: &str, job: impl FnOnce() + Send + 'static) {
    if !threads() {
        return job();
    }
    let _ = std::thread::Builder::new().name(name.into()).spawn(job);
}

// ---- The panic guard --------------------------------------------------------------------------

/// What [`guard`] answers: the body's value, or the panic it ended in.
pub type Caught<T> = Result<T, Box<dyn std::any::Any + Send + 'static>>;

/// Run `body`, and answer a panic inside it as a value instead of unwinding through the caller.
///
/// `AssertUnwindSafe`, because both callers throw away what the body was working on: a frame's
/// verdict, a resolve's burst.
///
/// **On a host where a panic aborts this is `Ok(body())` and nothing else** — see the module
/// doc. It is still called there, so the code that reads its answer is the same on every host.
pub fn guard<T>(body: impl FnOnce() -> T) -> Caught<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body))
}

// ---- The clock --------------------------------------------------------------------------------

/// The host's clock, when it has said it has one: milliseconds on something monotonic, from
/// any origin.
static CLOCK: OnceLock<fn() -> f64> = OnceLock::new();

/// Hand the crate a clock: `now_ms` answers milliseconds, monotonic, from whatever origin the
/// host likes — `performance.now()` is one. Once per process; a second word is ignored.
///
/// **Only ever for telemetry.** Every reading ends in an `_ms` field of a verdict, and nothing
/// in the crate paces, bounds or orders anything by one — which is why a host that installs
/// none still scans, with its timings at zero.
pub fn set_clock(now_ms: fn() -> f64) {
    let _ = CLOCK.set(now_ms);
}

/// A moment to measure a stage from. **An installed clock wins; otherwise `Instant` where the
/// target has one; otherwise every reading is zero** — and none of the three can panic.
#[derive(Debug, Clone, Copy)]
pub struct Stopwatch(Started);

#[derive(Debug, Clone, Copy)]
enum Started {
    /// A reading of the host's clock, kept with the clock that gave it.
    Host(f64, fn() -> f64),
    Own(std::time::Instant),
    /// No clock at all.
    Never,
}

impl Stopwatch {
    pub fn start() -> Stopwatch {
        Stopwatch::on(CLOCK.get().copied(), NATIVE)
    }

    /// [`Stopwatch::start`], told which clocks there are — the seam its tests come in by.
    fn on(host: Option<fn() -> f64>, own: bool) -> Stopwatch {
        Stopwatch(match host {
            Some(now) => Started::Host(now(), now),
            None if own => Started::Own(std::time::Instant::now()),
            None => Started::Never,
        })
    }

    /// Milliseconds since [`Stopwatch::start`]. Never negative and never not a number, whatever
    /// the host's clock answered.
    pub fn ms(&self) -> f32 {
        match self.0 {
            Started::Host(at, now) => {
                let span = now() - at;
                if span.is_finite() && span > 0.0 {
                    span as f32
                } else {
                    0.0
                }
            }
            Started::Own(at) => at.elapsed().as_secs_f32() * 1000.0,
            Started::Never => 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::thread::ThreadId;

    fn here() -> ThreadId {
        std::thread::current().id()
    }

    /// Every helper, with its work recording the thread it ran on.
    fn threads_used(run: impl FnOnce(&(dyn Fn() + Sync))) -> HashSet<ThreadId> {
        let seen = Mutex::new(HashSet::new());
        run(&|| {
            seen.lock().unwrap().insert(here());
        });
        seen.into_inner().unwrap()
    }

    #[test]
    fn the_helpers_keep_order_with_threads_and_without() {
        let check = || {
            assert_eq!(fan_out(&[1, 2, 3, 4, 5, 6], |x| x * 10), vec![10, 20, 30, 40, 50, 60]);
            assert_eq!(fan_out(&[7], |x| x + 1), vec![8]);
            assert!(fan_out(&[] as &[u8], |x| *x).is_empty());
            assert_eq!(par_map(&[1, 2, 3, 4, 5, 6], |x| x * 10), vec![10, 20, 30, 40, 50, 60]);
            assert_eq!(par_map(&[7], |x| x + 1), vec![8]);
            assert!(par_map(&[] as &[u8], |x| *x).is_empty());
            assert_eq!(join(|| "here", || 2), ("here", 2));
            assert_eq!(join3(|| "here", || 2, || 3.0), ("here", 2, 3.0));
        };
        assert!(threads(), "a test thread has threads until it says otherwise");
        check();
        let _one = inline();
        assert!(!threads());
        check();
    }

    /// The thread structure each site had before it moved here: `fan_out` leaves the caller
    /// idle, the other three give it the first share — and under [`inline`] nothing leaves it.
    #[test]
    fn each_helper_uses_the_threads_it_says_and_none_under_the_guard() {
        let me = here();
        let all = threads_used(|mark| drop(fan_out(&[0, 1, 2], |_| mark())));
        assert_eq!(all.len(), 3, "one thread an item");
        assert!(!all.contains(&me), "`fan_out` ran an item on the caller");

        let mapped = threads_used(|mark| drop(par_map(&[0, 1, 2], |_| mark())));
        assert_eq!(mapped.len(), 3);
        assert!(mapped.contains(&me), "`par_map`'s first item left the caller");

        let pair = threads_used(|mark| (join(mark, mark), ()).1);
        assert!(pair.len() == 2 && pair.contains(&me));
        let three = threads_used(|mark| (join3(mark, mark, mark), ()).1);
        assert!(three.len() == 3 && three.contains(&me));

        let (tx, rx) = std::sync::mpsc::channel();
        background("a-test-job", move || {
            let named = std::thread::current().name().map(String::from);
            let _ = tx.send((here(), named));
        });
        let (ran_on, named) = rx.recv().expect("the job never ran");
        assert_ne!(ran_on, me);
        assert_eq!(named.as_deref(), Some("a-test-job"));

        let _one = inline();
        let only = HashSet::from([me]);
        assert_eq!(threads_used(|mark| drop(fan_out(&[0, 1, 2], |_| mark()))), only);
        assert_eq!(threads_used(|mark| drop(par_map(&[0, 1, 2], |_| mark()))), only);
        assert_eq!(threads_used(|mark| (join(mark, mark), ()).1), only);
        assert_eq!(threads_used(|mark| (join3(mark, mark, mark), ()).1), only);
        let (tx, rx) = std::sync::mpsc::channel();
        background("a-test-job", move || {
            let _ = tx.send(here());
        });
        // `try_recv`, not `recv`: the job has run to its end before `background` returned.
        assert_eq!(rx.try_recv(), Ok(me));
    }

    /// The order a Worker runs each site's work in — the caller's share, then the rest as
    /// handed over.
    #[test]
    fn the_inline_order_is_the_callers_share_then_the_rest_as_written() {
        let _one = inline();
        let order = Mutex::new(Vec::new());
        let step = |n: u8| order.lock().unwrap().push(n);
        fan_out(&[1, 2, 3], |&n| step(n));
        par_map(&[4, 5, 6], |&n| step(n));
        join(|| step(7), || step(8));
        join3(|| step(9), || step(10), || step(11));
        assert_eq!(*order.lock().unwrap(), (1..=11).collect::<Vec<u8>>());
    }

    #[test]
    fn the_guard_nests_and_is_one_threads_business() {
        let outer = inline();
        let inner = inline();
        drop(inner);
        assert!(!threads(), "the inner guard took the outer one's word with it");
        // Another thread never heard of this one's guard.
        assert!(std::thread::spawn(threads).join().unwrap());
        drop(outer);
        assert!(threads());
    }

    /// A worker's panic reaches the caller from every helper, on either arm — which is what
    /// lets one [`guard`] at the top of a frame answer for every thread under it.
    #[test]
    fn a_panic_in_any_share_is_reraised_on_the_caller() {
        let boom = |x: &i32| if *x == 3 { panic!("a spawned item panicked") } else { *x };
        let all = || {
            assert!(guard(|| fan_out(&[1, 2, 3], boom)).is_err(), "fan_out swallowed it");
            assert!(guard(|| par_map(&[1, 2, 3], boom)).is_err(), "par_map swallowed it");
            assert!(guard(|| join(|| 1, || boom(&3))).is_err(), "join swallowed it");
            assert!(guard(|| join3(|| 1, || 2, || boom(&3))).is_err(), "join3 swallowed it");
            assert!(guard(|| join3(|| boom(&3), || 2, || 3)).is_err());
        };
        all();
        let _one = inline();
        all();
        assert_eq!(guard(|| 5).ok(), Some(5));
    }

    thread_local! {
        /// A clock a test moves by hand, on its own thread.
        static FAKE_MS: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
    }

    fn fake_now() -> f64 {
        FAKE_MS.with(|ms| ms.get())
    }

    #[test]
    fn a_stopwatch_reads_the_hosts_clock_before_its_own_and_zero_with_neither() {
        // A host's clock, from an origin of its own.
        FAKE_MS.with(|ms| ms.set(5_000.0));
        let hosted = Stopwatch::on(Some(fake_now), true);
        assert_eq!(hosted.ms(), 0.0);
        FAKE_MS.with(|ms| ms.set(5_012.5));
        assert_eq!(hosted.ms(), 12.5, "the installed clock did not win over `Instant`");
        // A clock that ran backwards, or answered nonsense, is no time at all.
        FAKE_MS.with(|ms| ms.set(4_000.0));
        assert_eq!(hosted.ms(), 0.0);
        FAKE_MS.with(|ms| ms.set(f64::NAN));
        assert_eq!(hosted.ms(), 0.0);

        // The target's own. **Half the sleep, and only ever a lower bound**: a loaded machine
        // can make a sleep as long as it likes, and Windows has been seen to end one a fraction
        // of a tick early by the clock `Instant` reads — neither is this test's business.
        let own = Stopwatch::on(None, true);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let first = own.ms();
        assert!(first >= 10.0, "a 20 ms sleep measured as {first}");
        assert!(own.ms() >= first);

        // Neither — a Worker nobody handed a clock. Zero, and above all no panic.
        let none = Stopwatch::on(None, false);
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert_eq!(none.ms(), 0.0);
    }

    /// A real clock, counted — so installing it for the whole test binary changes no other
    /// test's timings, and this one can still tell it was asked.
    static ASKED: AtomicUsize = AtomicUsize::new(0);

    fn counted_now() -> f64 {
        static ORIGIN: OnceLock<std::time::Instant> = OnceLock::new();
        ASKED.fetch_add(1, Ordering::Relaxed);
        ORIGIN.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1000.0
    }

    #[test]
    fn an_installed_clock_is_the_one_every_stopwatch_reads() {
        set_clock(counted_now);
        // The second word is ignored: a clock swapped under a running stopwatch would measure
        // from one origin to another.
        set_clock(fake_now);
        let before = ASKED.load(Ordering::Relaxed);
        let watch = Stopwatch::start();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let waited = watch.ms();
        assert!(waited >= 10.0, "a 20 ms sleep measured as {waited}");
        assert!(ASKED.load(Ordering::Relaxed) >= before + 2, "start and ms each ask the host");
    }

    // ---- One thread or many -------------------------------------------------------------------

    use crate::session::{FrameOptions, ResolveOn, ScanMode, Session, Verdict};
    use image::RgbImage;

    /// The banded card, face on, `w` wide: a dark border round light title, art, type and text
    /// bands — the horizontal structure card-likeness scores.
    fn banded(w: u32, h: u32) -> RgbImage {
        let border = 11 * w / 250;
        RgbImage::from_fn(w, h, |x, y| {
            if x < border || y < border || x >= w - border || y >= h - border {
                return image::Rgb([16, 16, 18]);
            }
            let v = match y as f32 / h as f32 {
                t if t < 0.10 => 238,
                t if t < 0.55 => 150,
                t if t < 0.62 => 238,
                t if t < 0.92 => 205,
                _ => 140,
            };
            image::Rgb([v, v, v])
        })
    }

    /// A 960×540 JPEG of that card on a flat grey table, `dx` pixels right of centre — the
    /// session tests' own fixture, drawn again here so this file needs nothing private of
    /// theirs. A pixel or two of movement a frame keeps the lock's smoothed quad apart from
    /// the raw one.
    fn card_frame_jpeg(dx: u32) -> Vec<u8> {
        let card = banded(250, 349);
        let (x0, y0) = (355 + dx, 95u32);
        let mut frame = RgbImage::from_pixel(960, 540, image::Rgb([96, 100, 104]));
        image::imageops::replace(&mut frame, &card, i64::from(x0), i64::from(y0));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
            .encode_image(&frame)
            .expect("encode");
        out
    }

    fn id(n: u8) -> [u8; crate::index::ID_LEN] {
        let mut raw = [0u8; crate::index::ID_LEN];
        raw[0] = n;
        raw
    }

    /// A reference that knows the banded card among two it does not: its negative, and a
    /// gradient. In colour, so a frame's match weighs chroma as the app's does.
    fn knows_the_banded_card() -> crate::reference::Reference {
        use crate::hash::{hash_rgb, HashKind};
        use crate::index::{BundleBuilder, Section};
        let kind = HashKind::DHashChroma32;
        let face = banded(crate::RECTIFIED_W, crate::RECTIFIED_H);
        let negative = RgbImage::from_fn(face.width(), face.height(), |x, y| {
            let p = face.get_pixel(x, y).0;
            image::Rgb([255 - p[0], 255 - p[1], 255 - p[2]])
        });
        let gradient =
            RgbImage::from_fn(60, 84, |x, y| image::Rgb([((x * 3 + y) % 256) as u8; 3]));
        let mut b = BundleBuilder::new(kind, 256);
        for (n, image) in [(1u8, &face), (2, &negative), (3, &gradient)] {
            b.push(Section::Card, id(n), &hash_rgb(image, kind, 256));
        }
        let mut r = crate::reference::Reference::new(b.finish(0));
        for (n, oracle) in [(1u8, 10u8), (2, 20), (3, 30)] {
            let label = crate::reference::Label {
                name: format!("Card {oracle}"),
                set: "hob".into(),
                number: n.to_string(),
                lang: "en".into(),
                released: "2025-01-01".into(),
            };
            r.add_label(id(n), Some(id(oracle)), None, label);
        }
        r
    }

    /// A verdict as JSON without what a clock put in it: every `…_ms` key, at any depth.
    fn without_timings(v: &Verdict) -> serde_json::Value {
        fn strip(value: &mut serde_json::Value) {
            match value {
                serde_json::Value::Object(map) => {
                    map.retain(|key, _| !key.ends_with("_ms"));
                    map.values_mut().for_each(strip);
                }
                serde_json::Value::Array(items) => items.iter_mut().for_each(strip),
                _ => {}
            }
        }
        let mut json = serde_json::to_value(v).expect("serialise");
        strip(&mut json);
        json
    }

    /// **A host with one thread answers what a host with many does** — the whole of what this
    /// module promises. The same frames go through a session whose sites fan out and through
    /// one under [`inline`], where each runs where it stands, and every verdict has to be the
    /// same but for its timings: the quad, the lock, the candidates and their distances, the
    /// tally, the resolution's tiers, the decision and its frame.
    ///
    /// **Four of the six sites, and the two reads of none.** These sessions have no readers —
    /// no model is in the tree — so what runs both ways here is a frame's detectors and a
    /// detector's masks ([`fan_out`], twice over), a frame's hashes and searches
    /// ([`par_map`]), a resolve's whole-card search ([`join3`], whose two reads are
    /// `NoReaders` and answer at once) and the resolve itself ([`background`], on its inline
    /// arm). **`session::fast_reads`' [`join`] never runs**, and neither does a real read
    /// beside a search. What holds those is the helpers' own tests above — the threads each
    /// uses, the order each keeps, the panic each carries — and, with the published models,
    /// the frame bench (`pnpm scanner:bench --native`), which fails when the hosts
    /// disagree about a decision or a read and which CI, having no models, does not run.
    ///
    /// **The threaded session resolves inline and the inline one in the "background".** A real
    /// background resolve lands on whichever frame follows it, which is the clock's business
    /// (`session::tests::a_background_resolve_decides_on_a_later_frame_and_only_once`), so the
    /// first is told to resolve inside its frame — and the second is left at the app's
    /// default, which is how this also holds that a host with no thread to give resolves
    /// inside the frame rather than waiting on a thread it will never get.
    ///
    /// A bar of four votes, so Fast decides inside `frames`: three to lock, then the votes. A
    /// debug build spends about a second on each frame, which is why each mode is a test of
    /// its own — the harness runs the two side by side.
    fn one_thread_answers_as_many_do(mode: ScanMode, frames: u32) -> Vec<Verdict> {
        assert!(threads(), "the premise: this thread has threads to compare against");
        let frames: Vec<Vec<u8>> = (0..frames).map(|i| card_frame_jpeg(i % 3)).collect();
        let opts = FrameOptions { mode, previews: true, decide_at: 4.0, ..Default::default() };
        assert_eq!(opts.method.as_str(), "both", "two methods, so the sweep fans out");

        let mut threaded = Session::new(Some(knows_the_banded_card()), None, 5);
        threaded.set_resolve_on(ResolveOn::Inline);
        let many: Vec<Verdict> = frames.iter().map(|f| threaded.frame(f, &opts)).collect();

        let one: Vec<Verdict> = {
            let _one_thread = inline();
            // Left at `ResolveOn::Background`, the default: what the app runs.
            let mut s = Session::new(Some(knows_the_banded_card()), None, 5);
            let seen = frames.iter().map(|f| s.frame(f, &opts)).collect();
            assert!(!s.resolving(), "a resolve was left waiting on a thread");
            seen
        };

        for (i, (a, b)) in many.iter().zip(&one).enumerate() {
            assert_eq!(
                without_timings(a),
                without_timings(b),
                "frame {i} in {mode:?} differs between many threads and one"
            );
        }
        // The premise: the stream reached the matcher, more than one pick at a time, and a
        // decision — or the two runs agreed about nothing much.
        let last = many.last().expect("frames");
        assert!(last.ok, "{:?}", last.error);
        assert!(
            many.iter().any(|v| v.r#match.as_ref().is_some_and(|m| m.hashes > 1)),
            "no frame hashed more than one view, so `par_map` never fanned out"
        );
        assert_eq!(last.decision_seq, 1, "the card was never decided in {mode:?}");
        let named = last.decision.as_ref().map(|d| d.printing.clone());
        assert_eq!(named, Some(crate::index::format_uuid(&id(1))));
        many
    }

    #[test]
    fn a_fast_session_answers_the_same_on_one_thread_as_on_many() {
        one_thread_answers_as_many_do(ScanMode::Fast, 9);
    }

    #[test]
    fn an_exact_session_answers_the_same_on_one_thread_as_on_many() {
        let seen = one_thread_answers_as_many_do(ScanMode::Exact, 7);
        let resolved = seen.iter().filter(|v| v.resolution.is_some()).count();
        assert_eq!(resolved, 1, "Exact resolved {resolved} times");
    }

    // ---- The fence ----------------------------------------------------------------------------

    /// What only this file may spell, on a code line of any other, as whole words. The last
    /// two are not a thread or a clock but what one waits on: a `Condvar` and a `Barrier` are
    /// each a wait for another thread, which on a host with one is a wait for ever.
    const WORDS: [&str; 7] = [
        "Instant",
        "SystemTime",
        "UNIX_EPOCH",
        "catch_unwind",
        "resume_unwind",
        "Condvar",
        "Barrier",
    ];
    /// And as written: `thread::` is the module however it was imported (`thread_local!` is not
    /// it, and is fine — a Worker has thread-locals). `.recv()` is a channel's blocking read —
    /// the same wait for ever; `try_recv`, which the session polls with, is another word.
    const SPELLINGS: [&str; 3] = ["std::thread", "thread::", ".recv()"];
    /// The three spellings of a conditional-compilation gate. One that names a target —
    /// `target_…`, or the bare `windows`, `unix` and `wasm` — is refused.
    const GATES: [&str; 3] = ["cfg(", "cfg!(", "cfg_attr("];
    const BARE_TARGETS: [&str; 3] = ["windows", "unix", "wasm"];

    fn has_word(line: &str, word: &str) -> bool {
        let is_word = |c: char| c.is_alphanumeric() || c == '_';
        line.match_indices(word).any(|(at, _)| {
            !line[..at].chars().next_back().is_some_and(is_word)
                && !line[at + word.len()..].chars().next().is_some_and(is_word)
        })
    }

    /// The word or spelling one code line names, if it names one.
    fn names(line: &str) -> Option<String> {
        if let Some(word) = WORDS.iter().find(|w| has_word(line, w)) {
            return Some(format!("`{word}`"));
        }
        SPELLINGS.iter().find(|s| line.contains(**s)).map(|s| format!("`{s}`"))
    }

    /// Whether `text` — a gate, whole — is a `cfg` that names a target.
    fn gates_a_target(text: &str) -> bool {
        GATES.iter().any(|g| text.contains(g))
            && (text.contains("target_") || BARE_TARGETS.iter().any(|t| has_word(text, t)))
    }

    /// The code line at `at`, **with the lines after it joined on while a gate it opens is
    /// still open**: rustfmt breaks a long `#[cfg(any(…))]` one key a line, and read a line at
    /// a time the line that says `cfg(` names no target and the line that names one says no
    /// `cfg(`. Parentheses are counted over the whole line, so a gate sharing a line with an
    /// open call joins too much — the cheap direction.
    fn statement(code: &[(usize, &str)], at: usize) -> String {
        let open = |text: &str| text.matches('(').count() > text.matches(')').count();
        let mut text = code[at].1.to_string();
        let mut next = at + 1;
        while GATES.iter().any(|g| text.contains(g)) && open(&text) && next < code.len() {
            text.push(' ');
            text.push_str(code[next].1.trim());
            next += 1;
        }
        text
    }

    /// What one code line breaks, if anything — the line itself for a word, the whole gate for
    /// a target.
    fn broken(code: &[(usize, &str)], at: usize) -> Option<String> {
        names(code[at].1).or_else(|| {
            gates_a_target(&statement(code, at)).then(|| "a `cfg` that names a target".to_string())
        })
    }

    /// A file as the sweep reads it.
    struct Shipped<'a> {
        /// Its shipped code: the lines above the cut, numbered, without the comment lines.
        code: Vec<(usize, &'a str)>,
        /// The first line of code **below** the module the cut was made at, if there is any.
        below: Option<(usize, &'a str)>,
    }

    /// A file's shipped code: its lines up to the first column-0 `#[cfg(test)]` **that gates a
    /// module**, without the lines that are comments. `detect.rs` gates a `thread_local!` and
    /// two helpers far above its tests; cutting at the first gate would leave everything below
    /// them unread, so a single gated item is read as shipped — refusing too much is the cheap
    /// direction.
    ///
    /// **The cut module has to be the last thing in the file**, and `below` is how the sweep
    /// holds a file to it: a `#[cfg(test)] mod helpers { … }` half-way down would otherwise hide
    /// every shipped line under it. The module ends at its own `;` or at the first column-0
    /// `}` after it — every file here closes its test module there.
    fn shipped(source: &str) -> Shipped<'_> {
        let lines: Vec<&str> = source.lines().collect();
        let is_code = |l: &&str| !l.trim().is_empty() && !l.trim_start().starts_with("//");
        // The item a gate at `i` is on: the next line that is neither blank nor an attribute.
        let gated = |i: usize| {
            let item = |l: &&str| !l.trim().is_empty() && !l.starts_with("#[");
            lines[i + 1..].iter().position(item).map(|n| i + 1 + n)
        };
        let cut = (0..lines.len()).find_map(|i| {
            let module = gated(i).filter(|_| lines[i] == "#[cfg(test)]")?;
            let named = lines[module];
            (named.starts_with("mod ") || named.starts_with("pub mod ")).then_some((i, module))
        });
        let (end, below) = match cut {
            None => (lines.len(), None),
            Some((gate, module)) => {
                let close = if lines[module].trim_end().ends_with(';') {
                    Some(module)
                } else {
                    (module..lines.len()).find(|&i| lines[i] == "}")
                };
                let below = close
                    .and_then(|close| (close + 1..lines.len()).find(|&i| is_code(&lines[i])))
                    .map(|i| (i + 1, lines[i]));
                (gate, below)
            }
        };
        let code = lines[..end]
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.trim_start().starts_with("//"))
            .map(|(i, l)| (i + 1, *l))
            .collect();
        Shipped { code, below }
    }

    /// Every `.rs` file under `dir`, **at any depth** — a module that grows into a folder is
    /// still the library — but for the two the fence is not about: this file, and `src/bin/`,
    /// the tools, which a browser never runs.
    fn sources(dir: &std::path::Path, top: bool, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("a source directory") {
            let path = entry.expect("an entry").path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if path.is_dir() {
                if !(top && name == "bin") {
                    sources(&path, false, out);
                }
            } else if path.extension().is_some_and(|e| e == "rs") && !(top && name == "host.rs") {
                out.push(path);
            }
        }
    }

    /// **Nothing in this crate's shipped library names a thread, a clock, an unwind or a target
    /// outside this file** — or waits the way only a host with a second thread can afford to.
    /// Each compiles on a desktop wherever it is written, and each is a trap or a hang in a
    /// Worker at run time — which is exactly why a compiler cannot be the fence.
    #[test]
    fn the_fence() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        sources(&root.join("src"), true, &mut files);
        files.sort();
        let mut found = Vec::new();
        for path in &files {
            let name = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
            let source = std::fs::read_to_string(path).expect("a source file");
            let read = shipped(&source);
            for at in 0..read.code.len() {
                if let Some(what) = broken(&read.code, at) {
                    let (n, line) = read.code[at];
                    found.push(format!("{name}:{n} names {what}: {}", line.trim()));
                }
            }
            if let Some((n, line)) = read.below {
                found.push(format!(
                    "{name}:{n} is code below a `#[cfg(test)]` module, where this sweep stops \
                     reading — move the module to the foot of the file: {}",
                    line.trim()
                ));
            }
        }
        // A sweep that read nothing passes everything.
        let read = files.len();
        assert!(read >= 16, "the fence read {read} files — `src/` has moved, or the walk broke");
        assert!(
            found.is_empty(),
            "only `host.rs` may know the machine it is on — ask it instead:\n{}",
            found.join("\n")
        );
    }

    /// The sweep refuses what it is for and lets through what it must — a fence that could not
    /// go red would look exactly like one that had nothing to find.
    #[test]
    fn the_fence_refuses_each_spelling_and_reads_past_a_gated_item() {
        let refused = |line: &str| broken(&[(1, line)], 0);
        for line in [
            "let t = std::time::Instant::now();",
            "use std::time::{Duration, Instant};",
            "let at = SystemTime::now();",
            "std::thread::scope(|s| {",
            "thread::spawn(job);",
            "match std::panic::catch_unwind(|| body()) {",
            "h.join().unwrap_or_else(|e| std::panic::resume_unwind(e))",
            "#[cfg(target_family = \"wasm\")]",
            "if cfg!(target_arch = \"wasm32\") {",
            "#[cfg_attr(not(windows), allow(dead_code))]",
            "#[cfg(unix)]",
            "let answer = rx.recv().ok();",
            "let ready = (Mutex::new(false), Condvar::new());",
            "let gate = std::sync::Barrier::new(2);",
        ] {
            assert!(refused(line).is_some(), "let through: {line}");
        }
        for line in [
            "thread_local! {",
            "let instants = slice.windows(2);",
            "#[cfg(feature = \"ocr\")]",
            "#[cfg_attr(not(feature = \"corpus\"), allow(dead_code))]",
            "let watch = crate::host::Stopwatch::start();",
            "pub struct InstantReplay;",
            "let result = match rx.try_recv() {",
            "let met = waits.recv_timeout(WAIT).is_ok();",
            "struct BarrierIsland;",
        ] {
            assert_eq!(refused(line), None, "refused: {line}");
        }

        // A gate rustfmt broke across lines is one gate: refused where it opens, and the lines
        // it runs over are not a second finding each.
        let split = [
            (1, "#[cfg(any("),
            (2, "    target_os = \"windows\","),
            (3, "    feature = \"ocr\","),
            (4, "))]"),
            (5, "fn gated() {}"),
        ];
        let hits: Vec<usize> =
            (0..split.len()).filter(|&at| broken(&split, at).is_some()).collect();
        assert_eq!(hits, [0], "a gate over four lines");
        let features =
            [(1, "#[cfg(any("), (2, "    feature = \"ocr\","), (3, "))]"), (4, "#[cfg(unix)]")];
        assert_eq!(broken(&features, 0), None, "a split gate ran on into the next one");

        // A gated item above the tests is read as shipped; the cut is the module's gate.
        let file = "fn a() {}\n// Instant::now() is why\n#[cfg(test)]\nthread_local! {}\n\
                    fn b() {}\n#[cfg(test)]\nmod tests {\n    use std::time::Instant;\n}\n\n\
                    // The foot of the file.\n";
        let read = shipped(file);
        let lines: Vec<&str> = read.code.iter().map(|(_, l)| *l).collect();
        assert_eq!(lines, ["fn a() {}", "#[cfg(test)]", "thread_local! {}", "fn b() {}"]);
        assert_eq!(read.below, None, "a comment under the tests is not code");

        // A test module that is not the last thing in the file hides what is under it.
        let hidden = "fn a() {}\n#[cfg(test)]\nmod helpers {\n    fn h() {}\n}\n\n\
                      fn unread() -> std::time::Instant {\n    todo!()\n}\n";
        assert_eq!(shipped(hidden).below, Some((7, "fn unread() -> std::time::Instant {")));
        let declared = "fn a() {}\n#[cfg(test)]\nmod fixtures;\nfn unread() {}\n";
        assert_eq!(shipped(declared).below, Some((4, "fn unread() {}")));
    }
}
