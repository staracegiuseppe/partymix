import { CUE_SONG, type CueDoc } from '../shared/model';
import { cleanCue, type UserCue } from './cueEdit';

/** What happened to a song's Start/End: only here (no NAS), being sent to the NAS, or saved on the NAS for this user. */
export type CueSaveState = 'local' | 'pending' | 'nas';
type Rec = UserCue & { updatedAt: number; title?: string; pending?: boolean; removed?: boolean };

export type CueStoreDeps = { storage?: Storage; now?: () => number };
const PREFIX = 'partymix.cues.';
/** Without a NAS the cues belong to this device. */
export const LOCAL_ACCOUNT = '~device';

/**
 * Start/End of the songs (SET START / SET END), personal to one account: each NAS user has their own, kept on the
 * device under that user's key and on the NAS (`/api/cues`) where the other users cannot read them. Songs are keyed
 * by their id everywhere (YouTube id, SHA-256 of a NAS file, `local:<hash>`), so the same song in two playlists has
 * the same Start/End for this user. Saving is automatic: every change is written at once and sent to the NAS.
 */
export class CueStore {
  private map = new Map<string, Rec>();
  private account = LOCAL_ACCOUNT;
  private listeners = new Set<() => void>();
  private ls?: Storage;
  private now: () => number;
  /** Grows at every change: the queue rows redraw only when it moved. */
  version = 0;

