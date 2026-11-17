import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite exists from Node 22.5: older Nodes (the NAS) fall back to sql.js below.
type DatabaseSync = { prepare(sql: string): unknown; exec(sql: string): void; close(): void };
let DatabaseSync: (new (file: string) => DatabaseSync) | undefined;
try { DatabaseSync = (await import('node:sqlite')).DatabaseSync as unknown as new (file: string) => DatabaseSync; } catch { DatabaseSync = undefined; }

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
  // Start/End of a song, personal to each NAS user (never shared with the others)
  `CREATE TABLE cue (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    song TEXT NOT NULL,
    start_time REAL,
    end_time REAL,
    title TEXT,
    updated_at INTEGER NOT NULL,
    device_name TEXT,
    PRIMARY KEY (user_id, song)
  );`,
];

/**
 * The database behind the server. Two engines, same calls:
 * - `node:sqlite` (Node 22.5+): a real SQLite file, WAL, the fast path.
 * - sql.js (SQLite compiled to WebAssembly, `server/vendor/`): for a NAS whose Node is older (DSM offers Node 18 at most
 *   on ARM models such as the DS215j). The database lives in memory and is written to the file shortly after every
 *   change, and when the server stops.
 */
export type RunResult = { lastInsertRowid: number | bigint; changes: number };
export interface Stmt {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}
export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
  /** Which engine answers: shown in /api/health. */
  readonly engine: 'node:sqlite' | 'sql.js';
}

type SqlJsStatement = { bind(p: unknown[]): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): void };
type SqlJsDatabase = {
  prepare(sql: string): SqlJsStatement;
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  getRowsModified(): number;
  export(): Uint8Array;
  close(): void;
};

class NativeDb implements Db {
  readonly engine = 'node:sqlite' as const;
  private d: DatabaseSync;
  constructor(d: DatabaseSync) { this.d = d; }
  prepare(sql: string): Stmt { return this.d.prepare(sql) as unknown as Stmt; }
  exec(sql: string) { this.d.exec(sql); }
  close() { this.d.close(); }
}

const SAVE_DELAY_MS = 250;

class SqlJsDb implements Db {
  readonly engine = 'sql.js' as const;
  private d: SqlJsDatabase;
  private file: string;
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  constructor(d: SqlJsDatabase, file: string) { this.d = d; this.file = file; }
  prepare(sql: string): Stmt {
    const d = this.d;
    const touch = () => this.touch();
    const row = (s: SqlJsStatement) => { const o = s.getAsObject(); return o; };
    return {
      get(...p) { const s = d.prepare(sql); try { s.bind(p); return s.step() ? row(s) : undefined; } finally { s.free(); } },
      all(...p) { const s = d.prepare(sql); const out: unknown[] = []; try { s.bind(p); while (s.step()) out.push(row(s)); } finally { s.free(); } return out; },
      run(...p) {
        d.run(sql, p);
        const changes = d.getRowsModified();
        const r = d.exec('SELECT last_insert_rowid() AS id');
        touch();
        return { lastInsertRowid: Number(r[0]?.values[0]?.[0] ?? 0), changes };
      },
    };
  }
  exec(sql: string) { this.d.exec(sql); this.touch(); }
  private touch() {
    this.dirty = true;
    if (this.file === ':memory:' || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, SAVE_DELAY_MS);
  }
  /** Writes the whole database to its file (a few MB at most): first next to it, then in its place. */
  flush() {
    if (!this.dirty || this.file === ':memory:') return;
    this.dirty = false;
    const bytes = this.d.export(); // sql.js reopens the database after export: the pragmas are set again below
    this.d.exec('PRAGMA foreign_keys = ON');
    writeFileSync(this.file + '.tmp', bytes);
    renameSync(this.file + '.tmp', this.file);
  }
  close() { if (this.timer) clearTimeout(this.timer); this.flush(); this.d.close(); }
}

/** `server/vendor/` seen from here, both from the sources and from the compiled copy in dist/. */
function vendorDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const v = join(dir, 'vendor', 'sql-wasm.cjs');
    if (existsSync(v)) return dirname(v);
    dir = dirname(dir);
  }
  throw new Error('server/vendor/sql-wasm.cjs non trovato');
}

export type DbEngine = 'node:sqlite' | 'sql.js' | 'auto';

/** Opens (or creates) the database and brings it up to date. `engine` auto = node:sqlite when this Node has it. */
export async function openDb(file: string, engine: DbEngine = (process.env.PARTYMIX_DB as DbEngine) || 'auto'): Promise<Db> {
  let db: Db;
  if (engine === 'node:sqlite' || (engine === 'auto' && DatabaseSync)) {
    if (!DatabaseSync) throw new Error('node:sqlite non disponibile in questo Node');
    const d = new DatabaseSync(file);
    d.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    db = new NativeDb(d);
  } else {
    const vendor = vendorDir();
    const initSqlJs = createRequire(import.meta.url)(join(vendor, 'sql-wasm.cjs')) as (o: { wasmBinary: Buffer }) => Promise<{ Database: new (data?: Uint8Array) => SqlJsDatabase }>;
    const SQL = await initSqlJs({ wasmBinary: readFileSync(join(vendor, 'sql-wasm.wasm')) });
    const data = file !== ':memory:' && existsSync(file) ? readFileSync(file) : undefined;
    db = new SqlJsDb(new SQL.Database(data ? new Uint8Array(data) : undefined), file);
  }
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Synchronous, node:sqlite only: kept for callers that cannot await (tests on Node 22+). */
export function openDbSync(file: string): Db {
  if (!DatabaseSync) throw new Error('node:sqlite non disponibile in questo Node: usa openDb()');
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const db = new NativeDb(d);
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
