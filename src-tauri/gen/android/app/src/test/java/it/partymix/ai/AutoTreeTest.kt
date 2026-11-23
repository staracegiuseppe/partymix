package it.partymix.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AutoTreeTest {
  @Test fun playlistIdsGoBothWays() {
    val id = AutoTree.playlistId("a1b2-c3")
    assertEquals("pl:a1b2-c3", id)
    assertEquals(AutoTree.Target.Playlist("a1b2-c3"), AutoTree.parse(id))
  }

  @Test fun trackIdsSurviveColonsAndSlashes() {
    val id = AutoTree.trackId("p:1/x", "local:ab/cd")
    assertEquals(AutoTree.Target.Track("p:1/x", "local:ab/cd"), AutoTree.parse(id))
  }

  @Test fun playAllIsItsOwnItem() {
    assertEquals(AutoTree.Target.PlayAll("p1"), AutoTree.parse(AutoTree.playAllId("p1")))
  }

  @Test fun rootAndOpenAndJunk() {
    assertEquals(AutoTree.Target.Root, AutoTree.parse(AutoTree.ROOT))
    assertEquals(AutoTree.Target.Open, AutoTree.parse(AutoTree.OPEN))
    assertNull(AutoTree.parse(null))
    assertNull(AutoTree.parse(""))
    assertNull(AutoTree.parse("pl:"))
    assertNull(AutoTree.parse("tr:onlyone"))
    assertNull(AutoTree.parse("whatever"))
  }

  @Test fun voiceSearchFindsAPlaylistByName() {
    val lists = listOf("p1" to "Estate 2024", "p2" to "Festa di Natale", "p3" to "Città")
    assertEquals("p2", AutoTree.searchPlaylist("natale", lists))
    assertEquals("p3", AutoTree.searchPlaylist("citta", lists)) // accents ignored
    assertEquals("p1", AutoTree.searchPlaylist("metti la playlist estate", lists)) // the playlist name inside a sentence
    assertNull(AutoTree.searchPlaylist("jazz", lists))
    assertNull(AutoTree.searchPlaylist("  ", lists))
  }
}
