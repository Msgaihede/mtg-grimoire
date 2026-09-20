//! What size the window opens at.
//!
//! `tauri.conf.json` can name exactly one size, and this app is portable: the same exe runs
//! off a stick on a 4K desk and on a 1080p laptop. 1920×1080 is the size to want — the
//! ribbon draws on one line from 1600 up, against two below it — and it is also the one size
//! a 1920×1080 monitor cannot actually give. Windows keeps a taskbar, so the work area on
//! that desk is 1920×1032, and a 1080-tall window puts its bottom edge — the deck editor's
//! row of actions — behind it, on the commonest desk there is.
//!
//! So the config declares the top rung and this picks the largest one the **work area**
//! holds. Nothing here is remembered between launches: the app registers no window-state
//! plugin, so this runs on every start, and a window the reader resized is theirs only until
//! they close it.
//!
//! **And every window after the first is opened here too** — [`open_new`], behind both a
//! relaunch and Ctrl+Shift+N. It takes the same rungs on the monitor of the window it came from
//! and opens [`OFFSET`] down and right of it, by [`cascade`].

use tauri::Manager;

/// The sizes the window may open at, largest first.
///
/// Two rungs rather than a formula, because the interesting widths are not a continuum: the
/// ribbon wraps to two lines below 1600 and draws on one at or above it, so 1920 and 1280
/// are the two layouts the app actually has. A rung is taken only when the work area holds
/// **both** of its axes — a 1920×1200 monitor takes the top rung (work area 1920×1152) and a
/// 1920×1080 one does not.
const LADDER: [(f64, f64); 2] = [(1920.0, 1080.0), (1280.0, 720.0)];

/// The floor, and the same two numbers `tauri.conf.json` sets as `minWidth`/`minHeight` —
/// pinned against it by `the_config_declares_the_top_rung_and_this_floor`. Below the bottom
/// rung there is nothing left to choose: the window takes the work area, and this is where it
/// stops shrinking. Tauri enforces the constraint itself, so a smaller number here would not
/// produce a smaller window — only a size the OS then silently disagrees with.
const MIN: (f64, f64) = (1024.0, 700.0);

/// What Windows draws *around* the size we ask for, and the reason a rung is not compared
/// against the work area directly. `set_size` sets the **client** area — the webview — and the
/// frame is added outside it.
///
/// **It was `(16.0, 39.0)` until the app took its own title bar** (2026-08-20). That 39 was 9px
/// of border plus the 30px caption Windows drew, measured live at a frame of 1936×1119 around a
/// 1920×1080 client. `tauri.conf.json` now sets `decorations: false` and
/// `src/components/TitleBar.tsx` draws the caption *inside* the client area, so the OS adds no
/// caption and the frame is border only: measured the same way on the same day, a **1280×800**
/// client reported a window rect of **1296×809** — 8px of invisible grab margin per side and 9px
/// below, which is also what makes the undecorated window resizable from its edges.
///
/// **Nothing went red when this became wrong, and that is worth knowing.** Every test below
/// still passes at either value, because in each of them it is the *width* that decides and the
/// width did not change. Left at 39 the app would simply have reserved 30px that no longer
/// exists and dropped to a lower rung on a desk that could hold the higher one.
const CHROME: (f64, f64) = (16.0, 9.0);

/// The logical size to open the **client** area at, on a desk whose work area is `work_area`
/// logical pixels.
///
/// Logical, not physical: at 150% scaling a 1920×1080 monitor's work area is 1280×688, and the
/// rung that fits it is the one that fits *those* numbers.
pub fn opening_size(work_area: (f64, f64)) -> (f64, f64) {
    let room = (work_area.0 - CHROME.0, work_area.1 - CHROME.1);
    for (width, height) in LADDER {
        if room.0 >= width && room.1 >= height {
            return (width, height);
        }
    }
    (room.0.max(MIN.0), room.1.max(MIN.1))
}

/// Every window after the first is `window-2`, `window-3`, … — the prefix
/// `capabilities/desktop.json` grants as `window-*`, which a test pins against this constant.
pub const LABEL_PREFIX: &str = "window-";

/// How far down and right of the window it came from a new one opens, in logical pixels — enough
/// to see that there are two, the way Windows cascades.
pub const OFFSET: f64 = 32.0;

/// The next label's number. `main` is the first window, so counting starts at two; a closed
/// window's number is never reused.
static NEXT_LABEL: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(2);

/// Where a new window's top-left goes, in logical pixels: [`OFFSET`] down and right of `from`,
/// except on an axis where the frame would leave the work area — there it starts again at that
/// axis's edge.
pub fn cascade(
    from: (f64, f64),
    size: (f64, f64),
    area_origin: (f64, f64),
    area_size: (f64, f64),
) -> (f64, f64) {
    let fit = |start: f64, len: f64, origin: f64, room: f64| {
        let wanted = start + OFFSET;
        if wanted + len > origin + room {
            origin
        } else {
            wanted.max(origin)
        }
    };
    (
        fit(from.0, size.0 + CHROME.0, area_origin.0, area_size.0),
        fit(from.1, size.1 + CHROME.1, area_origin.1, area_size.1),
    )
}

