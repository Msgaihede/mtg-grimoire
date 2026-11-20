package com.mtggrimoire.app

import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding

// HAND-EDITED — `tauri android init` writes this file and a re-init reverts it (the light-app
// spec §5). `apps/light/host.test.ts` holds the edit; `apps/light/CLAUDE.md` says why.
class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // **Immersive, asked for by the page** (the Life tracker's board, 2026-11-20; issue #1716). The
    // browser's Fullscreen API is no road here: this WebView (wry 0.55.1) answers a
    // `requestFullscreen()` by hiding the custom view the moment it is shown, so the bars stay. The
    // page asks `window.grimoireImmersive.setImmersive(on)` instead, by feature detection
    // (`packages/ui/lib/core/hostImmersive.ts`). wry calls this before its first `loadUrl`, the same
    // point it adds its own `ipc` interface, so the bridge is on the first page and every page after.
    webView.addJavascriptInterface(ImmersiveBridge(), "grimoireImmersive")
  }

  /**
   * The page's one way to turn the screen into a game's, and nothing else: exactly one method, so
   * the interface hands a page no other power. On, it does three things, and off it undoes them:
   *
   * - **The system bars put away.** Hidden, they come back for a moment on a swipe from the edge;
   *   the insets listener in `onCreate` then pads the content view by zero for them (it reads the
   *   bars' *visible* insets), the cutout still respected.
   * - **The rotation held** (issue #1716): `SCREEN_ORIENTATION_LOCKED` keeps the exact rotation the
   *   screen is in — upside down included — so a phone lying on the table never turns the board
   *   under the players. Off is `SCREEN_ORIENTATION_UNSPECIFIED`, the manifest's own (it declares
   *   no `screenOrientation`; `host.test.ts` holds that). Android 16 ignores an app's rotation on a
   *   large screen (600dp and up) for apps that target it, so a tablet still turns there.
   * - **The screen kept on** (issue #1716): `FLAG_KEEP_SCREEN_ON` on the window, so the phone
   *   neither dims nor locks between turns. It holds only while the window is shown, and asks no
   *   permission.
   *
   * The WebView calls it on a thread of its own, and the window and the activity are the UI
   * thread's, hence the hop.
   */
  inner class ImmersiveBridge {
    @JavascriptInterface
    fun setImmersive(on: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
          controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          controller.hide(WindowInsetsCompat.Type.systemBars())
          requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LOCKED
          window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
          controller.show(WindowInsetsCompat.Type.systemBars())
          requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
          window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Light icons on both bars: the app is dark everywhere (`color-scheme: dark`), so the system's
    // day/night guess would draw dark icons on a dark ground half the time.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)

    // **The last back puts the app away; it never finishes the activity.** Tauri's `AppPlugin`
    // walks the WebView's history (`goBack()` while `canGoBack()`, so a back closes a sheet) and,
    // from the first entry, hands the press to `onBackPressed()`. Left to the activity, a back that
    // finishes it — Android 11 and older always do, and the OnePlus on Android 16 this was found on
    // (2026-10-04) evidently did — destroys the one window Tauri has, its event loop ends, and tao's
    // `EventLoop::run` calls `std::process::exit`, whose static destructors race HWUI's
    // RenderThread: `FORTIFY: pthread_mutex_lock called on a destroyed mutex`. So this callback,
    // registered here and so ahead of the plugin's (which waits for the WebView), is the one the
    // dispatcher reaches only when the plugin hands the press on, and it moves the task to the
    // back — what Android 12+ does for a root launcher activity — so the app stays warm and nothing
    // exits. Its own `canGoBack()` keeps history-back whole should a later Tauri register first.
    // `apps/light/host.test.ts` holds it; the host's `lib.rs` covers an activity destroyed some other way.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val view = webView
        if (view != null && view.canGoBack()) {
          view.goBack()
        } else {
          moveTaskToBack(true)
        }
      }
    })

    // **The page lives inside the safe area, and the window behind the bars wears the app's
    // ground** (`windowBackground`, themes.xml). From targetSdk 35 Android draws every app edge
    // to edge and stops resizing it for the keyboard, and whether a WebView reports the bars and
    // a cutout through CSS `env(safe-area-inset-*)` depends on a WebView version this app does not
    // choose. So the content view is padded by the system bars, the display cutout and the
    // keyboard, the largest at each edge: the page's `env()` insets read 0 and its own `100dvh`
    // is the safe area, and a search box is never under the keyboard.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.updatePadding(left = safe.left, top = safe.top, right = safe.right, bottom = safe.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
