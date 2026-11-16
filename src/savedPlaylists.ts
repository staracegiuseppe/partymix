import type { Track } from './queue';

/**
 * Before 1.7 (four fixed playlists in localStorage). Still read once, to move the old playlists into the new store.
 * A playlist kept on this computer: its name, the link it came from and its songs, so it opens at once even offline from YouTube/Spotify. */
export type SavedPlaylist = { name: string; link: string; source: 'YouTube' | 'Spotify'; tracks: Track[]; savedAt: number; removed?: string[] };

const key = (slot: number) => `partymix.playlist.${slot}`;
/** A YouTube id or a song of the local library (`local:` + content hash). */
export const TRACK_ID = /^(?:[\w-]{6,20}|local:[0-9a-f]{8,64}|nas:[0-9a-f]{64})$/;

/** Only the fields a saved track may have, checked one by one (the data comes from storage the user could have edited). */
export function cleanTrack(v: unknown): Track | undefined {
  const t = v as Partial<Track> | null;
  if (!t || typeof t.videoId !== 'string' || !TRACK_ID.test(t.videoId)) return undefined;
  const out: Track = { videoId: t.videoId, status: t.status === 'unplayable' ? 'unplayable' : 'ok' };
  if (typeof t.title === 'string') out.title = t.title;
  if (typeof t.artist === 'string') out.artist = t.artist;
  if (typeof t.album === 'string') out.album = t.album;
  if (typeof t.thumb === 'string') out.thumb = t.thumb;
  if (typeof t.durationSec === 'number' && Number.isFinite(t.durationSec)) out.durationSec = t.durationSec;
  if (t.structured === true) out.structured = true;
  if (t.manual === true) out.manual = true;
  return out;
}

export function loadSaved(store: Storage | undefined, slot: number): SavedPlaylist | undefined {
  try {
    const j = JSON.parse(store?.getItem(key(slot)) ?? '');
    if (!j || typeof j !== 'object' || !Array.isArray(j.tracks)) return undefined;
    const tracks = (j.tracks as unknown[]).map(cleanTrack).filter((t): t is Track => !!t);
    if (!tracks.length) return undefined;
    return {
      name: typeof j.name === 'string' ? j.name.slice(0, 60) : '',
      link: typeof j.link === 'string' ? j.link : '',
      source: j.source === 'Spotify' ? 'Spotify' : 'YouTube',
      tracks,
      savedAt: typeof j.savedAt === 'number' ? j.savedAt : 0,
      removed: Array.isArray(j.removed) ? (j.removed as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return undefined;
  }
}

/** Saves the songs in their play order (not their play state: lock, current position) and the ones the user took out, so the list is the same next time. */
export function saveSaved(store: Storage | undefined, slot: number, p: Omit<SavedPlaylist, 'savedAt'>, now = Date.now()): boolean {
  const tracks = p.tracks.map((t) => cleanTrack(t)).filter((t): t is Track => !!t);
  try {
    store?.setItem(key(slot), JSON.stringify({ ...p, name: p.name.slice(0, 60), tracks, removed: p.removed ?? [], savedAt: now }));
    return !!store;
  } catch {
    return false; // storage full or unavailable: the link is still remembered
  }
}

/** The name shown on the button: the user's, else the playlist's own, else «Playlist N». */
export const slotLabel = (slot: number, name?: string) => (name?.trim() ? name.trim() : `Playlist ${slot + 1}`);