/// The window with focus, else any — what a relaunch opens its new window beside.
pub fn focused(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    let all = app.webview_windows();
    all.values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| all.into_values().next())
}

/// Open another window onto the same app: the config's window under a new label, sized by
/// [`opening_size`], placed by [`cascade`] beside `from`, with the camera grant, shown and focused.
///
/// ⚠️ **Never call this synchronously from a command or an event handler.** Tauri documents that
/// building a window on Windows "deadlocks when used in a synchronous command or event handlers"
/// (`tauri-2.11.5/src/webview/webview_window.rs:115`). The single-instance callback spawns onto
/// the async runtime and `window_new` is an `async` command for exactly this.
pub fn open_new(
    app: &tauri::AppHandle,
    from: Option<&tauri::WebviewWindow>,
) -> Result<tauri::WebviewWindow, String> {
    let Some(mut config) = app.config().app.windows.first().cloned() else {
        return Err("the app has no window configuration to open another from".to_owned());
    };
    config.label = format!(
        "{LABEL_PREFIX}{}",
        NEXT_LABEL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    place(&window, from);
    crate::camera::install(&window);
    let _ = window.show();
    let _ = window.set_focus();
    Ok(window)
}

/// Size `window` for the monitor `from` is on and put it beside `from`, or centre it when there is
/// no `from`. Best-effort, for [`open_sized_to_monitor`]'s reason.
///
/// **The position is set in physical pixels, converted back with the same `scale` it was derived
/// with.** A `LogicalPosition` would be converted by the *new* window's scale factor, and a window
/// Tauri has just built sits wherever Windows put it — on a desk whose monitors scale differently,
/// a point read off a 150% monitor and handed back at 100% lands on the wrong monitor altogether.
/// Monitor coordinates are physical, so the physical point is the one that means the same thing
/// to both windows. On a desk where every monitor shares one scale the two spellings agree.
fn place(window: &tauri::WebviewWindow, from: Option<&tauri::WebviewWindow>) {
    let anchor = from.unwrap_or(window);
    let monitor = anchor
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| anchor.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let origin = (
        f64::from(area.position.x) / scale,
        f64::from(area.position.y) / scale,
    );
    let room = (
        f64::from(area.size.width) / scale,
        f64::from(area.size.height) / scale,
    );
    let size = opening_size(room);
    let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
    match from.and_then(|f| f.outer_position().ok()) {
        Some(at) => {
            let (x, y) = cascade(
                (f64::from(at.x) / scale, f64::from(at.y) / scale),
                size,
                origin,
                room,
            );
            let _ = window.set_position(tauri::PhysicalPosition::new(
                (x * scale).round() as i32,
                (y * scale).round() as i32,
            ));
        }
        None => {
            let _ = window.center();
        }
    }
}

/// Size a window to the monitor it opened on, centre it, and show it. Every window the app opens
/// is sized by the same rungs — `main` here, from `setup`, and every later one through
/// [`open_new`]'s `place`, which shares [`opening_size`] and differs only in where it puts the
/// window.
///
/// Best-effort throughout, and deliberately: every call here is a window operation whose
/// failure is not worth a launch. What is *not* optional is `show()` — the config opens the
/// window hidden so the reader never sees it snap from 1920×1080 down to the rung that fits,
/// so this is the only thing that puts the app on screen. It runs first in `setup`, before
/// anything there that can fail, for that reason.
///
/// When no monitor answers, the window keeps the config's own 1920×1080 and is still shown: a
/// size that may be too big beats no window at all.
pub fn open_sized_to_monitor(window: &tauri::WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area().size;
        let (width, height) = opening_size((
            f64::from(area.width) / scale,
            f64::from(area.height) / scale,
        ));
        let _ = window.set_size(tauri::LogicalSize::new(width, height));
        let _ = window.center();
    }
    let _ = window.show();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The case this module exists for. A 1920×1080 desk with a 48px taskbar cannot hold a
    /// 1080-tall window — the frame would want 1089 of the 1032 it has, and 1936 of its 1920
    /// px of width — so the app opens at 720p there rather than putting its own bottom edge
    /// behind the taskbar.
    #[test]
    fn a_1080p_desk_opens_at_720p() {
        assert_eq!(opening_size((1920.0, 1032.0)), (1280.0, 720.0));
    }

    /// And anything with the room takes the top rung — the width at which the ribbon stops
    /// wrapping and the deck editor's stats panel stops squeezing the desk row. 2560×1392 is
    /// the desk this was written on, and the size it opened at, live.
    #[test]
    fn a_desk_with_the_room_opens_at_1080p() {
        assert_eq!(opening_size((2560.0, 1392.0)), (1920.0, 1080.0));
        // The frame, exactly, and nothing spare — 1920+16 by 1080+9, at the undecorated
        // `CHROME`. One pixel less in either axis and the rung is out of reach.
        assert_eq!(opening_size((1936.0, 1089.0)), (1920.0, 1080.0));
        assert_eq!(opening_size((1935.0, 1089.0)), (1280.0, 720.0));
        assert_eq!(opening_size((1936.0, 1088.0)), (1280.0, 720.0));
    }

    /// A work area of exactly 1920×1080 is **not** room for a 1920×1080 window, and this is
    /// the case that would be wrong without `CHROME` — without it the rung and the work area
    /// compare equal and the top one is taken. **Since the app took its own title bar it is
    /// the width that refuses this**, not the height: the 16px border wants 1936, and the 9px
    /// left below wants only 1089 where the old caption wanted 1119.
    #[test]
    fn a_work_area_the_size_of_the_rung_is_not_room_for_it() {
        assert_eq!(opening_size((1920.0, 1080.0)), (1280.0, 720.0));
    }

    /// Both axes, not just the height. A 1600×1200 desk is tall enough for 1080 and 320px too
    /// narrow for 1920.
    #[test]
    fn a_rung_needs_both_of_its_axes() {
        assert_eq!(opening_size((1600.0, 1200.0)), (1280.0, 720.0));
    }

    /// Below the bottom rung the window takes what the work area leaves once the frame is out
    /// of it — but never less than the constraint `tauri.conf.json` sets, which Tauri would
    /// enforce over us anyway. **1280×672 is the third monitor on this machine**, and 150%
    /// scaling on a 1080p one lands in the same place. Both are past the point where there is
    /// anything left to choose: the 700 floor is taller than either work area, so those windows
    /// keep a strip of themselves under the taskbar whatever this returns.
    #[test]
    fn a_desk_below_the_bottom_rung_takes_the_work_area_down_to_the_configured_minimum() {
        assert_eq!(opening_size((1280.0, 672.0)), (1264.0, 700.0));
        assert_eq!(opening_size((1280.0, 688.0)), (1264.0, 700.0));
        assert_eq!(opening_size((800.0, 600.0)), (1024.0, 700.0));
    }

    /// The case the offset exists for: a new window lands where the reader can see both.
    #[test]
    fn a_new_window_opens_down_and_right_of_the_one_it_came_from() {
        assert_eq!(
            cascade((100.0, 80.0), (1280.0, 720.0), (0.0, 0.0), (2560.0, 1392.0)),
            (132.0, 112.0)
        );
    }

    /// An axis that would push the frame off the work area starts again at that edge, rather than
    /// opening a window the reader has to drag back.
    #[test]
    fn an_axis_that_would_overflow_the_work_area_starts_again_at_its_edge() {
        // 1282 + 1280 + 16 of frame = 2578 > 2560.
        assert_eq!(
            cascade(
                (1250.0, 80.0),
                (1280.0, 720.0),
                (0.0, 0.0),
                (2560.0, 1392.0)
            ),
            (0.0, 112.0)
        );
    }

    /// A second monitor's work area does not start at zero.
    #[test]
    fn a_work_area_that_does_not_start_at_zero_is_respected() {
        // y: 732 + 720 + 9 = 1461 > 1032, so it starts again at that monitor's top.
        assert_eq!(
            cascade(
                (2600.0, 700.0),
                (1280.0, 720.0),
                (2560.0, 0.0),
                (1920.0, 1032.0)
            ),
            (2632.0, 0.0)
        );
    }

    /// The ladder's top rung and this floor are *also* written in `tauri.conf.json`, and the
    /// duplication is the point: the config is what the window is created at before `setup`
    /// runs, and what it keeps if no monitor answers. `visible: false` is pinned here too — it
    /// is what makes `open_sized_to_monitor` the only thing that shows `main`, and `open_new`
    /// the only thing that shows every window built from this same entry after it, so dropping
    /// it fails no build and no other test, it just puts the resize back on screen.
    #[test]
    fn the_config_declares_the_top_rung_and_this_floor() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &conf["app"]["windows"][0];
        assert_eq!(main["width"].as_f64(), Some(LADDER[0].0));
        assert_eq!(main["height"].as_f64(), Some(LADDER[0].1));
        assert_eq!(main["minWidth"].as_f64(), Some(MIN.0));
        assert_eq!(main["minHeight"].as_f64(), Some(MIN.1));
        assert_eq!(
            main["visible"],
            serde_json::Value::Bool(false),
            "the window opens hidden so the reader never sees it resize"
        );
    }
}
