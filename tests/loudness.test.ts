import { fileLufs, gainFactor, heardLufs, LoudnessStore, parseYouTubeLoudness, serial, TARGET_LUFS } from '../src/loudness';

const db = (f: number) => 20 * Math.log10(f);
/** What is heard: the song's loudness after YouTube (if any) and after our factor. */
const out = (lufs: number, src: 'youtube' | 'file') => heardLufs(lufs, src) + db(gainFactor(lufs, src));

describe('volume uguale tra i brani', () => {
  it('YouTube: un brano forte, uno a -16 e uno a -18 escono allo stesso livello', () => {
    // measured in the embedded player: -14 and louder → -19; quieter ones untouched
    const levels = [-8.3, -13.9, -16.9, -18].map((l) => out(l, 'youtube'));
    for (const l of levels) expect(l).toBeCloseTo(TARGET_LUFS - 3, 5);
  });

  it('file e video allo stesso livello; i brani molto deboli si alzano al massimo di 3 dB', () => {
    expect(out(-9, 'file')).toBeCloseTo(out(-8, 'youtube'), 5);
    expect(out(-14, 'file')).toBeCloseTo(TARGET_LUFS - 3, 5);
    expect(out(-26, 'file')).toBeCloseTo(-26 + 0, 5); // +3 dB of headroom used, nothing more
    expect(gainFactor(-26, 'file')).toBeCloseTo(1, 5);
  });

  it('volume mai sopra il 100% e loudness sconosciuta = margine fisso', () => {
    for (const l of [-40, -30, -20, -10, 0, 5]) for (const s of ['youtube', 'file'] as const) expect(gainFactor(l, s)).toBeLessThanOrEqual(1);
    expect(gainFactor(undefined, 'youtube')).toBeCloseTo(0.708, 3);
  });

  it('legge la loudness dalla pagina di YouTube', () => {
    expect(parseYouTubeLoudness('..."loudnessDb":1.12,"perceptualLoudnessDb":-12.88,...')).toBe(-12.88);
    expect(parseYouTubeLoudness('{"loudnessDb":-2.5}')).toBe(-16.5);
    expect(parseYouTubeLoudness('<html>niente</html>')).toBeUndefined();
  });

  it('misura un file: silenzio escluso, livello medio della musica', () => {
    const toLevel = (dbfs: number) => dbfs + 90.31;
    const song = [...Array(40).fill(toLevel(-100)), ...Array(400).fill(toLevel(-12)), ...Array(40).fill(toLevel(-100))];
    expect(fileLufs(song)).toBeCloseTo(-12, 0);
    expect(fileLufs(Array(5).fill(toLevel(-12)))).toBeUndefined();
  });

  it('ricorda le misure e non misura due volte', async () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const a = new LoudnessStore(st);
    let n = 0;
    const m = async () => { n++; return -10; };
    await Promise.all([a.ensure('x', m), a.ensure('x', m)]);
    expect(n).toBe(1);
    expect(new LoudnessStore(st).get('x')).toBe(-10);
  });

  it('una misura fallita non si ripete subito (niente pagina scaricata a ogni caricamento)', async () => {
    let t = 0, n = 0;
    const st = new LoudnessStore(undefined, 'k', () => t);
    const fail = async () => { n++; return undefined; };
    await st.ensure('x', fail, 1000); await st.ensure('x', fail, 1000);
    expect(n).toBe(1);
    t = 1001;
    await st.ensure('x', fail, 1000);
    expect(n).toBe(2);
  });

  it('una richiesta alla volta', async () => {
    const run = serial();
    let active = 0, max = 0;
    const job = async () => { active++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 2)); active--; };
    await Promise.all([run(job), run(job), run(async () => { throw new Error('x'); }).catch(() => {}), run(job)]);
    expect(max).toBe(1);
  });
});
