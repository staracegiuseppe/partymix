import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUE_SONG, type CueDoc } from '../../shared/model.ts';
import type { Db } from './db.ts';
import { bad } from './http.ts';

type Row = { song: string; start_time: number | null; end_time: number | null; title: string | null; updated_at: number; device_name: string | null };

const MAX_S = 86_400 * 7;
const docOf = (r: Row): CueDoc => {
  const d: CueDoc = { song: r.song, updatedAt: r.updated_at };
  if (r.start_time != null) d.startTime = r.start_time;
  if (r.end_time != null) d.endTime = r.end_time;
  if (r.title) d.title = r.title;
  if (r.device_name) d.deviceName = r.device_name;
  return d;
};

/** A cue time from the network: null/absent = none, else a number of seconds, kept to the millisecond. */
function time(x: unknown, what: string): number | null {
  if (x == null) return null;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > MAX_S) throw bad(`${what} non valido`);
  return Math.round(x * 1000) / 1000;
}

/** A name that is safe as a folder: the user's own folder for their cue files. */
export const userFolder = (id: number, name: string) => `${id}-${name.normalize('NFD').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'utente'}`;

/**
 * Start/End of the songs, one set per NAS user. Kept in the database and, for each song, in a small readable file
 * in that user's own folder: `users/<id>-<nome>/cues/<brano>.json` (easy to back up, to look at, to restore).
 * Every call takes the user of the device that asks: one user can never read or change another's cues.
 */
export class Cues {
  private db: Db;
  private root: string;
  private now: () => number;
  constructor(db: Db, root: string, now: () => number) { this.db = db; this.root = root; this.now = now; }

  list(userId: number): CueDoc[] {
    return (this.db.prepare('SELECT song, start_time, end_time, title, updated_at, device_name FROM cue WHERE user_id = ? ORDER BY song').all(userId) as Row[]).map(docOf);
  }

  /** Sets (or, with both times null, removes) a song's Start/End for this user. Returns the stored doc, or null when removed. */
  set(user: { id: number; name: string }, song: string, body: Record<string, unknown>, deviceName: string): CueDoc | null {
    if (!CUE_SONG.test(song)) throw bad('brano non valido');
    const start = time(body.startTime, 'startTime'), end = time(body.endTime, 'endTime');
    if (start != null && end != null && end <= start) throw bad('End point must be after Start point: l’End deve venire dopo lo Start');
    const title = typeof body.title === 'string' ? body.title.slice(0, 300) : null;
    const file = join(this.root, 'users', userFolder(user.id, user.name), 'cues', `${song.replace(':', '_')}.json`);
    if (start == null && end == null) {
      this.db.prepare('DELETE FROM cue WHERE user_id = ? AND song = ?').run(user.id, song);
      try { rmSync(file, { force: true }); } catch { /* the database is what counts */ }
      return null;
    }
    const t = this.now();
    this.db.prepare(`INSERT INTO cue (user_id, song, start_time, end_time, title, updated_at, device_name) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, song) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time,
      title = COALESCE(excluded.title, cue.title), updated_at = excluded.updated_at, device_name = excluded.device_name`)
      .run(user.id, song, start, end, title, t, deviceName);
    const doc = docOf(this.db.prepare('SELECT song, start_time, end_time, title, updated_at, device_name FROM cue WHERE user_id = ? AND song = ?').get(user.id, song) as Row);
    try {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify({ ...doc, user: user.name }, null, 2));
      renameSync(file + '.tmp', file);
    } catch (e) {
      console.error('file del cue non scritto:', (e as Error).message);
    }
    return doc;
  }
}
