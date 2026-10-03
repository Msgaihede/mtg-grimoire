package com.mtggrimoire.app

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

// HAND-EDITED — `tauri android init` writes this file and a re-init reverts it (the light-app
// spec §5). `mobile/host.test.ts` holds the edit; `mobile/CLAUDE.md` says why.
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // Light icons on both bars: the app is dark everywhere (`color-scheme: dark`), so the system's
    // day/night guess would draw dark icons on a dark ground half the time.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    super.onCreate(savedInstanceState)

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
