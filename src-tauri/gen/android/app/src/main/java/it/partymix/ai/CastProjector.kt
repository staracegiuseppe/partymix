package it.partymix.ai

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Presentation
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Display
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * The projector on a second screen: a TV or projector the phone casts to (wireless display / Miracast, «Smart View»,
 * «Trasmetti schermo»), or one plugged in with a cable. Android then has a «presentation» display, and the projector
 * page runs there full screen while the phone keeps showing the console. A Chromecast that only mirrors the phone
 * does not create such a display: there the phone screen is simply copied.
 */
class CastProjector(private val activity: Activity, private val documentStartScript: String) {
  private val dm = activity.getSystemService(DisplayManager::class.java)
  private val main = Handler(Looper.getMainLooper())
  private var presentation: ProjectorPresentation? = null
  /** The user asked for the projector: it opens by itself as soon as a cast screen shows up. */
  @Volatile private var wanted = false

  private val listener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) { if (wanted) show() }
    override fun onDisplayRemoved(displayId: Int) { if (presentation?.display?.displayId == displayId) dismiss() }
    override fun onDisplayChanged(displayId: Int) {}
  }

  init { dm.registerDisplayListener(listener, main) }

  private fun castDisplay(): Display? =
    dm.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).firstOrNull { it.displayId != Display.DEFAULT_DISPLAY }

  /** {available, name, showing, waiting} for the console. */
  fun state(): String {
    val d = castDisplay()
    return JSONObject()
      .put("available", d != null)
      .put("name", d?.name ?: "")
      .put("showing", presentation?.isShowing == true)
      .put("waiting", wanted && presentation?.isShowing != true)
      .toString()
  }

  /** Opens the projector on the cast screen; with none yet, opens Android's cast settings and waits for one. */
  fun start(): String {
    wanted = true
    main.post {
      if (castDisplay() != null) show() else openCastSettings()
    }
    return if (castDisplay() != null) "showing" else "settings"
  }

  fun stop() {
    wanted = false
    main.post { dismiss() }
  }

  fun openCastSettings() {
    val tries = listOf("android.settings.CAST_SETTINGS", "android.settings.WIFI_DISPLAY_SETTINGS", Settings.ACTION_DISPLAY_SETTINGS)
    for (a in tries) {
      try {
        activity.startActivity(Intent(a).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return
      } catch (e: Exception) { /* not on this phone: try the next one */ }
    }
  }

  fun destroy() {
    dm.unregisterDisplayListener(listener)
    dismiss()
  }

  private fun show() {
    val d = castDisplay() ?: return
    if (presentation?.isShowing == true && presentation?.display?.displayId == d.displayId) return
    dismiss()
    try {
      presentation = ProjectorPresentation(activity, d, documentStartScript).also { it.show() }
    } catch (e: WindowManager.InvalidDisplayException) {
      presentation = null // the screen went away meanwhile
    }
  }

  private fun dismiss() {
    presentation?.let { it.dismiss(); it.web?.destroy() }
    presentation = null
  }

  private class ProjectorPresentation(private val owner: Activity, display: Display, private val script: String) : Presentation(owner, display) {
    var web: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
      super.onCreate(savedInstanceState)
      window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      val w = WebView(context)
      w.settings.javaScriptEnabled = true
      w.settings.domStorageEnabled = true
      w.settings.mediaPlaybackRequiresUserGesture = false
      w.setBackgroundColor(android.graphics.Color.BLACK)
      if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
        WebViewCompat.addDocumentStartJavaScript(w, script, setOf("*"))
      }
      w.webViewClient = WebViewClient()
      // the shapes follow the room's sound: the microphone, already allowed for the app
      w.webChromeClient = object : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
          val mic = owner.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
          val ok = request.resources.filter { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && mic }
          if (ok.isEmpty()) request.deny() else request.grant(ok.toTypedArray())
        }
      }
      w.loadUrl("http://localhost:9527/projector.html")
      setContentView(w)
      web = w
    }
  }
}
