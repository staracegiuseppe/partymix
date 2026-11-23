package it.partymix.ai

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * The MediaSession of PartyMix, for Android Auto (and the phone's own media controls).
 * There is no native player: the music plays in the web view. Commands from the car go to the page
 * (`partymix-auto` events, see src/androidAuto.ts) and the page tells this side the song on air and the playlists.
 * Everything that touches the session runs on the main thread.
 */
object PartyMedia {
  data class Playlist(val id: String, val name: String, val count: Int)
  data class Song(val id: String, val title: String, val artist: String)

  private val main = Handler(Looper.getMainLooper())
  private val art = Executors.newSingleThreadExecutor()
  private var app: Context? = null
  private var session: MediaSessionCompat? = null
  /** Sends one command (a JSON object) to the page; null while the app is not open on the phone. */
  @Volatile private var sink: ((String) -> Unit)? = null
  /** The page has spoken since it was attached: it is alive and its automix can take commands. */
  @Volatile var connected = false
    private set
  @Volatile var playlists: List<Playlist> = emptyList()
    private set
  /** Told when the tree changes (playlists arrived, app opened or closed): the car reloads it. */
  @Volatile var onTreeChanged: (() -> Unit)? = null
  private val pending = ConcurrentHashMap<Int, (List<Song>?) -> Unit>()
  private val seq = AtomicInteger()
  private var artUrl = ""
  private var artBitmap: Bitmap? = null
  private var lastNow: JSONObject? = null

  private const val ACTIONS = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
    PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP or
    PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
    PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID or PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH
  const val CLOSED_MESSAGE = "Apri PartyMix sul telefono per ascoltare la musica in auto."

  /** The one session of the app (created at the first call, on the main thread). */
  fun session(ctx: Context): MediaSessionCompat {
    session?.let { return it }
    val c = ctx.applicationContext
    app = c
    val s = MediaSessionCompat(c, "PartyMix")
    s.setCallback(Callback(), main)
    s.setSessionActivity(openApp(c))
    s.isActive = true
    session = s
    if (!connected) showClosed()
    return s
  }

  private fun openApp(c: Context): PendingIntent = PendingIntent.getActivity(
    c, 10,
    Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
  )

  // --- the page (MainActivity) ---

  fun attach(send: (String) -> Unit) {
    sink = send
    connected = false
  }

  fun detach() {
    sink = null
    connected = false
    playlists = emptyList()
    pending.values.forEach { it(null) }
    pending.clear()
    main.post { showClosed(); onTreeChanged?.invoke() }
  }

  /** The car (or the phone's media controls) wants everything again. */
  fun hello() { send(JSONObject().put("cmd", "hello")) }

  private fun send(cmd: JSONObject) {
    val s = sink ?: return
    s(cmd.toString())
  }

  private fun markConnected() {
    if (connected) return
    connected = true
    main.post { onTreeChanged?.invoke() }
  }

  fun setPlaylists(json: String) {
    val out = ArrayList<Playlist>()
    try {
      val a = JSONArray(json)
      for (i in 0 until minOf(a.length(), 500)) {
        val o = a.optJSONObject(i) ?: continue
        val id = o.optString("id")
        if (id.isNotEmpty()) out.add(Playlist(id, o.optString("name").take(80).ifEmpty { "Playlist" }, o.optInt("count")))
      }
    } catch (e: Exception) {
      return
    }
    playlists = out
    connected = true
    main.post { onTreeChanged?.invoke() } // new playlists, or the app just opened: the car reloads the tree
  }

  /** Asks the page for the songs of a playlist; `done` (on the main thread) gets null if the page does not answer in 5 s. */
  fun requestTracks(playlist: String, done: (List<Song>?) -> Unit) {
    if (sink == null || !connected) { main.post { done(null) }; return }
    val req = seq.incrementAndGet()
    pending[req] = done
    send(JSONObject().put("cmd", "tracks").put("req", req).put("playlist", playlist))
    main.postDelayed({ pending.remove(req)?.invoke(null) }, 5000)
  }

  fun tracksAnswer(req: Int, json: String) {
    val done = pending.remove(req) ?: return
    val out = ArrayList<Song>()
    try {
      val a = JSONArray(json)
      for (i in 0 until minOf(a.length(), 1000)) {
        val o = a.optJSONObject(i) ?: continue
        val id = o.optString("id")
        if (id.isNotEmpty()) out.add(Song(id, o.optString("title").take(200), o.optString("artist").take(200)))
      }
    } catch (e: Exception) {
      main.post { done(null) }
      return
    }
    main.post { done(out) } // the car's result is sent from the main thread, like the timeout
  }

  /** The song on air, from the page: shown on the car's screen. */
  fun setNow(json: String) {
    val o = try { JSONObject(json) } catch (e: Exception) { return }
    markConnected()
    main.post { lastNow = o; show(o) }
  }

  private fun show(o: JSONObject) {
    val s = session ?: return
    val id = o.optString("id")
    val state = when (o.optString("state")) {
      "playing" -> PlaybackStateCompat.STATE_PLAYING
      "paused" -> PlaybackStateCompat.STATE_PAUSED
      else -> if (id.isEmpty()) PlaybackStateCompat.STATE_STOPPED else PlaybackStateCompat.STATE_PAUSED
    }
    val pos = o.optLong("pos").coerceAtLeast(0)
    s.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(ACTIONS)
        .setState(state, pos, if (state == PlaybackStateCompat.STATE_PLAYING) 1f else 0f, SystemClock.elapsedRealtime())
        .build(),
    )
    val title = o.optString("title")
    val url = o.optString("art")
    val m = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_MEDIA_ID, id)
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title.ifEmpty { "PartyMix" })
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title.ifEmpty { "PartyMix" })
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, o.optString("artist"))
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, o.optString("artist"))
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, o.optString("album"))
    val dur = o.optLong("dur")
    if (dur > 0) m.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, dur)
    if (url.isNotEmpty() && url == artUrl) artBitmap?.let { m.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
    s.setMetadata(m.build())
    if (url != artUrl) loadArt(url)
  }

  /** The cover, downloaded once per song (https only, small), then the metadata is shown again with it. */
  private fun loadArt(url: String) {
    artUrl = url
    artBitmap = null
    if (!url.startsWith("https://")) return
    art.execute {
      val bmp = download(url)
      main.post {
        if (artUrl != url || bmp == null) return@post
        artBitmap = bmp
        lastNow?.let { show(it) }
      }
    }
  }

  private fun download(url: String): Bitmap? = try {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 5000
    c.readTimeout = 5000
    c.instanceFollowRedirects = true
    try {
      if (c.responseCode != 200 || c.contentLengthLong > 2_000_000) null
      else {
        val bytes = c.inputStream.use { it.readBytes() }
        if (bytes.size > 2_000_000) null
        else {
          val b = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
          // small enough for the binder (the car gets it through the session): 320 px at most
          if (b != null && maxOf(b.width, b.height) > 320) {
            val k = 320f / maxOf(b.width, b.height)
            Bitmap.createScaledBitmap(b, (b.width * k).toInt().coerceAtLeast(1), (b.height * k).toInt().coerceAtLeast(1), true)
          } else b
        }
      }
    } finally {
      c.disconnect()
    }
  } catch (e: Exception) {
    null
  }

  /** The app is not open on the phone: the car says so, with a button that opens it. */
  private fun showClosed() {
    val s = session ?: return
    val c = app ?: return
    lastNow = null
    artUrl = ""
    artBitmap = null
    val extras = Bundle().apply {
      putString("android.media.extras.ERROR_RESOLUTION_ACTION_LABEL", "Apri PartyMix")
      putParcelable("android.media.extras.ERROR_RESOLUTION_ACTION_INTENT", openApp(c))
    }
    s.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(ACTIONS)
        .setState(PlaybackStateCompat.STATE_ERROR, 0, 0f)
        .setErrorMessage(PlaybackStateCompat.ERROR_CODE_APP_ERROR, CLOSED_MESSAGE)
        .setExtras(extras)
        .build(),
    )
    s.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, "PartyMix")
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, "PartyMix")
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, "Apri l'app sul telefono")
        .build(),
    )
  }

  /** A command for the page; while it is closed, the car shows why nothing happens. */
  private fun command(cmd: JSONObject) {
    if (sink == null || !connected) { showClosed(); return }
    send(cmd)
  }

  private class Callback : MediaSessionCompat.Callback() {
    private fun cmd(name: String) = JSONObject().put("cmd", name)

    override fun onPlay() = command(cmd("play"))
    override fun onPause() = command(cmd("pause"))
    override fun onStop() = command(cmd("stop"))
    override fun onSkipToNext() = command(cmd("next"))
    override fun onSkipToPrevious() = command(cmd("prev"))

    override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
      when (val t = AutoTree.parse(mediaId)) {
        is AutoTree.Target.Playlist -> command(cmd("playlist").put("id", t.id))
        is AutoTree.Target.PlayAll -> command(cmd("playlist").put("id", t.id))
        is AutoTree.Target.Track -> command(cmd("track").put("playlist", t.playlist).put("id", t.id))
        else -> command(cmd("play"))
      }
    }

    /** «Ok Google, metti <playlist> su PartyMix»; without a name it just plays. */
    override fun onPlayFromSearch(query: String?, extras: Bundle?) {
      val id = AutoTree.searchPlaylist(query, playlists.map { it.id to it.name })
      command(if (id != null) cmd("playlist").put("id", id) else cmd("play"))
    }
  }
}
