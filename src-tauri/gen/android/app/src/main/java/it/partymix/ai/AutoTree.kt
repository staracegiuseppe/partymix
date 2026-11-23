package it.partymix.ai

import java.net.URLDecoder
import java.net.URLEncoder
import java.text.Normalizer

/** The media ids of the Android Auto tree (root → playlists → songs) and the voice search: plain Kotlin, tested on the JVM. */
object AutoTree {
  const val ROOT = "root"
  /** The only item shown while the app is closed on the phone. */
  const val OPEN = "open"

  sealed class Target {
    object Root : Target()
    object Open : Target()
    data class Playlist(val id: String) : Target()
    data class PlayAll(val id: String) : Target()
    data class Track(val playlist: String, val id: String) : Target()
  }

  private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
  private fun dec(s: String) = URLDecoder.decode(s, "UTF-8")

  fun playlistId(id: String) = "pl:" + enc(id)
  fun playAllId(id: String) = "all:" + enc(id)
  fun trackId(playlist: String, id: String) = "tr:" + enc(playlist) + ":" + enc(id)

  fun parse(mediaId: String?): Target? {
    if (mediaId.isNullOrEmpty()) return null
    if (mediaId == ROOT) return Target.Root
    if (mediaId == OPEN) return Target.Open
    return try {
      when {
        mediaId.startsWith("pl:") -> mediaId.substring(3).takeIf { it.isNotEmpty() }?.let { Target.Playlist(dec(it)) }
        mediaId.startsWith("all:") -> mediaId.substring(4).takeIf { it.isNotEmpty() }?.let { Target.PlayAll(dec(it)) }
        mediaId.startsWith("tr:") -> {
          val parts = mediaId.substring(3).split(":")
          if (parts.size == 2 && parts[0].isNotEmpty() && parts[1].isNotEmpty()) Target.Track(dec(parts[0]), dec(parts[1])) else null
        }
        else -> null
      }
    } catch (e: IllegalArgumentException) {
      null
    }
  }

  private fun norm(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase().trim()

  /** «Ok Google, metti Festa di Natale su PartyMix»: the playlist whose name is in the query, or that contains the query. */
  fun searchPlaylist(query: String?, lists: List<Pair<String, String>>): String? {
    val q = norm(query ?: "")
    if (q.isEmpty()) return null
    lists.firstOrNull { norm(it.second) == q }?.let { return it.first }
    lists.firstOrNull { norm(it.second).contains(q) }?.let { return it.first }
    lists.filter { norm(it.second).isNotEmpty() && q.contains(norm(it.second)) }.maxByOrNull { it.second.length }?.let { return it.first }
    // «metti la playlist estate»: the playlist with the most words of the query in its name
    val words = q.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.length >= 3 && it !in FILLER }.toSet()
    val best = lists.map { p -> p.first to norm(p.second).split(Regex("[^\\p{L}\\p{N}]+")).count { it in words } }.maxByOrNull { it.second }
    return best?.takeIf { it.second > 0 }?.first
  }

  /** Words of a spoken request that are not part of a playlist name. */
  private val FILLER = setOf("metti", "suona", "riproduci", "ascolta", "playlist", "play", "partymix", "della", "delle", "dei", "con", "per", "una", "the")
}
