import type { CueDoc } from '../shared/model';
import { CueStore, CueSync, cuesFromPlaylists, LOCAL_ACCOUNT, type CueApi } from '../src/cueStore';

class MemStorage implements Storage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

/** The NAS: one list of cues per user, as the server keeps them. */
class FakeNasCues {
  byUser = new Map<string, Map<string, CueDoc>>();
  t = 1000;
  api(user: string): CueApi {
    const mine = () => { if (!this.byUser.has(user)) this.byUser.set(user, new Map()); return this.byUser.get(user)!; };
    return {
      cues: async () => [...mine().values()],
      putCue: async (song, b) => {
        if (b.startTime == null && b.endTime == null) { mine().delete(song); return null; }
        const d: CueDoc = { song, updatedAt: ++this.t, ...(b.startTime != null ? { startTime: b.startTime } : {}), ...(b.endTime != null ? { endTime: b.endTime } : {}) };
        mine().set(song, d);
        return d;
      },
    };
  }
}

const YT = 'b2GlV6Ap-3g';

describe('CueStore: Start/End personali e salvati da soli', () => {
  it('SET START due volte sostituisce; si salva subito, anche dopo la riapertura', () => {
    const ls = new MemStorage();
    const s = new CueStore({ storage: ls });
    s.set(YT, { startTime: 37.42 });
    s.set(YT, { startTime: 51.8 });
    s.set(YT, { endTime: 228.65 });
    expect(new CueStore({ storage: ls }).get(YT)).toEqual({ startTime: 51.8, endTime: 228.65 });
    expect(s.state(YT)).toBe('local');
    s.set(YT, { startTime: null, endTime: null });
    expect(new CueStore({ storage: ls }).get(YT)).toBeUndefined();
  });

  it('ogni utente del NAS ha i suoi: il figlio non vede quelli del papà sullo stesso dispositivo', () => {
    const ls = new MemStorage();
    const s = new CueStore({ storage: ls });
    s.useAccount('anna');
    s.set(YT, { startTime: 42.317 });
    s.useAccount(LOCAL_ACCOUNT, { forget: true }); // scollegato: la sua copia sparisce da qui
    expect([...ls.m.keys()].some((k) => k.endsWith('anna'))).toBe(false);
    s.useAccount('marco');
    expect(s.get(YT)).toBeUndefined();
  });

  it('al primo collegamento i cue messi prima su questo dispositivo diventano dell’utente', () => {
    const s = new CueStore({ storage: new MemStorage() });
    s.set(YT, { startTime: 10 });
    s.useAccount('anna', { adoptLocal: true });
    expect(s.get(YT)).toEqual({ startTime: 10 });
    expect(s.pending().map((p) => p.song)).toEqual([YT]);
  });

  it('un file locale caricato sul NAS si porta dietro Start/End', () => {
    const s = new CueStore({ storage: new MemStorage() });
    s.set('local:0123abcd', { startTime: 3 });
    s.rename('local:0123abcd', 'a'.repeat(64));
    expect(s.get('a'.repeat(64))).toEqual({ startTime: 3 });
    expect(s.get('local:0123abcd')).toBeUndefined();
  });
});

describe('CueSync: PC → NAS → telefono, per utente', () => {
  it('il telefono dello stesso utente riceve i cue; quello del figlio no', async () => {
    const nas = new FakeNasCues();
    const pc = new CueStore({ storage: new MemStorage() }); pc.useAccount('anna');
    const tel = new CueStore({ storage: new MemStorage() }); tel.useAccount('anna');
    const figlio = new CueStore({ storage: new MemStorage() }); figlio.useAccount('marco');
    const pcSync = new CueSync(pc, nas.api('anna'), () => {}, 0);
    pc.set(YT, { startTime: 42.317, endTime: 228.65 });
    expect(pc.state(YT)).toBe('pending');
    await pcSync.syncNow();
    expect(pc.state(YT)).toBe('nas');
    await new CueSync(tel, nas.api('anna')).syncNow();
    await new CueSync(figlio, nas.api('marco')).syncNow();
    expect(tel.get(YT)).toEqual({ startTime: 42.317, endTime: 228.65 });
    expect(figlio.get(YT)).toBeUndefined();
    pcSync.stop();
  });

  it('Reset arriva al NAS; offline le modifiche aspettano e partono dopo', async () => {
    const nas = new FakeNasCues();
    const pc = new CueStore({ storage: new MemStorage() }); pc.useAccount('anna');
    const api = nas.api('anna');
    let down = true;
    const flaky: CueApi = { cues: () => (down ? Promise.reject(new Error('offline')) : api.cues()), putCue: (s, b) => (down ? Promise.reject(new Error('offline')) : api.putCue(s, b)) };
    const sync = new CueSync(pc, flaky, () => {}, 0);
    pc.set(YT, { startTime: 5 });
    await sync.syncNow();
    expect(pc.state(YT)).toBe('pending');
    down = false;
    await sync.syncNow();
    expect(nas.byUser.get('anna')!.get(YT)?.startTime).toBe(5);
    pc.set(YT, { startTime: null, endTime: null });
    await sync.syncNow();
    expect(nas.byUser.get('anna')!.has(YT)).toBe(false);
    expect(pc.get(YT)).toBeUndefined();
    sync.stop();
  });
});

describe('tagli fatti con la beta1 (dentro la playlist)', () => {
  it('passano ai cue del dispositivo, poi all’utente al collegamento, e partono per il NAS', async () => {
    const s = new CueStore({ storage: new MemStorage() });
    s.set('jNQXAC9IVRw', { startTime: 1 }); // già presente: non viene toccato
    const raw = [{ tracks: [
      { videoId: YT, title: '50 Special', startTime: 22.471, endTime: 32.006, status: 'ok' },
      { videoId: 'jNQXAC9IVRw', startTime: 9 },
      { videoId: 'aaaaaaaaaaa', endTime: 5, startTime: 10 }, // End prima dello Start: resta solo lo Start
      { videoId: 'bbbbbbbbbbb', status: 'ok' },
    ] }];
    expect(cuesFromPlaylists(raw, s)).toBe(2);
    expect(s.get(YT)).toEqual({ startTime: 22.471, endTime: 32.006 });
    expect(s.get('jNQXAC9IVRw')).toEqual({ startTime: 1 });
    expect(s.get('aaaaaaaaaaa')).toEqual({ startTime: 10 });
    s.useAccount('anna', { adoptLocal: true });
    const nas = new FakeNasCues();
    // NAS ancora vecchio: rifiuta (404) e i tagli restano in attesa; aggiornato, partono
    let old = true;
    const api = nas.api('anna');
    const sync = new CueSync(s, { cues: () => (old ? Promise.reject(Object.assign(new Error('Not found'), { status: 404 })) : api.cues()), putCue: (k, b) => (old ? Promise.reject(Object.assign(new Error('Not found'), { status: 404 })) : api.putCue(k, b)) }, () => {}, 0);
    await sync.syncNow();
    expect(s.state(YT)).toBe('pending');
    old = false;
    await sync.syncNow();
    expect(s.state(YT)).toBe('nas');
    expect(nas.byUser.get('anna')!.get(YT)).toMatchObject({ startTime: 22.471, endTime: 32.006 });
    sync.stop();
  });
});