  constructor(deps: CueStoreDeps = {}) {
    this.ls = deps.storage;
    this.now = deps.now ?? Date.now;
    this.load();
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed() { this.version++; this.save(); for (const fn of this.listeners) fn(); }

  accountName(): string { return this.account; }
  isLocal(): boolean { return this.account === LOCAL_ACCOUNT; }

  /**
   * Switches to another account's cues (a NAS user, or back to this device alone). The first time a device links to
   * the NAS, the Start/End set before on this device go to that user. `forget` deletes the previous user's copy from
   * this device (unlinking: the next person who links here must not find them).
   */
  useAccount(name: string, opts: { adoptLocal?: boolean; forget?: boolean } = {}): void {
    const acc = name.trim() || LOCAL_ACCOUNT;
    if (acc === this.account) return;
    const before = this.account;
    const localCues = acc !== LOCAL_ACCOUNT && opts.adoptLocal ? [...this.readAccount(LOCAL_ACCOUNT)] : [];
    if (opts.forget && before !== LOCAL_ACCOUNT) { try { this.ls?.removeItem(PREFIX + before); } catch { /* nothing kept */ } }
    this.account = acc;
    this.load();
    for (const [song, r] of localCues) if (!this.map.has(song)) this.map.set(song, { ...r, pending: true });
    if (localCues.length) { try { this.ls?.removeItem(PREFIX + LOCAL_ACCOUNT); } catch { /* stays there too */ } }
    this.changed();
  }

  get(song: string): UserCue | undefined {
    const r = this.map.get(song);
    if (!r || r.removed) return undefined;
    const out: UserCue = {};
    if (r.startTime !== undefined) out.startTime = r.startTime;
    if (r.endTime !== undefined) out.endTime = r.endTime;
    return out;
  }

  state(song: string): CueSaveState | undefined {
    const r = this.map.get(song);
    if (!r) return undefined;
    return this.isLocal() ? 'local' : r.pending ? 'pending' : 'nas';
  }

  /** `undefined` = leave as it is, `null` = take it away. True when something changed. */
  set(song: string, patch: { startTime?: number | null; endTime?: number | null }, title?: string): boolean {
    const cur = this.map.get(song);
    const next: Rec = { ...(cur && !cur.removed ? cur : {}), updatedAt: this.now() };
    delete next.removed;
    for (const k of ['startTime', 'endTime'] as const) {
      const v = patch[k];
      if (v === null) delete next[k]; else if (v !== undefined) next[k] = v;
    }
    if (title) next.title = title;
    const same = cur && !cur.removed && cur.startTime === next.startTime && cur.endTime === next.endTime;
    if (same) return false;
    if (next.startTime === undefined && next.endTime === undefined) {
      if (!cur || cur.removed) return false;
      if (this.isLocal()) this.map.delete(song);
      else this.map.set(song, { updatedAt: next.updatedAt, removed: true, pending: true }); // the NAS must hear about it
    } else {
      next.pending = !this.isLocal();
      this.map.set(song, next);
    }
    this.changed();
    return true;
  }

  /** A song got a new id (a local file that is now on the NAS): its Start/End follow it. */
  rename(from: string, to: string): void {
    const r = this.map.get(from);
    if (!r || from === to || this.map.has(to)) return;
    this.map.set(to, { ...r, pending: !this.isLocal() });
    if (this.isLocal()) this.map.delete(from); else this.map.set(from, { updatedAt: this.now(), removed: true, pending: true });
    this.changed();
  }

  /** What still has to reach the NAS. */
  pending(): { song: string; startTime: number | null; endTime: number | null; title?: string; at: number }[] {
    if (this.isLocal()) return [];
    return [...this.map].filter(([, r]) => r.pending).map(([song, r]) => ({ song, startTime: r.removed ? null : r.startTime ?? null, endTime: r.removed ? null : r.endTime ?? null, title: r.title, at: r.updatedAt }));
  }

  /** The NAS took it: a removal is forgotten, a value is marked saved (unless it changed again meanwhile). */
  sent(song: string, at: number): void {
    const r = this.map.get(song);
    if (!r || r.updatedAt !== at) return;
    if (r.removed) this.map.delete(song); else delete r.pending;
    this.changed();
  }

  /** The user's cues as the NAS has them; what this device has not sent yet stays on top. */
  applyRemote(docs: CueDoc[]): void {
    const next = new Map<string, Rec>();
    for (const d of docs) {
      if (!CUE_SONG.test(d.song)) continue;
      const s = cleanCue(d.startTime), e = cleanCue(d.endTime);
      const r: Rec = { updatedAt: d.updatedAt };
      if (s !== undefined) r.startTime = s;
      if (e !== undefined && e > (s ?? 0)) r.endTime = e;
      if (d.title) r.title = d.title;
      next.set(d.song, r);
    }
    for (const [song, r] of this.map) if (r.pending) next.set(song, r);
    this.map = next;
    this.changed();
  }

  count(): number { return [...this.map.values()].filter((r) => !r.removed).length; }

  private readAccount(acc: string): Map<string, Rec> {
    const out = new Map<string, Rec>();
    try {
      const j = JSON.parse(this.ls?.getItem(PREFIX + acc) ?? '{}') as Record<string, Rec>;
      for (const [song, r] of Object.entries(j ?? {})) {
        if (!CUE_SONG.test(song) || !r || typeof r !== 'object') continue;
        const s = cleanCue(r.startTime), e = cleanCue(r.endTime);
        const rec: Rec = { updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0 };
        if (s !== undefined) rec.startTime = s;
        if (e !== undefined && e > (s ?? 0)) rec.endTime = e;
        if (typeof r.title === 'string') rec.title = r.title.slice(0, 300);
        if (r.pending) rec.pending = true;
        if (r.removed) rec.removed = true;
        if (rec.startTime === undefined && rec.endTime === undefined && !rec.removed) continue;
        out.set(song, rec);
      }
    } catch { /* nothing saved, or unreadable */ }
    return out;
  }
  private load() { this.map = this.readAccount(this.account); }
  private save() {
    try { this.ls?.setItem(PREFIX + this.account, JSON.stringify(Object.fromEntries(this.map))); } catch { /* full or blocked: stays in memory */ }
  }
}

/** The NAS side of the cues: push what changed here, take the user's list from the NAS. */
export type CueApi = { cues(): Promise<CueDoc[]>; putCue(song: string, body: { startTime: number | null; endTime: number | null; title?: string }): Promise<CueDoc | null> };

export class CueSync {
  private running?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private off: () => void;
  constructor(private store: CueStore, private api: CueApi, private log: (m: string) => void = () => {}, private delayMs = 400) {
    this.off = store.onChange(() => { if (store.pending().length) this.soon(); });
  }
  stop(): void { this.off(); if (this.timer) clearTimeout(this.timer); }
  soon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.syncNow(); }, this.delayMs);
  }
  /** Sends the pending changes, then reads the user's cues from the NAS. Offline: they wait and go next time. */
  syncNow(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          for (const p of this.store.pending()) {
            try {
              await this.api.putCue(p.song, { startTime: p.startTime, endTime: p.endTime, ...(p.title ? { title: p.title } : {}) });
            } catch (e) {
              // refused for good (bad value): not sent again and again; anything else (offline, old NAS) waits
              if ((e as { status?: number }).status !== 400) throw e;
              this.log(`Start/End di ${p.song} rifiutati dal NAS: ${(e as Error).message}`);
            }
            this.store.sent(p.song, p.at);
          }
          this.store.applyRemote(await this.api.cues());
        } catch (e) {
          this.log(`Start/End non sincronizzati: ${(e as Error).message}`);
        }
      } while (this.again);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
}

/**
 * 1.9.0-beta1 kept Start/End inside the playlist lines: moves them into the cues (the ones already there win).
 * Takes the playlists as saved on disk, before they are cleaned. Returns how many songs got their cuts back.
 */
export function cuesFromPlaylists(raw: unknown[], store: CueStore): number {
  let n = 0;
  for (const p of raw as { tracks?: { videoId?: unknown; startTime?: unknown; endTime?: unknown; title?: unknown }[] }[]) {
    for (const t of p?.tracks ?? []) {
      if (typeof t?.videoId !== 'string') continue;
      const s = cleanCue(t.startTime), e0 = cleanCue(t.endTime);
      const e = e0 !== undefined && e0 > (s ?? 0) ? e0 : undefined;
      if (s === undefined && e === undefined) continue;
      const key = t.videoId.startsWith('nas:') ? t.videoId.slice(4) : t.videoId;
      if (!CUE_SONG.test(key) || store.get(key)) continue;
      if (store.set(key, { startTime: s, endTime: e }, typeof t.title === 'string' ? t.title : undefined)) n++;
    }
  }
  return n;
}
