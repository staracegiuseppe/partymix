/**
 * How two devices change the same playlist without losing each other's work.
 *
 * A device never sends the whole playlist: it sends what it did since the version it started from, as operations
 * (`diff`). The server replays them on the playlist as it is now (`apply`), so a song added on the phone and a song
 * added on the PC both end up in the list. Only two things cannot be merged and are reported as conflicts: the same
 * field (name, description…) changed to two different values, and a playlist deleted on one side and edited on the other.
 *
 * Shared by the app (src/sync) and the server (server/src): type-level TypeScript only.
 */
import type { Entry, PlaylistMeta } from './model.ts';

export type MetaField = 'name' | 'description' | 'color' | 'cover' | 'link' | 'source' | 'sortOrder';
export const META_FIELDS: MetaField[] = ['name', 'description', 'color', 'cover', 'link', 'source', 'sortOrder'];

export type Op =
  /** A new line; `after` lists the lines just before it (newest first): the first one still there decides where it goes. */
  | { op: 'add'; entry: Entry; after: string[] }
  | { op: 'remove'; entryId: string }
  | { op: 'move'; entryId: string; after: string[] }
  | { op: 'set'; field: MetaField; value: string | number | undefined; was: string | number | undefined };

export type Conflict = { field: MetaField; mine: string | number | undefined; theirs: string | number | undefined };

const AFTER_DEPTH = 6;
const same = (a: unknown, b: unknown) => (a ?? undefined) === (b ?? undefined);

/** The ids just before index i (closest first). */
function predecessors(ids: string[], i: number): string[] {
  const out: string[] = [];
  for (let k = i - 1; k >= 0 && out.length < AFTER_DEPTH; k--) out.push(ids[k]);
  return out;
}

/** Longest common subsequence of two id lists: the lines that did not move. */
function stable(a: string[], b: string[]): Set<string> {
  const n = a.length, m = b.length;
  if (!n || !m) return new Set();
  // n×m table of lengths; playlists are at most a few thousand lines, and only the shared ids are compared
  const L: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = new Set<string>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { out.add(a[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** The operations that turn `base` into `local`. Empty = nothing changed. */
export function diff(base: { meta: PlaylistMeta; entries: Entry[] }, local: { meta: PlaylistMeta; entries: Entry[] }): Op[] {
  const ops: Op[] = [];
  for (const f of META_FIELDS) if (!same(base.meta[f], local.meta[f])) ops.push({ op: 'set', field: f, value: local.meta[f], was: base.meta[f] });
  const baseIds = base.entries.map((e) => e.entryId);
  const localIds = local.entries.map((e) => e.entryId);
  const inLocal = new Set(localIds), inBase = new Set(baseIds);
  for (const id of baseIds) if (!inLocal.has(id)) ops.push({ op: 'remove', entryId: id });
  const common = stable(baseIds.filter((id) => inLocal.has(id)), localIds.filter((id) => inBase.has(id)));
  local.entries.forEach((e, i) => {
    if (!inBase.has(e.entryId)) ops.push({ op: 'add', entry: e, after: predecessors(localIds, i) });
    else if (!common.has(e.entryId)) ops.push({ op: 'move', entryId: e.entryId, after: predecessors(localIds, i) });
  });
  return ops;
}

/**
 * Replays `ops` on `current`. `theirs` are the fields the other side changed meanwhile (from diff(base, current)):
 * a `set` on one of them with a different value is a conflict, and the current value stays.
 */
export function apply(current: { meta: PlaylistMeta; entries: Entry[] }, ops: Op[], theirs: Op[] = []): { meta: PlaylistMeta; entries: Entry[]; conflicts: Conflict[] } {
  const meta: PlaylistMeta = { ...current.meta };
  const entries = current.entries.map((e) => ({ ...e }));
  const conflicts: Conflict[] = [];
  const theirSets = new Map<MetaField, string | number | undefined>();
  for (const t of theirs) if (t.op === 'set') theirSets.set(t.field, t.value);
  const theirRemoved = new Set(theirs.filter((t) => t.op === 'remove').map((t) => (t as { entryId: string }).entryId));

  const indexOf = (id: string) => entries.findIndex((e) => e.entryId === id);
  const place = (e: Entry, after: string[]) => {
    for (const a of after) {
      const i = indexOf(a);
      if (i >= 0) { entries.splice(i + 1, 0, e); return; }
    }
    // none of its predecessors is here any more (or it was first): at the start
    entries.unshift(e);
  };

  for (const o of ops) {
    if (o.op === 'set') {
      if (theirSets.has(o.field) && !same(theirSets.get(o.field), o.value)) { conflicts.push({ field: o.field, mine: o.value, theirs: theirSets.get(o.field) }); continue; }
      (meta as Record<string, unknown>)[o.field] = o.value;
      if (o.value === undefined) delete (meta as Record<string, unknown>)[o.field];
    } else if (o.op === 'remove') {
      const i = indexOf(o.entryId);
      if (i >= 0) entries.splice(i, 1);
    } else if (o.op === 'add') {
      if (indexOf(o.entry.entryId) >= 0 || theirRemoved.has(o.entry.entryId)) continue; // already there, or the other side just took it out
      place({ ...o.entry }, o.after);
    } else if (o.op === 'move') {
      const i = indexOf(o.entryId);
      if (i < 0) continue;
      const [e] = entries.splice(i, 1);
      place(e, o.after.filter((a) => a !== o.entryId));
    }
  }
  if (typeof meta.name !== 'string' || !meta.name.trim()) meta.name = current.meta.name;
  return { meta, entries, conflicts };
}

/** Checks operations that came over the network. */
export function cleanOps(v: unknown, cleanEntry: (e: unknown) => Entry): Op[] {
  if (!Array.isArray(v)) throw new Error('ops deve essere una lista');
  if (v.length > 50_000) throw new Error('troppe operazioni');
  const id = (x: unknown) => { if (typeof x !== 'string' || !x || x.length > 64) throw new Error('entryId non valido'); return x; };
  const after = (x: unknown) => (Array.isArray(x) ? x.slice(0, AFTER_DEPTH).map(id) : []);
  return v.map((o: Record<string, unknown>) => {
    if (!o || typeof o !== 'object') throw new Error('operazione non valida');
    switch (o.op) {
      case 'add': return { op: 'add', entry: cleanEntry(o.entry), after: after(o.after) };
      case 'remove': return { op: 'remove', entryId: id(o.entryId) };
      case 'move': return { op: 'move', entryId: id(o.entryId), after: after(o.after) };
      case 'set': {
        const field = o.field as MetaField;
        if (!META_FIELDS.includes(field)) throw new Error('campo non valido');
        const value = o.value;
        if (field === 'sortOrder') { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('sortOrder non valido'); }
        else if (value != null && (typeof value !== 'string' || value.length > 1000)) throw new Error(`${field} non valido`);
        const was = typeof o.was === 'string' || typeof o.was === 'number' ? o.was : undefined;
        return { op: 'set', field, value: value == null || value === '' ? undefined : value, was };
      }
      default: throw new Error('operazione sconosciuta');
    }
  });
}
