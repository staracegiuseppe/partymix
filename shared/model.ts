/**
 * What PartyMix devices and the NAS server exchange. Shared by the app (src/sync) and the server (server/src),
 * so both sides read the same shapes. Only type-level TypeScript here and in shared/*.ts: the server runs these
 * files directly with Node's type stripping.
 */

/** One line of a playlist. entryId is its own identity: the same song twice is two lines. */
export type Entry = {
  entryId: string;
  /** SHA-256 of a file in the NAS library. */
  trackId?: string;
  /** A YouTube video (no file on the NAS). */
  youtubeId?: string;
  /** A file in one device's own library (`local:<hash>`), not on the NAS yet: elsewhere it shows as ⚠ missing. */
  localId?: string;
  title?: string;
  artist?: string;
  album?: string;
  thumb?: string;
  durationSec?: number;
};

export type PlaylistMeta = {
  name: string;
  description?: string;
  color?: string;
  cover?: string;
  link?: string;
  source?: string;
  sortOrder: number;
};

export type PlaylistDoc = PlaylistMeta & {
  id: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Device id that made the last change. */
  updatedBy: string | null;
  /** Name of that device, for "changed on Smartphone". */
  updatedByName?: string;
  deleted?: boolean;
  entries: Entry[];
};

export type PlaylistSummary = Omit<PlaylistDoc, 'entries'> & { count: number };

export type TrackDoc = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  trackNo?: number;
  durationSec?: number;
  size: number;
  mime: string;
  youtubeId?: string;
  hasCover: boolean;
  addedAt: number;
  metaVersion: number;
  deleted?: boolean;
};

export type Changes = {
  /** Pass this back as `since` next time. */
  seq: number;
  /** More changes after these: ask again at once. */
  more: boolean;
  tracks: TrackDoc[];
  playlists: PlaylistSummary[];
};

export type ServerEvent = { seq: number; kind: 'track' | 'playlist' | 'device'; id: string; by?: string; summary?: string };

export const PERM_NAMES = ['READ_LIBRARY', 'PLAY_TRACK', 'DOWNLOAD_TRACK', 'EDIT_PLAYLIST', 'UPLOAD_TRACK', 'DELETE_TRACK', 'ADMIN'] as const;
export type PermName = (typeof PERM_NAMES)[number];

export type DeviceDoc = {
  id: string;
  name: string;
  kind: 'pc' | 'android' | 'ios' | 'other';
  perms: PermName[];
  createdAt: number;
  lastSeen: number;
  current: boolean;
  revoked: boolean;
};

export type SessionDoc = { token: string; device: DeviceDoc; user: { name: string } };
