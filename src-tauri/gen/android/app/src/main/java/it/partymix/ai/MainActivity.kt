package it.partymix.ai

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.graphics.Color
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Runs before any page script, in the app and in the YouTube players: the page always says it is visible,
 * so nothing pauses the music when the screen turns off or another app comes to the front.
 */
private const val ALWAYS_VISIBLE = """
(function () {
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    Object.defineProperty(Document.prototype, 'webkitHidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(Document.prototype, 'webkitVisibilityState', { configurable: true, get: function () { return 'visible'; } });
    var stop = function (e) { e.stopImmediatePropagation(); };
    document.addEventListener('visibilitychange', stop, true);
    document.addEventListener('webkitvisibilitychange', stop, true);
    window.addEventListener('pagehide', stop, true);
  } catch (e) {}
})();
"""

class MainActivity : TauriActivity() {
  /** Last link shared to PartyMix from another app (YouTube, Spotify…), until the page takes it. */
  @Volatile private var sharedText: String? = null
  private var webView: WebView? = null
  private var cast: CastProjector? = null
  /** Height of the status bar and of the navigation bar in CSS pixels, so the page can keep its bars clear of them. */
  @Volatile private var insetsJson = "{}"

  override fun onCreate(savedInstanceState: Bundle?) {
    // transparent bars drawn behind by the page; their icons dark or light like the phone's theme
    enableEdgeToEdge(SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT), SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT))
    super.onCreate(savedInstanceState)
    // no grey veil behind the three navigation buttons: the page's own bottom bar colour runs under them
    if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    // Back closes a sheet or returns to «In onda» (history in the page); at the start it sends the app to the
    // background instead of closing it, so the party keeps playing.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val w = webView
        if (w != null && w.canGoBack()) w.goBack() else moveTaskToBack(true)
      }
    })
    keepShared(intent)
    // Android 13+: the "music playing" notification needs consent; the service runs either way.
    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    PartyService.start(this)
    cast = CastProjector(this, ALWAYS_VISIBLE)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (keepShared(intent)) {
      webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('partymix-shared'))", null) }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "PartyMixAndroid")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val d = resources.displayMetrics.density
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val json = "{\"top\":${(bars.top / d).toInt()},\"bottom\":${(bars.bottom / d).toInt()},\"ime\":${(ime / d).toInt()}}"
      if (json != insetsJson) {
        insetsJson = json
        v.post { (v as WebView).evaluateJavascript("window.dispatchEvent(new Event('partymix-insets'))", null) }
      }
      insets
    }
    ViewCompat.requestApplyInsets(webView) // the first measure may have gone by before the listener was set
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      WebViewCompat.addDocumentStartJavaScript(webView, ALWAYS_VISIBLE, setOf("*"))
    }
  }

  override fun onResume() {
    super.onResume()
    webView?.let { ViewCompat.requestApplyInsets(it) }
  }

  // Wry pauses the web view when the app leaves the screen, and that pauses the players: undo it.
  override fun onPause() {
    super.onPause()
    keepPlaying()
  }

  // Screen off or another app in front: the web view is told its window is hidden, and Chromium then suspends
  // the video players (the YouTube decks). Tell it again that it is visible, now and once the window has changed.
  override fun onStop() {
    super.onStop()
    keepPlaying()
    webView?.postDelayed({ keepPlaying() }, 300)
    webView?.postDelayed({ keepPlaying() }, 1500)
  }

  private fun keepPlaying() {
    val w = webView ?: return
    w.onResume()
    w.resumeTimers()
    w.dispatchWindowVisibilityChanged(View.VISIBLE)
  }

  /** The phone switched between light and dark (uiMode is handled here, the activity is not recreated). */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('partymix-theme'))", null) }
  }

  override fun onDestroy() {
    cast?.destroy()
    if (isFinishing) stopService(Intent(this, PartyService::class.java))
    super.onDestroy()
  }

  private fun keepShared(intent: Intent?): Boolean {
    if (intent?.action != Intent.ACTION_SEND) return false
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
    if (text.isNullOrEmpty()) return false
    sharedText = text.take(2000)
    return true
  }

  /** What the page may ask Android: the shared link, opening the two music apps, the projector on a cast screen. */
  inner class Bridge {
    @JavascriptInterface
    fun takeShared(): String? {
      val t = sharedText
      sharedText = null
      return t
    }

    /** A message to the author, sent by the user from their own mail app. The address is fixed here, not chosen by the page. */
    @JavascriptInterface
    fun sendFeedback(via: String, subject: String, body: String): Boolean {
      val to = "staracegiuseppe@gmail.com"
      val su = subject.take(150)
      val bo = body.take(1800)
      val intent = when (via) {
        "mail" -> Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).apply {
          putExtra(Intent.EXTRA_EMAIL, arrayOf(to)); putExtra(Intent.EXTRA_SUBJECT, su); putExtra(Intent.EXTRA_TEXT, bo)
        }
        "gmail" -> Intent(Intent.ACTION_VIEW, Uri.parse("https://mail.google.com/mail/?view=cm&fs=1&to=" + Uri.encode(to) + "&su=" + Uri.encode(su) + "&body=" + Uri.encode(bo)))
        "outlook" -> Intent(Intent.ACTION_VIEW, Uri.parse("https://outlook.live.com/mail/0/deeplink/compose?to=" + Uri.encode(to) + "&subject=" + Uri.encode(su) + "&body=" + Uri.encode(bo)))
        else -> return false
      }
      return try {
        startActivity(Intent.createChooser(intent, "Invia con…").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
      } catch (e: Exception) {
        false
      }
    }

    @JavascriptInterface
    fun insets(): String = insetsJson

    /** The phone's colours: light/dark and, from Android 12, the Material You palette. */
    @JavascriptInterface
    fun theme(): String = PhoneTheme.json(this@MainActivity)

    @JavascriptInterface
    fun castState(): String = cast?.state() ?: "{}"

    @JavascriptInterface
    fun castStart(): String = cast?.start() ?: "none"

    @JavascriptInterface
    fun castStop() { cast?.stop() }

    @JavascriptInterface
    fun castSettings() { runOnUiThread { cast?.openCastSettings() } }

    @JavascriptInterface
    fun openApp(which: String): Boolean {
      val intent = when (which) {
        "youtube" -> Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/feed/playlists"))
        "spotify" -> packageManager.getLaunchIntentForPackage("com.spotify.music")
          ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://open.spotify.com/collection/playlists"))
        else -> return false
      }
      return try {
        startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
