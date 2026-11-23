package it.partymix.ai

import android.os.Bundle
import android.os.Process
import android.support.v4.media.MediaBrowserCompat.MediaItem
import android.support.v4.media.MediaDescriptionCompat
import androidx.media.MediaBrowserServiceCompat
import androidx.media.utils.MediaConstants

/**
 * The service Android Auto connects to: the tree «playlists → songs» and the session of PartyMedia.
 * It plays nothing itself (the music is in the app's web view): with the app closed on the phone the car
 * shows one item, «Apri PartyMix sul telefono», and the session's error with a button that opens the app.
 */
class AutoService : MediaBrowserServiceCompat() {
  /** The root and every playlist: a playlist asked while the app was still starting got an empty answer, the car keeps it. */
  private val refresh: () -> Unit = {
    notifyChildrenChanged(AutoTree.ROOT)
    PartyMedia.playlists.forEach { notifyChildrenChanged(AutoTree.playlistId(it.id)) }
  }

  override fun onCreate() {
    super.onCreate()
    sessionToken = PartyMedia.session(this).sessionToken
    PartyMedia.onTreeChanged = refresh
  }

  override fun onDestroy() {
    if (PartyMedia.onTreeChanged === refresh) PartyMedia.onTreeChanged = null
    super.onDestroy()
  }

  override fun onGetRoot(clientPackageName: String, clientUid: Int, rootHints: Bundle?): BrowserRoot? {
    if (!allowed(clientPackageName, clientUid)) return null
    // «resume after reboot» from the phone's media controls: nothing to resume without the app open
    if (rootHints?.getBoolean(BrowserRoot.EXTRA_RECENT) == true) return null
    PartyMedia.hello() // the page sends the playlists and the song on air again
    val extras = Bundle().apply {
      putBoolean(MediaConstants.BROWSER_SERVICE_EXTRAS_KEY_SEARCH_SUPPORTED, false)
      putInt(MediaConstants.DESCRIPTION_EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.DESCRIPTION_EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
      putInt(MediaConstants.DESCRIPTION_EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.DESCRIPTION_EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }
    return BrowserRoot(AutoTree.ROOT, extras)
  }

  /** Android Auto, the Assistant, the system and this app; any app in a debug build (tests with a media browser). */
  private fun allowed(pkg: String, uid: Int): Boolean =
    BuildConfig.DEBUG || uid == Process.myUid() || uid == Process.SYSTEM_UID || pkg in CLIENTS

  override fun onLoadChildren(parentId: String, result: Result<MutableList<MediaItem>>) {
    when (val t = AutoTree.parse(parentId)) {
      AutoTree.Target.Root -> result.sendResult(rootItems())
      is AutoTree.Target.Playlist -> {
        result.detach()
        PartyMedia.requestTracks(t.id) { songs -> result.sendResult(playlistItems(t.id, songs)) }
      }
      else -> result.sendResult(mutableListOf())
    }
  }

  private fun rootItems(): MutableList<MediaItem> {
    if (!PartyMedia.connected) return mutableListOf(item(AutoTree.OPEN, "Apri PartyMix sul telefono", "La musica suona nell'app: aprila e torna qui", MediaItem.FLAG_PLAYABLE))
    val lists = PartyMedia.playlists
    if (lists.isEmpty()) return mutableListOf(item(AutoTree.OPEN, "Nessuna playlist", "Crea una playlist nell'app sul telefono", MediaItem.FLAG_PLAYABLE))
    return lists.mapTo(ArrayList()) { p ->
      item(AutoTree.playlistId(p.id), p.name, if (p.count == 1) "1 brano" else "${p.count} brani", MediaItem.FLAG_BROWSABLE)
    }
  }

  private fun playlistItems(id: String, songs: List<PartyMedia.Song>?): MutableList<MediaItem> {
    if (songs == null) return mutableListOf(item(AutoTree.OPEN, "Apri PartyMix sul telefono", "L'app non risponde", MediaItem.FLAG_PLAYABLE))
    val out = ArrayList<MediaItem>(songs.size + 1)
    val name = PartyMedia.playlists.firstOrNull { it.id == id }?.name ?: "la playlist"
    out.add(item(AutoTree.playAllId(id), "▶ Riproduci tutta", name, MediaItem.FLAG_PLAYABLE))
    songs.forEach { s -> out.add(item(AutoTree.trackId(id, s.id), s.title, s.artist, MediaItem.FLAG_PLAYABLE)) }
    return out
  }

  private fun item(mediaId: String, title: String, subtitle: String, flags: Int) =
    MediaItem(MediaDescriptionCompat.Builder().setMediaId(mediaId).setTitle(title).setSubtitle(subtitle).build(), flags)

  companion object {
    private val CLIENTS = setOf(
      "com.google.android.projection.gearhead", // Android Auto (also with the Desktop Head Unit)
      "com.google.android.carassistant",
      "com.google.android.googlequicksearchbox", // the Assistant
      "com.google.android.autosimulator",
    )
  }
}
