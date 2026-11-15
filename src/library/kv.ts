/**
 * A tiny key-value store over IndexedDB: playlists, the music library and (in the browser) the audio files themselves.
 * localStorage holds about 5 MB, not enough for thousands of songs; IndexedDB grows with the disk.
 */
export type StoreName = 'playlists' | 'library' | 'blobs' | 'sync';
const STORES: StoreName[] = ['playlists', 'library', 'blobs', 'sync'];
/** Grows when a store is added: the browser then calls onupgradeneeded and the missing stores are created. */
const DB_VERSION = 2;

export interface KV {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  getAll<T>(store: StoreName): Promise<T[]>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}

/** The storage is full: shown to the user as «spazio insufficiente», never as a raw browser error. */
export class QuotaError extends Error {
  readonly kind = 'quota';
  constructor() { super('Spazio insufficiente sul disco per salvare la musica.'); }
}
const isQuota = (e: unknown) => {
  const n = (e as { name?: string } | null)?.name ?? '';
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED' || /quota/i.test(String((e as Error)?.message ?? ''));
};

/** A copy like IndexedDB makes (so later changes to the object are not saved by accident); files stay shared. */
function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object' && !(typeof Blob !== 'undefined' && v instanceof Blob)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

/** Kept in memory only: used by the tests, and as a last resort when IndexedDB cannot be opened. */
export class MemoryKV implements KV {
  private data = new Map<string, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  /** Tests: makes the next put fail as a full disk would. */
  failNextPut?: Error;
  async get<T>(store: StoreName, key: string) { return this.data.get(store)!.get(key) as T | undefined; }
  async getAll<T>(store: StoreName) { return [...this.data.get(store)!.values()] as T[]; }
  async put(store: StoreName, key: string, value: unknown) {
    if (this.failNextPut) { const e = this.failNextPut; this.failNextPut = undefined; throw isQuota(e) ? new QuotaError() : e; }
    this.data.get(store)!.set(key, clone(value));
  }
  async delete(store: StoreName, key: string) { this.data.get(store)!.delete(key); }
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });

class IdbKV implements KV {
  constructor(private db: IDBDatabase) {}
  private os(store: StoreName, mode: IDBTransactionMode) { return this.db.transaction(store, mode).objectStore(store); }
  get<T>(store: StoreName, key: string) { return req(this.os(store, 'readonly').get(key)) as Promise<T | undefined>; }
  getAll<T>(store: StoreName) { return req(this.os(store, 'readonly').getAll()) as Promise<T[]>; }
  async put(store: StoreName, key: string, value: unknown) {
    try {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      await new Promise<void>((ok, ko) => { tx.oncomplete = () => ok(); tx.onerror = () => ko(tx.error); tx.onabort = () => ko(tx.error); });
    } catch (e) {
      throw isQuota(e) ? new QuotaError() : e;
    }
  }
  async delete(store: StoreName, key: string) { await req(this.os(store, 'readwrite').delete(key)); }
}

/** Opens the app database; asks the browser to keep it (not evicted when the disk fills up). */
export async function openKV(name = 'partymix'): Promise<KV> {
  if (typeof indexedDB === 'undefined') return new MemoryKV();
  try {
    const db = await new Promise<IDBDatabase>((ok, ko) => {
      const r = indexedDB.open(name, DB_VERSION);
      r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
      r.onblocked = () => ko(new Error('database bloccato'));
    });
    void navigator.storage?.persist?.().catch(() => false);
    return new IdbKV(db);
  } catch {
    return new MemoryKV();
  }
}
