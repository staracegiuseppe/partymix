import { DatabaseSync } from 'node:sqlite';

/**
 * The PartyMix database on the NAS (database/partymix.sqlite). Every step in MIGRATIONS runs once, in order;
 * PRAGMA user_version remembers how many already ran, so an old NAS catches up when the container is updated.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE user (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE device (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES user(id),
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    perms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    last_sync_seq INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );
  CREATE TABLE artist (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE album (
    id INTEGER PRIMARY KEY,
    artist_id INTEGER REFERENCES artist(id),
    title TEXT NOT NULL COLLATE NOCASE,
    year INTEGER,
    cover_sha256 TEXT,
    UNIQUE (artist_id, title)
  );
  CREATE TABLE change_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE track (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist_id INTEGER REFERENCES artist(id),
    album_id INTEGER REFERENCES album(id),
    genre TEXT,
    year INTEGER,
    track_no INTEGER,
    duration_sec REAL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    cover_sha256 TEXT,
    youtube_id TEXT,
    added_by TEXT REFERENCES device(id),
    added_at INTEGER NOT NULL,
    meta_version INTEGER NOT NULL DEFAULT 1,
    deleted_at INTEGER,
    seq INTEGER NOT NULL
  );
  CREATE INDEX track_seq ON track(seq);
  CREATE INDEX track_artist ON track(artist_id);
  CREATE INDEX track_title ON track(title COLLATE NOCASE);
  CREATE TABLE playlist (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT,
    cover TEXT,
    link TEXT,
    source TEXT,
    sort_order REAL NOT NULL DEFAULT 0,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES device(id),
    deleted_at INTEGER,
    seq INTEGER NOT NULL
  );
  CREATE INDEX playlist_seq ON playlist(seq);
  CREATE TABLE playlist_entry (
    playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    pos REAL NOT NULL,
    track_id TEXT,
    youtube_id TEXT,
    title TEXT,
    artist TEXT,
    album TEXT,
    thumb TEXT,
    duration_sec REAL,
    PRIMARY KEY (playlist_id, entry_id)
  );
  CREATE INDEX playlist_entry_pos ON playlist_entry(playlist_id, pos);
  CREATE INDEX playlist_entry_track ON playlist_entry(track_id);
  CREATE TABLE playlist_rev (
    playlist_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    device_id TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, version)
  );
  CREATE TABLE download (
    device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    state TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (device_id, track_id)
  );
  CREATE TABLE sync_job (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE upload (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // A playlist line can point to a file that is only on one device (not uploaded yet): other devices show it as missing.
  `ALTER TABLE playlist_entry ADD COLUMN local_id TEXT;`,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Runs fn inside one transaction: all of it is written, or nothing. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Records a change and returns its number: clients ask for "everything after seq N". */
export function bump(db: Db, kind: 'track' | 'playlist' | 'device', refId: string, at: number): number {
  const r = db.prepare('INSERT INTO change_log (kind, ref_id, at) VALUES (?, ?, ?)').run(kind, refId, at);
  return Number(r.lastInsertRowid);
}

export function currentSeq(db: Db): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM change_log').get() as { s: number };
  return r.s;
}
