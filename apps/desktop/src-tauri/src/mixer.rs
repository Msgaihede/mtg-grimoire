//! Names this app's sound in the Windows volume mixer — **MTG Grimoire** and its icon, where
//! Windows would otherwise say **Microsoft Edge WebView2** (issue #1703).
//!
//! **Why the mixer gets it wrong.** The page plays every sound — the scanner's beeps, the
//! playtest board — through Web Audio, and WebView2 opens the speaker from a process of its own:
//! an `msedgewebview2.exe` audio utility under the browser process this app starts. Windows labels
//! an audio session from the process that owns it, so the mixer shows the runtime's name and the
//! Edge logo, and a reader looking for the app's slider cannot find it. WebView2 has no setting
//! for this (MicrosoftEdge/WebView2Feedback#2236 is open).
//!
//! **What fixes it is Core Audio itself.** Any process may set a session's display name and icon
//! (`IAudioSessionControl::SetDisplayName` / `SetIconPath`), so a thread here watches every active
//! output device's sessions and relabels the ones a WebView2 process of **this** app owns: the
//! sessions already open at launch, each new one as it is created
//! (`IAudioSessionNotification`), and the sessions of a device plugged in or enabled later
//! (`IMMNotificationClient`) — Chromium follows the default device, so headphones plugged in
//! mid-game open a new session there.
//!
//! **Only this app's WebView2 is touched.** A session's process is walked up the process tree
//! through `msedgewebview2.exe` parents only ([`descends_from`]) until it reaches this process. A
//! browser this app opened for a link is its child too, and another app's WebView2 is somebody
//! else's — neither is an `msedgewebview2.exe` under this process, so neither is renamed.
//!
//! **The icon is named by resource id, not by index** (`<exe>,-32512`, [`icon_path`]):
//! `tauri-build` embeds the app icon as resource 32512 (`tauri-winres`'s `set_icon`), and a
//! mixer such as EarTrumpet loads an icon by id where it cannot by index. Windows' own mixer
//! takes either.
//!
//! **Best-effort, never fatal**, `camera`'s rule: a machine with no audio service, a device that
//! will not activate or a session that refuses the name leaves the stock label, and each names
//! itself with `eprintln!`. A no-op off Windows.
//!
//! Caveats, measured by others before this was written (Flow-Tube/Flow-Desktop#238, and the C#
//! sample it followed): a mixer that is **already open** may keep the old icon until it is opened
//! again (the name changes at once), and a mixer that groups by executable path (EarTrumpet) still
//! folds every WebView2 app on the machine into one row.

/// How far up the process tree a session's process is followed: the audio utility's parent is the
/// browser process, whose parent is this app, so two steps answer; the bound is for a reused
/// process id that makes a loop.
#[cfg(any(windows, test))]
const MAX_DEPTH: usize = 16;

/// The executable WebView2 runs every one of its processes as.
#[cfg(any(windows, test))]
const WEBVIEW_EXE: &str = "msedgewebview2.exe";

/// Starts relabelling this app's audio in the volume mixer, on a thread of its own.
///
/// `name` is what the mixer shows — the product name from `tauri.conf.json`. Returns at once; the
/// thread lives as long as the process.
pub fn start(name: &str) {
    #[cfg(windows)]
    watch::start(name);
    #[cfg(not(windows))]
    {
        let _ = name;
    }
}

/// The icon a session is given: this executable's application icon, by its resource id.
#[cfg(any(windows, test))]
fn icon_path(exe: &std::path::Path) -> String {
    format!("{},-32512", exe.display())
}

/// Whether an executable's name is WebView2's.
#[cfg(any(windows, test))]
fn is_webview(exe: &str) -> bool {
    exe.eq_ignore_ascii_case(WEBVIEW_EXE)
}

/// Whether `pid` is a process under `ancestor`, by `parents` — each WebView2 process's parent,
/// and nothing else.
///
/// **The map holds WebView2's processes only**, so the walk can pass through `msedgewebview2.exe`
/// and nothing else: a session owned by any other process (a browser, a game) is not in the map
/// and answers `false` at the first step, wherever it sits in the tree.
#[cfg(any(windows, test))]
fn descends_from(pid: u32, ancestor: u32, parents: &std::collections::HashMap<u32, u32>) -> bool {
    let mut at = pid;
    for _ in 0..MAX_DEPTH {
        match parents.get(&at) {
            Some(&parent) if parent == ancestor => return true,
            Some(&parent) if parent != 0 && parent != at => at = parent,
            _ => return false,
        }
    }
    false
}

#[cfg(windows)]
mod watch {
    use std::collections::HashMap;
    use std::sync::mpsc::{self, Sender};
    use std::sync::Arc;

