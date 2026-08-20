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
/// border and title bar are added outside it: measured live on 2026-08-20 (Windows 11, `npm run
/// tauri dev`, a debug build), a window opened at 1920×1080 reported a frame of **1936×1119**.
/// Ignore that and a work area of exactly 1080 looks like room for a 1080-tall window, when
/// what it would actually get is 39px of title bar under the taskbar.
const CHROME: (f64, f64) = (16.0, 39.0);

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

/// Size the main window to the monitor it opened on, centre it, and show it.
///
/// Best-effort throughout, and deliberately: every call here is a window operation whose
/// failure is not worth a launch. What is *not* optional is `show()` — the config opens the
/// window hidden so the reader never sees it snap from 1920×1080 down to the rung that fits,
/// so this is the only thing that puts the app on screen. It runs first in `setup`, before
/// anything there that can fail, for that reason.
///
/// When no monitor answers, the window keeps the config's own 1920×1080 and is still shown: a
/// size that may be too big beats no window at all.
pub fn open_sized_to_monitor(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
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
    /// 1080-tall window — the frame would want 1119 of the 1032 it has — so the app opens at
    /// 720p there rather than putting its own bottom edge behind the taskbar.
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
        // The frame, exactly, and nothing spare.
        assert_eq!(opening_size((1936.0, 1119.0)), (1920.0, 1080.0));
    }

    /// A work area of exactly 1080 is **not** room for a 1080-tall window, and this is the
    /// case that would be wrong without `CHROME`: what the taskbar would cover is the 39px of
    /// title bar Windows draws outside the size we asked for.
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

    /// The ladder's top rung and this floor are *also* written in `tauri.conf.json`, and the
    /// duplication is the point: the config is what the window is created at before `setup`
    /// runs, and what it keeps if no monitor answers. `visible: false` is pinned here too — it
    /// is what makes `open_sized_to_monitor` the only thing that shows the window, so dropping
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
