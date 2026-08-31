//! Grants the webview permission to use the camera — and only the camera — so the in-app QR
//! scanner can open one.
//!
//! **Measured live 2026-08-31** against `npm run tauri dev` (debug, Windows/WebView2):
//! `window.isSecureContext` is `true`, `document.featurePolicy.allowsFeature('camera')` is
//! `true`, `navigator.permissions.query({name:'camera'})` answers `granted`, and
//! `enumerateDevices()` lists a real `videoinput` — yet
//! `getUserMedia({video:true})` **and** `getUserMedia({audio:true})` both answer
//! `NotSupportedError: Not supported`. Audio failing identically is what rules out anything
//! camera-specific, and the CSP is not involved either: `media-src` governs a `<video src>`
//! fetch and `srcObject` is not one.
//!
//! The proof of what is actually wrong came from relaunching with
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` extended. `--use-fake-ui-for-media-stream
//! --use-fake-device-for-media-stream` opened a fake device, as expected — but
//! `--use-fake-ui-for-media-stream` **alone** opened a **real** camera
//! (`Lenovo 500 RGB Camera (17ef:482f)`, 640×480 @ 30 fps). That flag fakes only the
//! permission *prompt*, and the device behind it was real, so the WebView2 media stack works
//! end to end and the failure is an unhandled `PermissionRequested` event that WebView2
//! surfaces under the misleading name `NotSupportedError`.
//!
//! `wry` (this app's webview backend) only ever registers a `PermissionRequested` handler
//! when its builder is given the `clipboard` attribute, and even then the handler grants
//! **only** `CLIPBOARD_READ` and leaves every other kind — camera and microphone included —
//! to WebView2's own undecided default, which is Deny
//! (`wry-0.55.1/src/webview2/mod.rs`, guarded by `attributes.clipboard`). This app's builder
//! never sets that attribute, so on a stock build no handler exists at all and the default
//! wins. [`install`] replaces that with a scoped one: camera is granted, everything else is
//! refused — so nothing is ever granted to a page that never asks, and a reader who is not on
//! the scanner never had a live camera in the first place.
//!
//! Windows only for now. Android's grant is the manifest permission in
//! `gen/android/app/src/main/AndroidManifest.xml` (`android.permission.CAMERA` plus a
//! `required="false"` `uses-feature`, so the app still installs on a camera-less device) —
//! whether `wry`'s Android backend answers `onPermissionRequest` on its own, or needs a
//! Kotlin shim, is **unverified** and is not this task's job to settle. See the task report
//! for exactly what is owed there.

/// Installs the camera-permission handler on `window`'s underlying platform webview.
///
/// Best-effort and silent throughout: a window whose webview cannot be reached, or whose
/// `ICoreWebView2` cannot be retrieved, is left exactly as it was before this call —
/// WebView2's own default, which denies the camera. Nothing about opening the app may fail
/// over this.
///
/// A no-op off Windows. Android needs no handler installed here at all (its grant is the
/// manifest permission), and no other desktop platform this crate ships for is a webview2
/// target.
pub fn install(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    install_windows(window);
    #[cfg(not(windows))]
    {
        let _ = window;
    }
}

#[cfg(windows)]
fn install_windows(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND;
    use webview2_com::PermissionRequestedEventHandler;

    // `with_webview` hands us the platform webview on the WebView2 thread; everything past
    // this point is COM interop and every step is allowed to fail into a no-op rather than
    // an app that will not open.
    let _ = window.with_webview(|webview| {
        let controller = webview.controller();
        // SAFETY: `CoreWebView2` is a plain COM getter — no lifetime or aliasing requirement
        // beyond `controller` outliving the call, which it does as a local binding.
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
            return;
        };
        let mut token: i64 = 0;
        let handler = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            // SAFETY: `PermissionKind` and `SetState` are plain COM getter/setter calls on
            // `args`, valid for the lifetime of this callback — WebView2 owns `args` and
            // guarantees it outlives the `Invoke` call these closures answer.
            unsafe {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                args.SetState(decide(kind))
            }
        }));
        // SAFETY: `add_PermissionRequested` is a plain COM event registration; `handler` is
        // borrowed for the duration of the call and WebView2 takes its own reference, and
        // `token` is a plain `i64` out-param this module never reads back (nothing here ever
        // calls `remove_PermissionRequested`, so the handler lives for the webview's whole
        // life).
        let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
    });
}

/// The one decision this module makes: which permission kind gets `ALLOW`.
///
/// Pulled out of the closure above so it is a plain value-in, value-out function a test can
/// call directly — no live `ICoreWebView2` needed to prove camera is the only kind granted and
/// that microphone, which failed identically in the live probe above, stays refused.
#[cfg(windows)]
fn decide(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_KIND,
) -> webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DENY,
    };

    if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
        COREWEBVIEW2_PERMISSION_STATE_ALLOW
    } else {
        COREWEBVIEW2_PERMISSION_STATE_DENY
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::decide;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };

    #[test]
    fn camera_is_the_one_kind_granted() {
        assert_eq!(
            decide(COREWEBVIEW2_PERMISSION_KIND_CAMERA),
            COREWEBVIEW2_PERMISSION_STATE_ALLOW
        );
    }

    /// The live probe found `getUserMedia({audio:true})` failing exactly like video — this is
    /// what keeps that failure from becoming a second grant alongside the fix for the first.
    #[test]
    fn microphone_is_refused_even_though_the_probe_failed_it_identically() {
        assert_eq!(
            decide(COREWEBVIEW2_PERMISSION_KIND_MICROPHONE),
            COREWEBVIEW2_PERMISSION_STATE_DENY
        );
    }

    #[test]
    fn everything_else_is_refused_too() {
        assert_eq!(
            decide(COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION),
            COREWEBVIEW2_PERMISSION_STATE_DENY
        );
        assert_eq!(
            decide(COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY),
            COREWEBVIEW2_PERMISSION_STATE_DENY
        );
    }
}