    use windows::core::{implement, Interface, Ref, Result, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, PROPERTYKEY, S_OK};
    use windows::Win32::Media::Audio::{
        eRender, EDataFlow, ERole, IAudioSessionControl, IAudioSessionControl2,
        IAudioSessionManager2, IAudioSessionNotification, IAudioSessionNotification_Impl,
        IMMDevice, IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl,
        MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    use super::{descends_from, icon_path, is_webview};

    /// What a session of ours is given.
    struct Label {
        name: HSTRING,
        icon: HSTRING,
    }

    pub(super) fn start(name: &str) {
        let icon = match std::env::current_exe() {
            Ok(exe) => icon_path(&exe),
            Err(e) => {
                eprintln!("mixer: no path to this executable, so no icon in the mixer: {e}");
                String::new()
            }
        };
        let label = Arc::new(Label {
            name: HSTRING::from(name),
            icon: HSTRING::from(icon),
        });
        let spawned = std::thread::Builder::new()
            .name("mixer".to_owned())
            .spawn(move || {
                if let Err(e) = watch(&label) {
                    eprintln!("mixer: not watching the volume mixer: {e}");
                }
            });
        if let Err(e) = spawned {
            eprintln!("mixer: no thread to watch the volume mixer on: {e}");
        }
    }

    /// The thread's whole life: follow the output devices, and again on every change to them.
    ///
    /// **A multithreaded apartment**, because the session manager delivers
    /// `OnSessionCreated` only to one — Microsoft's own remark on `RegisterSessionNotification`.
    /// The device callbacks only post to this thread, which does the work; the session callback
    /// labels in place, on the audio service's thread.
    fn watch(label: &Arc<Label>) -> Result<()> {
        // SAFETY: once, on this thread, before any COM call on it; never uninitialised, because
        // the thread lives as long as the process.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok()?;
        // SAFETY: a plain COM activation; the class and the interface are Core Audio's own.
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }?;

        let (changed, changes) = mpsc::channel();
        let devices: IMMNotificationClient = Devices { changed }.into();
        // SAFETY: `devices` lives on this stack frame for as long as the loop below, which is the
        // process's life, so the enumerator never calls a released object.
        unsafe { enumerator.RegisterEndpointNotificationCallback(&devices) }?;
        let sessions: IAudioSessionNotification = Sessions {
            label: Arc::clone(label),
        }
        .into();

        let mut managers = HashMap::new();
        follow(&enumerator, &mut managers, &sessions, label);
        while changes.recv().is_ok() {
            // A device change arrives as a burst (added, then its state); one pass answers it.
            while changes.try_recv().is_ok() {}
            follow(&enumerator, &mut managers, &sessions, label);
        }
        Ok(())
    }

    /// Watch every active output device not yet watched, and let go of the ones that are gone.
    fn follow(
        enumerator: &IMMDeviceEnumerator,
        managers: &mut HashMap<String, IAudioSessionManager2>,
        sessions: &IAudioSessionNotification,
        label: &Label,
    ) {
        let outputs = match active_outputs(enumerator) {
            Ok(outputs) => outputs,
            Err(e) => {
                eprintln!("mixer: could not list the output devices: {e}");
                return;
            }
        };
        managers.retain(|id, manager| {
            let present = outputs.iter().any(|(output, _)| output == id);
            if !present {
                // SAFETY: `sessions` is the object this manager was registered with. A device
                // already gone may refuse; there is nothing left to stop then.
                let _ = unsafe { manager.UnregisterSessionNotification(sessions) };
            }
            present
        });
        for (id, device) in outputs {
            if managers.contains_key(&id) {
                continue;
            }
            match watch_device(&device, sessions, label) {
                Ok(manager) => {
                    managers.insert(id, manager);
                }
                Err(e) => eprintln!("mixer: could not watch an output device: {e}"),
            }
        }
    }

    /// Every active output device, by its id.
    fn active_outputs(enumerator: &IMMDeviceEnumerator) -> Result<Vec<(String, IMMDevice)>> {
        // SAFETY: plain COM getters on objects this thread holds.
        unsafe {
            let list = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
            let mut outputs = Vec::new();
            for index in 0..list.GetCount()? {
                let device = list.Item(index)?;
                let raw = device.GetId()?;
                let id = raw.to_string();
                CoTaskMemFree(Some(raw.0 as *const _));
                outputs.push((id.unwrap_or_default(), device));
            }
            Ok(outputs)
        }
    }

    /// Hear about every session `device` opens from now on, and label the ones already open.
    ///
    /// **Registered before the sessions are enumerated**: the session manager starts sending
    /// `OnSessionCreated` only once a client has asked for the enumerator, so the order is what
    /// leaves no session between the two unlabelled.
    fn watch_device(
        device: &IMMDevice,
        sessions: &IAudioSessionNotification,
        label: &Label,
    ) -> Result<IAudioSessionManager2> {
        // SAFETY: plain COM calls on objects this thread holds; `sessions` outlives the manager's
        // registration (see `watch`).
        unsafe {
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            manager.RegisterSessionNotification(sessions)?;
            let open = match manager.GetSessionEnumerator() {
                Ok(open) => open,
                Err(e) => {
                    let _ = manager.UnregisterSessionNotification(sessions);
                    return Err(e);
                }
            };
            for index in 0..open.GetCount().unwrap_or(0) {
                if let Ok(session) = open.GetSession(index) {
                    label_if_ours(&session, label);
                }
            }
            Ok(manager)
        }
    }

    /// Give a session this app's name and icon, if a WebView2 process of this app owns it.
    fn label_if_ours(session: &IAudioSessionControl, label: &Label) {
        let Ok(session) = session.cast::<IAudioSessionControl2>() else {
            return;
        };
        // SAFETY: plain COM calls on a session the caller holds; the strings outlive the calls.
        unsafe {
            if session.IsSystemSoundsSession() == S_OK {
                return;
            }
            let Ok(pid) = session.GetProcessId() else {
                return;
            };
            if !descends_from(pid, std::process::id(), &webview_parents()) {
                return;
            }
            if let Err(e) = session.SetDisplayName(&label.name, std::ptr::null()) {
                eprintln!("mixer: the session refused the app's name: {e}");
            }
            if !label.icon.is_empty() {
                if let Err(e) = session.SetIconPath(&label.icon, std::ptr::null()) {
                    eprintln!("mixer: the session refused the app's icon: {e}");
                }
            }
        }
    }

    /// Each running WebView2 process's parent, from one snapshot of the process table — taken
    /// per session, which is a handful of times a session at most, so a process that started a
    /// moment ago is in it.
    fn webview_parents() -> HashMap<u32, u32> {
        let mut parents = HashMap::new();
        // SAFETY: the snapshot handle is closed below on every path that opened it, and the entry
        // is sized as `Process32FirstW` requires.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return parents;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
            while more {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                if is_webview(&String::from_utf16_lossy(&entry.szExeFile[..end])) {
                    parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                }
                more = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        parents
    }

    /// The session callback: label each new session as it is created.
    #[implement(IAudioSessionNotification)]
    struct Sessions {
        label: Arc<Label>,
    }

    impl IAudioSessionNotification_Impl for Sessions_Impl {
        fn OnSessionCreated(&self, session: Ref<'_, IAudioSessionControl>) -> Result<()> {
            if let Some(session) = session.as_ref() {
                label_if_ours(session, &self.label);
            }
            Ok(())
        }
    }

    /// The device callback: tell the watching thread the devices changed. It never touches the
    /// enumerator itself — Microsoft's rule for `IMMNotificationClient`, whose callbacks must not
    /// block or call back into the endpoint API.
    #[implement(IMMNotificationClient)]
    struct Devices {
        changed: Sender<()>,
    }

    impl IMMNotificationClient_Impl for Devices_Impl {
        fn OnDeviceStateChanged(&self, _: &PCWSTR, _: DEVICE_STATE) -> Result<()> {
            let _ = self.changed.send(());
            Ok(())
        }

        fn OnDeviceAdded(&self, _: &PCWSTR) -> Result<()> {
            let _ = self.changed.send(());
            Ok(())
        }

        fn OnDeviceRemoved(&self, _: &PCWSTR) -> Result<()> {
            let _ = self.changed.send(());
            Ok(())
        }

        fn OnDefaultDeviceChanged(&self, _: EDataFlow, _: ERole, _: &PCWSTR) -> Result<()> {
            Ok(())
        }

        fn OnPropertyValueChanged(&self, _: &PCWSTR, _: &PROPERTYKEY) -> Result<()> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use super::{descends_from, icon_path, is_webview};

    const APP: u32 = 100;

    #[test]
    fn the_audio_utility_under_this_apps_webview_is_ours() {
        // app (100) → browser (200) → audio utility (300)
        let parents = HashMap::from([(200, APP), (300, 200)]);
        assert!(descends_from(300, APP, &parents));
        assert!(descends_from(200, APP, &parents));
    }

    #[test]
    fn another_apps_webview_is_not() {
        // another app (900) → its browser (910) → its audio utility (920)
        let parents = HashMap::from([(200, APP), (300, 200), (910, 900), (920, 910)]);
        assert!(!descends_from(920, APP, &parents));
    }

    #[test]
    fn a_process_that_is_not_webview2_is_not_followed() {
        // A browser this app opened for a link is its child, but not WebView2's, so it is absent
        // from the map and answers no at the first step.
        let parents = HashMap::from([(200, APP), (300, 200)]);
        assert!(!descends_from(500, APP, &parents));
    }

    #[test]
    fn a_loop_of_reused_process_ids_ends() {
        let parents = HashMap::from([(1, 2), (2, 1), (3, 3)]);
        assert!(!descends_from(1, APP, &parents));
        assert!(!descends_from(3, APP, &parents));
    }

    #[test]
    fn webview2_is_named_whatever_its_case() {
        assert!(is_webview("msedgewebview2.exe"));
        assert!(is_webview("MSEdgeWebView2.EXE"));
        assert!(!is_webview("msedge.exe"));
    }

    #[test]
    fn the_icon_is_the_executables_by_resource_id() {
        assert_eq!(
            icon_path(Path::new(r"C:\Apps\MTG Grimoire\mtg-grimoire.exe")),
            r"C:\Apps\MTG Grimoire\mtg-grimoire.exe,-32512"
        );
    }
}
